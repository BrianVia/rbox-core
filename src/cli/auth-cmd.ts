import os from "node:os";
import fs from "node:fs/promises";
import { clearCredentials, credentialsForStrictFlow, loadCredentials, PROD_WEB, saveCredentials } from "./credentials.js";
import { clearAccountProfile } from "./account-profile.js";
import { isInteractive, promptConfirm, promptInput, promptPassword } from "./prompt.js";
import { copyToClipboard, openInBrowser, waitForKeypress } from "./browser-open.js";
import { RboxApi } from "./remote.js";
import { emitJson } from "./json.js";
import { assertNoPendingGenesis, beginAtomicGenesis, completeAtomicGenesis, enrollViaPairing, enrollViaRecovery, enrollViaRecoveryWithPhraseInput, RecoveryPreAdmissionError } from "./e2ee-client.js";
import { preflightRecoveryEnvelope, validatePhraseForAccount } from "./e2ee-client.js";
import { buildPairing, phraseToRk, randomBytes, rkToPhrase, toB64url } from "../engine/e2ee/index.js";
import { loadDevice, loadRecoveryKey } from "./e2ee-keystore.js";
import { isAutostartEnabled } from "./autostart-cmd.js";
import { readStdinTrimmed } from "./read-stdin.js";
import { friendlyHttpError } from "./http-error.js";
import {
  defaultKitTargetDir,
  defaultKitPath,
  deleteMatchingPlaintextArtifact,
  displayPath,
  claimRecoveryKitOffer,
  mergeDiscoveredKeychainArtifact,
  markPlaintextCleanup,
  readRecoveryKitRecordState,
  recordKeychainArtifact,
  recoveryKitAction,
  recoveryKitFileState,
  resolveRecoveryKitPath,
  updateRecoveryKitOfferOutcome,
  writeRecoveryKit,
  type RecoveryKitOptions,
} from "./recovery-kit.js";
import { genesisClassifierConsultationNeeded, pendingGenesisState } from "./genesis-enrollment.js";
import { GENESIS_PENDING_MESSAGE } from "./genesis-durable.js";
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
  const secs = Number(res.headers.get("Retry-After"));
  return clampLoginSleepMs(Number.isFinite(secs) && secs >= 0 ? secs * 1000 : fallbackMs);
}

interface DeviceCodeStart {
  deviceCode: string;
  userCode: string;
  interval: number;
  expiresIn: number;
}

/** Start device-code login, retrying bounded 429s with `Retry-After` backoff. */
async function startDeviceCode(remoteUrl: string, label: string): Promise<DeviceCodeStart> {
  const MAX_RETRIES = 4;
  for (let attempt = 0; ; attempt++) {
    const res = await postJson(`${remoteUrl}/v1/auth/device/start`, { label });
    if (res.ok) return (await res.json()) as DeviceCodeStart;
    if (res.status === 429 && attempt < MAX_RETRIES) {
      const waitMs = retryAfterMs(res, Math.min(2000 * (attempt + 1), 10_000));
      console.error(`login rate-limited; retrying in ${Math.ceil(waitMs / 1000)}s...`);
      await sleep(waitMs);
      continue;
    }
    if (res.status === 429) throw new Error("login rate-limited — wait a minute and run `rbox login` again");
    throw await friendlyHttpError(res, "login");
  }
}

