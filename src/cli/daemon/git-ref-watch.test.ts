import { afterEach, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { GIT_REF_SIGNAL_TAIL_TABLE, isGitRefSignal, type BlobStore } from "../../engine/index.js";
import { captureGitState } from "../sync-git/capture.js";
import { type OwnedRefMutationBoundary } from "../sync-git/pins.js";
import {
  GitRefWatchRegistry,
  classifyRefEvent,
  classifyRepoCandidate,
  gitRefSideChannelEligible,
  type GitRefWatchClock,
  type GitRefWatchHandle,
  type GitRefWatchMode,
} from "./git-ref-watch.js";
import { createSignalDebouncer, type GitSignalBatch } from "./watcher.js";

const exec = promisify(execFile);
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "rbox ref watch",
  GIT_AUTHOR_EMAIL: "rbox-ref-watch@local",
  GIT_COMMITTER_NAME: "rbox ref watch",
  GIT_COMMITTER_EMAIL: "rbox-ref-watch@local",
};
const runGit = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args], { env: GIT_ENV }).then(({ stdout }) => stdout.toString().trim());

function memoryBlobStore(): BlobStore {
  const blobs = new Map<string, Buffer>();
  return {
    has: async (sha) => blobs.has(sha),
    put: async (sha, bytes) => { blobs.set(sha, Buffer.from(bytes)); },
    get: async (sha) => {
      const bytes = blobs.get(sha);
      if (!bytes) throw new Error(`missing blob ${sha}`);
      return bytes;
    },
  };
}

const settleWatch = () => new Promise((resolve) => setTimeout(resolve, 300));

test("side-channel construction is Linux Parcel-only", () => {
  expect(gitRefSideChannelEligible("linux", undefined)).toBe(false);
  expect(gitRefSideChannelEligible("linux", "parcel")).toBe(true);
  expect(gitRefSideChannelEligible("linux", "chokidar")).toBe(false);
  expect(gitRefSideChannelEligible("darwin", undefined)).toBe(false);
  expect(gitRefSideChannelEligible("darwin", "parcel")).toBe(false);
});

test("classifyRefEvent covers targets, lock pre-signals, structures, and exclusions by role", () => {
  expect(classifyRefEvent("gitDir", "HEAD")).toBe("target");
  expect(classifyRefEvent("gitDir", "HEAD.lock")).toBe("lockPreSignal");
  expect(classifyRefEvent("commonDir", "packed-refs")).toBe("target");
  expect(classifyRefEvent("commonDir", "packed-refs.lock")).toBe("lockPreSignal");
  expect(classifyRefEvent("commonDir", "refs")).toBe("structure");
  expect(classifyRefEvent("refsRoot", "stash")).toBe("target");
  expect(classifyRefEvent("refsRoot", "stash.lock")).toBe("lockPreSignal");
  expect(classifyRefEvent("refsRoot", "heads")).toBe("structure");
  expect(classifyRefEvent("refsRoot", "tags")).toBe("structure");
  expect(classifyRefEvent("refsNamespace", "nested/topic")).toBe("target");
  expect(classifyRefEvent("refsNamespace", "nested/topic.lock")).toBe("lockPreSignal");

  for (const [role, tail] of [
    ["gitDir", "config"],
    ["gitDir", "packed-refs"],
    ["gitDir", "refs"],
    ["commonDir", "HEAD"],
    ["commonDir", "refs/heads/main"],
    ["refsRoot", "HEAD"],
    ["refsRoot", "packed-refs"],
    ["commonDir", "reftable/tables.list"],
    ["commonDir", "refs/remotes/origin/main"],
    ["commonDir", "refs/rbox-wip/pin"],
    ["refsRoot", "remotes/origin/main"],
    ["refsRoot", "rbox-wip/pin"],
    ["refsNamespace", ""],
    ["refsNamespace", "../escape"],
  ] as const) expect(classifyRefEvent(role, tail), `${role}:${tail}`).toBe("none");
});

