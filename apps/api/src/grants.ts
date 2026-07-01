// §27 — download-grant primitive (docs/design/27-download-capabilities.md). The
// read-side analogue of §23's upload receipt (receipts.ts): a stateless, unforgeable
// proof that "account A was authorized to pull a workspace recently", minted at
// `latest()` (where the caller is already authorized) and presented on each blob GET so
// the server can SKIP the per-blob D1 `isEntitled` read (the 81%-of-p50 hot-path cost).
//
// Same crypto as the §23 receipt — HMAC-SHA256, domain-tagged, key-fingerprint `kid`
// (rotation-safe), cached CryptoKey — but with two deliberate differences:
//   1. A DISTINCT domain tag (`rbox.grant.v1|`), so a receipt can NEVER verify as a
//      grant (or vice-versa) even if the two ever shared a key.
//   2. BEST-EFFORT, not fail-closed: a missing/short key makes mint return `undefined`
//      (latest() just omits the grant) and verify return `{ok:false}` (blobGet falls
//      back to the D1 entitlement path). A misconfigured key must degrade to "no
//      speedup", never "broken pull" — the D1 path is the secure baseline. Forgery is
//      still impossible: verification requires the key, and an invalid grant is treated
//      exactly like no grant.

import type { Env } from "./env.js";
import { ctEqual } from "./util.js";

// 5 min — long enough to cover a typical clone without a mid-pull refresh; short enough
// that a STOLEN grant (which also needs the account's device token to pass the account
// bind) is useful only briefly. An EXPIRED grant is not a failure: blobGet falls back to
// the D1 entitlement path, so an entitled account is still served.
export const GRANT_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000; // tolerate ≤60s of client/server clock skew on `t` (matches receipts)
const MIN_KEY_BYTES = 32;
const DOMAIN = "rbox.grant.v1|"; // domain-separates this MAC from the §23 receipt MAC and every other key use

export interface GrantMintClaim {
  accountId: string;
  workspaceId: string;
  nowMs: number;
}
export interface GrantVerifyClaim {
  /** The AUTHENTICATED principal's account — the grant's `a` must equal this. */
  accountId: string;
  nowMs: number;
}
export type GrantVerify =
  | { ok: true }
  | {
      ok: false;
      reason: "no_key" | "malformed" | "bad_version" | "bad_kid" | "bad_mac" | "expired" | "future" | "bad_ttl" | "mismatch";
    };

interface Payload {
  v: 1;
  a: string; // accountId — ENFORCED at GET (must equal the authenticated principal)
  w: string; // workspaceId — issuance provenance / audit; NOT enforced at GET (blobGet has no ws context)
  t: number; // mint time (ms epoch)
  e: number; // expiry = t + GRANT_TTL_MS
}

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlToStr = (s: string): string => atob(s.replace(/-/g, "+").replace(/_/g, "/"));
const toHex = (buf: ArrayBuffer): string => [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

// kid = first 8 hex of sha256(key) — STABLE per key, so grants survive rotation. Cached.
const kidCache = new Map<string, string>();
async function kidOf(key: string): Promise<string> {
  let k = kidCache.get(key);
  if (k) return k;
  k = toHex(await crypto.subtle.digest("SHA-256", enc.encode(key))).slice(0, 8);
  kidCache.set(key, k);
  return k;
}

// Cache the imported HMAC CryptoKey per key string: a 64-wide concurrent pull must not
// re-`importKey` once per GET. The key set is tiny (current + prev); caching the Promise
// also de-dupes concurrent first imports.
const ckCache = new Map<string, Promise<CryptoKey>>();
function importHmacKey(key: string): Promise<CryptoKey> {
  let ck = ckCache.get(key);
  if (!ck) {
    ck = crypto.subtle.importKey("raw", enc.encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    ckCache.set(key, ck);
  }
  return ck;
}

async function hmac(key: string, msg: string): Promise<string> {
  const ck = await importHmacKey(key);
  return toHex(await crypto.subtle.sign("HMAC", ck, enc.encode(msg)));
}

/** Current + (optional) previous grant keys, or `undefined` when unconfigured/too short.
 *  BEST-EFFORT (unlike receipts' fail-closed throw): an absent key disables grants and
 *  everyone falls back to the D1 entitlement path — never a broken pull. */
function keys(env: Env): { current: string; all: string[] } | undefined {
  const cur = env.RBOX_GRANT_KEY;
  if (!cur || enc.encode(cur).length < MIN_KEY_BYTES) return undefined;
  const prev = env.RBOX_GRANT_KEY_PREV;
  const all = prev && enc.encode(prev).length >= MIN_KEY_BYTES ? [cur, prev] : [cur];
  return { current: cur, all };
}

/** Mint a download grant, or `undefined` when no grant key is configured (best-effort). */
export async function mintGrant(env: Env, claim: GrantMintClaim): Promise<string | undefined> {
  const k = keys(env);
  if (!k) return undefined;
  const payload: Payload = { v: 1, a: claim.accountId, w: claim.workspaceId, t: claim.nowMs, e: claim.nowMs + GRANT_TTL_MS };
  const kid = await kidOf(k.current);
  const body = `${kid}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const mac = await hmac(k.current, DOMAIN + body);
  return `${body}.${b64url(enc.encode(mac))}`;
}

/** Verify a presented grant. Any failure (incl. an unconfigured key) → `{ok:false}`, and
 *  the caller (blobGet) falls back to the D1 entitlement path — an invalid grant is
 *  indistinguishable from no grant. Binds `a` to the AUTHENTICATED account; `w` is not
 *  enforced (blobGet has no workspace context — see the design doc's Scope section). */
export async function verifyGrant(env: Env, grant: string, claim: GrantVerifyClaim): Promise<GrantVerify> {
  const k = keys(env);
  if (!k) return { ok: false, reason: "no_key" };

  const parts = grant.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [kid, payloadB64, macB64] = parts as [string, string, string];

  let payload: Payload;
  try {
    payload = JSON.parse(b64urlToStr(payloadB64));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload.v !== 1) return { ok: false, reason: "bad_version" };

  // Find the key whose kid matches (current or prev), then constant-time MAC compare over
  // the domain-tagged body. No key matches → bad_kid (don't leak which).
  let matchedKey: string | undefined;
  for (const kk of k.all) if ((await kidOf(kk)) === kid) matchedKey = kk;
  if (!matchedKey) return { ok: false, reason: "bad_kid" };

  let presentedMac: string;
  try {
    presentedMac = b64urlToStr(macB64);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = await hmac(matchedKey, `${DOMAIN}${kid}.${payloadB64}`);
  if (!ctEqual(expected, presentedMac)) return { ok: false, reason: "bad_mac" };

  // Timestamp bounds: TTL not over-long, `t` not future (skew-tolerant), not expired.
  if (!(payload.e - payload.t > 0 && payload.e - payload.t <= GRANT_TTL_MS)) return { ok: false, reason: "bad_ttl" };
  if (payload.t > claim.nowMs + CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (payload.e <= claim.nowMs) return { ok: false, reason: "expired" };

  // Account binding: the grant is only honored for the account it was minted for.
  if (payload.a !== claim.accountId) return { ok: false, reason: "mismatch" };
  return { ok: true };
}
