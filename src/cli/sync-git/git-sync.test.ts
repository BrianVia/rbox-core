import { gitSectionDeviceId } from "../../engine/index.js";
import * as followerProtocol from "./follower-protocol.js";
import { commitProtocolRefTransaction, prepareBasePresentArtifact } from "./base-artifacts.js";
import { artifactBinding, readRepoIdentityV1, readStateLineageV1 } from "./repo-lineage.js";
import { pRepairQRef } from "./p-repair.js";
import { otherWorkspaceClaimsRepoByRegistry } from "./plan.js";
import codecInternals from "../folder-config-codec.js";
import { forgetStandingArtifactRefusalsForTests } from "./branch-deletion-witness.js";
import { test as bunTest, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pull, push, pushManifest, scanManifestForPush, sync, type SyncDeps } from "../sync.js";
import { loadState, repoRecordsForState, saveStateUnsafeLegacyOrTest, syncStreamId, type RepoRecord, type SyncState, type WorkspaceConfig } from "../config.js";
import { gitResolveCmd } from "../git/resolve-command.js";
import { changedSidecarRepoKeys, orderedDeferralUpdates, type GitDeferralUpdates, type OrderedGitDeferralUpdates } from "../sync-state.js";
import { BlobShaMismatchError, type CommitOptions, type CommitResult, type SyncRemote } from "../remote.js";
import { buildIgnoreMatcher, MAX_PACK_CHAIN, scanManifest, type BlobStore, type FileEntry, type GitSection, type Manifest } from "../../engine/index.js";
import { captureGitState } from "./capture.js";
import { checkoutJournalDir } from "./journal.js";
import { gitIdentity, gitIdentityKey } from "./identity.js";
import { gitPreflight } from "./preflight.js";
import { gitSectionBlobRefs, gitSectionNewestLink, repoCtx } from "./git-state.js";
import { setGitSpawnObserver } from "../../engine/git-spawn.js";
import {
  MAX_GIT_CONFIG_KEYS,
  MAX_GIT_CONFIG_KEY_BYTES,
  MAX_GIT_CONFIG_SERIALIZED_BYTES,
  MAX_GIT_CONFIG_VALUE_BYTES,
} from "./config-sync.js";
import {
  applyGitSections,
  GIT_FINGERPRINT_VERSION,
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  gitDivergenceCount,
  gitDivergenceStatus,
  gitDivergenceFastRepoSource,
  gitFingerprintVersionForBounds,
  gitIncomingKey,
  formatGitPlanStats,
  formatGitPushLine,
  nextDeferral,
  planGitSections,
  withRevalidatedGitPartialApplies,
  type GitPushPlan,
} from "../sync-git.js";
import { loadGitDivergenceCache, type GitDivergenceCacheEntry } from "./divergence-cache.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { ShutdownMutationGate } from "../../engine/mutation-gate.js";
import { stateCasJournalDir } from "./state-cas-locks.js";
import { keepPinRef, readKeepPinOrigins } from "./keep-pins.js";

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

const sidecarSnapshot = (record: RepoRecord): string => JSON.stringify({
  pending: record.pending,
  partial: record.partial,
  attempt: record.attempt,
  deferrals: record.deferrals,
  resolutionReceipt: record.resolutionReceipt,
});

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
  /** Design 226: corrupt the ciphertext on disk while rejecting it, so the retry's local
   *  re-verification of the RETAINED bytes must fail closed instead of re-sending. */
  corruptSourceOnShaMismatch = false;
  gitPutCalls = 0;
  gitPutUploads: Array<{ sha: string; src: string; size: number; uploadsDir?: string }> = [];
  conflictNext = false;
  conflictManifestNext?: Manifest;
  lostAckAsConflictNext = false;
  loseAckThrowNext = false;
  independentIdenticalConflictNext = false;
  beforeForcedConflict?: () => Promise<void>;

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
  publishIndependent(manifest: Manifest): number {
    this.head += 1;
    this.log.set(this.head, manifest);
    return this.head;
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
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    await options?.beforeCommitSend?.();
    this.commitCalls += 1;
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    if (this.conflictNext) {
      this.conflictNext = false;
      this.head += 1;
      this.log.set(this.head, this.conflictManifestNext ?? this.log.get(this.head - 1) ?? { generatedAt: "", files: [] });
      this.conflictManifestNext = undefined;
      await this.beforeForcedConflict?.();
      return { conflict: true, head: this.head };
    }
    if (this.independentIdenticalConflictNext) {
      this.independentIdenticalConflictNext = false;
      this.head += 1;
      this.log.set(this.head, manifest);
      return { conflict: true, head: this.head };
    }
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
    if (this.loseAckThrowNext) {
      this.loseAckThrowNext = false;
      throw new Error("lost accepted response");
    }
    if (this.lostAckAsConflictNext) {
      this.lostAckAsConflictNext = false;
      return { conflict: true, head: this.head };
    }
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
          if (self.corruptSourceOnShaMismatch) await fs.appendFile(src, "corrupt");
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
  delete process.env.RBOX_GIT_PLAN_LAZY;
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
  for (const [root, cfg] of [[rootA, cfgA], [rootB, cfgB]] as const) {
    await saveStateUnsafeLegacyOrTest(root, {
      stream: syncStreamId(cfg), stateNonce: "a".repeat(32), stateRevision: 0,
      lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
    });
  }
  logsA = [];
  logsB = [];
  depsA = { remote, backoff: noBackoff, onGitLog: (l) => logsA.push(l) };
  depsB = { remote, backoff: noBackoff, onGitLog: (l) => logsB.push(l) };
});
afterEach(async () => {
  delete process.env.RBOX_GIT_PLAN_LAZY;
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
/** Design 226: every ciphertext still retained under the workspace's gitcap scratch root.
 *  Empty after any `planGitSections` exit — the single `finally` sweep is the only
 *  reclamation, so a non-empty result is a leak, not a timing artifact. */
async function retainedGitCiphertext(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(abs);
      else if (entry.name.endsWith(".ct")) found.push(abs);
    }
  };
  await walk(path.join(root, ".rbox", "gitcap"));
  return found.sort();
}

/** Design 226 §0: count every WRITE the plan makes to the workspace BlobStore, so a
 *  capture that is decided AGAINST can be asserted to cost exactly zero bytes. */
function countingGitRemote(base: SyncRemote) {
  const inner = base.blobStore();
  let writes = 0;
  const store: BlobStore = {
    has: (sha) => inner.has(sha),
    get: (sha) => inner.get(sha),
    getToFile: (sha, dest, size) => inner.getToFile!(sha, dest, size),
    async put(sha, bytes) {
      writes += 1;
      await inner.put(sha, bytes);
    },
    async putFile(sha, src, size, uploadsDir, onBytes) {
      writes += 1;
      await inner.putFile!(sha, src, size, uploadsDir, onBytes);
    },
  };
  const api = new Proxy(base, {
    get(target, prop) {
      if (prop === "blobStore") return () => store;
      const value = Reflect.get(target, prop, target);
      return value instanceof Function ? value.bind(target) : value;
    },
  });
  return { api, writes: () => writes };
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

async function readDivergenceCache(root: string): Promise<{ version?: number; repos?: Record<string, GitDivergenceCacheEntry> }> {
  return JSON.parse(await fs.readFile(divergenceCachePath(root), "utf8")) as { version?: number; repos?: Record<string, GitDivergenceCacheEntry> };
}

async function writeDivergenceCache(root: string, cache: { version?: number; repos?: Record<string, GitDivergenceCacheEntry> }): Promise<void> {
  await fs.mkdir(path.dirname(divergenceCachePath(root)), { recursive: true });
  await fs.writeFile(divergenceCachePath(root), JSON.stringify(cache));
}

async function markDivergenceCacheTrusted(root: string): Promise<void> {
  const cache = await readDivergenceCache(root);
  const trustedWrittenAt = Date.now() + GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS + 5_000;
  for (const entry of Object.values(cache.repos ?? {})) {
    if (entry) entry.writtenAtMs = trustedWrittenAt;
  }
  await writeDivergenceCache(root, cache);
}

function gitPlanSurface(plan: GitPushPlan): Omit<GitPushPlan, "gitPlanStats"> {
  const { gitPlanStats: _gitPlanStats, ...surface } = plan;
  return surface;
}

function deferred<T = void>() {
  return Promise.withResolvers<T>();
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
    repoRecords: { r: { repoGen: 1, sourceSeq: 1 } },
  };
  // Design 279: the CAS re-proves what THIS pull authored, so the marker under
  // test is the pull's own transition rather than a carried record.
  const outcome = {
    partial: {
      r: {
        incomingKey: "incoming",
        checkoutPending: false,
        appliedRefs: { "refs/heads/side": { kind: "direct" as const, oid: recorded } },
        heldRefs: { "refs/heads/held": "ownership" as const },
        configApplied: true,
      },
    },
  };
  const gate = new ShutdownMutationGate();
  let saveRan = false;
  let drainSettled = false;
  let drain: Promise<void> | undefined;
  await withRevalidatedGitPartialApplies(rootA, state, outcome, async () => {
    saveRan = true;
    expect(gate.closed).toBe(true);
    expect(drainSettled).toBe(false);
    await expect(git(repo, "update-ref", "refs/heads/side", recorded)).rejects.toThrow();
  }, {
    mutationBoundary: gate,
    afterFirstStateCasLockAcquired: async () => {
      gate.close();
      drain = gate.drain().then(() => { drainSettled = true; });
      await Promise.resolve();
      expect(drainSettled).toBe(false);
    },
  });
  await drain;
  expect(saveRan).toBe(true);
  expect(drainSettled).toBe(true);
  expect(outcome).toEqual({ partial: { r: null } });
  expect(await git(repo, "rev-parse", "side")).toBe(human);
  expect(await fs.readdir(stateCasJournalDir(rootA)).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error))).toEqual([]);
});

/** DESIGN 226 — RE-EXPRESSED, and an INTENTIONAL INVERSION of the first leg. This test's
 *  upload fault used to be a CAPTURE fault: the repo deferred with reason "artifact", the
 *  lane was saved durably, and the push then failed at an injected `commit`. Under the
 *  design-226 flush barrier the same fault rejects `planGitSections` itself, so no
 *  capture deferral exists to observe or age and no observation write happens at all —
 *  "one repo's upload fault fails the whole push" (§0, §2.2). If this is failing, do NOT
 *  make it green by reinstating a per-repo `catch { revertCapture }` around the flush;
 *  §2.2 rules that unsound for any repo past `commitAbsentBranchVerification` /
 *  `pinDisplaced`. The test's real subject — D2 sidecar exactness while a pending is
 *  outstanding — survives below, driven from the RECOVERED state, and the rejection being
 *  recoverable is exactly what the middle leg proves. */
test("a barrier-rejected push records nothing and recovers; D2 stays exact while pending is outstanding", async () => {
  const repo = path.join(rootA, "capture-restart");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "v1", "v1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await commitFile(repo, "f.txt", "v2", "v2");
  await fs.writeFile(path.join(rootA, "force-commit.txt"), "x");

  // Barrier leg: the artifact upload fault fails the WHOLE push and writes nothing.
  let deferralSaves = 0;
  depsA.onGitDeferralsSaved = () => { deferralSaves += 1; };
  remote.failNextGitPut = true;
  const seqBefore = remote.headSeq();
  await expect(push(rootA, cfgA, depsA)).rejects.toThrow(/simulated mid-capture churn/);
  expect(remote.headSeq()).toBe(seqBefore); // nothing published
  expect((await remote.latest()).manifest.files.some((f) => f.path === "force-commit.txt")).toBe(false);
  expect(deferralSaves).toBe(0); // the plan rejected before any deferral observation could be written
  expect(repoRecordsForState(await st(rootA))["capture-restart"]?.deferrals?.capture).toBeUndefined();
  expect(await retainedGitCiphertext(rootA)).toEqual([]); // the finally sweep still ran
  delete depsA.onGitDeferralsSaved;

  // Recoverable: `failNextGitPut` self-cleared, so the next push publishes both planes.
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBeGreaterThan(seqBefore);
  const healed = (await remote.latest()).manifest;
  expect(healed.files.some((f) => f.path === "force-commit.txt")).toBe(true);
  expect(healed.gitRepos!["capture-restart"]!.refs["refs/heads/main"]).toBe(await git(repo, "rev-parse", "refs/heads/main"));

  // D2 exactness while a pending is outstanding: B advances the repo, A is mid-operation
  // so the apply lane defers, and every P-bound sidecar stays byte-exact across a push.
  await pull(rootB, cfgB, depsB);
  const repoB = path.join(rootB, "capture-restart");
  await commitFile(repoB, "remote.txt", "newer", "newer remote truth");
  await push(rootB, cfgB, depsB);
  const busyLock = path.join(repo, ".git", "index.lock");
  await fs.writeFile(busyLock, "");
  await pull(rootA, cfgA, depsA);
  let record = repoRecordsForState(await st(rootA))["capture-restart"]!;
  expect(record.deferrals?.apply?.reason).toBe("git-busy");
  const since = record.deferrals?.apply?.deferredSince;
  expect(since).toBeDefined();
  const heldSidecars = sidecarSnapshot(record);

  await fs.rm(busyLock);
  await push(rootA, cfgA, depsA);
  record = repoRecordsForState(await st(rootA))["capture-restart"]!;
  expect(sidecarSnapshot(record)).toBe(heldSidecars);
  expect(record.deferrals?.apply?.deferredSince).toBe(since);
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
  const betaStartedBeforeAlphaFinished = await resolvesWithin(betaStarted.promise, 10_000);
  releaseAlpha.resolve();
  await outcome;

  expect(betaStartedBeforeAlphaFinished).toBe(true);
  expect(logsB.filter((l) => l.startsWith("git-sync applied ")).sort()).toEqual(["git-sync applied alpha", "git-sync applied beta"]);
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
  await saveStateUnsafeLegacyOrTest(rootA, {
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
  await saveStateUnsafeLegacyOrTest(rootA, {
    ...sA,
    lastSyncedManifest: { ...sA.lastSyncedManifest, gitRepos: { ...sA.lastSyncedManifest.gitRepos, rByte: { ...byteBase, bundleCipherSize: 1 } } },
  });
  await commitFile(rByte, "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["rByte"]!.packChain).toBeUndefined();
}, 120_000);

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
  await saveStateUnsafeLegacyOrTest(rootA, {
    ...sA,
    lastSyncedManifest: { ...sA.lastSyncedManifest, manifestSchema: 3, gitRepos: { r: { ...chained, packChain: maxLinks } } },
  });
  await commitFile(r, "f.txt", "v3", "c3");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.packChain).toBeUndefined();

  await pull(rootB, cfgB, depsB);
  expect((await st(rootB)).gitPendingRemote?.["r"]).toBeUndefined();
  expect(await git(path.join(rootB, "r"), "rev-parse", "main")).toBe(await git(r, "rev-parse", "main"));
}, 120_000);

