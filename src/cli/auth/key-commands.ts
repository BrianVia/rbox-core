
import fs from "node:fs/promises";
import { credentialsForStrictFlow, loadCredentials } from "../credentials.js";
import { promptInput, promptPassword } from "../prompt.js";
import { RboxApi } from "../remote.js";
import { emitJson } from "../json.js";
import { assertNoPendingGenesis } from "../e2ee-client.js";
import { validatePhraseForAccount } from "../e2ee-client.js";
import { rkToPhrase } from "../../engine/e2ee/index.js";
import { loadDevice, loadRecoveryKey } from "../e2ee-keystore.js";
import { readRecoveryKitRecordState, recordKeychainArtifact, recoveryKitFileState, type RecoveryKitOptions } from "../recovery-kit.js";
import { pendingGenesisState } from "../genesis-enrollment.js";
import { GENESIS_PENDING_MESSAGE } from "../genesis-durable.js";
import { canonicalRecoveryPhrase, probeKeychainKit, resolveLoginKeychain, writeKeychainKit, type KeychainSeams } from "../recovery-kit-keychain.js";


import { runGenesisEnrollment } from "./genesis-command.js";
import { NO_KIT, maybePrintRecoveryKitNudge, offerPlaintextCleanupAfterKeychainSave, recoveryKitStatusLines, showRecoveryPhrase, writeKitSuccess } from "./recovery-kit-flow.js";
import { EXISTING_ACCOUNT_ENROLLMENT_MESSAGE, ENCRYPTION_ENROLLED_MESSAGE, GENESIS_COMMAND } from "./presentation.js";

export async function keyStatus(opts: { json?: boolean } = {}): Promise<void> {
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds) throw new Error("not logged in — run `rbox login`");
  const genesisPending=Boolean(creds.accountId&&await pendingGenesisState(creds.accountId));
  const loaded = creds.accountId&&!genesisPending ? await loadDevice(creds.accountId) : undefined;
  const enrolled = Boolean(loaded && "secrets" in loaded);
  const cachedRk = creds.accountId&&!genesisPending ? await loadRecoveryKey(creds.accountId) : undefined;
  const kitRead = creds.accountId ? await readRecoveryKitRecordState(creds.accountId) : { state: "missing" as const };
  const kitRecord = kitRead.state === "recognized" ? kitRead.record : undefined;
  const keychainState = kitRecord?.keychain ? await probeKeychainKit(kitRecord.keychain) : undefined;
  const plaintextStates = kitRecord ? await Promise.all(kitRecord.plaintextArtifacts.map((artifact) => recoveryKitFileState(creds.accountId!, artifact))) : [];
  const pendingGenesis = genesisPending;
  if (opts.json) {
    const firstFile = kitRecord?.plaintextArtifacts[0];
    emitJson({
      enrolled: enrolled&&!genesisPending,
      recoveryKit: kitRecord ? {
        version: 3,
        recordState: "recognized",
        ...(kitRecord.keychain ? { keychain: { ...kitRecord.keychain, state: keychainState } } : {}),
        plaintextArtifacts: kitRecord.plaintextArtifacts.map((artifact, index) => ({ ...artifact, state: plaintextStates[index] })),
        onePasswordArtifacts: kitRecord.onePasswordArtifacts.map((artifact) => artifact.state === "active"
          ? { ...artifact, state: "recorded" }
          : artifact),
        ...(kitRecord.offer ? { offer: kitRecord.offer } : {}),
        ...(firstFile ? { path: firstFile.path, writtenAt: firstFile.writtenAt } : {}),
        pendingGenesis,
      } : {
        version: 3,
        recordState: kitRead.state,
        plaintextArtifacts: [],
        onePasswordArtifacts: [],
        pendingGenesis,
      },
      ...(genesisPending?{genesisPending:true,resumeInstruction:GENESIS_PENDING_MESSAGE}:{}),
    });
    return;
  }
  console.log(`device:   ${creds.deviceId}`);
  console.log(`account:  ${creds.accountId ?? "(unknown — re-login)"}`);
  if (!creds.accountId) return;
  if(genesisPending){
    console.log(`encryption: pending\n${GENESIS_PENDING_MESSAGE}`);
    for (const line of await recoveryKitStatusLines(creds.accountId, false, kitRead, keychainState, plaintextStates, true)) console.log(line);
    return;
  }
  console.log(`encryption: ${enrolled ? "enrolled (master key present)" : loaded ? "device key present, master key missing — will self-heal on next sync" : "NOT enrolled — run `rbox pair` or `rbox key recover`"}`);
  console.log(`recovery phrase cached locally: ${cachedRk ? "yes (`rbox key backup` can re-show)" : "no (use the phrase you saved at setup)"}`);
  for (const line of await recoveryKitStatusLines(creds.accountId, Boolean(cachedRk), kitRead, keychainState, plaintextStates, pendingGenesis)) console.log(line);
  await maybePrintRecoveryKitNudge(creds.accountId, Boolean(cachedRk));
}

/** `rbox key genesis --yes` — explicit non-interactive first-machine genesis. */
export async function keyGenesis(yes: boolean, kitOpts: RecoveryKitOptions = NO_KIT): Promise<void> {
  if (!yes) throw new Error(`usage: ${GENESIS_COMMAND}`);
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds?.accountId) throw new Error("not logged in — run `rbox login` first");
  const result = await runGenesisEnrollment(new RboxApi(creds.remoteUrl, creds.token, "", ""), { accountId: creds.accountId, deviceId: creds.deviceId }, kitOpts);
  if (result === "enrolled") {
    console.log(ENCRYPTION_ENROLLED_MESSAGE);
  } else {
    console.error(EXISTING_ACCOUNT_ENROLLMENT_MESSAGE);
  }
}

