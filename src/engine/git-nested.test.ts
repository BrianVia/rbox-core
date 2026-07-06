import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyGitState,
  assertGitTargetWithinRoot,
  buildIgnoreMatcher,
  captureGitState,
  decideDirBundleAllArgs,
  discoverGitRepos,
  encryptFileToTemp,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  inTreeWorktreeParentRel,
  projectIdentity,
  quarantineAndWipeGitState,
  validateManifest,
  LocalBlobStore,
  MAX_GIT_REPOS,
  type FileEntry,
  type GitSection,
} from "./index.js";

const exec = promisify(execFile);
const git = (root: string, ...args: string[]) => exec("git", ["-C", root, ...args]).then((r) => r.stdout.toString().trim());
const KEK = Buffer.alloc(32, 7);

let tmp: string;
let store: LocalBlobStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-g43-"));
  store = new LocalBlobStore(path.join(tmp, "store"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "t");
}
async function commit(dir: string, file: string, content: string, msg: string) {
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, "add", file);
  await git(dir, "commit", "-qm", msg);
}

/** Main clone + a real linked worktree; defaults keep the original out-of-root shape. */
async function makeMainWithWorktree(opts: { main?: string; worktree?: string; branch?: string } = {}): Promise<{ M: string; W: string }> {
  const M = opts.main ?? path.join(tmp, "main");
  const W = opts.worktree ?? path.join(tmp, "root", "wt");
  const branch = opts.branch ?? "feat";
  await initRepo(M);
  await commit(M, "f.txt", "base", "c1");
  await fs.mkdir(path.dirname(W), { recursive: true });
  await git(M, "worktree", "add", W, "-b", branch);
  return { M, W };
}

// ---- discovery (design 43 §3) ----------------------------------------------

test("discoverGitRepos finds nested repos + pointers, prunes ignored subtrees, sorts", async () => {
  const root = path.join(tmp, "root");
  await initRepo(root); // the sync root itself is a repo → "."
  await initRepo(path.join(root, "a"));
  await initRepo(path.join(root, "a", "vendor")); // repo inside another repo's working tree — still discovered
  await initRepo(path.join(root, "b", "c"));
  await initRepo(path.join(root, "node_modules", "dep")); // under a builtin-ignored dir → NOT discovered
  await initRepo(path.join(root, "skipme", "x")); // under a .rboxignore'd dir → NOT discovered
  await fs.writeFile(path.join(root, ".rboxignore"), "skipme/\n");
  await fs.mkdir(path.join(root, "wt"), { recursive: true });
  await fs.writeFile(path.join(root, "wt", ".git"), "gitdir: /nowhere/at/all\n"); // gitfile pointer

  const found = await discoverGitRepos(root, buildIgnoreMatcher(root));
  expect(found).toEqual([
    { relPath: ".", kind: "dir" },
    { relPath: "a", kind: "dir" },
    { relPath: "a/vendor", kind: "dir" },
    { relPath: "b/c", kind: "dir" },
    { relPath: "wt", kind: "pointer" },
  ]);
});

// ---- preflight matrix (design 43 §4) -----------------------------------------

test("preflight: ordinary dir repo ok (kind dir); real worktree ok (kind pointer)", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  expect(await gitPreflight(A)).toEqual({ ok: true, kind: "dir" });

  const { W } = await makeMainWithWorktree();
  expect(await gitPreflight(W)).toEqual({ ok: true, kind: "pointer" });
});

