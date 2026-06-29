import {
  assertMkWrapAuthorized,
  bootstrapAccount,
  buildPairing,
  buildRecoveryAdmission,
  fromB64url,
  generateRecoveryKey,
  generateSignKeyPair,
  generateWrapKeyPair,
  openOwnMasterKey,
  phraseToRk,
  redeemPairing,
  toB64url,
  verifyAccount,
  type DeviceSecrets,
  type RedeemResult,
  type SignedKeyState,
  type SignedRoster,
  type Wrap,
} from "../engine/e2ee/index.js";
import { RboxApi } from "./remote.js";
import type { AccountKeysDTO } from "./e2ee-remote.js";
import { E2eeRemote } from "./e2ee-remote.js";
import { hasDevice, keystorePinStore, loadDevice, saveDevice, saveMasterKey, saveRecoveryKey } from "./e2ee-keystore.js";
import { loadConfig, type WorkspaceConfig } from "./config.js";
import { loadCredentials } from "./credentials.js";
import type { SyncDeps } from "./sync.js";

const ACCOUNT_ID_RE = /^acct_[a-z0-9]+$/i; // grammar gate before trusting the value (D7)
const ADMIT_RETRIES = 4;

/** Parse the verified account chains from the server DTO + verify them (C1/C2/C7). */
async function verifyDto(dto: AccountKeysDTO, now: number) {
  const rosters = dto.rosters.map((s) => JSON.parse(s) as SignedRoster);
  const keyStates = dto.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
  if (!rosters.length || !keyStates.length) throw new Error("account key chain incomplete — refusing (fatal)");
  return { rosters, keyStates, account: await verifyAccount(rosters, keyStates, now) };
}

/** Cross-check a server-returned accountId against the SIGNED roster accountId (D7). */
function assertSignedAccountId(claimed: string, signed: string): void {
  if (!ACCOUNT_ID_RE.test(claimed)) throw new Error(`malformed accountId: ${claimed}`);
  if (claimed !== signed) throw new Error("accountId mismatch — server claim ≠ signed roster (refusing)");
}

// ---- enrollment ------------------------------------------------------------

/**
 * New account, first device (D2 crash-safe): generate keys, persist device.json +
 * mk.key (+ optional recovery cache) LOCALLY FIRST, then POST genesis. A crash
 * after the POST leaves local MK present ⇒ recoverable. Returns the recovery phrase
 * to display once.
 */
export async function bootstrapNewAccount(api: RboxApi, accountId: string, deviceId: string, opts: { cacheRecovery?: boolean; now: number }): Promise<string> {
  if (!ACCOUNT_ID_RE.test(accountId)) throw new Error(`malformed accountId from server: ${accountId}`);
  const boot = await bootstrapAccount(accountId, deviceId, opts.now);
  // Persist locally BEFORE the server POST (crash-safety).
  await saveDevice(boot.secrets);
  if (opts.cacheRecovery) await saveRecoveryKey(accountId, await phraseToRk(boot.recoveryPhrase));
  await api.bootstrapKeys({
    recoveryWrap: JSON.stringify(boot.upload.recoveryWrap),
    recoveryWrapId: boot.upload.recoveryWrapId,
    genesisRoster: JSON.stringify(boot.upload.genesisRoster),
    genesisKeyState: JSON.stringify(boot.upload.genesisKeyState),
    device: { deviceId, sigPubKey: boot.upload.device.sigPubKey, encPubKey: boot.upload.device.encPubKey, mkWrap: JSON.stringify(boot.upload.device.mkWrap) },
  });
  return boot.recoveryPhrase;
}

/** Self-verify the candidate extended chain + wrap authorization BEFORE publishing
 *  (D4) — a chain that wouldn't verify must never wedge other clients. */
async function selfVerifyAdmission(dto: AccountKeysDTO, admissionRoster: SignedRoster, deviceWrap: Wrap, now: number): Promise<void> {
  const rosters = dto.rosters.map((s) => JSON.parse(s) as SignedRoster);
  const keyStates = dto.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
  const account = await verifyAccount([...rosters, admissionRoster], keyStates, now);
  await assertMkWrapAuthorized(deviceWrap, account);
}

