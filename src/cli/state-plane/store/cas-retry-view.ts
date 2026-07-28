/**
 * The sealed, file-backed `CasRetryView` a rejected CAS returns.
 *
 * It is an artifact in its own right, not a table on the authority connection: it
 * gets its own id, its own exclusive lock, its own private directory, the same
 * seal-and-prove protocol as every other stage, and its own delete-on-close. Two
 * concurrent rejections therefore cannot clobber each other's view, and closing one
 * cannot empty another.
 */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import { decodeRepoRecord, type RepoRecordRow } from "../codecs/repo-record.js";
import { canonicalJson, domainHash, utf16beOrderKey } from "../digest/codecs.js";
import { CursorWindowError, StageChangedError } from "../errors.js";
import type { CasRetryRepo, CasRetryView, CursorPage, LineageSnapshot } from "../ports.js";
import { PAGE_BYTES, boundedStream } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, abandonBuilder, configureStageBuilder, deleteSealedArtifact,
  openSealedArtifact, sealAndPublish, sealedStagePath, streamRows,
} from "./stage-artifacts.js";
import { CAS_TRANSITION_TEMP } from "./transition-stages.js";

const MAX_RETRY_BATCH = 16;
const MAX_RETRY_ROW_RETAINED = 16 * 1024 * 1024;

const RETRY_DDL = `
CREATE TABLE retry_meta(
  retry_id TEXT PRIMARY KEY, state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  token_cjson TEXT NOT NULL, digest TEXT, row_count INTEGER
);
CREATE TABLE retry_rows(
  retry_id TEXT NOT NULL, rel_path TEXT NOT NULL, path_order BLOB NOT NULL,
  expected_repo_gen INTEGER NOT NULL, record_row_cjson TEXT,
  retained_estimate INTEGER NOT NULL,
  PRIMARY KEY(retry_id,rel_path)
);
CREATE INDEX retry_rows_order ON retry_rows(retry_id,path_order);
`;

/** Explicit columns: `path_order` is a BLOB whose JSON spelling would bloat the
 * frozen row for no reader, and the decoder never looks at it. */
const CURRENT_RECORD_SELECT = `SELECT rel_path,repo_gen,source_seq,base_cjson,advertised_cjson,
  branch_base_origins_cjson,packed_refs_identity,pending_cjson,repo_absent,removed_key,
  resolution_key,cfg_synced,cfg_applied,cfg_token_cjson,cfg_shape_cjson,deferrals_cjson,
  partial_cjson,attempt_cjson,resolution_receipt_cjson,idx_proj,extras_cjson,
  canonical_bytes,retained_estimate FROM repo_records WHERE lineage_id=? AND rel_path=?`;

interface RetryRowShape {
  rel_path: string;
  expected_repo_gen: number;
  record_row_cjson: string | null;
  retained_estimate: number;
}

/**
 * Freeze the ordered join of the packet's touched paths to the authority's current
 * records into a sealed artifact, inside one bounded authority transaction the
 * caller owns. Paging it afterwards cannot tear, and the view reports the exact
 * token it was built under.
 */
