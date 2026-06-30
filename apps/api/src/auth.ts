import type { Env } from "./env.js";
import { ctEqual, json, logErr, sha256Hex } from "./util.js";
import { capBytesFor } from "./plans.js";
import { audit, type Principal } from "./authz.js";
import { clientGeo, clientIp, enqueueNotify, prepareOutboxInsert } from "./notify.js";
import { dbFor, dirDb } from "./db.js";


/**
 * Self-hosted device-token auth (M4). Per-device opaque tokens, stored only as
 * sha256 hashes in D1, validated per request (immediate revocation). Issued via
 * a CLI device-authorization flow: bootstrap (secret) or device-to-device
 * approval. The token is minted on the FIRST poll after approval and returned
 * exactly once (one-time claim) — never stored in plaintext, never re-returned.
 */

const TOKEN_BYTES = 32;
const DEVICE_ID_BYTES = 16; // 128-bit device_id space → collisions are negligible (P1)
const MINT_MAX_ATTEMPTS = 5; // bounded retries when a unique INSERT collides (P1)
const AUTH_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 5;
const LAST_SEEN_THROTTLE_MS = 10 * 60 * 1000;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I

export function randomHex(bytes: number): string {
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
  // expires_at is now SELECTed (not just used in the WHERE) so we can derive the
  // token KIND (design 21 §1.1): durable CLI token (expires_at IS NULL) vs a
  // short-lived browser web session. The worker default-denies `web` off every
  // crypto/sync/credential-mint route.
  const row = await dirDb(env)
    .prepare(
      `SELECT d.device_id, d.account_id, d.user_id, d.last_seen_at, d.expires_at, m.role AS role
       FROM devices d LEFT JOIN memberships m ON m.account_id = d.account_id AND m.user_id = d.user_id
       WHERE d.token_hash = ? AND d.revoked = 0 AND (d.expires_at IS NULL OR d.expires_at > ?)`
    )
    .bind(hash, Date.now())
    .first<{ device_id: string; account_id: string; user_id: string | null; last_seen_at: number | null; expires_at: number | null; role: string | null }>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_seen_at || now - row.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    await dirDb(env).prepare("UPDATE devices SET last_seen_at = ? WHERE token_hash = ?").bind(now, hash).run().catch(() => {});
  }
  return { deviceId: row.device_id, accountId: row.account_id, userId: row.user_id, role: row.role ?? "viewer", kind: row.expires_at === null ? "durable" : "web" };
}

/** True when a D1/SQLite write failed a UNIQUE constraint (token_hash or device_id). */
export function isUniqueViolation(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? e));
}

/** Mint a device token into a specific account/user (returns the plaintext once,
 *  plus the generated `device_id`). `expiresAt` (epoch ms) makes it a short-lived
 *  token (web sessions); omit for durable CLI/device tokens.
 *
 *  `device_id` is GLOBALLY UNIQUE (migration 0013), so a colliding INSERT throws.
 *  We retry with a fresh token + device_id on a uniqueness violation (bounded), so
 *  the astronomically-rare collision self-heals instead of surfacing a 500.
 *  `genDeviceId` is the id source (default `${prefix}_<128-bit hex>`); it's
 *  injectable so callers can seed a specific first candidate and tests can force a
 *  collision. */
export async function mintDevice(
  env: Env,
  accountId: string,
  userId: string,
  prefix: string,
  label: string | null,
  expiresAt: number | null = null,
  genDeviceId: () => string = () => `${prefix}_${randomHex(DEVICE_ID_BYTES)}`,
): Promise<{ token: string; deviceId: string }> {
  return mintWithRetry(env, "mintDevice", async () => {
    const m = await prepareMintDevice(env, accountId, userId, prefix, label, expiresAt, genDeviceId);
    return { value: { token: m.token, deviceId: m.deviceId }, statements: [m.insert] };
  });
}

/** The bounded uniqueness-retry loop shared by every durable/web mint path. `attempt`
 *  builds one attempt — a return value plus the statement list to commit ATOMICALLY (the
 *  device INSERT alone, or device + notification outbox). On a `device_id`/`token_hash`
 *  collision the WHOLE batch is retried (fresh token + id); any other error surfaces
 *  immediately. Single-sourcing the loop keeps the attempt cap + violation matcher + the
 *  exhaustion error in one place. */
