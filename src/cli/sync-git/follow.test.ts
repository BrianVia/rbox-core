import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  LocalBlobStore,
  buildIgnoreMatcher,
  captureGitState,
  hashBytes,
  indexIdentityV2,
  oracleFromState,
  probeReceiverEquivalence,
  resetCheckoutCapabilityProbeCacheForTests,
  setReceiverEquivalenceProbeForTests,
  type AppliedManifestOracle,
  type GitSection,
  type Manifest,
} from "../../engine/index.js";
import { repoCtx } from "../../engine/git/shared.js";
import { loadState, repoRecordsForState, saveState, type SyncState, type WorkspaceConfig } from "../config.js";
import type { SyncRemote } from "../remote.js";
import { orderedRepoDeferralUpdates, saveStateSource } from "../sync-state.js";
import { applyGitSections, withRevalidatedGitPartialApplies } from "./apply.js";
import { checkoutJournalBinding, FollowCrashInjectedError, recoverFollowJournal, type FollowCrashPoint } from "./follow.js";
import { planGitSections } from "./plan.js";
import { configCredentialSkipLogged, configInvalidSkipLogged, configOwnershipSkipLogged, gitFollowEnabled, repoEquivalenceWarningLogged } from "./shared.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then(({ stdout }) => stdout.toString().trim());
const KEK = Buffer.alloc(32, 19);

const hostReceiverEquivalence = await (async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-equivalence-"));
  try {
    return await probeReceiverEquivalence(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
})();

let tmp: string;
let sender: string;
let workspace: string;
let receiver: string;
let store: LocalBlobStore;
let cfg: WorkspaceConfig;
let priorGitFollow: string | undefined;

beforeEach(async () => {
  priorGitFollow = process.env.RBOX_GIT_FOLLOW;
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-follow-"));
  sender = path.join(tmp, "sender");
  workspace = path.join(tmp, "workspace");
  receiver = path.join(workspace, "repo");
  await fs.mkdir(sender, { recursive: true });
  await fs.mkdir(path.join(workspace, ".rbox", "state"), { recursive: true });
  await git(sender, "init", "-qb", "main");
  await git(sender, "config", "user.email", "follow@example.invalid");
  await git(sender, "config", "user.name", "follow");
  store = new LocalBlobStore(path.join(tmp, "blobs"));
  cfg = {
    remoteWorkspaceId: "ws_follow",
    projectId: "root",
    deviceId: "receiver",
    rootPath: workspace,
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
  if (priorGitFollow === undefined) delete process.env.RBOX_GIT_FOLLOW;
  else process.env.RBOX_GIT_FOLLOW = priorGitFollow;
  resetCheckoutCapabilityProbeCacheForTests();
  setReceiverEquivalenceProbeForTests(undefined);
  configOwnershipSkipLogged.clear();
  configInvalidSkipLogged.clear();
  configCredentialSkipLogged.clear();
  repoEquivalenceWarningLogged.clear();
  await fs.rm(tmp, { recursive: true, force: true });
});

async function commit(content: string, message: string): Promise<string> {
  await fs.writeFile(path.join(sender, "tracked.txt"), content);
  await git(sender, "add", "tracked.txt");
  await git(sender, "commit", "-qm", message);
  return git(sender, "rev-parse", "HEAD");
}

const manifest = (section: GitSection): Manifest => ({ generatedAt: "", files: [], manifestSchema: 2, gitRepos: { repo: section } });
const stateWith = (section?: GitSection): SyncState => ({
  stream: "test-stream",
  stateNonce: "n".repeat(32),
  lastSyncedSequence: section ? 1 : 0,
  lastSyncedManifest: section ? manifest(section) : { generatedAt: "", files: [] },
  ...(section ? { repoRecords: { repo: { repoGen: 1, sourceSeq: 1, base: section } } } : {}),
});

const matchingOracle: AppliedManifestOracle = {
  proveRepo: async () => ({ kind: "match" }),
  reproveRepo: async () => ({ kind: "match" }),
  receiptHash: () => "receipt",
};

async function capture(): Promise<GitSection> {
  const section = await captureGitState(sender, store, KEK);
  if (!section) throw new Error("capture returned no section");
  return section;
}

async function materialize(section: GitSection): Promise<void> {
  const outcome = await applyGitSections(workspace, cfg, stateWith(), manifest(section), store, buildIgnoreMatcher(workspace), () => {});
  expect(outcome.gitRepos?.repo).toEqual(section);
}

async function baseAndIncoming(mode: "same" | "switch" | "detached" = "same"): Promise<{ c1: string; base: GitSection; incoming: GitSection; state: SyncState }> {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  const base = await capture();
  await materialize(base);
  if (mode === "switch") await git(sender, "checkout", "-qb", "next");
  else if (mode === "detached") await git(sender, "checkout", "-q", "--detach");
  await commit("three\n", "c3");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  return { c1, base, incoming, state: stateWith(base) };
}

async function applyIncoming(state: SyncState, incoming: GitSection, oracle: AppliedManifestOracle = matchingOracle, extra: Parameters<typeof applyGitSections>[7] = {}) {
  const logs: string[] = [];
  const outcome = await applyGitSections(workspace, cfg, state, manifest(incoming), store, buildIgnoreMatcher(workspace), (line) => logs.push(line), {
    oracle,
    sourceGlobalSeq: 2,
    capabilityProbe: async () => true,
    ...extra,
  });
  return { outcome, logs };
}

test("RBOX_GIT_FOLLOW parses only exact zero as disabled", () => {
  expect(gitFollowEnabled({})).toBe(true);
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "0" })).toBe(false);
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "00" })).toBe(true);
  expect(gitFollowEnabled({ RBOX_GIT_FOLLOW: "invalid" })).toBe(true);
});

