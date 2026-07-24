
import { isInteractive, promptConfirm } from "../prompt.js";
import { preflightRecoveryEnvelope } from "../e2ee-client.js";
import { defaultKitTargetDir, defaultKitPath, deleteMatchingPlaintextArtifact, displayPath, claimRecoveryKitOffer, markPlaintextCleanup, readRecoveryKitRecordState, recordKeychainArtifact, recoveryKitAction, recoveryKitFileState, updateRecoveryKitOfferOutcome, writeRecoveryKit, type RecoveryKitOptions } from "../recovery-kit.js";
import { probeKeychainKit, resolveLoginKeychain, writeKeychainKit, type KeychainArtifact } from "../recovery-kit-keychain.js";


export const NO_KIT: RecoveryKitOptions = { kit: false };

export class KeychainLocatorWriteError extends Error {
  constructor(cause: unknown) {
    super(`recovery phrase is present in Keychain, but status metadata could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "KeychainLocatorWriteError";
  }
}

/** Show the recovery phrase once with a forced acknowledgement (no escrow). The
 *  confirm re-asks until it's a deliberate yes — pressing enter (default No) won't
 *  slip past it — preserving the "you must acknowledge" beat without the literal
 *  "yes" typing of the old readline loop. */
export async function showRecoveryPhrase(
  phrase: string,
  creds: { accountId?: string; deviceId?: string },
  kitOpts: RecoveryKitOptions = NO_KIT,
  surface: "genesis" | "backup" = "genesis",
  allowRecoveryKitOffer = true
): Promise<void> {
  if (!isInteractive() && recoveryKitAction(false, kitOpts) === "write-suppress-echo") {
    await writeKitOrThrow(phrase, creds, kitOpts, true);
    return;
  }
  process.stderr.write(`\n⚠️  rbox is END-TO-END ENCRYPTED. This recovery phrase is the ONLY way back in\n    if you lose every signed-in device. There is NO escrow — we cannot recover it.\n\n    ${phrase}\n\n`);
  if (isInteractive()) {
    if (allowRecoveryKitOffer && await offerOrWriteKit(phrase, creds, kitOpts, surface)) return;
    while (!(await promptConfirm({ message: "Have you saved this recovery phrase somewhere safe?", default: false }))) {
      process.stderr.write(`    Save it first — it's the ONLY way back in if you lose every device.\n`);
    }
  } else {
    process.stderr.write(`(non-interactive: SAVE THE PHRASE ABOVE — it will not be shown again)\n`);
  }
}

export async function deliverRecoveryPhrase(phrase: string): Promise<void> {
  process.stderr.write(`\n⚠️  rbox is END-TO-END ENCRYPTED. This recovery phrase is the ONLY way back in\n    if you lose every signed-in device. There is NO escrow — we cannot recover it.\n\n    ${phrase}\n\n`);
  if (isInteractive()) {
    while (!(await promptConfirm({ message: "Have you saved this recovery phrase somewhere safe?", default: false }))) {
      process.stderr.write(`    Save it first — it's the ONLY way back in if you lose every device.\n`);
    }
  } else {
    process.stderr.write(`(non-interactive: SAVE THE PHRASE ABOVE — it will not be shown again)\n`);
  }
}

async function offerOrWriteKit(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, surface: "genesis" | "backup"): Promise<boolean> {
  const action = recoveryKitAction(true, kitOpts);
  if (action === "write") return writeKitOrWarn(phrase, creds, kitOpts, false);
  if (action !== "offer") return false;
  if (process.platform === "darwin" && (process.stdin.isTTY !== true || process.stderr.isTTY !== true)) return false;
  let keychainPath: string | undefined;
  if (process.platform === "darwin" && creds.accountId) {
    const target = await actionableKeychainOfferTarget(creds.accountId);
    if (!target) return false;
    keychainPath = target.keychainPath;
    if (!(await claimRecoveryKitOffer(creds.accountId, surface, "in-hand", async () => await probeKeychainKit(target) === "missing"))) return false;
  }

  const target = displayPath(await defaultKitTargetDir());
  const message = process.platform === "darwin"
    ? "Save this recovery phrase to the macOS Keychain (view later in Keychain Access — search \"rbox\")?"
    : `Save a recovery kit (writes the phrase in PLAINTEXT to ${target})?`;
  const save = await promptConfirm({ message, default: true });
  if (!save) {
    if (process.platform === "darwin" && creds.accountId) await updateRecoveryKitOfferOutcome(creds.accountId, "declined").catch(() => {});
    return false;
  }
  const saved = await writeKitOrWarn(phrase, creds, kitOpts, false, keychainPath);
  if (process.platform === "darwin" && creds.accountId) await updateRecoveryKitOfferOutcome(creds.accountId, saved ? "accepted" : "shown").catch(() => {});
  return saved;
}

