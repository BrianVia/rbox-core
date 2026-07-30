/**
 * The M0–M7 migration duration baseline (design 222 §7.5: "Migration duration:
 * M0–M7 ≤ 60 s on corpus-112k"; "any phase over 5 s prints progress").
 *
 * Why a synthetic corpus. The only real datum we have — 81 MB / 145,913 entries
 * / 101 repos at 38 s — comes from a founder-fleet workspace snapshot, and a
 * real-data snapshot must stay out of the repo. So the checked-in, comparable
 * number is measured on a NAMED, SEEDED, deterministic legacy state document
 * that this script generates, and the real datum is carried alongside it in
 * `migration-baseline.json` as a labelled reference row that nothing here can
 * check.
 *
 * This is a MANUAL gate, deliberately. A wall-clock assertion in CI measures the
 * runner, not the migration; it flakes, gets muted, and then guards nothing. The
 * gate is the recorded baseline plus this script: run it, read the comparison,
 * and `--update` when a change to the numbers is intended and explained.
 *
 * usage:
 *   bun scripts/bench/migration-baseline.ts                # compare
 *   bun scripts/bench/migration-baseline.ts --samples 9
 *   bun scripts/bench/migration-baseline.ts --update       # rewrite the baseline
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { saveStateUnsafeLegacyOrTest } from "../../src/cli/state-plane/adapters/legacy-json-store.js";
import { withStatePlaneLocks } from "../../src/cli/state-plane/locks.js";
import { runMigration } from "../../src/cli/state-plane/migration/authority.js";
import { sqliteResetPaths } from "../../src/cli/state-plane/paths.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../src/cli/workspace-config.js";

export const BASELINE_FILE = path.join(import.meta.dir, "migration-baseline.json");

/** The checked-in corpus. Named and seeded, so two hosts measure the same work.
 * Sized to be honest about per-entry cost while staying runnable in a dev loop;
 * the 60 s design bound is stated against corpus-112k and is carried in the
 * baseline as the bound, not as this corpus's expectation. */
export const BENCH_CORPUS = { name: "synthetic-20k", entries: 20_000, repos: 40, seed: 222_075 } as const;

export interface Summary { p50Ms: number; p95Ms: number; samples: number }

/** mulberry32, as `corpus.ts` uses: same seed → byte-identical document. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function corpusFiles(corpus: typeof BENCH_CORPUS): unknown[] {
  const next = rng(corpus.seed);
  return Array.from({ length: corpus.entries }, (_, i) => {
    const repo = i % corpus.repos;
    const depth = 1 + Math.floor(next() * 4);
    const dirs = Array.from({ length: depth }, (_, d) => `d${(i >> (d * 2)) % 16}`).join("/");
    return {
      path: `repo-${repo}/${dirs}/file-${i}.txt`,
      sha256: createHash("sha256").update(`${corpus.seed}:${i}`).digest("hex"),
      size: 24 + Math.floor(next() * 65_512),
      mode: 0o644,
      mtimeMs: 1_700_000_000_000 + i,
      type: "file" as const,
    };
  });
}

/** One migration, on a workspace built fresh so nothing is warm from the last
 * sample. Returns the total and the per-phase wall time the driver reported. */
async function sample(corpus: typeof BENCH_CORPUS): Promise<{ totalMs: number; phases: Map<string, number> }> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-mig-bench-home-"));
  const previousHome = process.env.RBOX_HOME;
  process.env.RBOX_HOME = home;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-mig-bench-ws-"));
  try {
    const config: WorkspaceConfig = {
      schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
      rootPath: root, remoteUrl: "https://example.invalid", token: "",
    };
    await saveConfig(root, config);
    fs.mkdirSync(sqliteResetPaths.stateRoot(root), { recursive: true });
    await saveStateUnsafeLegacyOrTest(root, {
      stream: syncStreamId(config),
      lastSyncedSequence: 0,
      lastSyncedManifest: { generatedAt: "", files: corpusFiles(corpus) },
    } as never);

    const phases = new Map<string, number>();
    let current = "start";
    let mark = performance.now();
    const startedAt = mark;
    const outcome = await withStatePlaneLocks(root, (locks) =>
      runMigration(root, { entry: "foreground-migrate", locks }, (progress) => {
        const now = performance.now();
        phases.set(current, (phases.get(current) ?? 0) + (now - mark));
        current = progress.phase;
        mark = now;
      }));
    const finishedAt = performance.now();
    phases.set(current, (phases.get(current) ?? 0) + (finishedAt - mark));
    if (!outcome.held) throw new Error(`the lock bundle refused: ${outcome.refusal.code}`);
    if (outcome.value.kind !== "migrated") {
      throw new Error(`migration did not complete: ${JSON.stringify(outcome.value).slice(0, 300)}`);
    }
    return { totalMs: finishedAt - startedAt, phases };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.RBOX_HOME;
    else process.env.RBOX_HOME = previousHome;
  }
}

