import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { daemonRuntimeDir, readMergedDaemonLogTail } from "./daemon-control.js";
import {
  buildDiagnosticsBundle,
  checkDeviceIdentity,
  collectDoctorContext,
  collectLeftoverWorktrees,
  collectRepoResidue,
  doctorCmd,
  presentDiagnosticsPreview,
  redactGitLogLines,
  renderDoctor,
  type DiagnosticsBundle,
  type DoctorChecks,
  type DoctorContext,
} from "./doctor-cmd.js";
import { CONFLICT_COPY_POPULATION_WHY } from "../engine/apply-receipt.js";
import { git } from "../engine/git-spawn.js";
import { gitDeferralReasonPresentation } from "./status-view.js";
import { gitIdentity, gitIdentityKey } from "./sync-git/identity.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId } from "./config.js";
import { saveDevice } from "./e2ee-keystore.js";
import { bootstrapAccount } from "../engine/e2ee/index.js";
import { saveCredentials } from "./credentials.js";
import { GENESIS_PENDING_MESSAGE, publishPrepublishMarker } from "./genesis-durable.js";
import { loadActivity } from "./activity.js";
import { loadMetrics } from "./metrics.js";
import type { DaemonObservation } from "./daemon/observation.js";
import { observeWorkspace, type LocalWorkspaceObservation } from "./workspace-observation.js";

let home: string;
let logs: string[];
let savedEnv: Record<string, string | undefined>;
const origLog = console.log;
const origFetch = globalThis.fetch;
const stdinTty = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
const bunVersion = () => (process.versions as NodeJS.ProcessVersions & { bun?: string }).bun ?? "unknown";

function contextObservation(
  root: string,
  sidecarBinding: DaemonObservation["sidecarBinding"],
): LocalWorkspaceObservation {
  return {
    depth: "local",
    root,
    observedAt: Date.parse("2026-07-03T00:00:00.000Z"),
    config: {
      schema: "e2ee/v1",
      remoteWorkspaceId: "ws_diag",
      projectId: "root",
      rootPath: root,
      remoteUrl: "https://api.test",
      token: "",
      deviceId: "dev_1",
    },
    daemon: {
      ownership: "stopped",
      running: false,
      stale: false,
      ownsRoot: false,
      ownsWorkspace: false,
      sidecarBinding,
      ambient: { kind: "absent" },
      ambientTrust: "absent",
    },
    readActivity: async () => undefined,
    readDaemonSidecars: async () =>
      sidecarBinding === "other-workspace" || sidecarBinding === "unreadable"
        ? undefined
        : {
            daemonLogTail: await readMergedDaemonLogTail(root, 64 * 1024),
            metrics: await loadMetrics(root),
            activity: await loadActivity(root),
          },
    deferrals: [],
    adopt: { status: "none" },
  };
}

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
const emptyWorktrees = {
  localOnly: {
    leftoverWorktrees: { count: 0, entries: [] },
    repoResidue: { count: 0, entries: [], quarantine: [], bytesMeasured: false },
  },
  diagnostics: {
    leftoverWorktrees: { count: 0, entries: [] },
    repoResidue: {
      count: 0,
      gitPresent: 0,
      rboxPresent: 0,
      identity: { match: 0, mismatch: 0, unknown: 0 },
      quarantinePresent: 0,
    },
  },
};

beforeEach(async () => {
  savedEnv = Object.fromEntries([
    "RBOX_HOME", "HOME", "RBOX_DIAGNOSTICS", "RBOX_TOKEN", "RBOX_DEVICE_ID", "RBOX_API",
  ].map((key) => [key, process.env[key]]));
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
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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
    leftoverWorktrees: { count: 0, entries: [] },
    repoResidue: {
      count: 0,
      gitPresent: 0,
      rboxPresent: 0,
      identity: { match: 0, mismatch: 0, unknown: 0 },
      quarantinePresent: 0,
    },
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
    calls.push(input instanceof URL ? input.toString() : input instanceof Request ? input.url : input);
    return Promise.resolve(new Response("disabled in test", { status: 503 }));
  }) as typeof fetch;
  return calls;
}

