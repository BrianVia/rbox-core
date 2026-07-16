import { test as bunTest, expect, beforeEach, afterEach } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pull, push, pushManifest, sync, type SyncDeps } from "../sync.js";
import { loadState, repoRecordsForState, saveState, type SyncState, type WorkspaceConfig } from "../config.js";
import { BlobShaMismatchError, type CommitResult, type SyncRemote } from "../remote.js";
import { buildIgnoreMatcher, captureGitState, gitIdentity, gitIdentityKey, gitPreflight, gitSectionBlobRefs, gitSectionNewestLink, MAX_PACK_CHAIN, scanManifest, setGitSpawnObserver, type BlobStore, type FileEntry, type GitSection, type Manifest } from "../../engine/index.js";
import {
  MAX_GIT_CONFIG_KEYS,
  MAX_GIT_CONFIG_KEY_BYTES,
  MAX_GIT_CONFIG_SERIALIZED_BYTES,
  MAX_GIT_CONFIG_VALUE_BYTES,
} from "../../engine/git/config-sync.js";
import {
  applyGitSections,
  GIT_FINGERPRINT_VERSION,
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  gitDivergenceCount,
  gitDivergenceFastRepoSource,
  gitFingerprintVersionForBounds,
  gitIncomingKey,
  nextDeferral,
  planGitSections,
  withRevalidatedGitPartialApplies,
  type GitPushPlan,
} from "../sync-git.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";

const exec = promisify(execFile);
const TEST_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox test", GIT_AUTHOR_EMAIL: "rbox-test@local",
  GIT_COMMITTER_NAME: "rbox test", GIT_COMMITTER_EMAIL: "rbox-test@local",
};
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: TEST_GIT_ENV }).then((r) => r.stdout.toString().trim());
const gitAt = (dir: string, date: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: { ...TEST_GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).then((r) => r.stdout.toString().trim());
const test = (name: string, fn: () => unknown | Promise<unknown>, timeout = 20_000) => bunTest(name, fn, timeout);
test.if = (cond: boolean) => (name: string, fn: () => unknown | Promise<unknown>, timeout = 20_000) =>
  cond ? bunTest(name, fn, timeout) : bunTest.skip(name, fn);

test("D2 deferral writer preserves chronic age across newer incoming keys and resets reason age", () => {
  const first = nextDeferral("apply", undefined, "git-busy", "2026-01-01T00:00:00.000Z", "incoming-v1");
  first.bytesChanged = true;
  const newer = nextDeferral("apply", first, "git-busy", "2026-01-02T00:00:00.000Z", "incoming-v2");
  expect(newer).toMatchObject({
    deferredSince: first.deferredSince,
    reasonSince: first.reasonSince,
    lastSeen: "2026-01-02T00:00:00.000Z",
    subjectKey: "incoming-v2",
    bytesChanged: true,
  });
  const changed = nextDeferral("apply", newer, "artifact", "2026-01-03T00:00:00.000Z", "incoming-v3");
  expect(changed.deferredSince).toBe(first.deferredSince);
  expect(changed.reasonSince).toBe("2026-01-03T00:00:00.000Z");
  expect(changed.lastSeen).toBe("2026-01-03T00:00:00.000Z");
});

async function withCompressEnv<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const prev = process.env.RBOX_COMPRESS;
  if (value === undefined) delete process.env.RBOX_COMPRESS;
  else process.env.RBOX_COMPRESS = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.RBOX_COMPRESS;
    else process.env.RBOX_COMPRESS = prev;
  }
}

// E2EE is the only sync mode: the fake server stores CIPHERTEXT by encSha; manifests
// are the post-decryption plaintext view (same layering as sync.test.ts's FakeRemote).
const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

/**
 * Stateful in-memory server (the sync.test.ts FakeRemote, extended for design 43):
 * commit() also enforces blob existence for every gitRepos artifact (as the real §28
 * server does via blobRefs), blobs can be deleted (GC simulation, the pending+422
 * case), and git-artifact PUTs can be failed once (capture-churn simulation).
 */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  commitCalls = 0;
  /** Fail the NEXT git-artifact upload (blobStore().putFile) — simulates a repo
   *  churning/vanishing mid-capture so that repo defers. Self-clears. */
  failNextGitPut = false;
  gitShaMismatchFailures = 0;
  gitPutCalls = 0;
  gitPutUploads: Array<{ sha: string; src: string; size: number; uploadsDir?: string }> = [];

  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  headSeq(): number {
    return this.head;
  }
  deleteBlob(encSha: string): void {
    this.blobs.delete(encSha);
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string, _size?: number, _uploadsDir?: string): Promise<void> {
    this.blobs.set(sha256, await fs.readFile(absPath));
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls += 1;
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    const missing = new Set<string>();
    for (const f of manifest.files) {
      if (f.type === "file" && !this.blobs.has(f.encSha ?? f.sha256)) missing.add(f.encSha ?? f.sha256);
    }
    for (const g of Object.values(manifest.gitRepos ?? {})) {
      for (const ref of gitSectionBlobRefs(g)) if (!this.blobs.has(ref.encSha)) missing.add(ref.encSha);
    }
    if (missing.size > 0) return { unsatisfiedBlobs: [...missing] };
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const self = this;
    return {
      async has(s) {
        return self.blobs.has(s);
      },
      async put(s, bytes) {
        self.blobs.set(s, Buffer.from(bytes));
      },
      async get(s) {
        const b = self.blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      async getToFile(s, dest) {
        const b = self.blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, b);
      },
      async putFile(s, src, size, uploadsDir, onBytes) {
        self.gitPutCalls += 1;
        self.gitPutUploads.push({ sha: s, src, size, uploadsDir });
        if (self.gitShaMismatchFailures > 0) {
          self.gitShaMismatchFailures -= 1;
          throw new BlobShaMismatchError(s);
        }
        if (self.failNextGitPut) {
          self.failNextGitPut = false;
          throw new Error("simulated mid-capture churn (upload failed)");
        }
        self.blobs.set(s, await fs.readFile(src));
        onBytes?.(size ?? 0);
      },
    };
  }
}

