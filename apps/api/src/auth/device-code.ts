import type { Env } from "../env.js";
import type { JsonValue } from "../../../../src/json.js";
import { cappedJson, ctEqual, exactObject, isWellFormed, json, objectWithKeys, sha256Hex, truncateUtf8, utf8Bytes } from "../util.js";
import type { Principal } from "../authz.js";
import { clientGeo, clientIp } from "../notify.js";
import { dbFor, dirDb } from "../db.js";
import { DEVICE_ID_BYTES, randomHex, TOKEN_BYTES } from "./shared.js";
import { AccountGoneError, checkDeviceCap, claimDeviceAuthWithEscrow, DeviceLimitError, recoverEscrowedDeviceToken } from "./mint.js";
import { ipKey, rateLimited } from "../ratelimit.js";
import {
  CLERK_STEP_UP_MAX_AGE_MINUTES,
  currentAccountEpoch,
  nudgeKeyDelivery,
  pollKeyDelivery,
  publicKeyFingerprint,
  queueKeyDelivery,
  requestIdForDeviceCode,
  validateDevicePublicKeys,
  validFingerprint,
  type DevicePublicKeys,
} from "./key-delivery.js";
import { verifyFreshClerkStepUp } from "../clerk.js";

const AUTH_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_S = 5;
const USER_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous 0/O/1/I
const DEVICE_CODE_HEX_RE = /^[0-9a-f]+$/;
export const DEVICE_START_MAX_BYTES = 8 * 1024;
export const DEVICE_POLL_MAX_BYTES = 1024;
export const DEVICE_APPROVE_MAX_BYTES = 32 * 1024;

function randomUserCode(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  const c = [...b].map((x) => USER_CODE_ALPHABET[x % USER_CODE_ALPHABET.length]).join("");
  return `${c.slice(0, 4)}-${c.slice(4)}`;
}

export function validateDeviceStartBody(value: JsonValue): ({ label?: string } & Partial<DevicePublicKeys>) | null {
  if (!objectWithKeys(value, ["label", "encPubKey", "sigPubKey"])) return null;
  if ((value.encPubKey === undefined) !== (value.sigPubKey === undefined)) return null;
  if (value.encPubKey !== undefined && (
    typeof value.encPubKey !== "string"
    || typeof value.sigPubKey !== "string"
    || utf8Bytes(value.encPubKey) > 8192
    || utf8Bytes(value.sigPubKey) > 256
  )) return null;
  const keys = value.encPubKey === undefined
    ? {}
    : { encPubKey: value.encPubKey as string, sigPubKey: value.sigPubKey as string };
  if (value.label === undefined) return keys;
  if (typeof value.label !== "string" || !isWellFormed(value.label)) return null;
  return { label: truncateUtf8(value.label, 600), ...keys };
}

export function validateDevicePollBody(value: JsonValue): { deviceCode: string } | null {
  return exactObject(value, ["deviceCode"])
    && typeof value.deviceCode === "string"
    && value.deviceCode.length === TOKEN_BYTES * 2
    && DEVICE_CODE_HEX_RE.test(value.deviceCode)
    ? { deviceCode: value.deviceCode }
    : null;
}

export type DeviceApproveBody =
  | { userCode: string; keyConsent?: false }
  | { userCode: string; keyConsent: true; pubkeyFingerprint: string; clerkToken: string };

export function validateDeviceApproveBody(value: JsonValue): DeviceApproveBody | null {
  const validCode = (candidate: JsonValue | undefined): candidate is string =>
    typeof candidate === "string" && /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i.test(candidate);
  if (exactObject(value, ["userCode"]) && validCode(value.userCode)) return { userCode: value.userCode };
  if (
    exactObject(value, ["userCode", "keyConsent"])
    && validCode(value.userCode)
    && value.keyConsent === false
  ) return { userCode: value.userCode, keyConsent: false };
  if (
    exactObject(value, ["userCode", "keyConsent", "pubkeyFingerprint", "clerkToken"])
    && validCode(value.userCode)
    && value.keyConsent === true
    && typeof value.pubkeyFingerprint === "string"
    && validFingerprint(value.pubkeyFingerprint)
    && typeof value.clerkToken === "string"
    && utf8Bytes(value.clerkToken) <= 16_384
    && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value.clerkToken)
  ) {
    return {
      userCode: value.userCode,
      keyConsent: true,
      pubkeyFingerprint: value.pubkeyFingerprint,
      clerkToken: value.clerkToken,
    };
  }
  return null;
}

