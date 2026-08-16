import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { FileEntry, Manifest } from "../../src/engine/index.js";
import type { StateSavePacket } from "../../src/cli/sync-state-model.js";
import { applySavePacketToStore } from "../../src/cli/state-plane/adapters/sqlite-state-save.js";
import { loadRawStateFromStore } from "../../src/cli/state-plane/adapters/read-only.js";
import { createStateStore } from "../../src/cli/state-plane/store/open.js";
import { casOwnerTokenFromLock } from "../../src/cli/state-plane/store/owner-token.js";
import type { OwnedLock } from "../../src/engine/lockfile.js";

const DEFAULT_N = 119_000;
const count = Number(process.env.BENCH_N ?? DEFAULT_N);
if (!Number.isSafeInteger(count) || count < 1) {
  throw new TypeError("BENCH_N must be a positive safe integer");
}

const STREAM = "bench://state-plane";
const NONCE = "c".repeat(32);
// The bench owns its scratch store outright, so a trivially-held lock is honest.
const OWNER = casOwnerTokenFromLock({ isOwnerSync: () => true } as OwnedLock);
const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-state-plane-bench-"));

function file(index: number, changed = false): FileEntry {
  const ordinal = String(index).padStart(8, "0");
  return {
    path: `files/${ordinal}.bin`,
    sha256: (changed ? "f" : (index % 16).toString(16)).repeat(64),
    size: changed ? index + 1 : index,
    mode: 0o644,
    mtimeMs: changed ? index + 0.75 : index + 0.25,
    type: "file",
  };
}

function packet(files: FileEntry[], sourceGlobalSeq: number): StateSavePacket {
  return {
    expectedStream: STREAM,
    expectedNonce: NONCE,
    sourceGlobalSeq,
    global: {
      manifest: {
        generatedAt: `2026-08-12T00:00:0${sourceGlobalSeq}.000Z`,
        manifestSchema: 2,
        files,
      } as Manifest,
    },
    repos: [],
  };
}

async function timed(name: string, operation: () => unknown | Promise<unknown>): Promise<number> {
  const started = performance.now();
  await operation();
  const elapsed = performance.now() - started;
  console.log(`${name}: ${elapsed.toFixed(2)} ms`);
  return elapsed;
}

const coldFiles = Array.from({ length: count }, (_, index) => file(index));
const steadyFiles = coldFiles.slice();
steadyFiles[Math.floor(count / 2)] = file(Math.floor(count / 2), true);

try {
  let store!: ReturnType<typeof createStateStore>;
  await timed("create_store", () => {
    store = createStateStore(path.join(root, "state.db"), {
      authorityId: "a".repeat(32),
      lineageId: "b".repeat(32),
      stream: STREAM,
      createdBy: "state-plane-bench",
      stateNonce: NONCE,
      stateRevision: 0,
    });
  });
  await timed("save_cold", async () => {
    const result = await applySavePacketToStore(store, packet(coldFiles, 1), OWNER);
    if (result.status !== "accepted") throw new Error(`cold save returned ${result.status}`);
  });
  await timed("save_steady_one_changed", async () => {
    const result = await applySavePacketToStore(store, packet(steadyFiles, 2), OWNER);
    if (result.status !== "accepted") throw new Error(`steady save returned ${result.status}`);
  });
  // Design 267's minimal packet. This times the SAVE only; whether a real pull
  // elides is decided in composeStateSavePacket and is not visible here — the
  // field trace is the authority for the end-to-end number.
  await timed("save_minimal_noop", async () => {
    const result = await applySavePacketToStore(store, {
      expectedStream: STREAM, expectedNonce: NONCE, sourceGlobalSeq: 3, repos: [],
      elisionExpectation: { nonce: NONCE, stateRevision: 2 },
    }, OWNER);
    if (result.status !== "accepted") throw new Error(`minimal save returned ${result.status}`);
  });
  await timed("load_full", () => {
    const state = loadRawStateFromStore(store);
    if (state.lastSyncedManifest.files.length !== count) {
      throw new Error(`load returned ${state.lastSyncedManifest.files.length} files, expected ${count}`);
    }
    const middle = state.lastSyncedManifest.files[Math.floor(count / 2)]!;
    if (middle.path !== steadyFiles[Math.floor(count / 2)]!.path || middle.sha256 !== "f".repeat(64)) {
      throw new Error("load did not return the changed middle entry");
    }
    if (state.lastSyncedManifest.files[0]!.path !== coldFiles[0]!.path
      || state.lastSyncedManifest.files.at(-1)!.path !== coldFiles.at(-1)!.path) {
      throw new Error("load did not preserve representative manifest values");
    }
  });
  store.close();
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
