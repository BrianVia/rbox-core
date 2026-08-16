/** Sealed relative-global CAS inputs (design 269).
 *
 * A delta stage is the only way a `stage-delta-v1` global reaches the CAS. It is
 * built, sealed, and published through the same normative artifact substrate as a
 * complete stage, and it is consumed by ONE fused pass that yields the ops while
 * accumulating the digest, verified at end-of-stream.
 */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { FileEntry } from "../../../engine/index.js";
import type { DeltaBinding } from "../../sync-state-model.js";
import { encodeFileEntryForConsume, type ConsumedFileEntry } from "../codecs/file-entry.js";
import { canonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import {
  StageDeltaDigestBuilder, type DeltaCounts, type StageDeltaLogicalDigest,
} from "../digest/stage-delta-v1.js";
import { StageChangedError } from "../errors.js";
import type { ManifestHeader, Plane } from "../ports.js";
import { PAGE_BYTES } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, abandonBuilder, configureStageBuilder, openSealedArtifact,
  sealAndPublish, sealedStagePath,
} from "./stage-artifacts.js";
import { runStatement, selectRow, streamRows } from "./statements.js";

const DELTA_DDL = `
CREATE TABLE delta_meta(
  stage_id TEXT PRIMARY KEY, plane TEXT NOT NULL CHECK(plane IN ('base','local')),
  state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  header_cjson TEXT NOT NULL, binding_cjson TEXT NOT NULL,
  digest TEXT, counts_cjson TEXT,
  CHECK(state='building' OR (digest IS NOT NULL AND counts_cjson IS NOT NULL))
);
CREATE TABLE delta_ops(
  stage_id TEXT NOT NULL, path TEXT NOT NULL, path_order BLOB NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('upsert','delete')), entry_cjson TEXT,
  CHECK((kind='upsert') = (entry_cjson IS NOT NULL)),
  PRIMARY KEY(stage_id,path)
);
CREATE INDEX delta_ops_order ON delta_ops(stage_id,path_order);
`;

export interface SealedDeltaStageRef {
  stageId: string;
  plane: Plane;
  /** The header this delta was SEALED with — the only header it may commit. */
  header: ManifestHeader;
  /** The predecessor this delta is relative to, sealed into the artifact. */
  binding: DeltaBinding;
  logicalDigest: StageDeltaLogicalDigest;
  physicalSha256: string;
  bytes: number;
  counts: DeltaCounts;
}

export interface DeltaStageBuilder {
  readonly stageId: string;
  putUpsert(entry: FileEntry): void;
  putDelete(path: string): void;
  finishDeltaStage(expectedCounts: DeltaCounts): SealedDeltaStageRef;
  discardDeltaStage(): void;
}

