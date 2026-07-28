/**
 * The U0 replacement seam (design 163 § "Early U0"): one mutable candidate
 * generation per `GenerationOwnerLease`, mutated only through a serialized
 * queue whose sole mutation-token custodian is this coordinator.
 *
 * `GenerationOwnerLease` is a runtime capability authenticated by the
 * isolate-private WeakMap below. A TypeScript brand alone is not authority. The
 * WeakMap authenticates only — it owns no lifetime and is never enumerated;
 * lifetime belongs to `GenerationOwnerScope`'s strong, enumerable registry.
 */
import type { FileEntry } from "../types.js";
import type { EntryArena } from "./arena.js";
import { CandidateGeneration, PublishedGeneration } from "./generation.js";
import { GenerationOwnerCapabilityError, GenerationReplacementConflict } from "./errors.js";
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

interface WorkerRecord {
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
  currentToken: GenerationMutationToken | null;
  terminalState: OwnerTerminalState;
  workerIntake: WorkerIntakeState;
  pendingResults: number;
  nextTokenSequence: number;
  nextWorkerId: number;
  drainWaiters: Array<() => void>;
  abort?: { promise: Promise<void>; resolve: () => void };
}

/** Isolate-private capability registry. Never enumerated, never a lifetime. */
const OWNER_CONTROLS = new WeakMap<GenerationOwnerLease, OwnerControl>();

let nextOwnerId = 1;

export function authenticateOwner(owner: GenerationOwnerLease): OwnerControl {
  const control = OWNER_CONTROLS.get(owner);
  if (!control) throw new GenerationOwnerCapabilityError();
  return control;
}

