import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonRuntimeDir } from "./daemon-control.js";
import {
  buildDiagnosticsBundle,
  checkDeviceIdentity,
  doctorCmd,
  presentDiagnosticsPreview,
  type DiagnosticsBundle,
  type DoctorChecks,
  type DoctorContext,
} from "./doctor-cmd.js";
import { saveDevice } from "./e2ee-keystore.js";
import { bootstrapAccount } from "../engine/e2ee/index.js";

let home: string;
let logs: string[];
const origLog = console.log;
const origFetch = globalThis.fetch;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const bunVersion = () => (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unknown";

const checks: DoctorChecks = {
  credentials: { ok: true, label: "credentials", message: "authenticated" },
  enrollment: { ok: true, label: "encryption", message: "present" },
  device: { ok: true, label: "device", message: "device dev_1" },
  daemon: { ok: false, label: "background sync", message: "stale", status: "stale" },
  remote: { ok: true, label: "remote", message: "reachable", latencyMs: 10 },
  version: { ok: true, label: "version", message: "up to date", current: "0.6.8", latest: "0.6.8" },
  state: { ok: true, label: "state", message: "ok" },
  crypto: { ok: true, label: "crypto workers", message: "idle", status: "idle" },
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-home-"));
  process.env.RBOX_HOME = home;
  process.exitCode = 0;
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
});

afterEach(async () => {
  console.log = origLog;
  globalThis.fetch = origFetch;
  if (stdinTty) Object.defineProperty(process.stdin, "isTTY", stdinTty);
  else delete (process.stdin as { isTTY?: boolean }).isTTY;
  delete process.env.RBOX_HOME;
  delete process.env.RBOX_DIAGNOSTICS;
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_DEVICE_ID;
  delete process.env.RBOX_API;
  process.exitCode = 0;
  await fs.rm(home, { recursive: true, force: true });
});

function sampleBundle(): DiagnosticsBundle {
  return {
    version: "0.6.8",
    platform: { os: "darwin", arch: "arm64" },
    bunVersion: bunVersion(),
    checks,
    daemonLogTail: "daemon line with path src/app.ts\n",
    metrics: { syncs: 1, commitConflicts409: 0, fileConflicts: 0 },
    activity: { at: "2026-07-03T00:00:00.000Z" },
    workspaceShape: { fileCount: 1, totalBytes: 42 },
  };
}

async function makeWorkspace(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-root-"));
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(
    path.join(root, ".rbox", "workspace.json"),
    JSON.stringify(
      {
        schema: "e2ee/v1",
        remoteWorkspaceId: "ws_diag",
        projectId: "root",
        rootPath: root,
        remoteUrl: "https://api.test",
        token: "",
        deviceId: "dev_1",
      },
      null,
      2
    )
  );
  return root;
}

function recordFetches(): string[] {
  const calls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    calls.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return Promise.resolve(new Response("disabled in test", { status: 503 }));
  }) as typeof fetch;
  return calls;
}

test("device identity check reports match, mismatch, and no enrollment", async () => {
  const enrolled = await bootstrapAccount("acct_doctor_device", "dev_enrolled", 1_900_000_000_000);
  await saveDevice(enrolled.secrets);
  const creds = { token: "tok", deviceId: "env", accountId: "acct_doctor_device", remoteUrl: "https://api.test" };
  const cfg = {
    schema: "e2ee/v1" as const,
    remoteWorkspaceId: "ws_device",
    projectId: "root",
    rootPath: "/tmp/device",
    remoteUrl: "https://api.test",
    token: "",
    deviceId: "dev_enrolled",
  };
  expect(await checkDeviceIdentity(creds, cfg)).toEqual({ ok: true, label: "device", message: "device dev_enrolled" });
  const mismatch = await checkDeviceIdentity(creds, { ...cfg, deviceId: "dev_dangling" });
  expect(mismatch.ok).toBe(false);
  expect(mismatch.message).toContain("dev_dangling");
  expect((await checkDeviceIdentity(undefined, cfg)).ok).toBe(true);
});

