/** The one atomic global + multi-repository CAS.
 *
 * Every input reaching `BEGIN IMMEDIATE` is a connection-owned TEMP copy of an
 * already-verified sealed artifact, so no external path can affect the outcome
 * after the transaction opens. The headers, evidence, and proofs that commit are
 * the ones the sealed artifacts authenticate — never a caller's parallel claim. */
import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { GlobalManifestMeta } from "../../sync-state-model.js";
import { canonicalJson } from "../digest/codecs.js";
import { sameStageBinding, type SourceStageBinding } from "../digest/repo-transition-v1.js";
import { StageChangedError } from "../errors.js";
import type { CasOwnerToken, CasRejectionReason, CasResult, ManifestHeader } from "../ports.js";
import { buildCasRetryView } from "./cas-retry-view.js";
import {
  Rejected, applyGlobal, applyTransitions, checkPredicates, rebuildManifestProjection, reject,
} from "./cas-steps.js";
import { copyStageFilesIntoTemp, createStageFileTemp, dropStageFileTemp } from "./generations.js";
import { stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { currentSnapshot } from "./read-snapshot.js";
import { openSealedStage, verifySourceStageBinding, type SealedStageRef } from "./sealed-stages.js";
import { StageLock, deleteSealedArtifact, type SealedArtifactRef } from "./stage-artifacts.js";
import {
  copyTransitionRowsIntoTemp, createTransitionTemp, dropTransitionTemp,
  openSealedRepoTransitionStage, type SealedRepoTransitionRef,
} from "./transition-stages.js";

export interface CasExpectation {
  lineageId: string;
  stream: string;
  /** `legacy` matches a lineage with no nonce, and only that. */
  nonce: string;
  stateRevision: number;
  baseGeneration: number;
  localRevision: number;
}

export interface CasPacket {
  expected: CasExpectation;
  sourceGlobalSeq: number;
  global?: { stage: SealedStageRef; fileHeader: ManifestHeader; manifestMeta?: GlobalManifestMeta };
  repoTransitions: SealedRepoTransitionRef;
  ownerToken: CasOwnerToken;
}

/** @internal Observation seam for the token-race branches of the retry protocol.
 * Production callers never pass it; it exists so the "snapshot changed while
 * building the retry view" refusal is executable rather than merely present. */
export interface CasInternalHooks {
  beforeRetryView?: () => void;
  afterRetryView?: () => void;
}

/**
 * A global packet must be paired with the transition stage built from it, and the
 * design explicitly allows further stages that are named only as Git evidence — so
 * the global binding must be PRESENT, not alone.
 */
function assertPairing(packet: CasPacket): void {
  const bindings = packet.repoTransitions.sourceStageBindings;
  if (!packet.global) {
    if (bindings.length !== 0) {
      throw new StageChangedError(packet.repoTransitions.stageId, "a repo-only packet must declare an empty source-stage list");
    }
    return;
  }
  if (!bindings.some((binding) => sameStageBinding(binding, packet.global!.stage))) {
    throw new StageChangedError(packet.repoTransitions.stageId, "the global stage is not one of the transition stage's source bindings");
  }
  if (packet.global.stage.plane !== "base") {
    throw new StageChangedError(packet.global.stage.stageId, "a CAS global stage must be a BASE stage");
  }
  if (packet.global.stage.counts.gitSections !== 0) {
    throw new StageChangedError(packet.global.stage.stageId, "the global ref names a file-only stage; stage Git must be consumed into transitions");
  }
  // The header that commits is the sealed one. A caller-supplied header is only
  // ever a claim, so it is compared and refused rather than trusted.
  if (canonicalJson(packet.global.fileHeader) !== canonicalJson(packet.global.stage.header)) {
    throw new StageChangedError(packet.global.stage.stageId, "the packet's file header is not the header this stage was sealed with");
  }
}

function assertTransitionSnapshot(packet: CasPacket): void {
  const token = packet.repoTransitions.snapshotToken;
  const expected = packet.expected;
  const matches = token.lineageId === expected.lineageId
    && token.stream === expected.stream
    && (token.nonce ?? "legacy") === expected.nonce
    && (token.stateRevision ?? 0) === expected.stateRevision
    && token.baseGeneration === expected.baseGeneration
    && token.localRevision === expected.localRevision;
  if (!matches) {
    throw new StageChangedError(packet.repoTransitions.stageId, "the transition stage is bound to a different snapshot than the packet expects");
  }
}

export function applyCasPacket(
  store: StateStoreHandle,
  stageDirectory: string,
  packet: CasPacket,
  hooks: CasInternalHooks = {},
): CasResult {
  if (store.readonly) return { status: "unsupported", error: new Error("state store is open read-only") };
  const db = stateStoreDatabase(store);
  assertPairing(packet);
  assertTransitionSnapshot(packet);
  createStageFileTemp(db);
  createTransitionTemp(db);
  const consumed: SealedArtifactRef[] = [];
  try {
    // One stage at a time, each under its own id-scoped lock: bounded descriptors
    // and bounded memory regardless of how many source stages a packet names.
    consumeTransitionStage(db, stageDirectory, packet.repoTransitions);
    consumed.push(packet.repoTransitions);
    const verified = new Set<string>();
    for (const binding of packet.repoTransitions.sourceStageBindings) {
      // A stage consumed below is fully verified by that consumption; a stage
      // named only as Git evidence gets the same full proof here.
      const derived = binding.stageId === packet.global?.stage.stageId
        ? packet.global.stage
        : verifySourceStageBinding(stageDirectory, binding);
      if (derived.logicalDigest !== binding.logicalDigest || derived.physicalSha256 !== binding.physicalSha256) {
        throw new StageChangedError(binding.stageId, "verified source stage does not match its binding");
      }
      verified.add(canonicalBinding(binding));
    }
    if (packet.global) {
      consumeGlobalStage(db, stageDirectory, packet.global.stage);
      consumed.push(packet.global.stage);
    }
    const result = runTransaction(db, stageDirectory, packet, verified, hooks);
    // The design's id-scoped cleanup after adoption or refusal. `busy` adopted and
    // refused nothing, so its inputs stay available to the caller's retry.
    if (result.status === "accepted" || result.status === "rejected") {
      for (const ref of consumed) deleteConsumedStage(stageDirectory, ref);
    }
    return result;
  } finally {
    dropStageFileTemp(db);
    dropTransitionTemp(db);
  }
}

const canonicalBinding = (binding: SourceStageBinding): string => canonicalJson({
  stageId: binding.stageId, logicalDigest: binding.logicalDigest, physicalSha256: binding.physicalSha256,
});

function deleteConsumedStage(directory: string, ref: SealedArtifactRef): void {
  const lock = StageLock.acquire(directory, ref.stageId);
  try {
    deleteSealedArtifact(directory, ref, lock);
  } finally {
    lock.release();
  }
}

function consumeTransitionStage(db: Database, directory: string, ref: SealedRepoTransitionRef): void {
  const lock = StageLock.acquire(directory, ref.stageId);
  try {
    const reader = openSealedRepoTransitionStage(directory, ref, lock);
    let copied: number;
    try {
      copied = copyTransitionRowsIntoTemp(db, reader);
    } finally {
      reader.close();
    }
    if (copied !== ref.rowCount) throw new StageChangedError(ref.stageId, "sealed transition row count changed while streaming");
  } finally {
    lock.release();
  }
}

function consumeGlobalStage(db: Database, directory: string, ref: SealedStageRef): void {
  const lock = StageLock.acquire(directory, ref.stageId);
  try {
    const reader = openSealedStage(directory, ref, lock);
    let copied: number;
    try {
      copied = copyStageFilesIntoTemp(db, reader);
    } finally {
      reader.close();
    }
    if (copied !== ref.counts.files) throw new StageChangedError(ref.stageId, "sealed stage file count changed while streaming");
  } finally {
    lock.release();
  }
}

function isBusy(error: unknown): boolean {
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code.startsWith("SQLITE_BUSY") || /database is locked/i.test(String(error));
}

function runTransaction(
  db: Database,
  stageDirectory: string,
  packet: CasPacket,
  verified: ReadonlySet<string>,
  hooks: CasInternalHooks,
): CasResult {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    // Another writer owns the authority right now. This is the design's `busy`:
    // nothing was attempted, so the caller may recompute and retry.
    if (isBusy(error)) return { status: "busy", detail: String(error) };
    throw error;
  }
  let rejection: CasRejectionReason | undefined;
  try {
    checkPredicates(db, packet, verified);
    const lineageId = packet.expected.lineageId;
    if (packet.global) applyGlobal(db, packet, lineageId);
    applyTransitions(db, lineageId);
    const generation = packet.expected.baseGeneration + (packet.global ? 1 : 0);
    rebuildManifestProjection(db, lineageId, generation);
    db.query("UPDATE state_lineage SET state_nonce=COALESCE(state_nonce,?),state_revision=? WHERE lineage_id=?")
      .run(crypto.randomBytes(16).toString("hex"), packet.expected.stateRevision + 1, lineageId);
    // Step 5: the last thing before commit is the ownership recheck.
    if (!packet.ownerToken.isOwner()) reject("owner-lost");
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    if (!(error instanceof Rejected)) throw error;
    rejection = error.reason;
  }
  if (rejection === undefined) return { status: "accepted", token: currentSnapshot(db) };
  return buildRejection(db, stageDirectory, rejection, hooks);
}

