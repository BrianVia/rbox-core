import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore, buildIgnoreMatcher, type GitSection, type Manifest } from "../engine/index.js";
import { captureGitState } from "./sync-git/capture.js";
import { setGitSpawnObserver } from "../engine/git-spawn.js";
import { checkoutJournalDir } from "../cli/sync-git/journal.js";
import { repoCtx } from "../cli/sync-git/git-state.js";
import { loadState, repoRecordsForState, saveStateUnsafeLegacyOrTest, syncStreamId, type RepoRecord, type SyncState, type WorkspaceConfig } from "./config.js";
import { gitDeferralsCmd } from "./git/deferrals-command.js";
import { gitResolveCmd } from "./git/resolve-command.js";
import { ManualBaseProofIncompleteError, ManualLineageProofUnavailableError } from "./git/resolve-contract.js";
import { safeResolveText, type GitResolveShow } from "./git/resolve-presentation.js";
import { applyGitSections } from "./sync-git/apply.js";
import { settleCommittedBranchArtifacts } from "./sync-git/received-git-transition-commit.js";
import { commitPlannedBranchTransition, planBranchTransition } from "./sync-git/branch-transition.js";
import { prepareFollowerBranchProtocol } from "./sync-git/follower-protocol.js";
import { gitFollowEnabled } from "./sync-git/shared.js";
import { acquireWorkspaceSyncMutex, releaseWorkspaceSyncMutex } from "./sync-mutex.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 41);

let tmp: string;
let sender: string;
let root: string;
let receiver: string;
let store: LocalBlobStore;
let cfg: WorkspaceConfig;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-git-resolve-"));
  sender = path.join(tmp, "sender");
  root = path.join(tmp, "workspace");
  receiver = path.join(root, "repo");
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  await git(sender, "init", "-qb", "main");
  await git(sender, "config", "user.email", "resolve@example.invalid");
  await git(sender, "config", "user.name", "resolve");
  store = new LocalBlobStore(path.join(tmp, "blobs"));
  cfg = {
    remoteWorkspaceId: "ws_resolve",
    projectId: "root",
    deviceId: "receiver",
    rootPath: root,
    remoteUrl: "https://example.invalid",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
    accountId: "acct",
    accountEpoch: 0,
    keyEpoch: 0,
  };
});

afterEach(async () => {
  setGitSpawnObserver(undefined);
  await fs.rm(tmp, { recursive: true, force: true });
});

async function commit(dir: string, content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(dir, "tracked.txt"), content);
  await git(dir, "add", "tracked.txt");
  await git(dir, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "-qm", message);
  return git(dir, "rev-parse", "HEAD");
}

async function capture(): Promise<GitSection> {
  const section = await captureGitState(sender, store, KEK);
  if (!section) throw new Error("capture returned no section");
  return section;
}

const manifest = (section: GitSection): Manifest => ({ generatedAt: "", files: [], manifestSchema: 2, gitRepos: { repo: section } });

async function fixture(opts: { branchSwitch?: boolean; syncedOperationAndBreadcrumb?: boolean } = {}) {
  const baseTip = await commit(sender, "base\n", "base");
  if (opts.syncedOperationAndBreadcrumb) {
    await fs.writeFile(path.join(sender, ".git", "MERGE_HEAD"), `${baseTip}\n`);
    await fs.writeFile(path.join(sender, ".git", "ORIG_HEAD"), `${baseTip}\n`);
  }
  if (opts.branchSwitch) await git(sender, "branch", "next");
  const base = await capture();
  const emptyState: SyncState = {
    stream: syncStreamId(cfg),
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  };
  const applied = await applyGitSections(root, cfg, emptyState, manifest(base), store, buildIgnoreMatcher(root), () => {});
  expect(applied.gitRepos?.repo).toEqual(base);
  // Mirror production's state-first P settlement instead of deleting protocol
  // refs in the fixture. This also keeps the later manual episode in one lineage.
  const repoRecord: RepoRecord = { repoGen: 1, sourceSeq: 1, base };
  if (applied.branchBaseOrigins?.repo) repoRecord.branchBaseOrigins = applied.branchBaseOrigins.repo;
  const initial: SyncState = {
    ...emptyState,
    lastSyncedSequence: 1,
    lastSyncedManifest: manifest(base),
    repoRecords: { repo: repoRecord },
  };
  await saveStateUnsafeLegacyOrTest(root, initial);
  await settleCommittedBranchArtifacts(root, initial, applied);
  await fs.writeFile(path.join(receiver, "tracked.txt"), "base\n");

  if (opts.syncedOperationAndBreadcrumb) await fs.rm(path.join(sender, ".git", "MERGE_HEAD"), { force: true });
  if (opts.branchSwitch) await git(sender, "checkout", "-q", "next");
  const incomingTip = await commit(sender, "incoming\n", "incoming");
  if (opts.syncedOperationAndBreadcrumb) {
    await fs.writeFile(path.join(sender, ".git", "MERGE_HEAD"), `${baseTip}\n`);
    await fs.writeFile(path.join(sender, ".git", "ORIG_HEAD"), `${incomingTip}\n`);
  }
  const incoming = await capture();

  if (opts.syncedOperationAndBreadcrumb) await fs.rm(path.join(receiver, ".git", "MERGE_HEAD"), { force: true });
  await commit(receiver, "local\n", "local-only");
  const localTip = await git(receiver, "rev-parse", "HEAD");
  if (opts.syncedOperationAndBreadcrumb) {
    await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${baseTip}\n`);
    await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${localTip}\n`);
  }
  await git(receiver, "branch", "local-topic");
  const state: SyncState = {
    stream: syncStreamId(cfg),
    stateNonce: "a".repeat(32),
    lastSyncedSequence: 2,
    lastSyncedManifest: manifest(base),
    repoRecords: {
      repo: {
        repoGen: 3,
        sourceSeq: 2,
        base,
        pending: incoming,
        resolutionKey: "checkpoint",
        partial: { incomingKey: "pending", checkoutPending: true, appliedRefs: {}, heldRefs: {}, configApplied: true },
        deferrals: {
          apply: {
            lane: "apply",
            reason: "local-commits",
            deferredSince: "2026-07-13T00:00:00.000Z",
            reasonSince: "2026-07-13T00:00:00.000Z",
            lastSeen: "2026-07-13T00:00:00.000Z",
          },
        },
      },
    },
  };
  await saveStateUnsafeLegacyOrTest(root, state);
  return { base, incoming, localTip };
}

function deps(lines: string[], extra: Parameters<typeof gitResolveCmd>[4] = {}) {
  return {
    build: async () => ({ cfg, store }),
    capabilityProbe: async () => true,
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => lines.push(line),
    now: () => new Date("2026-07-13T01:00:00.000Z"),
    hostname: () => "Test-Desktop",
    confirmedPush: async () => {
      const state = await loadState(root, syncStreamId(cfg));
      return {
        sequence: state.lastSyncedSequence + 1,
        manifest: state.lastSyncedManifest,
        committed: true,
        resolution: { outcome: "published" as const, sequence: state.lastSyncedSequence + 1 },
      };
    },
    ...extra,
  };
}

class ManualProgressScheduler {
  private nextId = 0;
  private announceScheduled!: () => void;
  readonly active = new Map<number, () => void>();
  readonly delays: number[] = [];
  readonly scheduled: Promise<void>;
  cleared = 0;

  constructor() {
    this.scheduled = new Promise<void>((resolve) => { this.announceScheduled = resolve; });
  }

  readonly setInterval = (fn: () => void, ms: number): number => {
    const id = ++this.nextId;
    this.active.set(id, fn);
    this.delays.push(ms);
    this.announceScheduled();
    return id;
  };

  readonly clearInterval = <Handle>(handle: Handle): void => {
    if (this.active.delete(Number(handle))) this.cleared++;
  };

  fireActive(): void {
    for (const fn of [...this.active.values()]) fn();
  }
}

async function show(lines: string[]): Promise<GitResolveShow> {
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(lines))).toBe(0);
  return JSON.parse(lines.at(-1)!) as GitResolveShow;
}

async function makeKeepMinePreviewable(): Promise<void> {
  const record = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  const incomingTip = record.pending!.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
}

