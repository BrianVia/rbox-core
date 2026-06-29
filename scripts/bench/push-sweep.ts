/**
 * Upload-concurrency sweep for a cold first-push (the dominant felt cost).
 * For each concurrency value: regenerate a FRESH unique-content corpus of fixed
 * shape (so every run is a true cold first-push — blobs genuinely missing), then
 * `rbox push` with RBOX_UPLOAD_CONCURRENCY set, timing the wall clock. Drives the
 * real compiled binary against a real worker (network latency is the whole point —
 * a local/Miniflare run has ~0 latency and would hide the concurrency effect).
 *
 * Usage: bun scripts/bench/push-sweep.ts [--bin <path>] [--shape small] [--remote <url>] [--conc 4,8,16,32,48,64] [--runs 1]
 * Requires: ~/.rbox/credentials.json already enrolled (E2EE) for <remote>.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateCorpus, SHAPES } from "./corpus.js";

const arg = (name: string, dflt: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : dflt;
};

const BIN = arg("bin", "/tmp/rbox-fixed");
const SHAPE = arg("shape", "small");
const REMOTE = arg("remote", process.env.RBOX_API ?? "https://rbox-dev-api.brian-via.workers.dev");
const CONCS = arg("conc", "4,8,16,32,48,64").split(",").map(Number);
const RUNS = Number(arg("runs", "1"));
const BENCH_DIR = path.join(os.homedir(), "code", "bench-ws");
const shape = SHAPES[SHAPE];
if (!shape) throw new Error(`unknown shape ${SHAPE} (have: ${Object.keys(SHAPES).join(", ")})`);

function run(args: string[], env: Record<string, string>): Promise<{ ms: number; stderr: string; code: number }> {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let stderr = "";
    const p = spawn(BIN, args, { cwd: BENCH_DIR, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "pipe"] });
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => resolve({ ms: performance.now() - t0, stderr, code: code ?? -1 }));
  });
}

async function ensureWorkspace(): Promise<void> {
  if (fs.existsSync(path.join(BENCH_DIR, ".rbox", "workspace.json"))) return;
  fs.rmSync(BENCH_DIR, { recursive: true, force: true });
  fs.mkdirSync(BENCH_DIR, { recursive: true });
  fs.writeFileSync(path.join(BENCH_DIR, "README.md"), "rbox bench workspace\n");
  const r = await run(["init", "--new", "--no-interactive", "--remote", REMOTE], {});
  if (r.code !== 0) throw new Error(`bench workspace init failed (${r.code}):\n${r.stderr}`);
  console.error(`[bench] initialized workspace at ${BENCH_DIR}`);
}

const pct = (arr: number[], p: number) => {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};

async function main() {
  await ensureWorkspace();
  console.error(`[bench] push-sweep shape=${SHAPE} (${shape.files} files) remote=${REMOTE} conc=[${CONCS}] runs=${RUNS}`);
  const results: Array<{ conc: number; wallMs: number; blobs: number; filesPerSec: number; blobsPerSec: number }> = [];
  let seed = 1000;
  for (const conc of CONCS) {
    const samples: number[] = [];
    let blobs = 0;
    for (let r = 0; r < RUNS; r++) {
      generateCorpus(BENCH_DIR, shape, seed++); // fresh unique content ⇒ true cold push
      const res = await run(["push"], { RBOX_UPLOAD_CONCURRENCY: String(conc) });
      if (res.code !== 0) {
        console.error(`[bench] conc=${conc} run=${r} FAILED (${res.code}): ${res.stderr.split("\n").slice(-3).join(" ")}`);
        continue;
      }
      const m = [...res.stderr.matchAll(/uploading \d+\/(\d+)/g)].pop();
      blobs = m ? Number(m[1]) : 0;
      samples.push(res.ms);
      console.error(`  conc=${String(conc).padStart(3)} run=${r} ${(res.ms / 1000).toFixed(1)}s  (${blobs} blobs)`);
    }
    if (!samples.length) continue;
    const wallMs = pct(samples, 50);
    results.push({ conc, wallMs, blobs, filesPerSec: Math.round((shape.files / wallMs) * 1000), blobsPerSec: Math.round((blobs / wallMs) * 1000) });
  }

  // table
  console.log(`\nupload-concurrency sweep — cold first-push, shape=${SHAPE} (${shape.files} files), remote=${REMOTE}`);
  console.log(`${"conc".padStart(5)} ${"wall(s)".padStart(9)} ${"blobs".padStart(7)} ${"blobs/s".padStart(9)} ${"files/s".padStart(9)}`);
  for (const r of results) {
    console.log(`${String(r.conc).padStart(5)} ${(r.wallMs / 1000).toFixed(1).padStart(9)} ${String(r.blobs).padStart(7)} ${String(r.blobsPerSec).padStart(9)} ${String(r.filesPerSec).padStart(9)}`);
  }
  const best = [...results].sort((a, b) => a.wallMs - b.wallMs)[0];
  if (best) console.log(`\nfastest: conc=${best.conc} @ ${(best.wallMs / 1000).toFixed(1)}s (${best.blobsPerSec} blobs/s)`);

  const outDir = path.join(process.cwd(), "bench-results");
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, `push-sweep-${SHAPE}.jsonl`);
  fs.appendFileSync(out, JSON.stringify({ shape: SHAPE, files: shape.files, remote: REMOTE, runs: RUNS, results }) + "\n");
  console.error(`[bench] appended ${out}`);
}

main();
