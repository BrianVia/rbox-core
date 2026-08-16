/** Building a file/Git generation stage.
 *
 * A generation is built inside its own private directory and sealed by the
 * normative commit → checkpoint TRUNCATE → close → S0 → fsync → prove → link
 * sequence. No stage is ever attached as writable authority, and no stage
 * pathname is reopened after verification. What a sealed stage then does to a
 * plane belongs to `plane-promotion.ts`. */
import { Database } from "bun:sqlite";
import crypto from "node:crypto";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { encodeFileEntry, encodeFileEntryForStage, fileEntryFromCanonical } from "../codecs/file-entry.js";
import { encodeGitSection } from "../codecs/git-section.js";
import { canonicalJson, parseCanonicalJson, utf16beOrderKey } from "../digest/codecs.js";
import { StageDigestBuilder, type StageCounts } from "../digest/stage-semantic-v1.js";
import { CursorWindowError, GitSectionOversizeError, StageChangedError } from "../errors.js";
import type { GitSectionRole, ManifestHeader, Plane } from "../ports.js";
import { MAX_FILE_BATCH, PAGE_BYTES, type SealedStageRef } from "./sealed-stages.js";
import {
  PrivateStageDirectory, StageLock, abandonBuilder, configureStageBuilder, sealAndPublish,
  sealedStagePath,
} from "./stage-artifacts.js";
import { runStatement, streamRows } from "./statements.js";

export const STAGE_DDL = `
CREATE TABLE stage_meta(
  stage_id TEXT PRIMARY KEY, plane TEXT NOT NULL CHECK(plane IN ('base','local')),
  state TEXT NOT NULL CHECK(state IN ('building','sealed')),
  header_cjson TEXT NOT NULL, digest TEXT, counts_cjson TEXT,
  CHECK(state='building' OR (digest IS NOT NULL AND counts_cjson IS NOT NULL))
);
CREATE TABLE stage_entries(
  stage_id TEXT NOT NULL, path TEXT NOT NULL, path_order BLOB NOT NULL,
  entry_cjson TEXT NOT NULL, PRIMARY KEY(stage_id,path)
);
CREATE INDEX stage_entries_order ON stage_entries(stage_id,path_order);
CREATE TABLE stage_git_roles(stage_id TEXT NOT NULL, role TEXT NOT NULL, PRIMARY KEY(stage_id,role));
CREATE TABLE stage_git_sections(
  stage_id TEXT NOT NULL, role TEXT NOT NULL, rel_path TEXT NOT NULL,
  path_order BLOB NOT NULL, section_cjson TEXT NOT NULL,
  PRIMARY KEY(stage_id,role,rel_path)
);
CREATE INDEX stage_git_sections_order ON stage_git_sections(stage_id,role,path_order);
`;

export interface GenerationBuilder {
  readonly stageId: string;
  putEntries(entries: readonly FileEntry[]): void;
  declareGitRole(role: GitSectionRole): void;
  putGitSection(role: GitSectionRole, relPath: string, section: GitSection): void;
  finishGeneration(expectedCounts: StageCounts): SealedStageRef;
  discardGeneration(): void;
}

export function beginGeneration(
  directory: string,
  plane: Plane,
  header: ManifestHeader,
  stageId: string = crypto.randomBytes(16).toString("hex"),
): GenerationBuilder {
  const lock = StageLock.acquire(directory, stageId);
  let privateDirectory: PrivateStageDirectory | undefined;
  let db: Database | undefined;
  try {
    privateDirectory = PrivateStageDirectory.claim(lock);
    db = new Database(privateDirectory.file(), { create: true, readwrite: true });
    configureStageBuilder(db);
    db.exec(STAGE_DDL);
    runStatement(db, "INSERT INTO stage_meta(stage_id,plane,state,header_cjson) VALUES (?,?,'building',?)",
      stageId, plane, canonicalJson(header));
  } catch (error) {
    abandonBuilder(db, lock, privateDirectory);
    throw error;
  }
  return new SqliteGenerationBuilder(directory, stageId, plane, header, db, lock, privateDirectory);
}

