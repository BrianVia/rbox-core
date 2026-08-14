/** Atomic state inspection and globally locked publication for `config.json`. */
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
import { acquireLock, type AcquireLockOptions, type OwnedLock } from "../engine/lockfile.js";
import codecInternals, {
  FOLDER_CATALOG_MAX_BYTES,
  FolderCatalogStaleEditError,
  type FolderCatalogRevision,
  type FolderCatalogSnapshot,
  type FolderCatalogState,
} from "./folder-config-codec.js";
import { folderCatalogDir, folderCatalogLockPath, folderCatalogPath } from "./rbox-paths.js";

export type FolderCatalogPublicationStep =
  | "before-write"
  | "after-write"
  | "before-directory-fsync"
  | "after-directory-fsync";

export type FolderCatalogAtomicStep =
  | "temp-opened"
  | "temp-written"
  | "temp-synced"
  | "temp-closed"
  | "before-rename"
  | "after-rename";

export type FolderCatalogDirectoryStep = "after-create" | "after-created-ancestor-fsync";

export interface FolderCatalogPublicationOptions {
  onStep?: (step: FolderCatalogPublicationStep) => void | Promise<void>;
  onAtomicStep?: (step: FolderCatalogAtomicStep) => void | Promise<void>;
  onDirectoryStep?: (step: FolderCatalogDirectoryStep, directory: string) => void | Promise<void>;
  /** Fault/collision seam for stale temporary-file recovery tests. */
  beforeTempOpen?: (temporary: string) => void | Promise<void>;
  lock?: AcquireLockOptions;
  lockWaitMs?: number;
  lockPollMs?: number;
}

export type FolderCatalogNoReplaceResult =
  | { kind: "published"; snapshot: FolderCatalogSnapshot }
  | { kind: "existing"; snapshot: FolderCatalogSnapshot };

type FileObservation =
  | { kind: "absent"; revision: FolderCatalogRevision }
  | { kind: "readable"; bytes: string; revision: FolderCatalogRevision }
  | { kind: "damaged"; reason: string; revision: FolderCatalogRevision }
  | { kind: "unreadable"; reason: string; revision: FolderCatalogRevision };

type LockedMutation<T> =
  | { kind: "unchanged"; value: T }
  | { kind: "replace"; bytes: string; value: (snapshot: FolderCatalogSnapshot) => T };

let tempCounter = 0;
const readableEvidence = new WeakMap<object, string>();

async function observeFile(): Promise<FileObservation> {
  let handle: fs.FileHandle;
  try {
    handle = await fs.open(
      folderCatalogPath(),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { kind: "absent", revision: codecInternals.revision("absent") };
    }
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
      revision: codecInternals.revision("unreadable"),
    };
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      return {
        kind: "unreadable",
        reason: `${folderCatalogPath()} is not a regular file`,
        revision: codecInternals.revision("unreadable"),
      };
    }
    const hash = crypto.createHash("sha256");
    const retained: Buffer[] = [];
    const chunk = Buffer.alloc(64 * 1024);
    let total = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      hash.update(bytes);
      total += bytesRead;
      if (total <= FOLDER_CATALOG_MAX_BYTES) retained.push(Buffer.from(bytes));
    }
    const revision = codecInternals.revision(hash.digest("hex"));
    if (total > FOLDER_CATALOG_MAX_BYTES) {
      return {
        kind: "damaged",
        reason: `${folderCatalogPath()} exceeds its ${FOLDER_CATALOG_MAX_BYTES}-byte limit`,
        revision,
      };
    }
    try {
      const bytes = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(retained, total));
      return { kind: "readable", bytes, revision };
    } catch {
      return { kind: "damaged", reason: `${folderCatalogPath()} is not valid UTF-8`, revision };
    }
  } catch (error) {
    return {
      kind: "unreadable",
      reason: error instanceof Error ? error.message : String(error),
      revision: codecInternals.revision("unreadable"),
    };
  } finally {
    await handle.close().catch(() => {});
  }
}

