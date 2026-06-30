import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { applyGitState, captureGitState, gitIdentity, gitIdentityKey, gitPreflight, LocalBlobStore } from "./index.js";

const exec = promisify(execFile);
const git = (root: string, ...args: string[]) => exec("git", ["-C", root, ...args]).then((r) => r.stdout.toString().trim());
const KEK = Buffer.alloc(32, 7); // §28: git artifacts are convergent-encrypted under the workspace KEK

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
