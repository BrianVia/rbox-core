import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { BlobStore } from "../blobstore.js";
import { encryptFileToTemp, decryptFileToPath } from "../crypto.js";
import type { GitArtifactRef } from "../types.js";

/** Repo shape: "dir" = ordinary repo (`.git` directory); "pointer" = worktree/submodule
 *  checkout (`.git` gitfile whose state lives in the main clone's gitdir). */
export type GitRepoKind = "dir" | "pointer";

const exec = promisify(execFile);

export const HEX40 = /^[0-9a-f]{40}$/;

export async function git(root: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], {
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    // Strip every repo-redirecting env var: rbox may be invoked from a git hook or wrapper,
    // and a leaked GIT_COMMON_DIR/GIT_WORK_TREE/GIT_INDEX_FILE would point commonDir (now
    // load-bearing for the apply shape refusal + gitBusy) at a FOREIGN repo.
    env: { ...process.env, GIT_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } as NodeJS.ProcessEnv,
  });
  return stdout.toString().trim();
}
export async function gitOk(root: string, args: string[]): Promise<boolean> {
  try {
    await git(root, args);
    return true;
  } catch {
    return false;
  }
}

// ---- repo context -----------------------------------------------------------

/** Everything path-shaped about a repo, resolved once. `gitDir` is the per-worktree
 *  gitdir (HEAD/index/op-state live here); `commonDir` is the shared object/ref store
 *  (== gitDir for dir repos; the main clone's `.git` for pointer repos). */
export interface RepoCtx {
  repoDir: string;
  kind: GitRepoKind;
  gitDir: string;
  commonDir: string;
}

export async function detectGitKind(repoDir: string): Promise<GitRepoKind | undefined> {
  const st = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "pointer";
  return undefined; // symlinked `.git` — unsupported shape
}

/** Resolve the repo's gitdirs, or undefined when the repo is unusable (no `.git`,
 *  dangling pointer — the Conductor incident — or not a repo at all). */
export async function repoCtx(repoDir: string): Promise<RepoCtx | undefined> {
  const kind = await detectGitKind(repoDir);
  if (!kind) return undefined;
  let gitDir: string;
  try {
    gitDir = await git(repoDir, ["rev-parse", "--absolute-git-dir"]);
  } catch {
    return undefined; // dangling pointer / corrupt repo → caller skips cleanly
  }
  const commonRaw = await git(repoDir, ["rev-parse", "--git-common-dir"]).catch(() => gitDir);
  return { repoDir, kind, gitDir, commonDir: path.resolve(repoDir, commonRaw) };
}

export async function readHead(ctx: RepoCtx): Promise<string> {
  return (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8")).trim();
}

/** Design 68 §3.3 — for a repo dir, the POSIX relPath (from `root`) of the in-tree MAIN
 *  CLONE that owns it as a LINKED worktree, or undefined when it is NOT an in-tree linked
 *  worktree: an ordinary dir repo, a submodule checkout, or a worktree whose main clone
 *  lives outside `root`. Submodules are EXEMPT (V14): their `commonDir` resolves into
 *  `.git/modules/…` (basename is the module name, never a bare `.git`), and the superproject
 *  stays structurally refused, so no parent bundle would carry the module store — skipping
 *  them would regress design-43 support. Used to policy-skip the pointer's full-store
 *  capture (its history rides the in-tree main clone's bundle instead). */
export async function inTreeWorktreeParentRel(root: string, repoDir: string): Promise<string | undefined> {
  const ctx = await repoCtx(repoDir);
  if (!ctx || ctx.kind !== "pointer") return undefined;
  if (path.basename(ctx.commonDir) !== ".git") return undefined; // submodule checkout → exempt
  const mainTop = path.dirname(ctx.commonDir);
  const rootReal = await fs.realpath(root).catch(() => path.resolve(root));
  const mainReal = await fs.realpath(mainTop).catch(() => path.resolve(mainTop));
  const rel = path.relative(rootReal, mainReal);
  if (rel === "") return "."; // the sync root itself is the main clone
  if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined; // out-of-tree main clone → unchanged full capture
  return rel.split(path.sep).join("/"); // POSIX relPath, matching discoverGitRepos keys
}

/** One entry from `git worktree list --porcelain` — enough for branch-collision checks.
 *  `prunable` marks a stale entry (`git worktree prune` case), which design 68 treats
 *  as absent for apply collisions and live-worktree bookkeeping. */
export interface WorktreeEntry {
  path: string;
  /** full refname (refs/heads/…) the worktree has checked out; undefined when detached. */
  branch?: string;
  prunable: boolean;
}

/** Parse `git worktree list --porcelain` into structured entries. Never throws (a repo
 *  with no worktrees dir simply lists its single main entry; an error → []). */
export async function listWorktrees(repoDir: string): Promise<WorktreeEntry[]> {
  const out = await git(repoDir, ["worktree", "list", "--porcelain"]).catch(() => "");
  const entries: WorktreeEntry[] = [];
  let cur: (Partial<WorktreeEntry> & { path?: string }) | undefined;
  const flush = () => {
    if (cur?.path) entries.push({ path: cur.path, branch: cur.branch, prunable: cur.prunable ?? false });
    cur = undefined;
  };
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      cur = { path: line.slice("worktree ".length), prunable: false };
    } else if (!cur) {
      continue;
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length);
    } else if (line.startsWith("prunable")) {
      cur.prunable = true;
    }
  }
  flush();
  return entries;
}