test("preflight refusals: no .git, dangling pointer, bare, alternates (both kinds), modules, toplevel mismatch", async () => {
  // no .git
  const plain = path.join(tmp, "plain");
  await fs.mkdir(plain);
  expect((await gitPreflight(plain)).ok).toBe(false);

  // dangling pointer (main clone deleted — the Conductor incident): clean {ok:false}, no throw
  const dangling = path.join(tmp, "dangling");
  await fs.mkdir(dangling);
  await fs.writeFile(path.join(dangling, ".git"), "gitdir: /nonexistent/clone/.git/worktrees/x\n");
  const dp = await gitPreflight(dangling);
  expect(dp.ok).toBe(false);
  expect(dp.kind).toBe("pointer");

  // bare `.git`
  const bare = path.join(tmp, "bare");
  await fs.mkdir(bare);
  await exec("git", ["init", "-q", "--bare", path.join(bare, ".git")]);
  expect((await gitPreflight(bare)).ok).toBe(false);

  // alternates on a dir repo
  const alt = path.join(tmp, "alt");
  await initRepo(alt);
  await commit(alt, "f.txt", "x", "c1");
  await fs.writeFile(path.join(alt, ".git", "objects", "info", "alternates"), "/somewhere/objects\n");
  const ar = await gitPreflight(alt);
  expect(ar.ok).toBe(false);
  expect(ar.reason).toContain("alternates");

  // alternates on a pointer repo's RESOLVED object store (the main clone's)
  const { M, W } = await makeMainWithWorktree();
  await fs.writeFile(path.join(M, ".git", "objects", "info", "alternates"), "/somewhere/objects\n");
  const wr = await gitPreflight(W);
  expect(wr.ok).toBe(false);
  expect(wr.reason).toContain("alternates");
  await fs.rm(path.join(M, ".git", "objects", "info", "alternates"));

  // design 68 §3.1: a PRIMARY with linked worktrees is now ELIGIBLE (was refused in v1)
  expect(await gitPreflight(M)).toEqual({ ok: true, kind: "dir" });

  // .git/modules (submodule superproject) stays refused (v1 [v2, M1])
  const sup = path.join(tmp, "sup");
  await initRepo(sup);
  await commit(sup, "f.txt", "x", "c1");
  await fs.mkdir(path.join(sup, ".git", "modules"));
  expect((await gitPreflight(sup)).reason).toContain("modules");

  // toplevel mismatch: core.worktree pointing above the repo dir — git resolves the
  // toplevel to the parent, so `repoDir` is not the repo's root
  const V = path.join(tmp, "vparent", "v");
  await initRepo(V);
  await commit(V, "f.txt", "x", "c1");
  await git(V, "config", "core.worktree", "../.."); // relative to the .git dir → vparent
  const vr = await gitPreflight(V);
  expect(vr.ok).toBe(false);
  expect(vr.reason).toContain("toplevel");
});

// ---- worktree round-trip (design 43 §5) ---------------------------------------

