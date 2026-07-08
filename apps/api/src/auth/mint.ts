import type { Env } from "../env.js";
import { sha256Hex } from "../util.js";
import { enqueueNotify, prepareOutboxInsert } from "../notify.js";
import { dbFor, dirDb } from "../db.js";
import { planFor } from "../plans.js";
import { DEVICE_ID_BYTES, isUniqueViolation, randomHex, TOKEN_BYTES } from "./shared.js";

const MINT_MAX_ATTEMPTS = 5; // bounded retries when a unique INSERT collides (P1)

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
async function readPlan(env: Env, accountId: string): Promise<string> {
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

/** Mint a SHORT-LIVED web session token (M11) for a Clerk-authenticated user.
 *  Returns the plaintext once; expires after `ttlMs` (default 1h). */
export async function createWebSession(env: Env, accountId: string, userId: string, ttlMs = 60 * 60 * 1000): Promise<{ token: string; deviceId: string }> {
  return mintDevice(env, accountId, userId, "web", "web", Date.now() + ttlMs);
}
