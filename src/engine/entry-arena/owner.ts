/**
 * The U0 replacement seam (design 163 § "Early U0"): one mutable candidate
 * generation per `GenerationOwnerLease`, mutated only through a serialized
 * queue whose sole mutation-token custodian is this coordinator.
 *
 * `GenerationOwnerLease` is a runtime capability authenticated by the
 * isolate-private WeakMap below. A TypeScript brand alone is not authority. The
 * WeakMap authenticates only — it owns no lifetime and is never enumerated;
 * lifetime belongs to `GenerationOwnerScope`'s strong, enumerable registry.
 *
 * ALL construction authority is co-located HERE, lexically: the control block,
 * the owner registry, the scope and its construction key, and the published
 * generation registry. Nothing is handed across a module boundary, so there is
 * no import order in which a capability can be claimed. Nothing exported yields
 * an `OwnerControl`, and worker code receives a narrow port, never a control.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { FileEntry } from "../types.js";
import type { EntryArena } from "./arena.js";
import { CandidateGeneration, PublishedGeneration } from "./generation.js";
import {
  EntryLeaseError,
  GenerationOwnerCapabilityError,
  GenerationReplacementConflict,
  OwnerReentrancyError,
} from "./errors.js";
import { SerializedQueue, deferred } from "./queue.js";
import { createRegistration, type WorkerOwnerPort, type WorkerRecord, type WorkerRegistration } from "./workers.js";
import {
  makeVersionToken,
  sameVersion,
  type AbortOutcome,
  type EntryVersionToken,
  type GenerationOwnerLease,
  type GenerationMutationToken,
  type OwnedEntryRef,
  type OwnerTerminalState,
  type PublishedGenerationToken,
  type ReplaceInternedEntryArgs,
  type ReplaceInternedEntryResult,
  type WorkerEntryRequest,
  type WorkerIntakeState,
  type WorkerResultId,
} from "./tokens.js";

/** One publication/discard in flight. The expectation follows ONLY an unbroken
 *  chain of this drain's own worker callbacks; anything else poisons it. */
interface DrainState {
  expectation: GenerationMutationToken;
  poisoned: boolean;
}

interface OwnerControl {
  readonly ownerId: number;
  readonly arena: EntryArena;
  readonly candidate: CandidateGeneration;
  readonly queue: SerializedQueue;
  readonly workerResults: Map<WorkerResultId, WorkerRecord>;
  readonly onTerminal: (ownerId: number) => void;
  /** Errors thrown by cancellation hooks. Recorded, never propagated: one bad
   *  hook can neither skip a later hook nor strand the abort promise. */
  readonly abortHookErrors: unknown[];
  currentToken: GenerationMutationToken | null;
  drain: DrainState | null;
  terminalState: OwnerTerminalState;
  workerIntake: WorkerIntakeState;
  pendingResults: number;
  nextTokenSequence: number;
  nextWorkerId: number;
  drainWaiters: Array<() => void>;
  port?: WorkerOwnerPort;
  abort?: { promise: Promise<AbortOutcome>; resolve: (value: AbortOutcome) => void };
}

/** Isolate-private capability registry. Never enumerated, never a lifetime. */
const OWNER_CONTROLS = new WeakMap<GenerationOwnerLease, OwnerControl>();

/** Set for the whole dynamic extent of a resource-release callback, propagated
 *  across awaits. NO owner may be driven terminal from inside one: a same-owner
 *  call is a direct cycle and two cross-owner calls are a mutual one, and no
 *  flow needs it — each candidate has exactly one lease, and scope teardown
 *  does the no-capability cleanup. */
const IN_RELEASE_CALLBACK = new AsyncLocalStorage<true>();

let nextOwnerId = 1;

function controlOf(owner: GenerationOwnerLease): OwnerControl {
  const control = OWNER_CONTROLS.get(owner);
  if (!control) throw new GenerationOwnerCapabilityError();
  return control;
}

function requireNoReleaseCycle(operation: string): void {
  if (IN_RELEASE_CALLBACK.getStore()) throw new OwnerReentrancyError(operation);
}

function advanceToken(control: OwnerControl): GenerationMutationToken {
  const token = Object.freeze({
    kind: "mutation" as const,
    ownerId: control.ownerId,
    sequence: control.nextTokenSequence++,
  });
  control.currentToken = token;
  return token;
}

function requireLive(control: OwnerControl): void {
  if (control.terminalState !== "live") throw new GenerationReplacementConflict("not-live", control.terminalState);
}

