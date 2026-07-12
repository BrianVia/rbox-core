/**
 * Full-scan wall-time benchmark for the darwin bulk-walk prototype (founder perf
 * task). Read-only against the target root.
 *
 * Measures WARM scans (HashCache primed → all cache hits → the pass is stat +
 * readdir dominated, exactly the phase getattrlistbulk targets), plus one COLD
 * scan for context. Toggle the bulk path with RBOX_SCAN_BULK=1.
 *
 *   bun scripts/bench-bulk-scan.ts <root> [--iters=N]
 *   RBOX_SCAN_BULK=1 bun scripts/bench-bulk-scan.ts <root> --iters=5
 */
import { buildIgnoreMatcher, createScanStats, HashCache, scanManifest, type ScanStats } from "../src/engine/index.js";

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
const bulk = process.env.RBOX_SCAN_BULK === "1";

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
  mode: bulk ? "bulk" : "stock", platform: process.platform, arch: process.arch, root,
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