test("design 53: fresh join fetch/import work is bounded by repos times MAX_PACK_CHAIN", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  for (const rel of ["ra", "rb", "rc"]) {
    const r = path.join(rootA, rel);
    await initRepo(r);
    await commitBinaryHistory(r, "base", 1);
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
}, 120_000);

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
}, 120_000);

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
  await saveStateUnsafeLegacyOrTest(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection! } } });

  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["main", "wt"]); // wt CARRIED alongside the captured main clone
  expect(m.gitRepos!["wt"]!.bundleEncSha).toBe(wtSection!.bundleEncSha); // carried UNCHANGED — never re-captured
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined(); // M4: base-carry, never a removal-memory stamp
  expect(logsA.some((l) => l.includes("skipped") && l.includes("wt"))).toBe(true);

  // The explicit JSON fixture has a capable publisher binding, so the first
  // ACK settles the new main section without a follow-up convergence commit.
  const head = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(head);
  expect(repoRecordsForState(await st(rootA)).main?.pending).toBeUndefined();
  const converged = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(converged);
  await pull(rootB, cfgB, depsB);
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined();
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();
}, 20_000);

test("design 68 §3.3 + 422: a forced skip-eligible pointer recaptures instead of carrying a missing base blob", async () => {
  const { W } = await makeInTreeMainWithWorktree();

  const wtSection = await captureGitState(W, remote.blobStore(), KEK);
  expect(wtSection!.refScope).toBe("scoped");
  const s0 = await st(rootA);
  await saveStateUnsafeLegacyOrTest(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection! } } });

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

// ── (b) churn: one repo's artifact upload fault fails the whole push (226 barrier) ────

/** DESIGN 226 — INTENTIONAL INVERSION. This test used to assert the PRE-226 outcome: the
 *  per-repo `catch` at the capture site deferred r2 with base carry while the push still
 *  committed the stable file subset and r1's carry. Under the design-226 flush barrier one
 *  repo's upload fault rejects `planGitSections`, so the whole push fails and NOTHING is
 *  published — that is §0's accepted blast-radius regression, taken because the
 *  alternative is publishing a section whose bytes are missing. If this is failing, do NOT
 *  make it green by reinstating a per-repo `catch { revertCapture }` around the flush;
 *  §2.2 rules that unsound for any repo past `commitAbsentBranchVerification` /
 *  `pinDisplaced`, and that set is not statically known at the flush point. The rejection
 *  is RECOVERABLE, which is the leg that matters and is asserted last. */
test("one repo's artifact upload fault fails the WHOLE push (226 barrier), and the next push recovers", async () => {
  const r1 = path.join(rootA, "r1");
  const r2 = path.join(rootA, "r2");
  await initRepo(r1);
  await commitFile(r1, "a.txt", "a1", "c1");
  await initRepo(r2);
  await commitFile(r2, "b.txt", "b1", "c1");
  await push(rootA, cfgA, depsA);
  const base1 = (await st(rootA)).lastSyncedManifest.gitRepos!["r1"]!;
  const base2 = (await st(rootA)).lastSyncedManifest.gitRepos!["r2"]!;

  // ONLY r2 changes (so the failing PUT deterministically hits r2's artifacts) plus an
  // unrelated file change the push would otherwise have committed.
  await commitFile(r2, "b.txt", "b2", "c2");
  await fs.writeFile(path.join(rootA, "note.txt"), "stable");
  remote.failNextGitPut = true;

  const seqBefore = remote.headSeq();
  await expect(push(rootA, cfgA, depsA)).rejects.toThrow(/simulated mid-capture churn/);
  expect(remote.headSeq()).toBe(seqBefore); // nothing published at all
  const held = (await remote.latest()).manifest;
  expect(held.files.some((f) => f.path === "note.txt")).toBe(false); // the stable subset did NOT ride along
  expect(held.gitRepos!["r2"]!.bundleEncSha).toBe(base2.bundleEncSha); // no section regressed either
  expect(held.gitRepos!["r1"]!.bundleEncSha).toBe(base1.bundleEncSha);
  expect(await retainedGitCiphertext(rootA)).toEqual([]); // the finally sweep still ran

  // Recoverable: the next push (nothing failing) publishes r2's fresh capture AND the file.
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBeGreaterThan(seqBefore);
  const healed = (await remote.latest()).manifest;
  expect(healed.files.some((f) => f.path === "note.txt")).toBe(true);
  expect(healed.gitRepos!["r2"]!.bundleEncSha).not.toBe(base2.bundleEncSha);
  expect(healed.gitRepos!["r1"]!.bundleEncSha).toBe(base1.bundleEncSha);
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
  expect(remote.gitPutUploads[0]!.sha).toBe(remote.gitPutUploads[1]!.sha); // same encSha
  // DESIGN 226 — DELIBERATE INVERSION of `not.toBe`. The staged plaintext is gone by the
  // flush, so the retry cannot re-encrypt; it re-sends the SAME retained ciphertext after
  // verifying locally that it still hashes to its encSha (and fails closed otherwise).
  expect(remote.gitPutUploads[0]!.src).toBe(remote.gitPutUploads[1]!.src);
  const scratch = `${path.join(rootA, ".rbox", "gitcap")}${path.sep}`;
  expect(remote.gitPutUploads[0]!.src.startsWith(scratch)).toBe(true);
  expect(remote.gitPutUploads[1]!.src.startsWith(scratch)).toBe(true);
  expect(new Set(remote.gitPutUploads.map((u) => u.uploadsDir))).toEqual(new Set([path.join(rootA, ".rbox", "state", "uploads")]));
}, 90_000);

/** DESIGN 226 — INTENTIONAL INVERSION. This test used to assert the PRE-226 outcome: an
 *  exhausted sha-mismatch budget deferred THAT repo with base carry while the push still
 *  committed the stable file subset. Under the design-226 flush barrier an exhausted PUT
 *  rejects `planGitSections` and the whole push fails, because by the flush point repos
 *  past `commitAbsentBranchVerification`/`pinDisplaced` have done irreversible work that
 *  `revertCapture` cannot undo. If this test is failing, do NOT make it green by
 *  reinstating a per-repo `catch { revertCapture }` around the flush — design 226 §2.2
 *  rules that unsound. The retry BUDGET is unchanged and still asserted here; recovery is
 *  covered by "the barrier's rejection is recoverable" below. */
test("git artifact sha_mismatch retries are bounded; final failure fails the push (226 barrier)", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const seqBefore = remote.headSeq();
  remote.gitPutCalls = 0;
  remote.gitPutUploads = [];

  await commitFile(r, "f.txt", "v2", "c2");
  await fs.writeFile(path.join(rootA, "note.txt"), "stable");
  const backoffAttempts: number[] = [];
  remote.gitShaMismatchFailures = 99;

  await expect(push(rootA, cfgA, { ...depsA, backoff: async (attempt) => backoffAttempts.push(attempt) }))
    .rejects.toThrow(/blob PUT rejected/);

  expect(remote.gitPutCalls).toBe(3); // PER_FILE_UPLOAD_ATTEMPTS parity, unchanged
  expect(backoffAttempts).toEqual([0, 1]); // retry budget unchanged
  expect(remote.headSeq()).toBe(seqBefore); // nothing published at all
  expect((await remote.latest()).manifest.files.some((f) => f.path === "note.txt")).toBe(false);
  expect(await retainedGitCiphertext(rootA)).toEqual([]); // the finally sweep still ran

  // Recoverable: the next push (nothing failing) publishes the repo and the stable file.
  remote.gitShaMismatchFailures = 0;
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBeGreaterThan(seqBefore);
  const healed = (await remote.latest()).manifest;
  expect(healed.files.some((f) => f.path === "note.txt")).toBe(true);
  expect(healed.gitRepos!["r"]!.refs["refs/heads/main"]).toBe(await git(r, "rev-parse", "refs/heads/main"));
}, 20_000);

test("design 226: a retained ciphertext corrupted on disk fails CLOSED instead of re-sending", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "v1", "c1");
  remote.gitShaMismatchFailures = 1;
  remote.corruptSourceOnShaMismatch = true;

  await expect(push(rootA, cfgA, { ...depsA, backoff: noBackoff }))
    .rejects.toThrow(/retained git artifact ciphertext no longer matches/);
  expect(remote.gitPutCalls).toBe(1); // no second send of bytes we cannot vouch for
  expect(await retainedGitCiphertext(rootA)).toEqual([]);
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
  const reports: string[][] = [];
  await push(rootA, cfgA, { ...depsA, onGitBusyDeferred: (repos) => reports.push([...repos]) });
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(base.bundleEncSha); // base carried
  expect(logsA.some((l) => l.includes("r: git busy"))).toBe(true);
  expect(reports).toEqual([["r"]]);

  await fs.rm(path.join(r, ".git", "index.lock"));
  const quietReports: string[][] = [];
  await push(rootA, cfgA, { ...depsA, onGitBusyDeferred: (repos) => quietReports.push([...repos]) }); // quiesced → captures v2
  expect(quietReports).toEqual([[]]);
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

