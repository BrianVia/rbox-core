import type { Env } from "./env.js";
import { ctEqual, json, sha256Hex } from "./util.js";
import type { Principal } from "./authz.js";

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

const TOKEN_RE = /^[0-9a-f]{64}$/; // 32 bytes hex
// A client-supplied opaque pairing tokenId (design 12, C6): url-safe, 16–64 chars.
// A legacy server-generated 64-hex token also matches, so redeem accepts both.
const PAIR_TOKEN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** Validate a bearer token → the full Principal (device + account + user + role).
 *  Throttled last_seen update. Role comes from the membership; a device with no
 *  membership (legacy) gets least-privilege 'viewer'. */
export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (!TOKEN_RE.test(token)) return null; // reject malformed before hashing
  const hash = await sha256Hex(token);
  const row = await env.rbox_dev_db
    .prepare(
      `SELECT d.device_id, d.account_id, d.user_id, d.last_seen_at, m.role AS role
       FROM devices d LEFT JOIN memberships m ON m.account_id = d.account_id AND m.user_id = d.user_id
       WHERE d.token_hash = ? AND d.revoked = 0 AND (d.expires_at IS NULL OR d.expires_at > ?)`
    )
    .bind(hash, Date.now())
    .first<{ device_id: string; account_id: string; user_id: string | null; last_seen_at: number | null; role: string | null }>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_seen_at || now - row.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    await env.rbox_dev_db.prepare("UPDATE devices SET last_seen_at = ? WHERE token_hash = ?").bind(now, hash).run().catch(() => {});
  }
  return { deviceId: row.device_id, accountId: row.account_id, userId: row.user_id, role: row.role ?? "viewer" };
}

/** Mint a device token into a specific account/user (returns the plaintext once).
 *  `expiresAt` (epoch ms) makes it a short-lived token (web sessions); omit for
 *  durable CLI/device tokens. */
