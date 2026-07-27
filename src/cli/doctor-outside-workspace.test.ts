import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { main } from "./main-dispatch.js";
import { daemonRuntimeDir } from "./daemon-control.js";

const oldArgv = process.argv;
const oldCwd = process.cwd();
const oldRboxHome = process.env.RBOX_HOME;
const oldHome = process.env.HOME;
const origLog = console.log;
const origFetch = globalThis.fetch;
let temp: string;
let outside: string;
let logs: string[];

beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-outside-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-cwd-"));
  process.env.RBOX_HOME = temp;
  process.env.HOME = temp;
  process.chdir(outside);
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
  globalThis.fetch = (async () => {
    throw new Error("offline in test");
  }) as typeof fetch;
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = origLog;
  globalThis.fetch = origFetch;
  process.argv = oldArgv;
  process.chdir(oldCwd);
  if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldRboxHome;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  process.exitCode = 0;
  await fs.rm(temp, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

async function seedWorkspaceRecord(name: string): Promise<string> {
  const root = path.join(temp, "workspaces", name);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({ remoteWorkspaceId: `ws_${name}`, projectId: "root", remoteUrl: "https://api.test" }),
  );
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(root), "desired.json"), JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_1",
    workspaceId: `ws_${name}`,
    at: new Date().toISOString(),
  }));
  return root;
}

test("doctor outside a workspace summarizes every synced folder instead of erroring (#498)", async () => {
  const root = await seedWorkspaceRecord("papers");
  process.argv = [process.execPath, "rbox", "doctor"];
  await main();
  const printed = logs.join("\n");
  expect(printed).toContain("1 workspace on this machine");
  expect(printed).toContain(root);
  expect(printed).toContain(`cd ${root} && rbox start`);
});

test("status outside a workspace shows the all-workspaces view (#498, design 211 table)", async () => {
  const root = await seedWorkspaceRecord("papers");
  process.argv = [process.execPath, "rbox", "status"];
  await main();
  const printed = logs.join("\n");
  expect(printed).toContain("1 workspace on this machine");
  expect(printed).toContain(root);
  expect(printed).toContain("WORKSPACE");
});

test("doctor --json outside a workspace emits the machine-scoped payload", async () => {
  const root = await seedWorkspaceRecord("papers");
  const written: string[] = [];
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    process.argv = [process.execPath, "rbox", "doctor", "--json"];
    await main();
  } finally {
    process.stdout.write = origWrite;
  }
  const payload = JSON.parse(written.join("")) as { scope: string; workspaces: Array<{ root: string; command: string }> };
  expect(payload.scope).toBe("machine");
  expect(payload.workspaces[0]!.root).toBe(root);
  expect(payload.workspaces[0]!.command).toContain("rbox");
});

test("the workspace root is an optional positional and --path is an equivalent alias", async () => {
  const root = await seedWorkspaceRecord("papers");
  const capture = async (argv: string[]): Promise<string> => {
    const written: string[] = [];
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    logs = [];
    try {
      process.argv = [process.execPath, "rbox", ...argv];
      await main();
    } finally {
      process.stdout.write = origWrite;
    }
    return written.join("") || logs.join("\n");
  };

  const positional = await capture(["doctor", root, "--json"]);
  const flag = await capture(["doctor", "--path", root, "--json"]);
  expect(positional).toBe(flag);

  // Workspace-scoped, not the machine-wide summary the bare invocation prints.
  const parsed = JSON.parse(positional) as { scope?: string };
  expect(parsed.scope).not.toBe("machine");

  // A positional that is not a workspace fails loudly instead of silently
  // falling back to the machine summary.
  process.argv = [process.execPath, "rbox", "doctor", outside];
  await expect(main()).rejects.toThrow("Not inside an rbox workspace");
});

test("a support report still requires a workspace", async () => {
  process.argv = [process.execPath, "rbox", "doctor", "--report"];
  await expect(main()).rejects.toThrow("Not inside an rbox workspace");
});
