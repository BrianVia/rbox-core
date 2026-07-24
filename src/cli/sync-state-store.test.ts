import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../engine/git/lockfile.js";
import { withRepositoryRecoveryFence } from "../engine/git/protocol-locks.js";
import {
  applyStateSavePacket,
  installGenesisResetStateUnderHeldLock,
  stateLockPath,
  statePath,
} from "./sync-state-store.js";

test("ordinary state CAS preserves the canonical state.json bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-store-"));
  const result = await applyStateSavePacket(root, {
    expectedStream: "stream",
    expectedNonce: "legacy",
    sourceGlobalSeq: 0,
    repos: [],
  });
  expect(result.status).toBe("accepted");
  if (result.status !== "accepted") return;
  expect(await fs.readFile(statePath(root), "utf8")).toBe(JSON.stringify({
    stream: "stream",
    lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
    stateNonce: result.state.stateNonce,
    stateRevision: 1,
    repoRecords: {},
  }, null, 2));
});

test("held-lock reset genesis preserves state and incarnation marker bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-genesis-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });

  await withRepositoryRecoveryFence([], path.resolve(statePath(root)), async () => {
    const acquired = await acquireLock(stateLockPath(root));
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    try {
      const state = await installGenesisResetStateUnderHeldLock(root, "next-stream", acquired.lock);
      expect(await fs.readFile(statePath(root), "utf8")).toBe(JSON.stringify({
        stream: "next-stream",
        stateNonce: state.stateNonce,
        stateRevision: 0,
        lastSyncedSequence: 0,
        lastSyncedManifest: { generatedAt: "", files: [] },
        repoRecords: {},
      }, null, 2));
      expect(await fs.readFile(path.join(root, ".rbox", "state", "state-incarnation.json"), "utf8")).toBe(JSON.stringify({
        stream: state.stream,
        stateNonce: state.stateNonce,
        stateRevision: 0,
      }, null, 2));
    } finally {
      await acquired.lock.release();
    }
  });
});
