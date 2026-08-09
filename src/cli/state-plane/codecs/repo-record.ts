import type { RepoRecord } from "../../sync-state-model.js";
import { isSafeRelPath, validateGitRepos } from "../../../engine/index.js";
import { RepoRecordOversizeError } from "../errors.js";
import { canonicalJson, extrasOf, parseCanonicalJson, retainedEstimate, spreadExtras, utf16beOrderKey } from "../digest/codecs.js";
import { MAX_CANONICAL_VALUE_BYTES, MAX_RETAINED_VALUE_BYTES } from "./file-entry.js";

export const REPO_RECORD_COLUMN_BY_FIELD = {
  repoGen: "repo_gen",
  sourceSeq: "source_seq",
  base: "base_cjson",
  advertised: "advertised_cjson",
  branchBaseOrigins: "branch_base_origins_cjson",
  packedRefsIdentity: "packed_refs_identity",
  pending: "pending_cjson",
  repoAbsent: "repo_absent",
  removedKey: "removed_key",
  resolutionKey: "resolution_key",
  cfgSynced: "cfg_synced",
  cfgApplied: "cfg_applied",
  cfgToken: "cfg_token_cjson",
  cfgShape: "cfg_shape_cjson",
  deferrals: "deferrals_cjson",
  partial: "partial_cjson",
  attempt: "attempt_cjson",
  resolutionReceipt: "resolution_receipt_cjson",
  idxProj: "idx_proj",
} as const satisfies Record<keyof RepoRecord, string>;

export const REPO_RECORD_KEYS = Object.keys(REPO_RECORD_COLUMN_BY_FIELD) as Array<keyof RepoRecord>;

const JSON_FIELDS = [
  "base", "advertised", "branchBaseOrigins", "packedRefsIdentity", "pending",
  "cfgToken", "cfgShape", "deferrals", "partial", "attempt", "resolutionReceipt",
] as const satisfies readonly (keyof RepoRecord)[];