/** Persist the device secrets, POST /v1/keys/admit, retrying 409s by rebuilding the
 *  roster against the new head with the SAME keypair (crash-safe, D3/D4). `build`
 *  produces a RedeemResult for a given head roster + the reused keypair. */
async function admitWithRetry(
  api: RboxApi,
  deviceId: string,
  initial: RedeemResult,
  keys: { sig: ReturnType<typeof generateSignKeyPair>; enc: ReturnType<typeof generateWrapKeyPair> },
  rebuild: (dto: AccountKeysDTO) => Promise<RedeemResult>,
  now: number
): Promise<void> {
  let result = initial;
  // Persist the device + MK locally BEFORE admit (D3): the keypair is durable, so a
  // lost admit-response can be finalized on the next run rather than wedging.
  await saveDevice(result.secrets);
  for (let attempt = 0; attempt <= ADMIT_RETRIES; attempt++) {
    const res = await api.admitDevice({
      device: { deviceId, sigPubKey: result.device.sigPubKey, encPubKey: result.device.encPubKey, mkWrap: JSON.stringify(result.device.mkWrap) },
      roster: { version: JSON.parse(result.admissionRoster.body).version as number, signed: JSON.stringify(result.admissionRoster) },
    });
    if (res.ok) return;
    // 409: someone advanced the roster. If our device already landed (lost response),
    // we're done; otherwise rebuild against the new head with the SAME keypair.
    const dto = await api.getAccountKeys();
    if (!dto) throw new Error("account key chain vanished mid-admit (fatal)");
    if (dto.devices.some((d) => d.deviceId === deviceId)) return; // our earlier attempt actually succeeded
    if (attempt === ADMIT_RETRIES) throw new Error("admit kept conflicting — try again");
    result = await rebuild(dto);
    await saveDevice(result.secrets); // keypair unchanged; roster parent updated
  }
}