test("side-channel targets are equivalent to isGitRefSignal on the non-lock subset", () => {
  const cases = [
    ...GIT_REF_SIGNAL_TAIL_TABLE.gitDir.targets.map((tail) => ({ role: "gitDir" as const, tail, rel: `.git/${tail}` })),
    ...GIT_REF_SIGNAL_TAIL_TABLE.commonDir.targets.map((tail) => ({ role: "commonDir" as const, tail, rel: `.git/${tail}` })),
    ...GIT_REF_SIGNAL_TAIL_TABLE.refsRoot.targets.map((tail) => ({ role: "refsRoot" as const, tail, rel: `.git/refs/${tail}` })),
    ...GIT_REF_SIGNAL_TAIL_TABLE.refsNamespace.parents.map((parent) => ({ role: "refsNamespace" as const, tail: "nested/topic", rel: `.git/${parent}/nested/topic` })),
    { role: "gitDir", tail: "config", rel: ".git/config" },
    { role: "commonDir", tail: "refs/remotes/origin/main", rel: ".git/refs/remotes/origin/main" },
    { role: "refsRoot", tail: "remotes/origin/main", rel: ".git/refs/remotes/origin/main" },
  ] as const;
  for (const { role, tail, rel } of cases) {
    expect(classifyRefEvent(role, tail) === "target", `${role}:${tail}`).toBe(isGitRefSignal(rel));
  }

  // A normal repository contributes both gitDir and commonDir roles to the
  // same physical root; equivalence is over that role union, not wrong-role
  // acceptance by either contributor.
  expect(classifyRefEvent("gitDir", "packed-refs")).toBe("none");
  expect(classifyRefEvent("commonDir", "packed-refs")).toBe("target");
});

test("repo candidate classifier requires the exact .git entry and preserves lifecycle semantics", () => {
  expect(classifyRepoCandidate(".git", "create")).toEqual({ owner: ".", dirty: false, discover: true });
  expect(classifyRepoCandidate("nested/repo/.git", "update")).toEqual({ owner: "nested/repo", dirty: true, discover: true });
  expect(classifyRepoCandidate("nested/repo/.git", "delete")).toEqual({ owner: "nested/repo", dirty: true, discover: false });
  for (const rel of ["nested/.github", "nested/.git-old", "nested/.git/HEAD", "../repo/.git", "nested/.git/"]) {
    expect(classifyRepoCandidate(rel, "create"), rel).toBeUndefined();
  }
});

test("signal debouncer atomically snapshots reason bits and monotonic per-owner candidate work", async () => {
  const batches: GitSignalBatch[] = [];
  let debouncer!: ReturnType<typeof createSignalDebouncer>;
  const complete = new Promise<void>((resolve) => {
    debouncer = createSignalDebouncer((batch) => {
      batches.push(batch);
      if (batches.length === 1) debouncer.push("signal"); // reentrant input belongs to the next snapshot
      else resolve();
    }, 5, 100);
  });

  debouncer.push("candidate", { owner: "repo", dirty: true, discover: false });
  debouncer.push("candidate", { owner: "repo", dirty: false, discover: true });
  debouncer.push("signal");
  await complete;
  debouncer.dispose();

  expect(batches).toHaveLength(2);
  expect(batches[0]).toEqual({
    reasons: { signal: true, candidate: true, other: false },
    candidates: [{ owner: "repo", dirty: true, discover: true }],
    discoverAll: false,
  });
  expect(batches[1]).toEqual({
    reasons: { signal: true, candidate: false, other: false },
    candidates: [],
    discoverAll: false,
  });
});

