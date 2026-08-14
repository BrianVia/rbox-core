import {
  caseFoldCollisionGroups,
  manifestPathCaseFold,
  type CaseFoldCollisionGroup,
  type FileEntry,
  type IgnoreMatcher,
  type Manifest,
} from "../engine/index.js";

export interface LocalManifestProjectionSpans {
  projection_ignore_carry_ms: number;
  projection_casefold_ms: number;
  projection_sort_ms: number;
}

export interface LocalManifestProjection {
  manifest: Manifest;
  caseCollisions: CaseFoldCollisionGroup[];
  strandedIgnored: number;
}

/** Shared forward-ignore + case-safe local publication projection. The returned
 * manifest is the only file plane downstream push/status policy may inspect. Raw
 * disk paths remain caller-owned because cache pruning must not interpret a
 * skipped collision as local absence. */
export function projectLocalManifest(
  local: Manifest,
  base: Manifest,
  matcher: IgnoreMatcher,
  purgeIgnored = false,
  onSpans?: (spans: LocalManifestProjectionSpans) => void,
): LocalManifestProjection {
  const ignoreCarryT0 = onSpans ? performance.now() : 0;
  const present = new Set(local.files.map((entry) => entry.path));
  // Base entries the matcher ignores: the scanner never emits an ignored path, so
  // this IS the stranded set (design 224 §2.3). Computed unconditionally so the
  // return is total — the forward-carry still consumes it only when not purging.
  const ignoredBase = base.files.filter((entry) => !present.has(entry.path) && matcher.ignores(entry.path));
  const strandedIgnored = ignoredBase.length;
  let carried = local;
  let carriedFiles: FileEntry[] | undefined;
  if (!purgeIgnored && ignoredBase.length > 0) {
    carriedFiles = [...local.files, ...ignoredBase];
    carried = { ...local, files: carriedFiles };
  }
  const projectionIgnoreCarryMs = onSpans ? performance.now() - ignoreCarryT0 : 0;

  let projectionSortMs = 0;
  if (carriedFiles) {
    const sortT0 = onSpans ? performance.now() : 0;
    carriedFiles.sort(compareEntries);
    if (onSpans) projectionSortMs += performance.now() - sortT0;
  }

  const casefoldT0 = onSpans ? performance.now() : 0;
  const caseCollisions = caseFoldCollisionGroups(carried.files);
  const projectionCasefoldMs = onSpans ? performance.now() - casefoldT0 : 0;
  if (caseCollisions.length === 0) {
    onSpans?.({
      projection_ignore_carry_ms: projectionIgnoreCarryMs,
      projection_casefold_ms: projectionCasefoldMs,
      projection_sort_ms: projectionSortMs,
    });
    return { manifest: carried, caseCollisions, strandedIgnored };
  }

  const ambiguousFolds = new Set(caseCollisions.map((group) => manifestPathCaseFold(group.paths[0]!)));
  const files = carried.files.filter((entry) => !ambiguousFolds.has(manifestPathCaseFold(entry.path)));
  // A valid applied base has at most one entry per fold. Carry that exact entry,
  // including spelling and encrypted address, so ambiguity never becomes a
  // deletion or an arbitrarily selected winner.
  for (const entry of base.files) {
    if (ambiguousFolds.has(manifestPathCaseFold(entry.path))) files.push(entry);
  }
  const sortT0 = onSpans ? performance.now() : 0;
  files.sort(compareEntries);
  if (onSpans) projectionSortMs += performance.now() - sortT0;
  onSpans?.({
    projection_ignore_carry_ms: projectionIgnoreCarryMs,
    projection_casefold_ms: projectionCasefoldMs,
    projection_sort_ms: projectionSortMs,
  });
  return { manifest: { ...carried, files }, caseCollisions, strandedIgnored };
}

function compareEntries(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
