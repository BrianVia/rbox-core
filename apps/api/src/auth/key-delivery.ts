import type { JsonValue } from "../../../../src/json.js";
import type { Env } from "../env.js";
import type { Principal } from "../authz.js";
import { dbFor, dirDb } from "../db.js";
import { ipKey, rateLimited } from "../ratelimit.js";
import {
  cappedJson,
  exactObject,
  json,
  logErr,
  objectWithKeys,
  sha256Hex,
  utf8Bytes,
} from "../util.js";
import { activeDeviceExistsSql } from "./devices.js";

export const KEY_DELIVERY_TTL_MS = 10 * 60 * 1000;
export const KEY_DELIVERY_ACTIVE_CAP = 5;
export const KEY_DELIVERY_FETCH_MAX_BYTES = 1024;
export const KEY_DELIVERY_SUBMIT_MAX_BYTES = 512 * 1024;
export const KEY_DELIVERY_ACK_MAX_BYTES = 1024;
export const KEY_DELIVERY_WRAP_MAX_BYTES = 256 * 1024;
export const CLERK_STEP_UP_MAX_AGE_MINUTES = 10;

const REQUEST_ID_RE = /^[0-9a-f]{64}$/;
const B64URL_RE = /^[A-Za-z0-9_-]+$/;
const FINGERPRINT_RE = /^[A-Za-z0-9_-]{43}$/;

export interface DevicePublicKeys {
  encPubKey: string;
  sigPubKey: string;
}

export interface QueueDeliveryInput extends DevicePublicKeys {
  requestId: string;
  userCode: string;
  accountId: string;
  userId: string | null;
  fingerprint: string;
  approvalTokenHash: string;
  approvalFactorVerifiedAt: number;
  accountEpoch: number;
  now: number;
  /** The device-code's own `expires_at`. The delivery MUST NOT outlive the
   * device-code login it fulfills (design 189 §7.2: the escrow/delivery shares
   * the device-code TTL), so its expiry is clamped to this. Both TTLs are 10min
   * but anchored at different events — device-code at login-start, delivery at
   * queue-time — so an unclamped `now + TTL` always lands *after* the
   * device-code expiry and the CLI rejects the delivery ("outside the
   * device-code TTL"). Clamping aligns them. */
  deviceCodeExpiresAt: number;
}

function decodeBase64url(value: string): Uint8Array | null {
  if (!value || !B64URL_RE.test(value)) return null;
  try {
    const b64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const raw = atob(b64);
    const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
    let roundTrip = "";
    for (const b of bytes) roundTrip += String.fromCharCode(b);
    const encoded = btoa(roundTrip).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return encoded === value ? bytes : null;
  } catch {
    return null;
  }
}

