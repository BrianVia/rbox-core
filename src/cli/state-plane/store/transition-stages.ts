/** Sealed multi-repository CAS inputs, and the bounded retry view a rejection
 * returns. A transition stage is the only way a RepoRecord reaches the CAS. */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import fs from "node:fs";
import type { RepoRecord, RepoRecordInput } from "../../sync-state-model.js";
import type { RepoBaseProof } from "../../sync-git/base-composer.js";
import { decodeRepoRecord, encodeRepoRecord, type RepoRecordRow } from "../codecs/repo-record.js";
import { canonicalJson, parseCanonicalJson, retainedEstimate, utf16beOrderKey } from "../digest/codecs.js";
import {
  RepoTransitionDigestBuilder, canonicalStageBinding, sameStageBinding,
  type RepoTransitionDigest, type SourceStageBinding,
} from "../digest/repo-transition-v1.js";
import {
  CursorWindowError, ProoflessBaseError, StageChangedError, TransitionRowOversizeError,
} from "../errors.js";
import type { CasRetryRepo, CasRetryView, CursorPage, LineageSnapshot } from "../ports.js";
import {
  StageLock, assertSealedZeroSidecars, buildingStagePath, configureStageBuilder,
  fsyncFile, openSealedArtifact, physicalProof, publishSealed, sealedStagePath, streamRows,
} from "./stage-artifacts.js";

const BATCH_BYTES = 4 * 1024 * 1024;
const MAX_ROW_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_ROW_RETAINED_BYTES = 24 * 1024 * 1024;
const MAX_RETRY_BATCH = 16;
const MAX_RETRY_ROW_RETAINED = 16 * 1024 * 1024;

const TRANSITION_DDL = `
CREATE TABLE transition_meta(
  stage_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  snapshot_cjson TEXT NOT NULL, source_bindings_cjson TEXT NOT NULL,
  importer TEXT NOT NULL CHECK(importer IN ('engine','migration')),
  digest TEXT, row_count INTEGER,
  CHECK(state='building' OR (digest IS NOT NULL AND row_count IS NOT NULL))
);
CREATE TABLE transition_rows(
  stage_id TEXT NOT NULL, rel_path TEXT NOT NULL, path_order BLOB NOT NULL,
  expected_repo_gen INTEGER NOT NULL CHECK(expected_repo_gen>=0),
  record_cjson TEXT NOT NULL, base_proof_cjson TEXT, evidence_cjson TEXT NOT NULL,
  canonical_bytes INTEGER NOT NULL CHECK(canonical_bytes BETWEEN 1 AND 8388608),
  retained_estimate INTEGER NOT NULL CHECK(retained_estimate BETWEEN 1 AND 25165824),
  PRIMARY KEY(stage_id,rel_path)
);
CREATE INDEX transition_rows_order ON transition_rows(stage_id,path_order);
`;

/** What a record derived from. Every named stage must appear verbatim in the
 * stage's own `sourceStageBindings`, so a record cannot claim an input the
 * transition as a whole was never bound to. */
export interface TransitionEvidenceBindings {
  sourceStages: SourceStageBinding[];
}

export interface TransitionInput {
  relPath: string;
  expectedRepoGen: number;
  newRecord: RepoRecordInput;
  baseProof?: RepoBaseProof;
  evidenceBindings: TransitionEvidenceBindings;
}

export interface SealedRepoTransitionRef {
  stageId: string;
  logicalDigest: RepoTransitionDigest;
  physicalSha256: string;
  bytes: number;
  rowCount: number;
  snapshotToken: LineageSnapshot;
  sourceStageBindings: SourceStageBinding[];
}

export interface TransitionRow {
  relPath: string;
  expectedRepoGen: number;
  newRecord: RepoRecordInput;
  baseProof?: RepoBaseProof;
  evidenceBindings: TransitionEvidenceBindings;
}

export interface RepoTransitionStageBuilder {
  readonly stageId: string;
  putTransition(input: TransitionInput): void;
  finishRepoTransitionStage(): SealedRepoTransitionRef;
  discard(): void;
}

