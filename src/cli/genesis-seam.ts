/**
 * Narrow design-180 capability boundary consumed by design 179.
 *
 * TODO(180-integration): replace with the real module from
 * feat/180-atomic-genesis. This file deliberately contains no journal, lock,
 * classifier, witness, or quarantine implementation.
 */
import { isDeepStrictEqual } from "node:util";
import { acquireGenesisLock } from "./e2ee-keystore.js";

export const RECOVERY_KIT_SERVICE = "rbox recovery phrase" as const;

export type CompletionIntent =
  | {
      version: 1;
      accountId: string;
      requestSha256: string;
      mode: "phrase-display";
      intentAt: string;
    }
  | {
      version: 1;
      accountId: string;
      requestSha256: string;
      mode: "keychain";
      keychain: {
        service: typeof RECOVERY_KIT_SERVICE;
        account: string;
        keychainPath: string;
      };
      intentAt: string;
    }
  | {
      version: 1;
      accountId: string;
      requestSha256: string;
      mode: "kit-path";
      path: string;
      intentAt: string;
    };

export type CompletionIntentRetargetWitness = {
  version: 1;
  accountId: string;
  requestSha256: string;
  oldIntent: CompletionIntent;
  oldIntentSha256: string;
  newIntent: CompletionIntent;
  newIntentSha256: string;
  witnessedAt: string;
};

export interface GenesisAttemptRef {
  accountId: string;
  requestSha256: string;
}

/** Structural projection of design 180's complete enrollment classifier. The
 * payload-bearing variants deliberately expose only the fields design 179
 * consumes so the phase-2 integration remains an import/adapter swap. */
export type GenesisClassification =
  | { kind: "pristine" }
  | { kind: "restart-prepublication"; marker: unknown }
  | { kind: "resume-attempt"; journal: GenesisAttemptRef }
  | { kind: "cleanup-resume"; journal: GenesisAttemptRef }
  | { kind: "committed-this-attempt"; journal: GenesisAttemptRef; phrase: string; intent?: CompletionIntent; witness?: CompletionIntentRetargetWitness }
  | { kind: "competing-genesis"; journal: GenesisAttemptRef }
  | { kind: "enrolled"; dto: unknown }
  | { kind: "legacy-orphan" }
  | { kind: "repaired-legacy"; repairId: string }
  | { kind: "quarantine-resume"; repairId: string }
  | { kind: "repair-ready"; repairId: string }
  | { kind: "integrity-failure"; reason: string };

export type CommittedGenesisClassification = Extract<GenesisClassification, { kind: "committed-this-attempt" }>;
export type PendingGenesisClassification = "none" | GenesisClassification;

export interface ValidatedStagedRecoveryKey extends GenesisAttemptRef {
  /** Authenticated bytes from design 180's rk.key.staged. */
  rk: Uint8Array;
  originalCacheRecovery: boolean;
}

