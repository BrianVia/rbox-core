import type { Database } from "bun:sqlite";
import type { FileEntry } from "../../../engine/index.js";
import type { GlobalManifestMeta, RepoRecord } from "../../sync-state-model.js";
import { decodeFileEntry, type FileEntryRow } from "../codecs/file-entry.js";
import { decodeGitSection } from "../codecs/git-section.js";
import { decodeRepoRecord, type RepoRecordRow } from "../codecs/repo-record.js";
import { canonicalJson, parseCanonicalJson, spreadExtras, utf16beOrderKey } from "../digest/codecs.js";
import { CursorWindowError, GitSectionOversizeError, SnapshotChangedError, decodeAuthorityRow } from "../errors.js";
import type {
  CursorPage, GitSectionRole, LineageSnapshot, ManifestHeader, Plane,
  ReadSnapshot, RepositorySnapshot,
} from "../ports.js";
import { stateStoreDatabase, type StateStoreHandle } from "./open.js";

const PAGE_BYTES = 4 * 1024 * 1024;

interface TokenRows {
  authority_id: string; lineage_id: string; stream: string; state_nonce: string | null;
  state_revision: number | null; last_synced_sequence: number;
  active_base_generation: number; local_revision: number; telemetry_binding_id: string | null;
  extras_cjson: string | null; source_shape_flags_cjson: string;
}

interface HeadRow {
  plane: Plane; generation: number; generated_at: string; manifest_schema: number | null;
  source_sequence: number | null; trust_epoch: string | null; complete: number; extras_cjson: string | null;
}

function header(row: HeadRow): ManifestHeader {
  return {
    ...spreadExtras(row.extras_cjson),
    generatedAt: row.generated_at,
    ...(row.manifest_schema === null ? {} : { manifestSchema: row.manifest_schema }),
    ...(row.source_sequence === null ? {} : { sourceSequence: row.source_sequence }),
    ...(row.trust_epoch === null ? {} : { trustEpoch: row.trust_epoch }),
    complete: row.complete === 1,
  };
}

export function currentSnapshot(db: Database): LineageSnapshot {
  const core = db.query(`SELECT m.authority_id,l.lineage_id,l.stream,l.state_nonce,l.state_revision,
    l.last_synced_sequence,l.active_base_generation,l.local_revision,l.telemetry_binding_id,
    l.extras_cjson,c.source_shape_flags_cjson
    FROM store_meta m JOIN state_lineage l ON l.lineage_id=m.active_lineage_id
    JOIN migration_completion c ON c.singleton=1
    WHERE m.singleton=1`).get() as TokenRows | null;
  if (!core) throw new Error("state store singleton disappeared");
  const heads = db.query(`SELECT plane,generation,generated_at,manifest_schema,source_sequence,
    trust_epoch,complete,extras_cjson FROM plane_heads WHERE lineage_id=? ORDER BY plane`).all(core.lineage_id) as HeadRow[];
  const base = heads.find((row) => row.plane === "base");
  const local = heads.find((row) => row.plane === "local");
  if (!base || !local || base.generation !== core.active_base_generation || local.generation !== core.local_revision) {
    throw new Error("state store head invariant failed");
  }
  const meta = db.query(`SELECT enc_manifest_sha,manifest_hash,account_epoch,key_epoch,chain_bytes,
    snapshot_bytes,extras_cjson FROM global_manifest_meta WHERE lineage_id=? AND base_generation=?`
  ).get(core.lineage_id, core.active_base_generation) as {
    enc_manifest_sha: Uint8Array; manifest_hash: Uint8Array; account_epoch: number; key_epoch: number;
    chain_bytes: number; snapshot_bytes: number; extras_cjson: string | null;
  } | null;
  const manifestMeta = meta ? {
    ...spreadExtras(meta.extras_cjson),
    encManifestSha: Buffer.from(meta.enc_manifest_sha).toString("hex"),
    manifestHash: Buffer.from(meta.manifest_hash).toString("hex"),
    accountEpoch: meta.account_epoch,
    keyEpoch: meta.key_epoch,
    chainBytes: meta.chain_bytes,
    snapshotBytes: meta.snapshot_bytes,
  } as Omit<GlobalManifestMeta, "chain" | "gitRepos"> : undefined;
  const sourceShape = parseCanonicalJson(core.source_shape_flags_cjson) as Record<string, unknown>;
  const manifestShape = sourceShape.lastSyncedManifest;
  const manifestGitReposPresent = typeof manifestShape === "object" && manifestShape !== null
    && !Array.isArray(manifestShape)
    && (manifestShape as Record<string, unknown>).gitRepos === true;
  return {
    authorityId: core.authority_id,
    lineageId: core.lineage_id,
    stream: core.stream,
    ...(core.state_nonce === null ? {} : { nonce: core.state_nonce }),
    ...(core.state_revision === null ? {} : { stateRevision: core.state_revision }),
    lastSyncedSequence: core.last_synced_sequence,
    baseGeneration: core.active_base_generation,
    localRevision: core.local_revision,
    ...(core.telemetry_binding_id === null ? {} : { telemetryBindingId: core.telemetry_binding_id }),
    lineageExtras: spreadExtras(core.extras_cjson),
    manifestGitReposPresent,
    baseHeader: header(base),
    localHeader: header(local),
    ...(manifestMeta ? { manifestMeta } : {}),
  };
}