// Design 273 P2 amended the "without repo deferral" half: the hold now KEEPS a
// `worktree-ownership` record so every local surface can see it. It is still
// never escalated and never handed a resolve command (the `ownership-hold`
// class owns that), and it still clears the moment the apply completes.
test("design 200 P2: linked-worktree partial apply stays pending with a visible ownership hold, then completes after removal", async () => {
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
  expect(record.deferrals?.apply?.reason).toBe("worktree-ownership");
  const holdSince = record.deferrals!.apply!.deferredSince;
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
  // ONE record across pulls: the age is the hold's real age, not a fresh stamp.
  expect(record.deferrals?.apply?.reason).toBe("worktree-ownership");
  expect(record.deferrals?.apply?.deferredSince).toBe(holdSince);
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

async function prepareSupersedingPending(rel: string): Promise<{
  a: string;
  b: string;
  sidecars: string;
}> {
  const { a, b, lock } = await makePending(rel);
  await fs.rm(lock);
  const state = await st(rootB);
  const record = state.repoRecords![rel]!;
  const pending = record.pending!;
  record.partial = {
    incomingKey: gitIncomingKey(pending), checkoutPending: true,
    appliedRefs: {}, heldRefs: {}, configApplied: true,
  };
  record.attempt = {
    incomingKey: gitIncomingKey(pending), localFingerprint: "pre-ack", fingerprintVersion: GIT_FINGERPRINT_VERSION,
    effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
    incomingIndexArtifactDescriptor: "null",
    reflogs: [], blockers: [{ provenance: "checkout", reason: "local-commits" }],
    repoIdentity: "pre-ack", stateNonce: state.stateNonce!, baseOriginsHash: "pre-ack",
    partialDisposition: "pre-ack", at: "2026-07-21T00:00:00.000Z",
  };
  await saveStateUnsafeLegacyOrTest(rootB, state);
  await git(b, "fetch", a, "refs/heads/main:refs/remotes/rbox-test/main");
  await git(b, "reset", "--hard", "refs/remotes/rbox-test/main");
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  await git(b, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "ahead pending");
  const exact = repoRecordsForState(await st(rootB))[rel]!;
  return {
    a,
    b,
    sidecars: sidecarSnapshot(exact),
  };
}

test("design 177: forced recapture recovery refusal is typed and carries protected pending verbatim", async () => {
  const rel = "keep-mine-forced-recovery";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  const state = await st(rootB);
  const pending = repoRecordsForState(state)[rel]!.pending!;
  await fs.mkdir(checkoutJournalDir(rootB, rel), { recursive: true });

  const plan = await planGitSections(
    rootB,
    cfgB,
    state,
    remote,
    new Set([rel]),
    buildIgnoreMatcher(rootB),
    undefined,
    noBackoff,
    {
      onGitLog: () => {},
      resolution: {
        repo: rel,
        verb: "keep-mine",
        confirmedReport: preview.discardReport,
        authorizedLanes: preview.discardReport.lanes
          .filter((lane: { disposition: string }) => lane.disposition === "not-subsumed")
          .map((lane: { lane: string }) => lane.lane)
          .sort(),
        forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
      },
    },
  );

  expect(plan.resolution).toMatchObject({
    outcome: "refused",
    reason: "checkout journal must be recovered before keep-mine can publish",
  });
  expect(plan.gitRepos?.[rel]).toEqual(pending);
  expect(plan.carried).toContain(rel);
  expect(plan.protectedPending).toContain(rel);
}, 90_000);

test("design 174 B: upload, commit-error, and multi-writer 409 preserve every P-bound sidecar pre-ACK", async () => {
  const rel = "supersede-failures";
  const { sidecars } = await prepareSupersedingPending(rel);
  const assertExact = async () => {
    const record = repoRecordsForState(await st(rootB))[rel]!;
    expect(sidecarSnapshot(record)).toBe(sidecars);
  };

  // DESIGN 226 — INTENTIONAL INVERSION of this leg only. Pre-226 the candidate capture's
  // upload fault deferred that repo and the push still committed the unrelated file. Under
  // the design-226 flush barrier the fault rejects `planGitSections` and the whole push
  // fails; the sidecar-exactness subject is unchanged and asserted on BOTH sides of the
  // rejection. Do NOT make this green by reinstating a per-repo `catch { revertCapture }`
  // around the flush — §2.2 rules that unsound. The commit-error and multi-writer-409 legs
  // below are untouched by 226, and the recovery leg is asserted after them: a push that
  // SUCCEEDS here supersedes P and clears its sidecars, which is the very thing the two
  // remaining legs need outstanding. So recovery is proved on the 409 leg's own push.
  remote.failNextGitPut = true;
  await fs.writeFile(path.join(rootB, "capture-failure.txt"), "one");
  const seqBefore = remote.headSeq();
  await expect(push(rootB, cfgB, depsB)).rejects.toThrow(/simulated mid-capture churn/);
  expect(remote.headSeq()).toBe(seqBefore); // nothing published
  expect((await remote.latest()).manifest.files.some((f) => f.path === "capture-failure.txt")).toBe(false);
  expect(await retainedGitCiphertext(rootB)).toEqual([]); // the finally sweep still ran
  await assertExact();

  const realCommit = remote.commit.bind(remote);
  remote.commit = async () => { throw new Error("candidate commit transport failed"); };
  await fs.writeFile(path.join(rootB, "commit-failure.txt"), "two");
  await expect(push(rootB, cfgB, depsB)).rejects.toThrow(/candidate commit transport failed/);
  await assertExact();
  remote.commit = realCommit;

  let atConflict: string | undefined;
  remote.conflictNext = true;
  remote.beforeForcedConflict = async () => {
    const record = repoRecordsForState(await st(rootB))[rel]!;
    atConflict = sidecarSnapshot(record);
  };
  await push(rootB, cfgB, depsB);
  expect(atConflict).toBe(sidecars);

  // DESIGN 226 — the barrier's rejection is RECOVERABLE, not a wedge. This push is the
  // first one allowed to succeed, and it lands BOTH files the two failed pushes blocked.
  expect(remote.headSeq()).toBeGreaterThan(seqBefore);
  const healed = (await remote.latest()).manifest;
  expect(healed.files.some((f) => f.path === "capture-failure.txt")).toBe(true);
  expect(healed.files.some((f) => f.path === "commit-failure.txt")).toBe(true);
  expect(await retainedGitCiphertext(rootB)).toEqual([]);
}, 90_000);

test("design 174 B: real pending is superseded by an ahead main with exact off-branch stash and ACK clears four sidecars", async () => {
  const rel = "supersede-e2e";
  const a = path.join(rootA, rel);
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await git(a, "branch", "prior");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, rel);
  const priorRef = "refs/heads/prior";
  expect(repoRecordsForState(await st(rootB))[rel]?.branchBaseOrigins?.[priorRef]).toBeDefined();

  // The pending writer carries a stash whose parent is deliberately off main,
  // and omits a previously advertised branch. B remains a real pull transition:
  // receiver quiescence, not hand-authored state, creates P.
  await git(a, "switch", "-qc", "stash-side");
  await fs.writeFile(path.join(a, "stash.txt"), "off-side stash\n");
  await git(a, "add", "stash.txt");
  await git(a, "stash", "push", "-qm", "rbox off-side stash");
  await git(a, "switch", "-q", "main");
  await git(a, "branch", "-D", "stash-side");
  await git(a, "branch", "-D", "prior");
  await commitFile(a, "f.txt", "v2", "c2");
  await fs.rm(path.join(a, ".git", "ORIG_HEAD"), { force: true });
  await push(rootA, cfgA, depsA);

  const lock = path.join(b, ".git", "index.lock");
  await fs.writeFile(lock, "");
  await pull(rootB, cfgB, depsB);
  await fs.rm(lock);
  let pendingState = await st(rootB);
  const pending = repoRecordsForState(pendingState)[rel]!.pending!;
  expect(pending.refs[priorRef]).toBeUndefined();
  expect(pending.refs["refs/stash"]).toBeDefined();

  // Install the exact pending semantic lanes locally, retain the omitted prior
  // branch, then advance main with an empty commit so index/op-state remain exact.
  await git(b, "fetch", a,
    "refs/heads/main:refs/remotes/rbox-test/main",
    "refs/stash:refs/stash");
  await git(b, "reset", "--hard", "refs/remotes/rbox-test/main");
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  await git(b, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", "ahead of pending");
  expect(await git(b, "merge-base", "--is-ancestor", pending.refs["refs/heads/main"]!, "refs/heads/main").then(() => true, () => false)).toBe(true);
  expect(await git(b, "rev-parse", "refs/stash")).toBe(pending.refs["refs/stash"]!);
  expect(await git(b, "rev-parse", priorRef)).toBeDefined();

  // Seed the other three sidecars so the accepted publisher ACK must clear only
  // its predecessor-bound apply episode while preserving an unrelated lane.
  const pendingRecord = pendingState.repoRecords![rel]!;
  const captureEpisode = nextDeferral("capture", undefined, "artifact", "2026-07-21T00:00:00.000Z");
  pendingRecord.deferrals = { ...pendingRecord.deferrals, capture: captureEpisode };
  pendingRecord.partial = {
    incomingKey: gitIncomingKey(pending), checkoutPending: true,
    appliedRefs: {}, heldRefs: {}, configApplied: true,
  };
  pendingRecord.attempt = {
    incomingKey: gitIncomingKey(pending), localFingerprint: "pre-ack", fingerprintVersion: GIT_FINGERPRINT_VERSION,
    effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
    incomingIndexArtifactDescriptor: "null",
    reflogs: [], blockers: [{ provenance: "checkout", reason: "local-commits" }],
    repoIdentity: "pre-ack", stateNonce: pendingState.stateNonce!, baseOriginsHash: "pre-ack",
    partialDisposition: "pre-ack", at: "2026-07-21T00:00:00.000Z",
  };
  await saveStateUnsafeLegacyOrTest(rootB, pendingState);

  const beforeSeq = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(beforeSeq + 1);
  const acked = repoRecordsForState(await st(rootB))[rel]!;
  expect(acked.pending).toBeUndefined();
  expect(acked.partial).toBeUndefined();
  expect(acked.attempt).toBeUndefined();
  expect(acked.deferrals?.apply).toBeUndefined();
  expect(acked.deferrals?.capture).toEqual(captureEpisode);
  expect(acked.base?.refs[priorRef]).toBeDefined();
  expect(acked.branchBaseOrigins?.[priorRef]).toBeDefined();
  const acknowledgedCandidate = (await remote.latest()).manifest.gitRepos![rel]!;
  expect(acked.base).toEqual(acknowledgedCandidate);
  const pendingKey = gitIncomingKey(pending);
  const candidateKey = gitIncomingKey(acknowledgedCandidate);
  expect(logsB.some((line) => line.includes(
    `git-sync superseded pending supersede-e2e [P=${pendingKey} candidate=${candidateKey} composed=${candidateKey}]`,
  ))).toBe(true);

  // D.4 convergence: the ACKed candidate is the exact composed BASE, a
  // self-pull is unchanged, and the following push is a no-op.
  const ackSeq = remote.headSeq();
  await pull(rootB, cfgB, depsB);
  const afterSelfPull = repoRecordsForState(await st(rootB))[rel]!;
  expect(afterSelfPull.pending).toBeUndefined();
  expect(afterSelfPull.base).toEqual(acknowledgedCandidate);
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(ackSeq);

  const rootC = path.join(tmp, "C");
  await fs.mkdir(path.join(rootC, ".rbox", "state"), { recursive: true });
  await saveStateUnsafeLegacyOrTest(rootC, {
    stream: syncStreamId({ ...cfgB, rootPath: rootC, deviceId: "devC" }), stateNonce: "c".repeat(32), stateRevision: 0,
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  });
  const cfgC: WorkspaceConfig = { ...cfgA, rootPath: rootC, deviceId: "devC" };
  await pull(rootC, cfgC, { remote, backoff: noBackoff, onGitLog: () => {} });
  const c = path.join(rootC, rel);
  expect(await git(c, "rev-parse", "refs/heads/main")).toBe(await git(b, "rev-parse", "refs/heads/main"));
  expect(await git(c, "rev-parse", priorRef)).toBe(await git(b, "rev-parse", priorRef));
}, 90_000);

test("design 177: confirmed keep-mine publishes synchronously and clears pending without daemon involvement", async () => {
  const rel = "keep-mine-e2e";
  const { b } = await prepareSupersedingPending(rel);
  const withDiscard = await st(rootB);
  const pendingRecord = withDiscard.repoRecords![rel]!;
  const discardedIncomingOid = pendingRecord.pending!.refs["refs/heads/main"]!;
  const discardedUniqueOid = await git(b, "commit-tree", "HEAD^{tree}", "-p", "HEAD", "-m", "incoming-only preservation root");
  pendingRecord.pending = {
    ...pendingRecord.pending!,
    refs: {
      ...pendingRecord.pending!.refs,
      "refs/tags/stale-incoming": discardedIncomingOid,
      "refs/heads/incoming-only": discardedUniqueOid,
    },
  };
  withDiscard.gitPendingRemote = { ...(withDiscard.gitPendingRemote ?? {}), [rel]: pendingRecord.pending };
  await saveStateUnsafeLegacyOrTest(rootB, withDiscard);
  await fs.writeFile(path.join(b, "local-stash.txt"), "keep this stash\n");
  await git(b, "stash", "push", "-u", "-m", "keep-mine local stash");
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const userRefsBefore = await git(b, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/stash");
  const indexBefore = await fs.readFile(path.join(b, ".git", "index"));
  const resolverDeps = {
    build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }),
    capabilityProbe: async () => true,
    now: () => new Date("2026-07-21T12:00:00.000Z"),
  };
  const previewLines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", { json: true, forceDiscardIncoming: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  })).toBe(1);
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview).toMatchObject({
    status: "preview", verb: "keep-mine", current: { status: "show-me" },
    confirm: { forceDiscardIncoming: true }, discardReport: { forceRequired: true },
  });

  const beforeSeq = remote.headSeq();
  const confirmedLines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: true,
  }, {
    ...resolverDeps, stdout: (line) => confirmedLines.push(line), stderr: (line) => confirmedLines.push(line),
  })).toBe(0);
  expect(remote.headSeq()).toBe(beforeSeq + 1);
  expect(await git(b, "rev-parse", "--verify", `refs/rbox-local/keep/${discardedUniqueOid}`)).toBe(discardedUniqueOid);
  expect(JSON.parse(confirmedLines.at(-1)!)).toMatchObject({
    status: "published", verb: "keep-mine", sequence: beforeSeq + 1,
  });
  const acked = repoRecordsForState(await st(rootB))[rel]!;
  expect(acked.pending).toBeUndefined();
  expect(acked.partial).toBeUndefined();
  expect(acked.attempt).toBeUndefined();
  expect(acked.deferrals?.apply).toBeUndefined();
  expect(acked.resolutionReceipt).toBeUndefined();
  expect(acked.base?.refs["refs/heads/main"]).toBe(await git(b, "rev-parse", "refs/heads/main"));
  expect(await git(b, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags", "refs/stash")).toBe(userRefsBefore);
  expect(await fs.readFile(path.join(b, ".git", "index"))).toEqual(indexBefore);

  const rootC = path.join(tmp, "keep-mine-follower");
  await fs.mkdir(path.join(rootC, ".rbox", "state"), { recursive: true });
  await saveStateUnsafeLegacyOrTest(rootC, {
    stream: syncStreamId({ ...cfgB, rootPath: rootC, deviceId: "devC" }), stateNonce: "c".repeat(32), stateRevision: 0,
    lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] },
  });
  const cfgC: WorkspaceConfig = { ...cfgB, rootPath: rootC, deviceId: "devC-keep-mine" };
  await pull(rootC, cfgC, { remote, backoff: noBackoff, onGitLog: () => {} });
  const follower = path.join(rootC, rel);
  expect(await git(follower, "rev-parse", "refs/heads/main")).toBe(await git(b, "rev-parse", "refs/heads/main"));
  expect(await git(follower, "rev-parse", "refs/stash")).toBe(await git(b, "rev-parse", "refs/stash"));
  await expect(git(follower, "rev-parse", "refs/tags/stale-incoming")).rejects.toThrow();
}, 90_000);

test("packed plus peer-diverged case stays per-ref for three cycles and keep-mine succeeds", async () => {
  const rel = "packed-case-b";
  const a = path.join(rootA, rel);
  await initRepo(a);
  await commitFile(a, "f.txt", "one", "c1");
  await git(a, "branch", "topic");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, rel);
  await git(b, "pack-refs", "--all");
  await push(rootB, cfgB, depsB); // records B's local monotonic baseline
  await git(b, "branch", "-D", "topic");

  await commitFile(a, "f.txt", "two", "peer advanced");
  await push(rootA, cfgA, depsA);
  for (let cycle = 0; cycle < 3; cycle++) {
    await pull(rootB, cfgB, depsB);
    const record = repoRecordsForState(await st(rootB))[rel]!;
    expect(record.partial?.heldRefs["refs/heads/topic"]).toBe("local-commits");
    expect(record.deferrals?.apply?.reason).toBe("deletion-pending");
    expect(record.deferrals?.apply?.reason).not.toBe("other");
  }

  const resolverDeps = {
    build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }),
    capabilityProbe: async () => true,
  };
  const previewLines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps,
    stdout: (line) => previewLines.push(line),
    stderr: (line) => previewLines.push(line),
  })).toBe(1);
  const preview = JSON.parse(previewLines.at(-1)!);
  const confirmedLines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.discardReport?.forceRequired === true,
  }, {
    ...resolverDeps,
    stdout: (line) => confirmedLines.push(line),
    stderr: (line) => confirmedLines.push(line),
  })).toBe(0);
  expect(JSON.parse(confirmedLines.at(-1)!)).toMatchObject({ status: "published", verb: "keep-mine" });
}, 90_000);

test("design 177: ambient commits and wholesale index rewrites never publish a stale keep-mine candidate", async () => {
  const rel = "keep-mine-ambient-churn";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const before = await st(rootB);
  const incomingOnly = await git(b, "commit-tree", "HEAD^{tree}", "-m", "incoming-only discard lane");
  before.repoRecords![rel]!.pending = {
    ...before.repoRecords![rel]!.pending!,
    refs: { ...before.repoRecords![rel]!.pending!.refs, "refs/heads/incoming-only": incomingOnly },
  };
  before.gitPendingRemote = { ...(before.gitPendingRemote ?? {}), [rel]: before.repoRecords![rel]!.pending! };
  await saveStateUnsafeLegacyOrTest(rootB, before);
  const pendingBefore = repoRecordsForState(await st(rootB))[rel]!.pending!;
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };

  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  expect(preview).toMatchObject({ discardReport: { forceRequired: true }, confirm: { forceDiscardIncoming: true } });
  expect(preview.discardReport.lanes).toContainEqual(expect.objectContaining({
    lane: "branch:refs/heads/incoming-only", disposition: "not-subsumed",
  }));
  const beforeSeq = remote.headSeq();
  let churnStarted = false;
  const publicationDeps = (deps: SyncDeps): SyncDeps => ({
    ...deps,
    resolutionCaptureTestHooks: {
      afterRefsRecorded: async () => {
        churnStarted = true;
      for (let i = 0; i < 3; i++) {
        await fs.writeFile(path.join(b, "ambient.txt"), `ambient-${i}\n`);
        await git(b, "add", "-A");
        await git(b, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "--allow-empty", "-qm", `ambient-${i}`);
        await git(b, "read-tree", "HEAD^");
        await git(b, "read-tree", "HEAD");
      }
      },
    },
  });

  const firstLines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps,
    stdout: (line) => firstLines.push(line),
    stderr: (line) => firstLines.push(line),
    confirmedPush: async ({ cfg, deps, resolution }) => {
      const hooked = publicationDeps(deps);
      const local = await scanManifestForPush(rootB, cfg, hooked);
      return pushManifest(rootB, cfg, local, hooked, { resolution });
    },
  })).toBe(1);
  expect(churnStarted).toBe(true);
  expect(remote.headSeq()).toBe(beforeSeq);
  expect(repoRecordsForState(await st(rootB))[rel]!.pending).toEqual(pendingBefore);
  expect(firstLines.join("\n")).toMatch(/changed while publishing|review.*confirm again|publication was refused/i);

  const retryPreviewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => retryPreviewLines.push(line), stderr: (line) => retryPreviewLines.push(line),
  });
  const retryPreview = JSON.parse(retryPreviewLines.at(-1)!);
  const retryLines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true,
    confirm: retryPreview.current.snapshot,
    forceDiscardIncoming: retryPreview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => retryLines.push(line), stderr: (line) => retryLines.push(line),
  })).toBe(0);

  expect(remote.headSeq()).toBe(beforeSeq + 1);
  const landed = await remote.latest();
  expect(landed.manifest.gitRepos?.[rel]?.refs["refs/heads/main"]).toBe(await git(b, "rev-parse", "HEAD"));
  expect(repoRecordsForState(await st(rootB))[rel]!.pending).toBeUndefined();
  expect(await git(b, "rev-parse", "--verify", `refs/rbox-local/keep/${incomingOnly}`)).toBe(incomingOnly);
}, 90_000);

test("design 177: lost accepted response returning 409 reconciles as ours without remote-moved copy", async () => {
  const rel = "keep-mine-lost-409";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  remote.lostAckAsConflictNext = true;
  const lines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => lines.push(line), stderr: (line) => lines.push(line),
  })).toBe(0);
  const result = JSON.parse(lines.at(-1)!);
  expect(result).toMatchObject({ status: "published", verb: "keep-mine", sequence: remote.headSeq() });
  expect(JSON.stringify(result)).not.toContain("another machine");
  const record = repoRecordsForState(await st(rootB))[rel]!;
  expect(record.pending).toBeUndefined();
  expect(record.resolutionReceipt).toBeUndefined();
}, 90_000);

