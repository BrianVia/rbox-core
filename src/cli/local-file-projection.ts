import {
  caseFoldCollisionGroups,
  manifestPathCaseFold,
  type CaseFoldCollisionGroup,
  type IgnoreMatcher,
  type Manifest,
} from "../engine/index.js";

/** Shared forward-ignore + case-safe local publication projection. The returned
 * manifest is the only file plane downstream push/status policy may inspect. Raw
 * disk paths remain caller-owned because cache pruning must not interpret a
 * skipped collision as local absence. */
export function projectLocalManifest(
  local: Manifest,
  base: Manifest,
  matcher: IgnoreMatcher,
  purgeIgnored = false,
): { manifest: Manifest; caseCollisions: CaseFoldCollisionGroup[] } {
  let carried = local;
  if (!purgeIgnored) {
    const present = new Set(local.files.map((entry) => entry.path));
    const ignoredBase = base.files.filter((entry) => !present.has(entry.path) && matcher.ignores(entry.path));
    if (ignoredBase.length > 0) carried = {
      ...local,
      files: [...local.files, ...ignoredBase].sort(compareEntries),
    };
  }

  const caseCollisions = caseFoldCollisionGroups(carried.files);
  if (caseCollisions.length === 0) return { manifest: carried, caseCollisions };

  const ambiguousFolds = new Set(caseCollisions.map((group) => manifestPathCaseFold(group.paths[0]!)));
  const files = carried.files.filter((entry) => !ambiguousFolds.has(manifestPathCaseFold(entry.path)));
  // A valid applied base has at most one entry per fold. Carry that exact entry,
  // including spelling and encrypted address, so ambiguity never becomes a
  // deletion or an arbitrarily selected winner.
  for (const entry of base.files) {
    if (ambiguousFolds.has(manifestPathCaseFold(entry.path))) files.push(entry);
  }
  files.sort(compareEntries);
  return { manifest: { ...carried, files }, caseCollisions };
}

function compareEntries(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}
