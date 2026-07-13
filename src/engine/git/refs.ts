import fs from "node:fs/promises";
import path from "node:path";
import { OP_STATE_DIRS, OP_STATE_FILES, isSyncableRef } from "../manifest-validate.js";
import { HEX40, exists, git, headBranchOf, moveFileAtomic, walkFiles } from "./shared.js";

export async function readAllRefs(repoDir: string): Promise<Record<string, string>> {
  const out = await git(repoDir, ["show-ref"]).catch(() => "");
  const refs: Record<string, string> = {};
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [sha, ref] = line.split(" ");
    if (sha && ref && isSyncableRef(ref)) refs[ref] = sha;
  }
  return refs;
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
