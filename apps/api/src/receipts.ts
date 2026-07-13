// §23.1 — upload-receipt primitive (docs/design/23-upload-receipts/1-receipt-primitive.md).
// A stateless, unforgeable proof that "account A uploaded `size` bytes for content
// address `encSha`, recently." Stateless = no D1 row — that is the whole point of
// keeping D1 off the PUT hot path. HMAC-SHA256, domain-tagged, key-fingerprint kid
// (rotation-safe), fail-closed.

import type { Env } from "./env.js";
import { ctEqual } from "./util.js";

export const RECEIPT_TTL_MS = 12 * 3600_000; // 12h — a receipt proves a recent direct-write upload
export const CLOCK_SKEW_MS = 60_000; // tolerate ≤60s of client/server clock skew on `t`
const MIN_KEY_BYTES = 32;
const DOMAIN = "rbox.receipt.v1|"; // domain-separates this MAC from every other key use

export interface MintClaim {
  accountId: string;
  encSha: string;
  size: number;
  nowMs: number;
  packId?: string;
}
export interface ReceiptClaim {
  accountId: string;
  encSha: string;
  /** Optional: when given it must match the receipt's signed size. The commit path
   *  omits it and uses the returned (authenticated) size to charge. */
  size?: number;
  nowMs: number;
}
export type VerifyResult =
  | { ok: true; size: number; packId?: string }
  | {
      ok: false;
      reason: "malformed" | "bad_version" | "bad_kid" | "bad_mac" | "expired" | "future" | "bad_ttl" | "mismatch";
    };

interface PayloadV1 {
  v: 1;
  a: string;
  s: string;
  n: number;
  t: number;
  e: number;
}
interface PayloadV2 {
  v: 2;
  a: string;
  s: string;
  n: number;
  t: number;
  e: number;
  p: string;
}
type Payload = PayloadV1 | PayloadV2;

const PACK_ID_RE = /^[0-9a-f]{32}$/;

const enc = new TextEncoder();
const b64url = (b: ArrayBuffer | Uint8Array): string => {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let s = "";
  for (const x of bytes) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const b64urlToStr = (s: string): string => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return b;
};
const toHex = (buf: ArrayBuffer): string =>
  [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, "0")).join("");

// kid = first 8 hex of sha256(key) — STABLE per key, so receipts survive rotation
// (a positional "current/prev" id would re-point after a rotate and break in-flight
// receipts). Cached per key string.
const kidCache = new Map<string, string>();
async function kidOf(key: string): Promise<string> {
  let k = kidCache.get(key);
  if (k) return k;
  k = toHex(await crypto.subtle.digest("SHA-256", enc.encode(key))).slice(0, 8);
  kidCache.set(key, k);
  return k;
}

// Cache the imported HMAC CryptoKey per key string (§30 codex MAJOR4): verifying a large
// commit's receipts (12k+) must not re-`importKey` once per receipt. The key set is tiny
// (current + prev); caching the Promise also de-dupes concurrent first imports.
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

/** Current + (optional) previous receipt keys. FAIL CLOSED: a missing/short key
 *  throws, so a misconfigured deploy can never mint or accept forgeable receipts. */
function keys(env: Env): { current: string; all: string[] } {
  const cur = env.RBOX_RECEIPT_KEY;
  if (!cur || enc.encode(cur).length < MIN_KEY_BYTES) {
    throw new Error("RBOX_RECEIPT_KEY missing or shorter than 32 bytes");
  }
  const prev = env.RBOX_RECEIPT_KEY_PREV;
  const all = prev && enc.encode(prev).length >= MIN_KEY_BYTES ? [cur, prev] : [cur];
  return { current: cur, all };
}

export async function mintReceipt(env: Env, claim: MintClaim): Promise<string> {
  const { current } = keys(env);
  const common = {
    a: claim.accountId,
    s: claim.encSha,
    n: claim.size,
    t: claim.nowMs,
    e: claim.nowMs + RECEIPT_TTL_MS,
  };
  const payload: Payload = claim.packId === undefined ? { v: 1, ...common } : { v: 2, ...common, p: claim.packId };
  const kid = await kidOf(current);
  const body = `${kid}.${b64url(enc.encode(JSON.stringify(payload)))}`;
  const mac = await hmac(current, DOMAIN + body);
  return `${body}.${b64url(enc.encode(mac))}`;
}

export async function verifyReceipt(env: Env, receipt: string, claim: ReceiptClaim): Promise<VerifyResult> {
  const parts = receipt.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [kid, payloadB64, macB64] = parts as [string, string, string];

  let payload: Payload;
  try {
    payload = JSON.parse(b64urlToStr(payloadB64));
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (payload === null || typeof payload !== "object") return { ok: false, reason: "malformed" };
  if (payload.v !== 1 && payload.v !== 2) return { ok: false, reason: "bad_version" };
  if (payload.v === 2 && (typeof payload.p !== "string" || !PACK_ID_RE.test(payload.p))) return { ok: false, reason: "malformed" };

  // Find the key whose kid matches (current or prev), then constant-time MAC compare
  // over the domain-tagged body. No key matches the kid → bad_kid (don't leak which).
  const { all } = keys(env);
  let matchedKey: string | undefined;
  for (const k of all) if ((await kidOf(k)) === kid) matchedKey = k;
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
  if (!(payload.e - payload.t > 0 && payload.e - payload.t <= RECEIPT_TTL_MS)) return { ok: false, reason: "bad_ttl" };
  if (payload.t > claim.nowMs + CLOCK_SKEW_MS) return { ok: false, reason: "future" };
  if (payload.e <= claim.nowMs) return { ok: false, reason: "expired" };

  // Claim binding: account + content must match; size only when the caller asserts one.
  if (payload.a !== claim.accountId || payload.s !== claim.encSha) return { ok: false, reason: "mismatch" };
  if (claim.size !== undefined && payload.n !== claim.size) return { ok: false, reason: "mismatch" };
  return payload.v === 2 ? { ok: true, size: payload.n, packId: payload.p } : { ok: true, size: payload.n };
}
