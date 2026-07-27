import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readTriageInputs, renderWorkspaceTriage, triageWorkspace, type TriageInputs } from "./doctor-triage.js";
import { doctorCmd, type DoctorChecks } from "./doctor-cmd.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId } from "./config.js";
import { daemonRuntimeDir } from "./daemon-control.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

let home: string;
let root: string;
const originalHome = process.env.HOME;

const healthyChecks = (): DoctorChecks => ({
  credentials: { ok: true, label: "credentials", message: "authenticated" },
  enrollment: { ok: true, label: "encryption", message: "device key and master key present" },
  device: { ok: true, label: "device", message: "device dev_1" },
  daemon: { ok: true, label: "background sync", message: "running (pid 1)", status: "running" },
  remote: { ok: true, label: "remote", message: "reachable" },
  version: { ok: true, label: "version", message: "up to date", current: "1.9.0", latest: "1.9.0" },
  state: { ok: true, label: "state", message: "ok" },
  crypto: { ok: true, label: "crypto workers", message: "idle", status: "idle" },
  locking: { ok: true, label: "locking", message: "ok", status: "ok" },
  git: { ok: true, label: "git", message: "supported", status: "supported" },
  chain: { ok: true, label: "manifest chain", message: "head 3" },
});

const inputs = (over: Partial<TriageInputs> = {}): TriageInputs => ({
  root: "/tmp/demo-workspace",
  checks: healthyChecks(),
  deferrals: [],
  ambient: { kind: "absent" },
  daemonRunning: true,
  adopt: { status: "none" },
  now: NOW,
  cliVersion: "1.9.0",
  ...over,
});

const workspaceConfig = (id = "ws_1") => ({
  schema: "e2ee/v1" as const,
  remoteWorkspaceId: id,
  projectId: "root",
  rootPath: root,
  remoteUrl: "https://api.test",
  token: "",
  deviceId: "dev_1",
});

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-triage-home-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-triage-root-"));
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify(workspaceConfig()));
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

test("a healthy workspace reports one plain-English all-clear and no findings", () => {
  const triage = triageWorkspace(inputs());
  expect(triage.healthy).toBe(true);
  expect(triage.findings).toEqual([]);
  const rendered = renderWorkspaceTriage(triage).join("\n");
  expect(rendered).toContain("Everything is syncing normally.");
});

test("a resolvable deferral becomes a repo-named resolve command with a safety line", () => {
  const triage = triageWorkspace(inputs({
    deferrals: [{
      repo: "savvy-core",
      oldestDeferredSince: new Date(NOW - 20 * 3600_000).toISOString(),
      displayReason: "local-commits",
      displayLane: "apply",
      reasonSince: new Date(NOW - 20 * 3600_000).toISOString(),
      reasonLabel: "local commits",
      reasonText: "Local commits changed here.",
      repairText: "Stop Git mutation, then let normal sync retry.",
      remediationClass: "apply-resolvable",
      canResolve: true,
      canKeepMine: true,
      bytesChanged: false,
    }],
  }));
  const finding = triage.findings[0]!;
  expect(finding.id).toBe("git-paused:savvy-core");
  expect(finding.severity).toBe("blocked");
  expect(finding.problem).toContain("savvy-core");
  expect(finding.problem).toContain("waiting for over an hour");
  expect(finding.safety).toContain("Your repository is healthy; only rbox's bookkeeping is paused.");
  expect(finding.command).toBe("rbox git resolve savvy-core keep-mine");
  expect(triage.healthy).toBe(false);
});

test("an unresolvable deferral points at the copy-pasteable repair brief", () => {
  const triage = triageWorkspace(inputs({
    deferrals: [{
      repo: "notes",
      oldestDeferredSince: new Date(NOW - 5 * 60_000).toISOString(),
      displayReason: "local-edits",
      displayLane: "capture",
      reasonSince: new Date(NOW - 5 * 60_000).toISOString(),
      reasonLabel: "local edits",
      reasonText: "Working files changed here.",
      repairText: "Stop Git and file changes, then let normal sync retry.",
      remediationClass: "transient",
      canResolve: false,
      canKeepMine: false,
      bytesChanged: false,
    }],
  }));
  expect(triage.findings[0]!.severity).toBe("attention");
  expect(triage.findings[0]!.command).toBe("rbox git deferrals --brief");
});

test("blocked findings sort ahead of attention, and advisories sort last", () => {
  const checks = healthyChecks();
  checks.credentials = { ok: false, label: "credentials", message: "not logged in" };
  checks.daemon = { ok: false, label: "background sync", message: "stopped", status: "stopped" };
  checks.version = { ok: false, label: "version", message: "update available", latest: "9.9.9" };
  const triage = triageWorkspace(inputs({ checks }));
  expect(triage.findings.map((f) => f.id)).toEqual(["signed-out", "daemon-stopped", "update-available"]);
  expect(triage.healthy).toBe(false);
  const rendered = renderWorkspaceTriage(triage).join("\n");
  expect(rendered).toContain("2 things need your attention.");
  expect(rendered).toContain("rbox login");
  expect(rendered).toContain("rbox start");
});