async function expectReportReachesConsent(opts: { diagnostics?: boolean; env?: boolean }): Promise<void> {
  const root = await makeWorkspace();
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    process.env.RBOX_TOKEN = "tok_test";
    process.env.RBOX_DEVICE_ID = "dev_1";
    process.env.RBOX_API = "https://api.test";
    if (opts.env) process.env.RBOX_DIAGNOSTICS = "1";
    const calls = recordFetches();

    await expect(doctorCmd(root, { report: true, yes: false, diagnostics: opts.diagnostics })).rejects.toThrow(/--yes/);
    expect(calls.length).toBeGreaterThan(0);
    expect(logs.join("\n")).toContain("doctor");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

test("stale daemon binding excludes daemon log, metrics, and activity sections", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-root-"));
  try {
    const ctx: DoctorContext = {
      root,
      cfg: {
        schema: "e2ee/v1",
        remoteWorkspaceId: "ws_new",
        projectId: "root",
        rootPath: root,
        remoteUrl: "https://api.test",
        token: "",
        deviceId: "dev_1",
      },
      checks,
      workspaceShape: { fileCount: 2, totalBytes: 99 },
      daemonStale: true,
    };
    const bundle = await buildDiagnosticsBundle(ctx);
    expect(bundle.daemonLogTail).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.metrics).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.activity).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.workspaceShape).toEqual({ fileCount: 2, totalBytes: 99 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("stopped daemon bound to another workspace excludes daemon-owned diagnostics sections", async () => {
  const root = await makeWorkspace();
  try {
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "workspace.bound"), "ws_other\n");
    await fs.writeFile(path.join(runtime, "daemon.log"), "old workspace path src/secret.ts\n");

    const ctx: DoctorContext = {
      root,
      cfg: {
        schema: "e2ee/v1",
        remoteWorkspaceId: "ws_diag",
        projectId: "root",
        rootPath: root,
        remoteUrl: "https://api.test",
        token: "",
        deviceId: "dev_1",
      },
      checks: { ...checks, daemon: { ok: false, label: "background sync", message: "stopped", status: "stopped" } },
      workspaceShape: { fileCount: 1, totalBytes: 42 },
      daemonStale: false,
    };

    const bundle = await buildDiagnosticsBundle(ctx);
    expect(bundle.daemonLogTail).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.metrics).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.activity).toEqual({ excluded: "stale daemon binding" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor --report prints a local preview and does not upload", async () => {
  const root = await makeWorkspace();
  try {
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const calls = recordFetches();
    await doctorCmd(root, { report: true, yes: false });
    expect(calls.some((url) => url.endsWith("/v1/diagnostics"))).toBe(false);
    expect(logs.join("\n")).toContain("--- diagnostics preview (");
    expect(logs.join("\n")).toContain("--- end diagnostics preview ---");
    expect(logs.join("\n")).toContain("nothing was uploaded — add --diagnostics to send this report to rbox support");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("doctor --diagnostics without --report errors with guidance", async () => {
  await expect(doctorCmd("/does/not/need/a/workspace", { report: false, yes: false, diagnostics: true })).rejects.toThrow(
    "--diagnostics uploads the support report — combine it with --report: rbox doctor --report --diagnostics"
  );
});

test("doctor --report --diagnostics proceeds to the normal preview consent flow", async () => {
  await expectReportReachesConsent({ diagnostics: true });
});

test("RBOX_DIAGNOSTICS=1 enables doctor --report for the normal preview consent flow", async () => {
  await expectReportReachesConsent({ env: true });
});

test("non-TTY --yes writes the full preview under ~/.rbox with mode 0600 instead of stdout", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  const ok = await presentDiagnosticsPreview(sampleBundle(), { yes: true });
  expect(ok).toBe(true);
  const printed = logs.join("\n");
  expect(printed).toContain("stored UNENCRYPTED");
  expect(printed).toContain("diagnostics preview written to");
  expect(printed).not.toContain("daemonLogTail");

  const match = printed.match(/diagnostics preview written to (.+\.json) \((\d+) bytes\)/);
  expect(match).not.toBeNull();
  const file = match![1]!;
  expect(file.startsWith(path.join(home, ".rbox"))).toBe(true);
  const stat = await fs.stat(file);
  expect(stat.mode & 0o777).toBe(0o600);
  const preview = await fs.readFile(file, "utf8");
  expect(preview).toContain('"daemonLogTail"');
  expect(preview).toContain("src/app.ts");
});

test("non-TTY --report without --yes refuses before writing a preview file", async () => {
  Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  await expect(presentDiagnosticsPreview(sampleBundle(), { yes: false })).rejects.toThrow(/--yes/);
  await expect(fs.readdir(path.join(home, ".rbox"))).rejects.toThrow();
});