function base64url(bytes: Uint8Array): string {
  let raw = "";
  for (const b of bytes) raw += String.fromCharCode(b);
  return btoa(raw).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Validate the exact public-key encodings before they become approval input. */
export async function validateDevicePublicKeys(keys: DevicePublicKeys): Promise<boolean> {
  const sig = decodeBase64url(keys.sigPubKey);
  const enc = decodeBase64url(keys.encPubKey);
  if (!sig || sig.byteLength !== 32 || !enc || enc.byteLength < 384 || enc.byteLength > 4096) return false;
  try {
    const key = await crypto.subtle.importKey(
      "spki",
      enc,
      { name: "RSA-OAEP", hash: "SHA-256" },
      true,
      ["encrypt"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", key) as JsonWebKey;
    return jwk.kty === "RSA" && typeof jwk.n === "string" && decodeBase64url(jwk.n)!.byteLength === 384
      && jwk.e === "AQAB";
  } catch {
    return false;
  }
}

/** RFC 8785/JCS is deterministic here because the value is a fixed two-string object. */
export async function publicKeyFingerprint(keys: DevicePublicKeys): Promise<string> {
  const canonical = JSON.stringify({ encPubKeySpki: keys.encPubKey, sigPubKey: keys.sigPubKey });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return base64url(new Uint8Array(digest));
}

export function validFingerprint(value: string): boolean {
  return FINGERPRINT_RE.test(value);
}

/** Free cap/uniqueness slots whose requests are already terminal by policy.
 * The partial unique index deliberately keys on state (SQLite partial indexes
 * cannot depend on the current clock), so approval performs this account-local
 * terminalization before attempting its atomic queue+approve batch. */
async function expireStaleAccountRequests(env: Env, accountId: string, now: number): Promise<void> {
  const db = dirDb(env);
  await db.batch([
    db.prepare(
      `UPDATE key_delivery
       SET state='expired',wrap_blob=NULL,published_roster_version=NULL
       WHERE account_id=? AND state IN ('queued','fulfilled') AND (
         expires_at<=?
         OR approval_factor_verified_at<=?
         OR account_epoch<>(SELECT MAX(account_epoch) FROM account_key_states WHERE account_id=key_delivery.account_id)
         OR (target_device_id IS NOT NULL AND NOT ${activeDeviceExistsSql()})
       )`,
    ).bind(accountId, now, now - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000),
    db.prepare(
      `DELETE FROM device_token_escrow
       WHERE account_id=? AND expires_at<=?`,
    ).bind(accountId, now),
  ]);
}

/** Insert the delivery first, then approve only if that exact insert exists.
 * Both statements are one D1 batch; cap/duplicate failures therefore cannot
 * leave `device_auth` approved without its promised delivery. */
export async function queueKeyDelivery(env: Env, input: QueueDeliveryInput): Promise<
  { ok: true; expiresAt: number } | { ok: false; reason: "no_pending_auth" | "cap" | "duplicate" | "epoch_changed" | "disabled" }
> {
  await expireStaleAccountRequests(env, input.accountId, input.now);
  // Clamp to the device-code expiry: a delivery must never outlive the login
  // that authorized it (design 189 §7.2). With equal 10min TTLs but a
  // queue-after-start offset, `now + TTL` is always past `deviceCodeExpiresAt`,
  // so the clamp aligns the delivery to the device-code window; the CLI's
  // `deliveryExpiry <= deviceCodeExpiry` invariant then holds.
  const expiresAt = Math.min(input.now + KEY_DELIVERY_TTL_MS, input.deviceCodeExpiresAt);
  const encHash = await sha256Hex(decodeBase64url(input.encPubKey)!);
  const sigHash = await sha256Hex(decodeBase64url(input.sigPubKey)!);
  const db = dirDb(env);
  try {
    const [queued, approved] = await db.batch([
      db.prepare(
        `INSERT INTO key_delivery
           (request_id,account_id,target_device_id,enc_pub_key_hash,sig_pub_key_hash,
            pubkey_fingerprint,approval_token_hash,approval_factor_verified_at,
            state,account_epoch,created_at,expires_at)
         SELECT ?,?,NULL,?,?,?,?,?,'queued',?,?,?
         FROM device_auth da
         WHERE da.user_code=? AND da.status='pending' AND da.expires_at>?
           AND da.request_id=? AND da.enc_pub_key=? AND da.sig_pub_key=?
           AND ?>?
           AND COALESCE((
             SELECT enabled FROM account_key_delivery_prefs WHERE account_id=?
           ),1)=1
           AND EXISTS (SELECT 1 FROM accounts WHERE id=? AND deleted_at IS NULL)
           AND ?=(SELECT MAX(account_epoch) FROM account_key_states WHERE account_id=?)
           AND (SELECT COUNT(*) FROM key_delivery
                WHERE account_id=? AND state IN ('queued','fulfilled') AND expires_at>?)<?
           AND NOT EXISTS (
             SELECT 1 FROM key_delivery
             WHERE account_id=? AND enc_pub_key_hash=?
               AND state IN ('queued','fulfilled') AND expires_at>?
           )`,
      ).bind(
        input.requestId,
        input.accountId,
        encHash,
        sigHash,
        input.fingerprint,
        input.approvalTokenHash,
        input.approvalFactorVerifiedAt,
        input.accountEpoch,
        input.now,
        expiresAt,
        input.userCode,
        input.now,
        input.requestId,
        input.encPubKey,
        input.sigPubKey,
        input.approvalFactorVerifiedAt,
        input.now - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000,
        input.accountId,
        input.accountId,
        input.accountEpoch,
        input.accountId,
        input.accountId,
        input.now,
        KEY_DELIVERY_ACTIVE_CAP,
        input.accountId,
        encHash,
        input.now,
      ),
      db.prepare(
        `UPDATE device_auth
         SET status='approved',account_id=?,user_id=?
         WHERE user_code=? AND status='pending' AND expires_at>?
           AND EXISTS (
             SELECT 1 FROM key_delivery
             WHERE request_id=? AND account_id=? AND approval_token_hash=? AND state='queued'
           )`,
      ).bind(
        input.accountId,
        input.userId,
        input.userCode,
        input.now,
        input.requestId,
        input.accountId,
        input.approvalTokenHash,
      ),
    ]);
    if ((queued?.meta.changes ?? 0) === 1 && (approved?.meta.changes ?? 0) === 1) {
      return { ok: true, expiresAt };
    }
  } catch (error) {
    const message = String((error as Error)?.message ?? error).toLowerCase();
    if (message.includes("account_id") && message.includes("enc_pub_key_hash")) {
      return { ok: false, reason: "duplicate" };
    }
    throw error;
  }

  const [auth, active, duplicate, epoch, prefs] = await Promise.all([
    db.prepare("SELECT status,expires_at FROM device_auth WHERE user_code=?").bind(input.userCode).first<{ status: string; expires_at: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM key_delivery WHERE account_id=? AND state IN ('queued','fulfilled') AND expires_at>?")
      .bind(input.accountId, input.now).first<{ n: number }>(),
    db.prepare(
      "SELECT 1 FROM key_delivery WHERE account_id=? AND enc_pub_key_hash=? AND state IN ('queued','fulfilled') AND expires_at>? LIMIT 1",
    ).bind(input.accountId, encHash, input.now).first(),
    currentAccountEpoch(env, input.accountId),
    db.prepare("SELECT enabled FROM account_key_delivery_prefs WHERE account_id=?")
      .bind(input.accountId).first<{ enabled: number }>(),
  ]);
  if (prefs?.enabled === 0 && auth?.status === "pending" && auth.expires_at > input.now) {
    return { ok: false, reason: "disabled" };
  }
  if (duplicate) return { ok: false, reason: "duplicate" };
  if ((active?.n ?? 0) >= KEY_DELIVERY_ACTIVE_CAP) return { ok: false, reason: "cap" };
  if (epoch !== input.accountEpoch) return { ok: false, reason: "epoch_changed" };
  if (!auth || auth.status !== "pending" || auth.expires_at <= input.now) {
    return { ok: false, reason: "no_pending_auth" };
  }
  return { ok: false, reason: "no_pending_auth" };
}

export interface KeyDeliveryPoll {
  status: "pending" | "ready" | "delivered" | "expired";
  requestId: string;
  expiresAt: number;
  mkWrapDevice?: string;
  publishedRosterVersion?: number;
  accountEpoch?: number;
}

async function expireRequest(env: Env, requestId: string, now: number): Promise<void> {
  const db = dirDb(env);
  await db.batch([
    db.prepare(
      `UPDATE key_delivery
       SET state='expired',wrap_blob=NULL,published_roster_version=NULL
       WHERE request_id=? AND state IN ('queued','fulfilled')
         AND (
           expires_at<=?
           OR approval_factor_verified_at<=?
           OR account_epoch<>(SELECT MAX(account_epoch) FROM account_key_states WHERE account_id=key_delivery.account_id)
           OR (target_device_id IS NOT NULL AND NOT ${activeDeviceExistsSql()})
         )`,
    ).bind(requestId, now, now - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000),
    db.prepare(
      `DELETE FROM device_token_escrow
       WHERE request_id=? AND expires_at<=?`,
    ).bind(requestId, now),
  ]);
}

/** Public device-code polling is authenticated by the 256-bit device_code whose
 * SHA-256 is requestId. It never exposes a different request. */
export async function pollKeyDelivery(env: Env, requestId: string, now = Date.now()): Promise<KeyDeliveryPoll | null> {
  await expireRequest(env, requestId, now);
  const row = await dirDb(env)
    .prepare(
      `SELECT request_id,state,wrap_blob,published_roster_version,account_epoch,expires_at
       FROM key_delivery WHERE request_id=?`,
    )
    .bind(requestId)
    .first<{
      request_id: string;
      state: "queued" | "fulfilled" | "delivered" | "expired";
      wrap_blob: string | null;
      published_roster_version: number | null;
      account_epoch: number;
      expires_at: number;
    }>();
  if (!row) return null;
  if (row.state === "fulfilled" && row.wrap_blob !== null && row.published_roster_version !== null) {
    return {
      status: "ready",
      requestId: row.request_id,
      expiresAt: row.expires_at,
      mkWrapDevice: row.wrap_blob,
      publishedRosterVersion: row.published_roster_version,
      accountEpoch: row.account_epoch,
    };
  }
  return {
    status: row.state === "queued" || row.state === "fulfilled" ? "pending" : row.state,
    requestId: row.request_id,
    expiresAt: row.expires_at,
  };
}

interface FetchBody {
  requestId?: string;
  keyReleaseOptIn: boolean;
}

export function validateKeyDeliveryFetchBody(value: JsonValue): FetchBody | null {
  if (!objectWithKeys(value, ["keyReleaseOptIn", "requestId"], ["keyReleaseOptIn"])) return null;
  if (typeof value.keyReleaseOptIn !== "boolean") return null;
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId))) return null;
  return {
    keyReleaseOptIn: value.keyReleaseOptIn,
    ...(value.requestId === undefined ? {} : { requestId: value.requestId }),
  };
}

function daemonMayRelease(p: Principal): boolean {
  return p.kind === "device";
}

async function deviceReleaseEnabled(env: Env, p: Principal): Promise<boolean> {
  if (!daemonMayRelease(p)) return false;
  const row = await dirDb(env)
    .prepare("SELECT key_release_enabled FROM devices WHERE device_id=? AND account_id=? AND revoked=0")
    .bind(p.deviceId, p.accountId)
    .first<{ key_release_enabled: number }>();
  return row?.key_release_enabled === 1;
}

/** Any authenticated live daemon reads either its nudged request or the oldest
 * queued request for poll-only fallback. The transmitted opt-in is persisted
 * before selection, so pull-only mode cannot inherit default-on. */
export async function fetchKeyDeliveryRequest(req: Request, env: Env, p: Principal): Promise<Response> {
  const limited = await rateLimited(env.RL_KEY_DELIVERY_FETCH, `kdf:${p.deviceId}`);
  if (limited) return limited;
  if (!daemonMayRelease(p)) return json({ error: "forbidden" }, 403);
  const parsed = await cappedJson(req, { maxBytes: KEY_DELIVERY_FETCH_MAX_BYTES }, validateKeyDeliveryFetchBody);
  if (!parsed.ok) return parsed.response;
  const db = dirDb(env);
  const desiredPreference = parsed.value.keyReleaseOptIn ? 1 : 0;
  const preference = await db
    .prepare(
      `SELECT key_release_enabled FROM devices
       WHERE device_id=? AND account_id=? AND revoked=0`,
    )
    .bind(p.deviceId, p.accountId)
    .first<{ key_release_enabled: number }>();
  if (!preference) return json({ error: "forbidden" }, 403);
  if (preference.key_release_enabled !== desiredPreference) {
    const changed = await db
      .prepare(
        `UPDATE devices SET key_release_enabled=?
         WHERE device_id=? AND account_id=? AND revoked=0`,
      )
      .bind(desiredPreference, p.deviceId, p.accountId)
      .run();
    if (changed.meta.changes !== 1) return json({ error: "forbidden" }, 403);
  }
  if (!parsed.value.keyReleaseOptIn) {
    return json({ request: null, keyReleaseEnabled: false });
  }
  const now = Date.now();
  if (parsed.value.requestId) await expireRequest(env, parsed.value.requestId, now);
  const requestFilter = parsed.value.requestId ? "AND kd.request_id=?" : "";
  const bindings: unknown[] = [
    p.accountId,
    now,
    p.accountId,
    now - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000,
  ];
  if (parsed.value.requestId) bindings.push(parsed.value.requestId);
  const row = await db
    .prepare(
      `SELECT kd.request_id,kd.target_device_id,kd.enc_pub_key_hash,kd.sig_pub_key_hash,
              kd.pubkey_fingerprint,kd.approval_token_hash,kd.account_epoch,kd.created_at,
              kd.expires_at,da.enc_pub_key,da.sig_pub_key
       FROM key_delivery kd
       JOIN device_auth da ON da.request_id=kd.request_id
       WHERE kd.account_id=? AND kd.state='queued' AND kd.expires_at>?
         AND kd.target_device_id IS NOT NULL
         AND ${activeDeviceExistsSql("kd")}
         AND kd.account_epoch=(
           SELECT MAX(account_epoch) FROM account_key_states WHERE account_id=?
         )
         AND kd.approval_factor_verified_at>?
         ${requestFilter}
       ORDER BY kd.created_at LIMIT 1`,
    )
    .bind(...bindings)
    .first<{
      request_id: string;
      target_device_id: string;
      enc_pub_key_hash: string;
      sig_pub_key_hash: string;
      pubkey_fingerprint: string;
      approval_token_hash: string;
      account_epoch: number;
      created_at: number;
      expires_at: number;
      enc_pub_key: string;
      sig_pub_key: string;
    }>();
  if (!row) return json({ request: null });
  return json({
    request: {
      requestId: row.request_id,
      targetDeviceId: row.target_device_id,
      encPubKey: row.enc_pub_key,
      sigPubKey: row.sig_pub_key,
      encPubKeyHash: row.enc_pub_key_hash,
      sigPubKeyHash: row.sig_pub_key_hash,
      pubkeyFingerprint: row.pubkey_fingerprint,
      approvalTokenHash: row.approval_token_hash,
      accountEpoch: row.account_epoch,
      approvedAt: row.created_at,
      expiresAt: row.expires_at,
    },
  });
}

interface SubmitBody {
  requestId: string;
  mkWrapDevice: string;
  publishedRosterVersion: number;
  accountEpoch: number;
}

export function validateKeyDeliverySubmitBody(value: JsonValue): SubmitBody | null {
  if (!exactObject(value, ["requestId", "mkWrapDevice", "publishedRosterVersion", "accountEpoch"])) return null;
  if (typeof value.requestId !== "string" || !REQUEST_ID_RE.test(value.requestId)) return null;
  if (typeof value.mkWrapDevice !== "string" || value.mkWrapDevice.length === 0 || utf8Bytes(value.mkWrapDevice) > KEY_DELIVERY_WRAP_MAX_BYTES) return null;
  if (typeof value.publishedRosterVersion !== "number" || !Number.isSafeInteger(value.publishedRosterVersion) || value.publishedRosterVersion < 0) return null;
  if (typeof value.accountEpoch !== "number" || !Number.isSafeInteger(value.accountEpoch) || value.accountEpoch < 0) return null;
  return {
    requestId: value.requestId,
    mkWrapDevice: value.mkWrapDevice,
    publishedRosterVersion: value.publishedRosterVersion,
    accountEpoch: value.accountEpoch,
  };
}

/** Single fulfillment CAS. The roster/device rows must already be committed and
 * the submitted roster must still be the published head. */
export async function submitKeyDeliveryBlob(req: Request, env: Env, p: Principal): Promise<Response> {
  const limited = await rateLimited(env.RL_KEY_DELIVERY_SUBMIT, `kds:${p.deviceId}`);
  if (limited) return limited;
  if (!await deviceReleaseEnabled(env, p)) return json({ error: "forbidden" }, 403);
  const parsed = await cappedJson(req, { maxBytes: KEY_DELIVERY_SUBMIT_MAX_BYTES }, validateKeyDeliverySubmitBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const now = Date.now();
  await expireRequest(env, body.requestId, now);
  const res = await dirDb(env)
    .prepare(
      `UPDATE key_delivery
       SET state='fulfilled',wrap_blob=?,published_roster_version=?,
           fulfilling_device_id=?,fulfilled_at=?
       WHERE request_id=? AND account_id=? AND state='queued' AND expires_at>?
         AND target_device_id IS NOT NULL
         AND ${activeDeviceExistsSql()}
         AND approval_factor_verified_at>?
         AND account_epoch=?
         AND account_epoch=(
           SELECT MAX(account_epoch) FROM account_key_states WHERE account_id=key_delivery.account_id
         )
         AND ?=(
           SELECT MAX(version) FROM rosters WHERE account_id=key_delivery.account_id
         )
         AND EXISTS (
           SELECT 1 FROM device_keys dk
           JOIN device_auth da ON da.request_id=key_delivery.request_id
           WHERE dk.device_id=key_delivery.target_device_id
             AND dk.account_id=key_delivery.account_id
             AND dk.enc_pubkey=da.enc_pub_key AND dk.sig_pubkey=da.sig_pub_key
             AND dk.mk_wrap=?
         )
         AND EXISTS (
           SELECT 1 FROM devices source_device
           WHERE source_device.device_id=? AND source_device.account_id=?
             AND source_device.revoked=0 AND source_device.key_release_enabled=1
         )
       RETURNING request_id`,
    )
    .bind(
      body.mkWrapDevice,
      body.publishedRosterVersion,
      p.deviceId,
      now,
      body.requestId,
      p.accountId,
      now,
      now - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000,
      body.accountEpoch,
      body.publishedRosterVersion,
      body.mkWrapDevice,
      p.deviceId,
      p.accountId,
    )
    .first<{ request_id: string }>();
  if (res) return json({ ok: true, requestId: res.request_id });
  const existing = await dirDb(env)
    .prepare(
      "SELECT state,expires_at,wrap_blob,published_roster_version,account_epoch FROM key_delivery WHERE request_id=? AND account_id=?",
    )
    .bind(body.requestId, p.accountId)
    .first<{
      state: string;
      expires_at: number;
      wrap_blob: string | null;
      published_roster_version: number | null;
      account_epoch: number;
    }>();
  if (!existing) return json({ error: "not_found" }, 404);
  if (
    existing.state === "fulfilled"
    && existing.expires_at > now
    && existing.wrap_blob === body.mkWrapDevice
    && existing.published_roster_version === body.publishedRosterVersion
    && existing.account_epoch === body.accountEpoch
  ) {
    return json({ ok: true, requestId: body.requestId, alreadyFulfilled: true });
  }
  if (existing.state === "fulfilled" || existing.state === "delivered") {
    return json({ error: "already_fulfilled" }, 409);
  }
  if (existing.state === "expired" || existing.expires_at <= now) return json({ error: "expired" }, 410);
  return json({ error: "publish_not_current" }, 409);
}

interface AckBody {
  requestId: string;
}

export function validateKeyDeliveryAckBody(value: JsonValue): AckBody | null {
  return exactObject(value, ["requestId"])
    && typeof value.requestId === "string"
    && REQUEST_ID_RE.test(value.requestId)
    ? { requestId: value.requestId }
    : null;
}

export async function ackKeyDelivery(req: Request, env: Env, p: Principal): Promise<Response> {
  const limited = await rateLimited(env.RL_KEY_DELIVERY_ACK, `kda:${p.deviceId}`);
  if (limited) return limited;
  if (p.kind !== "device") return json({ error: "forbidden" }, 403);
  const parsed = await cappedJson(req, { maxBytes: KEY_DELIVERY_ACK_MAX_BYTES }, validateKeyDeliveryAckBody);
  if (!parsed.ok) return parsed.response;
  const now = Date.now();
  await expireRequest(env, parsed.value.requestId, now);
  const db = dirDb(env);
  const [acked] = await db.batch([
    db.prepare(
      `UPDATE key_delivery
       SET state='delivered',wrap_blob=NULL,published_roster_version=NULL,delivered_at=?
       WHERE request_id=? AND account_id=? AND target_device_id=?
         AND state='fulfilled' AND expires_at>?
         AND ${activeDeviceExistsSql()}`,
    ).bind(now, parsed.value.requestId, p.accountId, p.deviceId, now),
    db.prepare(
      `DELETE FROM device_token_escrow
       WHERE request_id=? AND account_id=? AND device_id=?
         AND EXISTS (
           SELECT 1 FROM key_delivery
           WHERE request_id=device_token_escrow.request_id AND state='delivered'
         )`,
    ).bind(parsed.value.requestId, p.accountId, p.deviceId),
  ]);
  if ((acked?.meta.changes ?? 0) === 1) {
    return json({ ok: true, alreadyDelivered: false });
  }
  const row = await db
    .prepare(
      `SELECT state,expires_at FROM key_delivery
       WHERE request_id=? AND account_id=? AND target_device_id=?
         AND ${activeDeviceExistsSql()}`,
    )
    .bind(parsed.value.requestId, p.accountId, p.deviceId)
    .first<{ state: string; expires_at: number }>();
  if (!row) return json({ error: "not_found" }, 404);
  if (row.state === "delivered" && row.expires_at > now) {
    return json({ ok: true, alreadyDelivered: true });
  }
  if (row.state === "expired" || row.expires_at <= now) return json({ error: "expired" }, 410);
  return json({ error: "not_ready" }, 409);
}

/** Scheduled bounded terminalization. No expired request can be revived because
 * every writer also carries an independent expiry predicate. */
export async function sweepKeyDeliveries(env: Env, now = Date.now(), limit = 500): Promise<number> {
  const db = dirDb(env);
  const stale = await db
    .prepare(
      `SELECT request_id FROM key_delivery
       WHERE state IN ('queued','fulfilled') AND (
         expires_at<=?
         OR approval_factor_verified_at<=?
         OR account_epoch<>(SELECT MAX(account_epoch) FROM account_key_states WHERE account_id=key_delivery.account_id)
         OR (target_device_id IS NOT NULL AND NOT ${activeDeviceExistsSql()})
       )
       ORDER BY expires_at LIMIT ?`,
    )
    .bind(now, now - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000, limit)
    .all<{ request_id: string }>();
  const ids = stale.results ?? [];
  if (ids.length === 0) {
    await db.prepare("DELETE FROM device_token_escrow WHERE expires_at<=?").bind(now).run();
    return 0;
  }
  const placeholders = ids.map(() => "?").join(",");
  await db.batch([
    db.prepare(
      `UPDATE key_delivery SET state='expired',wrap_blob=NULL,published_roster_version=NULL
       WHERE request_id IN (${placeholders}) AND state IN ('queued','fulfilled')`,
    ).bind(...ids.map((row) => row.request_id)),
    db.prepare(
      `DELETE FROM device_token_escrow
       WHERE expires_at<=?`,
    ).bind(now),
  ]);
  return ids.length;
}

/** Notification-only wakeup. The authoritative daemon path always polls, so a DO
 * failure cannot lose delivery. */
export function nudgeKeyDelivery(
  ctx: Pick<ExecutionContext, "waitUntil">,
  env: Env,
  accountId: string,
  requestId: string,
): void {
  ctx.waitUntil((async () => {
    try {
      const rows = await dbFor(env, accountId)
        .prepare("SELECT workspace_id,project_id FROM workspaces WHERE account_id=? LIMIT 500")
        .bind(accountId)
        .all<{ workspace_id: string; project_id: string }>();
      await Promise.all((rows.results ?? []).map(async (row) => {
        const id = env.WORKSPACE_SYNC.idFromName(`${row.workspace_id}/${row.project_id}`);
        await env.WORKSPACE_SYNC.get(id).fetch("https://do/key-delivery-nudge", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ requestId }),
        });
      }));
    } catch (error) {
      logErr("key_delivery_nudge_failed", error);
    }
  })());
}

export async function currentAccountEpoch(env: Env, accountId: string): Promise<number | null> {
  const row = await dbFor(env, accountId)
    .prepare("SELECT MAX(account_epoch) AS epoch FROM account_key_states WHERE account_id=?")
    .bind(accountId)
    .first<{ epoch: number | null }>();
  return row?.epoch ?? null;
}

export async function requestIdForDeviceCode(deviceCode: string): Promise<string> {
  return sha256Hex(deviceCode);
}