test("signal debouncer bounds candidate owners and requests full discovery on overflow", async () => {
  let observed!: GitSignalBatch;
  const complete = new Promise<void>((resolve) => {
    const debouncer = createSignalDebouncer((batch) => {
      observed = batch;
      debouncer.dispose();
      resolve();
    }, 5, 100, 2);
    debouncer.push("candidate", { owner: "a", dirty: false, discover: true });
    debouncer.push("candidate", { owner: "b", dirty: false, discover: true });
    debouncer.push("candidate", { owner: "c", dirty: false, discover: true });
  });
  await complete;
  expect(observed).toEqual({
    reasons: { signal: false, candidate: true, other: false },
    candidates: [],
    discoverAll: true,
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-ref-reg-")));
  roots.push(root);
  return root;
}

function makeGitDir(gitDir: string): void {
  fs.mkdirSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "refs", "tags"), { recursive: true });
  fs.mkdirSync(path.join(gitDir, "objects"), { recursive: true });
  fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  fs.writeFileSync(path.join(gitDir, "config"), "[core]\n\trepositoryformatversion = 0\n\tbare = false\n");
}

class TestHandle implements GitRefWatchHandle {
  closed = 0;
  error?: (error: Error) => void;
  constructor(
    readonly target: string,
    readonly mode: GitRefWatchMode,
    readonly listener: (eventType: string, filename: string | Buffer | null) => void
  ) {}
  close(): void { this.closed++; }
  on(event: "error", listener: (error: Error) => void): this {
    if (event === "error") this.error = listener;
    return this;
  }
}

class TestWatches {
  attempts: Array<{ target: string; mode: GitRefWatchMode }> = [];
  handles: TestHandle[] = [];
  fail = new Map<string, number>();
  watch = (target: string, mode: GitRefWatchMode, listener: (eventType: string, filename: string | Buffer | null) => void): TestHandle => {
    this.attempts.push({ target, mode });
    const remaining = this.fail.get(target) ?? 0;
    if (remaining > 0) {
      this.fail.set(target, remaining - 1);
      throw new Error("injected attach failure");
    }
    const handle = new TestHandle(target, mode, listener);
    this.handles.push(handle);
    return handle;
  };
  latest(target: string, mode?: GitRefWatchMode): TestHandle {
    const found = this.handles.filter((handle) => handle.target === target && (!mode || handle.mode === mode)).at(-1);
    if (!found) throw new Error(`missing handle ${target}`);
    return found;
  }
}

class FakeClock implements GitRefWatchClock {
  time = 0;
  nextId = 1;
  timers = new Map<number, { at: number; fn: () => void }>();
  now = () => this.time;
  random = () => 0.5;
  setTimeout = (fn: () => void, ms: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown): void => { this.timers.delete(id as number); };
  async advance(ms: number): Promise<void> {
    const end = this.time + ms;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.time = due[1].at;
      this.timers.delete(due[0]);
      due[1].fn();
      await spin();
    }
    this.time = end;
    await spin();
  }
}

async function spin(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

test("registry aggregates role filters by physical root and preserves shared ownership", async () => {
  const root = tempRoot();
  const main = path.join(root, "main");
  const worktree = path.join(root, "wt");
  const common = path.join(main, ".git");
  const wtGitDir = path.join(common, "worktrees", "wt");
  makeGitDir(common);
  fs.mkdirSync(wtGitDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const contexts = new Map([
    [main, { repoDir: main, kind: "dir" as const, gitDir: common, commonDir: common }],
    [worktree, { repoDir: worktree, kind: "pointer" as const, gitDir: wtGitDir, commonDir: common }],
  ]);
  const watches = new TestWatches();
  const signals: number[] = [];
  const armed: string[] = [];
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async (repoDir) => contexts.get(repoDir),
    refStorage: async () => undefined,
    watch: watches.watch,
    onSignal: () => signals.push(1),
    onArmed: (owner) => armed.push(owner),
  });

  await registry.upsert([{ relPath: "main", kind: "dir" }, { relPath: "wt", kind: "pointer" }]);
  expect(registry.state.activeHandles).toBe(5);
  expect(armed.sort()).toEqual(["main", "wt"]);
  const shared = watches.latest(common, "shallow");
  const sharedHandleCount = watches.handles.filter((handle) => handle.target === common).length;
  shared.listener("change", "HEAD");
  shared.listener("change", "packed-refs");
  expect(signals).toHaveLength(2); // union of gitDir + commonDir roles

  const snapshot = registry.beginSnapshot();
  await registry.applySnapshot([{ relPath: "wt", kind: "pointer" }], snapshot, true);
  expect(registry.state.activeHandles).toBe(5); // common roots remain owned by the pointer
  const pointerOnlyCommon = watches.latest(common, "shallow");
  expect(pointerOnlyCommon).toBe(shared);
  expect(shared.closed).toBe(0);
  expect(watches.handles.filter((handle) => handle.target === common)).toHaveLength(sharedHandleCount);
  pointerOnlyCommon.listener("change", "HEAD");
  pointerOnlyCommon.listener("change", "packed-refs");
  expect(signals).toHaveLength(3); // HEAD no longer accepted; packed-refs still is

  const bothAgain = registry.beginSnapshot();
  await registry.applySnapshot([{ relPath: "main", kind: "dir" }, { relPath: "wt", kind: "pointer" }], bothAgain, true);
  const normalOnly = registry.beginSnapshot();
  await registry.applySnapshot([{ relPath: "main", kind: "dir" }], normalOnly, true);
  expect(registry.state.activeHandles).toBe(4); // inverse removal: normal retains every shared root

  const empty = registry.beginSnapshot();
  await registry.applySnapshot([], empty, true);
  expect(registry.state.activeHandles).toBe(0);
  expect(registry.state.floorRequired).toBe(false);
  await registry.close();
});

