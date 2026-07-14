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

function cleanScanDeps(): StatusCmdDeps {
  const d = scanDeps();
  d.scanManifest = async () => ({ generatedAt: new Date(NOW).toISOString(), files: [] });
  return d;
}

async function saveDeferralState(): Promise<void> {
  const older = new Date(NOW - 15 * 86400_000).toISOString();
  const tied = new Date(NOW - 2 * 86400_000).toISOString();
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: new Date(NOW - 20_000).toISOString(), files: [] },
    repoRecords: {
      zeta: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: {
          capture: {
            lane: "capture",
            reason: "local-commits",
            deferredSince: older,
            reasonSince: older,
            lastSeen: tied,
            checkout: { kind: "detached", label: "0123456789abcdef" },
          },
        },
      },
      beta: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: {
          config: {
            lane: "config",
            reason: "git-busy",
            deferredSince: tied,
            reasonSince: tied,
            lastSeen: tied,
          },
        },
      },
      alpha: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: {
          apply: {
            lane: "apply",
            reason: "local-edits",
            deferredSince: tied,
            reasonSince: tied,
            lastSeen: tied,
            subjectKey: "secret-oid-like-subject",
            checkout: { kind: "branch", label: "release/0.9" },
            bytesChanged: true,
          },
        },
      },
    },
  });
}

async function captureStatus(opts: { json?: boolean }): Promise<string> {
  const lines: string[] = [];
  let stdout = "";
  const oldLog = console.log;
  const oldWrite = process.stdout.write;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await statusCmdWithDeps(root, opts, cleanScanDeps());
  } finally {
    console.log = oldLog;
    process.stdout.write = oldWrite;
  }
  return opts.json ? stdout.trim() : lines.join("\n");
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
  d.gitDivergenceStatus = async () => ({ count: 1, deferrals: [], configChecking: ["repo"], configDisabled: [] });

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

test("status renders durable lanes oldest-first with reason precedence and safe checkout labels", async () => {
  await saveDeferralState();
  const out = await captureStatus({});
  expect(out).toContain("git-sync: 0 repos synced · 3 deferred");
  expect(out).not.toContain("✓ in sync");
  const lines = out.split("\n").filter((line) => line.includes("git deferred"));
  expect(lines).toEqual([
    "    git deferred 14d: local commits on detached checkout (zeta)",
    "    git deferred 1d: local edits on branch release/0.9 (alpha) (working files changed since)",
    "    git deferred 1d: git busy on checkout unavailable (beta)",
  ]);
  expect(out).not.toContain("0123456789abcdef");
});

test("degraded legacy deferral reload retains status reason and age", async () => {
  const deferredSince = new Date(NOW - 15 * 86400_000).toISOString();
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: new Date(NOW - 20_000).toISOString(), files: [] },
    gitDeferrals: {
      legacy: {
        apply: {
          lane: "apply",
          reason: "unsupported",
          deferredSince,
          reasonSince: deferredSince,
          lastSeen: deferredSince,
        },
      },
    },
  });
  const out = await captureStatus({});
  expect(out).toContain("git-sync: 0 repos synced · 1 deferred");
  expect(out).toContain("git deferred 14d: unsupported git state on checkout unavailable (legacy)");
});

test("status --json exposes only the stable local deferral projection and cannot report ok", async () => {
  await saveDeferralState();
  const parsed = JSON.parse(await captureStatus({ json: true })) as Record<string, any>;
  expect(parsed.health).not.toBe("ok");
  expect(parsed.git.deferrals).toEqual([
    {
      repo: "zeta",
      lane: "capture",
      reason: "local-commits",
      deferredSince: new Date(NOW - 15 * 86400_000).toISOString(),
      reasonSince: new Date(NOW - 15 * 86400_000).toISOString(),
      ageSeconds: 15 * 86400,
      bytesChanged: false,
      checkout: { kind: "detached" },
    },
    {
      repo: "alpha",
      lane: "apply",
      reason: "local-edits",
      deferredSince: new Date(NOW - 2 * 86400_000).toISOString(),
      reasonSince: new Date(NOW - 2 * 86400_000).toISOString(),
      ageSeconds: 2 * 86400,
      bytesChanged: true,
      checkout: { kind: "branch", label: "release/0.9" },
    },
    {
      repo: "beta",
      lane: "config",
      reason: "git-busy",
      deferredSince: new Date(NOW - 2 * 86400_000).toISOString(),
      reasonSince: new Date(NOW - 2 * 86400_000).toISOString(),
      ageSeconds: 2 * 86400,
      bytesChanged: false,
    },
  ]);
  expect(parsed.git.deferredRepos).toEqual([
    {
      repo: "zeta",
      oldestDeferredSince: new Date(NOW - 15 * 86400_000).toISOString(),
      displayReason: "local-commits",
      ageSeconds: 15 * 86400,
      bytesChanged: false,
      checkout: { kind: "detached" },
    },
    {
      repo: "alpha",
      oldestDeferredSince: new Date(NOW - 2 * 86400_000).toISOString(),
      displayReason: "local-edits",
      ageSeconds: 2 * 86400,
      bytesChanged: true,
      checkout: { kind: "branch", label: "release/0.9" },
    },
    {
      repo: "beta",
      oldestDeferredSince: new Date(NOW - 2 * 86400_000).toISOString(),
      displayReason: "git-busy",
      ageSeconds: 2 * 86400,
      bytesChanged: false,
    },
  ]);
  const payload = JSON.stringify(parsed.git);
  expect(payload).not.toContain("secret-oid-like-subject");
  expect(payload).not.toContain("0123456789abcdef");
  expect(payload).not.toContain("lastSeen");
});

test("typed divergence seam deferrals gate health even when local detail records are absent", async () => {
  cfg.syncGit = true;
  await saveConfig(root, cfg);
  const d = cleanScanDeps();
  d.gitDivergenceStatus = async () => ({
    count: 0,
    deferrals: [{
      relPath: "seam/repo",
      lane: "apply",
      reason: "local-edits",
      deferredSince: new Date(NOW - 3_600_000).toISOString(),
      bytesChanged: true,
    }],
    configChecking: [],
    configDisabled: [],
  });
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await statusCmdWithDeps(root, {}, d);
  } finally {
    console.log = oldLog;
  }
  const out = lines.join("\n");
  expect(out).toContain("1 git repo deferred");
  expect(out).toContain("git-sync: 0 repos synced · 1 deferred");
  expect(out).not.toContain("✓ in sync");
  expect(out.split("\n").filter((line) => line.includes("git deferred "))).toHaveLength(0);
});

test("one repo with multiple lanes renders one repo-level line and count", async () => {
  const at = new Date(NOW - 86_400_000).toISOString();
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: at, files: [] },
    repoRecords: {
      repo: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: {
          apply: { lane: "apply", reason: "local-edits", deferredSince: at, reasonSince: at, lastSeen: at },
          capture: { lane: "capture", reason: "local-index", deferredSince: at, reasonSince: at, lastSeen: at },
        },
      },
    },
  });
  const out = await captureStatus({});
  expect(out).toContain("1 git repo deferred");
  expect(out).toContain("git-sync: 0 repos synced · 1 deferred");
  const rows = out.split("\n").filter((line) => line.includes("git deferred "));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("local edits");
});
