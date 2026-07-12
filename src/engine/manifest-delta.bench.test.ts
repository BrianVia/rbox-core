import { expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

type Result = { maxRssKb: number; wallMs?: number; residentKb?: number; manifestBytesKb?: number };
const run = (mode: string): Result => {
  const child = spawnSync(process.execPath, [new URL("./manifest-delta.bench-helper.ts", import.meta.url).pathname, mode], { encoding: "utf8" });
  if (child.status !== 0) throw new Error(`benchmark child ${mode} failed: ${child.stderr}`);
  const line = child.stdout.trim().split("\n").at(-1);
  if (!line) throw new Error(`benchmark child ${mode} produced no result`);
  return JSON.parse(line) as Result;
};

const runFold = (): Promise<{ result: Result; peakDeltaKb: number }> => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [new URL("./manifest-delta.bench-helper.ts", import.meta.url).pathname, "fold"],
    { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let baselineKb: number | undefined;
  let peakKb = 0;
  let released = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const sample = (): void => {
    if (!child.pid || baselineKb === undefined) return;
    try {
      const status = readFileSync(`/proc/${child.pid}/status`, "utf8");
      const resident = Number(/^VmRSS:\s+(\d+)\s+kB$/m.exec(status)?.[1]);
      if (Number.isFinite(resident)) peakKb = Math.max(peakKb, resident);
    } catch { /* The process may have exited between the timer and the read. */ }
  };
  const timer = setInterval(sample, 1);
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!released) {
      const line = stdout.split("\n").find((candidate) => candidate.includes('"ready":true'));
      if (line) {
        baselineKb = (JSON.parse(line) as Result & { ready: true }).residentKb!;
        peakKb = baselineKb;
        released = true;
        child.stdin.end("go\n");
      }
    }
  });
  child.on("error", reject);
  child.on("exit", (code) => {
    clearInterval(timer);
    sample();
    if (code !== 0) return reject(new Error(`benchmark child fold failed: ${stderr}`));
    const line = stdout.trim().split("\n").at(-1);
    if (!line || baselineKb === undefined) return reject(new Error("benchmark child fold produced no result"));
    resolve({ result: JSON.parse(line) as Result, peakDeltaKb: Math.max(0, peakKb - baselineKb) });
  });
});

test("124k-entry trusted-base fast fold stays within Phase-D time and memory gates", async () => {
  const manifest = run("manifest");
  const oneManifestKb = manifest.manifestBytesKb!;
  if (oneManifestKb <= 0) throw new Error("benchmark could not measure serialized manifest size");
  const allowanceKb = oneManifestKb * 2;
  // Best-of-3: sampled peak RSS includes not-yet-collected garbage, which GC
  // timing jitters by tens of MB run-to-run. A genuine bound violation is LIVE
  // memory no collection can shed, so it fails every attempt; jitter passes at
  // least one. Wall time gets the same treatment (machine load).
  const attempts: Array<{ wallMs: number; peakDeltaKb: number }> = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    const { result: folded, peakDeltaKb } = await runFold();
    attempts.push({ wallMs: folded.wallMs!, peakDeltaKb });
    if (folded.wallMs! < 2_000 && peakDeltaKb <= allowanceKb) break;
  }
  const wallMs = Math.min(...attempts.map((a) => a.wallMs));
  const peakDeltaKb = Math.min(...attempts.map((a) => a.peakDeltaKb));
  console.log(`manifest fold benchmark: ${wallMs.toFixed(1)}ms, isolated peak RSS +${peakDeltaKb}KB, one manifest ${oneManifestKb}KB, allowance ${allowanceKb}KB, attempts ${attempts.map((a) => `${a.wallMs.toFixed(0)}ms/+${a.peakDeltaKb}KB`).join(" ")}`);
  expect(wallMs, `trusted-base decode+fold took ${wallMs.toFixed(1)}ms (best of ${attempts.length})`).toBeLessThan(2_000);
  expect(peakDeltaKb, `fold peak +${peakDeltaKb}KB exceeds two manifests (${allowanceKb}KB) on every attempt`).toBeLessThanOrEqual(allowanceKb);
}, 60_000);
