/** Sealed multi-repository CAS inputs. A transition stage is the only way a
 * RepoRecord reaches the CAS, and every row carries its own source evidence. */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { RepoRecord, RepoRecordInput } from "../../sync-state-model.js";
import type { RepoBaseProof } from "../../sync-git/base-composer.js";
import { jsonCounter, jsonObject, type JsonObject, type JsonValue } from "../../../json.js";
import { encodeRepoRecord } from "../codecs/repo-record.js";
import { canonicalJson, parseCanonicalJson, retainedEstimate, utf16beOrderKey } from "../digest/codecs.js";
import {
  RepoTransitionDigestBuilder, sameStageBinding,
  type RepoTransitionDigest, type SourceStageBinding,
} from "../digest/repo-transition-v1.js";
import { ProoflessBaseError, StageChangedError, TransitionRowOversizeError } from "../errors.js";
import {
  assertBaseProof, assertDeclaredBindings, assertEvidence, canonicalEvidenceOf,
} from "./transition-admission.js";

export { assertBaseProof, assertEvidence, canonicalEvidenceOf } from "./transition-admission.js";
import type { LineageSnapshot } from "../ports.js";
import { PAGE_BYTES } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, abandonBuilder, configureStageBuilder, openSealedArtifact,
  sealAndPublish, sealedStagePath,
} from "./stage-artifacts.js";
import { runStatement, selectRow, streamRows } from "./statements.js";

const MAX_ROW_CANONICAL_BYTES = 8 * 1024 * 1024;
const MAX_ROW_RETAINED_BYTES = 24 * 1024 * 1024;

