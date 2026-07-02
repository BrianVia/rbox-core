import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { pull, push, type SyncDeps } from "./sync.js";
import { loadState, syncStreamId, type WorkspaceConfig } from "./config.js";
import { type CommitResult, type SyncRemote } from "./remote.js";
import { type BlobStore, type FileEntry, type Manifest } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";

// Design 50 §4 + review B2: the push-side mass-delete guard, and the critical
// non-leak regression — `--allow-mass-delete` on PUSH must never satisfy the
// PULL-side guard (they are separate op-scoped consent fields).

const shaBytes = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KEK = Buffer.alloc(32, 7);
const enc = (content: string | Buffer) => encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));

/** The canonical in-memory server simulator (mirrors sync.test.ts's FakeRemote):
 *  monotonic head, 409 parent conflict, ciphertext-addressed blobs. */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.log.set(this.head, { generatedAt: "", files });
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.log.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    const bytes = await fs.readFile(absPath);
    if (shaBytes(bytes) !== sha256) throw new Error(`putBlobFile: content/sha mismatch for ${sha256}`);
    this.blobs.set(sha256, bytes);
  }
  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    const addr = (f: FileEntry) => f.encSha ?? f.sha256;
    const missing = manifest.files.filter((f) => f.type === "file").map(addr).filter((s) => !this.blobs.has(s));
    if (missing.length > 0) return { unsatisfiedBlobs: [...new Set(missing)] };
    this.head += 1;
    this.log.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      has: async (s) => blobs.has(s),
      put: async (s, bytes) => void blobs.set(s, Buffer.from(bytes)),
      get: async (s) => {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        return b;
      },
      getToFile: async (s, dest) => {
        const b = blobs.get(s);
        if (!b) throw new Error(`blob missing: ${s}`);
        await fs.writeFile(dest, b);
      },
      putFile: async (s, src) => void blobs.set(s, await fs.readFile(src)),
    };
  }
  /** Seed a blob into the store as an out-of-band writer would (so a remote
   *  manifest referencing it can be pulled/applied). */
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await enc(content);
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
}

let root: string;
let cfg: WorkspaceConfig;
const noBackoff = async () => {};
const deps = (remote: SyncRemote, extra: Partial<SyncDeps> = {}): SyncDeps => ({ remote, backoff: noBackoff, ...extra });

const N = 200; // baseline size; the guard needs ≥100 deletes AND ≥half the baseline

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-push-guard-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  cfg = { remoteWorkspaceId: "ws_t", projectId: "root", deviceId: "devA", rootPath: root, remoteUrl: "http://x", token: "", encrypted: true, kek: KEK };
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

/** Write N small tracked files and publish them, so the baseline holds N synced files. */
async function seedBaseline(remote: FakeRemote): Promise<void> {
  for (let i = 0; i < N; i++) await fs.writeFile(path.join(root, `f${i}.txt`), `content-${i}\n`);
  const res = await push(root, cfg, deps(remote));
  expect(res.committed).toBe(true);
  const state = await loadState(root, syncStreamId(cfg));
  expect(state.lastSyncedManifest.files.length).toBe(N);
}

async function deleteLocal(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await fs.rm(path.join(root, `f${i}.txt`));
}

test("push that deletes ≥half the baseline is REFUSED by the mass-delete guard", async () => {
  const remote = new FakeRemote();
  await seedBaseline(remote);
  await deleteLocal(120); // 120 ≥ 100 and 120*2 ≥ 200 → trips the guard

  const before = (await remote.latest()).sequence;
  await expect(push(root, cfg, deps(remote))).rejects.toThrow(/refusing \(mass-delete guard\)/);
  // Fail-closed at the source: the remote head never advanced — no device sees the wipe.
  expect((await remote.latest()).sequence).toBe(before);
});

test("push --allow-mass-delete (allowMassDeletePush) publishes the deletion once", async () => {
  const remote = new FakeRemote();
  await seedBaseline(remote);
  await deleteLocal(120);

  const res = await push(root, cfg, deps(remote, { allowMassDeletePush: true }));
  expect(res.committed).toBe(true);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.length).toBe(N - 120); // the deletion was published
});

test("REGRESSION (B2): push consent does NOT satisfy the PULL guard — a mass-delete pull still refuses", async () => {
  const remote = new FakeRemote();
  await seedBaseline(remote);
  // A second machine wiped the workspace: the remote head is now empty. A pull would
  // delete all N baseline files locally.
  remote.injectCommit([]);

  // allowMassDeletePush is set (as `rbox push --allow-mass-delete` would), allowMassDelete is NOT.
  // The pull-side guard must STILL trip — consent must not leak across ops.
  await expect(pull(root, cfg, deps(remote, { allowMassDeletePush: true }))).rejects.toThrow(/pull would delete .*mass-delete guard/);
  // And the files are untouched on disk (fail-closed before apply).
  expect((await fs.readdir(root)).filter((f) => f.startsWith("f")).length).toBe(N);
});

test("REGRESSION (B2): pull-side consent (allowMassDelete) DOES apply the same pull", async () => {
  const remote = new FakeRemote();
  await seedBaseline(remote);
  remote.injectCommit([]);
  const actions = await pull(root, cfg, deps(remote, { allowMassDelete: true }));
  expect(actions.filter((a) => a.kind === "delete").length).toBe(N);
});
