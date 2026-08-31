import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BlobStore, Manifest } from "../../engine/index.js";
import { push, type SyncDeps } from "../sync.js";
import { saveStateUnsafeLegacyOrTest, syncStreamId, type WorkspaceConfig } from "../config.js";
import type { CommitResult, SyncRemote } from "../remote.js";

// #818 fix 3, push side: the account-keys read must be ISSUED before the upload
// lane runs, not after it. A remote that records the order of the calls it gets
// is the whole assertion — the overlap is the point of the change.

const KEK = Buffer.alloc(32, 11);
const roots: string[] = [];

afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))));

class OrderingRemote implements SyncRemote {
  readonly order: string[] = [];
  head = 0;
  private manifest: Manifest = { generatedAt: "", files: [] };
  private readonly blobs = new Map<string, Buffer>();

  prefetchAccount(): void {
    this.order.push("prefetchAccount");
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifest };
  }

  async missingBlobs(shas: string[]): Promise<string[]> {
    return shas.filter((sha) => !this.blobs.has(sha));
  }

  async putBlobFile(sha: string, absPath: string): Promise<void> {
    this.order.push("putBlobFile");
    this.blobs.set(sha, await fs.readFile(absPath));
  }

  async commit(parentSequence: number, _deviceId: string, manifest: Manifest): Promise<CommitResult> {
    this.order.push("commit");
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head++;
    this.manifest = manifest;
    return { sequence: this.head };
  }

  blobStore(): BlobStore {
    return {
      has: async (sha) => this.blobs.has(sha),
      put: async (sha, bytes) => void this.blobs.set(sha, Buffer.from(bytes)),
      get: async (sha) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`missing blob ${sha}`);
        return bytes;
      },
      getToFile: async (sha, dest) => {
        const bytes = this.blobs.get(sha);
        if (!bytes) throw new Error(`missing blob ${sha}`);
        await fs.writeFile(dest, bytes);
      },
    };
  }
}

function config(root: string): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_prefetch",
    projectId: "root",
    deviceId: "device_a",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_prefetch",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

test("push issues the account-keys read before the upload lane, not in front of the signature", async () => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-prefetch-push-")));
  roots.push(root);
  await fs.mkdir(path.join(root, ".rbox/state"), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config(root)),
    stateNonce: "a".repeat(32),
    stateRevision: 0,
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  await fs.writeFile(path.join(root, "a.txt"), "hello");

  const remote = new OrderingRemote();
  const deps: SyncDeps = { remote, backoff: async () => {} };
  const result = await push(root, config(root), deps);

  expect(result.committed).toBe(true);
  expect(remote.order[0]).toBe("prefetchAccount");
  expect(remote.order).toContain("putBlobFile");
  expect(remote.order.indexOf("prefetchAccount")).toBeLessThan(remote.order.indexOf("putBlobFile"));
  expect(remote.order.at(-1)).toBe("commit");
});
