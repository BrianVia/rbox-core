import { expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../engine/lockfile.js";
import { withRepositoryRecoveryFence } from "../cli/sync-git/protocol-locks.js";
import { authorityMarkerBytes } from "./state-plane/authority-marker.js";
import { StateWriteRefusedError } from "./state-plane/errors.js";
import { sqliteResetPaths } from "./state-plane/paths.js";
import { createStateStore } from "./state-plane/store/open.js";
import {
  applyStateSavePacket,
  installGenesisResetStateUnderHeldLock,
  loadState,
  stateLockPath,
  statePath,
  stateWasStreamMismatch,
} from "./sync-state-store.js";

for (const archiveSuffix of ["json", "db"] as const) {
  test(`seq-0 load preserves reset-lineage authorization from a .${archiveSuffix} archive`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `rbox-lineage-${archiveSuffix}-`));
    await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
    await fs.writeFile(statePath(root), JSON.stringify({
      stream: "stream",
      lastSyncedSequence: 0,
      lastSyncedManifest: { generatedAt: "", files: [] },
    }));
    const lineage = path.join(root, ".rbox", "state", "lineages", "1".repeat(32));
    await fs.mkdir(lineage, { recursive: true });
    await fs.writeFile(path.join(lineage, `${"2".repeat(64)}.${archiveSuffix}`), "opaque");

    const loaded = await loadState(root, "stream");
    expect(stateWasStreamMismatch(loaded)).toBe(true);
    await fs.rm(root, { recursive: true, force: true });
  });
}

test("seq-0 load silently skips stray legacy reset namespace entries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-lineage-strays-"));
  try {
    await fs.mkdir(path.dirname(statePath(root)), { recursive: true });
    await fs.writeFile(statePath(root), JSON.stringify({
      stream: "stream",
      lastSyncedSequence: 0,
      lastSyncedManifest: { generatedAt: "", files: [] },
    }));
    const stateRoot = path.join(root, ".rbox", "state");
    const lineage = path.join(stateRoot, "lineages", "1".repeat(32));
    await fs.mkdir(lineage, { recursive: true });
    await fs.mkdir(path.join(stateRoot, "reset-candidates"));
    await fs.writeFile(path.join(stateRoot, "lineages", ".DS_Store"), "Finder metadata");
    await fs.writeFile(path.join(stateRoot, "reset-candidates", "README"), "operator note");
    await fs.writeFile(path.join(lineage, `${"2".repeat(64)}.json`), "opaque");

    const loaded = await loadState(root, "stream");
    expect(stateWasStreamMismatch(loaded)).toBe(true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

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

test("selected Q boundary returns the literal typed unsupported refusal without changing bytes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-state-store-q-unsupported-"));
  try {
    await fs.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
    createStateStore(sqliteResetPaths.active(root), {
      authorityId: "a".repeat(32),
      lineageId: "b".repeat(32),
      stream: "stream",
      createdBy: "test",
      stateNonce: "c".repeat(32),
      stateRevision: 0,
    }).close();
    await fs.writeFile(statePath(root), authorityMarkerBytes("a".repeat(32)));
    const beforeMarker = await fs.readFile(statePath(root));
    const beforeStore = await fs.readFile(sqliteResetPaths.active(root));
    const result = await applyStateSavePacket(root, {
      expectedStream: "stream",
      expectedNonce: "c".repeat(32),
      sourceGlobalSeq: 1,
      repos: [],
    }, {
      lock: {
        identity: {
          current: async () => { throw new Error("identity unavailable"); },
          probe: async () => ({ status: "unknown" }),
        },
      },
    });
    expect(result.status).toBe("unsupported");
    if (result.status === "unsupported") expect(result.error).toBeInstanceOf(StateWriteRefusedError);
    expect(await fs.readFile(statePath(root))).toEqual(beforeMarker);
    expect(await fs.readFile(sqliteResetPaths.active(root))).toEqual(beforeStore);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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

      expect(steps.slice(0, 4)).toEqual([
        "rename state.json",
        `fsync ${stateParent}`,
        "unlink marker",
        `fsync ${markerParent}`,
      ]);
      // Design 163 B0's witness and reserve are written after that window and
      // may only add directory flushes to it — never another publication.
      expect(steps.slice(4).filter((step) => !step.startsWith("fsync "))).toEqual([]);
    } finally {
      await acquired.lock.release();
    }
  });
});

test("selected replacement is private to sync-state and never widens the store facade", async () => {
  const cli = path.dirname(new URL(import.meta.url).pathname);
  const syncState = await fs.readFile(path.join(cli, "sync-state.ts"), "utf8");
  const storeFacade = await fs.readFile(path.join(cli, "sync-state-store.ts"), "utf8");
  const configFacade = await fs.readFile(path.join(cli, "config.ts"), "utf8");
  expect(syncState.match(/\breplaceResetLineageStream\b/g)).toHaveLength(2);
  expect(storeFacade).not.toContain("replaceResetLineageStream");
  expect(configFacade).not.toContain("replaceResetLineageStream");
});