test("design 177: a different-writer 409 aborts the rider once and returns a fresh preview", async () => {
  const rel = "keep-mine-409";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const resolverDeps = {
    build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }),
    capabilityProbe: async () => true,
  };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  const callsBefore = remote.commitCalls;
  remote.conflictNext = true;
  const lines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => lines.push(line), stderr: (line) => lines.push(line),
  })).toBe(1);
  const result = JSON.parse(lines.at(-1)!);
  expect(result).toMatchObject({ status: "snapshot-mismatch", verb: "keep-mine" });
  expect(result.message).toContain("another machine published while confirming");
  // The fresh preview is re-derived from the POST-pull state, so its token
  // equals the previewed one exactly when the other writer's publication
  // changed nothing this confirmation covers (here: a different repo). It
  // used to differ only because the aborted rider bumped `repoGen`, which the
  // token no longer binds — a counter is not evidence about the state the
  // human is consenting to discard. A publication that really did move this
  // repo's incoming section moves `incomingKey`, and the token rotates.
  expect(result.current).toBeDefined();
  expect(result.discardReport).toBeDefined();
  expect(remote.commitCalls - callsBefore).toBe(1);
  const record = repoRecordsForState(await st(rootB))[rel]!;
  expect(record.pending).toBeDefined();
  expect(record.resolutionReceipt).toBeUndefined();
}, 90_000);

test("design 177: a different-writer 409 with no remaining pending reports resolved without a fresh preview", async () => {
  const rel = "keep-mine-409-no-pending";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  const currentHead = await remote.latest();
  const { [rel]: _removed, ...remainingGit } = currentHead.manifest.gitRepos ?? {};
  remote.conflictManifestNext = {
    ...currentHead.manifest,
    generatedAt: "different-writer-removed-repo",
    gitRepos: Object.keys(remainingGit).length > 0 ? remainingGit : undefined,
  };
  remote.conflictNext = true;
  const callsBefore = remote.commitCalls;
  const lines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true,
    confirm: preview.current.snapshot,
    forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => lines.push(line), stderr: (line) => lines.push(line),
  })).toBe(1);
  const result = JSON.parse(lines.at(-1)!);
  expect(result).toMatchObject({ status: "refused", verb: "keep-mine", code: "no-incoming" });
  expect(result.message).toContain("post-pull state has no incoming hold");
  expect(result.current).toBeUndefined();
  expect(result.discardReport).toBeUndefined();
  expect(remote.commitCalls - callsBefore).toBe(1);
  const record = repoRecordsForState(await st(rootB))[rel];
  expect(record?.pending).toBeUndefined();
  expect(record?.resolutionReceipt).toBeUndefined();
}, 90_000);

test("design 177: independently published identical state is accepted-equivalent", async () => {
  const rel = "keep-mine-identical";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  remote.independentIdenticalConflictNext = true;
  const lines: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => lines.push(line), stderr: (line) => lines.push(line),
  })).toBe(0);
  expect(JSON.parse(lines.at(-1)!)).toMatchObject({ status: "published", sequence: remote.headSeq() });
  const record = repoRecordsForState(await st(rootB))[rel]!;
  expect(record.pending).toBeUndefined();
  expect(record.resolutionReceipt).toBeUndefined();
}, 90_000);

test("design 177: uncertain ACK reconciles a later exact head after unrelated changes apply", async () => {
  const rel = "keep-mine-later-head";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  remote.loseAckThrowNext = true;
  const uncertain: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => uncertain.push(line), stderr: (line) => uncertain.push(line),
  })).toBe(1);
  expect(JSON.parse(uncertain.at(-1)!)).toMatchObject({ status: "ack-uncertain" });
  expect(repoRecordsForState(await st(rootB))[rel]?.resolutionReceipt).toBeDefined();

  const landed = await remote.latest();
  const target = "unrelated-target";
  const unrelated: FileEntry = {
    path: "unrelated-link", type: "symlink", symlinkTarget: target,
    sha256: crypto.createHash("sha256").update(target).digest("hex"), size: target.length, mode: 0o777, mtimeMs: 1,
  };
  remote.publishIndependent({ ...landed.manifest, generatedAt: "later", files: [...landed.manifest.files, unrelated] });
  await pull(rootB, cfgB, depsB);
  expect(await fs.readlink(path.join(rootB, "unrelated-link"))).toBe(target);
  const record = repoRecordsForState(await st(rootB))[rel]!;
  expect(record.pending).toBeUndefined();
  expect(record.resolutionReceipt).toBeUndefined();
}, 90_000);

test("design 177: ordinary pull surfaces a mismatching uncertain-ACK head only when pending remains", async () => {
  const rel = "keep-mine-ordinary-reconcile";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const pendingBefore = repoRecordsForState(await st(rootB))[rel]!.pending!;
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  remote.loseAckThrowNext = true;
  const uncertain: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => uncertain.push(line), stderr: (line) => uncertain.push(line),
  })).toBe(1);
  expect(JSON.parse(uncertain.at(-1)!)).toMatchObject({ status: "ack-uncertain" });

  const landed = await remote.latest();
  remote.publishIndependent({
    ...landed.manifest,
    generatedAt: "different-writer-after-uncertain-ack",
    gitRepos: { ...(landed.manifest.gitRepos ?? {}), [rel]: pendingBefore },
  });
  const warnings: string[] = [];
  await pull(rootB, cfgB, { ...depsB, warningSink: (line) => warnings.push(line) });
  expect(warnings).toContain("another machine published while confirming — review the new state and confirm again");
  const record = repoRecordsForState(await st(rootB))[rel]!;
  expect(record.pending).toBeDefined();
  expect(record.resolutionReceipt).toBeUndefined();
}, 90_000);

test("design 177: ordinary push surfaces a mismatching uncertain-ACK head before planning", async () => {
  const rel = "keep-mine-push-reconcile";
  const { b } = await prepareSupersedingPending(rel);
  await fs.rm(path.join(b, ".git", "ORIG_HEAD"), { force: true });
  const pendingBefore = repoRecordsForState(await st(rootB))[rel]!.pending!;
  const resolverDeps = { build: async () => ({ cfg: cfgB, store: remote.blobStore(), remote }), capabilityProbe: async () => true };
  const previewLines: string[] = [];
  await gitResolveCmd(rootB, b, "keep-mine", { json: true }, {
    ...resolverDeps, stdout: (line) => previewLines.push(line), stderr: (line) => previewLines.push(line),
  });
  const preview = JSON.parse(previewLines.at(-1)!);
  remote.loseAckThrowNext = true;
  const uncertain: string[] = [];
  expect(await gitResolveCmd(rootB, b, "keep-mine", {
    json: true, confirm: preview.current.snapshot, forceDiscardIncoming: preview.confirm.forceDiscardIncoming,
  }, {
    ...resolverDeps, stdout: (line) => uncertain.push(line), stderr: (line) => uncertain.push(line),
  })).toBe(1);
  expect(JSON.parse(uncertain.at(-1)!)).toMatchObject({ status: "ack-uncertain" });

  const landed = await remote.latest();
  remote.publishIndependent({
    ...landed.manifest,
    generatedAt: "different-writer-before-ordinary-push",
    gitRepos: { ...(landed.manifest.gitRepos ?? {}), [rel]: pendingBefore },
  });
  const warnings: string[] = [];
  await push(rootB, cfgB, { ...depsB, warningSink: (line) => warnings.push(line) });
  expect(warnings).toContain("another machine published while confirming — review the new state and confirm again");
  expect(repoRecordsForState(await st(rootB))[rel]?.resolutionReceipt).toBeUndefined();
}, 90_000);

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
}, 90_000);

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

test("standing apply deferral remains byte-exact across a pre-ACK push while pending", async () => {
  const { b, lock } = await makePending("bytes-marker");
  const before = repoRecordsForState(await st(rootB))["bytes-marker"]!.deferrals!.apply!;
  expect(before.bytesChanged).toBeUndefined();
  const beforeRecord = repoRecordsForState(await st(rootB))["bytes-marker"]!;
  const beforeBytes = sidecarSnapshot(beforeRecord);

  await fs.writeFile(path.join(b, "f.txt"), "human bytes during deferral");
  await push(rootB, cfgB, depsB);

  const restarted = await st(rootB);
  const marked = repoRecordsForState(restarted)["bytes-marker"]!.deferrals!.apply!;
  expect(marked.bytesChanged).toBeUndefined();
  expect(marked.deferredSince).toBe(before.deferredSince);
  expect(marked.lastSeen).toBe(before.lastSeen);
  const restartedRecord = repoRecordsForState(restarted)["bytes-marker"]!;
  expect(sidecarSnapshot(restartedRecord)).toBe(beforeBytes);

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
  await saveStateUnsafeLegacyOrTest(rootB, partialState);
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

test("pending + 422: failed retries preserve P and all sidecars byte-for-byte", async () => {
  const { lock } = await makePending("r");
  await fs.rm(lock);
  const sB = await st(rootB);
  const pendingSec = sB.gitPendingRemote!["r"]!;
  const beforeRecord = JSON.stringify(repoRecordsForState(sB).r);
  const beforeSeq = remote.headSeq();
  remote.deleteBlob(pendingSec.bundleEncSha); // server-side GC of the pending section's bundle

  await fs.writeFile(path.join(rootB, "x.txt"), "x");
  await expect(pushManifest(rootB, cfgB, await scanManifest(rootB, undefined, undefined), depsB))
    .rejects.toThrow(/missing blobs/);
  expect(remote.headSeq()).toBe(beforeSeq);
  const sB2 = await st(rootB);
  expect(JSON.stringify(repoRecordsForState(sB2).r)).toBe(beforeRecord);
}, 90_000);

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

test("ordinary deletion of a packed branch publishes without whole-repository refusal", async () => {
  const repo = path.join(rootA, "branch-delete");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "checkout", "-qb", "topic");
  await commitFile(repo, "topic.txt", "topic", "topic c1");
  await git(repo, "checkout", "-q", "main");
  await git(repo, "pack-refs", "--all");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const before = repoRecordsForState(await st(rootA))["branch-delete"]!.base!;
  const topicOid = before.refs["refs/heads/topic"]!;

  await git(repo, "branch", "-D", "topic");
  await push(rootA, cfgA, depsA);

  const accepted = (await remote.latest()).manifest.gitRepos!["branch-delete"]!;
  expect(accepted.refs["refs/heads/topic"]).toBeUndefined();
  expect(accepted.refTombstones?.["refs/heads/topic"]?.filter((entry) => entry.oid === topicOid)).toHaveLength(1);
  const record = repoRecordsForState(await st(rootA))["branch-delete"]!;
  expect(record.deferrals?.capture).toBeUndefined();
  expect(record.base?.refs["refs/heads/topic"]).toBeUndefined();
  expect(record.pending).toBeUndefined();

  await pull(rootB, cfgB, depsB);
  const receiverRepo = path.join(rootB, "branch-delete");
  await expect(git(receiverRepo, "rev-parse", "--verify", "refs/heads/topic")).rejects.toThrow();
  expect(repoRecordsForState(await st(rootB))["branch-delete"]?.base?.refs["refs/heads/topic"]).toBeUndefined();
  expect(await git(receiverRepo, "rev-parse", keepPinRef(topicOid))).toBe(topicOid);
  expect((await readKeepPinOrigins(receiverRepo))[topicOid]?.some(
    (origin) => origin.ref === "refs/heads/topic" && origin.class === "tombstone",
  )).toBe(true);
}, 20_000);

test("design 200 Step D atomically defers a 24-head repository on real ref-lock contention", async () => {
  const repo = path.join(rootA, "branch-delete-lock");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  const deletedRefs = Array.from({ length: 24 }, (_, index) =>
    `refs/heads/topic-${index.toString().padStart(2, "0")}`);
  for (const ref of deletedRefs) await git(repo, "update-ref", ref, "HEAD");
  await push(rootA, cfgA, depsA);
  const beforeRecord = repoRecordsForState(await st(rootA))["branch-delete-lock"]!;
  const beforeSection = beforeRecord.base!;
  const priorMain = beforeSection.refs["refs/heads/main"]!;

  for (const ref of deletedRefs) await git(repo, "update-ref", "-d", ref);
  await commitFile(repo, "f.txt", "two", "main c2");
  const advancedMain = await git(repo, "rev-parse", "refs/heads/main");
  const lockPath = path.join(repo, ".git", "refs", "heads", "topic-00.lock");
  await push(rootA, cfgA, {
    ...depsA,
    beforeAbsenceWitness: async (rel) => {
      if (rel === "branch-delete-lock") {
        await fs.mkdir(path.dirname(lockPath), { recursive: true });
        await fs.writeFile(lockPath, "prepared transaction");
      }
    },
  });

  const carried = (await remote.latest()).manifest.gitRepos!["branch-delete-lock"]!;
  expect(carried.refs["refs/heads/main"]).toBe(priorMain); // unrelated work waits with the repository
  for (const ref of deletedRefs) {
    const oid = beforeSection.refs[ref]!;
    expect(carried.refs[ref]).toBe(oid);
    expect(carried.refTombstones?.[ref]?.some((entry) => entry.oid === oid)).not.toBe(true);
  }
  const deferredRecord = repoRecordsForState(await st(rootA))["branch-delete-lock"]!;
  expect(deferredRecord.deferrals?.capture?.reason).toBe("deletion-pending");
  for (const ref of deletedRefs) {
    expect(deferredRecord.base?.refs[ref]).toBe(beforeSection.refs[ref]);
    expect(deferredRecord.branchBaseOrigins?.[ref]).toEqual(beforeRecord.branchBaseOrigins?.[ref]);
  }

  await fs.rm(lockPath);
  // Once the real contention clears, the verify-only proof authorizes the
  // ordinary omission.
  await push(rootA, cfgA, depsA);
  const accepted = (await remote.latest()).manifest.gitRepos!["branch-delete-lock"]!;
  expect(accepted.refs["refs/heads/main"]).toBe(advancedMain);
  const finalRecord = repoRecordsForState(await st(rootA))["branch-delete-lock"]!;
  for (const ref of deletedRefs) {
    const oid = beforeSection.refs[ref]!;
    expect(accepted.refs[ref]).toBeUndefined();
    expect(accepted.refTombstones?.[ref]?.some((entry) => entry.oid === oid)).toBe(true);
    expect(finalRecord.base?.refs[ref]).toBeUndefined();
  }
}, 30_000);

test("design 200 kill switch restores pre-200 omission publication without proof-backed BASE retirement", async () => {
  const repo = path.join(rootA, "branch-delete-switch");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await git(repo, "pack-refs", "--all");
  await push(rootA, cfgA, depsA);
  const initialRecord = repoRecordsForState(await st(rootA))["branch-delete-switch"]!;
  const topicOid = initialRecord.base!.refs["refs/heads/topic"]!;
  const initialPackedMtime = initialRecord.packedRefsIdentity!.mtimeMs;
  await git(repo, "branch", "-D", "topic");

  const previous = process.env.RBOX_GIT_ABSENCE_CAPTURE;
  process.env.RBOX_GIT_ABSENCE_CAPTURE = "0";
  try {
    await push(rootA, cfgA, depsA);
  } finally {
    if (previous === undefined) delete process.env.RBOX_GIT_ABSENCE_CAPTURE;
    else process.env.RBOX_GIT_ABSENCE_CAPTURE = previous;
  }

  const accepted = (await remote.latest()).manifest.gitRepos!["branch-delete-switch"]!;
  expect(accepted.refs["refs/heads/topic"]).toBeUndefined();
  expect(accepted.refTombstones?.["refs/heads/topic"]?.some((entry) => entry.oid === topicOid)).toBe(true);
  const switchedOffRecord = repoRecordsForState(await st(rootA))["branch-delete-switch"]!;
  expect(switchedOffRecord.base!.refs["refs/heads/topic"]).toBe(topicOid);
  expect(switchedOffRecord.packedRefsIdentity!.mtimeMs).toBeGreaterThanOrEqual(initialPackedMtime);
}, 20_000);

test("design 309: a BASE section this device captured is origin evidence for deleting its branches", async () => {
  const rel = "self-authored-deletion";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  expect(record.base?.deviceId).toBe(gitSectionDeviceId(cfgA.deviceId));
  // Pre-273 shape: the branch is in BASE with no per-branch origin entry.
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  await git(repo, "branch", "-D", "topic");
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
  );
  expect(plan.captureDeferrals[rel]).toBeUndefined();
  expect(plan.absentBranchProofs?.[rel]?.["refs/heads/topic"]).toEqual({ priorOid: record.base!.refs["refs/heads/topic"] });
  expect(plan.gitRepos?.[rel]?.refs["refs/heads/topic"]).toBeUndefined();
  expect(plan.gitRepos?.[rel]?.refTombstones?.["refs/heads/topic"]?.some((entry) => entry.oid === record.base!.refs["refs/heads/topic"])).toBe(true);
});

