import { test, expect, beforeEach, afterEach, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// A scan-deferred path (mutated between the walk's stat and its deferred hash,
// design 85 P-1) must ride `deferManifest` into the commit: the BASE entry is
// carried, so the churning file is never published torn and never published as
// a deletion. The hash mock injects the mutation deterministically at hash time.
type Mutation = (abs: string) => Promise<void>;
const mutations = new Map<string, Mutation>(); // basename → one-shot mutation

mock.module("../../engine/hash.js", () => ({
  hashBytes: (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex"),
  hashFile: async (abs: string): Promise<string> => {
    const run = mutations.get(path.basename(abs));
    if (run) {
      mutations.delete(path.basename(abs));
      await run(abs);
    }
    return createHash("sha256").update(await fs.readFile(abs)).digest("hex");
  },
}));

const { push, pull } = await import("../sync.js");
const { loadState, syncStreamId } = await import("../config.js");
const { encryptFileNameProbe } = await import("../../engine/e2ee/e2ee-e2e.helpers.js");
type SyncDeps = import("../sync.js").SyncDeps;
type WorkspaceConfig = import("../config.js").WorkspaceConfig;
type CommitResult = import("../remote.js").CommitResult;
type SyncRemote = import("../remote.js").SyncRemote;
type BlobStore = import("../../engine/index.js").BlobStore;
type FileEntry = import("../../engine/index.js").FileEntry;
type Manifest = import("../../engine/index.js").Manifest;

const shaHex = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
const KEK = Buffer.alloc(32, 7);

/** Minimal in-memory server (mirrors push-guard.test.ts's FakeRemote). */
class FakeRemote implements SyncRemote {
  private head = 0;
  private readonly log = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
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
    if (shaHex(bytes) !== sha256) throw new Error(`putBlobFile: content/sha mismatch for ${sha256}`);
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
}

let root: string;
let cfg: WorkspaceConfig;
const noBackoff = async () => {};
const deps = (remote: SyncRemote): SyncDeps => ({ remote, backoff: noBackoff });

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scan-defer-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  cfg = {
    remoteWorkspaceId: "ws_t",
    projectId: "root",
    deviceId: "devA",
    rootPath: root,
    remoteUrl: "http://x",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_t",
    accountEpoch: 0,
    keyEpoch: 0,
  };
});
afterEach(async () => {
  mutations.clear();
  await fs.rm(root, { recursive: true, force: true });
});

test("push commits the BASE entry for a scan-deferred path — never torn, never a deletion", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const first = await push(root, cfg, deps(remote));
  expect(first.committed).toBe(true);
  const state = await loadState(root, syncStreamId(cfg));
  const base = state.lastSyncedManifest.files.find((f) => f.path === "a.txt")!;
  expect(base.sha256).toBe(shaHex("one"));

  // Force a.txt back through the hash path (drop the cache), and mutate it
  // between the second scan's stat and its deferred hash.
  await fs.rm(path.join(root, ".rbox/state/hashcache.json"), { force: true });
  await fs.writeFile(path.join(root, "b.txt"), "new file");
  mutations.set("a.txt", async (abs) => fs.appendFile(abs, "-appended"));

  const second = await push(root, cfg, deps(remote));
  expect(second.committed).toBe(true);

  const committed = (await remote.latest()).manifest;
  const a = committed.files.find((f) => f.path === "a.txt");
  expect(a).toBeDefined(); // never a deletion
  expect(a!.sha256).toBe(base.sha256); // the BASE entry, not the mid-mutation hash
  expect(a!.size).toBe(base.size);
  expect(committed.files.some((f) => f.path === "b.txt")).toBe(true); // stable subset committed
});

