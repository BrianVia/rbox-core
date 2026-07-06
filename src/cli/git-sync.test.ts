import { test, expect, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { pull, push, pushManifest, sync, type SyncDeps } from "./sync.js";
import { loadState, saveState, type WorkspaceConfig } from "./config.js";
import type { CommitResult, SyncRemote } from "./remote.js";
import { buildIgnoreMatcher, captureGitState, gitIdentity, gitIdentityKey, scanManifest, type BlobStore, type FileEntry, type GitSection, type Manifest } from "../engine/index.js";
import { gitDivergenceCount } from "./sync-git.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());
const gitAt = (dir: string, date: string, ...args: string[]) =>
  exec("git", ["-C", dir, ...args], { env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } }).then((r) => r.stdout.toString().trim());

// E2EE is the only sync mode: the fake server stores CIPHERTEXT by encSha; manifests
// are the post-decryption plaintext view (same layering as sync.test.ts's FakeRemote).
const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

/** Ciphertext addresses a git section references — mirrors the server's §28 blobRef view. */
const gitShasOf = (s: GitSection): string[] => [s.bundleEncSha, ...(s.indexEncSha ? [s.indexEncSha] : []), ...Object.values(s.opState ?? {}).map((r) => r.encSha)];

/**
 * Stateful in-memory server (the sync.test.ts FakeRemote, extended for design 43):
 * commit() also enforces blob existence for every gitRepos artifact (as the real §28
 * server does via blobRefs), blobs can be deleted (GC simulation, the pending+422
 * case), and git-artifact PUTs can be failed once (capture-churn simulation).
 */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  commitCalls = 0;
  /** Fail the NEXT git-artifact upload (blobStore().putFile) — simulates a repo
   *  churning/vanishing mid-capture so that repo defers. Self-clears. */
  failNextGitPut = false;

  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  headSeq(): number {
    return this.head;
  }
  deleteBlob(encSha: string): void {
    this.blobs.delete(encSha);
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    this.blobs.set(sha256, await fs.readFile(absPath));
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls += 1;
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    const missing = new Set<string>();
    for (const f of manifest.files) {
      if (f.type === "file" && !this.blobs.has(f.encSha ?? f.sha256)) missing.add(f.encSha ?? f.sha256);
    }
    for (const g of Object.values(manifest.gitRepos ?? {})) {
      for (const s of gitShasOf(g)) if (!this.blobs.has(s)) missing.add(s);
    }
    if (missing.size > 0) return { unsatisfiedBlobs: [...missing] };
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const self = this;
    return {
      async has(s) {
        return self.blobs.has(s);
      },
      async put(s, bytes) {
        self.blobs.set(s, Buffer.from(bytes));
      },
      async get(s) {
        const b = self.blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      async getToFile(s, dest) {
        const b = self.blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, b);
      },
      async putFile(s, src) {
        if (self.failNextGitPut) {
          self.failNextGitPut = false;
          throw new Error("simulated mid-capture churn (upload failed)");
        }
        self.blobs.set(s, await fs.readFile(src));
      },
    };
  }
}

let tmp: string;
let rootA: string;
let rootB: string;
let remote: FakeRemote;
let cfgA: WorkspaceConfig;
let cfgB: WorkspaceConfig;
let logsA: string[];
let logsB: string[];
let depsA: SyncDeps;
let depsB: SyncDeps;
const noBackoff = async () => {};

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-gitsync-"));
  rootA = path.join(tmp, "A");
  rootB = path.join(tmp, "B");
  await fs.mkdir(path.join(rootA, ".rbox", "state"), { recursive: true });
  await fs.mkdir(path.join(rootB, ".rbox", "state"), { recursive: true });
  remote = new FakeRemote();
  const mk = (root: string, dev: string): WorkspaceConfig => ({
    remoteWorkspaceId: "ws_g43",
    projectId: "root",
    deviceId: dev,
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    syncGit: true,
    encrypted: true,
    kek: KEK,
  });
  cfgA = mk(rootA, "devA");
  cfgB = mk(rootB, "devB");
  logsA = [];
  logsB = [];
  depsA = { remote, backoff: noBackoff, onGitLog: (l) => logsA.push(l) };
  depsB = { remote, backoff: noBackoff, onGitLog: (l) => logsB.push(l) };
});
afterEach(async () => {
  delete process.env.RBOX_GIT_REPO_CAP;
  await fs.rm(tmp, { recursive: true, force: true });
});

