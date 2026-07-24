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
import { generateSignKeyPair, generateWrapKeyPair, sign, signKeyPairFromSeed, signPrivateFromPkcs8, signPrivateToPkcs8, wrapPrivateFromPkcs8, wrapPrivateToPkcs8, type SignKeyPair, type WrapKeyPair } from "./asym.js";
import { buildSignedCommit, GENESIS_PARENT_HASH, parseCommit, verifyCommitSig, type BlobRef, type BlobRefset, type CommitBody, type SignedCommit } from "./commit.js";
import { buildKeyState, GENESIS_PREV_STATE_HASH, verifyKeyStateChain, type AccountKeyState, type SignedKeyState } from "./epoch.js";
import { canonicalString, parseStrict } from "./jcs.js";
import { aesGcmUnwrap, aesGcmWrap, generateMasterKey, generateWorkspaceKek, rsaDeviceUnwrap, rsaDeviceWrap, wrapHash, type Wrap, type WrapContext } from "./keys.js";
import { decryptManifest, encryptManifest } from "./manifest-crypto.js";
import { fromB64url, hkdf, sha256, sha256Hex, toB64url, utf8 } from "./primitives.js";
import { generateRecoveryKey, recoverySignKeyPair, rkToPhrase, rkWrapKey } from "./recovery.js";
import { activeSigners, buildAdminRoster, buildAdmissionRoster, buildGenesisRoster, verifyRosterChain, type AdmissionGrant, type RosterBody, type RosterEntry, type SignedRoster } from "./roster.js";

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

/** Assemble the local {@link DeviceSecrets} record from a device's freshly
 *  generated (or reused) keypairs + MK. Pure field packaging — no key derivation,
 *  wrapping, or zeroization — shared by bootstrap, pairing redemption, and recovery
 *  admission, which build the identical shape from the identical inputs. */
function deviceSecretsFrom(accountId: string, deviceId: string, mk: Uint8Array, sig: SignKeyPair, enc: WrapKeyPair): DeviceSecrets {
  return {
    accountId,
    deviceId,
    mk,
    sigPubKey: sig.publicKey,
    sigPrivPkcs8: signPrivateToPkcs8(sig.privateKey),
    encPubSpki: enc.publicKeySpki,
    encPrivPkcs8: wrapPrivateToPkcs8(enc.privateKey),
  };
}

/** Assemble the server-facing device upload object (public halves + this device's
 *  MK wrap) that accompanies each secrets record. Pure field packaging — the wrap
 *  is produced by the caller; this only b64url-encodes the public keys. */
function deviceUploadFrom(deviceId: string, sig: SignKeyPair, enc: WrapKeyPair, mkWrap: Wrap): { deviceId: string; sigPubKey: string; encPubKey: string; mkWrap: Wrap } {
  return { deviceId, sigPubKey: toB64url(sig.publicKey), encPubKey: toB64url(enc.publicKeySpki), mkWrap };
}