function requireCurrentToken(control: OwnerControl, token: GenerationMutationToken): void {
  if (!control.currentToken || token !== control.currentToken) throw new GenerationReplacementConflict("stale-token");
}

/** Runs already on the owner queue. Every retain change and the `currentToken`
 *  update happen inside this one synchronous step. */
function replaceOnQueue(
  control: OwnerControl,
  args: Omit<ReplaceInternedEntryArgs, "owner">,
  viaWorkerCallback: boolean,
): ReplaceInternedEntryResult {
  const { token, path, expected, next } = args;
  requireLive(control);
  requireCurrentToken(control, token);
  if (next.path !== path) throw new GenerationReplacementConflict("path-mismatch", `${next.path} !== ${path}`);
  const state = control.candidate.state(path);
  if (!state) throw new GenerationReplacementConflict("unknown-path", path);
  const current = makeVersionToken(control.candidate.generationId, path, state.pathEpoch, state.slot.id);
  if (!sameVersion(expected, current)) throw new GenerationReplacementConflict("stale-version", path);

  const provisional = control.arena.internExact(next);
  let handedOff = false;
  try {
    if (provisional === state.slot) {
      return { token, entry: control.candidate.ref(path)!, disposition: "unchanged" };
    }
    const entry = control.candidate.replace(path, provisional);
    handedOff = true;
    // A drain's expectation may only follow an UNBROKEN chain of that drain's
    // own callbacks. An outside advance — or a worker replaying a laundered
    // outside token — poisons it and fails the terminal step.
    const drain = control.drain;
    if (drain) {
      if (viaWorkerCallback && token === drain.expectation) drain.expectation = advanceToken(control);
      else {
        drain.poisoned = true;
        advanceToken(control);
      }
    } else {
      advanceToken(control);
    }
    return { token: control.currentToken!, entry, disposition: "replaced" };
  } finally {
    if (!handedOff) control.arena.release(provisional);
  }
}

export function replaceInternedEntry(args: ReplaceInternedEntryArgs): Promise<ReplaceInternedEntryResult> {
  const control = controlOf(args.owner);
  return control.queue.run(() => replaceOnQueue(control, args, false));
}

export function candidateRef(owner: GenerationOwnerLease, path: string): OwnedEntryRef | undefined {
  return controlOf(owner).candidate.ref(path);
}

/** The immutable DTO a crypto worker receives — never the owner, never a token. */
export function workerRequest(owner: GenerationOwnerLease, path: string): WorkerEntryRequest {
  const ref = candidateRef(owner, path);
  if (!ref) throw new GenerationReplacementConflict("unknown-path", path);
  return Object.freeze({ path, expected: ref.version, entry: ref.entry });
}

export interface OwnerSnapshot {
  ownerId: number;
  generationId: number;
  terminalState: OwnerTerminalState;
  workerIntake: WorkerIntakeState;
  pendingResults: number;
  tokenSequence: number | null;
  abortHookErrors: readonly unknown[];
}

export function inspectOwner(owner: GenerationOwnerLease): OwnerSnapshot {
  const control = controlOf(owner);
  return {
    ownerId: control.ownerId,
    generationId: control.candidate.generationId,
    terminalState: control.terminalState,
    workerIntake: control.workerIntake,
    pendingResults: control.pendingResults,
    tokenSequence: control.currentToken?.sequence ?? null,
    abortHookErrors: control.abortHookErrors,
  };
}

function drained(control: OwnerControl): Promise<void> {
  if (control.pendingResults === 0) return Promise.resolve();
  return new Promise<void>((resolve) => control.drainWaiters.push(resolve));
}

function settleDrain(control: OwnerControl): void {
  if (control.pendingResults !== 0) return;
  const waiters = control.drainWaiters;
  control.drainWaiters = [];
  for (const waiter of waiters) waiter();
  if (control.terminalState === "aborting") finalizeAbort(control);
}

function finalizeAbort(control: OwnerControl): void {
  if (control.terminalState !== "aborting") return;
  control.terminalState = "discarded";
  control.candidate.releaseAll();
  control.workerResults.clear();
  control.onTerminal(control.ownerId);
  control.abort?.resolve("aborted");
}

/** Close intake, wait off-queue for every registered worker to reach `done`,
 *  then re-enter the queue to finalize. A returned-but-queued result blocks the
 *  terminal step until its replacement/discard and release complete. */
async function closeAndDrain(control: OwnerControl, token: GenerationMutationToken): Promise<void> {
  await control.queue.run(() => {
    requireLive(control);
    if (control.drain) throw new GenerationReplacementConflict("pending-results", "another terminal operation is draining");
    requireCurrentToken(control, token);
    control.workerIntake = "closed";
    control.drain = { expectation: control.currentToken!, poisoned: false };
  });
  try {
    await drained(control);
  } catch (error) {
    control.drain = null;
    throw error;
  }
}

