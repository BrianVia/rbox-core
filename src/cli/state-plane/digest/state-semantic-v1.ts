import type { Database } from "bun:sqlite";
import { decodeFileEntry, type FileEntryRow } from "../codecs/file-entry.js";
import { decodeRepoRecord, type RepoRecordRow } from "../codecs/repo-record.js";
import type { StateSemanticDigest } from "../ports.js";
import { canonicalJson, domainHash, parseCanonicalJson } from "./codecs.js";

function tokens(hash: ReturnType<typeof domainHash>, tag: string, value: unknown): void {
  hash.token(tag);
  hash.token(value === undefined ? "0" : "1");
  if (value !== undefined) hash.token(canonicalJson(value));
}

/** state-semantic-v1 SQL projection. Grammar:
 * completion -> lineage -> base/local headers -> ordered base/local files ->
 * optional meta -> ordered chain -> ordered role Git -> ordered repositories ->
 * ordered legacy evidence. Each record is [tag,presence,canonical-value]. */
export function stateSemanticDigest(db: Database): StateSemanticDigest {
  const hash = domainHash("state-semantic-v1");
  const completion = db.query(`SELECT source_shape_flags_cjson,source_repo_records_present
    FROM migration_completion WHERE singleton=1`).get() as {
    source_shape_flags_cjson: string; source_repo_records_present: number;
  } | null;
  if (!completion) throw new Error("state semantic digest requires migration_completion singleton");
  tokens(hash, "source-shape-flags", parseCanonicalJson(completion.source_shape_flags_cjson));
  tokens(hash, "source-repo-records-present", completion.source_repo_records_present === 1);
  const lineage = db.query(`SELECT l.* FROM state_lineage l JOIN store_meta m
    ON m.active_lineage_id=l.lineage_id WHERE m.singleton=1`).get() as Record<string, unknown>;
  tokens(hash, "lineage", lineage);
  for (const plane of ["base", "local"] as const) {
    const head = db.query("SELECT * FROM plane_heads WHERE lineage_id=? AND plane=?")
      .get(lineage.lineage_id as string, plane);
    tokens(hash, `${plane}-head`, head);
    const entries = db.query(`SELECT e.* FROM plane_entries p JOIN entry_values e ON e.entry_id=p.entry_id
      WHERE p.lineage_id=? AND p.plane=? ORDER BY p.path_order`);
    for (const row of entries.iterate(lineage.lineage_id as string, plane) as Iterable<FileEntryRow>) {
      tokens(hash, `${plane}-file`, decodeFileEntry(row));
    }
  }
  const meta = db.query("SELECT * FROM global_manifest_meta WHERE lineage_id=?").get(lineage.lineage_id as string) as {
    base_generation: number; enc_manifest_sha: Uint8Array; manifest_hash: Uint8Array;
    account_epoch: number; key_epoch: number; chain_bytes: number; snapshot_bytes: number;
    extras_cjson: string | null;
  } | null;
  tokens(hash, "manifest-meta", meta ? {
    baseGeneration: meta.base_generation,
    encManifestSha: Buffer.from(meta.enc_manifest_sha).toString("hex"),
    manifestHash: Buffer.from(meta.manifest_hash).toString("hex"),
    accountEpoch: meta.account_epoch,
    keyEpoch: meta.key_epoch,
    chainBytes: meta.chain_bytes,
    snapshotBytes: meta.snapshot_bytes,
    ...(meta.extras_cjson === null ? {} : { extras: parseCanonicalJson(meta.extras_cjson) }),
  } : undefined);
  for (const row of db.query("SELECT ordinal,enc_sha FROM manifest_chain WHERE lineage_id=? ORDER BY ordinal")
    .iterate(lineage.lineage_id as string) as Iterable<{ ordinal: number; enc_sha: Uint8Array }>) {
    tokens(hash, "manifest-chain", { ordinal: row.ordinal, encSha: Buffer.from(row.enc_sha).toString("hex") });
  }
  // BINARY order is intentional and stable for the two frozen role enum values.
  for (const row of db.query(`SELECT role,rel_path,section_cjson FROM manifest_git_sections
    WHERE lineage_id=? ORDER BY role,path_order`).iterate(lineage.lineage_id as string) as Iterable<{
      role: string; rel_path: string; section_cjson: string;
    }>) {
    tokens(hash, "manifest-git", { role: row.role, relPath: row.rel_path, section: parseCanonicalJson(row.section_cjson) });
  }
  for (const row of db.query("SELECT * FROM repo_records WHERE lineage_id=? ORDER BY path_order")
    .iterate(lineage.lineage_id as string) as Iterable<RepoRecordRow>) {
    tokens(hash, "repo", { relPath: row.rel_path, record: decodeRepoRecord(row) });
  }
  for (const row of db.query("SELECT field,rel_path,value_cjson FROM legacy_state_maps ORDER BY field,rel_path")
    .iterate() as Iterable<{ field: string; rel_path: string; value_cjson: string }>) {
    tokens(hash, "legacy-map", { field: row.field, relPath: row.rel_path, value: parseCanonicalJson(row.value_cjson) });
  }
  return hash.digest() as StateSemanticDigest;
}