function sameToken(a: LineageSnapshot, b: LineageSnapshot): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

function assertToken(db: Database, expected: LineageSnapshot): void {
  if (!sameToken(currentSnapshot(db), expected)) throw new SnapshotChangedError();
}

function window(kind: "file" | "repo" | "git" | "chain", size: number): void {
  const maximum = kind === "file" || kind === "chain" ? 512 : 16;
  if (!Number.isInteger(size) || size < 1 || size > maximum) throw new CursorWindowError(kind, size, maximum);
}

function shortQuery<T>(db: Database, token: LineageSnapshot, query: () => T): T {
  assertToken(db, token);
  db.exec("BEGIN");
  try {
    assertToken(db, token);
    const result = query();
    db.exec("COMMIT");
    assertToken(db, token);
    return result;
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function boundedPage<T>(
  rows: T[],
  batchSize: number,
  bytes: (row: T) => number,
  key: (row: T) => string,
): CursorPage<T> {
  const admitted: T[] = [];
  let used = 0;
  for (const row of rows) {
    const rowBytes = bytes(row);
    if (admitted.length > 0 && used + rowBytes > PAGE_BYTES) break;
    admitted.push(row);
    used += rowBytes;
  }
  const last = admitted.at(-1);
  return {
    rows: admitted,
    done: admitted.length === rows.length && rows.length < batchSize,
    ...(last ? { after: key(last) } : {}),
  };
}

class SqliteReadSnapshot implements ReadSnapshot {
  constructor(private readonly db: Database, readonly token: LineageSnapshot) {}

  files(plane: Plane, afterPath: string | undefined, batchSize: number): CursorPage<FileEntry> {
    window("file", batchSize);
    return shortQuery(this.db, this.token, () => {
      const rows = this.db.query(`SELECT e.path,e.sha256,e.size,e.mode,e.mtime_ms,e.kind,e.symlink_target,
        e.enc_sha,e.comp,e.payload_sha,e.cipher_size,e.extras_cjson,e.canonical_bytes,e.retained_estimate
        FROM plane_entries p JOIN entry_values e ON e.entry_id=p.entry_id
        WHERE p.lineage_id=? AND p.plane=? AND p.path_order>?
        ORDER BY p.path_order LIMIT ?`).all(
        this.token.lineageId, plane, afterPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterPath), batchSize,
      ) as FileEntryRow[];
      const page = boundedPage(rows, batchSize, (row) => row.retained_estimate, (row) => row.path);
      return { ...page, rows: page.rows.map((row) => decodeAuthorityRow("fileEntry", row.path, () => decodeFileEntry(row))) };
    });
  }

  repos(afterRelPath: string | undefined, batchSize: number): CursorPage<{ relPath: string; record: RepoRecord; token: RepositorySnapshot }> {
    window("repo", batchSize);
    return shortQuery(this.db, this.token, () => {
      const rows = this.db.query(`SELECT * FROM repo_records WHERE lineage_id=? AND path_order>?
        ORDER BY path_order LIMIT ?`).all(
        this.token.lineageId, afterRelPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterRelPath), batchSize,
      ) as RepoRecordRow[];
      const page = boundedPage(rows, batchSize, (row) => row.retained_estimate, (row) => row.rel_path);
      return {
        ...page,
        rows: page.rows.map((row) => ({
          relPath: row.rel_path,
          record: decodeAuthorityRow("repoRecord", row.rel_path, () => decodeRepoRecord(row)),
          token: { ...this.token, repoGen: row.repo_gen },
        })),
      };
    });
  }

  repo(relPath: string): { record: RepoRecord; token: RepositorySnapshot } | undefined {
    return shortQuery(this.db, this.token, () => {
      const row = this.db.query("SELECT * FROM repo_records WHERE lineage_id=? AND rel_path=?")
        .get(this.token.lineageId, relPath) as RepoRecordRow | null;
      return row
        ? { record: decodeAuthorityRow("repoRecord", relPath, () => decodeRepoRecord(row)), token: { ...this.token, repoGen: row.repo_gen } }
        : undefined;
    });
  }

  manifestChainCursor(afterOrdinal: number | undefined, batchSize: number) {
    window("chain", batchSize);
    return shortQuery(this.db, this.token, () => {
      const rows = this.db.query(`SELECT ordinal,enc_sha FROM manifest_chain
        WHERE lineage_id=? AND base_generation=? AND ordinal>?
        ORDER BY ordinal LIMIT ?`).all(
        this.token.lineageId, this.token.baseGeneration, afterOrdinal ?? -1, batchSize,
      ) as Array<{ ordinal: number; enc_sha: Uint8Array }>;
      return {
        rows: rows.map((row) => ({ ordinal: row.ordinal, encSha: Buffer.from(row.enc_sha).toString("hex") })),
        done: rows.length < batchSize,
        ...(rows.length ? { after: String(rows.at(-1)!.ordinal) } : {}),
      };
    }) as CursorPage<{ ordinal: number; encSha: string }>;
  }

  private git(role: GitSectionRole, afterRelPath: string | undefined, batchSize: number) {
    window("git", batchSize);
    return shortQuery(this.db, this.token, () => {
      const rows = this.db.query(`SELECT rel_path,section_cjson FROM manifest_git_sections
        WHERE lineage_id=? AND base_generation=? AND role=? AND path_order>?
        ORDER BY path_order LIMIT ?`).all(
        this.token.lineageId, this.token.baseGeneration, role,
        afterRelPath === undefined ? Buffer.alloc(0) : utf16beOrderKey(afterRelPath), batchSize,
      ) as Array<{ rel_path: string; section_cjson: string }>;
      const rowBytes = (row: { rel_path: string; section_cjson: string }) =>
        Buffer.byteLength(row.rel_path) + Buffer.byteLength(row.section_cjson);
      const oversize = rows.find((row) => rowBytes(row) > PAGE_BYTES);
      if (oversize) throw new GitSectionOversizeError(oversize.rel_path, rowBytes(oversize));
      // Git sections are independently bounded by a page byte ceiling even
      // though design 163 only stated their 16-row ceiling explicitly.
      const page = boundedPage(rows, batchSize, rowBytes, (row) => row.rel_path);
      return {
        ...page,
        rows: page.rows.map((row) => ({
          relPath: row.rel_path,
          section: decodeAuthorityRow("gitSection", row.rel_path, () => decodeGitSection(row.rel_path, row.section_cjson)),
        })),
      };
    });
  }

  metaGitRepoCursor(afterRelPath: string | undefined, batchSize: number) {
    return this.git("meta-wire", afterRelPath, batchSize);
  }

  manifestGitRepoCursor(afterRelPath: string | undefined, batchSize: number) {
    return this.git("manifest-projection", afterRelPath, batchSize);
  }

  finishProjection(): void {
    assertToken(this.db, this.token);
  }
}

export function openReadSnapshot(store: StateStoreHandle): ReadSnapshot {
  const db = stateStoreDatabase(store);
  return new SqliteReadSnapshot(db, currentSnapshot(db));
}
