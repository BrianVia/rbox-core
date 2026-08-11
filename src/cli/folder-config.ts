/**
 * User-owned folder intent (design 231, dormant foundation).
 *
 * This is deliberately dependency-light and has no runtime callers yet. It owns
 * the closed config/authority codecs, pure policy resolution, and the one
 * durable publication boundary. It never observes bindings, registries,
 * daemon state, remote identity, scope, or sync runtime state.
 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDirectoryChain,
  fsyncCreatedDirectoryAncestors,
  fsyncDirectory,
  writeFileAtomic,
} from "../engine/fsutil.js";
import { acquireLock, type AcquireLockOptions, type OwnedLock } from "../engine/git/lockfile.js";
import {
  folderCatalogAuthorityPath,
  folderCatalogLockPath,
  folderCatalogPath,
  homeDir,
  rboxDir,
} from "./rbox-paths.js";

export const FOLDER_CATALOG_MAX_BYTES = 1024 * 1024;
export const FOLDER_CATALOG_MAX_FOLDERS = 1024;
export const FOLDER_NAME_MAX_SCALARS = 128;
export const FOLDER_PATH_MAX_BYTES = 4096;
export const FOLDER_TRASH_MAX_DAYS = 365;
export const FOLDER_TRASH_MAX_BYTES = 1099511627776;
const AUTHORITY_MAX_BYTES = 4096;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;

export interface FolderOptions {
  syncGit?: boolean;
  git?: { incremental?: boolean };
  respectGitignore?: boolean;
  noDrift?: boolean;
  trash?: { days?: number; maxBytes?: number };
}

export interface ResolvedFolderPolicy {
  syncGit: boolean;
  git: { incremental: boolean };
  respectGitignore: boolean;
  noDrift: boolean;
  trash: { days: number; maxBytes: number };
}

export const DEFAULT_FOLDER_POLICY: Readonly<ResolvedFolderPolicy> = Object.freeze({
  syncGit: true,
  git: Object.freeze({ incremental: true }),
  respectGitignore: false,
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

interface FolderCatalogAuthority {
  schemaVersion: 1;
  activatedAt: string;
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

export type FolderCandidateSeed = {
  name: string;
  path: string;
  policy: { kind: "available"; options?: FolderOptions } | { kind: "unavailable"; reason: string };
};

export interface FolderCatalogCandidate {
  catalog: FolderCatalog;
  bytes: string;
  generation: string;
  /** Exact observations the publication compare must still see. */
  source: { configDigest: string | null; markerDigest: string | null };
  origin: "generated" | "existing";
  skippedUnavailable: Array<{ name: string; path: string; reason: string }>;
}

export type FolderCatalogState =
  | { kind: "legacy" }
  | { kind: "candidate"; snapshot: FolderCatalogSnapshot; candidate: FolderCatalogCandidate }
  | { kind: "authoritative"; snapshot: FolderCatalogSnapshot; activatedAt: string }
  | { kind: "damaged"; authorityActivated: boolean; reason: string };

export type FolderCatalogPublicationStep =
  | "before-config-write"
  | "after-config-write"
  | "before-config-directory-fsync"
  | "after-config-directory-fsync"
  | "before-marker-write"
  | "after-marker-write"
  | "before-marker-directory-fsync"
  | "after-marker-directory-fsync";

export type FolderCatalogAtomicStep =
  | "temp-opened"
  | "temp-written"
  | "temp-synced"
  | "temp-closed"
  | "before-rename"
  | "after-rename";

export interface FolderCatalogPublicationOptions {
  now?: () => Date;
  onStep?: (step: FolderCatalogPublicationStep) => void | Promise<void>;
  onAtomicStep?: (target: "config" | "marker", step: FolderCatalogAtomicStep) => void | Promise<void>;
  /** Lock identity seam for platform/fault tests; production uses system identity. */
  lock?: AcquireLockOptions;
}

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

