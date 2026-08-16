/**
 * The no-op save proof (design 267 §3). One owner for the question "would this
 * section change durable state?", so packet composition never infers elision
 * from packet shape and no backend ever decides it.
 *
 * The proof travels as an ElisionReceipt: a pull constructs one only when it
 * holds every input first-hand. No receipt means the full packet, which is the
 * standing backstop for every caller that is not a pull.
 */
import { isDeepStrictEqual } from "node:util";
import { canonicalManifestHashStreaming } from "../engine/index.js";
import {
  manifestFromMeta, validManifestMeta, type GlobalManifestMeta, type RepoRecordInput, type StateSavePacket, type SyncState,
} from "./sync-state-model.js";
import {
  expectedStateNonce,
} from "./sync-state-records.js";

/** Pull-owned evidence, gathered before the state lock is taken. */
export interface ElisionReceipt {
  /** The UNFILTERED reconcile action list was empty. `actions` is not that list:
   * it drops ignored paths, and an ignored-path change still moves the base. */
  noActions: boolean;
  /** The stored base is the remote manifest itself, never a scoped projection. */
  storedBaseIsRemote: boolean;
  /** The meta this pull would persist. Absent under a changed straddling
   * projection, which is what makes scoped straddling fail closed. */
  manifestMeta?: GlobalManifestMeta | undefined;
  /** Snapshot binding: the loaded state's minted nonce and its revision. */
  nonce: string;
  stateRevision: number;
}

/** Kill switch, default ON; deletion condition is one clean fleet soak. */
export const noopElisionEnabled = (): boolean => process.env.RBOX_SAVE_NOOP_ELIDE !== "0";

/**
 * Mint a receipt from evidence plus a snapshot's identity. A minted (non-legacy)
 * nonce and a defined revision are required: a first save and a legacy nonce-less
 * JSON state have no identity to bind to, and no normalized sentinel is admitted
 * as elision evidence.
 */
export function elisionReceipt(
  snapshot: SyncState,
  evidence: Omit<ElisionReceipt, "nonce" | "stateRevision">,
): ElisionReceipt | undefined {
  const nonce = snapshot.stateNonce;
  if (!noopElisionEnabled()) return undefined;
  if (nonce === undefined || !/^[0-9a-f]{32}$/.test(nonce)) return undefined;
  if (snapshot.stateRevision === undefined) return undefined;
  return { ...evidence, nonce, stateRevision: snapshot.stateRevision };
}

/**
 * A receipt proves something about ONE snapshot, so it is evidence only while
 * the composer is still standing on that snapshot. Every CAS retry recomposes
 * against a fresh reload, and a reload that moved the revision — for ANY
 * rejection reason, not just drift — leaves the receipt unbound and therefore
 * spent. This is what makes "single-attempt" a structural property rather than
 * a discipline the rejection handler has to remember (§3.2b).
 */
export function receiptBoundTo(
  snapshot: SyncState,
  receipt: ElisionReceipt | undefined,
): ElisionReceipt | undefined {
  if (receipt === undefined) return undefined;
  const bound = receipt.nonce === expectedStateNonce(snapshot)
    && receipt.stateRevision === snapshot.stateRevision;
  return bound ? receipt : undefined;
}

/** Nothing but lineage identity remains, so the caller's loaded state plus the
 * accepted CAS token IS the durable state (§4). Both the caller that offers a
 * projection and the adapter that would honour one ask this same question. */
export const fullyElidedPacket = (packet: StateSavePacket): boolean =>
  packet.elisionExpectation !== undefined && packet.global === undefined && packet.repos.length === 0;

/**
 * §3.2, all four conditions required. The content self-check hashes the meta
 * reconstruction rather than the persisted manifest: the persisted `gitRepos` is
 * the LOCAL apply projection and legitimately differs from meta-wire truth, so
 * hashing it raw would make the predicate permanently false wherever git is
 * pending. This is the operand `push.ts`'s integrity check already hashes.
 */
export function globalWouldNotChange(
  snapshot: SyncState,
  sourceGlobalSeq: number,
  receipt: ElisionReceipt,
): boolean {
  return globalElisionAudit(snapshot, sourceGlobalSeq, receipt) === "unchanged";
}

/**
 * What the audit actually observed. `content-drift` is the ONE outcome that says
 * something about the durable base rather than about this cycle's shape: every
 * other input agreed, and only the persisted content's hash disagreed — design
 * 269 §2.4's drift detector.
 */
export type GlobalElisionAudit = "unchanged" | "content-drift" | "not-audited";

export function globalElisionAudit(
  snapshot: SyncState,
  sourceGlobalSeq: number,
  receipt: ElisionReceipt,
): GlobalElisionAudit {
  if (!receipt.noActions || !receipt.storedBaseIsRemote) return "not-audited";
  if (sourceGlobalSeq !== snapshot.lastSyncedSequence) return "not-audited";
  const incoming = validManifestMeta(receipt.manifestMeta);
  const persisted = validManifestMeta(snapshot.manifestMeta);
  if (!incoming || !persisted || !isDeepStrictEqual(incoming, persisted)) return "not-audited";
  return canonicalManifestHashStreaming(manifestFromMeta(snapshot.lastSyncedManifest, persisted))
    === incoming.manifestHash ? "unchanged" : "content-drift";
}

/** §3.3. `applyTransitions` is a pure upsert with no absence semantics, so a
 * transition that composes to the stored record moves nothing but its generation. */
export const recordWouldNotChange = (current: RepoRecordInput, composed: RepoRecordInput): boolean =>
  isDeepStrictEqual(current, composed);
