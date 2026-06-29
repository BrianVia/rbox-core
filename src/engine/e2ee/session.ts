/**
 * E2EE orchestration (design 12, v4) — composes the crypto + protocol modules
 * into the operations a client performs. Pure logic over data structures + a
 * device's local secrets; no network or filesystem here, so it's fully testable
 * (see session.test.ts + e2ee-e2e.test.ts). The CLI layer (src/cli) wires these
 * to the remote API and the on-disk keystore.
 *
 * The server stores everything these functions emit as opaque blobs; only a
 * device holding MK (via its RSA key, a pairing token, or the recovery phrase)
 * can open a workspace KEK and decrypt.
 */
import { generateSignKeyPair, generateWrapKeyPair, sign, signKeyPairFromSeed, signPrivateFromPkcs8, signPrivateToPkcs8, wrapPrivateFromPkcs8, wrapPrivateToPkcs8 } from "./asym.js";
import { buildSignedCommit, parseCommit, verifyCommitSig, type BlobRef, type SignedCommit } from "./commit.js";
import { buildKeyState, GENESIS_PREV_STATE_HASH, verifyKeyStateChain, type SignedKeyState } from "./epoch.js";
import { canonicalString, parseStrict } from "./jcs.js";
import { aesGcmUnwrap, aesGcmWrap, generateMasterKey, generateWorkspaceKek, rsaDeviceUnwrap, rsaDeviceWrap, wrapHash, type Wrap, type WrapContext } from "./keys.js";
import { decryptManifest, encryptManifest } from "./manifest-crypto.js";
import { fromB64url, hkdf, sha256, sha256Hex, toB64url, utf8 } from "./primitives.js";
import { generateRecoveryKey, recoverySignKeyPair, rkToPhrase, rkWrapKey } from "./recovery.js";
import { activeSigners, buildAdmissionRoster, buildGenesisRoster, verifyRosterChain, type AdmissionGrant, type RosterBody, type RosterEntry, type SignedRoster } from "./roster.js";

const PAIR_MK_WRAP_SALT = utf8("rbox/mk-wrap/v1");
const ADMISSION_SALT = utf8("rbox/admission/v1");

/** Everything a device keeps locally (persisted in the keystore, never uploaded
 *  except the public halves + MK wraps). */
export interface DeviceSecrets {
  accountId: string;
  deviceId: string;
  mk: Uint8Array;
  sigPubKey: Uint8Array;
  sigPrivPkcs8: Uint8Array;
  encPubSpki: Uint8Array;
  encPrivPkcs8: Uint8Array;
}

function rosterEntry(deviceId: string, kind: "device" | "recovery", sigPubKey: Uint8Array, encPubSpki: Uint8Array, addedAt: number): RosterEntry {
  return {
    deviceId,
    sigAlg: "Ed25519",
    encAlg: "RSA-OAEP-3072-SHA256",
    sigPubKey: toB64url(sigPubKey),
    encPubKey: toB64url(encPubSpki),
    role: "admin",
    kind,
    addedAt,
    status: "active",
  };
}

function deviceWrapCtx(accountId: string, accountEpoch: number): WrapContext {
  // recipientKeyHash is filled in by rsaDeviceWrap from the recipient's SPKI key
  // and bound via the OAEP label; callers needn't precompute it.
  return { accountId, accountEpoch, wrappedKeyKind: "MK", purpose: "rbox/mk-wrap/device/v1" };
}
function recoveryWrapCtx(accountId: string, accountEpoch: number): WrapContext {
  return { accountId, accountEpoch, wrappedKeyKind: "MK", purpose: "rbox/mk-wrap/recovery/v1" };
}
function pairingWrapCtx(accountId: string, accountEpoch: number): WrapContext {
  return { accountId, accountEpoch, wrappedKeyKind: "MK", purpose: "rbox/mk-wrap/pairing/v1" };
}
function kekWrapCtx(accountId: string, accountEpoch: number, keyEpoch: number): WrapContext {
  return { accountId, accountEpoch, keyEpoch, wrappedKeyKind: "KEK", purpose: "rbox/kek-wrap/v1" };
}

// ---- account bootstrap ----------------------------------------------------

export interface BootstrapResult {
  secrets: DeviceSecrets;
  recoveryPhrase: string;
  /** POST to /v1/keys/bootstrap. */
  upload: {
    recoveryWrap: Wrap;
    recoveryWrapId: string;
    genesisRoster: SignedRoster;
    genesisKeyState: SignedKeyState;
    device: { deviceId: string; sigPubKey: string; encPubKey: string; mkWrap: Wrap };
  };
}

