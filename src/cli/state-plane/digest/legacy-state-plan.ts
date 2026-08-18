/**
 * The normalized row view used by the legacy JSON semantic digest.
 */
import type { FileEntry, GitSection } from "../../../engine/index.js";
import {
  validManifestMeta, type RepoRecord, type SyncState,
} from "../../sync-state-model.js";
import {
  normalizeStateCounter, repoRecordsForState,
} from "../../sync-state-records.js";
import { encodeFileEntry } from "../codecs/file-entry.js";
import { encodeGitSection } from "../codecs/git-section.js";
import { encodeRepoRecord } from "../codecs/repo-record.js";
import { jsonObject, jsonText } from "../../../json.js";
import { canonicalJson, compareUtf16, extrasOf, parseCanonicalJson, type JsonValue } from "./codecs.js";
import { legacySourcePresenceFlags, type SourcePresenceFlags } from "./source-shape.js";


/** The generation every v1 import lands on. BASE starts at zero and the import
 * is that generation's only writer, so nothing else can name it. */
export const LEGACY_IMPORT_GENERATION = 0;

const SYNC_STATE_KEYS = [
  "stream", "lastSyncedSequence", "lastSyncedManifest", "manifestMeta",
  "gitReposRemoved", "gitNeedsResolution", "gitPendingRemote", "gitDeferrals",
  "gitPartial", "stateNonce", "stateRevision", "telemetryBindingId", "repoRecords",
] as const;

const MANIFEST_KEYS = ["generatedAt", "files", "manifestSchema", "gitRepos"] as const;

/** Three names `plane_heads` owns as columns. A source manifest carrying one
 * would round-trip through `extras_cjson` into a column the read path then
 * overwrites, so it is refused rather than silently rewritten. */
const RESERVED_MANIFEST_KEYS = ["complete", "sourceSequence", "trustEpoch"] as const;

/** The five per-repo maps a pre-record state keeps beside `repoRecords`. */
const LEGACY_MAP_FIELDS = [
  "gitReposRemoved", "gitNeedsResolution", "gitPendingRemote", "gitDeferrals", "gitPartial",
] as const;

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

/** The legacy document is not a shape this schema can hold. Typed and
 * fail-closed, so M-5 publishes a `verification` halt instead of letting a
 * `CHECK` constraint surface as an opaque SQLite error mid-transaction. */
export class LegacyStateStructureError extends Error {
  constructor(readonly detail: string) {
    super(`legacy state cannot be imported: ${detail}`);
    this.name = "LegacyStateStructureError";
  }
}

const refuse = (detail: string): never => {
  throw new LegacyStateStructureError(detail);
};

/** `path_order` is a big-endian UTF-16 blob, so its memcmp order is JS string
 * order. `rel_path`/`field` are TEXT under BINARY collation, which is memcmp
 * over UTF-8 — a different order above the BMP. Two comparators, deliberately. */
const compareUtf8 = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b));

export interface LegacyGitSectionRow {
  readonly role: "manifest-projection" | "meta-wire";
  readonly relPath: string;
  readonly section: GitSection;
}
export interface LegacyRepoRow { readonly relPath: string; readonly record: RepoRecord }
export interface LegacyMapRow {
  readonly field: string; readonly relPath: string; readonly value: JsonValue;
}

/** The `global_manifest_meta` row in the spelling both the digest token and the
 * insert use; the two hashes are hex here and BLOBs in the columns. */
export interface LegacyManifestMetaRow {
  readonly baseGeneration: number;
  readonly encManifestSha: string;
  readonly manifestHash: string;
  readonly accountEpoch: number;
  readonly keyEpoch: number;
  readonly chainBytes: number;
  readonly snapshotBytes: number;
  readonly extras?: JsonValue;
}

export interface LegacyPlaneHeadRow {
  readonly lineage_id: string;
  readonly plane: "base" | "local";
  readonly generation: number;
  readonly generated_at: string;
  readonly manifest_schema: number | null;
  readonly source_sequence: number | null;
  readonly trust_epoch: string | null;
  readonly complete: 0 | 1;
  readonly extras_cjson: string | null;
}

