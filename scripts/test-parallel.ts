/** Local N-way test parallelization over the CI shard registry.
 *  `bun run test:parallel [shards]` — runs the same shard partitioning CI uses
 *  (scripts/ci-shard-tests.ts) as concurrent local processes. Measured on the
 *  32-thread desktop (2026-07-26): 6 shards = 126s wall vs 364s serial, zero
 *  cross-shard flakes observed. If shards start flaking here but pass serially,
 *  suspect shared-state contention (~/.rbox/daemons litter, ports) before
 *  blaming the tests. */
const shardCount = Number(process.argv[2] ?? "6");
if (!Number.isInteger(shardCount) || shardCount < 6 || shardCount > 16) {
  console.error(`test-parallel: shard count must be 6..16 (the shard registry's anti-affinity groups need >=6), got ${process.argv[2]}`);
  process.exit(2);
}
const t0 = performance.now();
const procs = Array.from({ length: shardCount }, (_, i) =>
  Bun.spawn(["bun", "scripts/ci-shard-tests.ts", "run", "--shard-count", String(shardCount), "--shard-index", String(i)], {
    stdout: "pipe",
    stderr: "pipe",
  }));
const results = await Promise.all(procs.map(async (p, i) => {
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { i, code, tail: (out + err).split("\n").filter((l) => /(pass|fail|skip)/.test(l)).slice(-4) };
}));
const wall = ((performance.now() - t0) / 1000).toFixed(0);
let failed = false;
for (const r of results) {
  const status = r.code === 0 ? "ok" : "FAIL";
  if (r.code !== 0) failed = true;
  console.log(`shard ${r.i}/${shardCount}: ${status}${r.code === 0 ? "" : `\n${r.tail.join("\n")}`}`);
}
console.log(`test-parallel: ${shardCount} shards, wall ${wall}s${failed ? " — FAILURES above" : ", all green"}`);
process.exit(failed ? 1 : 0);
