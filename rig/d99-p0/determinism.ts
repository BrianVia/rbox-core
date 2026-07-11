import fs from "node:fs/promises";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { encryptFileToTempInline, generateKek } from "../../src/engine/crypto.js";
import { encryptBytesInMemory, sha256 } from "./core.js";

function seeded(size: number, compressible: boolean): Buffer {
  const b = Buffer.alloc(size);
  let x = (size + 1) >>> 0;
  for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = compressible ? 97 + (i % 4) : x & 255; }
  return b;
}

async function streamRatio(src: Buffer): Promise<number> {
  const chunks: Buffer[] = [];
  await pipeline(Readable.from([src]), (zlib as any).createZstdCompress({ level: 3 }), new Writable({ write(c, _e, cb) { chunks.push(c); cb(); } }));
  return Buffer.concat(chunks).length / src.length;
}

/** Fixtures straddling the COMPRESS_RATIO 0.95 keep/reject edge: mix random and
 *  constant bytes, sweeping the random fraction until the zstd-3 ratio lands
 *  just below and just above 0.95. Deterministic (seeded). */
async function ratioEdgeFixtures(): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let below: Buffer | undefined, above: Buffer | undefined;
  for (let k = 100; k >= 2 && (!below || !above); k--) {
    const size = 8192; const b = Buffer.alloc(size); let x = 424242;
    for (let i = 0; i < size; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; b[i] = i % k === 0 ? 97 : x & 255; }
    const r = await streamRatio(b);
    if (r < 0.95 && r > 0.9 && !below) below = b;
    if (r >= 0.95 && r < 0.999 && !above) above = b;
  }
  if (below) out.push(below);
  if (above) out.push(above);
  return out;
}

export async function runDeterminism(root: string) {
  // Size boundaries: empty, COMPRESS_MIN_BYTES (128) edge, stream-chunk (64 KiB)
  // edges, FUSE_MAX_FILE_BYTES (256 KiB) edge; compressible + incompressible each.
  const sizes = [0, 127, 128, 129, 255, 512, 2048, 8192, 65535, 65536, 65537, 131072, 200001, 262143, 262144, 262145];
  const cases: Buffer[] = sizes.flatMap((size) => (size === 0 ? [seeded(size, true)] : [seeded(size, true), seeded(size, false)]));
  cases.push(...(await ratioEdgeFixtures()));
  const kek = generateKek();
  const failures: { ordinal: number; size: number; expectedSha: string; oracleEncSha: string; memoryEncSha: string }[] = [];
  for (let ordinal = 0; ordinal < cases.length; ordinal++) {
    const src = cases[ordinal];
    const expected = { sha256: sha256(src), size: src.length };
    const srcPath = path.join(root, `d${ordinal}`);
    await fs.writeFile(srcPath, src);
    const oracle = await encryptFileToTempInline(srcPath, kek, root, { compress: true, expected });
    const mem = await encryptBytesInMemory(src, kek, expected, true);
    const oracleCt = await fs.readFile(oracle.ciphertextPath);
    await fs.rm(oracle.ciphertextPath, { force: true });
    const same = oracle.plaintextSha === mem.plaintextSha && oracle.encSha === mem.encSha && oracle.cipherSize === mem.cipherSize
      && oracle.comp === mem.comp && oracle.payloadSha === mem.payloadSha && oracleCt.equals(Buffer.from(mem.ct));
    if (!same) failures.push({ ordinal, size: src.length, expectedSha: expected.sha256, oracleEncSha: oracle.encSha, memoryEncSha: mem.encSha });
  }
  return { pass: failures.length === 0, cases: cases.length, failures };
}