export interface LegacyLineageRow {
  readonly lineage_id: string;
  readonly stream: string;
  readonly state_nonce: string | null;
  readonly state_revision: number | null;
  readonly last_synced_sequence: number;
  readonly active_base_generation: number;
  readonly local_revision: number;
  readonly telemetry_binding_id: string | null;
  readonly repo_records_authoritative: 1;
  readonly extras_cjson: string | null;
}

export interface NormalizedLegacyState {
  readonly lineage: LegacyLineageRow;
  readonly baseHead: LegacyPlaneHeadRow;
  readonly localHead: LegacyPlaneHeadRow;
  /** BASE entries in `path_order`. LOCAL has none: no scan has run yet. */
  readonly entries: readonly FileEntry[];
  readonly manifestMeta: LegacyManifestMetaRow | undefined;
  readonly chain: readonly string[];
  readonly gitSections: readonly LegacyGitSectionRow[];
  readonly repos: readonly LegacyRepoRow[];
  readonly legacyMaps: readonly LegacyMapRow[];
  readonly presenceFlags: SourcePresenceFlags;
  readonly repoRecordsPresent: boolean;
}

/** The legacy document is typed optimistically by its loader; every member that
 * reaches a guard here is really just decoded JSON. */
const decoded = <T>(value: T): JsonValue | undefined => value as JsonValue | undefined;

function optionalHex(value: string | undefined, pattern: RegExp, field: string): string | null {
  if (value === undefined) return null;
  if (!jsonText(decoded(value))) refuse(`${field} is not the lowercase hex identity the schema admits`);
  if (!pattern.test(value)) refuse(`${field} is not the lowercase hex identity the schema admits`);
  return value;
}

function orderedGitSections(
  role: LegacyGitSectionRow["role"], sections: Readonly<Record<string, GitSection>> | undefined,
): LegacyGitSectionRow[] {
  if (sections === undefined) return [];
  if (!jsonObject(decoded(sections))) refuse(`${role} git sections is not an object`);
  return Object.entries(sections)
    .map(([relPath, section]) => {
      // The store's one admission point: a section this refuses is one the wire
      // manifest would refuse too, so the import never lands an unreadable row.
      encodeGitSection(relPath, section);
      return { role, relPath, section };
    })
    .sort((a, b) => compareUtf16(a.relPath, b.relPath));
}

/** `extras` is ABSENT when the source carried none — an explicit undefined
 * would reach the digest as a member the source never had. */
const metaExtrasRow = (metaExtras: string | null): Pick<LegacyManifestMetaRow, "extras"> =>
  (metaExtras === null ? {} : { extras: parseCanonicalJson(metaExtras) });

function legacyMapRows(state: SyncState): LegacyMapRow[] {
  const rows: LegacyMapRow[] = [];
  for (const field of LEGACY_MAP_FIELDS) {
    const map = state[field];
    if (map === undefined) continue;
    if (!jsonObject(decoded(map))) refuse(`${field} is not an object`);
    for (const [relPath, value] of Object.entries(map)) {
      rows.push({ field, relPath, value: parseCanonicalJson(canonicalJson(value)) });
    }
  }
  return rows.sort((a, b) => compareUtf8(a.field, b.field) || compareUtf8(a.relPath, b.relPath));
}

/**
 * The legacy document as rows.
 *
 * The five sidecar maps of a pre-record state are folded into records by
 * `repoRecordsForState` — the same fold the JSON read path has always
 * performed, called rather than restated, because two copies of that rule are
 * two answers. That fold, and `encodeRepoRecord` after it, are also what strip
 * the obsolete `resolutionIntent` before it can reach `extras_cjson` or a shape
 * bit; a third strip here was unfalsifiable mechanism and is gone.
 *
 * DESIGN AMENDMENT (222 §M-5 prints `normalizeLegacyStateV1(state)`): the SQL
 * projection tokenizes the `state_lineage` and `plane_heads` rows whole and
 * both carry `lineage_id`, so a digest that omitted it would not be the digest
 * the SQL side computes. The binding is a parameter rather than a fiction.
 */