test("show-me snapshot is stable and JSON exposes no commit OIDs", async () => {
  await fixture();
  const firstLines: string[] = [];
  const first = await show(firstLines);
  const secondLines: string[] = [];
  const second = await show(secondLines);

  expect(first.snapshot).toMatch(/^[0-9a-f]{64}$/);
  expect(second.snapshot).toBe(first.snapshot);
  expect(first.localOnlyCommits).toEqual([{ labels: expect.arrayContaining(["heads/main"]), subject: "local-only" }]);
  expect(first.deferrals[0]?.ageSeconds).toBe(3600);
  const withoutSnapshot = JSON.stringify(first).replace(first.snapshot, "");
  expect(withoutSnapshot).not.toMatch(/\b[0-9a-f]{40}\b/);
});

test("show-me names this machine in keep-mine's description and falls back to direction alone", async () => {
  await fixture();
  const named: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", {}, deps(named, {
    hostname: () => "Brians-Desktop",
    stdout: (line: string) => named.push(line),
    stderr: () => {},
  }))).toBe(0);
  const keepMine = named.find((line) => line.startsWith("What to do:"))!;
  expect(keepMine).toContain("keep this computer's version (Brians-Desktop) and publish it");
  expect(keepMine).toContain("use the version from your other computer");
  expect(keepMine).not.toContain("theirs and");
  expect(named.find((line) => line.startsWith("What happened:"))).toContain("this computer (Brians-Desktop)");

  const anonymous: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", {}, deps(anonymous, {
    hostname: () => "localhost",
    stdout: (line: string) => anonymous.push(line),
    stderr: () => {},
  }))).toBe(0);
  const fallback = anonymous.find((line) => line.startsWith("What to do:"))!;
  expect(fallback).toContain("keep this computer's version and publish it");
  expect(fallback).toContain("use the version from your other computer");
  expect(fallback).not.toContain("localhost");
});

test("show-me batches subjects and keeps progress exclusively on stderr", async () => {
  await fixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const commands: string[][] = [];
  setGitSpawnObserver((_root, args) => commands.push([...args]));
  expect(await gitResolveCmd(root, receiver, "show-me", {}, deps(stdout, {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line),
  }))).toBe(0);
  const snapshotLine = stdout.at(-1)!;
  expect(snapshotLine).toMatch(/^  Confirmation token: [0-9a-f]{64}$/);
  expect(stdout.slice(0, 3)).toEqual([
    "What happened: rbox paused Git sync for repo because this computer (Test-Desktop) and your other computer both changed Git state; the branch main from your other computer is waiting.",
    "What is safe: Your repository is healthy; rbox has not changed your local Git state.",
    expect.stringMatching(/^What to do: to keep this computer's version \(Test-Desktop\) and publish it to your other computers, preview with 'rbox' 'git' 'resolve' 'repo' 'keep-mine'; to use the version from your other computer and set aside this computer's Git changes, run 'rbox' 'git' 'resolve' 'repo' 'take-theirs' '--confirm' '[0-9a-f]{64}'\.$/),
  ]);
  expect(stdout).toContain("  branch local-topic, branch local-topic's reflog, branch main, branch main's reflog contain history that exists only on this computer: local-only");
  expect(stdout).toContain("  rbox paused the apply step because of local commits since 2026-07-13T00:00:00.000Z.");
  expect(stderr).toEqual([
    "show-me: staging incoming bundle…",
    "show-me: proving ownership of 2 candidates…",
    "show-me: 1 local-only commits found",
  ]);
  const logs = commands.filter((args) => args[0] === "log");
  expect(logs).toHaveLength(1);
  expect(logs[0]).toContain("--stdin");
  expect(logs.some((args) => args.includes("-1"))).toBe(false);
});

test("show-me JSON stdout remains byte-for-byte on the existing exhaustive contract", async () => {
  await fixture();
  const stdout: string[] = [];
  const stderr: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(stdout, {
    stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line),
  }))).toBe(0);
  expect(stdout).toHaveLength(1);
  const parsed = JSON.parse(stdout[0]!) as GitResolveShow;
  expect(stdout[0]).toBe(JSON.stringify({
    status: "show-me",
    repo: "repo",
    incomingCheckout: { kind: "branch", label: "main" },
    localOnlyCommits: [{
      labels: ["heads/local-topic", "heads/local-topic reflog", "heads/main", "heads/main reflog"],
      subject: "local-only",
    }],
    oracle: "dirty",
    index: "diverged",
    operationState: "matches-incoming",
    stash: "clean",
    deferrals: [{ lane: "apply", reason: "local-commits", deferredSince: "2026-07-13T00:00:00.000Z", ageSeconds: 3600 }],
    snapshot: parsed.snapshot,
  }));
  expect(stderr).toHaveLength(3);
});

test("show-me preserves subjects after ownership-stream fallback and trims each batched subject like legacy", async () => {
  await fixture();
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--amend", "-qm", "  spaced subject  ");
  let failed = false;
  setGitSpawnObserver((_root, args) => {
    if (!failed && args[0] === "rev-list" && args.includes("--stdin") && !args.includes("--quiet")) {
      failed = true;
      throw new Error("forced ownership stream failure");
    }
  });
  const lines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(lines))).toBe(0);
  const shown = JSON.parse(lines.at(-1)!) as GitResolveShow;
  expect(shown.localOnlyCommits.some((entry) => entry.subject === "spaced subject")).toBe(true);
  expect(shown.localOnlyCommits.some((entry) => entry.subject === "unreadable commit")).toBe(false);
});

test("show-me JSON is exhaustive while only human local-only presentation is capped", async () => {
  const { localTip } = await fixture();
  const subjectOids = new Map<string, string>([["local-only", localTip]]);
  for (let i = 0; i < 51; i++) {
    const subject = `local-${String(i).padStart(3, "0")}`;
    subjectOids.set(subject, await commit(receiver, `${subject}\n`, subject));
  }

  const jsonOut: string[] = [];
  const jsonErr: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(jsonOut, {
    stdout: (line) => jsonOut.push(line), stderr: (line) => jsonErr.push(line),
  }))).toBe(0);
  expect(jsonOut).toHaveLength(1);
  const full = JSON.parse(jsonOut[0]!) as GitResolveShow;
  expect(full.localOnlyCommits).toHaveLength(52);
  expect(Object.keys(full).sort()).toEqual([
    "deferrals", "incomingCheckout", "index", "localOnlyCommits", "operationState", "oracle", "repo", "snapshot", "stash", "status",
  ]);
  expect(jsonErr).toEqual([
    "show-me: staging incoming bundle…",
    "show-me: proving ownership of 53 candidates…",
    "show-me: 52 local-only commits found",
  ]);

  const humanOut: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", {}, deps(humanOut, {
    stdout: (line) => humanOut.push(line), stderr: () => {},
  }))).toBe(0);
  expect(humanOut.filter((line) => line.includes("history that exists only on this computer:"))).toHaveLength(50);
  expect(humanOut).toContain("  …and 2 more commits only on this computer.");

  const hiddenSubject = full.localOnlyCommits.slice(50).map((entry) => entry.subject).find((subject) => subjectOids.has(subject));
  expect(hiddenSubject).toBeDefined();
  const takeOut: string[] = [];
  const takeErr: string[] = [];
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: full.snapshot }, deps(takeOut, {
    stdout: (line) => takeOut.push(line), stderr: (line) => takeErr.push(line),
  }))).toBe(0);
  const hiddenOid = subjectOids.get(hiddenSubject!)!;
  expect(await git(receiver, "rev-parse", `refs/rbox-local/keep/${hiddenOid}`)).toBe(hiddenOid);
  // Design 271 §2.7.6: take-theirs reports its steps on stderr; stdout stays
  // byte-clean for --json.
  expect(takeErr.filter((line) => !line.startsWith("take-theirs: "))).toEqual([]);
});

test("show-me heartbeat timers are cleared in finally", async () => {
  await fixture();
  const stderr: string[] = [];
  const scheduler = new ManualProgressScheduler();
  const resolving = gitResolveCmd(root, receiver, "show-me", { json: true }, deps([], {
    stderr: (line) => stderr.push(line), progressScheduler: scheduler,
  }));
  await scheduler.scheduled;
  scheduler.fireActive();
  expect(await resolving).toBe(0);
  expect(stderr.some((line) => /^show-me: still working \(\d+s\)$/.test(line))).toBe(true);
  expect(scheduler.delays.every((ms) => ms === 10_000)).toBe(true);
  expect(scheduler.cleared).toBe(scheduler.delays.length);
  expect(scheduler.active.size).toBe(0);
  const atReturn = stderr.length;
  scheduler.fireActive();
  expect(stderr).toHaveLength(atReturn);
});