class SqliteGenerationBuilder implements GenerationBuilder {
  #open = true;
  #pendingBytes = 0;
  readonly #digest: StageDigestBuilder;
  #ordered = true;
  #lastFilePath: string | undefined;
  #lastGitKey: string | undefined;

  constructor(
    private readonly directory: string,
    readonly stageId: string,
    private readonly plane: Plane,
    private readonly header: ManifestHeader,
    private readonly db: Database,
    private readonly lock: StageLock,
    private readonly privateDirectory: PrivateStageDirectory,
  ) {
    this.#digest = new StageDigestBuilder(stageId, plane, header);
    this.db.exec("BEGIN");
  }

  putEntries(entries: readonly FileEntry[]): void {
    this.#assertOpen();
    if (entries.length > MAX_FILE_BATCH) throw new CursorWindowError("file", entries.length, MAX_FILE_BATCH);
    const pending: ReturnType<typeof encodeFileEntryForStage>[] = [];
    const insertPending = (): void => {
      if (pending.length === 0) return;
      const batch = pending.splice(0);
      const values = batch.map(() => "(?,?,?,?)").join(",");
      const bindings = batch.flatMap((encoded) =>
        [this.stageId, encoded.path, encoded.pathOrder, encoded.canonical]);
      try {
        runStatement(this.db, `INSERT INTO stage_entries(stage_id,path,path_order,entry_cjson) VALUES ${values}`,
          ...bindings);
        for (const encoded of batch) this.#adoptInsertedEntry(encoded);
      } catch {
        // A multi-row statement is atomic. Replaying rowwise after its failure
        // preserves the original prefix-admission and exact SQLite refusal.
        for (const encoded of batch) {
          runStatement(this.db, "INSERT INTO stage_entries(stage_id,path,path_order,entry_cjson) VALUES (?,?,?,?)",
            this.stageId, encoded.path, encoded.pathOrder, encoded.canonical);
          this.#adoptInsertedEntry(encoded);
        }
      }
    };
    try {
      for (const entry of entries) {
        const encoded = encodeFileEntryForStage(entry);
        if (this.#pendingBytes > 0 && this.#pendingBytes + encoded.retainedEstimate > PAGE_BYTES) {
          insertPending();
          this.db.exec("COMMIT");
          this.db.exec("BEGIN");
          this.#pendingBytes = 0;
        }
        pending.push(encoded);
        this.#pendingBytes += encoded.retainedEstimate;
      }
      insertPending();
    } catch (error) {
      if (pending.length > 0) insertPending();
      throw error;
    }
  }

  #adoptInsertedEntry(encoded: ReturnType<typeof encodeFileEntryForStage>): void {
    if (this.#ordered && this.#lastGitKey === undefined
      && (this.#lastFilePath === undefined || this.#lastFilePath < encoded.path)) {
      this.#digest.file(encoded.canonical);
      this.#lastFilePath = encoded.path;
    } else {
      this.#ordered = false;
    }
  }

  declareGitRole(role: GitSectionRole): void {
    this.#assertOpen();
    runStatement(this.db, "INSERT OR IGNORE INTO stage_git_roles(stage_id,role) VALUES (?,?)", this.stageId, role);
    this.#digest.declareRole(role);
  }

  putGitSection(role: GitSectionRole, relPath: string, section: GitSection): void {
    this.#assertOpen();
    // Malformed path/section from a caller is a TypeError here, before any row
    // is written — the same admission the RepoRecord codec applies to its base/
    // advertised/pending sections. The stored bytes are then the exact canonical
    // spelling the digest covers.
    const encoded = encodeGitSection(relPath, section);
    if (encoded.bytes > PAGE_BYTES) throw new GitSectionOversizeError(relPath, encoded.bytes);
    this.#flushBefore(encoded.bytes);
    this.declareGitRole(role);
    runStatement(this.db, "INSERT INTO stage_git_sections(stage_id,role,rel_path,path_order,section_cjson) VALUES (?,?,?,?,?)",
      this.stageId, role, relPath, utf16beOrderKey(relPath), encoded.canonical);
    const key = `${role}\0${relPath}`;
    if (this.#ordered && (this.#lastGitKey === undefined || this.#lastGitKey < key)) {
      this.#digest.gitSection(role, relPath, encoded.canonical);
      this.#lastGitKey = key;
    } else {
      this.#ordered = false;
    }
    this.#pendingBytes += encoded.bytes;
  }

