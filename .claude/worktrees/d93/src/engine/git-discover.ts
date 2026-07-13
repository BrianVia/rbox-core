import fs from "node:fs/promises";
import path from "node:path";
import type { IgnoreMatcher } from "./ignore.js";

/** A git repo found inside the synced tree (design 43 §3).
 *  kind "dir"     — `.git` is a real directory (ordinary repo).
 *  kind "pointer" — `.git` is a gitfile pointer (worktree or submodule checkout). */
export interface DiscoveredGitRepo {
  /** POSIX relPath of the repo dir from the sync root; the root itself is ".". */
  relPath: string;
  kind: "dir" | "pointer";
}

/**
 * Ignore-pruned walk finding every git repo INSIDE the tree (design 43 §3).
 *
 * - Reuses the scan's ignore pruning: never descends into `node_modules/`, `.git/`,
 *   etc. — a vendored repo inside an ignored dir does not sync. (A repo under an
 *   ignored parent is not discoverable; re-include the parent via `.rboxignore`
 *   negation to sync it [v2, minor: documented semantic].)
 * - Does NOT stop at a repo boundary: a repo vendored inside another repo's working
 *   tree is discovered and captured independently.
 * - Returns EVERYTHING it finds, sorted by relPath. The MAX_GIT_REPOS cap semantics
 *   (carry-always, defer-new-beyond-cap [v2, M4]) live at the CALLER — the cap bounds
 *   capture work, never the manifest carry.
 * - Symlinks are never followed (neither a symlinked subdir nor a symlinked `.git`).
 */
export async function discoverGitRepos(root: string, matcher: IgnoreMatcher): Promise<DiscoveredGitRepo[]> {
  const out: DiscoveredGitRepo[] = [];
  await walkDir(root, "", matcher, out);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

async function walkDir(root: string, rel: string, matcher: IgnoreMatcher, out: DiscoveredGitRepo[]): Promise<void> {
  // A dir vanishing mid-walk (Conductor archiving a worktree) is a defer, not an abort.
  const entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }).catch(() => []);

  const dotGit = entries.find((e) => e.name === ".git");
  if (dotGit) {
    const relPath = rel === "" ? "." : rel;
    if (dotGit.isDirectory()) out.push({ relPath, kind: "dir" });
    else if (dotGit.isFile()) out.push({ relPath, kind: "pointer" });
    // a symlinked `.git` is not a supported repo shape — skipped (preflight would refuse it too)
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue; // dirents don't report symlinked dirs as directories — never followed
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if ((matcher.prunesForGitDiscovery?.(`${childRel}/`) ?? matcher.ignores(`${childRel}/`))) continue; // pruned before descent (`.git/` is hard-excluded)
    await walkDir(root, childRel, matcher, out);
  }
}