async function initRepo(dir: string) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "t");
}
async function commitFile(dir: string, file: string, content: string, msg: string, date?: string) {
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, "add", file);
  // identity via -c so commits work in repos rbox materialized (no local user config)
  if (date) await gitAt(dir, date, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", msg);
  else await git(dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", msg);
}
async function makeInTreeMainWithWorktree(): Promise<{ M: string; W: string }> {
  const M = path.join(rootA, "main");
  await initRepo(M);
  await commitFile(M, "m.txt", "mm", "c1");
  const W = path.join(rootA, "wt");
  await git(M, "worktree", "add", W, "-b", "feat");
  await commitFile(W, "w.txt", "ww", "wt c1");
  return { M, W };
}
const st = (root: string) => loadState(root, "http://x::ws_g43::root");
const syncCycle = async () => {
  await sync(rootA, cfgA, depsA);
  await sync(rootB, cfgB, depsB);
};

// ── (a) two-machine e2e: fidelity across nested repos + a real worktree ──────────

test("e2e: nested dir repos (staged+stash+paused rebase) + out-of-tree worktree round-trip B-side fsck-clean and continuable", async () => {
  // proj1: dir repo with a stash, then a PAUSED (conflicted) rebase with a staged resolution
  const p1 = path.join(rootA, "proj1");
  await initRepo(p1);
  await commitFile(p1, "a.txt", "v1", "c1");
  await fs.writeFile(path.join(p1, "a.txt"), "stashed-work");
  await git(p1, "stash", "-q");
  await git(p1, "checkout", "-qb", "side");
  await commitFile(p1, "a.txt", "side-change", "side c1");
  await git(p1, "checkout", "-q", "main");
  await commitFile(p1, "a.txt", "main-change", "main c2");
  await git(p1, "checkout", "-q", "side");
  await expect(git(p1, "rebase", "main")).rejects.toThrow(); // paused mid-rebase (conflict)
  await fs.writeFile(path.join(p1, "a.txt"), "resolved");
  await git(p1, "add", "a.txt"); // staged conflict resolution

  // proj2: plain nested dir repo
  const p2 = path.join(rootA, "sub", "proj2");
  await initRepo(p2);
  await commitFile(p2, "b.txt", "bb", "c1");

  // wt: a REAL `git worktree` of a main clone OUTSIDE the sync root
  const M = path.join(tmp, "mainclone");
  await initRepo(M);
  await commitFile(M, "m.txt", "mm", "c1");
  const W = path.join(rootA, "wt");
  await git(M, "worktree", "add", W, "-b", "feat");
  await commitFile(W, "w.txt", "ww", "wt c1");

  await push(rootA, cfgA, depsA);
  expect(logsA.some((l) => l.startsWith("git-sync: captured 3"))).toBe(true); // §10 forensic line
  const manifest = (await remote.latest()).manifest;
  expect(manifest.manifestSchema).toBe(2);
  expect(Object.keys(manifest.gitRepos ?? {}).sort()).toEqual(["proj1", "sub/proj2", "wt"]);
  expect(manifest.gitRepos!["wt"]!.refScope).toBe("scoped"); // pointer capture → scoped section
  expect(manifest.gitRepos!["proj1"]!.refScope).toBe("all");

  await pull(rootB, cfgB, depsB);
  for (const rel of ["proj1", "sub/proj2", "wt"]) {
    const d = path.join(rootB, rel);
    expect((await fs.lstat(path.join(d, ".git"))).isDirectory()).toBe(true); // standalone materialization
    await expect(git(d, "fsck", "--connectivity-only", "--no-dangling")).resolves.toBeDefined();
  }
  const b1 = path.join(rootB, "proj1");
  // history + refs + stash + status all match
  expect(await git(b1, "rev-parse", "main")).toBe(await git(p1, "rev-parse", "main"));
  expect(await git(b1, "rev-parse", "side")).toBe(await git(p1, "rev-parse", "side"));
  expect(await git(b1, "rev-parse", "refs/stash")).toBe(await git(p1, "rev-parse", "refs/stash"));
  expect(await git(b1, "stash", "list")).toBe(await git(p1, "stash", "list"));
  expect(await git(b1, "status", "--porcelain")).toBe(await git(p1, "status", "--porcelain"));
  // the paused rebase is present AND continuable on B
  expect((await fs.lstat(path.join(b1, ".git", "rebase-merge"))).isDirectory()).toBe(true);
  await git(b1, "config", "user.email", "t@t.t");
  await git(b1, "config", "user.name", "t");
  await expect(git(b1, "-c", "core.editor=true", "rebase", "--continue")).resolves.toBeDefined();
  expect(await git(b1, "symbolic-ref", "HEAD")).toBe("refs/heads/side"); // rebase completed onto side
  // the worktree materialized standalone on feat
  const bw = path.join(rootB, "wt");
  expect(await git(bw, "symbolic-ref", "HEAD")).toBe("refs/heads/feat");
  expect(await git(bw, "rev-parse", "feat")).toBe(await git(W, "rev-parse", "feat"));
  expect((await git(bw, "branch", "--format=%(refname:short)")).split("\n")).toEqual(["feat"]); // main never leaked
}, 30_000);

test("e2e: worktree scope-crossing converges (§7 trace) — B's edit applies into A's pointer repo, then ZERO capture ping-pong", async () => {
  const M = path.join(tmp, "mainclone");
  await initRepo(M);
  await commitFile(M, "m.txt", "mm", "c1");
  const W = path.join(rootA, "wt");
  await git(M, "worktree", "add", W, "-b", "feat");
  await commitFile(W, "w.txt", "ww", "wt c1");

  await push(rootA, cfgA, depsA); // scoped S1
  await pull(rootB, cfgB, depsB); // B materializes standalone (base = S1)

  // B does real work in the materialized repo and pushes — a dir repo with a SCOPED
  // base must capture fresh (all-scope A1), per the §7 matrix.
  const bw = path.join(rootB, "wt");
  await git(bw, "config", "user.email", "t@t.t");
  await git(bw, "config", "user.name", "t");
  await commitFile(bw, "w2.txt", "from-B", "b c1");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["wt"]!.refScope).toBe("all");

  // A pulls: the all-scope section applies into the POINTER repo (update-only, guarded)
  await pull(rootA, cfgA, depsA);
  expect(await git(W, "rev-parse", "feat")).toBe(await git(bw, "rev-parse", "feat"));
  expect(logsA.some((l) => l.startsWith("git-sync applied wt"))).toBe(true);

  // Convergence: one settling round, then TWO quiescent cycles make ZERO new commits.
  await syncCycle();
  const head = remote.headSeq();
  const calls = remote.commitCalls;
  await syncCycle();
  await syncCycle();
  expect(remote.headSeq()).toBe(head); // no capture ping-pong across scope crossings
  expect(remote.commitCalls).toBe(calls); // not even attempted commits
}, 30_000);