test("worktree capture is SCOPED (branch only, never the shared stash) and applies as a standalone repo", async () => {
  const { M, W } = await makeMainWithWorktree();
  // a stash in the SHARED gitdir must never ride a pointer capture
  await fs.writeFile(path.join(M, "f.txt"), "dirty-main");
  await git(M, "stash", "-q");
  expect(await git(M, "rev-parse", "--verify", "refs/stash")).toBeTruthy();
  // work in the worktree: a commit on feat + a staged file
  await commit(W, "w.txt", "wt-work", "wt c1");
  await fs.writeFile(path.join(W, "staged.txt"), "staged");
  await git(W, "add", "staged.txt");

  const section = await captureGitState(W, store, KEK);
  expect(section).toBeDefined();
  expect(section!.refScope).toBe("scoped");
  expect(Object.keys(section!.refs)).toEqual(["refs/heads/feat"]); // no refs/stash, no main
  expect(section!.head).toBe("ref: refs/heads/feat");

  // materializes as a full STANDALONE repo on the receiving side
  const D = path.join(tmp, "D");
  const res = await applyGitState(D, section!, store, KEK);
  expect(res.applied).toBe(true);
  expect((await fs.lstat(path.join(D, ".git"))).isDirectory()).toBe(true); // real .git dir, not a pointer
  expect(await git(D, "symbolic-ref", "HEAD")).toBe("refs/heads/feat");
  expect(await git(D, "rev-parse", "feat")).toBe(await git(W, "rev-parse", "feat"));
  expect((await git(D, "branch", "--format=%(refname:short)")).split("\n")).toEqual(["feat"]); // main did NOT leak in
  expect(await git(D, "diff", "--cached", "--name-only")).toBe("staged.txt"); // staged state restored
  await expect(git(D, "rev-parse", "--verify", "refs/stash")).rejects.toThrow(); // shared stash filtered at capture
  await expect(git(D, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
});

// ---- pseudo-ref pinning (design 43 §5 [v2, B3]) -------------------------------

test("mid-merge MERGE_HEAD from an UNBUNDLED branch survives a scoped round-trip (object-closure pin)", async () => {
  const { M, W } = await makeMainWithWorktree();
  // branch `other` diverges from base with a conflicting change — NOT part of feat's line of work
  await git(M, "branch", "other");
  await git(M, "checkout", "-q", "other");
  await commit(M, "f.txt", "other-change", "other c1");
  await git(M, "checkout", "-q", "main");
  // conflicting change on feat, then merge other → conflict, MERGE_HEAD set (per-worktree)
  await commit(W, "f.txt", "feat-change", "feat c1");
  await expect(git(W, "merge", "other")).rejects.toThrow(); // conflict
  const otherSha = await git(M, "rev-parse", "other");
  const wGitDir = await git(W, "rev-parse", "--absolute-git-dir");
  expect((await fs.readFile(path.join(wGitDir, "MERGE_HEAD"), "utf8")).trim()).toBe(otherSha);

  const section = await captureGitState(W, store, KEK);
  expect(section).toBeDefined();
  expect(Object.keys(section!.opState ?? {})).toContain("MERGE_HEAD");
  // §6.6 [v2, M3]: write-tree fails on the unmerged index → raw-index identity fallback
  expect(section!.indexTree?.startsWith("raw:")).toBe(true);

  const D = path.join(tmp, "D");
  const res = await applyGitState(D, section!, store, KEK);
  expect(res.applied).toBe(true);
  // MERGE_HEAD restored AND its commit object actually exists (this is what the pin buys —
  // codex repro'd `bundle create HEAD refs/heads/x` omitting a MERGE_HEAD commit)
  expect((await fs.readFile(path.join(D, ".git", "MERGE_HEAD"), "utf8")).trim()).toBe(otherSha);
  await expect(git(D, "cat-file", "-e", `${otherSha}^{commit}`)).resolves.toBeDefined();
  // AUTO_MERGE (ort, git >= 2.38): the file restores AND its TREE object rides the pin —
  // without it `git diff AUTO_MERGE` on the receiver dies with "bad object" (codex repro)
  if (section!.opState && "AUTO_MERGE" in section!.opState) {
    const autoTree = (await fs.readFile(path.join(D, ".git", "AUTO_MERGE"), "utf8")).trim();
    await expect(git(D, "cat-file", "-e", `${autoTree}^{tree}`)).resolves.toBeDefined();
  }
  await expect(git(D, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
});

test("unmerged-index identity fallback is stable in the window and clears on resolution", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "base", "c1");
  await git(A, "checkout", "-qb", "side");
  await commit(A, "f.txt", "side-change", "side c1");
  await git(A, "checkout", "-q", "main");
  await commit(A, "f.txt", "main-change", "main c2");
  await expect(git(A, "merge", "side")).rejects.toThrow(); // conflict → unmerged index

  const id1 = await gitIdentity(A);
  const id2 = await gitIdentity(A);
  expect(id1!.indexTree?.startsWith("raw:")).toBe(true);
  expect(gitIdentityKey(id1)).toBe(gitIdentityKey(id2)); // no git ops between → stable, no echo

  await git(A, "checkout", "--theirs", "f.txt");
  await git(A, "add", "f.txt"); // staged resolution progress MUST change the identity
  const id3 = await gitIdentity(A);
  expect(gitIdentityKey(id3)).not.toBe(gitIdentityKey(id1));
  expect(/^[0-9a-f]{40}$/.test(id3!.indexTree ?? "")).toBe(true); // write-tree works again
});

// ---- scope-gated ref publish + ownership guard (design 43 §7 [v2,B1; v3; v4]) ---

test("scope-gated deletion matrix: all→dir deletes absent refs; scoped→dir is update-only", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "v1", "c1");
  const all = await captureGitState(A, store, KEK);
  expect(all!.refScope).toBe("all");

  // all→dir: both sides speak "complete set" → absent local refs are deleted (design-02 semantics)
  const B = path.join(tmp, "B");
  await initRepo(B);
  await commit(B, "own.txt", "own", "b1");
  await git(B, "branch", "junk");
  const r1 = await applyGitState(B, all!, store, KEK);
  expect(r1.applied).toBe(true);
  expect(r1.conflictBundle).toBeTruthy(); // local committed state was quarantined first
  expect((await git(B, "branch", "--format=%(refname:short)")).split("\n").sort()).toEqual(["main"]);
  expect(await git(B, "rev-parse", "main")).toBe(await git(A, "rev-parse", "main"));
  // §9 [v5]: quarantine is full recovery — the bundle is accompanied by an index copy
  expect(await fs.readFile(r1.conflictBundle!.replace(/\.bundle$/, ".index"))).toBeDefined();

  // scoped→dir: update-only — a standalone receiver's extra local branches SURVIVE
  const { W } = await makeMainWithWorktree();
  await commit(W, "w.txt", "wt", "wt c1");
  const scoped = await captureGitState(W, store, KEK);
  expect(scoped!.refScope).toBe("scoped");
  const C = path.join(tmp, "C");
  await initRepo(C);
  await commit(C, "own.txt", "own", "c1");
  const cMain = await git(C, "rev-parse", "main");
  const r2 = await applyGitState(C, scoped!, store, KEK);
  expect(r2.applied).toBe(true);
  expect((await git(C, "branch", "--format=%(refname:short)")).split("\n").sort()).toEqual(["feat", "main"]);
  expect(await git(C, "rev-parse", "main")).toBe(cMain); // untouched
  expect(await git(C, "rev-parse", "feat")).toBe(await git(W, "rev-parse", "feat"));
  expect(await git(C, "symbolic-ref", "HEAD")).toBe("refs/heads/feat");
});