export function buildCasRetryView(
  authority: Database,
  directory: string,
  token: LineageSnapshot,
): CasRetryView {
  const retryId = crypto.randomBytes(16).toString("hex");
  const lock = StageLock.acquire(directory, retryId);
  let privateDirectory: PrivateStageDirectory | undefined;
  let db: Database | undefined;
  let ref: { stageId: string; logicalDigest: string; physicalSha256: string };
  try {
    privateDirectory = PrivateStageDirectory.claim(lock);
    db = new Database(privateDirectory.file(), { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(RETRY_DDL);
    db.query("INSERT INTO retry_meta(retry_id,state,token_cjson) VALUES (?,'building',?)")
      .run(retryId, canonicalJson(token));
    const digest = domainHash("cas-retry-view-v1");
    digest.token(canonicalJson(token));
    const lookup = authority.query(CURRENT_RECORD_SELECT);
    const insert = db.query(`INSERT INTO retry_rows(retry_id,rel_path,path_order,expected_repo_gen,record_row_cjson,retained_estimate)
      VALUES (?,?,?,?,?,?)`);
    db.exec("BEGIN");
    let rowCount = 0;
    streamRows<{ rel_path: string; path_order: Uint8Array; expected_repo_gen: number }>(
      authority, `SELECT rel_path,path_order,expected_repo_gen FROM ${CAS_TRANSITION_TEMP} ORDER BY path_order`,
      [], (row) => {
        const current = lookup.get(token.lineageId, row.rel_path) as RepoRecordRow | null;
        const frozen = current === null ? null : JSON.stringify(current);
        digest.token(row.rel_path);
        digest.token(String(row.expected_repo_gen));
        digest.token(frozen ?? "");
        insert.run(
          retryId, row.rel_path, Buffer.from(row.path_order), row.expected_repo_gen,
          frozen, current?.retained_estimate ?? 4096,
        );
        rowCount++;
      });
    const logicalDigest = digest.digest();
    db.query("UPDATE retry_meta SET state='sealed',digest=?,row_count=? WHERE retry_id=?")
      .run(logicalDigest, rowCount, retryId);
    db.exec("COMMIT");
    const physical = sealAndPublish(
      db, privateDirectory.file(), sealedStagePath(directory, retryId, logicalDigest), retryId,
    );
    privateDirectory.destroy();
    ref = { stageId: retryId, logicalDigest, physicalSha256: physical.sha256 };
  } catch (error) {
    abandonBuilder(db, lock, privateDirectory);
    throw error;
  }
  return openSealedRetryView(directory, ref, token, lock);
}

function openSealedRetryView(
  directory: string,
  ref: { stageId: string; logicalDigest: string; physicalSha256: string },
  token: LineageSnapshot,
  lock: StageLock,
): CasRetryView {
  const accessor = openSealedArtifact(directory, ref, lock);
  try {
    const meta = accessor.db.query("SELECT retry_id,state,token_cjson,digest FROM retry_meta").get() as {
      retry_id: string; state: string; token_cjson: string; digest: string;
    } | null;
    if (!meta || meta.retry_id !== ref.stageId || meta.state !== "sealed"
      || meta.digest !== ref.logicalDigest || meta.token_cjson !== canonicalJson(token)) {
      throw new StageChangedError(ref.stageId, "sealed retry view does not match its ref");
    }
  } catch (error) {
    try { accessor.close(); } catch { /* the original refusal is the report */ }
    lock.release();
    throw error;
  }
  let closed = false;
  return {
    token,
    touchedRepos(afterRelPath: string | undefined, batchSize: number): CursorPage<CasRetryRepo> {
      if (closed) throw new Error("retry view is closed");
      if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_RETRY_BATCH) {
        throw new CursorWindowError("repo", batchSize, MAX_RETRY_BATCH);
      }
      const after = afterRelPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterRelPath);
      return boundedStream<RetryRowShape, CasRetryRepo>(
        (visit) => streamRows(accessor.db, `SELECT rel_path,expected_repo_gen,record_row_cjson,retained_estimate
          FROM retry_rows WHERE retry_id=? AND path_order>? ORDER BY path_order LIMIT ?`,
        [ref.stageId, after, batchSize], visit),
        batchSize,
        (row) => {
          if (row.retained_estimate > MAX_RETRY_ROW_RETAINED) {
            throw new CursorWindowError("repo", row.retained_estimate, MAX_RETRY_ROW_RETAINED);
          }
          return row.retained_estimate;
        },
        (row) => ({
          relPath: row.rel_path,
          expectedRepoGen: row.expected_repo_gen,
          ...(row.record_row_cjson === null
            ? {}
            : { record: decodeRepoRecord(JSON.parse(row.record_row_cjson) as RepoRecordRow) }),
        }),
        (row) => row.rel_path,
      );
    },
    close(): void {
      if (closed) return;
      closed = true;
      try {
        accessor.close();
        deleteSealedArtifact(directory, ref, lock);
      } finally {
        lock.release();
      }
    },
  };
}

export const RETRY_PAGE_BYTES = PAGE_BYTES;