test("field incident: stale contained attached tip follows HEAD, tip, and semantic index", async () => {
  const setup = await baseAndIncoming();
  const { c1, base, state } = setup;
  await fs.writeFile(path.join(sender, ".git", "MERGE_HEAD"), `${c1}\n`);
  const incoming = await capture();
  const baseTip = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, baseTip);

  const { outcome, logs } = await applyIncoming(state, incoming);

  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  expect(await fs.readFile(path.join(receiver, ".git", "HEAD"), "utf8")).toBe("ref: refs/heads/main\n");
  const liveProjection = await indexIdentityV2(receiver, path.join(receiver, ".git", "index"));
  expect(liveProjection).toBe(outcome.idxProj?.repo);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(await fs.readFile(path.join(receiver, ".git", "MERGE_HEAD"), "utf8")).toBe(`${c1}\n`);

  await withRevalidatedGitPartialApplies(workspace, state, outcome, async () => undefined);
  expect(await fs.readdir(path.join(workspace, ".rbox", "state", "git-journal"))).toEqual([]);
});

test("field incident follows an incoming branch switch", async () => {
  const { c1, state, incoming } = await baseAndIncoming("switch");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/next");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/next"]);
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(incoming.refs["refs/heads/main"]);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
  await withRevalidatedGitPartialApplies(workspace, state, outcome, async () => undefined);
});

test("degraded clean arm defers a sibling-owned intersection as a whole section", async () => {
  await commit("one\n", "c1");
  const baseTip = await commit("two\n", "c2");
  await git(sender, "branch", "side", baseTip);
  const base = await capture();
  await materialize(base);

  const sibling = path.join(tmp, "receiver-side-worktree");
  await git(receiver, "worktree", "add", "-q", sibling, "side");
  const incomingTip = await commit("three\n", "c3");
  await git(sender, "branch", "-f", "side", incomingTip);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");

  const { outcome } = await applyIncoming(stateWith(base), incoming, matchingOracle, { degradedMutex: true });
  expect(outcome.gitRepos?.repo).toEqual(base);
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("worktree-ownership");
  expect(outcome.partial?.repo).toBeUndefined();
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(base.refs["refs/heads/main"]);
  expect(await git(sibling, "rev-parse", "refs/heads/side")).toBe(baseTip);
});

test("field incident follows a contained stale tip to detached incoming HEAD", async () => {
  const { c1, state, incoming } = await baseAndIncoming("detached");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  await expect(git(receiver, "symbolic-ref", "HEAD")).rejects.toThrow();
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.head.trim());
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(incoming.refs["refs/heads/main"]);
  expect(outcome.gitRepos?.repo).toEqual(incoming);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
  expect(outcome.deferrals?.repo?.apply).toBeUndefined();
  await withRevalidatedGitPartialApplies(workspace, state, outcome, async () => undefined);
});

test("design safety: detached receiver follows an incoming attached branch", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "HEAD"), `${c1}\n`);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  expect(outcome.gitPendingRemote?.repo).toBeUndefined();
  expect(outcome.partial?.repo).toBeNull();
});

test("disposition: staged index changes defer local-index", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "staged.txt"), "human\n");
  await git(receiver, "add", "staged.txt");
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-index");
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
});

for (const semanticEdit of ["skip-worktree", "assume-unchanged", "intent-to-add"] as const) {
  test(`clean production arm preserves ${semanticEdit} and defers local-index`, async () => {
    const { state, incoming } = await baseAndIncoming();
    const baseTip = await git(receiver, "rev-parse", "HEAD");
    if (semanticEdit === "intent-to-add") {
      await fs.writeFile(path.join(receiver, "intent.txt"), "human intent\n");
      await git(receiver, "add", "-N", "intent.txt");
    } else {
      await git(receiver, "update-index", `--${semanticEdit}`, "tracked.txt");
    }
    const projectionBefore = await indexIdentityV2(receiver, path.join(receiver, ".git", "index"));
    const { outcome } = await applyIncoming(state, incoming);
    expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-index");
    expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
    expect(await git(receiver, "rev-parse", "HEAD")).toBe(baseTip);
    expect(await indexIdentityV2(receiver, path.join(receiver, ".git", "index"))).toBe(projectionBefore);
    if (semanticEdit === "skip-worktree") {
      expect(await git(receiver, "ls-files", "-v", "tracked.txt")).toStartWith("S ");
    } else if (semanticEdit === "assume-unchanged") {
      expect(await git(receiver, "ls-files", "-v", "tracked.txt")).toStartWith("h ");
    } else {
      expect(await git(receiver, "ls-files", "--debug", "intent.txt")).toContain("flags: 20004000");
    }
  });
}

test("design safety: local merge state defers local-operation", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
});

for (const [label, rel] of [
  ["rebase", "rebase-merge/head-name"],
  ["cherry-pick", "CHERRY_PICK_HEAD"],
] as const) {
  test(`design safety: local ${label} state defers local-operation`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    await fs.mkdir(path.dirname(path.join(receiver, ".git", rel)), { recursive: true });
    await fs.writeFile(path.join(receiver, ".git", rel), `${c1}\n`);
    const { outcome } = await applyIncoming(state, incoming);
    expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-operation");
    expect(await fs.readFile(path.join(receiver, ".git", rel), "utf8")).toBe(`${c1}\n`);
  });
}

