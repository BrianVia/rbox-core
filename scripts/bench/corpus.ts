/**
 * Deterministic seeded fixture generator (design: benchmarking-and-observability §2.3).
 * Same (name, seed) → byte-identical tree, so runs are comparable across machines.
 * A different seed → different CONTENT (so blobs are genuinely missing server-side =
 * a true cold first-push under convergent encryption), same SHAPE (comparable cost).
 *
 * Deliberately seeds the shapes that matter to real workspaces: empty and
 * duplicate files, repositories, dense dependency trees, deep paths, large
 * binaries, and nested ignore rules.
 *
 * Usage:
 *   bun scripts/bench/corpus.ts <dir> <name> <seed>
 *   bun scripts/bench/corpus.ts <dir> corpus-112k 163112 --verify
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

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

export interface DevWorkspaceProfile {
  repos: number;
  dependencyDirs: number;
  deepDirs: number;
  largeBinaries: number;
  nestedIgnoreFiles: number;
}

export interface CorpusShape {
  files: number; // exact total regular files, including repository/ignore fixtures
  dirs: number; // ordinary directories in addition to profile directories
  emptyFiles: number; // 0-byte files (.gitkeep-style)
  duplicateFiles: number; // files sharing ONE content (same encSha)
  minBytes: number;
  maxBytes: number;
  profile?: DevWorkspaceProfile;
}

const CONTRACT_PROFILE: DevWorkspaceProfile = {
  repos: 2,
  dependencyDirs: 4,
  deepDirs: 3,
  largeBinaries: 2,
  nestedIgnoreFiles: 3,
};

export const CORPUS_112K_SEED = 163112;
export const CORPUS_MANIFEST_VERSION = 1;

export const CORPUS_112K_SHAPE: CorpusShape = {
  files: 112259,
  dirs: 4200,
  emptyFiles: 2200,
  duplicateFiles: 12000,
  minBytes: 24,
  maxBytes: 512,
  profile: {
    repos: 24,
    dependencyDirs: 640,
    deepDirs: 320,
    largeBinaries: 32,
    nestedIgnoreFiles: 48,
  },
};

export const SHAPES: Record<string, CorpusShape> = {
  tiny: { files: 100, dirs: 10, emptyFiles: 5, duplicateFiles: 10, minBytes: 64, maxBytes: 4096 },
  small: { files: 1200, dirs: 60, emptyFiles: 40, duplicateFiles: 120, minBytes: 64, maxBytes: 16384 },
  repo: { files: 5000, dirs: 300, emptyFiles: 150, duplicateFiles: 500, minBytes: 32, maxBytes: 65536 },
  "corpus-contract": {
    files: 240,
    dirs: 12,
    emptyFiles: 8,
    duplicateFiles: 20,
    minBytes: 16,
    maxBytes: 192,
    profile: CONTRACT_PROFILE,
  },
  "corpus-112k": CORPUS_112K_SHAPE,
};

/** Reproducibility pin: the name, seed, complete shape, framing, and expected identity. */
export const CORPUS_112K_PIN = {
  name: "corpus-112k",
  seed: CORPUS_112K_SEED,
  manifestVersion: CORPUS_MANIFEST_VERSION,
  shape: CORPUS_112K_SHAPE,
  sha256: "08ff772a60aa9e7968db0babf2a5c402ab9b0c8b320d8833fac855314fadfc88",
} as const;
export const CORPUS_112K_MANIFEST_SHA256 = CORPUS_112K_PIN.sha256;

/** SHA-256 of corpus-contract, seed 163112, manifest framing v1. */
export const CORPUS_CONTRACT_MANIFEST_SHA256 = "c95a54f7ec5807edc6cb9fb9e7c957de3a6a25e8bcd76873f38a381193ee9785";

export interface CorpusStats {
  files: number;
  totalBytes: number;
  emptyFiles: number;
  duplicateFiles: number;
}

function assertSeed(seed: number): void {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) {
    throw new Error(`seed must be a uint32, got ${String(seed)}`);
  }
}

function bytewise(a: string, b: string): number {
  return Buffer.from(a).compare(Buffer.from(b));
}

function listRegularFiles(root: string): string[] {
  const result: string[] = [];
  const visit = (relDir: string): void => {
    const absDir = path.join(root, relDir);
    for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
      if (relDir === "" && entry.name === ".rbox") continue;
      const rel = relDir === "" ? entry.name : path.join(relDir, entry.name);
      if (entry.isDirectory()) visit(rel);
      else if (entry.isFile()) result.push(rel.split(path.sep).join("/"));
    }
  };
  visit("");
  return result.sort(bytewise);
}

