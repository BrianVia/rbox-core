/**
 * Deterministic seeded fixture generator (design: benchmarking-and-observability §2.3).
 * Same (name, seed) → byte-identical tree, so runs are comparable across machines.
 * A different seed → different CONTENT (so blobs are genuinely missing server-side =
 * a true cold first-push under convergent encryption), same SHAPE (comparable cost).
 *
 * Deliberately seeds the two shapes that bit us dogfooding: EMPTY (0-byte) files and
 * DUPLICATE-content files (same convergent encSha).
 *
 * Usage: bun scripts/bench/corpus.ts <dir> <name> <seed>
 */
import fs from "node:fs";
import path from "node:path";

/** Tiny deterministic PRNG (mulberry32) — no Math.random, fully reproducible. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface CorpusShape {
  files: number; // total regular files
  dirs: number; // spread across this many directories
  emptyFiles: number; // 0-byte files (.gitkeep-style)
  duplicateFiles: number; // files sharing ONE content (same encSha)
  minBytes: number;
  maxBytes: number;
}

export const SHAPES: Record<string, CorpusShape> = {
  tiny: { files: 100, dirs: 10, emptyFiles: 5, duplicateFiles: 10, minBytes: 64, maxBytes: 4096 },
  small: { files: 1200, dirs: 60, emptyFiles: 40, duplicateFiles: 120, minBytes: 64, maxBytes: 16384 },
  repo: { files: 5000, dirs: 300, emptyFiles: 150, duplicateFiles: 500, minBytes: 32, maxBytes: 65536 },
};

export interface CorpusStats {
  files: number;
  totalBytes: number;
  emptyFiles: number;
  duplicateFiles: number;
}

/** Write a fresh corpus into `dir` (wiped first). `seed` varies content, not shape. */
export function generateCorpus(dir: string, shape: CorpusShape, seed: number): CorpusStats {
  // Wipe prior content but PRESERVE `.rbox/` (the workspace state) so a sweep can
  // regenerate fresh corpora into an already-initialized workspace.
  fs.mkdirSync(dir, { recursive: true });
  for (const e of fs.readdirSync(dir)) {
    if (e === ".rbox") continue;
    fs.rmSync(path.join(dir, e), { recursive: true, force: true });
  }
  const rand = rng(seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  // pre-make dirs
  const dirs = ["."];
  for (let d = 0; d < shape.dirs; d++) {
    const depth = randInt(1, 3);
    let p = "";
    for (let k = 0; k < depth; k++) p = path.join(p, `d${randInt(0, shape.dirs)}`);
    fs.mkdirSync(path.join(dir, p), { recursive: true });
    dirs.push(p);
  }
  const pick = <T>(arr: T[]) => arr[Math.floor(rand() * arr.length)]!;
  // one shared content blob for all "duplicate" files (seed-varied so it's a fresh blob)
  const dupContent = Buffer.from(`dup-${seed}-`.repeat(200));

  let totalBytes = 0;
  let i = 0;
  const writeAt = (name: string, buf: Buffer) => {
    fs.writeFileSync(path.join(dir, pick(dirs), name), buf);
    totalBytes += buf.length;
  };
  for (let n = 0; n < shape.emptyFiles; n++) writeAt(`empty-${i++}.keep`, Buffer.alloc(0));
  for (let n = 0; n < shape.duplicateFiles; n++) writeAt(`dup-${i++}.txt`, dupContent);
  const rest = shape.files - shape.emptyFiles - shape.duplicateFiles;
  for (let n = 0; n < rest; n++) {
    const len = randInt(shape.minBytes, shape.maxBytes);
    const buf = Buffer.allocUnsafe(len);
    // seed-varied pseudo-random bytes so content (→ encSha) is unique per seed
    for (let b = 0; b < len; b++) buf[b] = (randInt(0, 255) ^ (i & 0xff)) & 0xff;
    writeAt(`f-${i++}.bin`, buf);
  }
  totalBytes += dupContent.length; // dup content counted once as a blob
  return { files: shape.files, totalBytes, emptyFiles: shape.emptyFiles, duplicateFiles: shape.duplicateFiles };
}

if (import.meta.main) {
  const [dir, name, seedStr] = process.argv.slice(2);
  if (!dir || !name || !SHAPES[name]) {
    console.error(`usage: bun scripts/bench/corpus.ts <dir> <${Object.keys(SHAPES).join("|")}> <seed>`);
    process.exit(2);
  }
  const stats = generateCorpus(dir, SHAPES[name]!, Number(seedStr ?? "1"));
  console.log(JSON.stringify(stats));
}
