/**
 * The two walks of the state-semantic-v1 grammar — the SQL projection and the
 * legacy-JSON one — in ONE file, because a grammar divergence between them is
 * exactly the failure this digest exists to catch, and that divergence is
 * invisible when the two walks sit in two modules.
 *
 * They are deliberately two literal walks. A helper parameterized over "where
 * the rows come from" would make them agree by construction, which is precisely
 * the agreement the import-fidelity gate must not assume.
 *
 * The row plan the JSON walk reads is built in `legacy-state-plan.ts`; the same
 * plan is what `migration/import-install.ts` writes.
 */
import type { Database } from "bun:sqlite";
import { decodeFileEntry, type FileEntryRow } from "../codecs/file-entry.js";
import { decodeRepoRecord, type RepoRecordRow } from "../codecs/repo-record.js";
import type { StateSemanticDigest } from "../ports.js";
import type { JsonObject } from "../../../json.js";
import { canonicalJson, domainHash, parseCanonicalJson } from "./codecs.js";
import type { NormalizedLegacyState } from "./legacy-state-plan.js";
import type { LegacyLineageRow, LegacyPlaneHeadRow } from "./legacy-state-plan.js";

function tokens<T>(hash: ReturnType<typeof domainHash>, tag: string, value: T | undefined): void {
  hash.token(tag);
  hash.token(value === undefined ? "0" : "1");
  if (value !== undefined) hash.token(canonicalJson(value));
}

/**
 * Every statement this projection opens, finalized when it is done with it.
 *
 * `db.query` caches its statement on the connection, and a cached statement
 * that has been `iterate`d is still live afterwards: it holds a read
 * transaction that stops SQLite from removing `-wal`/`-shm` at close, so the
 * database never reaches `S0`. That is fatal for M4, whose whole job is to
 * bring the staging file to rest, and it was reachable before U3 only because
 * nothing had yet demanded `S0` after a digest.
 */
class DigestStatements {
  readonly #open: Array<{ finalize(): void }> = [];

  /** Streamed, not materialized: the largest of these tables is one row per
   * manifest entry, and the whole point of the migration envelope is that the
   * store never needs the manifest in memory twice. */
  each<T>(db: Database, sql: string, args: unknown[], visit: (row: T) => void): void {
    const statement = db.prepare(sql);
    this.#open.push(statement);
    for (const row of statement.iterate(...args as never[]) as Iterable<T>) visit(row);
  }

  one<T>(db: Database, sql: string, ...args: unknown[]): T | null {
    const statement = db.prepare(sql);
    this.#open.push(statement);
    return statement.get(...args as never[]) as T | null;
  }

