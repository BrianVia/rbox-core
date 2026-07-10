import os from "node:os";
import { clearCredentials, loadCredentials, PROD_WEB, saveCredentials } from "./credentials.js";
import { cancelableSelect, isInteractive, promptConfirm, promptPassword } from "./prompt.js";
import { copyToClipboard, openInBrowser, waitForKeypress } from "./browser-open.js";
import { AccountAlreadyBootstrappedError, RboxApi } from "./remote.js";
import { emitJson } from "./json.js";
import { bootstrapNewAccount, enrollViaPairing, enrollViaRecovery } from "./e2ee-client.js";
import { buildPairing, randomBytes, toB64url } from "../engine/e2ee/index.js";
import { acquireGenesisLock, forgetLocalDeviceMaterial, loadDevice, loadRecoveryKey } from "./e2ee-keystore.js";
import { isAutostartEnabled } from "./autostart-cmd.js";
import { readStdinTrimmed } from "./read-stdin.js";
import { friendlyHttpError } from "./http-error.js";
import {
  defaultKitTargetDir,
  displayPath,
  readRecoveryKitRecord,
  recoveryKitAction,
  recoveryKitFileState,
  writeRecoveryKit,
  type RecoveryKitOptions,
} from "./recovery-kit.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const MIN_LOGIN_BACKOFF_MS = 1000;
const MAX_LOGIN_BACKOFF_MS = 60_000;
const NO_KIT: RecoveryKitOptions = { kit: false };
export const EXISTING_ACCOUNT_ENROLLMENT_MESSAGE =
  "account already set up — enroll this machine with `rbox pair` from an enrolled machine, or run `rbox key recover`.";
const DEVICE_CODE_ENROLLMENT_NOTE =
  "note: device-code login authorized this machine, but encryption is not enrolled. Run `rbox pair` on an enrolled machine or `rbox key recover`.";
const GENESIS_COMMAND = "rbox key genesis --yes";
const HEADLESS_GENESIS_COMMAND_NOTE = `note: no encryption keys yet — run \`${GENESIS_COMMAND}\` to set up this first machine.`;
const ENCRYPTION_ENROLLED_MESSAGE = "encryption enrolled — this workspace will be end-to-end encrypted.";

/** Show the recovery phrase once with a forced acknowledgement (no escrow). The
 *  confirm re-asks until it's a deliberate yes — pressing enter (default No) won't
 *  slip past it — preserving the "you must acknowledge" beat without the literal
 *  "yes" typing of the old readline loop. */