let tmp: string;
let rootA: string;
let rootB: string;
let remote: FakeRemote;
let cfgA: WorkspaceConfig;
let cfgB: WorkspaceConfig;
let logsA: string[];
let logsB: string[];
let depsA: SyncDeps;
let depsB: SyncDeps;
const noBackoff = async () => {};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitsync-"));
  rootA = path.join(tmp, "A");
  rootB = path.join(tmp, "B");
  await fs.mkdir(path.join(rootA, ".rbox", "state"), { recursive: true });
  await fs.mkdir(path.join(rootB, ".rbox", "state"), { recursive: true });
  remote = new FakeRemote();
  const mk = (root: string, dev: string): WorkspaceConfig => ({
    remoteWorkspaceId: "ws_g43",
    projectId: "root",
    deviceId: dev,
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
    accountId: "acct_g43",
    accountEpoch: 0,
    keyEpoch: 0,
  });
  cfgA = mk(rootA, "devA");
  cfgB = mk(rootB, "devB");
  logsA = [];
  logsB = [];
  depsA = { remote, backoff: noBackoff, onGitLog: (l) => logsA.push(l) };
  depsB = { remote, backoff: noBackoff, onGitLog: (l) => logsB.push(l) };
});
afterEach(async () => {
  delete process.env.RBOX_GIT_REPO_CAP;
  delete process.env.RBOX_GIT_APPLY_CONCURRENCY;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "t");
}
async function commitFile(dir: string, file: string, content: string, msg: string, date?: string) {
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, "add", file);
  // identity via -c so commits work in repos rbox materialized (no local user config)
  if (date) await gitAt(dir, date, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", msg);
  else await git(dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", msg);
}
async function commitBinaryHistory(dir: string, prefix: string, count = 4) {
  for (let i = 0; i < count; i++) {
    await commitFile(dir, `${prefix}-${i}.bin`, crypto.randomBytes(2048).toString("hex"), `${prefix} ${i}`);
  }
}
async function appendPackedRef(dir: string, ref: string, sha: string) {
  const packed = path.join(dir, ".git", "packed-refs");
  const existing = await fs.readFile(packed, "utf8").catch(() => "# pack-refs with: peeled fully-peeled sorted\n");
  await fs.writeFile(packed, `${existing.endsWith("\n") ? existing : `${existing}\n`}${sha} ${ref}\n`);
}
async function makeInTreeMainWithWorktree(): Promise<{ M: string; W: string }> {
  const M = path.join(rootA, "main");
  await initRepo(M);
  await commitFile(M, "m.txt", "mm", "c1");
  const W = path.join(rootA, "wt");
  await git(M, "worktree", "add", W, "-b", "feat");
  await commitFile(W, "w.txt", "ww", "wt c1");
  return { M, W };
}
const st = (root: string) => loadState(root, "http://x::ws_g43::root");
const syncCycle = async () => {
  await sync(rootA, cfgA, depsA);
  await sync(rootB, cfgB, depsB);
};
async function observeGitSpawns<T>(fn: () => Promise<T>): Promise<{ value: T; spawns: number }> {
  let spawns = 0;
  setGitSpawnObserver(() => {
    spawns++;
  });
  try {
    const value = await fn();
    return { value, spawns };
  } finally {
    setGitSpawnObserver(undefined);
  }
}

async function observeGitSpawnsForRoot<T>(targetRoot: string, fn: () => Promise<T>): Promise<{ value: T; spawns: number; targetSpawns: number }> {
  let spawns = 0;
  let targetSpawns = 0;
  setGitSpawnObserver((spawnRoot) => {
    spawns++;
    if (spawnRoot === targetRoot) targetSpawns++;
  });
  try {
    const value = await fn();
    return { value, spawns, targetSpawns };
  } finally {
    setGitSpawnObserver(undefined);
  }
}

const divergenceCachePath = (root: string) => path.join(root, ".rbox", "state", "git-divergence.json");

async function readDivergenceCache(root: string): Promise<{ version?: number; repos?: Record<string, any> }> {
  return JSON.parse(await fs.readFile(divergenceCachePath(root), "utf8")) as { version?: number; repos?: Record<string, any> };
}

async function writeDivergenceCache(root: string, cache: { version?: number; repos?: Record<string, any> }): Promise<void> {
  await fs.mkdir(path.dirname(divergenceCachePath(root)), { recursive: true });
  await fs.writeFile(divergenceCachePath(root), JSON.stringify(cache));
}

async function markDivergenceCacheTrusted(root: string): Promise<void> {
  const cache = await readDivergenceCache(root);
  const trustedWrittenAt = Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 5_000;
  for (const entry of Object.values(cache.repos ?? {})) {
    if (entry && typeof entry === "object") entry.writtenAtMs = trustedWrittenAt;
  }
  await writeDivergenceCache(root, cache);
}

function gitPlanSurface(plan: GitPushPlan): Omit<GitPushPlan, "gitPlanStats"> {
  const { gitPlanStats: _gitPlanStats, ...surface } = plan;
  return surface;
}

function deferred<T = void>(): { promise: Promise<T>; resolve: (value?: T | PromiseLike<T>) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const resolvesWithin = async (promise: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([promise.then(() => true), delay(ms).then(() => false)]);

test("design 130: BASE-equal checked-out branch follow leaves a clean checkout", async () => {
  const a = path.join(rootA, "field-incident");
  await initRepo(a);
  await commitFile(a, "tracked.txt", "one\n", "c1");
  await commitFile(a, "tracked.txt", "two\n", "c2");
  await syncCycle();

  const b = path.join(rootB, "field-incident");
  const baseTip = await git(b, "rev-parse", "refs/heads/main");
  await commitFile(a, "tracked.txt", "three\n", "c3");
  const incomingTip = await git(a, "rev-parse", "HEAD");
  await sync(rootA, cfgA, depsA);

  // The branch still equals the positive logical BASE. The pull's file phase
  // installs incoming tracked bytes before the prepared checkout transaction.
  expect(await git(b, "rev-parse", "refs/heads/main")).toBe(baseTip);
  logsB.length = 0;
  await pull(rootB, cfgB, depsB);

  expect(logsB).toContain("git-sync followed field-incident");
  expect(await git(b, "symbolic-ref", "HEAD")).toBe("refs/heads/main");
  expect(await git(b, "rev-parse", "HEAD")).toBe(incomingTip);
  await expect(git(b, "diff", "--cached", "--quiet")).resolves.toBe("");
  await expect(git(b, "diff", "--quiet")).resolves.toBe("");
  expect(await fs.readFile(path.join(b, "tracked.txt"), "utf8")).toBe("three\n");
  const record = repoRecordsForState(await st(rootB))["field-incident"]!;
  expect(record.pending).toBeUndefined();
  expect(record.partial).toBeUndefined();
  expect(record.deferrals?.apply).toBeUndefined();
}, 20_000);

function observingBlobStore(inner: BlobStore, onGetToFile: (sha: string) => Promise<void> | void): BlobStore {
  const wrapped: BlobStore = {
    has: (sha) => inner.has(sha),
    put: (sha, bytes) => inner.put(sha, bytes),
    get: (sha) => inner.get(sha),
    async getToFile(sha, dest, expectedSize) {
      await onGetToFile(sha);
      if (inner.getToFile) return inner.getToFile(sha, dest, expectedSize);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, await inner.get(sha));
    },
  };
  if (inner.putFile) wrapped.putFile = (sha, src, size, uploadsDir, onBytes) => inner.putFile!(sha, src, size, uploadsDir, onBytes);
  return wrapped;
}

const gitManifest = (gitRepos: Record<string, GitSection>): Manifest => ({ generatedAt: "", files: [], manifestSchema: 2, gitRepos });
const gitState = (gitRepos?: Record<string, GitSection>): SyncState => ({
  stream: "test",
  stateNonce: "a".repeat(32),
  lastSyncedSequence: 0,
  lastSyncedManifest: gitRepos ? gitManifest(gitRepos) : { generatedAt: "", files: [] },
});

test("D2 pre-save partial revalidation invalidates a human-moved non-current ref", async () => {
  const repo = path.join(rootA, "r");
  await initRepo(repo);
  await commitFile(repo, "base.txt", "base", "base");
  await git(repo, "branch", "side");
  const recorded = await git(repo, "rev-parse", "side");
  await commitFile(repo, "main.txt", "next", "next");
  const human = await git(repo, "rev-parse", "main");
  await git(repo, "update-ref", "refs/heads/side", human);
  const state: SyncState = {
    ...gitState(),
    repoRecords: {
      r: {
        repoGen: 1,
        sourceSeq: 1,
        partial: {
          incomingKey: "incoming",
          checkoutPending: false,
          appliedRefs: { "refs/heads/side": { kind: "direct", oid: recorded } },
          heldRefs: { "refs/heads/held": "ownership" },
          configApplied: true,
        },
      },
    },
  };
  const outcome = {};
  let saveRan = false;
  await withRevalidatedGitPartialApplies(rootA, state, outcome, async () => {
    saveRan = true;
    await expect(git(repo, "update-ref", "refs/heads/side", recorded)).rejects.toThrow();
  });
  expect(saveRan).toBe(true);
  expect(outcome).toEqual({ partial: { r: null } });
  expect(await git(repo, "rev-parse", "side")).toBe(human);
});

test("D2 capture deferral survives a post-plan push failure and clears on a later clean plan", async () => {
  const repo = path.join(rootA, "capture-restart");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "v1", "v1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await commitFile(repo, "f.txt", "v2", "v2");
  await fs.writeFile(path.join(rootA, "force-commit.txt"), "x");
  remote.failNextGitPut = true;
  const realCommit = remote.commit.bind(remote);
  let durableObserved = false;
  depsA.onGitDeferralsSaved = (saved) => {
    durableObserved = repoRecordsForState(saved)["capture-restart"]?.deferrals?.capture?.reason === "artifact";
  };
  remote.commit = async () => {
    expect(durableObserved).toBe(true); // visibility hook ran immediately after the lane save
    throw new Error("post-plan network failure");
  };
  await expect(push(rootA, cfgA, depsA)).rejects.toThrow(/post-plan network failure/);
  let record = repoRecordsForState(await st(rootA))["capture-restart"]!;
  expect(record.deferrals?.capture?.reason).toBe("artifact");
  const since = record.deferrals?.capture?.deferredSince;

  remote.commit = realCommit;
  delete depsA.onGitDeferralsSaved;
  const repoB = path.join(rootB, "capture-restart");
  await commitFile(repoB, "remote.txt", "newer", "newer remote truth");
  await push(rootB, cfgB, depsB);
  const busyLock = path.join(repo, ".git", "index.lock");
  await fs.writeFile(busyLock, "");
  await pull(rootA, cfgA, depsA);
  record = repoRecordsForState(await st(rootA))["capture-restart"]!;
  expect(record.deferrals?.capture?.deferredSince).toBe(since);
  expect(record.deferrals?.apply?.reason).toBe("git-busy");

  await fs.rm(busyLock);
  await push(rootA, cfgA, depsA);
  record = repoRecordsForState(await st(rootA))["capture-restart"]!;
  expect(record.deferrals?.capture).toBeUndefined();
  expect(record.deferrals?.apply?.reason).toBe("git-busy");
  expect(since).toBeDefined();
});

async function captureSections(rels: readonly string[]): Promise<Record<string, GitSection>> {
  const store = remote.blobStore();
  const out: Record<string, GitSection> = {};
  for (const rel of rels) out[rel] = (await captureGitState(path.join(rootA, rel), store, KEK))!;
  return out;
}

const artifactSet = (section: GitSection): Set<string> => new Set(gitSectionBlobRefs(section).map((r) => r.encSha));

async function initRepoOnBranch(dir: string, branch: string, fileContent: string): Promise<void> {
  await initRepo(dir);
  await git(dir, "checkout", "-qb", branch);
  await commitFile(dir, "f.txt", fileContent, "c1");
}

// ── pooled pull-side git apply scheduling ─────────────────────────────────────

test("git apply pools independent repos under RBOX_GIT_APPLY_CONCURRENCY>=2", async () => {
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "2";
  for (const rel of ["alpha", "beta"]) {
    await initRepo(path.join(rootA, rel));
    await commitFile(path.join(rootA, rel), "f.txt", rel, "c1");
  }
  const sections = await captureSections(["alpha", "beta"]);
  const alphaArtifacts = artifactSet(sections.alpha!);
  const betaArtifacts = artifactSet(sections.beta!);
  const alphaBlocked = deferred();
  const releaseAlpha = deferred();
  const betaStarted = deferred();
  let blockedAlpha = false;

  const store = observingBlobStore(remote.blobStore(), async (sha) => {
    if (!blockedAlpha && alphaArtifacts.has(sha)) {
      blockedAlpha = true;
      alphaBlocked.resolve();
      await releaseAlpha.promise;
    } else if (betaArtifacts.has(sha)) {
      await alphaBlocked.promise;
      betaStarted.resolve();
    }
  });

  const outcome = applyGitSections(rootB, cfgB, gitState(), gitManifest(sections), store, buildIgnoreMatcher(rootB), (l) => logsB.push(l));
  await alphaBlocked.promise;
  const betaStartedBeforeAlphaFinished = await resolvesWithin(betaStarted.promise, 1_000);
  releaseAlpha.resolve();
  await outcome;

  expect(betaStartedBeforeAlphaFinished).toBe(true);
  expect(logsB.filter((l) => l.startsWith("git-sync applied ")).sort()).toEqual(["git-sync applied alpha", "git-sync applied beta"]);
}, 30_000);

test("git apply serializes pointer repos that share one common git dir", async () => {
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "2";
  const main = path.join(tmp, "shared-main");
  await initRepo(main);
  await commitFile(main, "base.txt", "base", "base");
  const wtA = path.join(rootB, "wt-a");
  const wtB = path.join(rootB, "wt-b");
  await git(main, "worktree", "add", wtA, "-b", "wt-a");
  await commitFile(wtA, "local-a.txt", "local-a", "local a");
  await git(main, "worktree", "add", wtB, "-b", "wt-b");
  await commitFile(wtB, "local-b.txt", "local-b", "local b");

  const storeForCapture = remote.blobStore();
  const baseA = (await captureGitState(wtA, storeForCapture, KEK))!;
  const baseB = (await captureGitState(wtB, storeForCapture, KEK))!;
  await initRepoOnBranch(path.join(rootA, "wt-a"), "wt-a", "remote-a");
  await initRepoOnBranch(path.join(rootA, "wt-b"), "wt-b", "remote-b");
  const remoteSecs = await captureSections(["wt-a", "wt-b"]);
  const labels = new Map<string, string>();
  for (const [rel, sec] of Object.entries(remoteSecs)) for (const sha of artifactSet(sec)) labels.set(sha, rel);
  const firstBlocked = deferred<string>();
  const releaseFirst = deferred();
  const secondStarted = deferred();
  let firstRel: string | undefined;

  const store = observingBlobStore(remote.blobStore(), async (sha) => {
    const rel = labels.get(sha);
    if (!rel) return;
    if (!firstRel) {
      firstRel = rel;
      firstBlocked.resolve(rel);
      await releaseFirst.promise;
    } else if (rel !== firstRel) {
      secondStarted.resolve();
    }
  });

  const outcome = applyGitSections(
    rootB,
    cfgB,
    gitState({ "wt-a": baseA, "wt-b": baseB }),
    gitManifest(remoteSecs),
    store,
    buildIgnoreMatcher(rootB),
    (l) => logsB.push(l)
  );
  await firstBlocked.promise;
  const overlapped = await resolvesWithin(secondStarted.promise, 1_000);
  releaseFirst.resolve();
  await outcome;

  expect(overlapped).toBe(false);
  expect(logsB.filter((l) => l.startsWith("git-sync applied ")).sort()).toEqual(["git-sync applied wt-a", "git-sync applied wt-b"]);
}, 30_000);

test("git apply keeps nested repo chains parent-before-child under pooling", async () => {
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "2";
  await initRepo(path.join(rootA, "parent"));
  await commitFile(path.join(rootA, "parent"), "parent.txt", "parent", "parent c1");
  await initRepo(path.join(rootA, "parent", "child"));
  await commitFile(path.join(rootA, "parent", "child"), "child.txt", "child", "child c1");
  const sections = await captureSections(["parent", "parent/child"]);
  const parentArtifacts = artifactSet(sections.parent!);
  const childArtifacts = artifactSet(sections["parent/child"]!);
  const parentBlocked = deferred();
  const releaseParent = deferred();
  const childStarted = deferred();
  let blockedParent = false;

  const store = observingBlobStore(remote.blobStore(), async (sha) => {
    if (!blockedParent && parentArtifacts.has(sha)) {
      blockedParent = true;
      parentBlocked.resolve();
      await releaseParent.promise;
    } else if (childArtifacts.has(sha)) {
      await parentBlocked.promise;
      childStarted.resolve();
    }
  });

  const outcome = applyGitSections(rootB, cfgB, gitState(), gitManifest(sections), store, buildIgnoreMatcher(rootB), (l) => logsB.push(l));
  await parentBlocked.promise;
  const childStartedBeforeParentFinished = await resolvesWithin(childStarted.promise, 1_000);
  releaseParent.resolve();
  await outcome;

  expect(childStartedBeforeParentFinished).toBe(false);
  expect(logsB.filter((l) => l.startsWith("git-sync applied "))).toEqual(["git-sync applied parent", "git-sync applied parent/child"]);
}, 30_000);

test("RBOX_GIT_APPLY_CONCURRENCY=1 preserves serial apply order", async () => {
  process.env.RBOX_GIT_APPLY_CONCURRENCY = "1";
  for (const rel of ["one", "two"]) {
    await initRepo(path.join(rootA, rel));
    await commitFile(path.join(rootA, rel), "f.txt", rel, "c1");
  }
  const sections = await captureSections(["one", "two"]);
  const oneArtifacts = artifactSet(sections.one!);
  const seen = new Set<string>();
  const events: string[] = [];
  const oneBlocked = deferred();
  const releaseOne = deferred();
  const twoStarted = deferred();
  let blockedOne = false;

  const labelFor = (sha: string): string | undefined => {
    for (const [rel, sec] of Object.entries(sections)) if (artifactSet(sec).has(sha)) return rel;
    return undefined;
  };
  const store = observingBlobStore(remote.blobStore(), async (sha) => {
    const rel = labelFor(sha);
    if (rel && !seen.has(rel)) {
      seen.add(rel);
      events.push(`start:${rel}`);
    }
    if (!blockedOne && oneArtifacts.has(sha)) {
      blockedOne = true;
      oneBlocked.resolve();
      await releaseOne.promise;
    } else if (rel === "two") {
      await oneBlocked.promise;
      twoStarted.resolve();
    }
  });

  const outcome = applyGitSections(rootB, cfgB, gitState(), gitManifest(sections), store, buildIgnoreMatcher(rootB), (l) => {
    logsB.push(l);
    const m = /^git-sync applied (.+)$/.exec(l);
    if (m) events.push(`done:${m[1]}`);
  });
  await oneBlocked.promise;
  const twoStartedBeforeOneFinished = await resolvesWithin(twoStarted.promise, 1_000);
  releaseOne.resolve();
  await outcome;

  expect(twoStartedBeforeOneFinished).toBe(false);
  expect(events).toEqual(["start:one", "done:one", "start:two", "done:two"]);
}, 30_000);

// ── (a) two-machine e2e: fidelity across nested repos + a real worktree ──────────

test("e2e: nested dir repos (staged+stash+paused rebase) + out-of-tree worktree round-trip B-side fsck-clean and continuable", async () => {
  // proj1: dir repo with a stash, then a PAUSED (conflicted) rebase with a staged resolution
  const p1 = path.join(rootA, "proj1");
  await initRepo(p1);
  await commitFile(p1, "a.txt", "v1", "c1");
  await fs.writeFile(path.join(p1, "a.txt"), "stashed-work");
  await git(p1, "stash", "-q");
  await git(p1, "checkout", "-qb", "side");
  await commitFile(p1, "a.txt", "side-change", "side c1");
  await git(p1, "checkout", "-q", "main");
  await commitFile(p1, "a.txt", "main-change", "main c2");
  await git(p1, "checkout", "-q", "side");
  await expect(git(p1, "rebase", "main")).rejects.toThrow(); // paused mid-rebase (conflict)
  await fs.writeFile(path.join(p1, "a.txt"), "resolved");
  await git(p1, "add", "a.txt"); // staged conflict resolution

  // proj2: plain nested dir repo
  const p2 = path.join(rootA, "sub", "proj2");
  await initRepo(p2);
  await commitFile(p2, "b.txt", "bb", "c1");

  // wt: a REAL `git worktree` of a main clone OUTSIDE the sync root
  const M = path.join(tmp, "mainclone");
  await initRepo(M);
  await commitFile(M, "m.txt", "mm", "c1");
  const W = path.join(rootA, "wt");
  await git(M, "worktree", "add", W, "-b", "feat");
  await commitFile(W, "w.txt", "ww", "wt c1");

  await push(rootA, cfgA, depsA);
  expect(logsA.some((l) => l.startsWith("git-sync: captured 3"))).toBe(true); // §10 forensic line
  const manifest = (await remote.latest()).manifest;
  expect(manifest.manifestSchema).toBe(2);
  expect(Object.keys(manifest.gitRepos ?? {}).sort()).toEqual(["proj1", "sub/proj2", "wt"]);
  expect(manifest.gitRepos!["wt"]!.refScope).toBe("scoped"); // pointer capture → scoped section
  expect(manifest.gitRepos!["proj1"]!.refScope).toBe("all");

  await pull(rootB, cfgB, depsB);
  for (const rel of ["proj1", "sub/proj2", "wt"]) {
    const d = path.join(rootB, rel);
    expect((await fs.lstat(path.join(d, ".git"))).isDirectory()).toBe(true); // standalone materialization
    await expect(git(d, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
  }
  const b1 = path.join(rootB, "proj1");
  // history + refs + stash + status all match
  expect(await git(b1, "rev-parse", "main")).toBe(await git(p1, "rev-parse", "main"));
  expect(await git(b1, "rev-parse", "side")).toBe(await git(p1, "rev-parse", "side"));
  expect(await git(b1, "rev-parse", "refs/stash")).toBe(await git(p1, "rev-parse", "refs/stash"));
  expect(await git(b1, "stash", "list")).toBe(await git(p1, "stash", "list"));
  expect(await git(b1, "status", "--porcelain")).toBe(await git(p1, "status", "--porcelain"));
  // the paused rebase is present AND continuable on B
  expect((await fs.lstat(path.join(b1, ".git", "rebase-merge"))).isDirectory()).toBe(true);
  await git(b1, "config", "user.email", "t@t.t");
  await git(b1, "config", "user.name", "t");
  await expect(git(b1, "-c", "core.editor=true", "rebase", "--continue")).resolves.toBeDefined();
  expect(await git(b1, "symbolic-ref", "HEAD")).toBe("refs/heads/side"); // rebase completed onto side
  // the worktree materialized standalone on feat
  const bw = path.join(rootB, "wt");
  expect(await git(bw, "symbolic-ref", "HEAD")).toBe("refs/heads/feat");
  expect(await git(bw, "rev-parse", "feat")).toBe(await git(W, "rev-parse", "feat"));
  expect((await git(bw, "branch", "--format=%(refname:short)")).split("\n")).toEqual(["feat"]); // main never leaked
}, 30_000);

test("e2e: worktree scope-crossing converges (§7 trace) — B's edit applies into A's pointer repo, then ZERO capture ping-pong", async () => {
  const M = path.join(tmp, "mainclone");
  await initRepo(M);
  await commitFile(M, "m.txt", "mm", "c1");
  const W = path.join(rootA, "wt");
  await git(M, "worktree", "add", W, "-b", "feat");
  await commitFile(W, "w.txt", "ww", "wt c1");

  await push(rootA, cfgA, depsA); // scoped S1
  await pull(rootB, cfgB, depsB); // B materializes standalone (base = S1)

  // B does real work in the materialized repo and pushes — a dir repo with a SCOPED
  // base must capture fresh (all-scope A1), per the §7 matrix.
  const bw = path.join(rootB, "wt");
  await git(bw, "config", "user.email", "t@t.t");
  await git(bw, "config", "user.name", "t");
  await commitFile(bw, "w2.txt", "from-B", "b c1");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["wt"]!.refScope).toBe("all");

  // A pulls: the all-scope section follows into the existing POINTER repo
  // through the steady oracle/journal pipeline (still update-only and guarded).
  await pull(rootA, cfgA, depsA);
  expect(await git(W, "rev-parse", "feat")).toBe(await git(bw, "rev-parse", "feat"));
  expect(logsA.some((l) => l.startsWith("git-sync followed wt"))).toBe(true);

  // Convergence: one settling round, then TWO quiescent cycles make ZERO new commits.
  await syncCycle();
  const head = remote.headSeq();
  const calls = remote.commitCalls;
  await syncCycle();
  await syncCycle();
  expect(remote.headSeq()).toBe(head); // no capture ping-pong across scope crossings
  expect(remote.commitCalls).toBe(calls); // not even attempted commits
}, 30_000);

test("root repo '.' still syncs end-to-end (pre-§43 behavior preserved)", async () => {
  await initRepo(rootA);
  await commitFile(rootA, "f.txt", "root-repo", "c1");
  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {})).toEqual(["."]);
  await pull(rootB, cfgB, depsB);
  expect(await git(rootB, "rev-parse", "main")).toBe(await git(rootA, "rev-parse", "main"));
  // quiescent: no echo
  const head = remote.headSeq();
  await syncCycle();
  expect(remote.headSeq()).toBe(head);
});

test("design 53: schema-3 incremental chain round-trips and is smaller than the base full bundle", () => withCompressEnv("0", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  const r = path.join(rootA, "r");
  await initRepo(r);
  for (let i = 0; i < 12; i++) {
    await commitFile(r, `history-${i}.txt`, `${i}\n${"x".repeat(4096)}\n`, `history ${i}`);
  }
  await push(rootA, cfgA, depsA);
  const base = (await remote.latest()).manifest.gitRepos!["r"]!;
  expect((await remote.latest()).manifest.manifestSchema).toBe(2);

  await commitFile(r, "delta.txt", "small delta\n", "delta");
  await push(rootA, cfgA, depsA);
  const chained = (await remote.latest()).manifest;
  const sec = chained.gitRepos!["r"]!;
  expect(chained.manifestSchema).toBe(3);
  expect(sec.packChain).toHaveLength(1);
  expect(sec.packChain![0]!.encSha).toBe(base.bundleEncSha);
  expect(sec.bundleCipherSize).toBeLessThan(base.bundleCipherSize);

  await pull(rootB, cfgB, depsB);
  await expect(git(path.join(rootB, "r"), "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
  expect(await git(path.join(rootB, "r"), "rev-parse", "main")).toBe(await git(r, "rev-parse", "main"));
}), 30_000);

test("design 53: default-on staged-only increment materializes on the receiver", () => withCompressEnv("0", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitBinaryHistory(r, "base", 8);
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  await fs.writeFile(path.join(r, "staged.txt"), "staged\n");
  await git(r, "add", "staged.txt");
  await push(rootA, cfgA, depsA);

  const chained = (await remote.latest()).manifest;
  expect(chained.manifestSchema).toBe(3);
  expect(chained.gitRepos!["r"]!.packChain).toHaveLength(1);

  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  expect(await git(b, "status", "--porcelain", "--untracked-files=no")).toBe(await git(r, "status", "--porcelain", "--untracked-files=no"));
  expect(await git(b, "status", "--porcelain", "--", "staged.txt")).toBe("A  staged.txt");
  await expect(git(b, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
}), 30_000);

test("design 53: explicit git.incremental false keeps full-bundle schema-2 recaptures", () => withCompressEnv("0", async () => {
  cfgA = { ...cfgA, git: { incremental: false } };
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitBinaryHistory(r, "base");
  await push(rootA, cfgA, depsA);
  const base = (await remote.latest()).manifest.gitRepos!["r"]!;

  await commitFile(r, "delta.txt", "v2\n", "c2");
  await push(rootA, cfgA, depsA);

  const full = (await remote.latest()).manifest;
  expect(full.manifestSchema).toBe(2);
  expect(full.gitRepos!["r"]!.packChain).toBeUndefined();
  expect(full.gitRepos!["r"]!.bundleEncSha).not.toBe(base.bundleEncSha);
}), 30_000);

test("design 53: missing chain blob in 422 page forces a full-bundle recapture", () => withCompressEnv("0", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitBinaryHistory(r, "base");
  await push(rootA, cfgA, depsA);
  await commitFile(r, "delta.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  const chained = (await remote.latest()).manifest.gitRepos!["r"]!;
  expect(chained.packChain).toHaveLength(1);

  remote.deleteBlob(chained.packChain![0]!.encSha);
  await fs.writeFile(path.join(rootA, "note.txt"), "forces commit\n");
  await push(rootA, cfgA, depsA);
  const healed = (await remote.latest()).manifest;
  expect(healed.files.some((f) => f.path === "note.txt")).toBe(true);
  expect(healed.manifestSchema).toBe(2);
  expect(healed.gitRepos!["r"]!.packChain).toBeUndefined();
  await expect(remote.blobStore().get(healed.gitRepos!["r"]!.bundleEncSha)).resolves.toBeDefined();
}), 30_000);

test("design 53: length and byte compaction triggers publish full bundles", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  const rLen = path.join(rootA, "rLen");
  await initRepo(rLen);
  await commitFile(rLen, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  let sA = await st(rootA);
  const lenBase = sA.lastSyncedManifest.gitRepos!["rLen"]!;
  const maxLinks = Array.from({ length: MAX_PACK_CHAIN - 1 }, () => gitSectionNewestLink(lenBase));
  await saveState(rootA, {
    ...sA,
    lastSyncedManifest: { ...sA.lastSyncedManifest, manifestSchema: 3, gitRepos: { rLen: { ...lenBase, packChain: maxLinks } } },
  });
  await commitFile(rLen, "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["rLen"]!.packChain).toBeUndefined();

  const rByte = path.join(rootA, "rByte");
  await initRepo(rByte);
  await commitFile(rByte, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  sA = await st(rootA);
  const byteBase = sA.lastSyncedManifest.gitRepos!["rByte"]!;
  await saveState(rootA, {
    ...sA,
    lastSyncedManifest: { ...sA.lastSyncedManifest, gitRepos: { ...sA.lastSyncedManifest.gitRepos, rByte: { ...byteBase, bundleCipherSize: 1 } } },
  });
  await commitFile(rByte, "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["rByte"]!.packChain).toBeUndefined();
}, 30_000);

test("design 53: missing receiver link defers, then heals when sender recompacts full", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitBinaryHistory(r, "base");
  await push(rootA, cfgA, depsA);
  await commitFile(r, "delta.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  const chained = (await remote.latest()).manifest.gitRepos!["r"]!;
  const blocked = chained.packChain![0]!.encSha;
  const failingRemote: SyncRemote = {
    latest: () => remote.latest(),
    missingBlobs: (shas) => remote.missingBlobs(shas),
    putBlobFile: (sha256, absPath, size, uploadsDir) => remote.putBlobFile(sha256, absPath, size, uploadsDir),
    commit: (parentSequence, deviceId, manifest) => remote.commit(parentSequence, deviceId, manifest),
    blobStore() {
      const bs = remote.blobStore();
      return {
        ...bs,
        async get(s) {
          if (s === blocked) throw new Error("simulated receiver-only missing chain link");
          return bs.get(s);
        },
        async getToFile(s, dest) {
          if (s === blocked) throw new Error("simulated receiver-only missing chain link");
          if (bs.getToFile) return bs.getToFile(s, dest);
          await fs.writeFile(dest, await bs.get(s));
        },
      };
    },
  };
  await pull(rootB, cfgB, { ...depsB, remote: failingRemote });
  expect((await st(rootB)).gitPendingRemote?.["r"]).toBeDefined();

  const sA = await st(rootA);
  const maxLinks = Array.from({ length: MAX_PACK_CHAIN - 1 }, () => gitSectionNewestLink(chained));
  await saveState(rootA, {
    ...sA,
    lastSyncedManifest: { ...sA.lastSyncedManifest, manifestSchema: 3, gitRepos: { r: { ...chained, packChain: maxLinks } } },
  });
  await commitFile(r, "f.txt", "v3", "c3");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.packChain).toBeUndefined();

  await pull(rootB, cfgB, depsB);
  expect((await st(rootB)).gitPendingRemote?.["r"]).toBeUndefined();
  expect(await git(path.join(rootB, "r"), "rev-parse", "main")).toBe(await git(r, "rev-parse", "main"));
}, 30_000);

test("design 53: fresh join fetch/import work is bounded by repos times MAX_PACK_CHAIN", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  for (const rel of ["ra", "rb", "rc"]) {
    const r = path.join(rootA, rel);
    await initRepo(r);
    await commitBinaryHistory(r, "base");
  }
  await push(rootA, cfgA, depsA);
  for (const rel of ["ra", "rb", "rc"]) await commitFile(path.join(rootA, rel), "delta.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);

  let fetches = 0;
  setGitSpawnObserver((_root, args) => {
    if (args[0] === "fetch") fetches++;
  });
  try {
    await pull(rootB, cfgB, depsB);
  } finally {
    setGitSpawnObserver(undefined);
  }
  expect(fetches).toBeLessThanOrEqual(3 * MAX_PACK_CHAIN);
  expect(fetches).toBe(6);
}, 30_000);

test("design 116: chained-section human edits defer with newest incoming carried", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitBinaryHistory(r, "base");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  await commitFile(r, "delta.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.packChain).toHaveLength(1);

  const b = path.join(rootB, "r");
  await commitFile(b, "local.txt", "local\n", "local");
  await pull(rootB, cfgB, depsB);
  const deferred = repoRecordsForState(await st(rootB)).r!;
  expect(deferred.deferrals?.apply?.reason).toBe("local-edits");
  expect(deferred.pending?.packChain).toHaveLength(1);
  expect(deferred.resolutionKey).toBeUndefined();
}, 30_000);

// ── design 68 §3.3: in-tree linked-worktree pointer skip (base-carry) ──────────────

test("design 68 V6: an in-tree linked-worktree pointer is SKIPPED — its history rides the main clone's bundle; no removal memory, no echo", async () => {
  const { M } = await makeInTreeMainWithWorktree();

  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {})).toEqual(["main"]); // wt NOT captured — travels with the main clone
  expect(m.gitRepos!["main"]!.refScope).toBe("all");
  const skipLine = logsA.find((l) => l.includes("skipped 1") && l.includes("wt"));
  expect(skipLine).toBeDefined();
  expect(skipLine!).toContain("linked worktree of in-tree repo main");
  expect(skipLine!).not.toContain("captured in-tree repo");
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined(); // base-carry never stamps removal memory

  // the worktree's committed branch rides the main clone's --single-worktree --all bundle (V4)
  await pull(rootB, cfgB, depsB);
  expect(await git(path.join(rootB, "main"), "rev-parse", "feat")).toBe(await git(M, "rev-parse", "feat"));
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();

  // steady state: skip is a carry → zero echo commits
  const head = remote.headSeq();
  await syncCycle();
  await syncCycle();
  expect(remote.headSeq()).toBe(head);
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined();
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();
}, 20_000);

test("design 68 V11: a skip-eligible pointer with an EXISTING captured base is CARRIED unchanged, not dropped — no removal memory (mixed-version safe)", async () => {
  const { W } = await makeInTreeMainWithWorktree();

  // Seed a pre-existing captured base for wt, as an OLDER client (which captured pointer
  // worktrees and refused main clones, §6a) would have authored. Its artifacts live
  // server-side, so the carry's blobRef check passes.
  const wtSection = await captureGitState(W, remote.blobStore(), KEK);
  expect(wtSection!.refScope).toBe("scoped");
  const s0 = await st(rootA);
  await saveState(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection! } } });

  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["main", "wt"]); // wt CARRIED alongside the captured main clone
  expect(m.gitRepos!["wt"]!.bundleEncSha).toBe(wtSection!.bundleEncSha); // carried UNCHANGED — never re-captured
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined(); // M4: base-carry, never a removal-memory stamp
  expect(logsA.some((l) => l.includes("skipped") && l.includes("wt"))).toBe(true);

  // steady state: the carry echoes nothing (the section bytes are stable across cycles)
  const head = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(head);
  await pull(rootB, cfgB, depsB);
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined();
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();
}, 20_000);