/** Create a brand-new account's key material: MK, this device's keypairs, the
 *  recovery key (+ phrase), the genesis roster (bootstrap device + recovery
 *  principal), and the genesis accountKeyState binding it all. */
export async function bootstrapAccount(accountId: string, deviceId: string, now: number): Promise<BootstrapResult> {
  const mk = generateMasterKey();
  const sig = generateSignKeyPair();
  const enc = generateWrapKeyPair();
  const rk = generateRecoveryKey();
  const rsk = await recoverySignKeyPair(rk);

  const accountEpoch = 0;
  const deviceEntry = rosterEntry(deviceId, "device", sig.publicKey, enc.publicKeySpki, now);
  const recoveryEntry = rosterEntry("recovery", "recovery", rsk.publicKey, enc.publicKeySpki, now);
  const genesisRoster = await buildGenesisRoster({ accountId, bootstrap: deviceEntry, recovery: recoveryEntry, bootstrapSignKey: sig });

  // Wraps: MK to this device (RSA), MK to recovery (AES under rkWrapKey).
  const deviceWrap = await rsaDeviceWrap(enc.publicKeySpki, mk, deviceWrapCtx(accountId, accountEpoch));
  const recoveryWrap = await aesGcmWrap(await rkWrapKey(rk), mk, recoveryWrapCtx(accountId, accountEpoch));
  const recoveryWrapId = await wrapHash(recoveryWrap);

  const genesisKeyState = await buildKeyState({
    accountId,
    accountEpoch,
    prevStateHash: GENESIS_PREV_STATE_HASH,
    rosterVersion: 0,
    rosterHash: genesisRoster.rosterHash,
    keyEpoch: 0,
    mkWrapHashes: [await wrapHash(deviceWrap), recoveryWrapId],
    recoveryWrapId,
    signerDeviceId: deviceId,
    signKey: sig,
  });

  return {
    secrets: {
      accountId,
      deviceId,
      mk,
      sigPubKey: sig.publicKey,
      sigPrivPkcs8: signPrivateToPkcs8(sig.privateKey),
      encPubSpki: enc.publicKeySpki,
      encPrivPkcs8: wrapPrivateToPkcs8(enc.privateKey),
    },
    recoveryPhrase: await rkToPhrase(rk),
    upload: {
      recoveryWrap,
      recoveryWrapId,
      genesisRoster,
      genesisKeyState,
      device: { deviceId, sigPubKey: toB64url(sig.publicKey), encPubKey: toB64url(enc.publicKeySpki), mkWrap: deviceWrap },
    },
  };
}

// ---- workspace keys -------------------------------------------------------

/** Generate a workspace KEK and wrap it under MK (to store as workspace_keys). */
export async function createWorkspaceKey(secrets: DeviceSecrets, workspaceId: string, keyEpoch = 0, accountEpoch = 0): Promise<{ kek: Uint8Array; kekWrap: Wrap }> {
  const kek = generateWorkspaceKek();
  const kekWrap = await aesGcmWrap(secrets.mk, kek, kekWrapCtx(secrets.accountId, accountEpoch, keyEpoch));
  return { kek, kekWrap };
}

/** Unwrap a workspace KEK from its stored wrap using MK. */
export function openWorkspaceKey(secrets: DeviceSecrets, kekWrap: Wrap, keyEpoch = 0, accountEpoch = 0): Promise<Uint8Array> {
  if (kekWrap.kind !== "aesgcm-wrap") throw new Error("workspace KEK wrap must be aesgcm-wrap");
  return aesGcmUnwrap(secrets.mk, kekWrap, kekWrapCtx(secrets.accountId, accountEpoch, keyEpoch));
}

// ---- commit (push) --------------------------------------------------------

export interface BuiltCommit {
  encManifest: Uint8Array; // upload as a normal blob keyed by encManifestSha
  encManifestSha: string;
  commit: SignedCommit;
}

