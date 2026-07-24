
import fs from "node:fs/promises";
import { credentialsForStrictFlow, loadCredentials } from "../credentials.js";
import { isInteractive, promptConfirm, promptInput } from "../prompt.js";
import { enrollViaRecovery, enrollViaRecoveryWithPhraseInput, RecoveryPreAdmissionError } from "../e2ee-client.js";
import { validatePhraseForAccount } from "../e2ee-client.js";
import { readStdinTrimmed } from "../read-stdin.js";
import { mergeDiscoveredKeychainArtifact, readRecoveryKitRecordState, type RecoveryKitOptions } from "../recovery-kit.js";
import { canonicalRecoveryPhrase, probeKeychainKit, readKeychainKit, resolveLoginKeychain, type KeychainArtifact, type KeychainSeams } from "../recovery-kit-keychain.js";
import { type GenesisSeam } from "../genesis-seam.js";


import { completeStagedGenesisRecoveryKit, defaultGenesisRecoveryKitCompletion } from "./genesis-command.js";
import type { GenesisRecoveryKitCompletionDeps } from "./genesis-destination-flow.js";
import { NO_KIT, offerRecoveryKitAfterRecover } from "./recovery-kit-flow.js";

export interface RecoverCmdDeps {
  loadCredentials?: typeof loadCredentials;
  isInteractive?: typeof isInteractive;
  promptInput?: typeof promptInput;
  readStdin?: typeof readStdinTrimmed;
  beforePhraseRead?: () => Promise<void>;
  /** Explicit fake-only unit seam; production leaves this undefined. */
  genesisSeam?: GenesisSeam;
  genesisCompletion?: GenesisRecoveryKitCompletionDeps;
  keychainPhrase?: typeof recoveryPhraseFromKeychain;
  manualPhrase?: () => Promise<string>;
  enroll?: typeof enrollViaRecovery;
  enrollWithPhraseInput?: typeof enrollViaRecoveryWithPhraseInput;
  mergeDiscovered?: typeof mergeDiscoveredKeychain;
  offerRecoveryKit?: typeof offerRecoveryKitAfterRecover;
  now?: () => number;
}

export async function recoverCmd(kitOpts: RecoveryKitOptions = NO_KIT, deps: RecoverCmdDeps = {}): Promise<void> {
  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const creds = credentialsForStrictFlow(loaded);
  if (!creds?.accountId) throw new Error("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");
  if (deps.genesisSeam) {
    const seam = deps.genesisSeam;
    const selected = await seam.withAccountGenesisLock(creds.accountId, async () => {
      const pending = await seam.pendingGenesis(creds.accountId!);
      if (pending !== "none") {
        if (pending.kind === "committed-this-attempt") {
          await completeStagedGenesisRecoveryKit(
            creds.accountId!,
            pending,
            seam,
            deps.genesisCompletion ?? defaultGenesisRecoveryKitCompletion({ accountId: creds.accountId!, deviceId: creds.deviceId }, kitOpts)
          );
        } else {
          await seam.resumeOrCleanupPendingGenesis(creds.accountId!, pending);
        }
        if (await seam.pendingGenesis(creds.accountId!) !== "none") throw new Error("pending encryption setup must be resolved before recovery");
      }
      const candidate = await (deps.keychainPhrase ?? recoveryPhraseFromKeychain)(creds.accountId!);
      let phrase = candidate?.phrase ?? await (deps.manualPhrase ?? (async () => {
        if ((deps.isInteractive ?? isInteractive)()) return (deps.promptInput ?? promptInput)({ message: "Enter your 24-word recovery phrase" });
        return (deps.readStdin ?? readStdinTrimmed)();
      }))();
      if (!phrase) throw new Error("no phrase entered");
      let recoveredViaKeychain = Boolean(candidate);
      let recovered: { accountId: string; deviceId: string };
      try {
        recovered = await (deps.enroll ?? enrollViaRecovery)(phrase, (deps.now ?? Date.now)(), loaded);
      } catch (error) {
        if (!candidate || !(error instanceof RecoveryPreAdmissionError)) throw error;
        process.stderr.write("Keychain recovery phrase could not be used; enter the phrase manually.\n");
        recoveredViaKeychain = false;
        phrase = await (deps.manualPhrase ?? (async () => (deps.readStdin ?? readStdinTrimmed)()))();
        if (!phrase) throw new Error("no phrase entered");
        recovered = await (deps.enroll ?? enrollViaRecovery)(phrase, (deps.now ?? Date.now)(), loaded);
      }
      return { phrase, recovered, recoveredViaKeychain, candidate };
    });
    console.log(`recovered + enrolled this device: ${selected.recovered.deviceId}`);
    if (selected.recoveredViaKeychain && selected.candidate?.artifact) await (deps.mergeDiscovered ?? mergeDiscoveredKeychain)(selected.recovered.accountId, selected.candidate.artifact);
    await (deps.offerRecoveryKit ?? offerRecoveryKitAfterRecover)(selected.phrase, selected.recovered, kitOpts);
    return;
  }
  let keychainCandidate: Awaited<ReturnType<typeof recoveryPhraseFromKeychain>>;
  let recoveredViaKeychain = false;
  const enrollWithPhraseInput = deps.enrollWithPhraseInput ?? enrollViaRecoveryWithPhraseInput;
  const readManualPhrase = async (): Promise<string> => {
    if (deps.manualPhrase) return deps.manualPhrase();
    if ((deps.isInteractive ?? isInteractive)()) {
      return (deps.promptInput ?? promptInput)({ message: "Enter your 24-word recovery phrase" });
    }
    return (deps.readStdin ?? readStdinTrimmed)();
  };
  let result: Awaited<ReturnType<typeof enrollViaRecoveryWithPhraseInput>>;
  try {
    result = await enrollWithPhraseInput(async () => {
      keychainCandidate = await (deps.keychainPhrase ?? recoveryPhraseFromKeychain)(creds.accountId!);
      if (keychainCandidate) {
        recoveredViaKeychain = true;
        return keychainCandidate.phrase;
      }
      return readManualPhrase();
    }, (deps.now ?? Date.now)(), loaded, deps.beforePhraseRead);
  } catch (error) {
    if (!recoveredViaKeychain || !(error instanceof RecoveryPreAdmissionError)) throw error;
    process.stderr.write("Keychain recovery phrase could not be used; enter the phrase manually.\n");
    recoveredViaKeychain = false;
    keychainCandidate = undefined;
    result = await enrollWithPhraseInput(readManualPhrase, (deps.now ?? Date.now)(), loaded, deps.beforePhraseRead);
  }
  console.log(`recovered + enrolled this device: ${result.deviceId}`);
  if (recoveredViaKeychain && keychainCandidate?.artifact) await (deps.mergeDiscovered ?? mergeDiscoveredKeychain)(result.accountId, keychainCandidate.artifact);
  await (deps.offerRecoveryKit ?? offerRecoveryKitAfterRecover)(result.phrase, result, kitOpts);
}