test("design 68 §3.3 + 422: a forced skip-eligible pointer recaptures instead of carrying a missing base blob", async () => {
  const { W } = await makeInTreeMainWithWorktree();

  const wtSection = await captureGitState(W, remote.blobStore(), KEK);
  expect(wtSection!.refScope).toBe("scoped");
  const s0 = await st(rootA);
  await saveState(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection! } } });

  remote.deleteBlob(wtSection!.bundleEncSha); // first attempt 422s on the carried pointer base
  await fs.writeFile(path.join(rootA, "note.txt"), "forces a commit\n");
  const events: Array<{ phase: string; detail?: string }> = [];
  await push(rootA, cfgA, { ...depsA, onProgress: (_done, _total, phase, detail) => events.push({ phase, detail }) });

  const m = (await remote.latest()).manifest;
  expect(m.files.some((f) => f.path === "note.txt")).toBe(true);
  expect(m.gitRepos?.["wt"]).toBeDefined();
  expect(events.some((e) => e.phase === "gitcap" && e.detail === "wt")).toBe(true); // forced rel was captured, not skip-carried
  await expect(remote.blobStore().get(m.gitRepos!["wt"]!.bundleEncSha)).resolves.toBeDefined();
}, 20_000);

// ── (b) churn: per-repo capture failure defers with base carry, push proceeds ────

