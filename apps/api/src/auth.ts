import type { Env } from "./env.js";

/**
 * Self-hosted device-token auth (M4). Per-device opaque tokens, stored only as
 * sha256 hashes in D1, validated per request (immediate revocation). Issued via
 * a CLI device-authorization flow: bootstrap (secret) or device-to-device
 * approval. The token is minted on the FIRST poll after approval and returned
 * exactly once (one-time claim) — never stored in plaintext, never re-returned.
 */

const TOKEN_BYTES = 32;
const AUTH_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 5;
const LAST_SEEN_THROTTLE_MS = 10 * 60 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
function randomUserCode(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const c = [...b].map((x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}
async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
/** Constant-time string compare (lengths leak, contents don't). */
function ctEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  if (ea.length !== eb.length) return false;
  let r = 0;
  for (let i = 0; i < ea.length; i++) r |= ea[i]! ^ eb[i]!;
  return r === 0;
}

const TOKEN_RE = /^[0-9a-f]{64}$/; // 32 bytes hex

export interface AuthedDevice {
  tokenHash: string;
  deviceId: string;
  accountId: string;
}

/** Validate a bearer token: hash → devices lookup (not revoked). Throttled
 *  last_seen update. Returns the device or null. */
export async function authenticate(req: Request, env: Env): Promise<AuthedDevice | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (!TOKEN_RE.test(token)) return null; // reject malformed before hashing
  const hash = await sha256Hex(token);
  const row = await env.rbox_dev_db
    .prepare("SELECT token_hash, device_id, account_id, last_seen_at FROM devices WHERE token_hash = ? AND revoked = 0")
    .bind(hash)
    .first<{ token_hash: string; device_id: string; account_id: string; last_seen_at: number | null }>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_seen_at || now - row.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    await env.rbox_dev_db.prepare("UPDATE devices SET last_seen_at = ? WHERE token_hash = ?").bind(now, hash).run().catch(() => {});
  }
  return { tokenHash: row.token_hash, deviceId: row.device_id, accountId: row.account_id };
}

async function mintDevice(env: Env, deviceId: string, label: string | null): Promise<string> {
  const token = randomHex(TOKEN_BYTES);
  const hash = await sha256Hex(token);
  await env.rbox_dev_db
    .prepare("INSERT INTO devices (token_hash, device_id, label, account_id, created_at) VALUES (?, ?, ?, 'default', ?)")
    .bind(hash, deviceId, label, Date.now())
    .run();
  return token;
}

// POST /v1/auth/device/bootstrap { secret, label } -> { token, deviceId }
export async function bootstrap(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { secret?: string; label?: string };
  const secret = env.RBOX_BOOTSTRAP_SECRET ?? "";
  // Constant-time; identical failure regardless of why.
  if (!secret || typeof body.secret !== "string" || !ctEqual(body.secret, secret)) {
    return json({ error: "unauthorized" }, 401);
  }
  const deviceId = `dev_${randomHex(6)}`;
  const token = await mintDevice(env, deviceId, body.label ?? "bootstrap");
  return json({ token, deviceId });
}

// POST /v1/auth/device/start { label } -> { deviceCode, userCode, interval, expiresIn }
export async function startDeviceAuth(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  const deviceCode = randomHex(TOKEN_BYTES);
  const deviceId = `dev_${randomHex(6)}`;
  const now = Date.now();
  // Collision-retry the human user_code among active auths.
  let userCode = randomUserCode();
  for (let i = 0; i < 5; i++) {
    const clash = await env.rbox_dev_db
      .prepare("SELECT 1 FROM device_auth WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
      .bind(userCode, now)
      .first();
    if (!clash) break;
    userCode = randomUserCode();
  }
  await env.rbox_dev_db
    .prepare("INSERT INTO device_auth (device_code, user_code, status, device_id, label, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
    .bind(deviceCode, userCode, deviceId, body.label ?? null, now, now + AUTH_TTL_MS)
    .run();
  return json({ deviceCode, userCode, interval: POLL_INTERVAL_S, expiresIn: Math.floor(AUTH_TTL_MS / 1000) });
}

// POST /v1/auth/device/poll { deviceCode } -> { status, token? }
export async function pollDeviceAuth(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { deviceCode?: string };
  if (typeof body.deviceCode !== "string") return json({ error: "bad_request" }, 400);
  const row = await env.rbox_dev_db
    .prepare("SELECT user_code, status, device_id, label, expires_at FROM device_auth WHERE device_code = ?")
    .bind(body.deviceCode)
    .first<{ user_code: string; status: string; device_id: string; label: string | null; expires_at: number }>();
  if (!row) return json({ status: "not_found" }, 404);
  if (Date.now() > row.expires_at && row.status === "pending") return json({ status: "expired" });
  if (row.status === "pending") return json({ status: "pending", interval: POLL_INTERVAL_S });
  if (row.status === "claimed") return json({ status: "claimed" }); // token already delivered, never again
  if (row.status === "approved") {
    // One-time claim: only the poll that wins the conditional UPDATE mints+returns.
    const claim = await env.rbox_dev_db
      .prepare("UPDATE device_auth SET status = 'claimed' WHERE device_code = ? AND status = 'approved'")
      .bind(body.deviceCode)
      .run();
    if (claim.meta.changes !== 1) return json({ status: "claimed" }); // lost the race
    const token = await mintDevice(env, row.device_id, row.label);
    return json({ status: "approved", token, deviceId: row.device_id });
  }
  return json({ status: row.status });
}

// POST /v1/auth/device/approve { userCode }  (authed)
export async function approveDeviceAuth(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { userCode?: string };
  if (typeof body.userCode !== "string") return json({ error: "bad_request" }, 400);
  const res = await env.rbox_dev_db
    .prepare("UPDATE device_auth SET status = 'approved' WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
    .bind(body.userCode.toUpperCase(), Date.now())
    .run();
  if (res.meta.changes !== 1) return json({ error: "no_pending_auth" }, 404);
  return json({ ok: true });
}

// GET /v1/auth/devices  (authed) -> device list
export async function listDevices(env: Env, self: AuthedDevice): Promise<Response> {
  const rows = await env.rbox_dev_db
    .prepare("SELECT device_id, label, created_at, last_seen_at FROM devices WHERE revoked = 0 ORDER BY created_at")
    .all<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null }>();
  return json({ devices: (rows.results ?? []).map((r) => ({ ...r, isSelf: r.device_id === self.deviceId })) });
}

// POST /v1/auth/devices/:deviceId/revoke  (authed)
export async function revokeDevice(env: Env, deviceId: string): Promise<Response> {
  const res = await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ?").bind(deviceId).run();
  return json({ ok: true, revoked: res.meta.changes });
}