async function showRecoveryPhrase(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions = NO_KIT): Promise<void> {
  if (!isInteractive() && recoveryKitAction(false, kitOpts) === "write-suppress-echo") {
    await writeKitOrThrow(phrase, creds, kitOpts, true);
    return;
  }

  process.stderr.write(`\n⚠️  rbox is END-TO-END ENCRYPTED. This recovery phrase is the ONLY way back in\n    if you lose every signed-in device. There is NO escrow — we cannot recover it.\n\n    ${phrase}\n\n`);
  if (isInteractive()) {
    if (await offerOrWriteKit(phrase, creds, kitOpts)) return;
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

type GenesisApi = Pick<RboxApi, "getAccountKeys" | "bootstrapKeys">;
type GenesisEnrollmentResult = "enrolled" | "already-setup";

interface GenesisEnrollmentDeps {
  showRecoveryPhrase?: typeof showRecoveryPhrase;
  now?: () => number;
}

export async function runGenesisEnrollment(
  api: GenesisApi,
  creds: { accountId: string; deviceId: string },
  kitOpts: RecoveryKitOptions = NO_KIT,
  deps: GenesisEnrollmentDeps = {}
): Promise<GenesisEnrollmentResult> {
  const releaseGenesisLock = acquireGenesisLock(creds.accountId);
  try {
    if (await api.getAccountKeys()) return "already-setup";

    try {
      const phrase = await bootstrapNewAccount(api, creds.accountId, creds.deviceId, { now: (deps.now ?? Date.now)() });
      await (deps.showRecoveryPhrase ?? showRecoveryPhrase)(phrase, creds, kitOpts);
      return "enrolled";
    } catch (err) {
      if (err instanceof AccountAlreadyBootstrappedError) {
        await forgetLocalDeviceMaterial(creds.accountId);
        if (await api.getAccountKeys()) return "already-setup";
      }
      throw err;
    }
  } finally {
    releaseGenesisLock();
  }
}

interface DeviceCodePostApprovalDeps {
  isInteractive?: typeof isInteractive;
  promptConfirm?: typeof promptConfirm;
  runGenesisEnrollment?: typeof runGenesisEnrollment;
  writeStderr?: (text: string) => void;
}

function assertValidDeviceCodeApproval(p: { accountId?: string; deviceId?: string }): asserts p is { accountId: string; deviceId: string } {
  if (!p.accountId || !p.deviceId) throw new Error("malformed approval response from server — run `rbox login` again");
}

export async function handleDeviceCodePostApprovalEncryption(
  api: GenesisApi,
  creds: { accountId: string; deviceId: string },
  kitOpts: RecoveryKitOptions = NO_KIT,
  deps: DeviceCodePostApprovalDeps = {}
): Promise<"existing-keys" | "headless-command" | "declined" | "enrolled" | "already-setup"> {
  const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
  const checkInteractive = deps.isInteractive ?? isInteractive;
  const confirm = deps.promptConfirm ?? promptConfirm;
  const enroll = deps.runGenesisEnrollment ?? runGenesisEnrollment;
  if (await api.getAccountKeys()) {
    writeStderr(`${DEVICE_CODE_ENROLLMENT_NOTE}\n`);
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
  writeStderr(`${DEVICE_CODE_ENROLLMENT_NOTE}\n`);
  return "already-setup";
}

/** `rbox login [--bootstrap <secret>] [--plan <solo|pro>]` — obtain a per-device token. */
export async function login(remoteUrl: string, bootstrapSecret?: string, bootstrapPlan?: string, kitOpts: RecoveryKitOptions = NO_KIT): Promise<void> {
  const label = os.hostname();
  // Headless pairing: redeem a token from the env (never argv — it's a bearer).
  const envPair = process.env.RBOX_PAIR_TOKEN;
  if (envPair) {
    await redeemPair(remoteUrl, envPair);
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
    return;
  }

  const start = await startDeviceCode(remoteUrl, label);

  // Browser-optional approval (design 47): print a dashboard URL a web session can
  // approve from any browser (laptop/phone, need not be this machine — the SSH case),
  // while keeping the terminal-to-terminal path for those who prefer it. Read RBOX_APP
  // at the call site so a test/override set after import still wins.
  const approveUrl = `${process.env.RBOX_APP ?? PROD_WEB}/cli-login?code=${start.userCode}`;
  console.log(`\nTo authorize this device, visit:\n`);
  console.log(`    ${approveUrl}\n`);
  console.log(`    (or run \`rbox device approve ${start.userCode}\` on an already-signed-in machine)`);
  console.log(`\nWaiting for approval (expires in ${start.expiresIn}s)...`);

  // The open/copy prompt runs CONCURRENTLY with polling — it never gates a single
  // tick. We keep the cancelable prompt so we can close it the instant approval
  // lands (or on timeout), so it never blocks or outlives the flow.
  const prompt = offerApprovalOpen(approveUrl);
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
        await handleDeviceCodePostApprovalEncryption(new RboxApi(remoteUrl, p.token, "", ""), { accountId: p.accountId, deviceId: p.deviceId }, kitOpts);
        return;
      }
      if (p.status === "expired" || p.status === "not_found") throw new Error("authorization expired — run `rbox login` again");
      // pending → keep polling
    }
    throw new Error("authorization timed out");
  } finally {
    try {
      prompt?.cancel();
    } catch {
      // already resolved / non-interactive → nothing to close
    }
  }
}

/** Best-effort, non-blocking "open the approval page" helper for the browser-login
 *  flow. Auto-opens the URL opportunistically (a headless spawn just no-ops — there's
 *  no reliable headed/headless signal, so we don't gate on one), then, on a TTY,
 *  shows an [open]/[copy]/[wait] choice WITHOUT the caller awaiting it, so polling
 *  proceeds regardless of whether the user ever answers. Returns the cancelable
 *  prompt (or undefined off-TTY) so the caller can close it once approval lands. */
function offerApprovalOpen(url: string): { cancel: () => void } | undefined {
  openInBrowser(url); // opportunistic; silently no-ops on a headless box
  if (!isInteractive()) return undefined;
  return cancelableSelect<"open" | "copy" | "wait">(
    {
      message: "Open the approval page?",
      choices: [
        { name: "Open in browser", value: "open", description: "launch the URL above in your default browser" },
        { name: "Copy URL to clipboard", value: "copy", description: "paste into a browser on another device (e.g. over SSH)" },
        { name: "I'll approve it another way", value: "wait", description: "keep waiting — approve from any browser or another terminal" },
      ],
    },
    (choice) => {
      if (choice === "open") {
        if (!openInBrowser(url)) console.log(`Open this URL to approve:\n    ${url}`);
      } else if (choice === "copy") {
        console.log(copyToClipboard(url) ? "URL copied to clipboard." : `Copy this URL to approve:\n    ${url}`);
      }
    }
  );
}