function rosterEntry(deviceId: string, kind: "device" | "recovery", sigPubKey: Uint8Array, encPubSpki: Uint8Array, addedAt: number, mkWrapHash?: string): RosterEntry {
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
    mkWrapHash,
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
function kekWrapCtx(accountId: string, workspaceId: string, accountEpoch: number, keyEpoch: number): WrapContext {
  // workspaceId is bound into the wrap AAD so a same-account/same-epoch KEK wrap from
  // ANOTHER workspace can't be substituted (per-workspace key separation).
  return { accountId, workspaceId, accountEpoch, keyEpoch, wrappedKeyKind: "KEK", purpose: "rbox/kek-wrap/v1" };
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
  // Wraps first — their hashes bind into the signed roster entries (D5/C7).
  const deviceWrap = await rsaDeviceWrap(enc.publicKeySpki, mk, deviceWrapCtx(accountId, accountEpoch));
  const recoveryWrap = await aesGcmWrap(await rkWrapKey(rk), mk, recoveryWrapCtx(accountId, accountEpoch));
  const deviceWrapHash = await wrapHash(deviceWrap);
  const recoveryWrapId = await wrapHash(recoveryWrap);

  const deviceEntry = rosterEntry(deviceId, "device", sig.publicKey, enc.publicKeySpki, now, deviceWrapHash);
  const recoveryEntry = rosterEntry("recovery", "recovery", rsk.publicKey, enc.publicKeySpki, now, recoveryWrapId);
  const genesisRoster = await buildGenesisRoster({ accountId, bootstrap: deviceEntry, recovery: recoveryEntry, bootstrapSignKey: sig });

  const genesisKeyState = await buildKeyState({
    accountId,
    accountEpoch,
    prevStateHash: GENESIS_PREV_STATE_HASH,
    rosterVersion: 0,
    rosterHash: genesisRoster.rosterHash,
    keyEpoch: 0,
    mkWrapHashes: [deviceWrapHash, recoveryWrapId],
    recoveryWrapId,
    signerDeviceId: deviceId,
    signKey: sig,
  });

  return {
    secrets: deviceSecretsFrom(accountId, deviceId, mk, sig, enc),
    recoveryPhrase: await rkToPhrase(rk),
    upload: {
      recoveryWrap,
      recoveryWrapId,
      genesisRoster,
      genesisKeyState,
      device: deviceUploadFrom(deviceId, sig, enc, deviceWrap),
    },
  };
}

// ---- workspace keys -------------------------------------------------------

/** Generate a workspace KEK and wrap it under MK (to store as workspace_keys). */
export async function createWorkspaceKey(secrets: DeviceSecrets, workspaceId: string, keyEpoch = 0, accountEpoch = 0): Promise<{ kek: Uint8Array; kekWrap: Wrap }> {
  const kek = generateWorkspaceKek();
  const kekWrap = await aesGcmWrap(secrets.mk, kek, kekWrapCtx(secrets.accountId, workspaceId, accountEpoch, keyEpoch));
  return { kek, kekWrap };
}

/** Unwrap a workspace KEK from its stored wrap using MK. The `workspaceId` MUST be
 *  the workspace this wrap belongs to — it's bound into the AAD, so passing a
 *  different one (a server serving another workspace's wrap) fails closed. */
export function openWorkspaceKey(secrets: DeviceSecrets, kekWrap: Wrap, workspaceId: string, keyEpoch = 0, accountEpoch = 0): Promise<Uint8Array> {
  if (kekWrap.kind !== "aesgcm-wrap") throw new Error("workspace KEK wrap must be aesgcm-wrap");
  return aesGcmUnwrap(secrets.mk, kekWrap, kekWrapCtx(secrets.accountId, workspaceId, accountEpoch, keyEpoch));
}

// ---- commit (push) --------------------------------------------------------

export interface BuiltCommit {
  encManifest: Uint8Array; // upload as a normal blob keyed by encManifestSha
  encManifestSha: string;
  commit: SignedCommit;
}

/** Encrypt a manifest and build a signed commit referencing it + its ref set. The ref set
 *  is carried inline (`blobRefs`) OR, for large repos, as a §24 sidecar descriptor
 *  (`blobRefset`) — the caller uploads the sidecar blob and passes the descriptor. Exactly
 *  one is supplied; `blobRefset` wins when present. */
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
  blobRefset?: BlobRefset;
  manifestChain?: string[];
  onEncryptMs?: (ms: number) => void;
}): Promise<BuiltCommit> {
  const t0 = args.onEncryptMs ? Date.now() : 0;
  const enc = await encryptManifest(args.kek, args.secrets.accountId, args.workspaceId, args.keyEpoch, args.manifestJson);
  if (args.onEncryptMs) args.onEncryptMs(Date.now() - t0);
  const base = {
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
    manifestChain: args.manifestChain,
  };
  const signKey = { publicKey: args.secrets.sigPubKey, privateKey: signPrivateFromPkcs8(args.secrets.sigPrivPkcs8) };
  const commit = await buildSignedCommit(args.blobRefset !== undefined ? { ...base, blobRefset: args.blobRefset } : { ...base, blobRefs: args.blobRefs }, signKey);
  return { encManifest: enc.bytes, encManifestSha: enc.encManifestSha, commit };
}

// ---- pull (verify + decrypt) ---------------------------------------------