/** `rbox key backup` — re-show the recovery phrase IF it was cached at setup (C9). */
export async function keyBackup(kitOpts: RecoveryKitOptions = NO_KIT): Promise<void> {
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds?.accountId) throw new Error("not logged in — run `rbox login`");
  await assertNoPendingGenesis(creds.accountId);
  const rk = await loadRecoveryKey(creds.accountId);
  if (!rk) {
    console.error("the recovery phrase isn't cached on this device. Use the phrase you saved at setup, or read it from another enrolled device.");
    process.exitCode = 1;
    return;
  }
  const { rkToPhrase } = await import("../../engine/e2ee/index.js");
  await showRecoveryPhrase(await rkToPhrase(rk), creds, kitOpts, "backup");
}

export interface KeySaveDeps {
  json?: boolean;
  seams?: KeychainSeams;
  loadCredentials?: typeof loadCredentials;
  loadRecoveryKey?: typeof loadRecoveryKey;
  promptPassword?: typeof promptPassword;
  readPhraseStdin?: () => Promise<string>;
  validatePhrase?: typeof validatePhraseForAccount;
  savePhrase?: (phrase: string, creds: { accountId: string; deviceId?: string }, kitOpts: RecoveryKitOptions, seams?: KeychainSeams) => Promise<void>;
}

export async function keySave(kitOpts: RecoveryKitOptions = { kit: true }, deps: KeySaveDeps = {}): Promise<void> {
  if (deps.json) throw new Error("`--json` is not supported by `rbox key save`");
  const loaded = await (deps.loadCredentials ?? loadCredentials)();
  const creds = credentialsForStrictFlow(loaded);
  if (!creds?.accountId) throw new Error("`rbox key save` needs an account login first — run `rbox login`");
  const cached = await (deps.loadRecoveryKey ?? loadRecoveryKey)(creds.accountId);
  let phrase: string;
  if (cached) {
    try { phrase = await (await import("../../engine/e2ee/index.js")).rkToPhrase(cached) }
    finally { cached.fill(0) }
  } else if (process.stdin.isTTY === true) {
    if (process.stderr.isTTY !== true) throw new Error("re-run in a terminal with stderr attached, or pipe the phrase on stdin");
    // Visible on purpose: a 24-word phrase typed blind is how typos and
    // truncated pastes happen; the phrase is being handled deliberately.
    phrase = (await (deps.promptPassword ?? promptInput)({ message: "Enter your 24-word recovery phrase (input is visible — make sure no one is looking over your shoulder)" })).trim();
  } else {
    phrase = await (deps.readPhraseStdin ?? readBoundedRecoveryPhraseStdin)();
  }
  const wordCount = phrase.split(/\s+/).filter(Boolean).length;
  if (wordCount !== 24) throw new Error(`expected 24 words but got ${wordCount} — that usually means a partial or wrapped paste; enter the phrase as one line`);
  phrase = await canonicalRecoveryPhrase(phrase);
  await (deps.validatePhrase ?? validatePhraseForAccount)(phrase, loaded);
  await (deps.savePhrase ?? saveValidatedRecoveryPhrase)(phrase, { accountId: creds.accountId, deviceId: creds.deviceId }, kitOpts, deps.seams);
}

async function readBoundedRecoveryPhraseStdin(): Promise<string> {
  // Read fd 0 directly: the compiled binary's process.stdin async iterator
  // yields nothing for a regular-file redirect (`rbox key save < file`),
  // while readFileSync(0) handles both pipes and files (field, 2026-07-22).
  const fs = await import("node:fs");
  const combined = fs.readFileSync(0);
  if (combined.length > 1024) { combined.fill(0); throw new Error("recovery phrase input exceeds 1 KiB"); }
  try {
    const raw = combined.toString("utf8");
    if (/\r|\n/.test(raw.replace(/\r?\n$/, ""))) throw new Error("recovery phrase input contains trailing extra data");
    const phrase = raw.replace(/\r?\n$/, "").trim();
    if (!phrase) throw new Error("no phrase entered");
    return phrase;
  } finally {
    combined.fill(0);
  }
}

async function saveValidatedRecoveryPhrase(phrase: string, creds: { accountId: string; deviceId?: string }, kitOpts: RecoveryKitOptions, seams?: KeychainSeams): Promise<void> {
  if (kitOpts.kitPath || (seams?.platform ?? process.platform) !== "darwin") {
    await writeKitSuccess(phrase, creds, kitOpts, false);
    return;
  }
  const keychainPath = await resolveLoginKeychain(seams);
  const artifact = await writeKeychainKit(phrase, creds.accountId, keychainPath, seams);
  await recordKeychainArtifact(creds.accountId, artifact);
  await offerPlaintextCleanupAfterKeychainSave(creds.accountId, phrase);
  process.stderr.write("  ✓ recovery phrase saved to the macOS Keychain (search \"rbox\" in Keychain Access)\n");
  process.stderr.write("    note: this item is not iCloud Keychain-synchronized — keep an off-machine copy too.\n");
}
