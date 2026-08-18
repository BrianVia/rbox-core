/**
 * Design 277 slice A: one durable-state materialization per operation.
 *
 * The count test pins the CLEAN steady cycle — zero pending events, no receipt,
 * no config change, no retry, no failure — because that is the cycle the fleet
 * actually runs all day. `loadRawStateFromStore` is the O(N) materialization;
 * the freshness probe is not.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  HashCache, scanManifest,
  type BlobStore, type FileEntry, type IgnoreMatcher, type Manifest, type WatchEvent,
} from "../../engine/index.js";
import { encryptFileNameProbe } from "../../engine/e2ee/e2ee-e2e.helpers.js";
import { syncStreamId, type SyncState, type WorkspaceConfig } from "../config.js";
import { RboxDaemon } from "../daemon.js";
import { authorityMarkerBytes } from "../state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "../state-plane/paths.js";
import * as storeFacade from "../state-plane/store-facade.js";
import { createStateStore } from "../state-plane/store/open.js";
import { loadRawState } from "../state-plane/adapters/whole-state-compat.js";
import { loadState } from "../config.js";
import { openStateStore, stateStoreDatabase } from "../state-plane/store/open.js";
import { runStatement } from "../state-plane/store/statements.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import type { WatchOptions, Watcher } from "./watcher.js";
import { prepareDaemonFolderAdmission, releaseDaemonFolderAdmission } from "./folder-admission.test-helper.js";

const KEK = Buffer.alloc(32, 7);
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);

class MiniRemote implements SyncRemote {
  head = 0;
  private readonly manifests = new Map<number, Manifest>();
  private readonly blobs = new Map<string, Buffer>();
  async seedEntry(rel: string, content: string): Promise<FileEntry> {
    const probe = await encryptFileNameProbe(new Uint8Array(KEK), new Uint8Array(Buffer.from(content)));
    this.blobs.set(probe.encSha, Buffer.from(probe.ciphertext));
    return { path: rel, type: "file", sha256: probe.plaintextSha, encSha: probe.encSha, size: content.length, mode: 0o644, mtimeMs: 1 };
  }
  injectCommit(files: FileEntry[]): void {
    this.head += 1;
    this.manifests.set(this.head, { generatedAt: "", files });
  }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifests.get(this.head) ?? { generatedAt: "", files: [] } };
  }
  async missingBlobs(shas: string[]): Promise<string[]> { return shas.filter((sha) => !this.blobs.has(sha)); }
  async putBlobFile(sha256: string, absPath: string): Promise<void> { this.blobs.set(sha256, await fs.readFile(absPath)); }
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.manifests.set(this.head, manifest);
    return { sequence: this.head };
  }
  blobStore(): BlobStore {
    const blobs = this.blobs;
    return {
      has: async (sha) => blobs.has(sha),
      put: async (sha, bytes) => void blobs.set(sha, Buffer.from(bytes)),
      get: async (sha) => {
        const blob = blobs.get(sha);
        if (!blob) throw new Error(`blob missing: ${sha}`);
        return blob;
      },
    };
  }
}

type TestStartWatcher = (root: string, matcher: IgnoreMatcher, onSettle: (events: WatchEvent[]) => void, opts?: WatchOptions) => Promise<Watcher>;

interface DaemonInternals {
  cache: HashCache;
  local: { head: Manifest };
  syncBase?: SyncState;
  want: { pull: boolean; push: boolean; fullScan: boolean; deepScan: boolean };
  startWatcherFn: TestStartWatcher;
  pump(): Promise<void>;
  stop(): Promise<void>;
  loadSyncBase(): Promise<SyncState>;
}

let root: string;
let daemons: DaemonInternals[];
let telemetryBefore: string | undefined;

beforeEach(async () => {
  daemons = [];
  // The sync-state reporter mints one telemetry binding per workspace off-mutex.
  // That once-per-workspace write is covered by its own probe test; counting it
  // here would hide the steady cycle this test exists to pin.
  telemetryBefore = process.env.RBOX_TELEMETRY;
  process.env.RBOX_TELEMETRY = "0";
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-state-load-")));
  const cfg = testConfig();
  await prepareDaemonFolderAdmission(root, cfg);
  await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY,
    lineageId: LINEAGE,
    stream: syncStreamId(cfg),
    createdBy: "test",
    stateNonce: NONCE,
    stateRevision: 0,
  }).close();
  await fs.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
});

afterEach(async () => {
  if (telemetryBefore === undefined) delete process.env.RBOX_TELEMETRY;
  else process.env.RBOX_TELEMETRY = telemetryBefore;
  await Promise.all(daemons.map((daemon) => daemon.stop().catch(() => {})));
  try {
    await releaseDaemonFolderAdmission(root);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

function testConfig(): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: "ws_load",
    projectId: "root",
    deviceId: "dev_load",
    rootPath: root,
    remoteUrl: "mem://",
    token: "",
    encrypted: true,
    kek: KEK,
    accountId: "acct_load",
    accountEpoch: 0,
    keyEpoch: 0,
  };
}

async function makeDaemon(remote: MiniRemote): Promise<DaemonInternals> {
  const daemon = new RboxDaemon(root, testConfig(), { remote, backoff: async () => {} }, {
    bootId: "boot-load", keyDeliveryFlight: null,
  }) as DaemonInternals;
  daemons.push(daemon);
  daemon.cache = await HashCache.load(root);
  daemon.local.head = await scanManifest(root);
  await daemon.loadSyncBase();
  return daemon;
}

/** A load through the production adapter, used to observe retention. */
async function loadRawStateThroughAdapter(): Promise<void> {
  await loadState(root, syncStreamId(testConfig()));
}