function counter(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a nonnegative safe integer`);
  }
}

function exactObject(
  value: unknown,
  field: string,
  keys: readonly string[],
): asserts value is object {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${field} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new TypeError(`${field} must have exactly ${expected.join(",")}`);
  }
}

function textMembers(value: object, field: string, keys: readonly string[]): void {
  for (const key of keys) {
    if (typeof Reflect.get(value, key) !== "string") throw new TypeError(`${field}.${key} must be text`);
  }
}

function validateFixedShapes(value: RepoRecord): void {
  if (value.packedRefsIdentity !== undefined) {
    exactObject(value.packedRefsIdentity, "packedRefsIdentity", ["mtimeMs"]);
    if (typeof value.packedRefsIdentity.mtimeMs !== "number" || !Number.isFinite(value.packedRefsIdentity.mtimeMs)) {
      throw new TypeError("packedRefsIdentity.mtimeMs must be finite");
    }
  }
  if (value.cfgToken !== undefined) {
    exactObject(value.cfgToken, "cfgToken", ["dev", "ino", "size", "mtimeNs", "ctimeNs"]);
    textMembers(value.cfgToken, "cfgToken", ["dev", "ino", "size", "mtimeNs", "ctimeNs"]);
  }
  if (value.cfgShape !== undefined) {
    exactObject(value.cfgShape, "cfgShape", ["shape", "commonDir"]);
    if (typeof value.cfgShape.shape !== "string") throw new TypeError("cfgShape.shape must be text");
    exactObject(value.cfgShape.commonDir, "cfgShape.commonDir", ["realpath", "dev", "ino", "birthtime"]);
    textMembers(value.cfgShape.commonDir, "cfgShape.commonDir", ["realpath", "dev", "ino", "birthtime"]);
  }
  if (value.resolutionReceipt !== undefined) {
    exactObject(value.resolutionReceipt, "resolutionReceipt", [
      "repo", "attemptedGitIncomingKey", "attemptedSequence", "confirmedReportHash",
    ]);
    textMembers(value.resolutionReceipt, "resolutionReceipt", [
      "repo", "attemptedGitIncomingKey", "confirmedReportHash",
    ]);
    counter(value.resolutionReceipt.attemptedSequence, "resolutionReceipt.attemptedSequence");
  }
}

export interface EncodedRepoRecord {
  relPath: string;
  pathOrder: Buffer;
  repoGen: number;
  sourceSeq: number;
  values: Record<string, string | number | null>;
  extrasCjson: string | null;
  canonicalBytes: number;
  retainedEstimate: number;
  canonical: string;
}

export function encodeRepoRecord(relPath: string, input: RepoRecord): EncodedRepoRecord {
  if (relPath !== "." && !isSafeRelPath(relPath)) {
    throw new TypeError("repository path must be POSIX-relative");
  }
  // The one named historical member is stripped, never retained as an extra.
  const { resolutionIntent: _obsolete, ...value } = input as RepoRecord & { resolutionIntent?: unknown };
  counter(value.repoGen, "repoGen");
  counter(value.sourceSeq, "sourceSeq");
  for (const field of REPO_RECORD_KEYS) {
    if (value[field] === null) throw new TypeError(`${field} must be absent rather than null`);
  }
  if (value.repoAbsent !== undefined && value.repoAbsent !== true) throw new TypeError("repoAbsent must be true or absent");
  validateFixedShapes(value);
  for (const field of ["base", "advertised", "pending"] as const) {
    const section = value[field];
    if (section !== undefined && !validateGitRepos({ [relPath]: section }).ok) throw new TypeError(`invalid ${field} GitSection`);
  }
  const canonical = canonicalJson(value);
  const canonicalBytes = Buffer.byteLength(canonical);
  const retained = retainedEstimate(value);
  if (canonicalBytes > MAX_CANONICAL_VALUE_BYTES || retained > MAX_RETAINED_VALUE_BYTES) {
    throw new RepoRecordOversizeError(relPath, canonicalBytes, retained);
  }
  const values: Record<string, string | number | null> = {};
  for (const field of JSON_FIELDS) {
    values[REPO_RECORD_COLUMN_BY_FIELD[field]] = value[field] === undefined ? null : canonicalJson(value[field]);
  }
  values.repo_absent = value.repoAbsent === true ? 1 : null;
  for (const field of ["removedKey", "resolutionKey", "cfgSynced", "cfgApplied", "idxProj"] as const) {
    const member = value[field];
    if (member !== undefined && typeof member !== "string") throw new TypeError(`${field} must be text`);
    values[REPO_RECORD_COLUMN_BY_FIELD[field]] = member ?? null;
  }
  return {
    relPath,
    pathOrder: utf16beOrderKey(relPath),
    repoGen: value.repoGen,
    sourceSeq: value.sourceSeq,
    values,
    extrasCjson: extrasOf(value, REPO_RECORD_KEYS),
    canonicalBytes,
    retainedEstimate: retained,
    canonical,
  };
}

export interface RepoRecordRow {
  rel_path: string;
  repo_gen: number;
  source_seq: number;
  base_cjson: string | null;
  advertised_cjson: string | null;
  branch_base_origins_cjson: string | null;
  packed_refs_identity: string | null;
  pending_cjson: string | null;
  repo_absent: number | null;
  removed_key: string | null;
  resolution_key: string | null;
  cfg_synced: string | null;
  cfg_applied: string | null;
  cfg_token_cjson: string | null;
  cfg_shape_cjson: string | null;
  deferrals_cjson: string | null;
  partial_cjson: string | null;
  attempt_cjson: string | null;
  resolution_receipt_cjson: string | null;
  idx_proj: string | null;
  extras_cjson: string | null;
  canonical_bytes: number;
  retained_estimate: number;
}

export function decodeRepoRecord(row: RepoRecordRow): RepoRecord {
  const record = {
    ...spreadExtras(row.extras_cjson),
    repoGen: row.repo_gen,
    sourceSeq: row.source_seq,
  };
  for (const field of JSON_FIELDS) {
    const text = row[REPO_RECORD_COLUMN_BY_FIELD[field]];
    if (text !== null) Object.assign(record, { [field]: parseCanonicalJson(text) });
  }
  if (row.repo_absent !== null) Object.assign(record, { repoAbsent: true as const });
  for (const field of ["removedKey", "resolutionKey", "cfgSynced", "cfgApplied", "idxProj"] as const) {
    const member = row[REPO_RECORD_COLUMN_BY_FIELD[field]];
    if (member !== null) Object.assign(record, { [field]: member });
  }
  const decoded = record as unknown as RepoRecord;
  const encoded = encodeRepoRecord(row.rel_path, decoded);
  if (encoded.canonicalBytes !== row.canonical_bytes || encoded.retainedEstimate !== row.retained_estimate) {
    throw new Error(`structural corruption in RepoRecord ${row.rel_path}`);
  }
  return decoded;
}
