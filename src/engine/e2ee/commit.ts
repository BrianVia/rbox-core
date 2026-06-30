/**
 * Authenticated commit chain (design 12, V4-4 / R1). A commit is a signed,
 * hash-chained object the server stores opaquely and the client verifies from
 * genesis. The chain makes rollback/splice/relabel EVIDENT to any client with a
 * pinned head; the signature makes forgery impossible (server has no signing key
 * that a roster-checking client will accept).
 *
 * `commitHash = SHA256(JCS(commitBody))`, `sig = Ed25519(deviceSigKey, commitHash)`.
 * `seq` is inside the body, so the sequence number itself is signed.
 */
import { sign, verify, type SignKeyPair } from "./asym.js";
import { canonicalString, verifyRoundTrip } from "./jcs.js";
import { fromB64url, fromHex, sha256Hex, toB64url, utf8 } from "./primitives.js";

export const GENESIS_PARENT_HASH = "0".repeat(64);

export interface BlobRef {
  encSha: string;
  size: number;
}

/** §24 — the sidecar descriptor that replaces inline `blobRefs` in the signed body for
 *  large repos. `sidecarSha` content-addresses the canonical `rbox-refset-v1` bytes (the
 *  full unique sorted ref set); `count`/`totalBytes` are ADVISORY (cheap reject + a
 *  post-fetch descriptor match) — never billed. The signature commits to `sidecarSha`, so
 *  the ref set can't be swapped. */
export interface BlobRefset {
  sidecarSha: string;
  count: number;
  totalBytes: number;
}

interface CommitBodyBase {
  type: "rbox/commit/v1";
  accountId: string;
  accountEpoch: number;
  workspaceId: string;
  seq: number;
  parentSeq: number;
  parentCommitHash: string;
  rosterVersion: number;
  keyEpoch: number;
  deviceId: string;
  encManifestSha: string;
}

/** §24 dual-mode: a commit carries EITHER inline `blobRefs` (legacy / small repos) XOR a
 *  `blobRefset` sidecar descriptor (large repos). Exactly one is present — `parseCommit`
 *  rejects both/neither. Old commits stay inline forever (the chain is immutable). */
export interface CommitBodyInline extends CommitBodyBase {
  blobRefs: BlobRef[];
}
export interface CommitBodySidecar extends CommitBodyBase {
  blobRefset: BlobRefset;
}
export type CommitBody = CommitBodyInline | CommitBodySidecar;

/** A commit as stored/transmitted: the canonical body string, its hash, and sig. */
export interface SignedCommit {
  body: string; // canonical JSON of CommitBody
  commitHash: string; // hex
  sig: string; // b64url, 64-byte Ed25519
}

const SHA_RE = /^[0-9a-f]{64}$/;

/** Normalize blobRefs to the V4-7 invariant: unique by encSha, sorted by encSha.
 *  Throws on a duplicate encSha (ambiguous) or a malformed encSha. */
export function normalizeBlobRefs(refs: BlobRef[]): BlobRef[] {
  const byEnc = new Map<string, BlobRef>();
  for (const r of refs) {
    if (!SHA_RE.test(r.encSha)) throw new Error(`blobRef encSha malformed: ${r.encSha}`);
    if (!Number.isSafeInteger(r.size) || r.size < 0) throw new Error(`blobRef size invalid: ${r.size}`);
    if (byEnc.has(r.encSha)) throw new Error(`duplicate blobRef encSha: ${r.encSha}`);
    byEnc.set(r.encSha, { encSha: r.encSha, size: r.size });
  }
  return [...byEnc.values()].sort((a, b) => (a.encSha < b.encSha ? -1 : a.encSha > b.encSha ? 1 : 0));
}

/** Structurally validate a sidecar descriptor (NOT the sidecar bytes — the server fetches
 *  + hashes those). `count`/`totalBytes` are bounded non-negative safe integers. */
export function validateBlobRefset(rs: unknown): BlobRefset {
  if (!rs || typeof rs !== "object") throw new Error("blobRefset not an object");
  const r = rs as Record<string, unknown>;
  if (typeof r.sidecarSha !== "string" || !SHA_RE.test(r.sidecarSha)) throw new Error("blobRefset.sidecarSha malformed");
  if (!Number.isSafeInteger(r.count) || (r.count as number) < 0) throw new Error("blobRefset.count invalid");
  if (!Number.isSafeInteger(r.totalBytes) || (r.totalBytes as number) < 0) throw new Error("blobRefset.totalBytes invalid");
  return { sidecarSha: r.sidecarSha, count: r.count as number, totalBytes: r.totalBytes as number };
}

