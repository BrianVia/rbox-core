
import { isInteractive, promptConfirm } from "../prompt.js";
import { RboxApi } from "../remote.js";
import { beginAtomicGenesis, completeAtomicGenesis } from "../e2ee-client.js";
import { validatePhraseForAccount } from "../e2ee-client.js";
import { phraseToRk, rkToPhrase } from "../../engine/e2ee/index.js";
import { defaultKitPath, displayPath, claimRecoveryKitOffer, readRecoveryKitRecordState, recordKeychainArtifact, resolveRecoveryKitPath, updateRecoveryKitOfferOutcome, writeRecoveryKit, type RecoveryKitOptions } from "../recovery-kit.js";
import { probeKeychainKit, resolveLoginKeychain, writeKeychainKit, type KeychainArtifact } from "../recovery-kit-keychain.js";
import { retargetThenWriteFallback, shouldPresentGenesisCompletion, type CommittedGenesisClassification, type CompletionIntent, type GenesisSeam } from "../genesis-seam.js";


import { NO_KIT, KeychainLocatorWriteError, actionableKeychainOfferTarget, offerPlaintextCleanupAfterKeychainSave, showRecoveryPhrase, writeKitOrThrow } from "./recovery-kit-flow.js";
import { chooseGenesisDestinationIntent, completeGenesisDestinationSet, type GenesisDestinationFlowDeps, type GenesisRecoveryKitCompletionDeps } from "./genesis-destination-flow.js";

export type GenesisApi = Pick<RboxApi, "getAccountKeys" | "getGenesisObservation" | "bootstrapKeys">;
export type GenesisEnrollmentResult = "enrolled" | "already-setup";

export interface GenesisEnrollmentDeps {
  showRecoveryPhrase?: typeof showRecoveryPhrase;
  deliverPhrase?: (phrase: string) => Promise<void>;
  now?: () => number;
  isInteractive?: typeof isInteractive;
  promptConfirm?: typeof promptConfirm;
  resolveKitPath?: typeof resolveRecoveryKitPath;
  writeKit?: typeof writeKitOrThrow;
  genesisCompletion?: GenesisRecoveryKitCompletionDeps;
  platform?: NodeJS.Platform;
  stdinTTY?: boolean;
  stderrTTY?: boolean;
  keychainOfferTarget?: (accountId: string) => Promise<KeychainArtifact | undefined>;
  probeKeychain?: typeof probeKeychainKit;
  destinationFlow?: GenesisDestinationFlowDeps;
}

