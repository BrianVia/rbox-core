import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pull, push, sync, type SyncDeps } from "./sync.js";
import type { WorkspaceConfig } from "./config.js";
import { loadState } from "./config.js";
import type { CommitResult, SyncRemote } from "./remote.js";
import type { BlobStore, Manifest } from "../engine/index.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/**
 * Stateful in-memory server simulator (design 09 §1) — mirrors the real
 * WorkspaceSync DO invariants: a monotonic head sequence, parent-sequence
 * conflict detection (409), and blob-existence validation at commit (422). It is
 * NOT a scripted mock; the tests assert against its real state so they fail when
 * the client's conflict-retry / base-advance / echo-storm logic regresses.
 */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>(); // seq → manifest
  private readonly blobs = new Map<string, Buffer>();
  commitCalls = 0;
  /** Each true in this queue makes the NEXT commit return one 422 (then is consumed). */
  forceUnsatisfiedOnce = false;
  /** Invoked just before a commit's parent check — lets a test advance the remote
   *  underneath the client to force a real 409 race. */
  beforeCommit?: () => Promise<void>;

  seedBlob(content: string): string {
    const s = sha(content);
    this.blobs.set(s, Buffer.from(content));
    return s;
  }
  /** Simulate another device committing `manifest` (advances head). */
  injectCommit(manifest: Manifest): void {
    this.head += 1;
    this.log.set(this.head, manifest);
  }
  headSeq(): number {
    return this.head;
  }
  hasBlob(s: string): boolean {
    return this.blobs.has(s);
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    // Verify bytes match the claimed content address — the real server does too.
    const bytes = await fs.readFile(absPath);
    if (sha(bytes.toString()) !== sha256) throw new Error(`putBlobFile: content/sha mismatch for ${sha256}`);
    this.blobs.set(sha256, bytes);
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.commitCalls += 1;
    if (this.beforeCommit) await this.beforeCommit();
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    const missing = manifest.files.filter((f) => f.type === "file").map((f) => f.sha256).filter((s) => !this.blobs.has(s));
    if (missing.length > 0) return { unsatisfiedBlobs: [...new Set(missing)] };
    if (this.forceUnsatisfiedOnce) {
      this.forceUnsatisfiedOnce = false;
      return { unsatisfiedBlobs: manifest.files.filter((f) => f.type === "file").map((f) => f.sha256) };
    }
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      async has(s) {
        return blobs.has(s);
      },
      async put(s, bytes) {
        blobs.set(s, Buffer.from(bytes));
      },
      async get(s) {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      async getToFile(s, dest) {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.writeFile(dest, b);
      },
      async putFile(s, src) {
        blobs.set(s, await fs.readFile(src));
      },
    };
  }
}

let root: string;
let cfg: WorkspaceConfig;
const noBackoff = async () => {};
const deps = (remote: SyncRemote): SyncDeps => ({ remote, backoff: noBackoff });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-sync-test-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  cfg = { remoteWorkspaceId: "ws_t", projectId: "root", deviceId: "devA", rootPath: root, remoteUrl: "http://x", token: "" };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const write = (rel: string, content: string) => fs.writeFile(path.join(root, rel), content);
const read = (rel: string) => fs.readFile(path.join(root, rel), "utf8");

// ── echo-storm no-op (the guard that makes continuous sync viable) ──────────

test("no-op: pull-then-push with no local changes makes ZERO commits, sequence stable", async () => {
  const remote = new FakeRemote();
  // remote publishes one file
  const c = "hello\n";
  const s = remote.seedBlob(c);
  remote.injectCommit({ generatedAt: "", files: [{ path: "a.txt", type: "file", sha256: s, size: c.length, mode: 0o644, mtimeMs: 1 }] });

  await pull(root, cfg, deps(remote)); // writes a.txt, base → seq 1
  expect(await read("a.txt")).toBe(c);
  const before = remote.commitCalls;
  const seq = await push(root, cfg, deps(remote)); // nothing changed on disk
  expect(remote.commitCalls).toBe(before); // ZERO new commits — no echo
  expect(seq).toBe(1);
  expect(remote.headSeq()).toBe(1);
});

// ── clean push ─────────────────────────────────────────────────────────────

test("clean push uploads the blob, commits, advances base", async () => {
  const remote = new FakeRemote();
  await write("new.txt", "fresh content\n");
  const seq = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.hasBlob(sha("fresh content\n"))).toBe(true);
  expect((await loadState(root)).lastSyncedSequence).toBe(1);
});

// ── 409 conflict-retry: the rescan is load-bearing ─────────────────────────