test("design safety: mode-only index edit defers local-index with working bytes untouched", async () => {
  const { state, incoming } = await baseAndIncoming();
  const bytes = await fs.readFile(path.join(receiver, "tracked.txt"));
  await git(receiver, "update-index", "--chmod=+x", "tracked.txt");
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-index");
  expect(await fs.readFile(path.join(receiver, "tracked.txt"))).toEqual(bytes);
  expect(await git(receiver, "ls-files", "-s", "tracked.txt")).toStartWith("100755 ");
});

test("disposition: oracle mismatch wins display precedence as local-edits", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "mismatch", sample: ["tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const { outcome } = await applyIncoming(state, incoming, oracle);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
});

test("disposition: receiver-only current commit defers local-commits", async () => {
  const { state, incoming } = await baseAndIncoming();
  const withSafeRef = { ...incoming, refs: { ...incoming.refs, "refs/heads/incoming-side": incoming.refs["refs/heads/main"]! } };
  await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "receiver only");
  const { outcome } = await applyIncoming(state, withSafeRef);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
  expect(await git(receiver, "rev-parse", "refs/heads/incoming-side")).toBe(withSafeRef.refs["refs/heads/incoming-side"]);
  expect(outcome.partial?.repo?.appliedRefs["refs/heads/incoming-side"]).toBeDefined();
});

test("R2-2 invalidated partial ref moved back to base is held, never republished", async () => {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  await git(sender, "branch", "side", c1);
  const base = await capture();
  await materialize(base);
  await commit("three\n", "c3");
  await git(sender, "branch", "-f", "side", await git(sender, "rev-parse", "main"));
  const incoming = await capture();
  const state = stateWith(base);
  await saveState(workspace, state);

  await fs.writeFile(path.join(receiver, "tracked.txt"), "human first episode\n");
  const mismatch: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const first = await applyIncoming(state, incoming, mismatch);
  const incomingSide = incoming.refs["refs/heads/side"]!;
  const baseSide = base.refs["refs/heads/side"]!;
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingSide);
  expect(first.outcome.partial?.repo?.appliedRefs["refs/heads/side"]).toEqual({ kind: "direct", oid: incomingSide });
  const saved = await saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  });

  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await git(receiver, "update-ref", "refs/heads/side", baseSide, incomingSide);
  const retry = await applyIncoming(saved, incoming);

  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(baseSide);
  expect(retry.outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(retry.outcome.partial?.repo?.heldRefs["refs/heads/side"]).toBe("local-commits");
  expect(retry.outcome.deferrals?.repo?.apply?.reason).toBe("local-commits");
});

test("disposition: receiver-only non-current branch is held while checkout follows", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await exec("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "side only"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs.some((line) => line.startsWith("git-sync followed repo"))).toBe(true);
  expect(outcome.partial?.repo?.heldRefs["refs/heads/local-side"]).toBe("local-commits");
  expect(outcome.partial?.repo?.checkoutPending).toBe(false);
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(await git(receiver, "rev-parse", "refs/heads/local-side")).toBe(local);
});

test("design safety: receiver-only tag is held and reachable while the safe checkout follows", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await exec("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", c1, "-m", "tag-only commit"])
    .then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/tags/receiver-only", local);
  const { outcome, logs } = await applyIncoming(state, incoming);
  expect(logs).toContain("git-sync followed repo");
  expect(outcome.partial?.repo?.heldRefs["refs/tags/receiver-only"]).toBe("local-commits");
  expect(outcome.partial?.repo?.checkoutPending).toBe(false);
  expect(await git(receiver, "rev-parse", "refs/tags/receiver-only")).toBe(local);
  await expect(git(receiver, "cat-file", "-e", `${local}^{commit}`)).resolves.toBe("");
});

test("design safety: ignored human file stays byte-identical and does not block metadata follow", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(workspace, ".rboxignore"), "repo/*.local\n");
  await fs.writeFile(path.join(receiver, "human.local"), "precious ignored bytes\n");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const expected = "three\n";
  const oracle = oracleFromState({
    root: workspace,
    matcher: buildIgnoreMatcher(workspace),
    base: {
      generatedAt: "",
      files: [{
        path: "repo/tracked.txt", type: "file", sha256: hashBytes(Buffer.from(expected)),
        size: Buffer.byteLength(expected), mode: 0o644, mtimeMs: 0,
      }],
    },
  });
  const { logs } = await applyIncoming(state, incoming, oracle);
  expect(logs).toContain("git-sync followed repo");
  expect(await fs.readFile(path.join(receiver, "human.local"), "utf8")).toBe("precious ignored bytes\n");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
});

test("deferredSince survives a partial follow followed by a new defer reason", async () => {
  const { state, incoming } = await baseAndIncoming();
  const tree = await git(receiver, "write-tree");
  const local = await exec("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", await git(receiver, "rev-parse", "HEAD"), "-m", "side only"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  await saveState(workspace, state);
  const first = await applyIncoming(state, incoming);
  const since = first.outcome.deferrals?.repo?.apply?.deferredSince;
  const saved = await saveStateSource(workspace, state, {
    expectedStream: "test-stream", sourceGlobalSeq: 2, observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  });
  const unreadable: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "indeterminate", why: "later read failure" }),
    reproveRepo: async () => ({ kind: "indeterminate", why: "later read failure" }),
    receiptHash: () => undefined,
  };
  await commit("four\n", "c4 after partial");
  const newer = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "four\n");
  const second = await applyIncoming(saved, newer, unreadable, { sourceGlobalSeq: 3 });
  expect(second.outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
  expect(second.outcome.deferrals?.repo?.apply?.deferredSince).toBe(since);
});

