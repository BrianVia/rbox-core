/**
 * Device roster (design 12, V4-1 / V4-3 / V4-8 / R1′). A signed, versioned,
 * hash-chained list of the account's devices and their public keys. It is the
 * trust root for commit-signature verification: a commit is valid only if its
 * signer is an `active` device in the roster version the commit names.
 *
 * Every roster version after genesis is justified by exactly one of:
 *   (a) ADMIN signature  — an already-active admin device signed the change.
 *   (b) ADMISSION grant  — a paired device admits ITSELF using a single-use grant
 *       pre-signed by an active admin + an admissionSig from the token-derived key
 *       (so the server, which never sees tokenSecret, cannot substitute keys).
 *   (c) RECOVERY signature — a recovery principal (RSK, bound at genesis/rotation)
 *       admits a fresh device after total device loss.
 *
 * v1 pins algorithms (Ed25519 + RSA-OAEP-3072-SHA256) and treats every active
 * device as a full admin (V4-3). Genesis trust roots in MK via accountKeyState
 * (epoch.ts), which binds rosterHash; here we verify the chain's internal
 * consistency and signatures.
 */
import { sign, verify, type SignKeyPair } from "./asym.js";
import { canonicalString, parseStrict, verifyRoundTrip } from "./jcs.js";
import { fromB64url, fromHex, sha256, sha256Hex, toB64url, utf8 } from "./primitives.js";

export const SIG_ALG = "Ed25519";
export const ENC_ALG = "RSA-OAEP-3072-SHA256";
const GENESIS_PREV_HASH = "0".repeat(64);

export interface RosterEntry {
  deviceId: string;
  sigAlg: typeof SIG_ALG;
  encAlg: typeof ENC_ALG;
  sigPubKey: string; // b64url raw 32-byte Ed25519
  encPubKey: string; // b64url SPKI DER RSA-3072
  role: "admin";
  kind: "device" | "recovery";
  addedAt: number;
  status: "active" | "revoked";
  /** SHA-256 (hex) of this principal's MK wrap, bound into the signed roster so a
   *  fetched MK wrap is authorized uniformly for bootstrap/pairing/recovery (C7 /
   *  design 12 D5). Optional only for back-compat with pre-D5 fixtures. */
  mkWrapHash?: string;
}

export interface RosterBody {
  type: "rbox/roster/v1";
  version: number;
  accountId: string;
  accountEpoch: number;
  prevRosterHash: string;
  devices: RosterEntry[]; // sorted by deviceId
  grantId?: string; // set iff this version was created via an admission grant (single-use)
}

export interface AdmissionGrant {
  type: "rbox/admission-grant/v1";
  accountId: string;
  accountEpoch: number;
  tokenId: string;
  grantId: string;
  admissionPubKey: string; // b64url raw Ed25519, derived from tokenSecret
  notAfter: number;
}

export interface AdmissionProof {
  grant: string; // canonical JSON of AdmissionGrant
  grantSignerDeviceId: string; // which active admin signed the grant
  grantSig: string; // b64url Ed25519 over sha256(grant)
  admissionSig: string; // b64url over sha256(JCS(admission delta)) by admissionPubKey
  deviceWrapHash: string; // sha256 of B's MK-to-self wrap (bound in the delta)
}

export interface SignedRoster {
  body: string; // canonical JSON of RosterBody
  rosterHash: string; // hex
  signerDeviceId: string;
  rosterSig: string; // b64url over rosterHash by signer's sigPubKey
  admission?: AdmissionProof;
}

// ---- construction ---------------------------------------------------------

function sortDevices(devices: RosterEntry[]): RosterEntry[] {
  return [...devices].sort((a, b) => (a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0));
}

function assertEntryShape(e: RosterEntry): void {
  if (e.sigAlg !== SIG_ALG || e.encAlg !== ENC_ALG) throw new Error(`roster: unsupported algorithms for ${e.deviceId}`);
  if (e.role !== "admin") throw new Error(`roster: only role "admin" is supported in v1`);
  if (fromB64url(e.sigPubKey).length !== 32) throw new Error(`roster: sigPubKey must be 32 bytes for ${e.deviceId}`);
}

