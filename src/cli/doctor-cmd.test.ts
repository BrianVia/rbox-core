import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonRuntimeDir } from "./daemon-control.js";
import {
  buildDiagnosticsBundle,
  checkDeviceIdentity,
  collectDoctorContext,
  doctorCmd,
  presentDiagnosticsPreview,
  redactGitLogLines,
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
const originalHome = process.env.HOME;

const checks: DoctorChecks = {
  credentials: { ok: true, label: "credentials", message: "authenticated" },
  enrollment: { ok: true, label: "encryption", message: "present" },
  device: { ok: true, label: "device", message: "device dev_1" },
  daemon: { ok: false, label: "background sync", message: "stale", status: "stale" },
  remote: { ok: true, label: "remote", message: "reachable", latencyMs: 10 },
  version: { ok: true, label: "version", message: "up to date", current: "0.6.8", latest: "0.6.8" },
  state: { ok: true, label: "state", message: "ok" },
  crypto: { ok: true, label: "crypto workers", message: "idle", status: "idle" },
  locking: { ok: true, label: "locking", message: "ok (.rbox/state/sync.lock)", status: "ok" },
  git: { ok: true, label: "git", message: "transactional symref-update supported", status: "supported", current: "git version 2.46.0" },
};

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-home-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
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
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
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
    metrics: { syncs: 1, commitConflicts409: 0, fileConflicts: 0, lockStarved: 1 },
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

test("doctor reports credential degradation and continues the remaining safe checks", async () => {
  const root = await makeWorkspace();
  await fs.mkdir(path.join(home, ".rbox"), { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(home, ".rbox", "credentials.json"), "{malformed", { mode: 0o600 });
  const calls = recordFetches();
  try {
    const context = await collectDoctorContext(root);
    expect(context.credentialResult?.state).toBe("corrupt");
    expect(context.checks.credentials.message).toContain("credential-degraded");
    expect(context.checks.state).toBeDefined();
    expect(context.checks.locking).toBeDefined();
    expect(context.checks.git).toBeDefined();
    expect(calls.length).toBeGreaterThan(0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

test("git daemon forensics are fail-closed and privacy-safe in diagnostics", async () => {
  const oid = "0123456789abcdef0123456789abcdef01234567";
  const raw = [
    "2026-07-13T12:00:00.000Z ordinary daemon line",
    "2026-07-13T12:00:00.100Z lock starved: reason=foreign age=15m",
    "2026-07-13T12:00:00.200Z lock starved: reason=foreign age=15m path=/secret token=deadbeef https://user:pass@example.test",
    "2026-07-13T12:00:00.500Z git-sync: captured 1 (private/summary) · carried 0 · skipped 0 · deferred 1 (private/summary: raw summary failure) · removed 0",
    "2026-07-13T12:00:01.000Z git deferred 14d: local edits on branch secret stash branch\tname (private/repo)",
    "2026-07-13T12:00:01.500Z git deferred 14d: local edits on branch another private branch (other/private)",
    `2026-07-13T12:00:02.000Z git-sync deferred private/legacy repo: fatal: raw git failure ${oid}`,
    "2026-07-13T12:00:03.000Z git-sync CONFLICT private/conflict — local kept; remote preserved at refs/rbox-conflict/private. Your local Git work is safe; inspect the preserved incoming state before resolving.",
    "2026-07-13T12:00:04.000Z git-sync WARNING private/repo: post-apply containment check failed: /secret/path",
    "2026-07-13T12:00:05.000Z git-sync config skipped private/repo: local branch name does not own config. rbox left shared Git settings alone; Git history can still sync.",
    `2026-07-13T12:00:06.000Z git-sync applied private/repo (held refs: refs/heads/secret=${oid})`,
    "2026-07-13T12:00:07.000Z git-sync applied private/repo (filtered refs: refs/heads/private)",
    "2026-07-13T12:00:07.500Z git-sync removed private/repo (remote deleted; local .git untouched). Your local Git repository is safe.",
    "2026-07-13T12:00:08.000Z git-sync deferred malformed-without-colon private/repo secret",
    "2026-07-13T12:00:09.000Z git-sync UNKNOWN private/repo raw error",
    "2026-07-13T12:00:10.000Z git-sync WARNING private/repo: raw error starts here",
    "injected continuation /secret/control-path refs/heads/private",
    "2026-07-13T12:00:10.500Z TIMESTAMP_SHAPED_SECRET /secret/spoof private/repo",
    "2026-07-13T12:00:10.750Z git deferred 1h: artifact on checkout unavailable (private/missing-checkout)",
    "2026-07-13T12:00:11.000Z ordinary daemon end",
  ].join("\n") + "\n";

  const redacted = redactGitLogLines(raw);
  expect(redacted).toContain("ordinary daemon line");
  expect(redacted).toContain("lock starved: reason=foreign age=15m");
  expect(redacted).toContain("git-sync summary reason=other age=-");
  expect(redacted).toContain("git-sync deferred reason=local-edits age=14d count=2");
  expect(redacted).toContain("git-sync deferred reason=other age=-");
  expect(redacted).toContain("git-sync conflict reason=conflict age=-");
  expect(redacted).toContain("git-sync warning reason=containment age=-");
  expect(redacted).toContain("git-sync config-skipped reason=config age=-");
  expect(redacted).toContain("git-sync applied reason=local-commits age=-");
  expect(redacted).toContain("git-sync applied reason=other age=-");
  expect(redacted).toContain("git-sync removed reason=other age=-");
  expect(redacted).toContain("git-sync deferred reason=artifact age=1h");
  expect(redacted).not.toMatch(/\d{4}-\d\d-\d\dT\S+Z git-sync/);
  expect(redacted).not.toContain("ordinary daemon end");
  for (const secret of ["private/", "secret stash branch", "refs/heads", oid, "raw git failure", "raw summary failure", "/secret", "deadbeef", "user:pass", "TIMESTAMP_SHAPED_SECRET", "UNKNOWN", "malformed-without-colon"]) {
    expect(redacted).not.toContain(secret);
  }

  const root = await makeWorkspace();
  try {
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.log"), raw);
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
      checks: { ...checks, daemon: { ok: true, label: "background sync", message: "running", status: "running" } },
      workspaceShape: { fileCount: 1, totalBytes: 42 },
      daemonStale: false,
    };
    const payload = JSON.stringify(await buildDiagnosticsBundle(ctx));
    expect(payload).toContain("git-sync deferred reason=local-edits age=14d");
    for (const secret of ["private/", "secret stash branch", "refs/heads", oid, "raw git failure", "raw summary failure", "/secret", "deadbeef", "user:pass", "TIMESTAMP_SHAPED_SECRET", "UNKNOWN", "malformed-without-colon"]) {
      expect(payload).not.toContain(secret);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a byte-truncated Git log record cannot leak a continuation", async () => {
  const root = await makeWorkspace();
  try {
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    const sentinel = "TRUNCATED_GIT_CONTINUATION_SECRET";
    await fs.writeFile(path.join(runtime, "daemon.log"), [
      "2026-07-13T11:59:59.000Z ordinary safely framed record",
      `2026-07-13T12:00:00.000Z git-sync WARNING repo: ${"x".repeat(70 * 1024)}`,
      sentinel,
      "2026-07-13T12:00:01.000Z TIMESTAMP_SPOOFED_CONTINUATION_SECRET",
      "",
    ].join("\n"));
    const ctx: DoctorContext = {
      root,
      cfg: {
        schema: "e2ee/v1", remoteWorkspaceId: "ws_diag", projectId: "root", rootPath: root,
        remoteUrl: "https://api.test", token: "", deviceId: "dev_1",
      },
      checks,
      workspaceShape: { fileCount: 1, totalBytes: 42 },
      daemonStale: false,
    };
    const payload = JSON.stringify(await buildDiagnosticsBundle(ctx));
    // The byte tail begins within the unsafe Git record, so neither its raw
    // continuations nor timestamp-shaped continuations may be treated as records.
    expect(payload).not.toContain("TIMESTAMP_SPOOFED_CONTINUATION_SECRET");
    expect(payload).not.toContain(sentinel);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("diagnostics merges bounded dated and crash channels before redaction", async () => {
  const root = await makeWorkspace();
  try {
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.log"), "2026-07-13T12:00:00.000Z crash diagnostic\n");
    await fs.writeFile(path.join(runtime, "daemon-2026-07-13.log"), "2026-07-13T12:00:01.000Z dated diagnostic\n");
    const ctx: DoctorContext = {
      root,
      cfg: {
        schema: "e2ee/v1", remoteWorkspaceId: "ws_diag", projectId: "root", rootPath: root,
        remoteUrl: "https://api.test", token: "", deviceId: "dev_1",
      },
      checks,
      workspaceShape: { fileCount: 1, totalBytes: 42 },
      daemonStale: false,
    };
    const tail = (await buildDiagnosticsBundle(ctx)).daemonLogTail;
    expect(tail).toContain("crash diagnostic");
    expect(tail).toContain("dated diagnostic");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("diagnostics retains the bounded tail of an oversized daemon source", async () => {
  const root = await makeWorkspace();
  try {
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "daemon.log"), `OLD_PREFIX_${"x".repeat(70 * 1024)}_FINAL_TAIL_SENTINEL\n`);
    const ctx: DoctorContext = {
      root,
      cfg: {
        schema: "e2ee/v1", remoteWorkspaceId: "ws_diag", projectId: "root", rootPath: root,
        remoteUrl: "https://api.test", token: "", deviceId: "dev_1",
      },
      checks,
      workspaceShape: { fileCount: 1, totalBytes: 42 },
      daemonStale: false,
    };
    const tail = (await buildDiagnosticsBundle(ctx)).daemonLogTail;
    expect(tail).toContain("_FINAL_TAIL_SENTINEL");
    expect(tail).not.toContain("OLD_PREFIX_");
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
