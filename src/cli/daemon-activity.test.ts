import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type BlobStore, type FileEntry, type Manifest } from "../engine/index.js";
import { encryptFileNameProbe } from "../engine/e2ee/e2ee-e2e.helpers.js";
import { loadActivity } from "./activity.js";
import type { WorkspaceConfig } from "./config.js";
import { RboxDaemon } from "./daemon.js";
import { pull } from "./sync.js";
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
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  /** Encrypt + store content as another writer would; returns its manifest entry. */
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
    if (this.latestError) throw this.latestError;
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

/** The daemon privates this test drives directly (no watcher, no websocket). */
interface DaemonInternals {
  cache: HashCache;
  manifest: Manifest;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  pump(): Promise<void>;
  /** The chained sidecar-write promise — the pump never awaits it (best-effort
   *  by contract), so tests drain it explicitly before reading the file. */
  activityWrite: Promise<void>;
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

test("pump error records a halt; only a same-kind success clears it", async () => {
  const remote = new MiniRemote();
  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  const daemon = await makeDaemon(remote);

  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const halted = await loadActivity(root);
  expect(halted?.halt?.reason).toContain("mass-delete guard");
  expect(halted?.halt?.count).toBe(1);
  expect(halted?.halt?.op).toBe("pull");

  // Codex R1 BLOCKER regression: a successful op of a DIFFERENT kind (the queued
  // no-op push, every safety scan) must NOT heal a pull halt — the guard warning
  // would flap off within seconds of every trip.
  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  expect((await loadActivity(root))?.halt?.reason).toContain("mass-delete guard");

  remote.latestError = undefined; // heal → a SUCCESSFUL PULL is what clears it
  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const healed = await loadActivity(root);
  expect(healed?.halt).toBeUndefined();
  expect(healed?.at).toBeDefined();

  // Codex R4 regression: a NEW failure with the SAME message after a heal is a new
  // episode — it must persist a fresh halt (not silently count as dedup repeat 2..9
  // and leave activity.json healed).
  remote.latestError = new Error("pull would delete 8603 of 8603 tracked files — refusing (mass-delete guard).");
  daemon.want.pull = true;
  await daemon.pump();
  await daemon.activityWrite;
  const rehalted = await loadActivity(root);
  expect(rehalted?.halt?.reason).toContain("mass-delete guard");
  expect(rehalted?.halt?.count).toBe(1);
});

test("a committed push records the last-sync trail; a no-op push does not", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello");
  daemon.manifest = await scanManifest(root);

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;
  const after = await loadActivity(root);
  expect(after?.lastPush).toEqual({ at: expect.any(String), files: 1, sequence: 1 });
  expect(after?.active).toBeUndefined(); // live progress never outlives its op

  daemon.want.push = true; // steady state: no changes → no-op → trail unchanged
  await daemon.pump();
  await daemon.activityWrite;
  expect((await loadActivity(root))?.lastPush?.sequence).toBe(1);
});

test("the 409-recovery pull inside a push is recorded in the trail (codex R2)", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "mine");
  daemon.manifest = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump(); // baseline: sequence 1
  await daemon.activityWrite;

  // Another writer advances the remote (adds b.txt) → our next push 409s.
  const current = (await remote.latest()).manifest.files;
  remote.injectCommit([...current, await remote.seedEntry("b.txt", "theirs")]);

  await fs.writeFile(path.join(root, "c.txt"), "more local work");
  daemon.manifest = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump(); // 409 → internal pull writes b.txt → re-scan → commit seq 3
  await daemon.activityWrite;

  const after = await loadActivity(root);
  // The recovery pull's local-tree mutation is recorded in ITS OWN slot — the
  // subsequent successful push must not mask it.
  expect(after?.lastPull).toEqual({ at: expect.any(String), writes: 1, deletes: 0, conflicts: 0 });
  expect(after?.lastPush?.sequence).toBe(3);
  expect(after?.lastPush?.files).toBe(3); // a.txt + b.txt + c.txt
  expect(await fs.readFile(path.join(root, "b.txt"), "utf8")).toBe("theirs");
});

test("a throwing onPullApplied hook never fails a completed pull (codex R3)", async () => {
  const remote = new MiniRemote();
  remote.injectCommit([await remote.seedEntry("x.txt", "hi")]);
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
  const actions = await pull(root, cfg, {
    remote,
    backoff: async () => {},
    onPullApplied: () => {
      throw new Error("observability boom");
    },
  });
  expect(actions).toHaveLength(1); // the pull itself succeeded…
  expect(await fs.readFile(path.join(root, "x.txt"), "utf8")).toBe("hi"); // …and applied
});