/** Connect this machine via a split-secret pairing token (D3/D4/D7). */
export async function enrollViaPairing(remoteUrl: string, fullToken: string, now: number): Promise<{ accountId: string; deviceId: string }> {
  const dot = fullToken.lastIndexOf(".");
  if (dot < 1) throw new Error("malformed pairing token (expected `rbox-pair_<id>.<secret>`)");
  const redeemToken = fullToken.slice(0, dot);
  const tokenSecret = fromB64url(fullToken.slice(dot + 1));
  if (tokenSecret.length !== 32) throw new Error("malformed pairing token (secret must be 32 bytes)");

  const res = await fetch(`${remoteUrl}/v1/auth/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: redeemToken }),
  });
  if (!res.ok) throw new Error("pairing failed — token may be expired, used, or invalid. Generate a fresh one with `rbox pair`.");
  const redeem = (await res.json()) as { token: string; deviceId: string; accountId: string; mkWrap: string | null; admissionGrant: string | null };
  if (!redeem.mkWrap || !redeem.admissionGrant) throw new Error("this pairing token carries no key material — it predates E2EE. Generate a fresh one with `rbox pair`.");

  const api = new RboxApi(remoteUrl, redeem.token, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto, now);
  assertSignedAccountId(redeem.accountId, account.currentRoster.accountId); // D7

  const material = { mkWrap: JSON.parse(redeem.mkWrap) as Wrap, admissionGrant: JSON.parse(redeem.admissionGrant) as { grant: string; grantSig: string; admissionPubKey: string; grantSignerDeviceId: string } };
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() };
  const headRoster = (curDto: AccountKeysDTO) => JSON.parse(curDto.rosters[curDto.rosters.length - 1]!) as SignedRoster;
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await redeemPairing({ accountId: redeem.accountId, deviceId: redeem.deviceId, tokenSecret, accountEpoch: account.currentEpoch, material, prevRoster: headRoster(curDto), now, deviceKeys: keys });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap, now); // D4
    return r;
  };

  const initial = await build(dto);
  await persistCredential(remoteUrl, redeem.token, redeem.deviceId, redeem.accountId);
  await admitWithRetry(api, redeem.deviceId, initial, keys, build, now);
  return { accountId: redeem.accountId, deviceId: redeem.deviceId };
}

/** Recover this machine from the phrase (D10): needs an existing device credential
 *  (the caller logged in first); RK unlocks MK + RSK to self-admit. */
export async function enrollViaRecovery(phrase: string, now: number): Promise<{ accountId: string; deviceId: string }> {
  const creds = await loadCredentials();
  if (!creds?.accountId) throw new Error("`rbox recover` needs an account login first — run `rbox login` (web/device-code), then recover.");
  const api = new RboxApi(creds.remoteUrl, creds.token, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto, now);
  assertSignedAccountId(creds.accountId, account.currentRoster.accountId);
  if (!dto.recoveryWrap) throw new Error("no recovery wrap stored for this account");

  const rk = await phraseToRk(phrase);
  const recoveryWrap = JSON.parse(dto.recoveryWrap) as Wrap;
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() };
  const headRoster = (curDto: AccountKeysDTO) => JSON.parse(curDto.rosters[curDto.rosters.length - 1]!) as SignedRoster;
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await buildRecoveryAdmission({ accountId: creds.accountId!, accountEpoch: account.currentEpoch, deviceId: creds.deviceId, recoveryKey: rk, recoveryWrap, prevRoster: headRoster(curDto), now });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap, now);
    return r;
  };
  const initial = await build(dto);
  await admitWithRetry(api, creds.deviceId, initial, keys, build, now);
  return { accountId: creds.accountId, deviceId: creds.deviceId };
}

async function persistCredential(remoteUrl: string, token: string, deviceId: string, accountId: string): Promise<void> {
  const { saveCredentials } = await import("./credentials.js");
  await saveCredentials({ token, deviceId, remoteUrl, accountId });
}

// ---- the sync seam ---------------------------------------------------------

/**
 * Load device secrets for the account, healing a partial keystore (D8): if
 * device.json is present but mk.key is missing, re-open this device's own
 * server-stored MK wrap and save it. A MISSING device.json → not enrolled (D6).
 */
async function ensureSecrets(api: RboxApi, accountId: string, accountEpoch: number, now: number): Promise<DeviceSecrets> {
  const loaded = await loadDevice(accountId);
  if (loaded && "secrets" in loaded) return loaded.secrets;
  if (!loaded) {
    throw new Error("this machine isn't enrolled for encryption — run `rbox pair` on a signed-in machine and connect with the token, or `rbox recover`.");
  }
  // device.json present, mk.key missing → re-derive MK from the server wrap (C7/D8).
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto, now);
  const mine = dto.devices.find((d) => d.deviceId === loaded.device.deviceId);
  if (!mine?.mkWrap) throw new Error("no MK wrap stored for this device — run `rbox recover`.");
  const wrap = JSON.parse(mine.mkWrap) as Wrap;
  await assertMkWrapAuthorized(wrap, account);
  const mk = await openOwnMasterKey(loaded.device, accountEpoch, wrap);
  await saveMasterKey(accountId, mk);
  return { ...loaded.device, mk };
}

/**
 * Build the authed E2EE sync deps for a workspace (D6 fail-closed): no E2EE
 * marker / no enrollment → throw before any sync. Returns the cfg (with the
 * blob-encryption KEK set from the frozen write context) and the E2eeRemote.
 */
export async function buildAuthedRemote(root: string, now: () => number = Date.now): Promise<{ cfg: WorkspaceConfig; deps: SyncDeps }> {
  const cfg = await loadConfig(root);
  if ((cfg as { schema?: string }).schema !== "e2ee/v1") {
    throw new Error("this workspace predates full E2EE — re-run `rbox init` to re-enroll (greenfield; dev data is wiped).");
  }
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login`");
  if (!creds.accountId) throw new Error("credential has no account — re-run `rbox login`");

  const api = new RboxApi(creds.remoteUrl ?? cfg.remoteUrl, creds.token, cfg.remoteWorkspaceId, cfg.projectId);
  const secrets = await ensureSecrets(api, creds.accountId, 0, now());
  const remote = new E2eeRemote(api, { accountId: creds.accountId, workspaceId: cfg.remoteWorkspaceId, deviceId: cfg.deviceId, secrets, now }, keystorePinStore(creds.accountId, cfg.remoteWorkspaceId));
  const kek = await remote.currentKek(); // frozen write epoch (D1)
  return { cfg: { ...cfg, token: creds.token, encrypted: true, kek: Buffer.from(kek) }, deps: { remote } };
}

export { hasDevice };
