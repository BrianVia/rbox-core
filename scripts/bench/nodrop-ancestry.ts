import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { setGitSpawnObserver } from "../../src/engine/git-spawn.js";
import { legacyNoDropProofForTest, noDropProof } from "../../src/cli/sync-git/reachability.js";

const exec = promisify(execFile);
const WARMUPS = 5;
const SAMPLES = 20;
const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-nodrop-bench-"));
const env = {
  ...process.env,
  GIT_AUTHOR_NAME: "no-drop bench",
  GIT_AUTHOR_EMAIL: "no-drop-bench@invalid",
  GIT_COMMITTER_NAME: "no-drop bench",
  GIT_COMMITTER_EMAIL: "no-drop-bench@invalid",
};

async function git(...args: string[]): Promise<string> {
  return (await exec("git", ["-C", root, ...args], { env })).stdout.toString().trim();
}

function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

async function measure(run: () => Promise<unknown>): Promise<{ p50: number; p95: number; spawns: number }> {
  for (let index = 0; index < WARMUPS; index++) await run();
  const elapsed: number[] = [];
  for (let index = 0; index < SAMPLES; index++) {
    const started = performance.now();
    await run();
    elapsed.push(performance.now() - started);
  }
  let spawns = 0;
  setGitSpawnObserver(() => { spawns++; });
  try { await run(); } finally { setGitSpawnObserver(undefined); }
  return { p50: percentile(elapsed, 0.5), p95: percentile(elapsed, 0.95), spawns };
}

try {
  await git("init", "-qb", "main");
  await fs.writeFile(path.join(root, "base.txt"), "base\n");
  await git("add", "base.txt");
  await git("commit", "-qm", "base");
  const tip = await git("rev-parse", "HEAD");
  const roots = Array.from({ length: 5 }, () => tip);

  console.log(`warmups=${WARMUPS} samples=${SAMPLES} roots=${roots.length}`);
  for (const count of [30, 500]) {
    const tips = Array.from({ length: count }, () => tip);
    const legacy = await measure(() => legacyNoDropProofForTest(root, roots, [], [], tips));
    const batched = await measure(() => noDropProof(root, roots, [], [], tips));
    console.log(
      `${count} tips | legacy p50=${legacy.p50.toFixed(2)}ms p95=${legacy.p95.toFixed(2)}ms spawns=${legacy.spawns}`
      + ` | batched p50=${batched.p50.toFixed(2)}ms p95=${batched.p95.toFixed(2)}ms spawns=${batched.spawns}`,
    );
  }
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