interface KeychainRecoveryDeps {
  stdinTTY?: boolean;
  stderrTTY?: boolean;
  readRecord?: typeof readRecoveryKitRecordState;
  resolve?: typeof resolveLoginKeychain;
  probe?: typeof probeKeychainKit;
  read?: typeof readKeychainKit;
  confirm?: typeof promptConfirm;
  validate?: typeof validatePhraseForAccount;
  warn?: (message: string) => void;
  seams?: KeychainSeams;
  realpath?: (value: string) => Promise<string>;
}

/** Selects a Keychain phrase only before admission. Every failure is redacted and
 * returns undefined so the unchanged manual recovery path remains available. */
export async function recoveryPhraseFromKeychain(accountId: string, deps: KeychainRecoveryDeps = {}): Promise<{ phrase: string; artifact: KeychainArtifact } | undefined> {
  if ((deps.stdinTTY ?? process.stdin.isTTY === true) !== true || (deps.stderrTTY ?? process.stderr.isTTY === true) !== true) return undefined;
  const loaded = await (deps.readRecord ?? readRecoveryKitRecordState)(accountId);
  let artifact: KeychainArtifact;
  try {
    if (loaded.state === "recognized" && loaded.record.keychain) {
      const persisted = loaded.record.keychain;
      const canonical = await (deps.realpath ?? deps.seams?.realpath ?? fs.realpath)(persisted.keychainPath);
      if (canonical === persisted.keychainPath) artifact = persisted;
      else {
        const keychainPath = await (deps.resolve ?? resolveLoginKeychain)(deps.seams);
        artifact = { service: "rbox recovery phrase", account: accountId, keychainPath, discoveredAt: new Date().toISOString() };
      }
    } else {
      const keychainPath = await (deps.resolve ?? resolveLoginKeychain)(deps.seams);
      artifact = { service: "rbox recovery phrase", account: accountId, keychainPath, discoveredAt: new Date().toISOString() };
    }
    if (await (deps.probe ?? probeKeychainKit)(artifact, deps.seams) !== "present") return undefined;
    if (!(await (deps.confirm ?? promptConfirm)({ message: "Found a recovery phrase for this account in the macOS Keychain — use it?", default: true }))) return undefined;
    const bytes = await (deps.read ?? readKeychainKit)(artifact, deps.seams);
    const secret = Buffer.from(bytes);
    try {
      const phrase = await canonicalRecoveryPhrase(secret.toString("utf8"));
      await (deps.validate ?? validatePhraseForAccount)(phrase);
      return { phrase, artifact };
    } finally { secret.fill(0); bytes.fill(0) }
  } catch {
    (deps.warn ?? ((message) => process.stderr.write(`${message}\n`)))("Keychain recovery phrase could not be used; enter the phrase manually.");
    return undefined;
  }
}

async function mergeDiscoveredKeychain(accountId: string, artifact: KeychainArtifact): Promise<void> {
  try {
    const outcome = await mergeDiscoveredKeychainArtifact(accountId, { service: artifact.service, account: artifact.account, keychainPath: artifact.keychainPath, discoveredAt: artifact.discoveredAt ?? new Date().toISOString() });
    if (outcome === "conflict") process.stderr.write("  ! recovery Keychain identity changed concurrently; rediscovery metadata was not recorded\n");
  } catch {
    process.stderr.write("  ! recovery succeeded, but Keychain rediscovery metadata was not recorded\n");
  }
}
