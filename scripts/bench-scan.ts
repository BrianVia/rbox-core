/**
 * Cold/warm scan benchmark (design 09 §2). Measures `scanManifest` cost on a
 * real tree to decide whether incremental/lazy hashing is needed.
 *
 *   bun scripts/bench-scan.ts <dir>
 *
 * Cold = no hashcache (every file hashed). Warm = second pass reusing the cache
 * (mtime/size hits skip hashing). Reports files, bytes hashed, and wall time.
 * The walk is ignore-aware, so node_modules/target/.venv/.git are skipped —
 * which is the whole point (don't pay to scan regenerable dirs).
 */
import { scanManifest, buildIgnoreMatcher, HashCache } from "../src/engine/index.js";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun scripts/bench-scan.ts <dir>");
  process.exit(1);
}

function bytesOf(m: { files: { type: string; size?: number }[] }): number {
  return m.files.reduce((n, f) => n + (f.type === "file" ? (f.size ?? 0) : 0), 0);
}
const ms = (start: number) => `${(performance.now() - start).toFixed(0)}ms`;
const mib = (n: number) => `${(n / 1024 / 1024).toFixed(1)}MiB`;

const matcher = buildIgnoreMatcher(dir);

// COLD: a fresh cache → every file is hashed.
const cold = new HashCache();
let t = performance.now();
const m1 = await scanManifest(dir, matcher, cold);
const coldMs = ms(t);

// WARM: reuse the now-populated cache → unchanged files skip hashing.
t = performance.now();
const m2 = await scanManifest(dir, matcher, cold);
const warmMs = ms(t);

const fileCount = m1.files.filter((f) => f.type === "file").length;
console.log(`tree:        ${dir}`);
console.log(`entries:     ${m1.files.length} (${fileCount} files, ${m1.files.length - fileCount} dirs/symlinks)`);
console.log(`bytes:       ${mib(bytesOf(m1))}`);
console.log(`COLD scan:   ${coldMs}  (every file hashed)`);
console.log(`WARM scan:   ${warmMs}  (cache hits skip hashing)`);
console.log(`consistent:  ${m1.files.length === m2.files.length ? "yes" : "NO — count drift!"}`);
