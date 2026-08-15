import crypto from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ensureDirectoryChain,
  fsyncCreatedDirectoryAncestors,
  fsyncDirectory,
  writeFileAtomic,
} from "../../../engine/fsutil.js";
import {
  boundedCopy,
  RESET_STREAM_BYTE_LIMIT,
} from "../../reset-io.js";
import { fsyncDbAndParent } from "./artifacts.js";
import type { OwnedLock } from "../../../engine/lockfile.js";
import { StateWriteRefusedError } from "../errors.js";
import { stateLockPath } from "../paths.js";

export interface SqliteResetRecoveryFs {
  ensureDirectoryChain(directory: string, description: string): Promise<ReadonlySet<string>>;
  fsyncCreatedDirectoryAncestors(directory: string, created: ReadonlySet<string>): Promise<void>;
  fsyncDirectory(directory: string): Promise<void>;
  atomicWrite(file: string, bytes: Uint8Array): Promise<void>;
  exactWrite(file: string, bytes: Uint8Array): Promise<void>;
  copyExact(source: string, destination: string): Promise<boolean>;
  rename(source: string, destination: string): Promise<void>;
  remove(file: string, options?: { force?: boolean }): Promise<void>;
  fsyncDbAndParent(file: string): Promise<void>;
}

export type SqliteResetFsTraceEvent =
  | { kind: "step"; operation: "atomic-write" | "exact-write" | "copy-exact" | "rename" | "remove"; file: string; step: string }
  | { kind: "directory-chain"; directory: string; created: readonly string[] }
  | { kind: "created-ancestors-fsynced"; directory: string; created: readonly string[] }
  | { kind: "file-published"; file: string; bytes: Uint8Array }
  | { kind: "file-removed"; file: string }
  | { kind: "directory-fsynced"; directory: string };

/**
 * The production filesystem implementation with an optional ordered observer.
 * Tests record this implementation; they do not replace compound writers with
 * lookalikes, so changes inside the real write/fsync path alter the replay.
 */
export function createSqliteResetRecoveryFs(
  root: string,
  heldLock: OwnedLock,
  observe: (event: SqliteResetFsTraceEvent) => void = () => undefined,
): SqliteResetRecoveryFs {
  const lockPath = stateLockPath(root);
  if (path.resolve(heldLock.path) !== path.resolve(lockPath)) {
    throw new StateWriteRefusedError("state-lock-unavailable", lockPath, "held lock has the wrong canonical path");
  }
  const assertOwner = (file: string): void => {
    if (!heldLock.isOwnerSync()) throw new StateWriteRefusedError("state-lock-lease-lost", file);
  };
  return {
    async ensureDirectoryChain(directory, description) {
      const created = await ensureDirectoryChain(directory, description);
      observe({ kind: "directory-chain", directory, created: [...created] });
      return created;
    },
    async fsyncCreatedDirectoryAncestors(directory, created) {
      await fsyncCreatedDirectoryAncestors(directory, created);
      observe({ kind: "created-ancestors-fsynced", directory, created: [...created] });
    },
    async fsyncDirectory(directory) {
      await fsyncDirectory(directory);
      observe({ kind: "directory-fsynced", directory });
    },
    async atomicWrite(file, bytes) {
      await writeFileAtomic(file, bytes, {
        mode: 0o600,
        onStep(step) { observe({ kind: "step", operation: "atomic-write", file, step }); },
        beforeRenameSync() { assertOwner(file); },
      });
      observe({ kind: "file-published", file, bytes: Buffer.from(bytes) });
    },
    async exactWrite(file, bytes) {
      const parent = path.dirname(file);
      const temp = path.join(parent, `.rbox-tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}-${path.basename(file)}`);
      let renamed = false;
      let preserveTemp = false;
      try {
        const handle = await fs.open(temp, "wx", 0o600);
        observe({ kind: "step", operation: "exact-write", file, step: "temp-opened" });
        try {
          await handle.writeFile(bytes);
          observe({ kind: "step", operation: "exact-write", file, step: "temp-written" });
          await handle.sync();
          observe({ kind: "step", operation: "exact-write", file, step: "temp-synced" });
        } finally {
          await handle.close();
          observe({ kind: "step", operation: "exact-write", file, step: "temp-closed" });
        }
        observe({ kind: "step", operation: "exact-write", file, step: "before-rename" });
        try {
          assertOwner(file);
        } catch (error) {
          preserveTemp = true;
          throw error;
        }
        await fs.rename(temp, file);
        renamed = true;
        observe({ kind: "step", operation: "exact-write", file, step: "after-rename" });
        observe({ kind: "file-published", file, bytes: Buffer.from(bytes) });
      } finally {
        if (!renamed && !preserveTemp) await fs.rm(temp, { force: true }).catch(() => undefined);
      }
    },
    async copyExact(source, destination) {
      const missing: string[] = [];
      let probe = path.resolve(path.dirname(destination));
      for (;;) {
        if (await fs.lstat(probe).then(() => true, (error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw error;
        })) break;
        missing.push(probe);
        const parent = path.dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
      const copied = await boundedCopy(source, destination, RESET_STREAM_BYTE_LIMIT, {
        onStep(step) {
          observe({ kind: "step", operation: "copy-exact", file: destination, step });
        },
        beforeRenameSync() { assertOwner(destination); },
      });
      if (copied) {
        observe({ kind: "file-published", file: destination, bytes: await fs.readFile(destination) });
        observe({ kind: "directory-fsynced", directory: path.dirname(destination) });
        observe({
          kind: "created-ancestors-fsynced",
          directory: path.dirname(destination),
          created: missing.reverse(),
        });
      }
      return copied;
    },
    async rename(source, destination) {
      const prepared = await fs.readFile(source);
      observe({ kind: "step", operation: "rename", file: destination, step: "before-owner-check" });
      assertOwner(destination);
      const bytes = fsSync.readFileSync(source);
      if (!bytes.equals(prepared)) throw new Error("SQLite reset rename source changed after preparation");
      await fs.rename(source, destination);
      observe({ kind: "file-removed", file: source });
      observe({ kind: "file-published", file: destination, bytes });
    },
    async remove(file, options) {
      observe({ kind: "step", operation: "remove", file, step: "before-owner-check" });
      assertOwner(file);
      await fs.rm(file, options);
      observe({ kind: "file-removed", file });
    },
    async fsyncDbAndParent(file) {
      await fsyncDbAndParent(file);
      observe({ kind: "directory-fsynced", directory: path.dirname(file) });
    },
  };
}