test("a contributor-only ownership update never reopens a still-owned physical handle", async () => {
  const root = tempRoot();
  const main = path.join(root, "main");
  const worktree = path.join(root, "wt");
  const common = path.join(main, ".git");
  const wtGitDir = path.join(common, "worktrees", "wt");
  makeGitDir(common);
  fs.mkdirSync(wtGitDir, { recursive: true });
  fs.mkdirSync(worktree, { recursive: true });
  const contexts = new Map([
    [main, { repoDir: main, kind: "dir" as const, gitDir: common, commonDir: common }],
    [worktree, { repoDir: worktree, kind: "pointer" as const, gitDir: wtGitDir, commonDir: common }],
  ]);
  const watches = new TestWatches();
  const clock = new FakeClock();
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    resolveRepo: async (repoDir) => contexts.get(repoDir),
    refStorage: async () => undefined,
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "main", kind: "dir" }]);
  const liveCommon = watches.latest(common, "shallow");
  watches.fail.set(common, 1);
  await registry.upsert([{ relPath: "wt", kind: "pointer" }]);
  expect(liveCommon.closed).toBe(0);
  expect(registry.state.pendingTargets).toBe(0);

  await registry.upsert([{ relPath: "main", kind: "dir" }]);
  expect(liveCommon.closed).toBe(0);
  expect(watches.handles.filter((handle) => handle.target === common && handle.closed === 0)).toHaveLength(1);

  await clock.advance(1_000);
  await registry.idle();
  expect(liveCommon.closed).toBe(0);
  expect(registry.state.pendingTargets).toBe(0);
  await registry.close();
});

test("two identical upserts do not reconcile the second input", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  let probes = 0;
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => {
      probes++;
      return { repoDir: repo, kind: "dir", gitDir, commonDir: gitDir };
    },
    refStorage: async () => undefined,
    watch: new TestWatches().watch,
  });
  const repos = [{ relPath: "repo", kind: "dir" as const }];
  await registry.upsert(repos);
  expect(probes).toBe(1);
  await registry.upsert(repos);
  expect(probes).toBe(1);
  await registry.close();
});

test("candidate generation dirtiness and root-self rename force replacement even at the same path", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const watches = new TestWatches();
  const armed: string[] = [];
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: watches.watch,
    onArmed: (owner) => armed.push(owner),
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  const firstCount = watches.handles.length;
  await registry.markCandidates([{ owner: "repo", dirty: true, discover: true }]);
  expect(registry.state.owners[0]?.generation).toBe(2);
  expect(watches.handles.length).toBe(firstCount + 4);
  const heads = watches.latest(path.join(gitDir, "refs", "heads"), "recursive");
  heads.listener("rename", null);
  await registry.idle();
  expect(watches.handles.length).toBe(firstCount + 5);
  expect(heads.closed).toBe(1);
  expect(armed).toEqual(["repo", "repo", "repo"]); // initial, candidate generation, structure generation
  await registry.close();
});

test("candidate overflow conservatively dirties every bounded owner", async () => {
  const root = tempRoot();
  const a = path.join(root, "a");
  const b = path.join(root, "b");
  makeGitDir(path.join(a, ".git"));
  makeGitDir(path.join(b, ".git"));
  const registry = new GitRefWatchRegistry({ root });
  await registry.upsert([{ relPath: "a", kind: "dir" }, { relPath: "b", kind: "dir" }]);
  await registry.markAllCandidatesDirty();
  expect(registry.state.owners.map((owner) => owner.generation)).toEqual([2, 2]);
  expect(registry.state.owners.every((owner) => owner.state === "armed")).toBe(true);
  await registry.close();
});

test("stale or incomplete safety snapshots cannot erase post-start candidate ownership", async () => {
  const root = tempRoot();
  const repo = path.join(root, "late");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: new TestWatches().watch,
  });
  const horizon = registry.beginSnapshot();
  await registry.upsert([{ relPath: "late", kind: "dir" }]);
  await registry.applySnapshot([], horizon, true);
  expect(registry.state.owners.map((owner) => owner.relPath)).toEqual(["late"]);
  const current = registry.beginSnapshot();
  await registry.applySnapshot([], current, false);
  expect(registry.state.owners.map((owner) => owner.relPath)).toEqual(["late"]);
  await registry.close();
});