async function mintWithRetry<T>(env: Env, label: string, attempt: () => Promise<{ value: T; statements: D1PreparedStatement[] }>): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < MINT_MAX_ATTEMPTS; i++) {
    const { value, statements } = await attempt();
    try {
      // §32: the device credential is directory-plane, so the batch runs on dirDb.
      // FLAG: mintDeviceWithNotification rides an account-data `device_notifications`
      // outbox INSERT in this same batch (§6f) — a cross-plane coupling that is one
      // binding at N=1 but needs splitting under real sharding.
      await dirDb(env).batch(statements);
      return value;
    } catch (e) {
      lastErr = e;
      if (!isUniqueViolation(e)) throw e; // unrelated failure → surface immediately
      // token_hash or device_id collided → regenerate both and retry
    }
  }
  throw new Error(`${label}: exhausted ${MINT_MAX_ATTEMPTS} attempts: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

/** A device mint, PREPARED (token generated, INSERT not yet run) so a caller can batch
 *  it atomically with another statement — notably the new-device-notification outbox
 *  row (design 30 §3.4). Returns the plaintext token + `token_hash` + `device_id`. The
 *  caller owns the uniqueness-retry by re-calling this and rebuilding its batch. */
export async function prepareMintDevice(
  env: Env,
  accountId: string,
  userId: string,
  prefix: string,
  label: string | null,
  expiresAt: number | null = null,
  genDeviceId: () => string = () => `${prefix}_${randomHex(DEVICE_ID_BYTES)}`,
): Promise<{ token: string; tokenHash: string; deviceId: string; insert: D1PreparedStatement }> {
  const deviceId = genDeviceId();
  const token = randomHex(TOKEN_BYTES);
  const tokenHash = await sha256Hex(token);
  const insert = dirDb(env)
    .prepare("INSERT INTO devices (token_hash, device_id, label, account_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(tokenHash, deviceId, label, accountId, userId, Date.now(), expiresAt);
  return { token, tokenHash, deviceId, insert };
}

export interface MintNotifyOpts {
  accountId: string;
  userId: string;
  label: string | null;
  event: "pair" | "device_code";
  ip: string | null;
  geo: string | null;
  /** Optional first-candidate seeding (device-code reuses its proposed id first). */
  genDeviceId?: () => string;
}

/** Mint a DURABLE device AND its notification outbox row in ONE atomic D1 batch, so
 *  "if the device exists, its notification exists" (design 16 §2.3). The whole batch is
 *  retried on a `device_id`/`token_hash` uniqueness collision (the mint retry, lifted up
 *  a level), keeping device+outbox coextensive. The returned `tokenHash` is the enqueue
 *  key — the credential verifier itself never egresses. */
export async function mintDeviceWithNotification(env: Env, o: MintNotifyOpts): Promise<{ token: string; deviceId: string; tokenHash: string }> {
  const createdAt = Date.now();
  const minted = await mintWithRetry(env, "mintDeviceWithNotification", async () => {
    const m = await prepareMintDevice(env, o.accountId, o.userId, "dev", o.label, null, o.genDeviceId);
    const outbox = prepareOutboxInsert(env, { tokenHash: m.tokenHash, deviceId: m.deviceId, accountId: o.accountId, mintedUserId: o.userId, label: o.label, ip: o.ip, geo: o.geo, event: o.event, createdAt });
    return { value: { token: m.token, deviceId: m.deviceId, tokenHash: m.tokenHash }, statements: [m.insert, outbox] };
  });
  // Fold the best-effort post-commit enqueue in here so a durable-mint call site can't
  // forget it — the function owns the whole notification contract. A lost enqueue is
  // re-driven by the cron backstop off the durable outbox row (enqueueNotify never throws).
  await enqueueNotify(env, minted.tokenHash);
  return minted;
}

/** Mint a SHORT-LIVED web session token (M11) for a Clerk-authenticated user.
 *  Returns the plaintext once; expires after `ttlMs` (default 1h). */
export async function createWebSession(env: Env, accountId: string, userId: string, ttlMs = 60 * 60 * 1000): Promise<{ token: string; deviceId: string }> {
  return mintDevice(env, accountId, userId, "web", "web", Date.now() + ttlMs);
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
  // memberships is directory-plane (authenticate JOINs devices↔memberships, §32 §2).
  const member = await dirDb(env)
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
  const res = await dirDb(env)
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
  const consumed = await dirDb(env)
    .prepare("UPDATE pairing_tokens SET consumed_at = ? WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING account_id, user_id, created_by, mk_wrap, admission_grant")
    .bind(now, hash, now)
    .first<{ account_id: string; user_id: string; created_by: string; mk_wrap: string | null; admission_grant: string | null }>();
  if (!consumed) return json({ error: "unauthorized" }, 401); // invalid / expired / already used

  // §31 (codex MAJOR2, r2): scrub the at-rest MK/admission ciphertext the INSTANT `consumed`
  // holds it — BEFORE any later return (e.g. the live-authority 401 below), since the token is
  // already single-use-burned and a consumed-then-rejected row must not retain mk_wrap. The TTL
  // is an API freshness gate, NOT crypto expiry; retained wrap + a later tokenSecret leak could
  // recover MK. Best-effort: a scrub failure only weakens defense-in-depth, never blocks.
  await dirDb(env).prepare("UPDATE pairing_tokens SET mk_wrap = NULL, admission_grant = NULL WHERE token_hash = ?").bind(hash).run().catch(() => {});

  // Fail-closed live authority check: creator device non-revoked AND user a member.
  const live = await dirDb(env)
    .prepare(
      `SELECT 1 FROM memberships m
       JOIN devices d ON d.account_id = m.account_id AND d.user_id = m.user_id
       WHERE m.account_id = ? AND m.user_id = ? AND d.device_id = ? AND d.revoked = 0`
    )
    .bind(consumed.account_id, consumed.user_id, consumed.created_by)
    .first();
  if (!live) return json({ error: "unauthorized" }, 401); // source revoked / membership gone (token already burned)

  try {
    // Durable credential mint → also write the new-device-notification outbox row in
    // the SAME atomic batch, then enqueue (design 16 §1.1: notify on a durable mint via
    // pairing-redeem). The owner — not the joining user — is the recipient (resolved in
    // the consumer). Email is strictly downstream; it never blocks the join.
    const { token: minted, deviceId } = await mintDeviceWithNotification(env, {
      accountId: consumed.account_id,
      userId: consumed.user_id,
      label,
      event: "pair",
      ip: clientIp(req),
      geo: clientGeo(req),
    });
    // Pass the opaque E2EE material straight through (null for legacy tokens).
    // accountId lets the redeemer namespace its keystore — but the client trusts
    // only the SIGNED accountId (verified roster/grant), cross-checking this (D7).
    return json({ token: minted, deviceId, accountId: consumed.account_id, mkWrap: consumed.mk_wrap, admissionGrant: consumed.admission_grant });
  } catch (e) {
    logErr("pair_redeem_mint_failed", e); // token burned; no raw message (touches account/device material)
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
  // origin='bootstrap' marks this as a crypto-anchored account (design 21 §3.2) — never
  // auto-reclaimable. cap_bytes is the materialized §23 hard-cap (kept in sync by the trigger).
  await dbFor(env, accountId)
    .prepare("INSERT INTO accounts (id, name, plan, origin, created_at, cap_bytes) VALUES (?, ?, 'free', 'bootstrap', ?, ?)")
    .bind(accountId, body.accountName ?? "account", now, capBytesFor("free"))
    .run();
  // users/memberships are directory-plane (authenticate JOINs memberships, §32 §2).
  await dirDb(env).prepare("INSERT INTO users (id, account_id, created_at) VALUES (?, ?, ?)").bind(userId, accountId, now).run();
  await dirDb(env).prepare("INSERT INTO memberships (account_id, user_id, role) VALUES (?, ?, 'owner')").bind(accountId, userId).run();
  const { token, deviceId } = await mintDevice(env, accountId, userId, "dev", body.label ?? "bootstrap");
  return json({ token, deviceId, accountId });
}

// POST /v1/auth/device/start { label } -> { deviceCode, userCode, interval, expiresIn }
export async function startDeviceAuth(req: Request, env: Env): Promise<Response> {
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
  if (typeof body.deviceCode !== "string") return json({ error: "bad_request" }, 400);
  const row = await dirDb(env)
    .prepare("SELECT user_code, status, device_id, label, expires_at, account_id, user_id FROM device_auth WHERE device_code = ?")
    .bind(body.deviceCode)
    .first<{ user_code: string; status: string; device_id: string; label: string | null; expires_at: number; account_id: string | null; user_id: string | null }>();
  if (!row) return json({ status: "not_found" }, 404);
  if (Date.now() > row.expires_at && row.status === "pending") return json({ status: "expired" });
  if (row.status === "pending") return json({ status: "pending", interval: POLL_INTERVAL_S });
  if (row.status === "claimed") return json({ status: "claimed" }); // token already delivered, never again
  if (row.status === "approved") {
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
    const { token, deviceId } = await mintDeviceWithNotification(env, {
      accountId: row.account_id ?? "default",
      userId: row.user_id ?? "",
      label: row.label,
      event: "device_code",
      ip: clientIp(req),
      geo: clientGeo(req),
      genDeviceId: () => (firstCandidate ? ((firstCandidate = false), row.device_id) : `dev_${randomHex(DEVICE_ID_BYTES)}`),
    });
    return json({ status: "approved", token, deviceId, accountId: row.account_id });
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

// GET /v1/auth/devices  (authed) -> device list, SCOPED to the caller's account.
export async function listDevices(env: Env, self: Principal): Promise<Response> {
  const rows = await dirDb(env)
    .prepare("SELECT device_id, label, created_at, last_seen_at FROM devices WHERE revoked = 0 AND account_id = ? ORDER BY created_at")
    .bind(self.accountId)
    .all<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null }>();
  return json({ devices: (rows.results ?? []).map((r) => ({ ...r, isSelf: r.device_id === self.deviceId })) });
}

/**
 * POST /v1/auth/devices/:deviceId/revoke (authed, design 19a / design 22 §4.1).
 *
 * ACCESS revocation only — it flips `devices.revoked` so the token 401s on its next
 * call, but it does NOT cryptographically evict the device's cached MK/KEKs (E2EE
 * epoch rotation is unbuilt, design 22 §1.3/§4.2). Callers surface that ceiling in
 * the UI; the server makes no claim beyond "the token is dead."
 *
 * Authorization is an ATOMIC guarded UPDATE (no SELECT-then-write race): any role
 * may revoke ITS OWN device; only owner/admin may revoke ANOTHER device in the
 * account. `device_id` is globally unique (migration 0013), so the WHERE matches at
 * most one row. A `changes==0` outcome is then disambiguated by a follow-up READ
 * (purely to pick the status code — it never gates the write): unknown-in-my-account
 * → 404 (uniform with cross-account, no enumeration leak), already-revoked →
 * idempotent 200, otherwise insufficient role → 403.
 */
export async function revokeDevice(env: Env, self: Principal, deviceId: string): Promise<Response> {
  const privileged = self.role === "owner" || self.role === "admin" ? 1 : 0;
  const res = await dirDb(env)
    .prepare("UPDATE devices SET revoked = 1 WHERE device_id = ? AND account_id = ? AND revoked = 0 AND (device_id = ? OR ? = 1)")
    .bind(deviceId, self.accountId, self.deviceId, privileged)
    .run();
  if ((res.meta.changes ?? 0) === 1) {
    await audit(env, self, deviceId === self.deviceId ? "device.revoke.self" : "device.revoke", deviceId);
    return json({ ok: true, revoked: 1 });
  }
  // changes==0: choose the response without leaking cross-account existence.
  const row = await dirDb(env)
    .prepare("SELECT revoked FROM devices WHERE device_id = ? AND account_id = ?")
    .bind(deviceId, self.accountId)
    .first<{ revoked: number }>();
  if (!row) return json({ error: "not_found" }, 404); // no such device in MY account (== cross-account)
  if (row.revoked === 1) return json({ ok: true, revoked: 0 }); // already revoked → idempotent, no audit spam
  return json({ error: "forbidden", message: "insufficient role to revoke another device" }, 403);
}

// ── /devices dashboard surface (design 22 §2) ────────────────────────────────
// Account-scoped, web-facing, camelCase, secret-free projections of the devices &
// workspaces a Clerk web session owns. Deliberately SEPARATE from the snake_case
// CLI contract `GET /v1/auth/devices` (`rbox device list` parses that) so neither
// regresses. Responses NEVER include `token_hash`, `account_id`, `user_id`, raw
// `expires_at`, or any key/roster material — `kind` is the only `expires_at`
// projection, and the server makes no claim about E2EE roster status (design §2.1).

const ACCOUNT_LIST_LIMIT_DEFAULT = 50;
const ACCOUNT_LIST_LIMIT_MAX = 100;
const DEVICE_LABEL_MAX = 256; // projection cap; the renderer also sanitizes (XSS/escaping)

function parseLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return ACCOUNT_LIST_LIMIT_DEFAULT;
  return Math.min(Math.floor(raw), ACCOUNT_LIST_LIMIT_MAX);
}

/** Opaque keyset cursor over `(created_at, rowid)`. It encodes ONLY public ordering
 *  position (never `token_hash` or any secret) and every query that consumes it is
 *  account-scoped server-side, so a tampered cursor can at most re-page the caller's
 *  OWN account from a different offset — never cross-tenant. The values are bound as
 *  parameters (never string-interpolated), and a malformed cursor is rejected (400). */
function encodeCursor(createdAt: number, rowid: number): string {
  return btoa(`${createdAt}.${rowid}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(raw: string): { createdAt: number; rowid: number } | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const m = /^(\d{1,15})\.(\d{1,15})$/.exec(decoded);
    if (!m) return null;
    return { createdAt: Number(m[1]), rowid: Number(m[2]) };
  } catch {
    return null;
  }
}

