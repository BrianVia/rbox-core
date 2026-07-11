/**
 * §24.1 — canonical blobRef-set ("sidecar") codec. LOCKED binary encoding so the
 * same ref set always produces the same bytes → the same `sidecarSha` (a normal
 * dedupable content blob), and so a parser cannot accept malleable bytes.
 *
 *   magic    "rbox-refset-v1"   (14 ASCII bytes, fixed)
 *   count    u32be
 *   refs     count × ( 32 raw sha256 bytes ‖ size u64be )      // 40 bytes/ref
 *
 * Strict rules the parser MUST enforce (reject otherwise): refs sorted ascending by
 * the 32 raw sha bytes, no duplicate shas, no trailing bytes (length == 18 + 40·count),
 * each size a non-negative safe integer. After parse the caller asserts count/Σsize
 * equal the signed body descriptor (§24.2/§24.3).
 *
 * DEPENDENCY-FREE (pure byte ops, no hashing) so it bundles into both the Bun client
 * and the workerd Worker. The caller hashes the bytes in its own runtime to derive /
 * verify `sidecarSha`. A golden-vector test pins the encoding in both test suites.
 */

export interface Ref {
  encSha: string; // 64-hex sha256
  size: number;
}

export const REFSET_MAGIC = "rbox-refset-v1"; // 14 bytes
export const REFSET_HEADER = 18; // 14 magic + 4 count(u32be)
export const REFSET_REC = 40; // 32 sha + 8 size(u64be)
/** Sizes are R2-object byte counts that must round-trip through D1 accounting as JS
 *  numbers, so they're bounded to the safe-integer range (a u64 ≥ 2^53 is rejected). */
const MAX_REF_SIZE = Number.MAX_SAFE_INTEGER;

const SHA_RE = /^[0-9a-f]{64}$/;
const MAGIC_BYTES = new Uint8Array(REFSET_MAGIC.length);
for (let i = 0; i < REFSET_MAGIC.length; i++) MAGIC_BYTES[i] = REFSET_MAGIC.charCodeAt(i);

function hexToBytes32(hex: string, out: Uint8Array, off: number): void {
  for (let i = 0; i < 32; i++) out[off + i] = parseInt(hex.substr(i * 2, 2), 16);
}
export function bytes32ToHex(b: Uint8Array, off: number): string {
  let s = "";
  for (let i = 0; i < 32; i++) s += b[off + i]!.toString(16).padStart(2, "0");
  return s;
}

/** Expected total byte length for a sidecar with `count` refs (cheap pre-GET check
 *  against the R2 object's reported size, before allocating from a self-declared count). */
export function refsetByteLength(count: number): number {
  return REFSET_HEADER + REFSET_REC * count;
}

/** Strictly validate canonical refset bytes without allocating SHA strings or Ref
 * objects. Returns the sum of record sizes. */
export function validateRefsetBytes(bytes: Uint8Array): number {
  if (bytes.length < REFSET_HEADER) throw new Error("refset: too short");
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error("refset: bad magic");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(14, false);
  if (bytes.length !== refsetByteLength(count)) throw new Error("refset: length mismatch (trailing/short bytes)");
  let totalBytes = 0;
  for (let i = 0; i < count; i++) {
    const off = REFSET_HEADER + REFSET_REC * i;
    if (i > 0) {
      const prevOff = off - REFSET_REC;
      let cmp = 0;
      for (let j = 0; j < 32; j++) {
        cmp = bytes[prevOff + j]! - bytes[off + j]!;
        if (cmp !== 0) break;
      }
      if (cmp >= 0) throw new Error("refset: not strictly ascending / duplicate sha");
    }
    const sizeBig = dv.getBigUint64(off + 32, false);
    if (sizeBig > BigInt(MAX_REF_SIZE)) throw new Error("refset: size exceeds safe integer range");
    totalBytes += Number(sizeBig);
  }
  return totalBytes;
}

/** Extract SHA strings without validation. Only call for bytes already validated by
 * validateRefsetBytes or parseRefset. */