test("a post-horizon structure event makes an older snapshot non-shrinking", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const watches = new TestWatches();
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    refStorage: async () => undefined,
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  const horizon = registry.beginSnapshot();
  watches.latest(gitDir, "shallow").listener("rename", "refs");
  await registry.applySnapshot([], horizon, true);
  await registry.idle();
  expect(registry.state.owners.map((owner) => owner.relPath)).toEqual(["repo"]);
  await registry.close();
});

test("a stale generation delayed in repo resolution cannot publish after a newer shrinking snapshot", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const ctx = { repoDir: repo, kind: "dir" as const, gitDir, commonDir: gitDir };
  let calls = 0;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const watches = new TestWatches();
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => {
      calls++;
      if (calls === 2) await blocked;
      return ctx;
    },
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  const initialHandles = watches.handles.length;
  const dirty = registry.markCandidates([{ owner: "repo", dirty: true, discover: true }]);
  await spin();
  const horizon = registry.beginSnapshot();
  const shrink = registry.applySnapshot([], horizon, true);
  release();
  await Promise.all([dirty, shrink]);
  expect(registry.state.owners).toEqual([]);
  expect(registry.state.activeHandles).toBe(0);
  expect(watches.handles).toHaveLength(initialHandles); // stale generation armed nothing
  await registry.close();
});

test("per-target backoff is 1s then 2s, is not preempted, and resets on success", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const heads = fs.realpathSync(path.join(gitDir, "refs", "heads"));
  const watches = new TestWatches();
  watches.fail.set(heads, 2);
  const clock = new FakeClock();
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(watches.attempts.filter((attempt) => attempt.target === heads)).toHaveLength(1);
  await clock.advance(999);
  await registry.markCandidates([{ owner: "repo", dirty: false, discover: true }]);
  expect(watches.attempts.filter((attempt) => attempt.target === heads)).toHaveLength(1);
  await clock.advance(1);
  await registry.idle();
  expect(watches.attempts.filter((attempt) => attempt.target === heads)).toHaveLength(2);
  await clock.advance(1_999);
  expect(watches.attempts.filter((attempt) => attempt.target === heads)).toHaveLength(2);
  await clock.advance(1);
  await registry.idle();
  expect(watches.attempts.filter((attempt) => attempt.target === heads)).toHaveLength(3);
  expect(registry.state.pendingTargets).toBe(0);
  expect(registry.state.owners[0]?.state).toBe("armed");
  await registry.close();
});

test("backoff applies ±20% jitter, caps at 60s before jitter, and keeps one earliest timer", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const heads = fs.realpathSync(path.join(gitDir, "refs", "heads"));
  const watches = new TestWatches();
  watches.fail.set(heads, 20);
  const clock = new FakeClock();
  clock.random = () => 0; // lower jitter edge
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  for (const delayMs of [800, 1_600, 3_200, 6_400, 12_800, 25_600, 48_000, 48_000]) {
    expect(clock.timers.size).toBe(1);
    const next = [...clock.timers.values()][0]!;
    expect(next.at - clock.time).toBe(delayMs);
    await clock.advance(delayMs);
    await registry.idle();
  }
  await registry.close();

  const upperWatches = new TestWatches();
  upperWatches.fail.set(heads, 1);
  const upperClock = new FakeClock();
  upperClock.random = () => 1;
  const upper = new GitRefWatchRegistry({
    root,
    clock: upperClock,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: upperWatches.watch,
  });
  await upper.upsert([{ relPath: "repo", kind: "dir" }]);
  expect([...upperClock.timers.values()][0]!.at).toBe(1_200);
  await upper.close();
});

test("failed forced replacement detaches the stale handle and retries the new generation", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const heads = fs.realpathSync(path.join(gitDir, "refs", "heads"));
  const watches = new TestWatches();
  const clock = new FakeClock();
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    refStorage: async () => undefined,
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  const staleHeads = watches.latest(heads, "recursive");
  watches.fail.set(heads, 1);
  await registry.markCandidates([{ owner: "repo", dirty: true, discover: true }]);
  expect(staleHeads.closed).toBe(1);
  expect(registry.state.activeHandles).toBe(3);
  expect(registry.state.pendingTargets).toBe(1);
  await clock.advance(1_000);
  await registry.idle();
  expect(registry.state.activeHandles).toBe(4);
  expect(registry.state.pendingTargets).toBe(0);
  await registry.close();
});