test("apply into a POINTER repo filters stash/tags, ownership-guards sibling branches, defers on blocked HEAD", async () => {
  const { M, W } = await makeMainWithWorktree();
  await git(M, "branch", "keepme"); // shared branch not in the incoming section — must survive
  await commit(W, "w.txt", "wt", "wt c1");

  // Build a standalone "all"-scope sender D from W's scoped section (the §5 round-trip shape)
  const D = path.join(tmp, "D");
  expect((await applyGitState(D, (await captureGitState(W, store, KEK))!, store, KEK)).applied).toBe(true);
  await git(D, "config", "user.email", "t@t.t");
  await git(D, "config", "user.name", "t");
  await git(D, "checkout", "-qf", "feat");
  await commit(D, "d.txt", "new-on-D", "d c1"); // feat advances on D
  await git(D, "branch", "-f", "main"); // D also has `main` — checked out by M on the other side
  await git(D, "tag", "v1");
  const allFromD = await captureGitState(D, store, KEK);
  expect(allFromD!.refScope).toBe("all");
  expect(Object.keys(allFromD!.refs).sort()).toEqual(["refs/heads/feat", "refs/heads/main", "refs/tags/v1"]);

  const mMainBefore = await git(M, "rev-parse", "main");
  const res = await applyGitState(W, allFromD!, store, KEK);
  expect(res.applied).toBe(true);
  // refs/tags/* filtered (shared namespace) + refs/heads/main filtered (checked out by main clone)
  expect(res.filteredRefs?.sort()).toEqual(["refs/heads/main", "refs/tags/v1"]);
  expect(await git(M, "rev-parse", "main")).toBe(mMainBefore); // sibling's checked-out branch NOT moved
  expect(await git(M, "tag", "-l", "v1")).toBe(""); // tag never written to the shared store
  expect(await git(M, "rev-parse", "--verify", "keepme")).toBeTruthy(); // no deletion on pointer targets, even from an "all" section
  expect(await git(W, "rev-parse", "feat")).toBe(await git(D, "rev-parse", "feat")); // own line of work updated

  // HEAD-branch blocked → the WHOLE apply defers [v4]
  await git(D, "checkout", "-q", "main");
  const headBlocked = await captureGitState(D, store, KEK);
  expect(headBlocked!.head).toBe("ref: refs/heads/main");
  const res2 = await applyGitState(W, headBlocked!, store, KEK);
  expect(res2.applied).toBe(false);
  expect(res2.reason).toContain("ownership-deferred");
});

// ---- apply fail-closed + shape refusals (codex round-1 fixes) -------------------

test("wrong-KEK apply into a FRESH target leaves NO .git behind (decrypt before init)", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK);

  const D = path.join(tmp, "D"); // does not exist at all
  const res = await applyGitState(D, section!, store, Buffer.alloc(32, 99)); // WRONG key
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("no mutation");
  // NB: D/ + an empty hard-ignored D/.rbox/ MAY exist (staging happens pre-decrypt by
  // design); the fail-closed contract is about `.git` — no repo may be materialized.
  expect(await fs.lstat(path.join(D, ".git")).catch(() => undefined)).toBeUndefined(); // nothing materialized
}, 20_000); // many live-git ops — the 5s default flakes under full-suite load

test("apply refuses a SYMLINKED .git target (never inits through it, never deletes the link)", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK);

  // real repo R elsewhere; target T whose .git is a symlink to R's gitdir
  const R = path.join(tmp, "R");
  await initRepo(R);
  await commit(R, "r.txt", "r", "r1");
  const rHead = await git(R, "rev-parse", "HEAD");
  const T = path.join(tmp, "T");
  await fs.mkdir(T);
  await fs.symlink(path.join(R, ".git"), path.join(T, ".git"));

  const res = await applyGitState(T, section!, store, KEK);
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("unsupported");
  expect((await fs.lstat(path.join(T, ".git"))).isSymbolicLink()).toBe(true); // link survives
  expect(await git(R, "rev-parse", "HEAD")).toBe(rHead); // linked repo untouched
});

test("a repo APPEARING at a fresh target during artifact download defers — its .git is never claimed", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK);

  const D = path.join(tmp, "D");
  // Simulate the mid-apply race deterministically: the FIRST blob fetch creates a real
  // repo at D (as a user's `git init` + commit would), then delegates to the real store.
  let raced = false;
  const racingStore = {
    has: (sha: string) => store.has(sha),
    put: (sha: string, data: Buffer) => store.put(sha, data),
    get: async (sha: string) => {
      if (!raced) {
        raced = true;
        await initRepo(D);
        await commit(D, "user.txt", "user work", "user c1");
      }
      return store.get(sha);
    },
  };

  const res = await applyGitState(D, section!, racingStore, KEK);
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("appeared mid-apply");
  // the user's repo is fully intact — createdGit was never asserted over it
  expect(await fs.lstat(path.join(D, ".git")).then((s) => s.isDirectory())).toBe(true);
  await expect(git(D, "rev-parse", "HEAD")).resolves.toBeTruthy();
  expect(await fs.readFile(path.join(D, "user.txt"), "utf8")).toBe("user work");
});