async function hashRoster(body: RosterBody): Promise<string> {
  return sha256Hex(utf8(canonicalString(body)));
}

async function signRosterBody(body: RosterBody, signerDeviceId: string, signKey: SignKeyPair, admission?: AdmissionProof): Promise<SignedRoster> {
  body.devices.forEach(assertEntryShape);
  const bodyStr = canonicalString(body);
  const rosterHash = await sha256Hex(utf8(bodyStr));
  const rosterSig = toB64url(sign(signKey.privateKey, fromHex(rosterHash)));
  return { body: bodyStr, rosterHash, signerDeviceId, rosterSig, admission };
}

/** Genesis roster (v0), self-signed by the bootstrap device. Includes the
 *  bootstrap device and the recovery (RSK) principal. */
export function buildGenesisRoster(args: {
  accountId: string;
  bootstrap: RosterEntry;
  recovery: RosterEntry;
  bootstrapSignKey: SignKeyPair;
}): Promise<SignedRoster> {
  const body: RosterBody = {
    type: "rbox/roster/v1",
    version: 0,
    accountId: args.accountId,
    accountEpoch: 0,
    prevRosterHash: GENESIS_PREV_HASH,
    devices: sortDevices([args.bootstrap, args.recovery]),
  };
  return signRosterBody(body, args.bootstrap.deviceId, args.bootstrapSignKey);
}

/** An admin-signed next version (revoke a device, or an online admin admits one). */
export async function buildAdminRoster(prev: RosterBody, devices: RosterEntry[], signerDeviceId: string, signKey: SignKeyPair): Promise<SignedRoster> {
  const body: RosterBody = {
    type: "rbox/roster/v1",
    version: prev.version + 1,
    accountId: prev.accountId,
    accountEpoch: prev.accountEpoch,
    prevRosterHash: await hashRoster(prev),
    devices: sortDevices(devices),
  };
  return signRosterBody(body, signerDeviceId, signKey);
}

/** The canonical admission delta B signs with the token-derived admission key. */
export function admissionDelta(args: {
  accountId: string;
  accountEpoch: number;
  grantId: string;
  parentRosterVersion: number;
  parentRosterHash: string;
  addedDeviceEntry: RosterEntry;
  deviceWrapHash: string;
}): string {
  return canonicalString({
    type: "rbox/admission/v1",
    accountId: args.accountId,
    accountEpoch: args.accountEpoch,
    grantId: args.grantId,
    parentRosterVersion: args.parentRosterVersion,
    parentRosterHash: args.parentRosterHash,
    addedDeviceEntry: args.addedDeviceEntry,
    deviceWrapHash: args.deviceWrapHash,
  });
}

/** A paired device B builds vN+1 admitting itself, justified by A's grant. */
export async function buildAdmissionRoster(args: {
  prev: RosterBody;
  newDevice: RosterEntry;
  newDeviceSignKey: SignKeyPair; // B's own key (PoP via rosterSig)
  grant: AdmissionGrant;
  grantSignerDeviceId: string;
  grantSig: string;
  admissionSignKey: SignKeyPair; // derived from tokenSecret
  deviceWrapHash: string;
}): Promise<SignedRoster> {
  const prevHash = await hashRoster(args.prev);
  const body: RosterBody = {
    type: "rbox/roster/v1",
    version: args.prev.version + 1,
    accountId: args.prev.accountId,
    accountEpoch: args.prev.accountEpoch,
    prevRosterHash: prevHash,
    devices: sortDevices([...args.prev.devices, args.newDevice]),
    grantId: args.grant.grantId,
  };
  const delta = admissionDelta({
    accountId: args.prev.accountId,
    accountEpoch: args.prev.accountEpoch,
    grantId: args.grant.grantId,
    parentRosterVersion: args.prev.version,
    parentRosterHash: prevHash,
    addedDeviceEntry: args.newDevice,
    deviceWrapHash: args.deviceWrapHash,
  });
  const admissionSig = toB64url(sign(args.admissionSignKey.privateKey, await sha256(utf8(delta))));
  return signRosterBody(body, args.newDevice.deviceId, args.newDeviceSignKey, {
    grant: canonicalString(args.grant),
    grantSignerDeviceId: args.grantSignerDeviceId,
    grantSig: args.grantSig,
    admissionSig,
    deviceWrapHash: args.deviceWrapHash,
  });
}