export async function runGenesisEnrollment(
  api: GenesisApi,
  creds: { accountId: string; deviceId: string },
  kitOpts: RecoveryKitOptions = NO_KIT,
  deps: GenesisEnrollmentDeps = {}
): Promise<GenesisEnrollmentResult> {
  const now = (deps.now ?? Date.now)();
  const started = await beginAtomicGenesis(api, creds.accountId, creds.deviceId, { now });
  if (started.kind === "already-setup") return "already-setup";
  const interactive = (deps.isInteractive ?? isInteractive)();
  const stdinTTY = deps.stdinTTY ?? interactive;
  const stderrTTY = deps.stderrTTY ?? process.stderr.isTTY === true;
  const platform = deps.platform ?? process.platform;
  const completion = deps.genesisCompletion ?? defaultGenesisRecoveryKitCompletion(creds, kitOpts, deps.showRecoveryPhrase);
  const updateGenesisOffer = async (outcome: "shown" | "accepted" | "declined"): Promise<void> => {
    const record = await readRecoveryKitRecordState(creds.accountId);
    const current = record.state === "recognized" ? record.record.offer : undefined;
    const mayAdvance = current?.surface === "genesis" &&
      (current.outcome === "claimed" || outcome === "accepted" && current.outcome === "shown");
    if (mayAdvance) {
      await updateRecoveryKitOfferOutcome(creds.accountId, outcome);
    }
  };
  await completeAtomicGenesis(started, {
    deliverPhrase: (phrase) => deps.deliverPhrase?.(phrase) ?? completion.displayPhrase(phrase, {
      version: 1,
      accountId: started.journal.accountId,
      requestSha256: started.journal.requestSha256,
      mode: "phrase-display",
      intentAt: new Date(now).toISOString(),
    }),
    selectIntent: async (journal, phrase, intentNow) => {
      const base = { version: 1 as const, accountId: journal.accountId, requestSha256: journal.requestSha256, intentAt: new Date(intentNow).toISOString() };
      if (deps.showRecoveryPhrase) return { ...base, mode: "phrase-display" as const };
      if (kitOpts.kitPath) {
        const target = await (deps.resolveKitPath ?? resolveRecoveryKitPath)(journal.accountId, kitOpts.kitPath, new Date(now));
        return { ...base, mode: "kit-path" as const, path: target };
      }
      if (kitOpts.kit) {
        const rk = await phraseToRk(phrase);
        try {
          return await completion.select(phrase, { accountId: journal.accountId, requestSha256: journal.requestSha256, originalCacheRecovery: journal.originalCacheRecovery, rk });
        } finally { rk.fill(0) }
      }
      if (!interactive) return { ...base, mode: "phrase-display" as const };
      // Preserve the legacy injected prompt seam used by embedders and existing
      // deterministic tests. Production has no injected confirm and always uses
      // the destination-set checkbox below.
      if (!deps.destinationFlow && (deps.promptConfirm || deps.deliverPhrase || deps.genesisCompletion || deps.writeKit)) {
        if (platform === "darwin" && (deps.keychainOfferTarget !== undefined || deps.resolveKitPath === undefined)) {
          if (!stdinTTY || !stderrTTY) return { ...base, mode: "phrase-display" as const };
          let target: KeychainArtifact | undefined;
          try {
            target = await (deps.keychainOfferTarget ?? actionableKeychainOfferTarget)(journal.accountId);
          } catch {
            target = undefined;
          }
          if (!target) return { ...base, mode: "phrase-display" as const };
          const record = await readRecoveryKitRecordState(journal.accountId);
          const continuingClaim = record.state === "recognized" &&
            record.record.offer?.surface === "genesis" &&
            record.record.offer.outcome === "claimed";
          const offerBlocks = record.state === "recognized" && record.record.offer !== undefined
            && !(record.record.offer.surface === "genesis" && record.record.offer.outcome === "declined");
          if (!shouldPresentGenesisCompletion(offerBlocks, started, { state: "absent" })) {
            return { ...base, mode: "phrase-display" as const };
          }
          const claimed = continuingClaim || await claimRecoveryKitOffer(journal.accountId, "genesis", "in-hand", async () =>
            await (deps.probeKeychain ?? probeKeychainKit)(target) === "missing");
          if (claimed && await (deps.promptConfirm ?? promptConfirm)({ message: "Save this recovery phrase to the macOS Keychain now (view later in Keychain Access — search \"rbox\")?", default: true })) {
            return { ...base, mode: "keychain" as const, keychain: { service: target.service, account: target.account, keychainPath: target.keychainPath } };
          }
          if (claimed) await updateGenesisOffer("declined").catch(() => {});
          return { ...base, mode: "phrase-display" as const };
        }
        const target = await (deps.resolveKitPath ?? resolveRecoveryKitPath)(journal.accountId, undefined, new Date(now));
        return await (deps.promptConfirm ?? promptConfirm)({ message: `Save a recovery kit (writes the phrase in PLAINTEXT to ${displayPath(target)})?`, default: true })
          ? { ...base, mode: "kit-path" as const, path: target }
          : { ...base, mode: "phrase-display" as const };
      }
      if (!stdinTTY || !stderrTTY) return { ...base, mode: "phrase-display" as const };
      let keychainTarget: KeychainArtifact | undefined;
      if (platform === "darwin") {
        try {
          keychainTarget = await (deps.keychainOfferTarget ?? actionableKeychainOfferTarget)(journal.accountId);
        } catch {
          keychainTarget = undefined;
        }
      }
      const filePath = await (deps.resolveKitPath ?? resolveRecoveryKitPath)(journal.accountId, undefined, new Date(now));
      return chooseGenesisDestinationIntent({
        accountId: journal.accountId,
        requestSha256: journal.requestSha256,
        now: intentNow,
        keychainTarget,
        filePath,
        deps: deps.destinationFlow,
      });
    },
    commitArtifact: async (intent, phrase) => {
      if (intent.mode === "keychain") {
        try {
          await completion.saveKeychain(phrase, intent);
          await updateGenesisOffer("accepted").catch(() => {});
        } catch (error) {
          await updateGenesisOffer("shown").catch(() => {});
          throw error;
        }
      } else if (deps.writeKit) {
        await deps.writeKit(phrase, creds, { kit: true, kitPath: intent.path }, !interactive);
        await updateGenesisOffer("accepted").catch(() => {});
      } else {
        await completion.saveFile(phrase, intent);
        await updateGenesisOffer("accepted").catch(() => {});
      }
    },
    retargetKeychainFailure: async (error, intent, phrase) => {
      if (error instanceof KeychainLocatorWriteError) return undefined;
      return completion.retargetAfterKeychainFailure?.(phrase, intent);
    },
    completeDestinationSet: (context) => completeGenesisDestinationSet(
      context,
      creds,
      completion,
      deps.destinationFlow
    ),
  }, now);
  return "enrolled";
}

