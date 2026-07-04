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

function run(args: string[], runCwd = cwd): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [cliEntry, ...args], {
    cwd: runCwd,
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1", RBOX_HOME: home },
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

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
