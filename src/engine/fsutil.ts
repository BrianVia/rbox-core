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
export async function writeFileAtomic(absPath: string, data: string | Uint8Array): Promise<void> {
  const dir = path.dirname(absPath);
  const tmp = path.join(dir, `${RBOX_TMP_PREFIX}${process.pid}-${counter++}-${path.basename(absPath)}`);
  let fh: fs.FileHandle | undefined;
  try {
    fh = await fs.open(tmp, "w");
    await fh.writeFile(data);
    await fh.sync(); // durability: bytes hit disk before the rename publishes them
  } finally {
    await fh?.close();
  }
  await fs.rename(tmp, absPath);
}
