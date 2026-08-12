import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  GIT_REF_SIGNAL_TAIL_TABLE,
  gitRefStorage,
  isGitRefSignalTail,
  readSyncableRefSurface,
  repoCtxFromDisk,
  type DiscoveredGitRepo,
  type OwnedRefMutationLease,
  type RepoCtx,
} from "../../engine/index.js";
import { gitRepoCap } from "../sync-git/shared.js";

/** Physical watch-root roles in the Linux Git ref side-channel. */
export type GitRefWatchRole = "gitDir" | "commonDir" | "refsRoot" | "refsNamespace";

export type GitRefEventClass = "target" | "lockPreSignal" | "structure" | "none";

/** The single construction gate used by the daemon and native release smoke. */
export function gitRefSideChannelEligible(
  platform = process.platform,
  selectedBackend?: "parcel" | "chokidar",
): boolean {
  return platform === "linux" && selectedBackend === "parcel";
}

/**
 * Classify a target-relative fs.watch filename. This is intentionally pure and
 * platform-neutral; only the Linux+Parcel registry consumes the result.
 */
export function classifyRefEvent(role: GitRefWatchRole, tail: string): GitRefEventClass {
  if (!safeTail(tail)) return "none";

  return classifySafeRefEvent(role, tail);
}

function classifySafeRefEvent(role: GitRefWatchRole, tail: string): GitRefEventClass {
  if (role !== "refsNamespace" && (GIT_REF_SIGNAL_TAIL_TABLE[role].structures as readonly string[]).includes(tail)) return "structure";

  if (tail.endsWith(".lock")) {
    const target = tail.slice(0, -".lock".length);
    return isTarget(role, target) ? "lockPreSignal" : "none";
  }
  return isTarget(role, tail) ? "target" : "none";
}

