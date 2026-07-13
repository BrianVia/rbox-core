/**
 * Recovery material (design 12, V4-9). The recovery phrase is a 24-word BIP39
 * mnemonic encoding 256 bits of entropy. That entropy IS the recovery key RK —
 * NOT the BIP39 PBKDF2 seed, NOT the UTF-8 of the words. From RK we derive:
 *   - rkWrapKey  = HKDF(RK, "rbox/recovery/v1", "mk-wrap")     → wraps MK (AES-GCM)
 *   - RSK seed   = HKDF(RK, "rbox/recovery/v1", "recovery-sign") → Ed25519 recovery
 *                  signing key (a roster admin principal, so a recovery-only device
 *                  can admit itself after total device loss — V4-1).
 *
 * BIP39 gives a checksum (catches typos) and a familiar word format. We implement
 * just entropy↔mnemonic; we never use the BIP39 seed function.
 */
import { signKeyPairFromSeed, type SignKeyPair } from "./asym.js";
import { BIP39_WORDS } from "./bip39-wordlist.js";
import { hkdf, randomBytes, sha256, utf8 } from "./primitives.js";

const ENTROPY_BYTES = 32; // 256-bit → 24 words
const RECOVERY_SALT = utf8("rbox/recovery/v1");

/** A fresh 256-bit recovery key (the bytes the mnemonic encodes). */
export function generateRecoveryKey(): Uint8Array {
  return randomBytes(ENTROPY_BYTES);
}

/** Encode 32 bytes of entropy as a 24-word BIP39 mnemonic (with checksum). */
export async function rkToPhrase(rk: Uint8Array): Promise<string> {
  if (rk.length !== ENTROPY_BYTES) throw new Error("recovery key must be 32 bytes");
  const checksum = (await sha256(rk))[0]!; // first 8 bits (CS = ENT/32 = 8)
  const bits: number[] = [];
  for (const b of rk) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  for (let i = 7; i >= 0; i--) bits.push((checksum >> i) & 1); // append 8 checksum bits → 264 = 24×11
  const words: string[] = [];
  for (let i = 0; i < bits.length; i += 11) {
    let idx = 0;
    for (let j = 0; j < 11; j++) idx = (idx << 1) | bits[i + j]!;
    words.push(BIP39_WORDS[idx]!);
  }
  return words.join(" ");
}

/** Decode + checksum-validate a 24-word mnemonic back to the 32-byte RK. Throws
 *  on unknown words, wrong length, or checksum mismatch (a typo). */
export async function phraseToRk(phrase: string): Promise<Uint8Array> {
  const words = phrase.normalize("NFKD").trim().toLowerCase().split(/\s+/);
  if (words.length !== 24) throw new Error(`recovery phrase must be 24 words (got ${words.length})`);
  const bits: number[] = [];
  for (const w of words) {
    const idx = BIP39_WORDS.indexOf(w);
    if (idx < 0) throw new Error(`not a valid recovery word: "${w}"`);
    for (let j = 10; j >= 0; j--) bits.push((idx >> j) & 1);
  }
  const rk = new Uint8Array(ENTROPY_BYTES);
  for (let i = 0; i < ENTROPY_BYTES; i++) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i * 8 + j]!;
    rk[i] = b;
  }
  let cs = 0;
  for (let j = 0; j < 8; j++) cs = (cs << 1) | bits[ENTROPY_BYTES * 8 + j]!;
  if (cs !== (await sha256(rk))[0]!) throw new Error("recovery phrase checksum failed — check for a typo");
  return rk;
}

/** AES-256 key that wraps MK under the recovery key. */
export function rkWrapKey(rk: Uint8Array): Promise<Uint8Array> {
  return hkdf(rk, RECOVERY_SALT, utf8("mk-wrap"), 32);
}

/** The recovery signing keypair (Ed25519) — a roster admin principal (V4-1). */
export async function recoverySignKeyPair(rk: Uint8Array): Promise<SignKeyPair> {
  return signKeyPairFromSeed(await hkdf(rk, RECOVERY_SALT, utf8("recovery-sign"), 32));
}
