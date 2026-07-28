/** The one atomic global + multi-repository CAS.
 *
 * Every input reaching `BEGIN IMMEDIATE` is a connection-owned TEMP copy of an
 * already-verified sealed artifact, so no external path can affect the outcome
 * after the transaction opens. */
import type { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { GitSection } from "../../../engine/index.js";
import {
  composeRepoBase, type BranchBaseOrigin, type RepoBaseProof, type RepoBaseValue,
} from "../../sync-git/base-composer.js";
import {
  validManifestMeta, type GlobalManifestMeta, type RepoRecord, type RepoRecordInput,
} from "../../sync-state-model.js";
import { encodeRepoRecord } from "../codecs/repo-record.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { sameStageBinding } from "../digest/repo-transition-v1.js";
import { ProoflessBaseError, StageChangedError } from "../errors.js";
import type { CasOwnerToken, CasRejectionReason, CasResult, ManifestHeader } from "../ports.js";
import {
  copyStageFilesIntoTemp, createStageFileTemp, dropStageFileTemp,
  internStagedEntryValues, openSealedStage, promoteFilesIntoPlane,
  verifySourceStageBinding, type SealedStageRef,
} from "./generations.js";
import { stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { currentSnapshot } from "./read-snapshot.js";
import { StageLock, streamRows } from "./stage-artifacts.js";
import {
  CAS_TRANSITION_TEMP, buildCasRetryView, copyTransitionRowsIntoTemp, createTransitionTemp,
  dropTransitionTemps, openSealedRepoTransitionStage, type SealedRepoTransitionRef,
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

class Rejected extends Error {
  constructor(readonly reason: CasRejectionReason) {
    super(`cas rejected: ${reason}`);
  }
}

const reject = (reason: CasRejectionReason): never => {
  throw new Rejected(reason);
};

function assertPairing(packet: CasPacket): void {
  const bindings = packet.repoTransitions.sourceStageBindings;
  if (!packet.global) {
    if (bindings.length !== 0) {
      throw new StageChangedError(packet.repoTransitions.stageId, "a repo-only packet must declare an empty source-stage list");
    }
    return;
  }
  if (bindings.length !== 1 || !sameStageBinding(bindings[0]!, packet.global.stage)) {
    throw new StageChangedError(packet.repoTransitions.stageId, "the global stage is not the transition stage's exact source binding");
  }
  if (packet.global.stage.plane !== "base") {
    throw new StageChangedError(packet.global.stage.stageId, "a CAS global stage must be a BASE stage");
  }
  if (packet.global.stage.counts.gitSections !== 0) {
    throw new StageChangedError(packet.global.stage.stageId, "the global ref names a file-only stage; stage Git must be consumed into transitions");
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

interface LineageRow {
  lineage_id: string; stream: string; state_nonce: string | null; state_revision: number | null;
  last_synced_sequence: number; active_base_generation: number; local_revision: number;
}

function checkPredicates(db: Database, packet: CasPacket): LineageRow {
  const row = db.query(`SELECT l.lineage_id,l.stream,l.state_nonce,l.state_revision,
    l.last_synced_sequence,l.active_base_generation,l.local_revision
    FROM store_meta m JOIN state_lineage l ON l.lineage_id=m.active_lineage_id
    WHERE m.singleton=1`).get() as LineageRow | null;
  if (!row) throw new Error("state store singleton disappeared");
  const expected = packet.expected;
  if (row.lineage_id !== expected.lineageId) reject("lineage");
  if (row.stream !== expected.stream) reject("stream");
  if ((row.state_nonce ?? "legacy") !== expected.nonce) reject("nonce");
  if ((row.state_revision ?? 0) !== expected.stateRevision) reject("state-revision");
  if (row.active_base_generation !== expected.baseGeneration) reject("base-generation");
  if (row.local_revision !== expected.localRevision) reject("local-revision");
  if (packet.global && packet.sourceGlobalSeq < row.last_synced_sequence) reject("global-sequence");
  const drift = db.query(`SELECT t.rel_path FROM ${CAS_TRANSITION_TEMP} t
    WHERE t.expected_repo_gen <> COALESCE(
      (SELECT r.repo_gen FROM repo_records r WHERE r.lineage_id=? AND r.rel_path=t.rel_path), 0)
    LIMIT 1`).get(expected.lineageId) as { rel_path: string } | null;
  if (drift) reject("repo-generation");
  if (!packet.ownerToken.isOwner()) reject("owner-lost");
  return row;
}

/** Step 3. The staged file set replaces BASE by set-difference; the header,
 * manifest meta, and sequence are replaced together or not at all. */
function applyGlobal(db: Database, packet: CasPacket, lineageId: string): void {
  const global = packet.global!;
  const generation = packet.expected.baseGeneration + 1;
  internStagedEntryValues(db);
  promoteFilesIntoPlane(db, lineageId, "base", generation);
  const { generatedAt, manifestSchema, sourceSequence, trustEpoch, complete: _complete, ...extras } = global.fileHeader;
  db.query(`UPDATE plane_heads SET generation=?,generated_at=?,manifest_schema=?,source_sequence=?,
    trust_epoch=?,complete=1,extras_cjson=? WHERE lineage_id=? AND plane='base'`).run(
    generation, generatedAt, manifestSchema ?? null, sourceSequence ?? null, trustEpoch ?? null,
    Object.keys(extras).length === 0 ? null : canonicalJson(extras), lineageId,
  );
  db.query("UPDATE state_lineage SET last_synced_sequence=? WHERE lineage_id=?").run(packet.sourceGlobalSeq, lineageId);
  db.query("DELETE FROM manifest_chain WHERE lineage_id=?").run(lineageId);
  db.query("DELETE FROM global_manifest_meta WHERE lineage_id=?").run(lineageId);
  db.query("DELETE FROM manifest_git_sections WHERE lineage_id=? AND role='meta-wire'").run(lineageId);
  if (global.manifestMeta === undefined) return;
  // The admission invariants U1a could only read are enforced here, by the one
  // definition the wire codec and the JSON authority already share: bounded,
  // deduplicated, self-excluding chain, and (chainBytes===0)===(chain.length===0).
  const meta = validManifestMeta(global.manifestMeta);
  if (!meta) throw new TypeError("CAS manifestMeta is not a valid GlobalManifestMeta");
  const { encManifestSha, manifestHash, accountEpoch, keyEpoch, chainBytes, snapshotBytes,
    chain, gitRepos, ...metaExtras } = meta as GlobalManifestMeta & Record<string, unknown>;
  db.query(`INSERT INTO global_manifest_meta(lineage_id,base_generation,enc_manifest_sha,manifest_hash,
    account_epoch,key_epoch,chain_bytes,snapshot_bytes,extras_cjson) VALUES (?,?,?,?,?,?,?,?,?)`).run(
    lineageId, generation, Buffer.from(encManifestSha, "hex"), Buffer.from(manifestHash, "hex"),
    accountEpoch, keyEpoch, chainBytes, snapshotBytes,
    Object.keys(metaExtras).length === 0 ? null : canonicalJson(metaExtras),
  );
  const chainInsert = db.query("INSERT INTO manifest_chain(lineage_id,base_generation,ordinal,enc_sha) VALUES (?,?,?,?)");
  for (const [ordinal, encSha] of chain.entries()) {
    chainInsert.run(lineageId, generation, ordinal, Buffer.from(encSha, "hex"));
  }
  const gitInsert = db.query(`INSERT INTO manifest_git_sections(lineage_id,base_generation,role,rel_path,path_order,section_cjson)
    VALUES (?,?,'meta-wire',?,?,?)`);
  for (const [relPath, section] of Object.entries(gitRepos)) {
    gitInsert.run(lineageId, generation, relPath, utf16beOrderKey(relPath), canonicalJson(section));
  }
}

const REPO_VALUE_COLUMNS = [
  "base_cjson", "advertised_cjson", "branch_base_origins_cjson", "packed_refs_identity",
  "pending_cjson", "repo_absent", "removed_key", "resolution_key", "cfg_synced", "cfg_applied",
  "cfg_token_cjson", "cfg_shape_cjson", "deferrals_cjson", "partial_cjson", "attempt_cjson",
  "resolution_receipt_cjson", "idx_proj",
] as const;

/**
 * Steps 2 and 4, streamed. Each transition is recomposed against its exact
 * predecessor with its own explicit proof and written as one whole value. The
 * packet is never collected in JS: one row is in memory at a time.
 */
function applyTransitions(db: Database, lineageId: string): void {
  const previous = db.query(`SELECT base_cjson,branch_base_origins_cjson
    FROM repo_records WHERE lineage_id=? AND rel_path=?`);
  const upsert = db.query(`INSERT INTO repo_records(
    lineage_id,rel_path,path_order,repo_gen,source_seq,${REPO_VALUE_COLUMNS.join(",")},
    extras_cjson,canonical_bytes,retained_estimate
  ) VALUES (${Array.from({ length: 5 + REPO_VALUE_COLUMNS.length + 3 }, () => "?").join(",")})
  ON CONFLICT(lineage_id,rel_path) DO UPDATE SET
    path_order=excluded.path_order, repo_gen=excluded.repo_gen, source_seq=excluded.source_seq,
    ${REPO_VALUE_COLUMNS.map((column) => `${column}=excluded.${column}`).join(",")},
    extras_cjson=excluded.extras_cjson, canonical_bytes=excluded.canonical_bytes,
    retained_estimate=excluded.retained_estimate`);
  streamRows<{ rel_path: string; expected_repo_gen: number; record_cjson: string; base_proof_cjson: string | null }>(
    db, `SELECT rel_path,expected_repo_gen,record_cjson,base_proof_cjson
    FROM ${CAS_TRANSITION_TEMP} ORDER BY path_order`, [], (row) => {
    const candidate = parseCanonicalJson(row.record_cjson) as unknown as RepoRecordInput;
    const before = previous.get(lineageId, row.rel_path) as {
      base_cjson: string | null; branch_base_origins_cjson: string | null;
    } | null;
    const next = recomposeBase(row.rel_path, candidate, row.base_proof_cjson, before);
    const encoded = encodeRepoRecord(row.rel_path, { ...next, repoGen: row.expected_repo_gen + 1 } as RepoRecord);
    upsert.run(
      lineageId, row.rel_path, encoded.pathOrder, encoded.repoGen, encoded.sourceSeq,
      ...REPO_VALUE_COLUMNS.map((column) => encoded.values[column] ?? null),
      encoded.extrasCjson, encoded.canonicalBytes, encoded.retainedEstimate,
    );
  });
}

/** Step 2. A record that asks for BASE without an explicit proof never reaches an
 * authority write; a proof that composes to `pending` installs today's safety hold
 * instead of silently landing the requested BASE. */
function recomposeBase(
  relPath: string,
  candidate: RepoRecordInput,
  baseProofCjson: string | null,
  before: { base_cjson: string | null; branch_base_origins_cjson: string | null } | null,
): RepoRecordInput {
  const previous: RepoBaseValue = {
    ...(before?.base_cjson == null ? {} : { base: parseCanonicalJson(before.base_cjson) as unknown as GitSection }),
    ...(before?.branch_base_origins_cjson == null
      ? {}
      : { branchBaseOrigins: parseCanonicalJson(before.branch_base_origins_cjson) as unknown as Record<string, BranchBaseOrigin> }),
  };
  if (baseProofCjson === null) {
    // Without a proof this transition may not move BASE in ANY direction:
    // introducing one, replacing one, and dropping one are all authority changes.
    if (candidate.base !== undefined) throw new ProoflessBaseError(relPath, "the CAS input carries BASE with no proof");
    if (candidate.branchBaseOrigins !== undefined) {
      throw new ProoflessBaseError(relPath, "the CAS input carries branch base origins with no proof");
    }
    if (previous.base !== undefined) {
      throw new ProoflessBaseError(relPath, "the CAS input would drop the authority's BASE with no proof");
    }
    return candidate;
  }
  const proof = parseCanonicalJson(baseProofCjson) as unknown as RepoBaseProof;
  const composed = composeRepoBase(
    previous,
    { base: candidate.base, branchBaseOrigins: candidate.branchBaseOrigins },
    proof.authority,
    proof.lockedProof,
  );
  const next: RepoRecordInput = { ...candidate };
  if (composed.base === undefined) delete next.base; else next.base = composed.base;
  if (composed.branchBaseOrigins === undefined) delete next.branchBaseOrigins;
  else next.branchBaseOrigins = composed.branchBaseOrigins;
  if (composed.disposition === "pending" && candidate.base !== undefined && next.pending === undefined) {
    next.pending = candidate.base;
  }
  return next;
}

/** The manifest projection is derived, never carried: removal and suppression hide
 * a repository from it without destroying its BASE provenance anchor. */
function rebuildManifestProjection(db: Database, lineageId: string, generation: number): void {
  db.query("DELETE FROM manifest_git_sections WHERE lineage_id=? AND role='manifest-projection'").run(lineageId);
  db.query(`INSERT INTO manifest_git_sections(lineage_id,base_generation,role,rel_path,path_order,section_cjson)
    SELECT ?,?,'manifest-projection',rel_path,path_order,base_cjson FROM repo_records
    WHERE lineage_id=? AND base_cjson IS NOT NULL AND repo_absent IS NULL AND removed_key IS NULL`)
    .run(lineageId, generation, lineageId);
}

export function applyCasPacket(store: StateStoreHandle, stageDirectory: string, packet: CasPacket): CasResult {
  if (store.readonly) return { status: "unsupported", error: new Error("state store is open read-only") };
  const db = stateStoreDatabase(store);
  assertPairing(packet);
  assertTransitionSnapshot(packet);
  createStageFileTemp(db);
  createTransitionTemp(db);
  try {
    // One stage at a time, each under its own id-scoped lock: bounded descriptors
    // and bounded memory regardless of how many source stages a packet names.
    consumeTransitionStage(db, stageDirectory, packet.repoTransitions);
    for (const binding of packet.repoTransitions.sourceStageBindings) {
      // A stage consumed below is fully verified by that consumption; a stage
      // named only as Git evidence gets the same full proof here.
      if (binding.stageId === packet.global?.stage.stageId) continue;
      verifySourceStageBinding(stageDirectory, binding);
    }
    if (packet.global) consumeGlobalStage(db, stageDirectory, packet.global.stage);
    return runTransaction(db, packet);
  } finally {
    dropStageFileTemp(db);
    dropTransitionTemps(db);
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

function runTransaction(db: Database, packet: CasPacket): CasResult {
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
    checkPredicates(db, packet);
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
  return buildRejection(db, rejection);
}

/** A rejection returns only the packet's touched paths, frozen under one token. A
 * token that moves while the view is being built is reported as `busy` rather than
 * handed back torn. */
function buildRejection(db: Database, reason: CasRejectionReason): CasResult {
  const before = currentSnapshot(db);
  db.exec("BEGIN");
  let retry;
  try {
    if (canonicalJson(currentSnapshot(db)) !== canonicalJson(before)) {
      db.exec("ROLLBACK");
      return { status: "busy", detail: "snapshot changed while building the retry view" };
    }
    retry = buildCasRetryView(db, before);
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
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
