import type { Env } from "../env.js";
import { json } from "../util.js";
import type { Principal } from "../authz.js";
import { clientGeo, clientIp } from "../notify.js";
import { dbFor, dirDb } from "../db.js";
import { DEVICE_ID_BYTES, randomHex, TOKEN_BYTES } from "./shared.js";
import { AccountGoneError, checkDeviceCap, DeviceLimitError, mintDeviceWithNotification } from "./mint.js";
import { ipKey, rateLimited } from "../ratelimit.js";

const AUTH_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const DEVICE_CODE_HEX_RE = /^[0-9a-f]+$/;

function randomUserCode(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const c = [...b].map((x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

// POST /v1/auth/device/start { label } -> { deviceCode, userCode, interval, expiresIn }
export async function startDeviceAuth(req: Request, env: Env): Promise<Response> {
  // Per-IP burst cap before the unconditional D1 insert.
  const limited = await rateLimited(env.RL_DEVICE_START, `ds:${ipKey(req)}`);
  if (limited) return limited;
  const body = (await req.json().catch(() => ({}))) as { label?: string };
  const deviceCode = randomHex(TOKEN_BYTES);
  const deviceId = `dev_${randomHex(DEVICE_ID_BYTES)}`; // proposed id; mint is the real uniqueness gate
  const now = Date.now();
  // Collision-retry the human user_code among active auths.
  let userCode = randomUserCode();
  for (let i = 0; i < 5; i++) {
    const clash = await dirDb(env)
      .prepare("SELECT 1 FROM device_auth WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
      .bind(userCode, now)
      .first();
    if (!clash) break;
    userCode = randomUserCode();
  }
  await dirDb(env)
    .prepare("INSERT INTO device_auth (device_code, user_code, status, device_id, label, created_at, expires_at) VALUES (?, ?, 'pending', ?, ?, ?, ?)")
    .bind(deviceCode, userCode, deviceId, body.label ?? null, now, now + AUTH_TTL_MS)
    .run();
  return json({ deviceCode, userCode, interval: POLL_INTERVAL_S, expiresIn: Math.floor(AUTH_TTL_MS / 1000) });
}

// POST /v1/auth/device/poll { deviceCode } -> { status, token? }
export async function pollDeviceAuth(req: Request, env: Env): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { deviceCode?: string };
  if (typeof body.deviceCode !== "string" || body.deviceCode.length !== TOKEN_BYTES * 2 || !DEVICE_CODE_HEX_RE.test(body.deviceCode)) {
    return json({ error: "bad_request" }, 400);
  }
  // Reject malformed codes before limiter/D1 work. Valid-shaped polls hit both
  // the spray-floor IP bucket and the per-code fairness bucket.
  const ipLimited = await rateLimited(env.RL_DEVICE_POLL_IP, `dpi:${ipKey(req)}`);
  if (ipLimited) return ipLimited;
  const limited = await rateLimited(env.RL_DEVICE_POLL, `dp:${body.deviceCode}`);
  if (limited) return limited;
  const row = await dirDb(env)
    .prepare("SELECT user_code, status, device_id, label, expires_at, account_id, user_id FROM device_auth WHERE device_code = ?")
    .bind(body.deviceCode)
    .first<{ user_code: string; status: string; device_id: string; label: string | null; expires_at: number; account_id: string | null; user_id: string | null }>();
  if (!row) return json({ status: "not_found" }, 404);
  if (Date.now() > row.expires_at && row.status === "pending") return json({ status: "expired" });
  if (row.status === "pending") return json({ status: "pending", interval: POLL_INTERVAL_S });
  if (row.status === "claimed") return json({ status: "claimed" }); // token already delivered, never again
  if (row.status === "approved") {
    // design 37: never mint a device into a tombstoned/erased account. The approver's account
    // ('default' legacy excepted) must still exist and be live. Checked before the claim so a
    // doomed mint doesn't burn the one-time approval.
    const acctId = row.account_id ?? "default";
    if (acctId !== "default") {
      // accounts is account-data plane → a point read on the approver's account (design 37).
      const acctLive = await dbFor(env, acctId).prepare("SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL").bind(acctId).first();
      if (!acctLive) return json({ status: "expired" }); // account tombstoned/gone → can't mint
    }
    // Cap preflight runs before the one-time approval is claimed; over-cap leaves
    // the code approved for retry after a device is revoked.
    const cap = await checkDeviceCap(env, acctId);
    if (!cap.ok) return json({ error: "device_limit_reached", cap: cap.cap, plan: cap.plan }, 409);
    // One-time claim: only the poll that wins the conditional UPDATE mints+returns.
    const claim = await dirDb(env)
      .prepare("UPDATE device_auth SET status = 'claimed' WHERE device_code = ? AND status = 'approved'")
      .bind(body.deviceCode)
      .run();
    if (claim.meta.changes !== 1) return json({ status: "claimed" }); // lost the race
    // Mint into the APPROVER's account/user (device-to-device join). Seed the
    // proposed id from device_auth as the first candidate, but fall back to a
    // fresh wide id if it collides (mint is the real uniqueness gate). The device +
    // notification outbox commit atomically; then enqueue (design 16 §1.1: notify on a
    // durable mint via device-code claim).
    let firstCandidate = true;
    let minted: { token: string; deviceId: string };
    try {
      minted = await mintDeviceWithNotification(env, {
        accountId: row.account_id ?? "default",
        userId: row.user_id ?? "",
        label: row.label,
        event: "device_code",
        ip: clientIp(req),
        geo: clientGeo(req),
        genDeviceId: () => (firstCandidate ? ((firstCandidate = false), row.device_id) : `dev_${randomHex(DEVICE_ID_BYTES)}`),
      });
    } catch (e) {
      // design 37: account tombstoned between the liveness read and the device insert → the
      // guarded mint wrote NO rows. The device-code is already claimed (dead); report expired.
      if (e instanceof AccountGoneError) return json({ status: "expired" });
      // Mint backstop can still catch concurrent overshoot after the claim; report
      // the cap as a 409 instead of surfacing a 500.
      if (e instanceof DeviceLimitError) return json({ error: "device_limit_reached", cap: e.cap, plan: e.plan }, 409);
      throw e;
    }
    return json({ status: "approved", token: minted.token, deviceId: minted.deviceId, accountId: row.account_id });
  }
  return json({ status: row.status });
}

// POST /v1/auth/device/approve { userCode }  (authed) — the new device joins the approver's account.
export async function approveDeviceAuth(req: Request, env: Env, approver: Principal): Promise<Response> {
  const body = (await req.json().catch(() => ({}))) as { userCode?: string };
  if (typeof body.userCode !== "string") return json({ error: "bad_request" }, 400);
  const res = await dirDb(env)
    .prepare("UPDATE device_auth SET status = 'approved', account_id = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
    .bind(approver.accountId, approver.userId, body.userCode.toUpperCase(), Date.now())
    .run();
  if (res.meta.changes !== 1) return json({ error: "no_pending_auth" }, 404);
  return json({ ok: true });
}

// GET /v1/auth/device/lookup?code=XXXX-XXXX -> { label, status } | 404  (design 47)
// PUBLIC (no Principal, carries only a guessable-but-inert user_code — same
// guess-space as approve) — lets the web confirm page show "approve login for
// <label>?" before the user has necessarily signed in. Never returns
// account_id/user_id/tokens; a caller can at most confirm a pending login
// exists, not act on it (approving still requires an authed session).
export async function lookupDeviceAuth(req: Request, env: Env): Promise<Response> {
  const userCode = new URL(req.url).searchParams.get("code")?.toUpperCase();
  if (!userCode) return json({ error: "bad_request" }, 400);
  const row = await dirDb(env)
    .prepare("SELECT label, status, expires_at FROM device_auth WHERE user_code = ?")
    .bind(userCode)
    .first<{ label: string | null; status: string; expires_at: number }>();
  if (!row || (Date.now() > row.expires_at && row.status === "pending")) return json({ error: "not_found" }, 404);
  return json({ label: row.label, status: row.status });
}