export interface GenesisSeam {
  /** TODO(180-integration): acquire design 180's account-scoped lock. */
  withAccountGenesisLock<T>(accountId: string, operation: () => Promise<T>): Promise<T>;
  /** TODO(180-integration): return the uncollapsed shared-classifier result. */
  pendingGenesis(accountId: string): Promise<PendingGenesisClassification>;
  /** TODO(180-integration): drive the classifier's exact resume/cleanup path.
   * Success means the journal has been durably retired. */
  resumeOrCleanupPendingGenesis(accountId: string, classification: GenesisClassification): Promise<void>;
  /** TODO(180-integration): strict staged-RK load + journal/envelope validation. */
  readValidatedStagedRecoveryKey(classification: CommittedGenesisClassification): Promise<ValidatedStagedRecoveryKey | undefined>;
  /** TODO(180-integration): strict canonical-intent and witness load. */
  readAndReconcileCompletionIntent(classification: CommittedGenesisClassification): Promise<{ state: "absent" } | { state: "intent"; intent: CompletionIntent }>;
  /** TODO(180-integration): hardened first publication owned by design 180. */
  writeCompletionIntent(classification: CommittedGenesisClassification, intent: CompletionIntent): Promise<void>;
  /** TODO(180-integration): witness-first Keychain-to-file RETARGET. */
  retargetKeychainIntent(classification: CommittedGenesisClassification, oldIntent: Extract<CompletionIntent, { mode: "keychain" }>, newIntent: Extract<CompletionIntent, { mode: "kit-path" }>): Promise<Extract<CompletionIntent, { mode: "keychain" | "kit-path" }>>;
  /** TODO(180-integration): writes artifact-committed and owns resulting cleanup. */
  commitVerifiedRecoveryKitArtifact(classification: CommittedGenesisClassification): Promise<void>;
  /** TODO(180-integration): writes phrase-delivered and owns resulting cleanup. */
  commitDeliveredRecoveryPhrase(classification: CommittedGenesisClassification): Promise<void>;
  /** TODO(180-integration): derives the exact three-entry manifest from its journal. */
  quarantineAbandonedAttempt(attempt: GenesisAttemptRef): Promise<void>;
}

const unavailable = async (): Promise<never> => {
  throw new Error("atomic genesis integration is unavailable in this build");
};

/** Fail-closed placeholder until design 180 is merged. */
export const pre180GenesisSeam: GenesisSeam = {
  withAccountGenesisLock: async (accountId, operation) => {
    const release = acquireGenesisLock(accountId);
    try { return await operation() } finally { release() }
  },
  pendingGenesis: async () => "none",
  resumeOrCleanupPendingGenesis: unavailable,
  readValidatedStagedRecoveryKey: async () => undefined,
  readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
  writeCompletionIntent: unavailable,
  retargetKeychainIntent: unavailable,
  commitVerifiedRecoveryKitArtifact: unavailable,
  commitDeliveredRecoveryPhrase: unavailable,
  quarantineAbandonedAttempt: unavailable,
};

let activeGenesisSeam: GenesisSeam = pre180GenesisSeam;

/** Process-local injection point. TODO(180-integration): initialize this binding
 * from the real feat/180-atomic-genesis adapter at module load. */
export function currentGenesisSeam(): GenesisSeam { return activeGenesisSeam }

/** Tests install one stateful fake; callers never read 180-owned files directly. */
export function installGenesisSeamForTests(seam: GenesisSeam): () => void {
  const previous = activeGenesisSeam;
  activeGenesisSeam = seam;
  return () => { activeGenesisSeam = previous };
}

/** Design-179 policy layered over the injected design-180 state. A claimed
 * local offer cannot suppress continuation of the same unresolved journal. */
export function shouldPresentGenesisCompletion(
  offerClaimed: boolean,
  pending: PendingGenesisClassification,
  state: { state: "absent" } | { state: "intent"; intent: CompletionIntent }
): boolean {
  if (pending === "none") return !offerClaimed;
  return pending.kind === "committed-this-attempt" && state.state === "absent";
}

/** The failing RETARGET invocation is forbidden from writing the fallback.
 * Only the exact durable new survivor returned by design 180 enables it. */
export async function retargetThenWriteFallback(
  seam: GenesisSeam,
  classification: CommittedGenesisClassification,
  oldIntent: Extract<CompletionIntent, { mode: "keychain" }>,
  newIntent: Extract<CompletionIntent, { mode: "kit-path" }>,
  writeFallback: (absolutePath: string) => Promise<void>
): Promise<"keychain-retained" | "file-written"> {
  const survivor = await seam.retargetKeychainIntent(classification, oldIntent, newIntent);
  if (isDeepStrictEqual(survivor, oldIntent)) return "keychain-retained";
  if (!isDeepStrictEqual(survivor, newIntent)) throw new Error("RETARGET returned an unexpected completion intent");
  await writeFallback(newIntent.path);
  return "file-written";
}