test("design 68 §3.2: apply into a primary with linked worktrees DEFERS on a checked-out-branch collision, then applies once the worktree is removed (V10, V3)", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK); // all-scope {refs/heads/main}

  const { M } = await makeMainWithWorktree({ main: path.join(tmp, "prim"), worktree: path.join(tmp, "prim-wt"), branch: "sibling" });
  const siblingSha = await git(M, "rev-parse", "sibling");
  const mMain = await git(M, "rev-parse", "main");

  // The all-scope apply would DELETE `sibling` (absent from the section) — but prim-wt has it
  // checked out, so `update-ref -d` would strand that worktree. Whole-section defer, no mutation.
  const res = await applyGitState(M, section!, store, KEK);
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("linked worktree");
  expect(res.reason).toContain("sibling");
  expect(await git(M, "rev-parse", "sibling")).toBe(siblingSha); // untouched
  expect(await git(M, "rev-parse", "main")).toBe(mMain); // no partial application

  // Remove the worktree → the checked-out set clears → the section applies next cycle (V3).
  await git(M, "worktree", "remove", "--force", path.join(tmp, "prim-wt"));
  const res2 = await applyGitState(M, section!, store, KEK);
  expect(res2.applied).toBe(true);
  expect(await git(M, "rev-parse", "main")).toBe(await git(A, "rev-parse", "main"));
  await expect(git(M, "rev-parse", "--verify", "sibling")).rejects.toThrow(); // now safely deleted
});

// ---- design 68: main-clone-with-worktrees capture (§3.1) ------------------------

test("design 68 §3.1: dir bundle args fall back on ancient git only when no live linked worktree depends on --single-worktree", () => {
  expect(decideDirBundleAllArgs(true, false)).toEqual({ ok: true, args: ["--single-worktree", "--all"] });
  expect(decideDirBundleAllArgs(true, true)).toEqual({ ok: true, args: ["--single-worktree", "--all"] });
  expect(decideDirBundleAllArgs(false, false)).toEqual({ ok: true, args: ["--all"] });
  expect(decideDirBundleAllArgs(false, true)).toEqual({ ok: false, reason: "git >= 2.15 required for worktree-aware capture" });
});