async function mintDevice(env: Env, accountId: string, userId: string, deviceId: string, label: string | null, expiresAt: number | null = null): Promise<string> {
  const token = randomHex(TOKEN_BYTES);
  const hash = await sha256Hex(token);
  await env.rbox_dev_db
    .prepare("INSERT INTO devices (token_hash, device_id, label, account_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(hash, deviceId, label, accountId, userId, Date.now(), expiresAt)
    .run();
  return token;
}

/** Mint a SHORT-LIVED web session token (M11) for a Clerk-authenticated user.
 *  Returns the plaintext once; expires after `ttlMs` (default 1h). */
export async function createWebSession(env: Env, accountId: string, userId: string, ttlMs = 60 * 60 * 1000): Promise<{ token: string; deviceId: string }> {
  const deviceId = `web_${randomHex(4)}`;
  const token = await mintDevice(env, accountId, userId, deviceId, "web", Date.now() + ttlMs);
  return { token, deviceId };
}

// ---- pairing tokens (M10): low-friction "connect a new machine" ----

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_ACTIVE_CAP = 5; // max outstanding (unconsumed, unexpired) per account
const PAIR_PREFIX = "rbox-pair_"; // human-recognizable; stripped before hashing

/**
 * POST /v1/auth/pair/create — AUTHENTICATED. Mint a short-lived, single-use
 * pairing token bound to the caller's account + user. Requires a real membership
 * (never the viewer-by-absence path) so a removed user can't mint, and enforces a
 * per-account active-token cap. Plaintext token returned exactly once.
 *
 * E2EE (design 12, V4-1): the body MAY carry opaque `mkWrap` (the MK wrapped for
 * the redeemer) and `admissionGrant` (the pre-signed roster-delta authority). The
 * server stores both verbatim and never interprets them — they're handed back at
 * redeem so a freshly paired device can unwrap MK and admit itself. Both optional;
 * absent → a legacy (M10) token that redeems exactly as before.
 *
 * C6: the body MAY also carry a client-generated `tokenId` (16–64 url-safe chars).
 * `buildPairing` needs the id up front to bind the `admissionGrant` to it, so the
 * client owns it and the server just stores keyed by sha256(tokenId). Absent →
 * the server mints a token itself (legacy M10 behavior), unchanged.
 */
export async function createPairToken(req: Request, env: Env, p: Principal): Promise<Response> {
  if (!p.userId) return json({ error: "forbidden", message: "pairing requires a user membership" }, 403);
  const member = await env.rbox_dev_db
    .prepare("SELECT 1 FROM memberships WHERE account_id = ? AND user_id = ?")
    .bind(p.accountId, p.userId)
    .first();
  if (!member) return json({ error: "forbidden", message: "pairing requires a user membership" }, 403);

  // Optional opaque E2EE admission material (bounded; stored verbatim, never parsed).
  const body = (await req.json().catch(() => ({}))) as { mkWrap?: unknown; admissionGrant?: unknown; tokenId?: unknown };
  const mkWrap = typeof body.mkWrap === "string" && body.mkWrap.length <= 64 * 1024 ? body.mkWrap : null;
  const admissionGrant = typeof body.admissionGrant === "string" && body.admissionGrant.length <= 64 * 1024 ? body.admissionGrant : null;

  // C6: adopt the client tokenId if supplied (validated), else mint one server-side.
  // Either way the row is keyed by sha256(<tokenId>) so redeem stays a single lookup.
  let tokenId: string;
  if (body.tokenId !== undefined) {
    if (typeof body.tokenId !== "string" || !PAIR_TOKEN_ID_RE.test(body.tokenId)) {
      return json({ error: "bad_request", message: "invalid tokenId" }, 400);
    }
    tokenId = body.tokenId;
  } else {
    tokenId = randomHex(TOKEN_BYTES);
  }
  const now = Date.now();
  const hash = await sha256Hex(tokenId);
  const expiresAt = now + PAIR_TTL_MS;
  // Atomic active-token cap: insert ONLY while the account is under the cap, in a
  // single INSERT…SELECT…WHERE. D1 serializes writes, so concurrent creates can't
  // both pass a stale count (closes the check-then-insert race). changes===0 → over cap.
  const res = await env.rbox_dev_db
    .prepare(
      `INSERT INTO pairing_tokens (token_hash, account_id, user_id, created_by, label, created_at, expires_at, mk_wrap, admission_grant)
       SELECT ?, ?, ?, ?, 'pair', ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM pairing_tokens WHERE account_id = ? AND consumed_at IS NULL AND expires_at > ?) < ?`
    )
    .bind(hash, p.accountId, p.userId, p.deviceId, now, expiresAt, mkWrap, admissionGrant, p.accountId, now, PAIR_ACTIVE_CAP)
    .run();
  if ((res.meta.changes ?? 0) === 0) return json({ error: "too_many_pairing_tokens", cap: PAIR_ACTIVE_CAP }, 429);
  return json({ token: `${PAIR_PREFIX}${tokenId}`, expiresAt });
}

/**
 * POST /v1/auth/pair/redeem — PUBLIC. Atomically consume an unexpired, unused
 * token (UPDATE … RETURNING is the sole single-use gate), then FAIL-CLOSED
 * re-validate live authority — the creating device is still non-revoked AND the
 * user still has a membership — before minting. A token from a since-revoked
 * device is consumed and rejected (never mints). Uniform 401 for every failure.
 */
export async function redeemPairToken(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { token?: string; label?: string };
  const raw = typeof body.token === "string" ? body.token : "";
  const token = raw.startsWith(PAIR_PREFIX) ? raw.slice(PAIR_PREFIX.length) : raw;
  // Accept both a client tokenId (C6) and a legacy 64-hex token — both stored as
  // sha256(<id>), so one lookup covers both. Bound the format before hashing.
  if (!PAIR_TOKEN_ID_RE.test(token)) return json({ error: "unauthorized" }, 401);
  const label = (typeof body.label === "string" ? body.label : "paired").slice(0, 200);
  const hash = await sha256Hex(token);
  const now = Date.now();

  // Atomic single-use consume + snapshot — only the row-winning redeem gets a row.
  // Also returns the opaque E2EE material (NULL for legacy tokens), handed back so
  // the new device can unwrap MK + author its admission roster delta (V4-1).
  const consumed = await env.rbox_dev_db
    .prepare("UPDATE pairing_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING account_id, user_id, created_by, mk_wrap, admission_grant")
    .bind(now, hash, now)
    .first<{ account_id: string; user_id: string; created_by: string; mk_wrap: string | null; admission_grant: string | null }>();
  if (!consumed) return json({ error: "unauthorized" }, 401); // invalid / expired / already used

  // Fail-closed live authority check: creator device non-revoked AND user a member.
  const live = await env.rbox_dev_db
    .prepare(
      `SELECT 1 FROM memberships m
       JOIN devices d ON d.account_id = m.account_id AND d.user_id = m.user_id
       WHERE m.account_id = ? AND m.user_id = ? AND d.device_id = ? AND d.revoked = 0`
    )
    .bind(consumed.account_id, consumed.user_id, consumed.created_by)
    .first();
  if (!live) return json({ error: "unauthorized" }, 401); // source revoked / membership gone (token already burned)

  const deviceId = `dev_${randomHex(4)}`;
  try {
    const minted = await mintDevice(env, consumed.account_id, consumed.user_id, deviceId, label);
    // Pass the opaque E2EE material straight through (null for legacy tokens).
    // accountId lets the redeemer namespace its keystore — but the client trusts
    // only the SIGNED accountId (verified roster/grant), cross-checking this (D7).
    return json({ token: minted, deviceId, accountId: consumed.account_id, mkWrap: consumed.mk_wrap, admissionGrant: consumed.admission_grant });
  } catch (e) {
    console.error("pair redeem: mint failed after consume (token burned):", String((e as Error)?.message ?? e));
    return json({ error: "internal" }, 500);
  }
}

// POST /v1/auth/device/bootstrap { secret, label } -> { token, deviceId, accountId }
// Creates a fresh account + owner user + device (the trust anchor for a new tenant).
export async function bootstrap(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { secret?: string; label?: string; accountName?: string };
  const secret = env.RBOX_BOOTSTRAP_SECRET ?? "";
  if (!secret || typeof body.secret !== "string" || !ctEqual(body.secret, secret)) {
    return json({ error: "unauthorized" }, 401); // constant-time, identical failure
  }
  const now = Date.now();
  const accountId = `acct_${randomHex(8)}`;
  const userId = `user_${randomHex(8)}`;
  await env.rbox_dev_db.prepare("INSERT INTO accounts (id, name, plan, created_at) VALUES (?, ?, 'free', ?)").bind(accountId, body.accountName ?? "account", now).run();
  await env.rbox_dev_db.prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(userId, accountId, now).run();
  await env.rbox_dev_db.prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(accountId, userId).run();
  const deviceId = `dev_${randomHex(6)}`;
  const token = await mintDevice(env, accountId, userId, deviceId, body.label ?? "bootstrap");
  return json({ token, deviceId, accountId });
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
    .prepare("SELECT user_code, status, device_id, label, expires_at, account_id, user_id FROM device_auth WHERE device_code = ?")
    .bind(body.deviceCode)
    .first<{ user_code: string; status: string; device_id: string; label: string | null; expires_at: number; account_id: string | null; user_id: string | null }>();
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
    // Mint into the APPROVER's account/user (device-to-device join).
    const token = await mintDevice(env, row.account_id ?? "default", row.user_id ?? "", row.device_id, row.label);
    return json({ status: "approved", token, deviceId: row.device_id, accountId: row.account_id });
  }
  return json({ status: row.status });
}