test("root repo '.' still syncs end-to-end (pre-§43 behavior preserved)", async () => {
  await initRepo(rootA);
  await commitFile(rootA, "f.txt", "root-repo", "c1");
  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {})).toEqual(["."]);
  await pull(rootB, cfgB, depsB);
  expect(await git(rootB, "rev-parse", "main")).toBe(await git(rootA, "rev-parse", "main"));
  // quiescent: no echo
  const head = remote.headSeq();
  await syncCycle();
  expect(remote.headSeq()).toBe(head);
});

// ── design 68 §3.3: in-tree linked-worktree pointer skip (base-carry) ──────────────

test("design 68 V6: an in-tree linked-worktree pointer is SKIPPED — its history rides the main clone's bundle; no removal memory, no echo", async () => {
  const { M } = await makeInTreeMainWithWorktree();

  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {})).toEqual(["main"]); // wt NOT captured — travels with the main clone
  expect(m.gitRepos!["main"]!.refScope).toBe("all");
  expect(logsA.some((l) => l.includes("skipped 1") && l.includes("wt"))).toBe(true);
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined(); // base-carry never stamps removal memory

  // the worktree's committed branch rides the main clone's --single-worktree --all bundle (V4)
  await pull(rootB, cfgB, depsB);
  expect(await git(path.join(rootB, "main"), "rev-parse", "feat")).toBe(await git(M, "rev-parse", "feat"));
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();

  // steady state: skip is a carry → zero echo commits
  const head = remote.headSeq();
  await syncCycle();
  await syncCycle();
  expect(remote.headSeq()).toBe(head);
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined();
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();
}, 20_000);

test("design 68 V11: a skip-eligible pointer with an EXISTING captured base is CARRIED unchanged, not dropped — no removal memory (mixed-version safe)", async () => {
  const { W } = await makeInTreeMainWithWorktree();

  // Seed a pre-existing captured base for wt, as an OLDER client (which captured pointer
  // worktrees and refused main clones, §6a) would have authored. Its artifacts live
  // server-side, so the carry's blobRef check passes.
  const wtSection = await captureGitState(W, remote.blobStore(), KEK);
  expect(wtSection!.refScope).toBe("scoped");
  const s0 = await st(rootA);
  await saveState(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection! } } });

  await push(rootA, cfgA, depsA);
  const m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["main", "wt"]); // wt CARRIED alongside the captured main clone
  expect(m.gitRepos!["wt"]!.bundleEncSha).toBe(wtSection!.bundleEncSha); // carried UNCHANGED — never re-captured
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined(); // M4: base-carry, never a removal-memory stamp
  expect(logsA.some((l) => l.includes("skipped") && l.includes("wt"))).toBe(true);

  // steady state: the carry echoes nothing (the section bytes are stable across cycles)
  const head = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(head);
  await pull(rootB, cfgB, depsB);
  expect((await st(rootA)).gitReposRemoved?.["wt"]).toBeUndefined();
  expect((await st(rootB)).gitReposRemoved?.["wt"]).toBeUndefined();
}, 20_000);

test("design 68 §3.3 + 422: a forced skip-eligible pointer recaptures instead of carrying a missing base blob", async () => {
  const { W } = await makeInTreeMainWithWorktree();

  const wtSection = await captureGitState(W, remote.blobStore(), KEK);
  expect(wtSection!.refScope).toBe("scoped");
  const s0 = await st(rootA);
  await saveState(rootA, { ...s0, lastSyncedManifest: { ...s0.lastSyncedManifest, manifestSchema: 2, gitRepos: { wt: wtSection! } } });

  remote.deleteBlob(wtSection!.bundleEncSha); // first attempt 422s on the carried pointer base
  await fs.writeFile(path.join(rootA, "note.txt"), "forces a commit\n");
  const events: Array<{ phase: string; detail?: string }> = [];
  await push(rootA, cfgA, { ...depsA, onProgress: (_done, _total, phase, detail) => events.push({ phase, detail }) });

  const m = (await remote.latest()).manifest;
  expect(m.files.some((f) => f.path === "note.txt")).toBe(true);
  expect(m.gitRepos?.["wt"]).toBeDefined();
  expect(events.some((e) => e.phase === "gitcap" && e.detail === "wt")).toBe(true); // forced rel was captured, not skip-carried
  await expect(remote.blobStore().get(m.gitRepos!["wt"]!.bundleEncSha)).resolves.toBeDefined();
}, 20_000);

// ── (b) churn: per-repo capture failure defers with base carry, push proceeds ────

test("a repo whose capture fails mid-push is DEFERRED with base carry; the push commits everything else", async () => {
  const r1 = path.join(rootA, "r1");
  const r2 = path.join(rootA, "r2");
  await initRepo(r1);
  await commitFile(r1, "a.txt", "a1", "c1");
  await initRepo(r2);
  await commitFile(r2, "b.txt", "b1", "c1");
  await push(rootA, cfgA, depsA);
  const base2 = (await st(rootA)).lastSyncedManifest.gitRepos!["r2"]!;

  // ONLY r2 changes (so the failing PUT deterministically hits r2's capture) plus an
  // unrelated file change so the push has something stable to commit.
  await commitFile(r2, "b.txt", "b2", "c2");
  await fs.writeFile(path.join(rootA, "note.txt"), "stable");
  remote.failNextGitPut = true;

  const seqBefore = remote.headSeq();
  await push(rootA, cfgA, depsA);
  expect(remote.headSeq()).toBe(seqBefore + 1); // push proceeded (r2's failure did not abort)
  const m = (await remote.latest()).manifest;
  expect(m.files.some((f) => f.path === "note.txt")).toBe(true); // stable subset committed
  expect(m.gitRepos!["r2"]!.bundleEncSha).toBe(base2.bundleEncSha); // base carried, not regressed
  expect(m.gitRepos!["r1"]!.bundleEncSha).toBe((await st(rootA)).lastSyncedManifest.gitRepos!["r1"]!.bundleEncSha); // r1 untouched carry
  expect(logsA.some((l) => l.includes("deferred 1") && l.includes("r2"))).toBe(true);

  // next push (nothing failing): r2 self-heals with a fresh capture
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r2"]!.bundleEncSha).not.toBe(base2.bundleEncSha);
}, 20_000);