test("show-me heartbeat timers are cleared when a phase transition throws", async () => {
  await fixture();
  const stderr: string[] = [];
  const scheduler = new ManualProgressScheduler();
  const resolving = gitResolveCmd(root, receiver, "show-me", { json: true }, deps([], {
    progressScheduler: scheduler,
    stderr: (line) => {
      if (line.startsWith("show-me: proving")) throw new Error("progress sink failed");
      stderr.push(line);
    },
  }));
  await scheduler.scheduled;
  scheduler.fireActive();
  expect(await resolving).toBe(1);
  expect(scheduler.delays.length).toBeGreaterThan(0);
  expect(scheduler.cleared).toBe(scheduler.delays.length);
  expect(scheduler.active.size).toBe(0);
  const atReturn = stderr.length;
  scheduler.fireActive();
  expect(stderr).toHaveLength(atReturn);
});

test("500 synthetic reflog candidates use one batched proof instead of per-tip Git calls", async () => {
  await fixture();
  const logPath = path.join(receiver, ".git", "logs", "refs", "heads", "main");
  const fake = Array.from({ length: 500 }, (_, i) => {
    const oldOid = (i + 1).toString(16).padStart(40, "0");
    const newOid = (i + 2).toString(16).padStart(40, "0");
    return `${oldOid} ${newOid} rbox <rbox@local> 0 +0000\tsynthetic`;
  }).join("\n");
  await fs.appendFile(logPath, `\n${fake}\n`);
  const commands: string[][] = [];
  setGitSpawnObserver((_root, args) => commands.push([...args]));
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps([]))).toBe(0);
  expect(commands.filter((args) => args[0] === "cat-file")).toHaveLength(1);
  expect(commands.filter((args) => args[0] === "merge-base")).toHaveLength(0);
  expect(commands.filter((args) => args[0] === "log" && args.includes("--stdin"))).toHaveLength(1);
  const batchedFamilies = commands.filter((args) => args[0] === "cat-file"
    || (args[0] === "rev-list" && args.includes("--stdin"))
    || (args[0] === "log" && args.includes("--stdin")));
  expect(batchedFamilies.map((args) => args[0])).toEqual(["cat-file", "rev-list", "rev-list", "log"]);
});

test("git deferrals renders empty human and JSON forms", async () => {
  const state: SyncState = { stream: syncStreamId(cfg), lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] } };
  const human: string[] = [];
  expect(await gitDeferralsCmd(root, {}, { loadConfig: async () => cfg, loadState: async () => state, stdout: (line) => human.push(line) })).toBe(0);
  expect(human).toEqual(["no deferred repos"]);
  const json: string[] = [];
  expect(await gitDeferralsCmd(root, { json: true }, { loadConfig: async () => cfg, loadState: async () => state, stdout: (line) => json.push(line) })).toBe(0);
  expect(JSON.parse(json[0]!)).toEqual({ schemaVersion: 1, deferrals: [] });
});

test("git deferrals brief is deterministic, actionable, anchored, quoted, and host-free", async () => {
  const { base } = await fixture();
  const saved = await loadState(root, syncStreamId(cfg));
  const original = repoRecordsForState(saved).repo!;
  const hostile = "Customer [x]/-it's `$(touch nope)`\nrepo";
  const state: SyncState = {
    ...saved,
    repoRecords: {
      [hostile]: {
        ...original,
        base,
        deferrals: {
          ...original.deferrals,
          capture: {
            lane: "capture",
            reason: "artifact",
            deferredSince: "2026-07-12T00:00:00.000Z",
            reasonSince: "2026-07-13T00:30:00.000Z",
            lastSeen: "2026-07-13T00:30:00.000Z",
            checkout: { kind: "branch", label: "user@example.test/TICKET_[7]" },
          },
        },
      },
    },
  };
  const lines: string[] = [];
  const code = await gitDeferralsCmd(root, { brief: true }, {
    loadConfig: async () => cfg,
    loadState: async () => state,
    now: () => new Date("2026-07-13T01:00:00.000Z"),
    version: "9.8.7-test",
    hostname: "private-host@example.test",
    stdout: (line) => lines.push(line),
  });
  expect(code).toBe(0);
  expect(lines[0]).toBe("contains local repo paths and branch names — share accordingly");
  expect(lines.at(-1)).toBe("-- end of brief · 1 repo(s)");
  const output = lines.join("\n");
  expect(output).toContain("rbox version: 9.8.7-test");
  expect(output).toContain("Also deferred: capture");
  expect(output).toContain("Your repository is healthy; only rbox's bookkeeping is paused");
  expect(output).toContain("`keep-mine` to keep this computer's version and publish it to your other computers");
  expect(output).toContain("`take-theirs` to use the version from your other computer and set aside this computer's Git changes");
  const command = lines.find((line) => line.startsWith("cd "))!;
  expect(command).toContain(`cd '${root}' && 'rbox' 'git' 'resolve'`);
  expect(command).toContain("'\\''");
  expect(command).toContain("`$(touch nope)`\nrepo'");
  expect(output).toContain("'<token-printed-by-show-me>'");
  expect(output).toContain("'git' 'resolve' '");
  expect(output).toContain("'keep-mine'");
  expect(output).not.toContain("'keep-mine' '--confirm' '<token-printed-by-show-me>'");
  expect(output).toContain("'take-theirs' '--confirm' '<token-printed-by-show-me>'");
  expect(output).not.toContain("private-host@example.test");
});

test("brief escapes only Markdown structure and leaves dotted names and versions readable", async () => {
  const { base } = await fixture();
  const saved = await loadState(root, syncStreamId(cfg));
  const original = repoRecordsForState(saved).repo!;
  const lines: string[] = [];
  await gitDeferralsCmd(root, { brief: true }, {
    loadConfig: async () => cfg,
    loadState: async () => ({ ...saved, repoRecords: { "foo.bar": { ...original, base, deferrals: {
      capture: { lane: "capture", reason: "artifact", deferredSince: "2026-07-13T00:00:00.000Z", reasonSince: "2026-07-13T00:00:00.000Z", lastSeen: "2026-07-13T00:00:00.000Z", checkout: { kind: "branch", label: "<script>" } },
    } } } }),
    now: () => new Date("2026-07-13T01:00:00.000Z"),
    version: "1.6.3",
    stdout: (line) => lines.push(line),
  });
  const output = lines.join("\n");
  expect(output).toContain("rbox version: 1.6.3");
  expect(output).toContain("## foo.bar");
  expect(output).toContain("branch \\<script\\>");
  expect(lines.at(-1)).toBe("-- end of brief · 1 repo(s)");
});

test("brief never resolves capture/config primaries and protects leading-dash repo argv", async () => {
  const { base } = await fixture();
  const saved = await loadState(root, syncStreamId(cfg));
  const original = repoRecordsForState(saved).repo!;
  const state: SyncState = {
    ...saved,
    repoRecords: {
      "--customer": { ...original, base },
      "config-primary": {
        ...original,
        base,
        deferrals: {
          apply: { lane: "apply", reason: "conflict", deferredSince: "2026-07-13T00:30:00.000Z", reasonSince: "2026-07-13T00:30:00.000Z", lastSeen: "2026-07-13T00:30:00.000Z" },
          config: { lane: "config", reason: "config", deferredSince: "2026-07-12T00:00:00.000Z", reasonSince: "2026-07-12T00:00:00.000Z", lastSeen: "2026-07-13T00:30:00.000Z" },
        },
      },
    },
  };
  const lines: string[] = [];
  expect(await gitDeferralsCmd(root, { brief: true }, {
    loadConfig: async () => cfg,
    loadState: async () => state,
    now: () => new Date("2026-07-13T01:00:00.000Z"),
    stdout: (line) => lines.push(line),
  })).toBe(0);
  const output = lines.join("\n");
  expect(output).toContain("'git' 'resolve' './--customer'");
  const configStart = output.indexOf("## config-primary");
  const configEnd = output.indexOf("\n## ", configStart + 3);
  const configSection = output.slice(configStart, configEnd === -1 ? undefined : configEnd);
  expect(configSection).not.toContain("'git' 'resolve'");
  expect(configSection).toContain("resolver commands do not apply");
});

