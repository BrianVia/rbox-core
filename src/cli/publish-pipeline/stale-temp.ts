/**
 * Stale ciphertext-temp reclamation (design 98 §6.1). Runs at push start under
 * the design-93 workspace sync mutex, so every pre-existing `enc-*` sibling is
 * stale by construction and swept unconditionally — process identity (the pid
 * embedded in the dir name) is diagnostic only and plays NO role, closing the
 * PID-reuse hole.
 */
import fs from "node:fs/promises";
import path from "node:path";
import type { Dirent } from "node:fs";

export async function reclaimStaleTemps(parentDir: string): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(parentDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let reclaimed = 0;
  await Promise.all(entries.map(async (entry) => {
    if (!entry.isDirectory() || !entry.name.startsWith("enc-")) return;
    try {
      await fs.rm(path.join(parentDir, entry.name), { recursive: true, force: true });
      reclaimed++;
    } catch {
      // Best effort: stale ciphertext never affects correctness.
    }
  }));
  return reclaimed;
}

export async function createRunTempDir(root: string): Promise<string> {
  const parent = path.resolve(root, ".rbox", "state", "tmp");
  await fs.mkdir(parent, { recursive: true });
  await reclaimStaleTemps(parent);
  const dir = path.join(parent, `enc-${process.pid}-${Date.now()}`);
  await fs.mkdir(dir, { mode: 0o700 });
  await fs.chmod(dir, 0o700);
  return dir;
}
