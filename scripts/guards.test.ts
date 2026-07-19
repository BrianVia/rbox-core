import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INQUIRER_IMPORT_ERROR } from "./guards";

const fixtureRoots: string[] = [];
const dedicatedGitSyncTests = [
  "design 53: fresh join fetch/import work is bounded by repos times MAX_PACK_CHAIN",
  "git artifact sha_mismatch re-encrypts and retries with resumable uploadsDir",
  "D2 apply deferral keeps chronic age across newer truth and resets reason age",
  "pending + 422: M5 non-looping drop — section dropped from THIS commit, pending kept for the next pull [v6]",
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

async function makeFixture(options: { duplicateSplitName?: boolean; missingDedicatedName?: boolean; strayImport?: boolean; hiddenStrayImport?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbox-guards-"));
  fixtureRoots.push(root);
  const configured = options.missingDedicatedName ? dedicatedGitSyncTests.slice(1) : dedicatedGitSyncTests;
  const ordinary = options.duplicateSplitName ? ["duplicate", "duplicate"] : ["sync one", "sync two"];
  await put(root, "src/cli/sync-git/git-sync.test.ts", [...configured, ...ordinary].map((name) => `test(${JSON.stringify(name)}, () => {});`).join("\n"));
  await put(root, "src/engine/git-nested.test.ts", 'test("nested one", () => {});\n');
  await put(root, "src/cli/prompt.ts", 'import { select } from "@inquirer/prompts";\nvoid select;\n');
  if (options.strayImport) {
    await put(root, "src/stray.ts", 'import { input } from "@inquirer/input";\nvoid input;\n');
  }
  if (options.hiddenStrayImport) {
    await put(root, "src/.hidden/stray.ts", 'import { input } from "@inquirer/input";\nvoid input;\n');
  }
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
    expect(result.stdout).toContain("only src/cli/prompt.ts may import @inquirer");
    expect(result.stderr).toBe("");
  });

  test("rejects an @inquirer import outside prompt.ts with the CI error", async () => {
    const result = await runFixture(await makeFixture({ strayImport: true }));
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toContain('src/stray.ts:1:import { input } from "@inquirer/input";');
    expect(result.stderr).toContain(INQUIRER_IMPORT_ERROR);
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

  test("spreads configured git-sync process-heavy tests deterministically", async () => {
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
    }
    expect(shardByName.size).toBe(dedicatedGitSyncTests.length);
    expect(new Set(shardByName.values()).size).toBe(dedicatedGitSyncTests.length);
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
