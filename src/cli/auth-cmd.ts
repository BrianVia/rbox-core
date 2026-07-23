import os from "node:os";
import fs from "node:fs/promises";
import { clearCredentials, credentialsForStrictFlow, loadCredentials, PROD_WEB, saveCredentials } from "./credentials.js";
import { clearAccountProfile } from "./account-profile.js";
import { isInteractive, promptCheckbox, promptConfirm, promptInput, promptKeypress, promptLoginFallback, promptPassword, promptSelect, type CheckboxPrompt } from "./prompt.js";
import { copyToClipboard, openInBrowser } from "./browser-open.js";
import { RboxApi } from "./remote.js";
import { emitJson } from "./json.js";
import { assertNoPendingGenesis, beginAtomicGenesis, completeAtomicGenesis, enrollViaPairing, enrollViaRecovery, enrollViaRecoveryWithPhraseInput, enrollViaWebDelivery, parsePairingToken, RecoveryPreAdmissionError, type AtomicGenesisDestinationSetContext, type AtomicGenesisDestinationSetResult, type WebDeliveryBoundary } from "./e2ee-client.js";
import { preflightRecoveryEnvelope, validatePhraseForAccount } from "./e2ee-client.js";
import { buildPairing, canonicalString, phraseToRk, randomBytes, rkToPhrase, sha256Hex, toB64url, utf8 } from "../engine/e2ee/index.js";
import { loadDevice, loadRecoveryKey } from "./e2ee-keystore.js";
import { acquireGenesisLockPair } from "./genesis-locks.js";
import { isAutostartEnabled } from "./autostart-cmd.js";
import { readStdinTrimmed } from "./read-stdin.js";
import { rboxBanner } from "./wordmark.js";
import { style, stderrStyle } from "./style.js";
import { friendlyHttpError } from "./http-error.js";
import {
  defaultKitTargetDir,
  defaultKitPath,
  deleteMatchingPlaintextArtifact,
  displayPath,
  claimRecoveryKitOffer,
  mergeDiscoveredKeychainArtifact,
  markPlaintextCleanup,
  invalidateOnePasswordArtifact,
  readPlaintextKit,
  readRecoveryKitRecordState,
  recordOnePasswordArtifact,
  recordKeychainArtifact,
  recoveryKitAction,
  recoveryKitFileState,
  resolveRecoveryKitPath,
  updateRecoveryKitOfferOutcome,
  writeRecoveryKit,
  type RecoveryKitOptions,
} from "./recovery-kit.js";
import { genesisClassifierConsultationNeeded, pendingGenesisState } from "./genesis-enrollment.js";
import { GENESIS_PENDING_MESSAGE, foldDestinationProgress, type DestinationCompletion, type DestinationSetCompletionIntent, type RecoveryDestination } from "./genesis-durable.js";
import {
  canonicalRecoveryPhrase,
  probeKeychainKit,
  readKeychainKit,
  resolveLoginKeychain,
  writeKeychainKit,
  type KeychainArtifact,
  type KeychainSeams,
} from "./recovery-kit-keychain.js";
import { retargetThenWriteFallback, shouldPresentGenesisCompletion, type CommittedGenesisClassification, type CompletionIntent, type GenesisSeam, type ValidatedStagedRecoveryKey } from "./genesis-seam.js";
import {
  createOnePasswordRecoveryItem,
  detectOnePasswordCli,
  listOnePasswordAccounts,
  listOnePasswordVaults,
  reconcileOnePasswordRecoveryItem,
  verifyOnePasswordRecoveryItem,
  type OnePasswordDiscovery,
  type OnePasswordLocator,
  type OnePasswordProvider,
} from "./recovery-kit-1password.js";
import { clearRecoverySecretClipboard, copyRecoverySecretToClipboard } from "./recovery-secret-clipboard.js";
import {
  finishLoginAttempt,
  generateLoginAttemptKeys,
  LoginAttemptAccountClaimedError,
  loginAttemptKeys,
  recordDeliveryExpiry,
  recordLoginCredentialSaved,
  recordLoginPersisted,
  reserveLoginCredential,
  resumeLoginAttempt,
  stageLoginAttempt,
  sweepLoginAttempts,
  type LoginAttemptActive,
  type PersistedDelivery,
} from "./login-attempt-journal.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_LOGIN_BACKOFF_MS = 1000;
const MAX_LOGIN_BACKOFF_MS = 60_000;
const NO_KIT: RecoveryKitOptions = { kit: false };
export const EXISTING_ACCOUNT_ENROLLMENT_MESSAGE =
  "account already set up — enroll this machine with `rbox pair` from an enrolled machine, or run `rbox key recover`.";
export const WORKSPACE_SYNC_NEXT_STEP =
  'Run `rbox setup` and choose "Sync an existing workspace" to get your existing folder syncing here.';
const DEVICE_CODE_NOTE_HEADER = "note: device-code login authorized this machine, but encryption is not enrolled.";
const DEVICE_CODE_ENROLL_STEP = "Run `rbox pair` on an enrolled machine or `rbox key recover`.";
/** Wizard mode omits the workspace step (the wizard itself chains there — design
 *  137 R1) and drops the numbering so a single instruction reads as one. */
export function deviceCodeEnrollmentNote(presentation: "standalone" | "wizard"): string {
  return presentation === "wizard"
    ? `${DEVICE_CODE_NOTE_HEADER}\n${DEVICE_CODE_ENROLL_STEP}`
    : `${DEVICE_CODE_NOTE_HEADER}\n1. ${DEVICE_CODE_ENROLL_STEP}\n2. ${WORKSPACE_SYNC_NEXT_STEP}`;
}
const GENESIS_COMMAND = "rbox key genesis --yes";
const HEADLESS_GENESIS_COMMAND_NOTE = `note: no encryption keys yet — run \`${GENESIS_COMMAND}\` to set up this first machine.`;
const ENCRYPTION_ENROLLED_MESSAGE = "encryption enrolled — this workspace will be end-to-end encrypted.";

class KeychainLocatorWriteError extends Error {
  constructor(cause: unknown) {
    super(`recovery phrase is present in Keychain, but status metadata could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "KeychainLocatorWriteError";
  }
}

/** Show the recovery phrase once with a forced acknowledgement (no escrow). The
 *  confirm re-asks until it's a deliberate yes — pressing enter (default No) won't
 *  slip past it — preserving the "you must acknowledge" beat without the literal
 *  "yes" typing of the old readline loop. */
async function showRecoveryPhrase(
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

async function deliverRecoveryPhrase(phrase: string): Promise<void> {
  process.stderr.write(`\n⚠️  rbox is END-TO-END ENCRYPTED. This recovery phrase is the ONLY way back in\n    if you lose every signed-in device. There is NO escrow — we cannot recover it.\n\n    ${phrase}\n\n`);
  if (isInteractive()) {
    while (!(await promptConfirm({ message: "Have you saved this recovery phrase somewhere safe?", default: false }))) {
      process.stderr.write(`    Save it first — it's the ONLY way back in if you lose every device.\n`);
    }
  } else {
    process.stderr.write(`(non-interactive: SAVE THE PHRASE ABOVE — it will not be shown again)\n`);
  }
}

async function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

function clampLoginSleepMs(ms: number): number {
  return Math.min(Math.max(Number.isFinite(ms) ? ms : MIN_LOGIN_BACKOFF_MS, MIN_LOGIN_BACKOFF_MS), MAX_LOGIN_BACKOFF_MS);
}

function pollIntervalMs(intervalSeconds: number): number {
  return clampLoginSleepMs(intervalSeconds * 1000);
}

/** Parse `Retry-After` seconds into a clamped login backoff. */
function retryAfterMs(res: Response, fallbackMs: number): number {
  const header = res.headers.get("Retry-After");
  const secs = header === null ? Number.NaN : Number(header);
  return clampLoginSleepMs(Number.isFinite(secs) && secs >= 0 ? secs * 1000 : fallbackMs);
}

