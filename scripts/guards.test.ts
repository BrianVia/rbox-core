import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { INQUIRER_IMPORT_ERROR } from "./guards";

const fixtureRoots: string[] = [];

afterEach(async () => {
  await Promise.all(fixtureRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function put(root: string, relativePath: string, contents: string): Promise<void> {
  const target = join(root, relativePath);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, contents);
}

async function makeFixture(options: { duplicateSplitName?: boolean; strayImport?: boolean; hiddenStrayImport?: boolean } = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rbox-guards-"));
  fixtureRoots.push(root);
  await put(root, "src/cli/sync-git/git-sync.test.ts", options.duplicateSplitName
    ? 'test("duplicate", () => {});\ntest("duplicate", () => {});\n'
    : 'test("sync one", () => {});\ntest("sync two", () => {});\n');
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
});