test("disposition: receiver-only stash defers local-stash and preserves stash", async () => {
  const { state, incoming } = await baseAndIncoming();
  await fs.writeFile(path.join(receiver, "stash.txt"), "stash work\n");
  await git(receiver, "add", "stash.txt");
  await git(receiver, "stash", "push", "-qm", "receiver stash");
  await fs.rm(path.join(receiver, ".git", "ORIG_HEAD"), { force: true });
  const stash = await git(receiver, "rev-parse", "refs/stash");
  const { outcome } = await applyIncoming(state, incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("local-stash");
  expect(await git(receiver, "rev-parse", "refs/stash")).toBe(stash);
});

test("incoming stash publishes a usable receiver reflog entry", async () => {
  const { c1, state } = await baseAndIncoming();
  await fs.writeFile(path.join(sender, "stash.txt"), "incoming stash\n");
  await git(sender, "add", "stash.txt");
  await git(sender, "stash", "push", "-qm", "incoming stash row");
  const incoming = await capture();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const result = await applyIncoming(state, incoming);
  expect(result.logs).toContain("git-sync followed repo");
  expect(await git(receiver, "stash", "list")).toContain("incoming stash row");
  await git(receiver, "stash", "pop", "-q");
  expect(await fs.readFile(path.join(receiver, "stash.txt"), "utf8")).toBe("incoming stash\n");
});

test("oracle indeterminate defers unreadable", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "indeterminate", why: "test unreadable" }),
    reproveRepo: async () => ({ kind: "indeterminate", why: "test unreadable" }),
    receiptHash: () => undefined,
  };
  const { outcome } = await applyIncoming(state, incoming, oracle);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
});

test("flag zero keeps the legacy conflict checkpoint; invalid values stay on", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  process.env.RBOX_GIT_FOLLOW = "0";
  const flagged = { ...incoming, refs: { ...incoming.refs, "refs/heads/flag-safe": incoming.refs["refs/heads/main"]! } };
  const off = await applyIncoming(state, flagged);
  expect(off.outcome.gitNeedsResolution?.repo).toBeDefined();
  expect(off.outcome.deferrals?.repo?.apply?.reason).toBe("conflict");
  expect(await git(receiver, "rev-parse", "refs/heads/flag-safe")).toBe(flagged.refs["refs/heads/flag-safe"]);

  process.env.RBOX_GIT_FOLLOW = "invalid";
  const checkpoint: SyncState = {
    stream: state.stream,
    stateNonce: state.stateNonce,
    lastSyncedSequence: 2,
    lastSyncedManifest: manifest(flagged),
    gitNeedsResolution: { repo: off.outcome.gitNeedsResolution!.repo },
    repoRecords: {
      repo: {
        repoGen: 2,
        sourceSeq: 2,
        base: flagged,
        idxProj: off.outcome.idxProj?.repo ?? undefined,
        resolutionKey: off.outcome.gitNeedsResolution!.repo,
        deferrals: { apply: off.outcome.deferrals!.repo!.apply! },
      },
    },
  };
  const on = await applyIncoming(checkpoint, flagged);
  expect(on.logs).toContain("git-sync followed repo");
  expect(on.outcome.gitNeedsResolution?.repo).toBeUndefined();
});

test("unsupported checkout capability defers without creating a legacy checkpoint", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const unsupported = { ...incoming, refs: { ...incoming.refs, "refs/heads/unsupported-safe": incoming.refs["refs/heads/main"]! } };
  const { outcome } = await applyIncoming(state, unsupported, matchingOracle, { capabilityProbe: async () => false });
  expect(outcome.gitNeedsResolution?.repo).toBeUndefined();
  expect(outcome.gitRepos?.repo).toEqual(state.lastSyncedManifest.gitRepos?.repo);
  expect(outcome.gitPendingRemote?.repo).toEqual(unsupported);
  expect(outcome.partial?.repo?.checkoutPending).toBe(true);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unsupported");
  expect(await git(receiver, "rev-parse", "refs/heads/unsupported-safe")).toBe(unsupported.refs["refs/heads/unsupported-safe"]);
});

test("degraded mutex keeps legacy conflict and performs no independent follow", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const { outcome } = await applyIncoming(state, incoming, matchingOracle, { degradedMutex: true });
  expect(outcome.gitNeedsResolution?.repo).toBeDefined();
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(c1);
});

test("degraded retry performs intent rollback before taking the legacy path", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await saveState(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-ref-commit") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-ref-commit");
  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming, matchingOracle, { degradedMutex: true });
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(c1);
  expect(retry.outcome.gitNeedsResolution?.repo).toBeDefined();
});

test("second-proof oracle mismatch aborts with local-edits", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const oracle: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "match" }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const result = await applyIncoming(state, incoming, oracle);
  expect(result.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(c1);
  expect(await fs.readdir(path.join(workspace, ".rbox", "state", "git-journal")).catch(() => [])).toEqual([]);
});

type BoundaryMutation = "git-add" | "commit" | "checkout" | "stash" | "op-state";
const boundaryMutations: Array<{ mutation: BoundaryMutation; reason: string }> = [
  { mutation: "git-add", reason: "local-index" },
  // These move the current ref after the first live snapshot, so the pinned
  // transaction's exact-old-value CAS is the protecting guard.
  { mutation: "commit", reason: "other" },
  { mutation: "checkout", reason: "other" },
  { mutation: "stash", reason: "local-stash" },
  { mutation: "op-state", reason: "local-operation" },
];

