/**
 * Design 202 — provenance of every in-memory manifest install, plus the two pure
 * helpers the trusted-pull seam needs (unsettled stripping, the O(applied) patch).
 *
 * The daemon's manifest is authored by exactly two shapes of work: a FULL WORKSPACE
 * observation (a scan) and a PARTIAL patch proportional to what changed (watcher
 * events, pull-applied actions). Making that explicit in the type is what lets P5
 * ("a full-workspace install has occurred since the state seed") and the completeness
 * upgrade rule ("only a full-workspace install with an empty deferred set may set
 * `manifestObservationComplete`") stop being bespoke booleans read off call sites.
 */
import { actionPath, compareManifestPaths, type Action, type FileEntry, type Manifest } from "../../engine/index.js";
import { gitIncomingKey } from "../sync-git/shared.js";
import type { SyncState } from "../config.js";

export type ManifestUpdate =
  | {
      kind: "full-workspace";
      /** The existing ScanCoverage vocabulary — no new terms. A pruned scan is still
       *  a full-workspace observation (pruning reuses cached listings, it does not
       *  omit paths), which is why P5 accepts it. */
      coverage: "full-tree" | "pruned";
      deferred: ReadonlySet<string>;
    }
  | {
      kind: "partial";
      /** `push-committed` is the committed-subset manifest a successful push returns:
       *  it differs from the daemon's own manifest only at the paths that push
       *  deferred (they carry the base entry), so it is a partial update like any
       *  other patch — never a fresh workspace observation. */
      source: "watch-events" | "pull-applied" | "push-committed";
      /** Least-information payload: exactly what this update touched, never the
       *  whole workspace. One update per settled drain / per pull, never per file. */
      paths: ReadonlySet<string>;
    };

/** Design 202 kill switch. Default ON; `=0` disables the seam AND the patch. */
export const pullTrustWatcherEnabled = (): boolean => process.env.RBOX_PULL_TRUST_WATCHER !== "0";

/**
 * "This manifest minus the paths nobody can currently observe" — one home for the
 * predicate. Its caller is the trusted view: pull's scan path deliberately omits
 * scan-deferred paths from `local` (design 108), because feeding a base-carried
 * entry into reconcile would let a remote delete plan a disk delete against a path
 * nobody could read. The daemon's manifest has the opposite shape (it CARRIES the
 * prior entry for deferred paths), so the omission has to be restored here before
 * the view crosses the seam.
 */
export function omitPaths(manifest: Manifest, paths: ReadonlySet<string>): Manifest {
  if (paths.size === 0) return manifest;
  const files = manifest.files.filter((f) => !paths.has(f.path));
  return files.length === manifest.files.length ? manifest : { ...manifest, files };
}

/**
 * The post-pull O(applied) refresh: start from the manifest the pull actually read
 * and move only the paths the pull touched to their POST-pull base entry (the same
 * truth the replaced scan would have re-derived from disk, minus the walk).
 *
 * `keepLocalAs` conflict copies are NOT entries we can author — the copy's hash is
 * unknown until something reads it — so they are returned as newly unsettled: the
 * watcher event re-observes them and the next push publishes them, exactly like any
 * local edit.
 */