test("push: a locked (busy) repo defers with base carry — no raw-identity capture while mid-operation", async () => {
  const r = path.join(rootA, "r");
  await initRepo(r);
  await commitFile(r, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const base = (await st(rootA)).lastSyncedManifest.gitRepos!["r"]!;

  await commitFile(r, "f.txt", "v2", "c2");
  await fs.writeFile(path.join(r, ".git", "index.lock"), ""); // repo is mid-operation
  await fs.writeFile(path.join(rootA, "x.txt"), "x");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(base.bundleEncSha); // base carried
  expect(logsA.some((l) => l.includes("r: git busy"))).toBe(true);

  await fs.rm(path.join(r, ".git", "index.lock"));
  await push(rootA, cfgA, depsA); // quiesced → captures v2
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).not.toBe(base.bundleEncSha);
}, 20_000);

test("repo dir GONE ENTIRELY → pusher drops the section (§9); receiver drops base, records removal memory, never touches local .git", async () => {
  const r = path.join(rootA, "gone");
  await initRepo(r);
  await commitFile(r, "f.txt", "x", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const bHead = await git(path.join(rootB, "gone"), "rev-parse", "HEAD");

  await fs.rm(r, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined(); // dropped
  expect(logsA.some((l) => l.includes("removed 1"))).toBe(true);

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base entry dropped
  expect(sB.gitReposRemoved?.["gone"]).toBeDefined(); // removal memory recorded
  expect(await git(path.join(rootB, "gone"), "rev-parse", "HEAD")).toBe(bHead); // local .git untouched

  // resurrection guard: B's next push does NOT re-add the untouched leftover
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head); // no-op — no resurrection ping-pong
});

// ── (c) design §13.5 pending tests ────────────────────────────────────────────────

/** Sync a repo to both machines, advance it on A, then make B's pull DEFER the apply
 *  (index.lock = receiver busy) so `gitPendingRemote` is recorded. Returns repo paths. */
async function makePending(rel: string): Promise<{ a: string; b: string; lock: string }> {
  const a = path.join(rootA, rel);
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B based at v1
  await commitFile(a, "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);
  const b = path.join(rootB, rel);
  const lock = path.join(b, ".git", "index.lock");
  await fs.writeFile(lock, "");
  await pull(rootB, cfgB, depsB); // apply defers: receiver git busy → pending v2
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.[rel]).toBeDefined();
  expect(logsB.some((l) => l.startsWith(`git-sync deferred ${rel}`))).toBe(true);
  return { a, b, lock };
}

test("pending: outbound pushes CARRY the pending section (never the stale base) and the base does not advance [v5]", async () => {
  const { b, lock } = await makePending("r");
  const sB = await st(rootB);
  const pendingSec = sB.gitPendingRemote!["r"]!;
  expect(sB.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).not.toBe(pendingSec.bundleEncSha); // base stayed v1

  // a steady pending carry alone is NOT a change — no echo commit
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head);

  // an unrelated file push CARRIES the pending section outbound, base still v1
  await fs.writeFile(path.join(rootB, "unrelated.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(pendingSec.bundleEncSha);
  const sB2 = await st(rootB);
  expect(sB2.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).not.toBe(pendingSec.bundleEncSha); // per-repo base advance withheld
  expect(sB2.gitPendingRemote?.["r"]).toBeDefined();

  // lock released → the next pull retries and applies; pending clears; base advances
  await fs.rm(lock);
  await pull(rootB, cfgB, depsB);
  const sB3 = await st(rootB);
  expect(sB3.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB3.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).toBe(pendingSec.bundleEncSha);
  expect(await fs.readFile(path.join(b, "f.txt"), "utf8")).toBe("v2");
}, 20_000);

test("pending + remote deletion: absence supersedes pending [v6] — pending cleared, removal memory recorded, no outbound resurrection", async () => {
  const { a, b, lock } = await makePending("r");
  await fs.rm(lock);
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // A deletes the repo

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // absence supersedes pending
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base dropped
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // leftover memory
  await expect(git(b, "rev-parse", "HEAD")).resolves.toBeDefined(); // local .git survives (at v1)

  // B's next push must NOT resurrect the repo A just deleted (no pending carry, no re-add)
  await fs.writeFile(path.join(rootB, "unrelated.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined();
}, 20_000);

test("pending-ONLY (never based) deletion: remote absence clears the pending entry cleanly", async () => {
  // A pushes a repo; B's target is a fresh EMPTY repo holding an index.lock → the
  // materialization defers → pending with NO base entry.
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const b = path.join(rootB, "r");
  await initRepo(b); // empty local repo (no commits) — a clean apply target, but busy:
  await fs.writeFile(path.join(b, ".git", "index.lock"), "");
  await pull(rootB, cfgB, depsB);
  let sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeDefined();
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // pending-only: never based

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // remote deletes the repo
  await fs.rm(path.join(b, ".git", "index.lock")); // repo quiesces — the removal can now be examined
  await pull(rootB, cfgB, depsB);
  sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // cleared — pending-only repos see absence too
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // the leftover empty .git is remembered
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head); // and never re-added
}, 20_000);

test("pending + 422: M5 non-looping drop — section dropped from THIS commit, pending kept for the next pull [v6]", async () => {
  const { lock } = await makePending("r");
  await fs.rm(lock);
  const sB = await st(rootB);
  const pendingSec = sB.gitPendingRemote!["r"]!;
  remote.deleteBlob(pendingSec.bundleEncSha); // server-side GC of the pending section's bundle

  await fs.writeFile(path.join(rootB, "x.txt"), "x");
  const res = await pushManifest(rootB, cfgB, await scanManifest(rootB, undefined, undefined), depsB);
  expect(res.sequence).toBe(remote.headSeq()); // the push SUCCEEDED (no 422 loop)
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeUndefined(); // dropped from this commit
  expect((await remote.latest()).manifest.files.some((f) => f.path === "x.txt")).toBe(true);
  const sB2 = await st(rootB);
  expect(sB2.gitPendingRemote?.["r"]).toBeDefined(); // pending left in place for the next pull
  expect(sB2.lastSyncedManifest.gitRepos!["r"]).toBeDefined(); // per-repo base kept the OLD entry

  // the next pull sees the (now-absent) repo and resolves via absence-supersedes
  await pull(rootB, cfgB, depsB);
  const sB3 = await st(rootB);
  expect(sB3.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB3.gitReposRemoved?.["r"]).toBeDefined();
}, 20_000);

test("pending + remote deletion while the repo is BUSY: absence still supersedes pending — no resurrection through pending or base", async () => {
  const { a, b } = await makePending("r"); // index.lock still held on B
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // A deletes the repo

  await pull(rootB, cfgB, depsB); // B's copy is BUSY — absence must still be processed
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // [v6] absence supersedes pending, even busy
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base dropped
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // lock-immune memory (base identity)

  // outbound file push while still busy: neither pending nor base resurrects the repo
  await fs.writeFile(path.join(rootB, "u.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined();

  // once quiesced, the unchanged leftover STILL doesn't re-add (memory matches live identity)
  await fs.rm(path.join(b, ".git", "index.lock"));
  await fs.writeFile(path.join(rootB, "u2.txt"), "y");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined();
  await expect(git(b, "rev-parse", "HEAD")).resolves.toBeDefined(); // local .git never touched
}, 20_000);

test("deleting a leftover .git prunes its removal memory even on a NO-OP push; an identical re-create then re-adds (§9)", async () => {
  const DATE = "2026-01-01T00:00:00 +0000"; // fixed dates → the re-create has the SAME identity
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "same", "c1", DATE);
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // memory recorded on B, leftover intact
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();

  // B deletes the leftover .git — no synced file changes → EXACTLY a no-op push,
  // which must still persist the §9 memory prune ("pruned when .git disappears").
  await fs.rm(path.join(rootB, "r"), { recursive: true, force: true });
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head); // no commit burned
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeUndefined(); // memory pruned anyway

  // B re-creates an IDENTICAL repo: a stale memory would suppress this legitimate re-add.
  const b = path.join(rootB, "r");
  await initRepo(b);
  await commitFile(b, "f.txt", "same", "c1", DATE);
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeDefined(); // re-added
}, 20_000);

test("absence supersedes pending even when the conflict preserve FAILS (crash-safe — no stale pending to resurrect)", async () => {
  const { a, b, lock } = await makePending("r");
  await fs.rm(lock);
  await commitFile(b, "g.txt", "local-work", "b c1"); // local diverges while pending
  const pendSec = (await st(rootB)).gitPendingRemote!["r"]!;
  const localHead = await git(b, "rev-parse", "HEAD");
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // remote deletes the repo
  remote.deleteBlob(pendSec.bundleEncSha); // the preserve's bundle fetch will now throw

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined(); // cleared DESPITE the preserve failure
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined(); // base dropped
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // guard stamped after the divergence was examined
  expect(logsB.some((l) => l.includes("WARNING r") && l.includes("preserve"))).toBe(true); // loud
  expect(await git(b, "rev-parse", "HEAD")).toBe(localHead); // local work untouched

  await fs.writeFile(path.join(rootB, "u.txt"), "x");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined(); // v6 class stays closed
}, 20_000);

test("pending + LOCAL divergence + remote deletion: conflict path wins FIRST, then removal memory (§13.5)", async () => {
  const { a, b, lock } = await makePending("r");
  await fs.rm(lock);
  // local diverges from base while the remote section is still pending
  await commitFile(b, "g.txt", "local-work", "b c1");
  const localHead = await git(b, "rev-parse", "HEAD");
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA); // remote deletes the repo

  await pull(rootB, cfgB, depsB);
  // conflict path preserved the PENDING remote section for recovery — local kept
  expect(await git(b, "rev-parse", "HEAD")).toBe(localHead);
  const conflicts = await fs.readdir(path.join(b, ".rbox", "git-conflicts"));
  expect(conflicts.some((f) => f.endsWith(".bundle"))).toBe(true);
  expect(logsB.some((l) => l.includes("CONFLICT r") && l.includes("pending"))).toBe(true);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // memory stamped AFTER the conflict was preserved
  expect(sB.lastSyncedManifest.gitRepos).toBeUndefined();

  // identity unchanged since the memory → the repo is NOT re-added (only files sync)
  await push(rootB, cfgB, depsB); // g.txt (the working file) may sync — git must not
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeUndefined();
  // NEW work after the memory was stamped → re-adding is intentional
  await commitFile(b, "h.txt", "newer-work", "b c2");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos?.["r"]).toBeDefined(); // intentional re-add
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeUndefined(); // memory cleared
}, 20_000);

// ── (d) removal memory: fresh re-create at the same path = CLEAN materialization ──

test("fresh re-create at a removed path: dir leftover is QUARANTINED then wiped, fresh state applies, memory clears", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "old c1");
  await git(a, "branch", "leftover-branch");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  const oldHead = await git(b, "rev-parse", "HEAD");

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B: base dropped, memory recorded, leftover intact
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();
  expect(await git(b, "rev-parse", "HEAD")).toBe(oldHead);

  // A creates a brand-NEW repo at the same path and pushes it
  await initRepo(a);
  await commitFile(a, "n.txt", "new", "new c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  // clean materialization: quarantine exists, old refs are GONE, new state applied
  const qDir = path.join(b, ".rbox", "git-quarantine");
  const qFiles = await fs.readdir(qDir);
  expect(qFiles.some((f) => f.endsWith(".bundle"))).toBe(true); // full recovery quarantined
  expect(await git(b, "rev-parse", "main")).toBe(await git(a, "rev-parse", "main"));
  await expect(git(b, "rev-parse", "--verify", "leftover-branch")).rejects.toThrow(); // wiped — no side-door resurrection
  const sB = await st(rootB);
  expect(sB.gitReposRemoved?.["r"]).toBeUndefined(); // memory cleared
  expect(sB.lastSyncedManifest.gitRepos?.["r"]).toBeDefined(); // based again
}, 20_000);

