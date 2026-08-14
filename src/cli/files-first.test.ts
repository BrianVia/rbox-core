// Design 108 — files-first first publish (flag-gated, default OFF).
//
// Uses the design-43 git-sync FakeRemote pattern (commit() enforces every gitRepos
// artifact blob is present, exactly as the §28 server does) so "git attached" and
// "git NOT attached" are both directly asserted from committed manifests. E2EE is the
// only mode: the server stores CIPHERTEXT by encSha; manifests are the plaintext view.
import { test as bunTest, expect, beforeEach, afterEach } from "bun:test";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { filesFirstFlagEnabled, push, type SyncDeps } from "./sync.js";
import { loadState, saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "./config.js";
import { BlobShaMismatchError, type CommitResult, type SyncRemote } from "./remote.js";
import { PhaseReport, gitSectionBlobRefs, type BlobStore, type FileEntry, type Manifest } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { firstPublishTiming } from "./upload-lane-timing.js";

const exec = promisify(execFile);
const git = (dir: string, ...args: string[]) => exec("git", ["-C", dir, ...args]).then((r) => r.stdout.toString().trim());
const test = (name: string, fn: () => unknown | Promise<unknown>, timeout = 20_000) => bunTest(name, fn, timeout);

const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

const STREAM = "http://x::ws_ff::root";

class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  commitCalls = 0;
  gitPutCalls = 0;
  /** File-blob PUT churn: a file whose encSha matches keeps hash-mismatching, so the
   *  per-file upload budget exhausts and the file DEFERS out of the commit. */
  forceFileShaMismatchAlways?: string;

  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.log.set(this.head, { generatedAt: "", files });
  }
  headSeq(): number {
    return this.head;
  }
  manifestAt(seq: number): Manifest | undefined {
    return this.log.get(seq);
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    if (this.forceFileShaMismatchAlways === sha256) throw new BlobShaMismatchError(sha256);
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
      for (const ref of gitSectionBlobRefs(g)) if (!this.blobs.has(ref.encSha)) missing.add(ref.encSha);
    }
    if (missing.size > 0) return { unsatisfiedBlobs: [...missing] };
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const self = this;
    return {
      async has(s) { return self.blobs.has(s); },
      async put(s, bytes) { self.blobs.set(s, Buffer.from(bytes)); },
      async get(s) { const b = self.blobs.get(s); if (!b) throw new Error(`blob missing: ${s}`); return b; },
      async getToFile(s, dest) { const b = self.blobs.get(s); if (!b) throw new Error(`blob missing: ${s}`); await fs.mkdir(path.dirname(dest), { recursive: true }); await fs.writeFile(dest, b); },
      async putFile(s, src, size, _uploadsDir, onBytes) { self.gitPutCalls += 1; self.blobs.set(s, await fs.readFile(src)); onBytes?.(size ?? 0); },
    };
  }
}

let root: string;
let remote: FakeRemote;
let cfg: WorkspaceConfig;
let deps: SyncDeps;
let savedFlag: string | undefined;
const noBackoff = async () => {};

beforeEach(async () => {
  savedFlag = process.env.RBOX_FILES_FIRST;
  // Explicit kill switch: tests that don't opt in with "1" exercise the legacy path.
  // (The production default is ON — pinned by the dedicated default test below.)
  process.env.RBOX_FILES_FIRST = "0";
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-ff-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  remote = new FakeRemote();
  cfg = {
    remoteWorkspaceId: "ws_ff", projectId: "root", deviceId: "devA", rootPath: root,
    remoteUrl: "http://x", token: "", syncGit: true, encrypted: true, kek: KEK,
    accountId: "acct_ff", accountEpoch: 0, keyEpoch: 0,
  };
  deps = { remote, backoff: noBackoff, onGitLog: () => {} };
});
afterEach(async () => {
  if (savedFlag === undefined) delete process.env.RBOX_FILES_FIRST;
  else process.env.RBOX_FILES_FIRST = savedFlag;
  await fs.rm(root, { recursive: true, force: true });
});