function takeDrain(control: OwnerControl): DrainState {
  const drain = control.drain;
  control.drain = null;
  if (!drain || drain.poisoned || control.currentToken !== drain.expectation) {
    throw new GenerationReplacementConflict("stale-token", "the candidate advanced outside this drain");
  }
  return drain;
}

export async function publishGeneration(
  owner: GenerationOwnerLease,
  token: GenerationMutationToken,
): Promise<PublishedGeneration> {
  const control = controlOf(owner);
  requireNoReleaseCycle("publishGeneration");
  await closeAndDrain(control, token);
  return control.queue.run(() => {
    requireLive(control);
    if (control.pendingResults !== 0) throw new GenerationReplacementConflict("pending-results");
    takeDrain(control);
    const published = new PublishedGeneration(
      control.arena,
      control.candidate.generationId,
      control.candidate.transfer(),
    );
    LIVE_PUBLISHED.set(published.token, published);
    control.terminalState = "published";
    control.currentToken = null;
    control.workerResults.clear();
    control.onTerminal(control.ownerId);
    return published;
  });
}

export async function discardGeneration(
  owner: GenerationOwnerLease,
  token: GenerationMutationToken,
): Promise<void> {
  const control = controlOf(owner);
  requireNoReleaseCycle("discardGeneration");
  await closeAndDrain(control, token);
  await control.queue.run(() => {
    requireLive(control);
    if (control.pendingResults !== 0) throw new GenerationReplacementConflict("pending-results");
    takeDrain(control);
    control.candidate.releaseAll();
    control.terminalState = "discarded";
    control.currentToken = null;
    control.workerResults.clear();
    control.onTerminal(control.ownerId);
  });
}

/** Unconditional terminal API: authenticates the owner, accepts no token. */
export function abortGeneration(owner: GenerationOwnerLease): Promise<AbortOutcome> {
  return abortControl(controlOf(owner), "abortGeneration");
}

function abortControl(control: OwnerControl, operation: string): Promise<AbortOutcome> {
  requireNoReleaseCycle(operation);
  if (control.abort) return control.abort.promise.then(() => "already-terminal" as const);
  if (control.terminalState !== "live") return Promise.resolve("already-terminal" as const);
  const pending = deferred<AbortOutcome>();
  control.abort = pending;
  void control.queue.run(() => {
    // Terminal state is re-read ON the queue: a publication queued ahead of this
    // task may already have won, and abort never rewrites a published generation.
    if (control.terminalState !== "live") {
      pending.resolve("already-terminal");
      return;
    }
    control.workerIntake = "closed";
    control.terminalState = "aborting";
    control.currentToken = null;
    control.drain = null;
    for (const record of control.workerResults.values()) {
      if (record.state === "done") continue;
      record.discardOnReturn = true;
      if (!record.cancel) continue;
      try {
        record.cancel();
      } catch (error) {
        control.abortHookErrors.push(error);
      }
    }
    if (control.pendingResults === 0) finalizeAbort(control);
  });
  return pending.promise;
}

function portFor(control: OwnerControl): WorkerOwnerPort {
  control.port ??= {
    runOnQueue: (task) => control.queue.run(task),
    isLive: () => control.terminalState === "live",
    replace: (path, expected, next) => {
      if (!control.currentToken) throw new GenerationReplacementConflict("stale-token");
      const result = replaceOnQueue(control, { token: control.currentToken, path, expected, next }, true);
      return { entry: result.entry, disposition: result.disposition };
    },
    finishWorker: (record) => {
      control.workerResults.delete(record.id);
      control.pendingResults--;
      settleDrain(control);
    },
    runRelease: (run) => IN_RELEASE_CALLBACK.run(true, run),
  };
  return control.port;
}

export function registerWorker(
  owner: GenerationOwnerLease,
  options: { cancel?: () => void } = {},
): Promise<WorkerRegistration> {
  const control = controlOf(owner);
  return control.queue.run(() => {
    requireLive(control);
    if (control.workerIntake !== "open") throw new GenerationReplacementConflict("intake-closed");
    const record: WorkerRecord = {
      id: control.nextWorkerId++,
      state: "registered",
      discardOnReturn: false,
      cancel: options.cancel,
    };
    control.workerResults.set(record.id, record);
    control.pendingResults++;
    return createRegistration(portFor(control), record);
  });
}

