import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { LocalBlobStore, buildIgnoreMatcher, captureGitState, type GitSection, type Manifest } from "../engine/index.js";
import { loadState, repoRecordsForState, saveState, syncStreamId, type SyncState, type WorkspaceConfig } from "./config.js";
import { gitResolveCmd, type GitResolveShow } from "./git-cmd.js";
import { applyGitSections } from "./sync-git/apply.js";
import { gitFollowEnabled } from "./sync-git/shared.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then(({ stdout }) => stdout.toString().trim());
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

async function fixture(opts: { branchSwitch?: boolean } = {}) {
  await commit(sender, "base\n", "base");
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
  await fs.writeFile(path.join(receiver, "tracked.txt"), "base\n");

  if (opts.branchSwitch) await git(sender, "checkout", "-q", "next");
  await commit(sender, "incoming\n", "incoming");
  const incoming = await capture();

  await commit(receiver, "local\n", "local-only");
  const localTip = await git(receiver, "rev-parse", "HEAD");
  await git(receiver, "branch", "local-topic");
  const state: SyncState = {
    stream: syncStreamId(cfg),
    stateNonce: "b".repeat(32),
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
  await saveState(root, state);
  return { base, incoming, localTip };
}

function deps(lines: string[], extra: Parameters<typeof gitResolveCmd>[4] = {}) {
  return {
    build: async () => ({ cfg, store }),
    capabilityProbe: async () => true,
    stdout: (line: string) => lines.push(line),
    stderr: (line: string) => lines.push(line),
    now: () => new Date("2026-07-13T01:00:00.000Z"),
    ...extra,
  };
}

async function show(lines: string[]): Promise<GitResolveShow> {
  expect(await gitResolveCmd(root, receiver, "show-me", { json: true }, deps(lines))).toBe(0);
  return JSON.parse(lines.at(-1)!) as GitResolveShow;
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

test("take-theirs quarantines, pins, follows under the kill switch, and clears state", async () => {
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
  expect(saved.pending).toBeUndefined();
  expect(saved.resolutionKey).toBeUndefined();
  expect(saved.partial).toBeUndefined();
  expect(saved.deferrals?.apply).toBeUndefined();
  const quarantineRoot = path.join(root, ".rbox", "git-quarantine");
  expect((await fs.readdir(path.join(quarantineRoot, (await fs.readdir(quarantineRoot))[0]!))).some((name) => name.endsWith(".bundle"))).toBe(true);
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

test("take-theirs aborts and re-shows when the locked snapshot changes", async () => {
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
  expect(result.message).toContain("sibling-next");
});

test("keep-mine is a typed unsupported result and never clears pending state", async () => {
  await fixture();
  const lines: string[] = [];
  expect(await gitResolveCmd(root, receiver, "keep-mine", { json: true, forceDiscardIncoming: true }, deps(lines))).toBe(1);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({
    status: "unsupported",
    verb: "keep-mine",
    code: "not-yet-supported",
  });
  expect(repoRecordsForState(await loadState(root, syncStreamId(cfg))).repo?.pending).toBeDefined();
});