export interface VerifiedAccount {
  rosters: RosterBody[];
  rosterHashByVersion: Map<number, string>;
  /** stateHash of the verified key-state at each account epoch (C2 anti-rollback:
   *  a fetched chain must agree with the device's pinned `keyStateHash` at its
   *  pinned epoch — catches a same-epoch key-state fork/substitution). */
  keyStateHashByEpoch: Map<number, string>;
  keyStates: AccountKeyState[];
  /** Highest-version roster — the authority for "is this device active NOW". */
  currentRoster: RosterBody;
  currentRosterHash: string;
  /** Highest account epoch (commits MUST be at this epoch to be applied — C4). */
  currentEpoch: number;
  /** Workspace-KEK epoch selector at the current account epoch. */
  currentKeyEpoch: number;
  currentKeyStateHash: string;
  /** Every MK-wrap hash ever bound in a signed roster/key-state (C7): a fetched
   *  MK wrap is trusted only if its hash is in here. */
  authorizedMkWrapHashes: Set<string>;
}

/** A device's locally pinned head, anti-rollback (C1/C2). */
export interface Pin {
  commitSeq: number;
  commitHash: string;
}

/** Verify the roster chain + key-state chain for an account (call once per pull
 *  session). Returns the verified, pinnable head facts. The caller MUST also
 *  check these extend its locally-pinned `rosterHash`/`keyStateHash` (C2). */
export async function verifyAccount(rosterChain: SignedRoster[], keyStateChain: SignedKeyState[]): Promise<VerifiedAccount> {
  const rosters = await verifyRosterChain(rosterChain);
  const rosterHashByVersion = new Map<number, string>();
  for (let i = 0; i < rosterChain.length; i++) rosterHashByVersion.set(i, rosterChain[i]!.rosterHash);
  const keyStates = await verifyKeyStateChain(keyStateChain, rosters, rosterHashByVersion);
  // The key-state chain is indexed by epoch (verifyKeyStateChain asserts body.accountEpoch === e).
  const keyStateHashByEpoch = new Map<number, string>();
  for (let e = 0; e < keyStateChain.length; e++) keyStateHashByEpoch.set(e, keyStateChain[e]!.stateHash);

  // The set of MK-wrap hashes the account has ever signed: key-state mkWrapHashes
  // (genesis device + recovery, and any rotation) ∪ each admission's deviceWrapHash.
  const authorizedMkWrapHashes = new Set<string>();
  for (const s of keyStates) for (const h of s.mkWrapHashes) authorizedMkWrapHashes.add(h);
  for (const sr of rosterChain) if (sr.admission?.deviceWrapHash) authorizedMkWrapHashes.add(sr.admission.deviceWrapHash);
  // D5: every roster entry binds its principal's MK-wrap hash, so bootstrap +
  // recovery + pairing wraps are all authorized uniformly (not only pairing's grant).
  for (const r of rosters) for (const d of r.devices) if (d.mkWrapHash) authorizedMkWrapHashes.add(d.mkWrapHash);

  const currentRosterIdx = rosterChain.length - 1;
  return {
    rosters,
    rosterHashByVersion,
    keyStateHashByEpoch,
    keyStates,
    currentRoster: rosters[currentRosterIdx]!,
    currentRosterHash: rosterChain[currentRosterIdx]!.rosterHash,
    currentEpoch: keyStates[keyStates.length - 1]!.accountEpoch,
    currentKeyEpoch: keyStates[keyStates.length - 1]!.keyEpoch,
    currentKeyStateHash: keyStateChain[keyStateChain.length - 1]!.stateHash,
    authorizedMkWrapHashes,
  };
}

/** Fail closed unless a fetched MK wrap's hash was signed into the account's
 *  roster/key-state (C7) — stops a server substituting a wrap. */
export async function assertMkWrapAuthorized(wrap: Wrap, account: VerifiedAccount): Promise<void> {
  const h = await wrapHash(wrap);
  if (!account.authorizedMkWrapHashes.has(h)) throw new Error("MK wrap not authorized by the signed roster/key-state (possible server substitution)");
}

/** Recovery is stricter than generic historical wrap authorization: the server
 * must return the exact wrap named by the latest verified key state. */
export async function assertCurrentRecoveryWrap(wrap: Wrap, account: VerifiedAccount): Promise<void> {
  const actual = await wrapHash(wrap);
  const expected = account.keyStates[account.keyStates.length - 1]?.recoveryWrapId;
  if (!expected || actual !== expected) {
    throw new Error("recovery wrap is not the current wrap authorized by the signed key state (possible server substitution)");
  }
  await assertMkWrapAuthorized(wrap, account);
}