type GenesisApi = Pick<RboxApi, "getAccountKeys" | "getGenesisObservation" | "bootstrapKeys">;
type GenesisEnrollmentResult = "enrolled" | "already-setup";

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
      if (platform === "darwin") {
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
        if (!shouldPresentGenesisCompletion(record.state === "recognized" && record.record.offer !== undefined, started, { state: "absent" })) {
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
      const selected = await (deps.promptConfirm ?? promptConfirm)({ message: `Save a recovery kit (writes the phrase in PLAINTEXT to ${displayPath(target)})?`, default: true });
      return selected ? { ...base, mode: "kit-path" as const, path: target } : { ...base, mode: "phrase-display" as const };
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

export function deviceApprovalUrl(userCode: string): string {
  return `${process.env.RBOX_APP || PROD_WEB}/cli-login?code=${userCode}`;
}

interface LoginDeps {
  redeemPair?: typeof redeemPair;
}

export async function login(
  remoteUrl: string,
  bootstrapSecret?: string,
  bootstrapPlan?: string,
  kitOpts: RecoveryKitOptions = NO_KIT,
  requestedLabel?: string,
  presentation: AuthPresentationContext = "standalone",
  deps: LoginDeps = {}
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
    console.log(`logged in (bootstrapped) as device ${deviceId}`);
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

  const start = await startDeviceCode(remoteUrl, label);

  // Browser-optional approval (design 47): print a dashboard URL a web session can
  // approve from any browser (laptop/phone, need not be this machine — the SSH case),
  // while keeping the terminal-to-terminal path for those who prefer it. Read RBOX_APP
  // at the call site so a test/override set after import still wins.
  const approveUrl = deviceApprovalUrl(start.userCode);
  console.log(`\nTo authorize this device, visit:\n`);
  console.log(`    ${approveUrl}\n`);
  console.log(`    (or run \`rbox device approve ${start.userCode}\` on an already-signed-in machine)`);
  console.log(`\nWaiting for approval (expires in ${start.expiresIn}s)...`);

  // The copy-key listener runs CONCURRENTLY with polling — it never gates a single
  // tick. We keep a cancel handle so we can close it the instant approval
  // lands (or on timeout), so it never blocks or outlives the flow.
  const copyKey = offerApprovalCopy(approveUrl);
  try {
    const deadline = Date.now() + start.expiresIn * 1000;
    const basePollWaitMs = pollIntervalMs(start.interval);
    while (Date.now() < deadline) {
      await sleep(basePollWaitMs);
      const pollRes = await postJson(`${remoteUrl}/v1/auth/device/poll`, { deviceCode: start.deviceCode });
      // Device cap does not clear through polling.
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
      // Non-OK poll responses are transient until the device code expires.
      if (!pollRes.ok) {
        await sleep(retryAfterMs(pollRes, basePollWaitMs));
        continue;
      }
      const p = (await pollRes.json()) as { status: string; token?: string; deviceId?: string; accountId?: string; interval?: number };
      if (p.status === "approved" && p.token) {
        assertValidDeviceCodeApproval(p);
        await saveCredentials({ token: p.token, deviceId: p.deviceId, remoteUrl, accountId: p.accountId });
        console.log(`device authorized: ${p.deviceId}`);
        const enrollment = await handleDeviceCodePostApprovalEncryption(
          new RboxApi(remoteUrl, p.token, "", ""),
          { accountId: p.accountId, deviceId: p.deviceId },
          kitOpts,
          { presentation }
        );
        if (presentation === "standalone" && deviceCodeLoginShouldPrintWorkspaceStep(enrollment)) {
          console.log(WORKSPACE_SYNC_NEXT_STEP);
        }
        return;
      }
      if (p.status === "expired" || p.status === "not_found") throw new Error("authorization expired — run `rbox login` again");
      // pending → keep polling
    }
    throw new Error("authorization timed out");
  } finally {
    try {
      copyKey?.cancel();
    } catch {
      // already resolved / non-interactive → nothing to close
    }
  }
}

/** Opportunistically open the approval page and listen for a single copy key
 *  concurrently with polling. The cancel handle restores stdin as soon as the
 *  grant completes, so the key listener never outlives the login flow. */
function offerApprovalCopy(url: string): { cancel: () => void } | undefined {
  openInBrowser(url); // opportunistic; silently no-ops on a headless box
  if (!isInteractive()) return undefined;
  console.log("    press [c] to copy the URL");
  const controller = new AbortController();
  void waitForKeypress(controller.signal).then((key) => {
    if (key === "c") console.log(copyToClipboard(url) ? "Copied to clipboard." : "Couldn't reach the clipboard — copy the URL above manually.");
  });
  return { cancel: () => controller.abort() };
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
  const { token } = (await res.json()) as { token: string };
  const full = `${token}.${toB64url(tokenSecret)}`; // <redeemToken>.<tokenSecret>
  console.log(`\nPairing token (valid ~10 min, single use — carries your encryption key):\n`);
  console.log(`    ${full}\n`);
  console.log(`On the new machine, run \`rbox setup\`, choose "Log into an existing account", then "Paste a pairing token".`);

  if (isInteractive()) {
    process.stdout.write("Press [c] to copy the token to your clipboard, any other key to continue... ");
    const key = await waitForKeypress();
    process.stdout.write("\n");
    if (key === "c") console.log(copyToClipboard(full) ? "Copied to clipboard." : "Couldn't reach the clipboard — copy the token above manually.");
  }
}

/** Redeem a split-secret pairing token → device credential + E2EE enrollment.
 *  The full token is read from a prompt/stdin (never argv) and never logged. */
export function pairingRedemptionSuccessMessages(deviceId: string, presentation: AuthPresentationContext = "standalone"): readonly string[] {
  return presentation === "wizard"
    ? [`device authorized + encryption enrolled: ${deviceId}`]
    : [`device authorized + encryption enrolled: ${deviceId}`, WORKSPACE_SYNC_NEXT_STEP];
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
        version: 2,
        recordState: "recognized",
        ...(kitRecord.keychain ? { keychain: { ...kitRecord.keychain, state: keychainState } } : {}),
        plaintextArtifacts: kitRecord.plaintextArtifacts.map((artifact, index) => ({ ...artifact, state: plaintextStates[index] })),
        ...(kitRecord.offer ? { offer: kitRecord.offer } : {}),
        ...(firstFile ? { path: firstFile.path, writtenAt: firstFile.writtenAt } : {}),
        pendingGenesis,
      } : {
        version: 2,
        recordState: kitRead.state,
        plaintextArtifacts: [],
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
    phrase = (await (deps.promptPassword ?? promptPassword)({ message: "Enter your 24-word recovery phrase" })).trim();
  } else {
    phrase = await (deps.readPhraseStdin ?? readBoundedRecoveryPhraseStdin)();
  }
  phrase = await canonicalRecoveryPhrase(phrase);
  await (deps.validatePhrase ?? validatePhraseForAccount)(phrase, loaded);
  await (deps.savePhrase ?? saveValidatedRecoveryPhrase)(phrase, { accountId: creds.accountId, deviceId: creds.deviceId }, kitOpts, deps.seams);
}

async function readBoundedRecoveryPhraseStdin(): Promise<string> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of process.stdin) {
    const chunk = Buffer.from(value as Buffer); size += chunk.length;
    if (size > 1024) throw new Error("recovery phrase input exceeds 1 KiB");
    chunks.push(chunk);
  }
  const combined = Buffer.concat(chunks);
  try {
    const raw = combined.toString("utf8");
    if (/\r|\n/.test(raw.replace(/\r?\n$/, ""))) throw new Error("recovery phrase input contains trailing extra data");
    const phrase = raw.replace(/\r?\n$/, "").trim();
    if (!phrase) throw new Error("no phrase entered");
    return phrase;
  } finally {
    combined.fill(0);
    for (const chunk of chunks) chunk.fill(0);
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
      else lines.push("recovery kit: macOS Keychain unavailable — backup state unknown; retry in a GUI session");
    }
    record.plaintextArtifacts.forEach((artifact, index) => {
      const shown = displayPath(artifact.path); const state = plaintextStates[index];
      if (state === "present") lines.push(`recovery kit: ${shown} (written ${artifact.writtenAt.slice(0, 10)})`);
      else if (state === "missing") lines.push(`recovery kit: ${shown} (file missing — moved or deleted)`);
      else if (state === "unavailable") lines.push(`recovery kit: ${shown} (file unavailable — backup state unknown)`);
      else lines.push(`recovery kit: ${shown} (file content unrecognized — replaced?)`);
    });
    if (!record.keychain && record.plaintextArtifacts.length === 0) lines.push("recovery kit: none recorded — run `rbox key save`");
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
