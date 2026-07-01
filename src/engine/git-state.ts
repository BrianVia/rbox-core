import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { BlobStore } from "./blobstore.js";
import { hashFile } from "./hash.js";
import { writeFileAtomic } from "./fsutil.js";
import { encryptFileToTemp, decryptFileToPath } from "./crypto.js";
import { OP_STATE_DIRS, OP_STATE_FILES, isSyncableRef, validateGitSection } from "./manifest-validate.js";
import type { GitArtifactRef, GitRefScope, GitSection } from "./types.js";

// Re-exported for compat: these moved to manifest-validate.ts (pure — validateManifest
// validates gitRepos values, and manifest-validate must stay node:*-free for the Worker).
export { isSyncableRef, validateGitSection };

/** The stable, plaintext-only identity of a repo's git state (no ciphertext addresses) —
 *  what change-detection compares. Distinct from the stored `GitSection`, whose blob fields
 *  are encShas. opState here is `rel → plaintext sha`. Carries `refScope` so callers can
 *  drive the design-43 §7 comparison matrix (project before comparing across scopes). */
export type GitIdentity = Pick<GitSection, "head" | "refs" | "indexTree" | "refScope"> & { opState?: Record<string, string> };

/** Repo shape: "dir" = ordinary repo (`.git` directory); "pointer" = worktree/submodule
 *  checkout (`.git` gitfile whose state lives in the main clone's gitdir). */
export type GitRepoKind = "dir" | "pointer";

export interface GitPreflightResult {
  ok: boolean;
  reason?: string;
  kind?: GitRepoKind;
}

const exec = promisify(execFile);

/**
 * Git-native repo-state sync (M2 v3, generalized per design 43 §§4-5). History rides
 * `git bundle` (consistent on a live repo by design); index/HEAD/op-state are atomic
 * single-file captures read from the RESOLVED gitdir (`git rev-parse --absolute-git-dir`)
 * — for pointer repos (worktree/submodule checkouts) that lands in the main clone's
 * `.git/worktrees/<n>/` (or `.git/modules/…`), never a hardcoded `repoDir/.git`.
 *
 * Change detection uses a STABLE identity (refs + HEAD + index hash + op-state),
 * NOT the bundle bytes — `git stash create` mints a fresh commit each capture, so
 * bundle bytes vary even when the repo is unchanged; keying off them would echo
 * the git section forever.
 */

const HEX40 = /^[0-9a-f]{40}$/;

/** Op-state files whose contents are COMMIT shas that must be PINNED into the bundle's
 *  object closure (design 43 §5 [v2, B3]): `bundle create HEAD refs/heads/x` omits a
 *  MERGE_HEAD commit from another branch (codex repro), which would restore a pseudo-ref
 *  pointing at a missing object. AUTO_MERGE (a TREE) is pinned separately in
 *  collectPinShas; MERGE_MSG is plain text. */
const PSEUDO_REF_SHA_FILES = [
  "MERGE_HEAD",
  "REBASE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "ORIG_HEAD",
  "rebase-merge/orig-head",
  "rebase-apply/orig-head",
];

const WIP_NS = "refs/rbox-wip";
const SCRATCH_MAX_AGE_MS = 60 * 60 * 1000; // 1h — see pruneStaleScratchRefs

