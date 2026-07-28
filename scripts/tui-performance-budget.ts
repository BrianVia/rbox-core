#!/usr/bin/env bun
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { resolveRigBinaryPaths } from "./rig/lib/binary.js";

interface Sample {
  wallMs: number;
  rssBytes: number;
}

const workloads = [
  { name: "status", args: ["status"], expectedExit: 0 },
  { name: "status-json", args: ["status", "--json"], expectedExit: 0 },
  { name: "prompt-status", args: ["prompt-status"], expectedExit: 0 },
  { name: "daemon-startup-selftest", args: ["__watcher-selftest"], expectedExit: 0 },
] as const;

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)]!;
}

function measure(binary: string, cwd: string, args: readonly string[], expectedExit: number): Sample {
  const isDarwin = process.platform === "darwin";
  const timeArgs = isDarwin ? ["-l"] : ["-v"];
  const started = performance.now();
  const result = Bun.spawnSync(["/usr/bin/time", ...timeArgs, binary, ...args], {
    cwd,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: cwd,
      RBOX_HOME: cwd,
      RBOX_ASSERT_INK_NOT_LOADED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const wallMs = performance.now() - started;
  if (result.exitCode !== expectedExit || result.stderr.toString().includes("Ink runtime loaded during a non-interactive command")) {
    throw new Error(`${path.basename(binary)} ${args.join(" ")} exited ${result.exitCode}, expected ${expectedExit}\n${result.stderr.toString()}`);
  }
  const timing = result.stderr.toString();
  const match = isDarwin
    ? timing.match(/^\s*(\d+)\s+maximum resident set size$/m)
    : timing.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
  if (!match) throw new Error(`could not read peak RSS from /usr/bin/time output\n${timing}`);
  return { wallMs, rssBytes: Number(match[1]) * (isDarwin ? 1 : 1024) };
}

const baselineArg = process.argv[2];
const candidateArg = process.argv[3];
const baseline = resolveRigBinaryPaths(baselineArg === undefined ? {} : { binary: baselineArg }).a;
const candidate = resolveRigBinaryPaths(candidateArg === undefined ? {} : { binary: candidateArg }).a;
if (!baseline || !candidate || process.argv.length !== 4) {
  throw new Error("usage: bun scripts/tui-performance-budget.ts /absolute/baseline/rbox /absolute/candidate/rbox");
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-tui-budget-"));
const baselineHome = path.join(root, "baseline");
const candidateHome = path.join(root, "candidate");
fs.mkdirSync(baselineHome);
fs.mkdirSync(candidateHome);

try {
  const sizeDelta = fs.statSync(candidate).size - fs.statSync(baseline).size;
  if (sizeDelta > 15 * 1024 * 1024) {
    throw new Error(`binary grew ${(sizeDelta / 1024 / 1024).toFixed(2)} MiB (budget: 15 MiB)`);
  }

  const report: Record<string, unknown> = {
    baseline,
    candidate,
    binarySize: {
      baseline: fs.statSync(baseline).size,
      candidate: fs.statSync(candidate).size,
      delta: sizeDelta,
    },
    workloads: {},
  };
  const failures: string[] = [];
  const isolatedBaseline = path.join(baselineHome, "rbox");
  const isolatedCandidate = path.join(candidateHome, "rbox");
  fs.copyFileSync(baseline, isolatedBaseline);
  fs.copyFileSync(candidate, isolatedCandidate);
  fs.chmodSync(isolatedBaseline, 0o755);
  fs.chmodSync(isolatedCandidate, 0o755);

  for (const workload of workloads) {
    for (let iteration = 0; iteration < 5; iteration++) {
      measure(isolatedBaseline, baselineHome, workload.args, workload.expectedExit);
      measure(isolatedCandidate, candidateHome, workload.args, workload.expectedExit);
    }
    const baselineSamples: Sample[] = [];
    const candidateSamples: Sample[] = [];
    for (let iteration = 0; iteration < 30; iteration++) {
      const first = iteration % 2 === 0
        ? [[isolatedBaseline, baselineHome, baselineSamples], [isolatedCandidate, candidateHome, candidateSamples]] as const
        : [[isolatedCandidate, candidateHome, candidateSamples], [isolatedBaseline, baselineHome, baselineSamples]] as const;
      for (const [binary, cwd, samples] of first) samples.push(measure(binary, cwd, workload.args, workload.expectedExit));
    }

    const summarize = (samples: Sample[]) => ({
      wallP50Ms: percentile(samples.map((sample) => sample.wallMs), 0.5),
      wallP95Ms: percentile(samples.map((sample) => sample.wallMs), 0.95),
      peakRssBytes: Math.max(...samples.map((sample) => sample.rssBytes)),
    });
    const baselineSummary = summarize(baselineSamples);
    const candidateSummary = summarize(candidateSamples);
    // Gate on the MEDIAN: shared CI runners throw multi-hundred-ms scheduler
    // spikes, and a p95 of 30 interleaved samples fails on two unlucky ones
    // (observed: identical binaries passing one run and failing the next).
    // p95 stays in the report for humans; the median catches real regressions.
    const wallLimit = Math.max(baselineSummary.wallP50Ms * 1.2, baselineSummary.wallP50Ms + 10);
    const rssLimit = Math.max(baselineSummary.peakRssBytes * 1.1, baselineSummary.peakRssBytes + 2 * 1024 * 1024);
    if (candidateSummary.wallP50Ms > wallLimit) {
      failures.push(`${workload.name} p50 ${candidateSummary.wallP50Ms.toFixed(2)}ms > ${wallLimit.toFixed(2)}ms`);
    }
    if (candidateSummary.peakRssBytes > rssLimit) {
      failures.push(`${workload.name} RSS ${candidateSummary.peakRssBytes} > ${Math.floor(rssLimit)}`);
    }
    (report.workloads as Record<string, unknown>)[workload.name] = {
      baseline: baselineSummary,
      candidate: candidateSummary,
      limits: { wallP95Ms: wallLimit, peakRssBytes: rssLimit },
    };
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (failures.length > 0) throw new Error(`TUI performance budget failed:\n- ${failures.join("\n- ")}`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