export function defaultGenesisRecoveryKitCompletion(
  creds: { accountId: string; deviceId: string },
  kitOpts: RecoveryKitOptions,
  display: typeof showRecoveryPhrase = showRecoveryPhrase
): GenesisRecoveryKitCompletionDeps {
  return {
    validatePhrase: (phrase) => validatePhraseForAccount(phrase),
    select: async (_phrase, staged) => {
      const base = { version: 1 as const, accountId: creds.accountId, requestSha256: staged.requestSha256, intentAt: new Date().toISOString() };
      if (kitOpts.kitPath) return { ...base, mode: "kit-path" as const, path: await resolveRecoveryKitPath(creds.accountId, kitOpts.kitPath) };
      if (kitOpts.kit && process.platform === "darwin") {
        const keychainPath = await resolveLoginKeychain();
        return { ...base, mode: "keychain" as const, keychain: { service: "rbox recovery phrase" as const, account: creds.accountId, keychainPath } };
      }
      if (kitOpts.kit) return { ...base, mode: "kit-path" as const, path: await defaultKitPath(creds.accountId) };
      return { ...base, mode: "phrase-display" as const };
    },
    // The completion intent already selected phrase display. Suppress the
    // ordinary offer path until design 180 records delivery and retires the
    // journal; an unstaged Keychain write must never race that journal.
    displayPhrase: (phrase) => display(phrase, creds, NO_KIT, "genesis", false),
    saveKeychain: async (phrase, intent) => {
      const artifact = await writeKeychainKit(phrase, creds.accountId, intent.keychain.keychainPath);
      try { await recordKeychainArtifact(creds.accountId, artifact) }
      catch (error) { throw new KeychainLocatorWriteError(error) }
      await offerPlaintextCleanupAfterKeychainSave(creds.accountId, phrase);
    },
    saveFile: async (phrase, intent) => {
      const written = await writeRecoveryKit(phrase, creds, intent.path);
      if (written.recordError) throw written.recordError;
    },
    retargetAfterKeychainFailure: async (_phrase, intent) => {
      if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return undefined;
      const target = await defaultKitPath(creds.accountId);
      if (!(await promptConfirm({ message: `Keychain save failed (unavailable) — save a PLAINTEXT file to ${displayPath(target)} instead?`, default: true }))) return undefined;
      return { version: 1, accountId: intent.accountId, requestSha256: intent.requestSha256, mode: "kit-path", path: target, intentAt: new Date().toISOString() };
    },
  };
}

/** Design-179's completion layer over design 180. The injected seam owns every
 * staged/journal/intent/receipt transition; callbacks own only exact artifact
 * delivery and must return only after verification plus locator durability. */
export async function completeStagedGenesisRecoveryKit(
  accountId: string,
  classification: CommittedGenesisClassification,
  seam: GenesisSeam,
  deps: GenesisRecoveryKitCompletionDeps
): Promise<CompletionIntent> {
  if (classification.kind !== "committed-this-attempt") throw new Error("genesis completion requires committed-this-attempt classification");
  const staged = await seam.readValidatedStagedRecoveryKey(classification);
  if (!staged) throw new Error("active genesis has no validated staged recovery key");
  if (staged.accountId !== accountId) throw new Error("staged recovery key account mismatch");
  if (classification.journal.accountId !== staged.accountId || classification.journal.requestSha256 !== staged.requestSha256) throw new Error("committed genesis classification does not match staged recovery key");
  const state = await seam.readAndReconcileCompletionIntent(classification);
  let intent = state.state === "intent" ? state.intent : undefined;
  const phrase = await rkToPhrase(staged.rk);
  try {
    await deps.validatePhrase(phrase);
    if (!intent) {
      const offerClaimed = await (deps.offerClaimed ?? (async (id) => {
        const record = await readRecoveryKitRecordState(id);
        return record.state === "recognized" && record.record.offer !== undefined;
      }))(accountId);
      if (!shouldPresentGenesisCompletion(offerClaimed, classification, state)) throw new Error("genesis completion selection is not actionable");
      intent = await deps.select(phrase, staged);
      if (intent.accountId !== accountId || intent.requestSha256 !== staged.requestSha256) throw new Error("completion selection does not match the active genesis attempt");
      await seam.writeCompletionIntent(classification, intent);
    }
    if (intent.mode === "phrase-display") {
      await deps.displayPhrase(phrase, intent);
      await seam.commitDeliveredRecoveryPhrase(classification);
    } else if (intent.mode === "keychain") {
      try {
        await deps.saveKeychain(phrase, intent);
      } catch (error) {
        if (error instanceof KeychainLocatorWriteError || !deps.retargetAfterKeychainFailure) throw error;
        const fallback = await deps.retargetAfterKeychainFailure(phrase, intent);
        if (!fallback) throw error;
        const result = await retargetThenWriteFallback(seam, classification, intent, fallback, async () => deps.saveFile(phrase, fallback));
        if (result === "keychain-retained") throw error;
        await seam.commitVerifiedRecoveryKitArtifact(classification);
        return fallback;
      }
      await seam.commitVerifiedRecoveryKitArtifact(classification);
    } else {
      await deps.saveFile(phrase, intent);
      await seam.commitVerifiedRecoveryKitArtifact(classification);
    }
    return intent;
  } finally {
    staged.rk.fill(0);
  }
}
