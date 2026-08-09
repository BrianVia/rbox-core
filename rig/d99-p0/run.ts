import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { generateKek } from "../../src/engine/crypto.js";
import { generateCorpus, HISTOGRAM, type CorpusFile } from "./corpus.js";
import { runDeterminism } from "./determinism.js";
import { summary, bootstrapDeltaCI } from "./metrics.js";
interface BunSpawnOptions { stdout: "pipe"; stderr: "pipe"; env: NodeJS.ProcessEnv }
declare const Bun: { spawn(args: string[], opts: BunSpawnOptions): { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> } };

const argv = process.argv.slice(2);
const value = (name: string, fallback: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : fallback; };
const files = Number(value("--files", "20000"));
const budgets = value("--budgets", "24,48,96,192").split(",").map(Number);
const runs = Number(value("--runs", "5"));
const passes = Number(value("--passes", "2"));
const inflights = value("--inflight", "1").split(",").map(Number);
const settles = value("--settle", "0,40").split(",").map(Number);
const maxJobsList = value("--maxjobs", "0").split(",").map(Number);
const determinismOnly = argv.includes("--determinism-only");
const skipScaling = argv.includes("--no-scaling");
const parallel = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
const workers = Math.min(Math.max(parallel - 2, 2), 16, Math.max(1, Math.floor(os.totalmem() / (512 * 1048576)))); // = configuredWorkers()
const resultsDir = new URL("./results/", import.meta.url);
await fs.mkdir(resultsDir, { recursive: true });

const oracleDir = await fs.mkdtemp(path.join(os.tmpdir(), "d99-oracle-"));
let determinism;
try { determinism = await runDeterminism(oracleDir); } finally { await fs.rm(oracleDir, { recursive: true, force: true }); }
console.log(`DETERMINISM: ${determinism.pass ? "PASS" : "FAIL"} (${determinism.cases} cases)`);
if (!determinism.pass) {
  console.error("CRITICAL: fused in-memory path is NOT byte-identical to the oracle — design 99 §7.1 fails.");
  await fs.writeFile(new URL("determinism-fail.json", resultsDir), JSON.stringify(determinism, null, 2));
  process.exit(1);
}
if (determinismOnly) process.exit(0);

// Best-effort cold-cache support: only possible with page-cache drop privileges.
function canDropCaches(): boolean {
  try { execSync("sync && echo 1 > /proc/sys/vm/drop_caches", { shell: "/bin/sh", stdio: "ignore" }); return true; } catch { return false; }
}
const coldAvailable = canDropCaches();

type Raw = Record<string, number | string>;
const raw: Raw[] = [];
const corpusStats: any[] = [];
const kek = generateKek();
const redact = (s: string) => s.split(/\s+/).map((t) => (t.includes("/") ? "[redacted]" : t)).join(" ");
async function child(args: string[], w = workers) {
  const proc = Bun.spawn([process.execPath, new URL("./child.ts", import.meta.url).pathname, ...args, `--workers=${w}`], { stdout: "pipe", stderr: "pipe", env: { ...process.env, RBOX_CRYPTO_WORKERS: String(w) } });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`benchmark child failed: ${redact(stderr)}`);
  return JSON.parse(stdout);
}

