import type { FileEntry, Manifest } from "./types.js";

export interface ManifestDiff {
  added: FileEntry[];
  changed: FileEntry[];
  deleted: string[];
}

export function indexByPath(manifest: Manifest): Map<string, FileEntry> {
  const map = new Map<string, FileEntry>();
  for (const entry of manifest.files) map.set(entry.path, entry);
  return map;
}

/**
 * Two entries are the "same content" when their hash, type, link target, and
 * mode match. mtime is intentionally absent — see {@link FileEntry}. `undefined`
 * means "absent on that side"; two absences are equal, one absence is not.
 */
export function sameContent(a?: FileEntry, b?: FileEntry): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.sha256 === b.sha256 &&
    a.type === b.type &&
    (a.symlinkTarget ?? "") === (b.symlinkTarget ?? "") &&
    a.mode === b.mode
  );
}

/** Push equality is `sameContent` PLUS size (design 92 I3): a same-SHA entry
 *  whose declared size was wrong (the poisoned-manifest incident) must be
 *  commit-worthy so the next honest writer heals the head. Do NOT fold size
 *  into `sameContent` — reconcile/apply use it as byte-identity, and making
 *  them size-sensitive would manufacture false conflicts on devices that
 *  already hold the correct bytes. */
function samePushEntry(a: FileEntry, b: FileEntry): boolean {
  return sameContent(a, b) && a.size === b.size;
}

/** What changed going from `base` to `next`. Used for "what to push". */
export function diffManifests(base: Manifest, next: Manifest): ManifestDiff {
  const b = indexByPath(base);
  const n = indexByPath(next);
  const added: FileEntry[] = [];
  const changed: FileEntry[] = [];
  const deleted: string[] = [];

  for (const [p, entry] of n) {
    const prev = b.get(p);
    if (!prev) added.push(entry);
    else if (!samePushEntry(prev, entry)) changed.push(entry);
  }
  for (const p of b.keys()) {
    if (!n.has(p)) deleted.push(p);
  }
  return { added, changed, deleted };
}
