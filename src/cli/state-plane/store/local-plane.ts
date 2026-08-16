/** LOCAL-plane transactions.
 *
 * LOCAL is rebuildable, so it needs no CAS packet: a scan promotes a sealed stage
 * by set-difference and a watcher invalidates completeness before disk mutation.
 * Both bump the LOCAL head, which is what every push/trusted-status predicate reads
 * through the lineage snapshot token. As on the global side, the header that
 * commits is the one the stage was sealed with. */
import type { Database } from "bun:sqlite";
import { jsonText } from "../../../json.js";
import { canonicalJson } from "../digest/codecs.js";
import { StageChangedError } from "../errors.js";
import type { LineageSnapshot, ManifestHeader } from "../ports.js";
import {
  copyStageFilesIntoTemp, createStageFileTemp, dropStageFileTemp, internStagedEntryValues,
  promoteFilesIntoPlane,
} from "./plane-promotion.js";
import { stateStoreDatabase, type StateStoreHandle } from "./open.js";
import { runStatement, selectRow } from "./statements.js";
import { currentSnapshot } from "./read-snapshot.js";
import { openSealedStageForConsume, type SealedStageRef } from "./sealed-stages.js";
import { StageLock, deleteSealedArtifact } from "./stage-artifacts.js";

export interface LocalScanResult {
  localRevision: number;
  token: LineageSnapshot;
}

/**
 * Finalize a full LOCAL scan. Only a full scan may set `complete=1`, and it does so
 * in the same transaction that installs the trust epoch the completeness claim is
 * about — a later reader can never see one without the other. The trust epoch is
 * read from the sealed header, so a stage sealed under epoch A can never commit
 * epoch B.
 */
export function applyLocalScan(
  store: StateStoreHandle,
  stageDirectory: string,
  stage: SealedStageRef,
  expected: { lineageId: string; localRevision: number },
): LocalScanResult {
  if (store.readonly) throw new Error("state store is open read-only");
  if (stage.plane !== "local") throw new StageChangedError(stage.stageId, "a LOCAL scan requires a LOCAL stage");
  if (stage.counts.gitSections !== 0) throw new StageChangedError(stage.stageId, "a LOCAL stage carries no Git sections");
  if (!jsonText(stage.header.trustEpoch) || stage.header.trustEpoch.length === 0) {
    throw new StageChangedError(stage.stageId, "a completed LOCAL scan must be sealed with its trust epoch");
  }
  const db = stateStoreDatabase(store);
  createStageFileTemp(db);
  try {
    const lock = StageLock.acquire(stageDirectory, stage.stageId);
    try {
      const reader = openSealedStageForConsume(stageDirectory, stage, lock);
      try {
        const copied = copyStageFilesIntoTemp(db, reader);
        if (copied !== stage.counts.files) {
          throw new StageChangedError(stage.stageId, "sealed stage file count changed while streaming");
        }
      } finally {
        reader.close();
      }
      // Adoption AND refusal both end the stage's life, so the id-scoped delete
      // runs either way under the lock that owned the whole consumption interval.
      let result: LocalScanResult;
      try {
        result = promote(db, stage, expected);
      } catch (error) {
        deleteSealedArtifact(stageDirectory, stage, lock);
        throw error;
      }
      deleteSealedArtifact(stageDirectory, stage, lock);
      return result;
    } finally {
      lock.release();
    }
  } finally {
    dropStageFileTemp(db);
  }
}

function promote(
  db: Database,
  stage: SealedStageRef,
  expected: { lineageId: string; localRevision: number },
): LocalScanResult {
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = selectRow<{ generation: number }>(
      db, "SELECT generation FROM plane_heads WHERE lineage_id=? AND plane='local'", expected.lineageId);
    if (!current) throw new Error("state store LOCAL head disappeared");
    if (current.generation !== expected.localRevision) {
      throw new StageChangedError(stage.stageId, `LOCAL head moved to ${current.generation}, expected ${expected.localRevision}`);
    }
    const generation = expected.localRevision + 1;
    internStagedEntryValues(db);
    promoteFilesIntoPlane(db, expected.lineageId, "local", generation);
    const header: ManifestHeader = stage.header;
    const { generatedAt, manifestSchema, sourceSequence, trustEpoch, complete: _complete, ...extras } = header;
    runStatement(db, `UPDATE plane_heads SET generation=?,generated_at=?,manifest_schema=?,source_sequence=?,
      trust_epoch=?,complete=1,extras_cjson=? WHERE lineage_id=? AND plane='local'`,
      generation, generatedAt, manifestSchema ?? null, sourceSequence ?? null, trustEpoch as string,
      Object.keys(extras).length === 0 ? null : canonicalJson(extras), expected.lineageId,
    );
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
  return { localRevision: expected.localRevision + 1, token: currentSnapshot(db) };
}

/**
 * Watcher invalidation. Clearing `complete` bumps the LOCAL head too: a predicate
 * that already read the previous token must be forced to re-read rather than keep
 * treating a now-untrusted plane as a full scan.
 */
export function invalidateLocalPlane(store: StateStoreHandle, lineageId: string): LocalScanResult {
  if (store.readonly) throw new Error("state store is open read-only");
  const db = stateStoreDatabase(store);
  db.exec("BEGIN IMMEDIATE");
  try {
    const current = selectRow<{ generation: number; complete: number }>(
      db, "SELECT generation,complete FROM plane_heads WHERE lineage_id=? AND plane='local'", lineageId);
    if (!current) throw new Error("state store LOCAL head disappeared");
    runStatement(db, "UPDATE plane_heads SET generation=?,complete=0,trust_epoch=NULL WHERE lineage_id=? AND plane='local'",
      current.generation + 1, lineageId);
    db.exec("COMMIT");
    return { localRevision: current.generation + 1, token: currentSnapshot(db) };
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