interface CommitFieldsBase {
  accountId: string;
  accountEpoch: number;
  workspaceId: string;
  seq: number;
  parentSeq: number;
  parentCommitHash: string;
  rosterVersion: number;
  keyEpoch: number;
  deviceId: string;
  encManifestSha: string;
}
/** §24: the caller supplies EITHER inline refs OR a sidecar descriptor (it already
 *  uploaded the sidecar blob + has its sha). Exactly one — never both. */
export type CommitFields = (CommitFieldsBase & { blobRefs: BlobRef[]; blobRefset?: undefined }) | (CommitFieldsBase & { blobRefset: BlobRefset; blobRefs?: undefined });

/** Build + sign a commit. Enforces `seq === parentSeq + 1` (V4-4). Emits a sidecar body
 *  iff `blobRefset` is supplied, else an inline `blobRefs` body. */
export async function buildSignedCommit(fields: CommitFields, signKey: SignKeyPair): Promise<SignedCommit> {
  if (fields.seq !== fields.parentSeq + 1) throw new Error(`commit seq must be parentSeq+1 (seq=${fields.seq}, parentSeq=${fields.parentSeq})`);
  if (!SHA_RE.test(fields.encManifestSha)) throw new Error("encManifestSha malformed");
  const base: CommitBodyBase = {
    type: "rbox/commit/v1",
    accountId: fields.accountId,
    accountEpoch: fields.accountEpoch,
    workspaceId: fields.workspaceId,
    seq: fields.seq,
    parentSeq: fields.parentSeq,
    parentCommitHash: fields.parentCommitHash,
    rosterVersion: fields.rosterVersion,
    keyEpoch: fields.keyEpoch,
    deviceId: fields.deviceId,
    encManifestSha: fields.encManifestSha,
  };
  // EXACTLY ONE ref carrier — canonical JSON includes only the present field, so the
  // signature floats over the right ref set with no implied/default the other mode.
  const body: CommitBody = fields.blobRefset !== undefined ? { ...base, blobRefset: validateBlobRefset(fields.blobRefset) } : { ...base, blobRefs: normalizeBlobRefs(fields.blobRefs) };
  const bodyStr = canonicalString(body);
  const commitHash = await sha256Hex(utf8(bodyStr));
  const sig = toB64url(sign(signKey.privateKey, fromHex(commitHash)));
  return { body: bodyStr, commitHash, sig };
}

/** Parse + structurally validate a stored commit (does NOT check the signature — see
 *  verifyCommitSig). DUAL-MODE (§24): exactly one of `blobRefs` (array) / `blobRefset`
 *  (object) must be an own property; both/neither/wrong-type → throw. `verifyRoundTrip`
 *  already rejects non-canonical bytes (incl. duplicate JSON keys), so the discriminator
 *  runs on a trustworthy object. */
export function parseCommit(c: SignedCommit): CommitBody {
  const body = verifyRoundTrip(c.body) as Record<string, unknown>; // parse + assert canonical form
  if (body.type !== "rbox/commit/v1") throw new Error("not a commit/v1");
  if (body.seq !== (body.parentSeq as number) + 1) throw new Error("commit seq must be parentSeq+1");
  if (!SHA_RE.test(body.encManifestSha as string)) throw new Error("encManifestSha malformed");
  const hasInline = Array.isArray(body.blobRefs);
  const hasSidecar = body.blobRefset !== undefined && typeof body.blobRefset === "object" && body.blobRefset !== null && !Array.isArray(body.blobRefset);
  if (hasInline === hasSidecar) throw new Error("commit must carry exactly one of blobRefs / blobRefset");
  if (hasInline) {
    if (body.blobRefset !== undefined) throw new Error("inline commit must not carry blobRefset");
    normalizeBlobRefs(body.blobRefs as BlobRef[]); // throws on dup/malformed
  } else {
    if (body.blobRefs !== undefined) throw new Error("sidecar commit must not carry blobRefs");
    validateBlobRefset(body.blobRefset);
  }
  return body as unknown as CommitBody;
}

/** Verify the hash binds the body and the signature binds the hash under
 *  `signerPubKey` (the device's roster sigPubKey). */
export async function verifyCommitSig(c: SignedCommit, signerPubKey: Uint8Array): Promise<boolean> {
  if (!SHA_RE.test(c.commitHash)) return false;
  const recomputed = await sha256Hex(utf8(c.body));
  if (recomputed !== c.commitHash) return false;
  return verify(signerPubKey, fromHex(c.commitHash), fromB64url(c.sig));
}
