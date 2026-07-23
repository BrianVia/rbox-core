/**
 * Narrow design-180 capability adapter consumed by design 179.
 *
 * Design 180 owns classification, locking, durable intent/RETARGET state,
 * receipts, and cleanup. This module only binds those real interfaces to the
 * small injectable surface used by recovery-kit policy and unit tests.
 */
import { isDeepStrictEqual } from "node:util";
import { AsyncLocalStorage } from "node:async_hooks";
import { rkToPhrase } from "../engine/e2ee/index.js";
import { credentialsForStrictFlow, loadCredentials } from "./credentials.js";
import { resumeGenesisCleanup, type AtomicGenesisCommit } from "./e2ee-client.js";
import {
  inspectPendingGenesis,
  classifyEnrollment,
  genesisClassifierConsultationNeeded,
  type EnrollmentClassification,
} from "./genesis-enrollment.js";
import {
  appendDestinationEvent,
  createDestinationProgress,
  loadDestinationProgress,
  loadStagedRecoveryKey,
  parseCompletionIntent,
  publishCompletionIntent,
  publishDestinationProgress,
  reconcileRetargetIntent,
  recordGenesisReceipt,
  recordDestinationSetReceipt,
  replaceDestinationSetIntent,
  retargetCompletionIntent,
  type CompletionIntent as DurableCompletionIntent,
  type CompletionIntentRetargetWitness as DurableCompletionIntentRetargetWitness,
  type CarriedDestinationCompletion,
  type DestinationEvent,
  type DestinationProgress,
  type DestinationSetCompletionIntent,
  type LegacyCompletionIntent,
  type GenesisJournal,
} from "./genesis-durable.js";
import { RboxApi } from "./remote.js";
import { acquireGenesisLockPair } from "./genesis-locks.js";
import { resumeGenesisQuarantine } from "./genesis-quarantine.js";

export const RECOVERY_KIT_SERVICE = "rbox recovery phrase" as const;

/** Legacy surface retained for design-179 callers. */
export type CompletionIntent = LegacyCompletionIntent;
export type DurableGenesisCompletionIntent = DurableCompletionIntent;
export type CompletionIntentRetargetWitness = DurableCompletionIntentRetargetWitness;
export type GenesisAttemptRef = Pick<GenesisJournal, "accountId" | "requestSha256">;
export type GenesisClassification = EnrollmentClassification;
export type CommittedGenesisClassification = Extract<EnrollmentClassification, { kind: "committed-this-attempt" }>;
export type PendingGenesisClassification = "none" | EnrollmentClassification;

export interface ValidatedStagedRecoveryKey extends GenesisAttemptRef {
  /** Authenticated bytes from design 180's rk.key.staged. */
  rk: Uint8Array;
  originalCacheRecovery: boolean;
}

export interface GenesisSeam {
  /** Hold design 180's global→account lock pair for every lower-level capability. */
  withAccountGenesisLock<T>(accountId: string, operation: () => Promise<T>): Promise<T>;
  /** Return the real, uncollapsed design-180 classifier result when consultation is required. */
  pendingGenesis(accountId: string): Promise<PendingGenesisClassification>;
  /** Resume only a transition authorized by a classification minted under this lock. */
  resumeOrCleanupPendingGenesis(accountId: string, classification: GenesisClassification): Promise<void>;
  /** Strict staged-RK load, bound to a real committed-this-attempt classification. */
  readValidatedStagedRecoveryKey(classification: CommittedGenesisClassification): Promise<ValidatedStagedRecoveryKey | undefined>;
  /** Strict canonical-intent load, reconciling a RETARGET witness first. */
  readAndReconcileCompletionIntent(classification: CommittedGenesisClassification): Promise<{ state: "absent" } | { state: "intent"; intent: CompletionIntent }>;
  /** Hardened first intent publication owned by design 180. */
  writeCompletionIntent(classification: CommittedGenesisClassification, intent: CompletionIntent): Promise<void>;
  /** Witness-first Keychain-to-file RETARGET owned by design 180. */
  retargetKeychainIntent(classification: CommittedGenesisClassification, oldIntent: Extract<CompletionIntent, { mode: "keychain" }>, newIntent: Extract<CompletionIntent, { mode: "kit-path" }>): Promise<Extract<CompletionIntent, { mode: "keychain" | "kit-path" }>>;
  /** Publish artifact-committed and run design 180's cleanup. */
  commitVerifiedRecoveryKitArtifact(classification: CommittedGenesisClassification): Promise<void>;
  /** Publish phrase-delivered and run design 180's cleanup. */
  commitDeliveredRecoveryPhrase(classification: CommittedGenesisClassification): Promise<void>;
  /** Require a fresh real competing-genesis proof, then receipt + quarantine cleanup. */
  quarantineAbandonedAttempt(attempt: GenesisAttemptRef): Promise<void>;
}

