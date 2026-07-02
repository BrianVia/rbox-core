import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type BlobStore, type Manifest } from "../engine/index.js";
import { loadActivity } from "./activity.js";
import type { WorkspaceConfig } from "./config.js";
import { RboxDaemon } from "./daemon.js";
import type { CommitResult, SyncRemote } from "./remote.js";

// Design 45: the daemon's activity sidecar is `rbox status`'s window into background
// sync. The load-bearing lifecycle: a pump error records a HALT (the mass-delete
// guard's only user-visible surface), the next success clears it, and a committed
// push records the last-sync trail. Exercised through the real pump via the same
// private-poke pattern as daemon-watch-degrade.test.ts.

const KEK = Buffer.alloc(32, 7);

/** Minimal stateful remote: enough for empty pulls and a real committed push.
 *  `missingBlobs` returns [] (server "has" everything) — blob-upload mechanics are
 *  sync.test.ts's job; here only the activity bookkeeping is under test. */
class MiniRemote implements SyncRemote {
  head = 0;
  latestError?: Error; // when set, latest() throws it (and it stays set until cleared)
  private manifests = new Map<number, Manifest>();
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    if (this.latestError) throw this.latestError;
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(): Promise<string[]> {
    return [];
  }
  async putBlobFile(): Promise<void> {}
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    // Touched by pull's git-section pass even when nothing transfers — inert is fine.
    return {
      has: async () => false,
      get: async () => {
        throw new Error("no blobs in these scenarios");
      },
    } as unknown as BlobStore;
  }
}

/** The daemon privates this test drives directly (no watcher, no websocket). */
interface DaemonInternals {
  cache: HashCache;
  manifest: Manifest;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pump(): Promise<void>;
}

let root: string;
beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-activity-")));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function makeDaemon(remote: MiniRemote): Promise<DaemonInternals> {
  const cfg: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_act",
    projectId: "root",
    deviceId: "dev_act",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
  };
  const daemon = new RboxDaemon(root, cfg, { remote, backoff: async () => {} }) as unknown as DaemonInternals;
  daemon.cache = await HashCache.load(root);
  daemon.manifest = await scanManifest(root);
  return daemon;
}

test("pump error records a halt; the next success clears it", async () => {
  const remote = new MiniRemote();
  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  const daemon = await makeDaemon(remote);

  daemon.want.pull = true;
  await daemon.pump();
  const halted = await loadActivity(root);
  expect(halted?.halt?.reason).toContain("mass-delete guard");
  expect(halted?.halt?.count).toBe(1);

  remote.latestError = undefined; // heal → the next pull succeeds and self-clears
  daemon.want.pull = true;
  await daemon.pump();
  const healed = await loadActivity(root);
  expect(healed?.halt).toBeUndefined();
  expect(healed?.at).toBeDefined();
});

test("a committed push records the last-sync trail; a no-op push does not", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.manifest = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  const after = await loadActivity(root);
  expect(after?.last).toEqual({ at: expect.any(String), op: "push", files: 1, sequence: 1 });
  expect(after?.active).toBeUndefined(); // live progress never outlives its op

  daemon.want.push = true; // steady state: no changes → no-op → trail unchanged
  await daemon.pump();
  expect((await loadActivity(root))?.last?.sequence).toBe(1);
});
