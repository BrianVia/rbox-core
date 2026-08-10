import crypto from "node:crypto";
import { canonicalize } from "../engine/e2ee/jcs.js";
import type { JsonObject } from "../json.js";
import {
  repositoryIdentityHash,
  validateRepoIdentityV1,
  type RepoIdentityV1,
} from "../engine/git/repo-lineage.js";
import { compareResetZEntries, type ResetZEntry } from "./reset-z.js";
import {
  STATE_STORE_SCHEMA_VERSION,
  STATE_STORE_SQLITE_APPLICATION_ID,
  STATE_STORE_SQLITE_USER_VERSION,
} from "./state-plane/schema/application.js";

export type ResetPhase = "prepared" | "ready" | "installed" | "z-retired";
export type ResetConsentKind = "setup-rebind" | "setup-create";
export interface ResetJournalAuthorization {
  version: 2;
  authorizedNextStream: string;
  consentKind: ResetConsentKind;
  mintedAtRevision: number;
}
export interface ResetNextState {
  stream: string;
  stateNonce: string;
  stateRevision: number;
  lastSyncedSequence: 0;
  lastSyncedManifest: { generatedAt: ""; files: [] };
  repoRecords: Record<string, never>;
  telemetryBindingId?: string;
}
interface OldV1 {
  stream: string;
  stateNonce: string;
  stateRevision: number;
  stateSha256: string;
  z: ResetZEntry[];
}
interface OldV2 extends OldV1 { archiveBaseline: "absent" | "exact" }
interface LegacyNext {
  stream: string;
  stateNonce: string;
  stateRevision: number;
  stateSha256: string;
  state: ResetNextState;
}
export interface ResetJournalV1 {
  v: 1; id: string; phase: ResetPhase; createdAt: string; old: OldV1; next: LegacyNext;
}
export interface ResetJournalV2 {
  v: 2; id: string; phase: ResetPhase; createdAt: string;
  authorization: ResetJournalAuthorization; old: OldV2; next: LegacyNext;
}
export interface SQLiteResetJournalV2 {
  v: 2;
  stateFormat: "sqlite/v1";
  id: string;
  phase: ResetPhase;
  createdAt: string;
  authorization: ResetJournalAuthorization;
  authorityId: string;
  sqliteApplicationId: typeof STATE_STORE_SQLITE_APPLICATION_ID;
  sqliteUserVersion: typeof STATE_STORE_SQLITE_USER_VERSION;
  storeSchemaVersion: typeof STATE_STORE_SCHEMA_VERSION;
  old: OldV2;
  next: {
    stream: string; stateNonce: string; stateRevision: number;
    stateSha256: string; dbBytesB64: string; dbBytes: Uint8Array;
  };
}
export type ResetJournal = ResetJournalV1 | ResetJournalV2 | SQLiteResetJournalV2;

export type ResetJournalSchemaErrorCode =
  | "Z_LIMIT" | "UNKNOWN_MEMBER" | "MISSING_MEMBER" | "TYPE_MISMATCH"
  | "STRING_LIMIT" | "STRING_INVALID" | "BASE64_FORMAT" | "BASE64_LENGTH"
  | "BASE64_NONCANONICAL" | "EMBEDDED_HASH_MISMATCH"
  | "SCHEMA_DISCRIMINATOR" | "AUTHORIZATION_MISMATCH"
  | "APPLICATION_ID_MISMATCH" | "SCHEMA_ID_MISMATCH";

export class ResetJournalSchemaError extends Error {
  constructor(
    readonly code: ResetJournalSchemaErrorCode,
    readonly jsonPath: string,
    readonly limit: number | null = null,
  ) {
    super(code);
  }
}

const HEX16 = /^[0-9a-f]{16}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const B64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();
const MAX_TEXT = 4_096;
const MAX_REF = 192;
const MAX_Z = 256;
const MAX_DB_B64 = 349_528;
const MAX_DB_BYTES = 262_144;