export type DestinationSetState =
  | { state: "absent" }
  | { state: "legacy"; intent: LegacyCompletionIntent }
  | { state: "destination-set"; intent: DestinationSetCompletionIntent; progress: DestinationProgress };

/** Design-187 capabilities kept separate so legacy auth callers remain exhaustive. */
export interface DestinationSetGenesisSeam {
  readAndReconcileDestinationSet(classification:CommittedGenesisClassification):Promise<DestinationSetState>;
  writeDestinationSet(classification:CommittedGenesisClassification,intent:DestinationSetCompletionIntent):Promise<DestinationProgress>;
  appendDestinationEvent(classification:CommittedGenesisClassification,intent:DestinationSetCompletionIntent,current:DestinationProgress,event:DestinationEvent):Promise<DestinationProgress>;
  replaceDestinationSet(
    classification:CommittedGenesisClassification,
    oldIntent:DestinationSetCompletionIntent,
    oldProgress:DestinationProgress,
    newIntent:DestinationSetCompletionIntent,
    carriedCompletions:CarriedDestinationCompletion[],
    liveValidOldIndexes:readonly number[]
  ):Promise<{intent:DestinationSetCompletionIntent;progress:DestinationProgress}>;
  commitDestinationSet(
    classification:CommittedGenesisClassification,
    intent:DestinationSetCompletionIntent,
    progress:DestinationProgress,
    liveValidDestinationIndexes:readonly number[],
    continuedAfterPartial:boolean
  ):Promise<void>;
}

interface GenesisLockContext {
  accountId: string;
  proofs: WeakSet<object>;
}

const genesisLockContext = new AsyncLocalStorage<GenesisLockContext>();

function lockedContext(accountId: string): GenesisLockContext {
  const context = genesisLockContext.getStore();
  if (!context || context.accountId !== accountId) throw new Error("design-180 genesis capability requires the account lock");
  return context;
}

function requireLockedProof(classification: GenesisClassification): void {
  const context = genesisLockContext.getStore();
  if (!context) throw new Error("design-180 genesis capability requires the account lock");
  if ("journal" in classification && classification.journal.accountId !== context.accountId) throw new Error("genesis classification account lock mismatch");
  if ("marker" in classification && classification.marker.accountId !== context.accountId) throw new Error("genesis classification account lock mismatch");
  if (!context.proofs.has(classification)) throw new Error("genesis classification was not minted under the held account lock");
}

function sameAttempt(classification: CommittedGenesisClassification, accountId: string, requestSha256: string): boolean {
  return classification.journal.accountId === accountId && classification.journal.requestSha256 === requestSha256;
}

async function classifyCurrentAccount(accountId: string): Promise<EnrollmentClassification> {
  const loaded = credentialsForStrictFlow(await loadCredentials());
  if (!loaded || loaded.accountId !== accountId) {
    throw new Error("pending encryption setup requires credentials for the same account");
  }
  const api = new RboxApi(loaded.remoteUrl, loaded.token, "", "");
  return classifyEnrollment(accountId, await api.getGenesisObservation());
}

async function canonicalIntent(classification: CommittedGenesisClassification): Promise<DurableCompletionIntent | undefined> {
  const pending = await inspectPendingGenesis(classification.journal.accountId);
  if (pending.witnessRaw !== undefined) {
    const reconciled = await reconcileRetargetIntent(classification.journal);
    if (!reconciled) throw new Error("RETARGET witness did not reconcile a completion intent");
    return reconciled;
  }
  return pending.intentRaw === undefined ? undefined : parseCompletionIntent(pending.intentRaw, classification.journal);
}

async function commitReceipt(
  classification: CommittedGenesisClassification,
  outcome: "artifact" | "phrase"
): Promise<void> {
  const intent = await canonicalIntent(classification);
  if (!intent) throw new Error("genesis completion intent is absent");
  if (intent.version !== 1) throw new Error("destination-set completion requires the design-187 seam");
  const at = new Date().toISOString();
  const receipt = outcome === "phrase"
    ? (() => {
        if (intent.mode !== "phrase-display") throw new Error("phrase delivery does not match the completion intent");
        return { outcome: "phrase-delivered" as const, at };
      })()
    : (() => {
        if (intent.mode === "phrase-display") throw new Error("artifact commitment does not match the completion intent");
        return {
          outcome: "artifact-committed" as const,
          at,
          artifact: intent.mode === "keychain"
            ? { mode: "keychain" as const, ...intent.keychain }
            : { mode: "kit-path" as const, path: intent.path },
        };
      })();
  await resumeGenesisCleanup(await recordGenesisReceipt(classification.journal, receipt));
}