test("a repo whose capture fails mid-push is DEFERRED with base carry; the push commits everything else", async () => {
  const r1 = path.join(rootA, "r1");
  const r2 = path.join(rootA, "r2");
  await initRepo(r1);
  await commitFile(r1, "a.txt", "a1", "c1");
  await initRepo(r2);
  await commitFile(r2, "b.txt", "b1", "c1");
  await push(rootA, cfgA, depsA);
  const base2 = (await st(rootA)).lastSyncedManifest.gitRepos!["r2"]!;

  // ONLY r2 changes (so the failing PUT deterministically hits r2's capture) plus an
  // unrelated file change so the push has something stable to commit.
  await commitFile(r2, "b.txt", "b2", "c2");
  await fs.writeFile(path.join(rootA, "note.txt"), "stable");
  remote.failNextGitPut = true;

  const seqBefore = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(seqBefore + 1); // push proceeded (r2's failure did not abort)
  const m = (await remote.latest()).manifest;
  expect(m.files.some((f) => f.path === "note.txt")).toBe(true); // stable subset committed
  expect(m.gitRepos!["r2"]!.bundleEncSha).toBe(base2.bundleEncSha); // base carried, not regressed
  expect(m.gitRepos!["r1"]!.bundleEncSha).toBe((await st(rootA)).lastSyncedManifest.gitRepos!["r1"]!.bundleEncSha); // r1 untouched carry
  expect(logsA.some((l) => l.includes("deferred 1") && l.includes("r2"))).toBe(true);

  // next push (nothing failing): r2 self-heals with a fresh capture
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r2"]!.bundleEncSha).not.toBe(base2.bundleEncSha);
}, 20_000);


/** True when the tmp filesystem is case-INSENSITIVE (macOS/APFS default). The
 *  case-drift repro (HEAD casing != packed-refs casing while HEAD still
 *  resolves) can only exist there; on case-sensitive FS the same setup reads
 *  as an unborn branch and capture exits early. The pure normalization is
 *  tested unconditionally below; the end-to-end repros run where they can. */
const fsCaseInsensitive = await (async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-case-probe-"));
  try {
    await fs.writeFile(path.join(d, "CaseProbe"), "");
    return await fs.access(path.join(d, "caseprobe")).then(() => true, () => false);
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
})();
test.if(fsCaseInsensitive)("capture self-validation failures defer with the validator reason", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "x", "c1");
  await git(r, "branch", "casemix");
  const sha = await git(r, "rev-parse", "casemix");
  await appendPackedRef(r, "refs/heads/CASEMIX", sha);
  await fs.writeFile(path.join(r, ".git", "HEAD"), "ref: refs/heads/CaseMix\n");
  await fs.writeFile(path.join(rootA, "note.txt"), "stable");

  const seqBefore = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(seqBefore + 1); // push still commits the stable file subset
  expect((await remote.latest()).manifest.files.some((f) => f.path === "note.txt")).toBe(true);
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeUndefined();
  const deferLine = logsA.find((l) => l.includes("deferred 1") && l.includes("r:"));
  expect(deferLine).toBeDefined();
  expect(deferLine!).toContain("r: capture failed self-validation: HEAD branch refs/heads/CaseMix not in refs");
  expect(deferLine!).not.toContain("capture returned nothing");
}, 20_000);

test("git artifact sha_mismatch re-encrypts and retries with resumable uploadsDir", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "v1", "c1");
  const backoffAttempts: number[] = [];
  remote.gitShaMismatchFailures = 1;

  await push(rootA, cfgA, { ...depsA, backoff: async (attempt) => backoffAttempts.push(attempt) });

  const m = (await remote.latest()).manifest;
  expect(m.gitRepos?.["r"]).toBeDefined();
  expect(backoffAttempts).toEqual([0]);
  expect(remote.gitPutCalls).toBeGreaterThanOrEqual(2);
  expect(remote.gitPutUploads[0]!.sha).toBe(remote.gitPutUploads[1]!.sha); // same plaintext bundle re-encrypted to the same encSha
  expect(remote.gitPutUploads[0]!.src).not.toBe(remote.gitPutUploads[1]!.src); // stale ciphertext temp was dropped and recreated
  const scratch = `${path.join(rootA, ".rbox", "gitcap")}${path.sep}`;
  expect(remote.gitPutUploads[0]!.src.startsWith(scratch)).toBe(true);
  expect(remote.gitPutUploads[1]!.src.startsWith(scratch)).toBe(true);
  expect(new Set(remote.gitPutUploads.map((u) => u.uploadsDir))).toEqual(new Set([path.join(rootA, ".rbox", "state", "uploads")]));
}, 20_000);

test("git artifact sha_mismatch retries are bounded; final failure defers with base carry", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const base = (await st(rootA)).lastSyncedManifest.gitRepos!["r"]!;
  remote.gitPutCalls = 0;
  remote.gitPutUploads = [];

  await commitFile(r, "f.txt", "v2", "c2");
  await fs.writeFile(path.join(rootA, "note.txt"), "stable");
  const backoffAttempts: number[] = [];
  remote.gitShaMismatchFailures = 99;

  await push(rootA, cfgA, { ...depsA, backoff: async (attempt) => backoffAttempts.push(attempt) });

  expect(remote.gitPutCalls).toBe(3); // PER_FILE_UPLOAD_ATTEMPTS parity
  expect(backoffAttempts).toEqual([0, 1]);
  const m = (await remote.latest()).manifest;
  expect(m.files.some((f) => f.path === "note.txt")).toBe(true);
  expect(m.gitRepos!["r"]!.bundleEncSha).toBe(base.bundleEncSha);
  expect(logsA.some((l) => l.includes("deferred 1") && l.includes("r: capture failed: blob PUT rejected"))).toBe(true);
}, 20_000);

test("push: a locked (busy) repo defers with base carry — no raw-identity capture while mid-operation", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const base = (await st(rootA)).lastSyncedManifest.gitRepos!["r"]!;

  await commitFile(r, "f.txt", "v2", "c2");
  await fs.writeFile(path.join(r, ".git", "index.lock"), ""); // repo is mid-operation
  await fs.writeFile(path.join(rootA, "x.txt"), "x");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(base.bundleEncSha); // base carried
  expect(logsA.some((l) => l.includes("r: git busy"))).toBe(true);

  await fs.rm(path.join(r, ".git", "index.lock"));
  await push(rootA, cfgA, depsA); // quiesced → captures v2
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).not.toBe(base.bundleEncSha);
}, 20_000);

test("repo dir GONE ENTIRELY → pusher drops the section (§9); receiver drops base, records removal memory, never touches local .git", async () => {
  const r = path.join(rootA, "gone");
  await initRepo(r);
  await commitFile(r, "f.txt", "x", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const bHead = await git(path.join(rootB, "gone"), "rev-parse", "HEAD");

  await fs.rm(r, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined(); // dropped
  expect(logsA.some((l) => l.includes("removed 1"))).toBe(true);

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base entry dropped
  expect(sB.gitReposRemoved?.["gone"]).toBeDefined(); // removal memory recorded
  expect(await git(path.join(rootB, "gone"), "rev-parse", "HEAD")).toBe(bHead); // local .git untouched

  // resurrection guard: B's next push does NOT re-add the untouched leftover
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head); // no-op — no resurrection ping-pong
});

// ── (c) design §13.5 pending tests ────────────────────────────────────────────────

test("design 116 phase-0: linked-worktree partial apply stays pending, retries without conflict, then completes after removal", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "base.txt", "base", "base");
  await git(a, "branch", "side");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  const b = path.join(rootB, "r");
  const baseline = (await st(rootB)).lastSyncedManifest.gitRepos!["r"]!;
  const heldSide = await git(b, "rev-parse", "side");
  const worktree = path.join(tmp, "b-r-side");
  await git(b, "worktree", "add", worktree, "side");

  await git(a, "checkout", "-q", "side");
  await commitFile(a, "side.txt", "incoming side", "advance side");
  const incomingSide = await git(a, "rev-parse", "side");
  await git(a, "checkout", "-q", "main");
  await commitFile(a, "main.txt", "incoming main", "advance main");
  const incomingMain = await git(a, "rev-parse", "main");
  await push(rootA, cfgA, depsA);

  await pull(rootB, cfgB, depsB);
  let state = await st(rootB);
  expect(await git(b, "rev-parse", "main")).toBe(incomingMain); // checkout/unrelated ref plane advanced
  expect(await git(b, "rev-parse", "side")).toBe(heldSide);
  expect(await git(worktree, "rev-parse", "HEAD")).toBe(heldSide);
  expect(state.gitPendingRemote?.["r"]?.refs["refs/heads/side"]).toBe(incomingSide);
  expect(state.lastSyncedManifest.gitRepos!["r"]!.refs).toEqual({
    ...baseline.refs,
    "refs/heads/main": incomingMain,
  }); // typed witnesses advance admitted members while the held member stays at prior BASE
  expect(state.gitNeedsResolution?.["r"]).toBeUndefined();
  let record = repoRecordsForState(state).r!;
  expect(record.partial).toEqual({
    incomingKey: gitIncomingKey(state.gitPendingRemote!["r"]!),
    checkoutPending: false,
    appliedRefs: expect.objectContaining({
      "refs/heads/main": expect.objectContaining({ kind: "present", oid: incomingMain }),
    }),
    heldRefs: { "refs/heads/side": "ownership" },
    configApplied: true,
  });
  const chronicSince = record.deferrals?.apply?.deferredSince;
  expect(record.deferrals?.apply).toMatchObject({ lane: "apply", reason: "worktree-ownership", checkout: { kind: "branch", label: "main" } });
  expect(logsB.some((line) => line === "git-sync followed r")).toBe(true);

  // A newer wire section may arrive after the v2 partial. The proof is against persisted
  // pending v2, then apply retries newest v3: unrelated main advances, side stays held.
  await commitFile(a, "main-v3.txt", "newest main", "advance main again");
  const newestMain = await git(a, "rev-parse", "main");
  await push(rootA, cfgA, depsA);
  logsB.length = 0;
  await pull(rootB, cfgB, depsB);
  state = await st(rootB);
  expect(await git(b, "rev-parse", "main")).toBe(newestMain);
  expect(state.gitPendingRemote?.["r"]).toBeDefined();
  expect(state.gitNeedsResolution?.["r"]).toBeUndefined();
  record = repoRecordsForState(state).r!;
  expect(record.partial?.incomingKey).toBe(gitIncomingKey(state.gitPendingRemote!["r"]!));
  expect(record.deferrals?.apply?.deferredSince).toBe(chronicSince);
  expect(logsB.some((line) => line.includes("CONFLICT r"))).toBe(false);
  expect(logsB.some((line) => line === "git-sync followed r")).toBe(true);

  // Once ownership disappears, the same recognizable three-way partial shape retries
  // into a full apply; pending clears and the base finally advances to incoming truth.
  await git(b, "worktree", "remove", "--force", worktree);
  logsB.length = 0;
  await pull(rootB, cfgB, depsB);
  state = await st(rootB);
  expect(await git(b, "rev-parse", "side")).toBe(incomingSide);
  expect(state.gitPendingRemote?.["r"]).toBeUndefined();
  expect(state.gitNeedsResolution?.["r"]).toBeUndefined();
  expect(repoRecordsForState(state).r?.partial).toBeUndefined();
  expect(repoRecordsForState(state).r?.deferrals?.apply).toBeUndefined();
  expect(state.lastSyncedManifest.gitRepos!["r"]!.refs["refs/heads/side"]).toBe(incomingSide);
  expect(logsB.some((line) => line.includes("CONFLICT r"))).toBe(false);
}, 20_000);

test("D2 partial retry never overwrites a human-moved applied non-current ref", async () => {
  const a = path.join(rootA, "partial-human");
  await initRepo(a);
  await commitFile(a, "base.txt", "base", "base");
  await git(a, "branch", "side");
  await git(a, "branch", "other");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "partial-human");
  const oldOther = await git(b, "rev-parse", "other");
  const worktree = path.join(tmp, "partial-human-side");
  await git(b, "worktree", "add", worktree, "side");

  await git(a, "checkout", "-q", "side");
  await commitFile(a, "side.txt", "incoming", "side");
  await git(a, "checkout", "-q", "other");
  await commitFile(a, "other.txt", "incoming", "other");
  const incomingOther = await git(a, "rev-parse", "other");
  await git(a, "checkout", "-q", "main");
  await commitFile(a, "main.txt", "incoming", "main");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  expect(await git(b, "rev-parse", "other")).toBe(incomingOther);
  expect(repoRecordsForState(await st(rootB))["partial-human"]?.partial).toBeDefined();

  // Simulated crash interval: state says rbox published `other`, then a human moves it.
  await git(b, "update-ref", "refs/heads/other", oldOther);
  await git(b, "worktree", "remove", "--force", worktree);
  logsB.length = 0;
  await pull(rootB, cfgB, depsB);
  expect(await git(b, "rev-parse", "other")).toBe(oldOther);
  const held = repoRecordsForState(await st(rootB))["partial-human"]!;
  expect(held.partial?.heldRefs["refs/heads/other"]).toBe("local-commits");
  expect(held.deferrals?.apply?.reason).toBe("local-commits");
  expect(logsB.some((line) => line.includes("CONFLICT partial-human"))).toBe(false);
}, 20_000);

/** Sync a repo to both machines, advance it on A, then make B's pull DEFER the apply
 *  (index.lock = receiver busy) so `gitPendingRemote` is recorded. Returns repo paths. */
