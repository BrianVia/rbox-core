import {
  assertMkWrapAuthorized,
  bootstrapAccount,
  buildPairing,
  buildRecoveryAdmission,
  fromB64url,
  generateSignKeyPair,
  generateWrapKeyPair,
  openOwnMasterKey,
  phraseToRk,
  randomBytes,
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
import { loadCredentials, saveCredentials } from "./credentials.js";
import type { SyncDeps } from "./sync.js";

const ACCOUNT_ID_RE = /^acct_[a-z0-9]+$/i; // grammar gate before trusting the value (D7)
const ADMIT_RETRIES = 4;

export function newAgentId(): string {
  return `agent_${toB64url(randomBytes(16))}`;
}

const PAIR_TOKEN_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const PAIR_TOKEN_PREFIX = "rbox-pair_";

export interface ParsedPairingToken {
  /** Preserve the prefixed/raw token exactly as supplied for server compatibility. */
  redeemToken: string;
  tokenSecret: Uint8Array;
}

export class PairingTokenShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingTokenShapeError";
  }
}

/** The shared secret decoder used by both the local wizard gate and redemption. */
export function decodePairingSecret(encoded: string): Uint8Array {
  return fromB64url(encoded);
}

/** Pure, single-source grammar for current, raw, and legacy pairing tokens. */
export function parsePairingToken(fullToken: string): ParsedPairingToken {
  const parts = fullToken.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new PairingTokenShapeError("malformed pairing token (expected `rbox-pair_<id>.<secret>`)");
  }
  const redeemToken = parts[0];
  const tokenId = redeemToken.startsWith(PAIR_TOKEN_PREFIX) ? redeemToken.slice(PAIR_TOKEN_PREFIX.length) : redeemToken;
  if (!PAIR_TOKEN_ID_RE.test(tokenId)) throw new PairingTokenShapeError("malformed pairing token (invalid redeem id)");
  let tokenSecret: Uint8Array;
  try {
    tokenSecret = decodePairingSecret(parts[1]);
  } catch (error) {
    throw new PairingTokenShapeError(`malformed pairing token (${error instanceof Error ? error.message : "invalid secret encoding"})`);
  }
  if (tokenSecret.length !== 32) throw new PairingTokenShapeError("malformed pairing token (secret must be 32 bytes)");
  return { redeemToken, tokenSecret };
}

async function pairingRedeemError(res: Response): Promise<Error> {
  if (res.status === 409) {
    const body = (await res.json().catch(() => ({}))) as { error?: string; cap?: unknown; plan?: unknown };
    if (body.error === "device_limit_reached") {
      const cap = typeof body.cap === "number" && Number.isFinite(body.cap) ? body.cap : "?";
      const plan = typeof body.plan === "string" && body.plan ? body.plan : "current plan";
      return new Error(`device limit reached (${cap}/${cap} on ${plan}) — revoke a device or upgrade; pairing token still valid`);
    }
  }
  return new Error("pairing failed — token may be expired, used, or invalid. Generate a fresh one with `rbox pair`.");
}

