import fs from "node:fs/promises";
import path from "node:path";
import { sha256, type Expected } from "./core.js";

export type Bucket = "empty" | "tiny" | "small" | "med" | "large" | "xl" | "near-cap" | "over-cap";
export type CorpusFile = { index: number; absPath: string; size: number; expected: Expected; bucket: Bucket; compressible: boolean };
export const HISTOGRAM: ReadonlyArray<{ bucket: Bucket; min: number; max: number; share: number }> = [
  { bucket: "empty", min: 0, max: 0, share: 3 }, { bucket: "tiny", min: 1, max: 511, share: 22 },
  { bucket: "small", min: 512, max: 2047, share: 30 }, { bucket: "med", min: 2048, max: 8191, share: 22 },
  { bucket: "large", min: 8192, max: 32767, share: 13 }, { bucket: "xl", min: 32768, max: 131071, share: 7 },
  { bucket: "near-cap", min: 131072, max: 262144, share: 2 }, { bucket: "over-cap", min: 262145, max: 1048576, share: 1 },
];

function rng(seed: number): () => number { let x = seed >>> 0 || 1; return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; }; }
function bytesFor(size: number, compressible: boolean, random: () => number, index: number): Buffer {
  const out = Buffer.alloc(size);
  if (compressible) { const token = Buffer.from(`{"ordinal":${index},"kind":"source","value":"aaaaaaaaaaaaaaaa"}\n`); for (let p=0;p<size;p+=token.length) token.copy(out,p,0,Math.min(token.length,size-p)); }
  else for (let i=0;i<size;i++) out[i] = Math.floor(random()*256);
  return out;
}
export async function generateCorpus(dir: string, count: number, seed: number): Promise<CorpusFile[]> {
  const random = rng(seed); const files: CorpusFile[] = [];
  for (let index=0; index<count; index++) {
    const pct = ((index * 100) / count + random() / count) % 100;
    let sum=0; const h = HISTOGRAM.find(v => (sum += v.share) > pct)!;
    const size = h.min === h.max ? h.min : h.min + Math.floor(random() * (h.max-h.min+1));
    const compressible = random() < 0.6; const content = bytesFor(size, compressible, random, index);
    const absPath = path.join(dir, String(index)); await fs.writeFile(absPath, content);
    files.push({ index, absPath, size, expected: { sha256: sha256(content), size }, bucket: h.bucket, compressible });
  }
  return files;
}
