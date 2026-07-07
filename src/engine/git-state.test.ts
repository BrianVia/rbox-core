import { test as bunTest, expect, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  applyGitState,
  buildIgnoreMatcher,
  captureGitState,
  normalizeSymbolicHeadCasing,
  GitCaptureDeferredError,
  gitCaptureScratchRoot,
  gitSectionNewestLink,
  gitSectionTips,
  gitIdentity,
  gitIdentityKey,
  gitPreflight,
  LocalBlobStore,
  preserveGitConflict,
  scanManifest,
  setGitSpawnObserver,
  sweepStaleGitCaptureDirs,
  validateGitSection,
  type BlobStore,
  type GitSection,
} from "./index.js";

const exec = promisify(execFile);
const git = (root: string, ...args: string[]) => exec("git", ["-C", root, ...args]).then((r) => r.stdout.toString().trim());
const KEK = Buffer.alloc(32, 7); // §28: git artifacts are convergent-encrypted under the workspace KEK
const test = (name: string, fn: () => unknown | Promise<unknown>, timeout = 20_000) => bunTest(name, fn, timeout);
test.if = (cond: boolean) => (name: string, fn: () => unknown | Promise<unknown>, timeout = 20_000) =>
  cond ? bunTest(name, fn, timeout) : bunTest.skip(name, fn);

let tmp: string;
let A: string;
let B: string;
let store: LocalBlobStore;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gs-"));
  A = path.join(tmp, "A");
  B = path.join(tmp, "B");
  await fs.mkdir(A, { recursive: true });
  await fs.mkdir(B, { recursive: true });
  store = new LocalBlobStore(path.join(tmp, "store"));
});
afterEach(async () => {
  await fs.rm(tmp, { recursive: true, force: true });
});

async function initRepo(dir: string) {
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "t");
}
async function commitFile(dir: string, file: string, content: string, msg: string) {
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, "add", file);
  await git(dir, "commit", "-qm", msg);
}
async function captureIncrement(repo: string, base: GitSection): Promise<GitSection> {
  const inc = await captureGitState(repo, store, KEK, { basis: { tips: gitSectionTips(base) } });
  expect(inc).toBeDefined();
  return { ...inc!, packChain: [...(base.packChain ?? []), gitSectionNewestLink(base)] };
}
async function appendPackedRef(dir: string, ref: string, sha: string) {
  const packed = path.join(dir, ".git", "packed-refs");
  const existing = await fs.readFile(packed, "utf8").catch(() => "# pack-refs with: peeled fully-peeled sorted\n");
  await fs.writeFile(packed, `${existing.endsWith("\n") ? existing : `${existing}\n`}${sha} ${ref}\n`);
}

test("preflight accepts an ordinary repo, rejects non-repo and bare", async () => {
  await initRepo(A);
  await fs.writeFile(path.join(A, "f.txt"), "x");
  await git(A, "add", "f.txt");
  await git(A, "commit", "-qm", "c1");
  expect((await gitPreflight(A)).ok).toBe(true);
  expect((await gitPreflight(B)).ok).toBe(false); // no commits yet but .git exists → inside-work-tree ok; not-a-repo dir:
  const plain = path.join(tmp, "plain");
  await fs.mkdir(plain);
  expect((await gitPreflight(plain)).ok).toBe(false);
});


/** True when the tmp filesystem is case-INSENSITIVE (macOS/APFS default). The
 *  case-drift repro (HEAD casing != packed-refs casing while HEAD still
 *  resolves) can only exist there; on case-sensitive FS the same setup reads
 *  as an unborn branch and capture exits early. The pure normalization is
 *  tested unconditionally below; the end-to-end repros run where they can. */
const fsCaseInsensitive = await (async () => {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-case-probe-"));
  try {
    await fs.writeFile(path.join(d, "CaseProbe"), "");
    return await fs.access(path.join(d, "caseprobe")).then(() => true, () => false);
  } finally {
    await fs.rm(d, { recursive: true, force: true });
  }
})();

