import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { loadState, repoRecordsForState, saveConfig, saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "./config.js";
import { populateStatusPath, type PopulateStatusV1 } from "./populate-status.js";
import { statusCmdWithDeps, type StatusCmdDeps } from "./status-cmd.js";
import { lockingHealthPath } from "./sync-mutex.js";
import { daemonDatedLogPath } from "./rbox-paths.js";
import { main } from "./main-dispatch.js";
import { writeResetHaltHealth } from "./reset-health.js";
import { RBOX_VERSION } from "./version.js";
import { saveActivity } from "./activity.js";
import { GENESIS_PENDING_MESSAGE, publishPrepublishMarker } from "./genesis-durable.js";

const OLD_ENV = { ...process.env };
const NOW = Date.parse("2026-07-08T12:00:00Z");
const exec = promisify(execFile);

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
  await saveStateUnsafeLegacyOrTest(root, {
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

async function captureStatus(opts: { json?: boolean; verbose?: boolean; git?: boolean }): Promise<string> {
  return captureStatusWithDeps(opts, cleanScanDeps());
}

async function captureStatusWithDeps(
  opts: { json?: boolean; verbose?: boolean; git?: boolean },
  statusDeps: StatusCmdDeps
): Promise<string> {
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
    await statusCmdWithDeps(root, opts, statusDeps);
  } finally {
    console.log = oldLog;
    process.stdout.write = oldWrite;
  }
  return opts.json ? stdout.trim() : lines.join("\n");
}

async function captureDispatch(args: string[]): Promise<string> {
  const previousArgv = process.argv;
  const previousCwd = process.cwd();
  const previousExitCode = process.exitCode;
  const oldLog = console.log;
  const oldWrite = process.stdout.write;
  let stdout = "";
  process.argv = [process.execPath, "rbox", ...args];
  process.chdir(root);
  process.exitCode = undefined;
  console.log = (...values: unknown[]) => { stdout += `${values.map(String).join(" ")}\n`; };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await main({ now: () => new Date(NOW) });
    // Bun quirk: `process.exitCode = undefined` cannot clear a previously set
    // numeric code (reads back 0), so a pristine-undefined assertion is
    // poisoned by any earlier suite that set an exit code.
    expect(process.exitCode ?? 0).toBe(0);
    return stdout.trim();
  } finally {
    process.argv = previousArgv;
    process.chdir(previousCwd);
    process.exitCode = previousExitCode ?? 0;
    console.log = oldLog;
    process.stdout.write = oldWrite;
  }
}

test("status remains read-only during pending genesis and surfaces the resume instruction in text and JSON", async () => {
  const accountId = "acct_bbbbbbbbbbbbbbbb";
  await publishPrepublishMarker({
    version: 1,
    accountId,
    deviceId: cfg.deviceId,
    repairId: null,
    startedAt: "2026-07-22T12:00:00.000Z",
    phase: "prepublish",
  });
  const d = cleanScanDeps();
  d.loadCredentials = async () => ({
    state: "valid",
    source: "disk",
    credentials: { v: 1, token: "tok", deviceId: cfg.deviceId, accountId, remoteUrl: "https://api.test" },
    legacy: false,
    extensions: {},
  });

  const human = await captureStatusWithDeps({ verbose: true }, d);
  expect(human).toContain(GENESIS_PENDING_MESSAGE);
  const json = JSON.parse(await captureStatusWithDeps({ json: true }, d));
  expect(json.genesisPending).toBe(true);
  expect(json.resumeInstruction).toBe(GENESIS_PENDING_MESSAGE);
});

test("design 178 C: computed status clears an idle capture-busy lane without a push", async () => {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  await exec("git", ["-C", repo, "init", "-q"]);
  const lock = path.join(repo, ".git", "index.lock");
  await fs.writeFile(lock, "");
  const at = new Date(NOW - 60_000).toISOString();
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: at, files: [] },
    repoRecords: {
      repo: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: { capture: { lane: "capture", reason: "git-busy", deferredSince: at, reasonSince: at, lastSeen: at } },
      },
    },
  });
  await fs.rm(lock);
  const output = await captureStatusWithDeps({ git: true }, cleanScanDeps());
  expect(output).not.toContain("git deferred");
  expect(repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.deferrals).toBeUndefined();
});

