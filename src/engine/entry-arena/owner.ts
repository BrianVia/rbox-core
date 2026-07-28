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
 * `createOwnerControl`/`authenticateOwner` demand a module-private construction
 * key, so a deep import cannot mint an owner outside a scope.
 */
import type { FileEntry } from "../types.js";
import type { EntryArena } from "./arena.js";
import { CandidateGeneration, PublishedGeneration } from "./generation.js";
import { GenerationOwnerCapabilityError, GenerationReplacementConflict, WorkerLifecycleError } from "./errors.js";
import { OWNER_CONSTRUCTION_KEY, requireConstructionKey, type OwnerConstructionKey } from "./internal.js";
import { SerializedQueue } from "./queue.js";
import {
  makeVersionToken,
  sameVersion,
  type EntryVersionToken,
  type GenerationMutationToken,
  type OwnedEntryRef,
  type OwnerTerminalState,
  type ReplacementDisposition,
  type WorkerEntryRequest,
  type WorkerIntakeState,
  type WorkerLifecycleState,
  type WorkerResultId,
} from "./tokens.js";

export interface GenerationOwnerLease {
  readonly ownerId: number;
}

export type AbortOutcome = "aborted" | "already-terminal";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

export interface WorkerRecord {
  readonly id: WorkerResultId;
  state: WorkerLifecycleState;
  discardOnReturn: boolean;
  readonly cancel?: () => void;
}

export interface OwnerControl {
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
  /** The token a publication/discard in progress expects to still see. Only
   *  advances made by that drain's own worker-return callbacks update it. */
  drainExpectation: GenerationMutationToken | null;
  terminalState: OwnerTerminalState;
  workerIntake: WorkerIntakeState;
  pendingResults: number;
  nextTokenSequence: number;
  nextWorkerId: number;
  drainWaiters: Array<() => void>;
  releaseCallbackDepth: number;
  abort?: Deferred<AbortOutcome>;
}

/** Isolate-private capability registry. Never enumerated, never a lifetime. */
const OWNER_CONTROLS = new WeakMap<GenerationOwnerLease, OwnerControl>();

let nextOwnerId = 1;

export function controlOfOwner(owner: GenerationOwnerLease): OwnerControl {
  const control = OWNER_CONTROLS.get(owner);
  if (!control) throw new GenerationOwnerCapabilityError();
  return control;
}

export function authenticateOwner(key: OwnerConstructionKey, owner: GenerationOwnerLease): OwnerControl {
  requireConstructionKey(key, OWNER_CONSTRUCTION_KEY, "authenticateOwner");
  return controlOfOwner(owner);
}

/** Creates an UNSEEDED owner. The caller registers the control in its scope
 *  BEFORE seeding, so a throwing seed iterator can never leak retains that the
 *  strong registry cannot find (see `seedCandidate`/`discardUnseeded`). */
export function createOwnerControl(
  key: OwnerConstructionKey,
  arena: EntryArena,
  onTerminal: (ownerId: number) => void,
): { owner: GenerationOwnerLease; token: GenerationMutationToken; control: OwnerControl } {
  requireConstructionKey(key, OWNER_CONSTRUCTION_KEY, "createOwnerControl");
  const ownerId = nextOwnerId++;
  const control: OwnerControl = {
    ownerId,
    arena,
    candidate: new CandidateGeneration(arena, arena.allocateGenerationId()),
    queue: new SerializedQueue(),
    workerResults: new Map(),
    onTerminal,
    abortHookErrors: [],
    currentToken: null,
    drainExpectation: null,
    terminalState: "live",
    workerIntake: "open",
    pendingResults: 0,
    nextTokenSequence: 1,
    nextWorkerId: 1,
    drainWaiters: [],
    releaseCallbackDepth: 0,
  };
  const token = advanceToken(control);
  const owner: GenerationOwnerLease = Object.freeze({ ownerId });
  OWNER_CONTROLS.set(owner, control);
  return { owner, token, control };
}

export function seedCandidate(
  key: OwnerConstructionKey,
  control: OwnerControl,
  entries: Iterable<Readonly<FileEntry>>,
): void {
  requireConstructionKey(key, OWNER_CONSTRUCTION_KEY, "seedCandidate");
  control.candidate.seed(entries);
}

/** Unwind for a seed that threw: the control is already registered, so its
 *  partial retains are released and the control leaves the registry terminal. */