  finalize(): void {
    for (const statement of this.#open.splice(0)) statement.finalize();
  }
}

/** state-semantic-v1 SQL projection. Grammar:
 * completion -> lineage -> base/local headers -> ordered base/local files ->
 * optional meta -> ordered chain -> ordered role Git -> ordered repositories ->
 * ordered legacy evidence. Each record is [tag,presence,canonical-value]. */
export function stateSemanticDigest(db: Database): StateSemanticDigest {
  const statements = new DigestStatements();
  try {
    return projectSemanticDigest(db, statements);
  } finally {
    statements.finalize();
  }
}

interface ManifestMetaRow {
  base_generation: number; enc_manifest_sha: Uint8Array; manifest_hash: Uint8Array;
  account_epoch: number; key_epoch: number; chain_bytes: number; snapshot_bytes: number;
  extras_cjson: string | null;
}

/** `extras` is ABSENT when the row carried none: the digest frames key
 * presence, so an explicit undefined would be a different value. */
function hashedManifestMeta(meta: ManifestMetaRow): JsonObject {
  const hashed: JsonObject = {
    baseGeneration: meta.base_generation,
    encManifestSha: Buffer.from(meta.enc_manifest_sha).toString("hex"),
    manifestHash: Buffer.from(meta.manifest_hash).toString("hex"),
    accountEpoch: meta.account_epoch,
    keyEpoch: meta.key_epoch,
    chainBytes: meta.chain_bytes,
    snapshotBytes: meta.snapshot_bytes,
  };
  if (meta.extras_cjson !== null) hashed.extras = parseCanonicalJson(meta.extras_cjson);
  return hashed;
}

function projectSemanticDigest(db: Database, statements: DigestStatements): StateSemanticDigest {
  const hash = domainHash("state-semantic-v1");
  // The column keeps its durable name; only the read alias is a code symbol
  // (docs/wire-rename-candidates.md). The DIGEST TOKEN below is framed into the
  // hash and can never be renamed without a new grammar.
  const completion = statements.one<{
    presence_flags_cjson: string; source_repo_records_present: number;
  }>(db, `SELECT source_shape_flags_cjson AS presence_flags_cjson,source_repo_records_present
    FROM migration_completion WHERE singleton=1`);
  if (!completion) throw new Error("state semantic digest requires migration_completion singleton");
  tokens(hash, "source-shape-flags", parseCanonicalJson(completion.presence_flags_cjson));
  tokens(hash, "source-repo-records-present", completion.source_repo_records_present === 1);
  const lineage = statements.one<LegacyLineageRow>(db, `SELECT l.* FROM state_lineage l JOIN store_meta m
    ON m.active_lineage_id=l.lineage_id WHERE m.singleton=1`)!;
  tokens(hash, "lineage", lineage);
  const lineageId = lineage.lineage_id as string;
  for (const plane of ["base", "local"] as const) {
    const head = statements.one<LegacyPlaneHeadRow>(db, "SELECT * FROM plane_heads WHERE lineage_id=? AND plane=?", lineageId, plane);
    tokens(hash, `${plane}-head`, head);
    statements.each<FileEntryRow>(db, `SELECT e.* FROM plane_entries p
      JOIN entry_values e ON e.entry_id=p.entry_id
      WHERE p.lineage_id=? AND p.plane=? ORDER BY p.path_order`, [lineageId, plane],
    (row) => tokens(hash, `${plane}-file`, decodeFileEntry(row)));
  }
  const meta = statements.one<ManifestMetaRow>(db,
    "SELECT * FROM global_manifest_meta WHERE lineage_id=?", lineageId);
  tokens(hash, "manifest-meta", meta === null ? undefined : hashedManifestMeta(meta));
  statements.each<{ ordinal: number; enc_sha: Uint8Array }>(
    db, "SELECT ordinal,enc_sha FROM manifest_chain WHERE lineage_id=? ORDER BY ordinal", [lineageId],
    (row) => tokens(hash, "manifest-chain", { ordinal: row.ordinal, encSha: Buffer.from(row.enc_sha).toString("hex") }));
  // BINARY order is intentional and stable for the two frozen role enum values.
  statements.each<{ role: string; rel_path: string; section_cjson: string }>(
    db, `SELECT role,rel_path,section_cjson FROM manifest_git_sections
    WHERE lineage_id=? ORDER BY role,path_order`, [lineageId],
    (row) => tokens(hash, "manifest-git", {
      role: row.role, relPath: row.rel_path, section: parseCanonicalJson(row.section_cjson),
    }));
  statements.each<RepoRecordRow>(
    db, "SELECT * FROM repo_records WHERE lineage_id=? ORDER BY path_order", [lineageId],
    (row) => tokens(hash, "repo", { relPath: row.rel_path, record: decodeRepoRecord(row) }));
  statements.each<{ field: string; rel_path: string; value_cjson: string }>(
    db, "SELECT field,rel_path,value_cjson FROM legacy_state_maps ORDER BY field,rel_path", [],
    (row) => tokens(hash, "legacy-map", {
      field: row.field, relPath: row.rel_path, value: parseCanonicalJson(row.value_cjson),
    }));
  return hash.digest() as StateSemanticDigest;
}

/** The same grammar, walked over the row plan instead of the tables. */
export function legacyStateSemanticDigest(plan: NormalizedLegacyState): StateSemanticDigest {
  const hash = domainHash("state-semantic-v1");
  tokens(hash, "source-shape-flags", plan.presenceFlags);
  tokens(hash, "source-repo-records-present", plan.repoRecordsPresent);
  tokens(hash, "lineage", plan.lineage);
  tokens(hash, "base-head", plan.baseHead);
  for (const entry of plan.entries) tokens(hash, "base-file", entry);
  // LOCAL carries no entries until the first scan, so nothing sits between its
  // head token and the meta token — the SQL walk emits the same nothing.
  tokens(hash, "local-head", plan.localHead);
  tokens(hash, "manifest-meta", plan.manifestMeta);
  for (const [ordinal, encSha] of plan.chain.entries()) tokens(hash, "manifest-chain", { ordinal, encSha });
  for (const row of plan.gitSections) {
    tokens(hash, "manifest-git", { role: row.role, relPath: row.relPath, section: row.section });
  }
  for (const row of plan.repos) tokens(hash, "repo", { relPath: row.relPath, record: row.record });
  for (const row of plan.legacyMaps) {
    tokens(hash, "legacy-map", { field: row.field, relPath: row.relPath, value: row.value });
  }
  return hash.digest() as StateSemanticDigest;
}