export async function logout(): Promise<void> {
  const autostartEnabled = await isAutostartEnabled().catch(() => false);
  await clearCredentials();
  console.log("logged out (credential removed)");
  if (autostartEnabled) console.log("autostart still enabled");
}

async function requireCreds() {
  const creds = await loadCredentials();
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
  const { devices } = (await res.json()) as { devices: Array<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null; isSelf: boolean }> };
  if (opts.json) {
    emitJson({
      devices: devices.map((d) => ({
        id: d.device_id,
        kind: "cli",
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        revoked: false,
      })),
    });
    return;
  }
  for (const d of devices) {
    const seen = d.last_seen_at ? new Date(d.last_seen_at).toISOString() : "never";
    console.log(`${d.isSelf ? "* " : "  "}${d.device_id}  ${d.label ?? ""}  last-seen ${seen}`);
  }
}

/** `rbox pair` — generate a single-use, split-secret token that ALSO carries this
 *  account's MK (wrapped) + a signed admission grant, so the new machine enrolls
 *  for encryption in one paste. The `tokenSecret` half is generated locally and
 *  NEVER sent to the server (design 12 §14.6). Printed once; treat as a secret. */
export async function pairCreate(): Promise<void> {
  const creds = await requireCreds();
  if (!creds.accountId) throw new Error("this device isn't enrolled for encryption — run `rbox login --bootstrap <secret>`, `rbox connect` (paste a pairing token from an enrolled machine), or `rbox key recover` first.");
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
  console.log(`On the new machine: run \`rbox\`, choose "Paste a pairing token", and paste it.`);

  if (isInteractive()) {
    process.stdout.write("Press [c] to copy the token to your clipboard, any other key to continue... ");
    const key = await waitForKeypress();
    process.stdout.write("\n");
    if (key === "c") console.log(copyToClipboard(full) ? "Copied to clipboard." : "Couldn't reach the clipboard — copy the token above manually.");
  }
}

/** Redeem a split-secret pairing token → device credential + E2EE enrollment.
 *  The full token is read from a prompt/stdin (never argv) and never logged. */
