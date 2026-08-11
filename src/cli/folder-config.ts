/**
 * User-owned folder intent publication (design 231, dormant foundation).
 *
 * This module owns authority-state inspection and the one durable publication
 * boundary. It never observes bindings, registries, daemon state, remote
 * identity, scope, or sync runtime state. The pure codec is re-exported so
 * this remains the single import surface.
 */
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
import codecInternals, {
  expandFolderPath,
  FOLDER_CATALOG_MAX_BYTES,
  FolderCatalogStaleEditError,
  parseFolderCatalog,
  resolveFolderPolicy,
  serializeFolderCatalog,
  type FolderCatalogCandidate,
  type FolderCatalogSnapshot,
  type FolderCatalogState,
} from "./folder-config-codec.js";
import {
  folderCatalogAuthorityPath,
  folderCatalogLockPath,
  folderCatalogPath,
  rboxDir,
} from "./rbox-paths.js";

export * from "./folder-config-codec.js";

const { closed, digest, object, required } = codecInternals;

const AUTHORITY_MAX_BYTES = 4096;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 25;

interface FolderCatalogAuthority {
  schemaVersion: 1;
  activatedAt: string;
}

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