  finishGeneration(expectedCounts: StageCounts): SealedStageRef {
    this.#assertOpen();
    try {
      const digest = this.#ordered && process.env.RBOX_STATE_VERIFY_STAGE !== "1"
        ? this.#digest
        : this.#verifiedDigest();
      const counts = digest.counts;
      const logicalDigest = digest.seal(expectedCounts);
      runStatement(this.db, "UPDATE stage_meta SET state='sealed',digest=?,counts_cjson=? WHERE stage_id=?",
        logicalDigest, canonicalJson(counts), this.stageId);
      this.db.exec("COMMIT");
      this.#open = false;
      const physical = sealAndPublish(
        this.db, this.privateDirectory.file(),
        sealedStagePath(this.directory, this.stageId, logicalDigest), this.stageId,
      );
      this.privateDirectory.destroy();
      this.lock.release();
      return {
        stageId: this.stageId, plane: this.plane, header: this.header, logicalDigest,
        physicalSha256: physical.sha256, bytes: physical.bytes, counts,
      };
    } catch (error) {
      // A sealing failure — no-clobber refusal, S0, or hash — must leave neither a
      // lock nor a partial artifact behind.
      this.#open = false;
      abandonBuilder(this.db, this.lock, this.privateDirectory);
      throw error;
    }
  }

  #verifiedDigest(): StageDigestBuilder {
    const digest = new StageDigestBuilder(this.stageId, this.plane, this.header);
      streamRows<{ path: string; entry_cjson: string }>(
        this.db, "SELECT path,entry_cjson FROM stage_entries WHERE stage_id=? ORDER BY path_order",
        [this.stageId], (row) => {
          // Re-encode rather than trust the stored bytes: the digest must cover a
          // value this store would itself admit, in this store's canonical spelling.
          const encoded = encodeFileEntry(fileEntryFromCanonical(row.entry_cjson));
          if (encoded.canonical !== row.entry_cjson || encoded.path !== row.path) {
            throw new StageChangedError(this.stageId, `stage row ${row.path} is not canonical`);
          }
          digest.file(encoded.canonical);
        });
      streamRows<{ role: GitSectionRole }>(
        this.db, "SELECT role FROM stage_git_roles WHERE stage_id=? ORDER BY role",
        [this.stageId], (row) => digest.declareRole(row.role));
      streamRows<{ role: GitSectionRole; rel_path: string; section_cjson: string }>(
        this.db, `SELECT role,rel_path,section_cjson FROM stage_git_sections
          WHERE stage_id=? ORDER BY role,path_order`,
        [this.stageId], (row) => digest.gitSection(row.role, row.rel_path, row.section_cjson));
    return digest;
  }

  discardGeneration(): void {
    if (!this.#open) return;
    this.#open = false;
    abandonBuilder(this.db, this.lock, this.privateDirectory);
  }

  #flushBefore(rowBytes: number): void {
    // An oversize-but-valid row is processed alone; otherwise the open batch is
    // committed before it would cross the byte ceiling.
    if (this.#pendingBytes > 0 && this.#pendingBytes + rowBytes > PAGE_BYTES) {
      this.db.exec("COMMIT");
      this.db.exec("BEGIN");
      this.#pendingBytes = 0;
    }
  }

  #assertOpen(): void {
    if (!this.#open) throw new Error("generation builder is closed");
    this.lock.assertHeld();
  }
}