function digest(bytes: string): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

type UnknownObject = { [key: string]: unknown };

function object(value: unknown, at: string): UnknownObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new FolderCatalogError(`${at} must be an object`);
  }
  return value as UnknownObject;
}

function closed(value: UnknownObject, allowed: readonly string[], at: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(value).find((key) => !allow.has(key));
  if (unknown !== undefined) throw new FolderCatalogError(`${at}.${unknown} is not supported`);
}

function required(value: UnknownObject, key: string, at: string): unknown {
  if (!Object.hasOwn(value, key)) throw new FolderCatalogError(`${at}.${key} is required`);
  return value[key];
}

function booleanField(value: unknown, at: string): boolean {
  if (typeof value !== "boolean") throw new FolderCatalogError(`${at} must be true or false`);
  return value;
}

function boundedInteger(value: unknown, min: number, max: number, at: string): number {
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

function parseOptions(value: unknown, at: string): FolderOptions {
  const raw = object(value, at);
  closed(raw, ["syncGit", "git", "respectGitignore", "noDrift", "trash"], at);
  const result: FolderOptions = {};
  if (Object.hasOwn(raw, "syncGit")) result.syncGit = booleanField(raw.syncGit, `${at}.syncGit`);
  if (Object.hasOwn(raw, "respectGitignore")) {
    result.respectGitignore = booleanField(raw.respectGitignore, `${at}.respectGitignore`);
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

function validateName(value: unknown, at: string): string {
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
  let decoded: unknown;
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
    noDrift: folder.noDrift ?? global.noDrift ?? DEFAULT_FOLDER_POLICY.noDrift,
    trash: {
      days: folder.trash?.days ?? global.trash?.days ?? DEFAULT_FOLDER_POLICY.trash.days,
      maxBytes: folder.trash?.maxBytes
        ?? global.trash?.maxBytes
        ?? DEFAULT_FOLDER_POLICY.trash.maxBytes,
    },
  };
}

export function buildFolderCatalogCandidate(
  seeds: readonly FolderCandidateSeed[],
  globalOptions: FolderOptions = {},
  options: { skipUnavailable?: boolean; home?: string } = {},
): FolderCatalogCandidate {
  const skippedUnavailable: FolderCatalogCandidate["skippedUnavailable"] = [];
  const folders: FolderCatalogEntry[] = [];
  for (const seed of seeds) {
    if (seed.policy.kind === "unavailable") {
      if (!options.skipUnavailable) {
        throw new FolderCatalogError(
          `cannot preserve policy for ${JSON.stringify(seed.path)}: ${seed.policy.reason}; restore it or explicitly skip unavailable folders`,
        );
      }
      skippedUnavailable.push({ name: seed.name, path: seed.path, reason: seed.policy.reason });
      continue;
    }
    folders.push({
      name: seed.name,
      path: collapseFolderPath(expandFolderPath(seed.path, options.home), options.home),
      ...(seed.policy.options === undefined ? {} : { options: seed.policy.options }),
    });
  }
  const catalog: FolderCatalog = { schemaVersion: 1, globalOptions, folders };
  const bytes = serializeFolderCatalog(catalog, options.home);
  return {
    catalog: parseFolderCatalog(bytes, options.home),
    bytes,
    generation: digest(bytes),
    source: { configDigest: null, markerDigest: null },
    origin: "generated",
    skippedUnavailable,
  };
}

async function readBounded(file: string, maxBytes: number): Promise<string | undefined> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error(`${file} is not a regular file`);
    if (stat.size > maxBytes) throw new Error(`${file} exceeds its ${maxBytes}-byte limit`);
    const buffer = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > maxBytes) throw new Error(`${file} exceeds its ${maxBytes}-byte limit`);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, offset));
    } catch {
      throw new Error(`${file} is not valid UTF-8`);
    }
  } finally {
    await handle.close();
  }
}