/** A rejection returns only the packet's touched paths, sealed under one token. A
 * token that moves while the view is being built is reported as `busy` rather than
 * handed back torn. */
function buildRejection(
  db: Database,
  stageDirectory: string,
  reason: CasRejectionReason,
  hooks: CasInternalHooks,
): CasResult {
  const before = currentSnapshot(db);
  hooks.beforeRetryView?.();
  db.exec("BEGIN");
  let retry;
  try {
    if (canonicalJson(currentSnapshot(db)) !== canonicalJson(before)) {
      db.exec("ROLLBACK");
      return { status: "busy", detail: "snapshot changed while building the retry view" };
    }
    retry = buildCasRetryView(db, stageDirectory, before);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  hooks.afterRetryView?.();
  if (canonicalJson(currentSnapshot(db)) !== canonicalJson(before)) {
    retry.close();
    return { status: "busy", detail: "snapshot changed while building the retry view" };
  }
  return { status: "rejected", reason, retry };
}

/** A separate singleton transaction that deliberately preserves `stateRevision`:
 * minting a local telemetry binding is not a state mutation callers may CAS on. */
export function ensureTelemetryBindingId(store: StateStoreHandle, expectedStream: string): string {
  const db = stateStoreDatabase(store);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.query(`SELECT l.lineage_id,l.stream,l.telemetry_binding_id FROM store_meta m
      JOIN state_lineage l ON l.lineage_id=m.active_lineage_id WHERE m.singleton=1`).get() as {
      lineage_id: string; stream: string; telemetry_binding_id: string | null;
    } | null;
    if (!row) throw new Error("state store singleton disappeared");
    if (row.stream !== expectedStream) throw new Error(`telemetry binding requested for stream ${expectedStream}, store holds ${row.stream}`);
    const binding = row.telemetry_binding_id ?? crypto.randomBytes(8).toString("hex");
    if (row.telemetry_binding_id === null) {
      db.query("UPDATE state_lineage SET telemetry_binding_id=? WHERE lineage_id=?").run(binding, row.lineage_id);
    }
    db.exec("COMMIT");
    return binding;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