export const design180GenesisSeam: GenesisSeam = {
  withAccountGenesisLock: async (accountId, operation) => {
    const inherited = genesisLockContext.getStore();
    if (inherited) {
      if (inherited.accountId !== accountId) throw new Error("cannot nest genesis locks for different accounts");
      return operation();
    }
    const pair = await acquireGenesisLockPair(accountId);
    try {
      return await genesisLockContext.run({ accountId, proofs: new WeakSet() }, operation);
    } finally {
      await pair.account.release();
      await pair.global.release();
    }
  },

  pendingGenesis: async (accountId) => {
    const context = lockedContext(accountId);
    if (!(await genesisClassifierConsultationNeeded(accountId))) return "none";
    const classification = await classifyCurrentAccount(accountId);
    context.proofs.add(classification);
    return classification;
  },

  resumeOrCleanupPendingGenesis: async (accountId, classification) => {
    if (lockedContext(accountId).accountId !== accountId) throw new Error("genesis account lock mismatch");
    requireLockedProof(classification);
    if (classification.kind === "cleanup-resume") {
      await resumeGenesisCleanup(classification.journal);
      return;
    }
    if (classification.kind === "competing-genesis") {
      const cleanup = await recordGenesisReceipt(classification.journal, { outcome: "competing-cleaned", at: new Date().toISOString() });
      await resumeGenesisCleanup(cleanup);
      return;
    }
    if (classification.kind === "quarantine-resume") {
      await resumeGenesisQuarantine(accountId, "repaired-legacy", classification.repairId, new Date().toISOString());
      return;
    }
    throw new Error(`genesis classification ${classification.kind} requires its design-180 high-level flow`);
  },

  readValidatedStagedRecoveryKey: async (classification) => {
    requireLockedProof(classification);
    const rk = await loadStagedRecoveryKey(classification.journal.accountId);
    try {
      if (await rkToPhrase(rk) !== classification.phrase) {
        throw new Error("staged recovery key does not match committed classification");
      }
      return {
        accountId: classification.journal.accountId,
        requestSha256: classification.journal.requestSha256,
        originalCacheRecovery: classification.journal.originalCacheRecovery,
        rk,
      };
    } catch (error) {
      rk.fill(0);
      throw error;
    }
  },

  readAndReconcileCompletionIntent: async (classification) => {
    requireLockedProof(classification);
    const intent = await canonicalIntent(classification);
    if (intent?.version === 2) throw new Error("destination-set completion requires the design-187 seam");
    return intent ? { state: "intent", intent } : { state: "absent" };
  },

  writeCompletionIntent: async (classification, intent) => {
    requireLockedProof(classification);
    if (!sameAttempt(classification, intent.accountId, intent.requestSha256)) {
      throw new Error("completion intent does not match committed genesis classification");
    }
    await publishCompletionIntent(intent, classification.journal);
  },

  retargetKeychainIntent: async (classification, oldIntent, newIntent) => {
    requireLockedProof(classification);
    if (!sameAttempt(classification, oldIntent.accountId, oldIntent.requestSha256) ||
        !sameAttempt(classification, newIntent.accountId, newIntent.requestSha256)) {
      throw new Error("RETARGET intents do not match committed genesis classification");
    }
    const pending = await inspectPendingGenesis(classification.journal.accountId);
    if (pending.witnessRaw !== undefined) {
      const survivor = await reconcileRetargetIntent(classification.journal);
      if (!survivor || (!isDeepStrictEqual(survivor, oldIntent) && !isDeepStrictEqual(survivor, newIntent))) {
        throw new Error("RETARGET reconciled an unexpected completion intent");
      }
      if (survivor.version !== 1) throw new Error("legacy RETARGET reconciled a destination-set intent");
      if (survivor.mode === "phrase-display") throw new Error("RETARGET reconciled a phrase-display intent");
      return survivor;
    }
    if (pending.intentRaw === undefined || !isDeepStrictEqual(parseCompletionIntent(pending.intentRaw, classification.journal), oldIntent)) {
      throw new Error("RETARGET source intent is not canonical");
    }
    await retargetCompletionIntent(classification.journal, oldIntent, newIntent, new Date().toISOString());
    const survivor = await reconcileRetargetIntent(classification.journal);
    if (!survivor || (!isDeepStrictEqual(survivor, oldIntent) && !isDeepStrictEqual(survivor, newIntent))) {
      throw new Error("RETARGET reconciled an unexpected completion intent");
    }
    if (survivor.version !== 1) throw new Error("legacy RETARGET reconciled a destination-set intent");
    if (survivor.mode === "phrase-display") throw new Error("RETARGET reconciled a phrase-display intent");
    return survivor;
  },

  commitVerifiedRecoveryKitArtifact: (classification) => {
    requireLockedProof(classification);
    return commitReceipt(classification, "artifact");
  },
  commitDeliveredRecoveryPhrase: (classification) => {
    requireLockedProof(classification);
    return commitReceipt(classification, "phrase");
  },

  quarantineAbandonedAttempt: async (attempt) => {
    const context = lockedContext(attempt.accountId);
    const classification = await classifyCurrentAccount(attempt.accountId);
    context.proofs.add(classification);
    if (classification.kind !== "competing-genesis" || classification.journal.requestSha256 !== attempt.requestSha256) {
      throw new Error("abandoned-attempt quarantine requires an exact competing-genesis classification");
    }
    const cleanup = await recordGenesisReceipt(classification.journal, {
      outcome: "competing-cleaned",
      at: new Date().toISOString(),
    });
    await resumeGenesisCleanup(cleanup);
  },
};