async function makePending(rel: string): Promise<{ a: string; b: string; lock: string }> {
  const a = path.join(rootA, rel);
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B based at v1
  await commitFile(a, "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  const b = path.join(rootB, rel);
  const lock = path.join(b, ".git", "index.lock");
  await fs.writeFile(lock, "");
  await pull(rootB, cfgB, depsB); // apply defers: receiver git busy → pending v2
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.[rel]).toBeDefined();
  expect(repoRecordsForState(sB)[rel]?.deferrals?.apply?.reason).toBe("git-busy");
  expect(logsB.some((l) => l.startsWith(`git-sync deferred ${rel}`))).toBe(true);
  return { a, b, lock };
}

test("D2 apply deferral keeps chronic age across newer truth and resets reason age", async () => {
  const { a, lock } = await makePending("chronic");
  const busy = repoRecordsForState(await st(rootB)).chronic!.deferrals!.apply!;
  await commitFile(a, "newer.txt", "v3", "v3");
  await push(rootA, cfgA, depsA);
  remote.deleteBlob((await remote.latest()).manifest.gitRepos!.chronic!.bundleEncSha);
  await fs.rm(lock);
  await pull(rootB, cfgB, depsB);
  const artifact = repoRecordsForState(await st(rootB)).chronic!.deferrals!.apply!;
  expect(artifact.reason).toBe("artifact");
  expect(artifact.deferredSince).toBe(busy.deferredSince);
  expect(artifact.reasonSince).not.toBe(busy.reasonSince);
  expect(artifact.lastSeen >= busy.lastSeen).toBe(true);
  expect(artifact.subjectKey).not.toBe(busy.subjectKey);
}, 20_000);

test("design 116: pending remote plus ordinary human divergence remains a typed deferral", async () => {
  const { b, lock } = await makePending("human-divergence");
  await fs.rm(lock);
  await commitFile(b, "local.txt", "human work", "local commit");
  logsB.length = 0;

  await pull(rootB, cfgB, depsB);

  const state = await st(rootB);
  expect(state.gitNeedsResolution?.["human-divergence"]).toBeUndefined();
  expect(state.gitPendingRemote?.["human-divergence"]).toBeDefined();
  const first = repoRecordsForState(state)["human-divergence"]?.deferrals?.apply;
  expect(first?.reason).toBe("local-edits");
  expect(logsB.some((line) => line.startsWith("git-sync deferred human-divergence"))).toBe(true);
  await pull(rootB, cfgB, depsB);
  const held = repoRecordsForState(await st(rootB))["human-divergence"]?.deferrals?.apply;
  expect(held?.reason).toBe("local-edits");
  expect(held?.deferredSince).toBe(first?.deferredSince);
}, 20_000);

test("pending: outbound pushes CARRY the pending section (never the stale base) and the base does not advance [v5]", async () => {
  const { b, lock } = await makePending("r");
  const sB = await st(rootB);
  const pendingSec = sB.gitPendingRemote!["r"]!;
  expect(sB.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).not.toBe(pendingSec.bundleEncSha); // base stayed v1

  // a steady pending carry alone is NOT a change — no echo commit
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head);

  // an unrelated file push CARRIES the pending section outbound, base still v1
  await fs.writeFile(path.join(rootB, "unrelated.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(pendingSec.bundleEncSha);
  const sB2 = await st(rootB);
  expect(sB2.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).not.toBe(pendingSec.bundleEncSha); // per-repo base advance withheld
  expect(sB2.gitPendingRemote?.["r"]).toBeDefined();

  // lock released → the next pull retries and applies; pending clears; base advances
  await fs.rm(lock);
  await pull(rootB, cfgB, depsB);
  const sB3 = await st(rootB);
  expect(sB3.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB3.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).toBe(pendingSec.bundleEncSha);
  expect(repoRecordsForState(sB3).r?.deferrals?.apply).toBeUndefined();
  expect(await fs.readFile(path.join(b, "f.txt"), "utf8")).toBe("v2");
}, 20_000);

test("standing apply deferral marks pushed repo bytes changed, survives restart, and clears with the episode", async () => {
  const { b, lock } = await makePending("bytes-marker");
  const before = repoRecordsForState(await st(rootB))["bytes-marker"]!.deferrals!.apply!;
  expect(before.bytesChanged).toBeUndefined();

  await fs.writeFile(path.join(b, "f.txt"), "human bytes during deferral");
  await push(rootB, cfgB, depsB);

  const restarted = await st(rootB);
  const marked = repoRecordsForState(restarted)["bytes-marker"]!.deferrals!.apply!;
  expect(marked.bytesChanged).toBe(true);
  expect(marked.deferredSince).toBe(before.deferredSince);
  expect(marked.lastSeen).toBe(before.lastSeen);

  await fs.rm(lock);
  await pull(rootB, cfgB, depsB);
  expect(repoRecordsForState(await st(rootB))["bytes-marker"]?.deferrals?.apply).toBeUndefined();
}, 20_000);

test("remote absence while partial: absence supersedes pending+partial [v6] — state clears with no outbound resurrection", async () => {
  const { a, b, lock } = await makePending("r");
  const partialState = await st(rootB);
  const pending = partialState.gitPendingRemote!.r!;
  partialState.repoRecords!.r!.partial = {
    incomingKey: gitIncomingKey(pending),
    checkoutPending: true,
    appliedRefs: {},
    heldRefs: {},
    configApplied: true,
  };
  await saveState(rootB, partialState);
  await fs.rm(lock);
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // A deletes the repo

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // absence supersedes pending
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base dropped
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // leftover memory
  expect(repoRecordsForState(sB).r?.deferrals).toBeUndefined();
  expect(repoRecordsForState(sB).r?.partial).toBeUndefined();
  await expect(git(b, "rev-parse", "HEAD")).resolves.toBeDefined(); // local .git survives (at v1)

  // B's next push must NOT resurrect the repo A just deleted (no pending carry, no re-add)
  await fs.writeFile(path.join(rootB, "unrelated.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined();
}, 20_000);

test("pending-ONLY (never based) deletion: remote absence clears the pending entry cleanly", async () => {
  // A pushes a repo; B's target is a fresh EMPTY repo holding an index.lock → the
  // materialization defers → pending with NO base entry.
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const b = path.join(rootB, "r");
  await initRepo(b); // empty local repo (no commits) — a clean apply target, but busy:
  await fs.writeFile(path.join(b, ".git", "index.lock"), "");
  await pull(rootB, cfgB, depsB);
  let sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeDefined();
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // pending-only: never based

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // remote deletes the repo
  await fs.rm(path.join(b, ".git", "index.lock")); // repo quiesces — the removal can now be examined
  await pull(rootB, cfgB, depsB);
  sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // cleared — pending-only repos see absence too
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // the leftover empty .git is remembered
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head); // and never re-added
}, 20_000);

test("pending + 422: M5 non-looping drop — section dropped from THIS commit, pending kept for the next pull [v6]", async () => {
  const { lock } = await makePending("r");
  await fs.rm(lock);
  const sB = await st(rootB);
  const pendingSec = sB.gitPendingRemote!["r"]!;
  remote.deleteBlob(pendingSec.bundleEncSha); // server-side GC of the pending section's bundle

  await fs.writeFile(path.join(rootB, "x.txt"), "x");
  const res = await pushManifest(rootB, cfgB, await scanManifest(rootB, undefined, undefined), depsB);
  expect(res.sequence).toBe(remote.headSeq()); // the push SUCCEEDED (no 422 loop)
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeUndefined(); // dropped from this commit
  expect((await remote.latest()).manifest.files.some((f) => f.path === "x.txt")).toBe(true);
  const sB2 = await st(rootB);
  expect(sB2.gitPendingRemote?.["r"]).toBeDefined(); // pending left in place for the next pull
  expect(sB2.lastSyncedManifest.gitRepos!["r"]).toBeDefined(); // per-repo base kept the OLD entry

  // the next pull sees the (now-absent) repo and resolves via absence-supersedes
  await pull(rootB, cfgB, depsB);
  const sB3 = await st(rootB);
  expect(sB3.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB3.gitReposRemoved?.["r"]).toBeDefined();
}, 20_000);

test("pending + remote deletion while the repo is BUSY: absence still supersedes pending — no resurrection through pending or base", async () => {
  const { a, b } = await makePending("r"); // index.lock still held on B
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // A deletes the repo

  await pull(rootB, cfgB, depsB); // B's copy is BUSY — absence must still be processed
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // [v6] absence supersedes pending, even busy
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base dropped
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // lock-immune memory (base identity)

  // outbound file push while still busy: neither pending nor base resurrects the repo
  await fs.writeFile(path.join(rootB, "u.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined();

  // once quiesced, the unchanged leftover STILL doesn't re-add (memory matches live identity)
  await fs.rm(path.join(b, ".git", "index.lock"));
  await fs.writeFile(path.join(rootB, "u2.txt"), "y");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined();
  await expect(git(b, "rev-parse", "HEAD")).resolves.toBeDefined(); // local .git never touched
}, 20_000);

test("deleting a leftover .git prunes its removal memory even on a NO-OP push; an identical re-create then re-adds (§9)", async () => {
  const DATE = "2026-01-01T00:00:00 +0000"; // fixed dates → the re-create has the SAME identity
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "same", "c1", DATE);
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // memory recorded on B, leftover intact
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();

  // B deletes the leftover .git — no synced file changes → EXACTLY a no-op push,
  // which must still persist the §9 memory prune ("pruned when .git disappears").
  await fs.rm(path.join(rootB, "r"), { recursive: true, force: true });
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head); // no commit burned
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeUndefined(); // memory pruned anyway

  // B re-creates an IDENTICAL repo: a stale memory would suppress this legitimate re-add.
  const b = path.join(rootB, "r");
  await initRepo(b);
  await commitFile(b, "f.txt", "same", "c1", DATE);
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeDefined(); // re-added
}, 20_000);

test("absence supersedes pending even when the conflict preserve FAILS (crash-safe — no stale pending to resurrect)", async () => {
  const { a, b, lock } = await makePending("r");
  await fs.rm(lock);
  await commitFile(b, "g.txt", "local-work", "b c1"); // local diverges while pending
  const pendSec = (await st(rootB)).gitPendingRemote!["r"]!;
  const localHead = await git(b, "rev-parse", "HEAD");
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // remote deletes the repo
  remote.deleteBlob(pendSec.bundleEncSha); // the preserve's bundle fetch will now throw

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // cleared DESPITE the preserve failure
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base dropped
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // guard stamped after the divergence was examined
  expect(logsB.some((l) => l.includes("WARNING r") && l.includes("preserve"))).toBe(true); // loud
  expect(await git(b, "rev-parse", "HEAD")).toBe(localHead); // local work untouched

  await fs.writeFile(path.join(rootB, "u.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined(); // v6 class stays closed
}, 20_000);

test("pending + LOCAL divergence + remote deletion: conflict path wins FIRST, then removal memory (§13.5)", async () => {
  const { a, b, lock } = await makePending("r");
  await fs.rm(lock);
  // local diverges from base while the remote section is still pending
  await commitFile(b, "g.txt", "local-work", "b c1");
  const localHead = await git(b, "rev-parse", "HEAD");
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // remote deletes the repo

  await pull(rootB, cfgB, depsB);
  // conflict path preserved the PENDING remote section for recovery — local kept
  expect(await git(b, "rev-parse", "HEAD")).toBe(localHead);
  const conflicts = await fs.readdir(path.join(b, ".rbox", "git-conflicts"));
  expect(conflicts.some((f) => f.endsWith(".bundle"))).toBe(true);
  expect(logsB.some((l) => l.includes("CONFLICT r") && l.includes("pending"))).toBe(true);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // memory stamped AFTER the conflict was preserved
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined();

  // identity unchanged since the memory → the repo is NOT re-added (only files sync)
  await push(rootB, cfgB, depsB); // g.txt (the working file) may sync — git must not
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeUndefined();
  // NEW work after the memory was stamped → re-adding is intentional
  await commitFile(b, "h.txt", "newer-work", "b c2");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeDefined(); // intentional re-add
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeUndefined(); // memory cleared
}, 20_000);

// ── (d) removal memory: fresh re-create at the same path = CLEAN materialization ──

test("fresh re-create at a removed path: dir leftover is QUARANTINED then wiped, fresh state applies, memory clears", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "old c1");
  await git(a, "branch", "leftover-branch");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  const oldHead = await git(b, "rev-parse", "HEAD");

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B: base dropped, memory recorded, leftover intact
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();
  expect(await git(b, "rev-parse", "HEAD")).toBe(oldHead);

  // A creates a brand-NEW repo at the same path and pushes it
  await initRepo(a);
  await commitFile(a, "n.txt", "new", "new c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  // clean materialization: quarantine exists, old refs are GONE, new state applied
  const qDir = path.join(b, ".rbox", "git-quarantine");
  const qFiles = await fs.readdir(qDir);
  expect(qFiles.some((f) => f.endsWith(".bundle"))).toBe(true); // full recovery quarantined
  expect(await git(b, "rev-parse", "main")).toBe(await git(a, "rev-parse", "main"));
  await expect(git(b, "rev-parse", "--verify", "leftover-branch")).rejects.toThrow(); // wiped — no side-door resurrection
  const sB = await st(rootB);
  expect(sB.gitReposRemoved?.["r"]).toBeUndefined(); // memory cleared
  expect(sB.lastSyncedManifest.gitRepos?.["r"]).toBeDefined(); // based again
}, 20_000);

test("clean materialization with a ref-wiping hook defers before stranding a sibling worktree branch", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "old c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  await git(b, "branch", "sibling");
  const siblingWt = path.join(tmp, "b-r-sibling");
  await git(b, "worktree", "add", siblingWt, "sibling");
  const siblingSha = await git(b, "rev-parse", "sibling");

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B: removal memory recorded over the dir leftover
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();

  const mainA = path.join(tmp, "a-main-for-r");
  await initRepo(mainA);
  await commitFile(mainA, "base.txt", "base", "main c1");
  await git(mainA, "worktree", "add", a, "-b", "feat");
  await commitFile(a, "feat.txt", "new", "feat c1");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.refScope).toBe("scoped");

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeDefined(); // whole section deferred
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // memory kept; hook did not run
  expect(logsB.some((l) => l.includes("r") && l.includes("would be wiped"))).toBe(true);
  expect(await git(b, "rev-parse", "sibling")).toBe(siblingSha);
  expect(await git(siblingWt, "rev-parse", "HEAD")).toBe(siblingSha);
  expect(await fs.readdir(path.join(b, ".rbox", "git-quarantine")).catch(() => [])).toEqual([]);
}, 20_000);

test("clean materialization with a ref-wiping hook still applies when no sibling worktree owns the wiped refs", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "old c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  await git(b, "branch", "sibling"); // local syncable ref, but not checked out in a linked worktree

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();

  const mainA = path.join(tmp, "a-main-for-r");
  await initRepo(mainA);
  await commitFile(mainA, "base.txt", "base", "main c1");
  await git(mainA, "worktree", "add", a, "-b", "feat");
  await commitFile(a, "feat.txt", "new", "feat c1");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.refScope).toBe("scoped");

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB.gitReposRemoved?.["r"]).toBeUndefined();
  expect(await git(b, "symbolic-ref", "HEAD")).toBe("refs/heads/feat");
  await expect(git(b, "rev-parse", "--verify", "sibling")).rejects.toThrow(); // wiped by clean materialization
  const qFiles = await fs.readdir(path.join(b, ".rbox", "git-quarantine"));
  expect(qFiles.some((f) => f.endsWith(".bundle"))).toBe(true);
}, 20_000);