/**
 * Hash every physical regular file (including ignored and .git files), while
 * excluding the deliberately preserved .rbox state directory. Framing is:
 * "rbox-corpus-v1\0", then repeated u32be(path bytes), path, u64be(size),
 * sha256(file bytes).
 */
export function computeCorpusManifestHash(root: string): string {
  const manifest = createHash("sha256");
  manifest.update(`rbox-corpus-v${CORPUS_MANIFEST_VERSION}\0`);
  for (const rel of listRegularFiles(root)) {
    const pathBytes = Buffer.from(rel, "utf8");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(pathBytes.length);
    const bytes = fs.readFileSync(path.join(root, ...rel.split("/")));
    const size = Buffer.allocUnsafe(8);
    size.writeBigUInt64BE(BigInt(bytes.length));
    manifest.update(length);
    manifest.update(pathBytes);
    manifest.update(size);
    manifest.update(createHash("sha256").update(bytes).digest());
  }
  return manifest.digest("hex");
}

/** Write a fresh corpus into `dir` (wiped first). `seed` varies content, not shape. */
export function generateCorpus(dir: string, shape: CorpusShape, seed: number): CorpusStats {
  assertSeed(seed);
  if (shape.emptyFiles + shape.duplicateFiles > shape.files) {
    throw new Error("emptyFiles + duplicateFiles exceeds total files");
  }

  // Wipe prior content but PRESERVE `.rbox/` (the workspace state) so a sweep can
  // regenerate fresh corpora into an already-initialized workspace.
  fs.mkdirSync(dir, { recursive: true });
  for (const entry of fs.readdirSync(dir)) {
    if (entry === ".rbox") continue;
    fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
  }

  const rand = rng(seed);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
  const dirs = ["."];
  for (let d = 0; d < shape.dirs; d++) {
    const depth = randInt(1, 3);
    let rel = "";
    for (let k = 0; k < depth; k++) rel = path.join(rel, `d${randInt(0, shape.dirs)}`);
    fs.mkdirSync(path.join(dir, rel), { recursive: true });
    dirs.push(rel);
  }

  const profile = shape.profile;
  const repoDirs: string[] = [];
  const dependencyDirs: string[] = [];
  const deepDirs: string[] = [];
  if (profile) {
    for (let n = 0; n < profile.repos; n++) {
      const rel = path.join("repos", `repo-${String(n).padStart(2, "0")}`);
      repoDirs.push(rel);
      dirs.push(path.join(rel, "src"), path.join(rel, "test"));
    }
    for (let n = 0; n < profile.dependencyDirs; n++) {
      const repo = repoDirs[n % repoDirs.length]!;
      const rel = path.join(repo, "node_modules", `pkg-${String(n).padStart(4, "0")}`, n % 2 ? "lib" : "dist");
      dependencyDirs.push(rel);
      dirs.push(rel);
    }
    for (let n = 0; n < profile.deepDirs; n++) {
      const repo = repoDirs[n % repoDirs.length]!;
      const rel = path.join(repo, "src", "features", `feature-${n}`, "generated", "platform", "internal", "v1", "types");
      deepDirs.push(rel);
      dirs.push(rel);
    }
    for (const rel of dirs) fs.mkdirSync(path.join(dir, rel), { recursive: true });
  }

  const pick = <T>(items: T[]): T => items[Math.floor(rand() * items.length)]!;
  const dupContent = Buffer.from(`dup-${seed}-`.repeat(200));
  let totalBytes = 0;
  let written = 0;
  let serial = 0;
  const writeExact = (rel: string, bytes: Buffer): void => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), bytes);
    totalBytes += bytes.length;
    written++;
  };
  const writePicked = (name: string, bytes: Buffer, pool = dirs): void => {
    writeExact(path.join(pick(pool), name), bytes);
  };
  const seededBytes = (length: number): Buffer => {
    const bytes = Buffer.allocUnsafe(length);
    for (let offset = 0; offset < length; offset += 4) {
      const value = Math.floor(rand() * 0x100000000) >>> 0;
      bytes[offset] = value & 0xff;
      if (offset + 1 < length) bytes[offset + 1] = (value >>> 8) & 0xff;
      if (offset + 2 < length) bytes[offset + 2] = (value >>> 16) & 0xff;
      if (offset + 3 < length) bytes[offset + 3] = (value >>> 24) & 0xff;
    }
    return bytes;
  };

  for (let n = 0; n < shape.emptyFiles; n++) writePicked(`empty-${serial++}.keep`, Buffer.alloc(0));
  for (let n = 0; n < shape.duplicateFiles; n++) writePicked(`dup-${serial++}.txt`, dupContent);

  if (profile) {
    // Deterministic, valid unborn Git repositories; no host `git init` defaults
    // or timestamps enter the fixture.
    for (let n = 0; n < profile.repos; n++) {
      const repo = repoDirs[n]!;
      fs.mkdirSync(path.join(dir, repo, ".git", "objects"), { recursive: true });
      fs.mkdirSync(path.join(dir, repo, ".git", "refs", "heads"), { recursive: true });
      writeExact(path.join(repo, ".git", "HEAD"), Buffer.from("ref: refs/heads/main\n"));
      writeExact(
        path.join(repo, ".git", "config"),
        Buffer.from("[core]\n\trepositoryformatversion = 0\n\tbare = false\n"),
      );
      writeExact(path.join(repo, ".git", "description"), Buffer.from("rbox seeded fixture\n"));
      writeExact(path.join(repo, ".git", "info", "exclude"), Buffer.from("*.local\n"));
    }
    for (let n = 0; n < profile.nestedIgnoreFiles; n++) {
      const repo = repoDirs[n % repoDirs.length]!;
      const nested = path.join(repo, "src", `ignored-shape-${n}`);
      writeExact(
        path.join(nested, ".gitignore"),
        Buffer.from("generated/\n*.cache\n!important.cache\n"),
      );
      writeExact(path.join(nested, "generated", "output.js"), Buffer.from(`ignored generated ${seed}:${n}\n`));
      writeExact(path.join(nested, "ignored.cache"), Buffer.from(`ignored cache ${seed}:${n}\n`));
      writeExact(path.join(nested, "important.cache"), Buffer.from(`re-included cache ${seed}:${n}\n`));
    }
    for (let n = 0; n < profile.largeBinaries; n++) {
      const repo = repoDirs[n % repoDirs.length]!;
      writeExact(path.join(repo, "assets", `bundle-${n}.bin`), seededBytes(256 * 1024 + n * 257));
    }
  }

  if (written > shape.files) throw new Error(`profile fixtures exceed file budget (${written} > ${shape.files})`);
  while (written < shape.files) {
    const length = randInt(shape.minBytes, shape.maxBytes);
    const pool = !profile
      ? dirs
      : written % 10 < 6
        ? dependencyDirs
        : written % 10 < 8
          ? repoDirs
          : deepDirs;
    writePicked(`f-${serial++}.bin`, seededBytes(length), pool);
  }

  const actualFiles = listRegularFiles(dir).length;
  if (actualFiles !== shape.files) {
    throw new Error(`generated file count mismatch: expected ${shape.files}, got ${actualFiles}`);
  }
  return {
    files: actualFiles,
    totalBytes,
    emptyFiles: shape.emptyFiles,
    duplicateFiles: shape.duplicateFiles,
  };
}