test("an unfinished move-in, a mass-delete stop, and no storage are all explained with one command each", () => {
  const triage = triageWorkspace(inputs({
    adopt: { status: "active", phase: "scanning", journalId: "j1" },
    activity: {
      at: new Date(NOW).toISOString(),
      halt: { at: new Date(NOW).toISOString(), reason: "mass delete", count: 1, op: "pull", typedReason: { kind: "mass-delete", op: "pull" } },
      outOfStorage: { at: new Date(NOW).toISOString(), kind: "storage" },
    },
  }));
  const byId = new Map(triage.findings.map((f) => [f.id, f]));
  expect(byId.get("adopt-incomplete")!.command).toBe("rbox adopt status");
  expect(byId.get("halt:mass-delete")!.command).toBe("rbox sync --allow-mass-delete");
  expect(byId.get("halt:mass-delete")!.safety).toContain("Nothing was deleted");
  expect(byId.get("quota-storage")!.command).toBe("rbox subscribe");
});

test("a degraded watcher, a pull-only hold, and a stale daemon version each get their own remedy", () => {
  const ambient = {
    kind: "ok" as const,
    status: {
      schemaVersion: 1 as const,
      state: "attention" as const,
      attentionReason: "watcher-degraded" as const,
      heartbeatAt: new Date(NOW - 1_000).toISOString(),
      sequence: 3,
      lastSyncedAt: null,
      mode: "pull-only" as const,
      daemonVersion: "1.8.0",
    },
  };
  const triage = triageWorkspace(inputs({ ambient }));
  const byId = new Map(triage.findings.map((f) => [f.id, f]));
  expect(byId.get("watcher-degraded")!.command).toBe("rbox stop && rbox start");
  expect(byId.get("watcher-degraded")!.problem).not.toContain("watcher");
  expect(byId.get("pull-only")!.command).toBe("rbox start --read-write");
  expect(byId.get("pull-only")!.severity).toBe("info");
  expect(byId.get("daemon-version-skew")!.command).toBe("rbox upgrade");
});

test("a stale ambient record is not read as live attention", () => {
  const triage = triageWorkspace(inputs({
    ambient: {
      kind: "ok",
      status: {
        schemaVersion: 1,
        state: "attention",
        attentionReason: "watcher-degraded",
        heartbeatAt: new Date(NOW - 3 * 3600_000).toISOString(),
        sequence: 1,
        lastSyncedAt: null,
      },
    },
  }));
  expect(triage.findings.map((f) => f.id)).not.toContain("watcher-degraded");
});

test("readTriageInputs projects seeded deferral state from the workspace on disk", async () => {
  const cfg = workspaceConfig();
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 1,
    lastSyncedManifest: { files: {} },
    repoRecords: {
      "savvy-core": {
        deferrals: {
          apply: {
            lane: "apply",
            reason: "local-commits",
            deferredSince: new Date(NOW - 26 * 3600_000).toISOString(),
          },
        },
      },
    },
  } as never);

  const collected = await readTriageInputs(root, healthyChecks(), NOW);
  expect(collected.deferrals.map((d) => d.repo)).toEqual(["savvy-core"]);
  const triage = triageWorkspace(collected);
  expect(triage.findings.some((f) => f.id === "git-paused:savvy-core")).toBe(true);
  expect(triage.root).toBe(path.resolve(root));
});

test("doctor --json emits the same findings machine-readably, and refuses --report", async () => {
  const origFetch = globalThis.fetch;
  const origWrite = process.stdout.write.bind(process.stdout);
  const written: string[] = [];
  globalThis.fetch = (async () => {
    throw new Error("offline in test");
  }) as typeof fetch;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await doctorCmd(root, { report: false, yes: false, json: true, now: NOW });
  } finally {
    process.stdout.write = origWrite;
    globalThis.fetch = origFetch;
    process.exitCode = 0;
  }
  const payload = JSON.parse(written.join("")) as {
    schemaVersion: number;
    scope: string;
    root: string;
    healthy: boolean;
    findings: Array<{ id: string; severity: string; problem: string; safety: string; command?: string }>;
  };
  expect(payload.schemaVersion).toBe(1);
  expect(payload.scope).toBe("workspace");
  expect(payload.root).toBe(path.resolve(root));
  expect(payload.findings.some((f) => f.id === "signed-out")).toBe(true);
  for (const finding of payload.findings) {
    expect(finding.problem.length).toBeGreaterThan(0);
    expect(finding.safety.length).toBeGreaterThan(0);
  }
  await expect(doctorCmd(root, { report: true, yes: true, json: true })).rejects.toThrow("--json prints the findings only");
});
