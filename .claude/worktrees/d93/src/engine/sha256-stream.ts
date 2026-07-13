/**
 * Pure-JS streaming SHA-256 (FIPS 180-4). Dependency-free so it runs in workerd
 * (the Worker has no streaming WebCrypto digest, and we avoid the nodejs_compat
 * flag). Used Worker-side for multipart post-complete whole-object verification,
 * where the object is streamed back from R2 and hashed incrementally without ever
 * buffering it. Verified against node:crypto in tests.
 *
 * The client (Bun) hashes via node:crypto (hash.ts) — faster; this module exists
 * for the constrained Worker runtime.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

export class Sha256 {
  private readonly h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  private readonly block = new Uint8Array(64);
  private blockLen = 0;
  private totalLen = 0; // bytes hashed so far
  private readonly w = new Uint32Array(64);

  update(data: Uint8Array): this {
    this.totalLen += data.length;
    let off = 0;
    // Fill any partial block first.
    if (this.blockLen > 0) {
      const need = 64 - this.blockLen;
      const take = Math.min(need, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      off = take;
      if (this.blockLen === 64) {
        this.process(this.block);
        this.blockLen = 0;
      }
    }
    // Process full 64-byte blocks directly from input.
    while (off + 64 <= data.length) {
      this.process(data.subarray(off, off + 64));
      off += 64;
    }
    // Buffer the remainder.
    if (off < data.length) {
      const rem = data.length - off;
      this.block.set(data.subarray(off), 0);
      this.blockLen = rem;
    }
    return this;
  }

  digestHex(): string {
    // Pad: 0x80, zeros, then 64-bit big-endian bit length.
    const bitLen = this.totalLen * 8;
    const pad = this.blockLen < 56 ? 56 - this.blockLen : 120 - this.blockLen;
    const tail = new Uint8Array(pad + 8);
    tail[0] = 0x80;
    // 64-bit length (we support up to 2^53 bits via float math on the high/low split).
    const hi = Math.floor(bitLen / 0x100000000);
    const lo = bitLen >>> 0;
    const dv = new DataView(tail.buffer);
    dv.setUint32(pad, hi);
    dv.setUint32(pad + 4, lo);
    this.update(tail);
    // (update bumped totalLen, but we're done.)
    let out = "";
    for (let i = 0; i < 8; i++) out += this.h[i]!.toString(16).padStart(8, "0");
    return out;
  }

  private process(chunk: Uint8Array): void {
    const w = this.w;
    const dv = new DataView(chunk.buffer, chunk.byteOffset, 64);
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = this.h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e!, 6) ^ rotr(e!, 11) ^ rotr(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (h! + S1 + ch + K[i]! + w[i]!) | 0;
      const S0 = rotr(a!, 2) ^ rotr(a!, 13) ^ rotr(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d! + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    this.h[0] = (this.h[0]! + a!) | 0;
    this.h[1] = (this.h[1]! + b!) | 0;
    this.h[2] = (this.h[2]! + c!) | 0;
    this.h[3] = (this.h[3]! + d!) | 0;
    this.h[4] = (this.h[4]! + e!) | 0;
    this.h[5] = (this.h[5]! + f!) | 0;
    this.h[6] = (this.h[6]! + g!) | 0;
    this.h[7] = (this.h[7]! + h!) | 0;
  }
}

/** Hash an async stream of byte chunks (e.g. an R2 object body) without buffering. */
export async function sha256OfStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const hasher = new Sha256();
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) hasher.update(value);
  }
  return hasher.digestHex();
}