type Obj = JsonObject;
function fail(code: ResetJournalSchemaErrorCode, path: string, limit: number | null = null): never {
  throw new ResetJournalSchemaError(code, path, limit);
}
const object = (value: unknown, path: string): Obj => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail("TYPE_MISMATCH", path);
  return value as Obj;
};
const exact = (value: Obj, keys: readonly string[], path: string): void => {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail("UNKNOWN_MEMBER", `${path}.${key}`);
  for (const key of keys) if (!Object.hasOwn(value, key)) fail("MISSING_MEMBER", `${path}.${key}`);
};
const string = (value: unknown, path: string, max = MAX_TEXT): string => {
  if (typeof value !== "string") fail("TYPE_MISMATCH", path);
  if (encoder.encode(value).byteLength > max) fail("STRING_LIMIT", path, max);
  if (value.includes("\0")) fail("STRING_INVALID", path);
  return value;
};
const counter = (value: unknown, path: string): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) fail("TYPE_MISMATCH", path);
  return value;
};
const fixed = (value: unknown, regex: RegExp, path: string): string => {
  if (typeof value !== "string") fail("TYPE_MISMATCH", path);
  if (!regex.test(value)) fail("STRING_INVALID", path);
  return value;
};
const canonicalTime = (value: unknown, path: string): string => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) fail("STRING_INVALID", path);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("STRING_INVALID", path);
  return value;
};
const hash = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const canonicalLine = (value: unknown): Uint8Array =>
  Buffer.concat([Buffer.from(canonicalize(value)), Buffer.from("\n")]);

function authorization(value: unknown, path: string): ResetJournalAuthorization {
  const obj = object(value, path);
  exact(obj, ["version", "authorizedNextStream", "consentKind", "mintedAtRevision"], path);
  if (obj.version !== 2) fail("SCHEMA_DISCRIMINATOR", `${path}.version`);
  const consent = obj.consentKind;
  if (consent !== "setup-rebind" && consent !== "setup-create") fail("STRING_INVALID", `${path}.consentKind`);
  return {
    version: 2,
    authorizedNextStream: string(obj.authorizedNextStream, `${path}.authorizedNextStream`),
    consentKind: consent,
    mintedAtRevision: counter(obj.mintedAtRevision, `${path}.mintedAtRevision`),
  };
}

function identity(value: unknown, path: string): RepoIdentityV1 {
  const obj = object(value, path);
  exact(obj, ["relPath", "kind", "worktreeId", "gitDirReal", "commonDirReal", "dev", "ino", "birthtime"], path);
  if (obj.kind !== "dir" && obj.kind !== "pointer") fail("STRING_INVALID", `${path}.kind`);
  const typed = {
    relPath: string(obj.relPath, `${path}.relPath`),
    kind: obj.kind,
    worktreeId: string(obj.worktreeId, `${path}.worktreeId`),
    gitDirReal: string(obj.gitDirReal, `${path}.gitDirReal`),
    commonDirReal: string(obj.commonDirReal, `${path}.commonDirReal`),
    dev: string(obj.dev, `${path}.dev`),
    ino: string(obj.ino, `${path}.ino`),
    birthtime: string(obj.birthtime, `${path}.birthtime`),
  } satisfies RepoIdentityV1;
  try { validateRepoIdentityV1(typed); } catch { fail("STRING_INVALID", path); }
  return typed;
}

function zEntries(value: unknown, path: string): ResetZEntry[] {
  if (!Array.isArray(value)) fail("TYPE_MISMATCH", path);
  if (value.length > MAX_Z) fail("Z_LIMIT", path, MAX_Z);
  const result = value.map((raw, index): ResetZEntry => {
    const here = `${path}[${index}]`;
    const obj = object(raw, here);
    exact(obj, ["lineageHash", "repositoryIdentityHash", "repositoryIdentity", "activeRef", "targetOid", "recoveryRef"], here);
    const lineageHash = fixed(obj.lineageHash, HEX64, `${here}.lineageHash`);
    const repositoryIdentityHashValue = fixed(obj.repositoryIdentityHash, HEX64, `${here}.repositoryIdentityHash`);
    const repositoryIdentity = identity(obj.repositoryIdentity, `${here}.repositoryIdentity`);
    if (repositoryIdentityHash(repositoryIdentity) !== repositoryIdentityHashValue) fail("EMBEDDED_HASH_MISMATCH", `${here}.repositoryIdentityHash`);
    const targetOid = fixed(obj.targetOid, HEX40, `${here}.targetOid`);
    const expectedActive = `refs/rbox-local/base-absent-settled/v1/${lineageHash}`;
    const expectedRecovery = `refs/rbox-recovery/base-absent/v1/${lineageHash}/${targetOid}`;
    const activeRef = string(obj.activeRef, `${here}.activeRef`, MAX_REF);
    const recoveryRef = string(obj.recoveryRef, `${here}.recoveryRef`, MAX_REF);
    if (activeRef !== expectedActive || recoveryRef !== expectedRecovery) fail("STRING_INVALID", here);
    return { lineageHash, repositoryIdentityHash: repositoryIdentityHashValue, repositoryIdentity, activeRef, targetOid, recoveryRef };
  });
  for (let index = 1; index < result.length; index++) {
    if (compareResetZEntries(result[index - 1]!, result[index]!) >= 0) fail("STRING_INVALID", `${path}[${index}]`);
  }
  return result;
}