test("brief emits no resolver commands for null pending or an empty resolution key", async () => {
  const { base } = await fixture();
  const saved = await loadState(root, syncStreamId(cfg));
  const original = repoRecordsForState(saved).repo!;
  const capture = { lane: "capture" as const, reason: "local-commits" as const, deferredSince: "2026-07-13T00:00:00.000Z", reasonSince: "2026-07-13T00:00:00.000Z", lastSeen: "2026-07-13T00:00:00.000Z" };
  const lines: string[] = [];
  await gitDeferralsCmd(root, { brief: true }, {
    loadConfig: async () => cfg,
    loadState: async () => ({ ...saved, repoRecords: {
      "null-pending": { ...original, pending: null as any, resolutionKey: undefined, base, deferrals: { capture } },
      "empty-key": { ...original, pending: undefined, resolutionKey: "", base, deferrals: { capture } },
    } }),
    stdout: (line) => lines.push(line),
  });
  expect(lines.join("\n")).not.toContain("'git' 'resolve'");
});

test("an emitted resolver command preserves a hostile repo name as one inert argv element", async () => {
  const { base } = await fixture();
  const saved = await loadState(root, syncStreamId(cfg));
  const original = repoRecordsForState(saved).repo!;
  const hostile = '-\'quote " double\n$(touch command-substitution) `touch backtick` space';
  const lines: string[] = [];
  await gitDeferralsCmd(root, { brief: true }, {
    loadConfig: async () => cfg,
    loadState: async () => ({ ...saved, repoRecords: { [hostile]: { ...original, pending: base, base, deferrals: {
      apply: { lane: "apply", reason: "conflict", deferredSince: "2026-07-13T00:00:00.000Z", reasonSince: "2026-07-13T00:00:00.000Z", lastSeen: "2026-07-13T00:00:00.000Z" },
    } } } }),
    stdout: (line) => lines.push(line),
  });
  const command = lines.find((line) => line.startsWith("cd "))!;
  const harnessDir = path.join(tmp, "argv-harness");
  const unrelated = path.join(tmp, "unrelated-cwd");
  const argvOut = path.join(tmp, "argv.bin");
  await fs.mkdir(harnessDir);
  await fs.mkdir(unrelated);
  const harness = path.join(harnessDir, "rbox");
  await fs.writeFile(harness, "#!/bin/sh\nprintf '%s\\0' \"$@\" > \"$RBOX_ARGV_OUT\"\n");
  await fs.chmod(harness, 0o755);
  await exec("sh", ["-c", command], {
    cwd: unrelated,
    env: { ...process.env, PATH: `${harnessDir}:${process.env.PATH ?? ""}`, RBOX_ARGV_OUT: argvOut },
  });
  const argv = (await fs.readFile(argvOut)).toString().split("\0").filter(Boolean);
  expect(argv).toEqual(["git", "resolve", `./${hostile}`]);
  expect(await fs.stat(path.join(root, "command-substitution")).then(() => true, () => false)).toBe(false);
  expect(await fs.stat(path.join(root, "backtick")).then(() => true, () => false)).toBe(false);
});

test("show-me strips terminal controls from a commit subject", async () => {
  await fixture();
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--amend", "-qm", "subject\u001b[2Jforged");
  const lines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", {}, deps(lines))).toBe(0);
  expect(lines.join("\n")).toContain("subject [2Jforged");
  expect(lines.join("\n")).not.toMatch(/[\u001b\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test("take-theirs quarantines, pins, follows, and clears pending resolution state", async () => {
  const { incoming, localTip } = await fixture();
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "0" })).toBe(false);
  const showLines: string[] = [];
  const current = await show(showLines);
  const beforeBytes = await fs.readFile(path.join(receiver, "tracked.txt"));
  const lines: string[] = [];

  const code = await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps(lines));
  expect({ code, lines }).toMatchObject({ code: 0 });
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "resolved", verb: "take-theirs", snapshot: current.snapshot });
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  await expect(git(receiver, "rev-parse", "--verify", "refs/heads/local-topic")).rejects.toThrow();
  expect(await fs.readFile(path.join(receiver, "tracked.txt"))).toEqual(beforeBytes);
  expect(await git(receiver, "rev-parse", `refs/rbox-local/keep/${localTip}`)).toBe(localTip);
  const origins = JSON.parse(await fs.readFile(path.join(receiver, ".git", "rbox-keep-origins.json"), "utf8"));
  expect(origins[localTip][0].class).toBe("human");
  const saved = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  expect(saved.base).toEqual(incoming);
  expect(saved.branchBaseOrigins?.["refs/heads/main"]).toMatchObject({
    kind: "pull-p", oid: incoming.refs["refs/heads/main"], lineageHash: expect.stringMatching(/^[0-9a-f]{64}$/),
  });
  expect((await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-local/base-present/v2", "refs/rbox-local/base-present-keep/v2"))
    .split("\n").filter(Boolean)).toEqual([]);
  expect(saved.pending).toBeUndefined();
  expect(saved.resolutionKey).toBeUndefined();
  expect(saved.partial).toBeUndefined();
  expect(saved.deferrals?.apply).toBeUndefined();
  const quarantineRoot = path.join(root, ".rbox", "git-quarantine");
  expect((await fs.readdir(path.join(quarantineRoot, (await fs.readdir(quarantineRoot))[0]!))).some((name) => name.endsWith(".bundle"))).toBe(true);
});

test("design 177 take-theirs is unchanged and never copies a leftover keep-mine intent", async () => {
  await fixture();
  const seeded = await loadState(root, syncStreamId(cfg));
  (seeded.repoRecords!.repo as RepoRecord & { resolutionIntent?: unknown }).resolutionIntent = {
    v: 1, verb: "keep-mine", snapshot: "old-client",
  };
  await saveStateUnsafeLegacyOrTest(root, seeded);
  const current = await show([]);
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps([]))).toBe(0);
  const saved = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  expect(saved.pending).toBeUndefined();
  expect((saved as RepoRecord & { resolutionIntent?: unknown }).resolutionIntent).toBeUndefined();
  expect(await fs.readFile(path.join(root, ".rbox", "state.json"), "utf8")).not.toContain("resolutionIntent");
});

test("take-theirs composes a stable side branch with no P into a manual origin", async () => {
  const { base, incoming } = await fixture();
  const baseOid = base.refs["refs/heads/main"]!;
  const nextOid = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, nextOid);
  await git(receiver, "branch", "topic", nextOid);
  const state = await loadState(root, syncStreamId(cfg));
  const record = state.repoRecords!.repo!;
  record.base = { ...record.base!, refs: { ...record.base!.refs, "refs/heads/topic": baseOid } };
  record.pending = { ...record.pending!, refs: { ...record.pending!.refs, "refs/heads/topic": nextOid } };
  await saveStateUnsafeLegacyOrTest(root, state);

  const current = await show([]);
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps([]))).toBe(0);
  const saved = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  expect(saved.base?.refs["refs/heads/topic"]).toBe(nextOid);
  expect(saved.branchBaseOrigins?.["refs/heads/topic"]).toMatchObject({ kind: "manual", oid: nextOid });
  expect(saved.branchBaseOrigins?.["refs/heads/topic"]?.kind === "manual"
    ? saved.branchBaseOrigins["refs/heads/topic"]!.episode : "").toMatch(/^[0-9a-f]{32}$/);
});

test("take-theirs verifies an already-absent branch and creates A before removing BASE", async () => {
  const { base } = await fixture();
  const prior = base.refs["refs/heads/main"]!;
  const state = await loadState(root, syncStreamId(cfg));
  const record = state.repoRecords!.repo!;
  record.base = { ...record.base!, refs: { ...record.base!.refs, "refs/heads/gone": prior } };
  record.pending = { ...record.pending!, refs: { ...record.pending!.refs } };
  delete record.pending.refs["refs/heads/gone"];
  await saveStateUnsafeLegacyOrTest(root, state);

  const current = await show([]);
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps([]))).toBe(0);
  const saved = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  expect(saved.base?.refs["refs/heads/gone"]).toBeUndefined();
  expect(saved.branchBaseOrigins?.["refs/heads/gone"]).toBeUndefined();
  const activeA = await git(receiver, "for-each-ref", "--format=%(refname)", "refs/rbox-local/base-absent/v2");
  expect(activeA).toBe("");
});