test("clean materialization with a ref-wiping hook defers before stranding a sibling worktree branch", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "old c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  await git(b, "branch", "sibling");
  const siblingWt = path.join(tmp, "b-r-sibling");
  await git(b, "worktree", "add", siblingWt, "sibling");
  const siblingSha = await git(b, "rev-parse", "sibling");

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B: removal memory recorded over the dir leftover
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();

  const mainA = path.join(tmp, "a-main-for-r");
  await initRepo(mainA);
  await commitFile(mainA, "base.txt", "base", "main c1");
  await git(mainA, "worktree", "add", a, "-b", "feat");
  await commitFile(a, "feat.txt", "new", "feat c1");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.refScope).toBe("scoped");

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeDefined(); // whole section deferred
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // memory kept; hook did not run
  expect(logsB.some((l) => l.includes("r") && l.includes("would be wiped"))).toBe(true);
  expect(await git(b, "rev-parse", "sibling")).toBe(siblingSha);
  expect(await git(siblingWt, "rev-parse", "HEAD")).toBe(siblingSha);
  expect(await fs.readdir(path.join(b, ".rbox", "git-quarantine")).catch(() => [])).toEqual([]);
}, 20_000);

test("clean materialization with a ref-wiping hook still applies when no sibling worktree owns the wiped refs", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "old c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  await git(b, "branch", "sibling"); // local syncable ref, but not checked out in a linked worktree

  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  expect((await st(rootB)).gitReposRemoved?.["r"]).toBeDefined();

  const mainA = path.join(tmp, "a-main-for-r");
  await initRepo(mainA);
  await commitFile(mainA, "base.txt", "base", "main c1");
  await git(mainA, "worktree", "add", a, "-b", "feat");
  await commitFile(a, "feat.txt", "new", "feat c1");
  await push(rootA, cfgA, depsA);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.refScope).toBe("scoped");

  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined();
  expect(sB.gitReposRemoved?.["r"]).toBeUndefined();
  expect(await git(b, "symbolic-ref", "HEAD")).toBe("refs/heads/feat");
  await expect(git(b, "rev-parse", "--verify", "sibling")).rejects.toThrow(); // wiped by clean materialization
  const qFiles = await fs.readdir(path.join(b, ".rbox", "git-quarantine"));
  expect(qFiles.some((f) => f.endsWith(".bundle"))).toBe(true);
}, 20_000);

