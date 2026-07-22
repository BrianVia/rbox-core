/**
 * Narrow design-180 capability boundary consumed by design 179.
 *
 * TODO(180-integration): replace with the real module from
 * feat/180-atomic-genesis. This file deliberately contains no journal, lock,
 * classifier, witness, or quarantine implementation.
 */
import { isDeepStrictEqual } from "node:util";

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

export interface ValidatedStagedRecoveryKey extends GenesisAttemptRef {
  /** Authenticated bytes from design 180's rk.key.staged. */
  rk: Uint8Array;
  originalCacheRecovery: boolean;
}

export interface GenesisSeam {
  /** TODO(180-integration): strict staged-RK load + journal/envelope validation. */
  readValidatedStagedRecoveryKey(accountId: string): Promise<ValidatedStagedRecoveryKey | undefined>;
  /** TODO(180-integration): strict canonical-intent and witness load. */
  readAndReconcileCompletionIntent(attempt: GenesisAttemptRef): Promise<{ state: "absent" } | { state: "intent"; intent: CompletionIntent }>;
  /** TODO(180-integration): hardened first publication owned by design 180. */
  writeCompletionIntent(intent: CompletionIntent): Promise<void>;
  /** TODO(180-integration): witness-first Keychain-to-file RETARGET. */
  retargetKeychainIntent(oldIntent: Extract<CompletionIntent, { mode: "keychain" }>, newIntent: Extract<CompletionIntent, { mode: "kit-path" }>): Promise<Extract<CompletionIntent, { mode: "keychain" | "kit-path" }>>;
  /** TODO(180-integration): strict pending projection; invalid state rejects. */
  pendingGenesis(accountId: string): Promise<"none" | "unreleased-recovery-kit-hold" | "cleanup">;
  /** TODO(180-integration): writes artifact-committed and owns resulting cleanup. */
  commitVerifiedRecoveryKitArtifact(attempt: GenesisAttemptRef): Promise<void>;
  /** TODO(180-integration): writes phrase-delivered and owns resulting cleanup. */
  commitDeliveredRecoveryPhrase(attempt: GenesisAttemptRef): Promise<void>;
  /** TODO(180-integration): derives the exact three-entry manifest from its journal. */
  quarantineAbandonedAttempt(attempt: GenesisAttemptRef): Promise<void>;
}

const unavailable = async (): Promise<never> => {
  throw new Error("atomic genesis integration is unavailable in this build");
};

/** Fail-closed placeholder until design 180 is merged. */
export const pre180GenesisSeam: GenesisSeam = {
  readValidatedStagedRecoveryKey: async () => undefined,
  readAndReconcileCompletionIntent: async () => ({ state: "absent" }),
  writeCompletionIntent: unavailable,
  retargetKeychainIntent: unavailable,
  pendingGenesis: async () => "none",
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
  pending: "none" | "unreleased-recovery-kit-hold" | "cleanup",
  state: { state: "absent" } | { state: "intent"; intent: CompletionIntent }
): boolean {
  if (pending !== "unreleased-recovery-kit-hold") return pending === "none" && !offerClaimed;
  return state.state === "absent";
}

/** The failing RETARGET invocation is forbidden from writing the fallback.
 * Only the exact durable new survivor returned by design 180 enables it. */
export async function retargetThenWriteFallback(
  seam: GenesisSeam,
  oldIntent: Extract<CompletionIntent, { mode: "keychain" }>,
  newIntent: Extract<CompletionIntent, { mode: "kit-path" }>,
  writeFallback: (absolutePath: string) => Promise<void>
): Promise<"keychain-retained" | "file-written"> {
  const survivor = await seam.retargetKeychainIntent(oldIntent, newIntent);
  if (isDeepStrictEqual(survivor, oldIntent)) return "keychain-retained";
  if (!isDeepStrictEqual(survivor, newIntent)) throw new Error("RETARGET returned an unexpected completion intent");
  await writeFallback(newIntent.path);
  return "file-written";
}