test("reset-journal halt renders text and JSON without dereferencing state", async () => {
  const journal = path.join(root, ".rbox", "state", "reset-v1.json");
  await fs.mkdir(path.dirname(journal), { recursive: true });
  await fs.writeFile(journal, "{malformed");
  const brief = await captureStatus({});
  expect(brief).toContain("sync halted to protect recovery state · rbox doctor reset-journal");
  expect(brief).not.toContain("malformed reset journal");
  const text = await captureStatus({ verbose: true });
  expect(text).toContain("sync halted: a state-recovery record can't be processed");
  expect(text).toContain("Files on disk are untouched");
  expect(text).toContain("rbox doctor reset-journal");
  const json = JSON.parse(await captureStatus({ json: true }));
  expect(json).toMatchObject({ halted: true, daemon: { running: false } });
  expect(json.reason).toContain("malformed reset journal JSON");
  expect(json.local).toBeUndefined();
  expect(json.remote).toBeUndefined();
});

test("stale daemon halt record with no journal renders recovering and remains read-only", async () => {
  await writeResetHaltHealth(root, {
    reason: "old halt",
    journalIdentity: "a".repeat(64),
    haltedAt: "2026-07-17T12:00:00.000Z",
  });
  const json = JSON.parse(await captureStatus({ json: true }));
  expect(json).toMatchObject({ halted: true, reason: "recovering" });
  expect(await fs.lstat(path.join(root, ".rbox", "state", "health-halt.json"))).toBeDefined();
});

test("status text and JSON expose only closed locking health", async () => {
  await fs.mkdir(path.dirname(lockingHealthPath(root)), { recursive: true });
  await fs.writeFile(lockingHealthPath(root), JSON.stringify({ status: "degraded-unlocked", reason: "identity-unavailable" }));
  const text = await captureStatus({ verbose: true });
  const lockingLine = text.split("\n").find((line) => line.includes("locking:")) ?? "";
  expect(lockingLine).toContain("locking: degraded-unlocked: identity-unavailable (.rbox/state/sync.lock)");
  expect(lockingLine).not.toContain(root);

  const json = JSON.parse(await captureStatus({ json: true })) as any;
  expect(json.locking).toEqual({
    status: "degraded-unlocked",
    reason: "identity-unavailable",
    path: ".rbox/state/sync.lock",
  });
});

test("status loads credentials once and continues locally with credential-degraded", async () => {
  let loads = 0;
  const d = cleanScanDeps();
  d.loadCredentials = async () => {
    loads++;
    return { state: "invalid-environment", variable: "RBOX_API", detail: "RBOX_API must be absolute" };
  };
  const text = await captureStatusWithDeps({}, d);
  expect(loads).toBe(1);
  expect(text).toContain("Credential degraded");
  expect(text).toContain("invalid-environment");
});

test("status exposes a durable starvation warning without holder details", async () => {
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state", "lock-starvation.json"), JSON.stringify({
    holderKey: "a".repeat(64), firstSeenAt: NOW - 900_000, warnedAt: NOW,
  }));
  await fs.mkdir(path.dirname(daemonDatedLogPath(root, new Date(NOW))), { recursive: true });
  await fs.writeFile(daemonDatedLogPath(root, new Date(NOW)), `${new Date(NOW).toISOString()} lock starved: reason=foreign age=15m\n`);
  const json = JSON.parse(await captureStatus({ json: true })) as any;
  expect(json.locking).toEqual({ status: "starved", reason: "foreign", path: ".rbox/state/sync.lock" });
  expect(JSON.stringify(json.locking)).not.toContain("a".repeat(64));
});

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
    await statusCmdWithDeps(root, { verbose: true }, deps());
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
  await saveStateUnsafeLegacyOrTest(root, {
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
    await statusCmdWithDeps(root, { verbose: true }, scanDeps());
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
  d.gitDivergenceStatus = async () => ({ count: 1, deferrals: [], configChecking: ["repo"], configDisabled: [], conflictSnapshots: { total: 0, prunable: 0 } });

  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await statusCmdWithDeps(root, { verbose: true }, d);
  } finally {
    console.log = oldLog;
  }

  const out = lines.join("\n");
  expect(out).toContain("git changes in 1 repo");
  expect(out).toContain("config: checking (repo)");
});

