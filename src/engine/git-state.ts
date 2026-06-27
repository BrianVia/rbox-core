import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BlobStore } from "./blobstore.js";
import { hashFile } from "./hash.js";
import { writeFileAtomic } from "./fsutil.js";
import type { GitSection } from "./types.js";

const exec = promisify(execFile);

/**
 * Git-native repo-state sync (M2 v3). History rides `git bundle` (consistent on a
 * live repo by design); index/HEAD/op-state are atomic single-file captures.
 * Nothing copies the live `.git` tree, so there is no torn-snapshot failure.
 *
 * Change detection uses a STABLE identity (refs + HEAD + index hash + op-state),
 * NOT the bundle bytes — `git stash create` mints a fresh commit each capture, so
 * bundle bytes vary even when the repo is unchanged; keying off them would echo
 * the git section forever.
 */

// Op-state paths (relative to .git) that let you continue a paused operation.
const OP_STATE_FILES = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "ORIG_HEAD", "MERGE_MSG"];
const OP_STATE_DIRS = ["rebase-merge", "rebase-apply", "sequencer"];

async function git(root: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], {
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    env: { ...process.env, GIT_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined } as NodeJS.ProcessEnv,
  });
  return stdout.toString().trim();
}
async function gitOk(root: string, args: string[]): Promise<boolean> {
  try {
    await git(root, args);
    return true;
  } catch {
    return false;
  }
}

/** Preflight: only ordinary, non-bare, in-root repos with a real `.git` dir. */
export async function gitPreflight(root: string): Promise<{ ok: boolean; reason?: string }> {
  let st;
  try {
    st = await fs.stat(path.join(root, ".git"));
  } catch {
    return { ok: false, reason: "no .git" };
  }
  if (!st.isDirectory()) return { ok: false, reason: ".git is a file (worktree/submodule) — unsupported" };
  if (!(await gitOk(root, ["rev-parse", "--is-inside-work-tree"]))) return { ok: false, reason: "not a work tree" };
  if ((await git(root, ["rev-parse", "--is-bare-repository"])) !== "false") return { ok: false, reason: "bare repo — unsupported" };
  const top = await git(root, ["rev-parse", "--show-toplevel"]).catch(() => "");
  // git returns a realpath; the sync root may contain symlinks (e.g. macOS
  // /var/folders -> /private/var/folders), so compare realpaths, not lexical paths.
  const rootReal = await fs.realpath(root).catch(() => path.resolve(root));
  const topReal = top ? await fs.realpath(top).catch(() => path.resolve(top)) : "";
  if (topReal !== rootReal) return { ok: false, reason: "repo toplevel != sync root" };
  for (const bad of ["objects/info/alternates", "worktrees", "modules"]) {
    if (await exists(path.join(root, ".git", bad))) return { ok: false, reason: `.git/${bad} present — unsupported` };
  }
  return { ok: true };
}

/** Cheap, stable identity of the repo state (no bundling). Undefined if no commits. */
export async function gitIdentity(root: string): Promise<Omit<GitSection, "bundleSha" | "bundleSize" | "generatedAt"> | undefined> {
  if (!(await gitOk(root, ["rev-parse", "--verify", "HEAD"]))) return undefined; // empty repo
  const refs = await readRefs(root);
  const head = (await fs.readFile(path.join(root, ".git", "HEAD"), "utf8")).trim();
  // Stable staging identity via write-tree (NOT the raw index file hash, which git
  // refreshes). write-tree may refresh stat info — harmless, like `git status`.
  const indexTree = (await git(root, ["write-tree"]).catch(() => "")) || undefined;
  const opState = await readOpState(root, async (p) => hashFile(p));
  return { refs, head, indexTree, opState: Object.keys(opState).length ? opState : undefined };
}

/** Full capture: build the bundle + upload all artifacts; return the manifest section.
 *
 * Small files (index, op-state) are STAGED (copied) into a temp dir FIRST and then
 * hashed+uploaded from those copies — never from the live `.git`. This avoids a
 * TOCTOU where `git stash create` (below) rewrites `.git/index` between hashing and
 * upload, making the claimed sha disagree with the uploaded bytes. (git writes
 * these files via atomic rename, so a copy is always an internally-consistent
 * snapshot.) History rides the bundle, which git produces consistently regardless.
 */