const scaling: any[] = [];
for (let pass = 1; pass <= passes; pass++) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "d99-corpus-"));
  try {
    console.log(`pass ${pass}/${passes}: generating ${files} synthetic files`);
    const corpus = await generateCorpus(dir, files, 9900 + pass);
    const manifest = path.join(dir, "manifest.json");
    await fs.writeFile(manifest, JSON.stringify(corpus));
    // Uniform page-cache warmup: every cell (either arm, any order) starts equally
    // warm (adversarial review item 1 — no arm may inherit another arm's warming).
    for (const f of corpus) await fs.readFile(f.absPath);
    const byBucket = Object.fromEntries(HISTOGRAM.map((h) => [h.bucket, { count: corpus.filter((f) => f.bucket === h.bucket).length, bytes: corpus.filter((f) => f.bucket === h.bucket).reduce((n, f) => n + f.size, 0) }]));
    const eligible = corpus.filter((f) => f.size <= 256 * 1024);
    corpusStats.push({ pass, histogram: byBucket, fuseEligibleCount: eligible.length, fuseEligibleBytes: eligible.reduce((n, f) => n + f.size, 0), plaintextBytes: corpus.reduce((n, f) => n + f.size, 0) });
    const base = [`--manifest=${manifest}`, `--kek=${kek.toString("hex")}`];
    // Interleaved cell order within each run: A first, then every B cell.
    for (let run = 1; run <= runs; run++) {
      console.log(`pass ${pass} run ${run}/${runs}: A`);
      raw.push({ ...(await child(["--arm=A", ...base])), pass, run, budgetMiB: 0, inflight: 0, settleMs: 0, maxJobs: 0 });
      for (const budget of budgets) for (const inflight of inflights) for (const settleMs of settles) for (const maxJobs of maxJobsList) {
        console.log(`pass ${pass} run ${run}/${runs}: B budget=${budget}MiB inflight=${inflight} settle=${settleMs}ms maxjobs=${maxJobs}`);
        raw.push({ ...(await child(["--arm=B", `--budget=${budget}`, `--inflight=${inflight}`, `--settle=${settleMs}`, `--maxjobs=${maxJobs}`, ...base])), pass, run, budgetMiB: budget, inflight, settleMs, maxJobs });
      }
    }
    // Worker-count scaling diagnostic (pass 1 only): the audit protocol demands the
    // concurrency confound be visible, not hidden inside the A/B comparison.
    if (pass === 1 && !skipScaling) {
      for (const w of [4, 8, workers].filter((v, i, a) => a.indexOf(v) === i)) {
        const aRes = await child(["--arm=A", ...base], w);
        const bRes = await child(["--arm=B", "--budget=192", "--inflight=1", "--settle=0", ...base], w);
        scaling.push({ workers: w, aWallMs: Math.round(aRes.wallMs), bWallMs: Math.round(bRes.wallMs) });
        console.log(`scaling w=${w}: A ${Math.round(aRes.wallMs)}ms B(192MiB,settle0) ${Math.round(bRes.wallMs)}ms`);
      }
    }
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

const keyOf = (r: Raw) => `${r.arm}|${r.budgetMiB}|${r.inflight}|${r.settleMs}|${r.maxJobs}`;
const keys = [...new Set(raw.map(keyOf))];
const numericKeys = [...new Set(raw.flatMap((r) => Object.keys(r).filter((k) => typeof r[k] === "number")))].filter((k) => !["pass", "run", "budgetMiB", "inflight", "settleMs", "maxJobs"].includes(k));
const cells = keys.map((key) => {
  const rows = raw.filter((r) => keyOf(r) === key);
  const out: any = { arm: rows[0].arm, budgetMiB: rows[0].budgetMiB, inflight: rows[0].inflight, settleMs: rows[0].settleMs, maxJobs: rows[0].maxJobs, samples: rows.length };
  for (const k of numericKeys) { const vals = rows.filter((r) => k in r).map((r) => Number(r[k])); if (vals.length) out[k] = summary(vals); }
  out.perPassWallP50 = Object.fromEntries([...new Set(rows.map((r) => r.pass))].map((p) => [String(p), summary(rows.filter((r) => r.pass === p).map((r) => Number(r.wallMs))).p50]));
  out.walls = rows.map((r) => Number(r.wallMs));
  return out;
});

const a = cells.find((c) => c.arm === "A");
// Budget selection: from the residence-modeled curve (highest settle), the smallest
// budget within 5% of the best throughput across budgets (inflight=1).
const settleForCurve = Math.max(...settles);
const curve = cells.filter((c) => c.arm === "B" && c.inflight === 1 && c.settleMs === settleForCurve);
const bestTp = Math.max(...curve.map((c) => c.filesPerSecond.p50));
// Health-first (design 99 §4.2: a healthy pipeline never spills): among zero-spill
// residence cells within 5% of best throughput, pick the smallest budget (tie-break:
// capped dispatch preferred, as the cap — not RAM starvation — is the honest knob).
const healthy = curve.filter((c) => c.spilledBytes.max === 0);
const candidates = (healthy.length ? healthy : curve).filter((c) => c.filesPerSecond.p50 >= bestTp * 0.95);
const pool = candidates.length ? candidates : (healthy.length ? healthy : curve);
const selected = [...pool].sort((x, y) => x.budgetMiB - y.budgetMiB || y.maxJobs - x.maxJobs)[0];
// Gate cell: the §5.3 null-sink (settle=0) B cell at the selected configuration.
const gateCell = cells.find((c) => c.arm === "B" && c.inflight === 1 && c.settleMs === 0 && c.budgetMiB === selected.budgetMiB && c.maxJobs === selected.maxJobs) ?? selected;
const delta = (a.wallMs.p50 - gateCell.wallMs.p50) / a.wallMs.p50;
const ci = bootstrapDeltaCI(a.walls, gateCell.walls);
const rssOk = gateCell.maxRssBytes.max <= a.maxRssBytes.max + selected.budgetMiB * 1048576 + 32 * 1048576;
const fdOk = gateCell.peakFdCount.max <= a.peakFdCount.max;
const gate = delta >= 0.30 && ci.lo >= 0.30 && rssOk && fdOk; // CI entirely above +30% improvement
const passWallsA = Object.values(a.perPassWallP50) as number[];
const passSpread = passWallsA.length > 1 ? (Math.max(...passWallsA) - Math.min(...passWallsA)) / Math.min(...passWallsA) : 0;

const json = {
  schemaVersion: 2, determinism,
  configuration: { files, workers, budgetsMiB: budgets, runs, passes, inflights, settlesMs: settles, warm: true, cold: coldAvailable ? "available" : "unavailable (no privilege)" },
  corpus: corpusStats, cells: cells.map(({ walls, ...c }) => c), scaling,
  selectedBudgetBytes: selected.budgetMiB * 1048576,
  gate: { deltaP50: delta, bootstrapCI95: ci, rssOk, fdOk, verdict: gate ? "GO" : "NO-GO" },
};
await fs.writeFile(new URL("results.json", resultsDir), JSON.stringify(json, null, 2));
const csvCells = json.cells;
const cols = ["arm", "budgetMiB", "inflight", "settleMs", "samples", ...numericKeys.flatMap((k) => [`${k}_p50`, `${k}_min`, `${k}_max`])];
const csv = [cols.join(","), ...csvCells.map((c: any) => cols.map((k) => { const m = k.match(/(.+)_(p50|min|max)$/); const v = m ? c[m[1]]?.[m[2]] : c[k]; return v === undefined ? "" : v; }).join(","))].join("\n") + "\n";
await fs.writeFile(new URL("results.csv", resultsDir), csv);

const fmtB = (c: any) => `| ${c.budgetMiB} | ${c.maxJobs} | ${c.settleMs} | ${a.wallMs.p50.toFixed(1)} | ${c.wallMs.p50.toFixed(1)} | ${(((a.wallMs.p50 - c.wallMs.p50) / a.wallMs.p50) * 100).toFixed(1)}% | ${c.filesPerSecond.p50.toFixed(0)} | ${Math.round(c.maxRssBytes.max / 1048576)} | ${Math.round(c.budgetHighWaterBytes.max / 1048576)} | ${c.peakHeldCharges?.max ?? 0} | ${c.spilledBytes.max} |`;
const bTable = cells.filter((c) => c.arm === "B" && c.inflight === 1).sort((x, y) => x.settleMs - y.settleMs || x.maxJobs - y.maxJobs || x.budgetMiB - y.budgetMiB).map(fmtB).join("\n");
const histogram = HISTOGRAM.map((h) => { const rows = corpusStats.map((s) => s.histogram[h.bucket]); return `| ${h.bucket} | ${rows.reduce((n: number, x: any) => n + x.count, 0) / rows.length} | ${Math.round(rows.reduce((n: number, x: any) => n + x.bytes, 0) / rows.length)} |`; }).join("\n");
const scalingTable = scaling.map((s) => `| ${s.workers} | ${s.aWallMs} | ${s.bWallMs} |`).join("\n");
const inflightNote = inflights.length > 1 ? cells.filter((c) => c.arm === "B" && c.settleMs === 0 && c.budgetMiB === selected.budgetMiB && c.maxJobs === selected.maxJobs).map((c) => `in-flight ${c.inflight}: wall p50 ${c.wallMs.p50.toFixed(1)} ms`).join("; ") : "in-flight sweep not run";

const report = `# Design 99 Phase-0 A/B report

**THROWAWAY / MEASUREMENT-ONLY.** Synthetic data only.

DETERMINISM: PASS (${determinism.cases} boundary/property cases, byte-identical vs untouched oracle)

Host: ${os.platform()} ${os.arch()}, ${parallel} logical CPUs; corpus + temps on OS tmpdir; ALL cells uniformly page-cache warmed after corpus generation; cell order interleaved (A then B cells per run); cold runs: ${coldAvailable ? "included" : "unavailable (no drop_caches privilege) — warm-only, so the gate evidence is warm-cache only"}. Final N: ${files}; workers: ${workers} (production configuredWorkers()); Arm A caller width = workers*2 (production poolMap).

## Corpus (avg across ${passes} passes, seeds differ per pass)

| Bucket | Count | Bytes |
|---|---:|---:|
${histogram}

Fuse eligible (avg): ${Math.round(corpusStats.reduce((n, s) => n + s.fuseEligibleCount, 0) / corpusStats.length)} files, ${Math.round(corpusStats.reduce((n, s) => n + s.fuseEligibleBytes, 0) / corpusStats.length)} bytes. Content mix: seeded 60% compressible / 40% incompressible, all files unique (100% cache-miss population).

## A/B encrypt wall + RAM-vs-throughput curve (inflight=1)

settle=0 is the pure §5.3 null-sink encrypt critical path; settle=${settleForCurve} ms models upload-settlement lease residence (§4.1) and is the curve the budget is selected from.

| Budget MiB | dispatch cap | settle ms | A p50 ms | B p50 ms | Delta | B files/s | B peak RSS MiB | Budget HWM MiB | Peak held charges | Spill bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${bTable}

Arm A peak RSS ${Math.round(a.maxRssBytes.max / 1048576)} MiB, peak FD ${a.peakFdCount.max}; gate-cell B peak FD ${gateCell.peakFdCount.max}.

## Worker-count scaling diagnostic (pass 1, 1 run per cell — context, not the gate)

| Workers | A wall ms | B wall ms (192 MiB, settle 0) |
|---:|---:|---:|
${scalingTable}

Both arms degrade severely as worker count rises on this host/runtime (Bun ${process.versions?.bun ?? ""}, streaming zstd). See findings.

## Selection + gate

- SELECTED CIPHERTEXT_BUDGET_BYTES: ${selected.budgetMiB * 1048576} (${selected.budgetMiB} MiB), dispatch cap ${selected.maxJobs === 0 ? "none" : selected.maxJobs} — smallest ZERO-SPILL budget within 5% of best throughput on the settle=${settleForCurve} ms residence curve (§4.2 health first).
- Secondary sweep: ${inflightNote}.
- Headline gate delta (A vs B at selected budget, settle=0): ${(delta * 100).toFixed(1)}% (p50), bootstrap 95% CI [${(ci.lo * 100).toFixed(1)}%, ${(ci.hi * 100).toFixed(1)}%].
- Memory: B peak RSS ≤ A + budget + 32 MiB: ${rssOk}. FD: B ≤ A: ${fdOk}.
- Pass-to-pass A wall p50 spread: ${(passSpread * 100).toFixed(1)}% (per-pass p50s in results.json).

**GATE VERDICT: ${gate ? "GO" : "NO-GO"}** — ≥30% with the full CI above the margin: ${gate}.
`;
await fs.writeFile(new URL("REPORT.md", resultsDir), report);
console.log(`SELECTED ${selected.budgetMiB} MiB; delta ${(delta * 100).toFixed(1)}% CI [${(ci.lo * 100).toFixed(1)}, ${(ci.hi * 100).toFixed(1)}]; GATE VERDICT: ${gate ? "GO" : "NO-GO"}`);