export function createOwnerControl(
  arena: EntryArena,
  onTerminal: (ownerId: number) => void,
  seed?: Iterable<Readonly<FileEntry>>,
): { owner: GenerationOwnerLease; token: GenerationMutationToken; control: OwnerControl } {
  const ownerId = nextOwnerId++;
  const candidate = new CandidateGeneration(arena, arena.allocateGenerationId());
  if (seed) candidate.seed(seed);
  const control: OwnerControl = {
    ownerId,
    arena,
    candidate,
    queue: new SerializedQueue(),
    workerResults: new Map(),
    onTerminal,
    currentToken: null,
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
  return { owner, token, control };
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
function replaceOnQueue(
  control: OwnerControl,
  args: Omit<ReplaceInternedEntryArgs, "owner">,
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
    return { token: advanceToken(control), entry, disposition: "replaced" };
  } finally {
    if (!handedOff) control.arena.release(provisional);
  }
}

export function replaceInternedEntry(args: ReplaceInternedEntryArgs): Promise<ReplaceInternedEntryResult> {
  const control = authenticateOwner(args.owner);
  return control.queue.run(() => replaceOnQueue(control, args));
}

/** The coordinator is the sole token custodian, so it — and only it, by
 *  capability — can re-read the current token after applying worker results
 *  inside a return callback. Workers never see this. */
export function currentMutationToken(owner: GenerationOwnerLease): GenerationMutationToken {
  const control = authenticateOwner(owner);
  if (!control.currentToken) throw new GenerationReplacementConflict("stale-token", control.terminalState);
  return control.currentToken;
}

export function candidateRef(owner: GenerationOwnerLease, path: string): OwnedEntryRef | undefined {
  return authenticateOwner(owner).candidate.ref(path);
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
}

export function inspectOwner(owner: GenerationOwnerLease): OwnerSnapshot {
  const control = authenticateOwner(owner);
  return {
    ownerId: control.ownerId,
    generationId: control.candidate.generationId,
    terminalState: control.terminalState,
    workerIntake: control.workerIntake,
    pendingResults: control.pendingResults,
    tokenSequence: control.currentToken?.sequence ?? null,
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
  control.abort?.resolve();
}

/** Close intake, wait off-queue for every registered worker to reach `done`,
 *  then re-enter the queue to finalize. A returned-but-queued result therefore
 *  blocks publication until its replacement/discard and release complete.
 *
 * The caller's exact current token is proved at INITIATION. Token advances made
 * afterwards by this coordinator's own worker-return callbacks do not invalidate
 * the decision: those tokens are transient and, by contract, never leave the
 * queue step that produced them. */
async function closeAndDrain(control: OwnerControl, token: GenerationMutationToken): Promise<void> {
  await control.queue.run(() => {
    requireLive(control);
    requireCurrentToken(control, token);
    control.workerIntake = "closed";
  });
  await drained(control);
}

export async function publishGeneration(
  owner: GenerationOwnerLease,
  token: GenerationMutationToken,
): Promise<PublishedGeneration> {
  const control = authenticateOwner(owner);
  await closeAndDrain(control, token);
  return control.queue.run(() => {
    requireLive(control);
    if (control.pendingResults !== 0) throw new GenerationReplacementConflict("pending-results");
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
  const control = authenticateOwner(owner);
  await closeAndDrain(control, token);
  await control.queue.run(() => {
    requireLive(control);
    control.candidate.releaseAll();
    control.terminalState = "discarded";
    control.currentToken = null;
    control.workerResults.clear();
    control.onTerminal(control.ownerId);
  });
}

/** Unconditional terminal API: authenticates the owner, accepts no token. */
export function abortGeneration(owner: GenerationOwnerLease): Promise<"aborted" | "already-terminal"> {
  return abortControl(authenticateOwner(owner));
}

export function abortControl(control: OwnerControl): Promise<"aborted" | "already-terminal"> {
  if (control.abort) return control.abort.promise.then(() => "already-terminal" as const);
  if (control.terminalState !== "live") return Promise.resolve("already-terminal" as const);
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  control.abort = { promise, resolve };
  void control.queue.run(() => {
    control.workerIntake = "closed";
    control.terminalState = "aborting";
    control.currentToken = null;
    for (const record of control.workerResults.values()) {
      if (record.state === "done") continue;
      record.discardOnReturn = true;
      record.cancel?.();
    }
    if (control.pendingResults === 0) finalizeAbort(control);
  });
  return promise.then(() => "aborted" as const);
}

export interface WorkerApplyContext {
  readonly token: GenerationMutationToken;
  /** Synchronous replacement, already on the owner queue. */
  replace(path: string, expected: EntryVersionToken, next: Readonly<FileEntry>): ReplaceInternedEntryResult;
}

export interface WorkerRegistration {
  readonly id: WorkerResultId;
  readonly state: WorkerLifecycleState;
  markRunning(): Promise<void>;
  /** `registered -> running -> result-returned -> applying|discarding ->
   *  resources-released -> done`. Pending in every state before `done`; promise
   *  settlement alone never decrements `pendingResults`. */
  returnResult(
    apply: (context: WorkerApplyContext) => void,
    releaseResources?: () => void | Promise<void>,
  ): Promise<"applied" | "discarded">;
  /** Terminal without a result (the worker threw or was cancelled). */
  fail(releaseResources?: () => void | Promise<void>): Promise<"discarded">;
}

export function registerWorker(
  owner: GenerationOwnerLease,
  options: { cancel?: () => void } = {},
): Promise<WorkerRegistration> {
  const control = authenticateOwner(owner);
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
    return makeRegistration(control, record);
  });
}

function makeRegistration(control: OwnerControl, record: WorkerRecord): WorkerRegistration {
  const settle = async (
    apply: ((context: WorkerApplyContext) => void) | undefined,
    releaseResources: (() => void | Promise<void>) | undefined,
  ): Promise<"applied" | "discarded"> =>
    control.queue.run(async () => {
      record.state = "result-returned";
      const discard = apply === undefined || record.discardOnReturn || control.terminalState !== "live";
      record.state = discard ? "discarding" : "applying";
      try {
        if (!discard) {
          apply!({
            get token(): GenerationMutationToken {
              if (!control.currentToken) throw new GenerationReplacementConflict("stale-token");
              return control.currentToken;
            },
            replace: (path, expected, next) =>
              replaceOnQueue(control, { token: control.currentToken!, path, expected, next }),
          });
        }
      } finally {
        if (releaseResources) await releaseResources();
        record.state = "resources-released";
        record.state = "done";
        control.workerResults.delete(record.id);
        control.pendingResults--;
        settleDrain(control);
      }
      return discard ? "discarded" : "applied";
    });

  return {
    id: record.id,
    get state(): WorkerLifecycleState {
      return record.state;
    },
    markRunning: () =>
      control.queue.run(() => {
        if (record.state === "registered") record.state = "running";
      }),
    returnResult: (apply, releaseResources) => settle(apply, releaseResources),
    fail: (releaseResources) => settle(undefined, releaseResources) as Promise<"discarded">,
  };
}