test("design 309: a BASE section with no author stamp still refuses an origin-less deletion", async () => {
  const rel = "unstamped-deletion";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  const { deviceId: _stamp, ...unstamped } = record.base!;
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins, base: unstamped };
  await git(repo, "branch", "-D", "topic");
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
  );
  expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
  expect(plan.gitRepos?.[rel]?.refs["refs/heads/topic"]).toBeDefined();
});

test("design 311: a standing-artifacts refusal is remembered until the protocol ref plane changes", async () => {
  const rel = "standing-artifacts-memo";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  await git(repo, "branch", "-D", "topic");
  forgetStandingArtifactRefusalsForTests();
  const original = followerProtocol.prepareFollowerBranchProtocol;
  let protocolCalls = 0;
  const spy = spyOn(followerProtocol, "prepareFollowerBranchProtocol").mockImplementation(async (input) => {
    protocolCalls++;
    const result = await original(input);
    if (result.status === "ready") {
      result.protocol.artifacts["refs/heads/topic"] = { absence: "absent", present: "present", keeps: "clear", settledAbsence: "absent" };
    }
    return result;
  });
  let witnessStage = false;
  const witnessSpawns: string[][] = [];
  setGitSpawnObserver((_spawnRoot, args) => { if (witnessStage) witnessSpawns.push([...args]); });
  try {
    const run = async () => {
      witnessStage = false;
      witnessSpawns.length = 0;
      const logs: string[] = [];
      const plan = await planGitSections(
        rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
          beforeAbsenceWitness: () => { witnessStage = true; },
          onGitLog: (line) => logs.push(line),
        },
      );
      return { plan, logs };
    };
    const first = await run();
    expect(first.plan.captureDeferrals[rel]).toBe("deletion-pending");
    expect(first.logs.some((line) => line.includes("refused refs/heads/topic (artifacts-standing)"))).toBe(true);
    expect(protocolCalls).toBe(1);

    const second = await run();
    expect(second.plan.captureDeferrals[rel]).toBe("deletion-pending");
    expect(second.logs.some((line) => line.includes("refused refs/heads/topic (artifacts-standing)"))).toBe(true);
    expect(protocolCalls).toBe(1); // remembered: no scan
    expect(witnessSpawns.map((args) => args[0])).toEqual(["for-each-ref"]); // only the plane token

    await git(repo, "update-ref", "refs/rbox-local/keep/0000000000000000000000000000000000000000", (await git(repo, "rev-parse", "HEAD")).trim());
    const third = await run();
    expect(third.plan.captureDeferrals[rel]).toBe("deletion-pending");
    expect(protocolCalls).toBe(2); // the plane changed: scanned again
  } finally {
    setGitSpawnObserver(undefined);
    spy.mockRestore();
    forgetStandingArtifactRefusalsForTests();
  }
}, 30_000);

async function plantCreateReceipt(
  rel: string, ref: string, nextOid: string, state: SyncState, priorOid: string | null = null,
  rebind?: (binding: { lineageHash: string; repositoryIdentityHash: string }) => { lineageHash: string; repositoryIdentityHash: string },
): Promise<void> {
  const repo = path.join(rootA, rel);
  const ctx = (await repoCtx(repo))!;
  const identity = await readRepoIdentityV1(rel, ctx.kind, { worktreeId: ctx.repoDir, gitDirReal: ctx.gitDir, commonDirReal: ctx.commonDir });
  const current = artifactBinding(await readStateLineageV1(rootA, state.stream, state.stateNonce!, identity));
  const binding = rebind ? rebind(current) : current;
  const prepared = await prepareBasePresentArtifact(repo, binding, ref, "ab".repeat(16), priorOid, nextOid);
  await commitProtocolRefTransaction(repo, prepared.transactionLines);
}

async function receiptRefs(rel: string): Promise<string[]> {
  return (await git(path.join(rootA, rel), "for-each-ref", "--format=%(refname)", "refs/rbox-local/base-present", "refs/rbox-local/base-present-keep"))
    .split("\n").filter(Boolean);
}

test("design 310: a CREATE-P receipt matching this device's own BASE is a completed landing and retires with the deletion", async () => {
  const rel = "self-settled-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  await plantCreateReceipt(rel, "refs/heads/topic", topicOid, state);
  expect(await receiptRefs(rel)).toHaveLength(2); // P + next keep
  await git(repo, "branch", "-D", "topic");
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
  );
  expect(plan.captureDeferrals[rel]).toBeUndefined();
  expect(plan.absentBranchProofs?.[rel]?.["refs/heads/topic"]).toEqual({ priorOid: topicOid });
  expect(plan.gitRepos?.[rel]?.refTombstones?.["refs/heads/topic"]?.some((entry) => entry.oid === topicOid)).toBe(true);
  expect(await receiptRefs(rel)).toEqual([]); // retired in the same transaction
}, 20_000);

test("design 310: an UPDATE-P receipt at the BASE commit is not a create landing and still refuses", async () => {
  const rel = "update-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  const firstOid = (await git(repo, "rev-parse", "HEAD")).trim();
  await git(repo, "branch", "topic");
  await commitFile(repo, "g.txt", "two", "c2");
  await git(repo, "branch", "-f", "topic", "HEAD");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  await plantCreateReceipt(rel, "refs/heads/topic", topicOid, state, firstOid); // prior -> next: an update, not a create
  await git(repo, "branch", "-D", "topic");
  const logs: string[] = [];
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, { onGitLog: (line) => logs.push(line) },
  );
  expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
  expect(logs.some((line) => line.includes("refused refs/heads/topic (artifacts-standing)"))).toBe(true);
  expect(await receiptRefs(rel)).toHaveLength(3); // P + prior keep + next keep
}, 20_000);

test("design 312: a CREATE-P receipt from another lineage of this same repository settles like an owning one", async () => {
  const rel = "prior-lineage-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  // Same physical repository, different (earlier) workspace lineage.
  await plantCreateReceipt(rel, "refs/heads/topic", topicOid, state, null, (b) => ({ ...b, lineageHash: "f".repeat(64) }));
  expect(await receiptRefs(rel)).toHaveLength(2);
  await git(repo, "branch", "-D", "topic");
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff,
    { otherWorkspaceClaimsRepo: async () => false },
  );
  expect(plan.captureDeferrals[rel]).toBeUndefined();
  expect(plan.absentBranchProofs?.[rel]?.["refs/heads/topic"]).toEqual({ priorOid: topicOid });
  expect(await receiptRefs(rel)).toEqual([]);
}, 20_000);

test("design 312: a foreign receipt stays standing while another workspace on this host claims the repository", async () => {
  const rel = "claimed-foreign-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  await plantCreateReceipt(rel, "refs/heads/topic", topicOid, state, null, (b) => ({ ...b, lineageHash: "f".repeat(64) }));
  await git(repo, "branch", "-D", "topic");
  const claims: string[] = [];
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff,
    { otherWorkspaceClaimsRepo: async (_root, repoDir) => { claims.push(repoDir); return true; } },
  );
  expect(claims).toHaveLength(1);
  expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
  expect(await receiptRefs(rel)).toHaveLength(2);
}, 20_000);

test("design 312: a foreign receipt inside a P-repair recovery (Q present) stays standing", async () => {
  const rel = "repairing-foreign-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  const foreignLineage = "f".repeat(64);
  await plantCreateReceipt(rel, "refs/heads/topic", topicOid, state, null, (b) => ({ ...b, lineageHash: foreignLineage }));
  await git(repo, "update-ref", pRepairQRef(foreignLineage, "refs/heads/topic", "ab".repeat(16)), topicOid);
  await git(repo, "branch", "-D", "topic");
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff,
    { otherWorkspaceClaimsRepo: async () => false },
  );
  expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
  expect(await receiptRefs(rel)).toHaveLength(2);
}, 20_000);

test("design 312: the host inventory guard fails closed and matches any other root containing the repository", async () => {
  // The repository lives under rootB; our workspace root is rootA (a foreign checkout).
  const repo = path.join(rootB, "inventory-guard");
  await fs.mkdir(repo, { recursive: true });
  const revision = codecInternals.revision("absent");
  const evidence = (rows: string[], persisted: string[], unavailable: string[] = []) => async () => ({
    desiredRows: rows.map((rootPath) => ({ key: rootPath, path: rootPath, desired: { rootPath } })) as never,
    persistedEntries: persisted.map((root) => ({ root })) as never,
    unavailable,
  });
  const absent = async () => ({ kind: "absent" as const, revision });
  // Only our own root: no claim.
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([rootA], [rootA]), inspectCatalog: absent })).toBe(false);
  // Another known root that CONTAINS the repository (daemon row, registry, or catalog): claim.
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([rootA, rootB], []), inspectCatalog: absent })).toBe(true);
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([], [repo]), inspectCatalog: absent })).toBe(true);
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([], []), inspectCatalog: async () => ({ kind: "authoritative" as const, revision, snapshot: { folders: [{ normalizedPath: rootB }] } as never }) })).toBe(true);
  // An unrelated root elsewhere: no claim.
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([path.join(rootB, "elsewhere")], []), inspectCatalog: absent })).toBe(false);
  // Unreadable evidence or a damaged catalog: fail closed.
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([], [], ["daemons"]), inspectCatalog: absent })).toBe(true);
  expect(await otherWorkspaceClaimsRepoByRegistry(rootA, repo, { readEvidence: evidence([], []), inspectCatalog: async () => ({ kind: "damaged" as const, reason: "x", revision }) })).toBe(true);
});

test("design 312: a CREATE-P receipt from a DIFFERENT repository identity still refuses", async () => {
  const rel = "other-repo-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  await plantCreateReceipt(rel, "refs/heads/topic", topicOid, state, null, () => ({ lineageHash: "f".repeat(64), repositoryIdentityHash: "e".repeat(64) }));
  await git(repo, "branch", "-D", "topic");
  const logs: string[] = [];
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, { onGitLog: (line) => logs.push(line) },
  );
  expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
  expect(logs.some((line) => line.includes("refused refs/heads/topic (artifacts-standing)"))).toBe(true);
  expect(await receiptRefs(rel)).toHaveLength(2);
}, 20_000);

test("design 310: a CREATE-P receipt for a DIFFERENT commit than BASE still stands and refuses the deletion", async () => {
  const rel = "foreign-receipt";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins };
  await commitFile(repo, "g.txt", "two", "c2"); // a commit BASE never saw
  const otherOid = (await git(repo, "rev-parse", "HEAD")).trim();
  await plantCreateReceipt(rel, "refs/heads/topic", otherOid, state);
  await git(repo, "branch", "-D", "topic");
  const logs: string[] = [];
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, { onGitLog: (line) => logs.push(line) },
  );
  expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
  expect(logs.some((line) => line.includes("refused refs/heads/topic (artifacts-standing)"))).toBe(true);
  expect(await receiptRefs(rel)).toHaveLength(2);
}, 20_000);

test("design 308: a missing BASE branch with no recorded origin is refused before any artifact scan", async () => {
  const rel = "cheap-witness-refusal";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = state.repoRecords![rel]!;
  // A legacy BASE: the branch exists in BASE but carries no origin evidence, so
  // its deletion can never be proven this cycle.
  const { "refs/heads/topic": _origin, ...origins } = record.branchBaseOrigins ?? {};
  // ...and the section was captured by ANOTHER device, so design 309's
  // self-authored evidence does not apply either.
  state.repoRecords![rel] = { ...record, branchBaseOrigins: origins, base: { ...record.base!, deviceId: "dev_00000000" } };
  await git(repo, "branch", "-D", "topic");
  let witnessStage = false;
  const scanSpawns: string[][] = [];
  const logs: string[] = [];
  setGitSpawnObserver((_spawnRoot, args) => {
    if (witnessStage) scanSpawns.push([...args]);
  });
  try {
    const plan = await planGitSections(
      rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
        beforeAbsenceWitness: () => { witnessStage = true; },
        onGitLog: (line) => logs.push(line),
      },
    );
    expect(plan.captureDeferrals[rel]).toBe("deletion-pending");
    expect(plan.absentBranchProofs?.[rel]).toBeUndefined();
    expect(plan.gitRepos?.[rel]?.refs["refs/heads/topic"]).toBeDefined(); // BASE carried, deletion not published
    expect(logs.some((line) => line.includes(`deferred ${rel}: finishing branch deletion: branch deletion witness refused refs/heads/topic (origin-mismatch)`))).toBe(true);
    expect(scanSpawns).toEqual([]);
  } finally {
    setGitSpawnObserver(undefined);
  }
}, 20_000);

test("Step D never runs witness math on a carried pending omission (busy carry keeps one deferral, no proofs)", async () => {
  const rel = "carried-pending-omission";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = repoRecordsForState(state)[rel]!;
  // A peer deletion in flight: pending omits the BASE-positive head (§3.6's
  // one-cycle carried window). Pending is protected inbound state, never this
  // cycle's capture evidence.
  const { "refs/heads/topic": _omitted, ...restRefs } = record.base!.refs;
  const pendingSection = { ...record.base!, refs: restRefs };
  state.gitPendingRemote = { ...state.gitPendingRemote, [rel]: pendingSection };
  state.repoRecords![rel] = { ...state.repoRecords![rel]!, pending: pendingSection };
  await fs.writeFile(path.join(repo, ".git", "index.lock"), "");
  try {
    const plan = await planGitSections(
      rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
    );
    expect(plan.carried).toContain(rel);
    expect(plan.absentBranchProofs?.[rel]).toBeUndefined();
    expect(plan.gitRepos?.[rel]?.refs["refs/heads/topic"]).toBeUndefined();
    expect(plan.deferred.filter((item) => item.relPath === rel)).toHaveLength(1);
    expect(plan.captureDeferrals[rel]).not.toBe("deletion-pending");
  } finally {
    await fs.rm(path.join(repo, ".git", "index.lock"), { force: true });
  }
}, 20_000);