test("configured-uninitialized doctor renders current indeterminate and I/O probes from central copy", async () => {
  const cases = [
    {
      code: "EPERM",
      id: "state-genesis/lock-indeterminate",
      problem: "rbox couldn't create the lock it needs in this folder. Check this folder's permissions and storage or security policy, then run the same command again. If it still fails, run rbox doctor.",
    },
    {
      code: "EIO",
      id: "state-genesis/lock-io",
      problem: "rbox couldn't complete a storage operation needed to create, verify, or clean up the lock in this folder. Check that the disk has free space and that this folder is readable and writable, then run the same command again. If it still fails, run rbox doctor.",
    },
  ] as const;
  for (const row of cases) {
    const root = await makeWorkspace();
    const link = spyOn(fs, "link").mockRejectedValue(Object.assign(new Error(row.code), { code: row.code }));
    try {
      const locking = (await collectDoctorContext(root)).checks.locking;
      expect(locking).toEqual({
        ok: false,
        label: "locking",
        status: row.id,
        message: row.problem,
        finding: {
          id: row.id,
          severity: "blocked",
          problem: row.problem,
          safety: "Your files are safe. rbox stopped before syncing or changing any more files; synced copies on the server and other computers were not changed.",
        },
      });
    } finally {
      link.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

test("doctor remains available during pending genesis, reports the resume path, and refuses diagnostics upload", async () => {
  const root = await makeWorkspace();
  const accountId = "acct_cccccccccccccccc";
  await saveCredentials({ token: "tok", deviceId: "dev_1", accountId, remoteUrl: "https://api.test" });
  await publishPrepublishMarker({
    version: 1,
    accountId,
    deviceId: "dev_1",
    repairId: null,
    startedAt: "2026-07-22T12:00:00.000Z",
    phase: "prepublish",
  });
  const calls = recordFetches();
  try {
    const context = await collectDoctorContext(root);
    expect(context.checks.enrollment).toMatchObject({
      ok: false,
      message: "genesis enrollment is pending",
      hint: GENESIS_PENDING_MESSAGE,
    });

    await expect(doctorCmd(root, { report: true, yes: true, diagnostics: true })).rejects.toThrow(GENESIS_PENDING_MESSAGE);
    expect(calls.some((url) => url.endsWith("/v1/diagnostics"))).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("review L1: diagnostics classifies stale-unattributed before generic lock fallback", () => {
  const redacted = redactGitLogLines(
    "2026-07-13T12:00:00.000Z git deferred 14d: stale-unattributed locks remain on checkout unavailable (private/repo)\n",
  );
  expect(redacted).toContain("git-sync deferred reason=stale-unattributed age=14d");
  expect(redacted).not.toContain("reason=git-busy");
  expect(redacted).not.toContain("private/repo");
});

test("diagnostics classifies a deleted branch before the local-commits fallback", () => {
  const redacted = redactGitLogLines(
    "2026-07-13T12:00:00.000Z git-sync deferred private/repo: branch deleted here (held refs: refs/heads/private)\n",
  );
  expect(redacted).toContain("git-sync deferred reason=deletion-pending age=-");
  expect(redacted).not.toContain("reason=local-commits");
  expect(redacted).not.toContain("private/repo");
});

test("Step-D forensic grammar survives doctor redaction as deletion-pending", () => {
  const redacted = redactGitLogLines(
    "2026-07-13T12:00:00.000Z git-sync deferred private/repo: finishing branch deletion: packed-refs mtime regressed while a BASE branch was absent\n",
  );
  expect(redacted).toContain("git-sync deferred reason=deletion-pending age=-");
  expect(redacted).not.toContain("private/repo");
  expect(redacted).not.toContain("packed-refs");
});

test("diagnostics preserves the strict ref-read refusal class", () => {
  const redacted = redactGitLogLines(
    "2026-07-13T12:00:00.000Z git-sync deferred repo: ref-read-unreadable exit-128\n",
  );
  expect(redacted).toContain("git-sync deferred reason=ref-read-unreadable age=-");
});

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
  const root = await makeWorkspace();
  try {
    const runtime = daemonRuntimeDir(root);
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(path.join(runtime, "workspace.bound"), "ws_previous\n");
    await fs.writeFile(path.join(runtime, "daemon.log"), "previous workspace path src/secret.ts\n");
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
      checks,
      workspaceSize: { fileCount: 2, totalBytes: 99 },
      observation: await observeWorkspace(root, { depth: "local" }),
      ...emptyWorktrees,
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

test("diagnostics emits no sidecar bytes when local observation denies attribution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-doctor-rebind-"));
  const cfg = contextObservation(root, "workspace").config;
  try {
    const observation = contextObservation(root, "workspace");
    observation.readDaemonSidecars = async () => undefined;
    const ctx: DoctorContext = {
      root,
      cfg,
      checks,
      workspaceSize: { fileCount: 0, totalBytes: 0 },
      observation,
      ...emptyWorktrees,
    };

    const bundle = await buildDiagnosticsBundle(ctx);
    expect(bundle.daemonLogTail).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.metrics).toEqual({ excluded: "stale daemon binding" });
    expect(bundle.activity).toEqual({ excluded: "stale daemon binding" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("design 200 P2: doctor prints absolute leftover paths but the bundle contains only the redacted projection", async () => {
  const root = await makeWorkspace();
  const privateParent = await fs.mkdtemp(path.join(os.tmpdir(), "doctor-private-parent-"));
  const linked = path.join(privateParent, "private-linked-name");
  try {
    const repo = path.join(root, "repo");
    await fs.mkdir(repo, { recursive: true });
    await git(repo, ["init", "-qb", "main"]);
    await git(repo, ["config", "user.email", "doctor@example.invalid"]);
    await git(repo, ["config", "user.name", "doctor"]);
    await fs.writeFile(path.join(repo, "tracked"), "one\n");
    await git(repo, ["add", "tracked"]);
    await git(repo, ["commit", "-qm", "one"]);
    const tip = (await git(repo, ["rev-parse", "HEAD"])).trim();
    await git(repo, ["branch", "held", tip]);
    await git(repo, ["worktree", "add", "-q", linked, "held"]);

    const cfg = {
      schema: "e2ee/v1" as const,
      remoteWorkspaceId: "ws_diag",
      projectId: "root",
      rootPath: root,
      remoteUrl: "https://api.test",
      token: "",
      deviceId: "dev_1",
      syncGit: true,
    };
    const section = {
      bundleSha: "1".repeat(64),
      bundleEncSha: "2".repeat(64),
      bundleCipherSize: 1,
      head: "ref: refs/heads/main\n",
      refs: { "refs/heads/main": tip, "refs/heads/held": tip },
      refScope: "all" as const,
    };
    await saveStateUnsafeLegacyOrTest(root, {
      stream: syncStreamId(cfg),
      stateNonce: "a".repeat(32),
      lastSyncedSequence: 1,
      lastSyncedManifest: {
        generatedAt: "2026-07-25T00:00:00.000Z",
        files: [],
        manifestSchema: 2,
        gitRepos: { repo: section },
      },
    });

    const worktrees = await collectLeftoverWorktrees(root, cfg);
    expect(worktrees.localOnly).toEqual({
      count: 1,
      entries: [{
        branch: "refs/heads/held",
        path: linked,
        prunable: false,
        holdsSyncedRef: true,
      }],
    });
    expect(worktrees.diagnostics).toEqual({
      count: 1,
      entries: [{
        branch: "refs/heads/held",
        prunable: false,
        holdsSyncedRef: true,
      }],
    });

    const ctx: DoctorContext = {
      root,
      cfg,
      checks,
      workspaceSize: { fileCount: 1, totalBytes: 4 },
      observation: contextObservation(root, "other-workspace"),
      localOnly: { leftoverWorktrees: worktrees.localOnly },
      diagnostics: { leftoverWorktrees: worktrees.diagnostics },
    };
    const printed = renderDoctor(ctx.checks, ctx.localOnly);
    expect(printed).toContain("leftover worktrees: 1");
    expect(printed).toContain(linked);
    expect(printed).toContain("refs/heads/held");
    expect(printed).toContain("prunable no");
    expect(printed).toContain("holds synced ref yes");

    const payload = JSON.stringify(await buildDiagnosticsBundle(ctx));
    expect(payload).toContain("\"leftoverWorktrees\"");
    expect(payload).toContain("\"holdsSyncedRef\":true");
    for (const secret of [linked, path.basename(linked), path.basename(privateParent)]) {
      expect(payload).not.toContain(secret);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(privateParent, { recursive: true, force: true });
  }
});

test("207.7: repo residue is local-only, verdicts are neutral, and quarantine sizing is opt-in", async () => {
  const root = await makeWorkspace();
  try {
    const cfg = {
      schema: "e2ee/v1" as const,
      remoteWorkspaceId: "ws_diag",
      projectId: "root",
      rootPath: root,
      remoteUrl: "https://api.test",
      token: "",
      deviceId: "dev_1",
      syncGit: true,
    };
    const initCommittedRepo = async (rel: string): Promise<string> => {
      const repo = path.join(root, rel);
      await fs.mkdir(repo, { recursive: true });
      await git(repo, ["init", "-qb", "main"]);
      await git(repo, ["config", "user.email", "doctor@example.invalid"]);
      await git(repo, ["config", "user.name", "doctor"]);
      await fs.writeFile(path.join(repo, "tracked"), `${rel}\n`);
      await git(repo, ["add", "tracked"]);
      await git(repo, ["commit", "-qm", rel]);
      return repo;
    };
    const matchRepo = await initCommittedRepo("private-match-repo");
    const mismatchRepo = await initCommittedRepo("private-mismatch-repo");
    const currentRepo = await initCommittedRepo("current-repo");
    const unknownRepo = path.join(root, "private-unknown-repo");
    await fs.mkdir(unknownRepo);
    await fs.mkdir(path.join(matchRepo, ".rbox", "git-quarantine"), { recursive: true });
    await fs.writeFile(path.join(matchRepo, ".rbox", "git-quarantine", "kept.bundle"), "kept\n");

    const tip = (await git(currentRepo, ["rev-parse", "HEAD"])).trim();
    const currentSection = {
      bundleSha: "1".repeat(64),
      bundleEncSha: "2".repeat(64),
      bundleCipherSize: 1,
      head: "ref: refs/heads/main\n",
      refs: { "refs/heads/main": tip },
      refScope: "all" as const,
    };
    const matchKey = gitIdentityKey(await gitIdentity(matchRepo));
    await saveStateUnsafeLegacyOrTest(root, {
      stream: syncStreamId(cfg),
      stateNonce: "b".repeat(32),
      lastSyncedSequence: 2,
      lastSyncedManifest: {
        generatedAt: "2026-07-26T00:00:00.000Z",
        files: [],
        manifestSchema: 2,
        gitRepos: { "current-repo": currentSection },
      },
      gitReposRemoved: {
        "private-match-repo": matchKey,
        "private-mismatch-repo": "not-the-live-identity",
        "private-unknown-repo": "no-readable-git",
        "private-absent-repo": "phantom-must-not-render",
      },
    });
    await fs.mkdir(path.join(root, ".rbox", "git-quarantine"), { recursive: true });
    await fs.writeFile(path.join(root, ".rbox", "git-quarantine", "retired.git"), "retired\n");
    await fs.mkdir(path.join(currentRepo, ".rbox", "git-quarantine"), { recursive: true });
    await fs.writeFile(path.join(currentRepo, ".rbox", "git-quarantine", "local.bundle"), "bundle\n");
    await fs.mkdir(path.join(currentRepo, ".rbox", "git-conflicts"), { recursive: true });
    await fs.writeFile(path.join(currentRepo, ".rbox", "git-conflicts", "conflict.bundle"), "conflict\n");

    const presence = await collectRepoResidue(root, cfg);
    expect(presence.localOnly.entries.map(({ rel, identity }) => ({ rel, identity }))).toEqual([
      { rel: "private-match-repo", identity: "match" },
      { rel: "private-mismatch-repo", identity: "mismatch" },
      { rel: "private-unknown-repo", identity: "unknown" },
    ]);
    expect(presence.localOnly.entries.find((entry) => entry.rel === "private-match-repo")).toMatchObject({
      gitPresent: true,
      rboxPresent: true,
    });
    expect(presence.localOnly.quarantine.every((entry) => entry.bytes === undefined)).toBe(true);

    const localOnly = {
      leftoverWorktrees: { count: 0, entries: [] },
      repoResidue: presence.localOnly,
    };
    const printed = renderDoctor(checks, localOnly);
    expect(printed).toContain("leftover worktrees: 0");
    expect(printed).toContain("repo residue: 3");
    expect(printed).toContain(
      "left behind after 'private-match-repo' was removed on another machine — contains a local Git repository rbox will not delete. review it yourself before removing anything.",
    );
    expect(printed).toContain(`${matchRepo} · .git present · .rbox present · identity match`);
    expect(printed).toContain(`remove manually: rm -rf -- '${matchRepo}'`);
    expect(printed).not.toContain("private-absent-repo");
    expect(printed).toContain("workspace .rbox/git-quarantine: present · size not measured");
    expect(printed).toContain("current-repo/.rbox/git-conflicts: present · size not measured");

    const sized = await collectRepoResidue(root, cfg, { residueBytes: true });
    expect(sized.localOnly.bytesMeasured).toBe(true);
    expect(sized.localOnly.quarantine.filter((entry) => entry.present).every((entry) => (entry.bytes ?? -1) >= 0)).toBe(true);
    const sizedPrinted = renderDoctor(checks, {
      leftoverWorktrees: { count: 0, entries: [] },
      repoResidue: sized.localOnly,
    });
    expect(sizedPrinted).toContain("workspace .rbox/git-quarantine: size on disk");
    expect(sizedPrinted).toContain("current-repo/.rbox/git-quarantine: size on disk");
    expect(sizedPrinted).toContain("current-repo/.rbox/git-conflicts: size on disk");

    const ctx: DoctorContext = {
      root,
      cfg,
      checks,
      workspaceSize: { fileCount: 3, totalBytes: 1 },
      observation: contextObservation(root, "other-workspace"),
      localOnly,
      diagnostics: {
        leftoverWorktrees: { count: 0, entries: [] },
        repoResidue: presence.diagnostics,
      },
    };
    const payload = JSON.stringify(await buildDiagnosticsBundle(ctx));
    expect(payload).toContain("\"repoResidue\"");
    expect(payload).toContain("\"count\":3");
    expect(payload).toContain("\"match\":1");
    for (const secret of [
      matchRepo,
      mismatchRepo,
      unknownRepo,
      "private-match-repo",
      "private-mismatch-repo",
      "private-unknown-repo",
      "current-repo",
    ]) {
      expect(payload).not.toContain(secret);
    }
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
      workspaceSize: { fileCount: 1, totalBytes: 42 },
      // The REAL observation, reading the real records written above: the
      // exclusion has to come from production authorization, not a fixture.
      observation: await observeWorkspace(root, { depth: "local" }),
      ...emptyWorktrees,
    };

    expect(await readMergedDaemonLogTail(root, 64 * 1024)).toContain("src/secret.ts");
    expect(ctx.observation.daemon.sidecarBinding).toBe("other-workspace");

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
      workspaceSize: { fileCount: 1, totalBytes: 42 },
      observation: contextObservation(root, "absent"),
      ...emptyWorktrees,
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
      workspaceSize: { fileCount: 1, totalBytes: 42 },
      observation: contextObservation(root, "absent"),
      ...emptyWorktrees,
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
      workspaceSize: { fileCount: 1, totalBytes: 42 },
      observation: contextObservation(root, "absent"),
      ...emptyWorktrees,
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
      workspaceSize: { fileCount: 1, totalBytes: 42 },
      observation: contextObservation(root, "absent"),
      ...emptyWorktrees,
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

test("a conflict-copies hold buckets correctly through both doctor channels", () => {
  // The `why` half: asserted over the exported constant, never a literal — a
  // literal stays green if the constant drifts back to the singular.
  expect(redactGitLogLines(`git-sync deferred r: ${CONFLICT_COPY_POPULATION_WHY}`))
    .toBe("git-sync deferred reason=conflict-copies age=-");
  // The label half, read from its own seam for the same reason: the daemon's
  // `git deferred` line carries the rendered LABEL, not the why.
  const label = gitDeferralReasonPresentation("conflict-copies").label;
  expect(redactGitLogLines(`git deferred 1h: ${label} on branch main (r)`))
    .toBe("git-sync deferred reason=conflict-copies age=1h");
});
