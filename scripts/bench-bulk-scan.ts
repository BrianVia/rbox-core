/**
 * Full-scan wall-time benchmark for the default Darwin bulk walk. Read-only
 * against the target root.
 *
 * Measures WARM scans (HashCache primed → all cache hits → the pass is stat +
 * readdir dominated, exactly the phase getattrlistbulk targets), plus one COLD
 * scan for context. On unsupported runtimes the scanner uses its ordinary
 * per-directory fallback.
 *
 *   bun scripts/bench-bulk-scan.ts <root> [--iters=N]
 */
import { buildIgnoreMatcher, createScanStats, HashCache, scanManifest, type ScanStats } from "../src/engine/index.js";
import { bulkWalkSupported } from "../src/engine/darwin-bulk-walk.js";

const p50 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

async function oneScan(root: string, cache: HashCache): Promise<{ wallMs: number; stats: ScanStats }> {
  const matcher = buildIgnoreMatcher(root);
  const stats = createScanStats();
  const t0 = performance.now();
  const m = await scanManifest(root, matcher, cache, undefined, undefined, stats);
  if (m.files.length < 0) throw new Error("unreachable");
  return { wallMs: performance.now() - t0, stats };
}

const root = process.argv[2];
if (!root) { console.error("usage: bun scripts/bench-bulk-scan.ts <root> [--iters=N]"); process.exit(2); }
const iters = Number(process.argv.find((a) => a.startsWith("--iters="))?.split("=")[1] ?? 5);
const bulk = bulkWalkSupported();

const cache = new HashCache();
const cold = await oneScan(root, cache); // primes the cache (hashes everything)

const walls: number[] = [], statMs: number[] = [], readdirMs: number[] = [];
let last: ScanStats | undefined;
for (let i = 0; i < iters; i++) {
  const r = await oneScan(root, cache);
  walls.push(r.wallMs); statMs.push(r.stats.statMs); readdirMs.push(r.stats.readdirMs);
  last = r.stats;
}

console.log(JSON.stringify({
  mode: bulk ? "bulk" : "fallback", platform: process.platform, arch: process.arch, root,
  coldWallMs: Math.round(cold.wallMs),
  warm: {
    iters,
    wallP50Ms: Math.round(p50(walls)),
    statP50Ms: Math.round(p50(statMs)),
    readdirP50Ms: Math.round(p50(readdirMs)),
    wallAllMs: walls.map((x) => Math.round(x)),
  },
  lastStats: last && { dirsWalked: last.dirsWalked, filesStatted: last.filesStatted, filesSkippedCacheHit: last.filesSkippedCacheHit, filesHashed: last.filesHashed },
}, null, 2));
