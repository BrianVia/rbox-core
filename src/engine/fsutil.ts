import fs from "node:fs/promises";
import path from "node:path";

/** Prefix for transient temp files. Ignore-listed (see ignore.ts) so a crashed
 *  temp left beside a real file is never scanned into a manifest. */
export const RBOX_TMP_PREFIX = ".rbox-tmp-";

let counter = 0;

/**
 * Write `data` to `absPath` atomically: stage to a sibling temp, fsync it, then
 * rename over the target. A crash can leave a temp (ignore-listed) but never a
 * half-written real file. Same-directory temp guarantees the rename is on one
 * filesystem (rename across filesystems is not atomic).
 */
export async function writeFileAtomic(
  absPath: string,
  data: string | Uint8Array,
  opts: {
    beforeRename?: () => boolean | Promise<boolean>;
    mode?: number;
    flag?: string;
  } = {}
): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `${RBOX_TMP_PREFIX}${process.pid}-${counter++}-${path.basename(absPath)}`);
  let fh: fs.FileHandle | undefined;
  try {
    try {
      fh = await fs.open(tmp, opts.flag ?? "w", opts.mode);
      await fh.writeFile(data);
      await fh.sync(); // durability: bytes hit disk before the rename publishes them
    } finally {
      await fh?.close();
    }
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
  let publish = true;
  try {
    publish = opts.beforeRename ? await opts.beforeRename() : true;
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  if (!publish) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    return;
  }
  try {
    await fs.rename(tmp, absPath);
  } catch (error) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Flush directory metadata after publishing or removing an entry. Callers choose
 * whether durability failure is fatal; the file-handle lifecycle is shared here. */
export async function fsyncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Refuse to operate on a path whose real parent escapes the workspace — e.g. a
 *  synced symlink `foo -> /etc` followed by a file entry `foo/passwd`. Static
 *  manifest validation can't catch this (it's runtime FS state), so this is the
 *  complementary runtime guard. */
export async function assertWithinRoot(destRoot: string, abs: string): Promise<void> {
  const rootReal = await fs.realpath(destRoot);
  let probe = path.dirname(abs);
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`refusing to write outside workspace via symlinked parent: ${abs}`);
      }
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        const parent = path.dirname(probe);
        if (parent === probe) return; // reached FS root without escaping
        probe = parent;
        continue;
      }
      throw e;
    }
  }
}