export function patchManifestFromPull(
  trusted: Manifest,
  actions: readonly Action[],
  postBase: Manifest,
): { manifest: Manifest; paths: Set<string>; unsettled: Set<string> } {
  // `paths` is built ONCE and serves both roles: the merge's touch list and the
  // provenance stamp (no second set assembled just to report). Conflict-copy paths
  // are touched — they belong in the stamp — but are not entries we can author, so
  // `unsettled` marks them and the merge below leaves them exactly as they are.
  const paths = new Set<string>();
  const unsettled = new Set<string>();
  for (const a of actions) {
    paths.add(actionPath(a));
    if (a.kind === "conflict") {
      paths.add(a.keepLocalAs);
      unsettled.add(a.keepLocalAs);
    }
  }
  if (paths.size === unsettled.size) return { manifest: trusted, paths, unsettled };
  // `trusted.files` is in canonical manifest order (P5 guarantees a scan-authored
  // lineage), so the patch is ONE linear merge over it plus a per-touched-path lookup
  // in the post-pull base — no Map over the whole manifest and no re-sort.
  const baseEntryAt = postBaseLookup(postBase, paths);
  const touched = [...paths].sort(compareManifestPaths);
  const files: FileEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < trusted.files.length || j < touched.length) {
    const held = trusted.files[i];
    const p = touched[j];
    if (p === undefined) { files.push(held!); i++; continue; }
    const order = held === undefined ? 1 : compareManifestPaths(held.path, p);
    if (order < 0) { files.push(held!); i++; continue; } // untouched: copy through
    // Absent from the post-pull base ⇒ the pull removed it (delete, or a write the
    // base does not carry because local rules ignore it — either way not ours to keep).
    // Unsettled (a conflict copy) ⇒ not ours to author at all: keep whatever the
    // trusted manifest held, and let the watcher event settle it.
    const replacement = unsettled.has(p) ? (order === 0 ? held : undefined) : baseEntryAt(p);
    if (replacement) files.push(replacement);
    if (order === 0) i++;
    j++;
  }
  return { manifest: { ...trusted, files }, paths, unsettled };
}

/**
 * Reader for "what does the post-pull base carry at this path?".
 *
 * Every manifest this client commits is in canonical order, so the normal answer is
 * a binary search — O(applied·log n), no allocation. But `postBase` arrives over the
 * wire, and an unordered one would make a binary search MISS a path that is present,
 * which the patch would read as "the pull removed it" and the next push would publish
 * as a deletion. So order is verified first (one comparison per entry, no allocation)
 * and an unordered base falls back to a single pass collecting only the touched paths.
 */
function postBaseLookup(postBase: Manifest, wanted: ReadonlySet<string>): (path: string) => FileEntry | undefined {
  const files = postBase.files;
  for (let i = 1; i < files.length; i++) {
    if (compareManifestPaths(files[i - 1]!.path, files[i]!.path) > 0) {
      const found = new Map<string, FileEntry>();
      for (const f of files) if (wanted.has(f.path)) found.set(f.path, f);
      return (path) => found.get(path);
    }
  }
  return (path) => {
    let lo = 0;
    let hi = files.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const order = compareManifestPaths(files[mid]!.path, path);
      if (order === 0) return files[mid];
      if (order < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return undefined;
  };
}

/**
 * Fallback trigger F2, pure and entirely daemon-side: did the pull change git
 * topology or any repo section? Compared over the pre-op and post-op sync bases
 * (`doPull` already reloads the latter), so `pull()` returns nothing new.
 *
 * A materialized/removed repo means the replaced scan's non-manifest side effects
 * matter (ref-registry upsert + safety floor) and the matcher's `knownGitRepos`
 * provenance (P7) has moved — both are handled by falling back to the scan.
 */
export function gitTopologyChanged(before: SyncState, after: SyncState): boolean {
  const a = before.lastSyncedManifest.gitRepos ?? {};
  const b = after.lastSyncedManifest.gitRepos ?? {};
  // The union's loop subsumes any key-set difference: a key present on one side only
  // fails its `!sa`/`!sb` test, so no separate size comparison is needed.
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    const sa = a[k];
    const sb = b[k];
    if (!sa || !sb) return true;
    if (gitIncomingKey(sa) !== gitIncomingKey(sb)) return true;
  }
  return false;
}

/** P7's provenance token: the base `gitRepos` key set a matcher was built from. */
export function gitReposMatcherKey(state?: { lastSyncedManifest: Manifest }): string {
  return Object.keys(state?.lastSyncedManifest.gitRepos ?? {}).sort().join("\0");
}