export function refsetShas(bytes: Uint8Array): string[] {
  const count = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(14, false);
  const shas = new Array<string>(count);
  for (let i = 0; i < count; i++) shas[i] = bytes32ToHex(bytes, REFSET_HEADER + REFSET_REC * i);
  return shas;
}

/**
 * Serialize a ref set to the canonical bytes. Input may be in any order; the output is
 * sorted ascending by raw sha bytes (== ascending hex, since hex preserves byte order)
 * with duplicates rejected — identical sets always yield byte-identical output.
 */
export function serializeRefset(refs: Ref[]): Uint8Array {
  const seen = new Set<string>();
  const sorted = [...refs].sort((a, b) => (a.encSha < b.encSha ? -1 : a.encSha > b.encSha ? 1 : 0));
  const out = new Uint8Array(refsetByteLength(sorted.length));
  out.set(MAGIC_BYTES, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(14, sorted.length, false);
  let off = REFSET_HEADER;
  for (const r of sorted) {
    if (!SHA_RE.test(r.encSha)) throw new Error(`refset: malformed encSha ${r.encSha}`);
    if (!Number.isSafeInteger(r.size) || r.size < 0) throw new Error(`refset: bad size ${r.size}`);
    if (seen.has(r.encSha)) throw new Error(`refset: duplicate encSha ${r.encSha}`);
    seen.add(r.encSha);
    hexToBytes32(r.encSha, out, off);
    dv.setBigUint64(off + 32, BigInt(r.size), false);
    off += REFSET_REC;
  }
  return out;
}

/**
 * Strictly parse canonical sidecar bytes back to the ref set. Throws on ANY deviation
 * (wrong magic, length≠18+40·count, unsorted, duplicate sha, size out of safe range).
 * Allocation is bounded by the actual byte length, never the self-declared count
 * (length is validated against count first). Returns refs in canonical order.
 */
export function parseRefset(bytes: Uint8Array): Ref[] {
  if (bytes.length < REFSET_HEADER) throw new Error("refset: too short");
  for (let i = 0; i < MAGIC_BYTES.length; i++) {
    if (bytes[i] !== MAGIC_BYTES[i]) throw new Error("refset: bad magic");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(14, false);
  // Validate length BEFORE trusting count for any allocation/iteration.
  if (bytes.length !== refsetByteLength(count)) throw new Error("refset: length mismatch (trailing/short bytes)");
  const refs: Ref[] = new Array(count);
  let prevHex = "";
  let off = REFSET_HEADER;
  for (let i = 0; i < count; i++) {
    const encSha = bytes32ToHex(bytes, off);
    if (encSha <= prevHex && i > 0) throw new Error("refset: not strictly ascending / duplicate sha");
    prevHex = encSha;
    const sizeBig = dv.getBigUint64(off + 32, false);
    if (sizeBig > BigInt(MAX_REF_SIZE)) throw new Error("refset: size exceeds safe integer range");
    refs[i] = { encSha, size: Number(sizeBig) };
    off += REFSET_REC;
  }
  return refs;
}

/** Memory-lean parser used by the retained-root index fold. It performs the
 * same strict validation as parseRefset, but retains only sha strings. */
export function parseRefsetShaSet(bytes: Uint8Array): Set<string> {
  if (bytes.length < REFSET_HEADER) throw new Error("refset: too short");
  for (let i = 0; i < MAGIC_BYTES.length; i++) if (bytes[i] !== MAGIC_BYTES[i]) throw new Error("refset: bad magic");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = dv.getUint32(14, false);
  if (bytes.length !== refsetByteLength(count)) throw new Error("refset: length mismatch (trailing/short bytes)");
  const refs = new Set<string>();
  let prevHex = "";
  let off = REFSET_HEADER;
  for (let i = 0; i < count; i++) {
    const encSha = bytes32ToHex(bytes, off);
    if (i > 0 && encSha <= prevHex) throw new Error("refset: not strictly ascending / duplicate sha");
    prevHex = encSha;
    if (dv.getBigUint64(off + 32, false) > BigInt(MAX_REF_SIZE)) throw new Error("refset: size exceeds safe integer range");
    refs.add(encSha);
    off += REFSET_REC;
  }
  return refs;
}