function parseAuthority(bytes: string): FolderCatalogAuthority {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new Error("config-authority.json is not valid JSON");
  }
  const raw = object(value, "authority marker");
  closed(raw, ["schemaVersion", "activatedAt"], "authority marker");
  if (required(raw, "schemaVersion", "authority marker") !== 1) {
    throw new Error("config-authority.json has an unsupported schemaVersion");
  }
  const activatedAt = required(raw, "activatedAt", "authority marker");
  if (typeof activatedAt !== "string"
    || Number.isNaN(Date.parse(activatedAt))
    || new Date(activatedAt).toISOString() !== activatedAt) {
    throw new Error("config-authority.json activatedAt must be an ISO timestamp");
  }
  return { schemaVersion: 1, activatedAt };
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

/** Inspect without healing. Any evidence of activated-but-broken authority fails closed. */
export async function inspectFolderCatalog(): Promise<FolderCatalogState> {
  const [configRead, markerRead] = await Promise.allSettled([
    readBounded(folderCatalogPath(), FOLDER_CATALOG_MAX_BYTES),
    readBounded(folderCatalogAuthorityPath(), AUTHORITY_MAX_BYTES),
  ]);
  if (markerRead.status === "rejected") {
    return {
      kind: "damaged",
      authorityActivated: true,
      reason: markerRead.reason instanceof Error ? markerRead.reason.message : String(markerRead.reason),
    };
  }
  const markerBytes = markerRead.value;
  if (configRead.status === "rejected") {
    return {
      kind: "damaged",
      authorityActivated: markerBytes !== undefined,
      reason: configRead.reason instanceof Error ? configRead.reason.message : String(configRead.reason),
    };
  }
  const configBytes = configRead.value;
  if (configBytes === undefined && markerBytes === undefined) return { kind: "legacy" };
  let authority: FolderCatalogAuthority | undefined;
  if (markerBytes !== undefined) {
    try {
      authority = parseAuthority(markerBytes);
    } catch (error) {
      return { kind: "damaged", authorityActivated: true, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  if (configBytes === undefined) {
    return {
      kind: "damaged",
      authorityActivated: markerBytes !== undefined,
      reason: markerBytes === undefined ? "config is absent" : "config-authority.json exists but config.json is absent",
    };
  }
  let validated: FolderCatalogSnapshot;
  try {
    validated = snapshot(configBytes);
  } catch (error) {
    return {
      kind: "damaged",
      authorityActivated: markerBytes !== undefined,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (authority) return { kind: "authoritative", snapshot: validated, activatedAt: authority.activatedAt };
  return {
    kind: "candidate",
    snapshot: validated,
    candidate: {
      catalog: validated.catalog,
      bytes: configBytes,
      generation: validated.generation,
      source: { configDigest: validated.generation, markerDigest: null },
      origin: "existing",
      skippedUnavailable: [],
    },
  };
}

export async function readFolderCatalog(): Promise<FolderCatalogSnapshot> {
  const state = await inspectFolderCatalog();
  if (state.kind === "authoritative") return state.snapshot;
  if (state.kind === "damaged") throw new Error(`rbox folder configuration is damaged: ${state.reason}`);
  throw new Error(state.kind === "legacy"
    ? "rbox folder configuration is not authoritative on this machine"
    : "rbox folder configuration is awaiting authority activation");
}

async function observation(file: string, maxBytes: number): Promise<string | null> {
  const bytes = await readBounded(file, maxBytes);
  return bytes === undefined ? null : digest(bytes);
}

async function matches(configDigest: string | null, markerDigest: string | null): Promise<boolean> {
  const [config, marker] = await Promise.all([
    observation(folderCatalogPath(), FOLDER_CATALOG_MAX_BYTES),
    observation(folderCatalogAuthorityPath(), AUTHORITY_MAX_BYTES),
  ]);
  return config === configDigest && marker === markerDigest;
}

async function catalogLock(options?: AcquireLockOptions): Promise<OwnedLock> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const acquired = await acquireLock(folderCatalogLockPath(), options);
    if (acquired.status === "acquired") return acquired.lock;
    if (acquired.status === "unsupported" || acquired.status === "error") {
      throw new Error(`cannot lock rbox folder config: ${String(acquired.error)}`);
    }
    if (Date.now() >= deadline) throw new Error("rbox folder config is busy; retry in a moment");
    await new Promise<void>((resolve) => setTimeout(resolve, LOCK_POLL_MS));
  }
}

async function syncExistingFile(file: string): Promise<void> {
  const handle = await fs.open(file, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicComparedWrite(
  file: string,
  bytes: string,
  expectedConfig: string | null,
  expectedMarker: string | null,
  target: "config" | "marker",
  options: FolderCatalogPublicationOptions,
): Promise<void> {
  let stale = false;
  await writeFileAtomic(file, bytes, {
    mode: 0o600,
    exactMode: true,
    beforeRename: async () => {
      const current = await matches(expectedConfig, expectedMarker);
      stale = !current;
      return current;
    },
    onStep: (step) => options.onAtomicStep?.(target, step),
  });
  if (stale) throw new FolderCatalogStaleEditError();
}

/**
 * Durably publish caller-observed intent, then the activation marker. A
 * hand-authored candidate is never rewritten; it is synced and compared again
 * immediately before marker publication.
 */
export async function publishInitialFolderCatalog(
  candidate: FolderCatalogCandidate,
  options: FolderCatalogPublicationOptions = {},
): Promise<FolderCatalogSnapshot> {
  const validatedBytes = serializeFolderCatalog(candidate.catalog);
  const parsedCandidate = parseFolderCatalog(candidate.bytes);
  const normalizedCatalog = parseFolderCatalog(validatedBytes);
  if (JSON.stringify(parsedCandidate) !== JSON.stringify(normalizedCatalog)
    || digest(candidate.bytes) !== candidate.generation) {
    throw new Error("folder catalog candidate is internally inconsistent");
  }
  const created = await ensureDirectoryChain(rboxDir(), "rbox config directory");
  await fsyncCreatedDirectoryAncestors(rboxDir(), created);
  const lock = await catalogLock(options.lock);
  try {
    if (!await matches(candidate.source.configDigest, candidate.source.markerDigest)) {
      throw new FolderCatalogStaleEditError();
    }
    if (candidate.origin === "generated") {
      await options.onStep?.("before-config-write");
      await atomicComparedWrite(folderCatalogPath(), candidate.bytes, null, null, "config", options);
      await options.onStep?.("after-config-write");
      await options.onStep?.("before-config-directory-fsync");
      await fsyncDirectory(path.dirname(folderCatalogPath()));
      await options.onStep?.("after-config-directory-fsync");
    } else {
      await syncExistingFile(folderCatalogPath());
      await fsyncDirectory(path.dirname(folderCatalogPath()));
      if (!await matches(candidate.generation, null)) throw new FolderCatalogStaleEditError();
    }

    const authority: FolderCatalogAuthority = {
      schemaVersion: 1,
      activatedAt: (options.now?.() ?? new Date()).toISOString(),
    };
    const authorityBytes = `${JSON.stringify(authority, null, 2)}\n`;
    await options.onStep?.("before-marker-write");
    await atomicComparedWrite(
      folderCatalogAuthorityPath(),
      authorityBytes,
      candidate.generation,
      null,
      "marker",
      options,
    );
    await options.onStep?.("after-marker-write");
    await options.onStep?.("before-marker-directory-fsync");
    await fsyncDirectory(path.dirname(folderCatalogAuthorityPath()));
    await options.onStep?.("after-marker-directory-fsync");
    return snapshot(candidate.bytes);
  } finally {
    await lock.release();
  }
}