export function summarize(values: number[]): Summary {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { p50Ms: round(at(0.5)), p95Ms: round(at(0.95)), samples: sorted.length };
}

const round = (ms: number): number => Math.round(ms * 10) / 10;

async function measure(samples: number): Promise<{ total: Summary; phases: Record<string, Summary> }> {
  await sample(BENCH_CORPUS); // one warmup, discarded
  const totals: number[] = [];
  const perPhase = new Map<string, number[]>();
  for (let i = 0; i < samples; i += 1) {
    const run = await sample(BENCH_CORPUS);
    totals.push(run.totalMs);
    for (const [phase, ms] of run.phases) perPhase.set(phase, [...(perPhase.get(phase) ?? []), ms]);
  }
  const phases: Record<string, Summary> = {};
  for (const phase of [...perPhase.keys()].sort()) phases[phase] = summarize(perPhase.get(phase) ?? []);
  return { total: summarize(totals), phases };
}

/* ---------------------------------------------------------------- the file */

export interface Baseline {
  version: 1;
  /** §7.5's hard bound, in seconds, on corpus-112k. Recorded, never measured
   * here: this corpus is not corpus-112k. */
  designBoundSecondsOnCorpus112k: number;
  /** A comparison fails when a measured p50/p95 exceeds the recorded one by
   * more than this factor. Wide on purpose — this catches an order-of-magnitude
   * regression, not host-to-host noise. */
  toleranceRatio: number;
  corpus: { name: string; entries: number; repos: number; seed: number };
  measuredAt: string;
  host: string;
  total: Summary;
  phases: Record<string, Summary>;
  /** OUT-OF-REPO REFERENCE DATUM. Measured on a real founder-fleet workspace
   * whose snapshot cannot be checked in, so nothing in this repo can reproduce
   * or verify it. It is here because it is the only real-corpus evidence for
   * the §7.5 bound; treat it as a recorded observation, not as a gate. */
  referenceCorpus: {
    label: string;
    bytes: number;
    entries: number;
    repos: number;
    durationSeconds: number;
    measuredAt: string;
    machineCheckable: false;
    note: string;
  };
}

export function readBaseline(file = BASELINE_FILE): Baseline {
  return JSON.parse(fs.readFileSync(file, "utf8")) as Baseline;
}

function compare(baseline: Baseline, measured: { total: Summary; phases: Record<string, Summary> }): boolean {
  const rows: string[] = [];
  let ok = true;
  const check = (label: string, recorded: Summary | undefined, now: Summary): void => {
    if (!recorded) {
      rows.push(`  ${label.padEnd(10)} ${fmt(now)}   (not in the baseline)`);
      return;
    }
    const worst = Math.max(now.p50Ms / (recorded.p50Ms || 1), now.p95Ms / (recorded.p95Ms || 1));
    const verdict = worst <= baseline.toleranceRatio ? "ok" : "REGRESSED";
    if (verdict !== "ok") ok = false;
    rows.push(`  ${label.padEnd(10)} ${fmt(now)}  was ${fmt(recorded)}  x${worst.toFixed(2)}  ${verdict}`);
  };
  check("TOTAL", baseline.total, measured.total);
  for (const [phase, summary] of Object.entries(measured.phases)) check(phase, baseline.phases[phase], summary);
  console.log(rows.join("\n"));
  const bound = baseline.designBoundSecondsOnCorpus112k * 1000;
  console.log(`\n§7.5 bound (corpus-112k, not this corpus): ${bound} ms`);
  console.log(`reference corpus: ${baseline.referenceCorpus.label} at ${baseline.referenceCorpus.durationSeconds}s`
    + ` — recorded ${baseline.referenceCorpus.measuredAt}, not machine-checkable here`);
  return ok;
}

const fmt = (s: Summary): string => `p50=${String(s.p50Ms).padStart(8)}ms p95=${String(s.p95Ms).padStart(8)}ms`;

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const update = argv.includes("--update");
  const samplesArg = argv.indexOf("--samples");
  const samples = samplesArg === -1 ? 5 : Number(argv[samplesArg + 1]);
  if (!Number.isSafeInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");

  console.log(`corpus ${BENCH_CORPUS.name}: ${BENCH_CORPUS.entries} entries / ${BENCH_CORPUS.repos} repos`
    + `, ${samples} samples after 1 warmup\n`);
  const measured = await measure(samples);

  if (update) {
    const previous = readBaseline();
    const next: Baseline = {
      ...previous,
      corpus: { ...BENCH_CORPUS },
      measuredAt: new Date().toISOString().slice(0, 10),
      host: `${os.platform()}-${os.arch()}`,
      total: measured.total,
      phases: measured.phases,
    };
    fs.writeFileSync(BASELINE_FILE, `${JSON.stringify(next, null, 2)}\n`);
    console.log(`wrote ${BASELINE_FILE}\n  TOTAL ${fmt(measured.total)}`);
  } else if (!compare(readBaseline(), measured)) {
    process.exitCode = 1;
  }
}