test("repo cap admits stable path order and logs once per over-cap composition", async () => {
  const root = tempRoot();
  const contexts = new Map<string, { repoDir: string; kind: "dir"; gitDir: string; commonDir: string }>();
  for (const rel of ["z", "a", "m"]) {
    const repoDir = path.join(root, rel);
    const gitDir = path.join(repoDir, ".git");
    makeGitDir(gitDir);
    contexts.set(repoDir, { repoDir, kind: "dir", gitDir, commonDir: gitDir });
  }
  const logs: string[] = [];
  const registry = new GitRefWatchRegistry({
    root,
    repoCap: 2,
    resolveRepo: async (repoDir) => contexts.get(repoDir),
    refStorage: async () => undefined,
    watch: new TestWatches().watch,
    onLog: (line) => logs.push(line),
  });
  const repos = [{ relPath: "z", kind: "dir" as const }, { relPath: "a", kind: "dir" as const }, { relPath: "m", kind: "dir" as const }];
  await registry.upsert(repos);
  expect(registry.state.owners.map(({ relPath, state }) => [relPath, state])).toEqual([["a", "armed"], ["m", "armed"], ["z", "overCap"]]);
  expect(registry.state.activeHandles).toBe(8);
  await registry.upsert(repos);
  expect(logs.filter((line) => line.includes("repo cap"))).toHaveLength(1);
  await registry.close();
});

test("reader death closes all handles, latches the floor, and suppresses future attaches", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const watches = new TestWatches();
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  const attempts = watches.attempts.length;
  watches.handles[0]!.error?.(new Error("reader exited"));
  expect(registry.state).toMatchObject({ readerDead: true, floorRequired: true, activeHandles: 0 });
  expect(watches.handles.every((handle) => handle.closed === 1)).toBe(true);
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(watches.attempts).toHaveLength(attempts);
  await registry.close();
});

test("close fences a late repo-resolution result and publishes no handle", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  let release!: (ctx: { repoDir: string; kind: "dir"; gitDir: string; commonDir: string }) => void;
  const delayed = new Promise<{ repoDir: string; kind: "dir"; gitDir: string; commonDir: string }>((resolve) => { release = resolve; });
  const watches = new TestWatches();
  const registry = new GitRefWatchRegistry({ root, resolveRepo: () => delayed, watch: watches.watch });
  const input = registry.upsert([{ relPath: "repo", kind: "dir" }]);
  await spin();
  const closing = registry.close();
  release({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir });
  await Promise.all([input, closing]);
  expect(registry.state.closed).toBe(true);
  expect(watches.handles).toHaveLength(0);
});

test("containment refuses out-of-root pointer targets without pinning the dir-only floor", async () => {
  const root = tempRoot();
  const external = tempRoot();
  const repo = path.join(root, "wt");
  fs.mkdirSync(repo, { recursive: true });
  makeGitDir(external);
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => ({ repoDir: repo, kind: "pointer", gitDir: external, commonDir: external }),
    refStorage: async () => undefined,
    watch: new TestWatches().watch,
  });
  await registry.upsert([{ relPath: "wt", kind: "pointer" }]);
  expect(registry.state.activeHandles).toBe(0);
  expect(registry.state.owners[0]?.state).toBe("outside");
  expect(registry.state.floorRequired).toBe(false);
  await registry.close();
});

test("registry pre-attach refuses config-authoritative reftable without opening handles", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const watches = new TestWatches();
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    refStorage: async () => "reftable",
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(registry.state.owners[0]?.state).toBe("refused");
  expect(watches.handles).toEqual([]);
  await registry.close();
});

test("config-authority failure stays pending and cannot admit a reftable repo before the authoritative retry", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const watches = new TestWatches();
  const clock = new FakeClock();
  const armed: string[] = [];
  let probes = 0;
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    refStorage: async () => {
      probes++;
      if (probes === 1) throw new Error("injected config read fault");
      return "reftable";
    },
    watch: watches.watch,
    onArmed: (owner) => armed.push(owner),
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(registry.state).toMatchObject({ activeHandles: 0, pendingTargets: 1 });
  expect(registry.state.owners[0]?.state).toBe("failed");
  expect(armed).toEqual([]);
  expect(clock.timers.size).toBe(1);
  await clock.advance(999);
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(probes).toBe(1);

  await clock.advance(1);
  await registry.idle();
  expect(registry.state).toMatchObject({ activeHandles: 0, pendingTargets: 0 });
  expect(registry.state.owners[0]?.state).toBe("refused");
  expect(armed).toEqual([]);
  await registry.close();
});