test("take-theirs P-repairs a moved standing episode, invalidates the old confirmation, then resnapshots", async () => {
  const { base, incoming } = await fixture();
  const prior = base.refs["refs/heads/main"]!;
  const next = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, next);
  await git(receiver, "branch", "topic", prior);
  const state = await loadState(root, syncStreamId(cfg));
  const stored = state.repoRecords!.repo!;
  stored.base = { ...stored.base!, refs: { ...stored.base!.refs, "refs/heads/topic": prior } };
  stored.pending = { ...stored.pending!, refs: { ...stored.pending!.refs, "refs/heads/topic": next } };
  await saveStateUnsafeLegacyOrTest(root, state);
  const record = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  const ctx = await repoCtx(receiver);
  const prepared = await prepareFollowerBranchProtocol({
    workspaceRoot: root, relPath: "repo", state: await loadState(root, syncStreamId(cfg)),
    ctx,
    record, base: record.base, incoming: record.pending!, liveRefs: Object.fromEntries((await git(receiver, "for-each-ref", "--format=%(refname) %(objectname)"))
      .split("\n").filter(Boolean).map((line) => line.split(" ") as [string, string])),
  });
  if (prepared.status !== "ready") throw new Error(prepared.reason);
  const plan = await planBranchTransition({
    repoDir: receiver, binding: prepared.protocol.binding, ref: "refs/heads/topic",
    beforeOid: prior, afterOid: next, logicalBaseOid: prior,
  });
  await commitPlannedBranchTransition(plan);
  await git(receiver, "update-ref", "-m", "user moved topic", "refs/heads/topic", prior, next);

  const stale = await show([]);
  const first: string[] = [];
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: stale.snapshot }, deps(first))).toBe(1);
  expect(JSON.parse(first.at(-1)!)).toMatchObject({ status: "snapshot-mismatch" });
  const fresh = await show([]);
  expect(fresh.snapshot).not.toBe(stale.snapshot);
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: fresh.snapshot }, deps([]))).toBe(0);
  expect(await git(receiver, "rev-parse", "refs/heads/topic")).toBe(next);
  const remainingP = await git(receiver, "for-each-ref", "--format=%(refname) %(objectname)", "refs/rbox-local/base-present/v2");
  const remainingPayloads = await Promise.all(remainingP.split("\n").filter(Boolean)
    .map((line) => git(receiver, "cat-file", "-p", line.split(" ")[1]!)));
  expect(remainingPayloads.some((payload) => payload.includes('"ref":"refs/heads/topic"'))).toBe(false);
});

test("design 126: confirmed take-theirs remains authorized with synced operation state and a breadcrumb mismatch", async () => {
  const { incoming } = await fixture({ syncedOperationAndBreadcrumb: true });
  const showLines: string[] = [];
  const current = await show(showLines);
  const lines: string[] = [];

  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps(lines))).toBe(0);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "resolved", verb: "take-theirs" });
  expect(await fs.readFile(path.join(receiver, ".git", "MERGE_HEAD"), "utf8")).toBe(`${await git(sender, "rev-parse", "HEAD~1")}\n`);
  const incomingOrig = await fs.readFile(path.join(sender, ".git", "ORIG_HEAD"), "utf8");
  expect(await fs.readFile(path.join(receiver, ".git", "ORIG_HEAD"), "utf8")).toBe(incomingOrig);
  expect(repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.pending).toBeUndefined();
});

test("take-theirs rejects a stale confirmation before quarantine when a ref moves", async () => {
  await fixture();
  const showLines: string[] = [];
  const current = await show(showLines);
  await git(receiver, "branch", "concurrent-ref");
  const lines: string[] = [];

  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps(lines))).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "snapshot-mismatch" });
  await expect(fs.access(path.join(root, ".rbox", "git-quarantine"))).rejects.toThrow();
});

test("take-theirs aborts when the locked snapshot changes", async () => {
  await fixture();
  const showLines: string[] = [];
  const current = await show(showLines);
  const beforeHead = await git(receiver, "rev-parse", "HEAD");
  const lines: string[] = [];

  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps(lines, {
    beforeSecondProof: async () => { await fs.writeFile(path.join(receiver, "tracked.txt"), "concurrent\n"); },
  }))).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "snapshot-mismatch", verb: "take-theirs" });
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(beforeHead);
  expect(repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.pending).toBeDefined();
});

test("take-theirs names a sibling worktree collision", async () => {
  await fixture({ branchSwitch: true });
  const sibling = path.join(tmp, "sibling-next");
  await git(receiver, "worktree", "add", "-q", sibling, "next");
  const showLines: string[] = [];
  const current = await show(showLines);
  const lines: string[] = [];

  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps(lines))).toBe(1);
  const result = JSON.parse(lines.at(-1)!);
  expect(result).toMatchObject({ status: "refused", code: "worktree-ownership" });
  expect(result.message).toBe("another worktree owns a ref required by the confirmed checkout");
  expect(result.message).not.toContain("sibling-next");
});

test("keep-mine confirmation executes synchronously from the confirmed preview", async () => {
  const { incoming } = await fixture();
  const incomingTip = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");

  const previewLines: string[] = [];
  cfg.git = { incremental: true };
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines))).toBe(1);
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview).toMatchObject({
    status: "preview", verb: "keep-mine", current: { status: "show-me" },
    confirm: { snapshot: expect.any(String), forceDiscardIncoming: false },
  });
  const humanPreview: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {}, deps(humanPreview))).toBe(1);
  expect(humanPreview.findIndex((line) => line.startsWith("Preliminary incoming-discard report")))
    .toBeLessThan(humanPreview.findIndex((line) => line.startsWith("Confirm exactly this preview with:")));
  const before = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  const refsBefore = await git(receiver, "for-each-ref", "--format=%(refname) %(objectname)");
  const indexBefore = await fs.readFile(path.join(receiver, ".git", "index"));

  const confirmed: string[] = [];
  // Force is exact, not a generic acknowledgement: an unnecessary force flag
  // re-renders the preview and cannot publish.
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: true,
  }, deps(confirmed))).toBe(1);
  expect(JSON.parse(confirmed.at(-1)!)).toMatchObject({ status: "preview", confirm: { forceDiscardIncoming: false } });
  confirmed.length = 0;
  const confirmCode = await gitResolveCmd(root, receiver, "keep-mine", {
    confirm: preview.current.snapshot,
  }, deps(confirmed));
  expect(confirmCode).toBe(0);
  expect(confirmed.join("\n")).toContain("published; this computer's version (Test-Desktop) is the synced truth now");
  const after = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo!;
  expect(after).toEqual(before);
  expect(await git(receiver, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);
  expect(await fs.readFile(path.join(receiver, ".git", "index"))).toEqual(indexBefore);
});

test("keep-mine requires force exactly when the preview has a non-subsumed lane", async () => {
  const { incoming } = await fixture();
  const incomingTip = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
  await git(receiver, "tag", "force-review", "HEAD");
  const state = await loadState(root, syncStreamId(cfg));
  const record = state.repoRecords!.repo!;
  record.pending = {
    ...record.pending!,
    refs: { ...record.pending!.refs, "refs/tags/force-review": incomingTip },
  };
  await saveStateUnsafeLegacyOrTest(root, state);

  const previewLines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines))).toBe(1);
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview).toMatchObject({
    status: "preview",
    confirm: { forceDiscardIncoming: true },
    discardReport: { forceRequired: true },
  });
  expect(preview.discardReport.lanes).toContainEqual(expect.objectContaining({
    lane: "tag:refs/tags/force-review", disposition: "not-subsumed",
  }));

  const missingForce: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true, confirm: preview.current.snapshot,
  }, deps(missingForce))).toBe(1);
  expect(JSON.parse(missingForce.at(-1)!)).toMatchObject({ status: "preview", confirm: { forceDiscardIncoming: true } });

  const confirmed: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: true,
  }, deps(confirmed))).toBe(0);
  expect(JSON.parse(confirmed.at(-1)!)).toMatchObject({ status: "published", sequence: expect.any(Number) });
});