async function git(root: string, args: string[], opts: { maxBuffer?: number } = {}): Promise<string> {
  const { stdout } = await exec("git", ["-C", root, ...args], {
    maxBuffer: opts.maxBuffer ?? 16 * 1024 * 1024,
    // Strip every repo-redirecting env var: rbox may be invoked from a git hook or wrapper,
    // and a leaked GIT_COMMON_DIR/GIT_WORK_TREE/GIT_INDEX_FILE would point commonDir (now
    // load-bearing for the apply shape refusal + gitBusy) at a FOREIGN repo.
    env: { ...process.env, GIT_DIR: undefined, GIT_OBJECT_DIRECTORY: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined } as NodeJS.ProcessEnv,
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

// ---- repo context -----------------------------------------------------------

/** Everything path-shaped about a repo, resolved once. `gitDir` is the per-worktree
 *  gitdir (HEAD/index/op-state live here); `commonDir` is the shared object/ref store
 *  (== gitDir for dir repos; the main clone's `.git` for pointer repos). */
interface RepoCtx {
  repoDir: string;
  kind: GitRepoKind;
  gitDir: string;
  commonDir: string;
}

async function detectGitKind(repoDir: string): Promise<GitRepoKind | undefined> {
  const st = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
  if (!st) return undefined;
  if (st.isDirectory()) return "dir";
  if (st.isFile()) return "pointer";
  return undefined; // symlinked `.git` — unsupported shape
}

/** Resolve the repo's gitdirs, or undefined when the repo is unusable (no `.git`,
 *  dangling pointer — the Conductor incident — or not a repo at all). */
async function repoCtx(repoDir: string): Promise<RepoCtx | undefined> {
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

async function readHead(ctx: RepoCtx): Promise<string> {
  return (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8")).trim();
}

/** "ref: refs/heads/x" → "refs/heads/x"; detached (40-hex) → undefined. */
function headBranchOf(head: string): string | undefined {
  const m = /^ref: (refs\/heads\/\S+)$/.exec(head.trim());
  return m?.[1];
}

// ---- preflight (design 43 §4) ------------------------------------------------

/** Preflight: ordinary non-bare repos whose toplevel IS `repoDir` — as a real `.git`
 *  dir ("dir") or a gitfile worktree/submodule checkout ("pointer"). Dir-repos with
 *  linked worktrees (`.git/worktrees/`) or submodules (`.git/modules/`) stay refused
 *  (v1; superprojects explicitly unsupported [v2, M1]); alternates refused for both
 *  kinds (pointer: checked on the RESOLVED object store). Dangling pointers (main
 *  clone deleted) fail cleanly — the repo is skipped this cycle. */
export async function gitPreflight(repoDir: string): Promise<GitPreflightResult> {
  const kind = await detectGitKind(repoDir);
  if (!kind) {
    const st = await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined);
    if (!st) return { ok: false, reason: "no .git" };
    return { ok: false, reason: ".git is neither a directory nor a gitfile pointer — unsupported" };
  }
  const ctx = await repoCtx(repoDir);
  if (!ctx) {
    return { ok: false, reason: kind === "pointer" ? "dangling .git pointer (main clone missing?)" : "unreadable .git — unsupported", kind };
  }
  if (!(await gitOk(repoDir, ["rev-parse", "--is-inside-work-tree"]))) return { ok: false, reason: "not a work tree", kind };
  if ((await git(repoDir, ["rev-parse", "--is-bare-repository"]).catch(() => "")) !== "false") return { ok: false, reason: "bare repo — unsupported", kind };
  const top = await git(repoDir, ["rev-parse", "--show-toplevel"]).catch(() => "");
  // git returns a realpath; the repo dir may contain symlinks (e.g. macOS
  // /var/folders -> /private/var/folders), so compare realpaths, not lexical paths.
  const dirReal = await fs.realpath(repoDir).catch(() => path.resolve(repoDir));
  const topReal = top ? await fs.realpath(top).catch(() => path.resolve(top)) : "";
  if (topReal !== dirReal) return { ok: false, reason: "repo toplevel != repo dir", kind };
  if (kind === "dir") {
    for (const bad of ["objects/info/alternates", "worktrees", "modules"]) {
      if (await exists(path.join(repoDir, ".git", bad))) return { ok: false, reason: `.git/${bad} present — unsupported`, kind };
    }
  } else {
    // pointer: the object store is the main clone's — refuse if THAT uses alternates.
    if (await exists(path.join(ctx.commonDir, "objects", "info", "alternates"))) {
      return { ok: false, reason: "resolved gitdir uses objects/info/alternates — unsupported", kind };
    }
  }
  return { ok: true, kind };
}

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
async function indexTreeOf(ctx: RepoCtx): Promise<string | undefined> {
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

// ---- scratch-ref pinning (design 43 §5 [v2, B2/B3; v3]) ------------------------

interface ScratchPins {
  /** enumerated exact refs, e.g. refs/rbox-wip/<epochMs>-<rand>/0 — a literal glob arg
   *  to `git bundle create` FAILS ("Refusing to create empty bundle"), so these are
   *  passed to the bundle EXPLICITLY, never as a wildcard. */
  refs: string[];
}

/** Pin every commit the section will reference under a CAPTURE-UNIQUE namespace
 *  `refs/rbox-wip/<epochMs>-<rand>/<n>`: linked worktrees share one ref store, so a
 *  single global scratch ref would race under concurrent sibling captures [v2, B2]. */
async function createScratchPins(repoDir: string, shas: string[]): Promise<ScratchPins> {
  const ns = `${WIP_NS}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  const refs: string[] = [];
  try {
    let n = 0;
    for (const sha of shas) {
      const ref = `${ns}/${n++}`;
      await git(repoDir, ["update-ref", ref, sha]);
      refs.push(ref);
    }
  } catch (e) {
    await deleteScratchPins(repoDir, { refs });
    throw e;
  }
  return { refs };
}

async function deleteScratchPins(repoDir: string, pins: ScratchPins): Promise<void> {
  for (const ref of pins.refs) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
}

/** Prune stale scratch refs left by CRASHED runs — AGE-GUARDED [v3]: only entries whose
 *  `<epochMs>-<rand>` id is older than 1h are deleted. A blind prune in a SHARED gitdir
 *  would delete a concurrent sibling capture's live pins. */
async function pruneStaleScratchRefs(repoDir: string, ns: string): Promise<void> {
  const out = await git(repoDir, ["for-each-ref", "--format=%(refname)", ns]).catch(() => "");
  const cutoff = Date.now() - SCRATCH_MAX_AGE_MS;
  for (const ref of out.split("\n").filter(Boolean)) {
    if (ref === ns) {
      // legacy pre-§43 exact ref (`refs/rbox-wip`) from a crashed old capture — it D/F-blocks
      // the namespaced refs below and old clients only ever ran on unshared root repos, so
      // deleting it blindly is safe (and matches the old cleanup).
      await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
      continue;
    }
    const id = ref.slice(ns.length + 1).split("/")[0] ?? "";
    const epoch = Number.parseInt(id, 10);
    if (Number.isFinite(epoch) && epoch < cutoff) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
  }
}

/** Objects the section references that a scoped bundle might not reach: the detached-HEAD
 *  sha (a bundle's HEAD advertisement is NOT imported by `git fetch 'refs/*:…'` — codex
 *  verified), every pseudo-ref COMMIT sha the op-state references, and the AUTO_MERGE
 *  TREE (ort writes it on conflict; restoring the file without its tree object leaves
 *  `git diff AUTO_MERGE` broken on the receiver — codex repro. A ref may point at a tree
 *  and `git bundle create` ships its closure — verified locally, git 2.50.1). Applied to
 *  DIR captures too (the pseudo-ref hole is latent in design 02: `--all` usually reaches
 *  those commits via a branch, but nothing guarantees it). Only shas whose objects verify
 *  are pinned — a stale pseudo-ref must not fail the whole bundle. */
async function collectPinShas(ctx: RepoCtx, head: string): Promise<string[]> {
  const shas = new Set<string>();
  const h = head.trim();
  if (HEX40.test(h)) shas.add(h); // detached HEAD
  for (const rel of PSEUDO_REF_SHA_FILES) {
    const txt = await fs.readFile(path.join(ctx.gitDir, rel), "utf8").catch(() => "");
    for (const line of txt.split("\n")) {
      const s = line.trim();
      if (HEX40.test(s)) shas.add(s); // MERGE_HEAD may list several (octopus)
    }
  }
  const out: string[] = [];
  for (const s of shas) {
    if (await gitOk(ctx.repoDir, ["rev-parse", "--verify", "--quiet", `${s}^{commit}`])) out.push(s);
  }
  const autoMerge = (await fs.readFile(path.join(ctx.gitDir, "AUTO_MERGE"), "utf8").catch(() => "")).trim();
  if (HEX40.test(autoMerge) && !out.includes(autoMerge) && (await gitOk(ctx.repoDir, ["rev-parse", "--verify", "--quiet", `${autoMerge}^{tree}`]))) {
    out.push(autoMerge);
  }
  return out;
}

// ---- capture (design 43 §5) ----------------------------------------------------

/** Full capture: build the bundle + upload all artifacts; return the manifest section.
 *
 * Small files (index, op-state) are STAGED (copied) into a temp dir FIRST and then
 * hashed+uploaded from those copies — never from the live gitdir. This avoids a
 * TOCTOU where `git stash create` (below) rewrites the index between hashing and
 * upload, making the claimed sha disagree with the uploaded bytes. (git writes
 * these files via atomic rename, so a copy is always an internally-consistent
 * snapshot.) History rides the bundle, which git produces consistently regardless.
 *
 * Scope split (design 43 §5):
 * - dir repo → refScope "all": bundle `--all` + refs/stash + enumerated pins.
 * - pointer repo → refScope "scoped": bundle `refs/heads/<current-branch>` + enumerated
 *   pins ONLY — no `--all`, and `refs/stash` is NEVER captured (it lives in the SHARED
 *   gitdir; per-worktree capture would fan one global stash stack out into N standalone
 *   repos [v2, B2]). Uncommitted dirty state still transfers via the WIP commit + index.
 */
export async function captureGitState(repoDir: string, store: BlobStore, kek: Buffer): Promise<GitSection | undefined> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) return undefined; // unusable (dangling pointer etc.) → caller defers
  if (!(await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"]))) return undefined; // empty repo

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcap-"));
  let pins: ScratchPins | undefined;
  try {
    // Age-guarded prune of scratch refs left by prior crashed captures (shared-store safe).
    await pruneStaleScratchRefs(repoDir, WIP_NS);

    // 1. Stage index + op-state immediately (atomic single-file snapshots) — from the
    //    RESOLVED gitdir (pointer repos: `.git/worktrees/<n>/…`), never `repoDir/.git`.
    let stagedIndex: string | undefined;
    if (await exists(path.join(ctx.gitDir, "index"))) {
      stagedIndex = path.join(tmpDir, "index");
      await fs.copyFile(path.join(ctx.gitDir, "index"), stagedIndex);
    }
    const stagedOp: Array<{ rel: string; staged: string }> = [];
    const liveOp = await readOpState(ctx.gitDir, async () => ""); // just enumerate present op-state
    for (const rel of Object.keys(liveOp)) {
      const staged = path.join(tmpDir, "op", rel);
      await fs.mkdir(path.dirname(staged), { recursive: true });
      await fs.copyFile(path.join(ctx.gitDir, rel), staged);
      stagedOp.push({ rel, staged });
    }

    // 2. refs + HEAD (scope-aware) — read via git / atomic file from the resolved gitdir.
    const head = await readHead(ctx);
    const refs = ctx.kind === "dir" ? await readAllRefs(repoDir) : await readScopedRefs(repoDir, head);

    // 3. Make dirty+staged state + pseudo-ref commits reachable, then bundle.
    //    `git stash create` works from a worktree context unchanged.
    const wip = (await git(repoDir, ["stash", "create"]).catch(() => "")).trim();
    const pinShas = new Set(await collectPinShas(ctx, head));
    if (wip) pinShas.add(wip);
    pins = await createScratchPins(repoDir, [...pinShas]);
    const bundlePath = path.join(tmpDir, "repo.bundle");
    const bundleArgs =
      ctx.kind === "dir"
        ? ["--all", ...(refs["refs/stash"] ? ["refs/stash"] : []), ...pins.refs]
        : [...Object.keys(refs), ...pins.refs]; // current branch (if any) + pins; detached HEAD rides its pin
    await git(repoDir, ["bundle", "create", bundlePath, ...bundleArgs]);

    // 4. §28: ENCRYPT each staged artifact under the workspace KEK, upload the CIPHERTEXT by
    //    encSha (convergent — same primitive as file blobs), and record (plaintext sha, encSha,
    //    cipherSize). The server only ever sees ciphertext + encShas; the manifest carrying this
    //    section is itself E2EE-encrypted, so refs/HEAD/object-shas stay private too.
    const bundle = await putGitArtifact(store, kek, bundlePath, tmpDir);

    let index: GitArtifactRef | undefined;
    if (stagedIndex) index = await putGitArtifact(store, kek, stagedIndex, tmpDir);
    const indexTree = await indexTreeOf(ctx);
    const opState: Record<string, GitArtifactRef> = {};
    for (const { rel, staged } of stagedOp) {
      opState[rel] = await putGitArtifact(store, kek, staged, tmpDir);
    }

    const section: GitSection = {
      bundleSha: bundle.sha,
      bundleEncSha: bundle.encSha,
      bundleCipherSize: bundle.cipherSize,
      head,
      refs,
      indexSha: index?.sha,
      indexEncSha: index?.encSha,
      indexCipherSize: index?.cipherSize,
      indexTree,
      opState: Object.keys(opState).length ? opState : undefined,
      refScope: ctx.kind === "dir" ? "all" : "scoped",
      generatedAt: new Date().toISOString(),
    };
    // Engine self-check (scrutiny M4): a capture race (branch deleted between the HEAD and
    // refs reads by a concurrent git/sibling worktree, or an exotic symbolic-ref outside
    // refs/heads) can assemble a section apply-side validation refuses. Defer this repo —
    // undefined, identical to the empty-repo path; the next cycle re-captures — rather than
    // commit a section every receiver will reject.
    if (!validateGitSection(section).ok) return undefined;
    return section;
  } finally {
    if (pins) await deleteScratchPins(repoDir, pins);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ---- apply (design 43 §7) -------------------------------------------------------

export interface ApplyGitResult {
  applied: boolean;
  reason?: string;
  conflictBundle?: string;
  /** Refs the pointer-target namespace/ownership filter refused to publish
   *  (design 43 §7 [v3/v4]) — surfaced so the caller can log them. */
  filteredRefs?: string[];
}

interface LocalSnapshot {
  refs: Record<string, string>;
  head: string;
  indexBytes?: Buffer;
  opState: Record<string, Buffer>;
  /** Bytes of the refs/stash REFLOG (logs/refs/stash), if present. Publishing
   *  refs/stash appends a reflog entry (--create-reflog) — a rolled-back apply must
   *  not leak remote entries into `git stash list` (codex step-3 MAJOR). */
  stashReflog?: Buffer;
}
async function snapshotLocal(ctx: RepoCtx): Promise<LocalSnapshot> {
  const refs = await readAllRefs(ctx.repoDir);
  const head = (await fs.readFile(path.join(ctx.gitDir, "HEAD"), "utf8").catch(() => "")).trim();
  const indexBytes = (await exists(path.join(ctx.gitDir, "index"))) ? await fs.readFile(path.join(ctx.gitDir, "index")) : undefined;
  const opState: Record<string, Buffer> = {};
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) opState[rel] = await fs.readFile(path.join(ctx.gitDir, rel));
  const stashReflog = await fs.readFile(path.join(ctx.commonDir, "logs", "refs", "stash")).catch(() => undefined);
  return { refs, head, indexBytes, opState, stashReflog };
}
/** Roll back to the pre-apply snapshot. For a POINTER target, `onlyRefs` restricts the
 *  ref restore to exactly the refs the apply touched — a full reset would clobber
 *  concurrent sibling-worktree ref updates in the SHARED store. */
async function restoreLocal(ctx: RepoCtx, snap: LocalSnapshot, onlyRefs?: Set<string>): Promise<void> {
  if (onlyRefs) {
    for (const ref of onlyRefs) {
      const sha = snap.refs[ref];
      if (sha) await git(ctx.repoDir, ["update-ref", ref, sha]).catch(() => {});
      else await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
    }
  } else {
    // Reset syncable refs to the snapshot.
    for (const ref of Object.keys(await readAllRefs(ctx.repoDir))) if (!(ref in snap.refs)) await git(ctx.repoDir, ["update-ref", "-d", ref]).catch(() => {});
    for (const [ref, sha] of Object.entries(snap.refs)) await git(ctx.repoDir, ["update-ref", ref, sha]).catch(() => {});
    // The stash REFLOG must match the snapshot too: the publish appends an entry
    // (--create-reflog) that `git stash list` would still show after a bare ref rollback.
    const stashLog = path.join(ctx.commonDir, "logs", "refs", "stash");
    if (snap.stashReflog) {
      await fs.mkdir(path.dirname(stashLog), { recursive: true }).catch(() => {});
      await writeFileAtomic(stashLog, snap.stashReflog);
    } else {
      await fs.rm(stashLog, { force: true }).catch(() => {});
    }
  }
  if (snap.head) await writeFileAtomic(path.join(ctx.gitDir, "HEAD"), snap.head.endsWith("\n") ? snap.head : `${snap.head}\n`);
  if (snap.indexBytes) await writeFileAtomic(path.join(ctx.gitDir, "index"), snap.indexBytes);
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) if (!(rel in snap.opState)) await fs.rm(path.join(ctx.gitDir, rel), { force: true }).catch(() => {});
  for (const [rel, bytes] of Object.entries(snap.opState)) {
    await fs.mkdir(path.dirname(path.join(ctx.gitDir, rel)), { recursive: true });
    await writeFileAtomic(path.join(ctx.gitDir, rel), bytes);
  }
  await pruneEmptyOpStateDirs(ctx.gitDir, Object.keys(snap.opState));
}

/** Branches (full refnames) checked out by a DIFFERENT worktree of the same store —
 *  `git update-ref refs/heads/x` from one worktree silently moves a branch a sibling
 *  has checked out, leaving that sibling dirty (`git branch -f` refuses; `update-ref`
 *  does not — codex repro, design 43 §7 [v4]). From `git worktree list --porcelain`. */
async function branchesCheckedOutElsewhere(ctx: RepoCtx): Promise<Set<string>> {
  const out = await git(ctx.repoDir, ["worktree", "list", "--porcelain"]).catch(() => "");
  const selfReal = await fs.realpath(ctx.repoDir).catch(() => path.resolve(ctx.repoDir));
  const owned = new Set<string>();
  let wtPath: string | undefined;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) wtPath = line.slice("worktree ".length);
    else if (line.startsWith("branch ") && wtPath) {
      const real = await fs.realpath(wtPath).catch(() => path.resolve(wtPath!));
      if (real !== selfReal) owned.add(line.slice("branch ".length));
    }
  }
  return owned;
}

/** Quarantine the local repo's committed + staged state before a mutating apply —
 *  a bundle with the SAME HEAD/pseudo-ref pinning discipline as capture, PLUS copies
 *  of index/op-state (full recovery, not refs-only — design 43 §9 [v5]). Dir repos
 *  bundle `--all`; pointer repos bundle their scoped line of work (an `--all` bundle
 *  of a big SHARED clone would be huge and isn't ours to quarantine). Throws on
 *  bundle failure — callers fail closed. */
async function quarantineLocal(ctx: RepoCtx, qDir: string, ts: string): Promise<string> {
  await fs.mkdir(qDir, { recursive: true });
  const bundlePath = path.join(qDir, `${ts}.bundle`);
  // Same stale-scratch prune as capture: a legacy exact `refs/rbox-wip` ref D/F-blocks
  // the namespaced pins below and would fail the quarantine (→ spurious apply defer).
  await pruneStaleScratchRefs(ctx.repoDir, WIP_NS);
  const head = await readHead(ctx);
  const pinShas = new Set(await collectPinShas(ctx, head));
  const wip = (await git(ctx.repoDir, ["stash", "create"]).catch(() => "")).trim();
  if (wip) pinShas.add(wip);
  const pins = await createScratchPins(ctx.repoDir, [...pinShas]);
  try {
    const args =
      ctx.kind === "dir"
        ? ["--all", ...pins.refs]
        : [...Object.keys(await readScopedRefs(ctx.repoDir, head)), ...pins.refs];
    await git(ctx.repoDir, ["bundle", "create", bundlePath, ...args]);
  } finally {
    await deleteScratchPins(ctx.repoDir, pins);
  }
  if (await exists(path.join(ctx.gitDir, "index"))) {
    await fs.copyFile(path.join(ctx.gitDir, "index"), path.join(qDir, `${ts}.index`));
  }
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) {
    const dest = path.join(qDir, `${ts}-op`, rel);
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(path.join(ctx.gitDir, rel), dest);
  }
  return bundlePath;
}

/**
 * CLEAN apply (caller guarantees local == base): import objects from the bundle,
 * publish refs/HEAD per the SCOPE-GATED rules below, restore index/op-state — under
 * receiver quiescence, transactionally. On any failure or fsck-fail, ROLL BACK to
 * the pre-apply snapshot. Quarantines local first (fail-closed if that fails).
 *
 * Ref-publish semantics (design 43 §7 [v2, B1; v3; v4]):
 * - deletion of absent local refs happens ONLY when section.refScope === "all" AND the
 *   local repo is a dir-repo (both sides speak "complete set" — design-02 semantics);
 * - a "scoped" section applied into a dir-repo is UPDATE-ONLY (extra local branches survive);
 * - ANY section applied into a local POINTER repo touches a ref store SHARED with sibling
 *   worktrees and the main clone: `refs/stash` + `refs/tags/*` are FILTERED, and
 *   `refs/heads/*` publication is OWNERSHIP-GUARDED via `git worktree list --porcelain` —
 *   a branch checked out by a DIFFERENT worktree is filtered (returned in filteredRefs);
 *   if the section's own HEAD branch is blocked, the WHOLE apply defers
 *   ({applied:false, reason: "ownership-deferred: …"}).
 *
 * NOTE (STEP 3): callers materializing a repo at `join(root, key)` must run
 * {@link assertGitTargetWithinRoot} BEFORE this function and re-verify after `git init`
 * (design 43 §7 [v2, B5; v3]) — this function trusts `repoDir`.
 *
 * `opts.beforeMutate` (design 43 §9 [v5] clean materialization): invoked AFTER every
 * artifact has been fetched+decrypted+verified but BEFORE any gitdir mutation — the
 * caller's quarantine+ref-wipe of a removal-memory leftover runs here, so a missing or
 * corrupt remote artifact can never strand a wiped repo (codex step-3 MAJOR). A hook
 * throw returns {applied:false} with the target untouched.
 */
export async function applyGitState(
  repoDir: string,
  section: GitSection,
  store: BlobStore,
  kek: Buffer,
  opts: { beforeMutate?: () => Promise<void> } = {}
): Promise<ApplyGitResult> {
  const v = validateGitSection(section);
  if (!v.ok) return { applied: false, reason: `invalid git section: ${v.reason}` };

  // Fresh target (no .git): the repo is materialized by `git init` — but only AFTER every
  // artifact has been fetched+decrypted+verified (decrypt-before-mutate: a wrong-KEK apply
  // must leave NO .git behind — codex repro'd the old init-first order doing exactly that).
  // "Fresh" strictly means NO `.git` entry at all: a symlinked `.git` (kind undefined but
  // lstat-present) must be REFUSED, not initialized — `git init` through the symlink would
  // reinitialize the LINKED repo, and the fresh-cleanup would then delete the user's symlink,
  // hijacking the directory on the next cycle (scrutiny M1).
  const preKind = await detectGitKind(repoDir);
  if (!preKind && (await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined))) {
    return { applied: false, reason: ".git is neither a directory nor a gitfile pointer — unsupported apply target" };
  }
  let ctx = preKind ? await repoCtx(repoDir) : undefined;
  if (preKind && !ctx) return { applied: false, reason: "repo unusable (dangling .git pointer?)" };

  // Scope-gated publish set (design 43 §7). A fresh target materializes as a dir repo.
  const publishRefs: Record<string, string> = { ...section.refs };
  const filteredRefs: string[] = [];
  let deleteAbsent = false;
  if (!ctx || ctx.kind === "dir") {
    // Apply refuses the same dir shapes preflight refuses: publishing into a PRIMARY with
    // linked worktrees would move branches its siblings have checked out (codex repro), and
    // superproject/alternates stores have undefined apply semantics (design 43 §4, v1).
    if (ctx) {
      for (const bad of ["worktrees", "modules", "objects/info/alternates"]) {
        if (await exists(path.join(ctx.commonDir, bad))) {
          return { applied: false, reason: `.git/${bad} present — unsupported apply target` };
        }
      }
    }
    deleteAbsent = section.refScope === "all";
  } else {
    for (const ref of Object.keys(publishRefs)) {
      if (!ref.startsWith("refs/heads/")) {
        // a standalone receiver's stash/tags must never overwrite the SHARED stash stack
        // or tag namespace [v3]
        filteredRefs.push(ref);
        delete publishRefs[ref];
      }
    }
    const owned = await branchesCheckedOutElsewhere(ctx);
    for (const ref of Object.keys(publishRefs)) {
      if (owned.has(ref)) {
        filteredRefs.push(ref);
        delete publishRefs[ref];
      }
    }
    const headBranch = headBranchOf(section.head);
    if (headBranch && owned.has(headBranch)) {
      // applying a HEAD that points at a branch we refused to move would be incoherent [v4]
      return { applied: false, reason: `ownership-deferred: ${headBranch} is checked out by another worktree`, filteredRefs };
    }
  }
  if (ctx && (await gitBusy(ctx))) return { applied: false, reason: "receiver git busy" };

  // Stage on the REPO's filesystem (under .rbox), NOT os.tmpdir() — the decrypted index/op-state
  // are moved into the gitdir with rename, which throws EXDEV across mounts. On Linux/containers
  // /tmp is commonly a separate tmpfs from the repo, so an os.tmpdir() staging would fail git
  // apply on every pull (it only worked on macOS because $TMPDIR + the repo share one APFS volume).
  await fs.mkdir(path.join(repoDir, ".rbox"), { recursive: true });
  const tmpDir = await fs.mkdtemp(path.join(repoDir, ".rbox", "gitap-"));
  let createdGit = false;
  // Fail-closed for the fresh path: any failure after `git init` removes the .git WE created
  // this call (nothing of the user's lives in it), restoring the strict no-mutation contract.
  const removeFreshGit = async () => {
    if (createdGit) await fs.rm(path.join(repoDir, ".git"), { recursive: true, force: true }).catch(() => {});
  };
  try {
    // §28 (codex M4): fetch + DECRYPT + verify ALL artifacts into temp files BEFORE touching
    // the gitdir (and before `git init` on a fresh target). A decrypt/fetch/verify failure
    // (wrong key, swapped blob, corruption) returns {applied:false} with the target untouched
    // — never aborts mid-mutation. GCM + the plaintext-sha check in decryptFileToPath
    // authenticate each artifact here.
    const bundlePath = path.join(tmpDir, "in.bundle");
    const indexTmp = section.indexSha ? path.join(tmpDir, "index") : undefined;
    const opTmp: Array<{ rel: string; tmp: string }> = [];
    try {
      await getGitArtifact(store, kek, { sha: section.bundleSha, encSha: section.bundleEncSha, cipherSize: section.bundleCipherSize }, bundlePath, tmpDir);
      if (indexTmp) await getGitArtifact(store, kek, { sha: section.indexSha!, encSha: section.indexEncSha!, cipherSize: section.indexCipherSize! }, indexTmp, tmpDir);
      for (const [rel, ref] of Object.entries(section.opState ?? {})) {
        const tmp = path.join(tmpDir, "op", rel);
        await getGitArtifact(store, kek, ref, tmp, tmpDir);
        opTmp.push({ rel, tmp });
      }
    } catch (e) {
      return { applied: false, reason: `git artifact fetch/decrypt failed (no mutation): ${(e as Error)?.message ?? e}`, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    }

    // GIT-LEVEL bundle verification BEFORE any mutation when a repo already exists at
    // the target: decrypt + plaintext-sha authenticate the BYTES, not their bundle-ness
    // — a sha-valid non-bundle would otherwise pass to `beforeMutate`, wipe a clean-
    // materialization leftover, and only then fail `bundle verify` (codex step-3
    // round-2 repro). Our bundles are self-contained (no prerequisites), so verifying
    // against the pre-existing repo is equivalent to the post-init verify below, which
    // stays as the fresh-target gate (nothing exists to verify against before init).
    let bundleVerified = false;
    if (ctx) {
      if (!(await gitOk(repoDir, ["bundle", "verify", bundlePath]))) {
        return { applied: false, reason: "bundle verify failed (no mutation)", filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
      bundleVerified = true;
    }

    // Artifacts are decrypt-verified on disk and the bundle is git-verified — the
    // caller's pre-mutation step (quarantine + ref-wipe for a clean materialization)
    // may now run. Failure → no mutation yet, defer cleanly.
    if (opts.beforeMutate) {
      try {
        await opts.beforeMutate();
      } catch (e) {
        return { applied: false, reason: `pre-mutation step failed (no apply): ${(e as Error)?.message ?? e}`, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
    }

    if (!ctx) {
      // TOCTOU recheck (scrutiny M2): the artifact download above can take a long time on a
      // big bundle. If a repo APPEARED at repoDir in that window (user ran git init/clone —
      // this is a live-folder daemon), `git init` would "reinitialize" IT and createdGit
      // would claim a .git this call did NOT create — every later failure path would then
      // rm -rf the USER's .git. Absence must be re-confirmed immediately before init.
      if (await fs.lstat(path.join(repoDir, ".git")).catch(() => undefined)) {
        return { applied: false, reason: "target repo appeared mid-apply — deferred" };
      }
      // fresh machine / standalone materialization of a worktree-origin section (design 43 §5)
      await git(repoDir, ["init", "-q"]);
      createdGit = true;
      ctx = await repoCtx(repoDir);
      if (!ctx) {
        await removeFreshGit();
        return { applied: false, reason: "git init failed for fresh apply target" };
      }
    }

    const hadHead = await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"]);
    const snap = await snapshotLocal(ctx);

    // Fresh targets verify here (a repo now exists); existing targets verified above —
    // don't pay the full bundle read twice.
    if (!bundleVerified && !(await gitOk(repoDir, ["bundle", "verify", bundlePath]))) {
      await removeFreshGit();
      return { applied: false, reason: "bundle verify failed", filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    }

    // Quarantine local committed+staged state first — fail closed if we can't (§9 [v5]:
    // bundle with capture-grade pinning PLUS index/op-state copies).
    let conflictBundle: string | undefined;
    if (hadHead) {
      try {
        conflictBundle = await quarantineLocal(ctx, path.join(repoDir, ".rbox", "git-quarantine"), `${Date.now()}`);
      } catch (e) {
        return { applied: false, reason: `quarantine bundle failed; aborting: ${(e as Error)?.message ?? e}`, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
    }

    // Import objects from the (decrypted, verified) remote bundle into a non-checked-out,
    // APPLY-UNIQUE namespace (pointer targets share the ref store with sibling worktrees —
    // a fixed namespace would race concurrent sibling applies, same hazard as rbox-wip).
    await pruneStaleScratchRefs(repoDir, "refs/rbox-incoming");
    const incomingNs = `refs/rbox-incoming/${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
    try {
      // --no-tags: fetch's tag-following would otherwise write the bundle's refs/tags/* DIRECTLY
      // into refs/tags (outside the namespace refspec) — on a pointer target that is the shared
      // tag store the §7 filter exists to protect. Tags still publish on dir targets via the
      // explicit update-ref loop below (they're in section.refs).
      await git(repoDir, ["fetch", "--no-tags", bundlePath, `refs/*:${incomingNs}/*`], { maxBuffer: 64 * 1024 * 1024 });
    } catch (e) {
      // Nothing published yet — refs/HEAD/index are untouched; only namespaced scratch may exist.
      for (const ref of await listRefs(repoDir, incomingNs)) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
      await removeFreshGit();
      return { applied: false, reason: `bundle fetch failed (no publish): ${(e as Error)?.message ?? e}`, conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    }

    try {
      // Publish refs per the scope-gated rules (see doc comment).
      for (const [ref, sha] of Object.entries(publishRefs)) {
        if (ref === "refs/stash") {
          // refs/stash is only usable through its REFLOG (`git stash list`/`pop` read
          // stash@{N}, never the bare ref) — publish it WITH a reflog entry whose
          // message is the stash commit's subject (`git stash` writes the same text to
          // both), so the synced stash is listable/poppable on the receiver.
          const subject = (await git(repoDir, ["log", "-1", "--format=%s", sha]).catch(() => "")) || "rbox: synced stash";
          await git(repoDir, ["update-ref", "--create-reflog", "-m", subject, ref, sha]);
        } else {
          await git(repoDir, ["update-ref", ref, sha]);
        }
      }
      if (deleteAbsent) {
        for (const ref of Object.keys(await readAllRefs(repoDir))) {
          if (!(ref in section.refs)) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
        }
      }
      await writeFileAtomic(path.join(ctx.gitDir, "HEAD"), section.head.endsWith("\n") ? section.head : `${section.head}\n`);

      // Restore index + op-state from the pre-decrypted temp files via atomic rename —
      // into the RESOLVED gitdir.
      if (indexTmp) await moveFileAtomic(indexTmp, path.join(ctx.gitDir, "index"));
      await restoreOpState(ctx.gitDir, opTmp);

      if (!(await gitOk(repoDir, ["fsck", "--connectivity-only", "--no-dangling"]))) {
        // ROLLBACK (fresh target: removing the .git we created IS the rollback)
        if (createdGit) await removeFreshGit();
        else await restoreLocal(ctx, snap, ctx.kind === "pointer" ? new Set(Object.keys(publishRefs)) : undefined);
        return { applied: false, reason: "post-apply fsck failed — rolled back", conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
      }
    } catch (e) {
      // ROLLBACK on any mutation error (fresh target: remove the .git we created)
      if (createdGit) await removeFreshGit();
      else await restoreLocal(ctx, snap, ctx.kind === "pointer" ? new Set(Object.keys(publishRefs)) : undefined).catch(() => {});
      return { applied: false, reason: `apply failed — rolled back: ${(e as Error)?.message ?? e}`, conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
    } finally {
      for (const ref of await listRefs(repoDir, incomingNs)) await git(repoDir, ["update-ref", "-d", ref]).catch(() => {});
    }
    return { applied: true, conflictBundle, filteredRefs: filteredRefs.length ? filteredRefs : undefined };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Receiver quiescence probe (design 43 §7): is the repo mid-operation (index/HEAD
 * lock, gc, ref locks in the shared store)? Checked per repo BEFORE the pull-side
 * divergence comparison — a lock makes `write-tree` fail, which flips gitIdentity
 * onto the raw-index fallback and would otherwise read as false divergence (a
 * spurious CONFLICT where the design demands "a busy repo defers only itself").
 * A repo with no usable context is not busy (there is nothing to contend with).
 */
export async function isGitBusy(repoDir: string): Promise<boolean> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) return false;
  return gitBusy(ctx);
}

/**
 * Design 43 §9 [v5] — the DIR-leftover half of a CLEAN MATERIALIZATION (fresh re-create
 * at a removed path): quarantine the local repo first (a bundle with the SAME
 * HEAD/pseudo-ref pinning discipline as capture, PLUS index/op-state copies — full
 * recovery, not refs-only), then DELETE its syncable refs + index + op-state (reset to
 * empty). A following {@link applyGitState} then lands on a clean target, so the
 * leftover's old refs can never re-enter a later all-scope capture (resurrection
 * through the side door — codex round-4 BLOCKER). DIR repos only: a pointer repo's
 * refs live in the SHARED main-clone store and must never be wiped — pointer leftovers
 * go through the guarded update-only apply instead. Throws when the quarantine fails
 * (callers defer the apply — fail closed, never wipe unquarantined state).
 */
export async function quarantineAndWipeGitState(repoDir: string): Promise<{ quarantineBundle?: string }> {
  const ctx = await repoCtx(repoDir);
  if (!ctx) throw new Error("repo unusable — cannot quarantine for clean materialization");
  if (ctx.kind !== "dir") throw new Error("refusing to ref-wipe a pointer repo (shared ref store)");
  let quarantineBundle: string | undefined;
  if (await gitOk(repoDir, ["rev-parse", "--verify", "HEAD"])) {
    quarantineBundle = await quarantineLocal(ctx, path.join(repoDir, ".rbox", "git-quarantine"), `${Date.now()}`);
  }
  for (const ref of Object.keys(await readAllRefs(repoDir))) {
    await git(repoDir, ["update-ref", "-d", ref]);
  }
  await fs.rm(path.join(ctx.gitDir, "index"), { force: true });
  for (const rel of Object.keys(await readOpState(ctx.gitDir, async () => ""))) {
    await fs.rm(path.join(ctx.gitDir, rel), { force: true }).catch(() => {});
  }
  await pruneEmptyOpStateDirs(ctx.gitDir, []);
  return { quarantineBundle };
}

/**
 * CONFLICT preserve (both sides diverged): do NOT clobber local. Import the remote
 * refs into a recovery namespace and bundle, so the user can merge manually.
 */
export async function preserveGitConflict(repoDir: string, section: GitSection, store: BlobStore, kek: Buffer): Promise<{ recoveryBundle?: string }> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitcf-"));
  try {
    const bundlePath = path.join(tmpDir, "remote.bundle");
    await getGitArtifact(store, kek, { sha: section.bundleSha, encSha: section.bundleEncSha, cipherSize: section.bundleCipherSize }, bundlePath, tmpDir);
    if (!(await gitOk(repoDir, ["bundle", "verify", bundlePath]))) return {};
    const ts = `${Date.now()}`;
    // --no-tags: tag-following would write remote tags DIRECTLY into refs/tags, outside the
    // recovery namespace — a silent local mutation the conflict flow must never make.
    await git(repoDir, ["fetch", "--no-tags", bundlePath, `refs/*:refs/rbox-conflict/${ts}/*`], { maxBuffer: 64 * 1024 * 1024 }).catch(() => {});
    const recDir = path.join(repoDir, ".rbox", "git-conflicts");
    await fs.mkdir(recDir, { recursive: true });
    const recoveryBundle = path.join(recDir, `remote-${ts}.bundle`);
    await fs.copyFile(bundlePath, recoveryBundle).catch(() => {});
    return { recoveryBundle };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ---- apply-target containment (design 43 §7 [v2, B5; v3]) ------------------------

/**
 * Refuse a git materialization/apply target that escapes the workspace root. Every
 * EXISTING path component from root → target is lstat-checked (no symlink components —
 * a symlinked parent smuggled via the file manifest must not redirect a repo
 * materialization outside the workspace), and the deepest existing prefix's realpath
 * must stay inside the root's realpath. Callers re-run this immediately after
 * `git init` (cheap belt-and-braces re-verify); a *local*-attacker race between check
 * and init is explicitly out of the threat model. Throws on violation; returns the
 * absolute target path (`root` itself for relPath "."). Exported for STEP 3.
 */
export async function assertGitTargetWithinRoot(root: string, relPath: string): Promise<string> {
  const rootReal = await fs.realpath(root);
  if (relPath === ".") return root;
  const abs = path.join(root, relPath);
  let probe = root;
  for (const seg of relPath.split("/")) {
    probe = path.join(probe, seg);
    let st;
    try {
      st = await fs.lstat(probe);
    } catch {
      break; // rest doesn't exist yet — it will be created under the verified prefix
    }
    if (st.isSymbolicLink()) throw new Error(`git apply target has a symlink component: ${probe}`);
  }
  // Belt-and-braces: realpath of the deepest existing prefix must stay inside the root.
  let existing = abs;
  for (;;) {
    try {
      const real = await fs.realpath(existing);
      if (real !== rootReal && !real.startsWith(rootReal + path.sep)) {
        throw new Error(`git apply target escapes workspace root: ${abs}`);
      }
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      existing = parent;
    }
  }
  return abs;
}

// ---- helpers --------------------------------------------------------------

async function readAllRefs(repoDir: string): Promise<Record<string, string>> {
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
async function readScopedRefs(repoDir: string, head: string): Promise<Record<string, string>> {
  const branch = headBranchOf(head);
  if (!branch) return {};
  const sha = await git(repoDir, ["rev-parse", "--verify", "--quiet", branch]).catch(() => "");
  return sha && HEX40.test(sha) ? { [branch]: sha } : {};
}

async function listRefs(repoDir: string, prefix: string): Promise<string[]> {
  const out = await git(repoDir, ["for-each-ref", "--format=%(refname)", prefix]).catch(() => "");
  return out.split("\n").filter(Boolean);
}

/** Enumerate/hash op-state under the RESOLVED gitdir (pointer repos: per-worktree state —
 *  exactly what makes "continue the rebase on the other machine" work). */
async function readOpState(gitDir: string, hash: (absPath: string) => Promise<string>): Promise<Record<string, string>> {
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

async function restoreOpState(gitDir: string, opTmp: Array<{ rel: string; tmp: string }>): Promise<void> {
  // Remove any op-state the sender no longer has (completed operation).
  const want = new Set(opTmp.map((o) => o.rel));
  const existing = await readOpState(gitDir, async () => "");
  for (const rel of Object.keys(existing)) {
    if (!want.has(rel)) await fs.rm(path.join(gitDir, rel), { force: true }).catch(() => {});
  }
  // Atomic-rename each PRE-DECRYPTED temp into place (decryption already happened + verified
  // before any mutation, §28 codex M4) — never a torn or plaintext-less live file.
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
async function pruneEmptyOpStateDirs(gitDir: string, keepRels: Iterable<string>): Promise<void> {
  const keep = new Set<string>();
  for (const rel of keepRels) {
    const top = rel.split("/")[0]!;
    if (rel.includes("/")) keep.add(top);
  }
  for (const d of OP_STATE_DIRS) {
    if (!keep.has(d)) await fs.rm(path.join(gitDir, d), { recursive: true, force: true }).catch(() => {});
  }
}

/** rename, with an EXDEV fallback (copy to a temp in the DEST dir, then rename) — a
 *  pointer repo's resolved gitdir (the main clone) may live on a different mount than
 *  the worktree where the apply staged its temp files. */
async function moveFileAtomic(src: string, dest: string): Promise<void> {
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

async function gitBusy(ctx: RepoCtx): Promise<boolean> {
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

/** §28: ENCRYPT a staged plaintext artifact under the workspace KEK, upload the CIPHERTEXT by
 *  its encSha (convergent — same primitive + receipt-capturing store path as file blobs), and
 *  return the (plaintext sha, encSha, cipherSize) ref. Skips the upload if the account already
 *  has the ciphertext blob (entitled+present). The temp ciphertext is always cleaned up. */
async function putGitArtifact(store: BlobStore, kek: Buffer, srcPath: string, tmpDir: string): Promise<GitArtifactRef> {
  const enc = await encryptFileToTemp(srcPath, kek, tmpDir);
  try {
    if (!(await store.has(enc.encSha))) {
      if (store.putFile) await store.putFile(enc.encSha, enc.ciphertextPath, enc.cipherSize);
      else await store.put(enc.encSha, await fs.readFile(enc.ciphertextPath));
    }
  } finally {
    await fs.rm(enc.ciphertextPath, { force: true });
  }
  return { sha: enc.plaintextSha, encSha: enc.encSha, cipherSize: enc.cipherSize };
}

async function getBlobToFile(store: BlobStore, sha: string, destPath: string): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  if (store.getToFile) await store.getToFile(sha, destPath);
  else await fs.writeFile(destPath, await store.get(sha));
}

/** §28: fetch a git artifact's CIPHERTEXT by encSha, then decrypt+verify (GCM tag + plaintext-sha)
 *  to `destPath`. Throws on any fetch/decrypt/verify failure — callers run this into temp files
 *  BEFORE mutating the gitdir (codex M4), so a bad/ swapped/ corrupt blob never half-applies. */
async function getGitArtifact(store: BlobStore, kek: Buffer, ref: GitArtifactRef, destPath: string, tmpDir: string): Promise<void> {
  const ct = path.join(tmpDir, `ct-${ref.encSha}`);
  await getBlobToFile(store, ref.encSha, ct);
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await decryptFileToPath(ct, kek, ref.sha, destPath);
  await fs.rm(ct, { force: true });
}
