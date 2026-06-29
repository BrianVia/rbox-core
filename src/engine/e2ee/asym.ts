/**
 * Asymmetric crypto for E2EE (design 12, V4-8): Ed25519 for signing (commits,
 * rosters, grants) and RSA-OAEP-3072-SHA256 for wrapping MK to a device.
 *
 * On node:crypto (fully supported by Bun, the client runtime) rather than
 * WebCrypto, because we need DETERMINISTIC Ed25519-from-seed — deriving the
 * recovery signing key (RSK) from RK and the admission key from tokenSecret —
 * which WebCrypto cannot do (it can't compute a public key from a raw seed). All
 * E2EE asymmetric ops are client-side; the server only stores opaque blobs.
 *
 * Wire encodings (V4-8): Ed25519 public key = raw 32 bytes; Ed25519 signature =
 * raw 64 bytes; RSA public key = SPKI DER. All carried as base64url by callers.
 */
import { constants, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt, publicEncrypt, sign as nodeSign, verify as nodeVerify, type KeyObject } from "node:crypto";

// Fixed DER framings that wrap a bare 32-byte Ed25519 key (RFC 8410). Prepending
// these lets us move between raw 32-byte keys (our wire format) and node KeyObjects.
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export interface SignKeyPair {
  /** raw 32-byte Ed25519 public key */
  publicKey: Uint8Array;
  /** node KeyObject (private); never serialized to the wire in raw form */
  privateKey: KeyObject;
}

// ---- Ed25519 signing ------------------------------------------------------

export function generateSignKeyPair(): SignKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { publicKey: rawEdPublic(publicKey), privateKey };
}

/** Deterministically derive an Ed25519 keypair from a 32-byte seed (V4-1, V4-9). */
export function signKeyPairFromSeed(seed: Uint8Array): SignKeyPair {
  if (seed.length !== 32) throw new Error("ed25519 seed must be 32 bytes");
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: "der", type: "pkcs8" });
  return { publicKey: rawEdPublic(createPublicKey(privateKey)), privateKey };
}

export function sign(privateKey: KeyObject, message: Uint8Array): Uint8Array {
  return new Uint8Array(nodeSign(null, Buffer.from(message), privateKey));
}

/** Verify a raw 64-byte Ed25519 signature against a raw 32-byte public key. */
export function verify(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKeyRaw.length !== 32 || signature.length !== 64) return false;
  try {
    const pub = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, Buffer.from(publicKeyRaw)]), format: "der", type: "spki" });
    return nodeVerify(null, Buffer.from(message), pub, Buffer.from(signature));
  } catch {
    return false;
  }
}

/** Re-import a private Ed25519 key persisted as PKCS8 DER (keystore round-trip). */
export function signPrivateFromPkcs8(pkcs8: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
}
export function signPrivateToPkcs8(privateKey: KeyObject): Uint8Array {
  return new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer);
}

function rawEdPublic(pub: KeyObject): Uint8Array {
  return new Uint8Array(Buffer.from((pub.export({ format: "jwk" }) as { x: string }).x, "base64url"));
}

// ---- RSA-OAEP-3072 device wrap -------------------------------------------

export interface WrapKeyPair {
  /** SPKI DER public key */
  publicKeySpki: Uint8Array;
  privateKey: KeyObject;
}

export function generateWrapKeyPair(): WrapKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
  return { publicKeySpki: new Uint8Array(publicKey.export({ format: "der", type: "spki" }) as Buffer), privateKey };
}

/** RSA-OAEP-SHA256 encrypt with an OAEP `label` that binds context (V4-6: there
 *  is no GCM nonce/AAD for RSA, so the label carries account/epoch/recipient). */
export function rsaWrap(publicKeySpki: Uint8Array, label: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const key = createPublicKey({ key: Buffer.from(publicKeySpki), format: "der", type: "spki" });
  return new Uint8Array(
    publicEncrypt({ key, oaepHash: "sha256", oaepLabel: Buffer.from(label), padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(plaintext))
  );
}

export function rsaUnwrap(privateKey: KeyObject, label: Uint8Array, ciphertext: Uint8Array): Uint8Array {
  return new Uint8Array(
    privateDecrypt({ key: privateKey, oaepHash: "sha256", oaepLabel: Buffer.from(label), padding: constants.RSA_PKCS1_OAEP_PADDING }, Buffer.from(ciphertext))
  );
}

export function wrapPrivateFromPkcs8(pkcs8: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.from(pkcs8), format: "der", type: "pkcs8" });
}
export function wrapPrivateToPkcs8(privateKey: KeyObject): Uint8Array {
  return new Uint8Array(privateKey.export({ format: "der", type: "pkcs8" }) as Buffer);
}
