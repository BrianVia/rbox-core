import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cliEntry = path.join(path.dirname(fileURLToPath(import.meta.url)), "index.ts");

let home: string;
let cwd: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-dispatch-home-"));
  cwd = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-dispatch-cwd-"));
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(cwd, { recursive: true, force: true });
});

function run(args: string[], runCwd = cwd, envOverrides: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const env = { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", RBOX_HOME: home };
  delete env.RBOX_API;
  delete env.RBOX_API_QUIET;
  const res = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: runCwd,
    env: { ...env, ...envOverrides },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

test("RBOX_API override warning is printed exactly once on stderr", () => {
  const res = run(["version"], cwd, { RBOX_API: "https://api.test" });
  expect(res.status).toBe(0);
  expect(res.stdout.trim()).not.toBe("");
  expect(res.stderr).toBe("⚠ RBOX_API override: https://api.test\n");

  const fastPath = run(["prompt-status"], cwd, { RBOX_API: "https://api.test" });
  expect(fastPath.status).toBe(0);
  expect(fastPath.stderr).toBe("⚠ RBOX_API override: https://api.test\n");
});

test("RBOX_API override warning is absent when unset or set to production", () => {
  expect(run(["version"]).stderr).toBe("");
  expect(run(["version"], cwd, { RBOX_API: "https://api.rbox.to" }).stderr).toBe("");
});

test("RBOX_API_QUIET=1 suppresses the override warning", () => {
  const res = run(["version"], cwd, { RBOX_API: "https://api.test", RBOX_API_QUIET: "1" });
  expect(res.status).toBe(0);
  expect(res.stderr).toBe("");
});

test("unknown flags fail before command dispatch", () => {
  const res = run(["start", "--pullonly"]);
  expect(res.status).toBe(1);
  expect(res.stdout).toBe("");
  expect(res.stderr).toContain("unknown flag --pullonly");
  expect(res.stderr).toContain("rbox start --help");
});

test("RBOX_API override warning leaves JSON command stdout valid", async () => {
  const root = await makeWorkspace();
  try {
    const res = run(["trash", "list", "--json"], root, { RBOX_API: "https://api.test" });
    expect(res.status).toBe(0);
    expect(JSON.parse(res.stdout)).toEqual({ entries: [], totalBytes: 0 });
    expect(res.stderr).toBe("⚠ RBOX_API override: https://api.test\n");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-dispatch-ws-"));
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify({
      schema: "e2ee/v1",
      remoteWorkspaceId: "ws_dispatch",
      projectId: "root",
      rootPath: root,
      remoteUrl: "https://api.test",
      token: "",
      deviceId: "dev_dispatch",
    })
  );
  return root;
}

test("--json on a command without JSON support keeps human error output", () => {
  const res = run(["doctor", "--json"]);
  expect(res.status).toBe(1);
  expect(res.stdout).toBe("");
  expect(res.stderr).toContain("rbox: Not inside an rbox workspace");
  expect(res.stderr).not.toContain('{"error"');
});

test("JSON-supported group usage errors emit JSON to stderr", () => {
  const res = run(["device", "--json"]);
  expect(res.status).toBe(1);
  expect(res.stdout).toBe("");
  expect(JSON.parse(res.stderr)).toEqual({ error: "usage: rbox device <approve <user-code>|list|revoke <device-id>>" });
});

test("versions usage errors emit JSON to stderr when --json is active", () => {
  const res = run(["versions", "--json", "--limit", "nope"]);
  expect(res.status).toBe(1);
  expect(res.stdout).toBe("");
  expect(JSON.parse(res.stderr)).toEqual({ error: "usage: rbox versions [path] [--limit <n>] [--json]" });
});

test("trash usage errors emit JSON to stderr when --json is active", async () => {
  const root = await makeWorkspace();
  try {
    const res = run(["trash", "--json", "bogus"], root);
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    expect(JSON.parse(res.stderr)).toEqual({ error: "usage: rbox trash <list | restore <path> [--batch <name>] | empty> [--path <dir>]" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("git deferrals rejects conflicting modes, positionals, and leaf-unknown flags", () => {
  const conflict = run(["git", "deferrals", "--brief", "--json"]);
  expect(conflict.status).toBe(1);
  expect(conflict.stdout).toBe("");
  expect(JSON.parse(conflict.stderr)).toEqual({ error: "usage: rbox git deferrals [--brief | --json]" });

  const positional = run(["git", "deferrals", "repo"]);
  expect(positional.status).toBe(1);
  expect(positional.stdout).toBe("");
  expect(positional.stderr).toContain("usage: rbox git deferrals");

  const unknown = run(["git", "deferrals", "--confirm", "token"]);
  expect(unknown.status).toBe(1);
  expect(unknown.stdout).toBe("");
  expect(unknown.stderr).toContain("unknown flag --confirm");
});

test("git deferrals root discovery failures never emit success JSON", () => {
  const result = run(["git", "deferrals", "--json"]);
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(JSON.parse(result.stderr).error).toContain("Not inside an rbox workspace");
});
