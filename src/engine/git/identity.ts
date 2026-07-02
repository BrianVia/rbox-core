import path from "node:path";
import { hashFile } from "../hash.js";
import type { GitRefScope, GitSection } from "../types.js";
import { type RepoCtx, exists, git, gitOk, headBranchOf, readHead, repoCtx } from "./shared.js";
import { readAllRefs, readOpState, readScopedRefs } from "./refs.js";

/** The stable, plaintext-only identity of a repo's git state (no ciphertext addresses) —
 *  what change-detection compares. Distinct from the stored `GitSection`, whose blob fields
 *  are encShas. opState here is `rel → plaintext sha`. Carries `refScope` so callers can
 *  drive the design-43 §7 comparison matrix (project before comparing across scopes). */
export type GitIdentity = Pick<GitSection, "head" | "refs" | "indexTree" | "refScope"> & { opState?: Record<string, string> };

// ---- identity (design 43 §§6-7) -----------------------------------------------

/** Cheap, stable identity of the repo state (no bundling). Undefined if no commits or
 *  the repo is unusable. SCOPE-AWARE (design 43 §5): a pointer repo's identity is
 *  HEAD + the current-branch ref + indexTree + opState only — the shared store's other
 *  branches/tags/stash belong to the main clone, not this checkout. */
export async function gitIdentity(repoDir: string): Promise<GitIdentity | undefined> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) return undefined;
  if (!(await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"]))) return undefined; // empty repo
  const head = await readHead(ctx);
  const refs = ctx.kind === "dir" ? await readAllRefs(repoDir) : await readScopedRefs(repoDir, head);
  const indexTree = await indexTreeOf(ctx);
  const opState = await readOpState(ctx.gitDir, async (p) => hashFile(p));
  return {
    refScope: ctx.kind === "dir" ? "all" : "scoped",
    refs,
    head,
    indexTree,
    opState: Object.keys(opState).length ? opState : undefined,
  };
}

/** Stable staging identity via write-tree (NOT the raw index file hash, which git
 *  refreshes). write-tree may refresh stat info — harmless, like `git status`.
 *  Fallback (design 43 §6.6 [v2, M3]): write-tree FAILS on an index with unmerged
 *  entries, which would freeze the identity mid-conflict and never re-capture staged
 *  conflict-resolution progress — so identity falls back to `raw:<sha256 of the
 *  resolved-gitdir index bytes>`. Volatile (stat refreshes can over-capture) but
 *  conservative: in the transient unmerged window, re-capturing beats carrying stale state. */
export async function indexTreeOf(ctx: RepoCtx): Promise<string | undefined> {
  const wt = (await git(ctx.repoDir, ["write-tree"]).catch(() => "")) || undefined;
  if (wt) return wt;
  const idx = path.join(ctx.gitDir, "index");
  if (!(await exists(idx))) return undefined;
  return `raw:${await hashFile(idx)}`;
}

/**
 * Project an identity/section onto a ref scope for cross-scope comparison (design 43 §7).
 * Projection = HEAD + the refs the narrower side carries (HEAD's branch only) + indexTree
 * + opState. Pure — never touches the repo. STEP-3 composes `gitIdentityKey(projectIdentity(x,
 * narrowerScope))` per the §7 comparison matrix (pull-side: project onto the NARROWER of the
 * two scopes; capture-side carry-forward: the normative shape×scope rules, incl. the explicit
 * pointer/all-base wider-carry exception).
 */
export function projectIdentity<T extends GitSection | GitIdentity>(g: T, scope: GitRefScope): T {
  if (scope === "all") return g;
  const branch = headBranchOf(g.head);
  const refs: Record<string, string> = {};
  if (branch && g.refs[branch] !== undefined) refs[branch] = g.refs[branch]!;
  return { ...g, refScope: "scoped", refs };
}

/** A stable string fingerprint for reconcile/change-detection. Uses the write-tree
 *  staging identity (NOT the volatile raw index hash) and excludes bundle bytes.
 *  Deliberately EXCLUDES refScope: cross-scope comparisons project both sides onto the
 *  narrower scope first (see {@link projectIdentity}, design 43 §7) and must be able to
 *  compare equal across shapes. */
export function gitIdentityKey(g: GitSection | GitIdentity | undefined): string {
  if (!g) return "none";
  const refs = Object.entries(g.refs).sort().map(([k, v]) => `${k}=${v}`).join(",");
  // opState values are plaintext shas in a GitIdentity but {sha,encSha,cipherSize} in a stored
  // GitSection — normalize to the PLAINTEXT sha so identity is stable across both shapes (and
  // doesn't stringify a GitArtifactRef to "[object Object]", which would re-bundle every push).
  const ops = g.opState ? Object.entries(g.opState).sort().map(([k, v]) => `${k}=${typeof v === "string" ? v : v.sha}`).join(",") : "";
  return `${g.head}|${g.indexTree ?? ""}|${refs}|${ops}`;
}