test("clean materialization wipes ONLY after artifacts verify — a missing bundle leaves the leftover intact", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "c1");
  await git(a, "branch", "leftover-branch");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // memory recorded, leftover intact

  // A re-creates a fresh repo at the same path; the server then LOSES its bundle
  await initRepo(a);
  await commitFile(a, "n.txt", "new", "n1");
  await push(rootA, cfgA, depsA);
  const newSec = (await remote.latest()).manifest.gitRepos!["r"]!;
  const saved = await remote.blobStore().get(newSec.bundleEncSha);
  remote.deleteBlob(newSec.bundleEncSha);

  await pull(rootB, cfgB, depsB); // fetch fails → the wipe must never have run
  expect(await git(b, "rev-parse", "--verify", "leftover-branch")).toBeTruthy(); // NOT wiped
  expect(await fs.readdir(path.join(b, ".rbox", "git-quarantine")).catch(() => [])).toEqual([]); // no quarantine cut
  let sB = await st(rootB);
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // resurrection guard kept
  expect(sB.gitPendingRemote?.["r"]).toBeDefined(); // deferred for retry

  // the blob returns → the clean materialization completes on the next pull
  await remote.blobStore().put(newSec.bundleEncSha, saved);
  await pull(rootB, cfgB, depsB);
  expect(await git(b, "rev-parse", "main")).toBe(await git(a, "rev-parse", "main"));
  await expect(git(b, "rev-parse", "--verify", "leftover-branch")).rejects.toThrow(); // wiped post-verify
  sB = await st(rootB);
  expect(sB.gitReposRemoved?.["r"]).toBeUndefined();
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined();
}, 20_000);

test("an ignored-but-present leftover keeps its removal memory (guard survives being undiscoverable)", async () => {
  const a = path.join(rootA, "gone");
  await initRepo(a);
  await commitFile(a, "f.txt", "x", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B: memory recorded, leftover .git intact

  // B now ignores the leftover's subtree — discovery can't see it, but the guard must survive
  await fs.writeFile(path.join(rootB, ".rboxignore"), "gone/\n");
  await fs.writeFile(path.join(rootB, "z.txt"), "z");
  await push(rootB, cfgB, depsB);
  expect((await st(rootB)).gitReposRemoved?.["gone"]).toBeDefined(); // NOT pruned
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined(); // and nothing resurrected
}, 20_000);

test("design 72: a based repo hidden by gitignore discovery pruning is silently base-carried, not deferred or removed", async () => {
  const depA = path.join(rootA, "dep");
  await initRepo(depA);
  await commitFile(depA, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const before = (await remote.latest()).manifest.gitRepos?.["dep"]?.bundleEncSha;
  expect(before).toBeDefined();

  logsB = [];
  await fs.writeFile(path.join(rootB, ".gitignore"), "dep/\n");
  await fs.writeFile(path.join(rootB, "note.txt"), "forces a file commit");
  await push(rootB, cfgB, depsB);

  const latest = await remote.latest();
  expect(latest.manifest.gitRepos?.["dep"]?.bundleEncSha).toBe(before);
  expect(logsB.some((l) => l.includes("dep") && l.includes("deferred"))).toBe(false);
  expect(logsB.some((l) => l.includes("dep") && l.includes("removed"))).toBe(false);
}, 20_000);

// ── (e) cap semantics [v2, M4] ─────────────────────────────────────────────────────

test("cap: new repos beyond the cap are deferred LOUDLY; base-carrying repos always carry AND still capture", async () => {
  process.env.RBOX_GIT_REPO_CAP = "2";
  for (const r of ["ra", "rb", "rc"]) {
    const d = path.join(rootA, r);
    await initRepo(d);
    await commitFile(d, "f.txt", r, "c1");
  }
  await push(rootA, cfgA, depsA);
  let m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["ra", "rb"]); // first 2 admitted
  expect(logsA.some((l) => l.includes("rc") && l.includes("cap"))).toBe(true);

  // based repos are never cap-throttled: with cap=1, a CHANGED based repo still captures
  process.env.RBOX_GIT_REPO_CAP = "1";
  const oldRa = m.gitRepos!["ra"]!.bundleEncSha;
  await commitFile(path.join(rootA, "ra"), "f.txt", "ra2", "c2");
  await push(rootA, cfgA, depsA);
  m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["ra", "rb"]); // carry never drops
  expect(m.gitRepos!["ra"]!.bundleEncSha).not.toBe(oldRa); // based repo captured over the cap
  // rc stays deferred until the cap allows admission
  delete process.env.RBOX_GIT_REPO_CAP;
  await push(rootA, cfgA, depsA);
  expect(Object.keys((await remote.latest()).manifest.gitRepos ?? {}).sort()).toEqual(["ra", "rb", "rc"]);
}, 20_000);

// ── needs-resolution conflict suppression [v2, M2] ─────────────────────────────────

test("per-repo human divergence is pending-carried and capture-suppressed without a checkpoint", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  // both sides diverge
  await commitFile(a, "f.txt", "a-side", "a c2");
  const b = path.join(rootB, "r");
  await git(b, "config", "user.email", "t@t.t");
  await git(b, "config", "user.name", "t");
  await commitFile(b, "g.txt", "b-side", "b c2");
  const bHead = await git(b, "rev-parse", "HEAD");
  await push(rootA, cfgA, depsA);

  await pull(rootB, cfgB, depsB);
  expect(await git(b, "rev-parse", "HEAD")).toBe(bHead); // local never clobbered
  expect(logsB.some((l) => l.startsWith("git-sync deferred r"))).toBe(true);
  const sB = await st(rootB);
  expect(sB.gitNeedsResolution?.["r"]).toBeUndefined();
  expect(sB.gitPendingRemote?.["r"]?.bundleEncSha).toBe((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha);
  expect(repoRecordsForState(sB).r?.deferrals?.apply?.reason).toBe("local-edits");

  // sync()'s immediate push-after-pull must NOT republish the conflicted local state:
  // the git section stays the checkpointed remote (files like g.txt may still sync)
  const remoteSec = (await remote.latest()).manifest.gitRepos!["r"]!;
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(remoteSec.bundleEncSha);
  // and with files settled, the next push is a full no-op
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head);

  expect((await st(rootB)).gitPendingRemote?.["r"]).toBeDefined();
}, 20_000);

// ── per-repo independence: one busy repo defers only itself ────────────────────────

test("one busy repo defers only itself; every other repo's base advances independently", async () => {
  for (const r of ["r1", "r2"]) {
    const d = path.join(rootA, r);
    await initRepo(d);
    await commitFile(d, "f.txt", "v1", "c1");
  }
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await commitFile(path.join(rootA, "r1"), "f.txt", "v2", "c2");
  await commitFile(path.join(rootA, "r2"), "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);

  await fs.writeFile(path.join(rootB, "r1", ".git", "index.lock"), ""); // r1 busy on B
  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r1"]).toBeDefined(); // deferred
  expect(sB.gitPendingRemote?.["r2"]).toBeUndefined(); // applied
  expect(await git(path.join(rootB, "r2"), "rev-parse", "main")).toBe(await git(path.join(rootA, "r2"), "rev-parse", "main"));
}, 20_000);

// ── live-validation finding (design 43 §14 v6.1): shallow clones ─────────────────

test("structural preflight refusal (shallow clone): section DROPPED, not carried — never poisons receivers", async () => {
  // Live validation caught this: `bundle --all` from a SHALLOW clone silently omits
  // parents beyond the shallow boundary; receivers fail-close on every apply, forever,
  // because identity can't see shallowness. Structural refusals must DROP the section.
  const origin = path.join(tmp, "shallow-origin");
  await initRepo(origin);
  await commitFile(origin, "s.txt", "1", "c1");
  await commitFile(origin, "s.txt", "2", "c2");

  const p = path.join(rootA, "sh");
  await initRepo(p);
  await commitFile(p, "x.txt", "x", "c1");
  await push(rootA, cfgA, depsA); // full repo → section captured into base
  expect((await st(rootA)).lastSyncedManifest.gitRepos?.["sh"]).toBeDefined();
  const protectedBefore = repoRecordsForState(await st(rootA)).sh!;

  // Swap in a SHALLOW clone at the same path — simulating a base section whose repo
  // is now structurally unsyncable (the exact shape the old client authored live).
  await fs.rm(p, { recursive: true, force: true });
  await exec("git", ["clone", "-q", "--depth", "1", `file://${origin}`, p], { env: TEST_GIT_ENV });

  // Design 45: the pending structural DROP is an unpublished change —
  // status must not read "in sync" while the next push would commit a removal.
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), buildIgnoreMatcher(rootA))).toBe(1);

  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  expect(state.lastSyncedManifest.gitRepos?.["sh"]).toBeUndefined(); // dropped, not carried
  expect(repoRecordsForState(state).sh).toMatchObject({
    base: protectedBefore.base,
    repoAbsent: true,
  });
  expect(repoRecordsForState(state).sh?.branchBaseOrigins).toEqual(protectedBefore.branchBaseOrigins);
  expect(repoRecordsForState(state).sh?.advertised).toBeUndefined();
  expect(logsA.some((l) => l.includes("shallow clone"))).toBe(true); // loud, with the un-shallow hint
  // …and once the drop is published, the still-shallow repo is no longer pending work.
  expect(await gitDivergenceCount(rootA, cfgA, state, buildIgnoreMatcher(rootA))).toBe(0);

  // repoAbsent is not an identity-bound removal guard: repairing the structural
  // shape permits a normal fresh capture even though HEAD/index did not change.
  await git(p, "fetch", "--unshallow", "-q");
  await push(rootA, cfgA, depsA);
  const repaired = await st(rootA);
  expect(repaired.lastSyncedManifest.gitRepos?.["sh"]).toBeDefined();
  expect(repoRecordsForState(repaired).sh?.repoAbsent).toBeUndefined();
});

// ── design 45: the status verdict's advisory git-divergence walk ─────────────────

test("gitDivergenceCount mirrors push's capture decision (read-only, no state mutation)", async () => {
  const p1 = path.join(rootA, "proj1");
  await initRepo(p1);
  await commitFile(p1, "a.txt", "v1", "c1");
  const matcher = buildIgnoreMatcher(rootA);

  // Never-synced local repo → a push would publish it.
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
  // …and the walk itself must not have created/advanced any sync state.
  expect((await st(rootA)).lastSyncedSequence).toBe(0);

  // Push, then identity matches base → in sync.
  await push(rootA, cfgA, depsA);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);

  // A fresh local commit diverges the identity while the base stands → 1
  // A clean file tree + unpushed git state must not read "in sync".
  await commitFile(p1, "b.txt", "v2", "c2");
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
  await push(rootA, cfgA, depsA);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);

  // git-sync off → the dimension is simply absent.
  expect(await gitDivergenceCount(rootA, { ...cfgA, syncGit: false }, await st(rootA), matcher)).toBe(0);
});

test("gitDivergenceCount honors needsResolution suppression before preflight (codex R4)", async () => {
  const p1 = path.join(rootA, "proj1");
  await initRepo(p1);
  await commitFile(p1, "a.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);

  // Diverge locally → pending work…
  await commitFile(p1, "b.txt", "v2", "c2");
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);

  // …until a conflict checkpoint suppresses it: push CARRIES the base while the
  // identity equals the recorded conflict-time value, so status must read 0 —
  // and the suppression must be honored BEFORE preflight, matching the planner.
  const state = await st(rootA);
  await saveState(rootA, { ...state, gitNeedsResolution: { proj1: gitIdentityKey(await gitIdentity(p1)) } });
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);

  // The user touches the repo → identity leaves the checkpoint → republish is
  // intentional and the divergence shows again.
  await commitFile(p1, "c.txt", "v3", "c3");
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
});

test("gitDivergenceCount treats dangling gitfile pointers as transient like capture preflight", async () => {
  const repo = path.join(rootA, "dangling");
  await initRepo(repo);
  await commitFile(repo, "a.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  await fs.rm(path.join(repo, ".git"), { recursive: true, force: true });
  await fs.writeFile(path.join(repo, ".git"), "gitdir: /nonexistent/rbox-main/.git/worktrees/dangling\n");

  const pf = await gitPreflight(repo);
  expect(pf.ok).toBe(false);
  expect(pf.kind).toBe("pointer");
  expect(pf.structural).not.toBe(true);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), buildIgnoreMatcher(rootA))).toBe(0);
});

test("gitDivergenceCount warm unchanged multi-repo fixture issues zero git spawns", async () => {
  for (const rel of ["alpha", "nested/beta", "gamma"]) {
    const repo = path.join(rootA, rel);
    await initRepo(repo);
    await commitFile(repo, "f.txt", rel, "c1");
  }
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);

  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0); // populate cache
  await markDivergenceCacheTrusted(rootA);
  const cache = JSON.parse(await fs.readFile(path.join(rootA, ".rbox", "state", "git-divergence.json"), "utf8")) as {
    version: string;
    repos: { alpha: { kind?: string } };
  };
  expect(cache.version).toBe(GIT_FINGERPRINT_VERSION);
  expect(cache.repos.alpha.kind).toBe("dir");
  const warm = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
  expect(warm.value).toBe(0);
  expect(warm.spawns).toBe(0);
}, 30_000);