export function verifyPinnedCorpus(root: string, name: string, seed: number): string {
  if (name !== CORPUS_112K_PIN.name || seed !== CORPUS_112K_PIN.seed) {
    throw new Error(`--verify requires ${CORPUS_112K_PIN.name} seed ${CORPUS_112K_PIN.seed}`);
  }
  const actual = computeCorpusManifestHash(root);
  if (actual !== CORPUS_112K_PIN.sha256) {
    throw new Error(`${CORPUS_112K_PIN.name} manifest mismatch: expected ${CORPUS_112K_PIN.sha256}, got ${actual}`);
  }
  return actual;
}

if (import.meta.main) {
  const [dir, name, seedText, flag] = process.argv.slice(2);
  if (!dir || !name || !SHAPES[name]) {
    console.error(`usage: bun scripts/bench/corpus.ts <dir> <${Object.keys(SHAPES).join("|")}> <seed> [--verify]`);
    process.exit(2);
  }
  const seed = Number(seedText ?? "1");
  const started = performance.now();
  const stats = generateCorpus(dir, SHAPES[name]!, seed);
  const output: CorpusStats & { manifestSha256?: string; generationMs: number } = {
    ...stats,
    generationMs: Math.round(performance.now() - started),
  };
  if (flag === "--verify") output.manifestSha256 = verifyPinnedCorpus(dir, name, seed);
  else if (flag !== undefined) throw new Error(`unknown flag: ${flag}`);
  console.log(JSON.stringify(output));
}