test("design 68 §3.1 V1/V4: main clone with 2 linked worktrees captures --single-worktree --all; worktree branches + commits ride, main index/stash captured", async () => {
  const { M, W: W1 } = await makeMainWithWorktree({ worktree: path.join(tmp, "wt1"), branch: "feat1" });
  await commit(W1, "w1.txt", "w1", "feat1 c1"); // a commit IN the worktree, on its branch
  const W2 = path.join(tmp, "wt2");
  await git(M, "worktree", "add", W2, "-b", "feat2");
  await commit(W2, "w2.txt", "w2", "feat2 c1");
  // main-checkout-local state: a stash + a staged file (its OWN index, not a worktree's)
  await fs.writeFile(path.join(M, "f.txt"), "dirty");
  await git(M, "stash", "-q");
  await fs.writeFile(path.join(M, "s.txt"), "staged");
  await git(M, "add", "s.txt");

  const section = await captureGitState(M, store, KEK);
  expect(section).toBeDefined();
  expect(section!.refScope).toBe("all");
  // worktree branches travel as ordinary refs/heads/* (V4); refs/stash is main-local
  expect(Object.keys(section!.refs).sort()).toEqual(["refs/heads/feat1", "refs/heads/feat2", "refs/heads/main", "refs/stash"]);
  expect(section!.indexSha).toBeDefined();

  // standalone twin: every branch + its commit present, main index restored, fsck-clean
  const D = path.join(tmp, "D");
  expect((await applyGitState(D, section!, store, KEK)).applied).toBe(true);
  expect((await git(D, "branch", "--format=%(refname:short)")).split("\n").sort()).toEqual(["feat1", "feat2", "main"]);
  expect(await git(D, "rev-parse", "feat1")).toBe(await git(M, "rev-parse", "feat1")); // V4: worktree-branch commit rode
  expect(await git(D, "rev-parse", "feat2")).toBe(await git(M, "rev-parse", "feat2"));
  expect(await git(D, "rev-parse", "refs/stash")).toBe(await git(M, "rev-parse", "refs/stash"));
  expect(await git(D, "diff", "--cached", "--name-only")).toBe("s.txt"); // main-checkout index restored
  await expect(git(D, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
});

test("design 68 §3.1 V9: a DETACHED linked-worktree HEAD does NOT ride the main bundle (--single-worktree excludes tier-2 state)", async () => {
  const { M, W } = await makeMainWithWorktree({ worktree: path.join(tmp, "wt") });
  await commit(W, "w.txt", "onbranch", "feat c1"); // a commit on feat — MUST ride (V4)
  const featSha = await git(W, "rev-parse", "feat");
  await git(W, "checkout", "-q", "--detach");
  await commit(W, "d.txt", "detached", "detached c1"); // reachable ONLY from the detached HEAD
  const detachedSha = await git(W, "rev-parse", "HEAD");
  expect(detachedSha).not.toBe(featSha);

  const section = await captureGitState(M, store, KEK);
  const D = path.join(tmp, "D");
  expect((await applyGitState(D, section!, store, KEK)).applied).toBe(true);
  expect(await git(D, "rev-parse", "feat")).toBe(featSha); // branch commit rode
  await expect(git(D, "cat-file", "-e", `${detachedSha}^{commit}`)).rejects.toThrow(); // detached commit excluded
});

test("design 68 V7: a prunable-only .git/worktrees is treated as absent — preflight ok, capture proceeds", async () => {
  const { M, W } = await makeMainWithWorktree({ worktree: path.join(tmp, "wt") });
  await commit(W, "w.txt", "w", "feat c1");
  await fs.rm(W, { recursive: true, force: true }); // checkout gone → the admin entry is prunable

  expect((await fs.lstat(path.join(M, ".git", "worktrees"))).isDirectory()).toBe(true); // stale entry lingers
  expect(await gitPreflight(M)).toEqual({ ok: true, kind: "dir" });
  const section = await captureGitState(M, store, KEK);
  expect(section).toBeDefined();
  expect(section!.refScope).toBe("all");
});

test("design 68 V13: a PRUNABLE worktree entry produces no phantom apply collision (checked-out set ignores stale entries)", async () => {
  const { M, W } = await makeMainWithWorktree({ worktree: path.join(tmp, "wt"), branch: "sibling" });
  await commit(W, "w.txt", "w", "sibling c1");
  await fs.rm(W, { recursive: true, force: true }); // prunable: `sibling` is not really checked out

  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "a.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK); // all-scope {refs/heads/main} — would delete `sibling`

  const res = await applyGitState(M, section!, store, KEK);
  expect(res.applied).toBe(true); // no live worktree holds `sibling` → no collision defer
  expect(await git(M, "rev-parse", "main")).toBe(await git(A, "rev-parse", "main"));
  await expect(git(M, "rev-parse", "--verify", "sibling")).rejects.toThrow(); // deleted — no phantom guard
});

test("design 68 §3.3 / V14: inTreeWorktreeParentRel resolves in-tree worktrees; exempts submodules and out-of-tree clones", async () => {
  const root = path.join(tmp, "root");
  await fs.mkdir(root, { recursive: true });
  // in-tree main clone + in-tree linked worktree → parent relPath
  const { W } = await makeMainWithWorktree({ main: path.join(root, "main"), worktree: path.join(root, "wt") });
  expect(await inTreeWorktreeParentRel(root, W)).toBe("main");
  // out-of-tree main clone (Conductor layout) → undefined (unchanged full capture)
  const { W: Wo } = await makeMainWithWorktree({ main: path.join(tmp, "mainOut"), worktree: path.join(root, "wtOut"), branch: "featO" });
  expect(await inTreeWorktreeParentRel(root, Wo)).toBeUndefined();
  // ordinary dir repo → undefined
  const D = path.join(root, "plain");
  await initRepo(D);
  await commit(D, "f.txt", "x", "c1");
  expect(await inTreeWorktreeParentRel(root, D)).toBeUndefined();
  // submodule checkout: commonDir resolves into .git/modules/<n> → EXEMPT (never a bare `.git`)
  const sub = path.join(tmp, "sub");
  await initRepo(sub);
  await commit(sub, "s.txt", "s", "c1");
  const sup = path.join(root, "super");
  await initRepo(sup);
  await commit(sup, "f.txt", "x", "c1");
  await git(sup, "-c", "protocol.file.allow=always", "submodule", "add", `file://${sub}`, "mod");
  expect(await inTreeWorktreeParentRel(root, path.join(sup, "mod"))).toBeUndefined();
});

test("apply removes op-state DIRECTORIES the sender no longer has (empty rebase-merge/ = phantom rebase)", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK); // no op-state

  const B = path.join(tmp, "B");
  await initRepo(B);
  await commit(B, "g.txt", "y", "c1");
  await fs.mkdir(path.join(B, ".git", "rebase-merge"), { recursive: true });
  await fs.writeFile(path.join(B, ".git", "rebase-merge", "msgnum"), "1\n");

  const res = await applyGitState(B, section!, store, KEK);
  expect(res.applied).toBe(true);
  // git treats the DIRECTORY's presence as rebase-in-progress; files-only cleanup left it behind
  expect(await fs.lstat(path.join(B, ".git", "rebase-merge")).catch(() => undefined)).toBeUndefined();
});