test("keep-mine refuses a checkout journal without recovering or changing sidecars", async () => {
  const { incoming } = await fixture();
  const incomingTip = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
  const journalDir = checkoutJournalDir(root, "repo");
  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(path.join(journalDir, "journal.json"), "{nonterminal\n");
  const beforeState = JSON.stringify(await loadState(root, syncStreamId(cfg)));
  const beforeJournal = await fs.readFile(path.join(journalDir, "journal.json"));

  const lines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true, forceDiscardIncoming: true }, deps(lines))).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "refused", code: "journal-recovery" });
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(beforeState);
  expect(await fs.readFile(path.join(journalDir, "journal.json"))).toEqual(beforeJournal);
});

test("keep-mine refuses an incoming checkout branch contested by a linked worktree and clears nothing", async () => {
  await fixture({ branchSwitch: true });
  const sibling = path.join(tmp, "sibling-next-keep-mine");
  await git(receiver, "worktree", "add", "-q", sibling, "next");
  const before = JSON.stringify(await loadState(root, syncStreamId(cfg)));
  const lines: string[] = [];

  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(lines))).toBe(1);
  const result = JSON.parse(lines.at(-1)!);
  expect(result).toMatchObject({ status: "refused", verb: "keep-mine", code: "worktree-ownership" });
  expect(result.message).toContain("active in another linked worktree");
  expect(result.message).not.toContain("sibling-next-keep-mine");
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(before);
});

test("keep-mine refuses busy and in-progress Git state without clearing anything", async () => {
  await fixture();
  const before = JSON.stringify(await loadState(root, syncStreamId(cfg)));
  const lock = path.join(receiver, ".git", "index.lock");
  await fs.writeFile(lock, "busy\n");
  const busy: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(busy))).toBe(1);
  expect(JSON.parse(busy.at(-1)!)).toMatchObject({ status: "refused", code: "git-busy" });
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(before);
  await fs.rm(lock);

  await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${await git(receiver, "rev-parse", "HEAD")}\n`);
  const operation: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(operation))).toBe(1);
  expect(JSON.parse(operation.at(-1)!)).toMatchObject({ status: "refused", code: "local-operation" });
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(before);
});

test("keep-mine previews despite breadcrumb op-state (ORIG_HEAD) but refuses in-progress (MERGE_HEAD)", async () => {
  const { incoming } = await fixture();
  const incomingTip = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
  // ORIG_HEAD (breadcrumb, design 126) — written explicitly so the fixture never
  // depends on reset's environment-varying side effect (CI's git skipped it).
  await fs.writeFile(path.join(receiver, ".git", "ORIG_HEAD"), `${incomingTip}\n`);
  cfg.git = { incremental: true };
  const previewLines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines))).toBe(1);
  expect(JSON.parse(previewLines.at(-1)!)).toMatchObject({ status: "preview", verb: "keep-mine" });
  // A genuinely in-progress operation still refuses.
  await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${incomingTip}\n`);
  const refusedLines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(refusedLines))).toBe(1);
  expect(JSON.parse(refusedLines.at(-1)!)).toMatchObject({ status: "refused", code: "local-operation" });
});

test("design 177 treats a bare rebase root as in-progress at both preview and confirm doors", async () => {
  await fixture();
  await makeKeepMinePreviewable();
  const bare = path.join(receiver, ".git", "rebase-merge");
  await fs.mkdir(bare);
  const previewRefusal: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewRefusal))).toBe(1);
  expect(JSON.parse(previewRefusal.at(-1)!)).toMatchObject({ status: "refused", code: "local-operation" });

  await fs.rm(bare, { recursive: true });
  const previewLines: string[] = [];
  await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines));
  const preview = JSON.parse(previewLines.at(-1)!);
  const confirmRefusal: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, deps(confirmRefusal, {
    beforeConfirmRecheck: async () => { await fs.mkdir(bare); },
  }))).toBe(1);
  expect(JSON.parse(confirmRefusal.at(-1)!)).toMatchObject({ status: "refused", code: "local-operation" });
});

// Field: a paying customer's repo was unresolvable for seven days behind
// "a Git operation is in progress" with a clean tree and no MERGE_HEAD — git had
// nothing to finish or abort. MERGE_MSG (a commit-message draft) and AUTO_MERGE
// (ort's scratch tree) are fossils of CONCLUDED operations, so they are
// breadcrumbs, not operations.
test("a concluded operation's leftover MERGE_MSG/AUTO_MERGE previews and publishes keep-mine", async () => {
  await fixture();
  await makeKeepMinePreviewable();
  const gitDir = path.join(receiver, ".git");
  await fs.writeFile(path.join(gitDir, "MERGE_MSG"), "Merge branch 'feature'\n");
  await fs.writeFile(path.join(gitDir, "AUTO_MERGE"), `${await git(receiver, "rev-parse", "HEAD^{tree}")}\n`);
  // The precondition git itself reports: nothing is in progress.
  expect(await fs.exists(path.join(gitDir, "MERGE_HEAD"))).toBe(false);
  expect(await git(receiver, "status", "--porcelain")).toBe("");

  const previewLines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines))).toBe(1);
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview).toMatchObject({ status: "preview", verb: "keep-mine" });

  // Past the preview door is not enough — the confirm door re-checks live op-state.
  const confirmed: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming === true,
  }, deps(confirmed))).toBe(0);
  expect(confirmed.join("\n")).toContain("published");
  // Publication never touches the fossils; they keep syncing as op-state.
  expect(await fs.readFile(path.join(gitDir, "MERGE_MSG"), "utf8")).toBe("Merge branch 'feature'\n");
});

// Negative controls for the reclassification. The confirm door's own refusal is
// pinned by the design 177 bare-rebase-root test above (an empty directory is the
// only in-progress marker that can appear without changing the preview snapshot).
test("a real MERGE_HEAD alongside the fossils still refuses keep-mine", async () => {
  await fixture();
  await makeKeepMinePreviewable();
  const gitDir = path.join(receiver, ".git");
  const before = JSON.stringify(await loadState(root, syncStreamId(cfg)));
  await fs.writeFile(path.join(gitDir, "MERGE_MSG"), "Merge branch 'feature'\n");
  await fs.writeFile(path.join(gitDir, "MERGE_HEAD"), `${await git(receiver, "rev-parse", "HEAD")}\n`);
  const refused: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(refused))).toBe(1);
  expect(JSON.parse(refused.at(-1)!)).toMatchObject({ status: "refused", code: "local-operation" });
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(before);
});

test("an empty rebase-merge directory beside the fossils still refuses keep-mine", async () => {
  await fixture();
  await makeKeepMinePreviewable();
  const gitDir = path.join(receiver, ".git");
  await fs.writeFile(path.join(gitDir, "MERGE_MSG"), "Merge branch 'feature'\n");
  // Directory PRESENCE is git's rebase evidence even with no files inside it.
  await fs.mkdir(path.join(gitDir, "rebase-merge"));
  const refused: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(refused))).toBe(1);
  expect(JSON.parse(refused.at(-1)!)).toMatchObject({ status: "refused", code: "local-operation" });
});

test("design 177 preview drift returns a fresh token and the old token stays dead", async () => {
  await fixture();
  await makeKeepMinePreviewable();
  const state = await loadState(root, syncStreamId(cfg));
  const incomingTip = state.repoRecords!.repo!.pending!.refs["refs/heads/main"]!;
  await git(receiver, "tag", "preview-drift", incomingTip);
  state.repoRecords!.repo!.pending = {
    ...state.repoRecords!.repo!.pending!,
    refs: { ...state.repoRecords!.repo!.pending!.refs, "refs/tags/preview-drift": incomingTip },
  };
  await saveStateUnsafeLegacyOrTest(root, state);
  const previewLines: string[] = [];
  await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines));
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview.discardReport).toMatchObject({ forceRequired: false });
  expect(preview.discardReport.lanes).toContainEqual(expect.objectContaining({
    lane: "tag:refs/tags/preview-drift", disposition: "subsumed",
  }));
  const driftedLines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, deps(driftedLines, {
    beforeConfirmRecheck: async () => {
      await git(receiver, "tag", "-d", "preview-drift");
    },
  }))).toBe(1);
  const fresh = JSON.parse(driftedLines.at(-1)!);
  expect(fresh).toMatchObject({ status: "snapshot-mismatch", current: { snapshot: expect.any(String) } });
  expect(fresh.current.snapshot).not.toBe(preview.current.snapshot);
  expect(fresh.discardReport).toMatchObject({ forceRequired: true });
  expect(fresh.discardReport.lanes).toContainEqual(expect.objectContaining({
    lane: "tag:refs/tags/preview-drift", disposition: "not-subsumed",
  }));
  expect(fresh.discardReport.lanes).not.toEqual(preview.discardReport.lanes);

  const replay: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, deps(replay))).toBe(1);
  expect(JSON.parse(replay.at(-1)!)).toMatchObject({
    status: "snapshot-mismatch",
    current: { snapshot: fresh.current.snapshot },
  });
});

