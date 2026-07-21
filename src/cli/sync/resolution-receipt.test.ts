import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LocalBlobStore, type GitSection, type Manifest } from "../../engine/index.js";
import { loadState, repoRecordsForState, saveStateUnsafeLegacyOrTest, type GitResolutionPublicationReceipt, type SyncState, type WorkspaceConfig } from "../config.js";
import type { CommitResult, SyncRemote } from "../remote.js";
import { finishResolutionReceipt, reconcileResolutionReceipt } from "./pull.js";

let root = "";
const stream = "https://api.test::ws::project";
const cfg: WorkspaceConfig = {
  rootPath: "",
  remoteUrl: "https://api.test",
  remoteWorkspaceId: "ws",
  projectId: "project",
  deviceId: "device",
  token: "test",
  encrypted: true,
  syncGit: true,
};
const section: GitSection = {
  bundleSha: "1".repeat(64), bundleEncSha: "2".repeat(64), bundleCipherSize: 1,
  head: "ref: refs/heads/main\n", refs: { "refs/heads/main": "3".repeat(40) },
  refScope: "all", generatedAt: "2026-07-21T00:00:00.000Z",
};
const receipt: GitResolutionPublicationReceipt = {
  repo: "repo", attemptedGitIncomingKey: "attempted", attemptedSequence: 8, confirmedReportHash: "4".repeat(64),
};

class ThrowingLatestRemote implements SyncRemote {
  readonly store: LocalBlobStore;
  constructor() { this.store = new LocalBlobStore(path.join(root, "blobs")); }
  async latest(): Promise<{ sequence: number; manifest: Manifest }> { throw new Error("unauthenticated head"); }
  async missingBlobs(): Promise<string[]> { return []; }
  async putBlobFile(): Promise<void> {}
  async commit(): Promise<CommitResult> { throw new Error("unused"); }
  blobStore(): LocalBlobStore { return this.store; }
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-resolution-receipt-"));
  cfg.rootPath = root;
});
afterEach(async () => fs.rm(root, { recursive: true, force: true }));

async function seed(): Promise<SyncState> {
  const state: SyncState = {
    stream,
    stateNonce: "a".repeat(32),
    stateRevision: 0,
    lastSyncedSequence: 7,
    lastSyncedManifest: { generatedAt: "base", files: [], gitRepos: { repo: section }, manifestSchema: 2 },
    repoRecords: {
      repo: {
        repoGen: 1,
        sourceSeq: 7,
        base: section,
        pending: section,
        resolutionKey: "held",
        partial: { incomingKey: "pending", checkoutPending: true, appliedRefs: {}, heldRefs: {}, configApplied: true },
        attempt: {
          incomingKey: "pending", effectiveBaseIndexProjection: null, effectiveIncomingIndexProjection: null,
          incomingIndexArtifactDescriptor: "absent", localFingerprint: "f", fingerprintVersion: "v",
          reflogs: [], blockers: [], repoIdentity: "repo", stateNonce: "a".repeat(32), baseOriginsHash: "base",
          partialDisposition: "held", at: "2026-07-21T00:00:00.000Z",
        },
        deferrals: {
          apply: {
            lane: "apply", reason: "conflict", deferredSince: "2026-07-21T00:00:00.000Z",
            reasonSince: "2026-07-21T00:00:00.000Z", lastSeen: "2026-07-21T00:00:00.000Z",
          },
        },
        resolutionReceipt: receipt,
      },
    },
  };
  await saveStateUnsafeLegacyOrTest(root, state);
  return loadState(root, stream);
}

test("design 177 unreadable or unauthenticated head retains the publication receipt byte-for-byte", async () => {
  await seed();
  const before = await fs.readFile(path.join(root, ".rbox", "state.json"));
  const remote = new ThrowingLatestRemote();
  await expect(reconcileResolutionReceipt(root, cfg, { remote }, remote)).rejects.toThrow("unauthenticated head");
  expect(await fs.readFile(path.join(root, ".rbox", "state.json"))).toEqual(before);
  expect(repoRecordsForState(await loadState(root, stream)).repo?.resolutionReceipt).toEqual(receipt);
});

test("design 177 accepted-equivalent first save removes the receipt and all accepted clears atomically", async () => {
  let state = await seed();
  let attempted = 0;
  await expect(finishResolutionReceipt(root, state, "repo", receipt, true, async (_root, packet) => {
    attempted++;
    const next = packet.repos[0]?.newRecord;
    expect(next?.resolutionReceipt).toBeUndefined();
    expect(next?.pending).toBeUndefined();
    expect(next?.resolutionKey).toBeUndefined();
    expect(next?.partial).toBeUndefined();
    expect(next?.attempt).toBeUndefined();
    expect(next?.deferrals?.apply).toBeUndefined();
    throw new Error("injected first atomic save failure");
  })).rejects.toThrow("injected first atomic save failure");
  expect(attempted).toBe(1);
  let record = repoRecordsForState(await loadState(root, stream)).repo!;
  expect(record.resolutionReceipt).toEqual(receipt);
  expect(record.pending).toEqual(section);
  expect(record.resolutionKey).toBe("held");
  expect(record.partial).toBeDefined();
  expect(record.attempt).toBeDefined();
  expect(record.deferrals?.apply).toBeDefined();

  await finishResolutionReceipt(root, state, "repo", receipt, true);
  record = repoRecordsForState(await loadState(root, stream)).repo!;
  expect(record.resolutionReceipt).toBeUndefined();
  expect(record.pending).toBeUndefined();
  expect(record.resolutionKey).toBeUndefined();
  expect(record.partial).toBeUndefined();
  expect(record.attempt).toBeUndefined();
  expect(record.deferrals?.apply).toBeUndefined();
});

test("design 177 mismatch drops only the receipt", async () => {
  const state = await seed();
  await finishResolutionReceipt(root, state, "repo", receipt, false);
  const record = repoRecordsForState(await loadState(root, stream)).repo!;
  expect(record.resolutionReceipt).toBeUndefined();
  expect(record.pending).toEqual(section);
  expect(record.resolutionKey).toBe("held");
});

test("design 177 failed accepted-clear validation retains both receipt and pending", async () => {
  const state = await seed();
  const wrong = { ...receipt, attemptedGitIncomingKey: "different" };
  await expect(finishResolutionReceipt(root, state, "repo", wrong, true))
    .rejects.toThrow("receipt changed during reconciliation");
  const record = repoRecordsForState(await loadState(root, stream)).repo!;
  expect(record.resolutionReceipt).toEqual(receipt);
  expect(record.pending).toEqual(section);
  expect(record.partial).toBeDefined();
});