test("clean materialization wipes ONLY after artifacts verify — a missing bundle leaves the leftover intact", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "old", "c1");
  await git(a, "branch", "leftover-branch");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  const b = path.join(rootB, "r");
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // memory recorded, leftover intact

  // A re-creates a fresh repo at the same path; the server then LOSES its bundle
  await initRepo(a);
  await commitFile(a, "n.txt", "new", "n1");
  await push(rootA, cfgA, depsA);
  const newSec = (await remote.latest()).manifest.gitRepos!["r"]!;
  const saved = await remote.blobStore().get(newSec.bundleEncSha);
  remote.deleteBlob(newSec.bundleEncSha);

  await pull(rootB, cfgB, depsB); // fetch fails → the wipe must never have run
  expect(await git(b, "rev-parse", "--verify", "leftover-branch")).toBeTruthy(); // NOT wiped
  expect(await fs.readdir(path.join(b, ".rbox", "git-quarantine")).catch(() => [])).toEqual([]); // no quarantine cut
  let sB = await st(rootB);
  expect(sB.gitReposRemoved?.["r"]).toBeDefined(); // resurrection guard kept
  expect(sB.gitPendingRemote?.["r"]).toBeDefined(); // deferred for retry

  // the blob returns → the clean materialization completes on the next pull
  await remote.blobStore().put(newSec.bundleEncSha, saved);
  await pull(rootB, cfgB, depsB);
  expect(await git(b, "rev-parse", "main")).toBe(await git(a, "rev-parse", "main"));
  await expect(git(b, "rev-parse", "--verify", "leftover-branch")).rejects.toThrow(); // wiped post-verify
  sB = await st(rootB);
  expect(sB.gitReposRemoved?.["r"]).toBeUndefined();
  expect(sB.gitPendingRemote?.["r"]).toBeUndefined();
}, 20_000);