/** A git repo `repo/` with one commit (so it has capturable history) plus its working
 *  file, which rbox also scans as a plain file entry `repo/a.txt`. Genesis on this tree
 *  therefore has BOTH a real file diff AND git to attach — the files-first case. */
async function repoWithFile(rel = "repo", file = "a.txt", content = "hello world"): Promise<void> {
  const dir = path.join(root, rel);
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-qb", "main");
  await git(dir, "config", "user.email", "t@t.t");
  await git(dir, "config", "user.name", "t");
  await fs.writeFile(path.join(dir, file), content);
  await git(dir, "add", file);
  await git(dir, "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "c1");
}
const st = () => loadState(root, STREAM);
const gitKeys = (m?: Manifest) => Object.keys(m?.gitRepos ?? {});

// ── 0. production default is ON; "0" is the kill switch ─────────────────────
test("files-first defaults ON with the env unset; =0 disables", () => {
  delete process.env.RBOX_FILES_FIRST;
  expect(filesFirstFlagEnabled()).toBe(true);
  process.env.RBOX_FILES_FIRST = "0";
  expect(filesFirstFlagEnabled()).toBe(false);
});

// ── 1. flag OFF: git captured inline (byte-identical legacy path) ───────────
test("flag OFF: genesis captures git INLINE at commit 1 (no files-first)", async () => {
  await repoWithFile();
  const observed: string[][] = [];
  deps.onGitReposDiscovered = async (repos) => { await Promise.resolve(); observed.push(repos.map((repo) => repo.relPath)); };
  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true);
  expect(r.gitDeferred).toBeFalsy();
  expect(r.sequence).toBe(1);
  expect(gitKeys(remote.manifestAt(1))).toEqual(["repo"]); // git in commit 1
  expect(remote.gitPutCalls).toBeGreaterThan(0);
  expect(observed).toEqual([["repo"]]);
});

// ── 2. genesis files-first fires: commit 1 files-only, commit 2 attaches git ─
test("flag ON genesis: commit 1 files-only, gitDeferred, commit 2 attaches git", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  const observed: string[][] = [];
  deps.onGitReposDiscovered = async (repos) => { await Promise.resolve(); observed.push(repos.map((repo) => repo.relPath)); };

  const r1 = await push(root, cfg, deps);
  expect(r1.committed).toBe(true);
  expect(r1.gitDeferred).toBe(true);
  expect(r1.sequence).toBe(1);
  const m1 = remote.manifestAt(1)!;
  expect(gitKeys(m1)).toEqual([]); // NO git in commit 1
  expect(m1.files.some((f) => f.path === "repo/a.txt")).toBe(true); // files present
  expect(remote.gitPutCalls).toBe(0); // no git blob uploaded during commit 1
  expect(observed).toEqual([["repo"]]); // genesis early-return site is observed and awaited

  const r2 = await push(root, cfg, deps);
  expect(r2.committed).toBe(true);
  expect(r2.gitDeferred).toBeFalsy();
  expect(r2.sequence).toBe(2);
  expect(gitKeys(remote.manifestAt(2))).toEqual(["repo"]); // git attached in commit 2
  expect(remote.gitPutCalls).toBeGreaterThan(0);
  expect(observed).toEqual([["repo"], ["repo"]]);
});

// ── 2b. syncGit workspace with NO repos: files-first does not signal a wasted commit 2 ─
test("flag ON genesis, files but NO git repo: commit 1 is terminal (gitDeferred falsy)", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await fs.writeFile(path.join(root, "plain.txt"), "just a file, no repo");
  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true);
  expect(r.gitDeferred).toBeFalsy(); // nothing owed → no commit 2
  expect(r.sequence).toBe(1);
});

