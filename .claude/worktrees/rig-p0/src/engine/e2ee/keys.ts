/**
 * Key hierarchy + wrap wire formats (design 12, V4-6).
 *
 *   recovery key RK ──(rkWrapKey)──┐
 *   device RSA keypair ────────────┤ wrap →  Account Master Key (MK, 256-bit)
 *                                  │                  │ wrap →
 *                                  │           Workspace KEK (256-bit, per workspace+keyEpoch)
 *                                  │                  │ HKDF(plaintextSha) →
 *                                  └─                 per-blob key+nonce (convergent)
 *
 * Two wrap formats, each binds its context so a wrap can't be lifted to another
 * account/epoch/recipient/purpose:
 *   - AES-GCM wrap  (MK-under-RK, KEK-under-MK): context travels as the GCM AAD.
 *   - RSA-OAEP wrap (MK-to-device):              context travels as the OAEP label.
 *
 * Every value here is opaque to the server; only a device holding the right key
 * can unwrap. Wrap blobs serialize to JSON for storage.
 */
import type { KeyObject } from "node:crypto";
import { rsaUnwrap, rsaWrap } from "./asym.js";
import { canonicalString } from "./jcs.js";
import { aesGcmDecrypt, aesGcmEncrypt, fromB64url, randomBytes, sha256, sha256Hex, toB64url, utf8 } from "./primitives.js";

export type WrappedKeyKind = "MK" | "KEK";

/** Context bound into a wrap. Omitted fields (keyEpoch on an MK wrap) are absent
 *  from the canonical form, not null — both sides must agree on what's present. */
export interface WrapContext {
  accountId: string;
  accountEpoch: number;
  wrappedKeyKind: WrappedKeyKind;
  purpose: string;
  keyEpoch?: number; // present for KEK wraps
  workspaceId?: string; // present for KEK wraps — binds the wrap to ITS workspace (key separation)
  recipientKeyHash?: string; // present for device (RSA) wraps — hash of the device enc pubkey
}

export interface AesGcmWrap {
  v: 1;
  kind: "aesgcm-wrap";
  alg: "A256GCM";
  nonce: string; // b64url, 12 bytes
  ct: string; // b64url
  ctx: WrapContext; // the bound context (also fed as AAD)
}

export interface RsaWrap {
  v: 1;
  kind: "rsa-oaep-wrap";
  alg: "RSA-OAEP-3072-SHA256";
  recipientKeyHash: string; // hex sha256 of the recipient device's SPKI enc pubkey
  ct: string; // b64url
  ctx: WrapContext;
}

export type Wrap = AesGcmWrap | RsaWrap;

export function generateMasterKey(): Uint8Array {
  return randomBytes(32);
}
export function generateWorkspaceKek(): Uint8Array {
  return randomBytes(32);
}

/** SHA-256 (hex) of a recipient device's SPKI public key — the stable id used in
 *  wrap context and the roster (V4-8). */
export function recipientKeyHash(spkiPublicKey: Uint8Array): Promise<string> {
  return sha256Hex(spkiPublicKey);
}

// ---- AES-GCM wrap (symmetric wrapping key) --------------------------------

/** Wrap `keyMaterial` under a 32-byte symmetric `wrappingKey`, binding `ctx`. */
export async function aesGcmWrap(wrappingKey: Uint8Array, keyMaterial: Uint8Array, ctx: WrapContext): Promise<AesGcmWrap> {
  const nonce = randomBytes(12);
  const aad = utf8(canonicalString(ctx));
  const ct = await aesGcmEncrypt(wrappingKey, nonce, keyMaterial, aad);
  return { v: 1, kind: "aesgcm-wrap", alg: "A256GCM", nonce: toB64url(nonce), ct: toB64url(ct), ctx };
}

/** Unwrap an AES-GCM wrap, REQUIRING the bound context to equal `expected`
 *  (a wrap from another account/epoch/purpose is rejected before decryption). */
export async function aesGcmUnwrap(wrappingKey: Uint8Array, wrap: AesGcmWrap, expected: WrapContext): Promise<Uint8Array> {
  assertContext(wrap.ctx, expected);
  const aad = utf8(canonicalString(wrap.ctx));
  return aesGcmDecrypt(wrappingKey, fromB64url(wrap.nonce), fromB64url(wrap.ct), aad);
}

// ---- RSA-OAEP device wrap -------------------------------------------------

/** Wrap MK to a device's RSA public key. Context is bound via the OAEP label
 *  (RSA has no GCM AAD — V4-6). */
export async function rsaDeviceWrap(devicePublicSpki: Uint8Array, mk: Uint8Array, ctx: WrapContext): Promise<RsaWrap> {
  const rkh = ctx.recipientKeyHash ?? (await recipientKeyHash(devicePublicSpki));
  const fullCtx: WrapContext = { ...ctx, recipientKeyHash: rkh };
  const label = await sha256(utf8(canonicalString(fullCtx)));
  const ct = rsaWrap(devicePublicSpki, label, mk);
  return { v: 1, kind: "rsa-oaep-wrap", alg: "RSA-OAEP-3072-SHA256", recipientKeyHash: rkh, ct: toB64url(ct), ctx: fullCtx };
}

export async function rsaDeviceUnwrap(devicePrivateKey: KeyObject, wrap: RsaWrap, expected: WrapContext): Promise<Uint8Array> {
  assertContext(wrap.ctx, { ...expected, recipientKeyHash: wrap.ctx.recipientKeyHash });
  const label = await sha256(utf8(canonicalString(wrap.ctx)));
  return rsaUnwrap(devicePrivateKey, label, fromB64url(wrap.ct));
}

/** SHA-256 (hex) of a wrap's canonical bytes — what the roster/accountKeyState
 *  signs (deviceWrapHash / mkWrapHashes, V4-1/V4-2) so a wrap can't be swapped. */
export function wrapHash(wrap: Wrap): Promise<string> {
  return sha256Hex(utf8(canonicalString(wrap)));
}

function assertContext(got: WrapContext, expected: WrapContext): void {
  if (canonicalString(got) !== canonicalString(expected)) {
    throw new Error("wrap context mismatch — refusing to unwrap a wrap bound to a different account/epoch/purpose");
  }
}