test("gitDivergenceFastRepoSource treats v2 divergence cache as empty", async () => {
  const cachePath = path.join(rootA, ".rbox", "state", "git-divergence.json");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.mkdir(path.join(rootA, "cached-pointer"), { recursive: true });
  await fs.writeFile(
    cachePath,
    JSON.stringify({
      version: 2,
      repos: {
        legacy: { fingerprint: "fp", writtenAtMs: Date.now(), identityKey: "id", probe: { busy: false, preflightOk: true, identityKey: "id" } },
        "cached-pointer": { fingerprint: "fp", writtenAtMs: Date.now(), identityKey: "id", kind: "pointer", probe: { busy: false, preflightOk: true, identityKey: "id" } },
      },
    })
  );
  expect(await gitDivergenceFastRepoSource(rootA, undefined, buildIgnoreMatcher(rootA))).toEqual([]);
});

test("git divergence cache does not trust entries written under different git-config bounds", async () => {
  const cachePath = path.join(rootA, ".rbox", "state", "git-divergence.json");
  await fs.mkdir(path.join(rootA, "cached-repo"), { recursive: true });
  await fs.writeFile(
    cachePath,
    JSON.stringify({
      version: gitFingerprintVersionForBounds({
        maxKeys: MAX_GIT_CONFIG_KEYS - 1,
        maxSerializedBytes: MAX_GIT_CONFIG_SERIALIZED_BYTES,
        maxKeyBytes: MAX_GIT_CONFIG_KEY_BYTES,
        maxValueBytes: MAX_GIT_CONFIG_VALUE_BYTES,
      }),
      repos: {
        "cached-repo": {
          fingerprint: "cached-under-old-bounds",
          writtenAtMs: Date.now(),
          identityKey: "id",
          kind: "dir",
          probe: { busy: false, preflightOk: true, identityKey: "id" },
        },
      },
    })
  );

  expect(await gitDivergenceFastRepoSource(rootA, undefined, buildIgnoreMatcher(rootA))).toEqual([]);
});

test("gitDivergenceFastRepoSource filters cached and base repos through current admission", async () => {
  const cachePath = path.join(rootA, ".rbox", "state", "git-divergence.json");
  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.mkdir(path.join(rootA, "cache-present"), { recursive: true });
  await fs.mkdir(path.join(rootA, "base-present"), { recursive: true });
  await fs.mkdir(path.join(rootA, "ignored", "cache"), { recursive: true });
  await fs.mkdir(path.join(rootA, "ignored", "base"), { recursive: true });
  await fs.writeFile(path.join(rootA, ".rboxignore"), "ignored/\n");
  await fs.writeFile(
    cachePath,
    JSON.stringify({
      version: GIT_FINGERPRINT_VERSION,
      repos: {
        "cache-present": { fingerprint: "fp", writtenAtMs: Date.now(), identityKey: "id", kind: "dir", probe: { busy: false, preflightOk: true, identityKey: "id" } },
        "cache-missing": { fingerprint: "fp", writtenAtMs: Date.now(), identityKey: "id", kind: "dir", probe: { busy: false, preflightOk: true, identityKey: "id" } },
        "ignored/cache": { fingerprint: "fp", writtenAtMs: Date.now(), identityKey: "id", kind: "dir", probe: { busy: false, preflightOk: true, identityKey: "id" } },
      },
    })
  );
  const base = {
    "base-present": {} as GitSection,
    "base-missing": {} as GitSection,
    "ignored/base": {} as GitSection,
  };

  expect(await gitDivergenceFastRepoSource(rootA, base, buildIgnoreMatcher(rootA))).toEqual([
    { relPath: "base-present" },
    { relPath: "cache-present", kind: "dir" },
  ]);
});

test("gitDivergenceCount fingerprint cache invalidates on commits, staging, stash, branch checkout, packed refs, and sentinels", async () => {
  const repo = path.join(rootA, "mut");
  await initRepo(repo);
  await commitFile(repo, "base.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);

  const warmZero = async () => {
    expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);
    await markDivergenceCacheTrusted(rootA);
    const warm = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
    expect(warm.value).toBe(0);
    expect(warm.spawns).toBe(0);
  };
  const expectInvalidates = async (mutate: () => Promise<void>, expected: number) => {
    await warmZero();
    await mutate();
    const after = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
    expect(after.value).toBe(expected);
    expect(after.spawns).toBeGreaterThan(0);
  };

  await expectInvalidates(() => commitFile(repo, "commit.txt", "commit", "commit mutation"), 1);
  await push(rootA, cfgA, depsA);

  await expectInvalidates(async () => {
    await fs.writeFile(path.join(repo, "staged.txt"), "staged");
    await git(repo, "add", "staged.txt");
  }, 1);
  await push(rootA, cfgA, depsA);

  await expectInvalidates(async () => {
    await fs.writeFile(path.join(repo, "stash.txt"), "stash");
    await git(repo, "stash", "-q");
  }, 1);
  await push(rootA, cfgA, depsA);

  await expectInvalidates(async () => {
    await git(repo, "checkout", "-qb", "topic");
  }, 1);
  await push(rootA, cfgA, depsA);

  await expectInvalidates(async () => {
    await git(repo, "pack-refs", "--all", "--prune");
  }, 0);

  const head = await git(repo, "rev-parse", "HEAD");
  await expectInvalidates(async () => {
    await fs.writeFile(path.join(repo, ".git", "shallow"), `${head}\n`);
  }, 1);
  await fs.rm(path.join(repo, ".git", "shallow"), { force: true });

  await expectInvalidates(async () => {
    await fs.writeFile(path.join(repo, ".git", "objects", "info", "alternates"), "/tmp/rbox-missing-objects\n");
  }, 1);
}, 40_000);

test("gitDivergenceCount fingerprint cache invalidates on rebase op-state", async () => {
  const repo = path.join(rootA, "rebasey");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);
  await markDivergenceCacheTrusted(rootA);
  expect((await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher))).spawns).toBe(0);

  await git(repo, "checkout", "-qb", "side");
  await commitFile(repo, "f.txt", "side", "side c1");
  await git(repo, "checkout", "-q", "main");
  await commitFile(repo, "f.txt", "main", "main c2");
  await git(repo, "checkout", "-q", "side");
  await expect(git(repo, "rebase", "main")).rejects.toThrow();

  const after = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
  expect(after.value).toBe(1);
  expect(after.spawns).toBeGreaterThan(0);
}, 30_000);

test("gitDivergenceCount fingerprint cache invalidates pointer worktree refs via commonDir", async () => {
  const main = path.join(tmp, "main-outside");
  await initRepo(main);
  await commitFile(main, "m.txt", "main", "c1");
  const wt = path.join(rootA, "wt-pointer");
  await git(main, "worktree", "add", wt, "-b", "feat");
  await commitFile(wt, "w.txt", "worktree", "wt c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);
  await markDivergenceCacheTrusted(rootA);
  expect((await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher))).spawns).toBe(0);

  await commitFile(wt, "w2.txt", "common-dir-ref-change", "wt c2");
  const after = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
  expect(after.value).toBe(1);
  expect(after.spawns).toBeGreaterThan(0);
}, 30_000);

test("gitDivergenceCount stable-pair retry avoids stale cache under mid-probe mutation", async () => {
  const repo = path.join(rootA, "stable");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);
  await fs.rm(path.join(rootA, ".rbox", "state", "git-divergence.json"), { force: true });

  let mutated = false;
  setGitSpawnObserver((spawnRoot, args) => {
    if (mutated || spawnRoot !== repo || args[0] !== "write-tree") return;
    mutated = true;
    fsSync.writeFileSync(path.join(repo, "late.txt"), "late");
    execFileSync("git", ["-C", repo, "add", "late.txt"], { env: TEST_GIT_ENV });
  });
  try {
    expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
  } finally {
    setGitSpawnObserver(undefined);
  }
  expect(mutated).toBe(true);

  await markDivergenceCacheTrusted(rootA);
  const warm = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
  expect(warm.value).toBe(1);
  expect(warm.spawns).toBe(0);
}, 30_000);

test("gitDivergenceCount heals corrupt divergence cache after correct slow path", async () => {
  const repo = path.join(rootA, "corrupt-cache");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);
  await fs.mkdir(path.join(rootA, ".rbox", "state"), { recursive: true });
  const cachePath = path.join(rootA, ".rbox", "state", "git-divergence.json");
  await fs.writeFile(cachePath, "{not json");

  const slow = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
  expect(slow.value).toBe(0);
  expect(slow.spawns).toBeGreaterThan(0);
  expect(JSON.parse(await fs.readFile(cachePath, "utf8")).version).toBe(GIT_FINGERPRINT_VERSION);

  await markDivergenceCacheTrusted(rootA);
  const warm = await observeGitSpawns(async () => gitDivergenceCount(rootA, cfgA, await st(rootA), matcher));
  expect(warm.value).toBe(0);
  expect(warm.spawns).toBe(0);
}, 30_000);

// ── design 83: push-side git-plan fingerprint cache ─────────────────────────────

test("design 83/93: plan cache treats v2 as cold, writes the current version, then serves trusted warm carries with zero git spawns", async () => {
  const repo = path.join(rootA, "d83-v2");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);

  await writeDivergenceCache(rootA, {
    version: 2,
    repos: {
      "d83-v2": { fingerprint: "legacy", identityKey: "legacy", kind: "dir", probe: { busy: false, preflightOk: true, preflightKind: "dir", identityKey: "legacy" } },
    },
  });

  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  const cold = await observeGitSpawns(async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(cold.value.gitPlanStats?.fpMisses).toBe(1);
  expect(cold.value.gitPlanStats?.spawnedRepos).toBe(1);
  expect(cold.spawns).toBeGreaterThan(0);
  expect((await readDivergenceCache(rootA)).version).toBe(GIT_FINGERPRINT_VERSION);

  await markDivergenceCacheTrusted(rootA);
  const warm = await observeGitSpawns(async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(warm.value.gitPlanStats?.fpHits).toBe(1);
  expect(warm.value.gitPlanStats?.spawnedRepos).toBe(0);
  expect(warm.spawns).toBe(0);
  expect(gitPlanSurface(warm.value)).toEqual(gitPlanSurface(cold.value));
}, 30_000);

test("design 83: racy-clean margin refuses a hash-matching entry and takes the spawn path", async () => {
  const repo = path.join(rootA, "d83-margin");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);

  let cache = await readDivergenceCache(rootA);
  for (const entry of Object.values(cache.repos ?? {})) {
    if (entry && typeof entry === "object") entry.writtenAtMs = 0;
  }
  await writeDivergenceCache(rootA, cache);

  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  cache = await readDivergenceCache(rootA);
  for (const entry of Object.values(cache.repos ?? {})) {
    if (entry && typeof entry === "object") entry.writtenAtMs = 0;
  }
  await writeDivergenceCache(rootA, cache);

  const plan = await observeGitSpawns(async () => planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA)));
  expect(plan.value.gitPlanStats?.fpUntrusted).toBe(1);
  expect(plan.value.gitPlanStats?.spawnedRepos).toBe(1);
  expect(plan.spawns).toBeGreaterThan(0);
}, 30_000);

test("design 83: plan cache does not trust a stale carried probe after another repo changes during capture", async () => {
  const cleanRel = "d83-race-clean";
  const slowRel = "d83-race-slow";
  const clean = path.join(rootA, cleanRel);
  const slow = path.join(rootA, slowRel);
  for (const repo of [clean, slow]) {
    await initRepo(repo);
    await commitFile(repo, "f.txt", "base", "c1");
  }
  await push(rootA, cfgA, depsA);
  await fs.rm(divergenceCachePath(rootA), { force: true });

  await commitFile(slow, "slow.txt", "slow", "slow c2");
  let mutatedClean = false;
  setGitSpawnObserver((spawnRoot, args) => {
    if (mutatedClean || spawnRoot !== slow || args[0] !== "bundle" || args[1] !== "create") return;
    mutatedClean = true;
    fsSync.writeFileSync(path.join(clean, "late.txt"), "late");
    execFileSync("git", ["-C", clean, "add", "late.txt"], { env: TEST_GIT_ENV });
    execFileSync("git", ["-C", clean, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "late clean"], { env: TEST_GIT_ENV });
  });
  try {
    await push(rootA, cfgA, depsA);
  } finally {
    setGitSpawnObserver(undefined);
  }
  expect(mutatedClean).toBe(true);

  await markDivergenceCacheTrusted(rootA);
  const next = await observeGitSpawns(async () => planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA)));
  expect(next.value.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(next.value.captured).toContain(cleanRel);
  expect(next.value.carried).not.toContain(cleanRel);
  expect(next.spawns).toBeGreaterThan(0);
}, 40_000);

