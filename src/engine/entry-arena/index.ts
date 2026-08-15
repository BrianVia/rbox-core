/**
 * Public surface of the U0 entry-interning unit. Deliberately absent:
 * `OwnerControl`, `OwnerHandle`, and `CandidateGeneration`. All construction
 * authority is co-located inside `owner.ts` — its scope key and registries are
 * module-scope consts that never cross a module boundary — so there is nothing
 * to hand off, nothing to claim, and `withGenerationOwnerScope` is the only
 * owner construction path in every import order.
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
  EntryStructureError,
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
  withGenerationOwnerScope,
  workerRequest,
  type CandidateSeed,
  type GenerationOwnerScope,
  type OwnerSnapshot,
} from "./owner.js";
export type { WorkerApplyContext, WorkerRegistration } from "./workers.js";
export type {
  AbortOutcome,
  EntryLease,
  EntryVersionToken,
  GenerationId,
  GenerationMutationToken,
  OwnedEntryRef,
  GenerationOwnerLease,
  OwnerTerminalState,
  PublishedGenerationToken,
  ReplaceInternedEntryArgs,
  ReplaceInternedEntryResult,
  ReplacementDisposition,
  SlotId,
  WorkerEntryRequest,
  WorkerIntakeState,
  WorkerLifecycleState,
  WorkerReplacementResult,
  WorkerResultId,
} from "./tokens.js";