for (const { mutation, reason } of boundaryMutations) {
  test(`design safety linearization: ${mutation} before the boundary is protected`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    const old = await git(receiver, "rev-parse", "refs/heads/main");
    await git(receiver, "update-ref", "refs/heads/main", c1, old);
    let mutated = false;
    let protectedOid: string | undefined;
    const mutate = async (): Promise<void> => {
      if (mutated) return;
      mutated = true;
      if (mutation === "git-add") {
        await fs.writeFile(path.join(receiver, "boundary-index.txt"), "boundary\n");
        await git(receiver, "add", "boundary-index.txt");
      } else if (mutation === "commit") {
        await git(receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "boundary commit");
      } else if (mutation === "checkout") {
        const tree = await git(receiver, "rev-parse", `${c1}^{tree}`);
        protectedOid = await exec("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", c1, "-m", "boundary checkout commit"])
          .then(({ stdout }) => stdout.toString().trim());
        await git(receiver, "branch", "boundary-checkout", protectedOid);
        await git(receiver, "checkout", "-q", "boundary-checkout");
      } else if (mutation === "stash") {
        await fs.writeFile(path.join(receiver, "boundary-stash.txt"), "boundary stash\n");
        await git(receiver, "stash", "push", "-uqm", "boundary stash");
        protectedOid = await git(receiver, "rev-parse", "refs/stash");
      } else {
        await fs.writeFile(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
      }
    };
    const result = await applyIncoming(state, incoming, matchingOracle, { capabilityProbe: async () => { await mutate(); return true; } });
    expect(result.outcome.deferrals?.repo?.apply?.reason).toBe(reason);
    expect(result.outcome.gitPendingRemote?.repo).toEqual(incoming);
    if (mutation === "checkout") {
      expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/boundary-checkout");
      expect(await git(receiver, "rev-parse", "HEAD")).toBe(protectedOid);
    } else if (mutation === "stash") {
      expect(await git(receiver, "rev-parse", "refs/stash")).toBe(protectedOid);
      await expect(git(receiver, "cat-file", "-e", `${protectedOid}^{commit}`)).resolves.toBe("");
    }
  });
}

for (const { mutation } of boundaryMutations) {
  test(`design safety linearization: ${mutation} after the boundary remains ordinary post-follow work`, async () => {
    const { c1, state, incoming } = await baseAndIncoming();
    const old = await git(receiver, "rev-parse", "refs/heads/main");
    await git(receiver, "update-ref", "refs/heads/main", c1, old);
    let mutated = false;
    const postFollow = (point: FollowCrashPoint): void => {
      if (point !== "after-published-flip" || mutated) return;
      mutated = true;
      if (mutation === "git-add") {
        fsSync.writeFileSync(path.join(receiver, "post-index.txt"), "post\n");
        execFileSync("git", ["-C", receiver, "add", "post-index.txt"]);
      } else if (mutation === "commit") {
        execFileSync("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "post-follow commit"]);
      } else if (mutation === "checkout") {
        execFileSync("git", ["-C", receiver, "checkout", "-qb", "post-follow-checkout"]);
      } else if (mutation === "stash") {
        fsSync.writeFileSync(path.join(receiver, "post-stash.txt"), "post stash\n");
        execFileSync("git", ["-C", receiver, "stash", "push", "-uqm", "post-follow stash"]);
      } else {
        fsSync.writeFileSync(path.join(receiver, ".git", "MERGE_HEAD"), `${c1}\n`);
      }
    };
    const result = await applyIncoming(state, incoming, matchingOracle, { crashAt: postFollow });
    expect(result.logs).toContain("git-sync followed repo");
    expect(mutated).toBe(true);
    if (mutation === "git-add") expect(await git(receiver, "diff", "--cached", "--name-only")).toContain("post-index.txt");
    else if (mutation === "commit") expect(await git(receiver, "log", "-1", "--format=%s")).toBe("post-follow commit");
    else if (mutation === "checkout") expect(await git(receiver, "symbolic-ref", "HEAD")).toBe("refs/heads/post-follow-checkout");
    else if (mutation === "stash") expect(await git(receiver, "stash", "list")).toContain("post-follow stash");
    else expect(await fs.readFile(path.join(receiver, ".git", "MERGE_HEAD"), "utf8")).toBe(`${c1}\n`);
  });
}

for (const point of [
  "after-safe-refs",
  "after-journal-write",
  "after-connectivity-proof",
  "after-prepare",
  "after-index-lock",
  "after-head-commit",
  "after-ref-commit",
  "before-index-publish",
  "after-index-publish",
  "mid-op-state",
  "after-published-flip",
] as const satisfies readonly FollowCrashPoint[]) {
  test(`crash recovery at ${point} is coherent and retry converges`, async () => {
    const { c1, base, state, incoming: firstIncoming } = await baseAndIncoming(point === "after-head-commit" ? "switch" : "same");
    let incoming = firstIncoming;
    if (point === "mid-op-state") {
      await fs.writeFile(path.join(sender, ".git", "MERGE_HEAD"), `${c1}\n`);
      incoming = await capture();
    }
    const old = await git(receiver, "rev-parse", "refs/heads/main");
    await git(receiver, "update-ref", "refs/heads/main", c1, old);
    await saveState(workspace, state);
    const crashAt = (seen: FollowCrashPoint) => { if (seen === point) throw new FollowCrashInjectedError(seen); };
    await expect(applyIncoming(state, incoming, matchingOracle, { crashAt })).rejects.toThrow(`injected follow crash at ${point}`);

    const retryState = await loadState(workspace, "test-stream");
    const retry = await applyIncoming(retryState, incoming);
    expect(retry.logs.some((line) => line === "git-sync followed repo" || line.startsWith("git-sync recovered published checkout repo"))).toBe(true);
    const incomingHeadRef = /^ref:\s*(refs\/\S+)/.exec(incoming.head)?.[1];
    expect(await git(receiver, "rev-parse", "HEAD")).toBe(incomingHeadRef ? incoming.refs[incomingHeadRef] : incoming.head.trim());
    const persistedAfterRetry = await loadState(workspace, "test-stream");
    expect(await indexIdentityV2(receiver, path.join(receiver, ".git", "index"))).toBe(retry.outcome.idxProj?.repo ?? persistedAfterRetry.repoRecords?.repo?.idxProj);
    await withRevalidatedGitPartialApplies(workspace, retryState, retry.outcome, async () => undefined);
    const journalRoot = path.join(workspace, ".rbox", "state", "git-journal");
    expect(await fs.readdir(journalRoot).catch(() => [])).toEqual([]);
    if (point !== "after-head-commit") expect(base.refs["refs/heads/main"]).not.toBe(incoming.refs["refs/heads/main"]);
  }, 20_000);
}

test("crash-window human ref move is preserved and takes conflict path", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await saveState(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-ref-commit") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-ref-commit");
  const tree = await git(receiver, "rev-parse", `${incoming.refs["refs/heads/main"]}^{tree}`);
  const human = await exec("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", incoming.refs["refs/heads/main"]!, "-m", "human crash-window move"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/main", human, incoming.refs["refs/heads/main"]!);

  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming);
  expect(await git(receiver, "rev-parse", "refs/heads/main")).toBe(human);
  expect(retry.outcome.gitNeedsResolution?.repo).toBeDefined();
  expect(retry.logs.some((line) => line.includes("crash-window human changes preserved"))).toBe(true);
});

