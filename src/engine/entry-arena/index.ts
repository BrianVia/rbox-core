/**
 * Public surface of the U0 entry-interning unit. Deliberately absent:
 * `takeOwnerCapability`, `takePublicationCapability`, `OwnerControl`,
 * `OwnerHandle`, and `CandidateGeneration`. The minting capabilities are
 * claim-once handoffs consumed at module initialization by their single
 * legitimate consumer, the raw control block is unreachable, and
 * `withGenerationOwnerScope` is the only owner construction path.
 */
export {
  EntryArena,
  MAX_EXTENSION_DEPTH,
  canonicalEntryKey,
  defaultFingerprint,
  sameEntryExact,
  type ArenaSlot,
  type ArenaStats,
  type EntryArenaOptions,
} from "./arena.js";
export { withCipherDescriptor, type CipherDescriptor } from "./cipher-descriptor.js";
export { PublishedGeneration } from "./generation.js";
export {
  EntryLeaseError,
  EntryShapeError,
  GenerationOwnerCapabilityError,
  GenerationReplacementConflict,
  OwnerReentrancyError,
  WorkerLifecycleError,
  type ReplacementConflictReason,
} from "./errors.js";
export {
  abortGeneration,
  candidateRef,
  discardGeneration,
  inspectOwner,
  publishGeneration,
  registerWorker,
  replaceInternedEntry,
  workerRequest,
  type AbortOutcome,
  type GenerationOwnerLease,
  type OwnerSnapshot,
  type ReplaceInternedEntryArgs,
  type ReplaceInternedEntryResult,
} from "./owner.js";
export type { WorkerApplyContext, WorkerRegistration } from "./workers.js";
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
  WorkerReplacementResult,
  WorkerResultId,
} from "./tokens.js";