test("normalizeSymbolicHeadCasing: pure semantics (FS-independent)", () => {
  const refs = { "refs/heads/casemix": "a".repeat(40), "refs/heads/main": "b".repeat(40) };
  // drift → normalized to the ref store's casing
  expect(normalizeSymbolicHeadCasing("ref: refs/heads/CaseMix", refs)).toBe("ref: refs/heads/casemix");
  // exact match → untouched
  expect(normalizeSymbolicHeadCasing("ref: refs/heads/main", refs)).toBe("ref: refs/heads/main");
  // ambiguous (two case-variants) → untouched, validation refuses downstream
  const amb = { ...refs, "refs/heads/CASEMIX": "c".repeat(40) };
  expect(normalizeSymbolicHeadCasing("ref: refs/heads/CaseMix", amb)).toBe("ref: refs/heads/CaseMix");
  // detached HEAD → untouched
  expect(normalizeSymbolicHeadCasing("d".repeat(40), refs)).toBe("d".repeat(40));
  // no candidate at all → untouched
  expect(normalizeSymbolicHeadCasing("ref: refs/heads/ghost", refs)).toBe("ref: refs/heads/ghost");
});

test.if(fsCaseInsensitive)("capture normalizes symbolic HEAD casing to the ref store casing", async () => {
  await initRepo(A);
  await commitFile(A, "f.txt", "x", "c1");
  await git(A, "branch", "casemix");
  await fs.writeFile(path.join(A, ".git", "HEAD"), "ref: refs/heads/CaseMix\n");

  const section = await captureGitState(A, store, KEK);
  expect(section).toBeDefined();
  expect(section!.head).toBe("ref: refs/heads/casemix");
  expect(section!.refs["refs/heads/casemix"]).toBe(await git(A, "rev-parse", "casemix"));
  expect(validateGitSection(section!).ok).toBe(true);
});

test.if(fsCaseInsensitive)("capture refuses ambiguous case-insensitive HEAD ref matches with validation reason", async () => {
  await initRepo(A);
  await commitFile(A, "f.txt", "x", "c1");
  await git(A, "branch", "casemix");
  const sha = await git(A, "rev-parse", "casemix");
  await appendPackedRef(A, "refs/heads/CASEMIX", sha);
  await fs.writeFile(path.join(A, ".git", "HEAD"), "ref: refs/heads/CaseMix\n");

  let err: unknown;
  try {
    await captureGitState(A, store, KEK);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GitCaptureDeferredError);
  expect((err as Error).message).toBe("capture failed self-validation: HEAD branch refs/heads/CaseMix not in refs");
});

