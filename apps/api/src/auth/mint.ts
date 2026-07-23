import type { Env } from "../env.js";
import { sha256Hex } from "../util.js";
import { enqueueNotify, prepareOutboxInsert } from "../notify.js";
import { dbFor, dirDb } from "../db.js";
import { planFor } from "../plans.js";
import { DEVICE_ID_BYTES, isUniqueViolation, randomHex, TOKEN_BYTES } from "./shared.js";

const MINT_MAX_ATTEMPTS = 5; // bounded retries when a unique INSERT collides (P1)
const ESCROW_CONTEXT = "rbox/device-token-escrow/v1";

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
      const results = await dirDb(env).batch(statements);
      // design 37: statements[0] is the liveness-guarded device INSERT. changes==0 means the
      // account was tombstoned (or vanished) mid-flight, so NO `devices` row was written (and the
      // outbox INSERT, guarded identically, also wrote nothing) → the mint FAILS, no orphan rows.
      // A uniqueness collision THROWS (caught below) rather than returning 0, so 0 is unambiguous.
      if ((results[0]?.meta.changes ?? 0) === 0) throw new AccountGoneError(label);
      return value;
    } catch (e) {
      lastErr = e;
      if (e instanceof AccountGoneError) throw e; // account tombstoned mid-mint → surface (no retry)
      if (!isUniqueViolation(e)) throw e; // unrelated failure → surface immediately
      // token_hash or device_id collided → regenerate both and retry
    }
  }
  throw new Error(`${label}: exhausted ${MINT_MAX_ATTEMPTS} attempts: ${String((lastErr as Error)?.message ?? lastErr)}`);
}

/** Thrown when a mint is blocked because its target account was TOMBSTONED mid-flight (the
 *  liveness-guarded device INSERT landed 0 rows). Public mint routes catch it and return a clean
 *  "account deleted" error instead of a 500 — no `devices` row was written (design 37). */
export class AccountGoneError extends Error {
  constructor(label: string) {
    super(`${label}: account tombstoned mid-mint`);
    this.name = "AccountGoneError";
  }
}

/** Thrown when a durable mint is blocked by the per-account device cap. Carries
 *  cap + plan for the public 409 DTO; handler preflights keep grants unburned,
 *  and this remains the mint-path backstop. */
export class DeviceLimitError extends Error {
  constructor(
    readonly cap: number,
    readonly plan: string,
  ) {
    super(`device limit reached (cap ${cap} on ${plan})`);
    this.name = "DeviceLimitError";
  }
}

/** The device cap for a plan. Only explicit `RBOX_ENV === "dev"` disables it. */
function deviceCapFor(env: Env, plan: string | null | undefined): number {
  return env.RBOX_ENV === "dev" ? Infinity : planFor(plan).devices;
}