// POST /v1/auth/device/start { label } -> { deviceCode, userCode, interval, expiresIn }
export async function startDeviceAuth(req: Request, env: Env): Promise<Response> {
  // Per-IP burst cap before the unconditional D1 insert.
  const limited = await rateLimited(env.RL_DEVICE_START, `ds:${ipKey(req)}`);
  if (limited) return limited;
  const parsed = await cappedJson(req, { maxBytes: DEVICE_START_MAX_BYTES }, validateDeviceStartBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  if (
    body.encPubKey !== undefined
    && !await validateDevicePublicKeys({ encPubKey: body.encPubKey, sigPubKey: body.sigPubKey! })
  ) {
    return json({ error: "invalid_device_public_keys" }, 400);
  }
  const deviceCode = randomHex(TOKEN_BYTES);
  const requestId = await requestIdForDeviceCode(deviceCode);
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
    .prepare(
      `INSERT INTO device_auth
         (device_code,user_code,status,device_id,label,created_at,expires_at,
          enc_pub_key,sig_pub_key,pubkeys_captured_at,request_id)
       VALUES (?,?,'pending',?,?,?,?,?,?,?,?)`,
    )
    .bind(
      deviceCode,
      userCode,
      deviceId,
      body.label ?? null,
      now,
      now + AUTH_TTL_MS,
      body.encPubKey ?? null,
      body.sigPubKey ?? null,
      body.encPubKey === undefined ? null : now,
      requestId,
    )
    .run();
  return json({ deviceCode, userCode, interval: POLL_INTERVAL_S, expiresIn: Math.floor(AUTH_TTL_MS / 1000) });
}

// POST /v1/auth/device/poll { deviceCode } -> { status, token? }
export async function pollDeviceAuth(
  req: Request,
  env: Env,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const parsed = await cappedJson(req, { maxBytes: DEVICE_POLL_MAX_BYTES }, validateDevicePollBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  // Reject malformed codes before limiter/D1 work. Valid-shaped polls hit both
  // the spray-floor IP bucket and the per-code fairness bucket.
  const ipLimited = await rateLimited(env.RL_DEVICE_POLL_IP, `dpi:${ipKey(req)}`);
  if (ipLimited) return ipLimited;
  const limited = await rateLimited(env.RL_DEVICE_POLL, `dp:${body.deviceCode}`);
  if (limited) return limited;
  const row = await dirDb(env)
    .prepare("SELECT user_code,status,device_id,label,expires_at,account_id,user_id,request_id FROM device_auth WHERE device_code = ?")
    .bind(body.deviceCode)
    .first<{ user_code: string; status: string; device_id: string; label: string | null; expires_at: number; account_id: string | null; user_id: string | null; request_id: string | null }>();
  if (!row) return json({ status: "not_found" }, 404);
  const requestId = row.request_id ?? await requestIdForDeviceCode(body.deviceCode);
  const keyDelivery = await pollKeyDelivery(env, requestId);
  if (Date.now() > row.expires_at && row.status !== "claimed") return json({ status: "expired", keyDelivery });
  if (row.status === "pending") return json({ status: "pending", interval: POLL_INTERVAL_S, keyDelivery });
  if (row.status === "claimed") {
    const escrow = await recoverEscrowedDeviceToken(env, requestId);
    return json({
      status: "claimed",
      ...(escrow
        ? { token: escrow.token, deviceId: escrow.deviceId, accountId: escrow.accountId }
        : {}),
      keyDelivery,
    });
  }
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
    let minted: Awaited<ReturnType<typeof claimDeviceAuthWithEscrow>>;
    try {
      minted = await claimDeviceAuthWithEscrow(env, {
        deviceCode: body.deviceCode,
        requestId,
        accountId: row.account_id ?? "default",
        userId: row.user_id ?? "",
        label: row.label,
        ip: clientIp(req),
        geo: clientGeo(req),
        proposedDeviceId: row.device_id,
        expiresAt: row.expires_at,
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
    if (!minted) return json({ status: "claimed", keyDelivery: await pollKeyDelivery(env, requestId) });
    if (ctx && keyDelivery) nudgeKeyDelivery(ctx, env, minted.accountId, requestId);
    return json({
      status: "approved",
      token: minted.token,
      deviceId: minted.deviceId,
      accountId: row.account_id,
      keyDelivery: await pollKeyDelivery(env, requestId),
    });
  }
  return json({ status: row.status, keyDelivery });
}

// POST /v1/auth/device/approve { userCode }  (authed) — the new device joins the approver's account.
export async function approveDeviceAuth(
  req: Request,
  env: Env,
  approver: Principal,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const limited = await rateLimited(env.RL_KEY_DELIVERY_APPROVE, `kda:${approver.userId ?? approver.deviceId}`);
  if (limited) return limited;
  const parsed = await cappedJson(req, { maxBytes: DEVICE_APPROVE_MAX_BYTES }, validateDeviceApproveBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const userCode = body.userCode.toUpperCase();
  if (body.keyConsent === true) {
    if (approver.kind !== "web") return json({ error: "fresh_step_up_required" }, 403);
    const now = Date.now();
    const stepUp = await verifyFreshClerkStepUp(env, body.clerkToken, now);
    if (!stepUp) return json({ error: "fresh_step_up_required" }, 403);
    const mapping = await dirDb(env)
      .prepare("SELECT account_id,user_id FROM clerk_users WHERE clerk_user_id=?")
      .bind(stepUp.sub)
      .first<{ account_id: string; user_id: string }>();
    if (
      !mapping
      || mapping.account_id !== approver.accountId
      || mapping.user_id !== approver.userId
    ) return json({ error: "step_up_principal_mismatch" }, 403);
    // Belt-and-suspenders freshness re-check at queue time; queueKeyDelivery's SQL
    // independently re-enforces the factor age, so the shared path needs no stepUp.
    const queueNow = Date.now();
    if (
      stepUp.factorVerifiedAt <= queueNow - CLERK_STEP_UP_MAX_AGE_MINUTES * 60_000
      || queueNow > stepUp.tokenValidUntil
    ) return json({ error: "fresh_step_up_required" }, 403);
    return queueApprovedKeyDelivery(env, approver, {
      userCode,
      pubkeyFingerprint: body.pubkeyFingerprint,
      approvalTokenHash: await sha256Hex(body.clerkToken),
      approvalFactorVerifiedAt: stepUp.factorVerifiedAt,
    }, ctx);
  }
  const res = await dirDb(env)
    .prepare("UPDATE device_auth SET status = 'approved', account_id = ?, user_id = ? WHERE user_code = ? AND status = 'pending' AND expires_at > ?")
    .bind(approver.accountId, approver.userId, userCode, Date.now())
    .run();
  if (res.meta.changes !== 1) return json({ error: "no_pending_auth" }, 404);
  return json({ ok: true });
}

export interface ApprovedKeyDeliveryInput {
  userCode: string;
  pubkeyFingerprint: string;
  approvalTokenHash: string;
  approvalFactorVerifiedAt: number;
}

/**
 * The shared approve→queue path (design 189 §3): resolve the pending device-code,
 * verify the fragment/fingerprint binding against the captured pubkeys, confirm the
 * account has an E2EE epoch, then run the atomic approve+queue D1 batch and nudge.
 * Both the real `device/approve` (after its Clerk step-up) and the dev-only
 * `device/approve-dev` (after its env+secret gate) call this — the 189 binding,
 * caps, revoke fence, and atomicity are identical across both; only the preceding
 * AUTHENTICATION differs. `approver` supplies the account/user the delivery binds to.
 */
export async function queueApprovedKeyDelivery(
  env: Env,
  approver: Principal,
  input: ApprovedKeyDeliveryInput,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const userCode = input.userCode.toUpperCase();
  const now = Date.now();
  const pending = await dirDb(env)
    .prepare(
      `SELECT request_id,enc_pub_key,sig_pub_key,expires_at
       FROM device_auth
       WHERE user_code=? AND status='pending' AND expires_at>?`,
    )
    .bind(userCode, now)
    .first<{ request_id: string | null; enc_pub_key: string | null; sig_pub_key: string | null; expires_at: number }>();
  if (!pending) return json({ error: "no_pending_auth" }, 404);
  if (!pending.request_id || !pending.enc_pub_key || !pending.sig_pub_key) {
    return json({ error: "key_delivery_unavailable" }, 409);
  }
  const expected = await publicKeyFingerprint({
    encPubKey: pending.enc_pub_key,
    sigPubKey: pending.sig_pub_key,
  });
  if (!ctEqual(expected, input.pubkeyFingerprint)) {
    return json({ error: "pubkey_binding_mismatch" }, 409);
  }
  const accountEpoch = await currentAccountEpoch(env, approver.accountId);
  if (accountEpoch === null) {
    // First device on an account whose encryption isn't set up yet (genesis
    // hasn't run): there are no keys to deliver, so a key-consent approve
    // gracefully DOWNGRADES to a plain device-auth sign-in instead of erroring
    // "encryption isn't set up for this account yet". The CLI then guides the
    // user to `rbox key genesis`. Mirrors the `disabled` branch below.
    // (Papercut 2026-07-23: the web /cli-login page offers "send keys" whenever
    // the URL carries a #fp, even for a first device on an unencrypted account.)
    const approved = await dirDb(env)
      .prepare(
        `UPDATE device_auth SET status='approved',account_id=?,user_id=?
         WHERE user_code=? AND status='pending' AND expires_at>?`,
      )
      .bind(approver.accountId, approver.userId, userCode, now)
      .run();
    if (approved.meta.changes !== 1) return json({ error: "no_pending_auth" }, 404);
    return json({ ok: true, keyDelivery: null, encryptionAbsent: true });
  }
  const queued = await queueKeyDelivery(env, {
    requestId: pending.request_id,
    userCode,
    accountId: approver.accountId,
    userId: approver.userId,
    encPubKey: pending.enc_pub_key,
    sigPubKey: pending.sig_pub_key,
    fingerprint: expected,
    approvalTokenHash: input.approvalTokenHash,
    approvalFactorVerifiedAt: input.approvalFactorVerifiedAt,
    accountEpoch,
    now,
    deviceCodeExpiresAt: pending.expires_at,
  });
  if (!queued.ok) {
    if (queued.reason === "disabled") {
      const approved = await dirDb(env)
        .prepare(
          `UPDATE device_auth SET status='approved',account_id=?,user_id=?
           WHERE user_code=? AND status='pending' AND expires_at>?`,
        )
        .bind(approver.accountId, approver.userId, userCode, now)
        .run();
      if (approved.meta.changes !== 1) return json({ error: "no_pending_auth" }, 404);
      return json({ ok: true, keyDelivery: null, keyDeliveryDisabled: true });
    }
    if (queued.reason === "no_pending_auth") return json({ error: "no_pending_auth" }, 404);
    if (queued.reason === "epoch_changed") return json({ error: "key_delivery_epoch_changed" }, 409);
    return json({ error: queued.reason === "cap" ? "key_delivery_cap" : "duplicate_key_delivery" }, 409);
  }
  if (ctx) nudgeKeyDelivery(ctx, env, approver.accountId, pending.request_id);
  return json({ ok: true, keyDelivery: { requestId: pending.request_id, status: "pending", expiresAt: queued.expiresAt } });
}

export function validateDeviceApproveDevBody(
  value: JsonValue,
): { userCode: string; pubkeyFingerprint: string; bootstrapSecret: string } | null {
  if (!exactObject(value, ["userCode", "pubkeyFingerprint", "bootstrapSecret"])) return null;
  if (typeof value.userCode !== "string" || !/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/i.test(value.userCode)) return null;
  if (typeof value.pubkeyFingerprint !== "string" || !validFingerprint(value.pubkeyFingerprint)) return null;
  if (typeof value.bootstrapSecret !== "string" || value.bootstrapSecret.length === 0 || utf8Bytes(value.bootstrapSecret) > 4096) return null;
  return { userCode: value.userCode, pubkeyFingerprint: value.pubkeyFingerprint, bootstrapSecret: value.bootstrapSecret };
}

// POST /v1/auth/device/approve-dev { userCode, pubkeyFingerprint, bootstrapSecret }
// DEV-ONLY scriptable twin of the web key-consent approve (design 192). It lets the
// headless two-machine rig drive the 189 key-delivery flow without a Clerk-authed
// browser. It swaps ONLY the authentication (Clerk step-up + web-kind session) for a
// dev-env + operator-secret gate; the fingerprint binding, epoch/caps/revoke fence,
// and atomic approve+queue are the IDENTICAL queueApprovedKeyDelivery path.
//
// PROD-IMPOSSIBLE — three independent gates:
//   1. env.RBOX_ENV !== "dev" → 404 (hardcoded "prod" in wrangler.jsonc production
//      vars; same gate as the dev bootstrap plan + device-cap bypass). In prod the
//      route is indistinguishable from one that does not exist.
//   2. Reachable only by a durable DEVICE bearer (approve-dev is on neither the web
//      nor api_key allowlist), so the caller is already an enrolled device.
//   3. RBOX_BOOTSTRAP_SECRET operator proof via constant-time ctEqual.
export async function approveDeviceAuthDev(
  req: Request,
  env: Env,
  approver: Principal,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  if (env.RBOX_ENV !== "dev") return json({ error: "not_found" }, 404);
  const limited = await rateLimited(env.RL_KEY_DELIVERY_APPROVE, `kda:${approver.userId ?? approver.deviceId}`);
  if (limited) return limited;
  const parsed = await cappedJson(req, { maxBytes: DEVICE_APPROVE_MAX_BYTES }, validateDeviceApproveDevBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const secret = env.RBOX_BOOTSTRAP_SECRET ?? "";
  if (!secret || !ctEqual(body.bootstrapSecret, secret)) return json({ error: "unauthorized" }, 401);
  const userCode = body.userCode.toUpperCase();
  return queueApprovedKeyDelivery(env, approver, {
    userCode,
    pubkeyFingerprint: body.pubkeyFingerprint,
    approvalTokenHash: await sha256Hex(`dev-approve:${userCode}:${body.pubkeyFingerprint}`),
    approvalFactorVerifiedAt: Date.now(),
  }, ctx);
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
    .prepare("SELECT label,status,expires_at,enc_pub_key,sig_pub_key FROM device_auth WHERE user_code = ?")
    .bind(userCode)
    .first<{ label: string | null; status: string; expires_at: number; enc_pub_key: string | null; sig_pub_key: string | null }>();
  if (!row || Date.now() > row.expires_at) return json({ error: "not_found" }, 404);
  return json({
    label: row.label,
    status: row.status,
    ...(row.enc_pub_key && row.sig_pub_key
      ? { encPubKeySpki: row.enc_pub_key, sigPubKey: row.sig_pub_key }
      : {}),
  });
}

// Dedicated public echo used by the fragment-bound approval page.
export async function lookupDevicePubkeys(req: Request, env: Env): Promise<Response> {
  const response = await lookupDeviceAuth(req, env);
  if (!response.ok) return response;
  const body = await response.json() as {
    encPubKeySpki?: string;
    sigPubKey?: string;
  };
  if (!body.encPubKeySpki || !body.sigPubKey) return json({ error: "not_found" }, 404);
  return json({ encPubKeySpki: body.encPubKeySpki, sigPubKey: body.sigPubKey });
}