export function beginRepoTransitionStage(
  directory: string,
  snapshotToken: LineageSnapshot,
  sourceStageBindings: readonly SourceStageBinding[],
  options: { importer?: "engine" | "migration"; stageId?: string } = {},
): RepoTransitionStageBuilder {
  const importer = options.importer ?? "engine";
  const stageId = options.stageId ?? crypto.randomBytes(16).toString("hex");
  const bindings = [...sourceStageBindings].sort((a, b) => (a.stageId < b.stageId ? -1 : a.stageId > b.stageId ? 1 : 0));
  const lock = StageLock.acquire(directory, stageId);
  const file = buildingStagePath(directory, stageId);
  let db: Database;
  try {
    fs.rmSync(file, { force: true });
    db = new Database(file, { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(TRANSITION_DDL);
    db.query(`INSERT INTO transition_meta(stage_id,state,snapshot_cjson,source_bindings_cjson,importer)
      VALUES (?,'building',?,?,?)`).run(
      stageId, canonicalJson(snapshotToken), canonicalJson(bindings), importer,
    );
  } catch (error) {
    lock.cleanupOwnedArtifacts();
    lock.release();
    throw error;
  }
  return new SqliteTransitionBuilder(directory, stageId, snapshotToken, bindings, importer, db, lock, file);
}

/**
 * The proof rule the withdrawn first implementation of this seam failed.
 *
 * A record that carries `base` is asserting new BASE authority. That assertion is
 * admitted only with an explicit `RepoBaseProof` whose authority kind is a real
 * one — the `migration` kind is a blanket authority and is reserved for the tagged
 * migration importer, which is why an implicit `migrationRepoBaseProof()` default
 * is not offered anywhere in this seam. Whatever proof is supplied is then bound
 * by the transition digest to this repository, its expected generation, the
 * source evidence, and the coherent snapshot token.
 */
function assertBaseProof(input: TransitionInput, importer: "engine" | "migration"): void {
  if (input.baseProof === undefined) {
    if (input.newRecord.base !== undefined) {
      throw new ProoflessBaseError(input.relPath, "the record introduces or changes BASE but carries no baseProof");
    }
    if (input.newRecord.branchBaseOrigins !== undefined) {
      throw new ProoflessBaseError(input.relPath, "the record carries branch base origins but no baseProof");
    }
    return;
  }
  const authority = input.baseProof?.authority;
  if (!authority || typeof authority.kind !== "string") {
    throw new ProoflessBaseError(input.relPath, "baseProof has no authority kind");
  }
  if (authority.kind === "migration" && importer !== "migration") {
    throw new ProoflessBaseError(input.relPath, "implicit migration authority is reserved for the tagged migration importer");
  }
  if (!input.baseProof?.lockedProof) throw new ProoflessBaseError(input.relPath, "baseProof has no lockedProof");
}

function assertEvidence(input: TransitionInput, bindings: readonly SourceStageBinding[]): void {
  const named = input.evidenceBindings?.sourceStages;
  if (!Array.isArray(named)) throw new TypeError(`transition ${input.relPath} has no evidenceBindings.sourceStages`);
  if (bindings.length === 0 && named.length > 0) {
    throw new TypeError(`transition ${input.relPath} names source stages, but the stage declared none`);
  }
  for (const binding of named) {
    if (!bindings.some((declared) => sameStageBinding(declared, binding))) {
      throw new TypeError(`transition ${input.relPath} names source stage ${binding.stageId}, which this stage is not bound to`);
    }
  }
}

class SqliteTransitionBuilder implements RepoTransitionStageBuilder {
  #open = true;
  #pendingBytes = 0;

  constructor(
    private readonly directory: string,
    readonly stageId: string,
    private readonly snapshotToken: LineageSnapshot,
    private readonly bindings: SourceStageBinding[],
    private readonly importer: "engine" | "migration",
    private readonly db: Database,
    private readonly lock: StageLock,
    private readonly file: string,
  ) {
    this.db.exec("BEGIN");
  }

  putTransition(input: TransitionInput): void {
    if (!this.#open) throw new Error("transition stage builder is closed");
    this.lock.assertHeld();
    if (!Number.isSafeInteger(input.expectedRepoGen) || input.expectedRepoGen < 0) {
      throw new TypeError(`transition ${input.relPath} has an invalid expected generation`);
    }
    assertBaseProof(input, this.importer);
    assertEvidence(input, this.bindings);
    // Pre-materialization scan: the complete row — record plus proof plus evidence
    // — is measured and refused BEFORE anything is encoded or written, so an
    // oversize row never reaches sealing or an authority write.
    const canonicalRecord = canonicalJson(input.newRecord);
    const canonicalProof = input.baseProof === undefined ? undefined : canonicalJson(input.baseProof);
    const canonicalEvidence = canonicalJson({ sourceStages: input.evidenceBindings.sourceStages.map(canonicalStageBinding) });
    const rowCanonical = Buffer.byteLength(canonicalRecord)
      + Buffer.byteLength(canonicalProof ?? "") + Buffer.byteLength(canonicalEvidence);
    const rowRetained = retainedEstimate({
      newRecord: input.newRecord,
      ...(input.baseProof === undefined ? {} : { baseProof: input.baseProof }),
      evidenceBindings: input.evidenceBindings,
    });
    if (rowCanonical > MAX_ROW_CANONICAL_BYTES || rowRetained > MAX_ROW_RETAINED_BYTES) {
      throw new TransitionRowOversizeError(input.relPath, rowCanonical, rowRetained);
    }
    // Inside the row ceiling, the record must still be one this store can hold.
    const encoded = encodeRepoRecord(input.relPath, { ...input.newRecord, repoGen: input.expectedRepoGen + 1 } as RepoRecord);
    if (this.#pendingBytes > 0 && this.#pendingBytes + rowRetained > BATCH_BYTES) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
      this.#pendingBytes = 0;
    }
    try {
      this.db.query(`INSERT INTO transition_rows(stage_id,rel_path,path_order,expected_repo_gen,
        record_cjson,base_proof_cjson,evidence_cjson,canonical_bytes,retained_estimate)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(
        this.stageId, input.relPath, encoded.pathOrder, input.expectedRepoGen,
        canonicalRecord, canonicalProof ?? null, canonicalEvidence, rowCanonical, rowRetained,
      );
    } catch (error) {
      if (String(error).includes("UNIQUE") || String(error).includes("PRIMARY KEY")) {
        throw new TypeError(`transition stage already has a row for ${input.relPath}`);
      }
      throw error;
    }
    this.#pendingBytes += rowRetained;
  }

  finishRepoTransitionStage(): SealedRepoTransitionRef {
    if (!this.#open) throw new Error("transition stage builder is closed");
    this.lock.assertHeld();
    const digest = new RepoTransitionDigestBuilder(this.snapshotToken, this.bindings);
    streamRows<TransitionRowShape>(this.db, `SELECT rel_path,expected_repo_gen,record_cjson,base_proof_cjson,evidence_cjson
      FROM transition_rows WHERE stage_id=? ORDER BY path_order`, [this.stageId], (row) => {
      const revalidated: TransitionInput = {
        relPath: row.rel_path,
        expectedRepoGen: row.expected_repo_gen,
        newRecord: parseCanonicalJson(row.record_cjson) as unknown as RepoRecordInput,
        ...(row.base_proof_cjson === null
          ? {}
          : { baseProof: parseCanonicalJson(row.base_proof_cjson) as unknown as RepoBaseProof }),
        evidenceBindings: { sourceStages: this.bindings },
      };
      assertBaseProof(revalidated, this.importer);
      digest.row({
        relPath: row.rel_path,
        expectedRepoGen: row.expected_repo_gen,
        canonicalRecord: row.record_cjson,
        canonicalBaseProof: row.base_proof_cjson ?? undefined,
        canonicalEvidenceBindings: row.evidence_cjson,
      });
    });
    const rowCount = digest.rows;
    const logicalDigest = digest.seal();
    this.db.query("UPDATE transition_meta SET state='sealed',digest=?,row_count=? WHERE stage_id=?")
      .run(logicalDigest, rowCount, this.stageId);
    this.db.exec("COMMIT");
    this.#open = false;
    this.db.close();
    assertSealedZeroSidecars(this.file, this.stageId);
    fsyncFile(this.file);
    const physical = physicalProof(this.file, this.stageId);
    publishSealed(this.file, sealedStagePath(this.directory, this.stageId, logicalDigest), this.stageId);
    this.lock.release();
    return {
      stageId: this.stageId, logicalDigest, physicalSha256: physical.sha256, bytes: physical.bytes,
      rowCount, snapshotToken: this.snapshotToken, sourceStageBindings: this.bindings,
    };
  }

  discard(): void {
    if (!this.#open) return;
    this.#open = false;
    try { if (this.db.inTransaction) this.db.exec("ROLLBACK"); } catch { /* closing anyway */ }
    this.db.close();
    this.lock.cleanupOwnedArtifacts();
    this.lock.release();
  }
}

interface TransitionRowShape {
  rel_path: string;
  expected_repo_gen: number;
  record_cjson: string;
  base_proof_cjson: string | null;
  evidence_cjson: string;
}

export interface SealedTransitionReader {
  streamRows(visit: (row: TransitionRow) => void): number;
  close(): void;
}

export function openSealedRepoTransitionStage(
  directory: string,
  ref: SealedRepoTransitionRef,
  lock: StageLock,
): SealedTransitionReader {
  const file = sealedStagePath(directory, ref.stageId, ref.logicalDigest);
  const accessor = openSealedArtifact(file, ref, lock);
  try {
    const meta = accessor.db.query("SELECT stage_id,state,snapshot_cjson,source_bindings_cjson,digest,row_count FROM transition_meta").get() as {
      stage_id: string; state: string; snapshot_cjson: string; source_bindings_cjson: string;
      digest: string; row_count: number;
    } | null;
    if (!meta || meta.stage_id !== ref.stageId || meta.state !== "sealed") {
      throw new StageChangedError(ref.stageId, "sealed transition identity does not match its ref");
    }
    if (meta.snapshot_cjson !== canonicalJson(ref.snapshotToken)
      || meta.source_bindings_cjson !== canonicalJson(ref.sourceStageBindings)) {
      throw new StageChangedError(ref.stageId, "sealed transition snapshot or source bindings do not match its ref");
    }
    const digest = new RepoTransitionDigestBuilder(ref.snapshotToken, ref.sourceStageBindings);
    streamRows<TransitionRowShape>(accessor.db, `SELECT rel_path,expected_repo_gen,record_cjson,base_proof_cjson,evidence_cjson
      FROM transition_rows WHERE stage_id=? ORDER BY path_order`, [ref.stageId], (row) => digest.row({
      relPath: row.rel_path,
      expectedRepoGen: row.expected_repo_gen,
      canonicalRecord: row.record_cjson,
      canonicalBaseProof: row.base_proof_cjson ?? undefined,
      canonicalEvidenceBindings: row.evidence_cjson,
    }));
    if (digest.rows !== ref.rowCount || digest.seal() !== ref.logicalDigest || meta.digest !== ref.logicalDigest) {
      throw new StageChangedError(ref.stageId, "sealed transition logical digest does not match its ref");
    }
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    throw error;
  }
  return {
    streamRows(visit): number {
      return streamRows<TransitionRowShape>(accessor.db, `SELECT rel_path,expected_repo_gen,record_cjson,base_proof_cjson,evidence_cjson
        FROM transition_rows WHERE stage_id=? ORDER BY path_order`, [ref.stageId], (row) => visit({
        relPath: row.rel_path,
        expectedRepoGen: row.expected_repo_gen,
        newRecord: parseCanonicalJson(row.record_cjson) as unknown as RepoRecordInput,
        ...(row.base_proof_cjson === null
          ? {}
          : { baseProof: parseCanonicalJson(row.base_proof_cjson) as unknown as RepoBaseProof }),
        evidenceBindings: { sourceStages: ref.sourceStageBindings },
      }));
    },
    close(): void {
      accessor.close();
    },
  };
}

/* --------------------------------------------------------------- retry view */

export const CAS_TRANSITION_TEMP = "cas_transitions";
export const CAS_RETRY_TEMP = "cas_retry";

export function createTransitionTemp(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_TRANSITION_TEMP};
    CREATE TEMP TABLE ${CAS_TRANSITION_TEMP}(
      rel_path TEXT PRIMARY KEY, path_order BLOB NOT NULL, expected_repo_gen INTEGER NOT NULL,
      record_cjson TEXT NOT NULL, base_proof_cjson TEXT);`);
}

/** Only the input copy. A retry view handed back to a caller owns its own frozen
 * table and drops it on `close()`. */
export function dropTransitionTemps(db: Database): void {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_TRANSITION_TEMP}`);
}

export function copyTransitionRowsIntoTemp(db: Database, reader: SealedTransitionReader): number {
  const insert = db.query(`INSERT INTO ${CAS_TRANSITION_TEMP}(rel_path,path_order,expected_repo_gen,record_cjson,base_proof_cjson)
    VALUES (?,?,?,?,?)`);
  return reader.streamRows((row) => {
    insert.run(
      row.relPath, utf16beOrderKey(row.relPath), row.expectedRepoGen,
      canonicalJson(row.newRecord), row.baseProof === undefined ? null : canonicalJson(row.baseProof),
    );
  });
}

/**
 * Freeze the ordered join of the packet's touched paths to the authority's current
 * records into a file-backed TEMP table, inside one bounded transaction. Paging it
 * afterwards therefore cannot tear; the caller sees the exact token it was built
 * under. Callers that observe a token change build nothing and report `busy`.
 */
export function buildCasRetryView(db: Database, token: LineageSnapshot): CasRetryView {
  db.exec(`DROP TABLE IF EXISTS temp.${CAS_RETRY_TEMP};
    CREATE TEMP TABLE ${CAS_RETRY_TEMP}(
      rel_path TEXT PRIMARY KEY, path_order BLOB NOT NULL,
      expected_repo_gen INTEGER NOT NULL, record_row_cjson TEXT);`);
  const insert = db.query(`INSERT INTO ${CAS_RETRY_TEMP}(rel_path,path_order,expected_repo_gen,record_row_cjson)
    VALUES (?,?,?,?)`);
  // Explicit columns: `path_order` is a BLOB whose JSON spelling would bloat the
  // frozen row for no reader, and the decoder never looks at it.
  const lookup = db.query(`SELECT rel_path,repo_gen,source_seq,base_cjson,advertised_cjson,
    branch_base_origins_cjson,packed_refs_identity,pending_cjson,repo_absent,removed_key,
    resolution_key,cfg_synced,cfg_applied,cfg_token_cjson,cfg_shape_cjson,deferrals_cjson,
    partial_cjson,attempt_cjson,resolution_receipt_cjson,idx_proj,extras_cjson,
    canonical_bytes,retained_estimate FROM repo_records WHERE lineage_id=? AND rel_path=?`);
  streamRows<{ rel_path: string; path_order: Uint8Array; expected_repo_gen: number }>(
    db, `SELECT rel_path,path_order,expected_repo_gen FROM ${CAS_TRANSITION_TEMP} ORDER BY path_order`, [], (row) => {
      const current = lookup.get(token.lineageId, row.rel_path) as RepoRecordRow | null;
      insert.run(
        row.rel_path, Buffer.from(row.path_order), row.expected_repo_gen,
        current === null ? null : JSON.stringify(current),
      );
    });
  let closed = false;
  return {
    token,
    touchedRepos(afterRelPath: string | undefined, batchSize: number): CursorPage<CasRetryRepo> {
      if (closed) throw new Error("retry view is closed");
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RETRY_BATCH) {
        throw new CursorWindowError("repo", batchSize, MAX_RETRY_BATCH);
      }
      const rows = db.query(`SELECT rel_path,expected_repo_gen,record_row_cjson FROM ${CAS_RETRY_TEMP}
        WHERE path_order>? ORDER BY path_order LIMIT ?`).all(
        afterRelPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterRelPath), batchSize,
      ) as Array<{ rel_path: string; expected_repo_gen: number; record_row_cjson: string | null }>;
      const admitted: CasRetryRepo[] = [];
      let used = 0;
      for (const row of rows) {
        const stored = row.record_row_cjson === null ? null : JSON.parse(row.record_row_cjson) as RepoRecordRow;
        const bytes = stored?.retained_estimate ?? 4096;
        if (bytes > MAX_RETRY_ROW_RETAINED) throw new CursorWindowError("repo", bytes, MAX_RETRY_ROW_RETAINED);
        if (admitted.length > 0 && used + bytes > BATCH_BYTES) break;
        admitted.push({
          relPath: row.rel_path,
          expectedRepoGen: row.expected_repo_gen,
          ...(stored === null ? {} : { record: decodeRepoRecord(stored) }),
        });
        used += bytes;
      }
      const last = rows[admitted.length - 1];
      return {
        rows: admitted,
        done: admitted.length === rows.length && rows.length < batchSize,
        ...(last ? { after: last.rel_path } : {}),
      };
    },
    close(): void {
      if (closed) return;
      closed = true;
      db.exec(`DROP TABLE IF EXISTS temp.${CAS_RETRY_TEMP}`);
    },
  };
}