test("rebind with a surviving intent journal quarantines it without touching Git", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await saveState(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-ref-commit") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-ref-commit");
  const crashTip = await git(receiver, "rev-parse", "HEAD");
  const ctx = await repoCtx(receiver);
  if (!ctx) throw new Error("receiver context missing");
  const rebound = await recoverFollowJournal(workspace, "repo", await checkoutJournalBinding("new-stream", "new-nonce", ctx));
  expect(rebound.status).toBe("binding-mismatch");
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(crashTip);
  if (rebound.status === "binding-mismatch") expect(await fs.stat(rebound.quarantinePath)).toBeDefined();
});

test("crash after safe-ref publish is idempotent and retry does not duplicate mutation", async () => {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  await git(sender, "branch", "side");
  const base = await capture();
  await materialize(base);
  await git(sender, "checkout", "-q", "side");
  await commit("side-three\n", "side c3");
  const incomingSide = await git(sender, "rev-parse", "side");
  await git(sender, "checkout", "-q", "main");
  await commit("main-three\n", "main c3");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "main-three\n");
  await git(receiver, "update-ref", "refs/heads/main", c1, base.refs["refs/heads/main"]!);
  const state = stateWith(base);
  await saveState(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-safe-refs") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-safe-refs");
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingSide);

  const retryState = await loadState(workspace, "test-stream");
  const retry = await applyIncoming(retryState, incoming);
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(incomingSide);
  expect(retry.logs).toContain("git-sync followed repo");
  expect(retry.outcome.gitPendingRemote?.repo).toBeUndefined();
  await withRevalidatedGitPartialApplies(workspace, retryState, retry.outcome, async () => undefined);
});