test("an ignored-but-present leftover keeps its removal memory (guard survives being undiscoverable)", async () => {
  const a = path.join(rootA, "gone");
  await initRepo(a);
  await commitFile(a, "f.txt", "x", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await fs.rm(a, { recursive: true, force: true });
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB); // B: memory recorded, leftover .git intact

  // B now ignores the leftover's subtree — discovery can't see it, but the guard must survive
  await fs.writeFile(path.join(rootB, ".rboxignore"), "gone/\n");
  await fs.writeFile(path.join(rootB, "z.txt"), "z");
  await push(rootB, cfgB, depsB);
  expect((await st(rootB)).gitReposRemoved?.["gone"]).toBeDefined(); // NOT pruned
  expect((await remote.latest()).manifest.gitRepos).toBeUndefined(); // and nothing resurrected
}, 20_000);

// ── (e) cap semantics [v2, M4] ─────────────────────────────────────────────────────

test("cap: new repos beyond the cap are deferred LOUDLY; base-carrying repos always carry AND still capture", async () => {
  process.env.RBOX_GIT_REPO_CAP = "2";
  for (const r of ["ra", "rb", "rc"]) {
    const d = path.join(rootA, r);
    await initRepo(d);
    await commitFile(d, "f.txt", r, "c1");
  }
  await push(rootA, cfgA, depsA);
  let m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["ra", "rb"]); // first 2 admitted
  expect(logsA.some((l) => l.includes("rc") && l.includes("cap"))).toBe(true);

  // based repos are never cap-throttled: with cap=1, a CHANGED based repo still captures
  process.env.RBOX_GIT_REPO_CAP = "1";
  const oldRa = m.gitRepos!["ra"]!.bundleEncSha;
  await commitFile(path.join(rootA, "ra"), "f.txt", "ra2", "c2");
  await push(rootA, cfgA, depsA);
  m = (await remote.latest()).manifest;
  expect(Object.keys(m.gitRepos ?? {}).sort()).toEqual(["ra", "rb"]); // carry never drops
  expect(m.gitRepos!["ra"]!.bundleEncSha).not.toBe(oldRa); // based repo captured over the cap
  // rc stays deferred until the cap allows admission
  delete process.env.RBOX_GIT_REPO_CAP;
  await push(rootA, cfgA, depsA);
  expect(Object.keys((await remote.latest()).manifest.gitRepos ?? {}).sort()).toEqual(["ra", "rb", "rc"]);
}, 20_000);

// ── needs-resolution conflict suppression [v2, M2] ─────────────────────────────────

test("per-repo conflict: remote preserved, base checkpointed, capture SUPPRESSED until local identity changes", async () => {
  const a = path.join(rootA, "r");
  await initRepo(a);
  await commitFile(a, "f.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);

  // both sides diverge
  await commitFile(a, "f.txt", "a-side", "a c2");
  const b = path.join(rootB, "r");
  await git(b, "config", "user.email", "t@t.t");
  await git(b, "config", "user.name", "t");
  await commitFile(b, "g.txt", "b-side", "b c2");
  const bHead = await git(b, "rev-parse", "HEAD");
  await push(rootA, cfgA, depsA);

  await pull(rootB, cfgB, depsB);
  expect(await git(b, "rev-parse", "HEAD")).toBe(bHead); // local never clobbered
  expect(logsB.some((l) => l.includes("CONFLICT r"))).toBe(true);
  const sB = await st(rootB);
  expect(sB.gitNeedsResolution?.["r"]).toBeDefined();
  expect(sB.lastSyncedManifest.gitRepos!["r"]!.bundleEncSha).toBe((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha); // checkpointed to remote
  const refs = await git(b, "for-each-ref", "--format=%(refname)", "refs/rbox-conflict");
  expect(refs.length).toBeGreaterThan(0); // remote preserved for manual merge

  // sync()'s immediate push-after-pull must NOT republish the conflicted local state:
  // the git section stays the checkpointed remote (files like g.txt may still sync)
  const remoteSec = (await remote.latest()).manifest.gitRepos!["r"]!;
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).toBe(remoteSec.bundleEncSha);
  // and with files settled, the next push is a full no-op
  const head = remote.headSeq();
  await push(rootB, cfgB, depsB);
  expect(remote.headSeq()).toBe(head);

  // the user resolves (identity changes) → republishing becomes intentional
  await commitFile(b, "f.txt", "merged", "b merge");
  await push(rootB, cfgB, depsB);
  expect((await remote.latest()).manifest.gitRepos!["r"]!.bundleEncSha).not.toBe(remoteSec.bundleEncSha);
  expect((await st(rootB)).gitNeedsResolution?.["r"]).toBeUndefined();
}, 20_000);

// ── per-repo independence: one busy repo defers only itself ────────────────────────

test("one busy repo defers only itself; every other repo's base advances independently", async () => {
  for (const r of ["r1", "r2"]) {
    const d = path.join(rootA, r);
    await initRepo(d);
    await commitFile(d, "f.txt", "v1", "c1");
  }
  await push(rootA, cfgA, depsA);
  await pull(rootB, cfgB, depsB);
  await commitFile(path.join(rootA, "r1"), "f.txt", "v2", "c2");
  await commitFile(path.join(rootA, "r2"), "f.txt", "v2", "c2");
  await push(rootA, cfgA, depsA);

  await fs.writeFile(path.join(rootB, "r1", ".git", "index.lock"), ""); // r1 busy on B
  await pull(rootB, cfgB, depsB);
  const sB = await st(rootB);
  expect(sB.gitPendingRemote?.["r1"]).toBeDefined(); // deferred
  expect(sB.gitPendingRemote?.["r2"]).toBeUndefined(); // applied
  expect(await git(path.join(rootB, "r2"), "rev-parse", "main")).toBe(await git(path.join(rootA, "r2"), "rev-parse", "main"));
}, 20_000);

// ── live-validation finding (design 43 §14 v6.1): shallow clones ─────────────────

test("structural preflight refusal (shallow clone): section DROPPED, not carried — never poisons receivers", async () => {
  // Live validation caught this: `bundle --all` from a SHALLOW clone silently omits
  // parents beyond the shallow boundary; receivers fail-close on every apply, forever,
  // because identity can't see shallowness. Structural refusals must DROP the section.
  const origin = path.join(tmp, "shallow-origin");
  await initRepo(origin);
  await commitFile(origin, "s.txt", "1", "c1");
  await commitFile(origin, "s.txt", "2", "c2");

  const p = path.join(rootA, "sh");
  await initRepo(p);
  await commitFile(p, "x.txt", "x", "c1");
  await push(rootA, cfgA, depsA); // full repo → section captured into base
  expect((await st(rootA)).lastSyncedManifest.gitRepos?.["sh"]).toBeDefined();

  // Swap in a SHALLOW clone at the same path — simulating a base section whose repo
  // is now structurally unsyncable (the exact shape the old client authored live).
  await fs.rm(p, { recursive: true, force: true });
  await exec("git", ["clone", "-q", "--depth", "1", `file://${origin}`, p]);

  // Design 45 (codex R2): the pending structural DROP is an unpublished change —
  // status must not read "in sync" while the next push would commit a removal.
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), buildIgnoreMatcher(rootA))).toBe(1);

  await push(rootA, cfgA, depsA);
  const state = await st(rootA);
  expect(state.lastSyncedManifest.gitRepos?.["sh"]).toBeUndefined(); // dropped, not carried
  expect(logsA.some((l) => l.includes("shallow clone"))).toBe(true); // loud, with the un-shallow hint
  // …and once the drop is published, the still-shallow repo is no longer pending work.
  expect(await gitDivergenceCount(rootA, cfgA, state, buildIgnoreMatcher(rootA))).toBe(0);
});