/** Published generations that `publishGeneration` registered. The TOKEN is the
 *  seed capability and this map is the only thing that grants it, so a
 *  hand-constructed `PublishedGeneration` — or any impostor token — is inert. */
const LIVE_PUBLISHED = new WeakMap<PublishedGenerationToken, PublishedGeneration>();

function resolvePublished(token: PublishedGenerationToken): PublishedGeneration {
  const generation = LIVE_PUBLISHED.get(token);
  if (!generation || generation.isReleased) throw new EntryLeaseError("published generation token is not live");
  return generation;
}

/** Construction key for the scope. A module-scope const that never leaves this
 *  file, so `withGenerationOwnerScope` really is the only construction path —
 *  there is no handoff to steal and no import order that changes that. */
const SCOPE_KEY = Symbol("rbox.entry-arena.scope-construction");

export interface CandidateSeed {
  /** The published TOKEN is the seed capability, and it takes its OWN
   *  one-per-slot retains. A released or unregistered token does not resolve,
   *  so only live published generations can seed. */
  seedFrom?: PublishedGenerationToken;
  entries?: Iterable<Readonly<FileEntry>>;
}

/** The strong, enumerable registry entry: exactly what teardown needs, with no
 *  way back to the control block. */
interface OwnerHandle {
  readonly owner: GenerationOwnerLease;
  readonly token: GenerationMutationToken;
  readonly ownerId: number;
  abort(operation: string): Promise<AbortOutcome>;
}

/**
 * Bounded owner scope. Its registry is strong and enumerable and OWNS every
 * handle until an exact terminal action, so teardown can release a candidate
 * even when the capability object was lost. It never relies on WeakMap
 * enumeration, `FinalizationRegistry`, or GC timing.
 */
export class GenerationOwnerScope {
  private readonly handles = new Map<number, OwnerHandle>();
  private closed = false;

  constructor(
    readonly arena: EntryArena,
    key: symbol,
  ) {
    if (key !== SCOPE_KEY) throw new Error("a generation owner scope is created only by withGenerationOwnerScope");
  }

  /** Only the workspace writer holding the workspace mutex may call this. */
  createOwner(seed: CandidateSeed = {}): { owner: GenerationOwnerLease; token: GenerationMutationToken } {
    if (this.closed) throw new Error("generation owner scope is closed");
    const entries = seed.entries ?? (seed.seedFrom ? resolvePublished(seed.seedFrom).entries : []);
    const ownerId = nextOwnerId++;
    const control: OwnerControl = {
      ownerId,
      arena: this.arena,
      candidate: new CandidateGeneration(this.arena, this.arena.allocateGenerationId()),
      queue: new SerializedQueue(),
      workerResults: new Map(),
      onTerminal: (id) => this.handles.delete(id),
      abortHookErrors: [],
      currentToken: null,
      drain: null,
      terminalState: "live",
      workerIntake: "open",
      pendingResults: 0,
      nextTokenSequence: 1,
      nextWorkerId: 1,
      drainWaiters: [],
    };
    const token = advanceToken(control);
    const owner: GenerationOwnerLease = Object.freeze({ ownerId });
    OWNER_CONTROLS.set(owner, control);
    // Registered BEFORE seeding: a throwing iterator then leaves partial retains
    // that this registry can still find and release.
    this.handles.set(ownerId, { owner, token, ownerId, abort: (operation) => abortControl(control, operation) });
    try {
      control.candidate.seed(entries);
    } catch (error) {
      control.candidate.releaseAll();
      control.terminalState = "discarded";
      control.currentToken = null;
      this.handles.delete(ownerId);
      throw error;
    }
    return { owner, token };
  }

  get liveOwnerIds(): number[] {
    return [...this.handles.keys()];
  }

  /** No-capability drain for owner loss. */
  async abortOwner(ownerId: number): Promise<AbortOutcome> {
    const handle = this.handles.get(ownerId);
    if (!handle) return "already-terminal";
    return handle.abort("scope.abortOwner");
  }

  /** Does not return before every owner reaches terminal with zero pending. */
  async abortAll(): Promise<void> {
    this.closed = true;
    while (this.handles.size > 0) {
      await Promise.all([...this.handles.values()].map((handle) => handle.abort("scope.abortAll")));
    }
  }
}

export async function withGenerationOwnerScope<T>(
  arena: EntryArena,
  body: (scope: GenerationOwnerScope) => Promise<T> | T,
): Promise<T> {
  const scope = new GenerationOwnerScope(arena, SCOPE_KEY);
  try {
    return await body(scope);
  } finally {
    await scope.abortAll();
  }
}
