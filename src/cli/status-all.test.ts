/**
 * `rbox status --all` / `rbox doctor --all` end to end through the dispatcher
 * (design 211): registry-sourced enumeration, the PATH mutual exclusion, the
 * JSON form, and the convergence a plain in-workspace command performs.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { main } from "./main-dispatch.js";
import { readPersistedEntries, rememberBinding } from "./binding-registry.js";
import { daemonRuntimeDir } from "./rbox-paths.js";

const oldArgv = process.argv;
const oldCwd = process.cwd();
const oldRboxHome = process.env.RBOX_HOME;
const oldHome = process.env.HOME;
const origLog = console.log;
const origWrite = process.stdout.write.bind(process.stdout);
const origFetch = globalThis.fetch;

let home: string;
let outside: string;
let logs: string[];
let stdout: string[];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-status-all-home-"));
  outside = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-status-all-cwd-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  process.chdir(outside);
  logs = [];
  stdout = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  globalThis.fetch = (async () => {
    throw new Error("offline in test");
  }) as typeof fetch;
  process.exitCode = 0;
});

afterEach(async () => {
  console.log = origLog;
  process.stdout.write = origWrite;
  globalThis.fetch = origFetch;
  process.argv = oldArgv;
  process.chdir(oldCwd);
  if (oldRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = oldRboxHome;
  if (oldHome === undefined) delete process.env.HOME;
  else process.env.HOME = oldHome;
  process.exitCode = 0;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

/** A workspace bound with `rbox track` and never started: no daemon record at
 * all, which is exactly what the pre-registry machine view could not see. */
async function trackOnlyWorkspace(name: string, workspaceName?: string): Promise<string> {
  const root = path.join(home, "workspaces", name);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: `ws_${name}`,
    projectId: "root",
    remoteUrl: "https://api.test",
    ...(workspaceName ? { name: workspaceName } : {}),
  }));
  await rememberBinding(root, { remoteWorkspaceId: `ws_${name}`, ...(workspaceName ? { name: workspaceName } : {}) });
  return root;
}

const run = async (...argv: string[]): Promise<void> => {
  process.argv = [process.execPath, "rbox", ...argv];
  await main();
};

test("status --all lists a track-only workspace the daemon records never knew about", async () => {
  const root = await trackOnlyWorkspace("papers", "Papers");
  // Proof the old enumeration source is empty: no daemon runtime dir exists.
  await expect(fs.stat(daemonRuntimeDir(root))).rejects.toThrow();

  await run("status", "--all");
  const printed = logs.join("\n");
  expect(printed).toContain("1 workspace on this machine");
  expect(printed).toContain("Papers");
  expect(printed).toContain(root);
  expect(printed).toContain("WORKSPACE");
});

test("status --all reports a vanished root as a stale binding rather than dropping it", async () => {
  const root = await trackOnlyWorkspace("archive", "Archive");
  await fs.rm(root, { recursive: true, force: true });

  await run("status", "--all");
  const printed = logs.join("\n");
  expect(printed).toContain("Archive");
  expect(printed).toContain("root gone");
  expect(printed).toContain("needs attention");
});

test("status --all and a PATH are mutually exclusive", async () => {
  const root = await trackOnlyWorkspace("papers");
  await expect(run("status", "--all", root)).rejects.toThrow(/cannot be combined with a path/);
});

test("doctor --all and a --path are mutually exclusive", async () => {
  const root = await trackOnlyWorkspace("papers");
  await expect(run("doctor", "--all", "--path", root)).rejects.toThrow(/cannot be combined with a path/);
});

test("doctor --all refuses the workspace-scoped support report", async () => {
  await trackOnlyWorkspace("papers");
  await expect(run("doctor", "--all", "--report")).rejects.toThrow(/workspace-scoped/);
});

test("status --all --json emits the machine-scoped payload with the design 211 fields", async () => {
  const root = await trackOnlyWorkspace("papers", "Papers");
  await run("status", "--all", "--json");
  const payload = JSON.parse(stdout.join(""));
  expect(payload.schemaVersion).toBe(1);
  expect(payload.scope).toBe("machine");
  expect(payload.workspaces).toHaveLength(1);
  expect(payload.workspaces[0]).toMatchObject({
    root,
    name: "Papers",
    binding: "bound",
    state: "stopped",
    daemonRunning: false,
  });
});

test("doctor --all works from anywhere and uses the findings renderer", async () => {
  await trackOnlyWorkspace("papers", "Papers");
  await run("doctor", "--all");
  const printed = logs.join("\n");
  expect(printed).toContain("rbox doctor");
  expect(printed).toContain("1 workspace on this machine");
  expect(printed).toContain("rbox start");
});

test("an in-workspace command converges a binding no bind path ever registered", async () => {
  // Simulate a workspace bound by an older binary: config on disk, registry empty.
  const root = path.join(home, "workspaces", "legacy");
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: "ws_legacy",
    projectId: "root",
    remoteUrl: "https://api.test",
    name: "Legacy",
  }));
  expect(await readPersistedEntries()).toEqual([]);

  process.chdir(root);
  await run("status", "--json").catch(() => undefined);

  expect(await readPersistedEntries()).toMatchObject([{ root, workspaceId: "ws_legacy", name: "Legacy" }]);
});

test("untrack forgets a registered root whose binding is already gone", async () => {
  const root = await trackOnlyWorkspace("archive");
  await fs.rm(root, { recursive: true, force: true });

  await run("untrack", root, "--force");
  expect(await readPersistedEntries()).toEqual([]);
  expect(logs.join("\n")).toContain("forgot");
});

test("untrack of a stale nested root never walks up and destroys the parent's binding", async () => {
  // The registry lists a child whose own binding is gone, and its PARENT is a
  // live workspace. Walking up would untrack the parent the user never named.
  const parent = await trackOnlyWorkspace("parent", "Parent");
  const child = path.join(parent, "nested");
  await fs.mkdir(path.join(child, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(child, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: "ws_nested",
    projectId: "root",
    remoteUrl: "https://api.test",
  }));
  await rememberBinding(child, { remoteWorkspaceId: "ws_nested" });
  await fs.rm(path.join(child, ".rbox"), { recursive: true, force: true });

  await run("untrack", child, "--force");

  // The parent keeps its binding and its registry entry; only the child is gone.
  await fs.access(path.join(parent, ".rbox", "workspace.json"));
  expect((await readPersistedEntries()).map((entry) => entry.root)).toEqual([parent]);
});

test("--all rejects the single-workspace detail flags rather than ignoring them", async () => {
  await trackOnlyWorkspace("papers");
  await expect(run("status", "--all", "--verbose")).rejects.toThrow(/--all is the aggregate view/);
  await expect(run("status", "--all", "--git")).rejects.toThrow(/--all is the aggregate view/);
  await expect(run("doctor", "--all", "--residue-bytes")).rejects.toThrow(/workspace-scoped/);
});

test("untrack of an unknown, unbound path still refuses", async () => {
  await expect(run("untrack", path.join(outside, "nowhere"), "--force")).rejects.toThrow(/Not inside an rbox workspace/);
});
