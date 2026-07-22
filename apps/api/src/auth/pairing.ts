import type { Env } from "../env.js";
import { cappedJson, isWellFormed, json, logErr, objectWithKeys, sha256Hex, truncateCodePoints, truncateUtf8, utf8Bytes } from "../util.js";
import type { Principal } from "../authz.js";
import { clientGeo, clientIp } from "../notify.js";
import { dbFor, dirDb } from "../db.js";
import { randomHex, TOKEN_BYTES } from "./shared.js";
import { AccountGoneError, checkDeviceCap, DeviceLimitError, mintDeviceWithNotification } from "./mint.js";
import { ipKey, rateLimited } from "../ratelimit.js";
import { GENESIS_TOMBSTONE_SENTINEL, assertGenesisSingleDatabase, deletionLedgerBlocks, tombstoneFenceResponse } from "../genesis-repair.js";

// A client-supplied opaque pairing tokenId (design 12, C6): url-safe, 16–64 chars.
// A legacy server-generated 64-hex token also matches, so redeem accepts both.
const PAIR_TOKEN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;

// ---- pairing tokens (M10): low-friction "connect a new machine" ----

const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_ACTIVE_CAP = 5; // max outstanding (unconsumed, unexpired) per account
const PAIR_PREFIX = "rbox-pair_"; // human-recognizable; stripped before hashing
export const PAIR_CREATE_MAX_BYTES = 1024 * 1024;
export const PAIR_REDEEM_MAX_BYTES = 8 * 1024;

export function validatePairCreateBody(value: unknown): { mkWrap?: string; admissionGrant?: string; tokenId?: string } | null {
  if (!objectWithKeys(value, ["mkWrap", "admissionGrant", "tokenId"])) return null;
  if (value.mkWrap !== undefined && (typeof value.mkWrap !== "string" || utf8Bytes(value.mkWrap) > 65_536)) return null;
  if (value.admissionGrant !== undefined && (typeof value.admissionGrant !== "string" || utf8Bytes(value.admissionGrant) > 65_536)) return null;
  if (value.tokenId !== undefined && (typeof value.tokenId !== "string" || !PAIR_TOKEN_ID_RE.test(value.tokenId))) return null;
  return value as { mkWrap?: string; admissionGrant?: string; tokenId?: string };
}

