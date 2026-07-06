import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig } from "./config.js";
import { accountStatus } from "./account-cmd.js";
import { listDevices, keyStatus } from "./auth-cmd.js";
import { daemonRuntimeDir } from "./daemon-control.js";
import { statusCmd } from "./status-cmd.js";
import { trashCmd } from "./trash-cmd.js";
import { versionsCmd } from "./versions-cmd.js";
import { fail, setJsonErrorMode } from "./style.js";

const origFetch = globalThis.fetch;
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

let tmp: string;

async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const out: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = origStdout;
  }
  return out.join("");
}

function stubFetch(responder: (url: string) => { status: number; body: unknown }): void {
  globalThis.fetch = (async (url: string) => {
    const r = responder(String(url));
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    } as Response;
  }) as unknown as typeof fetch;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-json-output-"));
});

afterEach(async () => {
  globalThis.fetch = origFetch;
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
  setJsonErrorMode(false);
  process.exitCode = 0;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_API;
  delete process.env.RBOX_DEVICE_ID;
  delete process.env.RBOX_ACCOUNT_ID;
  delete process.env.RBOX_HOME;
  await fs.rm(tmp, { recursive: true, force: true });
});

test("status --json emits JSON and uses shellStateOf health values", async () => {
  await saveConfig(tmp, {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_json",
    name: "JSON Workspace",
    projectId: "root",
    deviceId: "dev_json",
    rootPath: tmp,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: false,
  });
  await fs.mkdir(path.join(tmp, ".rbox", "state"), { recursive: true });
  await fs.writeFile(
    path.join(tmp, ".rbox", "state", "activity.json"),
    JSON.stringify({ at: "2026-07-04T12:00:00.000Z", outOfStorage: { at: "2026-07-04T12:00:00.000Z", kind: "storage", used: 2, cap: 2 } })
  );

  const dto = JSON.parse(await captureStdout(() => statusCmd(tmp, { json: true })));
  expect(dto).toEqual({
    workspace: { id: "ws_json", name: "JSON Workspace", root: tmp },
    health: "outofstorage",
    daemon: { running: false, pid: null },
    remote: null,
    trash: null,
    account: { plan: null, usedBytes: null, capBytes: null },
  });
});

test("status --json keeps machine health at halt when a fresh retry is active", async () => {
  await saveConfig(tmp, {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_json_retry",
    name: "JSON Retry Workspace",
    projectId: "root",
    deviceId: "dev_json_retry",
    rootPath: tmp,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: false,
  });
  await fs.mkdir(path.join(tmp, ".rbox", "state"), { recursive: true });
  const now = new Date().toISOString();
  await fs.writeFile(
    path.join(tmp, ".rbox", "state", "activity.json"),
    JSON.stringify({
      at: now,
      halt: { at: now, reason: "ENOENT: no such file or directory", count: 1, op: "push" },
      active: { at: now, phase: "encrypt", done: 1, total: 2 },
    })
  );

  const dto = JSON.parse(await captureStdout(() => statusCmd(tmp, { json: true })));
  expect(dto.health).toBe("halt");
});

test("status hashcache write-back is guarded by daemon pidfile presence", async () => {
  process.env.RBOX_HOME = path.join(tmp, "home");
  await fs.writeFile(path.join(tmp, "file.txt"), "hash me");
  await saveConfig(tmp, {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_hashcache",
    name: "HashCache Workspace",
    projectId: "root",
    deviceId: "dev_hashcache",
    rootPath: tmp,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: false,
  });
  const cachePath = path.join(tmp, ".rbox", "state", "hashcache.json");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, "{}");
  const runtime = daemonRuntimeDir(tmp);
  await fs.mkdir(runtime, { recursive: true });
  await fs.writeFile(path.join(runtime, "daemon.pid"), "v2 999999 rbox-test-boot\n");

  await captureStdout(() => statusCmd(tmp, { json: true }));
  expect(await fs.readFile(cachePath, "utf8")).toBe("{}");

  await fs.rm(path.join(runtime, "daemon.pid"), { force: true });
  await captureStdout(() => statusCmd(tmp, { json: true }));
  expect(JSON.parse(await fs.readFile(cachePath, "utf8"))["file.txt"]).toBeDefined();
});

test("device list --json emits JSON", async () => {
  process.env.RBOX_TOKEN = "tok";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_a";
  stubFetch(() => ({
    status: 200,
    body: { devices: [{ device_id: "dev_a", label: "laptop", created_at: 1, last_seen_at: 2, isSelf: true }] },
  }));

  const dto = JSON.parse(await captureStdout(() => listDevices({ json: true })));
  expect(dto).toEqual({ devices: [{ id: "dev_a", kind: "cli", createdAt: 1, lastSeenAt: 2, revoked: false }] });
});

test("account status --json emits JSON", async () => {
  process.env.RBOX_TOKEN = "tok";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_a";
  stubFetch((url) =>
    url.endsWith("/v1/account/status")
      ? { status: 200, body: { accountId: "acct_a", linked: true, plan: "free" } }
      : { status: 200, body: { plan: "pro", graceUntil: 123, readOnly: true } }
  );

  const dto = JSON.parse(await captureStdout(() => accountStatus({ json: true })));
  expect(dto).toEqual({ accountId: "acct_a", plan: "pro", graceUntil: 123, readOnly: true, linked: true });
});

test("versions --json emits JSON", async () => {
  const remote = {
    history: async () => [{ seq: 7, deviceId: "dev_a", keyEpoch: 0 }],
    advisoryTimes: async () => new Map([[7, 456]]),
  };
  const dto = JSON.parse(
    await captureStdout(() =>
      versionsCmd(tmp, undefined, 10, {
        json: true,
        buildAuthedRemote: async () => ({ remote }) as never,
      })
    )
  );
  expect(dto).toEqual({ versions: [{ sequence: 7, committedAt: 456, path: null }] });
});

test("trash list --json emits JSON", async () => {
  const batch = "2020-01-01T00-00-00-000Z";
  const file = path.join(tmp, ".rbox", "trash", batch, "src", "a.txt");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "abcd");

  const dto = JSON.parse(await captureStdout(() => trashCmd(tmp, ["list"], { json: "true" })));
  expect(dto).toEqual({
    entries: [{ path: "src/a.txt", deletedAt: "2020-01-01T00:00:00.000Z", size: 4, batch }],
    totalBytes: 4,
  });
});

test("key status --json emits enrollment and recovery-kit state", async () => {
  process.env.RBOX_TOKEN = "tok";
  process.env.RBOX_API = "https://api.test";
  process.env.RBOX_DEVICE_ID = "dev_a";
  process.env.RBOX_ACCOUNT_ID = "acct_a";
  process.env.RBOX_HOME = tmp;
  const kit = path.join(tmp, ".rbox", "e2ee", "acct_a", "kit.json");
  await fs.mkdir(path.dirname(kit), { recursive: true });
  await fs.writeFile(kit, JSON.stringify({ path: "/tmp/rbox-kit.txt", writtenAt: "2026-07-04T12:00:00.000Z" }));

  const dto = JSON.parse(await captureStdout(() => keyStatus({ json: true })));
  expect(dto).toEqual({
    enrolled: false,
    recoveryKit: { path: "/tmp/rbox-kit.txt", writtenAt: "2026-07-04T12:00:00.000Z" },
  });
});

test("json error mode emits {error} to stderr", () => {
  const err: string[] = [];
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  setJsonErrorMode(true);
  fail("forced failure");
  expect(err.join("")).toBe('{"error":"forced failure"}\n');
  expect(process.exitCode).toBe(1);
});