/** Encrypt a manifest and build a signed commit referencing it + its blobRefs. */
export async function buildCommit(args: {
  secrets: DeviceSecrets;
  workspaceId: string;
  kek: Uint8Array;
  keyEpoch: number;
  accountEpoch: number;
  rosterVersion: number;
  seq: number;
  parentSeq: number;
  parentCommitHash: string;
  manifestJson: Uint8Array;
  blobRefs: BlobRef[];
}): Promise<BuiltCommit> {
  const enc = await encryptManifest(args.kek, args.secrets.accountId, args.workspaceId, args.keyEpoch, args.manifestJson);
  const commit = await buildSignedCommit(
    {
      accountId: args.secrets.accountId,
      accountEpoch: args.accountEpoch,
      workspaceId: args.workspaceId,
      seq: args.seq,
      parentSeq: args.parentSeq,
      parentCommitHash: args.parentCommitHash,
      rosterVersion: args.rosterVersion,
      keyEpoch: args.keyEpoch,
      deviceId: args.secrets.deviceId,
      encManifestSha: enc.encManifestSha,
      blobRefs: args.blobRefs,
    },
    { publicKey: args.secrets.sigPubKey, privateKey: signPrivateFromPkcs8(args.secrets.sigPrivPkcs8) }
  );
  return { encManifest: enc.bytes, encManifestSha: enc.encManifestSha, commit };
}

// ---- pull (verify + decrypt) ---------------------------------------------

export interface VerifiedAccount {
  rosters: RosterBody[];
  rosterHashByVersion: Map<number, string>;
}

/** Verify the roster chain + key-state chain for an account (call once per pull
 *  session). `genesisKeyStateTrust` must equal the locally-pinned genesis
 *  key-state hash if the device has one (anti-rollback of the trust root). */
export async function verifyAccount(rosterChain: SignedRoster[], keyStateChain: SignedKeyState[], now: number): Promise<VerifiedAccount> {
  const rosters = await verifyRosterChain(rosterChain, { now });
  const rosterHashByVersion = new Map<number, string>();
  for (let i = 0; i < rosterChain.length; i++) rosterHashByVersion.set(i, rosterChain[i]!.rosterHash);
  await verifyKeyStateChain(keyStateChain, rosters, rosterHashByVersion);
  return { rosters, rosterHashByVersion };
}

/** Verify a pulled commit's signature against the signer's roster entry, then
 *  decrypt the manifest. Throws if the signer isn't an active device in the
 *  commit's rosterVersion, the signature is bad, or the manifest won't decrypt. */
export async function openCommit(args: {
  secrets: DeviceSecrets;
  kek: Uint8Array;
  account: VerifiedAccount;
  commit: SignedCommit;
  encManifest: Uint8Array;
  workspaceId: string;
}): Promise<Uint8Array> {
  const body = parseCommit(args.commit);
  const roster = args.account.rosters[body.rosterVersion];
  if (!roster) throw new Error(`commit references unknown rosterVersion ${body.rosterVersion}`);
  const signers = activeSigners(roster);
  const signerPub = signers.get(body.deviceId);
  if (!signerPub) throw new Error(`commit signer ${body.deviceId} is not an active device in roster v${body.rosterVersion}`);
  if (!(await verifyCommitSig(args.commit, signerPub))) throw new Error("commit signature invalid");
  // encManifest integrity: its hash must equal the signed encManifestSha.
  if ((await sha256Hex(args.encManifest)) !== body.encManifestSha) throw new Error("encManifest does not match the signed encManifestSha");
  return decryptManifest(args.kek, args.secrets.accountId, args.workspaceId, body.keyEpoch, args.encManifest);
}

// ---- pairing (key transfer to a new device, V4-1/R2) ----------------------

export interface PairingMaterial {
  /** opaque, stored server-side keyed by tokenId; handed to the redeemer. */
  mkWrap: Wrap;
  admissionGrant: { grant: string; grantSig: string; admissionPubKey: string; grantSignerDeviceId: string };
}

/** Device A: given a fresh tokenSecret (32 bytes), produce the MK wrap (under a
 *  token-derived key) + the signed admission grant (binding a token-derived
 *  admission key). The server stores these but never sees tokenSecret. */
export async function buildPairing(secrets: DeviceSecrets, args: { accountEpoch: number; tokenId: string; tokenSecret: Uint8Array; notAfter: number }): Promise<PairingMaterial> {
  // Independent derivations from tokenSecret — run together.
  const [wrapKey, admissionSeed] = await Promise.all([
    hkdf(args.tokenSecret, PAIR_MK_WRAP_SALT, utf8("mk-wrap"), 32),
    hkdf(args.tokenSecret, ADMISSION_SALT, utf8("admission-key"), 32),
  ]);
  const mkWrap = await aesGcmWrap(wrapKey, secrets.mk, pairingWrapCtx(secrets.accountId, args.accountEpoch));
  const admissionKp = signKeyPairFromSeed(admissionSeed);
  const grant: AdmissionGrant = {
    type: "rbox/admission-grant/v1",
    accountId: secrets.accountId,
    accountEpoch: args.accountEpoch,
    tokenId: args.tokenId,
    grantId: toB64url(generateRecoveryKey().subarray(0, 16)),
    admissionPubKey: toB64url(admissionKp.publicKey),
    notAfter: args.notAfter,
  };
  const grantStr = canonicalString(grant);
  const grantSig = toB64url(sign(signPrivateFromPkcs8(secrets.sigPrivPkcs8), await sha256(utf8(grantStr))));
  return {
    mkWrap,
    admissionGrant: { grant: grantStr, grantSig, admissionPubKey: toB64url(admissionKp.publicKey), grantSignerDeviceId: secrets.deviceId },
  };
}