test("design 177 confirmed keep-mine surfaces lock waiting and a plain timeout", async () => {
  await fixture();
  await makeKeepMinePreviewable();
  const previewLines: string[] = [];
  await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines));
  const preview = JSON.parse(previewLines.at(-1)!);

  const owner = await acquireWorkspaceSyncMutex(root, "cli", { attempts: 1 });
  const waited: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, deps(waited, {
    mutexOptions: {
      acquisitionDeadlineMs: 1_000,
      retryDelayMs: 1,
      sleep: async () => { await releaseWorkspaceSyncMutex(owner); },
    },
  }))).toBe(0);
  expect(waited).toContain("waiting for the current sync cycle to finish…");

  const blocking = await acquireWorkspaceSyncMutex(root, "cli", { attempts: 1 });
  let now = 0;
  const timedOut: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, deps(timedOut, {
    mutexOptions: {
      acquisitionDeadlineMs: 100,
      retryDelayMs: 50,
      nowMs: () => now,
      sleep: async (ms) => { now += ms; },
    },
  }))).toBe(1);
  expect(JSON.parse(timedOut.at(-1)!)).toMatchObject({ status: "refused", code: "sync-busy" });
  expect(JSON.parse(timedOut.at(-1)!).message).toContain("timed out waiting");
  await releaseWorkspaceSyncMutex(blocking);
});

test("keep-mine refuses reserved current-branch divergence without clearing anything", async () => {
  await fixture();
  const before = JSON.stringify(await loadState(root, syncStreamId(cfg)));
  const lines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true, forceDiscardIncoming: true }, deps(lines))).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "refused", code: "conflict" });
  expect(JSON.parse(lines.at(-1)!).message).toContain("rbox won't pick a side");
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(before);
});

test("keep-mine refuses BASE-present pending-present local-absent branch shape", async () => {
  await fixture();
  await git(receiver, "checkout", "-q", "local-topic");
  await git(receiver, "branch", "-D", "main");
  const before = JSON.stringify(await loadState(root, syncStreamId(cfg)));
  const lines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true, forceDiscardIncoming: true }, deps(lines))).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "refused", code: "conflict" });
  expect(JSON.parse(lines.at(-1)!).message).toContain("rbox still tracks it as synced");
  expect(JSON.stringify(await loadState(root, syncStreamId(cfg)))).toBe(before);
});

test("keep-mine voids a config-only race and requires a real pending section", async () => {
  const { incoming } = await fixture();
  const incomingTip = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
  const previewLines: string[] = [];
  await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines));
  const preview = JSON.parse(previewLines.at(-1)!);
  await git(receiver, "config", "branch.main.rebase", "true");
  const raced: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true, confirm: preview.current.snapshot,
  }, deps(raced))).toBe(1);
  expect(JSON.parse(raced.at(-1)!)).toMatchObject({ status: "snapshot-mismatch", verb: "keep-mine" });

  const state = await loadState(root, syncStreamId(cfg));
  delete state.repoRecords!.repo!.pending;
  await saveStateUnsafeLegacyOrTest(root, state);
  const absent: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(absent))).toBe(1);
  expect(JSON.parse(absent.at(-1)!)).toMatchObject({ status: "refused", code: "no-incoming" });
  expect(repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.deferrals?.apply).toBeDefined();
});

test("keep-mine binds the exact incremental capture-policy setting", async () => {
  const { incoming } = await fixture();
  const incomingTip = incoming.refs["refs/heads/main"]!;
  await git(receiver, "fetch", "-q", sender, incomingTip);
  await git(receiver, "reset", "--hard", incomingTip);
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
  const previewLines: string[] = [];
  await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines));
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview.current.snapshot).toBeString();

  cfg.git = { incremental: false };
  const raced: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true, confirm: preview.current.snapshot,
  }, deps(raced))).toBe(1);
  expect(JSON.parse(raced.at(-1)!)).toMatchObject({ status: "snapshot-mismatch", verb: "keep-mine" });
});

test("keep-mine voids pending-key and effective-scope races at the immediate pre-write reload", async () => {
  const preparePreview = async (): Promise<{ snapshot: string }> => {
    const { incoming } = await fixture();
    const incomingTip = incoming.refs["refs/heads/main"]!;
    await git(receiver, "fetch", "-q", sender, incomingTip);
    await git(receiver, "reset", "--hard", incomingTip);
    await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
    await git(receiver, "-c", "user.email=resolve@example.invalid", "-c", "user.name=resolve", "commit", "--allow-empty", "-qm", "keep local ahead");
    const lines: string[] = [];
    await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(lines));
    const preview = JSON.parse(lines.at(-1)!);
    expect(preview.status).toBe("preview");
    return { snapshot: preview.current.snapshot };
  };

  const pendingPreview = await preparePreview();
  const pendingRace: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: pendingPreview.snapshot,
  }, deps(pendingRace, {
    beforeConfirmRecheck: async () => {
      const raced = await loadState(root, syncStreamId(cfg));
      const pending = raced.repoRecords!.repo!.pending!;
      raced.repoRecords!.repo!.pending = {
        ...pending,
        refs: {
          ...pending.refs,
          "refs/tags/pending-key-race": pending.refs["refs/heads/main"]!,
        },
      };
      await saveStateUnsafeLegacyOrTest(root, raced);
    },
  }))).toBe(1);
  expect(JSON.parse(pendingRace.at(-1)!)).toMatchObject({ status: "snapshot-mismatch", verb: "keep-mine" });

  // Rebuild a fresh fixture, then change only the on-disk repository
  // representation from a directory to a gitfile pointing at the same bytes.
  // That flips the effective capture scope all→scoped without changing refs.
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  const scopePreview = await preparePreview();
  const scopeRace: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: scopePreview.snapshot,
  }, deps(scopeRace, {
    beforeConfirmRecheck: async () => {
      const gitDir = path.join(receiver, ".git");
      const pointed = path.join(receiver, ".git-pointed");
      await fs.rename(gitDir, pointed);
      await fs.writeFile(gitDir, `gitdir: ${pointed}\n`);
    },
  }))).toBe(1);
  expect(JSON.parse(scopeRace.at(-1)!)).toMatchObject({ status: "snapshot-mismatch", verb: "keep-mine" });
});

test("resolve maps workspace contention to the closed sync-busy refusal", async () => {
  await fixture();
  const held = await acquireWorkspaceSyncMutex(root, "cli");
  const lines: string[] = [];
  try {
    expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(lines))).toBe(1);
  } finally {
    await releaseWorkspaceSyncMutex(held);
  }
  expect(JSON.parse(lines.at(-1)!)).toEqual({
    status: "refused", verb: "show-me", repo: "repo", code: "sync-busy",
    message: "daemon/CLI is syncing; retry, or run `rbox stop` first",
  });
});

test("resolve maps missing incoming state and unknown exceptions to closed codes", async () => {
  await fixture();
  const state = await loadState(root, syncStreamId(cfg));
  if (state.repoRecords) delete state.repoRecords.repo;
  await saveStateUnsafeLegacyOrTest(root, state);
  const missing: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(missing))).toBe(1);
  expect(JSON.parse(missing.at(-1)!)).toMatchObject({ code: "no-incoming", message: "no deferred incoming Git state is available for this repository" });

  const failed: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(failed, {
    build: async () => { throw new Error("Authorization: Bearer secret-token\n/private/path\u001b[2J"); },
  }))).toBe(1);
  const output = failed.at(-1)!;
  expect(JSON.parse(output)).toMatchObject({ code: "operation-failed" });
  expect(output).not.toContain("secret-token");
  expect(output).not.toContain("/private/path");
  expect(output).not.toMatch(/[\r\n\u001b]/);
});

