import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INQUIRER_IMPORT_ERROR, TUI_IMPORT_ERROR } from "./guards";

const fixtureRoots: string[] = [];
const dedicatedGitSyncTests = [
  "design 53: fresh join fetch/import work is bounded by repos times MAX_PACK_CHAIN",
  "git artifact sha_mismatch re-encrypts and retries with resumable uploadsDir",
  "D2 apply deferral keeps chronic age across newer truth and resets reason age",
  "pending + 422: failed retries preserve P and all sidecars byte-for-byte",
  "clean materialization with a ref-wiping hook defers before stranding a sibling worktree branch",
];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function put(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function makeFixture(options: { duplicateSplitName?: boolean; missingDedicatedName?: boolean; strayImport?: boolean; hiddenStrayImport?: boolean; strayInk?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbox-guards-"));
  fixtureRoots.push(root);
  const configured = options.missingDedicatedName ? dedicatedGitSyncTests.slice(1) : dedicatedGitSyncTests;
  const ordinary = options.duplicateSplitName ? ["duplicate", "duplicate"] : ["sync one", "sync two"];
  await put(root, "src/cli/sync-git/git-sync.test.ts", [...configured, ...ordinary].map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n"));
  await put(root, "src/cli/e2ee-sync.test.ts", 'test("e2ee transport", () => {});\n');
  await put(root, "src/cli/sync-git/git-nested.test.ts", 'test("nested one", () => {});\n');
  await put(root, "src/cli/prompt.ts", "export const prompt = true;\n");
  await put(root, "src/cli/prompt-ink.tsx", 'import React from "react";\nimport { render } from "ink";\nvoid React; void render;\n');
  if (options.strayImport) {
    await put(root, "src/stray.ts", 'import { input } from "@inquirer/input";\nvoid input;\n');
  }
  if (options.hiddenStrayImport) {
    await put(root, "src/.hidden/stray.ts", 'import { input } from "@inquirer/input";\nvoid input;\n');
  }
  if (options.strayInk) await put(root, "src/stray-ink.ts", 'import { Text } from "ink";\nvoid Text;\n');
  return root;
}

async function runSharderFixture(root: string, command: "guard" | "plan", shardCount: number): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const processHandle = Bun.spawn([
    process.execPath,
    join(import.meta.dir, "ci-shard-tests.ts"),
    command,
    "--shard-count",
    String(shardCount),
  ], { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function runFixture(root: string): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const processHandle = Bun.spawn([process.execPath, join(import.meta.dir, "guards.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

describe("repository guards", () => {
  test("accepts a clean synthetic tree", async () => {
    const result = await runFixture(await makeFixture());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("runtime units covered across 6 shards");
    expect(result.stdout).toContain("@inquirer forbidden");
    expect(result.stderr).toBe("");
  });

  test("rejects every @inquirer import with the CI error", async () => {
    const result = await runFixture(await makeFixture({ strayImport: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('src/stray.ts:1:import { input } from "@inquirer/input";');
    expect(result.stderr).toContain(INQUIRER_IMPORT_ERROR);
  });

  test("rejects Ink outside the shared runtime", async () => {
    const result = await runFixture(await makeFixture({ strayInk: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('src/stray-ink.ts:1:import { Text } from "ink";');
    expect(result.stderr).toContain(TUI_IMPORT_ERROR);
  });

  test("rejects ink subpath imports and raw-key readers outside the runtime", async () => {
    const root = await makeFixture();
    await put(root, "src/stray-subpath.ts", 'const ink = await import("ink/build/index.js");\nvoid ink;\n');
    await put(root, "src/stray-rawkey.ts", 'import * as readline from "node:readline";\nreadline.emitKeypressEvents(process.stdin);\n');
    const result = await runFixture(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain("src/stray-subpath.ts:1:");
    expect(result.stdout).toContain("src/stray-rawkey.ts:2:");
    expect(result.stderr).toContain(TUI_IMPORT_ERROR);
  });

  test("checks hidden src paths like the original recursive grep", async () => {
    const result = await runFixture(await makeFixture({ hiddenStrayImport: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('src/.hidden/stray.ts:1:import { input } from "@inquirer/input";');
    expect(result.stderr).toContain(INQUIRER_IMPORT_ERROR);
  });

  test("propagates shard coverage failures", async () => {
    const result = await runFixture(await makeFixture({ duplicateSplitName: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("split coverage errors:");
    expect(result.stderr).toContain("missing 0, duplicate 1");
  });

  test("spreads configured process-heavy families deterministically", async () => {
    const root = await makeFixture();
    const first = await runSharderFixture(root, "plan", 6);
    const second = await runSharderFixture(root, "plan", 6);
    expect(first.exitCode).toBe(0);
    expect(second).toEqual(first);

    const shardByName = new Map<string, string>();
    let shard = "";
    for (const line of first.stdout.split("\n")) {
      if (line.startsWith("shard ")) shard = line.split(":", 1)[0]!;
      for (const name of dedicatedGitSyncTests) {
        if (line.includes(`#dedicated:${name}`)) shardByName.set(name, shard);
      }
      if (line.trimStart().startsWith("src/cli/e2ee-sync.test.ts ")) shardByName.set("e2ee-sync", shard);
    }
    expect(shardByName.size).toBe(dedicatedGitSyncTests.length + 1);
    expect(new Set(shardByName.values()).size).toBe(dedicatedGitSyncTests.length + 1);
  });

  test("rejects a stale configured dedicated test name", async () => {
    const result = await runSharderFixture(await makeFixture({ missingDedicatedName: true }), "guard", 6);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("dedicated test must be discovered exactly once:");
    expect(result.stderr).toContain("fresh join fetch/import work");
    expect(result.stderr).toContain("(found 0)");
  });

  test("rejects an anti-affinity group larger than the shard count", async () => {
    const result = await runSharderFixture(await makeFixture(), "guard", 4);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("anti-affinity group git-sync-process exceeds 4 shards");
  });
});