// ── 3. files-must-diff guard: git-only workspace bypasses files-first ───────
test("flag ON but NO file diff (git-only): files-first bypassed, git-first single commit advances", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  await fs.rm(path.join(root, "repo", "a.txt")); // empty working tree; repo keeps its history

  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true);
  expect(r.gitDeferred).toBeFalsy(); // bypassed → ordinary git-first commit
  expect(r.sequence).toBe(1);
  expect(gitKeys(remote.manifestAt(1))).toEqual(["repo"]); // git in commit 1
  expect(remote.manifestAt(1)!.files.some((f) => f.path === "repo/a.txt")).toBe(false);
});

// ── 4. rebind excluded: a stream-mismatch state never files-first ───────────
test("flag ON but stream-mismatch refuses before files-first or git capture", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  // Design 138 makes every loadState mismatch a hard refusal. Only setup may
  // authorize the destructive rebind transaction.
  await saveStateUnsafeLegacyOrTest(root, {
    stream: "http://x::ws_OTHER::root",
    stateNonce: "a".repeat(32),
    stateRevision: 4,
    lastSyncedSequence: 5,
    lastSyncedManifest: { generatedAt: "", files: [] },
    repoRecords: {},
  });
  expect(syncStreamId(cfg)).toBe(STREAM); // sanity: our stream differs from the persisted one

  await expect(push(root, cfg, deps)).rejects.toThrow("refusing to reset local sync history without setup confirmation");
  expect(remote.manifestAt(1)).toBeUndefined();
});

// ── 5. starvation fallback: all files churn → fallback fires once, git attaches ─
test("flag ON, sole churning file: files-first commits nothing → fallback captures git (not starved)", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile("repo", "churn.txt", "unstable-content");
  // Force the sole file's blob PUT to permanently hash-mismatch → it defers every attempt.
  remote.forceFileShaMismatchAlways = (await enc("unstable-content")).encSha;

  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true); // git advanced the sequence via the fallback re-run
  expect(r.sequence).toBe(1);
  expect(gitKeys(remote.manifestAt(1))).toEqual(["repo"]); // git NOT starved — attached
  expect(remote.manifestAt(1)!.files.some((f) => f.path === "repo/churn.txt")).toBe(false); // file deferred
});

// ── 6. remote-head 409 on a genuine first-init: latch off, git captured on retry ─
test("flag ON genesis but remote head advanced: 409 latches files-first off, git inline on retry", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  remote.injectCommit([await remote.seedEntry("seed.txt", "seeded")]); // head = 1 already

  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true);
  expect(r.gitDeferred).toBeFalsy(); // 409 → pull-first → latch → git inline
  expect(gitKeys(remote.manifestAt(r.sequence))).toEqual(["repo"]);
});

// ── 7. timeToFilesSyncedMs: command-milestone start (before scan) is honored ─
test("timeToFilesSyncedMs uses deps.filesFirstStartedAt (pre-scan wall included)", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  const report = PhaseReport.push();
  deps.report = report;
  deps.filesFirstStartedAt = performance.now() - 5000; // simulate 5s of pre-commit wall
  await push(root, cfg, deps);
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  const summary = lines.join(" ");
  const m = summary.match(/filesSynced(\d+)/);
  expect(m).not.toBeNull();
  expect(Number(m![1])).toBeGreaterThanOrEqual(5000);
  expect(firstPublishTiming.enabled).toBe(false); // finalized + disabled
});

test("a no-op push renders NO FirstPublishStats", async () => {
  await repoWithFile();
  await push(root, cfg, deps); // commit 1 (flag off, inline)
  const report = PhaseReport.push();
  deps.report = report;
  const r = await push(root, cfg, deps); // nothing changed → no-op
  expect(r.committed).toBe(false);
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  expect(lines.join(" ")).not.toContain("filesSynced");
});

