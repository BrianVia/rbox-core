import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// Design 85 P-1 regression: a path that churns during the
// POST-pull rescan must carry the post-pull BASE entry, never the pre-pull
// manifest entry — carrying pre-pull truth lets the pump's follow-up push
// publish stale content over the version the pull just applied.
//
// The hash mock defers f.txt deterministically: it mutates the file only when
// the hash reads the freshly PULLED content, i.e. exactly during the post-pull
// rescan (the pull's own pre-apply scan sees the old content and is left alone).
let mutateWhenContent: { base: string; content: string; mutation: (abs: string) => Promise<void> } | undefined;

mock.module("../../engine/hash.js", () => ({
  hashBytes: (bytes: Uint8Array | Buffer): string => createHash("sha256").update(bytes).digest("hex"),
  hashFile: async (abs: string): Promise<string> => {
    const bytes = await fs.readFile(abs);
    const arm = mutateWhenContent;
    // Exact-basename guard: apply verifies the downloaded blob at a TMP path with
    // the same content — the churn must hit only the published file's rescan.
    if (arm && path.basename(abs) === arm.base && bytes.toString() === arm.content) {
      mutateWhenContent = undefined;
      await arm.mutation(abs);
    }
    return createHash("sha256").update(await fs.readFile(abs)).digest("hex");
  },
}));

const { HashCache, scanManifest } = await import("../../engine/index.js");
const { encryptFileNameProbe } = await import("../../engine/e2ee/e2ee-e2e.helpers.js");
const { RboxDaemon } = await import("../daemon.js");
type BlobStore = import("../../engine/index.js").BlobStore;
type FileEntry = import("../../engine/index.js").FileEntry;
type Manifest = import("../../engine/index.js").Manifest;
type CommitResult = import("../remote.js").CommitResult;
type SyncRemote = import("../remote.js").SyncRemote;
type WorkspaceConfig = import("../config.js").WorkspaceConfig;

const KEK = Buffer.alloc(32, 7);
const shaHex = (s: string) => createHash("sha256").update(s).digest("hex");

class MiniRemote implements SyncRemote {
  head = 0;
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const p = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(p.encSha, Buffer.from(p.ciphertext));
    return { path: rel, type: "file", sha256: p.plaintextSha, encSha: p.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.manifests.set(this.head, { generatedAt: "", files });
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((s) => !this.blobs.has(s));
  }
  async putBlobFile(sha256: string, absPath: string): Promise<void> {
    this.blobs.set(sha256, await fs.readFile(absPath));
  }
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.manifests.set(this.head, manifest);
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
    };
  }
}

interface DaemonInternals {
  cache: InstanceType<typeof HashCache>;
  local: { head: Manifest };
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  retryQueue: { stop(): void };
  pump(): Promise<void>;
  loadSyncBase(): Promise<unknown>;
}

let root: string;
let daemon: DaemonInternals | undefined;

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-scan-defer-")));
});
afterEach(async () => {
  mutateWhenContent = undefined;
  daemon?.retryQueue.stop();
  daemon = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

function testConfig(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_defer",
    projectId: "root",
    deviceId: "dev_defer",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_defer",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

test("a freshly pulled path deferred during the post-pull rescan carries the pulled entry — the chained push never publishes its deletion", async () => {
  const remote = new MiniRemote();
  await fs.writeFile(path.join(root, "f.txt"), "one");
  daemon = new RboxDaemon(root, testConfig(), { remote, backoff: async () => {} }, { bootId: "boot-defer" }) as unknown as DaemonInternals;
  daemon.cache = new HashCache();
  daemon.local.head = await scanManifest(root); // pre-pull in-memory truth: f.txt only, no g.txt
  await daemon.loadSyncBase();

  daemon.want.push = true;
  await daemon.pump(); // baseline: f.txt synced (sequence 1)
  expect(remote.head).toBe(1);

  // Remote is ahead with a NEW file g.txt (sequence 2). This is the sharp case:
  // a deferred MODIFIED file is also caught by upload-time churn deferral, but a
  // deferred NEW file carried from the PRE-pull manifest is simply ABSENT — the
  // chained push would commit its deletion with no blob upload to catch it.
  remote.injectCommit([await remote.seedEntry("f.txt", "one"), await remote.seedEntry("g.txt", "two")]);
  // Churn g.txt exactly when the post-pull rescan hashes the pulled bytes.
  mutateWhenContent = { base: "g.txt", content: "two", mutation: async (abs) => fs.appendFile(abs, "-junk") };

  daemon.want.pull = true;
  await daemon.pump(); // doPull → post-pull rescan (defers g.txt) → chained push

  // Not vacuous: the pull applied (disk holds the pulled bytes + the injected
  // churn), and the churn really fired during the rescan.
  expect(await fs.readFile(path.join(root, "g.txt"), "utf8")).toBe("two-junk");
  expect(mutateWhenContent).toBeUndefined();

  // The deferred path carried the POST-pull base entry: the chained push saw no
  // local change — g.txt was neither deleted nor republished stale.
  expect(remote.head).toBe(2);
  const latest = (await remote.latest()).manifest.files.find((f) => f.path === "g.txt")!;
  expect(latest.sha256).toBe(shaHex("two"));
});
