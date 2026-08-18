/**
 * Design 277 §A2: the freshness probe and the boundary-fence identity read.
 *
 * The probe's whole job is to answer "is the state I hold still the state the
 * store holds?" without materializing it, so every test here writes through a
 * REAL writer and asks the probe about a state loaded before that write.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SyncState } from "../../sync-state-model.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import { createStateStore } from "../store/open.js";
import { loadRawStateIdentity, probeStateFreshness, stateMatchesFreshness } from "./lineage-reads.js";
import { ensureTelemetryBindingId, loadState } from "./whole-state-compat.js";
import { saveStateUnsafeLegacyOrTest } from "./legacy-json-store.js";
import { saveStateSource } from "../../sync-state.js";

const STREAM = "https://api.test::ws_277::root";
const AUTHORITY = "a".repeat(32);
const LINEAGE = "b".repeat(32);
const NONCE = "c".repeat(32);

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

async function sqliteWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-277-${prefix}-`));
  roots.push(root);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: AUTHORITY, lineageId: LINEAGE, stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes(AUTHORITY));
  return root;
}

async function legacyWorkspace(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-277-${prefix}-`));
  roots.push(root);
  await saveStateUnsafeLegacyOrTest(root, {
    stream: STREAM, stateNonce: NONCE, stateRevision: 0,
    lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

function saveThrough(root: string, state: SyncState): Promise<unknown> {
  return saveStateSource(root, state, {
    expectedStream: STREAM,
    sourceGlobalSeq: state.lastSyncedSequence,
    observedRepos: [],
    values: {},
  });
}

test("an unchanged store probes as the state the caller holds", async () => {
  const root = await sqliteWorkspace("unchanged");
  const state = await loadState(root, STREAM);
  const probe = await probeStateFreshness(root, STREAM);
  expect(probe).toBeDefined();
  expect(probe!.authorityId).toBe(AUTHORITY);
  expect(probe!.lineageId).toBe(LINEAGE);
  expect(stateMatchesFreshness(state, probe!)).toBe(true);
});

test("an accepted save moves the probed tokens away from the held state", async () => {
  const root = await sqliteWorkspace("saved");
  const before = await loadState(root, STREAM);
  await saveThrough(root, before);
  const probe = await probeStateFreshness(root, STREAM);
  expect(probe).toBeDefined();
  expect(stateMatchesFreshness(before, probe!)).toBe(false);
  expect(stateMatchesFreshness(await loadState(root, STREAM), probe!)).toBe(true);
});

test("the non-CAS telemetry writer moves a probed token too", async () => {
  // The negative control for design 277 §A2's writer audit: this is the ONE
  // production writer that bumps no revision, which is exactly why
  // `telemetry_binding_id` is one of the probed columns.
  const root = await sqliteWorkspace("telemetry");
  const before = await loadState(root, STREAM);
  expect(before.telemetryBindingId).toBeUndefined();
  expect(stateMatchesFreshness(before, (await probeStateFreshness(root, STREAM))!)).toBe(true);

  await ensureTelemetryBindingId(root, STREAM, () => Buffer.from("0011223344556677", "hex"));

  const probe = await probeStateFreshness(root, STREAM);
  expect(probe!.telemetryBindingId).toBe("0011223344556677");
  expect(probe!.stateRevision).toBe(before.stateRevision);
  expect(stateMatchesFreshness(before, probe!)).toBe(false);
});

test("a legacy JSON authority never probes, so it never reuses", async () => {
  const root = await legacyWorkspace("legacy");
  expect(await probeStateFreshness(root, STREAM)).toBeUndefined();
});

test("an uninitialized workspace never probes", async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-277-absent-"));
  roots.push(root);
  expect(await probeStateFreshness(root, STREAM)).toBeUndefined();
});

test("a different stream never probes", async () => {
  const root = await sqliteWorkspace("stream");
  expect(await probeStateFreshness(root, "https://api.test::other::root")).toBeUndefined();
});

test("the boundary identity read reports stream and nonce for both backends", async () => {
  const sqlite = await sqliteWorkspace("identity");
  expect(await loadRawStateIdentity(sqlite)).toEqual({ stream: STREAM, stateNonce: NONCE });
  const legacy = await legacyWorkspace("identity-legacy");
  expect(await loadRawStateIdentity(legacy)).toMatchObject({ stream: STREAM, stateNonce: NONCE });
  const absent = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-277-identity-absent-"));
  roots.push(absent);
  expect(await loadRawStateIdentity(absent)).toBeUndefined();
});