// ── 8. metric honesty: 409-then-success emits EXACTLY ONE FirstPublishStats ──
// (finalize only after admission+state-save, and render the
// headline timeToFilesSyncedMs on the successful attempt even though its retry
// re-uploaded nothing — the files DID sync, on the earlier 409'd attempt.) The FAILED
// attempt must render none and must not
// leak timing state into the next operation.
test("409-then-success emits exactly ONE FirstPublishStats (headline KPI) and leaves timing disabled", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  remote.injectCommit([await remote.seedEntry("seed.txt", "seeded")]); // forces a 409 on attempt 1
  const report = PhaseReport.push();
  deps.report = report;
  deps.filesFirstStartedAt = performance.now() - 1234; // command milestone survives the retry
  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true); // retry succeeds, git inline
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  const summary = lines.join(" ");
  const matches = summary.match(/filesSynced(\d+)/g) ?? [];
  expect(matches.length).toBe(1); // exactly one, on the successful attempt
  expect(Number(matches[0]!.replace("filesSynced", ""))).toBeGreaterThanOrEqual(1234); // milestone honored
  expect(firstPublishTiming.enabled).toBe(false);
});

test("a failed/no-upload push does not leak timing into a later unrelated push", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  await push(root, cfg, deps); // commit 1 (files-first)
  await push(root, cfg, deps); // commit 2 (git attach)
  // Timing must be disabled between pushes — no leaked operation state.
  expect(firstPublishTiming.enabled).toBe(false);
  const r = await push(root, cfg, deps); // no-op
  expect(r.committed).toBe(false);
  expect(firstPublishTiming.enabled).toBe(false);
});

// ── 9. steady-state unchanged: files-first inactive once seq >= 1 ───────────
test("steady push (seq>=1) captures git INLINE even with the flag on", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  await push(root, cfg, deps); // commit 1 files-first
  await push(root, cfg, deps); // commit 2 git attach → seq 2
  // A new git commit (steady change).
  await fs.writeFile(path.join(root, "repo", "b.txt"), "second");
  await git(path.join(root, "repo"), "add", "b.txt");
  await git(path.join(root, "repo"), "-c", "user.email=t@t.t", "-c", "user.name=t", "commit", "-qm", "c2");
  const r = await push(root, cfg, deps);
  expect(r.committed).toBe(true);
  expect(r.gitDeferred).toBeFalsy(); // appliedSequence !== 0 → never files-first
  expect(gitKeys(remote.manifestAt(r.sequence))).toEqual(["repo"]);
});

// ── 10. crash-safe: commit 1 leaves every git sidecar empty ─────────────────
test("after files-first commit 1, git sidecars and base gitRepos are empty (owed re-derived next push)", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  await push(root, cfg, deps);
  const state = await st();
  expect(state.lastSyncedSequence).toBe(1);
  expect(state.lastSyncedManifest.gitRepos ?? {}).toEqual({});
  expect(state.gitPendingRemote ?? {}).toEqual({});
  expect(state.gitReposRemoved ?? {}).toEqual({});
  expect(state.gitNeedsResolution ?? {}).toEqual({});
});

// ── 11. privacy: FirstPublishStats carries no path- or hash-shaped strings ──
test("FirstPublishStats line contains no path-shaped or 64-hex string (design 97)", async () => {
  process.env.RBOX_FILES_FIRST = "1";
  await repoWithFile();
  const report = PhaseReport.push();
  deps.report = report;
  deps.filesFirstStartedAt = performance.now();
  await push(root, cfg, deps);
  const lines: string[] = [];
  report.logSummaryTo((l) => lines.push(l));
  const fp = lines.join(" ").split(/\s+/).filter((tok) => tok.startsWith("filesSynced") || tok.startsWith("fp"));
  const summary = lines.join(" ");
  const fpSegment = summary.slice(summary.indexOf("fp "));
  expect(fpSegment).not.toMatch(/[0-9a-f]{64}/); // no ciphertext address / sha
  expect(fpSegment.replace(/http:\/\//g, "")).not.toMatch(/\/[A-Za-z0-9._-]+\//); // no path segment
  expect(fp.length).toBeGreaterThan(0);
});