// #828: 132 chromium-fork repos paused during a stress test, then added to
// config.json `ignorePaths`. rbox can never sync them again, so the pause
// records had nothing left to protect — yet they survived forever and buried
// every live deferral in `rbox status --git`.
test("a paused repository now under the ignore rules retires its record, and its files stay on disk", async () => {
  const rel = "ignored-pause";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  // The pause this retirement must be able to reach: an apply-lane deferral, the
  // one lane no ordinary capture observation clears.
  state.repoRecords![rel] = {
    ...state.repoRecords![rel]!,
    deferrals: {
      apply: {
        lane: "apply",
        deferredSince: "2026-08-22T12:00:00.000Z",
        reasonSince: "2026-08-22T12:00:00.000Z",
        lastSeen: "2026-08-22T12:00:00.000Z",
        reason: "local-commits",
      },
    },
  };

  const ignored = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA, { ignorePaths: [rel] }),
  );
  expect(ignored.ignoreRetired).toEqual([rel]);
  expect(ignored.skipped.map((item) => item.relPath)).toContain(rel);
  // The safety property: retirement is bookkeeping only.
  expect(await fs.readFile(path.join(repo, "f.txt"), "utf8")).toBe("one");
  expect(await fs.stat(path.join(repo, ".git")).then(() => true)).toBeTrue();
  // …and BASE is carried, not dropped, so nothing proposes deleting the peer's history.
  expect(ignored.gitRepos?.[rel]).toEqual(repoRecordsForState(state)[rel]!.base!);

  // Un-ignored again: ordinary discovery finds the repo, so nothing retires and
  // a fresh deferral record is minted by the normal flow.
  const unignored = await planGitSections(
    rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA),
  );
  expect(unignored.ignoreRetired).toEqual([]);
  expect(unignored.captureObserved).toContain(rel);
}, 20_000);

test("an ignored repository with no standing pause retires nothing", async () => {
  const rel = "ignored-no-pause";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await push(rootA, cfgA, depsA);
  const plan = await planGitSections(
    rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA, { ignorePaths: [rel] }),
  );
  expect(plan.skipped.map((item) => item.relPath)).toContain(rel);
  expect(plan.ignoreRetired).toEqual([]);
}, 20_000);

// #828 field shape (2026-09-02, founder desktop): the 132 surviving chromium
// pauses are capture-lane records with NO base and NO pending section — the
// capture that would have minted one was deferred ("unsupported") before it ever
// ran. Such a record is in none of the planner's key sources (discovery is pruned
// by the whole-tree `chromium/` rule, and there is no base/pending entry), so no
// per-repo branch ever meets it. Retirement must join the RECORD set against the
// current ignore rules, not the planned set.
test("a paused record with no base and no pending still retires under a whole-tree ignore rule", async () => {
  const parent = "ghost-parent";
  const rel = `${parent}/nested`;
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  const state = await st(rootA);
  // Exactly the field record: a standing capture pause, nothing else.
  state.repoRecords = {
    ...state.repoRecords,
    [rel]: {
      repoGen: 1,
      sourceSeq: 1,
      deferrals: {
        capture: {
          lane: "capture",
          deferredSince: "2026-08-23T16:25:52.377Z",
          reasonSince: "2026-08-23T16:25:52.377Z",
          lastSeen: "2026-09-01T01:53:08.484Z",
          reason: "unsupported",
        },
      },
    },
  };

  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA, { ignorePaths: [parent] }),
  );
  expect(plan.ignoreRetired).toEqual([rel]);
  // The observation write only visits observed repos, so retirement must land there too.
  expect(plan.captureObserved).toContain(rel);
  // Bookkeeping only: files and `.git` are untouched.
  expect(await fs.readFile(path.join(repo, "f.txt"), "utf8")).toBe("one");
  expect(await fs.stat(path.join(repo, ".git")).then(() => true)).toBeTrue();
}, 20_000);

test("design 306b: slow-path (untrusted-cache) carries reuse the identity probe's context too", async () => {
  const rels = ["slow-carry-a", "slow-carry-b"];
  for (const rel of rels) {
    const repo = path.join(rootA, rel);
    await initRepo(repo);
    await commitFile(repo, "f.txt", "one", "c1");
  }
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  // No markDivergenceCacheTrusted: every repo takes the slow classify path and
  // carries through RepoCaptureAttempt's identity match, not the fast-path branch.
  let captureStage = false;
  let captureRevParseSpawns = 0;
  const freshContextReads: string[] = [];
  setGitSpawnObserver((_spawnRoot, args) => {
    if (captureStage && args[0] === "rev-parse") captureRevParseSpawns++;
  });
  try {
    const plan = await planGitSections(
      rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
        beforeCapturePool: () => { captureStage = true; },
        onPostCaptureRepoCtxRead: (rel) => freshContextReads.push(rel),
      },
    );
    expect(plan.carried).toEqual(expect.arrayContaining(rels));
    expect(freshContextReads.filter((rel) => rels.includes(rel))).toEqual([]);
    expect(captureRevParseSpawns).toBe(0);
  } finally {
    setGitSpawnObserver(undefined);
  }
}, 20_000);

test("design 306: carried repos reuse classify contexts and still refresh packed-refs", async () => {
  const rels = ["carried-context-a", "carried-context-b", "carried-context-c"];
  for (const rel of rels) {
    const repo = path.join(rootA, rel);
    await initRepo(repo);
    await commitFile(repo, "f.txt", "one", "c1");
    await git(repo, "pack-refs", "--all");
  }
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const baseline = repoRecordsForState(state)[rels[0]!]!.packedRefsIdentity!.mtimeMs;
  const moved = new Date(Date.now() + 2_000);
  await fs.utimes(path.join(rootA, rels[0]!, ".git", "packed-refs"), moved, moved);
  await markDivergenceCacheTrusted(rootA);
  const previous = process.env.RBOX_GIT_ABSENCE_CAPTURE;
  process.env.RBOX_GIT_ABSENCE_CAPTURE = "0";
  try {
    process.env.RBOX_GIT_PLAN_LAZY = "0";
    const legacy = await planGitSections(
      rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
    );
    process.env.RBOX_GIT_PLAN_LAZY = "1";
    let captureStage = false;
    let captureRevParseSpawns = 0;
    const freshContextReads: string[] = [];
    setGitSpawnObserver((_spawnRoot, args) => {
      if (captureStage && args[0] === "rev-parse") captureRevParseSpawns++;
    });
    const memoized = await planGitSections(
      rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
        beforeCapturePool: () => { captureStage = true; },
        onPostCaptureRepoCtxRead: (rel) => freshContextReads.push(rel),
      },
    );
    expect(memoized.carried).toEqual(rels);
    expect(freshContextReads).toEqual([]);
    expect(captureRevParseSpawns).toBe(0);
    expect(memoized.packedRefsIdentity?.[rels[0]!]!.mtimeMs).toBeGreaterThan(baseline);
    expect(gitPlanSurface(memoized)).toEqual(gitPlanSurface(legacy));
  } finally {
    setGitSpawnObserver(undefined);
    if (previous === undefined) delete process.env.RBOX_GIT_ABSENCE_CAPTURE;
    else process.env.RBOX_GIT_ABSENCE_CAPTURE = previous;
  }
}, 20_000);

test("design 200 forced recapture cannot turn an unreadable ref store into a zero-ref repository omission", async () => {
  const repo = path.join(rootA, "strict-force");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const base = repoRecordsForState(state)["strict-force"]!.base!;
  await fs.writeFile(path.join(repo, ".git", "refs", "heads", "broken"), "not-an-oid\n");

  const plan = await planGitSections(
    rootA,
    cfgA,
    state,
    remote,
    new Set(["strict-force"]),
    buildIgnoreMatcher(rootA),
  );
  expect(plan.gitRepos?.["strict-force"]).toEqual(base);
  expect(plan.captured).not.toContain("strict-force");
  expect(plan.carried).toContain("strict-force");
  expect(plan.captureDeferrals["strict-force"]).toBe("ref-read-unreadable");
  expect(plan.absentBranchProofs?.["strict-force"]).toBeUndefined();
}, 20_000);

test("Step D context loss after capture carries the section with one typed refusal and no tombstone", async () => {
  const repo = path.join(rootA, "step-d-context-loss");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const base = repoRecordsForState(state)["step-d-context-loss"]!.base!;
  await git(repo, "branch", "-D", "topic");
  const gitDir = path.join(repo, ".git");
  const hiddenGitDir = path.join(repo, ".git-step-d-hidden");
  let moved = false;
  const plan = await planGitSections(
    rootA,
    cfgA,
    state,
    remote,
    new Set(),
    buildIgnoreMatcher(rootA),
    undefined,
    undefined,
    {
      beforeAbsenceWitness: async (rel) => {
        if (rel === "step-d-context-loss") {
          await fs.rename(gitDir, hiddenGitDir);
          moved = true;
        }
      },
    },
  ).finally(async () => {
    if (moved) await fs.rename(hiddenGitDir, gitDir);
  });
  expect(plan.gitRepos?.["step-d-context-loss"]).toEqual(base);
  expect(plan.captureDeferrals["step-d-context-loss"]).toBe("unreadable");
  expect(plan.deferred.filter((item) => item.relPath === "step-d-context-loss")).toHaveLength(1);
  expect(plan.absentBranchProofs?.["step-d-context-loss"]).toBeUndefined();
  expect(plan.gitRepos?.["step-d-context-loss"]?.refTombstones?.["refs/heads/topic"]).toBeUndefined();
}, 20_000);

test("Step D HEAD read failure refuses only that repository and never aborts the push plan", async () => {
  const refusedRepo = path.join(rootA, "head-read-refused");
  const healthyRepo = path.join(rootA, "head-read-healthy");
  for (const repo of [refusedRepo, healthyRepo]) {
    await initRepo(repo);
    await commitFile(repo, "f.txt", "one", "c1");
  }
  await git(refusedRepo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const refusedBase = repoRecordsForState(state)["head-read-refused"]!.base!;
  await git(refusedRepo, "branch", "-D", "topic");
  await commitFile(healthyRepo, "f.txt", "two", "healthy c2");
  const healthyTip = await git(healthyRepo, "rev-parse", "HEAD");
  const headPath = path.join(refusedRepo, ".git", "HEAD");
  const hiddenHead = path.join(refusedRepo, ".git", "HEAD.step-d-hidden");
  let moved = false;
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
    undefined, undefined, {
      beforeAbsencePreflight: async (rel) => {
        if (rel === "head-read-refused") {
          await fs.rename(headPath, hiddenHead);
          moved = true;
        }
      },
    },
  ).finally(async () => {
    if (moved) await fs.rename(hiddenHead, headPath);
  });
  expect(plan.gitRepos?.["head-read-refused"]).toEqual(refusedBase);
  expect(plan.captureDeferrals["head-read-refused"]).toBe("unreadable");
  expect(plan.gitRepos?.["head-read-healthy"]?.refs["refs/heads/main"]).toBe(healthyTip);
}, 30_000);

test("Step D unreadable worktree registry is a per-repository refusal, never an empty ownership map", async () => {
  const repo = path.join(rootA, "worktree-registry-refused");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const base = repoRecordsForState(state)["worktree-registry-refused"]!.base!;
  await git(repo, "branch", "-D", "topic");
  const configPath = path.join(repo, ".git", "config");
  const originalConfig = await fs.readFile(configPath);
  let corrupted = false;
  const plan = await planGitSections(
    rootA, cfgA, state, remote, new Set(), buildIgnoreMatcher(rootA),
    undefined, undefined, {
      beforeAbsencePreflight: async (rel) => {
        if (rel === "worktree-registry-refused") {
          await fs.appendFile(configPath, "\n[broken\n");
          corrupted = true;
        }
      },
    },
  ).finally(async () => {
    if (corrupted) await fs.writeFile(configPath, originalConfig);
  });
  expect(plan.gitRepos?.["worktree-registry-refused"]).toEqual(base);
  expect(plan.captureDeferrals["worktree-registry-refused"]).toBe("unreadable");
  expect(plan.absentBranchProofs?.["worktree-registry-refused"]).toBeUndefined();
}, 20_000);

test("design 200 a standing missing-origin refusal remains a typed whole-repository carry", async () => {
  const repo = path.join(rootA, "standing-refusal");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const record = repoRecordsForState(state)["standing-refusal"]!;
  const base = record.base!;
  const topicOid = base.refs["refs/heads/topic"]!;
  delete record.branchBaseOrigins?.["refs/heads/topic"];
  // Design 309: a section this device captured would now count as origin
  // evidence, so the standing refusal under test needs a foreign author stamp.
  state.repoRecords!["standing-refusal"] = { ...state.repoRecords!["standing-refusal"]!, base: { ...base, deviceId: "dev_00000000" } };
  await saveStateUnsafeLegacyOrTest(rootA, state);
  await git(repo, "branch", "-D", "topic");

  for (let cycle = 0; cycle < 2; cycle++) {
    await push(rootA, cfgA, depsA);
    const carried = (await remote.latest()).manifest.gitRepos!["standing-refusal"]!;
    expect(carried.refs["refs/heads/topic"]).toBe(topicOid);
    expect(carried.refTombstones?.["refs/heads/topic"]?.some((entry) => entry.oid === topicOid)).not.toBe(true);
    expect(repoRecordsForState(await st(rootA))["standing-refusal"]?.deferrals?.capture?.reason).toBe("deletion-pending");
  }
}, 20_000);

test("backdated packed-refs restore is a standing refusal until a ref rewrite advances mtime", async () => {
  const repo = path.join(rootA, "backdated-packed");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await git(repo, "update-ref", "refs/heads/mtime-nudge", "HEAD");
  await git(repo, "pack-refs", "--all");
  await push(rootA, cfgA, depsA);
  const record = repoRecordsForState(await st(rootA))["backdated-packed"]!;
  const topicOid = record.base!.refs["refs/heads/topic"]!;
  const baseline = record.packedRefsIdentity!.mtimeMs;

  await git(repo, "branch", "-D", "topic");
  const packedPath = path.join(repo, ".git", "packed-refs");
  const older = new Date(baseline - 60_000);
  await fs.utimes(packedPath, older, older);
  for (let cycle = 0; cycle < 2; cycle++) {
    await push(rootA, cfgA, depsA);
    const current = repoRecordsForState(await st(rootA))["backdated-packed"]!;
    expect(current.base?.refs["refs/heads/topic"]).toBe(topicOid);
    expect(current.packedRefsIdentity?.mtimeMs).toBe(baseline);
    expect(current.deferrals?.capture?.reason).toBe("deletion-pending");
  }

  await git(repo, "update-ref", "refs/heads/mtime-clear", "HEAD");
  await git(repo, "pack-refs", "--all");
  await push(rootA, cfgA, depsA);
  const accepted = repoRecordsForState(await st(rootA))["backdated-packed"]!;
  expect(accepted.base?.refs["refs/heads/topic"]).toBeUndefined();
  expect(accepted.deferrals?.capture).toBeUndefined();
}, 30_000);

test("packed-refs ENOENT clears the baseline and never wedges branch deletion across three cycles", async () => {
  const repo = path.join(rootA, "packed-enoent");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "one", "c1");
  await git(repo, "branch", "topic");
  await git(repo, "pack-refs", "--all");
  await push(rootA, cfgA, depsA);
  const before = repoRecordsForState(await st(rootA))["packed-enoent"]!;
  const mainOid = before.base!.refs["refs/heads/main"]!;
  const topicOid = before.base!.refs["refs/heads/topic"]!;
  await fs.mkdir(path.join(repo, ".git", "refs", "heads"), { recursive: true });
  await fs.writeFile(path.join(repo, ".git", "refs", "heads", "main"), `${mainOid}\n`);
  await fs.writeFile(path.join(repo, ".git", "refs", "heads", "topic"), `${topicOid}\n`);
  await fs.rm(path.join(repo, ".git", "packed-refs"));
  await git(repo, "branch", "-D", "topic");

  for (let cycle = 0; cycle < 3; cycle++) {
    await push(rootA, cfgA, depsA);
    const current = repoRecordsForState(await st(rootA))["packed-enoent"]!;
    expect(current.packedRefsIdentity).toBeUndefined();
    expect(current.base?.refs["refs/heads/topic"]).toBeUndefined();
    expect(current.deferrals?.capture).toBeUndefined();
  }
}, 30_000);