export function discardUnseeded(key: OwnerConstructionKey, control: OwnerControl): void {
  requireConstructionKey(key, OWNER_CONSTRUCTION_KEY, "discardUnseeded");
  control.candidate.releaseAll();
  control.terminalState = "discarded";
  control.currentToken = null;
  control.workerResults.clear();
  control.onTerminal(control.ownerId);
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

export function requireOwnerLive(control: OwnerControl): void {
  if (control.terminalState !== "live") throw new GenerationReplacementConflict("not-live", control.terminalState);
}

function requireCurrentToken(control: OwnerControl, token: GenerationMutationToken): void {
  if (!control.currentToken || token !== control.currentToken) throw new GenerationReplacementConflict("stale-token");
}

export interface ReplaceInternedEntryArgs {
  owner: GenerationOwnerLease;
  token: GenerationMutationToken;
  path: string;
  expected: EntryVersionToken;
  next: Readonly<FileEntry>;
}

export interface ReplaceInternedEntryResult {
  token: GenerationMutationToken;
  entry: OwnedEntryRef;
  disposition: ReplacementDisposition;
}

/** Runs already on the owner queue. Every retain change and the `currentToken`
 *  update happen inside this one synchronous step. */
export function replaceOnOwnerQueue(
  control: OwnerControl,
  args: Omit<ReplaceInternedEntryArgs, "owner">,
  viaWorkerCallback: boolean,
): ReplaceInternedEntryResult {
  const { token, path, expected, next } = args;
  requireOwnerLive(control);
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
    const advanced = advanceToken(control);
    // The coordinator knows which advances are its own drain's; only those keep
    // a publication's expectation current (design 163 §1446-1453, §1472-1474).
    if (viaWorkerCallback && control.drainExpectation) control.drainExpectation = advanced;
    return { token: advanced, entry, disposition: "replaced" };
  } finally {
    if (!handedOff) control.arena.release(provisional);
  }
}

export function replaceInternedEntry(args: ReplaceInternedEntryArgs): Promise<ReplaceInternedEntryResult> {
  const control = controlOfOwner(args.owner);
  return control.queue.run(() => replaceOnOwnerQueue(control, args, false));
}

export function candidateRef(owner: GenerationOwnerLease, path: string): OwnedEntryRef | undefined {
  return controlOfOwner(owner).candidate.ref(path);
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
  const control = controlOfOwner(owner);
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

export function settleOwnerDrain(control: OwnerControl): void {
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
 *  then re-enter the queue to finalize. A returned-but-queued result therefore
 *  blocks the terminal step until its replacement/discard and release complete.
 *
 * The caller proves the exact current token at initiation; from there the
 * expectation follows this drain's own worker callbacks. Any advance made from
 * outside the drain leaves `currentToken !== drainExpectation` and fails the
 * terminal step. */
async function closeAndDrain(control: OwnerControl, token: GenerationMutationToken): Promise<void> {
  await control.queue.run(() => {
    requireOwnerLive(control);
    requireCurrentToken(control, token);
    control.workerIntake = "closed";
    control.drainExpectation = control.currentToken;
  });
  await drained(control);
}

/** A resource-release callback must not SYNCHRONOUSLY start a terminal operation
 *  on its own owner: its registration is still pending, so that operation could
 *  only finish after the settlement that is waiting for the callback. Release
 *  runs off-queue, so this is a cycle detector, not a queue-occupancy fix. */
function requireNotInReleaseCallback(control: OwnerControl, operation: string): void {
  if (control.releaseCallbackDepth > 0) {
    throw new WorkerLifecycleError(`${operation} cannot be called from a resource-release callback of the same owner`);
  }
}

function requireDrainExpectation(control: OwnerControl): void {
  const expected = control.drainExpectation;
  control.drainExpectation = null;
  if (control.currentToken !== expected) {
    throw new GenerationReplacementConflict("stale-token", "the candidate advanced outside this drain");
  }
}

export async function publishGeneration(
  owner: GenerationOwnerLease,
  token: GenerationMutationToken,
): Promise<PublishedGeneration> {
  const control = controlOfOwner(owner);
  requireNotInReleaseCallback(control, "publishGeneration");
  await closeAndDrain(control, token);
  return control.queue.run(() => {
    requireOwnerLive(control);
    if (control.pendingResults !== 0) throw new GenerationReplacementConflict("pending-results");
    requireDrainExpectation(control);
    const published = new PublishedGeneration(
      control.arena,
      control.candidate.generationId,
      control.candidate.transfer(),
    );
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
  const control = controlOfOwner(owner);
  requireNotInReleaseCallback(control, "discardGeneration");
  await closeAndDrain(control, token);
  await control.queue.run(() => {
    requireOwnerLive(control);
    if (control.pendingResults !== 0) throw new GenerationReplacementConflict("pending-results");
    requireDrainExpectation(control);
    control.candidate.releaseAll();
    control.terminalState = "discarded";
    control.currentToken = null;
    control.workerResults.clear();
    control.onTerminal(control.ownerId);
  });
}

/** Unconditional terminal API: authenticates the owner, accepts no token. */
export function abortGeneration(owner: GenerationOwnerLease): Promise<AbortOutcome> {
  const control = controlOfOwner(owner);
  requireNotInReleaseCallback(control, "abortGeneration");
  return abortControl(control);
}

export function abortControl(control: OwnerControl): Promise<AbortOutcome> {
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
    control.drainExpectation = null;
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