export async function captureGitState(root: string, store: BlobStore): Promise<GitSection | undefined> {
  if (!(await gitOk(root, ["rev-parse", "--verify", "HEAD"]))) return undefined; // empty repo

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcap-"));
  try {
    const gitDir = path.join(root, ".git");
    // Clean any stale internal scratch ref left by a prior crashed capture.
    await git(root, ["update-ref", "-d", "refs/rbox-wip"]).catch(() => {});

    // 1. Stage index + op-state immediately (atomic single-file snapshots).
    let stagedIndex: string | undefined;
    if (await exists(path.join(gitDir, "index"))) {
      stagedIndex = path.join(tmpDir, "index");
      await fs.copyFile(path.join(gitDir, "index"), stagedIndex);
    }
    const stagedOp: Array<{ rel: string; staged: string }> = [];
    const liveOp = await readOpState(root, async () => ""); // just enumerate present op-state
    for (const rel of Object.keys(liveOp)) {
      const staged = path.join(tmpDir, "op", rel);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(path.join(gitDir, rel), staged);
      stagedOp.push({ rel, staged });
    }

    // 2. refs + HEAD (read via git / atomic file).
    const refs = await readRefs(root);
    const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8")).trim();

    // 3. Make dirty+staged state reachable so the bundle ships index blobs, then bundle.
    const wip = (await git(root, ["stash", "create"]).catch(() => "")).trim();
    if (wip) await git(root, ["update-ref", "refs/rbox-wip", wip]);
    const bundlePath = path.join(tmpDir, "repo.bundle");
    try {
      await git(root, ["bundle", "create", bundlePath, "--all", ...(refs["refs/stash"] ? ["refs/stash"] : []), ...(wip ? ["refs/rbox-wip"] : [])]);
    } finally {
      if (wip) await git(root, ["update-ref", "-d", "refs/rbox-wip"]).catch(() => {});
    }

    // 4. Hash + upload everything from the staging copies (sha always matches bytes).
    const bundleSha = await hashFile(bundlePath);
    const bundleSize = (await fs.stat(bundlePath)).size;
    await putBlobFromFile(store, bundleSha, bundlePath, bundleSize);

    let indexSha: string | undefined;
    if (stagedIndex) {
      indexSha = await hashFile(stagedIndex);
      await putBlobFromFile(store, indexSha, stagedIndex);
    }
    const indexTree = (await git(root, ["write-tree"]).catch(() => "")) || undefined;
    const opState: Record<string, string> = {};
    for (const { rel, staged } of stagedOp) {
      const sha = await hashFile(staged);
      opState[rel] = sha;
      await putBlobFromFile(store, sha, staged);
    }

    return { bundleSha, bundleSize, head, refs, indexSha, indexTree, opState: Object.keys(opState).length ? opState : undefined, generatedAt: new Date().toISOString() };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/** A stable string fingerprint for reconcile/change-detection. Uses the write-tree
 *  staging identity (NOT the volatile raw index hash) and excludes bundle bytes. */
export function gitIdentityKey(g: GitSection | { refs: Record<string, string>; head: string; indexTree?: string; opState?: Record<string, string> } | undefined): string {
  if (!g) return "none";
  const refs = Object.entries(g.refs).sort().map(([k, v]) => `${k}=${v}`).join(",");
  const ops = g.opState ? Object.entries(g.opState).sort().map(([k, v]) => `${k}=${v}`).join(",") : "";
  return `${g.head}|${g.indexTree ?? ""}|${refs}|${ops}`;
}

export interface ApplyGitResult {
  applied: boolean;
  reason?: string;
  conflictBundle?: string;
}

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** Reject a malformed/hostile section before it touches `.git`. */
export function validateGitSection(s: GitSection): { ok: boolean; reason?: string } {
  if (!HEX64.test(s.bundleSha)) return { ok: false, reason: "bad bundleSha" };
  if (s.indexSha && !HEX64.test(s.indexSha)) return { ok: false, reason: "bad indexSha" };
  if (!/^(ref: refs\/[A-Za-z0-9._\/-]+|[0-9a-f]{40})$/.test(s.head.trim())) return { ok: false, reason: "bad HEAD" };
  for (const [ref, sha] of Object.entries(s.refs)) {
    if (!isSyncableRef(ref) || ref.includes("..") || ref.includes("\0")) return { ok: false, reason: `bad ref ${ref}` };
    if (!HEX40.test(sha)) return { ok: false, reason: `bad ref sha ${ref}` };
  }
  for (const [rel, sha] of Object.entries(s.opState ?? {})) {
    const okRel = OP_STATE_FILES.includes(rel) || OP_STATE_DIRS.some((d) => rel.startsWith(`${d}/`));
    if (!okRel || rel.includes("..") || rel.includes("\0") || rel.startsWith("/")) return { ok: false, reason: `bad opState ${rel}` };
    if (!HEX64.test(sha)) return { ok: false, reason: `bad opState sha ${rel}` };
  }
  return { ok: true };
}

interface LocalSnapshot {
  refs: Record<string, string>;
  head: string;
  indexBytes?: Buffer;
  opState: Record<string, Buffer>;
}
async function snapshotLocal(root: string): Promise<LocalSnapshot> {
  const gitDir = path.join(root, ".git");
  const refs = await readRefs(root);
  const head = (await fs.readFile(path.join(gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const indexBytes = (await exists(path.join(gitDir, "index"))) ? await fs.readFile(path.join(gitDir, "index")) : undefined;
  const opState: Record<string, Buffer> = {};
  for (const rel of Object.keys(await readOpState(root, async () => ""))) opState[rel] = await fs.readFile(path.join(gitDir, rel));
  return { refs, head, indexBytes, opState };
}
async function restoreLocal(root: string, snap: LocalSnapshot): Promise<void> {
  const gitDir = path.join(root, ".git");
  // Reset syncable refs to the snapshot.
  for (const ref of Object.keys(await readRefs(root))) if (!(ref in snap.refs)) await git(root, ["update-ref", "-d", ref]).catch(() => {});
  for (const [ref, sha] of Object.entries(snap.refs)) await git(root, ["update-ref", ref, sha]).catch(() => {});
  if (snap.head) await writeFileAtomic(path.join(gitDir, "HEAD"), snap.head.endsWith("\n") ? snap.head : `${snap.head}\n`);
  if (snap.indexBytes) await writeFileAtomic(path.join(gitDir, "index"), snap.indexBytes);
  for (const rel of Object.keys(await readOpState(root, async () => ""))) if (!(rel in snap.opState)) await fs.rm(path.join(gitDir, rel), { force: true }).catch(() => {});
  for (const [rel, bytes] of Object.entries(snap.opState)) {
    await fs.mkdir(path.dirname(path.join(gitDir, rel)), { recursive: true });
    await writeFileAtomic(path.join(gitDir, rel), bytes);
  }
}

/**
 * CLEAN apply (caller guarantees local == base): import objects from the bundle,
 * publish refs/HEAD to exactly the remote set, restore index/op-state — under
 * receiver quiescence, transactionally. On any failure or fsck-fail, ROLL BACK to
 * the pre-apply snapshot. Quarantines local first (fail-closed if that fails).
 */
export async function applyGitState(root: string, section: GitSection, store: BlobStore): Promise<ApplyGitResult> {
  const v = validateGitSection(section);
  if (!v.ok) return { applied: false, reason: `invalid git section: ${v.reason}` };

  if (!(await exists(path.join(root, ".git")))) await git(root, ["init", "-q"]); // fresh machine
  if (await gitBusy(root)) return { applied: false, reason: "receiver git busy" };

  const gitDir = path.join(root, ".git");
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitap-"));
  const hadHead = await gitOk(root, ["rev-parse", "--verify", "HEAD"]);
  const snap = await snapshotLocal(root);
  try {
    // Quarantine local committed state first — fail closed if we can't.
    let conflictBundle: string | undefined;
    if (hadHead) {
      const qDir = path.join(root, ".rbox", "git-quarantine");
      await fs.mkdir(qDir, { recursive: true });
      conflictBundle = path.join(qDir, `${Date.now()}.bundle`);
      try {
        await git(root, ["bundle", "create", conflictBundle, "--all"]);
      } catch (e) {
        return { applied: false, reason: `quarantine bundle failed; aborting: ${(e as Error)?.message ?? e}` };
      }
    }

    // Import objects from the remote bundle into a non-checked-out namespace.
    const bundlePath = path.join(tmpDir, "in.bundle");
    await getBlobToFile(store, section.bundleSha, bundlePath);
    if (!(await gitOk(root, ["bundle", "verify", bundlePath]))) return { applied: false, reason: "bundle verify failed", conflictBundle };
    await git(root, ["fetch", bundlePath, "refs/*:refs/rbox-incoming/*"], { maxBuffer: 64 * 1024 * 1024 });

    try {
      // Publish refs to exactly the remote set (syncable namespaces only).
      for (const [ref, sha] of Object.entries(section.refs)) await git(root, ["update-ref", ref, sha]);
      for (const ref of Object.keys(await readRefs(root))) {
        if (!(ref in section.refs)) await git(root, ["update-ref", "-d", ref]).catch(() => {});
      }
      await writeFileAtomic(path.join(gitDir, "HEAD"), section.head.endsWith("\n") ? section.head : `${section.head}\n`);

      // Restore index + op-state via temp→rename (never a torn live file).
      if (section.indexSha) await getBlobAtomic(store, section.indexSha, path.join(gitDir, "index"));
      await restoreOpState(root, section.opState ?? {}, store);

      if (!(await gitOk(root, ["fsck", "--connectivity-only", "--no-dangling"]))) {
        await restoreLocal(root, snap); // ROLLBACK
        return { applied: false, reason: "post-apply fsck failed — rolled back", conflictBundle };
      }
    } catch (e) {
      await restoreLocal(root, snap).catch(() => {}); // ROLLBACK on any mutation error
      return { applied: false, reason: `apply failed — rolled back: ${(e as Error)?.message ?? e}`, conflictBundle };
    } finally {
      for (const ref of await listRefs(root, "refs/rbox-incoming")) await git(root, ["update-ref", "-d", ref]).catch(() => {});
    }
    return { applied: true, conflictBundle };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * CONFLICT preserve (both sides diverged): do NOT clobber local. Import the remote
 * refs into a recovery namespace and bundle, so the user can merge manually.
 */
export async function preserveGitConflict(root: string, section: GitSection, store: BlobStore): Promise<{ recoveryBundle?: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcf-"));
  try {
    const bundlePath = path.join(tmpDir, "remote.bundle");
    await getBlobToFile(store, section.bundleSha, bundlePath);
    if (!(await gitOk(root, ["bundle", "verify", bundlePath]))) return {};
    const ts = `${Date.now()}`;
    await git(root, ["fetch", bundlePath, `refs/*:refs/rbox-conflict/${ts}/*`], { maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
    const recDir = path.join(root, ".rbox", "git-conflicts");
    await fs.mkdir(recDir, { recursive: true });
    const recoveryBundle = path.join(recDir, `remote-${ts}.bundle`);
    await fs.copyFile(bundlePath, recoveryBundle).catch(() => {});
    return { recoveryBundle };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ---- helpers --------------------------------------------------------------

/** Only these ref namespaces sync. NOT refs/remotes (machine-local origins),
 *  refs/notes, refs/replace, or refs/rbox-* (our internal scratch). */
export function isSyncableRef(ref: string): boolean {
  return ref.startsWith("refs/heads/") || ref.startsWith("refs/tags/") || ref === "refs/stash";
}

async function readRefs(root: string): Promise<Record<string, string>> {
  const out = await git(root, ["show-ref"]).catch(() => "");
  const refs: Record<string, string> = {};
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [sha, ref] = line.split(" ");
    if (sha && ref && isSyncableRef(ref)) refs[ref] = sha;
  }
  return refs;
}
async function listRefs(root: string, prefix: string): Promise<string[]> {
  const out = await git(root, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
  return out.split("\n").filter(Boolean);
}

async function readOpState(root: string, hash: (absPath: string) => Promise<string>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const f of OP_STATE_FILES) {
    const abs = path.join(root, ".git", f);
    if (await exists(abs)) out[f] = await hash(abs);
  }
  for (const d of OP_STATE_DIRS) {
    const abs = path.join(root, ".git", d);
    if (await exists(abs)) {
      for (const rel of await walkFiles(abs)) out[`${d}/${rel}`] = await hash(path.join(abs, rel));
    }
  }
  return out;
}

async function restoreOpState(root: string, opState: Record<string, string>, store: BlobStore): Promise<void> {
  // Remove any op-state the sender no longer has (completed operation).
  const existing = await readOpState(root, async () => "");
  for (const rel of Object.keys(existing)) {
    if (!(rel in opState)) await fs.rm(path.join(root, ".git", rel), { force: true }).catch(() => {});
  }
  for (const [rel, sha] of Object.entries(opState)) {
    await getBlobAtomic(store, sha, path.join(root, ".git", rel));
  }
}

async function gitBusy(root: string): Promise<boolean> {
  for (const lock of ["index.lock", "HEAD.lock", "gc.pid"]) {
    if (await exists(path.join(root, ".git", lock))) return true;
  }
  // any *.lock under refs/
  const refsDir = path.join(root, ".git", "refs");
  if (await exists(refsDir)) {
    for (const rel of await walkFiles(refsDir)) if (rel.endsWith(".lock")) return true;
  }
  return false;
}

async function walkFiles(dir: string, base = ""): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.readdir(path.join(dir, base), { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...(await walkFiles(dir, rel)));
    else if (e.isFile()) out.push(rel);
  }
  return out;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function putBlobFromFile(store: BlobStore, sha: string, srcPath: string, size?: number): Promise<void> {
  if (await store.has(sha)) return;
  if (store.putFile) {
    await store.putFile(sha, srcPath, size ?? (await fs.stat(srcPath)).size);
  } else {
    await store.put(sha, await fs.readFile(srcPath));
  }
}
async function getBlobToFile(store: BlobStore, sha: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  if (store.getToFile) await store.getToFile(sha, destPath);
  else await fs.writeFile(destPath, await store.get(sha));
}

/** Download to a temp sibling, then atomic-rename into place — never a torn live
 *  `.git` file (HEAD/index/op-state). */
async function getBlobAtomic(store: BlobStore, sha: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.rbox-tmp-${process.pid}-${Math.abs(hashLite(sha + destPath))}`;
  await getBlobToFile(store, sha, tmp);
  await fs.rename(tmp, destPath);
}
function hashLite(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return h;
}