function safeTail(tail: string): boolean {
  if (typeof tail !== "string") return false; // fs.watch contract violations must classify as noise, never throw
  if (tail.length === 0 || tail.includes("\0") || tail.startsWith("/") || tail.endsWith("/")) return false;
  return tail.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function isTarget(role: GitRefWatchRole, tail: string): boolean {
  if (role === "refsNamespace") return isGitRefSignalTail(`refs/heads/${tail}`);
  return (GIT_REF_SIGNAL_TAIL_TABLE[role].targets as readonly string[]).includes(tail);
}

export type RepoCandidateEventKind = "create" | "update" | "delete";

export interface RepoCandidateWork {
  /** POSIX path of the repository worktree relative to the sync root. */
  owner: string;
  /** Monotonic invalidation: update/delete dirties the owner's generation. */
  dirty: boolean;
  /** Create/update asks the registry to discover this owner subtree. */
  discover: boolean;
}

/**
 * Recognize lifecycle events on the `.git` entry itself. Descendants and names
 * such as `.github`/`.git-old` are deliberately not candidates.
 */
export function classifyRepoCandidate(relPath: string, kind: RepoCandidateEventKind): RepoCandidateWork | undefined {
  // Fast bail for the hot path: this runs on EVERY watcher event, and almost
  // all paths are unrelated to a repository lifecycle entry.
  if (relPath !== ".git" && !relPath.endsWith("/.git")) return undefined;
  if (!relPath || relPath.startsWith("/") || relPath.endsWith("/")) return undefined;
  const parts = relPath.split("/");
  if (parts.at(-1) !== ".git" || parts.some((part) => part.length === 0 || part === "." || part === "..")) return undefined;
  const owner = parts.length === 1 ? "." : parts.slice(0, -1).join("/");
  return {
    owner,
    dirty: kind === "update" || kind === "delete",
    discover: kind === "create" || kind === "update",
  };
}

// ---- Linux ref-watch registry -------------------------------------------------

export type GitRefWatchMode = "shallow" | "recursive";

export interface GitRefWatchHandle {
  close(): void | Promise<void>;
  on?(event: "error", listener: (error: Error) => void): unknown;
}

export interface GitRefWatchClock {
  now(): number;
  random(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface GitRefWatchRegistryOptions {
  root: string;
  repoCap?: number;
  namespaceDirBudget?: number;
  namespaceEntryBudget?: number;
  resolveRepo?: (repoDir: string) => Promise<RepoCtx | undefined>;
  refStorage?: (repoDir: string) => Promise<string | undefined>;
  realpath?: (target: string) => Promise<string>;
  readRefSurface?: (repoDir: string) => Promise<string | undefined>;
  watch?: (target: string, mode: GitRefWatchMode, listener: (eventType: string, filename: string | Buffer | null) => void) => GitRefWatchHandle;
  clock?: GitRefWatchClock;
  /** Target/lock callbacks only. Structure and null/root events only re-arm. */
  onSignal?: () => void;
  /** Queues the arm-then-push handshake after a complete generation is armed. */
  onArmed?: (owner: string) => void;
  onFloorChange?: (required: boolean, reason: string) => void;
  onLog?: (message: string) => void;
}

export interface GitRefWatchRegistryState {
  readonly closed: boolean;
  readonly readerDead: boolean;
  readonly floorRequired: boolean;
  readonly activeHandles: number;
  readonly pendingTargets: number;
  readonly owners: readonly { relPath: string; kind: DiscoveredGitRepo["kind"]; generation: number; state: OwnerState }[];
}

type OwnerState = "pending" | "armed" | "failed" | "overCap" | "outside" | "refused";

interface OwnerRecord extends DiscoveredGitRepo {
  generation: number;
  touchedEpoch: number;
  state: OwnerState;
  handshakeGeneration: number;
  /** Additive inputs can raise but never clear a dir-backed floor claim. */
  floorDir: boolean;
}

interface Contributor {
  owner: string;
  role: GitRefWatchRole;
  generation: number;
}

interface DesiredTarget {
  key: string;
  rawRoot: string;
  canonicalRoot: string;
  mode: GitRefWatchMode;
  contributors: Map<string, Contributor>;
}

interface ActiveTarget extends DesiredTarget {
  handle: GitRefWatchHandle;
}

interface RetryState {
  attempt: number;
  nextAttemptAt: number;
  owners: Set<string>;
}

interface AdmissionResult {
  ok: boolean;
  reason?: string;
}

interface RunBuild {
  desired: Map<string, DesiredTarget>;
  ownerTargets: Map<string, Set<string>>;
  ownerFailures: Map<string, OwnerState>;
  pendingRetryKeys: Set<string>;
}

interface OwnedRefMutationState {
  depth: number;
  repoDir: string;
  before: string | undefined;
}

const DEFAULT_NAMESPACE_DIR_BUDGET = 512;
const DEFAULT_NAMESPACE_ENTRY_BUDGET = 8192;

const SYSTEM_CLOCK: GitRefWatchClock = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const defaultWatch = (
  target: string,
  mode: GitRefWatchMode,
  listener: (eventType: string, filename: string | Buffer | null) => void
): GitRefWatchHandle => fs.watch(target, { recursive: mode === "recursive" }, listener);

/**
 * Admission-budgeted ownership registry for Bun's Linux recursive fs.watch.
 * Construction is platform-gated by the daemon; keeping the class injectable
 * lets contract tests exercise races and reader failure on every CI host.
 */
export class GitRefWatchRegistry {
  readonly #root: string;
  readonly #repoCap: number;
  readonly #dirBudget: number;
  readonly #entryBudget: number;
  readonly #resolveRepo: NonNullable<GitRefWatchRegistryOptions["resolveRepo"]>;
  readonly #refStorage: NonNullable<GitRefWatchRegistryOptions["refStorage"]>;
  readonly #realpath: NonNullable<GitRefWatchRegistryOptions["realpath"]>;
  readonly #readRefSurface: NonNullable<GitRefWatchRegistryOptions["readRefSurface"]>;
  readonly #watch: NonNullable<GitRefWatchRegistryOptions["watch"]>;
  readonly #clock: GitRefWatchClock;
  readonly #onSignal?: () => void;
  readonly #onArmed?: (owner: string) => void;
  readonly #onFloorChange?: (required: boolean, reason: string) => void;
  readonly #onLog?: (message: string) => void;

  #rootReal?: string;
  #closed = false;
  #readerDead = false;
  #inputEpoch = 0;
  #requestedGeneration = 0;
  #settledGeneration = 0;
  #owners = new Map<string, OwnerRecord>();
  #snapshotDirOwners = new Set<string>();
  #active = new Map<string, ActiveTarget>();
  #forcedTargets = new Set<string>();
  #retries = new Map<string, RetryState>();
  #retryTimer?: unknown;
  #pump?: Promise<void>;
  #closingHandles: Promise<void>[] = [];
  #waiters: Array<{ generation: number; resolve: () => void }> = [];
  #floorRequired = false;
  #overCapComposition = "";
  #ownedRefMutations = new Map<string, OwnedRefMutationState>();
  #ownedRefMutationQueue = Promise.resolve();

  constructor(opts: GitRefWatchRegistryOptions) {
    this.#root = path.resolve(opts.root);
    this.#repoCap = opts.repoCap ?? gitRepoCap();
    this.#dirBudget = opts.namespaceDirBudget ?? DEFAULT_NAMESPACE_DIR_BUDGET;
    this.#entryBudget = opts.namespaceEntryBudget ?? DEFAULT_NAMESPACE_ENTRY_BUDGET;
    if (!Number.isInteger(this.#repoCap) || this.#repoCap < 1) throw new Error("repoCap must be a positive integer");
    if (!Number.isInteger(this.#dirBudget) || this.#dirBudget < 0) throw new Error("namespaceDirBudget must be a non-negative integer");
    if (!Number.isInteger(this.#entryBudget) || this.#entryBudget < 0) throw new Error("namespaceEntryBudget must be a non-negative integer");
    this.#resolveRepo = opts.resolveRepo ?? repoCtxFromDisk;
    this.#refStorage = opts.refStorage ?? gitRefStorage;
    this.#realpath = opts.realpath ?? ((target) => fsp.realpath(target));
    this.#readRefSurface = opts.readRefSurface ?? readSyncableRefSurface;
    this.#watch = opts.watch ?? defaultWatch;
    this.#clock = opts.clock ?? SYSTEM_CLOCK;
    this.#onSignal = opts.onSignal;
    this.#onArmed = opts.onArmed;
    this.#onFloorChange = opts.onFloorChange;
    this.#onLog = opts.onLog;
  }

  get epoch(): number { return this.#inputEpoch; }
  get floorRequired(): boolean { return this.#floorRequired; }
  get activeHandles(): number { return this.#active.size; }

  get state(): GitRefWatchRegistryState {
    return {
      closed: this.#closed,
      readerDead: this.#readerDead,
      floorRequired: this.#floorRequired,
      activeHandles: this.#active.size,
      pendingTargets: this.#retries.size,
      owners: [...this.#owners.values()].sort(ownerOrder).map(({ relPath, kind, generation, state }) => ({ relPath, kind, generation, state })),
    };
  }

  /** Wait for the currently requested reconcile generation (test/diagnostic seam). */
  async idle(): Promise<void> {
    while (this.#pump) await this.#pump;
  }

  /** Bracket one refs/rbox-wip update-ref command. The successful command owns
   * the exclusive lock; the registry owns attribution and reconciliation. */
  enterOwnedRefMutation(repoDir: string): Promise<OwnedRefMutationLease | undefined> {
    return this.#serializeOwnedRefMutation(async () => {
      if (this.#closed || this.#readerDead) return undefined;
      const ctx = await this.#resolveRepo(repoDir).catch(() => undefined);
      if (!ctx || this.#closed || this.#readerDead) return undefined;
      const [rootReal, commonDir] = await Promise.all([
        this.#rootReal ? Promise.resolve(this.#rootReal) : this.#realpath(this.#root).catch(() => undefined),
        this.#realpath(ctx.commonDir).catch(() => undefined),
      ]);
      if (!rootReal || !commonDir || !within(rootReal, commonDir) || this.#closed || this.#readerDead) return undefined;
      this.#rootReal ??= rootReal;
      const current = this.#ownedRefMutations.get(commonDir);
      if (current) current.depth++;
      else this.#ownedRefMutations.set(commonDir, {
        depth: 1,
        repoDir,
        before: await this.#readRefSurface(repoDir).catch(() => undefined),
      });
      let finished = false;
      return {
        finish: async () => {
          if (finished) return;
          finished = true;
          await this.#serializeOwnedRefMutation(() => this.#finishOwnedRefMutation(commonDir)).catch(() => {});
        },
      };
    }).catch(() => undefined);
  }

  /** Additive initial/plan/candidate discovery input. Never shrinks ownership. */
  upsert(repos: readonly DiscoveredGitRepo[]): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const epoch = ++this.#inputEpoch;
    let changed = false;
    for (const repo of orderedUniqueRepos(repos)) changed = this.#mergeOwner(repo, epoch) || changed;
    this.#refreshFloor("discovery");
    return this.#reconcileIfNeeded(changed);
  }

  /** Snapshot horizon captured before a safety discovery walk starts. */
  beginSnapshot(): number { return this.#inputEpoch; }

  /** The sole shrinking input. Incomplete or epoch-stale snapshots are additive. */
  applySnapshot(repos: readonly DiscoveredGitRepo[], startEpoch: number, complete: boolean): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const mayShrink = complete && startEpoch === this.#inputEpoch;
    const ordered = orderedUniqueRepos(repos);
    const found = new Set(ordered.map((repo) => repo.relPath));
    const epoch = ++this.#inputEpoch;
    let changed = false;
    for (const repo of ordered) changed = this.#mergeOwner(repo, epoch) || changed;
    if (mayShrink) {
      for (const [relPath, owner] of this.#owners) {
        if (!found.has(relPath) && owner.touchedEpoch <= startEpoch) {
          this.#owners.delete(relPath);
          changed = true;
        }
      }
      this.#snapshotDirOwners = new Set(ordered.filter((repo) => repo.kind === "dir").map((repo) => repo.relPath));
      for (const repo of ordered) this.#owners.get(repo.relPath)!.floorDir = repo.kind === "dir";
    }
    this.#refreshFloor(mayShrink ? "complete-snapshot" : "nonshrinking-snapshot");
    return this.#reconcileIfNeeded(changed);
  }

  /** Candidate update/delete dirties the entire owner generation monotonically. */
  markCandidates(candidates: readonly RepoCandidateWork[]): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const epoch = ++this.#inputEpoch;
    let changed = false;
    for (const candidate of candidates) {
      const owner = this.#owners.get(candidate.owner);
      if (!owner) continue;
      if (candidate.dirty) {
        this.#dirtyOwner(owner, epoch);
        changed = true;
        for (const [key, target] of this.#active) {
          for (const contributor of target.contributors.values()) {
            if (contributor.owner !== owner.relPath) continue;
            this.#forcedTargets.add(key);
            break;
          }
        }
      } else owner.touchedEpoch = epoch;
    }
    this.#refreshFloor("candidate");
    return this.#reconcileIfNeeded(changed);
  }

  /** Candidate-map overflow conservatively dirties every bounded owner. */
  markAllCandidatesDirty(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    const epoch = ++this.#inputEpoch;
    for (const owner of this.#owners.values()) this.#dirtyOwner(owner, epoch);
    for (const key of this.#active.keys()) this.#forcedTargets.add(key);
    this.#refreshFloor("candidate-overflow");
    return this.#reconcileIfNeeded(this.#owners.size > 0 || this.#active.size > 0);
  }

  /** Fatal process-global Bun reader failure: restart is the only recovery. */
  readerDied(error: Error): void {
    if (this.#closed || this.#readerDead) return;
    this.#readerDead = true;
    this.#onLog?.(`git ref watcher reader died: ${error.message}`);
    this.#clearRetryTimer();
    this.#retries.clear();
    this.#closingHandles.push(...[...this.#active.values()].map((target) => closeHandle(target.handle)));
    this.#active.clear();
    this.#resolveWaiters(Number.POSITIVE_INFINITY);
    this.#refreshFloor("reader-death");
  }

  /** Closed is set before the first await; in-flight results cannot publish. */
  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#clearRetryTimer();
    const handles = [...this.#active.values()].map((target) => target.handle);
    this.#active.clear();
    this.#ownedRefMutations.clear();
    this.#resolveWaiters(Number.POSITIVE_INFINITY);
    await Promise.all(handles.map(closeHandle));
    if (this.#pump) await this.#pump;
    await Promise.all(this.#closingHandles);
  }

  #serializeOwnedRefMutation<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#ownedRefMutationQueue.then(task, task);
    this.#ownedRefMutationQueue = result.then(() => {}, () => {});
    return result;
  }

  async #finishOwnedRefMutation(commonDir: string): Promise<void> {
    const state = this.#ownedRefMutations.get(commonDir);
    if (!state || this.#closed || this.#readerDead) return;
    if (--state.depth > 0) return;
    const lockPath = path.join(commonDir, "packed-refs.lock");
    const lockedBefore = await pathPresence(lockPath);
    const after = await this.#readRefSurface(state.repoDir).catch(() => undefined);
    const lockedAfter = await pathPresence(lockPath);
    this.#ownedRefMutations.delete(commonDir);
    if (state.before === undefined || after === undefined || state.before !== after || lockedBefore !== false || lockedAfter !== false) {
      this.#onSignal?.();
    }
  }

  #requestReconcile(): Promise<void> {
    if (this.#closed || this.#readerDead) return Promise.resolve();
    const generation = ++this.#requestedGeneration;
    const settled = new Promise<void>((resolve) => this.#waiters.push({ generation, resolve }));
    this.#ensurePump();
    return settled;
  }

  #reconcileIfNeeded(changed: boolean): Promise<void> {
    // Refused/outside owners intentionally defer re-probe to the next dirty input
    // or any due retry; retryable failures are independently re-armed by their timer.
    if (!changed && !this.#retryDue()) return Promise.resolve();
    return this.#requestReconcile();
  }

  #retryDue(): boolean {
    const now = this.#clock.now();
    for (const retry of this.#retries.values()) if (retry.nextAttemptAt <= now) return true;
    return false;
  }

  #mergeOwner(repo: DiscoveredGitRepo, epoch: number): boolean {
    const prior = this.#owners.get(repo.relPath);
    if (!prior) {
      this.#owners.set(repo.relPath, { ...repo, generation: 1, touchedEpoch: epoch, state: "pending", handshakeGeneration: 0, floorDir: repo.kind === "dir" });
      return true;
    }
    prior.touchedEpoch = epoch;
    prior.floorDir ||= repo.kind === "dir";
    if (prior.kind === repo.kind) return false;
    prior.kind = repo.kind;
    prior.generation++;
    prior.state = "pending";
    return true;
  }

  #dirtyOwner(owner: OwnerRecord, epoch: number): void {
    owner.generation++;
    owner.touchedEpoch = epoch;
    owner.state = "pending";
  }

  #ensurePump(): void {
    if (this.#pump || this.#closed || this.#readerDead || this.#settledGeneration >= this.#requestedGeneration) return;
    const pump = this.#runPump();
    this.#pump = pump;
    void pump.finally(() => {
      if (this.#pump !== pump) return;
      this.#pump = undefined;
      this.#ensurePump();
    });
  }

  async #runPump(): Promise<void> {
    while (!this.#closed && !this.#readerDead && this.#settledGeneration < this.#requestedGeneration) {
      const generation = this.#requestedGeneration;
      await this.#reconcile(generation);
      if (this.#closed || this.#readerDead) break;
      if (generation === this.#requestedGeneration) {
        this.#settledGeneration = generation;
        this.#resolveWaiters(generation);
      }
    }
  }

  async #reconcile(generation: number): Promise<void> {
    const built = await this.#buildDesired(generation);
    if (!built || this.#closed || this.#readerDead || generation !== this.#requestedGeneration) return;
    const retainedRetryKeys = new Set([...built.pendingRetryKeys, ...built.desired.keys()]);
    for (const key of this.#retries.keys()) if (!retainedRetryKeys.has(key)) this.#retries.delete(key);
    for (const key of this.#forcedTargets) if (!built.desired.has(key) && !this.#active.has(key)) this.#forcedTargets.delete(key);

    const created = new Map<string, ActiveTarget>();
    const failedReplacements = new Set<string>();
    for (const desired of built.desired.values()) {
      const current = this.#active.get(desired.key);
      // Contributor/filter changes do not replace a live physical root. The
      // complete next graph is already built, so they can be published in place;
      // only a generation-dirty root or an actual attach retry needs a new handle.
      const changed = !current || this.#forcedTargets.has(desired.key) || this.#retries.has(desired.key);
      if (!changed) continue;
      const retry = this.#retries.get(desired.key);
      if (retry && retry.nextAttemptAt > this.#clock.now()) continue;
      try {
        const active = this.#attach(desired);
        if (this.#closed || this.#readerDead || generation !== this.#requestedGeneration) {
          await closeHandle(active.handle);
          for (const target of created.values()) await closeHandle(target.handle);
          return;
        }
        created.set(desired.key, active);
        this.#retries.delete(desired.key);
      } catch (error) {
        if (current) failedReplacements.add(desired.key);
        this.#recordFailure(desired, error);
      }
    }

    if (this.#closed || this.#readerDead || generation !== this.#requestedGeneration) {
      for (const target of created.values()) await closeHandle(target.handle);
      return;
    }

    // Publish every newly armed replacement before retiring superseded handles.
    const retire: GitRefWatchHandle[] = [];
    for (const key of failedReplacements) {
      if (!this.#forcedTargets.has(key)) continue;
      const stale = this.#active.get(key);
      if (stale) {
        this.#active.delete(key);
        retire.push(stale.handle);
      }
    }
    for (const [key, target] of created) {
      const prior = this.#active.get(key);
      this.#active.set(key, target);
      this.#forcedTargets.delete(key);
      if (prior) retire.push(prior.handle);
    }
    for (const [key, current] of [...this.#active]) {
      const desired = built.desired.get(key);
      if (!desired) {
        this.#active.delete(key);
        retire.push(current.handle);
      } else if (!created.has(key) && !failedReplacements.has(key) && !this.#retries.has(key)) {
        // Filters/refcounts can change without replacing an otherwise-live root.
        current.contributors = desired.contributors;
      }
    }
    await Promise.all(retire.map(closeHandle));
    if (this.#closed || this.#readerDead || generation !== this.#requestedGeneration) {
      const rollback: GitRefWatchHandle[] = [];
      for (const [key, target] of created) {
        if (this.#active.get(key) === target) {
          this.#active.delete(key);
          rollback.push(target.handle);
        }
      }
      await Promise.all(rollback.map(closeHandle));
      return;
    }

    for (const owner of this.#owners.values()) {
      const failure = built.ownerFailures.get(owner.relPath);
      const targets = built.ownerTargets.get(owner.relPath) ?? new Set();
      const allArmed = targets.size > 0 && [...targets].every((key) => this.#active.has(key) && !this.#retries.has(key));
      owner.state = failure ?? (allArmed ? "armed" : "failed");
      if (owner.state === "armed" && owner.handshakeGeneration < owner.generation) {
        owner.handshakeGeneration = owner.generation;
        this.#onArmed?.(owner.relPath);
      }
    }
    this.#scheduleRetryTimer();
    this.#refreshFloor("reconcile");
  }

  async #buildDesired(generation: number): Promise<RunBuild | undefined> {
    const desired = new Map<string, DesiredTarget>();
    const ownerTargets = new Map<string, Set<string>>();
    const ownerFailures = new Map<string, OwnerState>();
    const pendingRetryKeys = new Set<string>();
    const owners = [...this.#owners.values()].sort(ownerOrder);
    const admitted = owners.slice(0, this.#repoCap);
    const overCap = owners.slice(this.#repoCap);
    const composition = overCap.map((owner) => `${owner.relPath}:${owner.kind}`).join(",");
    if (composition !== this.#overCapComposition) {
      this.#overCapComposition = composition;
      if (composition) this.#onLog?.(`git ref watcher repo cap ${this.#repoCap} exceeded: ${composition}`);
    }
    for (const owner of overCap) ownerFailures.set(owner.relPath, "overCap");

    const rootRetry = this.#retries.get("sync-root");
    if (!this.#rootReal && rootRetry && rootRetry.nextAttemptAt > this.#clock.now()) {
      for (const owner of owners) ownerFailures.set(owner.relPath, "failed");
      pendingRetryKeys.add("sync-root");
      return { desired, ownerTargets, ownerFailures, pendingRetryKeys };
    }
    const rootReal = this.#rootReal ?? await this.#realpath(this.#root).catch(() => undefined);
    if (this.#closed || generation !== this.#requestedGeneration) return undefined;
    if (!rootReal) {
      for (const owner of owners) ownerFailures.set(owner.relPath, "failed");
      this.#recordRetry("sync-root", new Set(owners.map((owner) => owner.relPath)));
      pendingRetryKeys.add("sync-root");
      return { desired, ownerTargets, ownerFailures, pendingRetryKeys };
    }
    this.#retries.delete("sync-root");
    this.#rootReal = rootReal;
    const admissionCache = new Map<string, Promise<AdmissionResult | undefined>>();

    for (const owner of admitted) {
      const repoDir = owner.relPath === "." ? this.#root : path.join(this.#root, ...owner.relPath.split("/"));
      const resolveKey = `owner\0${owner.relPath}`;
      const resolveRetry = this.#retries.get(resolveKey);
      if (resolveRetry && resolveRetry.nextAttemptAt > this.#clock.now()) {
        pendingRetryKeys.add(resolveKey);
        ownerFailures.set(owner.relPath, "failed");
        continue;
      }
      const ctx = await this.#resolveRepo(repoDir).catch(() => undefined);
      if (this.#closed || generation !== this.#requestedGeneration) return undefined;
      if (!ctx) {
        ownerFailures.set(owner.relPath, "failed");
        this.#recordRetry(resolveKey, new Set([owner.relPath]));
        pendingRetryKeys.add(resolveKey);
        continue;
      }
      this.#retries.delete(resolveKey);
      const storageKey = `storage\0${owner.relPath}`;
      const storageRetry = this.#retries.get(storageKey);
      if (storageRetry && storageRetry.nextAttemptAt > this.#clock.now()) {
        pendingRetryKeys.add(storageKey);
        ownerFailures.set(owner.relPath, "failed");
        continue;
      }
      let storage: string | undefined;
      try {
        storage = await this.#refStorage(repoDir);
      } catch (error) {
        if (this.#closed || generation !== this.#requestedGeneration) return undefined;
        ownerFailures.set(owner.relPath, "failed");
        this.#recordRetry(storageKey, new Set([owner.relPath]));
        pendingRetryKeys.add(storageKey);
        this.#onLog?.(`git ref watcher config authority unavailable for ${owner.relPath}: ${errorMessage(error)}`);
        continue;
      }
      this.#retries.delete(storageKey);
      if (this.#closed || generation !== this.#requestedGeneration) return undefined;
      if (storage === "reftable") {
        ownerFailures.set(owner.relPath, "refused");
        this.#onLog?.(`git ref watcher refused ${owner.relPath}: reftable ref storage is unsupported`);
        continue;
      }

      const specs: Array<{ rawRoot: string; mode: GitRefWatchMode; role: GitRefWatchRole }> = [
        { rawRoot: ctx.gitDir, mode: "shallow", role: "gitDir" },
        { rawRoot: ctx.commonDir, mode: "shallow", role: "commonDir" },
        { rawRoot: path.join(ctx.commonDir, "refs"), mode: "shallow", role: "refsRoot" },
      ];
      const admissionKey = `namespace\0${path.resolve(ctx.commonDir)}`;
      const admissionRetry = this.#retries.get(admissionKey);
      let admittedNamespaces: AdmissionResult;
      if (admissionRetry && admissionRetry.nextAttemptAt > this.#clock.now()) {
        admissionRetry.owners.add(owner.relPath);
        pendingRetryKeys.add(admissionKey);
        admittedNamespaces = { ok: false, reason: "admission retry pending" };
      } else {
        let admission = admissionCache.get(ctx.commonDir);
        if (!admission) {
          admission = this.#admitNamespaces(ctx.commonDir, generation);
          admissionCache.set(ctx.commonDir, admission);
        }
        const result = await admission;
        if (!result) return undefined;
        admittedNamespaces = result;
        if (result.ok) {
          this.#retries.delete(admissionKey);
        } else {
          const recorded = this.#retries.get(admissionKey);
          if (recorded && recorded.nextAttemptAt > this.#clock.now()) recorded.owners.add(owner.relPath);
          else this.#recordRetry(admissionKey, new Set([owner.relPath]));
          pendingRetryKeys.add(admissionKey);
        }
      }
      if (this.#closed || generation !== this.#requestedGeneration) return undefined;
      if (admittedNamespaces.ok) {
        specs.push(
          { rawRoot: path.join(ctx.commonDir, "refs", "heads"), mode: "recursive", role: "refsNamespace" },
          { rawRoot: path.join(ctx.commonDir, "refs", "tags"), mode: "recursive", role: "refsNamespace" }
        );
      } else {
        ownerFailures.set(owner.relPath, "failed");
        this.#onLog?.(`git ref watcher namespace admission deferred for ${owner.relPath}: ${admittedNamespaces.reason}`);
      }

      const keys = new Set<string>();
      for (const spec of specs) {
        const rawKey = targetKey(path.resolve(spec.rawRoot), spec.mode);
        const rawRetry = this.#retries.get(rawKey);
        if (rawRetry && rawRetry.nextAttemptAt > this.#clock.now()) {
          pendingRetryKeys.add(rawKey);
          ownerFailures.set(owner.relPath, "failed");
          // Keep a still-live pre-replacement handle in the desired graph while
          // its retry is sleeping. Otherwise an unrelated reconcile would treat
          // the temporarily omitted root as removed and retire useful coverage.
          const held = [...this.#active.values()].find((target) => target.rawRoot === spec.rawRoot && target.mode === spec.mode);
          if (held) {
            if (!desired.has(held.key)) desired.set(held.key, {
              key: held.key,
              rawRoot: held.rawRoot,
              canonicalRoot: held.canonicalRoot,
              mode: held.mode,
              contributors: new Map(held.contributors),
            });
            keys.add(held.key);
          }
          continue;
        }
        const canonicalRoot = await this.#realpath(spec.rawRoot).catch(() => undefined);
        if (this.#closed || generation !== this.#requestedGeneration) return undefined;
        if (!canonicalRoot) {
          ownerFailures.set(owner.relPath, "failed");
          this.#recordPathFailure(spec.rawRoot, spec.mode, owner.relPath, new Error("watch root unavailable"));
          pendingRetryKeys.add(rawKey);
          continue;
        }
        if (!within(rootReal, canonicalRoot)) {
          ownerFailures.set(owner.relPath, "outside");
          this.#onLog?.(`git ref watcher refused out-of-root target for ${owner.relPath}: ${canonicalRoot}`);
          continue;
        }
        const key = targetKey(canonicalRoot, spec.mode);
        // A missing raw path and an attach failure share a key when no symlink
        // canonicalization changes it. Preserve that due retry through attach so
        // another failure advances the exponential attempt; successful attach is
        // the only reset. A distinct lexical-path retry has served its purpose.
        if (rawKey !== key) this.#retries.delete(rawKey);
        keys.add(key);
        let target = desired.get(key);
        if (!target) {
          target = { key, rawRoot: spec.rawRoot, canonicalRoot, mode: spec.mode, contributors: new Map() };
          desired.set(key, target);
        }
        target.contributors.set(`${owner.relPath}\0${spec.role}\0${spec.rawRoot}`, { owner: owner.relPath, role: spec.role, generation: owner.generation });
      }
      ownerTargets.set(owner.relPath, keys);
    }
    return { desired, ownerTargets, ownerFailures, pendingRetryKeys };
  }

  async #admitNamespaces(commonDir: string, generation: number): Promise<AdmissionResult | undefined> {
    let dirs = 0;
    let entries = 0;
    const pending = [path.join(commonDir, "refs", "heads"), path.join(commonDir, "refs", "tags")];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      let stat: Awaited<ReturnType<typeof fsp.lstat>>;
      try {
        stat = await fsp.lstat(dir);
      } catch (error) {
        if (this.#closed || generation !== this.#requestedGeneration) return undefined;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { ok: false, reason: `read fault at ${dir}` };
      }
      if (this.#closed || generation !== this.#requestedGeneration) return undefined;
      if (stat.isSymbolicLink() || !stat.isDirectory()) return { ok: false, reason: `namespace root is not a real directory at ${dir}` };
      let handle: Awaited<ReturnType<typeof fsp.opendir>>;
      try {
        handle = await fsp.opendir(dir);
      } catch (error) {
        if (this.#closed || generation !== this.#requestedGeneration) return undefined;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        return { ok: false, reason: `read fault at ${dir}` };
      }
      if (this.#closed || generation !== this.#requestedGeneration) { await closeDir(handle); return undefined; }
      dirs++;
      if (dirs > this.#dirBudget) { await closeDir(handle); return { ok: false, reason: `directory budget ${this.#dirBudget} exceeded` }; }
      try {
        while (true) {
          const entry = await handle.read();
          if (this.#closed || generation !== this.#requestedGeneration) { await closeDir(handle); return undefined; }
          if (!entry) break;
          entries++;
          if (entries > this.#entryBudget) { await closeDir(handle); return { ok: false, reason: `entry budget ${this.#entryBudget} exceeded` }; }
          if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(path.join(dir, entry.name));
        }
      } catch {
        await closeDir(handle);
        if (this.#closed || generation !== this.#requestedGeneration) return undefined;
        return { ok: false, reason: `read fault at ${dir}` };
      }
      await closeDir(handle);
      if (this.#closed || generation !== this.#requestedGeneration) return undefined;
    }
    return { ok: true };
  }

  #attach(desired: DesiredTarget): ActiveTarget {
    let active!: ActiveTarget;
    const handle = this.#watch(desired.canonicalRoot, desired.mode, (eventType, filename) => {
      // The ref side-channel is an ACCELERATOR over the git safety floor: any
      // failure in here degrades to "this target is dirty" — it must never
      // propagate as an uncaught exception that takes the daemon down
      // (2026-07-26: Linux fs.watch delivered an undefined filename and the
      // resulting TypeError crash-looped a fresh device's daemon).
      try {
        if (this.#closed || this.#readerDead) return;
        const tail = Buffer.isBuffer(filename) ? filename.toString("utf8") : filename;
        // Nameless events (filename null OR undefined — Bun surfaces both on
        // Linux) mean "something under this root changed": conservatively
        // dirty the target; never hand a non-string to the classifier.
        if (tail == null || (eventType === "rename" && tail === "")) {
          this.#dirtyTarget(desired.key);
          return;
        }
        if (!safeTail(tail)) return;
        let signal = false;
        for (const contributor of (active?.contributors ?? desired.contributors).values()) {
          const eventClass = classifySafeRefEvent(contributor.role, tail);
          if (eventClass === "structure") {
            this.#dirtyTarget(desired.key);
            return;
          }
          if (eventClass === "lockPreSignal" && contributor.role === "commonDir"
            && tail === "packed-refs.lock" && this.#ownedRefMutations.has(desired.canonicalRoot)) continue;
          if (eventClass === "target" || eventClass === "lockPreSignal") signal = true;
        }
        if (signal) this.#onSignal?.();
      } catch (error) {
        try { this.#dirtyTarget(desired.key); } catch { /* detaching */ }
        this.#onLog?.(`git-ref-watch event error (degraded to dirty): ${error instanceof Error ? error.message : String(error)}`);
      }
    });
    active = { ...desired, contributors: new Map(desired.contributors), handle };
    handle.on?.("error", (error) => this.readerDied(error));
    return active;
  }

  #dirtyTarget(key: string): void {
    if (this.#closed || this.#readerDead) return;
    ++this.#inputEpoch;
    this.#forcedTargets.add(key);
    const target = this.#active.get(key);
    if (target) {
      for (const owner of this.#owners.values()) {
        for (const contributor of target.contributors.values()) {
          if (contributor.owner !== owner.relPath) continue;
          this.#dirtyOwner(owner, this.#inputEpoch);
          break;
        }
      }
    }
    this.#refreshFloor("structure");
    void this.#requestReconcile();
  }

  #recordFailure(desired: DesiredTarget, error: unknown): void {
    const owners = new Set([...desired.contributors.values()].map((contributor) => contributor.owner));
    this.#recordRetry(desired.key, owners);
    this.#onLog?.(`git ref watcher attach failed for ${desired.canonicalRoot}: ${errorMessage(error)}`);
  }

  #recordPathFailure(rawRoot: string, mode: GitRefWatchMode, owner: string, error: unknown): void {
    const key = targetKey(path.resolve(rawRoot), mode);
    this.#recordRetry(key, new Set([owner]));
    this.#onLog?.(`git ref watcher target unavailable at ${rawRoot}: ${errorMessage(error)}`);
  }

  #recordRetry(key: string, owners: Set<string>): void {
    const prior = this.#retries.get(key);
    const attempt = (prior?.attempt ?? 0) + 1;
    const base = Math.min(60_000, 1_000 * 2 ** (attempt - 1));
    const jitter = 0.8 + this.#clock.random() * 0.4;
    this.#retries.set(key, { attempt, nextAttemptAt: this.#clock.now() + Math.round(base * jitter), owners });
    this.#scheduleRetryTimer();
    this.#refreshFloor("attach-failure");
  }

  #scheduleRetryTimer(): void {
    this.#clearRetryTimer();
    if (this.#closed || this.#readerDead || this.#retries.size === 0) return;
    const next = Math.min(...[...this.#retries.values()].map((retry) => retry.nextAttemptAt));
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = undefined;
      if (!this.#closed && !this.#readerDead) void this.#requestReconcile();
    }, Math.max(0, next - this.#clock.now()));
  }

  #clearRetryTimer(): void {
    if (this.#retryTimer !== undefined) this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
  }

  #refreshFloor(reason: string): void {
    const next = this.#readerDead || this.#snapshotDirOwners.size > 0
      || [...this.#owners.values()].some((owner) => owner.floorDir);
    if (next === this.#floorRequired) return;
    this.#floorRequired = next;
    this.#onFloorChange?.(next, reason);
  }

  #resolveWaiters(generation: number): void {
    const keep: Array<{ generation: number; resolve: () => void }> = [];
    for (const waiter of this.#waiters) {
      if (waiter.generation <= generation) waiter.resolve();
      else keep.push(waiter);
    }
    this.#waiters = keep;
  }
}

export const ownerOrder = (a: Pick<DiscoveredGitRepo, "relPath">, b: Pick<DiscoveredGitRepo, "relPath">): number =>
  a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0;

const orderedUniqueRepos = (repos: readonly DiscoveredGitRepo[]): DiscoveredGitRepo[] =>
  [...new Map(repos.map((repo) => [repo.relPath, repo])).values()].sort(ownerOrder);

const within = (rootReal: string, targetReal: string): boolean => {
  const rel = path.relative(rootReal, targetReal);
  return rel === "" || rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
};

const targetKey = (canonicalRoot: string, mode: GitRefWatchMode): string => `${mode}\0${canonicalRoot}`;

async function closeHandle(handle: GitRefWatchHandle): Promise<void> {
  try { await handle.close(); } catch { /* close is an idempotent fence */ }
}

async function closeDir(handle: { close(): void | Promise<void> }): Promise<void> {
  try { await handle.close(); } catch { /* admission is best-effort; read fault already pins */ }
}

async function pathPresence(target: string): Promise<boolean | undefined> {
  try {
    await fsp.lstat(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? false : undefined;
  }
}

const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