test("status renders durable lanes oldest-first with reason precedence and safe checkout labels", async () => {
  await saveDeferralState();
  const out = await captureStatus({ verbose: true });
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

test("status --git aggregate and detail use one consistent repo projection", async () => {
  await saveDeferralState();
  const out = await captureStatus({ git: true });
  expect(out).toContain("⚠ 3 git repos need attention (oldest: 14 days) · rbox status --git");
  const details = out.split("\n").filter((line) => line.includes("git deferred "));
  expect(details).toHaveLength(3);
  expect(details[0]).toContain("local commits on detached checkout (zeta)");
  expect(details[1]).toContain("local edits on branch release/0.9 (alpha)");
  expect(details[2]).toContain("git busy on checkout unavailable (beta)");
  expect(out).toContain("Stop Git mutation, then let normal sync retry.");
  expect(out).not.toContain("0123456789abcdef");
});

test("full and --git status add one actionable companion while JSON and the shared line stay frozen", async () => {
  const at = new Date(NOW - 3_600_000).toISOString();
  const pending = {
    bundleSha: "1".repeat(64),
    bundleEncSha: "2".repeat(64),
    bundleCipherSize: 1,
    head: "ref: refs/heads/main\n",
    refs: { "refs/heads/main": "3".repeat(40) },
    refScope: "all" as const,
  };
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: at, files: [] },
    repoRecords: {
      repo: {
        repoGen: 1,
        sourceSeq: 7,
        pending,
        deferrals: {
          apply: {
            lane: "apply",
            reason: "local-commits",
            deferredSince: at,
            reasonSince: at,
            lastSeen: at,
            checkout: { kind: "branch", label: "main" },
          },
        },
      },
    },
  });

  const frozen = "git deferred 1h: local commits on branch main (repo)";
  const guidance = "To publish my work, run `rbox git resolve <repo> keep-mine`; `take-theirs` discards my local changes and follows incoming.";
  for (const options of [{ verbose: true }, { git: true }]) {
    const human = await captureStatus(options);
    expect(human.split("\n").filter((line) => line.trim() === frozen)).toHaveLength(1);
    expect(human.split(guidance)).toHaveLength(2);
    expect(human.match(/Your repository is healthy; only rbox's bookkeeping is paused/g)).toHaveLength(1);
  }

  const jsonText = await captureStatus({ json: true });
  expect(jsonText).not.toContain("bookkeeping");
  expect(jsonText).not.toContain("keep-mine");
  expect(JSON.parse(jsonText).git.deferrals).toEqual([{
    repo: "repo",
    lane: "apply",
    reason: "local-commits",
    deferredSince: at,
    reasonSince: at,
    ageSeconds: 3600,
    bytesChanged: false,
    checkout: { kind: "branch", label: "main" },
  }]);
});

test("degraded legacy deferral reload retains status reason and age", async () => {
  const deferredSince = new Date(NOW - 15 * 86400_000).toISOString();
  await saveStateUnsafeLegacyOrTest(root, {
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
  const out = await captureStatus({ verbose: true });
  expect(out).toContain("git-sync: 0 repos synced · 1 deferred");
  expect(out).toContain("git deferred 14d: needs Git >= 2.46 transactional symref-update; found git version");
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

test("status and git deferrals JSON dispatches serialize identical lane arrays", async () => {
  await saveDeferralState();
  const status = JSON.parse(await captureDispatch(["status", "--json"]));
  const deferrals = JSON.parse(await captureDispatch(["git", "deferrals", "--json"]));
  expect(deferrals.deferrals).toEqual(status.git.deferrals);
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
    conflictSnapshots: { total: 3, prunable: 2 },
  });
  const lines: string[] = [];
  const oldLog = console.log;
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    await statusCmdWithDeps(root, { verbose: true }, d);
  } finally {
    console.log = oldLog;
  }
  const out = lines.join("\n");
  expect(out).toContain("1 git repo deferred");
  expect(out).toContain("git-sync: 0 repos synced · 1 deferred");
  expect(out).toContain("conflict snapshots: 3 (2 prunable)");
  expect(out).not.toContain("✓ in sync");
  expect(out.split("\n").filter((line) => line.includes("git deferred "))).toHaveLength(0);
});

test("human status quiets only transient deferrals younger than ten minutes while JSON retains every lane", async () => {
  const young = new Date(NOW - 9 * 60_000).toISOString();
  const boundary = new Date(NOW - 10 * 60_000).toISOString();
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: new Date(NOW - 20_000).toISOString(), files: [] },
    repoRecords: {
      "young-transient": {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: { capture: { lane: "capture", reason: "local-commits", deferredSince: young, reasonSince: young, lastSeen: young } },
      },
      "boundary-transient": {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: { capture: { lane: "capture", reason: "local-commits", deferredSince: boundary, reasonSince: boundary, lastSeen: boundary } },
      },
      "young-durable": {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: { apply: { lane: "apply", reason: "conflict", deferredSince: young, reasonSince: young, lastSeen: young } },
      },
      mixed: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: {
          capture: { lane: "capture", reason: "local-commits", deferredSince: young, reasonSince: young, lastSeen: young },
          apply: { lane: "apply", reason: "conflict", deferredSince: young, reasonSince: young, lastSeen: young },
        },
      },
    },
  });

  const human = await captureStatus({ git: true });
  expect(human).toContain("⚠ 3 git repos need attention");
  expect(human).not.toContain("(young-transient)");
  expect(human).toContain("(boundary-transient)");
  expect(human).toContain("(young-durable)");
  expect(human).toContain("(mixed)");

  const json = JSON.parse(await captureStatus({ json: true }));
  expect(json.git.deferrals.map((lane: { repo: string }) => lane.repo)).toEqual([
    "boundary-transient",
    "mixed",
    "mixed",
    "young-durable",
    "young-transient",
  ]);
  expect(json.git.deferredRepos).toHaveLength(4);
});