export async function offerRecoveryKitAfterRecover(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, surface: "recover" | "wizard-recover" = "recover"): Promise<void> {
  const action = recoveryKitAction(isInteractive(), kitOpts);
  if (action === "none") return;
  if (action === "write-suppress-echo") {
    await writeKitOrThrow(phrase, creds, kitOpts, true);
    return;
  }
  if (action === "write") {
    await writeKitOrWarn(phrase, creds, kitOpts, false);
    return;
  }
  if (process.platform === "darwin" && (process.stdin.isTTY !== true || process.stderr.isTTY !== true)) return;
  let keychainPath: string | undefined;
  if (process.platform === "darwin" && creds.accountId) {
    const target = await actionableKeychainOfferTarget(creds.accountId);
    if (!target) return;
    keychainPath = target.keychainPath;
    if (!(await claimRecoveryKitOffer(creds.accountId, surface, "in-hand", async () => await probeKeychainKit(target) === "missing"))) return;
  }
  const target = displayPath(await defaultKitTargetDir());
  const message = process.platform === "darwin"
    ? "Save this recovery phrase to the macOS Keychain now (view later in Keychain Access — search \"rbox\")?"
    : `Save a recovery kit (writes the phrase in PLAINTEXT to ${target})?`;
  if (await promptConfirm({ message, default: true })) {
    const saved = await writeKitOrWarn(phrase, creds, kitOpts, false, keychainPath);
    if (process.platform === "darwin" && creds.accountId) await updateRecoveryKitOfferOutcome(creds.accountId, saved ? "accepted" : "shown").catch(() => {});
  } else if (process.platform === "darwin" && creds.accountId) await updateRecoveryKitOfferOutcome(creds.accountId, "declined").catch(() => {});
}

async function writeKitOrWarn(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean, keychainPath?: string): Promise<boolean> {
  try {
    await writeKitSuccess(phrase, creds, kitOpts, suppressEcho, keychainPath);
    return true;
  } catch (e) {
    process.stderr.write(`  ! recovery kit write failed: ${e instanceof Error ? e.message : String(e)}\n`);
    if (e instanceof KeychainLocatorWriteError) return false;
    if (process.platform === "darwin" && !kitOpts.kitPath && process.stdin.isTTY === true && process.stderr.isTTY === true && creds.accountId) {
      const fallback = await defaultKitTargetDir();
      if (await promptConfirm({ message: `Keychain save failed (unavailable) — save a PLAINTEXT file to ${displayPath(fallback)} instead?`, default: true })) {
        try {
          await writeKitSuccess(phrase, creds, { kit: true, kitPath: await (await import("../recovery-kit.js")).defaultKitPath(creds.accountId) }, suppressEcho);
          return true;
        } catch (fallbackError) {
          process.stderr.write(`  ! plaintext recovery kit write failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`);
        }
      }
    }
    return false;
  }
}

