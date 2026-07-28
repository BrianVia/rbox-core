import crypto from "node:crypto";
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
  | { kind: "step"; operation: "atomic-write" | "exact-write" | "copy-exact"; file: string; step: string }
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
  observe: (event: SqliteResetFsTraceEvent) => void = () => undefined,
): SqliteResetRecoveryFs {
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
      });
      observe({ kind: "file-published", file, bytes: Buffer.from(bytes) });
    },
    async exactWrite(file, bytes) {
      const parent = path.dirname(file);
      const temp = path.join(parent, `.rbox-tmp-${process.pid}-${crypto.randomBytes(8).toString("hex")}-${path.basename(file)}`);
      let renamed = false;
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
        await fs.rename(temp, file);
        renamed = true;
        observe({ kind: "step", operation: "exact-write", file, step: "after-rename" });
        observe({ kind: "file-published", file, bytes: Buffer.from(bytes) });
      } finally {
        if (!renamed) await fs.rm(temp, { force: true }).catch(() => undefined);
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
      const bytes = await fs.readFile(source);
      await fs.rename(source, destination);
      observe({ kind: "file-removed", file: source });
      observe({ kind: "file-published", file: destination, bytes });
    },
    async remove(file, options) {
      await fs.rm(file, options);
      observe({ kind: "file-removed", file });
    },
    async fsyncDbAndParent(file) {
      await fsyncDbAndParent(file);
      observe({ kind: "directory-fsynced", directory: path.dirname(file) });
    },
  };
}

export const PRODUCTION_RECOVERY_FS = createSqliteResetRecoveryFs();