test("hostile repository arguments produce identical safe JSON and human semantics", async () => {
  const hostile = "https://user:password@example.invalid/outside\nAuthorization: Bearer token";
  const jsonLines: string[] = [];
  expect(await gitResolveCmd(root, hostile, "show-me", { json: true }, deps(jsonLines))).toBe(1);
  const json = JSON.parse(jsonLines.at(-1)!);
  const human: string[] = [];
  expect(await gitResolveCmd(root, hostile, "show-me", {}, deps(human))).toBe(1);
  expect(json).toMatchObject({ code: "operation-failed", message: "the Git resolution could not complete safely; no confirmation can be reused" });
  expect(human.join("\n")).toContain(json.message);
  expect(`${jsonLines.join("\n")}\n${human.join("\n")}`).not.toMatch(/user:password|Bearer token|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/);
});

test("safe resolve rendering keeps multiline error words separated", () => {
  const error = new Error("first line\nsecond line");
  expect(safeResolveText(error.message, root)).toBe("first line second line");
});

test("resolve maps indeterminate proof, journal recovery, and degraded mutex to closed codes", async () => {
  await fixture();
  const proof: string[] = [];
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true }, deps(proof, { forceProofIndeterminate: true }))).toBe(1);
  expect(JSON.parse(proof.at(-1)!)).toMatchObject({ code: "proof-indeterminate", message: "proof could not complete; retry after Git state settles" });

  const journalDir = checkoutJournalDir(root, "repo");
  await fs.mkdir(journalDir, { recursive: true });
  await fs.writeFile(path.join(journalDir, "journal.json"), "{corrupt\n");
  const journal: string[] = [];
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(journal))).toBe(1);
  expect(JSON.parse(journal.at(-1)!)).toMatchObject({ code: "journal-recovery" });
  expect(journal.at(-1)).not.toContain(journalDir);
  await fs.rm(journalDir, { recursive: true, force: true });

  await makeKeepMinePreviewable();
  const previewLines: string[] = [];
  await gitResolveCmd(root, receiver, "keep-mine", { json: true }, deps(previewLines));
  const preview = JSON.parse(previewLines.at(-1)!);
  const pendingBefore = repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.pending;
  let confirmedPushCalls = 0;
  const degraded: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, deps(degraded, {
    mutexOptions: { lock: { identity: { current: async () => { throw new Error("private identity failure"); }, probe: async () => ({ status: "unknown" }) } } },
    confirmedPush: async () => {
      confirmedPushCalls++;
      throw new Error("degraded keep-mine must not publish");
    },
  }))).toBe(1);
  expect(JSON.parse(degraded.at(-1)!)).toMatchObject({
    code: "mutex-degraded",
    message: "locking unavailable; keep-mine will not publish until safe serialization is restored",
  });
  expect(degraded.at(-1)).not.toContain("private identity failure");
  expect(confirmedPushCalls).toBe(0);
  expect(repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.pending).toEqual(pendingBefore);
});

/**
 * Design 271 §2.7: the two refusals inside `makeIntended` cannot emit and
 * return, so they travel as error classes the outer catch classifies into their
 * own code and curated, path-free message — never the generic catch-all.
 */
test("the two makeIntended error classes classify into their own resolve codes", async () => {
  await fixture();
  const cases = [
    { error: new ManualLineageProofUnavailableError(), code: "manual-lineage-proof" },
    { error: new ManualBaseProofIncompleteError(), code: "manual-base-proof" },
  ] as const;
  for (const { error, code } of cases) {
    const lines: string[] = [];
    expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true }, deps(lines, {
      build: async () => { throw error; },
    }))).toBe(1);
    const output = lines.at(-1)!;
    const parsed = JSON.parse(output);
    expect(parsed.code).toBe(code);
    expect(parsed.status).toBe("refused");
    expect(parsed.message).not.toContain("/");
    expect(output).not.toMatch(/[\r\n\u001b]/);
  }
});

test("take-theirs and keep-mine report their steps on stderr, never on stdout", async () => {
  await fixture();
  const out: string[] = [];
  const err: string[] = [];
  await gitResolveCmd(root, receiver, "take-theirs", { json: true }, deps([], {
    stdout: (line: string) => out.push(line),
    stderr: (line: string) => err.push(line),
  }));
  expect(err.some((line) => line.startsWith("take-theirs: "))).toBe(true);
  for (const line of out) expect(line.startsWith("take-theirs: ")).toBe(false);
  // Every stdout line stays parseable JSON under --json.
  for (const line of out) expect(() => JSON.parse(line)).not.toThrow();
});

/**
 * Design 271 §2.7: the three refusals in the resolve mutex body emit their own
 * code and curated, path-free text instead of collapsing into the catch-all.
 * `artifact` is the one whose raw hold reason exists at all — it is REPLACED,
 * never appended, because it stringifies arbitrary errors and may name paths.
 */
test("the standing-artifact refusal replaces its raw hold reason with curated text", async () => {
  const { incoming } = await fixture();
  const current = await show([]);
  const lines: string[] = [];

  const code = await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: current.snapshot }, deps(lines, {
    // A foreign artifact planted inside the protocol namespace during the
    // follow: the post-landing settlement scan refuses it.
    beforeSecondProof: async () => {
      await git(receiver, "update-ref",
        `refs/rbox-local/base-present/v2/${"a".repeat(64)}/${"b".repeat(64)}`,
        incoming.refs["refs/heads/main"]!);
    },
  }));

  expect(code).toBe(1);
  const output = lines.at(-1)!;
  expect(JSON.parse(output)).toEqual({
    status: "refused", verb: "take-theirs", repo: "repo", code: "artifact",
    message: "the incoming checkout was applied but its settlement could not finish; your prior state is preserved in the Git quarantine — retry after Git state settles",
  });
  // The raw hold reason names the namespace it refused; none of it may leak.
  expect(output).not.toContain("rbox-local/base-present");
  expect(output).not.toContain(root);
  expect(output).not.toMatch(/[\r\n\u001b]/);
});

test("the incomplete-checkout refusal emits its own code and curated text on both surfaces", async () => {
  await fixture();
  const message = "the incoming checkout was published for some refs but not all; the resolution is incomplete — retry after Git state settles";
  const json: string[] = [];
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: (await show([])).snapshot },
    deps(json, { forceMutexBodyRefusal: "incomplete-checkout" }))).toBe(1);
  expect(JSON.parse(json.at(-1)!)).toEqual({
    status: "refused", verb: "take-theirs", repo: "repo", code: "incomplete-checkout", message,
  });
  expect(json.at(-1)).not.toContain(root);
  expect(json.at(-1)).not.toMatch(/[\r\n\u001b]/);

});

test("the incomplete-checkout refusal renders the same curated text for a human", async () => {
  await fixture();
  const human: string[] = [];
  expect(await gitResolveCmd(root, receiver, "take-theirs", { confirm: (await show([])).snapshot },
    deps(human, { forceMutexBodyRefusal: "incomplete-checkout" }))).toBe(1);
  expect(human.filter((line) => !line.startsWith("take-theirs: ")).join("\n"))
    .toContain("the incoming checkout was published for some refs but not all");
  expect(human.join("\n")).not.toContain(root);
});

test("the journal-recovery refusal emits its own code and curated text", async () => {
  await fixture();
  const json: string[] = [];
  expect(await gitResolveCmd(root, receiver, "take-theirs", { json: true, confirm: (await show([])).snapshot },
    deps(json, { forceMutexBodyRefusal: "journal-recovery" }))).toBe(1);
  expect(JSON.parse(json.at(-1)!)).toEqual({
    status: "refused", verb: "take-theirs", repo: "repo", code: "journal-recovery",
    message: "the published checkout journal could not be recovered; retry after Git state settles, or inspect the local recovery copy",
  });
  expect(json.at(-1)).not.toContain(root);
  expect(json.at(-1)).not.toMatch(/[\r\n\u001b]/);
});