// ---- verification ---------------------------------------------------------

/**
 * Verify a roster chain from genesis. Returns the verified bodies (index = version)
 * or throws on the first inconsistency. Does NOT establish genesis trust — the
 * caller binds roster v0's hash to a MK-authenticated accountKeyState (epoch.ts).
 *
 * No clock parameter: §31 removed the admission-grant `notAfter` check (replaying immutable
 * history against the verifier's current clock is unsound and bricked multi-device accounts).
 * Freshness is gated where a trusted clock exists — the pairing-token TTL at redeem (auth.ts) —
 * and grant reuse is prevented by the single-use grantId below.
 */
export async function verifyRosterChain(chain: SignedRoster[]): Promise<RosterBody[]> {
  if (chain.length === 0) throw new Error("empty roster chain");
  const bodies: RosterBody[] = [];
  const seenGrantIds = new Set<string>();

  for (let i = 0; i < chain.length; i++) {
    const sr = chain[i]!;
    const body = parseRoster(sr);
    if (body.version !== i) throw new Error(`roster version gap: expected ${i}, got ${body.version}`);
    if ((await sha256Hex(utf8(sr.body))) !== sr.rosterHash) throw new Error(`roster ${i}: hash mismatch`);

    if (i === 0) {
      if (body.prevRosterHash !== GENESIS_PREV_HASH) throw new Error("genesis roster must have zero prevRosterHash");
      // Genesis is self-signed: signer must be an active admin IN v0.
      await requireSignerInRoster(sr, body);
    } else {
      const prev = bodies[i - 1]!;
      if (body.prevRosterHash !== chain[i - 1]!.rosterHash) throw new Error(`roster ${i}: broken prev-hash link`);
      if (body.accountId !== prev.accountId) throw new Error(`roster ${i}: accountId changed`);
      if (body.accountEpoch < prev.accountEpoch) throw new Error(`roster ${i}: accountEpoch went backwards`);
      await verifyTransition(prev, sr, body, seenGrantIds);
    }
    if (body.grantId) seenGrantIds.add(body.grantId);
    bodies.push(body);
  }
  return bodies;
}

/** Active device sig pubkeys at a roster version, for commit verification. */
export function activeSigners(body: RosterBody): Map<string, Uint8Array> {
  const m = new Map<string, Uint8Array>();
  for (const d of body.devices) if (d.status === "active") m.set(d.deviceId, fromB64url(d.sigPubKey));
  return m;
}

function parseRoster(sr: SignedRoster): RosterBody {
  const body = verifyRoundTrip(sr.body) as RosterBody; // parse + assert canonical form
  if (body.type !== "rbox/roster/v1") throw new Error("not a roster/v1");
  body.devices.forEach(assertEntryShape);
  // device ids unique + sorted
  const ids = body.devices.map((d) => d.deviceId);
  if (new Set(ids).size !== ids.length) throw new Error("roster: duplicate deviceId");
  if (canonicalString(ids) !== canonicalString([...ids].sort())) throw new Error("roster: devices not sorted by deviceId");
  return body;
}

async function requireSignerInRoster(sr: SignedRoster, body: RosterBody): Promise<void> {
  const signer = body.devices.find((d) => d.deviceId === sr.signerDeviceId && d.status === "active");
  if (!signer) throw new Error(`roster signer ${sr.signerDeviceId} not an active device in the roster`);
  if (!verify(fromB64url(signer.sigPubKey), fromHex(sr.rosterHash), fromB64url(sr.rosterSig))) {
    throw new Error(`roster signature invalid for signer ${sr.signerDeviceId}`);
  }
}

