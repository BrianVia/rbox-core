import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "./blobstore.js";
import type { Action } from "./reconcile.js";
import type { FileEntry, Manifest } from "./types.js";

/**
 * Push a tree's content into the blob store (the Phase-1 stand-in for "upload
 * missing blobs"). Only file content is stored; symlinks carry their target in
 * the manifest. Returns the count actually uploaded (deduped against the store).
 */
export async function uploadManifestBlobs(
  root: string,
  manifest: Manifest,
  store: BlobStore
): Promise<number> {
  let uploaded = 0;
  for (const entry of manifest.files) {
    if (entry.type !== "file") continue;
    if (await store.has(entry.sha256)) continue;
    await store.put(entry.sha256, await fs.readFile(path.join(root, entry.path)));
    uploaded++;
  }
  return uploaded;
}

/**
 * Apply reconcile actions to `destRoot`. Every write is atomic (temp + rename),
 * so a crash never leaves a half-written file at a real path. Conflicts move the
 * local copy aside first, then write the remote — nothing is destroyed.
 */
export async function applyActions(
  destRoot: string,
  actions: Action[],
  store: BlobStore
): Promise<void> {
  // Writes/conflicts first, deletes last (mirrors the sync-loop ordering).
  const deletes = actions.filter((a) => a.kind === "delete");
  const rest = actions.filter((a) => a.kind !== "delete");

  for (const a of rest) {
    if (a.kind === "write") {
      await writeEntry(destRoot, a.entry, store);
    } else if (a.kind === "conflict") {
      await moveAside(destRoot, a.path, a.keepLocalAs);
      await writeEntry(destRoot, a.entry, store);
    }
  }
  for (const a of deletes) {
    await removePath(destRoot, a.path);
  }
}

async function writeEntry(destRoot: string, entry: FileEntry, store: BlobStore): Promise<void> {
  const abs = path.join(destRoot, entry.path);
  await fs.mkdir(path.dirname(abs), { recursive: true });

  if (entry.type === "symlink") {
    await fs.rm(abs, { force: true });
    await fs.symlink(entry.symlinkTarget ?? "", abs);
    return;
  }

  const bytes = await store.get(entry.sha256);
  const tmp = `${abs}.rbox-tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, bytes);
  await fs.chmod(tmp, entry.mode);
  await fs.rename(tmp, abs);
}

async function moveAside(destRoot: string, fromRel: string, toRel: string): Promise<void> {
  const from = path.join(destRoot, fromRel);
  const to = path.join(destRoot, toRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

async function removePath(destRoot: string, rel: string): Promise<void> {
  await fs.rm(path.join(destRoot, rel), { force: true });
}