function oldState(value: unknown, path: string, v2: boolean): OldV1 | OldV2 {
  const obj = object(value, path);
  exact(obj, ["stream", "stateNonce", "stateRevision", "stateSha256", ...(v2 ? ["archiveBaseline"] : []), "z"], path);
  const base: OldV1 = {
    stream: string(obj.stream, `${path}.stream`),
    stateNonce: fixed(obj.stateNonce, HEX32, `${path}.stateNonce`),
    stateRevision: counter(obj.stateRevision, `${path}.stateRevision`),
    stateSha256: fixed(obj.stateSha256, HEX64, `${path}.stateSha256`),
    z: zEntries(obj.z, `${path}.z`),
  };
  if (!v2) return base;
  if (obj.archiveBaseline !== "absent" && obj.archiveBaseline !== "exact") fail("STRING_INVALID", `${path}.archiveBaseline`);
  return { ...base, archiveBaseline: obj.archiveBaseline };
}

function legacyState(value: unknown, path: string): ResetNextState {
  const obj = object(value, path);
  const keys = ["stream", "stateNonce", "stateRevision", "lastSyncedSequence", "lastSyncedManifest", "repoRecords"];
  if (Object.hasOwn(obj, "telemetryBindingId")) keys.push("telemetryBindingId");
  exact(obj, keys, path);
  const manifest = object(obj.lastSyncedManifest, `${path}.lastSyncedManifest`);
  exact(manifest, ["generatedAt", "files"], `${path}.lastSyncedManifest`);
  const repos = object(obj.repoRecords, `${path}.repoRecords`);
  if (manifest.generatedAt !== "" || !Array.isArray(manifest.files) || manifest.files.length !== 0 || Object.keys(repos).length !== 0 || obj.lastSyncedSequence !== 0) {
    fail("TYPE_MISMATCH", path);
  }
  if (obj.telemetryBindingId !== undefined) fixed(obj.telemetryBindingId, HEX16, `${path}.telemetryBindingId`);
  return {
    stream: string(obj.stream, `${path}.stream`),
    stateNonce: fixed(obj.stateNonce, HEX32, `${path}.stateNonce`),
    stateRevision: counter(obj.stateRevision, `${path}.stateRevision`),
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
    ...(obj.telemetryBindingId === undefined ? {} : { telemetryBindingId: obj.telemetryBindingId as string }),
  };
}

function legacyNext(value: unknown, path: string): LegacyNext {
  const obj = object(value, path);
  exact(obj, ["stream", "stateNonce", "stateRevision", "stateSha256", "state"], path);
  const state = legacyState(obj.state, `${path}.state`);
  const next = {
    stream: string(obj.stream, `${path}.stream`),
    stateNonce: fixed(obj.stateNonce, HEX32, `${path}.stateNonce`),
    stateRevision: counter(obj.stateRevision, `${path}.stateRevision`),
    stateSha256: fixed(obj.stateSha256, HEX64, `${path}.stateSha256`),
    state,
  };
  if (state.stream !== next.stream || state.stateNonce !== next.stateNonce || state.stateRevision !== next.stateRevision) fail("STRING_INVALID", `${path}.state`);
  if (hash(canonicalLine(state)) !== next.stateSha256) fail("EMBEDDED_HASH_MISMATCH", `${path}.stateSha256`);
  return next;
}

function envelope(obj: Obj): { id: string; phase: ResetPhase; createdAt: string } {
  const phase = obj.phase;
  if (phase !== "prepared" && phase !== "ready" && phase !== "installed" && phase !== "z-retired") fail("STRING_INVALID", "$.phase");
  return { id: fixed(obj.id, HEX32, "$.id"), phase, createdAt: canonicalTime(obj.createdAt, "$.createdAt") };
}