test("a legacy exact refs/rbox-wip ref does not D/F-block the apply-time quarantine", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK);

  const B = path.join(tmp, "B");
  await initRepo(B);
  await commit(B, "g.txt", "y", "c1");
  await git(B, "update-ref", "refs/rbox-wip", await git(B, "rev-parse", "HEAD")); // pre-§43 crash leftover

  const res = await applyGitState(B, section!, store, KEK);
  expect(res.applied).toBe(true); // quarantine pruned the legacy ref instead of failing
  await expect(git(B, "rev-parse", "--verify", "refs/rbox-wip")).rejects.toThrow();
});

test("a rolled-back apply leaks NO stash reflog entries (git stash list stays clean)", async () => {
  // A: repo with a real stash (refs/stash + reflog publish on the receiver)
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "v1", "c1");
  await fs.writeFile(path.join(A, "f.txt"), "wip");
  await git(A, "stash", "-q");
  const section = await captureGitState(A, store, KEK);
  expect(section!.refs["refs/stash"]).toBeDefined();

  // Sabotage: a syncable ref pointing at an object the bundle doesn't carry —
  // update-ref fails AFTER refs/stash published (insertion order puts it last),
  // forcing the rollback path.
  const bogus: typeof section = { ...section!, refs: { ...section!.refs, "refs/heads/zzz": "f".repeat(40) } };

  const B = path.join(tmp, "B");
  await initRepo(B);
  await commit(B, "g.txt", "y", "c1");
  const res = await applyGitState(B, bogus!, store, KEK);
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("rolled back");
  // the ref rollback also rolled back the REFLOG the stash publish appended —
  // otherwise `git stash list` would show a phantom remote stash after a failed apply
  expect(await git(B, "stash", "list")).toBe("");
  await expect(git(B, "rev-parse", "--verify", "refs/stash")).rejects.toThrow();
});

test("a sha-valid NON-BUNDLE artifact never reaches beforeMutate — the leftover survives (git-level verify precedes the wipe)", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "n.txt", "new", "n1");
  const section = await captureGitState(A, store, KEK);

  // A structurally valid encrypted artifact whose PLAINTEXT is not a git bundle:
  // decrypt + plaintext-sha checks pass; only `git bundle verify` can reject it.
  const badPlain = path.join(tmp, "notabundle");
  await fs.writeFile(badPlain, "this is not a git bundle");
  const enc = await encryptFileToTemp(badPlain, KEK, tmp);
  await store.put(enc.encSha, await fs.readFile(enc.ciphertextPath));
  const badSec: GitSection = { ...section!, bundleSha: enc.plaintextSha, bundleEncSha: enc.encSha, bundleCipherSize: enc.cipherSize };

  const B = path.join(tmp, "B");
  await initRepo(B);
  await commit(B, "old.txt", "old", "o1");
  await git(B, "branch", "leftover");
  let hookRan = false;
  const res = await applyGitState(B, badSec, store, KEK, {
    beforeMutate: async () => {
      hookRan = true;
      await quarantineAndWipeGitState(B);
    },
  });
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("bundle verify failed");
  expect(hookRan).toBe(false); // the wipe never ran
  await expect(git(B, "rev-parse", "--verify", "leftover")).resolves.toBeDefined(); // refs intact
  await expect(git(B, "rev-parse", "--verify", "main")).resolves.toBeDefined();
});

test("beforeMutate hook runs only AFTER artifact fetch+decrypt verify, and its failure defers with no mutation", async () => {
  const A = path.join(tmp, "A");
  await initRepo(A);
  await commit(A, "f.txt", "x", "c1");
  const section = await captureGitState(A, store, KEK);

  const B = path.join(tmp, "B");
  await initRepo(B);
  await commit(B, "g.txt", "y", "c1");
  const bHead = await git(B, "rev-parse", "HEAD");

  // 1) fetch/decrypt failure (wrong KEK) → the hook must never run
  let hookRan = false;
  const bad = await applyGitState(B, section!, store, Buffer.alloc(32, 9), {
    beforeMutate: async () => {
      hookRan = true;
    },
  });
  expect(bad.applied).toBe(false);
  expect(hookRan).toBe(false); // verified-before-mutate: no wipe on undecryptable remotes

  // 2) hook throw → {applied:false}, target untouched
  const res = await applyGitState(B, section!, store, KEK, {
    beforeMutate: async () => {
      throw new Error("quarantine failed");
    },
  });
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("pre-mutation");
  expect(await git(B, "rev-parse", "HEAD")).toBe(bHead); // no mutation
});

// ---- scope projection (design 43 §7) ------------------------------------------

test("projectIdentity: an all-identity projected to scoped equals the scoped identity (convergence)", async () => {
  const { W } = await makeMainWithWorktree();
  await commit(W, "w.txt", "wt", "wt c1");
  const scoped = await captureGitState(W, store, KEK);
  const D = path.join(tmp, "D");
  expect((await applyGitState(D, scoped!, store, KEK)).applied).toBe(true);
  // D grows an extra branch — the §7 trace: projected(all) must still equal projected(scoped)
  await git(D, "branch", "extra");
  const allId = await gitIdentity(D);
  expect(allId!.refScope).toBe("all");
  expect(gitIdentityKey(allId)).not.toBe(gitIdentityKey(scoped)); // full identities differ…
  expect(gitIdentityKey(projectIdentity(allId!, "scoped"))).toBe(gitIdentityKey(projectIdentity(scoped!, "scoped"))); // …projections converge
});

