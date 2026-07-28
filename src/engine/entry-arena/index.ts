/**
 * Public surface of the U0 entry-interning unit. Deliberately absent:
 * `createOwnerControl`, `authenticateOwner`, `seedCandidate`, `discardUnseeded`,
 * `abortControl`, `controlOfOwner`, `replaceOnOwnerQueue`, `OwnerControl`, and
 * `CandidateGeneration`, plus the construction keys — the mutable builder, the
 * raw control block, and the capability minting stay module-private, and
 * `withGenerationOwnerScope` is the only owner construction path.
 */
export { EntryArena, defaultFingerprint, sameEntryExact, type ArenaSlot, type ArenaStats, type EntryArenaOptions } from "./arena.js";
export { withCipherDescriptor, type CipherDescriptor } from "./cipher-descriptor.js";
export { PublishedGeneration } from "./generation.js";
export {
  EntryLeaseError,
  EntryShapeError,
  GenerationOwnerCapabilityError,
  GenerationReplacementConflict,
  WorkerLifecycleError,
  type ReplacementConflictReason,
} from "./errors.js";
export {
  abortGeneration,
  candidateRef,
  discardGeneration,
  inspectOwner,
  publishGeneration,
  replaceInternedEntry,
  workerRequest,
  type AbortOutcome,
  type GenerationOwnerLease,
  type OwnerSnapshot,
  type ReplaceInternedEntryArgs,
  type ReplaceInternedEntryResult,
} from "./owner.js";
export { registerWorker, type WorkerApplyContext, type WorkerRegistration } from "./workers.js";
export { withGenerationOwnerScope, type CandidateSeed, type GenerationOwnerScope } from "./scope.js";
export type {
  EntryLease,
  EntryVersionToken,
  GenerationId,
  GenerationMutationToken,
  OwnedEntryRef,
  OwnerTerminalState,
  PublishedGenerationToken,
  ReplacementDisposition,
  SlotId,
  WorkerEntryRequest,
  WorkerIntakeState,
  WorkerLifecycleState,
  WorkerResultId,
} from "./tokens.js";