async function rateLimitRetryMs(res: Response, fallbackMs: number): Promise<number> {
  const header = res.headers.get("Retry-After");
  if (header !== null) return retryAfterMs(res, fallbackMs);
  const body = await res.clone().json().catch(() => undefined) as { retryAfterSeconds?: unknown } | undefined;
  const seconds = body?.retryAfterSeconds;
  return clampLoginSleepMs(
    typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
      ? seconds * 1000
      : fallbackMs,
  );
}

interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  interval: number;
  expiresIn: number;
}

/** Start device-code login, retrying bounded 429s with `Retry-After` backoff. */
async function startDeviceCode(
  remoteUrl: string,
  label: string,
  publicKeys: { encPubKey: string; sigPubKey: string },
  wait: (ms: number) => Promise<unknown> = sleep,
): Promise<DeviceCodeStart> {
  const MAX_RETRIES = 4;
  for (let attempt = 0; ; attempt++) {
    const res = await postJson(`${remoteUrl}/v1/auth/device/start`, {
      label,
      encPubKey: publicKeys.encPubKey,
      sigPubKey: publicKeys.sigPubKey,
    });
    if (res.ok) return (await res.json()) as DeviceCodeStart;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitMs = await rateLimitRetryMs(res, Math.min(2000 * (attempt + 1), 10_000));
      console.error(`login rate-limited; retrying in ${Math.ceil(waitMs / 1000)}s...`);
      await wait(waitMs);
      continue;
    }
    if (res.status === 429) throw new Error("login rate-limited — wait a minute and run `rbox login` again");
    throw await friendlyHttpError(res, "login");
  }
}

type GenesisApi = Pick<RboxApi, "getAccountKeys" | "getGenesisObservation" | "bootstrapKeys">;
type GenesisEnrollmentResult = "enrolled" | "already-setup";

type GenesisDestinationChoice = "onepassword" | "keychain" | "kit-path" | "clipboard";

interface GenesisDestinationFlowDeps {
  checkbox?: CheckboxPrompt;
  select?: typeof promptSelect;
  confirm?: typeof promptConfirm;
  writeStderr?: (text: string) => void;
  detectOnePassword?: typeof detectOnePasswordCli;
  listOnePasswordAccounts?: typeof listOnePasswordAccounts;
  listOnePasswordVaults?: typeof listOnePasswordVaults;
  reconcileOnePassword?: typeof reconcileOnePasswordRecoveryItem;
  createOnePassword?: typeof createOnePasswordRecoveryItem;
  verifyOnePassword?: typeof verifyOnePasswordRecoveryItem;
  copyClipboard?: typeof copyRecoverySecretToClipboard;
  clearClipboard?: typeof clearRecoverySecretClipboard;
}

// Copy shaped by two founder field-review rounds (2026-07-23): one clear task,
// heading bright, two short sentences, no security essay. Cut material lives in
// design 187 for docs/web use.
const genesisRecoveryLeadIn = (): string => `
${stderrStyle.bold("Protect your files")}

rbox encrypts files before they leave this machine. Save your recovery
phrase so you can restore access later.

Your files on this machine stay unchanged.
`;

function destinationKinds(destinations: readonly RecoveryDestination[]): Set<GenesisDestinationChoice> {
  return new Set(destinations.map((destination) => destination.kind));
}

async function chooseGenesisDestinationIntent(args: {
  accountId: string;
  requestSha256: string;
  now: number;
  keychainTarget?: KeychainArtifact;
  filePath: string;
  fixed?: RecoveryDestination[];
  opDiscovery?: OnePasswordDiscovery;
  deps?: GenesisDestinationFlowDeps;
}): Promise<DestinationSetCompletionIntent> {
  const deps = args.deps ?? {};
  const checkbox = deps.checkbox ?? promptCheckbox;
  const select = deps.select ?? promptSelect;
  const write = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const fixed = args.fixed ?? [];
  const fixedKinds = destinationKinds(fixed);
  const discovery = args.opDiscovery ?? await (deps.detectOnePassword ?? detectOnePasswordCli)();

  write(rboxBanner() + genesisRecoveryLeadIn());
  // No "1Password CLI not found" notice here (founder cut, 2026-07-23): when op
  // is absent the option simply doesn't appear, and the clipboard flow already
  // says "paste it into your password manager now" at the moment that matters.

  for (;;) {
    const selected = await checkbox<GenesisDestinationChoice>({
      // The TUI renders its own key-hint line — do not embed one in the message.
      message: "Save it in one or more places:",
      choices: [
        ...(discovery.state === "available" ? [{
          name: "1Password",
          value: "onepassword" as const,
          description: "creates a secure item in a vault you choose",
          checked: fixedKinds.has("onepassword"),
          disabled: fixedKinds.has("onepassword") ? "already saved" : false,
        }] : []),
        ...(args.keychainTarget ? [{
          name: "macOS Keychain",
          value: "keychain" as const,
          description: "saves on this Mac; it does not sync through iCloud",
          checked: fixedKinds.has("keychain") || fixed.length === 0,
          disabled: fixedKinds.has("keychain") ? "already saved" : false,
        }] : []),
        {
          name: "Plain-text file",
          value: "kit-path" as const,
          // The exact path prints after the save succeeds — not here.
          description: "Protect it like a password.",
          checked: fixedKinds.has("kit-path") || fixed.length === 0 && !args.keychainTarget,
          disabled: fixedKinds.has("kit-path") ? "already saved" : false,
        },
        {
          name: "Copy to clipboard",
          value: "clipboard" as const,
          // Exposure disclosure moved to copy time, where it matters.
          checked: fixedKinds.has("clipboard"),
          disabled: fixedKinds.has("clipboard") ? "already saved" : false,
        },
      ],
      validate: (values) => values.length + fixed.length > 0 || "Choose at least one place to save the phrase.",
    });

    const requested = new Set<GenesisDestinationChoice>([...fixedKinds, ...selected]);
    const destinations: RecoveryDestination[] = [];
    if (requested.has("onepassword")) {
      const existing = fixed.find((destination) => destination.kind === "onepassword");
      if (existing) {
        destinations.push(existing);
      } else {
        if (discovery.state !== "available") continue;
        write("\n1Password may ask you to sign in or approve access.\n");
        const provider: OnePasswordProvider = { executable: discovery.executable, env: process.env };
        const accountResult = await (deps.listOnePasswordAccounts ?? listOnePasswordAccounts)(provider);
        if (accountResult.state !== "ok" || accountResult.accounts.length === 0) {
          write("\nNo 1Password account is available to the CLI. Sign in or add an account in the 1Password app/CLI, then try again.\n");
          continue;
        }
        const accountUuid = accountResult.accounts.length === 1
          ? accountResult.accounts[0]!.uuid
          : await select<string>({
              message: "Choose a 1Password account:",
              choices: accountResult.accounts.map((account) => ({ name: account.label, value: account.uuid })),
            });
        const vaultResult = await (deps.listOnePasswordVaults ?? listOnePasswordVaults)(provider, accountUuid);
        if (vaultResult.state !== "ok" || vaultResult.vaults.length === 0) {
          write("\nNo writable 1Password vault is available. Choose another save method or try again.\n");
          continue;
        }
        const back = "__rbox_back__";
        const vaultUuid = await select<string>({
          message: "Choose a 1Password vault:",
          choices: [
            ...vaultResult.vaults.map((vault) => ({ name: vault.label, value: vault.uuid })),
            { name: "← Choose another save method", value: back },
          ],
        });
        if (vaultUuid === back) continue;
        destinations.push({
          kind: "onepassword",
          accountUuid,
          vaultUuid,
          operationTag: `rbox_${toB64url(randomBytes(12))}`,
          fieldId: "rboxRecoveryPhrase",
        });
      }
    }
    if (requested.has("keychain") && args.keychainTarget) {
      const existing = fixed.find((destination) => destination.kind === "keychain");
      destinations.push(existing ?? {
        kind: "keychain",
        service: args.keychainTarget.service,
        account: args.keychainTarget.account,
        keychainPath: args.keychainTarget.keychainPath,
      });
    }
    if (requested.has("kit-path")) {
      const existing = fixed.find((destination) => destination.kind === "kit-path");
      destinations.push(existing ?? { kind: "kit-path", path: args.filePath });
    }
    if (requested.has("clipboard")) destinations.push({ kind: "clipboard" });
    return {
      version: 2,
      accountId: args.accountId,
      requestSha256: args.requestSha256,
      mode: "destination-set",
      destinations,
      successThreshold: 1,
      intentAt: new Date(args.now).toISOString(),
    };
  }
}

