import fs from "node:fs/promises";
import path from "node:path";
import type { BlobStore } from "./blobstore.js";
import { sameContent } from "./diff.js";
import { hashBytes, hashFile } from "./hash.js";
import { RBOX_TMP_PREFIX } from "./fsutil.js";
import { conflictName, type Action } from "./reconcile.js";
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

export interface ApplyOptions {
  /** Used to name conflict copies created when a precondition fails. */
  device?: string;
  /** ISO timestamp for conflict-copy names; defaults to now. */
  now?: string;
}

/**
 * Apply reconcile actions to `destRoot` — precondition-checked and
 * non-destructive. Every write stages a temp first, then re-checks the target
 * against the local state reconcile expected (`expectedLocal`); if the user
 * touched the file in the scan→apply window, the current bytes are moved aside
 * to a `.conflict` copy before the remote is published. Deletes that find a
 * changed file move it aside instead of removing it. Writes/conflicts first,
 * deletes last.
 */
export async function applyActions(
  destRoot: string,
  actions: Action[],
  store: BlobStore,
  opts: ApplyOptions = {}
): Promise<void> {
  const device = opts.device ?? "local";
  const now = opts.now ?? new Date().toISOString();

  const deletes = actions.filter((a) => a.kind === "delete");
  const rest = actions.filter((a) => a.kind !== "delete");

  for (const a of rest) {
    if (a.kind === "write") {
      await writeEntry(destRoot, a.entry, a.expectedLocal, store, device, now);
    } else if (a.kind === "conflict") {
      // Reconcile already decided both sides diverged: keep local aside, take remote.
      await moveAside(destRoot, a.path, a.keepLocalAs);
      await writeEntry(destRoot, a.entry, undefined, store, device, now);
    }
  }
  for (const a of deletes) {
    await deleteEntry(destRoot, a.path, a.expectedLocal, device, now);
  }
}

/** Stage the remote entry to a temp, re-check the target, preserve any surprise
 *  bytes as a conflict copy, then atomically publish. */
async function writeEntry(
  destRoot: string,
  entry: FileEntry,
  expectedLocal: FileEntry | undefined,
  store: BlobStore,
  device: string,
  now: string
): Promise<void> {
  const abs = path.join(destRoot, entry.path);
  await assertWithinRoot(destRoot, abs); // defend symlink+file traversal combo
  await fs.mkdir(path.dirname(abs), { recursive: true });

  const tmp = tmpName(abs);
  if (entry.type === "symlink") {
    await fs.symlink(entry.symlinkTarget ?? "", tmp);
  } else {
    const bytes = await store.get(entry.sha256);
    await fs.writeFile(tmp, bytes);
    await fs.chmod(tmp, entry.mode);
  }

  try {
    // Final precondition: does the target still match what reconcile assumed?
    const current = await currentEntryAt(destRoot, entry.path);
    if (!sameContent(current, expectedLocal) && current) {
      // The user created/edited it in the window — preserve those bytes.
      await moveAside(destRoot, entry.path, conflictName(entry.path, device, now));
    }
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
}

/** Remove the target only if it still matches what reconcile expected; if it
 *  changed under us, a concurrent edit beats the propagated delete — move it
 *  aside so the user's bytes survive (real trash tier is M6). */
async function deleteEntry(
  destRoot: string,
  rel: string,
  expectedLocal: FileEntry | undefined,
  device: string,
  now: string
): Promise<void> {
  const abs = path.join(destRoot, rel);
  await assertWithinRoot(destRoot, abs);
  const current = await currentEntryAt(destRoot, rel);
  if (!current) return; // already gone
  if (sameContent(current, expectedLocal)) {
    await fs.rm(abs, { force: true });
  } else {
    await moveAside(destRoot, rel, conflictName(rel, device, now));
  }
}

/** The on-disk entry at `rel`, or undefined if absent. Symlink targets are read,
 *  not followed; directories read as undefined (we never delete/overwrite a dir
 *  as if it were a file). */
async function currentEntryAt(destRoot: string, rel: string): Promise<FileEntry | undefined> {
  const abs = path.join(destRoot, rel);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  if (st.isSymbolicLink()) {
    const target = await fs.readlink(abs);
    return { path: rel, type: "symlink", symlinkTarget: target, sha256: hashBytes(Buffer.from(target)), size: Buffer.byteLength(target), mode: 0o777, mtimeMs: 0 };
  }
  if (st.isFile()) {
    return { path: rel, type: "file", sha256: await hashFile(abs), size: st.size, mode: st.mode & 0o777, mtimeMs: st.mtimeMs };
  }
  return undefined; // directory or special file
}

async function moveAside(destRoot: string, fromRel: string, toRel: string): Promise<void> {
  const from = path.join(destRoot, fromRel);
  const to = path.join(destRoot, toRel);
  await fs.mkdir(path.dirname(to), { recursive: true });
  await fs.rename(from, to);
}

/** Refuse to operate on a path whose real parent escapes the workspace — e.g. a
 *  synced symlink `foo -> /etc` followed by a file entry `foo/passwd`. Static
 *  manifest validation can't catch this (it's runtime FS state), so this is the
 *  complementary runtime guard. */
async function assertWithinRoot(destRoot: string, abs: string): Promise<void> {
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

let tmpCounter = 0;
function tmpName(abs: string): string {
  const dir = path.dirname(abs);
  return path.join(dir, `${RBOX_TMP_PREFIX}${process.pid}-${tmpCounter++}-${path.basename(abs)}`);
}