export async function writeKitOrThrow(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean): Promise<void> {
  try {
    await writeKitSuccess(phrase, creds, kitOpts, suppressEcho);
  } catch (e) {
    throw new Error(`recovery kit write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function writeKitSuccess(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean, offeredKeychainPath?: string): Promise<void> {
  if (process.platform === "darwin" && !kitOpts.kitPath) {
    if (!creds.accountId) throw new Error("credential has no account id; cannot write a recovery kit");
    const keychainPath = offeredKeychainPath ?? await resolveLoginKeychain();
    const artifact = await writeKeychainKit(phrase, creds.accountId, keychainPath);
    try { await recordKeychainArtifact(creds.accountId, artifact) }
    catch (error) { throw new KeychainLocatorWriteError(error) }
    await offerPlaintextCleanupAfterKeychainSave(creds.accountId, phrase);
    process.stderr.write("  ✓ recovery phrase saved to the macOS Keychain (search \"rbox\" in Keychain Access)\n");
    process.stderr.write("    note: this item is not iCloud Keychain-synchronized — keep an off-machine copy too.\n");
    return;
  }
  const written = await writeRecoveryKit(phrase, creds, kitOpts.kitPath);
  const shown = displayPath(written.path);
  process.stderr.write(suppressEcho ? `recovery phrase written to ${shown} — not echoed (--kit)\n` : `  ✓ recovery kit written: ${shown}\n`);
  if (written.recordError) process.stderr.write(`  ! recovery kit status record failed: ${written.recordError.message}\n`);
}

export async function offerPlaintextCleanupAfterKeychainSave(accountId: string, canonicalPhrase: string): Promise<void> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return;
  const record = await readRecoveryKitRecordState(accountId);
  if (record.state !== "recognized") return;
  for (const artifact of record.record.plaintextArtifacts) {
    const parsed = await recoveryKitFileState(accountId, artifact);
    if (parsed !== "present") continue;
    const remove = await promptConfirm({ message: `Delete the matching old plaintext kit at ${displayPath(artifact.path)}?`, default: true });
    if (!remove) {
      await markPlaintextCleanup(accountId, artifact.path, "declined").catch(() => {});
      continue;
    }
    try {
      if (!(await deleteMatchingPlaintextArtifact(accountId, artifact, canonicalPhrase))) await markPlaintextCleanup(accountId, artifact.path, "failed");
    } catch {
      await markPlaintextCleanup(accountId, artifact.path, "failed").catch(() => {});
      process.stderr.write(`  ! old plaintext recovery kit was not deleted: ${displayPath(artifact.path)}\n`);
    }
  }
}

export async function recoveryKitStatusLines(
  _accountId: string,
  hasCachedRk: boolean,
  loaded: Awaited<ReturnType<typeof readRecoveryKitRecordState>>,
  keychainState: Awaited<ReturnType<typeof probeKeychainKit>> | undefined,
  plaintextStates: Awaited<ReturnType<typeof recoveryKitFileState>>[],
  pendingGenesis: boolean
): Promise<string[]> {
  const lines: string[] = [];
  if (loaded.state === "unknown") lines.push("recovery kit: status record unavailable or unrecognized — backup state unknown");
  else if (loaded.state === "missing") lines.push(hasCachedRk ? "recovery kit: none recorded — run `rbox key save`" : "recovery kit: none recorded — use the copy you saved at setup, or run `rbox key save`");
  else {
    const record = loaded.record;
    if (record.keychain) {
      const date = (record.keychain.writtenAt ?? record.keychain.discoveredAt)!.slice(0, 10);
      if (keychainState === "present") lines.push(`recovery kit: macOS Keychain \"${record.keychain.service}\" (${record.keychain.writtenAt ? "written" : "discovered"} ${date})`);
      else if (keychainState === "missing") lines.push("recovery kit: macOS Keychain item missing — re-run rbox key save");
      else lines.push("recovery kit: macOS Keychain could not be checked — backup state unknown; try again or re-run `rbox key save`");
    }
    record.plaintextArtifacts.forEach((artifact, index) => {
      const shown = displayPath(artifact.path); const state = plaintextStates[index];
      if (state === "present") lines.push(`recovery kit: ${shown} (written ${artifact.writtenAt.slice(0, 10)})`);
      else if (state === "missing") lines.push(`recovery kit: ${shown} (file missing — moved or deleted)`);
      else if (state === "unavailable") lines.push(`recovery kit: ${shown} (file unavailable — backup state unknown)`);
      else lines.push(`recovery kit: ${shown} (file content unrecognized — replaced?)`);
    });
    record.onePasswordArtifacts.forEach((artifact) => {
      if (artifact.state === "active") {
        lines.push(`recovery kit: 1Password item saved ${artifact.writtenAt.slice(0, 10)} (not checked)`);
      } else {
        lines.push("recovery kit: previous 1Password item is missing or no longer matches");
      }
    });
    if (!record.keychain && record.plaintextArtifacts.length === 0 && record.onePasswordArtifacts.length === 0) lines.push("recovery kit: none recorded — run `rbox key save`");
  }
  if (pendingGenesis) lines.push("recovery phrase staged, not yet saved");
  return lines;
}

export async function maybePrintRecoveryKitNudge(accountId: string, hasCachedRk: boolean): Promise<void> {
  if (process.platform !== "darwin" || process.stdin.isTTY !== true || process.stderr.isTTY !== true) return;
  try {
    await preflightRecoveryEnvelope();
    const keychainPath = await resolveLoginKeychain();
    const state = await probeKeychainKit({ service: "rbox recovery phrase", account: accountId, keychainPath, discoveredAt: new Date().toISOString() });
    if (state !== "missing") return;
    if (!(await claimRecoveryKitOffer(accountId, "status", hasCachedRk ? "cached-rk" : "typed", async () => {
      await preflightRecoveryEnvelope();
      return await probeKeychainKit({ service: "rbox recovery phrase", account: accountId, keychainPath, discoveredAt: new Date().toISOString() }) === "missing";
    }))) return;
    process.stderr.write(hasCachedRk
      ? "Save your cached recovery phrase to the macOS Keychain without typing it: rbox key save\n"
      : "Save your recovery phrase to the macOS Keychain: rbox key save (you'll enter the phrase you saved; rbox validates it before storing)\n");
    await updateRecoveryKitOfferOutcome(accountId, "shown");
  } catch {
    // A nudge is never allowed to make status fail.
  }
}

export async function actionableKeychainOfferTarget(accountId: string): Promise<KeychainArtifact | undefined> {
  try {
    const keychainPath = await resolveLoginKeychain();
    const target: KeychainArtifact = { service: "rbox recovery phrase", account: accountId, keychainPath, discoveredAt: new Date().toISOString() };
    return await probeKeychainKit(target) === "missing" ? target : undefined;
  } catch {
    return undefined;
  }
}