test("human status shows conflict snapshots only when pruning is actionable while JSON always keeps counts", async () => {
  cfg.syncGit = true;
  await saveConfig(root, cfg);
  const d = cleanScanDeps();
  d.gitDivergenceStatus = async () => ({
    count: 0,
    deferrals: [],
    configChecking: [],
    configDisabled: [],
    conflictSnapshots: { total: 1710, prunable: 0 },
  });

  expect(await captureStatusWithDeps({}, d)).not.toContain("conflict snapshots:");
  expect(await captureStatusWithDeps({ verbose: true }, d)).not.toContain("conflict snapshots:");
  expect(JSON.parse(await captureStatusWithDeps({ json: true }, d)).git.conflictSnapshots).toEqual({ total: 1710, prunable: 0 });

  d.gitDivergenceStatus = async () => ({
    count: 0,
    deferrals: [],
    configChecking: [],
    configDisabled: [],
    conflictSnapshots: { total: 1710, prunable: 12 },
  });
  expect(await captureStatusWithDeps({}, d)).toContain("conflict snapshots: 1710 (12 prunable)");
  expect(await captureStatusWithDeps({ verbose: true }, d)).toContain("conflict snapshots: 1710 (12 prunable)");
});

test("status returns the effective daemon state in text and json modes", async () => {
  const d = cleanScanDeps();
  d.daemonBindingStatus = () => ({ alive: { running: true, pid: 1234, bootId: "boot_status" }, bound: cfg.remoteWorkspaceId, stale: false });
  d.readDaemonPidRecord = () => ({ present: true });
  const oldLog = console.log;
  const oldWrite = process.stdout.write;
  console.log = () => {};
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    expect(await statusCmdWithDeps(root, {}, d)).toEqual({ daemonRunning: true });
    expect(await statusCmdWithDeps(root, { json: true }, d)).toEqual({ daemonRunning: true });
    d.daemonBindingStatus = () => ({ alive: { running: true, pid: 1234, bootId: "boot_status" }, bound: "ws_previous", stale: true });
    expect(await statusCmdWithDeps(root, { json: true }, d)).toEqual({ daemonRunning: false });
  } finally {
    console.log = oldLog;
    process.stdout.write = oldWrite;
  }
});