function destinationLabel(destination: RecoveryDestination): string {
  if (destination.kind === "onepassword") return "1Password";
  if (destination.kind === "keychain") return "macOS Keychain";
  if (destination.kind === "kit-path") return "plain-text file";
  return "Clipboard";
}

async function completeGenesisDestinationSet(
  initial: AtomicGenesisDestinationSetContext,
  creds: { accountId: string; deviceId: string },
  keychainCompletion: GenesisRecoveryKitCompletionDeps,
  deps: GenesisDestinationFlowDeps = {}
): Promise<AtomicGenesisDestinationSetResult> {
  const confirm = deps.confirm ?? promptConfirm;
  const select = deps.select ?? promptSelect;
  const write = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  let context = initial;
  let continuedAfterPartial = false;
  const eventAt = (): string => {
    const current = new Date().toISOString();
    return current < context.progress.updatedAt ? context.progress.updatedAt : current;
  };

  for (;;) {
    const folded = await foldDestinationProgress(context.intent, context.progress.events);
    const liveValid = new Set<number>();
    const failed = new Map<number, string>();

    for (let index = 0; index < context.intent.destinations.length; index++) {
      const destination = context.intent.destinations[index]!;
      const prior = folded.completions[index];
      if (prior) {
        let state: "valid" | "invalid" | "unverifiable" = "valid";
        // Distinguish authoritative-missing from authoritative-mismatch so the
        // durable invalidation records the real reason (MINOR 6).
        let invalidReason: "missing" | "mismatch" = "missing";
        if (prior.kind === "keychain") {
          const probe = await probeKeychainKit(prior);
          state = probe === "present" ? "valid" : probe === "missing" ? "invalid" : "unverifiable";
          invalidReason = "missing";
        } else if (prior.kind === "kit-path") {
          const probe = await readPlaintextKit(prior.path);
          if (probe.state === "present" && probe.accountId === creds.accountId && probe.phrase === context.phrase) state = "valid";
          else if (probe.state === "missing") { state = "invalid"; invalidReason = "missing"; }
          else if (probe.state === "present" || probe.state === "unrecognized") { state = "invalid"; invalidReason = "mismatch"; }
          else state = "unverifiable";
        } else if (prior.kind === "onepassword") {
          const discovery = await (deps.detectOnePassword ?? detectOnePasswordCli)();
          if (discovery.state !== "available") state = "unverifiable";
          else {
            const expected = Buffer.from(context.phrase, "utf8");
            try {
              const verification = await (deps.verifyOnePassword ?? verifyOnePasswordRecoveryItem)(
                { executable: discovery.executable, env: process.env },
                prior,
                expected
              );
              state = verification === "valid" ? "valid" : verification === "mismatch" ? "invalid" : "unverifiable";
              invalidReason = "mismatch";
            } finally {
              expected.fill(0);
            }
          }
        }
        if (state === "valid") {
          liveValid.add(index);
          continue;
        }
        if (state === "invalid") {
          if (prior.kind === "onepassword") {
            await invalidateOnePasswordArtifact(creds.accountId, {
              rboxAccountId: creds.accountId,
              accountUuid: prior.accountUuid,
              vaultUuid: prior.vaultUuid,
              itemUuid: prior.itemUuid,
              fieldId: prior.fieldId,
              operationTag: prior.operationTag,
            }, invalidReason);
          }
          context.progress = await context.append({
            kind: "invalidated",
            destinationIndex: index,
            priorCompletionSha256: await sha256Hex(utf8(canonicalString(prior))),
            reason: invalidReason,
            at: eventAt(),
          });
        } else {
          failed.set(index, "couldn't verify the existing copy");
          continue;
        }
      }

      try {
        let completion: DestinationCompletion | undefined;
        if (destination.kind === "keychain") {
          await keychainCompletion.saveKeychain(context.phrase, {
            version: 1,
            accountId: context.intent.accountId,
            requestSha256: context.intent.requestSha256,
            mode: "keychain",
            keychain: destination,
            intentAt: context.intent.intentAt,
          });
          completion = { ...destination, kind: "keychain", completedAt: eventAt() };
        } else if (destination.kind === "kit-path") {
          const written = await writeRecoveryKit(context.phrase, creds, destination.path);
          if (written.recordError) throw written.recordError;
          completion = { ...destination, kind: "kit-path", completedAt: eventAt() };
        } else if (destination.kind === "clipboard") {
          write("\nClipboard history, other apps, or cross-device clipboard sync may retain this phrase.\nPaste it into your password manager now; rbox will clear the clipboard when you confirm.\n");
          const copied = await (deps.copyClipboard ?? copyRecoverySecretToClipboard)(context.phrase);
          if (!copied.ok) throw new Error("clipboard copy failed");
          if (!(await confirm({ message: "Have you pasted and saved the phrase somewhere durable?", default: false }))) {
            // The phrase is on the clipboard; best-effort clear it before we bail
            // so declining doesn't leave it lingering there (the disclosure said
            // rbox clears the clipboard). Failure to clear is non-fatal here.
            await (deps.clearClipboard ?? clearRecoverySecretClipboard)().catch(() => {});
            throw new Error("not yet confirmed saved");
          }
          const cleared = await (deps.clearClipboard ?? clearRecoverySecretClipboard)();
          if (!cleared.ok && !(await confirm({ message: "rbox couldn't clear the clipboard. Have you cleared it yourself?", default: false }))) {
            throw new Error("clipboard was not cleared");
          }
          completion = { kind: "clipboard", confirmedAt: eventAt() };
        } else {
          const discovery = await (deps.detectOnePassword ?? detectOnePasswordCli)();
          if (discovery.state !== "available") throw new Error("1Password CLI is unavailable");
          const provider: OnePasswordProvider = { executable: discovery.executable, env: process.env };
          const reconciliation = await (deps.reconcileOnePassword ?? reconcileOnePasswordRecoveryItem)(provider, destination);
          let locator: OnePasswordLocator | undefined;
          if (reconciliation.state === "found") {
            if (!folded.attempts[index]) throw new Error("unexpected untracked 1Password item");
            locator = reconciliation.locator;
          } else if (reconciliation.state === "missing") {
            const attempt = folded.attempts[index];
            // Fail closed: once an attempt reached may-have-dispatched, an item
            // might exist in the vault even though we can't see it, so we never
            // create a second one. A plain Retry can't get past this — tell the
            // user to pick "Change incomplete choices" to set up 1Password again.
            if (attempt && attempt.state !== "child-not-started") throw new Error('1Password didn\'t confirm the earlier save. Choose "Change incomplete choices" to set up 1Password again — rbox won\'t create a duplicate');
            const attemptId = `op_${toB64url(randomBytes(12))}`;
            context.progress = await context.append({ kind: "op-dispatch-prepared", destinationIndex: index, attemptId, at: eventAt() });
            context.progress = await context.append({ kind: "op-may-have-dispatched", destinationIndex: index, attemptId, at: eventAt() });
            const created = await (deps.createOnePassword ?? createOnePasswordRecoveryItem)(provider, {
              ...destination,
              rboxAccountId: creds.accountId,
              phrase: context.phrase,
            });
            if (created.state === "child-not-started") {
              context.progress = await context.append({ kind: "op-child-not-started", destinationIndex: index, attemptId, reason: created.reason, at: eventAt() });
              throw new Error("1Password CLI could not start");
            }
            if (created.state !== "created") throw new Error('1Password didn\'t confirm the save. Choose "Change incomplete choices" to set up 1Password again — rbox won\'t create a duplicate');
            locator = created.locator;
          } else {
            throw new Error(reconciliation.state === "ambiguous"
              ? "multiple matching 1Password items need attention"
              : "1Password is unavailable");
          }
          const expected = Buffer.from(context.phrase, "utf8");
          try {
            const verification = await (deps.verifyOnePassword ?? verifyOnePasswordRecoveryItem)(provider, locator, expected);
            if (verification !== "valid") throw new Error(verification === "mismatch" ? "1Password item did not match" : "1Password item could not be verified");
          } finally {
            expected.fill(0);
          }
          const completedAt = eventAt();
          await recordOnePasswordArtifact(creds.accountId, {
            rboxAccountId: creds.accountId,
            ...locator,
            writtenAt: completedAt,
            state: "active",
          });
          completion = { ...locator, kind: "onepassword", completedAt };
        }
        // Derive the event's `at` from the completion's own timestamp instead of
        // sampling the clock a second time — a second sample can land in a later
        // millisecond (e.g. across the 1Password locator write) and there is no
        // integrity reason for them to differ.
        const completedAt = completion.kind === "clipboard" ? completion.confirmedAt : completion.completedAt;
        context.progress = await context.append({ kind: "completed", destinationIndex: index, completion, at: completedAt });
        liveValid.add(index);
      } catch (error) {
        failed.set(index, error instanceof Error ? error.message : "couldn't complete the save");
      }
    }

    if (liveValid.size === context.intent.destinations.length) {
      write(`\n✓ Recovery phrase saved to ${liveValid.size === 1 ? destinationLabel(context.intent.destinations[0]!) : `${liveValid.size} selected places`}\n`);
      for (const index of [...liveValid].sort((a, b) => a - b)) {
        const destination = context.intent.destinations[index]!;
        if (destination.kind === "kit-path") write(`  ${displayPath(destination.path)}\n`);
      }
      return { intent: context.intent, progress: context.progress, liveValidDestinationIndexes: [...liveValid], continuedAfterPartial };
    }

    write(`\nSaved recovery phrase to ${liveValid.size} of ${context.intent.destinations.length} selected places:\n`);
    for (let index = 0; index < context.intent.destinations.length; index++) {
      const destination = context.intent.destinations[index]!;
      write(`  ${liveValid.has(index) ? "✓" : "!"} ${destinationLabel(destination)}${failed.has(index) ? ` — ${failed.get(index)}` : ""}\n`);
    }
    const action = liveValid.size === 0
      ? await select<"retry" | "change">({
          message: "No durable recovery copy is complete yet. What do you want to do?",
          choices: [
            { name: "Retry incomplete choices", value: "retry" },
            { name: "Change incomplete choices", value: "change" },
          ],
        })
      : await select<"retry" | "continue" | "change">({
          message: "What do you want to do?",
          choices: [
            { name: "Retry failed choices", value: "retry" },
            { name: "Continue with the successful copies", value: "continue" },
            { name: "Change incomplete choices", value: "change" },
          ],
        });
    if (action === "retry") continue;
    if (action === "continue") {
      if (await confirm({ message: "Continue setup with only the successful recovery copies?", default: false })) {
        continuedAfterPartial = true;
        return { intent: context.intent, progress: context.progress, liveValidDestinationIndexes: [...liveValid], continuedAfterPartial };
      }
      continue;
    }

    // If an incomplete 1Password choice ever reached may-have-dispatched, an item
    // might already exist in the vault even though rbox can't confirm it. Say so
    // without claiming it is absent (design 187 failure semantics) before the user
    // replaces that choice.
    const maybeOrphanedOnePassword = context.intent.destinations.some((destination, index) =>
      destination.kind === "onepassword" && !liveValid.has(index)
      && folded.attempts[index] !== undefined && folded.attempts[index]!.state !== "child-not-started");
    if (maybeOrphanedOnePassword) {
      write("\nNote: an earlier 1Password save may have created an item rbox can't confirm.\nrbox won't remove it — check 1Password and delete any extra \"rbox recovery phrase\" item you don't want.\n");
    }

    const fixed = [...liveValid].map((index) => context.intent.destinations[index]!);
    let keychainTarget: KeychainArtifact | undefined = context.intent.destinations.find(
      (destination): destination is Extract<RecoveryDestination, { kind: "keychain" }> => destination.kind === "keychain"
    );
    if (!keychainTarget && process.platform === "darwin") {
      try { keychainTarget = await actionableKeychainOfferTarget(creds.accountId) } catch {}
    }
    const replacement = await chooseGenesisDestinationIntent({
      accountId: context.intent.accountId,
      requestSha256: context.intent.requestSha256,
      now: Date.now(),
      keychainTarget,
      filePath: context.intent.destinations.find((destination): destination is Extract<RecoveryDestination, { kind: "kit-path" }> => destination.kind === "kit-path")?.path ?? await defaultKitPath(creds.accountId),
      fixed,
      deps,
    });
    const newIndexByKind = new Map(replacement.destinations.map((destination, index) => [destination.kind, index]));
    const carriedCompletions = await Promise.all([...liveValid].map(async (oldDestinationIndex) => {
      const completion = folded.completions[oldDestinationIndex]!;
      return {
        oldDestinationIndex,
        newDestinationIndex: newIndexByKind.get(completion.kind)!,
        completionSha256: await sha256Hex(utf8(canonicalString(completion))),
      };
    }));
    context = { ...context, ...(await context.replace({ newIntent: replacement, carriedCompletions, liveValidOldIndexes: [...liveValid] })) };
  }
}

