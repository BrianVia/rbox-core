/**
 * Pure user-owned folder intent codecs and policy resolution (design 231).
 * This module never performs filesystem I/O or observes
 * bindings, registries, daemon state, remote identity, scope, or sync state.
 */
import crypto from "node:crypto";
import path from "node:path";
import { homeDir } from "./rbox-paths.js";
import type { JsonValue } from "../json.js";
import { trashConfig, type WorkspaceConfig } from "./workspace-config.js";
import { normalizeIgnorePath } from "../engine/ignore.js";

export const FOLDER_CATALOG_MAX_BYTES = 1024 * 1024;
export const FOLDER_CATALOG_MAX_FOLDERS = 1024;
export const FOLDER_NAME_MAX_SCALARS = 128;
export const FOLDER_PATH_MAX_BYTES = 4096;
export const FOLDER_IGNORE_PATHS_MAX = 1024;
export const FOLDER_TRASH_MAX_DAYS = 365;
export const FOLDER_TRASH_MAX_BYTES = 1099511627776;

export type FolderOptions = {
  syncGit?: boolean;
  git?: { incremental?: boolean };
  respectGitignore?: boolean;
  ignorePaths?: string[];
  noDrift?: boolean;
  trash?: { days?: number; maxBytes?: number };
};

export interface ResolvedFolderPolicy {
  syncGit: boolean;
  git: { incremental: boolean };
  respectGitignore: boolean;
  ignorePaths: string[];
  noDrift: boolean;
  trash: { days: number; maxBytes: number };
}

const EMPTY_IGNORE_PATHS: string[] = [];
Object.freeze(EMPTY_IGNORE_PATHS);

export const DEFAULT_FOLDER_POLICY: Readonly<ResolvedFolderPolicy> = Object.freeze({
  syncGit: true,
  git: Object.freeze({ incremental: true }),
  respectGitignore: false,
  ignorePaths: EMPTY_IGNORE_PATHS,
  noDrift: false,
  trash: Object.freeze({ days: 30, maxBytes: 2147483648 }),
});

export interface FolderCatalogEntry {
  name: string;
  path: string;
  options?: FolderOptions;
}

export interface FolderCatalog {
  schemaVersion: 1;
  globalOptions: FolderOptions;
  folders: FolderCatalogEntry[];
}

export interface FolderCatalogSnapshot {
  catalog: FolderCatalog;
  /** SHA-256 of the exact validated config bytes pinned by this snapshot. */
  generation: string;
  folders: ResolvedFolderCatalogEntry[];
}

export interface ResolvedFolderCatalogEntry extends FolderCatalogEntry {
  normalizedPath: string;
  policy: ResolvedFolderPolicy;
}

declare const folderCatalogRevisionBrand: unique symbol;

/** Opaque catalog freshness token. Callers may retain it and compare with `===`. */
export type FolderCatalogRevision = string & { readonly [folderCatalogRevisionBrand]: true };

export type FolderCatalogState =
  | { kind: "absent"; revision: FolderCatalogRevision }
  | { kind: "authoritative"; snapshot: FolderCatalogSnapshot; revision: FolderCatalogRevision }
  | { kind: "damaged"; reason: string; revision: FolderCatalogRevision };

export class FolderCatalogError extends Error {
  constructor(message: string) {
    super(`invalid rbox folder config: ${message}`);
    this.name = "FolderCatalogError";
  }
}

export class FolderCatalogStaleEditError extends Error {
  constructor() {
    super("rbox folder config changed while it was being published; review the edit and retry");
    this.name = "FolderCatalogStaleEditError";
  }
}

function digest(bytes: string | Uint8Array): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

/**
 * A member of the parsed config document, or the same member as a typed caller
 * already holds it (an absent optional field is `undefined`, which JSON has no
 * spelling for). Every validator below reads exactly this domain.
 */
type ConfigValue = JsonValue | undefined | { [key: string]: ConfigValue } | ConfigValue[];
type ConfigObject = { [key: string]: ConfigValue };

function object(value: ConfigValue, at: string): ConfigObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FolderCatalogError(`${at} must be an object`);
  }
  return value;
}