export async function redeemPair(remoteUrl: string, pairToken: string): Promise<void> {
  const { deviceId } = await enrollViaPairing(remoteUrl, pairToken.trim(), Date.now());
  console.log(`device authorized + encryption enrolled: ${deviceId}`);
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
export async function recoverCmd(kitOpts: RecoveryKitOptions = NO_KIT): Promise<void> {
  const creds = await loadCredentials();
  if (!creds?.accountId) throw new Error("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");
  let phrase: string;
  if (isInteractive()) {
    // No-echo — the phrase is key material (mask:false = matches the old no-echo).
    phrase = (await promptPassword({ message: "Enter your 24-word recovery phrase" })).trim();
  } else {
    // Piped (`echo "<phrase>" | rbox key recover`) — drain stdin like `connect` does so
    // recovery still works in CI / non-TTY, where inquirer can't run.
    phrase = await readStdinTrimmed();
  }
  if (!phrase) throw new Error("no phrase entered");
  const { accountId, deviceId } = await enrollViaRecovery(phrase, Date.now());
  console.log(`recovered + enrolled this device: ${deviceId}`);
  await offerRecoveryKitAfterRecover(phrase, { accountId, deviceId }, kitOpts);
}

/** `rbox key status` — local E2EE enrollment state for the current account. */
export async function keyStatus(opts: { json?: boolean } = {}): Promise<void> {
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login`");
  const loaded = creds.accountId ? await loadDevice(creds.accountId) : undefined;
  const enrolled = Boolean(loaded && "secrets" in loaded);
  const cachedRk = creds.accountId ? await loadRecoveryKey(creds.accountId) : undefined;
  const kitRecord = creds.accountId ? await readRecoveryKitRecord(creds.accountId) : undefined;
  if (opts.json) {
    emitJson({
      enrolled,
      recoveryKit: kitRecord ? { path: kitRecord.path, writtenAt: kitRecord.writtenAt } : null,
    });
    return;
  }
  console.log(`device:   ${creds.deviceId}`);
  console.log(`account:  ${creds.accountId ?? "(unknown — re-login)"}`);
  if (!creds.accountId) return;
  console.log(`encryption: ${enrolled ? "enrolled (MK present)" : loaded ? "device key present, MK missing — will self-heal on next sync" : "NOT enrolled — run `rbox pair` or `rbox key recover`"}`);
  console.log(`recovery phrase cached locally: ${cachedRk ? "yes (`rbox key backup` can re-show)" : "no (use the phrase you saved at setup)"}`);
  console.log(await recoveryKitStatusLine(creds.accountId, Boolean(cachedRk)));
}

/** `rbox key genesis --yes` — explicit non-interactive first-machine genesis. */
export async function keyGenesis(yes: boolean, kitOpts: RecoveryKitOptions = NO_KIT): Promise<void> {
  if (!yes) throw new Error(`usage: ${GENESIS_COMMAND}`);
  const creds = await loadCredentials();
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
  const creds = await loadCredentials();
  if (!creds?.accountId) throw new Error("not logged in — run `rbox login`");
  const rk = await loadRecoveryKey(creds.accountId);
  if (!rk) {
    console.error("the recovery phrase isn't cached on this device. Use the phrase you saved at setup, or read it from another enrolled device.");
    process.exitCode = 1;
    return;
  }
  const { rkToPhrase } = await import("../engine/e2ee/index.js");
  await showRecoveryPhrase(await rkToPhrase(rk), creds, kitOpts);
}

export async function revokeDevice(deviceId: string): Promise<void> {
  const creds = await requireCreds();
  const res = await postJson(`${creds.remoteUrl}/v1/auth/devices/${deviceId}/revoke`, {}, creds.token);
  if (!res.ok) throw await friendlyHttpError(res, "device revoke");
  console.log(`revoked ${deviceId}`);
}

async function offerOrWriteKit(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions): Promise<boolean> {
  const action = recoveryKitAction(true, kitOpts);
  if (action === "write") return writeKitOrWarn(phrase, creds, kitOpts, false);
  if (action !== "offer") return false;

  const target = displayPath(await defaultKitTargetDir());
  const save = await promptConfirm({ message: `Save a recovery kit (writes the phrase in PLAINTEXT to ${target})?`, default: true });
  return save ? writeKitOrWarn(phrase, creds, kitOpts, false) : false;
}

async function offerRecoveryKitAfterRecover(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions): Promise<void> {
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
  const target = displayPath(await defaultKitTargetDir());
  if (await promptConfirm({ message: `Save a recovery kit (writes the phrase in PLAINTEXT to ${target})?`, default: true })) {
    await writeKitOrWarn(phrase, creds, kitOpts, false);
  }
}

async function writeKitOrWarn(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean): Promise<boolean> {
  try {
    await writeKitSuccess(phrase, creds, kitOpts, suppressEcho);
    return true;
  } catch (e) {
    process.stderr.write(`  ! recovery kit write failed: ${e instanceof Error ? e.message : String(e)}\n`);
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

async function writeKitSuccess(phrase: string, creds: { accountId?: string; deviceId?: string }, kitOpts: RecoveryKitOptions, suppressEcho: boolean): Promise<void> {
  const written = await writeRecoveryKit(phrase, creds, kitOpts.kitPath);
  const shown = displayPath(written.path);
  process.stderr.write(suppressEcho ? `recovery phrase written to ${shown} — not echoed (--kit)\n` : `  ✓ recovery kit written: ${shown}\n`);
  if (written.recordError) process.stderr.write(`  ! recovery kit status record failed: ${written.recordError.message}\n`);
}

async function recoveryKitStatusLine(accountId: string, hasCachedRk: boolean): Promise<string> {
  const record = await readRecoveryKitRecord(accountId);
  if (!record) {
    return hasCachedRk
      ? "recovery kit: none recorded — run `rbox key backup --kit`"
      : "recovery kit: none recorded — no cached phrase on this device; use the copy you saved at setup, or `rbox key recover` (which will offer a kit)";
  }
  const written = record.writtenAt.slice(0, 10);
  const shown = displayPath(record.path);
  const state = await recoveryKitFileState(record);
  if (state === "present") return `recovery kit: ${shown} (written ${written})`;
  if (state === "missing") return `recovery kit: ${shown} (file missing — moved or deleted; re-run rbox key backup --kit)`;
  return `recovery kit: ${shown} (file present but content unrecognized — replaced?)`;
}