interface GenesisEnrollmentDeps {
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

interface GenesisRecoveryKitCompletionDeps {
  select(phrase: string, staged: ValidatedStagedRecoveryKey): Promise<CompletionIntent>;
  validatePhrase(phrase: string): Promise<void>;
  displayPhrase(phrase: string, intent: Extract<CompletionIntent, { mode: "phrase-display" }>): Promise<void>;
  saveKeychain(phrase: string, intent: Extract<CompletionIntent, { mode: "keychain" }>): Promise<void>;
  saveFile(phrase: string, intent: Extract<CompletionIntent, { mode: "kit-path" }>): Promise<void>;
  retargetAfterKeychainFailure?(phrase: string, intent: Extract<CompletionIntent, { mode: "keychain" }>): Promise<Extract<CompletionIntent, { mode: "kit-path" }> | undefined>;
  offerClaimed?(accountId: string): Promise<boolean>;
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

interface DeviceCodePostApprovalDeps {
  isInteractive?: typeof isInteractive;
  promptConfirm?: typeof promptConfirm;
  runGenesisEnrollment?: typeof runGenesisEnrollment;
  writeStderr?: (text: string) => void;
  presentation?: AuthPresentationContext;
}

export type DeviceCodePostApprovalResult = "existing-keys" | "headless-command" | "declined" | "enrolled" | "already-setup";

export function deviceCodeLoginShouldPrintWorkspaceStep(result: DeviceCodePostApprovalResult): boolean {
  return result !== "existing-keys" && result !== "already-setup";
}

function assertValidDeviceCodeApproval(p: { accountId?: string; deviceId?: string }): asserts p is { accountId: string; deviceId: string } {
  if (!p.accountId || !p.deviceId) throw new Error("malformed approval response from server — run `rbox login` again");
}

export async function handleDeviceCodePostApprovalEncryption(
  api: GenesisApi,
  creds: { accountId: string; deviceId: string },
  kitOpts: RecoveryKitOptions = NO_KIT,
  deps: DeviceCodePostApprovalDeps = {}
): Promise<DeviceCodePostApprovalResult> {
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const checkInteractive = deps.isInteractive ?? isInteractive;
  const confirm = deps.promptConfirm ?? promptConfirm;
  const enroll = deps.runGenesisEnrollment ?? runGenesisEnrollment;
  const enrollmentNote = deviceCodeEnrollmentNote(deps.presentation === "wizard" ? "wizard" : "standalone");
  if(await genesisClassifierConsultationNeeded(creds.accountId)){
    const result=await enroll(api,creds,kitOpts);return result==="enrolled"?"enrolled":"already-setup";
  }
  if (await api.getAccountKeys()) {
    writeStderr(`${enrollmentNote}\n`);
    return "existing-keys";
  }

  if (!checkInteractive()) {
    writeStderr(`${HEADLESS_GENESIS_COMMAND_NOTE}\n`);
    return "headless-command";
  }

  const yes = await confirm({ message: "Set up encryption on this first machine now?", default: true });
  if (!yes) {
    writeStderr(`${HEADLESS_GENESIS_COMMAND_NOTE}\n`);
    return "declined";
  }

  const result = await enroll(api, creds, kitOpts);
  if (result === "enrolled") {
    console.log(ENCRYPTION_ENROLLED_MESSAGE);
    return "enrolled";
  }
  writeStderr(`${enrollmentNote}\n`);
  return "already-setup";
}

/** `rbox login [--bootstrap <secret>] [--plan <solo|pro>] [--label <text>]` — obtain a per-device token. */
export type AuthPresentationContext = "standalone" | "wizard";

export function deviceApprovalUrl(userCode: string, fingerprint?: string): string {
  const url = new URL("/cli-login", process.env.RBOX_APP || PROD_WEB);
  url.searchParams.set("code", userCode);
  if (fingerprint) url.hash = `fp=${fingerprint}`;
  return url.toString();
}

interface LoginDeps {
  redeemPair?: typeof redeemPair;
  now?: () => number;
  sleep?: (ms: number) => Promise<unknown>;
  isInteractive?: typeof isInteractive;
  promptLoginFallback?: typeof promptLoginFallback;
  enrollViaWebDelivery?: typeof enrollViaWebDelivery;
  enrollViaRecoveryWithPhraseInput?: typeof enrollViaRecoveryWithPhraseInput;
  onCredentialReserved?: () => void | Promise<void>;
  onWebDeliveryBoundary?: (boundary: WebDeliveryBoundary) => void | Promise<void>;
}

interface KeyDeliveryPoll {
  status: "pending" | "ready" | "delivered" | "expired";
  requestId: string;
  expiresAt: number;
  mkWrapDevice?: string;
  publishedRosterVersion?: number;
  accountEpoch?: number;
}

interface DevicePoll {
  status: string;
  token?: string;
  deviceId?: string;
  accountId?: string;
  interval?: number;
  keyDelivery?: KeyDeliveryPoll | null;
}

export type DeviceLoginFsmState =
  | "awaiting-approval"
  | "key-delivery-pending"
  | "keys-ready"
  | "legacy"
  | "fallback"
  | "admitted";

export type DeviceLoginFsmEvent =
  | { kind: "poll"; poll: DevicePoll }
  | { kind: "deadline" }
  | { kind: "acknowledged" };

/** Pure transition surface used by the FSM tests. Transport/persistence effects
 * are deliberately owned by runDeviceCodeLogin below. */
export function transitionDeviceLogin(
  state: DeviceLoginFsmState,
  event: DeviceLoginFsmEvent,
): DeviceLoginFsmState {
  if (event.kind === "acknowledged") {
    if (state !== "keys-ready") throw new Error(`cannot acknowledge login from ${state}`);
    return "admitted";
  }
  if (event.kind === "deadline") {
    return state === "key-delivery-pending" ? "fallback" : state;
  }
  const delivery = event.poll.keyDelivery;
  if ((event.poll.status === "approved" || event.poll.status === "claimed") && event.poll.token) {
    if (delivery === undefined || delivery === null) return "legacy";
    if (delivery.status === "ready") return "keys-ready";
    if (delivery.status === "pending") return "key-delivery-pending";
    if (delivery.status === "expired") return "fallback";
  }
  if (state === "key-delivery-pending" && delivery?.status === "ready") return "keys-ready";
  if (state === "key-delivery-pending" && delivery?.status === "expired") return "fallback";
  return state;
}

function recordKeys(value: object): string[] {
  return Object.keys(value).sort();
}

function parseKeyDelivery(value: unknown, requestId: string): KeyDeliveryPoll | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("malformed keyDelivery response");
  const delivery = value as Record<string, unknown>;
  if (delivery.requestId !== requestId
    || typeof delivery.expiresAt !== "number"
    || !Number.isSafeInteger(delivery.expiresAt)
    || delivery.expiresAt < 0) {
    throw new Error("keyDelivery request binding is invalid");
  }
  if (delivery.status === "ready") {
    if (canonicalString(recordKeys(delivery)) !== canonicalString([
      "accountEpoch", "expiresAt", "mkWrapDevice", "publishedRosterVersion", "requestId", "status",
    ])
      || typeof delivery.mkWrapDevice !== "string" || !delivery.mkWrapDevice
      || typeof delivery.publishedRosterVersion !== "number"
      || !Number.isSafeInteger(delivery.publishedRosterVersion)
      || delivery.publishedRosterVersion < 0
      || typeof delivery.accountEpoch !== "number"
      || !Number.isSafeInteger(delivery.accountEpoch)
      || delivery.accountEpoch < 0) {
      throw new Error("malformed ready keyDelivery response");
    }
    return delivery as unknown as KeyDeliveryPoll;
  }
  if (!["pending", "delivered", "expired"].includes(String(delivery.status))
    || canonicalString(recordKeys(delivery)) !== canonicalString([
      "expiresAt", "requestId", "status",
    ])) {
    throw new Error("malformed keyDelivery response");
  }
  return delivery as unknown as KeyDeliveryPoll;
}

interface ClaimedLogin {
  token: string;
  deviceId: string;
  accountId: string;
}

async function credentialForAttempt(
  attempt: LoginAttemptActive,
): Promise<ClaimedLogin | undefined> {
  if (attempt.phase === "staged") return undefined;
  const loaded = credentialsForStrictFlow(await loadCredentials());
  if (!loaded
    || loaded.remoteUrl !== attempt.remoteUrl
    || loaded.accountId !== attempt.accountId
    || loaded.deviceId !== attempt.deviceId) {
    if (attempt.phase === "credential-reserved") return undefined;
    throw new Error("saved login credential does not match the resumable attempt");
  }
  return { token: loaded.token, deviceId: loaded.deviceId, accountId: loaded.accountId };
}

async function ackKeyDelivery(
  attempt: LoginAttemptActive,
  credential: ClaimedLogin,
  delivery: Pick<PersistedDelivery, "requestId" | "expiresAt">,
  deps: LoginDeps,
): Promise<void> {
  const wait = deps.sleep ?? sleep;
  for (let retry = 0; retry <= 4; retry++) {
    const response = await postJson(
      `${attempt.remoteUrl}/v1/auth/key-delivery/ack`,
      { requestId: delivery.requestId },
      credential.token,
    );
    if (response.ok) {
      const body = await response.json().catch(() => undefined) as unknown;
      if (typeof body !== "object" || body === null || Array.isArray(body)
        || canonicalString(recordKeys(body)) !== canonicalString(["alreadyDelivered", "ok"])
        || (body as { ok?: unknown }).ok !== true
        || typeof (body as { alreadyDelivered?: unknown }).alreadyDelivered !== "boolean") {
        throw new Error("malformed key-delivery ACK response");
      }
      return;
    }
    if (response.status === 429 && retry < 4) {
      const delay = await rateLimitRetryMs(response, Math.min(1000 * (retry + 1), 5000));
      if ((deps.now ?? Date.now)() + delay >= delivery.expiresAt) break;
      await wait(delay);
      continue;
    }
    throw await friendlyHttpError(response, "key-delivery ACK");
  }
  throw new Error("key-delivery ACK did not complete before expiry");
}

async function refetchPersistedDelivery(
  attempt: Extract<LoginAttemptActive, { phase: "persisted" }>,
  credential: ClaimedLogin,
): Promise<void> {
  const response = await postJson(
    `${attempt.remoteUrl}/v1/auth/device/poll`,
    { deviceCode: attempt.deviceCode },
  );
  if (!response.ok) throw await friendlyHttpError(response, "key-delivery recovery poll");
  const poll = await response.json() as DevicePoll;
  const delivery = parseKeyDelivery(poll.keyDelivery, attempt.requestId);
  if ((poll.status === "approved" || poll.status === "claimed") && poll.token
    && (poll.token !== credential.token
      || poll.deviceId !== credential.deviceId
      || poll.accountId !== credential.accountId)) {
    throw new Error("recovered login credential changed after persistence");
  }
  if (delivery?.status === "delivered") return;
  if (delivery?.status !== "ready") {
    throw new Error("persisted key delivery is no longer ready for ACK");
  }
  const recovered: PersistedDelivery = {
    requestId: delivery.requestId,
    mkWrapDevice: delivery.mkWrapDevice!,
    publishedRosterVersion: delivery.publishedRosterVersion!,
    accountEpoch: delivery.accountEpoch!,
    expiresAt: delivery.expiresAt,
  };
  if (canonicalString(recovered) !== canonicalString(attempt.delivery)) {
    throw new Error("re-fetched key delivery changed after persistence");
  }
}

async function persistClaimedCredential(
  attempt: LoginAttemptActive,
  credential: ClaimedLogin,
  deps: LoginDeps,
): Promise<LoginAttemptActive> {
  const pair = await acquireGenesisLockPair(credential.accountId);
  try {
    const local = await loadDevice(credential.accountId);
    if (local) {
      const localDevice = "secrets" in local ? local.secrets : local.device;
      if (localDevice.deviceId !== credential.deviceId) {
        throw new LoginAttemptAccountClaimedError();
      }
    }
    const reserved = await reserveLoginCredential(
      attempt,
      credential.accountId,
      credential.deviceId,
    );
    await deps.onCredentialReserved?.();
    await saveCredentials({ ...credential, remoteUrl: attempt.remoteUrl });
    return await recordLoginCredentialSaved(
      reserved,
      credential.accountId,
      credential.deviceId,
    );
  } finally {
    await pair.account.release();
    await pair.global.release();
  }
}

async function runDeliveryFallback(
  attempt: LoginAttemptActive,
  label: string,
  presentation: AuthPresentationContext,
  credential: ClaimedLogin | undefined,
  deps: LoginDeps,
): Promise<void> {
  if (attempt.phase === "persisted") {
    throw new Error("persisted key delivery must resume ACK; refusing another enrollment path");
  }
  if (!(deps.isInteractive ?? isInteractive)()) {
    await finishLoginAttempt(attempt, "abandoned", (deps.now ?? Date.now)());
    throw new Error("no enrolled machine delivered keys before expiry — run `rbox login` in a terminal to use a pairing token or recovery phrase");
  }
  const answer = await (deps.promptLoginFallback ?? promptLoginFallback)({
    validPairingToken: (value) => {
      try {
        parsePairingToken(value);
        return true;
      } catch {
        return false;
      }
    },
  });
  await finishLoginAttempt(attempt, "abandoned", (deps.now ?? Date.now)());
  if (answer.kind === "pairing") {
    try {
      await (deps.redeemPair ?? redeemPair)(attempt.remoteUrl, answer.token, label, presentation);
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${message}\npairing may have been consumed — do not fall back to the older browser credential; inspect login status or mint a fresh token`);
    }
  }
  if (!credential) throw new Error("delivery fallback is missing the claimed browser credential");
  const loaded = {
    state: "valid" as const,
    source: "disk" as const,
    credentials: {
      v: 1 as const,
      ...credential,
      remoteUrl: attempt.remoteUrl,
    },
    legacy: false,
    extensions: {},
  };
  const result = await (deps.enrollViaRecoveryWithPhraseInput ?? enrollViaRecoveryWithPhraseInput)(
    async () => answer.phrase,
    (deps.now ?? Date.now)(),
    loaded,
  );
  console.log(`device authorized + encryption enrolled: ${result.deviceId}`);
  if (presentation === "standalone") console.log(WORKSPACE_SYNC_NEXT_STEP);
}

export async function runDeviceCodeLogin(
  initialAttempt: LoginAttemptActive,
  kitOpts: RecoveryKitOptions,
  presentation: AuthPresentationContext,
  deps: LoginDeps = {},
): Promise<void> {
  let attempt = initialAttempt;
  let credential = await credentialForAttempt(attempt);
  if (attempt.phase === "credential-reserved" && credential) {
    attempt = await recordLoginCredentialSaved(
      attempt,
      credential.accountId,
      credential.deviceId,
    );
  }
  const now = deps.now ?? Date.now;
  const wait = deps.sleep ?? sleep;
  const enroll = deps.enrollViaWebDelivery ?? enrollViaWebDelivery;
  let state: DeviceLoginFsmState = attempt.phase === "staged"
    ? "awaiting-approval"
    : attempt.phase === "persisted"
      ? "keys-ready"
      : "key-delivery-pending";

  if (attempt.phase === "persisted") {
    if (!credential) throw new Error("persisted login attempt is missing its credential");
    await refetchPersistedDelivery(attempt, credential);
    await ackKeyDelivery(attempt, credential, attempt.delivery, deps);
    await finishLoginAttempt(attempt, "fulfilled", now());
    console.log(`device authorized + encryption enrolled: ${credential.deviceId}`);
    if (presentation === "standalone") console.log(WORKSPACE_SYNC_NEXT_STEP);
    return;
  }

  const approveUrl = deviceApprovalUrl(attempt.userCode, attempt.pubkeyFingerprint);
  if (attempt.phase === "staged") {
    console.log("\nTo authorize this device, visit:\n");
    console.log(`    ${approveUrl}\n`);
    console.log(`\nWaiting for approval (expires in ${Math.max(0, Math.ceil((attempt.expiresAt - now()) / 1000))}s)...`);
  } else {
    console.log("\nWaiting for encryption keys from an enrolled machine...");
  }
  const copyKey = attempt.phase === "staged" ? offerApprovalCopy(approveUrl) : undefined;
  const basePollWaitMs = pollIntervalMs(attempt.pollIntervalSeconds);
  let nextPollWaitMs = basePollWaitMs;
  try {
    for (;;) {
      const deadline = Math.min(attempt.expiresAt, attempt.deliveryExpiresAt ?? attempt.expiresAt);
      if (now() >= deadline) {
        state = transitionDeviceLogin(state, { kind: "deadline" });
        await copyKey?.close();
        if (state === "fallback") {
          await runDeliveryFallback(attempt, attempt.label, presentation, credential, deps);
          return;
        }
        await finishLoginAttempt(attempt, "abandoned", now());
        throw new Error("authorization timed out");
      }

      await wait(Math.min(nextPollWaitMs, Math.max(1, deadline - now())));
      const pollRes = await postJson(
        `${attempt.remoteUrl}/v1/auth/device/poll`,
        { deviceCode: attempt.deviceCode },
      );
      if (pollRes.status === 409) {
        const responseBody = await pollRes.text().catch(() => "");
        const body = (() => {
          try {
            return JSON.parse(responseBody) as { error?: string; cap?: number; plan?: string };
          } catch {
            return {};
          }
        })();
        if (body.error === "device_limit_reached") {
          throw new Error(`device limit reached (${body.cap}/${body.cap} on ${body.plan}) — revoke a device or upgrade`);
        }
        throw await friendlyHttpError(pollRes, "login", responseBody);
      }
      if (pollRes.status === 404) {
        await finishLoginAttempt(attempt, "abandoned", now());
        throw new Error("authorization expired — run `rbox login` again");
      }
      if (!pollRes.ok) {
        nextPollWaitMs = pollRes.status === 429
          ? await rateLimitRetryMs(pollRes, basePollWaitMs)
          : retryAfterMs(pollRes, basePollWaitMs);
        continue;
      }

      const raw = await pollRes.json() as DevicePoll;
      nextPollWaitMs = raw.interval === undefined ? basePollWaitMs : pollIntervalMs(raw.interval);
      raw.keyDelivery = parseKeyDelivery(raw.keyDelivery, attempt.requestId);
      if (raw.keyDelivery && attempt.deliveryExpiresAt !== raw.keyDelivery.expiresAt) {
        attempt = await recordDeliveryExpiry(attempt, raw.keyDelivery.expiresAt);
      }
      if (raw.status === "not_found"
        || raw.status === "expired"
          && !(state === "key-delivery-pending" && raw.keyDelivery?.status === "expired")) {
        await finishLoginAttempt(attempt, "abandoned", now());
        throw new Error("authorization expired — run `rbox login` again");
      }
      if ((raw.status === "approved" || raw.status === "claimed") && raw.token) {
        assertValidDeviceCodeApproval(raw);
        if (credential
          && (credential.token !== raw.token
            || credential.deviceId !== raw.deviceId
            || credential.accountId !== raw.accountId)) {
          throw new Error("recovered login credential changed across polls");
        }
        if (!credential) {
          credential = { token: raw.token, deviceId: raw.deviceId, accountId: raw.accountId };
          try {
            attempt = await persistClaimedCredential(attempt, credential, deps);
          } catch (error) {
            if (error instanceof LoginAttemptAccountClaimedError) {
              await finishLoginAttempt(attempt, "abandoned", now());
            }
            throw error;
          }
        }
      }

      state = transitionDeviceLogin(state, { kind: "poll", poll: raw });
      if (state === "legacy") {
        if (!credential) throw new Error("legacy device-code claim did not return a credential");
        await copyKey?.close();
        await finishLoginAttempt(attempt, "abandoned", now());
        console.log(`device authorized: ${credential.deviceId}`);
        const enrollment = await handleDeviceCodePostApprovalEncryption(
          new RboxApi(attempt.remoteUrl, credential.token, "", ""),
          { accountId: credential.accountId, deviceId: credential.deviceId },
          kitOpts,
          { presentation },
        );
        if (presentation === "standalone" && deviceCodeLoginShouldPrintWorkspaceStep(enrollment)) {
          console.log(WORKSPACE_SYNC_NEXT_STEP);
        }
        return;
      }
      if (state === "fallback") {
        await copyKey?.close();
        await runDeliveryFallback(attempt, attempt.label, presentation, credential, deps);
        return;
      }
      if (state !== "keys-ready") continue;
      if (!credential || raw.keyDelivery?.status !== "ready") {
        throw new Error("ready key delivery is missing the recovered device credential");
      }
      await copyKey?.close();
      const delivery: PersistedDelivery = {
        requestId: raw.keyDelivery.requestId,
        mkWrapDevice: raw.keyDelivery.mkWrapDevice!,
        publishedRosterVersion: raw.keyDelivery.publishedRosterVersion!,
        accountEpoch: raw.keyDelivery.accountEpoch!,
        expiresAt: raw.keyDelivery.expiresAt,
      };
      await enroll({
        remoteUrl: attempt.remoteUrl,
        token: credential.token,
        accountId: credential.accountId,
        deviceId: credential.deviceId,
        requestId: attempt.requestId,
        mkWrapDevice: delivery.mkWrapDevice,
        publishedRosterVersion: delivery.publishedRosterVersion,
        accountEpoch: delivery.accountEpoch,
        keys: loginAttemptKeys(attempt),
      }, {
        persistCheckpoint: async () => {
          attempt = await recordLoginPersisted(attempt, delivery);
        },
        onBoundary: deps.onWebDeliveryBoundary,
      });
      await ackKeyDelivery(attempt, credential, delivery, deps);
      await finishLoginAttempt(attempt, "fulfilled", now());
      state = transitionDeviceLogin(state, { kind: "acknowledged" });
      console.log(`device authorized + encryption enrolled: ${credential.deviceId}`);
      if (presentation === "standalone") console.log(WORKSPACE_SYNC_NEXT_STEP);
      return;
    }
  } finally {
    await copyKey?.close().catch(() => {});
  }
}

export async function login(
  remoteUrl: string,
  bootstrapSecret?: string,
  bootstrapPlan?: string,
  kitOpts: RecoveryKitOptions = NO_KIT,
  requestedLabel?: string,
  presentation: AuthPresentationContext = "standalone",
  deps: LoginDeps = {},
): Promise<void> {
  const label = requestedLabel?.trim() || os.hostname();
  // Headless pairing: redeem a token from the env (never argv — it's a bearer).
  const envPair = process.env.RBOX_PAIR_TOKEN;
  if (envPair) {
    await (deps.redeemPair ?? redeemPair)(remoteUrl, envPair, label, presentation);
    return;
  }
  if (bootstrapSecret) {
    const res = await postJson(`${remoteUrl}/v1/auth/device/bootstrap`, { secret: bootstrapSecret, label, ...(bootstrapPlan !== undefined ? { plan: bootstrapPlan } : {}) });
    if (!res.ok) throw await friendlyHttpError(res, "login --bootstrap");
    const { token, deviceId, accountId } = (await res.json()) as { token: string; deviceId: string; accountId: string };
    await saveCredentials({ token, deviceId, remoteUrl, accountId });
    console.log(`${style.sym.ok} logged in`);
    const api = new RboxApi(remoteUrl, token, "", "");
    const genesis = await runGenesisEnrollment(api, { accountId, deviceId }, kitOpts);
    if (genesis === "enrolled") {
      console.log(ENCRYPTION_ENROLLED_MESSAGE);
    } else {
      console.error(EXISTING_ACCOUNT_ENROLLMENT_MESSAGE);
    }
    if (presentation === "standalone") console.log(WORKSPACE_SYNC_NEXT_STEP);
    return;
  }

  const now = deps.now ?? Date.now;
  await sweepLoginAttempts(now());
  let attempt = await resumeLoginAttempt(remoteUrl, label, { now });
  if (!attempt) {
    const keys = generateLoginAttemptKeys();
    const encPubKey = toB64url(keys.encPubKeySpki);
    const sigPubKey = toB64url(keys.sigPubKey);
    const start = await startDeviceCode(
      remoteUrl,
      label,
      { encPubKey, sigPubKey },
      deps.sleep ?? sleep,
    );
    const startedAt = now();
    attempt = await stageLoginAttempt({
      deviceCode: start.deviceCode,
      userCode: start.userCode,
      remoteUrl,
      label,
      pollIntervalSeconds: start.interval,
      createdAt: startedAt,
      expiresAt: startedAt + start.expiresIn * 1000,
      keys,
    });
  }
  await runDeviceCodeLogin(attempt, kitOpts, presentation, deps);
}

/** Opportunistically open the approval page and listen for a single copy key
 *  concurrently with polling. `close()` aborts the listener and resolves only
 *  after the prompt runtime has fully released stdin — callers MUST await it
 *  before mounting any follow-on prompt on the same terminal, because the
 *  runtime holds an exclusive per-stdin lock while a prompt is live. */
function offerApprovalCopy(url: string): { close: () => Promise<void> } | undefined {
  openInBrowser(url); // opportunistic; silently no-ops on a headless box
  if (!isInteractive()) return undefined;
  console.log("    press [c] to copy the URL");
  const controller = new AbortController();
  const settled = promptKeypress({ signal: controller.signal }).then((key) => {
    if (key === "c") console.log(copyToClipboard(url) ? "Copied to clipboard." : "Couldn't reach the clipboard — copy the URL above manually.");
  }).catch(() => {});
  return {
    close: async () => {
      controller.abort();
      await settled;
    },
  };
}

export async function logout(): Promise<void> {
  const autostartEnabled = await isAutostartEnabled().catch(() => false);
  await clearCredentials();
  await clearAccountProfile();
  console.log("logged out (credential removed)");
  if (autostartEnabled) console.log("autostart still enabled");
}

async function requireCreds() {
  const creds = credentialsForStrictFlow(await loadCredentials());
  if (!creds) throw new Error("not logged in — run `rbox login` (or `rbox login --bootstrap <secret>`)");
  return creds;
}

/** `rbox device approve <userCode>` — approve another device's pending login. */
export async function approveDevice(userCode: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/device/approve`, { userCode }, creds.token);
  if (!res.ok) throw await friendlyHttpError(res, "device approve");
  console.log(`approved ${userCode}`);
}

export async function listDevices(opts: { json?: boolean } = {}): Promise<void> {
  const creds = await requireCreds();
  const res = await fetch(`${creds.remoteUrl}/v1/auth/devices`, { headers: { authorization: `Bearer ${creds.token}` } });
  if (!res.ok) throw await friendlyHttpError(res, "device list");
  const { devices } = (await res.json()) as { devices: Array<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null; last_seen_version?: string | null; isSelf: boolean }> };
  if (opts.json) {
    emitJson({
      devices: devices.map((d) => ({
        id: d.device_id,
        kind: "cli",
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        lastSeenVersion: d.last_seen_version ?? null,
        revoked: false,
      })),
    });
    return;
  }
  for (const d of devices) {
    const seen = d.last_seen_at ? new Date(d.last_seen_at).toISOString() : "never";
    console.log(`${d.isSelf ? "* " : "  "}${d.device_id}  ${d.label ?? ""}  version ${d.last_seen_version ?? "—"}  last-seen ${seen}`);
  }
}

/** `rbox pair` — generate a single-use, split-secret token that ALSO carries this
 *  account's MK (wrapped) + a signed admission grant, so the new machine enrolls
 *  for encryption in one paste. The `tokenSecret` half is generated locally and
 *  NEVER sent to the server (design 12 §14.6). Printed once; treat as a secret. */
export async function pairCreate(): Promise<void> {
  const creds = await requireCreds();
  if (!creds.accountId) throw new Error("this device isn't enrolled for encryption — run `rbox login --bootstrap <secret>`, `rbox connect` (paste a pairing token from an enrolled machine), or `rbox key recover` first.");
  await assertNoPendingGenesis(creds.accountId);
  const loaded = await loadDevice(creds.accountId);
  if (!loaded || !("secrets" in loaded)) throw new Error("no encryption key on this device — pair/recover this machine before creating a pairing token.");

  // Client owns the tokenId (so the grant binds the exact token, C6) + a 32-byte
  // tokenSecret kept local. The grant is verified-active by buildPairing's caller.
  const tokenId = `t${toB64url(randomBytes(16))}`; // url-safe lookup id (no `.`)
  const tokenSecret = randomBytes(32);
  const notAfter = Date.now() + 10 * 60 * 1000;
  const material = await buildPairing(loaded.secrets, { accountEpoch: 0, tokenId, tokenSecret, notAfter });

  const res = await postJson(
    `${creds.remoteUrl}/v1/auth/pair/create`,
    { tokenId, mkWrap: JSON.stringify(material.mkWrap), admissionGrant: JSON.stringify(material.admissionGrant) },
    creds.token
  );
  if (res.status === 429) throw new Error("too many active pairing tokens — redeem or wait for one to expire");
  if (!res.ok) throw await friendlyHttpError(res, "pair");
  const body = await res.json() as unknown;
  const token = typeof body === "object" && body !== null && !Array.isArray(body)
    ? (body as Record<string, unknown>).token
    : undefined;
  const command = pairingConnectCommand(token, tokenId, tokenSecret);
  await presentPairingConnectCommand(command);
}

/** Redeem a split-secret pairing token → device credential + E2EE enrollment.
 *  The full token comes from the explicit one-shot argv path or, for bare
 *  `rbox connect`, a masked prompt/stdin. It is never logged by redemption. */
export function pairingRedemptionSuccessMessages(deviceId: string, presentation: AuthPresentationContext = "standalone"): readonly string[] {
  return presentation === "wizard"
    ? [`device authorized + encryption enrolled: ${deviceId}`]
    : [`device authorized + encryption enrolled: ${deviceId}`, WORKSPACE_SYNC_NEXT_STEP];
}

/** Build the executable next-machine command only after proving that the
 * server echoed the exact client-chosen lookup id. This is a command-output
 * trust boundary: never interpolate an arbitrary remote response. */
export function pairingConnectCommand(serverToken: unknown, tokenId: string, tokenSecret: Uint8Array): string {
  const expected = `rbox-pair_${tokenId}`;
  if (serverToken !== expected) throw new Error("malformed pairing response (token id mismatch)");
  return `rbox connect ${expected}.${toB64url(tokenSecret)}`;
}

interface PairingConnectPresentationDeps {
  isInteractive?: typeof isInteractive;
  waitForKeypress?: () => Promise<string | undefined>;
  copyToClipboard?: typeof copyToClipboard;
  log?: (message: string) => void;
  write?: (message: string) => void;
}

/** Present and optionally copy the complete one-shot command. Kept separate
 * from minting so the exact executable output is directly regression-tested. */
export async function presentPairingConnectCommand(command: string, deps: PairingConnectPresentationDeps = {}): Promise<void> {
  const log = deps.log ?? ((message: string) => console.log(message));
  const write = deps.write ?? ((message: string) => process.stdout.write(message));
  log("\nPairing command (valid ~10 min, single use — carries your encryption key):\n");
  log(`    ${command}\n`);
  log("Run the command above on the new machine to authorize it and enroll encryption.");

  if ((deps.isInteractive ?? isInteractive)()) {
    write("Press [c] to copy the command to your clipboard, any other key to continue... ");
    const key = await (deps.waitForKeypress ?? promptKeypress)();
    write("\n");
    if (key === "c") {
      log((deps.copyToClipboard ?? copyToClipboard)(command)
        ? "Copied command to clipboard."
        : "Couldn't reach the clipboard — copy the command above manually.");
    }
  }
}

export async function redeemPair(
  remoteUrl: string,
  pairToken: string,
  label?: string,
  presentation: AuthPresentationContext = "standalone"
): Promise<void> {
  const { deviceId } = await enrollViaPairing(remoteUrl, pairToken.trim(), Date.now(), label);
  for (const message of pairingRedemptionSuccessMessages(deviceId, presentation)) console.log(message);
}

interface PairingTokenInputDeps {
  isInteractive?: typeof isInteractive;
  promptPassword?: typeof promptPassword;
  readStdin?: typeof readStdinTrimmed;
}

export async function readPairingTokenInteractive(deps: PairingTokenInputDeps = {}): Promise<string> {
  const token = (deps.isInteractive ?? isInteractive)()
    ? await (deps.promptPassword ?? promptPassword)({ message: "Paste pairing token" })
    : await (deps.readStdin ?? readStdinTrimmed)();
  return token.trim();
}

/** `rbox key recover` — re-enroll this machine from the recovery phrase (needs an
 *  account login first; the phrase unlocks MK, not server auth — §14.7/D10). */
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

/** `rbox key status` — local E2EE enrollment state for the current account. */
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
  const { rkToPhrase } = await import("../engine/e2ee/index.js");
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
    try { phrase = await (await import("../engine/e2ee/index.js")).rkToPhrase(cached) }
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

export async function revokeDevice(deviceId: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/devices/${deviceId}/revoke`, {}, creds.token);
  if (!res.ok) throw await friendlyHttpError(res, "device revoke");
  console.log(`revoked ${deviceId}`);
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
          await writeKitSuccess(phrase, creds, { kit: true, kitPath: await (await import("./recovery-kit.js")).defaultKitPath(creds.accountId) }, suppressEcho);
          return true;
        } catch (fallbackError) {
          process.stderr.write(`  ! plaintext recovery kit write failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}\n`);
        }
      }
    }
    return false;
  }
}

async function writeKitOrThrow(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean): Promise<void> {
  try {
    await writeKitSuccess(phrase, creds, kitOpts, suppressEcho);
  } catch (e) {
    throw new Error(`recovery kit write failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function writeKitSuccess(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean, offeredKeychainPath?: string): Promise<void> {
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

async function offerPlaintextCleanupAfterKeychainSave(accountId: string, canonicalPhrase: string): Promise<void> {
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

async function recoveryKitStatusLines(
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

async function maybePrintRecoveryKitNudge(accountId: string, hasCachedRk: boolean): Promise<void> {
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

async function actionableKeychainOfferTarget(accountId: string): Promise<KeychainArtifact | undefined> {
  try {
    const keychainPath = await resolveLoginKeychain();
    const target: KeychainArtifact = { service: "rbox recovery phrase", account: accountId, keychainPath, discoveredAt: new Date().toISOString() };
    return await probeKeychainKit(target) === "missing" ? target : undefined;
  } catch {
    return undefined;
  }
}