test("design 83: trusted warm plan is zero-spawn and uses cached parentRel for pointer skips", async () => {
  const { W } = await makeInTreeMainWithWorktree();
  const wtSection = (await captureGitState(W, remote.blobStore(), KEK))!;
  const s0 = await st(rootA);
  await saveState(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection } } });
  await push(rootA, cfgA, depsA);

  await fs.rm(divergenceCachePath(rootA), { force: true });
  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  const slow = await observeGitSpawns(async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(slow.value.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(slow.spawns).toBeGreaterThan(0);

  await markDivergenceCacheTrusted(rootA);
  const warm = await observeGitSpawns(async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(gitPlanSurface(warm.value)).toEqual(gitPlanSurface(slow.value));
  expect(warm.value.gitPlanStats?.spawnedRepos).toBe(0);
  expect(warm.value.gitPlanStats?.parentRelCached).toBe(1);
  expect(warm.spawns).toBe(0);
}, 30_000);

test("design 83: baseless in-tree pointer pre-skip uses warm cached parentRel with zero spawns", async () => {
  const { W } = await makeInTreeMainWithWorktree();
  await push(rootA, cfgA, depsA);

  await fs.rm(divergenceCachePath(rootA), { force: true });
  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  const cold = await observeGitSpawnsForRoot(W, async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(cold.value.gitPlanStats?.pointerPreSkips).toBe(0);
  expect(cold.value.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(cold.targetSpawns).toBeGreaterThan(0);
  expect(cold.value.skipped.map((s) => s.relPath)).toContain("wt");
  expect(cold.value.gitRepos?.["wt"]).toBeUndefined();
  const coldCache = await readDivergenceCache(rootA);
  expect(coldCache.repos?.wt?.kind).toBe("pointer");
  expect(coldCache.repos?.wt?.probe?.preflightOk).toBe(true);
  expect(coldCache.repos?.wt?.probe?.parentRel).toBe("main");

  await markDivergenceCacheTrusted(rootA);
  const warm = await observeGitSpawnsForRoot(W, async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(gitPlanSurface(warm.value)).toEqual(gitPlanSurface(cold.value));
  expect(warm.value.gitPlanStats?.pointerPreSkips).toBe(1);
  expect(warm.value.gitPlanStats?.spawnedRepos).toBe(0);
  expect(warm.targetSpawns).toBe(0);
  expect(warm.spawns).toBe(0);
}, 30_000);

test("design 83: baseless pointer pre-skip falls back when cached parent is not sectioned", async () => {
  const { W } = await makeInTreeMainWithWorktree();
  await fs.writeFile(path.join(rootA, ".rboxignore"), "main/\n");
  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);

  const cold = await observeGitSpawnsForRoot(W, async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(cold.value.skipped.map((s) => s.relPath)).not.toContain("wt");
  expect(cold.value.captured).toEqual(["wt"]);
  expect(cold.targetSpawns).toBeGreaterThan(0);

  await markDivergenceCacheTrusted(rootA);
  const warm = await observeGitSpawnsForRoot(W, async () => planGitSections(rootA, cfgA, state, remote, new Set(), matcher));
  expect(warm.value.skipped.map((s) => s.relPath)).not.toContain("wt");
  expect(warm.value.captured).toEqual(["wt"]);
  expect(Object.keys(warm.value.gitRepos ?? {})).toEqual(Object.keys(cold.value.gitRepos ?? {}));
  expect(warm.value.gitRepos?.["wt"]?.refScope).toBe(cold.value.gitRepos?.["wt"]?.refScope);
  expect(warm.value.gitPlanStats?.pointerPreSkips).toBe(0);
  expect(warm.value.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(warm.targetSpawns).toBeGreaterThan(0);
}, 30_000);

test("design 83: baseless pointer fingerprint miss spawns and never pre-skips", async () => {
  const { W } = await makeInTreeMainWithWorktree();
  await push(rootA, cfgA, depsA);
  await fs.rm(divergenceCachePath(rootA), { force: true });

  const planned = await observeGitSpawnsForRoot(W, async () =>
    planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA))
  );
  expect(planned.value.gitPlanStats?.fpMisses).toBeGreaterThan(0);
  expect(planned.value.gitPlanStats?.pointerPreSkips).toBe(0);
  expect(planned.value.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(planned.targetSpawns).toBeGreaterThan(0);
  expect(planned.value.skipped.map((s) => s.relPath)).toContain("wt");
}, 30_000);

test("design 83: pending, needs-resolution, and force baseless pointers never pre-skip", async () => {
  const { W } = await makeInTreeMainWithWorktree();
  const wtSection = (await captureGitState(W, remote.blobStore(), KEK))!;
  await push(rootA, cfgA, depsA);
  await markDivergenceCacheTrusted(rootA);

  const baseState = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  const liveIdentityKey = gitIdentityKey(await gitIdentity(W));

  const pending = await observeGitSpawnsForRoot(W, async () =>
    planGitSections(rootA, cfgA, { ...baseState, gitPendingRemote: { wt: wtSection } }, remote, new Set(), matcher)
  );
  expect(pending.value.gitPlanStats?.pointerPreSkips).toBe(0);
  expect(pending.value.skipped.map((s) => s.relPath)).not.toContain("wt");
  expect(pending.value.gitRepos?.["wt"]).toEqual(wtSection);
  expect(pending.targetSpawns).toBe(0);

  await markDivergenceCacheTrusted(rootA);
  const needsResolution = await observeGitSpawnsForRoot(W, async () =>
    planGitSections(rootA, cfgA, { ...baseState, gitNeedsResolution: { wt: liveIdentityKey } }, remote, new Set(), matcher)
  );
  expect(needsResolution.value.gitPlanStats?.pointerPreSkips).toBe(0);
  expect(needsResolution.value.skipped.map((s) => s.relPath)).not.toContain("wt");
  expect(needsResolution.value.gitRepos?.["wt"]).toBeUndefined();
  expect(needsResolution.targetSpawns).toBeGreaterThan(0);

  await markDivergenceCacheTrusted(rootA);
  const forced = await observeGitSpawnsForRoot(W, async () =>
    planGitSections(rootA, cfgA, baseState, remote, new Set(["wt"]), matcher)
  );
  expect(forced.value.gitPlanStats?.pointerPreSkips).toBe(0);
  expect(forced.value.skipped.map((s) => s.relPath)).not.toContain("wt");
  expect(forced.value.captured).toContain("wt");
  expect(forced.targetSpawns).toBeGreaterThan(0);
}, 30_000);

test("design 83: fast-path guard failures stay on the existing live planner path", async () => {
  const rel = "d83-guards";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const baseState = await st(rootA);
  const baseSec = baseState.lastSyncedManifest.gitRepos![rel]!;
  const liveIdentityKey = gitIdentityKey(await gitIdentity(repo));
  const matcher = () => buildIgnoreMatcher(rootA);
  const plan = (state: SyncState, force: ReadonlySet<string> = new Set(), m = matcher()) =>
    planGitSections(rootA, cfgA, state, remote, force, m);
  const refreshTrusted = async () => {
    await plan(baseState);
    await markDivergenceCacheTrusted(rootA);
  };
  const expectSpawn = async (state: SyncState = baseState, force: ReadonlySet<string> = new Set(), m = matcher()) => {
    await refreshTrusted();
    const out = await plan(state, force, m);
    expect(out.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
    expect(out.gitPlanStats?.fpHits).toBe(0);
    return out;
  };

  expect((await expectSpawn(baseState, new Set([rel]))).captured).toContain(rel);
  expect((await expectSpawn({ ...baseState, gitNeedsResolution: { [rel]: liveIdentityKey } })).carried).toContain(rel);
  expect((await expectSpawn({ ...baseState, lastSyncedManifest: { ...baseState.lastSyncedManifest, gitRepos: undefined }, gitReposRemoved: { [rel]: liveIdentityKey } })).gitRepos).toBeUndefined();
  expect((await expectSpawn({ ...baseState, lastSyncedManifest: { ...baseState.lastSyncedManifest, gitRepos: undefined } })).captured).toContain(rel);

  await refreshTrusted();
  const pending = await plan({ ...baseState, gitPendingRemote: { [rel]: baseSec } });
  expect(pending.gitPlanStats?.fpHits).toBe(0);
  expect(pending.gitPlanStats?.spawnedRepos).toBe(0);
  expect(pending.gitRepos?.[rel]).toEqual(baseSec);

  await fs.writeFile(path.join(rootA, ".rboxignore"), `${rel}/\n`);
  try {
    await refreshTrusted();
    const ignored = await plan(baseState, new Set(), buildIgnoreMatcher(rootA));
    expect(ignored.gitPlanStats?.fpHits).toBe(0);
    expect(ignored.gitPlanStats?.spawnedRepos).toBe(0);
    expect(ignored.gitRepos?.[rel]).toEqual(baseSec);
  } finally {
    await fs.rm(path.join(rootA, ".rboxignore"), { force: true });
  }

  await fs.writeFile(path.join(repo, ".git", "index.lock"), "");
  try {
    const busy = await expectSpawn();
    expect(busy.deferred.some((d) => d.relPath === rel && d.reason.includes("git busy"))).toBe(true);
  } finally {
    await fs.rm(path.join(repo, ".git", "index.lock"), { force: true });
  }

  const head = await git(repo, "rev-parse", "HEAD");
  await fs.writeFile(path.join(repo, ".git", "shallow"), `${head}\n`);
  try {
    const structural = await expectSpawn();
    expect(structural.removed).toContain(rel);
  } finally {
    await fs.rm(path.join(repo, ".git", "shallow"), { force: true });
  }

  await refreshTrusted();
  let cache = await readDivergenceCache(rootA);
  cache.repos![rel]!.probe.preflightKind = "bogus";
  await writeDivergenceCache(rootA, cache);
  let invalidKind = await plan(baseState);
  expect(invalidKind.gitPlanStats?.fpMisses).toBe(1);
  expect(invalidKind.gitPlanStats?.spawnedRepos).toBe(1);

  await refreshTrusted();
  cache = await readDivergenceCache(rootA);
  cache.repos![rel]!.probe.identityKey = "different";
  cache.repos![rel]!.identityKey = "different";
  await writeDivergenceCache(rootA, cache);
  const nonCarry = await plan(baseState);
  expect(nonCarry.gitPlanStats?.fpMisses).toBe(1);
  expect(nonCarry.gitPlanStats?.spawnedRepos).toBe(1);
}, 40_000);

test("design 83: plan cache misses changed git state and keeps other repos on the fast path", async () => {
  for (const rel of ["d83-a", "d83-b"]) {
    const repo = path.join(rootA, rel);
    await initRepo(repo);
    await commitFile(repo, "f.txt", rel, "c1");
  }
  await push(rootA, cfgA, depsA);

  const expectOneRepoMiss = async (mutate: () => Promise<void>, expectCapture: boolean) => {
    await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
    await markDivergenceCacheTrusted(rootA);
    await mutate();
    const planned = await observeGitSpawns(async () => planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA)));
    expect(planned.value.gitPlanStats?.fpHits).toBe(1);
    expect(planned.value.gitPlanStats?.spawnedRepos).toBe(1);
    if (expectCapture) expect(planned.value.captured).toEqual(["d83-a"]);
    else expect(planned.value.carried).toContain("d83-a");
    expect(planned.spawns).toBeGreaterThan(0);
  };

  await expectOneRepoMiss(() => commitFile(path.join(rootA, "d83-a"), "commit.txt", "changed", "changed"), true);
  await push(rootA, cfgA, depsA);

  await expectOneRepoMiss(async () => {
    await fs.writeFile(path.join(rootA, "d83-a", "staged.txt"), "staged");
    await git(path.join(rootA, "d83-a"), "add", "staged.txt");
  }, true);
  await push(rootA, cfgA, depsA);

  await expectOneRepoMiss(async () => {
    await git(path.join(rootA, "d83-a"), "tag", "d83-tag");
  }, true);
  await push(rootA, cfgA, depsA);

  await expectOneRepoMiss(async () => {
    await git(path.join(rootA, "d83-a"), "checkout", "-qb", "d83-topic");
  }, true);
  await push(rootA, cfgA, depsA);

  await expectOneRepoMiss(async () => {
    await git(path.join(rootA, "d83-a"), "pack-refs", "--all", "--prune");
  }, false);
}, 30_000);

test("design 83: plan cache invalidates paused rebase op-state instead of fast-carrying", async () => {
  const rel = "d83-rebase-plan";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);

  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), matcher);
  await markDivergenceCacheTrusted(rootA);
  expect((await observeGitSpawns(async () => planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), matcher))).spawns).toBe(0);

  await git(repo, "checkout", "-qb", "side");
  await commitFile(repo, "f.txt", "side", "side c1");
  await git(repo, "checkout", "-q", "main");
  await commitFile(repo, "f.txt", "main", "main c2");
  await git(repo, "checkout", "-q", "side");
  await expect(git(repo, "rebase", "main")).rejects.toThrow();

  const planned = await observeGitSpawns(async () => planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), matcher));
  expect(planned.value.gitPlanStats?.fpHits).toBe(0);
  expect(planned.value.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(planned.value.carried).not.toContain(rel);
  expect(planned.value.captured.includes(rel) || planned.value.deferred.some((d) => d.relPath === rel)).toBe(true);
  expect(planned.spawns).toBeGreaterThan(0);
}, 30_000);

test("design 83/93: status and plan writers leave one loadable bounds-versioned cache", async () => {
  const repo = path.join(rootA, "d83-cross-writer");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  await fs.rm(divergenceCachePath(rootA), { force: true });

  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), buildIgnoreMatcher(rootA))).toBe(0);
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  let cache = await readDivergenceCache(rootA);
  expect(cache.version).toBe(GIT_FINGERPRINT_VERSION);
  expect(typeof cache.repos?.["d83-cross-writer"]?.writtenAtMs).toBe("number");
  expect(typeof cache.repos?.["d83-cross-writer"]?.probe?.identityKey).toBe("string");

  await fs.rm(divergenceCachePath(rootA), { force: true });
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), buildIgnoreMatcher(rootA))).toBe(0);
  cache = await readDivergenceCache(rootA);
  expect(cache.version).toBe(GIT_FINGERPRINT_VERSION);
  expect(typeof cache.repos?.["d83-cross-writer"]?.writtenAtMs).toBe("number");
  expect(typeof cache.repos?.["d83-cross-writer"]?.probe?.identityKey).toBe("string");
}, 30_000);

// ── gitcap progress (the long silent phase on a repo-heavy first push) ───────────

test("push emits gitcap progress per CAPTURED repo — monotonic settle count, repo names as detail, capture-scoped total", async () => {
  const alpha = path.join(rootA, "alpha");
  await initRepo(alpha);
  await commitFile(alpha, "a.txt", "a", "c1");
  const beta = path.join(rootA, "sub", "beta");
  await initRepo(beta);
  await commitFile(beta, "b.txt", "b", "c1");

  type Ev = { done: number; total: number; detail?: string; bytesDone?: number; bytesTotal?: number };
  const cap = (): { events: Ev[]; deps: SyncDeps } => {
    const events: Ev[] = [];
    return {
      events,
      deps: {
        ...depsA,
        onProgress: (done, total, phase, detail, bytes) =>
          phase === "gitcap" && events.push({ done, total, detail, bytesDone: bytes?.bytesDone, bytesTotal: bytes?.bytesTotal }),
      },
    };
  };

  const first = cap();
  await push(rootA, cfgA, first.deps);
  expect(first.events.length).toBeGreaterThanOrEqual(2);
  // Total is the CAPTURE set, not every discovered repo, and stays fixed across the run.
  expect(first.events.every((e) => e.total === 2)).toBe(true);
  // `done` is a monotonic completed-count under bounded concurrency, and byte ticks
  // can arrive before the repo count advances.
  expect(Math.max(...first.events.map((e) => e.done))).toBe(2);
  expect(first.events.some((e) => e.bytesDone !== undefined && e.bytesDone > 0 && e.bytesTotal === undefined)).toBe(true);
  // Detail is the repo basename (a nested repo shows its own name, not the path).
  expect(new Set(first.events.map((e) => e.detail))).toEqual(new Set(["alpha", "beta"]));

  // A second push with nothing changed CARRIES both repos (no capture) → zero gitcap
  // events. Proves the denominator is capture-scoped, not repo-count-scoped.
  const second = cap();
  await push(rootA, cfgA, second.deps);
  expect(second.events.length).toBe(0);
});
