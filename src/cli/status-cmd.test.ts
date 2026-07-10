import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveConfig, saveState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { populateStatusPath, type PopulateStatusV1 } from "./populate-status.js";
import { statusCmdWithDeps, type StatusCmdDeps } from "./status-cmd.js";

const OLD_ENV = { ...process.env };
const NOW = Date.parse("2026-07-08T12:00:00Z");

let root = "";
let runtime = "";
let home = "";
let cfg: WorkspaceConfig;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-status-root-"));
  runtime = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-status-runtime-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-status-home-"));
  process.env = { ...OLD_ENV, RBOX_HOME: runtime, HOME: home };
  delete process.env.RBOX_TOKEN;
  delete process.env.RBOX_DEVICE_ID;
  delete process.env.RBOX_ACCOUNT_ID;
  cfg = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_status",
    projectId: "root",
    deviceId: "dev_status",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    encrypted: true,
  };
  await saveConfig(root, cfg);
});

afterEach(async () => {
  process.env = { ...OLD_ENV };
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(runtime, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

function deps(): StatusCmdDeps {
  return {
    now: () => NOW,
    loadHashCache: async () => {
      throw new Error("hash cache should not load while populate marker is fresh");
    },
    scanManifest: async () => {
      throw new Error("scan should not run while populate marker is fresh");
    },
    gitDivergenceCount: async () => {
      throw new Error("git divergence should not run while populate marker is fresh");
    },
    gitDivergenceFastRepoSource: async () => [],
    daemonBindingStatus: () => ({ alive: { running: false }, stale: false }),
    readDaemonPidRecord: () => ({ present: false }),
  } as StatusCmdDeps;
}

function scanDeps(): StatusCmdDeps {
  return {
    now: () => NOW,
    loadHashCache: async () => ({
      prune() {},
      save: async () => {},
    }),
    scanManifest: async () => ({
      generatedAt: new Date(NOW).toISOString(),
      files: [{ path: "local.txt", type: "file", sha256: "a".repeat(64), size: 5, mode: 0o644, mtimeMs: 1 }],
    }),
    gitDivergenceCount: async () => 0,
    gitDivergenceFastRepoSource: async () => [],
    daemonBindingStatus: () => ({ alive: { running: false }, stale: false }),
    readDaemonPidRecord: () => ({ present: false }),
  } as StatusCmdDeps;
}

test("status renders initial sync progress instead of sequence-zero local changes", async () => {
  await fs.writeFile(path.join(root, "partially-downloaded.txt"), "local file that must not be counted as new");
  const marker: PopulateStatusV1 = {
    schemaVersion: 1,
    kind: "initial-populate",
    workspaceId: cfg.remoteWorkspaceId,
    projectId: cfg.projectId,
    stream: syncStreamId(cfg),
    pid: process.pid,
    startedAt: new Date(NOW - 1_000).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    operation: { kind: "pull", phase: "download", filesDone: 120, filesTotal: 200 },
  };
  await fs.mkdir(path.dirname(populateStatusPath(root)), { recursive: true });
  await fs.writeFile(populateStatusPath(root), `${JSON.stringify(marker)}\n`);

  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await statusCmdWithDeps(root, {}, deps());
  } finally {
    console.log = oldLog;
  }

  const out = lines.join("\n");
  expect(out).toContain("initial sync in progress");
  expect(out).toContain("120/200 files");
  expect(out).toContain("background sync: initial sync in progress");
  expect(out).not.toContain("local changes to sync");
});

test("status does not suppress local changes for a fresh populate marker on an advanced baseline", async () => {
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: new Date(NOW - 10_000).toISOString(), files: [] },
  });
  const marker: PopulateStatusV1 = {
    schemaVersion: 1,
    kind: "initial-populate",
    workspaceId: cfg.remoteWorkspaceId,
    projectId: cfg.projectId,
    stream: syncStreamId(cfg),
    pid: process.pid,
    startedAt: new Date(NOW - 1_000).toISOString(),
    heartbeatAt: new Date(NOW).toISOString(),
    operation: { kind: "pull", phase: "download", filesDone: 120, filesTotal: 200 },
  };
  await fs.mkdir(path.dirname(populateStatusPath(root)), { recursive: true });
  await fs.writeFile(populateStatusPath(root), `${JSON.stringify(marker)}\n`);

  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await statusCmdWithDeps(root, {}, scanDeps());
  } finally {
    console.log = oldLog;
  }

  const out = lines.join("\n");
  expect(out).toContain("1 local change to sync");
  expect(out).not.toContain("initial sync in progress");
  expect(out).toContain("sequence 7");
});

test("status renders the design-93 indeterminate config lane and never reports zero-on-error", async () => {
  cfg.syncGit = true;
  await saveConfig(root, cfg);
  const d = scanDeps();
  d.gitDivergenceStatus = async () => ({ count: 1, configChecking: ["repo"], configDisabled: [] });

  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await statusCmdWithDeps(root, {}, d);
  } finally {
    console.log = oldLog;
  }

  const out = lines.join("\n");
  expect(out).toContain("git changes in 1 repo");
  expect(out).toContain("config: checking (repo)");
});