// ── design 45: the status verdict's advisory git-divergence walk ─────────────────

test("gitDivergenceCount mirrors push's capture decision (read-only, no state mutation)", async () => {
  const p1 = path.join(rootA, "proj1");
  await initRepo(p1);
  await commitFile(p1, "a.txt", "v1", "c1");
  const matcher = buildIgnoreMatcher(rootA);

  // Never-synced local repo → a push would publish it.
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
  // …and the walk itself must not have created/advanced any sync state.
  expect((await st(rootA)).lastSyncedSequence).toBe(0);

  // Push, then identity matches base → in sync.
  await push(rootA, cfgA, depsA);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);

  // A fresh local commit diverges the identity while the base stands → 1
  // (codex R1: a clean file tree + unpushed git state must not read "in sync").
  await commitFile(p1, "b.txt", "v2", "c2");
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
  await push(rootA, cfgA, depsA);
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);

  // git-sync off → the dimension is simply absent.
  expect(await gitDivergenceCount(rootA, { ...cfgA, syncGit: false }, await st(rootA), matcher)).toBe(0);
});

test("gitDivergenceCount honors needsResolution suppression before preflight (codex R4)", async () => {
  const p1 = path.join(rootA, "proj1");
  await initRepo(p1);
  await commitFile(p1, "a.txt", "v1", "c1");
  await push(rootA, cfgA, depsA);
  const matcher = buildIgnoreMatcher(rootA);

  // Diverge locally → pending work…
  await commitFile(p1, "b.txt", "v2", "c2");
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);

  // …until a conflict checkpoint suppresses it: push CARRIES the base while the
  // identity equals the recorded conflict-time value, so status must read 0 —
  // and the suppression must be honored BEFORE preflight, matching the planner.
  const state = await st(rootA);
  await saveState(rootA, { ...state, gitNeedsResolution: { proj1: gitIdentityKey(await gitIdentity(p1)) } });
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(0);

  // The user touches the repo → identity leaves the checkpoint → republish is
  // intentional and the divergence shows again.
  await commitFile(p1, "c.txt", "v3", "c3");
  expect(await gitDivergenceCount(rootA, cfgA, await st(rootA), matcher)).toBe(1);
});

// ── gitcap progress (the long silent phase on a repo-heavy first push) ───────────

test("push emits gitcap progress per CAPTURED repo — monotonic settle count, repo names as detail, capture-scoped total", async () => {
  const alpha = path.join(rootA, "alpha");
  await initRepo(alpha);
  await commitFile(alpha, "a.txt", "a", "c1");
  const beta = path.join(rootA, "sub", "beta");
  await initRepo(beta);
  await commitFile(beta, "b.txt", "b", "c1");

  type Ev = { done: number; total: number; detail?: string };
  const cap = (): { events: Ev[]; deps: SyncDeps } => {
    const events: Ev[] = [];
    return {
      events,
      deps: { ...depsA, onProgress: (done, total, phase, detail) => phase === "gitcap" && events.push({ done, total, detail }) },
    };
  };

  const first = cap();
  await push(rootA, cfgA, first.deps);
  // One event per repo that was actually captured (both are new).
  expect(first.events.length).toBe(2);
  // Total is the CAPTURE set, not every discovered repo, and stays fixed across the run.
  expect(first.events.every((e) => e.total === 2)).toBe(true);
  // `done` is a monotonic completed-count under bounded concurrency → 1 then 2.
  expect(first.events.map((e) => e.done).sort((x, y) => x - y)).toEqual([1, 2]);
  // Detail is the repo basename (a nested repo shows its own name, not the path).
  expect(new Set(first.events.map((e) => e.detail))).toEqual(new Set(["alpha", "beta"]));

  // A second push with nothing changed CARRIES both repos (no capture) → zero gitcap
  // events. Proves the denominator is capture-scoped, not repo-count-scoped.
  const second = cap();
  await push(rootA, cfgA, second.deps);
  expect(second.events.length).toBe(0);
});