test("namespace admission is combined and fail-shallow; growth after count remains documented best effort", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  fs.writeFileSync(path.join(gitDir, "refs", "heads", "one"), "x");
  fs.writeFileSync(path.join(gitDir, "refs", "tags", "two"), "x");
  const bounded = new TestWatches();
  const registry = new GitRefWatchRegistry({
    root,
    namespaceEntryBudget: 1,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: bounded.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(registry.state.activeHandles).toBe(2); // shared control root + refs root only
  expect(bounded.attempts.some((attempt) => attempt.mode === "recursive")).toBe(false);
  expect(registry.state.owners[0]?.state).toBe("failed");
  expect(registry.state.pendingTargets).toBe(1);
  await registry.close();

  const growth = new TestWatches();
  const growthRegistry = new GitRefWatchRegistry({
    root,
    namespaceEntryBudget: 10,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: (target, mode, listener) => {
      if (mode === "recursive") fs.mkdirSync(path.join(target, "arrived-after-count", "deep"), { recursive: true });
      return growth.watch(target, mode, listener);
    },
  });
  await growthRegistry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(growthRegistry.state.activeHandles).toBe(4);
  fs.mkdirSync(path.join(gitDir, "refs", "heads", "post-arm-populated", "deep"), { recursive: true });
  expect(growthRegistry.state.activeHandles).toBe(4); // Bun owns post-arm descendant exposure
  await growthRegistry.close();
});

test("namespace admission failure retries on the shared backoff timer and resets after success", async () => {
  const root = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  const crowded = path.join(gitDir, "refs", "heads", "crowded");
  fs.mkdirSync(crowded);
  const clock = new FakeClock();
  const watches = new TestWatches();
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    namespaceDirBudget: 2,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: watches.watch,
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(registry.state).toMatchObject({ activeHandles: 2, pendingTargets: 1 });
  expect(clock.timers.size).toBe(1);
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(clock.timers.size).toBe(1);
  expect(watches.attempts.filter((attempt) => attempt.mode === "recursive")).toHaveLength(0);

  fs.rmdirSync(crowded);
  await clock.advance(1_000);
  await registry.idle();
  expect(registry.state).toMatchObject({ activeHandles: 4, pendingTargets: 0 });
  expect(registry.state.owners[0]?.state).toBe("armed");
  await registry.close();
});

test("namespace admission refuses a symlinked heads root without traversing its external tree", async () => {
  const root = tempRoot();
  const external = tempRoot();
  const repo = path.join(root, "repo");
  const gitDir = path.join(repo, ".git");
  makeGitDir(gitDir);
  fs.rmSync(path.join(gitDir, "refs", "heads"), { recursive: true });
  fs.rmSync(path.join(gitDir, "refs", "tags"), { recursive: true });
  fs.mkdirSync(path.join(external, "deep", "deeper"), { recursive: true });
  fs.symlinkSync(external, path.join(gitDir, "refs", "heads"), "dir");
  const clock = new FakeClock();
  const watches = new TestWatches();
  const logs: string[] = [];
  const registry = new GitRefWatchRegistry({
    root,
    clock,
    namespaceDirBudget: 0,
    namespaceEntryBudget: 0,
    resolveRepo: async () => ({ repoDir: repo, kind: "dir", gitDir, commonDir: gitDir }),
    watch: watches.watch,
    onLog: (message) => logs.push(message),
  });
  await registry.upsert([{ relPath: "repo", kind: "dir" }]);
  expect(registry.state).toMatchObject({ activeHandles: 2, pendingTargets: 1 });
  expect(watches.attempts.some((attempt) => attempt.target.startsWith(external))).toBe(false);
  expect(watches.attempts.some((attempt) => attempt.mode === "recursive")).toBe(false);
  expect(logs.some((message) => message.includes("namespace root is not a real directory"))).toBe(true);
  expect(logs.some((message) => message.includes("directory budget"))).toBe(false);
  await registry.close();
});

test("nameless and garbage fs.watch filenames never throw and degrade to dirty (2026-07-26 FM crash)", async () => {
  const root = tempRoot();
  const main = path.join(root, "main");
  const common = path.join(main, ".git");
  makeGitDir(common);
  const contexts = new Map([
    [main, { repoDir: main, kind: "dir" as const, gitDir: common, commonDir: common }],
  ]);
  const watches = new TestWatches();
  const logs: string[] = [];
  const registry = new GitRefWatchRegistry({
    root,
    resolveRepo: async (repoDir) => contexts.get(repoDir),
    refStorage: async () => undefined,
    watch: watches.watch,
    onLog: (line) => logs.push(line),
  });
  await registry.upsert([{ relPath: "main", kind: "dir" }]);
  const shared = watches.latest(common, "shallow");

  // Bun on Linux delivers null AND undefined filenames; the pre-fix guard only
  // checked `=== null`, so undefined reached safeTail(.length) and the
  // TypeError killed the daemon. Every shape here must be absorbed.
  const garbage: unknown[] = [undefined, null, "", Buffer.from("HEAD"), 42, {}, "HEAD"];
  for (const filename of garbage) {
    expect(() => shared.listener("rename", filename as never)).not.toThrow();
    expect(() => shared.listener("change", filename as never)).not.toThrow();
  }
  expect(registry.state.closed).toBe(false);
  expect(registry.state.readerDead).toBe(false);
});

test("classifyRefEvent tolerates non-string tails", () => {
  expect(classifyRefEvent("gitDir", undefined as never)).toBe("none");
  expect(classifyRefEvent("gitDir", null as never)).toBe("none");
  expect(classifyRefEvent("refsRoot", 7 as never)).toBe("none");
});

test.skipIf(process.platform !== "linux")(
  "real Linux registry: forced pending capture with ORIG_HEAD has no scratch-ref follow-up signal",
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-owned-ref-quiet-")));
    await runGit(root, "init", "-qb", "main");
    await runGit(root, "commit", "--allow-empty", "-qm", "baseline");
    const head = await runGit(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${head}\n`);
    let signals = 0;
    const registry = new GitRefWatchRegistry({ root, onSignal: () => { signals++; } });
    try {
      await registry.upsert([{ relPath: ".", kind: "dir" }]);
      // This is the exact forced-capture primitive used for a pending section;
      // ORIG_HEAD guarantees at least one scratch pin even on a clean worktree.
      expect(await captureGitState(root, memoryBlobStore(), Buffer.alloc(32, 23), {
        ownedRefMutationBoundary: registry,
      })).toBeDefined();
      await settleWatch();
      expect(signals).toBe(0);
    } finally {
      await registry.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);

test.skipIf(process.platform !== "linux")(
  "real Linux registry: external packed-ref transaction during an active capture boundary survives reconcile",
  async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rbox-owned-ref-race-")));
    await runGit(root, "init", "-qb", "main");
    await runGit(root, "commit", "--allow-empty", "-qm", "baseline");
    const head = await runGit(root, "rev-parse", "HEAD");
    fs.writeFileSync(path.join(root, ".git", "ORIG_HEAD"), `${head}\n`);
    await runGit(root, "pack-refs", "--all");
    const tree = await runGit(root, "rev-parse", "HEAD^{tree}");
    const externalOid = await runGit(root, "commit-tree", tree, "-p", head, "-m", "external packed ref");
    let signals = 0;
    const registry = new GitRefWatchRegistry({ root, onSignal: () => { signals++; } });
    let injected = false;
    const boundary: OwnedRefMutationBoundary = {
      enterOwnedRefMutation: async (repoDir) => {
        const lease = await registry.enterOwnedRefMutation(repoDir);
        if (!lease) return undefined;
        return {
          finish: async () => {
            if (!injected) {
              injected = true;
              const packed = path.join(root, ".git", "packed-refs");
              const lock = `${packed}.lock`;
              const prior = fs.readFileSync(packed, "utf8");
              fs.writeFileSync(lock, `${prior}${prior.endsWith("\n") ? "" : "\n"}${externalOid} refs/tags/external-race\n`);
              await lease.finish();
              // Reconcile must signal while the ambiguous external lock is still
              // present; do not rely on Bun delivering the final target callback.
              expect(signals).toBeGreaterThan(0);
              fs.renameSync(lock, packed);
              return;
            }
            await lease.finish();
          },
        };
      },
    };
    try {
      await registry.upsert([{ relPath: ".", kind: "dir" }]);
      expect(await captureGitState(root, memoryBlobStore(), Buffer.alloc(32, 29), {
        ownedRefMutationBoundary: boundary,
      })).toBeDefined();
      expect(injected).toBe(true);
      expect(signals).toBeGreaterThan(0);
    } finally {
      await registry.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
  15_000,
);