function stateFrom(observation: FileObservation): FolderCatalogState {
  if (observation.kind === "absent") return observation;
  if (observation.kind === "damaged" || observation.kind === "unreadable") {
    return { kind: "damaged", reason: observation.reason, revision: observation.revision };
  }
  try {
    const state: FolderCatalogState = {
      kind: "authoritative",
      snapshot: codecInternals.snapshot(observation.bytes),
      revision: observation.revision,
    };
    readableEvidence.set(state, observation.bytes);
    return state;
  } catch (error) {
    const state: FolderCatalogState = {
      kind: "damaged",
      reason: error instanceof Error ? error.message : String(error),
      revision: observation.revision,
    };
    readableEvidence.set(state, observation.bytes);
    return state;
  }
}

function readableEntries(state: FolderCatalogState): Array<{ name: string; path: string }> {
  if (state.kind === "authoritative") {
    return state.snapshot.catalog.folders.map(({ name, path: storedPath }) => ({ name, path: storedPath }));
  }
  const bytes = readableEvidence.get(state);
  if (bytes === undefined) return [];
  try {
    const decoded = JSON.parse(bytes) as { folders?: unknown };
    if (!Array.isArray(decoded?.folders)) return [];
    return decoded.folders.flatMap((entry) => {
      if (typeof entry !== "object" || entry === null) return [];
      const value = entry as { name?: unknown; path?: unknown };
      return typeof value.name === "string" && typeof value.path === "string"
        ? [{ name: value.name, path: value.path }]
        : [];
    });
  } catch {
    return [];
  }
}

function authorityError(state: Exclude<FolderCatalogState, { kind: "authoritative" }>): Error {
  return state.kind === "damaged"
    ? new Error(
      `rbox folder configuration is damaged: ${state.reason}. Copy ${folderCatalogPath()} somewhere safe, then run \`rbox config regenerate\`.`,
    )
    : new Error("rbox folder configuration is absent; run `rbox config regenerate`");
}

export async function inspectFolderCatalog(): Promise<FolderCatalogState> {
  return stateFrom(await observeFile());
}

export async function readFolderCatalog(): Promise<FolderCatalogSnapshot> {
  const state = await inspectFolderCatalog();
  if (state.kind === "authoritative") return state.snapshot;
  throw authorityError(state);
}

async function catalogLock(options: FolderCatalogPublicationOptions): Promise<OwnedLock> {
  // A fresh machine (or fresh test catalog dir) has no catalog directory yet;
  // the lock file lives inside it, so the chain must exist before acquisition.
  const created = await ensureDirectoryChain(folderCatalogDir(), "rbox config directory");
  await fsyncCreatedDirectoryAncestors(folderCatalogDir(), created);
  const deadline = Date.now() + (options.lockWaitMs ?? 10_000);
  for (;;) {
    const acquired = await acquireLock(folderCatalogLockPath(), options.lock);
    if (acquired.status === "acquired") return acquired.lock;
    if (acquired.status === "unsupported" || acquired.status === "error") {
      throw new Error(`cannot lock rbox folder config: ${String(acquired.error)}`);
    }
    if (Date.now() >= deadline) throw new Error("rbox folder config is busy; retry in a moment");
    await new Promise<void>((resolve) => setTimeout(resolve, options.lockPollMs ?? 25));
  }
}

async function prepareDirectory(options: FolderCatalogPublicationOptions): Promise<void> {
  const created = await ensureDirectoryChain(
    folderCatalogDir(),
    "rbox config directory",
    (directory) => options.onDirectoryStep?.("after-create", directory),
    true,
  );
  await fsyncCreatedDirectoryAncestors(
    folderCatalogDir(),
    created,
    (directory) => options.onDirectoryStep?.("after-created-ancestor-fsync", directory),
  );
}

async function replace(
  expectedRevision: FolderCatalogRevision,
  bytes: string,
  options: FolderCatalogPublicationOptions,
): Promise<void> {
  let stale = false;
  await writeFileAtomic(folderCatalogPath(), bytes, {
    mode: 0o600,
    exactMode: true,
    beforeRename: async () => {
      const matches = (await observeFile()).revision === expectedRevision;
      stale = !matches;
      return matches;
    },
    onStep: options.onAtomicStep,
  });
  if (stale) throw new FolderCatalogStaleEditError();
}

