import os from "node:os";
import { credentialsForStrictFlow, loadCredentials, PROD_WEB, saveCredentials } from "../credentials.js";
import { isInteractive, promptConfirm, promptKeypress, promptLoginFallback } from "../prompt.js";
import { copyToClipboard, openInBrowser } from "../browser-open.js";
import { RboxApi } from "../remote.js";
import { enrollViaRecoveryWithPhraseInput, enrollViaWebDelivery, parsePairingToken, type WebDeliveryBoundary } from "../e2ee-client.js";
import { canonicalString, toB64url } from "../../engine/e2ee/index.js";
import { loadDevice } from "../e2ee-keystore.js";
import { acquireGenesisLockPair } from "../genesis-locks.js";
import { style } from "../style.js";
import { friendlyHttpError } from "../http-error.js";
import { type RecoveryKitOptions } from "../recovery-kit.js";
import { genesisClassifierConsultationNeeded } from "../genesis-enrollment.js";
import { finishLoginAttempt, generateLoginAttemptKeys, LoginAttemptAccountClaimedError, loginAttemptKeys, recordDeliveryExpiry, recordLoginCredentialSaved, recordLoginPersisted, reserveLoginCredential, resumeLoginAttempt, stageLoginAttempt, sweepLoginAttempts, type LoginAttemptActive, type PersistedDelivery } from "../login-attempt-journal.js";


import { acknowledgeKeyDeliveryAuth, bootstrapDeviceAuth, pollDeviceAuth, startDeviceAuth } from "../remote/auth-command-wire.js";
import type { JsonValue } from "../../json.js";
import { runGenesisEnrollment, type GenesisApi } from "./genesis-command.js";
import { NO_KIT } from "./recovery-kit-flow.js";
import { redeemPair } from "./pairing-command.js";
import { EXISTING_ACCOUNT_ENROLLMENT_MESSAGE, WORKSPACE_SYNC_NEXT_STEP, deviceCodeEnrollmentNote, HEADLESS_GENESIS_COMMAND_NOTE, ENCRYPTION_ENROLLED_MESSAGE, type AuthPresentationContext } from "./presentation.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_LOGIN_BACKOFF_MS = 1000;
const MAX_LOGIN_BACKOFF_MS = 60_000;

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
    const res = await startDeviceAuth(remoteUrl, {
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
    // Client-skew (design 189 §11): a server that predates key delivery rejects
    // the enrollment pubkey fields as an unknown request shape (400). Fall back
    // to a legacy label-only start — the poll loop then sees no keyDelivery field
    // and completes as an ordinary device-code login (enroll via pairing/phrase).
    // Guard on the retry succeeding so a genuinely bad request still surfaces.
    if (res.status === 400) {
      const legacy = await startDeviceAuth(remoteUrl, { label });
      if (legacy.ok) return (await legacy.json()) as DeviceCodeStart;
    }
    throw await friendlyHttpError(res, "login");
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

type KeyDeliveryPoll = {
  status: "pending" | "ready" | "delivered" | "expired";
  requestId: string;
  expiresAt: number;
  mkWrapDevice?: string;
  publishedRosterVersion?: number;
  accountEpoch?: number;
};

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

function parseKeyDelivery(value: JsonValue | undefined, requestId: string): KeyDeliveryPoll | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("malformed keyDelivery response");
  const delivery = value;
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
    return delivery as KeyDeliveryPoll;
  }
  if (!["pending", "delivered", "expired"].includes(String(delivery.status))
    || canonicalString(recordKeys(delivery)) !== canonicalString([
      "expiresAt", "requestId", "status",
    ])) {
    throw new Error("malformed keyDelivery response");
  }
  return delivery as KeyDeliveryPoll;
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
    const response = await acknowledgeKeyDeliveryAuth(
      attempt.remoteUrl,
      delivery.requestId,
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
  const response = await pollDeviceAuth(attempt.remoteUrl, attempt.deviceCode);
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
      const pollRes = await pollDeviceAuth(attempt.remoteUrl, attempt.deviceCode);
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
    const res = await bootstrapDeviceAuth(remoteUrl, { secret: bootstrapSecret, label, ...(bootstrapPlan !== undefined ? { plan: bootstrapPlan } : {}) });
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
