/**
 * Design 277 §A: the loaded-state memo, tested through the real adapter.
 *
 * Every assertion here compares what `loadState` returns against a fresh
 * `loadRawState`, which never consults the memo — a retention that is ever
 * wrong shows up as a difference, not as a passing count.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SyncState } from "../../sync-state-model.js";
import { saveStateSource } from "../../sync-state.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import * as storeFacade from "../store-facade.js";
import { createStateStore } from "../store/open.js";
import { saveStateUnsafeLegacyOrTest } from "./legacy-json-store.js";
import { ensureTelemetryBindingId, loadRawState, loadState } from "./whole-state-compat.js";

const STREAM = "https://api.test::ws_memo::root";
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);

const roots: string[] = [];
afterEach(() => {
  delete process.env.RBOX_STATE_LOAD_CACHE;
  delete process.env.RBOX_STATE_FREEZE;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function sqliteWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-memo-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  return root;
}

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

function save(root: string, state: SyncState): Promise<unknown> {
  return saveStateSource(root, state, {
    expectedStream: STREAM,
    sourceGlobalSeq: state.lastSyncedSequence,
    observedRepos: [],
    values: {},
  });
}

test("a second load of an unchanged store materializes nothing and returns the same state", async () => {
  const root = await sqliteWorkspace("hit");
  const first = await loadState(root, STREAM);
  const loads = await countMaterializations(async () => {
    const second = await loadState(root, STREAM);
    expect(second).toBe(first);
    expect(second).toEqual((await loadRawState(root))!);
  });
  expect(loads).toBe(1); // the raw comparison read, not the memoized load
});

test("an accepted save leaves the loads that follow it free and exact", async () => {
  const root = await sqliteWorkspace("save");
  const before = await loadState(root, STREAM);
  await save(root, before);
  const loads = await countMaterializations(async () => {
    const after = await loadState(root, STREAM);
    expect(after).not.toBe(before);
    expect(after.stateRevision).not.toBe(before.stateRevision);
  });
  expect(loads).toBe(0);
  expect(await loadState(root, STREAM)).toEqual((await loadRawState(root))!);
});

test("a foreign write moves the probed token and forces a materialization", async () => {
  const root = await sqliteWorkspace("foreign");
  const held = await loadState(root, STREAM);
  // Another writer, out of band: the memo must not answer for it.
  await save(root, held);
  const loads = await countMaterializations(async () => {
    // Drop the save's own retention the way a different process would: the
    // token comparison, not the writer, is what decides.
    process.env.RBOX_STATE_LOAD_CACHE = "0";
    await loadState(root, STREAM);
    delete process.env.RBOX_STATE_LOAD_CACHE;
    const reloaded = await loadState(root, STREAM);
    expect(reloaded).toEqual((await loadRawState(root))!);
  });
  expect(loads).toBeGreaterThanOrEqual(2);
});

test("the non-CAS telemetry writer is covered by the probed binding column", async () => {
  const root = await sqliteWorkspace("telemetry");
  const before = await loadState(root, STREAM);
  expect(before.telemetryBindingId).toBeUndefined();
  const minted = await ensureTelemetryBindingId(root, STREAM, () => Buffer.from("0011223344556677", "hex"));
  expect(minted.state.stateRevision).toBe(before.stateRevision);
  const after = await loadState(root, STREAM);
  expect(after.telemetryBindingId).toBe("0011223344556677");
  expect(after).toEqual((await loadRawState(root))!);
});

test("RBOX_STATE_LOAD_CACHE=0 materializes every load", async () => {
  const root = await sqliteWorkspace("killswitch");
  await loadState(root, STREAM);
  process.env.RBOX_STATE_LOAD_CACHE = "0";
  const loads = await countMaterializations(async () => {
    await loadState(root, STREAM);
    await loadState(root, STREAM);
  });
  expect(loads).toBe(2);
});

test("a legacy JSON authority is never memoized", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-memo-legacy-"));
  roots.push(root);
  await saveStateUnsafeLegacyOrTest(root, {
    stream: STREAM, stateNonce: NONCE, stateRevision: 0,
    lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files: [] },
  });
  const first = await loadState(root, STREAM);
  const second = await loadState(root, STREAM);
  expect(second).not.toBe(first);
  expect(second).toEqual(first);
});

test("RBOX_STATE_FREEZE=1 makes a retained state immutable for the aliasing sweep", async () => {
  // The precondition for sharing one object between callers. The design's
  // validation runs the whole CLI suite with this on; here it is pinned as the
  // mechanism it is.
  const root = await sqliteWorkspace("frozen");
  process.env.RBOX_STATE_FREEZE = "1";
  try {
    const state = await loadState(root, STREAM);
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.lastSyncedManifest)).toBe(true);
    expect(await loadState(root, STREAM)).toBe(state);
  } finally {
    delete process.env.RBOX_STATE_FREEZE;
  }
});
