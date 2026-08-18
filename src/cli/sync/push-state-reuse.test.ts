/**
 * Design 277 §A1 at the publication seam: the boundary's state is used ONCE,
 * the receipt path never reuses it, and every re-invocation loads for real.
 */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { scanManifest, type BlobStore, type Manifest } from "../../engine/index.js";
import { loadState, repoRecordsForState, syncStreamId, type SyncState, type WorkspaceConfig } from "../config.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import { authorityMarkerBytes } from "../state-plane/authority-marker.js";
import { sqliteResetPaths, statePath } from "../state-plane/paths.js";
import * as storeFacade from "../state-plane/store-facade.js";
import { createStateStore } from "../state-plane/store/open.js";
import { saveStateSource } from "../sync-state.js";
import { pushManifest } from "./push.js";

const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);
const RECEIPT = { repo: "repo", attemptedGitIncomingKey: "attempted", attemptedSequence: 1, confirmedReportHash: "4".repeat(64) };

let root = "";
const cfg: WorkspaceConfig = {
  schema: "e2ee/v1",
  rootPath: "",
  remoteUrl: "https://api.test",
  remoteWorkspaceId: "ws_reuse",
  projectId: "root",
  deviceId: "dev_reuse",
  token: "",
  encrypted: true,
  kek: Buffer.alloc(32, 5),
  accountId: "acct",
  accountEpoch: 0,
  keyEpoch: 0,
};

class FakeRemote implements SyncRemote {
  head = 0;
  conflictsLeft = 0;
  commits = 0;
  private manifest: Manifest = { generatedAt: "", files: [] };
  private readonly blobs = new Map<string, Buffer>();
  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    return { sequence: this.head, manifest: this.manifest };
  }
  async missingBlobs(): Promise<string[]> { return []; }
  async putBlobFile(sha256: string, absPath: string): Promise<void> { this.blobs.set(sha256, await fs.readFile(absPath)); }
  async commit(parentSequence: number, _device: string, manifest: Manifest): Promise<CommitResult> {
    this.commits += 1;
    if (this.conflictsLeft > 0) {
      this.conflictsLeft -= 1;
      return { conflict: true, head: this.head };
    }
    if (parentSequence !== this.head) return { conflict: true, head: this.head };
    this.head += 1;
    this.manifest = manifest;
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

beforeEach(async () => {
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-push-state-reuse-")));
  cfg.rootPath = root;
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

afterEach(async () => fs.rm(root, { recursive: true, force: true }));

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

const emptyManifest: Manifest = { generatedAt: "", files: [] };

async function boundary(): Promise<SyncState> {
  return loadState(root, syncStreamId(cfg));
}

test("277 A1: a boundary state serves the receipt reconcile and the attempt", async () => {
  const remote = new FakeRemote();
  const boundaryState = await boundary();
  const loads = await countMaterializations(async () => {
    await pushManifest(root, cfg, emptyManifest, { remote }, { boundaryState });
  });
  expect(loads).toBe(0);
});

test("277 A1: without a boundary state the publication loads twice, as it always has", async () => {
  const remote = new FakeRemote();
  const loads = await countMaterializations(async () => {
    await pushManifest(root, cfg, emptyManifest, { remote });
  });
  expect(loads).toBe(2);
});

test("277 A1: a reconciled resolution receipt refuses the boundary state", async () => {
  const remote = new FakeRemote();
  const before = await boundary();
  await saveStateSource(root, before, {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: before.lastSyncedSequence,
    observedRepos: ["repo"],
    values: { resolutionReceipt: { repo: RECEIPT } },
  });
  const boundaryState = await boundary();
  expect(repoRecordsForState(boundaryState).repo?.resolutionReceipt).toBeDefined();

  const result = await pushManifest(root, cfg, emptyManifest, { remote }, { boundaryState });
  // The reconcile applied a manifest and cleared the receipt, so the attempt
  // materialized the state those writers left: a reused boundary would report
  // the superseded, receipt-bearing state here.
  expect(repoRecordsForState(await boundary()).repo?.resolutionReceipt).toBeUndefined();
  expect(result.durable).toEqual({ state: await boundary() });
});

test("277 A1: the boundary state is single-use — a retried attempt loads for real", async () => {
  const remote = new FakeRemote();
  remote.conflictsLeft = 1;
  await fs.writeFile(path.join(root, "a.txt"), "hello\n");
  const local = await scanManifest(root);
  const boundaryState = await boundary();
  const loads = await countMaterializations(async () => {
    await pushManifest(root, cfg, local, { remote, backoff: async () => {} }, { boundaryState });
  });
  expect(remote.commits).toBe(2);
  // Attempt one consumed the pre-load; the recovery pull and rescan between
  // attempts superseded it, so attempt two loaded.
  expect(loads).toBeGreaterThanOrEqual(1);
});

test("277 A1: the push reports a durable receipt its caller can adopt", async () => {
  const remote = new FakeRemote();
  const boundaryState = await boundary();
  const result = await pushManifest(root, cfg, emptyManifest, { remote }, { boundaryState });
  expect(result.durable).toBeDefined();
  expect(result.durable).toEqual({ state: await boundary() });
});