/** Verify a commit's signature against the device active in ITS OWN roster version
 *  (authentic history — a link may predate a rotation). Throws on an unknown roster,
 *  an inactive/unknown signer, or a bad signature. Shared by chain + history-segment
 *  verification and historical decrypt; the head opener (`openCommit`) deliberately
 *  gates on the CURRENT roster/epoch instead, so it does NOT use this. */
async function assertSignedByOwnRoster(c: SignedCommit, body: CommitBody, account: VerifiedAccount): Promise<void> {
  const roster = account.rosters[body.rosterVersion];
  if (!roster) throw new Error(`commit seq ${body.seq} references unknown rosterVersion ${body.rosterVersion}`);
  const pub = activeSigners(roster).get(body.deviceId);
  if (!pub) throw new Error(`commit seq ${body.seq} signer ${body.deviceId} not active in roster v${body.rosterVersion}`);
  if (!(await verifyCommitSig(c, pub))) throw new Error(`commit seq ${body.seq} signature invalid`);
}

/**
 * Verify a commit chain descends from the pinned head (C1): hash-links forward
 * from `pin` (or genesis), each commit signed by a device active in ITS OWN
 * roster version (authentic history). Returns the head commit, or null if empty.
 * Does NOT apply the current-epoch/current-roster gate — that's `openCommit` on
 * the head (a historical link may predate a rotation).
 */
export async function verifyCommitChain(commits: SignedCommit[], pin: Pin | null, account: VerifiedAccount): Promise<SignedCommit | null> {
  if (commits.length === 0) return null;
  let prevHash = pin ? pin.commitHash : GENESIS_PARENT_HASH;
  let prevSeq = pin ? pin.commitSeq : 0;
  for (const c of commits) {
    const body = parseCommit(c);
    if (body.parentSeq !== prevSeq || body.parentCommitHash !== prevHash) throw new Error(`commit chain break at seq ${body.seq} (rollback/splice evident)`);
    await assertSignedByOwnRoster(c, body, account);
    prevHash = c.commitHash;
    prevSeq = body.seq;
  }
  return commits[commits.length - 1]!;
}

/**
 * Verify the HEAD commit is safe to apply, then decrypt its manifest. C4: reject
 * if EITHER the signer is not active in the CURRENT roster OR the commit's
 * accountEpoch != the current verified epoch (disjunctive — either is fatal).
 */
export async function openCommit(args: {
  secrets: DeviceSecrets;
  kek: Uint8Array;
  account: VerifiedAccount;
  commit: SignedCommit;
  encManifest: Uint8Array;
  workspaceId: string;
}): Promise<Uint8Array> {
  const body = parseCommit(args.commit);
  const signerPub = activeSigners(args.account.currentRoster).get(body.deviceId);
  if (!signerPub || body.accountEpoch !== args.account.currentEpoch) {
    throw new Error("commit rejected: signer not active in the current roster, or stale/unknown accountEpoch");
  }
  if (!(await verifyCommitSig(args.commit, signerPub))) throw new Error("commit signature invalid");
  // encManifest integrity: its hash must equal the signed encManifestSha.
  if ((await sha256Hex(args.encManifest)) !== body.encManifestSha) throw new Error("encManifest does not match the signed encManifestSha");
  return decryptManifest(args.kek, args.secrets.accountId, args.workspaceId, body.keyEpoch, args.encManifest);
}

/**
 * Authenticate a HISTORICAL commit segment (version history / restore, design 12
 * §15). Given the contiguous ascending segment `[fromSeq..head]` and the ALREADY-
 * TRUSTED head hash (the caller verified the head forward from its pin — C1/C2),
 * prove the whole segment is the true ancestry of that head: each commit links to
 * its predecessor, each `sig` verifies against the signer active in its OWN roster
 * version (a historical link may predate a rotation), and the LAST commit's hash
 * equals `trustedHeadHash`. The terminal-hash match is load-bearing — head is
 * trusted, its `parentCommitHash` commits to `head-1`, inductively down to
 * `fromSeq`. Returns the commit at `fromSeq`. Throws (fail closed) on any gap,
 * broken link, bad signature, unknown roster, or a non-terminating segment.
 *
 * This is the DOWNWARD sibling of `verifyCommitChain` (which anchors forward from a
 * pin); it needs no genesis reachability, so it survives retention pruning of old
 * `seq:<n>` pointers and long histories past `MAX_COMMIT_SPAN`.
 */
