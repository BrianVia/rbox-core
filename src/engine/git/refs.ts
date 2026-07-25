import fs from "node:fs/promises";
import path from "node:path";
import { OP_STATE_CLASSIFICATION, OP_STATE_DIRS, OP_STATE_FILES, isSyncableRef, type OpStateRoot } from "../manifest-validate.js";
import { HEX40, exists, git, gitStatus, headBranchOf, moveFileAtomic, walkFiles } from "./shared.js";

function parseAllRefs(out: string): Record<string, string> {
  const refs: Record<string, string> = {};
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const [sha, ref] = line.split(" ");
    if (sha && ref && isSyncableRef(ref)) refs[ref] = sha;
  }
  return refs;
}

export async function readAllRefs(repoDir: string): Promise<Record<string, string>> {
  const out = await git(repoDir, ["show-ref"]).catch(() => "");
  return parseAllRefs(out);
}

export type StrictRefRead =
  | { status: "ok"; refs: Record<string, string> }
  | { status: "unreadable"; marker: string };

/** Evidence-grade ref read: Git's documented no-ref exit is distinct from a
 * corrupt, interrupted, or otherwise unreadable ref database. */
export async function readAllRefsStrict(repoDir: string): Promise<StrictRefRead> {
  const result = await gitStatus(repoDir, ["show-ref"]);
  if (result.status === "ok") return { status: "ok", refs: parseAllRefs(result.stdout) };
  if (result.exit === 1 && result.stderr.trim() === "") return { status: "ok", refs: {} };
  return {
    status: "unreadable",
    marker: result.exit === null ? "no-exit" : `exit-${result.exit}`,
  };
}

/** Pointer-repo (scoped) refs: ONLY `refs/heads/<current-branch>` — the shared store's
 *  other branches/tags/stash belong to the main clone. Detached HEAD → {}. */
export async function readScopedRefs(repoDir: string, head: string): Promise<Record<string, string>> {
  const branch = headBranchOf(head);
  if (!branch) return {};
  const sha = await git(repoDir, ["rev-parse", "--verify", "--quiet", branch]).catch(() => "");
  return sha && HEX40.test(sha) ? { [branch]: sha } : {};
}

export async function listRefs(repoDir: string, prefix: string): Promise<string[]> {
  const out = await git(repoDir, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
  return out.split("\n").filter(Boolean);
}

/** Enumerate/hash op-state under the RESOLVED gitdir (pointer repos: per-worktree state —
 *  exactly what makes "continue the rebase on the other machine" work). */
export async function readOpState(gitDir: string, hash: (absPath: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of OP_STATE_FILES) {
    const abs = path.join(gitDir, f);
    if (await exists(abs)) out[f] = await hash(abs);
  }
  for (const d of OP_STATE_DIRS) {
    const abs = path.join(gitDir, d);
    if (await exists(abs)) {
      for (const rel of await walkFiles(abs)) out[`${d}/${rel}`] = await hash(path.join(abs, rel));
    }
  }
  return out;
}

/** Presence is separate from file enumeration: an empty rebase/sequencer root is
 * still operationally active even though readOpState returns no entries for it. */
export async function readOpStateRootsPresent(gitDir: string): Promise<OpStateRoot[]> {
  const roots = [...OP_STATE_FILES, ...OP_STATE_DIRS] as const;
  const present = await Promise.all(roots.map(async (rel) => fs.lstat(path.join(gitDir, rel)).then(
    () => rel,
    (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? undefined : Promise.reject(error),
  )));
  return present.filter((rel): rel is OpStateRoot => rel !== undefined);
}

export async function readOpStateSnapshot(
  gitDir: string,
  hash: (absPath: string) => Promise<string>,
): Promise<{ files: Record<string, string>; rootsPresent: OpStateRoot[] }> {
  const [files, rootsPresent] = await Promise.all([
    readOpState(gitDir, hash),
    readOpStateRootsPresent(gitDir),
  ]);
  return { files, rootsPresent };
}

export function hasInProgressOpState(snapshot: { files: Record<string, unknown>; rootsPresent: readonly OpStateRoot[] }): boolean {
  return Object.keys(snapshot.files).some((rel) => OP_STATE_CLASSIFICATION[rel.split("/")[0] as OpStateRoot] === "in-progress")
    || snapshot.rootsPresent.some((root) => OP_STATE_CLASSIFICATION[root] === "in-progress");
}

export async function restoreOpState(gitDir: string, opTmp: Array<{ rel: string; tmp: string }>): Promise<void> {
  // Remove any op-state the sender no longer has (completed operation).
  const want = new Set(opTmp.map((o) => o.rel));
  const existing = await readOpState(gitDir, async () => "");
  for (const rel of Object.keys(existing)) {
    if (!want.has(rel)) await fs.rm(path.join(gitDir, rel), { force: true }).catch(() => {});
  }
  // Atomic-rename each PRE-DECRYPTED temp into place (decryption already happened + verified
  // before any mutation, §28) — never a torn or plaintext-less live file.
  for (const { rel, tmp } of opTmp) {
    const dest = path.join(gitDir, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await moveFileAtomic(tmp, dest);
  }
  await pruneEmptyOpStateDirs(gitDir, want);
}

/** Remove op-state DIRECTORIES the target should no longer have. Deleting only the files
 *  (above) leaves an empty `.git/rebase-merge/` behind, and git treats the directory's
 *  PRESENCE as "rebase in progress" (codex repro) — while rbox identity (file-based) sees
 *  nothing, so the divergence would never heal. */
export async function pruneEmptyOpStateDirs(gitDir: string, keepRels: Iterable<string>): Promise<void> {
  const keep = new Set<string>();
  for (const rel of keepRels) {
    const top = rel.split("/")[0]!;
    if (rel.includes("/")) keep.add(top);
  }
  for (const d of OP_STATE_DIRS) {
    if (!keep.has(d)) await fs.rm(path.join(gitDir, d), { recursive: true, force: true }).catch(() => {});
  }
}