// POST /v1/auth/device/approve { userCode }  (authed) — the new device joins the approver's account.
export async function approveDeviceAuth(req: Request, env: Env, approver: Principal): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { userCode?: string };
  if (typeof body.userCode !== "string") return json({ error: "bad_request" }, 400);
  const res = await env.rbox_dev_db
    .prepare("UPDATE device_auth SET status = 'approved', account_id = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
    .bind(approver.accountId, approver.userId, body.userCode.toUpperCase(), Date.now())
    .run();
  if (res.meta.changes !== 1) return json({ error: "no_pending_auth" }, 404);
  return json({ ok: true });
}

// GET /v1/auth/devices  (authed) -> device list, SCOPED to the caller's account.
export async function listDevices(env: Env, self: Principal): Promise<Response> {
  const rows = await env.rbox_dev_db
    .prepare("SELECT device_id, label, created_at, last_seen_at FROM devices WHERE revoked = 0 AND account_id = ? ORDER BY created_at")
    .bind(self.accountId)
    .all<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null }>();
  return json({ devices: (rows.results ?? []).map((r) => ({ ...r, isSelf: r.device_id === self.deviceId })) });
}

// POST /v1/auth/devices/:deviceId/revoke  (authed) — only within the caller's account.
export async function revokeDevice(env: Env, self: Principal, deviceId: string): Promise<Response> {
  const res = await env.rbox_dev_db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ? AND account_id = ?").bind(deviceId, self.accountId).run();
  return json({ ok: true, revoked: res.meta.changes });
}
