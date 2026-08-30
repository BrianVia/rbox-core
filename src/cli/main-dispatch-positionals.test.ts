import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { extraPositionalError } from "./flags.js";
import { main } from "./main-dispatch.js";

const oldArgv = process.argv;
const oldRboxHome = process.env.RBOX_HOME;
const oldStderrWrite = process.stderr.write;
const oldExitCode = process.exitCode;
let stderr = "";
let temp: string;

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-positionals-dispatch-"));
  process.env.RBOX_HOME = temp;
  process.exitCode = 0;
  stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
});

afterEach(async () => {
  process.argv = oldArgv;
  process.stderr.write = oldStderrWrite;
  process.exitCode = oldExitCode ?? 0;
  if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldRboxHome;
  await fs.rm(temp, { recursive: true, force: true });
});

const noHealthRefresh = { refreshSystemLockIdentityLedger: async () => {} };

async function expectRejected(argv: string[], unexpected: string, command: string): Promise<void> {
  process.argv = [process.execPath, "rbox", ...argv];
  await main(noHealthRefresh);
  expect(process.exitCode).toBe(1);
  expect(stderr).toContain(`unexpected argument "${unexpected}"`);
  expect(stderr).toContain(`rbox ${command}`);
}

test("export rejects an ignored path instead of exporting the cwd workspace", async () => {
  await expectRejected(["export", "~/code/myapp"], "~/code/myapp", "export");
  expect(stderr).toContain("usage: rbox export");
  expect(await fs.readdir(temp)).toEqual([]);
});

test("zero-positional commands reject an extra path or token", async () => {
  for (const [command, extra] of [
    ["setup", "~/code/myapp"],
    ["init", "~/code/myapp"],
    ["usage", "x"],
    ["billing", "x"],
    ["logout", "x"],
    ["upgrade", "x"],
  ] as const) {
    stderr = "";
    process.exitCode = 0;
    await expectRejected([command, extra], extra, command);
  }
});

test("single-positional commands name the first surplus argument", async () => {
  for (const [command, args, extra] of [
    ["stop", ["/a", "/b"], "/b"],
    ["logs", ["a", "b"], "b"],
    ["versions", ["a", "b"], "b"],
    ["push", ["a", "b"], "b"],
    ["pull", ["a", "b"], "b"],
    ["sync", ["a", "b"], "b"],
  ] as const) {
    stderr = "";
    process.exitCode = 0;
    await expectRejected([command, ...args], extra, command);
  }
});

test("a command token that routes nowhere exits non-zero (bare/unknown `daemon` alias)", async () => {
  for (const argv of [["daemon"], ["daemon", "bogus"], ["not-a-command"]]) {
    stderr = "";
    process.exitCode = 0;
    process.argv = [process.execPath, "rbox", ...argv];
    await main(noHealthRefresh);
    expect(process.exitCode, `rbox ${argv.join(" ")}`).toBe(1);
  }
});

test("declared positional capacities preserve accepted forms", () => {
  for (const [command, positional] of [
    ["status", []],
    ["status", ["<path>"]],
    ["key", ["revoke", "<id>"]],
    ["trash", ["restore", "<path>"]],
    ["git", ["resolve", "<repo>", "keep-mine"]],
    ["config", ["add", "<path>"]],
    ["include", ["add", "a", "b", "c"]],
    ["doctor", ["reset-journal", "<path>"]],
  ] as const) {
    expect(extraPositionalError(command, [...positional]), `rbox ${command} ${positional.join(" ")}`).toBeUndefined();
  }
});