test("default suppresses real legacy daemon/history/footer facts while --verbose retains them", async () => {
  const d = cleanScanDeps();
  d.daemonBindingStatus = () => ({ alive: { running: true, pid: 1234, bootId: "boot_status" }, bound: cfg.remoteWorkspaceId, stale: false });
  d.readDaemonPidRecord = () => ({ present: true });
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "state", "activity.json"), JSON.stringify({
    at: new Date(NOW).toISOString(),
    lastPush: { at: new Date(NOW - 60_000).toISOString(), files: 3, sequence: 7 },
  }));
  const brief = await captureStatusWithDeps({}, d);
  const verbose = await captureStatusWithDeps({ verbose: true }, d);
  for (const fragment of ["background sync:", "locking:", "last push:", "device dev_status", "sequence 0", "files on disk"]) {
    expect(brief).not.toContain(fragment);
    expect(verbose).toContain(fragment);
  }
  expect(brief).toContain("syncing normally");
});

test("status --verbose preserves the complete legacy text golden byte for byte", async () => {
  expect(await captureStatus({ verbose: true })).toBe([
    `workspace ws_status @ ${root} · rbox ${RBOX_VERSION}`,
    "  ✓ in sync — 0 files",
    "  background sync: stopped",
    "  locking: ok (.rbox/state/sync.lock)",
    "  device dev_status · sequence 0 · 0 files on disk",
    "account not signed in (run `rbox login`)",
  ].join("\n"));
});

test("JSON adds optional top-level haltReason and otherwise keeps the detailed path", async () => {
  const d = cleanScanDeps();
  d.daemonBindingStatus = () => ({ alive: { running: true, pid: 1234, bootId: "boot_status" }, bound: cfg.remoteWorkspaceId, stale: false });
  d.readDaemonPidRecord = () => ({ present: true });
  const activityPath = path.join(root, ".rbox", "state", "activity.json");
  await fs.mkdir(path.dirname(activityPath), { recursive: true });
  await fs.writeFile(activityPath, JSON.stringify({ at: new Date(NOW).toISOString() }));
  const healthy = JSON.parse(await captureStatusWithDeps({ json: true }, d));
  expect(healthy.haltReason).toBeUndefined();
  await fs.writeFile(activityPath, JSON.stringify({
    at: new Date(NOW).toISOString(),
    halt: { at: new Date(NOW).toISOString(), reason: "private raw daemon reason", count: 1, op: "push", typedReason: { kind: "body-too-large" } },
  }));
  const halted = JSON.parse(await captureStatusWithDeps({ json: true }, d));
  expect(halted).toEqual({ ...healthy, health: "halt", haltReason: "private raw daemon reason" });
});