test("new repository at a previously removed path publishes in one cycle without deletion-pending and clears repoAbsent", async () => {
  const repo = path.join(rootA, "one-cycle-readd");
  await initRepo(repo);
  await commitFile(repo, "old.txt", "old", "old");
  await git(repo, "branch", "old-side");
  await push(rootA, cfgA, depsA);
  await fs.rm(repo, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  expect(repoRecordsForState(await st(rootA))["one-cycle-readd"]?.repoAbsent).toBe(true);

  await initRepo(repo);
  await commitFile(repo, "new.txt", "new", "new");
  await push(rootA, cfgA, depsA);
  const remoteSection = (await remote.latest()).manifest.gitRepos?.["one-cycle-readd"];
  const record = repoRecordsForState(await st(rootA))["one-cycle-readd"]!;
  expect(remoteSection).toBeDefined();
  expect(record.repoAbsent).toBeUndefined();
  expect(record.removedKey).toBeUndefined();
  expect(record.deferrals?.capture?.reason).not.toBe("deletion-pending");
}, 30_000);

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
}, 90_000);

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
  await saveStateUnsafeLegacyOrTest(rootA, { ...state, gitNeedsResolution: { proj1: gitIdentityKey(await gitIdentity(p1)) } });
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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

test("gitDivergenceCount stable-pair retry avoids stale cache under mid-probe mutation", async () => {
  const repo = path.join(rootA, "stable");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);
  await fs.rm(path.join(rootA, ".rbox", "state", "git-divergence.json"), { force: true });

  let mutated = false;
  setGitSpawnObserver((spawnRoot, args) => {
    if (mutated || spawnRoot !== repo || args.at(-1) !== "write-tree") return;
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
}, 120_000);

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
}, 120_000);

// ── design 204-C: lazy git-plan ─────────────────────────────────────────────────

test("design 204 C1/C15: no-journal lazy plan skips only recovery and is byte-faithful to legacy", async () => {
  const rel = "lazy-fidelity";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await git(repo, "branch", "topic");
  await push(rootA, cfgA, depsA);
  await git(repo, "branch", "-D", "topic");
  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);

  const legacyRecovery: string[] = [];
  process.env.RBOX_GIT_PLAN_LAZY = "0";
  const legacy = await planGitSections(rootA, cfgA, state, remote, new Set(), matcher, undefined, noBackoff, {
    onJournalRecovery: (seen) => legacyRecovery.push(seen),
  });

  const lazyRecovery: string[] = [];
  process.env.RBOX_GIT_PLAN_LAZY = "1";
  const lazy = await planGitSections(rootA, cfgA, state, remote, new Set(), matcher, undefined, noBackoff, {
    onJournalRecovery: (seen) => lazyRecovery.push(seen),
  });

  const stableSurface = (value: GitPushPlan) => JSON.parse(JSON.stringify(gitPlanSurface(value)), (key, item) =>
    key === "generatedAt" || key === "ts" ? "<time>" : item);
  expect(legacyRecovery).toEqual([rel]);
  expect(lazyRecovery).toEqual([]);
  expect(stableSurface(lazy)).toEqual(stableSurface(legacy));
  expect(JSON.stringify(lazy.publisherAckBindings)).toBe(JSON.stringify(legacy.publisherAckBindings));
  expect(JSON.stringify(lazy.absentBranchProofs)).toBe(JSON.stringify(legacy.absentBranchProofs));
}, 60_000);

test("design 204 C1/C13: a journal appearing after the lazy probe is untouched until the next plan", async () => {
  const rel = "lazy-journal-race";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  const journalDir = checkoutJournalDir(rootA, rel);
  const firstRecoveries: string[] = [];
  process.env.RBOX_GIT_PLAN_LAZY = "1";

  await planGitSections(rootA, cfgA, state, remote, new Set(), matcher, undefined, noBackoff, {
    onJournalRecovery: (seen) => firstRecoveries.push(seen),
    afterJournalPreloop: async () => {
      await fs.mkdir(journalDir, { recursive: true });
    },
  });
  expect(firstRecoveries).toEqual([]);
  expect(await fs.lstat(journalDir).then(() => true, () => false)).toBe(true);

  const nextRecoveries: string[] = [];
  await planGitSections(rootA, cfgA, state, remote, new Set(), matcher, undefined, noBackoff, {
    onJournalRecovery: (seen) => nextRecoveries.push(seen),
  });
  expect(nextRecoveries).toEqual([rel]);
}, 60_000);

test("design 204 C1: pending supersession and publisher ACK binding are identical without a journal", async () => {
  const rel = "lazy-pending";
  await prepareSupersedingPending(rel);
  const state = await st(rootB);
  const matcher = buildIgnoreMatcher(rootB);

  process.env.RBOX_GIT_PLAN_LAZY = "0";
  const legacy = await planGitSections(rootB, cfgB, state, remote, new Set(), matcher);
  process.env.RBOX_GIT_PLAN_LAZY = "1";
  const lazy = await planGitSections(rootB, cfgB, state, remote, new Set(), matcher);

  expect(lazy.supersededPending).toEqual(legacy.supersededPending);
  expect(lazy.supersessionIdentityKeys).toEqual(legacy.supersessionIdentityKeys);
  expect(JSON.stringify(lazy.publisherAckBindings)).toBe(JSON.stringify(legacy.publisherAckBindings));
  expect({ ...lazy.gitRepos?.[rel], generatedAt: "<time>" })
    .toEqual({ ...legacy.gitRepos?.[rel], generatedAt: "<time>" });
}, 90_000);

test("design 204 C2: pre-capture ctx memo is cleared before a dir-to-pointer flip", async () => {
  const rel = "lazy-ctx-flip";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  await markDivergenceCacheTrusted(rootA);
  process.env.RBOX_GIT_PLAN_LAZY = "1";
  const observed: Array<{ rel: string; kind?: string }> = [];
  const movedGit = path.join(rootA, "lazy-ctx-flip-gitdir");

  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
    beforeCapturePool: async () => {
      await fs.rename(path.join(repo, ".git"), movedGit);
      await fs.writeFile(path.join(repo, ".git"), "gitdir: ../lazy-ctx-flip-gitdir\n");
    },
    onHygieneCtx: (seen, ctx) => {
      if (seen === rel) observed.push({ rel: seen, kind: ctx?.kind });
    },
  });

  expect(observed.some(({ rel: seen, kind }) => seen === rel && kind === "pointer")).toBe(true);
}, 60_000);

test("design 243: timing buckets are an exclusive partition and are summarized", async () => {
  const repo = path.join(rootA, "lazy-timings");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  process.env.RBOX_GIT_PLAN_LAZY = "1";
  const plan = await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  const stats = plan.gitPlanStats!;
  const topLevelKeys = [
    "setupMs", "discoverMs", "removalPruneMs", "journalPreloopMs", "carryMs",
    "fingerprintMs", "captureMs", "projectionMs", "finalizeMs", "hygieneMs",
    "divergenceCacheMs",
  ] as const;
  for (const key of [...topLevelKeys, "otherMs"] as const) {
    expect(Number.isFinite(stats[key])).toBe(true);
    expect(stats[key]).toBeGreaterThanOrEqual(0);
    expect(stats[key]).toBeLessThanOrEqual(stats.totalMs);
  }
  const namedMs = topLevelKeys.reduce((sum, key) => sum + stats[key], 0);
  expect(namedMs).toBeLessThanOrEqual(stats.totalMs);
  expect(stats.otherMs).toBeCloseTo(stats.totalMs - namedMs, 8);
  const summary = formatGitPlanStats(stats);
  expect(summary).toContain("ms[t");
  for (const marker of [" s", " d", " rm", " j", " cy", " f", " cp", " pr", " fn", " h", " dc", " o"]) {
    expect(summary).toContain(marker);
  }
}, 60_000);

test("design 298 attributes a slow git plan to at most three repositories and stays quiet when fast", async () => {
  for (const rel of ["attrib-a", "attrib-b", "attrib-c", "attrib-d"]) {
    await initRepo(path.join(rootA, rel));
    await commitFile(path.join(rootA, rel), "f.txt", rel, "c1");
  }
  const logs: string[] = [];
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
    onGitLog: (line) => logs.push(line),
    onCaptureQueued: (rel) => {
      if (rel !== "attrib-a") return;
      const until = performance.now() + 525;
      while (performance.now() < until) { /* existing synchronous test seam */ }
    },
  });
  const line = logs.find((entry) => entry.startsWith("git-plan slowest: "));
  expect(line).toBeDefined();
  const [repoPart, stagePart] = line!.slice("git-plan slowest: ".length).split(" | ");
  expect(stagePart).toMatch(/^stages start=\d+ pool=\d+ carried=\d+\[ctx=\d+ packed=\d+ repos=\d+ freshCtx=\d+\] discover=\d+$/);
  const entries = repoPart!.split("; ");
  expect(entries.length).toBeLessThanOrEqual(3);
  expect(entries[0]).toMatch(/^attrib-a fp=untrusted cp=\d+ d=\d+$/);
  const totals = entries.map((entry) => {
    const [, capture, discover] = entry.match(/ cp=(\d+) d=(\d+)$/)!;
    return Number(capture) + Number(discover);
  });
  expect(totals).toEqual([...totals].sort((a, b) => b - a));

  const fastLogs: string[] = [];
  await planGitSections(rootB, cfgB, await st(rootB), remote, new Set(), buildIgnoreMatcher(rootB), undefined, noBackoff, {
    onGitLog: (entry) => fastLogs.push(entry),
  });
  expect(fastLogs.some((entry) => entry.startsWith("git-plan slowest: "))).toBe(false);
}, 60_000);

// ── design 83: push-side git-plan fingerprint cache ─────────────────────────────

test("steady-state all-hit git plan has no sidecar changes", async () => {
  for (const rel of ["steady-a", "steady-b"]) {
    const repo = path.join(rootA, rel);
    await initRepo(repo);
    await commitFile(repo, "f.txt", rel, "c1");
  }
  await push(rootA, cfgA, depsA);
  for (const rel of ["steady-a", "steady-b"]) {
    await commitFile(path.join(rootA, rel), "f.txt", `${rel}-next`, "c2");
  }
  await push(rootA, cfgA, depsA);

  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  await planGitSections(rootA, cfgA, state, remote, new Set(), matcher);
  await markDivergenceCacheTrusted(rootA);
  const plan = await planGitSections(rootA, cfgA, state, remote, new Set(), matcher);
  expect(plan.gitPlanStats?.fpHits).toBe(2);
  expect(plan.gitPlanStats?.fpMisses).toBe(0);
  expect(plan.captured).toEqual([]);
  expect(plan.deferred).toEqual([]);

  const records = repoRecordsForState(state);
  const deferralUpdates: Record<string, OrderedGitDeferralUpdates> = {};
  const now = "2026-07-19T12:00:00.000Z";
  for (const rel of plan.captureObserved) {
    const current = records[rel]?.deferrals;
    const lanes: GitDeferralUpdates = {};
    const captureReason = plan.captureDeferrals[rel];
    if (captureReason) lanes.capture = nextDeferral("capture", current?.capture, captureReason, now);
    else if (current?.capture) lanes.capture = null;
    if (plan.configObserved.includes(rel)) {
      const configReason = plan.configDeferrals[rel];
      if (configReason) lanes.config = nextDeferral("config", current?.config, configReason, now);
      else if (current?.config) lanes.config = null;
    }
    const ordered = orderedDeferralUpdates(current, lanes);
    if (ordered !== undefined) deferralUpdates[rel] = ordered;
  }
  const deferralChurningRepoKeys = changedSidecarRepoKeys(state, {
    bases: state.lastSyncedManifest.gitRepos,
    pending: state.gitPendingRemote,
    removed: state.gitReposRemoved,
    resolutions: state.gitNeedsResolution,
    deferrals: deferralUpdates,
  });
  const churningRepoKeys = changedSidecarRepoKeys(state, {
    bases: state.lastSyncedManifest.gitRepos,
    repoAbsent: plan.repoAbsent ?? {},
    pending: plan.gitPendingRemote,
    removed: plan.gitReposRemoved,
    resolutions: plan.gitNeedsResolution,
  });
  const steadyPush = await push(rootA, cfgA, depsA);
  const after = await st(rootA);
  expect({
    committed: steadyPush.committed,
    deferralChurningRepoKeys,
    churningRepoKeys,
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: after.stateRevision,
  }, `churningRepoKeys=${JSON.stringify({ deferralChurningRepoKeys, churningRepoKeys })}`).toEqual({
    committed: false,
    deferralChurningRepoKeys: [],
    churningRepoKeys: [],
    stateRevisionBefore: state.stateRevision,
    stateRevisionAfter: state.stateRevision,
  });
}, 120_000);

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
}, 120_000);

test("design 83: racy-clean margin refuses a hash-matching entry and takes the spawn path", async () => {
  const repo = path.join(rootA, "d83-margin");
  await initRepo(repo);
  await commitFile(repo, "f.txt", "base", "c1");
  await push(rootA, cfgA, depsA);

  let cache = await readDivergenceCache(rootA);
  for (const entry of Object.values(cache.repos ?? {})) {
    if (entry) entry.writtenAtMs = 0;
  }
  await writeDivergenceCache(rootA, cache);

  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  cache = await readDivergenceCache(rootA);
  for (const entry of Object.values(cache.repos ?? {})) {
    if (entry) entry.writtenAtMs = 0;
  }
  await writeDivergenceCache(rootA, cache);

  const plan = await observeGitSpawns(async () => planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA)));
  expect(plan.value.gitPlanStats?.fpUntrusted).toBe(1);
  expect(plan.value.gitPlanStats?.spawnedRepos).toBe(1);
  expect(plan.spawns).toBeGreaterThan(0);
}, 120_000);

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
  process.env.RBOX_GIT_PLAN_LAZY = "1";
  const { W } = await makeInTreeMainWithWorktree();
  const wtSection = (await captureGitState(W, remote.blobStore(), KEK))!;
  const s0 = await st(rootA);
  await saveStateUnsafeLegacyOrTest(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection } } });
  await push(rootA, cfgA, depsA);
  // D.3 makes the newly discovered main clone baseless PENDING after the
  // legacy fixture's first ACK. Let the exact composer proof converge it before
  // this test measures steady-state cache behavior.
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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
}, 120_000);

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
  // D.3: pending still bypasses the pointer pre-skip, but an exact ACK-composer
  // dry run may admit a fresh candidate instead of forcing a byte carry.
  expect(pending.value.captured).toContain("wt");
  expect(pending.value.supersededPending).toContain("wt");
  expect(pending.targetSpawns).toBeGreaterThan(0);

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
}, 120_000);

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
  expect(pending.gitPlanStats?.spawnedRepos).toBeGreaterThan(0);
  expect(pending.supersededPending).toEqual([rel]);
  expect(pending.protectedPending).toEqual([rel]);

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
}, 120_000);