async function verifyTransition(prev: RosterBody, sr: SignedRoster, body: RosterBody, seenGrantIds: Set<string>): Promise<void> {
  const prevSigner = prev.devices.find((d) => d.deviceId === sr.signerDeviceId && d.status === "active");

  if (prevSigner) {
    // (a) admin-signed or (c) recovery-signed: signer was active in prev. Both are
    // admins in v1; the only distinction (kind) doesn't change authority.
    if (!verify(fromB64url(prevSigner.sigPubKey), fromHex(sr.rosterHash), fromB64url(sr.rosterSig))) {
      throw new Error(`roster ${body.version}: admin signature invalid`);
    }
    return;
  }

  // (b) admission grant: the signer is a brand-new device admitting itself.
  const adm = sr.admission;
  if (!adm) throw new Error(`roster ${body.version}: signer not active in prev and no admission proof`);
  await verifyAdmission(prev, sr, body, adm, seenGrantIds);
}

async function verifyAdmission(prev: RosterBody, sr: SignedRoster, body: RosterBody, adm: AdmissionProof, seenGrantIds: Set<string>): Promise<void> {
  const grant = parseStrict(adm.grant) as AdmissionGrant;
  if (grant.type !== "rbox/admission-grant/v1") throw new Error("bad admission grant type");
  if (canonicalString(grant) !== adm.grant) throw new Error("admission grant not canonical");
  if (grant.accountId !== prev.accountId || grant.accountEpoch !== prev.accountEpoch) throw new Error("admission grant account/epoch mismatch");
  // §31: NO `grant.notAfter` vs current-clock check here. This replays IMMUTABLE history; a roster
  // version has no trustworthy append timestamp, so comparing a grant's liveness bound to the
  // verifier's *current* clock is unsound — it bricks every multi-device account ~notAfter after
  // pairing (P0). Freshness is gated where a trusted clock exists: the pairing-token TTL at
  // redeem (MK delivery, auth.ts), and reuse is prevented by the single-use grantId below.
  if (seenGrantIds.has(grant.grantId) || body.grantId !== grant.grantId) throw new Error("admission grant replay / grantId mismatch");

  // grantSig: an active admin in prev authorized this admission.
  const grantSigner = prev.devices.find((d) => d.deviceId === adm.grantSignerDeviceId && d.status === "active");
  if (!grantSigner) throw new Error("admission grant signer not active in prev roster");
  if (!verify(fromB64url(grantSigner.sigPubKey), await sha256(utf8(adm.grant)), fromB64url(adm.grantSig))) throw new Error("admission grantSig invalid");

  // Delta must add EXACTLY one device (the signer); nothing else changed.
  const added = diffExactlyOneAdded(prev, body);
  if (added.deviceId !== sr.signerDeviceId) throw new Error("admission: added device is not the roster signer");

  // admissionSig over the exact delta, by the token-derived admissionPubKey.
  const delta = admissionDelta({
    accountId: prev.accountId,
    accountEpoch: prev.accountEpoch,
    grantId: grant.grantId,
    parentRosterVersion: prev.version,
    parentRosterHash: body.prevRosterHash, // already verified === chain[i-1].rosterHash
    addedDeviceEntry: added,
    deviceWrapHash: adm.deviceWrapHash,
  });
  if (!verify(fromB64url(grant.admissionPubKey), await sha256(utf8(delta)), fromB64url(adm.admissionSig))) throw new Error("admissionSig invalid (token possession not proven)");

  // PoP: the new device signed the roster with its own sigPubKey.
  if (!verify(fromB64url(added.sigPubKey), fromHex(sr.rosterHash), fromB64url(sr.rosterSig))) throw new Error("admission: new-device PoP signature invalid");
}

/** Assert the only difference prev→next is exactly one added device entry. */
function diffExactlyOneAdded(prev: RosterBody, next: RosterBody): RosterEntry {
  const prevById = new Map(prev.devices.map((d) => [d.deviceId, canonicalString(d)]));
  const added: RosterEntry[] = [];
  for (const d of next.devices) {
    const before = prevById.get(d.deviceId);
    if (before === undefined) added.push(d);
    else if (before !== canonicalString(d)) throw new Error(`admission: existing device ${d.deviceId} was mutated`);
    prevById.delete(d.deviceId);
  }
  if (prevById.size > 0) throw new Error("admission: a device was removed (not allowed in an admission delta)");
  if (added.length !== 1) throw new Error(`admission: expected exactly one added device, got ${added.length}`);
  return added[0]!;
}