export function validatePairRedeemBody(value: unknown): { token: string; label?: string } | null {
  if (!objectWithKeys(value, ["token", "label"], ["token"]) || typeof value.token !== "string") return null;
  const tokenId = value.token.startsWith(PAIR_PREFIX) ? value.token.slice(PAIR_PREFIX.length) : value.token;
  if (!PAIR_TOKEN_ID_RE.test(tokenId)) return null;
  if (value.label !== undefined && (typeof value.label !== "string" || !isWellFormed(value.label))) return null;
  return { token: value.token, ...(value.label === undefined ? {} : { label: truncateUtf8(value.label, 600) }) };
}

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
  const parsed = await cappedJson(req, { maxBytes: PAIR_CREATE_MAX_BYTES }, validatePairCreateBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const mkWrap = body.mkWrap ?? null;
  const admissionGrant = body.admissionGrant ?? null;

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
  const e2eeBearing = mkWrap !== null || admissionGrant !== null;
  assertGenesisSingleDatabase(env, p.accountId);
  const res = await dirDb(env).prepare(
    `INSERT INTO pairing_tokens (token_hash,account_id,user_id,created_by,label,created_at,expires_at,mk_wrap,admission_grant)
     SELECT ?,?,?,?,'pair',?,?,?,? WHERE
       (SELECT COUNT(*) FROM pairing_tokens WHERE account_id=? AND consumed_at IS NULL AND expires_at>?)<?
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=? AND status IN ('purging','done'))
       AND (?=0 OR EXISTS (SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL))`
  ).bind(hash,p.accountId,p.userId,p.deviceId,now,expiresAt,mkWrap,admissionGrant,p.accountId,now,PAIR_ACTIVE_CAP,p.accountId,e2eeBearing?1:0,p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL).run();
  if ((res.meta.changes ?? 0) === 0) {
    const erased = await deletionLedgerBlocks(env,p.accountId);
    if (erased) return json({ error: "account_erased" }, 410);
    if (e2eeBearing) {
      const fence = await tombstoneFenceResponse(env,p.accountId);
      if (fence) return fence;
      const real=await dbFor(env,p.accountId).prepare(`SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL`).bind(p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL).first();
      if(!real)return json({error:"account_keys_missing"},409);
    }
    return json({ error: "too_many_pairing_tokens", cap: PAIR_ACTIVE_CAP }, 429);
  }
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
  // Shared per-IP burst cap on the credential-minting edge before D1 work.
  const limited = await rateLimited(env.RL_LINK_PAIR, `lp:${ipKey(req)}`);
  if (limited) return limited;
  const parsed = await cappedJson(req, { maxBytes: PAIR_REDEEM_MAX_BYTES }, validatePairRedeemBody);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value;
  const raw = body.token;
  const token = raw.startsWith(PAIR_PREFIX) ? raw.slice(PAIR_PREFIX.length) : raw;
  // Accept both a client tokenId (C6) and a legacy 64-hex token — both stored as
  // sha256(<id>), so one lookup covers both. Bound the format before hashing.
  const label = truncateCodePoints(body.label ?? "paired", 200);
  const hash = await sha256Hex(token);
  const now = Date.now();

  // Cap preflight resolves the token's account without burning it, so a full live
  // account 409s while the token remains redeemable after a device is revoked. A
  // miss falls through to the single-use consume and uniform 401 path.
  const peek = await dirDb(env)
    .prepare("SELECT account_id FROM pairing_tokens WHERE token_hash = ? AND consumed_at IS NULL AND expires_at > ?")
    .bind(hash, now)
    .first<{ account_id: string }>();
  if (peek) {
    // design 37 ordering: account tombstone semantics outrank the cap. If the account is
    // already gone, skip the cap preflight and let the normal consume+liveness path below burn
    // the token and return the exact design-37 401 response.
    const acctLive = await dbFor(env, peek.account_id).prepare("SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL").bind(peek.account_id).first();
    if (acctLive) {
      const cap = await checkDeviceCap(env, peek.account_id);
      if (!cap.ok) return json({ error: "device_limit_reached", cap: cap.cap, plan: cap.plan }, 409);
    }
  }

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

  // Fail-closed live authority check: creator device non-revoked AND user a member (directory
  // plane). The account-liveness gate is a SEPARATE account-data-plane read below — never a
  // cross-plane JOIN.
  const live = await dirDb(env)
    .prepare(
      `SELECT 1 FROM memberships m
       JOIN devices d ON d.account_id = m.account_id AND d.user_id = m.user_id
       WHERE m.account_id = ? AND m.user_id = ? AND d.device_id = ? AND d.revoked = 0`
    )
    .bind(consumed.account_id, consumed.user_id, consumed.created_by)
    .first();
  if (!live) return json({ error: "unauthorized" }, 401); // source revoked / membership gone (token already burned)
  // design 37: a pairing token must not mint a usable device into a TOMBSTONED account during
  // its grace window. accounts is account-data plane → a point read on the resolved account.
  const acctLive = await dbFor(env, consumed.account_id).prepare("SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL").bind(consumed.account_id).first();
  if (!acctLive) return json({ error: "unauthorized" }, 401); // account tombstoned (token already burned)

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
    // design 37: account tombstoned between the live-authority read and the device insert →
    // the guarded mint wrote NO rows. Uniform unauthorized (token already burned).
    if (e instanceof AccountGoneError) return json({ error: "unauthorized" }, 401);
    // Mint backstop can still catch concurrent overshoot after the consume; report
    // the cap as a 409 instead of surfacing a 500.
    if (e instanceof DeviceLimitError) return json({ error: "device_limit_reached", cap: e.cap, plan: e.plan }, 409);
    logErr("pair_redeem_mint_failed", e); // token burned; no raw message (touches account/device material)
    return json({ error: "internal" }, 500);
  }
}