/** Slice a `limit+1`-fetched result set into a page plus the opaque cursor for the
 *  next page (null when there's none). The off-by-one sentinel logic is identical for
 *  every keyset list endpoint, so it lives in exactly one place. */
function keysetPage<T extends { created_at: number; rid: number }>(results: T[] | undefined, limit: number): { page: T[]; nextCursor: string | null } {
  const all = results ?? [];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  return { page, nextCursor: all.length > limit && last ? encodeCursor(last.created_at, last.rid) : null };
}

interface DeviceRow {
  rid: number;
  device_id: string;
  label: string | null;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number | null;
}

/** GET /v1/account/devices?include=cli|all&limit&cursor — the caller's devices. */
export async function accountDevices(env: Env, p: Principal, url: URL): Promise<Response> {
  const includeAll = url.searchParams.get("include") === "all";
  const limit = parseLimit(url);
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return json({ error: "bad_request", message: "invalid cursor" }, 400);

  const binds: (string | number)[] = [p.accountId];
  // The OR parentheses are LOAD-BEARING (design §2.1): without them `AND` binds
  // tighter than `OR` and every account's live web sessions would leak cross-tenant.
  let where = "revoked = 0 AND account_id = ?";
  if (includeAll) {
    where += " AND (expires_at IS NULL OR expires_at > ?)"; // durable OR a LIVE (unexpired) web session
    binds.push(Date.now());
  } else {
    where += " AND expires_at IS NULL"; // default: durable CLI devices only, not browser tabs
  }
  if (cursor) {
    where += " AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    binds.push(cursor.createdAt, cursor.createdAt, cursor.rowid);
  }
  binds.push(limit + 1); // +1 sentinel → is there a next page?

  const rows = await dirDb(env)
    .prepare(`SELECT rowid AS rid, device_id, label, created_at, last_seen_at, expires_at FROM devices WHERE ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .bind(...binds)
    .all<DeviceRow>();
  const { page, nextCursor } = keysetPage(rows.results, limit);

  return json({
    devices: page.map((r) => ({
      deviceId: r.device_id,
      label: r.label === null ? null : r.label.slice(0, DEVICE_LABEL_MAX),
      kind: r.expires_at === null ? "cli" : "web", // the ONLY projection of expires_at
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      isCurrent: r.device_id === p.deviceId,
    })),
    nextCursor,
  });
}

interface WorkspaceRow {
  rid: number;
  workspace_id: string;
  project_id: string;
  created_at: number;
}

/** GET /v1/account/workspaces?limit&cursor — the caller's sync roots. Under E2EE the
 *  server holds NO folder name/path; `projectId` is a PK component returned verbatim. */
export async function accountWorkspaces(env: Env, p: Principal, url: URL): Promise<Response> {
  const limit = parseLimit(url);
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return json({ error: "bad_request", message: "invalid cursor" }, 400);

  const binds: (string | number)[] = [p.accountId];
  let where = "account_id = ?";
  if (cursor) {
    where += " AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    binds.push(cursor.createdAt, cursor.createdAt, cursor.rowid);
  }
  binds.push(limit + 1);

  const rows = await dbFor(env, p.accountId)
    .prepare(`SELECT rowid AS rid, workspace_id, project_id, created_at FROM workspaces WHERE ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .bind(...binds)
    .all<WorkspaceRow>();
  const { page, nextCursor } = keysetPage(rows.results, limit);

  return json({
    workspaces: page.map((r) => ({ workspaceId: r.workspace_id, projectId: r.project_id, createdAt: r.created_at })),
    nextCursor,
  });
}