const TRANSITION_DDL = `
CREATE TABLE transition_meta(
  stage_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  snapshot_cjson TEXT NOT NULL, source_bindings_cjson TEXT NOT NULL,
  importer TEXT NOT NULL CHECK(importer='engine'),
  global_binding_cjson TEXT,
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

/** What this record derived from. Every named stage must appear verbatim in the
 * stage's own `sourceStageBindings`, and a stage that declared sources requires
 * every row to name at least one: a derived record with no evidence is exactly the
 * silent synthesis this seam must not admit. */
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
  /** The declared source stage that is THE global stage, when the packet has one.
   * Every derived row's evidence must name it exactly. */
  globalBinding?: SourceStageBinding;
  logicalDigest: RepoTransitionDigest;
  physicalSha256: string;
  bytes: number;
  rowCount: number;
  snapshotToken: LineageSnapshot;
  sourceStageBindings: SourceStageBinding[];
}

export type TransitionRow = TransitionInput;

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
  options: {
    stageId?: string;
    globalBinding?: SourceStageBinding;
  } = {},
): RepoTransitionStageBuilder {
  const globalBinding = options.globalBinding;
  if (globalBinding && !sourceStageBindings.some((binding) => sameStageBinding(binding, globalBinding))) {
    throw new TypeError("the global binding must also be declared as a source stage");
  }
  const stageId = options.stageId ?? crypto.randomBytes(16).toString("hex");
  assertDeclaredBindings(sourceStageBindings);
  const bindings = [...sourceStageBindings].sort((a, b) => (a.stageId < b.stageId ? -1 : a.stageId > b.stageId ? 1 : 0));
  const lock = StageLock.acquire(directory, stageId);
  let privateDirectory: PrivateStageDirectory | undefined;
  let db: Database | undefined;
  try {
    privateDirectory = PrivateStageDirectory.claim(lock);
    db = new Database(privateDirectory.file(), { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(TRANSITION_DDL);
    runStatement(db, `INSERT INTO transition_meta(stage_id,state,snapshot_cjson,source_bindings_cjson,importer,global_binding_cjson)
      VALUES (?,'building',?,?,?,?)`,
      stageId, canonicalJson(snapshotToken), canonicalJson(bindings), "engine",
      globalBinding === undefined ? null : canonicalJson(globalBinding),
    );
  } catch (error) {
    abandonBuilder(db, lock, privateDirectory);
    throw error;
  }
  return new SqliteTransitionBuilder(directory, stageId, snapshotToken, bindings, globalBinding, db, lock, privateDirectory);
}

class SqliteTransitionBuilder implements RepoTransitionStageBuilder {
  #open = true;
  #pendingBytes = 0;

  constructor(
    private readonly directory: string,
    readonly stageId: string,
    private readonly snapshotToken: LineageSnapshot,
    private readonly bindings: SourceStageBinding[],
    private readonly globalBinding: SourceStageBinding | undefined,
    private readonly db: Database,
    private readonly lock: StageLock,
    private readonly privateDirectory: PrivateStageDirectory,
  ) {
    this.db.exec("BEGIN");
  }

  putTransition(input: TransitionInput): void {
    if (!this.#open) throw new Error("transition stage builder is closed");
    this.lock.assertHeld();
    if (!Number.isSafeInteger(input.expectedRepoGen) || input.expectedRepoGen < 0) {
      throw new TypeError(`transition ${input.relPath} has an invalid expected generation`);
    }
    assertBaseProof(input);
    assertEvidence(input.relPath, input.evidenceBindings, this.bindings, this.globalBinding);
    // Pre-materialization scan: the complete row — record plus proof plus evidence
    // — is measured and refused BEFORE anything is encoded or written, so an
    // oversize row never reaches sealing or an authority write.
    const canonicalRecord = canonicalJson(input.newRecord);
    const canonicalProof = input.baseProof === undefined ? undefined : canonicalJson(input.baseProof);
    const canonicalEvidence = canonicalEvidenceOf(input.evidenceBindings);
    const rowCanonical = Buffer.byteLength(canonicalRecord)
      + Buffer.byteLength(canonicalProof ?? "") + Buffer.byteLength(canonicalEvidence);
    const retainedInput = input.baseProof === undefined ? {
      newRecord: input.newRecord,
      evidenceBindings: input.evidenceBindings,
    } : {
      newRecord: input.newRecord,
      baseProof: input.baseProof,
      evidenceBindings: input.evidenceBindings,
    };
    const rowRetained = retainedEstimate(retainedInput);
    if (rowCanonical > MAX_ROW_CANONICAL_BYTES || rowRetained > MAX_ROW_RETAINED_BYTES) {
      throw new TransitionRowOversizeError(input.relPath, rowCanonical, rowRetained);
    }
    // Inside the row ceiling, the record must still be one this store can hold.
    const encoded = encodeRepoRecord(input.relPath, { ...input.newRecord, repoGen: input.expectedRepoGen + 1 } as RepoRecord);
    if (this.#pendingBytes > 0 && this.#pendingBytes + rowRetained > PAGE_BYTES) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
      this.#pendingBytes = 0;
    }
    try {
      runStatement(this.db, `INSERT INTO transition_rows(stage_id,rel_path,path_order,expected_repo_gen,
        record_cjson,base_proof_cjson,evidence_cjson,canonical_bytes,retained_estimate)
        VALUES (?,?,?,?,?,?,?,?,?)`,
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
    try {
      const digest = new RepoTransitionDigestBuilder(this.snapshotToken, this.bindings, this.globalBinding);
      streamRows<PersistedTransitionRow>(this.db, TRANSITION_ROW_SELECT, [this.stageId], (row) => {
        revalidate(row, this.bindings, this.globalBinding);
        digest.row(digestRow(row));
      });
      const rowCount = digest.rows;
      const logicalDigest = digest.seal();
      runStatement(this.db, "UPDATE transition_meta SET state='sealed',digest=?,row_count=? WHERE stage_id=?",
        logicalDigest, rowCount, this.stageId);
      this.db.exec("COMMIT");
      this.#open = false;
      const physical = sealAndPublish(
        this.db, this.privateDirectory.file(),
        sealedStagePath(this.directory, this.stageId, logicalDigest), this.stageId,
      );
      this.privateDirectory.destroy();
      this.lock.release();
      const sealed = {
        stageId: this.stageId,
        logicalDigest, physicalSha256: physical.sha256, bytes: physical.bytes,
        rowCount, snapshotToken: this.snapshotToken, sourceStageBindings: this.bindings,
      };
      return this.globalBinding === undefined
        ? sealed
        : { ...sealed, globalBinding: this.globalBinding };
    } catch (error) {
      this.#open = false;
      abandonBuilder(this.db, this.lock, this.privateDirectory);
      throw error;
    }
  }

  discard(): void {
    if (!this.#open) return;
    this.#open = false;
    abandonBuilder(this.db, this.lock, this.privateDirectory);
  }
}

interface PersistedTransitionRow {
  rel_path: string;
  expected_repo_gen: number;
  record_cjson: string;
  base_proof_cjson: string | null;
  evidence_cjson: string;
}

const TRANSITION_ROW_SELECT = `SELECT rel_path,expected_repo_gen,record_cjson,base_proof_cjson,evidence_cjson
  FROM transition_rows WHERE stage_id=? ORDER BY path_order`;

const digestRow = (row: PersistedTransitionRow) => ({
  relPath: row.rel_path,
  expectedRepoGen: row.expected_repo_gen,
  canonicalRecord: row.record_cjson,
  canonicalBaseProof: row.base_proof_cjson ?? undefined,
  canonicalEvidenceBindings: row.evidence_cjson,
});

/**
 * The persisted spelling of a payload this seam admitted at put time.
 * `parseCanonicalJson` refuses non-canonical bytes; this re-establishes the JSON
 * container. What a payload MEANS stays with `transition-admission`, whose rules
 * run on every decoded row through `revalidate` and own the named refusals — a
 * proofless BASE must surface as a ProoflessBaseError, never as a decode
 * TypeError.
 */
/** The one container test every persisted-payload decode in this seam shares. */
export const isJsonObject = (value: JsonValue | undefined): value is JsonObject =>
  jsonObject(value);

function persistedObject(field: string, text: string): JsonObject {
  const value = parseCanonicalJson(text);
  if (!isJsonObject(value)) throw new TypeError(`transition ${field} is not a JSON object`);
  return value;
}

/** `sourceSeq` is RepoRecordInput's one required member; every other member is
 * optional and is re-established by `encodeRepoRecord` at the authority write. */
function assertRecordInput(value: JsonObject): asserts value is JsonObject & RepoRecordInput {
  if (jsonCounter(value.sourceSeq) === undefined) throw new TypeError("transition record has no sourceSeq");
}

function assertBaseProofPayload(value: JsonObject): asserts value is JsonObject & RepoBaseProof {
  // A proof's authority kind and prooflessness itself stay with assertBaseProof;
  // only the two members that make the value a proof
  // at all are established here.
  if (!isJsonObject(value.authority)) throw new TypeError("transition baseProof has no authority");
  if (!isJsonObject(value.lockedProof)) throw new TypeError("transition baseProof has no lockedProof");
}

function assertEvidenceBindings(value: JsonObject): asserts value is JsonObject & TransitionEvidenceBindings {
  if (!Array.isArray(value.sourceStages)) throw new TypeError("transition evidence has no sourceStages");
}

/** The record a transition carries, as persisted. */
export function decodeTransitionRecord(text: string): RepoRecordInput {
  const value = persistedObject("record", text);
  assertRecordInput(value);
  return value;
}

/** The explicit BASE authority proof a transition carries, as persisted. */
export function decodeTransitionBaseProof(text: string): RepoBaseProof {
  const value = persistedObject("baseProof", text);
  assertBaseProofPayload(value);
  return value;
}

/** The source-stage evidence a transition row carries, as persisted. */
export function decodeTransitionEvidence(text: string): TransitionEvidenceBindings {
  const value = persistedObject("evidenceBindings", text);
  assertEvidenceBindings(value);
  return value;
}

function decodeRow(row: PersistedTransitionRow): TransitionRow {
  const decoded = {
    relPath: row.rel_path,
    expectedRepoGen: row.expected_repo_gen,
    newRecord: decodeTransitionRecord(row.record_cjson),
    evidenceBindings: decodeTransitionEvidence(row.evidence_cjson),
  };
  return row.base_proof_cjson === null
    ? decoded
    : { ...decoded, baseProof: decodeTransitionBaseProof(row.base_proof_cjson) };
}

/** The row's OWN evidence is re-admitted; nothing is substituted from the stage. */
function revalidate(
  row: PersistedTransitionRow,
  declared: SourceStageBinding[],
  globalBinding?: SourceStageBinding,
): TransitionRow {
  const decoded = decodeRow(row);
  assertBaseProof(decoded);
  assertEvidence(decoded.relPath, decoded.evidenceBindings, declared, globalBinding);
  return decoded;
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
  const accessor = openSealedArtifact(directory, ref, lock);
  try {
    const meta = selectRow<{
      stage_id: string; state: string; snapshot_cjson: string; source_bindings_cjson: string;
      importer: "engine"; global_binding_cjson: string | null;
      digest: string; row_count: number;
    }>(accessor.db, `SELECT stage_id,state,snapshot_cjson,source_bindings_cjson,importer,
      global_binding_cjson,digest,row_count FROM transition_meta`);
    if (!meta || meta.stage_id !== ref.stageId || meta.state !== "sealed") {
      throw new StageChangedError(ref.stageId, "sealed transition identity does not match its ref");
    }
    // The sealed bytes must be canonical, and canonical bytes are the value's one
    // spelling — so comparing them to the ref's spelling below is the whole
    // identity check. What the sealed global binding IS therefore comes from the
    // ref, which the caller already holds as a typed binding.
    if (meta.global_binding_cjson !== null) parseCanonicalJson(meta.global_binding_cjson);
    if (meta.snapshot_cjson !== canonicalJson(ref.snapshotToken)
      || meta.source_bindings_cjson !== canonicalJson(ref.sourceStageBindings)
      || (meta.global_binding_cjson ?? canonicalJson(null)) !== canonicalJson(ref.globalBinding ?? null)) {
      throw new StageChangedError(ref.stageId, "sealed transition snapshot, source bindings, or global binding do not match its ref");
    }
    const sealedGlobal = ref.globalBinding;
    const digest = new RepoTransitionDigestBuilder(ref.snapshotToken, ref.sourceStageBindings, sealedGlobal);
    streamRows<PersistedTransitionRow>(accessor.db, TRANSITION_ROW_SELECT, [ref.stageId], (row) => {
      revalidate(row, ref.sourceStageBindings, sealedGlobal);
      digest.row(digestRow(row));
    });
    if (digest.rows !== ref.rowCount || digest.seal() !== ref.logicalDigest || meta.digest !== ref.logicalDigest) {
      throw new StageChangedError(ref.stageId, "sealed transition logical digest does not match its ref");
    }
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    // A sealed row that no longer decodes or no longer passes admission is a
    // changed artifact, not a caller mistake; only the proof rule keeps its own
    // name so a proofless row reaching a CAS is never reported as mere tampering.
    if (error instanceof StageChangedError || error instanceof ProoflessBaseError) throw error;
    throw new StageChangedError(ref.stageId, `sealed transition is not readable as sealed: ${String(error)}`);
  }
  return {
    streamRows(visit): number {
      return streamRows<PersistedTransitionRow>(accessor.db, TRANSITION_ROW_SELECT, [ref.stageId],
        (row) => visit(decodeRow(row)));
    },
    close(): void {
      accessor.close();
    },
  };
}