export async function verifyHistorySegment(
  commits: SignedCommit[],
  fromSeq: number,
  trustedHeadHash: string,
  account: VerifiedAccount
): Promise<SignedCommit> {
  if (commits.length === 0) throw new Error("empty history segment (server returned no commits for the range)");
  let expectSeq = fromSeq;
  let prevHash: string | null = null;
  let prevSeq = 0;
  for (const c of commits) {
    const body = parseCommit(c);
    if (body.seq !== expectSeq) throw new Error(`history segment gap at seq ${body.seq} (expected ${expectSeq})`);
    if (prevHash !== null && (body.parentSeq !== prevSeq || body.parentCommitHash !== prevHash)) {
      throw new Error(`history segment chain break at seq ${body.seq} (rollback/splice evident)`);
    }
    await assertSignedByOwnRoster(c, body, account);
    prevHash = c.commitHash;
    prevSeq = body.seq;
    expectSeq++;
  }
  if (commits[commits.length - 1]!.commitHash !== trustedHeadHash) {
    throw new Error("history segment does not terminate at the verified head (tamper/fork evident)");
  }
  return commits[0]!;
}

/**
 * Decrypt a HISTORICAL commit's manifest (design 12 §15). Unlike `openCommit` (the
 * head opener, which applies the C4 current-epoch/current-roster gate), this opens a
 * commit whose authenticity was ALREADY proven by `verifyHistorySegment` (terminal-
 * hash anchor + own-roster signature). It therefore drops the current-epoch gate — a
 * legitimately-old commit may be signed by a since-revoked device and carry an older
 * `accountEpoch`/`keyEpoch`. Still verifies: the sig against the signer active in the
 * commit's OWN roster version, `sha256(encManifest) == encManifestSha`, and decrypts
 * strictly under `body.keyEpoch` (the caller supplies that epoch's KEK; a missing
 * epoch KEK is a fail-closed error upstream, never a guess).
 */
export async function openCommitHistorical(args: {
  secrets: DeviceSecrets;
  kek: Uint8Array;
  account: VerifiedAccount;
  commit: SignedCommit;
  encManifest: Uint8Array;
  workspaceId: string;
}): Promise<Uint8Array> {
  const body = parseCommit(args.commit);
  await assertSignedByOwnRoster(args.commit, body, args.account);
  if ((await sha256Hex(args.encManifest)) !== body.encManifestSha) throw new Error("encManifest does not match the signed encManifestSha");
  return decryptManifest(args.kek, args.secrets.accountId, args.workspaceId, body.keyEpoch, args.encManifest);
}

/**
 * Address-authenticate and AEAD-open one bounded manifest-chain link. The
 * caller supplies the target commit's signed key epoch for every link; a link
 * crossing an epoch boundary therefore fails authentication.
 */
export async function openManifestChainBlob(args: {
  kek: Uint8Array;
  accountId: string;
  workspaceId: string;
  keyEpoch: number;
  expectedEncSha: string;
  bytes: Uint8Array;
}): Promise<Uint8Array> {
  if ((await sha256Hex(args.bytes)) !== args.expectedEncSha) throw new Error("manifest chain blob does not match its expected address");
  return decryptManifest(args.kek, args.accountId, args.workspaceId, args.keyEpoch, args.bytes);
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
  /** Reuse a pre-generated device keypair across 409 retries (crash-safe, D3). */
  deviceKeys?: { sig: SignKeyPair; enc: WrapKeyPair };
}): Promise<RedeemResult> {
  if (args.material.mkWrap.kind !== "aesgcm-wrap") throw new Error("pairing MK wrap must be aesgcm-wrap");
  const wrapKey = await hkdf(args.tokenSecret, PAIR_MK_WRAP_SALT, utf8("mk-wrap"), 32);
  const mk = await aesGcmUnwrap(wrapKey, args.material.mkWrap, pairingWrapCtx(args.accountId, args.accountEpoch));

  const sig = args.deviceKeys?.sig ?? generateSignKeyPair();
  const enc = args.deviceKeys?.enc ?? generateWrapKeyPair();
  const selfWrap = await rsaDeviceWrap(enc.publicKeySpki, mk, deviceWrapCtx(args.accountId, args.accountEpoch));
  const selfWrapHash = await wrapHash(selfWrap);

  const prevBody = parseStrict(args.prevRoster.body) as RosterBody;
  const newEntry = rosterEntry(args.deviceId, "device", sig.publicKey, enc.publicKeySpki, args.now, selfWrapHash);
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
    deviceWrapHash: selfWrapHash,
  });

  return {
    secrets: deviceSecretsFrom(args.accountId, args.deviceId, mk, sig, enc),
    device: deviceUploadFrom(args.deviceId, sig, enc, selfWrap),
    admissionRoster,
  };
}