test("design safety: artifact failure after safe-ref progress preserves the published ref", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const withSafeRef = { ...incoming, refs: { ...incoming.refs, "refs/heads/artifact-safe": incoming.refs["refs/heads/main"]! } };
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await expect(applyIncoming(state, withSafeRef, matchingOracle, {
    crashAt: (point) => { if (point === "after-safe-refs") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-safe-refs");
  const safeTip = withSafeRef.refs["refs/heads/artifact-safe"]!;
  expect(await git(receiver, "rev-parse", "refs/heads/artifact-safe")).toBe(safeTip);

  const missing = withSafeRef.bundleEncSha;
  await fs.rm(path.join(tmp, "blobs", "blobs", missing.slice(0, 2), missing));
  const retry = await applyIncoming(state, withSafeRef);
  expect(retry.outcome.deferrals?.repo?.apply?.reason).toBe("artifact");
  expect(retry.outcome.gitPendingRemote?.repo).toEqual(withSafeRef);
  expect(await git(receiver, "rev-parse", "refs/heads/artifact-safe")).toBe(safeTip);
});

test("non-current NFF publication pins the displaced live tip in the same episode", async () => {
  const c1 = await commit("one\n", "c1");
  await commit("two\n", "c2");
  await git(sender, "branch", "side");
  const base = await capture();
  await materialize(base);
  await commit("three\n", "c3");
  const tree = await git(sender, "write-tree");
  const replacement = await exec("git", ["-C", sender, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-m", "unrelated side replacement"]).then(({ stdout }) => stdout.toString().trim());
  const displaced = base.refs["refs/heads/side"]!;
  await git(sender, "update-ref", "refs/heads/side", replacement, displaced);
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "three\n");
  await git(receiver, "update-ref", "refs/heads/main", c1, base.refs["refs/heads/main"]!);
  const result = await applyIncoming(stateWith(base), incoming);
  expect(result.logs).toContain("git-sync followed repo");
  expect(await git(receiver, "rev-parse", "refs/heads/side")).toBe(replacement);
  expect(await git(receiver, "rev-parse", `refs/rbox-local/keep/${displaced}`)).toBe(displaced);
  const origins = JSON.parse(await fs.readFile(path.join(receiver, ".git", "rbox-keep-origins.json"), "utf8"));
  expect(origins[displaced]?.some((origin: { ref: string; class: string }) => origin.ref === "refs/heads/side" && origin.class === "human")).toBe(true);
});

test("working edit made after an intent crash is untouched and retry defers local-edits", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await saveState(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-journal-write") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-journal-write");
  await fs.writeFile(path.join(receiver, "tracked.txt"), "human crash-window edit\n");
  const mismatch: AppliedManifestOracle = {
    proveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    reproveRepo: async () => ({ kind: "mismatch", sample: ["repo/tracked.txt"] }),
    receiptHash: () => undefined,
  };
  const retry = await applyIncoming(await loadState(workspace, "test-stream"), incoming, mismatch);
  expect(await fs.readFile(path.join(receiver, "tracked.txt"), "utf8")).toBe("human crash-window edit\n");
  expect(retry.outcome.deferrals?.repo?.apply?.reason).toBe("local-edits");
});

test("crash before journal clear leaves published state recoverable without duplicate mutation", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await saveState(workspace, state);
  const first = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "before-journal-clear") throw new FollowCrashInjectedError(point); },
  });
  await expect(withRevalidatedGitPartialApplies(workspace, state, first.outcome, async () => saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      resolutions: first.outcome.gitNeedsResolution,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  }))).rejects.toThrow("before-journal-clear");
  const tip = await git(receiver, "rev-parse", "HEAD");
  const landed = await loadState(workspace, "test-stream");
  const landedGen = landed.repoRecords?.repo?.repoGen;
  const retry = await applyIncoming(landed, incoming);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(tip);
  expect(retry.logs.some((line) => line.startsWith("git-sync recovered published checkout repo"))).toBe(true);
  expect((await loadState(workspace, "test-stream")).repoRecords?.repo?.repoGen).toBe(landedGen);
});

test("push planning completes a published journal before capture without echo", async () => {
  const { c1, state, incoming } = await baseAndIncoming();
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  await saveState(workspace, state);
  await expect(applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "after-published-flip") throw new FollowCrashInjectedError(point); },
  })).rejects.toThrow("after-published-flip");
  const logs: string[] = [];
  const plan = await planGitSections(
    workspace,
    cfg,
    await loadState(workspace, "test-stream"),
    {} as SyncRemote,
    new Set(),
    buildIgnoreMatcher(workspace),
    undefined,
    undefined,
    { onGitLog: (line) => logs.push(line) },
  );
  expect(logs.some((line) => line.includes("recovered published checkout repo before capture"))).toBe(true);
  expect(plan.gitRepos?.repo).toEqual(incoming);
  expect(plan.changed).toBe(false);
  expect((await loadState(workspace, "test-stream")).repoRecords?.repo?.base).toEqual(incoming);
  expect(await fs.readdir(path.join(workspace, ".rbox", "state", "git-journal")).catch(() => [])).toEqual([]);
});

test("published partial recovery is idempotent after a branch-switch hold", async () => {
  const { c1, state, incoming } = await baseAndIncoming("switch");
  const old = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", c1, old);
  const tree = await git(receiver, "write-tree");
  const local = await exec("git", ["-C", receiver, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit-tree", tree, "-p", c1, "-m", "held local side"]).then(({ stdout }) => stdout.toString().trim());
  await git(receiver, "update-ref", "refs/heads/local-side", local);
  await saveState(workspace, state);
  const first = await applyIncoming(state, incoming, matchingOracle, {
    crashAt: (point) => { if (point === "before-journal-clear") throw new FollowCrashInjectedError(point); },
  });
  expect(first.outcome.partial?.repo?.heldRefs["refs/heads/local-side"]).toBe("local-commits");
  await expect(withRevalidatedGitPartialApplies(workspace, state, first.outcome, async () => saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: {
      bases: first.outcome.gitRepos,
      pending: first.outcome.gitPendingRemote,
      deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), first.outcome.deferrals),
      partial: first.outcome.partial,
      idxProj: first.outcome.idxProj,
    },
  }))).rejects.toThrow("before-journal-clear");
  const landed = await loadState(workspace, "test-stream");
  const landedGen = landed.repoRecords?.repo?.repoGen;
  const retry = await applyIncoming(landed, incoming);
  expect(retry.logs.some((line) => line.startsWith("git-sync recovered published checkout repo"))).toBe(true);
  expect((await loadState(workspace, "test-stream")).repoRecords?.repo?.repoGen).toBe(landedGen);
});