// ---- apply-target containment (design 43 §7 [v2, B5; v3]) ----------------------

test("assertGitTargetWithinRoot: ok for nested + '.', throws on symlink components/escape", async () => {
  const root = path.join(tmp, "root");
  await fs.mkdir(path.join(root, "a"), { recursive: true });
  expect(await assertGitTargetWithinRoot(root, ".")).toBe(root);
  expect(await assertGitTargetWithinRoot(root, "a/repo")).toBe(path.join(root, "a/repo")); // not-yet-created tail ok
  const outside = path.join(tmp, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "link"));
  await expect(assertGitTargetWithinRoot(root, "link/repo")).rejects.toThrow(/symlink/);
  await expect(assertGitTargetWithinRoot(root, "link")).rejects.toThrow(/symlink/);
});

// ---- schema + gitRepos validation (design 43 §2) -------------------------------

const fileEntry = (p: string): FileEntry => ({ path: p, sha256: "a".repeat(64), size: 1, mode: 0o644, mtimeMs: 0, type: "file" });
const section = (over: Partial<GitSection> = {}): GitSection => ({
  bundleSha: "a".repeat(64),
  bundleEncSha: "b".repeat(64),
  bundleCipherSize: 10,
  head: "ref: refs/heads/main",
  refs: { "refs/heads/main": "c".repeat(40) },
  refScope: "all",
  generatedAt: "",
  ...over,
});
const m43 = (gitRepos: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  generatedAt: "",
  files: [fileEntry("src/a.ts")],
  manifestSchema: 2,
  gitRepos,
  ...extra,
});

test("validateManifest: schema gate — legacy `git` refused, newer schema refused, v1 manifests still pass", () => {
  expect(validateManifest({ generatedAt: "", files: [] }).ok).toBe(true); // pre-§43 manifest
  const legacy = validateManifest({ generatedAt: "", files: [], git: section() });
  expect(legacy.ok).toBe(false);
  expect(!legacy.ok && legacy.error).toContain("older rbox");
  const future = validateManifest({ generatedAt: "", files: [], manifestSchema: 3 });
  expect(future.ok).toBe(false);
  expect(!future.ok && future.error).toContain("upgrade rbox");
  expect(validateManifest({ generatedAt: "", files: [], manifestSchema: 2, gitRepos: {} }).ok).toBe(true);
});

test("validateManifest: gitRepos keys — '.', safe rel paths ok; traversal/dup/file-collision/bad-section refused", () => {
  expect(validateManifest(m43({ ".": section(), "a/b": section() })).ok).toBe(true);
  // gitRepos without the schema stamp is refused (loud break, never silent)
  expect(validateManifest({ generatedAt: "", files: [], gitRepos: { ".": section() } }).ok).toBe(false);
  for (const bad of ["../x", "/abs", "a/../b", ""]) {
    expect(validateManifest(m43({ [bad]: section() })).ok).toBe(false);
  }
  expect(validateManifest(m43({ Repo: section(), repo: section() })).ok).toBe(false); // case-insensitive dup
  expect(validateManifest(m43({ "src/a.ts": section() })).ok).toBe(false); // collides with a FILE entry [v2, B5]
  expect(validateManifest(m43({ ".": { ...section(), refScope: undefined as never } })).ok).toBe(false); // refScope mandatory
  expect(validateManifest(m43({ ".": { ...section(), refs: { "refs/remotes/origin/x": "c".repeat(40) } } })).ok).toBe(false); // non-syncable ref
  // symbolic HEAD must name a branch the section CARRIES (else apply leaves an unborn HEAD)
  expect(validateManifest(m43({ ".": { ...section(), head: "ref: refs/heads/missing", refs: {} } })).ok).toBe(false);
  expect(validateManifest(m43({ ".": { ...section(), head: "ref: refs/notheads/x" } })).ok).toBe(false); // symbolic HEAD outside refs/heads
  expect(validateManifest(m43({ ".": { ...section(), head: "d".repeat(40), refs: {} } })).ok).toBe(true); // detached HEAD needs no refs
});

test("validateManifest: MAX_GIT_REPOS is a LOUD error at the boundary, not a silent drop", () => {
  const at = Object.fromEntries(Array.from({ length: MAX_GIT_REPOS }, (_, i) => [`r${i}`, section()]));
  expect(validateManifest(m43(at)).ok).toBe(true);
  const over = { ...at, overflow: section() };
  const r = validateManifest(m43(over));
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error).toContain("too many git repos");
});