/** Recover MK on a fresh device from the recovery phrase + the stored recovery
 *  wrap. Caller then builds a recovery-signed admission roster. */
export async function recoverMasterKey(accountId: string, accountEpoch: number, recoveryKey: Uint8Array, recoveryWrap: Wrap): Promise<Uint8Array> {
  if (recoveryWrap.kind !== "aesgcm-wrap") throw new Error("recovery wrap must be aesgcm-wrap");
  return aesGcmUnwrap(await rkWrapKey(recoveryKey), recoveryWrap, recoveryWrapCtx(accountId, accountEpoch));
}

/**
 * Recover on a fresh device after device loss (design 12 §14.7 / D5): recover MK
 * via RK, generate this device's keypairs + MK self-wrap, and build an admission
 * roster signed by the RECOVERY principal (RSK, already `active` in the prev
 * roster) admitting this device — its `mkWrapHash` is bound in the signed entry so
 * C7 authorizes the recovered wrap. Returns the same shape as `redeemPairing`.
 */
export async function buildRecoveryAdmission(args: {
  accountId: string;
  accountEpoch: number;
  deviceId: string;
  recoveryKey: Uint8Array;
  recoveryWrap: Wrap;
  prevRoster: SignedRoster; // current head roster (caller verified it)
  now: number;
  /** Reuse a pre-generated device keypair across 409 retries (crash-safe, D3). */
  deviceKeys?: { sig: SignKeyPair; enc: WrapKeyPair };
}): Promise<RedeemResult> {
  const mk = await recoverMasterKey(args.accountId, args.accountEpoch, args.recoveryKey, args.recoveryWrap);
  const rsk = await recoverySignKeyPair(args.recoveryKey);
  const sig = args.deviceKeys?.sig ?? generateSignKeyPair();
  const enc = args.deviceKeys?.enc ?? generateWrapKeyPair();
  const selfWrap = await rsaDeviceWrap(enc.publicKeySpki, mk, deviceWrapCtx(args.accountId, args.accountEpoch));
  const selfWrapHash = await wrapHash(selfWrap);

  const prevBody = parseStrict(args.prevRoster.body) as RosterBody;
  const newEntry = rosterEntry(args.deviceId, "device", sig.publicKey, enc.publicKeySpki, args.now, selfWrapHash);
  const admissionRoster = await buildAdminRoster(prevBody, [...prevBody.devices, newEntry], "recovery", rsk);

  return {
    secrets: deviceSecretsFrom(args.accountId, args.deviceId, mk, sig, enc),
    device: deviceUploadFrom(args.deviceId, sig, enc, selfWrap),
    admissionRoster,
  };
}

/** Open this device's own MK wrap (RSA) — used on a device that's already in the
 *  roster but reloading MK from the server (e.g. fresh keystore on same device). */
export async function openOwnMasterKey(secrets: Omit<DeviceSecrets, "mk">, accountEpoch: number, mkWrap: Wrap): Promise<Uint8Array> {
  if (mkWrap.kind !== "rsa-oaep-wrap") throw new Error("device MK wrap must be rsa-oaep-wrap");
  return rsaDeviceUnwrap(wrapPrivateFromPkcs8(secrets.encPrivPkcs8), mkWrap, deviceWrapCtx(secrets.accountId, accountEpoch));
}