test("steady base-clean follow repairs a stale index cache before the next contained follow", async () => {
  const { base, state, incoming } = await baseAndIncoming();
  state.repoRecords!.repo!.idxProj = "v2:stale-cache";
  await saveState(workspace, state);
  const clean = await applyIncoming(state, incoming);
  expect(clean.logs).toContain("git-sync followed repo");
  expect(clean.outcome.idxProj?.repo).toStartWith("v2:");
  const saved = await saveStateSource(workspace, state, {
    expectedStream: "test-stream",
    sourceGlobalSeq: 2,
    observedRepos: ["repo"],
    values: { bases: clean.outcome.gitRepos, partial: clean.outcome.partial, idxProj: clean.outcome.idxProj },
  });
  await commit("four\n", "c4");
  const newer = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "four\n");
  const live = await git(receiver, "rev-parse", "refs/heads/main");
  await git(receiver, "update-ref", "refs/heads/main", base.refs["refs/heads/main"]!, live);
  const followed = await applyIncoming(saved, newer, matchingOracle, { sourceGlobalSeq: 3 });
  expect(followed.logs).toContain("git-sync followed repo");
  expect(followed.outcome.deferrals?.repo?.apply?.reason).not.toBe("local-index");
});

async function captureWithLiteralIndexTwins(first: string, second: string): Promise<GitSection> {
  const parent = await git(sender, "rev-parse", "HEAD");
  await fs.writeFile(path.join(sender, "blob-source"), "same bytes\n");
  const blob = await git(sender, "hash-object", "-w", "blob-source");
  await git(sender, "read-tree", "--empty");
  await git(sender, "update-index", "--add", "--cacheinfo", "100644", blob, first);
  await git(sender, "update-index", "--add", "--cacheinfo", "100644", blob, second);
  const tree = await git(sender, "write-tree");
  const commitOid = await git(sender, "commit-tree", tree, "-p", parent, "-m", "literal index twins");
  await git(sender, "update-ref", "refs/heads/main", commitOid, parent);
  return capture();
}

test("R2-9: injected NFC receiver equivalence rejects an incoming index with NFC/NFD literal twins", async () => {
  await commit("base\n", "base");
  const base = await capture();
  await materialize(base);
  const incoming = await captureWithLiteralIndexTwins("é.txt", "e\u0301.txt");
  setReceiverEquivalenceProbeForTests(async () => ({ caseAliases: false, unicodeAliases: true }));

  const { outcome, logs } = await applyIncoming(stateWith(base), incoming);

  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
  expect(logs.some((line) => line.includes("incoming index has receiver-equivalent paths"))).toBe(true);
  expect(await git(receiver, "rev-parse", "HEAD")).toBe(base.refs["refs/heads/main"]);
});

test.skipIf(!hostReceiverEquivalence.caseAliases)("R2-9: actual case-aliasing receiver rejects a case-colliding incoming index", async () => {
  await commit("base\n", "base");
  const base = await capture();
  await materialize(base);
  const incoming = await captureWithLiteralIndexTwins("Case.txt", "case.txt");

  const { outcome } = await applyIncoming(stateWith(base), incoming);

  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.deferrals?.repo?.apply?.reason).toBe("unreadable");
});

test("R2-10: NFC/NFD-twin repo keys are all deferred before either target mutates", async () => {
  await commit("base\n", "base");
  const section = await capture();
  const first = "repos/é";
  const second = "repos/e\u0301";
  const logs: string[] = [];
  const remote: Manifest = {
    generatedAt: "",
    files: [],
    manifestSchema: 2,
    gitRepos: { [first]: section, [second]: section },
  };

  const outcome = await applyGitSections(workspace, cfg, stateWith(), remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line));

  expect(outcome.gitPendingRemote?.[first]).toEqual(section);
  expect(outcome.gitPendingRemote?.[second]).toEqual(section);
  expect(outcome.deferrals?.[first]?.apply?.reason).toBe("unreadable");
  expect(outcome.deferrals?.[second]?.apply?.reason).toBe("unreadable");
  expect(logs.filter((line) => line.includes("receiver-equivalent Git repo keys"))).toHaveLength(1);
  await applyGitSections(workspace, cfg, stateWith(), remote, store, buildIgnoreMatcher(workspace), (line) => logs.push(line));
  expect(logs.filter((line) => line.includes("receiver-equivalent Git repo keys"))).toHaveLength(1);
  await expect(fs.lstat(path.join(workspace, first, ".git"))).rejects.toThrow();
  await expect(fs.lstat(path.join(workspace, second, ".git"))).rejects.toThrow();
});

test("R2-11: refname alias group is held while an unrelated checkout follows", async () => {
  await commit("base\n", "base");
  await git(sender, "branch", "Foo");
  const base = await capture();
  await materialize(base);
  const sibling = path.join(tmp, "sibling-Foo");
  await git(receiver, "worktree", "add", sibling, "Foo");
  await git(sender, "branch", "foo");
  await git(sender, "branch", "-D", "Foo");
  await commit("incoming\n", "advance unrelated main");
  const incoming = await capture();
  await fs.writeFile(path.join(receiver, "tracked.txt"), "incoming\n");

  const { outcome, logs } = await applyIncoming(stateWith(base), incoming);

  expect(await git(receiver, "rev-parse", "HEAD")).toBe(incoming.refs["refs/heads/main"]);
  expect(await git(receiver, "rev-parse", "refs/heads/Foo")).toBe(base.refs["refs/heads/Foo"]);
  await expect(git(receiver, "rev-parse", "--verify", "refs/heads/foo")).rejects.toThrow();
  expect(outcome.gitPendingRemote?.repo).toEqual(incoming);
  expect(outcome.partial?.repo?.heldRefs["refs/heads/Foo"]).toBe("ownership");
  expect(outcome.partial?.repo?.heldRefs["refs/heads/foo"]).toBe("ownership");
  expect(logs.some((line) => line.includes("receiver-equivalent Git refnames held"))).toBe(true);
});
