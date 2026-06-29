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

export interface CommitBody {
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
  blobRefs: BlobRef[];
}

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

export interface CommitFields {
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
  blobRefs: BlobRef[];
}

/** Build + sign a commit. Enforces `seq === parentSeq + 1` (V4-4). */
export async function buildSignedCommit(fields: CommitFields, signKey: SignKeyPair): Promise<SignedCommit> {
  if (fields.seq !== fields.parentSeq + 1) throw new Error(`commit seq must be parentSeq+1 (seq=${fields.seq}, parentSeq=${fields.parentSeq})`);
  if (!SHA_RE.test(fields.encManifestSha)) throw new Error("encManifestSha malformed");
  const body: CommitBody = {
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
    blobRefs: normalizeBlobRefs(fields.blobRefs),
  };
  const bodyStr = canonicalString(body);
  const commitHash = await sha256Hex(utf8(bodyStr));
  const sig = toB64url(sign(signKey.privateKey, fromHex(commitHash)));
  return { body: bodyStr, commitHash, sig };
}

/** Parse + structurally validate a stored commit (does NOT check the signature —
 *  see verifyCommitSig, which needs the signer's pubkey from the roster). */
export function parseCommit(c: SignedCommit): CommitBody {
  const body = verifyRoundTrip(c.body) as CommitBody; // parse + assert canonical form
  if (body.type !== "rbox/commit/v1") throw new Error("not a commit/v1");
  if (body.seq !== body.parentSeq + 1) throw new Error("commit seq must be parentSeq+1");
  normalizeBlobRefs(body.blobRefs); // throws on dup/malformed; also asserts present
  if (!SHA_RE.test(body.encManifestSha)) throw new Error("encManifestSha malformed");
  return body;
}

/** Verify the hash binds the body and the signature binds the hash under
 *  `signerPubKey` (the device's roster sigPubKey). */
export async function verifyCommitSig(c: SignedCommit, signerPubKey: Uint8Array): Promise<boolean> {
  if (!SHA_RE.test(c.commitHash)) return false;
  const recomputed = await sha256Hex(utf8(c.body));
  if (recomputed !== c.commitHash) return false;
  return verify(signerPubKey, fromHex(c.commitHash), fromB64url(c.sig));
}