/** "ref: refs/heads/x" → "refs/heads/x"; detached (40-hex) → undefined. */
export function headBranchOf(head: string): string | undefined {
  const m = /^ref: (refs\/heads\/\S+)$/.exec(head.trim());
  return m?.[1];
}

// ---- filesystem helpers ---------------------------------------------------

export async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** rename, with an EXDEV fallback (copy to a temp in the DEST dir, then rename) — a
 *  pointer repo's resolved gitdir (the main clone) may live on a different mount than
 *  the worktree where the apply staged its temp files. */
export async function moveFileAtomic(src: string, dest: string): Promise<void> {
  try {
    await fs.rename(src, dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
    const tmp = path.join(path.dirname(dest), `.rbox-xdev-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
    await fs.copyFile(src, tmp);
    await fs.rename(tmp, dest);
    await fs.rm(src, { force: true }).catch(() => {});
  }
}

export async function gitBusy(ctx: RepoCtx): Promise<boolean> {
  // per-worktree locks live in the resolved gitdir; store-wide locks in the common dir
  for (const lock of [path.join(ctx.gitDir, "index.lock"), path.join(ctx.gitDir, "HEAD.lock"), path.join(ctx.commonDir, "gc.pid")]) {
    if (await exists(lock)) return true;
  }
  // any *.lock under the SHARED refs/
  const refsDir = path.join(ctx.commonDir, "refs");
  if (await exists(refsDir)) {
    for (const rel of await walkFiles(refsDir)) if (rel.endsWith(".lock")) return true;
  }
  return false;
}

// ---- encrypted artifact IO (§28) ------------------------------------------

export interface PutGitArtifactOptions {
  attempts?: number;
  backoff?: (attempt: number) => Promise<void>;
  uploadsDir?: string;
}

const isBlobShaMismatchError = (e: unknown): boolean => e instanceof Error && e.name === "BlobShaMismatchError";

/** §28: ENCRYPT a staged plaintext artifact under the workspace KEK, upload the CIPHERTEXT by
 *  its encSha (convergent — same primitive + receipt-capturing store path as file blobs), and
 *  return the (plaintext sha, encSha, cipherSize) ref. Skips the upload if the account already
 *  has the ciphertext blob (entitled+present). On a typed sha-mismatch, drop the stale
 *  ciphertext temp, re-encrypt from the staged plaintext artifact, back off, and retry
 *  within the caller's bound. The temp ciphertext is always cleaned up. */
export async function putGitArtifact(
  store: BlobStore,
  kek: Buffer,
  srcPath: string,
  tmpDir: string,
  opts: PutGitArtifactOptions = {}
): Promise<GitArtifactRef> {
  const attempts = Math.max(1, opts.attempts ?? 1);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const enc = await encryptFileToTemp(srcPath, kek, tmpDir);
    try {
      if (!(await store.has(enc.encSha))) {
        if (store.putFile) await store.putFile(enc.encSha, enc.ciphertextPath, enc.cipherSize, opts.uploadsDir);
        else await store.put(enc.encSha, await fs.readFile(enc.ciphertextPath));
      }
      return { sha: enc.plaintextSha, encSha: enc.encSha, cipherSize: enc.cipherSize };
    } catch (e) {
      if (!isBlobShaMismatchError(e) || attempt + 1 >= attempts) throw e;
      await opts.backoff?.(attempt);
    } finally {
      await fs.rm(enc.ciphertextPath, { force: true });
    }
  }
  throw new Error("unreachable git artifact upload retry state");
}

async function getBlobToFile(store: BlobStore, sha: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  if (store.getToFile) await store.getToFile(sha, destPath);
  else await fs.writeFile(destPath, await store.get(sha));
}

/** §28: fetch a git artifact's CIPHERTEXT by encSha, then decrypt+verify (GCM tag + plaintext-sha)
 *  to `destPath`. Throws on any fetch/decrypt/verify failure — callers run this into temp files
 *  BEFORE mutating the gitdir (codex M4), so a bad/ swapped/ corrupt blob never half-applies. */
export async function getGitArtifact(store: BlobStore, kek: Buffer, ref: GitArtifactRef, destPath: string, tmpDir: string): Promise<void> {
  const ct = path.join(tmpDir, `ct-${ref.encSha}`);
  await getBlobToFile(store, ref.encSha, ct);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await decryptFileToPath(ct, kek, ref.sha, destPath);
  await fs.rm(ct, { force: true });
}