export function beginDeltaStage(
  directory: string,
  plane: Plane,
  header: ManifestHeader,
  binding: DeltaBinding,
  stageId: string = crypto.randomBytes(16).toString("hex"),
): DeltaStageBuilder {
  const lock = StageLock.acquire(directory, stageId);
  let privateDirectory: PrivateStageDirectory | undefined;
  let db: Database | undefined;
  try {
    privateDirectory = PrivateStageDirectory.claim(lock);
    db = new Database(privateDirectory.file(), { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(DELTA_DDL);
    runStatement(db, "INSERT INTO delta_meta(stage_id,plane,state,header_cjson,binding_cjson) VALUES (?,?,'building',?,?)",
      stageId, plane, canonicalJson(header), canonicalBinding(binding));
  } catch (error) {
    abandonBuilder(db, lock, privateDirectory);
    throw error;
  }
  return new SqliteDeltaStageBuilder(directory, stageId, plane, header, binding, db, lock, privateDirectory);
}

export const canonicalBinding = (binding: DeltaBinding): string =>
  canonicalJson({ nonce: binding.nonce, stateRevision: binding.stateRevision });

class SqliteDeltaStageBuilder implements DeltaStageBuilder {
  #open = true;
  #pendingBytes = 0;
  #lastPath: string | undefined;
  readonly #digest: StageDeltaDigestBuilder;

  constructor(
    private readonly directory: string,
    readonly stageId: string,
    private readonly plane: Plane,
    private readonly header: ManifestHeader,
    private readonly binding: DeltaBinding,
    private readonly db: Database,
    private readonly lock: StageLock,
    private readonly privateDirectory: PrivateStageDirectory,
  ) {
    this.#digest = new StageDeltaDigestBuilder(stageId, plane, header, binding);
    this.db.exec("BEGIN");
  }

  putUpsert(entry: FileEntry): void {
    const encoded = encodeFileEntryForConsume(entry);
    this.#admitPath(encoded.path, encoded.retainedEstimate);
    runStatement(this.db, "INSERT INTO delta_ops(stage_id,path,path_order,kind,entry_cjson) VALUES (?,?,?,'upsert',?)",
      this.stageId, encoded.path, encoded.pathOrder, encoded.canonical);
    this.#digest.upsert(encoded.path, encoded.canonical);
  }

  putDelete(path: string): void {
    this.#admitPath(path, path.length * 2);
    runStatement(this.db, "INSERT INTO delta_ops(stage_id,path,path_order,kind,entry_cjson) VALUES (?,?,?,'delete',NULL)",
      this.stageId, path, utf16beOrderKey(path));
    this.#digest.delete(path);
  }

  finishDeltaStage(expectedCounts: DeltaCounts): SealedDeltaStageRef {
    this.#assertOpen();
    try {
      const logicalDigest = this.#digest.seal(expectedCounts);
      runStatement(this.db, "UPDATE delta_meta SET state='sealed',digest=?,counts_cjson=? WHERE stage_id=?",
        logicalDigest, canonicalJson(expectedCounts), this.stageId);
      this.db.exec("COMMIT");
      this.#open = false;
      const physical = sealAndPublish(
        this.db, this.privateDirectory.file(),
        sealedStagePath(this.directory, this.stageId, logicalDigest), this.stageId,
      );
      this.privateDirectory.destroy();
      this.lock.release();
      return {
        stageId: this.stageId, plane: this.plane, header: this.header, binding: this.binding,
        logicalDigest, physicalSha256: physical.sha256, bytes: physical.bytes, counts: expectedCounts,
      };
    } catch (error) {
      this.#open = false;
      abandonBuilder(this.db, this.lock, this.privateDirectory);
      throw error;
    }
  }

  discardDeltaStage(): void {
    if (!this.#open) return;
    this.#open = false;
    abandonBuilder(this.db, this.lock, this.privateDirectory);
  }

  /** One ordered op sequence: strictly ascending across BOTH kinds, so a
   * duplicated or reordered path is refused before any row exists. */
  #admitPath(path: string, rowBytes: number): void {
    this.#assertOpen();
    if (this.#lastPath !== undefined && this.#lastPath >= path) {
      throw new TypeError(`delta op ${path} is not strictly after ${this.#lastPath}`);
    }
    if (this.#pendingBytes > 0 && this.#pendingBytes + rowBytes > PAGE_BYTES) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
      this.#pendingBytes = 0;
    }
    this.#lastPath = path;
    this.#pendingBytes += rowBytes;
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error("delta stage builder is closed");
    this.lock.assertHeld();
  }
}

/** One op as the consumer receives it: an upsert carries the admitted value. */
export type ConsumedDeltaOp =
  | { kind: "upsert"; path: string; entry: ConsumedFileEntry }
  | { kind: "delete"; path: string };

export interface ConsumedDeltaReader {
  readonly sealedHeader: ManifestHeader;
  readonly sealedBinding: DeltaBinding;
  readonly resultFiles: number;
  /** Yields every op in path order and verifies the artifact at end-of-stream. */
  streamOps(visit: (op: ConsumedDeltaOp) => void): number;
  close(): void;
}

interface DeltaMetaRow {
  stage_id: string; plane: Plane; state: string;
  header_cjson: string; binding_cjson: string; digest: string; counts_cjson: string;
}

/**
 * Verify and open one sealed delta under its own id-scoped lock. Metadata is
 * proven before any op is yielded; the ops themselves are proven by the fused
 * digest at end-of-stream, before the consumer's copy can reach authority.
 */
export function openSealedDeltaStageForConsume(
  directory: string,
  ref: SealedDeltaStageRef,
  lock: StageLock,
): ConsumedDeltaReader {
  const accessor = openSealedArtifact(directory, ref, lock);
  try {
    const meta = selectRow<DeltaMetaRow>(accessor.db,
      "SELECT stage_id,plane,state,header_cjson,binding_cjson,digest,counts_cjson FROM delta_meta");
    if (!meta || meta.stage_id !== ref.stageId || meta.state !== "sealed") {
      throw new StageChangedError(ref.stageId, "sealed delta identity does not match its ref");
    }
    // Canonical bytes are a value's ONE spelling, so comparing them to the ref's
    // spelling is the whole metadata identity check.
    if (meta.plane !== ref.plane || meta.digest !== ref.logicalDigest
      || meta.header_cjson !== canonicalJson(ref.header)
      || meta.binding_cjson !== canonicalBinding(ref.binding)
      || meta.counts_cjson !== canonicalJson(ref.counts)) {
      throw new StageChangedError(ref.stageId, "sealed delta metadata does not match its ref");
    }
    return {
      sealedHeader: ref.header,
      sealedBinding: ref.binding,
      resultFiles: ref.counts.resultFiles,
      streamOps(visit: (op: ConsumedDeltaOp) => void): number {
        return streamDeltaOps(accessor.db, ref, visit);
      },
      close(): void {
        accessor.close();
      },
    };
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    throw error;
  }
}

function streamDeltaOps(
  db: Database,
  ref: SealedDeltaStageRef,
  visit: (op: ConsumedDeltaOp) => void,
): number {
  const digest = new StageDeltaDigestBuilder(ref.stageId, ref.plane, ref.header, ref.binding);
  let lastPath: string | undefined;
  const copied = streamRows<{ path: string; kind: string; entry_cjson: string | null }>(
    db, "SELECT path,kind,entry_cjson FROM delta_ops WHERE stage_id=? ORDER BY path_order",
    [ref.stageId], (row) => {
      if (lastPath !== undefined && lastPath >= row.path) {
        throw new StageChangedError(ref.stageId, `sealed delta op ${row.path} is not strictly after ${lastPath}`);
      }
      lastPath = row.path;
      if (row.kind === "delete") {
        if (row.entry_cjson !== null) throw new StageChangedError(ref.stageId, `sealed delta delete ${row.path} carries a value`);
        digest.delete(row.path);
        visit({ kind: "delete", path: row.path });
        return;
      }
      if (row.kind !== "upsert" || row.entry_cjson === null) {
        throw new StageChangedError(ref.stageId, `sealed delta op ${row.path} has no known kind`);
      }
      const entry = encodeFileEntryForConsume(JSON.parse(row.entry_cjson) as FileEntry);
      if (entry.path !== row.path || entry.canonical !== row.entry_cjson) {
        throw new StageChangedError(ref.stageId, `sealed delta row ${row.path} is not canonical`);
      }
      digest.upsert(entry.path, entry.canonical);
      visit({ kind: "upsert", path: entry.path, entry });
    });
  if (copied !== ref.counts.upserts + ref.counts.deletes
    || digest.counts.upserts !== ref.counts.upserts || digest.counts.deletes !== ref.counts.deletes) {
    throw new StageChangedError(ref.stageId, "sealed delta op count changed while streaming");
  }
  if (digest.seal(ref.counts) !== ref.logicalDigest) {
    throw new StageChangedError(ref.stageId, "sealed delta logical digest does not match its ref");
  }
  return copied;
}