export function normalizeLegacyStateV1(state: SyncState, lineageId: string): NormalizedLegacyState {
  if (!HEX32.test(lineageId)) refuse("the migration lineage id is not lowercase hex32");
  if (!jsonText(decoded(state.stream)) || state.stream.length === 0) refuse("stream is not nonempty text");
  const manifest = state.lastSyncedManifest;
  if (!jsonObject(decoded(manifest))) refuse("lastSyncedManifest is not an object");
  for (const reserved of RESERVED_MANIFEST_KEYS) {
    if (reserved in manifest) refuse(`lastSyncedManifest.${reserved} collides with a plane_heads column`);
  }
  if (!jsonText(decoded(manifest.generatedAt))) refuse("lastSyncedManifest.generatedAt is not text");
  if (!Array.isArray(manifest.files)) refuse("lastSyncedManifest.files is not a list");
  if (manifest.manifestSchema !== undefined
    && (!Number.isSafeInteger(manifest.manifestSchema) || (manifest.manifestSchema as number) < 1)) {
    refuse("lastSyncedManifest.manifestSchema is not a schema version");
  }

  const entries = [...manifest.files]
    .map((entry) => {
      encodeFileEntry(entry);
      return entry;
    })
    .sort((a, b) => compareUtf16(a.path, b.path));
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    refuse("lastSyncedManifest.files repeats a path");
  }

  const repos = Object.entries(repoRecordsForState(state))
    .map(([relPath, record]) => {
      encodeRepoRecord(relPath, record);
      return { relPath, record };
    })
    .sort((a, b) => compareUtf16(a.relPath, b.relPath));

  const meta = validManifestMeta(state.manifestMeta);
  const metaExtras = meta === undefined ? null : extrasOf(meta, [
    "encManifestSha", "manifestHash", "accountEpoch", "keyEpoch",
    "chain", "chainBytes", "snapshotBytes", "gitRepos",
  ]);
  const generation = LEGACY_IMPORT_GENERATION;
  return {
    lineage: {
      lineage_id: lineageId,
      stream: state.stream,
      state_nonce: optionalHex(state.stateNonce, HEX32, "stateNonce"),
      state_revision: state.stateRevision === undefined ? null : normalizeStateCounter(state.stateRevision),
      last_synced_sequence: normalizeStateCounter(state.lastSyncedSequence),
      active_base_generation: generation,
      local_revision: generation,
      telemetry_binding_id: optionalHex(state.telemetryBindingId, HEX16, "telemetryBindingId"),
      repo_records_authoritative: 1,
      extras_cjson: extrasOf(state, SYNC_STATE_KEYS),
    },
    baseHead: {
      lineage_id: lineageId, plane: "base", generation,
      generated_at: manifest.generatedAt as string,
      manifest_schema: manifest.manifestSchema === undefined ? null : manifest.manifestSchema as number,
      source_sequence: normalizeStateCounter(state.lastSyncedSequence),
      trust_epoch: null, complete: 1,
      extras_cjson: extrasOf(manifest, MANIFEST_KEYS),
    },
    // LOCAL starts incomplete for the reason genesis does: no filesystem scan
    // has established a trust epoch for this lineage.
    localHead: {
      lineage_id: lineageId, plane: "local", generation,
      generated_at: "", manifest_schema: null, source_sequence: null,
      trust_epoch: null, complete: 0, extras_cjson: null,
    },
    entries,
    manifestMeta: meta === undefined ? undefined : {
      baseGeneration: generation,
      encManifestSha: meta.encManifestSha,
      manifestHash: meta.manifestHash,
      accountEpoch: meta.accountEpoch,
      keyEpoch: meta.keyEpoch,
      chainBytes: meta.chainBytes,
      snapshotBytes: meta.snapshotBytes,
      ...metaExtrasRow(metaExtras),
    },
    chain: meta === undefined ? [] : meta.chain,
    gitSections: [
      ...orderedGitSections("manifest-projection", manifest.gitRepos),
      ...orderedGitSections("meta-wire", meta === undefined ? undefined : meta.gitRepos),
    ],
    repos,
    legacyMaps: legacyMapRows(state),
    presenceFlags: legacySourcePresenceFlags(state),
    repoRecordsPresent: state.repoRecords !== undefined,
  };
}