test("review M4: stopped daemon renders a persisted recovery as a halt, not an armed timer", async () => {
  await saveActivity(root, {
    at: new Date(NOW).toISOString(),
    halt: {
      at: new Date(NOW - 30_000).toISOString(),
      reason: "push conflict",
      count: 1,
      op: "push",
      nextProbeAt: new Date(NOW + 60_000).toISOString(),
      recoveryState: "armed",
      typedReason: { kind: "push-conflict" },
    },
  });

  const out = await captureStatusWithDeps({}, cleanScanDeps());

  expect(out).toContain("sync halted — see rbox logs");
  expect(out).toContain("background sync is stopped · rbox start");
  expect(out).not.toContain("retrying after conflict");
  expect(out).not.toContain("next probe");
});

test("review M6: status hygiene failures retain deferrals through both call sites", async () => {
  const at = new Date(NOW - 15 * 86400_000).toISOString();
  const stream = syncStreamId(cfg);
  await saveStateUnsafeLegacyOrTest(root, {
    stream,
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: at, files: [] },
    repoRecords: {
      repo: {
        repoGen: 1,
        sourceSeq: 7,
        deferrals: { capture: { lane: "capture", reason: "git-busy", deferredSince: at, reasonSince: at, lastSeen: at } },
      },
    },
  });
  await saveActivity(root, {
    at: new Date(NOW).toISOString(),
    local: {
      at: new Date(NOW).toISOString(), stream, baseSequence: 6, trackedFiles: 0,
      added: 0, changed: 0, deleted: 0, settled: true, sourceVersion: 1,
    },
  });
  let calls = 0;
  const d = cleanScanDeps();
  d.reconcileGitDeferrals = async () => {
    calls++;
    throw new Error("hygiene unavailable");
  };

  const out = await captureStatusWithDeps({}, d);

  expect(calls).toBe(2);
  expect(out).toContain("1 git repo needs attention");
  expect(repoRecordsForState(await loadState(root, stream)).repo?.deferrals?.capture?.reason).toBe("git-busy");
});

test("all conflicting status presentation flag pairs are rejected", async () => {
  for (const opts of [
    { json: true, verbose: true },
    { json: true, git: true },
    { verbose: true, git: true },
  ]) {
    await expect(statusCmdWithDeps(root, opts, cleanScanDeps())).rejects.toThrow("choose only one status presentation flag");
  }
});

test("CLI dispatch rejects every conflicting presentation pair after boolean flag parsing", async () => {
  const previousArgv = process.argv;
  const previousExitCode = process.exitCode;
  const previousWrite = process.stderr.write;
  try {
    for (const args of [
      ["status", "--json", "--verbose"],
      ["status", "--json", "--git"],
      ["status", "--verbose", "--git"],
    ]) {
      let stderr = "";
      process.argv = [process.execPath, "rbox", ...args];
      process.exitCode = 0;
      process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
        return true;
      }) as typeof process.stderr.write;
      await main({ now: () => new Date(NOW) });
      expect(process.exitCode).toBe(1);
      expect(stderr).toContain("choose only one status presentation flag: --json, --verbose, or --git");
    }
  } finally {
    process.argv = previousArgv;
    process.exitCode = previousExitCode ?? 0;
    process.stderr.write = previousWrite;
  }
});