function sqliteNext(value: unknown): SQLiteResetJournalV2["next"] {
  const obj = object(value, "$.next");
  exact(obj, ["stream", "stateNonce", "stateRevision", "stateSha256", "dbBytesB64"], "$.next");
  const dbBytesB64 = string(obj.dbBytesB64, "$.next.dbBytesB64", MAX_DB_B64);
  if (dbBytesB64.length % 4 !== 0 || !B64.test(dbBytesB64)) fail("BASE64_FORMAT", "$.next.dbBytesB64");
  const padding = dbBytesB64.endsWith("==") ? 2 : dbBytesB64.endsWith("=") ? 1 : 0;
  const decodedLength = (dbBytesB64.length / 4) * 3 - padding;
  if (decodedLength < 1 || decodedLength > MAX_DB_BYTES) fail("BASE64_LENGTH", "$.next.dbBytesB64", MAX_DB_BYTES);
  const dbBytes = Uint8Array.from(Buffer.from(dbBytesB64, "base64"));
  if (Buffer.from(dbBytes).toString("base64") !== dbBytesB64) fail("BASE64_NONCANONICAL", "$.next.dbBytesB64");
  const stateSha256 = fixed(obj.stateSha256, HEX64, "$.next.stateSha256");
  if (hash(dbBytes) !== stateSha256) fail("EMBEDDED_HASH_MISMATCH", "$.next.stateSha256");
  return {
    stream: string(obj.stream, "$.next.stream"),
    stateNonce: fixed(obj.stateNonce, HEX32, "$.next.stateNonce"),
    stateRevision: counter(obj.stateRevision, "$.next.stateRevision"),
    stateSha256, dbBytesB64, dbBytes,
  };
}

export function constructResetJournal(value: unknown): ResetJournal {
  const obj = object(value, "$");
  if (obj.v === 1) {
    exact(obj, ["v", "id", "phase", "createdAt", "old", "next"], "$");
    return { v: 1, ...envelope(obj), old: oldState(obj.old, "$.old", false) as OldV1, next: legacyNext(obj.next, "$.next") };
  }
  if (obj.v !== 2) fail("SCHEMA_DISCRIMINATOR", "$.v");
  if (Object.hasOwn(obj, "stateFormat")) {
    exact(obj, ["v", "stateFormat", "id", "phase", "createdAt", "authorization", "authorityId", "sqliteApplicationId", "sqliteUserVersion", "storeSchemaVersion", "old", "next"], "$");
    if (obj.stateFormat !== "sqlite/v1") fail("SCHEMA_DISCRIMINATOR", "$.stateFormat");
    if (obj.sqliteApplicationId !== STATE_STORE_SQLITE_APPLICATION_ID) fail("APPLICATION_ID_MISMATCH", "$.sqliteApplicationId");
    if (obj.sqliteUserVersion !== STATE_STORE_SQLITE_USER_VERSION || obj.storeSchemaVersion !== STATE_STORE_SCHEMA_VERSION) fail("SCHEMA_ID_MISMATCH", "$.sqliteUserVersion");
    const auth = authorization(obj.authorization, "$.authorization");
    const next = sqliteNext(obj.next);
    if (auth.authorizedNextStream !== next.stream) fail("AUTHORIZATION_MISMATCH", "$.authorization.authorizedNextStream");
    return {
      v: 2, stateFormat: "sqlite/v1", ...envelope(obj), authorization: auth,
      authorityId: fixed(obj.authorityId, HEX32, "$.authorityId"),
      sqliteApplicationId: STATE_STORE_SQLITE_APPLICATION_ID,
      sqliteUserVersion: STATE_STORE_SQLITE_USER_VERSION,
      storeSchemaVersion: STATE_STORE_SCHEMA_VERSION,
      old: oldState(obj.old, "$.old", true) as OldV2, next,
    };
  }
  exact(obj, ["v", "id", "phase", "createdAt", "authorization", "old", "next"], "$");
  const auth = authorization(obj.authorization, "$.authorization");
  const next = legacyNext(obj.next, "$.next");
  if (auth.authorizedNextStream !== next.stream) fail("AUTHORIZATION_MISMATCH", "$.authorization.authorizedNextStream");
  return { v: 2, ...envelope(obj), authorization: auth, old: oldState(obj.old, "$.old", true) as OldV2, next };
}