/** Drop this root's retention the way a fresh process would start. */
async function releaseRetainedState(): Promise<void> {
  const memo = await import("../state-plane/adapters/state-memo.js");
  memo.forgetState(root);
}

/** Count only the O(N) materializations a cycle performs, from the boundary in.
 *  The spy sits on the store facade, which is how the adapter reaches the
 *  projection; a direct `adapters/read-only.js` import would bypass it, and
 *  `state-plane/inventory.test.ts` is what keeps every read on that route. */
async function countMaterializations(run: () => Promise<void>): Promise<number> {
  const original = storeFacade.loadRawStateFromStore;
  let loads = 0;
  const spy = spyOn(storeFacade, "loadRawStateFromStore").mockImplementation((...args) => {
    loads += 1;
    return original(...args);
  });
  try {
    await run();
  } finally {
    spy.mockRestore();
  }
  return loads;
}

test("277: with the memo off, the clean zero-change push cycle materializes state four times", async () => {
  // The behavior this design set out to remove, pinned so the kill switch is a
  // real revert: the boundary load, the receipt reconcile, the attempt, and the
  // publish transition's refresh each materialize the whole workspace.
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  process.env.RBOX_STATE_LOAD_CACHE = "0";
  try {
    const loads = await countMaterializations(async () => {
      daemon.want.push = true;
      await daemon.pump();
    });
    expect(loads).toBe(4);
  } finally {
    delete process.env.RBOX_STATE_LOAD_CACHE;
  }
});

test("277: a cold clean push cycle materializes state exactly once", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await releaseRetainedState(); // a freshly started daemon has nothing retained
  const loads = await countMaterializations(async () => {
    daemon.want.push = true;
    await daemon.pump();
  });
  expect(loads).toBe(1);
});

test("277: the steady zero-change push cycle materializes state not at all", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  daemon.want.push = true;
  await daemon.pump();

  const loads = await countMaterializations(async () => {
    daemon.want.push = true;
    await daemon.pump();
  });
  expect(loads).toBe(0);
});

// The pull's own accepted save projects the installed state through
// `translateCasResult` — a write-path materialization, not a load. Every LOAD
// in the cycle is served from the retention.
test("277: the steady zero-change pull cycle materializes state only for its own accepted save", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  daemon.want.pull = true;
  await daemon.pump();

  const loads = await countMaterializations(async () => {
    daemon.want.pull = true;
    await daemon.pump();
  });
  expect(loads).toBe(1);
});

test("277: a write from ANOTHER process between cycles is materialized again", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  daemon.want.push = true;
  await daemon.pump();

  // Mutated outside this process's adapter, so the retention stays resident and
  // stale: only the token comparison can catch it.
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: false });
  try {
    runStatement(stateStoreDatabase(store), "UPDATE state_lineage SET state_revision=state_revision+1");
  } finally {
    store.close();
  }

  const loads = await countMaterializations(async () => {
    daemon.want.push = true;
    await daemon.pump();
  });
  expect(loads).toBe(1);
  expect(daemon.syncBase).toEqual(await loadRawState(root));
});

test("277: the settled durable state deep-equals the store after a zero-change push", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  daemon.want.push = true;
  await daemon.pump();
  expect(daemon.syncBase).toEqual(await loadRawState(root));
});

test("277: the settled durable state deep-equals the store after a committing push", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  daemon.local.head = await scanManifest(root);
  daemon.want.push = true;
  await daemon.pump();
  expect(remote.head).toBe(1);
  expect(daemon.syncBase).toEqual(await loadRawState(root));
});

test("277: the settled durable state deep-equals the store after a pull that applies", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  remote.injectCommit([await remote.seedEntry("remote.txt", "remote\n")]);
  daemon.want.pull = true;
  await daemon.pump();
  expect(daemon.syncBase?.lastSyncedSequence).toBe(1);
  expect(daemon.syncBase).toEqual(await loadRawState(root));
});


test("277: a stopped daemon releases its retained state", async () => {
  const remote = new MiniRemote();
  const daemon = await makeDaemon(remote);
  daemon.want.push = true;
  await daemon.pump();
  await daemon.stop();

  // Nothing is retained across a stop, so the next load materializes: the memo
  // is a live-daemon optimization, not a process-lifetime cache.
  const loads = await countMaterializations(async () => {
    await loadRawStateThroughAdapter();
  });
  expect(loads).toBe(1);
});