/** Parse the verified account chains from the server DTO + verify them (C1/C2/C7). */
async function verifyDto(dto: AccountKeysDTO) {
  const rosters = dto.rosters.map((s) => JSON.parse(s) as SignedRoster);
  const keyStates = dto.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
  if (!rosters.length || !keyStates.length) throw new Error("account key chain incomplete — refusing (fatal)");
  return { rosters, keyStates, account: await verifyAccount(rosters, keyStates) };
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
export async function bootstrapNewAccount(api: Pick<RboxApi, "bootstrapKeys">, accountId: string, deviceId: string, opts: { cacheRecovery?: boolean; now: number }): Promise<string> {
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
async function selfVerifyAdmission(dto: AccountKeysDTO, admissionRoster: SignedRoster, deviceWrap: Wrap): Promise<void> {
  const rosters = dto.rosters.map((s) => JSON.parse(s) as SignedRoster);
  const keyStates = dto.keyStates.map((s) => JSON.parse(s) as SignedKeyState);
  const account = await verifyAccount([...rosters, admissionRoster], keyStates);
  await assertMkWrapAuthorized(deviceWrap, account);
}

/** Persist the device secrets, POST /v1/keys/admit, retrying 409s by rebuilding the
 *  roster against the new head with the SAME keypair (crash-safe, D3/D4). `build`
 *  produces a RedeemResult for a given head roster + the reused keypair. */
const headRoster = (dto: AccountKeysDTO): SignedRoster => JSON.parse(dto.rosters[dto.rosters.length - 1]!) as SignedRoster;

async function admitWithRetry(api: RboxApi, deviceId: string, initial: RedeemResult, rebuild: (dto: AccountKeysDTO) => Promise<RedeemResult>, persist = true): Promise<void> {
  // Persist the device + MK locally BEFORE admit (D3): the keypair is durable, so a
  // lost admit-response can be finalized on the next run rather than wedging.
  let result = initial;
  if (persist) await saveDevice(result.secrets);
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
    if (persist) await saveDevice(result.secrets); // keypair unchanged; roster parent updated
  }
}

/** Connect this machine via a split-secret pairing token (D3/D4/D7). */
export async function enrollViaPairing(remoteUrl: string, fullToken: string, now: number, label?: string): Promise<{ accountId: string; deviceId: string }> {
  const { redeemToken, tokenSecret } = parsePairingToken(fullToken);

  const res = await fetch(`${remoteUrl}/v1/auth/pair/redeem`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: redeemToken, ...(label ? { label } : {}) }),
  });
  if (!res.ok) throw await pairingRedeemError(res);
  const redeem = (await res.json()) as { token: string; deviceId: string; accountId: string; mkWrap: string | null; admissionGrant: string | null };
  if (!redeem.mkWrap || !redeem.admissionGrant) throw new Error("this pairing token carries no key material — it predates E2EE. Generate a fresh one with `rbox pair`.");

  const api = new RboxApi(remoteUrl, redeem.token, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  assertSignedAccountId(redeem.accountId, account.currentRoster.accountId); // D7

  const material = { mkWrap: JSON.parse(redeem.mkWrap) as Wrap, admissionGrant: JSON.parse(redeem.admissionGrant) as { grant: string; grantSig: string; admissionPubKey: string; grantSignerDeviceId: string } };
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() }; // one keypair, reused across 409 retries (D3)
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await redeemPairing({ accountId: redeem.accountId, deviceId: redeem.deviceId, tokenSecret, accountEpoch: account.currentEpoch, material, prevRoster: headRoster(curDto), now, deviceKeys: keys });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap); // D4
    return r;
  };

  const initial = await build(dto);
  await saveCredentials({ token: redeem.token, deviceId: redeem.deviceId, remoteUrl, accountId: redeem.accountId });
  await admitWithRetry(api, redeem.deviceId, initial, build);
  return { accountId: redeem.accountId, deviceId: redeem.deviceId };
}

/** Recover this machine from the phrase (D10): needs an existing device credential
 *  (the caller logged in first); RK unlocks MK + RSK to self-admit. */
export async function enrollViaRecovery(phrase: string, now: number): Promise<{ accountId: string; deviceId: string }> {
  return enrollViaPrevalidatedRecovery(await phraseToRk(phrase), now);
}

/** Recovery continuation for callers that already passed the local BIP39 gate. */
export async function enrollViaPrevalidatedRecovery(rk: Uint8Array, now: number): Promise<{ accountId: string; deviceId: string }> {
  const creds = await loadCredentials();
  if (!creds?.accountId) throw new Error("`rbox key recover` needs an account login first — run `rbox login` (web/device-code), then recover.");
  const api = new RboxApi(creds.remoteUrl, creds.token, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  assertSignedAccountId(creds.accountId, account.currentRoster.accountId);
  if (!dto.recoveryWrap) throw new Error("no recovery wrap stored for this account");

  const recoveryWrap = JSON.parse(dto.recoveryWrap) as Wrap;
  // A recovered device is a FRESH roster principal — never reuse the credential's
  // deviceId (it may already be an entry, e.g. recovering on the same machine that
  // lost its keystore) which would collide as a duplicate roster deviceId.
  const deviceId = `rec_${toB64url(randomBytes(6))}`;
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() }; // one keypair, reused across 409 retries (D3)
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await buildRecoveryAdmission({ accountId: creds.accountId!, accountEpoch: account.currentEpoch, deviceId, recoveryKey: rk, recoveryWrap, prevRoster: headRoster(curDto), now, deviceKeys: keys });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap);
    return r;
  };
  const initial = await build(dto);
  await admitWithRetry(api, deviceId, initial, build);
  return { accountId: creds.accountId, deviceId };
}

/** Admit a locally generated agent/API-key device without replacing the issuing
 *  machine's own keystore. The PAT bearer must already authenticate as `deviceId`;
 *  the issuer signs the admission grant, and the new device self-admits through
 *  the same verified roster path as pairing. */