test("live daemon version is rendered and exact skew warning is closed in human and JSON output", async () => {
  const d = cleanScanDeps();
  let promotions = 0;
  d.promotePendingModeIntent = async (promotedRoot) => {
    expect(promotedRoot).toBe(root);
    promotions++;
    return true;
  };
  d.daemonBindingStatus = () => ({ alive: { running: true, pid: 1234, bootId: "boot_status" }, bound: cfg.remoteWorkspaceId, stale: false });
  d.readDaemonPidRecord = () => ({ present: true });
  d.readAmbientDaemonStatusRecord = () => ({
    kind: "ok",
    status: { schemaVersion: 1, daemonVersion: "1.7.17", mode: "pull-only", bootId: "boot_status", state: "synced", heartbeatAt: new Date(NOW).toISOString(), sequence: 7, lastSyncedAt: null },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  const oldWrite = process.stdout.write;
  console.log = (...parts) => void logs.push(parts.join(" "));
  const stdout: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout.push(String(chunk)); return true; }) as typeof process.stdout.write;
  try {
    await statusCmdWithDeps(root, { verbose: true }, d);
    expect(promotions).toBe(1);
    expect(logs.join("\n")).toContain("background sync: running (v1.7.17, pull-only) (pid 1234)");
    expect(logs.join("\n")).toContain(`daemon is running v1.7.17 but this CLI is v${RBOX_VERSION} — restart to finish the upgrade: rbox stop && rbox start`);
    await statusCmdWithDeps(root, { json: true }, d);
    expect(promotions).toBe(2);
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ daemon: { version: "1.7.17", mode: "pull-only", cliVersion: RBOX_VERSION, versionSkew: true } });
    d.readAmbientDaemonStatusRecord = () => ({
      kind: "ok",
      status: { schemaVersion: 1, daemonVersion: RBOX_VERSION, mode: "read-write", bootId: "boot_status", state: "synced", heartbeatAt: new Date(NOW).toISOString(), sequence: 7, lastSyncedAt: null },
    });
    logs.length = 0;
    await statusCmdWithDeps(root, { verbose: true }, d);
    expect(promotions).toBe(3);
    expect(logs.join("\n")).toContain(`(v${RBOX_VERSION}, read-write)`);
    expect(logs.join("\n")).not.toContain("restart to finish the upgrade");
    d.readAmbientDaemonStatusRecord = () => ({
      kind: "ok",
      status: { schemaVersion: 1, daemonVersion: RBOX_VERSION, mode: "pull-only", bootId: "boot_stale", state: "synced", heartbeatAt: new Date(NOW).toISOString(), sequence: 7, lastSyncedAt: null },
    });
    logs.length = 0;
    await statusCmdWithDeps(root, { verbose: true }, d);
    expect(promotions).toBe(4);
    expect(logs.join("\n")).toContain(`background sync: running (v${RBOX_VERSION}) (pid 1234)`);
    expect(logs.join("\n")).not.toContain("pull-only");
    d.daemonBindingStatus = () => ({ alive: { running: false }, stale: false });
    stdout.length = 0;
    await statusCmdWithDeps(root, { json: true }, d);
    expect(promotions).toBe(4);
    expect(JSON.parse(stdout.at(-1)!)).toMatchObject({ daemon: { version: null, mode: null, versionSkew: false } });
  } finally {
    console.log = oldLog;
    process.stdout.write = oldWrite;
  }
});

test("live ambient record without daemonVersion is tolerated without display or warning", async () => {
  const d = cleanScanDeps();
  d.daemonBindingStatus = () => ({ alive: { running: true, pid: 1234 }, bound: cfg.remoteWorkspaceId, stale: false });
  d.readAmbientDaemonStatusRecord = () => ({
    kind: "ok",
    status: { schemaVersion: 1, state: "synced", heartbeatAt: new Date(NOW).toISOString(), sequence: 7, lastSyncedAt: null },
  });
  const logs: string[] = [];
  const oldLog = console.log;
  console.log = (...parts) => void logs.push(parts.join(" "));
  try {
    await statusCmdWithDeps(root, { verbose: true }, d);
  } finally {
    console.log = oldLog;
  }
  expect(logs.join("\n")).toContain("background sync: running (pid 1234)");
  expect(logs.join("\n")).not.toContain(" (v");
  expect(logs.join("\n")).not.toContain("restart to finish the upgrade");
});

test("one repo with multiple lanes renders one repo-level line and count", async () => {
  const at = new Date(NOW - 86_400_000).toISOString();
  await saveStateUnsafeLegacyOrTest(root, {
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
  const out = await captureStatus({ verbose: true });
  expect(out).toContain("1 git repo deferred");
  expect(out).toContain("git-sync: 0 repos synced · 1 deferred");
  const rows = out.split("\n").filter((line) => line.includes("git deferred "));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toContain("local edits");
});