async function noReplace(bytes: string, options: FolderCatalogPublicationOptions): Promise<boolean> {
  const target = folderCatalogPath();
  let temporary = "";
  let handle: fs.FileHandle | undefined;
  let ownsTemporary = false;
  let published = false;
  try {
    try {
      for (;;) {
        temporary = path.join(path.dirname(target), `.rbox-tmp-${process.pid}-${tempCounter++}-${path.basename(target)}`);
        await options.beforeTempOpen?.(temporary);
        try {
          handle = await fs.open(temporary, "wx", 0o600);
          ownsTemporary = true;
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        }
      }
      await options.onAtomicStep?.("temp-opened");
      await handle.writeFile(bytes);
      await options.onAtomicStep?.("temp-written");
      await handle.chmod(0o600);
      await handle.sync();
      await options.onAtomicStep?.("temp-synced");
    } finally {
      await handle?.close();
      await options.onAtomicStep?.("temp-closed");
    }
    await options.onAtomicStep?.("before-rename");
    try {
      await fs.link(temporary, target);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (published) await options.onAtomicStep?.("after-rename");
    return published;
  } finally {
    if (ownsTemporary) await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function durableWrite(
  write: () => Promise<boolean>,
  options: FolderCatalogPublicationOptions,
): Promise<boolean> {
  await options.onStep?.("before-write");
  const published = await write();
  if (!published) return false;
  await options.onStep?.("after-write");
  await options.onStep?.("before-directory-fsync");
  await fsyncDirectory(path.dirname(folderCatalogPath()));
  await options.onStep?.("after-directory-fsync");
  return true;
}

async function lockedMutation<T>(
  plan: (state: FolderCatalogState) => LockedMutation<T>,
  options: FolderCatalogPublicationOptions = {},
): Promise<T> {
  await prepareDirectory(options);
  const lock = await catalogLock(options);
  try {
    const state = stateFrom(await observeFile());
    const mutation = plan(state);
    if (mutation.kind === "unchanged") return mutation.value;
    const snapshot = codecInternals.snapshot(mutation.bytes);
    await durableWrite(async () => {
      await replace(state.revision, mutation.bytes, options);
      return true;
    }, options);
    return mutation.value(snapshot);
  } finally {
    await lock.release();
  }
}

export async function publishReplacing(
  expectedRevision: FolderCatalogRevision,
  bytes: string,
  options: FolderCatalogPublicationOptions = {},
): Promise<FolderCatalogSnapshot> {
  const next = codecInternals.snapshot(bytes);
  await prepareDirectory(options);
  const lock = await catalogLock(options);
  try {
    if ((await observeFile()).revision !== expectedRevision) throw new FolderCatalogStaleEditError();
    await durableWrite(async () => {
      await replace(expectedRevision, bytes, options);
      return true;
    }, options);
    return next;
  } finally {
    await lock.release();
  }
}

export async function publishNoReplace(
  bytes: string,
  options: FolderCatalogPublicationOptions = {},
): Promise<FolderCatalogNoReplaceResult> {
  const next = codecInternals.snapshot(bytes);
  await prepareDirectory(options);
  const lock = await catalogLock(options);
  try {
    const current = await observeFile();
    if (current.kind !== "absent") {
      const state = stateFrom(current);
      if (state.kind !== "authoritative") {
        throw new Error(`rbox folder configuration is damaged: ${state.kind === "damaged" ? state.reason : "unreadable"}`);
      }
      return { kind: "existing", snapshot: state.snapshot };
    }
    const published = await durableWrite(() => noReplace(bytes, options), options);
    if (published) return { kind: "published", snapshot: next };
    const winner = stateFrom(await observeFile());
    if (winner.kind !== "authoritative") {
      throw new Error("folder catalog no-replace publication lost without a valid winner");
    }
    return { kind: "existing", snapshot: winner.snapshot };
  } finally {
    await lock.release();
  }
}

export default { authorityError, lockedMutation, readableEntries };