test("capture names its early bails: empty repo throws a reasoned defer, not undefined", async () => {
  await initRepo(A); // no commit → HEAD is an unborn branch
  let err: unknown;
  try {
    await captureGitState(A, store, KEK);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(GitCaptureDeferredError);
  expect((err as Error).message).toContain("HEAD unverifiable");
});

test("capture→apply reproduces branches, staged state, and stash across repos", async () => {
  await initRepo(A);
  await fs.writeFile(path.join(A, "f.txt"), "v1");
  await git(A, "add", "f.txt");
  await git(A, "commit", "-qm", "c1");
  await git(A, "checkout", "-qb", "feature");
  await fs.writeFile(path.join(A, "f.txt"), "v2");
  await git(A, "commit", "-qam", "c2");
  await git(A, "checkout", "-q", "main");
  await fs.writeFile(path.join(A, "f.txt"), "wip");
  await git(A, "stash", "-q");
  await fs.writeFile(path.join(A, "g.txt"), "staged");
  await git(A, "add", "g.txt");

  const section = await captureGitState(A, store, KEK);
  expect(section).toBeDefined();
  // §28 zero-knowledge: the stored blobs are CIPHERTEXT — a stored bundle must not be a valid
  // git bundle, and the plaintext content "v2" must not appear in ANY stored blob.
  const bundleBytes = await store.get(section!.bundleEncSha);
  expect(bundleBytes.subarray(0, 16).toString("utf8")).not.toContain("# v2 git bundle"); // git bundle magic header absent
  for (const f of await fs.readdir(path.join(tmp, "store"), { recursive: true } as never).catch(() => [] as string[])) {
    const p = path.join(tmp, "store", f as string);
    if ((await fs.stat(p).catch(() => null))?.isFile()) {
      expect((await fs.readFile(p)).toString("latin1")).not.toContain("staged"); // a known plaintext blob content
    }
  }

  // Fresh repo B, apply the captured (encrypted) state — decrypts + reproduces byte-identically.
  await initRepo(B);
  const res = await applyGitState(B, section!, store, KEK);
  expect(res.applied).toBe(true);

  // Branches + commits match.
  const aBranches = (await git(A, "branch", "--format=%(refname:short)")).split("\n").sort();
  const bBranches = (await git(B, "branch", "--format=%(refname:short)")).split("\n").sort();
  expect(bBranches).toEqual(aBranches);
  expect(await git(B, "rev-parse", "main")).toBe(await git(A, "rev-parse", "main"));
  expect(await git(B, "rev-parse", "feature")).toBe(await git(A, "rev-parse", "feature"));

  // Staged state matches (index blobs were shipped via stash-create).
  expect((await git(B, "diff", "--cached", "--name-only")).split("\n").sort()).toEqual(
    (await git(A, "diff", "--cached", "--name-only")).split("\n").sort()
  );

  // fsck clean.
  await expect(git(B, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
});

test("incremental dir/all capture uses basis negations and a chained section round-trips", async () => {
  await initRepo(A);
  await commitFile(A, "history.txt", "base\n", "c1");
  const base = await captureGitState(A, store, KEK);
  expect(base).toBeDefined();
  const baseTip = await git(A, "rev-parse", "main");

  await fs.writeFile(path.join(A, "history.txt"), "stashed\n");
  await git(A, "stash", "-q");
  await commitFile(A, "next.txt", "next\n", "c2");

  const bundleCreates: string[][] = [];
  setGitSpawnObserver((_root, args) => {
    if (args[0] === "bundle" && args[1] === "create") bundleCreates.push([...args]);
  });
  let chained: NonNullable<Awaited<ReturnType<typeof captureGitState>>>;
  try {
    chained = await captureIncrement(A, base!);
  } finally {
    setGitSpawnObserver(undefined);
  }
  const incArgs = bundleCreates.at(-1)!;
  expect(incArgs).toContain("--all");
  expect(incArgs).toContain("refs/stash");
  expect(incArgs).toContain(`^${baseTip}`);
  expect(chained.packChain).toHaveLength(1);

  const res = await applyGitState(B, chained, store, KEK);
  expect(res.applied).toBe(true);
  expect(await git(B, "rev-parse", "main")).toBe(await git(A, "rev-parse", "main"));
  expect(await git(B, "rev-parse", "refs/stash")).toBe(await git(A, "rev-parse", "refs/stash"));
});

test("rewritten refs between increment links import with forced scratch refs, and second apply skips only historical links", async () => {
  await initRepo(A);
  await commitFile(A, "f.txt", "base\n", "c1");
  const base = (await captureGitState(A, store, KEK))!;
  const c1 = await git(A, "rev-parse", "main");

  await commitFile(A, "f.txt", "base\nold-tip\n", "c2");
  const link1 = await captureIncrement(A, base);
  const c2 = await git(A, "rev-parse", "main");

  await git(A, "reset", "--hard", c1);
  await commitFile(A, "f.txt", "base\nrewritten-tip\n", "c3");
  const rewritten = await captureIncrement(A, link1);
  const c3 = await git(A, "rev-parse", "main");
  expect(c3).not.toBe(c2);
  expect(rewritten.packChain).toHaveLength(2);

  let res = await applyGitState(B, rewritten, store, KEK);
  expect(res.applied).toBe(true);
  expect(await git(B, "rev-parse", "main")).toBe(c3);

  const fetches: string[][] = [];
  setGitSpawnObserver((_root, args) => {
    if (args[0] === "fetch") fetches.push([...args]);
  });
  try {
    res = await applyGitState(B, rewritten, store, KEK);
  } finally {
    setGitSpawnObserver(undefined);
  }
  expect(res.applied).toBe(true);
  expect(fetches).toHaveLength(1);
});

test("current incremental link is imported even when recorded commit tips are already present", async () => {
  await initRepo(A);
  await commitFile(A, "f.txt", "base\n", "c1");
  const base = (await captureGitState(A, store, KEK))!;
  let res = await applyGitState(B, base, store, KEK);
  expect(res.applied).toBe(true);

  await fs.writeFile(path.join(A, "staged.txt"), "staged\n");
  await git(A, "add", "staged.txt");
  const chained = await captureIncrement(A, base);
  expect(chained.packChain).toHaveLength(1);
  expect(gitSectionTips(chained)).toEqual(gitSectionTips(base));

  res = await applyGitState(B, chained, store, KEK);
  expect(res.applied).toBe(true);
  expect(await git(B, "diff", "--cached", "--name-only")).toBe("staged.txt");
  await expect(git(B, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
});

test("unchained full-bundle sections do not use presence probes", async () => {
  await initRepo(A);
  await commitFile(A, "f.txt", "base\n", "c1");
  const section = (await captureGitState(A, store, KEK))!;
  expect(section.packChain).toBeUndefined();

  let res = await applyGitState(B, section, store, KEK);
  expect(res.applied).toBe(true);

  let catFileProbes = 0;
  let fetches = 0;
  setGitSpawnObserver((_root, args) => {
    if (args[0] === "cat-file" && args[1] === "-e") catFileProbes++;
    if (args[0] === "fetch") fetches++;
  });
  try {
    res = await applyGitState(B, section, store, KEK);
  } finally {
    setGitSpawnObserver(undefined);
  }
  expect(res.applied).toBe(true);
  expect(catFileProbes).toBe(0);
  expect(fetches).toBe(1);
});

test("preserveGitConflict imports the current WIP link even when commit tips are present", async () => {
  await initRepo(A);
  await commitFile(A, "f.txt", "base\n", "c1");
  const base = (await captureGitState(A, store, KEK))!;
  const applied = await applyGitState(B, base, store, KEK);
  expect(applied.applied).toBe(true);

  await fs.writeFile(path.join(A, "staged.txt"), "staged\n");
  await git(A, "add", "staged.txt");
  const chained = await captureIncrement(A, base);
  expect(gitSectionTips(chained)).toEqual(gitSectionTips(base));

  const preserved = await preserveGitConflict(B, chained, store, KEK);
  expect(preserved.recoveryBundle).toBeDefined();
  await expect(git(B, "bundle", "verify", preserved.recoveryBundle!)).resolves.toBeDefined();
  expect(await git(B, "bundle", "list-heads", preserved.recoveryBundle!)).toContain("rbox-wip");
});

test("detached pointer captures use detached HEAD as basis for scoped chains", async () => {
  const M = path.join(tmp, "main");
  const W = path.join(tmp, "worktree");
  await fs.mkdir(M, { recursive: true });
  await initRepo(M);
  await commitFile(M, "f.txt", "base\n", "c1");
  await git(M, "worktree", "add", "--detach", W, "HEAD");

  const base = (await captureGitState(W, store, KEK))!;
  expect(base.refScope).toBe("scoped");
  expect(base.refs).toEqual({});
  await commitFile(W, "detached.txt", "next\n", "detached c2");

  const bundleCreates: string[][] = [];
  setGitSpawnObserver((_root, args) => {
    if (args[0] === "bundle" && args[1] === "create") bundleCreates.push([...args]);
  });
  let chained: NonNullable<Awaited<ReturnType<typeof captureGitState>>>;
  try {
    chained = await captureIncrement(W, base);
  } finally {
    setGitSpawnObserver(undefined);
  }
  const incArgs = bundleCreates.at(-1)!;
  expect(incArgs).not.toContain("--all");
  expect(incArgs).toContain(`^${base.head}`);
  expect(chained.refs).toEqual({});
  expect(chained.head).toBe(await git(W, "rev-parse", "HEAD"));

  const res = await applyGitState(B, chained, store, KEK);
  expect(res.applied).toBe(true);
  expect(await git(B, "rev-parse", "HEAD")).toBe(chained.head);
});

test("capture stages ciphertext under workspace .rbox/gitcap, not direct os.tmpdir scratch", async () => {
  const workspace = A;
  const repo = path.join(workspace, "repo");
  await fs.mkdir(repo, { recursive: true });
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "f.txt"), "v1");
  await git(repo, "add", "f.txt");
  await git(repo, "commit", "-qm", "c1");

  const blobs = new Map<string, Buffer>();
  const uploadPaths: string[] = [];
  const recordingStore: BlobStore = {
    async has(s) {
      return blobs.has(s);
    },
    async put(s, bytes) {
      blobs.set(s, Buffer.from(bytes));
    },
    async get(s) {
      const b = blobs.get(s);
      if (!b) throw new Error(`missing ${s}`);
      return b;
    },
    async putFile(s, src) {
      uploadPaths.push(src);
      blobs.set(s, await fs.readFile(src));
    },
  };

  const section = await captureGitState(repo, recordingStore, KEK, { workspaceRoot: workspace });
  expect(section).toBeDefined();
  expect(uploadPaths.length).toBeGreaterThan(0);
  const scratch = `${gitCaptureScratchRoot(workspace)}${path.sep}`;
  for (const p of uploadPaths) {
    expect(p.startsWith(scratch)).toBe(true);
    expect(p.startsWith(path.join(os.tmpdir(), "rbox-gitcap-"))).toBe(false);
  }
});

test("stale git capture sweep removes orphan rbox-gitcap directories and preserves live owners", async () => {
  const scratch = gitCaptureScratchRoot(A);
  await fs.mkdir(scratch, { recursive: true });
  const orphanDir = path.join(scratch, "rbox-gitcap-orphan");
  const freshOrphanDir = path.join(scratch, "rbox-gitcap-fresh-orphan");
  const liveDir = path.join(scratch, "rbox-gitcap-live");
  const oldOtherDir = path.join(scratch, "not-rbox-gitcap-old");
  const oldFile = path.join(scratch, "rbox-gitcap-file");
  await fs.mkdir(orphanDir);
  await fs.mkdir(freshOrphanDir);
  await fs.mkdir(liveDir);
  await fs.writeFile(path.join(liveDir, "owner.pid"), `${process.pid}\n`);
  await fs.mkdir(oldOtherDir);
  await fs.writeFile(oldFile, "not a dir");
  const now = Date.now();
  const old = new Date(now - 25 * 60 * 60 * 1000);
  await fs.utimes(orphanDir, old, old);
  await fs.utimes(liveDir, old, old);
  await fs.utimes(oldOtherDir, old, old);
  await fs.utimes(oldFile, old, old);

  await sweepStaleGitCaptureDirs(A, now);
  await expect(fs.stat(orphanDir)).rejects.toThrow();
  await expect(fs.stat(freshOrphanDir)).rejects.toThrow();
  await expect(fs.stat(liveDir)).resolves.toBeDefined();
  await expect(fs.stat(oldOtherDir)).resolves.toBeDefined();
  await expect(fs.stat(oldFile)).resolves.toBeDefined();
});

test("second git capture sweep preserves an aged live staging dir and sweeps a dead owner promptly", async () => {
  const repo = path.join(A, "repo");
  await fs.mkdir(repo, { recursive: true });
  await initRepo(repo);
  await fs.writeFile(path.join(repo, "f.txt"), "v1");
  await git(repo, "add", "f.txt");
  await git(repo, "commit", "-qm", "c1");

  const scratch = gitCaptureScratchRoot(A);
  await fs.mkdir(scratch, { recursive: true });
  const liveDir = path.join(scratch, "rbox-gitcap-live-aging");
  const deadDir = path.join(scratch, "rbox-gitcap-dead-owner");
  await fs.mkdir(liveDir);
  await fs.writeFile(path.join(liveDir, "owner.pid"), `${process.pid}\n`);
  await fs.writeFile(path.join(liveDir, "repo.bundle"), "still being read");
  await fs.mkdir(deadDir);
  await fs.writeFile(path.join(deadDir, "owner.pid"), "999999999\n");
  await fs.writeFile(path.join(deadDir, "repo.bundle"), "abandoned");
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(liveDir, old, old);

  const section = await captureGitState(repo, store, KEK, { workspaceRoot: A });
  expect(section).toBeDefined();
  await expect(fs.stat(liveDir)).resolves.toBeDefined();
  await expect(fs.stat(deadDir)).rejects.toThrow();
});

test("scanManifest never includes staged git capture bytes under .rbox", async () => {
  await fs.writeFile(path.join(A, "tracked.txt"), "visible");
  await fs.mkdir(path.join(A, ".rbox", "gitcap", "rbox-gitcap-leftover"), { recursive: true });
  await fs.writeFile(path.join(A, ".rbox", "gitcap", "rbox-gitcap-leftover", "repo.bundle"), "secret bundle bytes");

  const manifest = await scanManifest(A, buildIgnoreMatcher(A));
  expect(manifest.files.map((f) => f.path)).toEqual(["tracked.txt"]);
});

test("apply with the WRONG key fails closed — no .git mutation (§28 decrypt-before-mutate)", async () => {
  await initRepo(A);
  await fs.writeFile(path.join(A, "f.txt"), "remote-content");
  await git(A, "add", "f.txt");
  await git(A, "commit", "-qm", "remote");
  const section = await captureGitState(A, store, KEK);

  // B has its own committed state that must survive a failed apply.
  await initRepo(B);
  await fs.writeFile(path.join(B, "local.txt"), "local");
  await git(B, "add", "local.txt");
  await git(B, "commit", "-qm", "local");
  const bHeadBefore = await git(B, "rev-parse", "HEAD");

  const res = await applyGitState(B, section!, store, Buffer.alloc(32, 99)); // WRONG key
  expect(res.applied).toBe(false);
  expect(res.reason).toContain("decrypt"); // failed at decrypt, before any mutation
  expect(await git(B, "rev-parse", "HEAD")).toBe(bHeadBefore); // B untouched
  expect((await git(B, "branch", "--format=%(refname:short)")).split("\n")).toEqual(["main"]); // no remote refs leaked in
});

test("gitIdentity is stable across captures when nothing changed (no echo)", async () => {
  await initRepo(A);
  await fs.writeFile(path.join(A, "f.txt"), "v1");
  await git(A, "add", "f.txt");
  await git(A, "commit", "-qm", "c1");

  const id1 = await gitIdentity(A);
  const id2 = await gitIdentity(A);
  // Identity key must match even though a fresh bundle would differ byte-wise.
  expect(gitIdentityKey(id1 as never)).toBe(gitIdentityKey(id2 as never));

  // A new commit changes the identity.
  await fs.writeFile(path.join(A, "f.txt"), "v2");
  await git(A, "commit", "-qam", "c2");
  const id3 = await gitIdentity(A);
  expect(gitIdentityKey(id3 as never)).not.toBe(gitIdentityKey(id1 as never));
});