export async function admitAgentDevice(args: {
  remoteUrl: string;
  bearer: string;
  accountId: string;
  deviceId: string;
  issuer: DeviceSecrets;
  expiresAt: number;
  now: number;
}): Promise<DeviceSecrets> {
  const api = new RboxApi(args.remoteUrl, args.bearer, "", "");
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  assertSignedAccountId(args.accountId, account.currentRoster.accountId);

  const tokenSecret = randomBytes(32);
  const tokenId = newAgentId();
  const material = await buildPairing(args.issuer, { accountEpoch: account.currentEpoch, tokenId, tokenSecret, notAfter: args.expiresAt });
  const keys = { sig: generateSignKeyPair(), enc: generateWrapKeyPair() };
  const build = async (curDto: AccountKeysDTO): Promise<RedeemResult> => {
    const r = await redeemPairing({
      accountId: args.accountId,
      deviceId: args.deviceId,
      tokenSecret,
      accountEpoch: account.currentEpoch,
      material,
      prevRoster: headRoster(curDto),
      now: args.now,
      deviceKeys: keys,
    });
    await selfVerifyAdmission(curDto, r.admissionRoster, r.device.mkWrap);
    return r;
  };

  const initial = await build(dto);
  await admitWithRetry(api, args.deviceId, initial, build, false);
  return initial.secrets;
}

// ---- the sync seam ---------------------------------------------------------

/**
 * Load device secrets for the account, healing a partial keystore (D8): if
 * device.json is present but mk.key is missing, re-open this device's own
 * server-stored MK wrap and save it. A MISSING device.json → not enrolled (D6).
 */
async function ensureSecrets(api: RboxApi, accountId: string): Promise<DeviceSecrets> {
  const loaded = await loadDevice(accountId);
  if (loaded && "secrets" in loaded) return loaded.secrets;
  if (!loaded) {
    throw new Error("this machine isn't enrolled for encryption — run `rbox pair` on a signed-in machine and connect with the token, or `rbox key recover`.");
  }
  // device.json present, mk.key missing → re-derive MK from the server wrap (C7/D8),
  // using the account's verified current epoch (not a hardcoded 0).
  const dto = await api.getAccountKeys();
  if (!dto) throw new Error("account has no key material (fatal)");
  const { account } = await verifyDto(dto);
  const mine = dto.devices.find((d) => d.deviceId === loaded.device.deviceId);
  if (!mine?.mkWrap) throw new Error("no MK wrap stored for this device — run `rbox key recover`.");
  const wrap = JSON.parse(mine.mkWrap) as Wrap;
  await assertMkWrapAuthorized(wrap, account);
  const mk = await openOwnMasterKey(loaded.device, account.currentEpoch, wrap);
  await saveMasterKey(accountId, mk);
  return { ...loaded.device, mk };
}

/**
 * Build the authed E2EE sync deps for a workspace (D6 fail-closed): no E2EE
 * marker / no enrollment → throw before any sync. Returns the cfg (with the
 * blob-encryption KEK set from the frozen write context) and the E2eeRemote.
 */
export async function buildAuthedRemote(root: string, now: () => number = Date.now, warningSink?: (line: string) => void): Promise<{ cfg: WorkspaceConfig; deps: SyncDeps; remote: E2eeRemote }> {
  const cfg = await loadConfig(root);
  if ((cfg as { schema?: string }).schema !== "e2ee/v1") {
    throw new Error("this workspace predates full E2EE — re-run `rbox init` to re-enroll (greenfield; dev data is wiped).");
  }
  const creds = await loadCredentials();
  if (!creds) throw new Error("not logged in — run `rbox login`");
  if (!creds.accountId) throw new Error("credential has no account — re-run `rbox login`");

  // ONE effective remote for both the network client and the returned cfg (design 44
  // §2): the sync-state stream stamp derives from cfg.remoteUrl, so the cfg
  // must name the remote actually being talked to — otherwise a baseline built against
  // prod could be accepted while syncing a same-id workspace on a different server,
  // and its divergent (or empty) head would reconcile as local deletes.
  const remoteUrl = creds.remoteUrl ?? cfg.remoteUrl;
  const api = new RboxApi(remoteUrl, creds.token, cfg.remoteWorkspaceId, cfg.projectId, warningSink);
  const secrets = await ensureSecrets(api, creds.accountId);
  const remote = new E2eeRemote(api, { accountId: creds.accountId, workspaceId: cfg.remoteWorkspaceId, secrets, now, ...(warningSink ? { warningSink } : {}) }, keystorePinStore(creds.accountId, cfg.remoteWorkspaceId));
  const writeContext = await remote.currentKek(); // frozen write epoch (D1)
  // `remote` is returned alongside `deps` so version-history commands can reach the
  // E2eeRemote history/restore/advisoryTimes methods directly (the raw transport stays
  // encapsulated); push/pull/sync ignore it and use `deps` as before.
  return {
    cfg: {
      ...cfg,
      remoteUrl,
      token: creds.token,
      encrypted: true,
      kek: Buffer.from(writeContext.kek),
      accountId: writeContext.accountId,
      accountEpoch: writeContext.accountEpoch,
      keyEpoch: writeContext.keyEpoch,
    },
    deps: { remote, ...(warningSink ? { warningSink } : {}) },
    remote,
  };
}

export { hasDevice };