export const design187DestinationSetSeam:DestinationSetGenesisSeam={
  readAndReconcileDestinationSet:async(classification)=>{
    requireLockedProof(classification);
    const intent=await canonicalIntent(classification);
    if(!intent)return{state:"absent"};
    if(intent.version===1)return{state:"legacy",intent};
    let progress:DestinationProgress;
    try{progress=await loadDestinationProgress(intent);}
    catch(error){
      if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;
      progress=await createDestinationProgress(intent);
      await publishDestinationProgress(intent,progress);
    }
    return{state:"destination-set",intent,progress};
  },
  writeDestinationSet:async(classification,intent)=>{
    requireLockedProof(classification);
    if(!sameAttempt(classification,intent.accountId,intent.requestSha256))throw new Error("destination-set intent does not match committed genesis classification");
    await publishCompletionIntent(intent,classification.journal);
    const progress=await createDestinationProgress(intent);
    await publishDestinationProgress(intent,progress);
    return progress;
  },
  appendDestinationEvent:async(classification,intent,current,event)=>{
    requireLockedProof(classification);
    if(!sameAttempt(classification,intent.accountId,intent.requestSha256)||classification.journal.phase!=="active"||classification.journal.completionReceipts["recovery-kit-staging"])throw new Error("destination event append is not authorized");
    const canonical=await canonicalIntent(classification);
    if(!canonical||canonical.version!==2||!isDeepStrictEqual(canonical,intent))throw new Error("destination event intent is not canonical");
    return appendDestinationEvent(intent,current,event);
  },
  replaceDestinationSet:async(classification,oldIntent,oldProgress,newIntent,carriedCompletions,liveValidOldIndexes)=>{
    requireLockedProof(classification);
    if(!sameAttempt(classification,oldIntent.accountId,oldIntent.requestSha256)||!sameAttempt(classification,newIntent.accountId,newIntent.requestSha256))throw new Error("destination-set replacement attempt mismatch");
    await replaceDestinationSetIntent(classification.journal,oldIntent,oldProgress,newIntent,carriedCompletions,liveValidOldIndexes,new Date().toISOString());
    const survivor=await reconcileRetargetIntent(classification.journal);
    if(!survivor||survivor.version!==2||!isDeepStrictEqual(survivor,newIntent))throw new Error("destination-set replacement did not select the new plan");
    return{intent:survivor,progress:await loadDestinationProgress(survivor)};
  },
  commitDestinationSet:async(classification,intent,progress,liveValidDestinationIndexes,continuedAfterPartial)=>{
    requireLockedProof(classification);
    if(!sameAttempt(classification,intent.accountId,intent.requestSha256))throw new Error("destination-set receipt attempt mismatch");
    const cleanup=await recordDestinationSetReceipt(classification.journal,intent,progress,liveValidDestinationIndexes,continuedAfterPartial,new Date().toISOString());
    await resumeGenesisCleanup(cleanup);
  },
};

let activeGenesisSeam: GenesisSeam = design180GenesisSeam;

export function currentGenesisSeam(): GenesisSeam { return activeGenesisSeam }

/** Tests install stateful fakes; production always starts on the real adapter. */
export function installGenesisSeamForTests(seam: GenesisSeam): () => void {
  const previous = activeGenesisSeam;
  activeGenesisSeam = seam;
  return () => { activeGenesisSeam = previous };
}

/** A claimed local offer cannot suppress continuation of the same unresolved journal. */
export function shouldPresentGenesisCompletion(
  offerClaimed: boolean,
  pending: PendingGenesisClassification | AtomicGenesisCommit,
  state: { state: "absent" } | { state: "intent"; intent: CompletionIntent }
): boolean {
  if (pending === "none") return !offerClaimed;
  return (pending.kind === "committed-this-attempt" || pending.kind === "committed") && state.state === "absent";
}

/** Only the exact durable new survivor returned by design 180 enables fallback output. */
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