test("push carries a previously-synced file through an EACCES hash fault", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await fs.writeFile(path.join(root, "keep.txt"), "stable");
  await push(root, cfg, deps(remote));
  const base = (await loadState(root, syncStreamId(cfg))).lastSyncedManifest;
  const baseA = base.files.find((f) => f.path === "a.txt")!;

  await fs.rm(path.join(root, ".rbox/state/hashcache.json"), { force: true });
  await fs.writeFile(path.join(root, "b.txt"), "new");
  mutations.set("a.txt", async () => { throw Object.assign(new Error("injected unreadable"), { code: "EACCES" }); });

  const result = await push(root, cfg, deps(remote));
  expect(result.committed).toBe(true);
  const committed = (await remote.latest()).manifest;
  const committedA = committed.files.find((f) => f.path === "a.txt")!;
  expect(committedA.sha256).toBe(baseA.sha256);
  expect(committedA.size).toBe(baseA.size);
  expect(committed.files.some((f) => f.path === "b.txt")).toBe(true);
  expect(base.files.filter((f) => !committed.files.some((entry) => entry.path === f.path)).map((f) => f.path)).not.toContain("a.txt");
  expect((await loadState(root, syncStreamId(cfg))).lastSyncedManifest.files.some((f) => f.path === "a.txt")).toBe(true);
});

// Pull sites intentionally pass NO deferred set (impl review D1-R2): a path the
// pre-apply scan dropped reaches reconcile as locally-absent, and every branch is
// byte-preserving — remote-untouched takes the no-action arm; remote-changed plans
// a write whose expectedLocal (absent) mismatches the on-disk churn, so apply
// moves the local bytes to a conflict copy before publishing; deletes are planned
// only from sameContent(local, base), never from absence. These two tests pin that.
test("pull with the churning path deferred and remote UNCHANGED leaves the local file untouched", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await push(root, cfg, deps(remote)); // synced baseline (sequence 1)

  await fs.rm(path.join(root, ".rbox/state/hashcache.json"), { force: true });
  mutations.set("a.txt", async (abs) => fs.appendFile(abs, "-edit"));

  const actions = await pull(root, cfg, deps(remote));
  expect(actions).toEqual([]); // no write, no delete, no conflict
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("one-edit");
});

test("pull with the churning path deferred and remote CHANGED preserves the local bytes as a conflict copy", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  await push(root, cfg, deps(remote)); // synced baseline (sequence 1)
  remote.injectCommit([await remote.seedEntry("a.txt", "two")]); // remote is ahead

  await fs.rm(path.join(root, ".rbox/state/hashcache.json"), { force: true });
  mutations.set("a.txt", async (abs) => fs.appendFile(abs, "-edit"));

  await pull(root, cfg, deps(remote));
  expect(mutations.size).toBe(0); // the churn really fired during the pre-apply scan
  expect(await fs.readFile(path.join(root, "a.txt"), "utf8")).toBe("two"); // remote applied
  const names = await fs.readdir(root);
  const conflict = names.find((n) => n.includes(".conflict"));
  expect(conflict).toBeDefined(); // the mid-write bytes survived
  expect(await fs.readFile(path.join(root, conflict!), "utf8")).toBe("one-edit");
});

test("push with every change scan-deferred publishes no torn entry and makes no spurious commit", async () => {
  const remote = new FakeRemote();
  await fs.writeFile(path.join(root, "a.txt"), "one");
  const first = await push(root, cfg, deps(remote));
  expect(first.committed).toBe(true);
  const seqAfterFirst = (await remote.latest()).sequence;

  await fs.rm(path.join(root, ".rbox/state/hashcache.json"), { force: true });
  mutations.set("a.txt", async (abs) => fs.appendFile(abs, "-appended"));

  const second = await push(root, cfg, deps(remote));
  expect(second.committed).toBe(false); // base carried → no diff → no-op
  expect((await remote.latest()).sequence).toBe(seqAfterFirst);
  const committed = (await remote.latest()).manifest;
  expect(committed.files.find((f) => f.path === "a.txt")!.sha256).toBe(shaHex("one"));
});
