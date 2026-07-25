import { expect, spyOn, test } from "bun:test";
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

/** Records the durability-relevant syscalls of a bun spy in global call order. */
interface CallTrace {
  mock: { calls: unknown[][]; invocationCallOrder: number[] };
}

test("an accepted state CAS publishes state.json's parent before retiring the incarnation marker", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-durability-"));
  await fs.mkdir(path.join(root, ".rbox", "state"), { recursive: true });
  const stateParent = path.dirname(statePath(root));
  const markerPath = path.join(root, ".rbox", "state", "state-incarnation.json");
  const markerParent = path.dirname(markerPath);
  expect(stateParent).not.toBe(markerParent);

  await withRepositoryRecoveryFence([], path.resolve(statePath(root)), async () => {
    const acquired = await acquireLock(stateLockPath(root));
    expect(acquired.status).toBe("acquired");
    if (acquired.status !== "acquired") return;
    try {
      const genesis = await installGenesisResetStateUnderHeldLock(root, "durable-stream", acquired.lock);

      // Real crash consistency is not observable in-process, but the ORDER that
      // makes a crash recoverable is: publish state.json's own parent, and only
      // then retire the marker that backs it up. The held lock keeps the lockfile's
      // own `.rbox` fsyncs out of the traced window.
      const open = spyOn(fs, "open");
      const rename = spyOn(fs, "rename");
      const rm = spyOn(fs, "rm");
      let steps: string[];
      try {
        const result = await applyStateSavePacket(root, {
          expectedStream: "durable-stream",
          expectedNonce: genesis.stateNonce!,
          sourceGlobalSeq: 0,
          repos: [],
        }, { heldLock: acquired.lock });
        expect(result.status).toBe("accepted");

        const events: { order: number; step: string }[] = [];
        const trace = (spy: CallTrace, label: (args: unknown[]) => string | undefined): void => {
          spy.mock.calls.forEach((args, index) => {
            const step = label(args);
            if (step !== undefined) events.push({ order: spy.mock.invocationCallOrder[index]!, step });
          });
        };
        trace(open, (args) => args[0] === stateParent || args[0] === markerParent ? `fsync ${String(args[0])}` : undefined);
        trace(rename, (args) => args[1] === statePath(root) ? "rename state.json" : undefined);
        trace(rm, (args) => args[0] === markerPath ? "unlink marker" : undefined);
        steps = events.sort((a, b) => a.order - b.order).map((event) => event.step);
      } finally {
        open.mockRestore();
        rename.mockRestore();
        rm.mockRestore();
      }

      expect(steps).toEqual([
        "rename state.json",
        `fsync ${stateParent}`,
        "unlink marker",
        `fsync ${markerParent}`,
      ]);
    } finally {
      await acquired.lock.release();
    }
  });
});