test("409 conflict: client pulls + RE-SCANS + retries, and does NOT lose the remote change", async () => {
  const remote = new FakeRemote();
  // Our local change:
  await write("mine.txt", "mine\n");
  // A competing remote commit lands exactly once, right before our first commit:
  const theirs = "theirs\n";
  const theirSha = remote.seedBlob(theirs);
  let injected = false;
  remote.beforeCommit = async () => {
    if (!injected) {
      injected = true;
      remote.injectCommit({ generatedAt: "", files: [{ path: "theirs.txt", type: "file", sha256: theirSha, size: theirs.length, mode: 0o644, mtimeMs: 1 }] });
    }
  };
  const seq = await push(root, cfg, deps(remote));
  // Oracle: the retry pulled their file to disk AND kept ours — both survive.
  expect(await read("theirs.txt")).toBe(theirs); // remote change not clobbered
  expect(await read("mine.txt")).toBe("mine\n"); // our change preserved
  expect(seq).toBe(remote.headSeq());
  expect(remote.commitCalls).toBeGreaterThanOrEqual(2); // first conflicted, retry succeeded
});

// ── 409 give-up leaves state untouched ─────────────────────────────────────

test("409 forever: exhausts retries, throws, never commits our change, never loses it", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  // Advance the remote before every commit → the parent check never matches.
  let n = 0;
  remote.beforeCommit = async () => {
    const c = `other${n++}\n`;
    const s = remote.seedBlob(c);
    remote.injectCommit({ generatedAt: "", files: [{ path: `o${n}.txt`, type: "file", sha256: s, size: c.length, mode: 0o644, mtimeMs: 1 }] });
  };
  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/too many conflicts/);
  // Oracle: our change was NEVER committed (no partial/torn commit) and is NOT
  // lost — it's still on disk. (The base legitimately tracks pulled remote state;
  // what must hold is no data loss and no phantom commit of ours.)
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "mine.txt")).toBe(false); // never committed
  expect(await read("mine.txt")).toBe("mine\n"); // never lost
});

test("onCommitConflict fires once per 409 (the metric the daemon tallies)", async () => {
  const remote = new FakeRemote();
  await write("mine.txt", "mine\n");
  let injected = 0;
  remote.beforeCommit = async () => {
    if (injected < 2) {
      injected++;
      const c = `o${injected}\n`;
      remote.injectCommit({ generatedAt: "", files: [{ path: `o${injected}.txt`, type: "file", sha256: remote.seedBlob(c), size: c.length, mode: 0o644, mtimeMs: 1 }] });
    }
  };
  let conflicts = 0;
  await push(root, cfg, { remote, backoff: noBackoff, onCommitConflict: () => conflicts++ });
  expect(conflicts).toBe(2); // two 409s before the third commit succeeded
});

// ── 422 unsatisfied-blobs → reupload + retry ───────────────────────────────

test("422 unsatisfied blobs: client re-uploads and retries to success", async () => {
  const remote = new FakeRemote();
  await write("x.txt", "payload\n");
  remote.forceUnsatisfiedOnce = true; // first commit reports missing, even though uploaded
  const seq = await push(root, cfg, deps(remote));
  expect(seq).toBe(1);
  expect(remote.commitCalls).toBe(2); // 422 then success
});

// ── pull validation: invalid remote manifest never touches disk / base ──────

test("pull rejects an invalid remote manifest and does not advance base", async () => {
  const remote = new FakeRemote();
  // Inject a manifest with a path-traversal entry (invalid) at head.
  remote.injectCommit({ generatedAt: "", files: [{ path: "../escape", type: "file", sha256: sha("x"), size: 1, mode: 0o644, mtimeMs: 1 }] });
  await expect(pull(root, cfg, deps(remote))).rejects.toThrow(/invalid remote manifest/);
  expect((await loadState(root)).lastSyncedSequence).toBe(0); // base unchanged
});

// ── forward-only ignore carry (M3b) ────────────────────────────────────────

test("a now-ignored, previously-synced file is carried forward (not seen as a deletion)", async () => {
  const remote = new FakeRemote();
  // 1) clean-push the file → it's in the base + remote.
  await write("keep.env", "K=V\n");
  await push(root, cfg, deps(remote));
  expect((await remote.latest()).manifest.files.some((f) => f.path === "keep.env")).toBe(true);
  // 2) now ignore it on disk and push again — it must be CARRIED, not deleted.
  await write(".rboxignore", "keep.env\n");
  await push(root, cfg, deps(remote));
  const latest = await remote.latest();
  expect(latest.manifest.files.some((f) => f.path === "keep.env")).toBe(true); // carried forward
});

// ── full sync cycle ────────────────────────────────────────────────────────

test("sync = pull then push in one call", async () => {
  const remote = new FakeRemote();
  const c = "remote\n";
  const s = remote.seedBlob(c);
  remote.injectCommit({ generatedAt: "", files: [{ path: "r.txt", type: "file", sha256: s, size: c.length, mode: 0o644, mtimeMs: 1 }] });
  await write("local.txt", "local\n");
  const { pulled, pushedSequence } = await sync(root, cfg, deps(remote));
  expect(pulled.some((a) => a.kind === "write")).toBe(true); // pulled r.txt
  expect(await read("r.txt")).toBe(c);
  expect(pushedSequence).toBe(remote.headSeq()); // pushed local.txt on top
});