/** accounts.plan for the cap (account-data plane). Missing rows fail closed. */
export async function readPlan(env: Env, accountId: string): Promise<string> {
  if (accountId === "default") return "none";
  const row = await dbFor(env, accountId).prepare("SELECT plan FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string }>();
  return row?.plan ?? "none";
}

/** Count of an account's durable, non-revoked device credentials. */
async function durableDeviceCount(env: Env, accountId: string): Promise<number> {
  const row = await dirDb(env).prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ? AND expires_at IS NULL AND revoked = 0").bind(accountId).first<{ n: number }>();
  return row?.n ?? 0;
}

interface DeviceCapStatus {
  ok: boolean;
  cap: number;
  plan: string;
}

/** Preflight the durable-device cap without minting. Full accounts 409 before a
 *  one-time grant is consumed; the legacy 'default' account and explicit dev env
 *  are unbounded. Read errors fail closed, and the mint backstop catches the
 *  remaining check-then-mint race. */
export async function checkDeviceCap(env: Env, accountId: string): Promise<DeviceCapStatus> {
  const plan = await readPlan(env, accountId);
  const cap = accountId === "default" ? Infinity : deviceCapFor(env, plan);
  if (!Number.isFinite(cap)) return { ok: true, cap, plan };
  return { ok: (await durableDeviceCount(env, accountId)) < cap, cap, plan };
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
  // Mint backstop for durable credentials. Keep this separate from the design-37
  // guarded INSERT so changes==0 remains tombstone-only; handlers preflight to
  // avoid burning grants, and this catches concurrent overshoot.
  if (expiresAt === null) {
    const status = await checkDeviceCap(env, accountId);
    if (!status.ok) throw new DeviceLimitError(status.cap, status.plan);
  }
  const deviceId = genDeviceId();
  const token = randomHex(TOKEN_BYTES);
  const tokenHash = await sha256Hex(token);
  // design 37: COUPLE the device insert to account liveness so a mint can't create a `devices`
  // row for a TOMBSTONED account even if deletion tombstones it AFTER a caller's pre-mint
  // liveness read (the TOCTOU). The guarded INSERT…SELECT…WHERE EXISTS lands 0 rows when the
  // account is gone; `mintWithRetry` detects changes==0 and fails the mint (no row written). The
  // legacy platform account 'default' (which may have no `accounts` row) is the sole bypass,
  // matching authenticate(). §32 FLAG: the `accounts` EXISTS sub-select is account-data plane
  // while `devices` is directory-plane — one binding at N=1, a cross-plane coupling under sharding.
  const insert = dirDb(env)
    .prepare(
      `INSERT INTO devices (token_hash, device_id, label, account_id, user_id, created_at, expires_at, kind)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?
       WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL) OR ? = 'default'`,
    )
    .bind(tokenHash, deviceId, label, accountId, userId, Date.now(), expiresAt, expiresAt === null ? "device" : "web", accountId, accountId);
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

function bytesToBase64url(bytes: Uint8Array): string {
  let raw = "";
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(b64), (char) => char.charCodeAt(0));
}

async function escrowKey(env: Env): Promise<CryptoKey> {
  // A dedicated secret can rotate independently. Existing deployments remain
  // safe during rollout by deriving a domain-separated key from the already
  // required high-entropy bootstrap secret.
  const secret = env.RBOX_DEVICE_TOKEN_ESCROW_KEY || env.RBOX_BOOTSTRAP_SECRET;
  if (!secret) throw new Error("device token escrow key unavailable");
  const raw = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${ESCROW_CONTEXT}\0${secret}`),
  );
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function escrowAad(requestId: string, deviceId: string, tokenHash: string): Uint8Array {
  return new TextEncoder().encode(`${ESCROW_CONTEXT}\0${requestId}\0${deviceId}\0${tokenHash}`);
}

async function encryptEscrowToken(
  env: Env,
  requestId: string,
  deviceId: string,
  tokenHash: string,
  token: string,
): Promise<{ ciphertext: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: escrowAad(requestId, deviceId, tokenHash) },
    await escrowKey(env),
    new TextEncoder().encode(token),
  );
  return { ciphertext: bytesToBase64url(new Uint8Array(encrypted)), iv: bytesToBase64url(iv) };
}

export interface EscrowedDeviceToken {
  token: string;
  tokenHash: string;
  deviceId: string;
  accountId: string;
  expiresAt: number;
}

/** Recover the exact bearer committed by a winning concurrent/crashed poll. */
export async function recoverEscrowedDeviceToken(
  env: Env,
  requestId: string,
  now = Date.now(),
): Promise<EscrowedDeviceToken | null> {
  const row = await dirDb(env)
    .prepare(
      `SELECT e.token_ciphertext,e.token_iv,e.token_hash,e.device_id,e.account_id,e.expires_at
       FROM device_token_escrow e
       JOIN device_auth da ON da.request_id=e.request_id
       WHERE e.request_id=? AND e.expires_at>? AND da.status='claimed'`,
    )
    .bind(requestId, now)
    .first<{
      token_ciphertext: string;
      token_iv: string;
      token_hash: string;
      device_id: string;
      account_id: string;
      expires_at: number;
    }>();
  if (!row) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: base64urlToBytes(row.token_iv),
        additionalData: escrowAad(requestId, row.device_id, row.token_hash),
      },
      await escrowKey(env),
      base64urlToBytes(row.token_ciphertext),
    );
    const token = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plaintext);
    if (await sha256Hex(token) !== row.token_hash) return null;
    return {
      token,
      tokenHash: row.token_hash,
      deviceId: row.device_id,
      accountId: row.account_id,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

export interface ClaimDeviceAuthOpts {
  deviceCode: string;
  requestId: string;
  accountId: string;
  userId: string;
  label: string | null;
  proposedDeviceId: string;
  expiresAt: number;
  ip: string | null;
  geo: string | null;
  now?: number;
  genDeviceId?: () => string;
  /** Crash-injection seam: runs after the atomic batch and before enqueue/response. */
  afterCommit?: () => void | Promise<void>;
}

/** Atomic device-code claim + mint + delivery retarget + encrypted token escrow.
 *
 * Every statement after the claim is guarded by this attempt's random
 * `claim_nonce`. A losing concurrent batch therefore writes zero rows, then
 * decrypts the winning escrow; a uniqueness throw rolls the whole batch back and
 * retries with fresh credentials. */
export async function claimDeviceAuthWithEscrow(
  env: Env,
  opts: ClaimDeviceAuthOpts,
): Promise<EscrowedDeviceToken | null> {
  const now = opts.now ?? Date.now();
  const recovered = await recoverEscrowedDeviceToken(env, opts.requestId, now);
  if (recovered) return recovered;

  const capStatus = await checkDeviceCap(env, opts.accountId);
  if (!capStatus.ok) throw new DeviceLimitError(capStatus.cap, capStatus.plan);
  const cap = Number.isFinite(capStatus.cap) ? capStatus.cap : Number.MAX_SAFE_INTEGER;
  let firstCandidate = true;
  let lastError: unknown;
  for (let attempt = 0; attempt < MINT_MAX_ATTEMPTS; attempt++) {
    const deviceId = firstCandidate
      ? ((firstCandidate = false), opts.proposedDeviceId)
      : (opts.genDeviceId?.() ?? `dev_${randomHex(DEVICE_ID_BYTES)}`);
    const token = randomHex(TOKEN_BYTES);
    const tokenHash = await sha256Hex(token);
    const claimNonce = randomHex(TOKEN_BYTES);
    const encrypted = await encryptEscrowToken(env, opts.requestId, deviceId, tokenHash, token);
    const db = dirDb(env);
    const liveAccount = `(EXISTS (SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL) OR ?='default')`;
    try {
      const results = await db.batch([
        db.prepare(
          `UPDATE device_auth
           SET status='claimed',claim_nonce=?,request_id=COALESCE(request_id,?),device_id=?
           WHERE device_code=? AND (request_id=? OR request_id IS NULL) AND status='approved' AND expires_at>?
             AND account_id=? AND ${liveAccount}
             AND (SELECT COUNT(*) FROM devices
                  WHERE account_id=? AND expires_at IS NULL AND revoked=0)<?`,
        ).bind(
          claimNonce,
          opts.requestId,
          deviceId,
          opts.deviceCode,
          opts.requestId,
          now,
          opts.accountId,
          opts.accountId,
          opts.accountId,
          opts.accountId,
          cap,
        ),
        db.prepare(
          `INSERT INTO devices
             (token_hash,device_id,label,account_id,user_id,created_at,expires_at,kind)
           SELECT ?,?,?,?,?,?,NULL,'device' FROM device_auth
           WHERE device_code=? AND request_id=? AND claim_nonce=? AND status='claimed'`,
        ).bind(
          tokenHash,
          deviceId,
          opts.label,
          opts.accountId,
          opts.userId,
          now,
          opts.deviceCode,
          opts.requestId,
          claimNonce,
        ),
        db.prepare(
          `UPDATE key_delivery SET target_device_id=?
           WHERE request_id=? AND account_id=? AND state='queued' AND expires_at>?
             AND approval_factor_verified_at>?
             AND account_epoch=(
               SELECT MAX(account_epoch) FROM account_key_states
               WHERE account_id=key_delivery.account_id
             )
             AND EXISTS (
               SELECT 1 FROM device_auth da JOIN devices d ON d.device_id=?
               WHERE da.device_code=? AND da.request_id=? AND da.claim_nonce=?
                 AND da.status='claimed' AND d.token_hash=? AND d.revoked=0
             )`,
        ).bind(
          deviceId,
          opts.requestId,
          opts.accountId,
          now,
          now - 10 * 60_000,
          deviceId,
          opts.deviceCode,
          opts.requestId,
          claimNonce,
          tokenHash,
        ),
        db.prepare(
          `INSERT INTO device_notifications
             (token_hash,device_id,account_id,minted_user_id,label,ip,geo,event,created_at,
              keys_granted,key_fingerprint)
           SELECT ?,?,?,?,?,?,?, 'device_code',?,
             CASE WHEN EXISTS (
               SELECT 1 FROM key_delivery
               WHERE request_id=? AND account_id=? AND target_device_id=?
                 AND state='queued' AND expires_at>?
             ) THEN 1 ELSE 0 END,
             (SELECT pubkey_fingerprint FROM key_delivery
              WHERE request_id=? AND account_id=? AND target_device_id=?
                AND state='queued' AND expires_at>?)
           FROM device_auth
           WHERE device_code=? AND request_id=? AND claim_nonce=? AND status='claimed'`,
        ).bind(
          tokenHash,
          deviceId,
          opts.accountId,
          opts.userId,
          opts.label,
          opts.ip,
          opts.geo,
          now,
          opts.requestId,
          opts.accountId,
          deviceId,
          now,
          opts.requestId,
          opts.accountId,
          deviceId,
          now,
          opts.deviceCode,
          opts.requestId,
          claimNonce,
        ),
        db.prepare(
          `INSERT INTO device_token_escrow
             (request_id,account_id,device_id,token_hash,token_ciphertext,token_iv,created_at,expires_at)
           SELECT ?,?,?,?,?,?,?,?
           FROM device_auth
           WHERE device_code=? AND request_id=? AND claim_nonce=? AND status='claimed'
             AND EXISTS (SELECT 1 FROM devices WHERE token_hash=? AND device_id=?)`,
        ).bind(
          opts.requestId,
          opts.accountId,
          deviceId,
          tokenHash,
          encrypted.ciphertext,
          encrypted.iv,
          now,
          opts.expiresAt,
          opts.deviceCode,
          opts.requestId,
          claimNonce,
          tokenHash,
          deviceId,
        ),
      ]);
      if ((results[0]?.meta.changes ?? 0) === 0) {
        const winner = await recoverEscrowedDeviceToken(env, opts.requestId, now);
        if (winner) return winner;
        const auth = await db
          .prepare("SELECT status FROM device_auth WHERE device_code=? AND request_id=?")
          .bind(opts.deviceCode, opts.requestId)
          .first<{ status: string }>();
        // A committed winner whose escrow is no longer recoverable remains a
        // claimed one-time code; never misreport it as a fresh cap/liveness race.
        if (auth?.status !== "approved") return null;
        if (opts.accountId !== "default") {
          const live = await dbFor(env, opts.accountId)
            .prepare("SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL")
            .bind(opts.accountId)
            .first();
          if (!live) throw new AccountGoneError("claimDeviceAuthWithEscrow");
        }
        const currentCap = await checkDeviceCap(env, opts.accountId);
        if (!currentCap.ok) throw new DeviceLimitError(currentCap.cap, currentCap.plan);
        return null;
      }
      const expected = [
        results[0]?.meta.changes,
        results[1]?.meta.changes,
        results[3]?.meta.changes,
        results[4]?.meta.changes,
      ];
      if (expected.some((changes) => changes !== 1)) {
        throw new Error(`device-code claim batch invariant: ${expected.join("/")}`);
      }
      await opts.afterCommit?.();
      await enqueueNotify(env, tokenHash);
      return { token, tokenHash, deviceId, accountId: opts.accountId, expiresAt: opts.expiresAt };
    } catch (error) {
      lastError = error;
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error(`claimDeviceAuthWithEscrow: exhausted ${MINT_MAX_ATTEMPTS} attempts: ${String((lastError as Error)?.message ?? lastError)}`);
}

/** Mint a SHORT-LIVED web session token (M11) for a Clerk-authenticated user.
 *  Returns the plaintext once; expires after `ttlMs` (default 1h). */
export async function createWebSession(env: Env, accountId: string, userId: string, ttlMs = 60 * 60 * 1000): Promise<{ token: string; deviceId: string }> {
  return mintDevice(env, accountId, userId, "web", "web", Date.now() + ttlMs);
}