test("steady plan queues only one changed repo while retaining all 100 repo counts", async () => {
  for (let i = 0; i < 100; i++) {
    const rel = `queue-${i.toString().padStart(3, "0")}`;
    const repo = path.join(rootA, rel);
    await initRepo(repo);
    await commitFile(repo, "f.txt", rel, "initial");
  }
  await push(rootA, cfgA, depsA);
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  await markDivergenceCacheTrusted(rootA);
  await commitFile(path.join(rootA, "queue-042"), "changed.txt", "changed", "changed");

  const queued: string[] = [];
  const plan = await planGitSections(
    rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA),
    undefined, noBackoff, { onCaptureQueued: (rel) => queued.push(rel) },
  );

  expect(queued).toEqual(["queue-042"]);
  expect(plan.gitPlanStats?.repos).toBe(100);
  expect(plan.captured).toEqual(["queue-042"]);
  expect(plan.carried).toHaveLength(99);
  expect(formatGitPushLine(plan)).toContain("captured 1 (queue-042) · carried 99");
}, 120_000);

test("design 174 B: a ref reset between maybe-probe and capture fails final candidate proof and carries P", async () => {
  const rel = "supersede-race";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "base.txt", "base", "base");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const pending = state.lastSyncedManifest.gitRepos![rel]!;
  const original = await git(repo, "rev-parse", "refs/heads/main");

  await git(repo, "switch", "--orphan", "race-unrelated");
  await commitFile(repo, "other.txt", "other", "unrelated");
  const unrelated = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-q", "main");
  await git(repo, "branch", "-D", "race-unrelated");

  const counted = countingGitRemote(remote);
  const plan = await planGitSections(
    rootA, cfgA, { ...state, gitPendingRemote: { [rel]: pending } }, counted.api,
    new Set(), buildIgnoreMatcher(rootA), undefined, undefined,
    { afterPendingPreProbe: async (candidateRel) => {
      expect(candidateRel).toBe(rel);
      await git(repo, "update-ref", "refs/heads/main", unrelated, original);
    } },
  );
  expect(plan.supersededPending).toEqual([]);
  expect(plan.gitRepos?.[rel]).toBe(pending);
  expect(plan.carried).toContain(rel);
  expect(plan.deferred.some((entry) => entry.relPath === rel && entry.reason.includes("did not supersede"))).toBe(true);
  // Design 226 §0, the headline regression: this tick FORCE-CAPTURED the candidate and
  // then discarded it. Zero store writes — not "few" — and no retained ciphertext left.
  expect(counted.writes()).toBe(0);
  expect(await retainedGitCiphertext(rootA)).toEqual([]);
}, 20_000);

test("#573: a refused supersession is not re-captured every push, and any change re-captures it", async () => {
  const rel = "supersede-refusal-memo";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "base.txt", "base", "base");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const pending = state.lastSyncedManifest.gitRepos![rel]!;

  // Diverge main off the pending tip: presence-only pre-probe admits it, the final
  // proof's fast-forward requirement refuses it — the field shape of #573.
  await git(repo, "switch", "--orphan", "refusal-unrelated");
  await commitFile(repo, "other.txt", "other", "unrelated");
  const unrelated = await git(repo, "rev-parse", "HEAD");
  await git(repo, "switch", "-q", "main");
  await git(repo, "branch", "-D", "refusal-unrelated");
  await git(repo, "update-ref", "refs/heads/main", unrelated);

  const planOnce = async (): Promise<{ plan: GitPushPlan; queued: string[]; writes: number }> => {
    const queued: string[] = [];
    const counted = countingGitRemote(remote);
    const plan = await planGitSections(
      rootA, cfgA, { ...state, gitPendingRemote: { [rel]: pending } }, counted.api,
      new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff,
      { onCaptureQueued: (candidate) => queued.push(candidate) },
    );
    return { plan, queued, writes: counted.writes() };
  };

  const first = await planOnce();
  expect(first.queued).toEqual([rel]);
  expect(first.plan.supersededPending).toEqual([]);
  expect(first.plan.gitRepos?.[rel]).toEqual(pending);

  await markDivergenceCacheTrusted(rootA);
  const second = await planOnce();
  expect(second.queued).toEqual([]); // the whole capture, not just its uploads
  expect(second.writes).toBe(0);
  // Every push-visible outcome is identical to the capture-and-revert it replaced,
  // except that a capture that never ran observes no config. That observation is inert
  // for this repo: a protected-pending repo is skipped by the durable deferral writer.
  expect(second.plan.protectedPending).toContain(rel);
  expect({ ...gitPlanSurface(second.plan), configObserved: first.plan.configObserved })
    .toEqual(gitPlanSurface(first.plan));
  expect(second.plan.deferred.some((entry) =>
    entry.relPath === rel && entry.reason.includes("did not supersede"))).toBe(true);
  expect(await retainedGitCiphertext(rootA)).toEqual([]);

  // Invalidation: the repository moved, so the recorded verdict is no longer evidence.
  await commitFile(repo, "moved.txt", "moved", "moved");
  const third = await planOnce();
  expect(third.queued).toEqual([rel]);
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
}, 120_000);

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
  expect(cache.repos?.["d83-cross-writer"]?.writtenAtMs).toEqual(expect.any(Number));
  expect(cache.repos?.["d83-cross-writer"]?.probe?.identityKey).toEqual(expect.any(String));

  await fs.rm(divergenceCachePath(rootA), { force: true });
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA));
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), buildIgnoreMatcher(rootA))).toBe(0);
  cache = await readDivergenceCache(rootA);
  expect(cache.version).toBe(GIT_FINGERPRINT_VERSION);
  expect(cache.repos?.["d83-cross-writer"]?.writtenAtMs).toEqual(expect.any(Number));
  expect(cache.repos?.["d83-cross-writer"]?.probe?.identityKey).toEqual(expect.any(String));
}, 120_000);

// ── gitcap progress (the long silent phase on a repo-heavy first push) ───────────

test("push emits gitcap progress per CAPTURED repo — monotonic settle count, repo names as detail, capture-scoped total", async () => {
  const alpha = path.join(rootA, "alpha");
  await initRepo(alpha);
  await commitFile(alpha, "a.txt", "a", "c1");
  const beta = path.join(rootA, "sub", "beta");
  await initRepo(beta);
  await commitFile(beta, "b.txt", "b", "c1");

  type Ev = { done: number; total: number; detail?: string; bytesDone?: number; bytesTotal?: number };
  const cap = () => {
    const events: Ev[] = [];
    const logs: string[] = [];
    const summaries: GitPushPlan[] = [];
    return {
      events,
      logs,
      summaries,
      deps: {
        ...depsA,
        onGitLog: (line, pushPlan) => {
          logs.push(line);
          if (pushPlan) summaries.push(pushPlan);
        },
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
  // Detail is the workspace-relative repo path, so nested repositories stay unique.
  expect(new Set(first.events.map((e) => e.detail))).toEqual(new Set(["alpha", "sub/beta"]));
  // Interactive sinks receive structure without changing the forensic log payload.
  expect(first.summaries).toHaveLength(1);
  expect(first.logs).toEqual([formatGitPushLine(first.summaries[0]!)]);

  // A second push with nothing changed CARRIES both repos (no capture) → zero gitcap
  // events. Proves the denominator is capture-scoped, not repo-count-scoped.
  const second = cap();
  await push(rootA, cfgA, second.deps);
  expect(second.events.length).toBe(0);
});

// ── design 226: git capture uploads AFTER the decision ───────────────────────────

test("design 226: a superseding candidate's artifacts are all flushed before the plan returns", async () => {
  const rel = "flush-supersede";
  await prepareSupersedingPending(rel);
  const store = remote.blobStore();
  const counted = countingGitRemote(remote);

  const plan = await planGitSections(
    rootB, cfgB, await st(rootB), counted.api, new Set(), buildIgnoreMatcher(rootB),
    undefined, noBackoff, { onGitLog: (l) => logsB.push(l) },
  );

  expect(plan.supersededPending).toEqual([rel]);
  const refs = gitSectionBlobRefs(plan.gitRepos![rel]!);
  expect(refs.length).toBeGreaterThan(0);
  // Satisfied at RETURN, i.e. inside the git-plan phase — long before api.commit sends
  // the refset. A flush wired after the commit would leave these absent here.
  for (const ref of refs) expect(await store.has(ref.encSha)).toBe(true);
  expect(counted.writes()).toBeGreaterThan(0);
  expect(await retainedGitCiphertext(rootB)).toEqual([]);
}, 90_000);

test("design 226: one artifact PUT failure rejects the whole plan, publishes nothing, and is recoverable", async () => {
  const one = path.join(rootA, "barrier-one");
  const two = path.join(rootA, "barrier-two");
  await initRepo(one);
  await commitFile(one, "f.txt", "v1", "c1");
  await initRepo(two);
  await commitFile(two, "g.txt", "v1", "c1");
  const seqBefore = remote.headSeq();
  remote.failNextGitPut = true;

  await expect(planGitSections(
    rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA),
    undefined, noBackoff, { onGitLog: () => {} },
  )).rejects.toThrow(/upload failed/);

  expect(remote.headSeq()).toBe(seqBefore); // no manifest, so no repo's section published
  expect(await retainedGitCiphertext(rootA)).toEqual([]); // finally sweep ran on the throw

  // Recoverable: the rejection left no half-applied state the next push cannot redo.
  await push(rootA, cfgA, depsA);
  const healed = (await remote.latest()).manifest;
  expect(healed.gitRepos!["barrier-one"]).toBeDefined();
  expect(healed.gitRepos!["barrier-two"]).toBeDefined();
}, 90_000);

test("design 226: a throw after capture still sweeps every retained ciphertext", async () => {
  const one = path.join(rootA, "sweep-one");
  const two = path.join(rootA, "sweep-two");
  await initRepo(one);
  await commitFile(one, "f.txt", "v1", "c1");
  await initRepo(two);
  await commitFile(two, "g.txt", "v1", "c1");

  // A `has` fault throws at the FIRST flush point, with the second repo's ciphertext
  // still retained and nothing yet uploaded — the exception path the sweep must cover.
  const failing: SyncRemote = new Proxy(remote, {
    get(target, prop) {
      if (prop === "blobStore") {
        const inner = target.blobStore();
        return () => ({ ...inner, has: async () => { throw new Error("catalog probe failed"); } });
      }
      const value = Reflect.get(target, prop, target);
      return value instanceof Function ? value.bind(target) : value;
    },
  });

  await expect(planGitSections(
    rootA, cfgA, await st(rootA), failing, new Set(), buildIgnoreMatcher(rootA),
    undefined, noBackoff, { onGitLog: () => {} },
  )).rejects.toThrow(/catalog probe failed/);
  expect(await retainedGitCiphertext(rootA)).toEqual([]);
}, 90_000);

test("design 226: pack recompaction retains per call and flushes ONLY the second capture", async () => {
  cfgA = { ...cfgA, git: { incremental: true } };
  const rel = "recompact";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);

  // A one-byte base makes ANY increment trip exceedsPackChainByteBound, so
  // capturePlannedGitSection takes the second (full) capture path.
  const sA = await st(rootA);
  const base = sA.lastSyncedManifest.gitRepos![rel]!;
  await saveStateUnsafeLegacyOrTest(rootA, {
    ...sA,
    lastSyncedManifest: { ...sA.lastSyncedManifest, gitRepos: { [rel]: { ...base, bundleCipherSize: 1 } } },
  });
  await commitFile(repo, "f.txt", "v2", "c2");

  const counted = countingGitRemote(remote);
  const plan = await planGitSections(
    rootA, cfgA, await st(rootA), counted.api, new Set(), buildIgnoreMatcher(rootA),
    undefined, noBackoff, { onGitLog: () => {} },
  );

  const recompacted = plan.gitRepos![rel]!;
  expect(recompacted.packChain).toBeUndefined(); // the full recapture, not the increment
  // Exactly the surviving section's artifacts — the discarded first capture's bundle is
  // retained but NEVER sent (its per-call path kept it from colliding with the second's).
  expect(counted.writes()).toBe(gitSectionBlobRefs(recompacted).length);
  expect(await retainedGitCiphertext(rootA)).toEqual([]);
}, 120_000);

test("design 226: gitForceForMissingBlobs still re-flushes an artifact the server lost", async () => {
  const rel = "force-recover";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const committed = (await st(rootA)).lastSyncedManifest.gitRepos![rel]!;
  const store = remote.blobStore();
  remote.deleteBlob(committed.bundleEncSha);
  expect(await store.has(committed.bundleEncSha)).toBe(false);

  const counted = countingGitRemote(remote);
  const plan = await planGitSections(
    rootA, cfgA, await st(rootA), counted.api, new Set([rel]), buildIgnoreMatcher(rootA),
    undefined, noBackoff, { onGitLog: () => {} },
  );

  expect(plan.captured).toContain(rel);
  // The per-plan dedupe set starts empty every plan, so recovery is never short-circuited.
  expect(counted.writes()).toBeGreaterThan(0);
  for (const ref of gitSectionBlobRefs(plan.gitRepos![rel]!)) {
    expect(await store.has(ref.encSha)).toBe(true);
  }
  expect(await retainedGitCiphertext(rootA)).toEqual([]);
}, 90_000);

test("design 307: ordinary planning reuses exact topology without re-reporting and matches a fresh walk", async () => {
  const rel = "topology-stable";
  const repo = path.join(rootA, rel);
  await initRepo(repo);
  await commitFile(repo, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  const matcher = buildIgnoreMatcher(rootA);
  const observations: Array<{ repos: readonly { relPath: string }[]; complete: boolean }> = [];

  const walked = await planGitSections(rootA, cfgA, state, remote, new Set(), matcher, undefined, noBackoff, {
    onGitReposDiscovered: async (observation) => { observations.push(observation); },
  });
  expect(observations).toEqual([{ repos: [{ relPath: rel, kind: "dir" }], complete: true }]);

  observations.length = 0;
  const reused = await planGitSections(rootA, cfgA, state, remote, new Set(), matcher, undefined, noBackoff, {
    trustedGitTopology: () => [{ relPath: rel, kind: "dir" }],
    onGitReposDiscovered: async (observation) => { observations.push(observation); },
  });
  expect(observations).toEqual([]);
  const stable = (plan: GitPushPlan) => JSON.parse(JSON.stringify(gitPlanSurface(plan)), (key, value) =>
    key === "generatedAt" || key === "ts" ? "<time>" : value);
  expect(stable(reused)).toEqual(stable(walked));
});

test("design 307: invalidation between topology access and planning falls back and captures the new repo", async () => {
  const rel = "appeared-after-certificate";
  const observed: string[][] = [];
  let reads = 0;
  await planGitSections(rootA, cfgA, await st(rootA), remote, new Set(), buildIgnoreMatcher(rootA), undefined, noBackoff, {
    trustedGitTopology: () => {
      reads++;
      fsSync.mkdirSync(path.join(rootA, rel, ".git"), { recursive: true });
      return undefined;
    },
    onGitReposDiscovered: async ({ repos, complete }) => {
      expect(complete).toBe(true);
      observed.push(repos.map((repo) => repo.relPath));
    },
    onGitLog: () => {},
  });
  expect(reads).toBe(1);
  expect(observed).toEqual([[rel]]);
});