export interface RedeemResult {
  secrets: DeviceSecrets;
  device: { deviceId: string; sigPubKey: string; encPubKey: string; mkWrap: Wrap };
  admissionRoster: SignedRoster;
}

/** Device B: unwrap MK from the pairing material (using tokenSecret), generate
 *  its own keypairs, self-wrap MK, and build the admission roster vN+1 that
 *  admits itself (justified by A's grant + a token-derived admissionSig). */
export async function redeemPairing(args: {
  accountId: string;
  deviceId: string;
  tokenSecret: Uint8Array;
  accountEpoch: number;
  material: PairingMaterial;
  prevRoster: SignedRoster; // current head roster (verified by the caller)
  now: number;
}): Promise<RedeemResult> {
  if (args.material.mkWrap.kind !== "aesgcm-wrap") throw new Error("pairing MK wrap must be aesgcm-wrap");
  const wrapKey = await hkdf(args.tokenSecret, PAIR_MK_WRAP_SALT, utf8("mk-wrap"), 32);
  const mk = await aesGcmUnwrap(wrapKey, args.material.mkWrap, pairingWrapCtx(args.accountId, args.accountEpoch));

  const sig = generateSignKeyPair();
  const enc = generateWrapKeyPair();
  const selfWrap = await rsaDeviceWrap(enc.publicKeySpki, mk, deviceWrapCtx(args.accountId, args.accountEpoch));

  const prevBody = parseStrict(args.prevRoster.body) as RosterBody;
  const newEntry = rosterEntry(args.deviceId, "device", sig.publicKey, enc.publicKeySpki, args.now);
  const admissionKp = signKeyPairFromSeed(await hkdf(args.tokenSecret, ADMISSION_SALT, utf8("admission-key"), 32));
  const grant = parseStrict(args.material.admissionGrant.grant) as AdmissionGrant;

  const admissionRoster = await buildAdmissionRoster({
    prev: prevBody,
    newDevice: newEntry,
    newDeviceSignKey: sig,
    grant,
    grantSignerDeviceId: args.material.admissionGrant.grantSignerDeviceId,
    grantSig: args.material.admissionGrant.grantSig,
    admissionSignKey: admissionKp,
    deviceWrapHash: await wrapHash(selfWrap),
  });

  return {
    secrets: {
      accountId: args.accountId,
      deviceId: args.deviceId,
      mk,
      sigPubKey: sig.publicKey,
      sigPrivPkcs8: signPrivateToPkcs8(sig.privateKey),
      encPubSpki: enc.publicKeySpki,
      encPrivPkcs8: wrapPrivateToPkcs8(enc.privateKey),
    },
    device: { deviceId: args.deviceId, sigPubKey: toB64url(sig.publicKey), encPubKey: toB64url(enc.publicKeySpki), mkWrap: selfWrap },
    admissionRoster,
  };
}

/** Recover MK on a fresh device from the recovery phrase + the stored recovery
 *  wrap. Caller then builds a recovery-signed admission roster. */
export async function recoverMasterKey(accountId: string, accountEpoch: number, recoveryKey: Uint8Array, recoveryWrap: Wrap): Promise<Uint8Array> {
  if (recoveryWrap.kind !== "aesgcm-wrap") throw new Error("recovery wrap must be aesgcm-wrap");
  return aesGcmUnwrap(await rkWrapKey(recoveryKey), recoveryWrap, recoveryWrapCtx(accountId, accountEpoch));
}

/** Open this device's own MK wrap (RSA) — used on a device that's already in the
 *  roster but reloading MK from the server (e.g. fresh keystore on same device). */
export async function openOwnMasterKey(secrets: Omit<DeviceSecrets, "mk">, accountEpoch: number, mkWrap: Wrap): Promise<Uint8Array> {
  if (mkWrap.kind !== "rsa-oaep-wrap") throw new Error("device MK wrap must be rsa-oaep-wrap");
  return rsaDeviceUnwrap(wrapPrivateFromPkcs8(secrets.encPrivPkcs8), mkWrap, deviceWrapCtx(secrets.accountId, accountEpoch));
}