function closed(value: ConfigObject, allowed: readonly string[], at: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown !== undefined) throw new FolderCatalogError(`${at}.${unknown} is not supported`);
}

function required(value: ConfigObject, key: string, at: string): ConfigValue {
  if (!Object.hasOwn(value, key)) throw new FolderCatalogError(`${at}.${key} is required`);
  return value[key];
}

function booleanField(value: ConfigValue, at: string): boolean {
  if (typeof value !== "boolean") throw new FolderCatalogError(`${at} must be true or false`);
  return value;
}

function boundedInteger(value: ConfigValue, min: number, max: number, at: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isSafeInteger(value)
    || value < min || value > max) {
    throw new FolderCatalogError(`${at} must be an integer from ${min} through ${max}`);
  }
  return value;
}

function hasOnlyUnicodeScalars(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(++index);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/** Shape check for an ALREADY-PERSISTED ignorePaths list (the adoption journal's
 *  pinned policy). Catalog ingress uses {@link parseOptions} instead, which reports
 *  which entry was rejected and why; a durable record only needs a yes/no. */
export const isIgnorePathList = (value: JsonValue | undefined): value is string[] =>
  Array.isArray(value) && value.length <= FOLDER_IGNORE_PATHS_MAX
    && value.every((entry) => typeof entry === "string" && normalizeIgnorePath(entry) !== undefined);

function parseOptions(value: ConfigValue, at: string): FolderOptions {
  const raw = object(value, at);
  closed(raw, ["syncGit", "git", "respectGitignore", "ignorePaths", "noDrift", "trash"], at);
  const result: FolderOptions = {};
  if (Object.hasOwn(raw, "syncGit")) result.syncGit = booleanField(raw.syncGit, `${at}.syncGit`);
  if (Object.hasOwn(raw, "respectGitignore")) {
    result.respectGitignore = booleanField(raw.respectGitignore, `${at}.respectGitignore`);
  }
  if (Object.hasOwn(raw, "ignorePaths")) {
    if (!Array.isArray(raw.ignorePaths)) throw new FolderCatalogError(`${at}.ignorePaths must be an array`);
    if (raw.ignorePaths.length > FOLDER_IGNORE_PATHS_MAX) {
      throw new FolderCatalogError(`${at}.ignorePaths exceeds ${FOLDER_IGNORE_PATHS_MAX} entries`);
    }
    result.ignorePaths = raw.ignorePaths.map((entry, index) => {
      const entryAt = `${at}.ignorePaths[${index}]`;
      if (typeof entry !== "string") throw new FolderCatalogError(`${entryAt} must be a string`);
      if (!hasOnlyUnicodeScalars(entry)) throw new FolderCatalogError(`${entryAt} contains an invalid Unicode scalar`);
      if (Buffer.byteLength(entry, "utf8") > FOLDER_PATH_MAX_BYTES) {
        throw new FolderCatalogError(`${entryAt} exceeds ${FOLDER_PATH_MAX_BYTES} UTF-8 bytes`);
      }
      if (normalizeIgnorePath(entry) === undefined) {
        throw new FolderCatalogError(`${entryAt} must be a workspace-relative path with no globs, negations, or "..": ${JSON.stringify(entry)}`);
      }
      return entry;
    });
  }
  if (Object.hasOwn(raw, "noDrift")) result.noDrift = booleanField(raw.noDrift, `${at}.noDrift`);
  if (Object.hasOwn(raw, "git")) {
    const git = object(raw.git, `${at}.git`);
    closed(git, ["incremental"], `${at}.git`);
    result.git = {};
    if (Object.hasOwn(git, "incremental")) {
      result.git.incremental = booleanField(git.incremental, `${at}.git.incremental`);
    }
  }
  if (Object.hasOwn(raw, "trash")) {
    const trash = object(raw.trash, `${at}.trash`);
    closed(trash, ["days", "maxBytes"], `${at}.trash`);
    result.trash = {};
    if (Object.hasOwn(trash, "days")) {
      result.trash.days = boundedInteger(trash.days, 0, FOLDER_TRASH_MAX_DAYS, `${at}.trash.days`);
    }
    if (Object.hasOwn(trash, "maxBytes")) {
      result.trash.maxBytes = boundedInteger(
        trash.maxBytes,
        0,
        FOLDER_TRASH_MAX_BYTES,
        `${at}.trash.maxBytes`,
      );
    }
  }
  return result;
}

function validateName(value: ConfigValue, at: string): string {
  if (typeof value !== "string") throw new FolderCatalogError(`${at} must be a string`);
  if (!hasOnlyUnicodeScalars(value)) throw new FolderCatalogError(`${at} contains an invalid Unicode scalar`);
  if (value.length === 0 || value.trim() !== value) {
    throw new FolderCatalogError(`${at} must be non-empty and have no leading or trailing whitespace`);
  }
  if (value.normalize("NFC") !== value) throw new FolderCatalogError(`${at} must already be NFC-normalized`);
  if (Array.from(value).length > FOLDER_NAME_MAX_SCALARS) {
    throw new FolderCatalogError(`${at} exceeds ${FOLDER_NAME_MAX_SCALARS} Unicode scalar values`);
  }
  return value;
}

/** Expand only `~` and `~/...`; shell-style `~user` is intentionally unsupported. */
export function expandFolderPath(value: string, home = homeDir()): string {
  if (!hasOnlyUnicodeScalars(value)) throw new FolderCatalogError("folder path contains an invalid Unicode scalar");
  if (value.includes("\0")) throw new FolderCatalogError("folder path contains NUL");
  if (Buffer.byteLength(value, "utf8") > FOLDER_PATH_MAX_BYTES) {
    throw new FolderCatalogError(`folder path exceeds ${FOLDER_PATH_MAX_BYTES} UTF-8 bytes`);
  }
  let expanded = value;
  if (value === "~") expanded = home;
  else if (value.startsWith("~/")) expanded = path.join(home, value.slice(2));
  else if (value.startsWith("~")) throw new FolderCatalogError("folder path does not support ~user expansion");
  if (!path.isAbsolute(expanded)) throw new FolderCatalogError("folder path must be absolute after ~ expansion");
  return path.resolve(expanded);
}

/** Render a path under the home boundary as `~`/`~/...` without changing identity. */
export function collapseFolderPath(value: string, home = homeDir()): string {
  if (!path.isAbsolute(value) || !path.isAbsolute(home)) {
    throw new FolderCatalogError("only absolute folder paths can be collapsed");
  }
  const normalized = path.resolve(value);
  const normalizedHome = path.resolve(home);
  if (normalized === normalizedHome) return "~";
  const relative = path.relative(normalizedHome, normalized);
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return normalized;
}

/** Parse and validate the complete closed schema. Physical/nested overlaps remain valid. */
export function parseFolderCatalog(bytes: string, home = homeDir()): FolderCatalog {
  if (Buffer.byteLength(bytes, "utf8") > FOLDER_CATALOG_MAX_BYTES) {
    throw new FolderCatalogError(`config exceeds ${FOLDER_CATALOG_MAX_BYTES} bytes`);
  }
  let decoded: ConfigValue;
  try {
    decoded = JSON.parse(bytes);
  } catch (error) {
    throw new FolderCatalogError(`config is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  const raw = object(decoded, "$");
  closed(raw, ["schemaVersion", "globalOptions", "folders"], "$");
  const version = required(raw, "schemaVersion", "$");
  if (version !== 1) {
    throw new FolderCatalogError(
      typeof version === "number" && version > 1
        ? `schemaVersion ${version} is newer than this rbox supports`
        : "$.schemaVersion must be 1",
    );
  }
  const globalOptions = parseOptions(required(raw, "globalOptions", "$"), "$.globalOptions");
  const folderValues = required(raw, "folders", "$");
  if (!Array.isArray(folderValues)) throw new FolderCatalogError("$.folders must be an array");
  if (folderValues.length > FOLDER_CATALOG_MAX_FOLDERS) {
    throw new FolderCatalogError(`$.folders exceeds ${FOLDER_CATALOG_MAX_FOLDERS} entries`);
  }
  const names = new Set<string>();
  const normalizedPaths = new Set<string>();
  const folders = folderValues.map((value, index): FolderCatalogEntry => {
    const at = `$.folders[${index}]`;
    const entry = object(value, at);
    closed(entry, ["name", "path", "options"], at);
    const name = validateName(required(entry, "name", at), `${at}.name`);
    if (names.has(name)) throw new FolderCatalogError(`${at}.name duplicates the exact local name ${JSON.stringify(name)}`);
    names.add(name);
    const storedPath = required(entry, "path", at);
    if (typeof storedPath !== "string") throw new FolderCatalogError(`${at}.path must be a string`);
    const normalizedPath = expandFolderPath(storedPath, home);
    if (normalizedPaths.has(normalizedPath)) {
      throw new FolderCatalogError(`${at}.path duplicates normalized path ${JSON.stringify(normalizedPath)}`);
    }
    normalizedPaths.add(normalizedPath);
    const options = Object.hasOwn(entry, "options") ? parseOptions(entry.options, `${at}.options`) : undefined;
    return { name, path: storedPath, ...(options === undefined ? {} : { options }) };
  });
  return { schemaVersion: 1, globalOptions, folders };
}

export function serializeFolderCatalog(catalog: FolderCatalog, home = homeDir()): string {
  const bytes = `${JSON.stringify(catalog, null, 2)}\n`;
  // Serialization is a publication boundary, so typed callers do not bypass
  // the runtime closed-schema and bounds checks.
  parseFolderCatalog(bytes, home);
  return bytes;
}

export function folderCatalogGeneration(bytes: string): string {
  parseFolderCatalog(bytes);
  return digest(bytes);
}

/** Resolve nested values field-by-field; false and zero never mean "inherit". */
export function resolveFolderPolicy(globalOptions: FolderOptions, folderOptions: FolderOptions = {}): ResolvedFolderPolicy {
  const global = parseOptions(globalOptions, "globalOptions");
  const folder = parseOptions(folderOptions, "folderOptions");
  return {
    syncGit: folder.syncGit ?? global.syncGit ?? DEFAULT_FOLDER_POLICY.syncGit,
    git: {
      incremental: folder.git?.incremental ?? global.git?.incremental ?? DEFAULT_FOLDER_POLICY.git.incremental,
    },
    respectGitignore: folder.respectGitignore
      ?? global.respectGitignore
      ?? DEFAULT_FOLDER_POLICY.respectGitignore,
    ignorePaths: folder.ignorePaths ?? global.ignorePaths ?? DEFAULT_FOLDER_POLICY.ignorePaths,
    noDrift: folder.noDrift ?? global.noDrift ?? DEFAULT_FOLDER_POLICY.noDrift,
    trash: {
      days: folder.trash?.days ?? global.trash?.days ?? DEFAULT_FOLDER_POLICY.trash.days,
      maxBytes: folder.trash?.maxBytes
        ?? global.trash?.maxBytes
        ?? DEFAULT_FOLDER_POLICY.trash.maxBytes,
    },
  };
}

/** Materialize the exact effective pre-catalog binding policy for generation. */
export function snapshotPreCatalogPolicy(binding: WorkspaceConfig): FolderOptions {
  return {
    syncGit: binding.syncGit === true,
    git: { incremental: binding.git?.incremental === false ? false : true },
    respectGitignore: binding.respectGitignore === true,
    ignorePaths: binding.ignorePaths ?? [],
    noDrift: binding.noDrift === true,
    trash: trashConfig(binding),
  };
}

function snapshot(bytes: string): FolderCatalogSnapshot {
  const catalog = parseFolderCatalog(bytes);
  return {
    catalog,
    generation: digest(bytes),
    folders: catalog.folders.map((folder) => ({
      ...folder,
      normalizedPath: expandFolderPath(folder.path),
      policy: resolveFolderPolicy(catalog.globalOptions, folder.options),
    })),
  };
}

/** Internal bridge for state inspection and publication; not re-exported by the facade. */
export default {
  revision: (value: string): FolderCatalogRevision => value as FolderCatalogRevision,
  revisionForBytes: (bytes: string | Uint8Array): FolderCatalogRevision => digest(bytes) as FolderCatalogRevision,
  snapshot,
};
