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
import { createStateStore, openStateStore, stateStoreDatabase } from "../store/open.js";
import { runStatement } from "../store/statements.js";
import { saveStateUnsafeLegacyOrTest } from "./legacy-json-store.js";
import { stateWasStreamMismatch } from "../reset-lineage.js";
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

/**
 * Mutate the live database WITHOUT going through the adapter, so the retention
 * stays resident and stale — the multi-process case. Anything the adapter does
 * for itself (refreshing on its own save) would prove nothing about the token
 * comparison, which is the only thing standing between a stale memo and a
 * wrong answer.
 */
function mutateStoreOutsideTheAdapter(root: string, sql: string, ...bindings: string[]): void {
  mutateStoreInOneOpen(root, [[sql, ...bindings]]);
}

/** Several statements on ONE handle: the open validation runs per open, so a
 * change that spans two rows cannot be split across two of them. */
function mutateStoreInOneOpen(root: string, statements: readonly (readonly string[])[]): void {
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: false });
  try {
    for (const [sql, ...bindings] of statements) runStatement(stateStoreDatabase(store), sql!, ...bindings);
  } finally {
    store.close();
  }
}

async function materializationsForNextLoad(root: string): Promise<number> {
  return countMaterializations(async () => {
    const state = await loadState(root, STREAM);
    expect(state).toEqual((await loadRawState(root))!);
  }) .then((loads) => loads - 1); // the loadRawState comparison read is not the load under test
}

test("a foreign state_revision bump forces exactly one rematerialization", async () => {
  const root = await sqliteWorkspace("column-revision");
  await loadState(root, STREAM);
  mutateStoreOutsideTheAdapter(root, "UPDATE state_lineage SET state_revision=state_revision+1");
  expect(await materializationsForNextLoad(root)).toBe(1);
  expect(await materializationsForNextLoad(root)).toBe(0); // and settles again
});

test("a foreign state_nonce change forces exactly one rematerialization", async () => {
  const root = await sqliteWorkspace("column-nonce");
  await loadState(root, STREAM);
  mutateStoreOutsideTheAdapter(root, "UPDATE state_lineage SET state_nonce=?", "f".repeat(32));
  expect(await materializationsForNextLoad(root)).toBe(1);
  expect((await loadState(root, STREAM)).stateNonce).toBe("f".repeat(32));
});

test("a foreign telemetry_binding_id change forces exactly one rematerialization", async () => {
  const root = await sqliteWorkspace("column-binding");
  await loadState(root, STREAM);
  mutateStoreOutsideTheAdapter(root, "UPDATE state_lineage SET telemetry_binding_id=?", "00112233445566ff");
  expect(await materializationsForNextLoad(root)).toBe(1);
  expect((await loadState(root, STREAM)).telemetryBindingId).toBe("00112233445566ff");
});

test("a replaced authority and lineage force a rematerialization", async () => {
  const root = await sqliteWorkspace("column-lineage");
  await loadState(root, STREAM);
  // How authority and lineage actually move: the workspace is reset onto a new
  // database, and the marker names it.
  await fsp.rm(sqliteResetPaths.active(root), { force: true });
  createStateStore(sqliteResetPaths.active(root), {
    authorityId: "9".repeat(32), lineageId: "8".repeat(32), stream: STREAM,
    createdBy: "test", stateNonce: NONCE, stateRevision: 0,
  }).close();
  await fsp.writeFile(statePath(root), authorityMarkerBytes("9".repeat(32)));
  expect(await materializationsForNextLoad(root)).toBe(1);
});

test("an authority that moves ALONE forces a rematerialization", async () => {
  // The lineage row is left byte-identical — same lineage_id, stream, nonce,
  // revision, binding — so this test fails if `authorityId` stops being part of
  // the comparison. Authority and lineage usually move together; that is
  // exactly why the column needs its own witness.
  const root = await sqliteWorkspace("column-authority");
  const before = await loadState(root, STREAM);
  const successor = "9".repeat(32);
  // The authority id is carried by the marker, store_meta, and the completion
  // record the open validation counts against it — move all three, and nothing
  // else, so the lineage row this comparison reads is untouched.
  mutateStoreInOneOpen(root, [
    ["UPDATE store_meta SET authority_id=? WHERE singleton=1", successor],
    ["UPDATE migration_completion SET authority_id=? WHERE singleton=1", successor],
  ]);
  await fsp.writeFile(statePath(root), authorityMarkerBytes(successor));

  expect(await materializationsForNextLoad(root)).toBe(1);
  const after = await loadState(root, STREAM);
  expect(after.stateNonce).toBe(before.stateNonce);
  expect(after.stateRevision).toBe(before.stateRevision);
  expect(await materializationsForNextLoad(root)).toBe(0); // and settles again
});

test("a foreign stream change is refused, never served from retention", async () => {
  const root = await sqliteWorkspace("column-stream");
  await loadState(root, STREAM);
  mutateStoreOutsideTheAdapter(root, "UPDATE state_lineage SET stream=?", "https://api.test::moved::root");
  await expect(loadState(root, STREAM)).rejects.toThrow(/stream/);
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

const RECEIPT = {
  repo: "repo", attemptedGitIncomingKey: "attempted", attemptedSequence: 1,
  confirmedReportHash: "4".repeat(64),
};

test("RBOX_STATE_FREEZE=1 freezes DEEPLY nested state, not just the top containers", async () => {
  // The aliasing gate is only as strong as its depth: design 43/273's git
  // machinery lives in nested members (repo records' receipts, deferrals,
  // partial applies, git sections' refs), which is exactly where an in-place
  // mutation would hide.
  const root = await sqliteWorkspace("deep-freeze");
  const before = await loadState(root, STREAM);
  await saveStateSource(root, before, {
    expectedStream: STREAM,
    sourceGlobalSeq: before.lastSyncedSequence,
    observedRepos: ["repo"],
    values: { resolutionReceipt: { repo: RECEIPT } },
  });

  process.env.RBOX_STATE_FREEZE = "1";
  try {
    const state = await loadState(root, STREAM);
    const record = state.repoRecords?.repo;
    expect(record).toBeDefined();
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record!.resolutionReceipt)).toBe(true);
    expect(() => { (record!.resolutionReceipt as { repo: string }).repo = "moved"; }).toThrow();
  } finally {
    delete process.env.RBOX_STATE_FREEZE;
  }
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

/** Reset-v1's hash-addressed old-lineage archive: the durable evidence that a
 * seq-0 state came from a rebind/freshening rather than true genesis. */
async function plantResetLineageArchive(root: string): Promise<string> {
  const archive = path.join(sqliteResetPaths.stateRoot(root), "lineages", "d".repeat(32));
  await fsp.mkdir(archive, { recursive: true });
  await fsp.writeFile(path.join(archive, `${"e".repeat(64)}.db`), "archive");
  return path.join(sqliteResetPaths.stateRoot(root), "lineages");
}

test("a rebind-marked state is never retained, so its provenance cannot outlive the evidence", async () => {
  const root = await sqliteWorkspace("provenance");
  const lineages = await plantResetLineageArchive(root);
  const marked = await loadState(root, STREAM);
  expect(stateWasStreamMismatch(marked)).toBe(true);

  // The archive is the evidence. Once it is gone the next load must re-derive
  // from durable facts — a retained object would carry the sticky mark forever.
  await fsp.rm(lineages, { recursive: true, force: true });
  const reloaded = await loadState(root, STREAM);
  expect(stateWasStreamMismatch(reloaded)).toBe(false);
});

test("provenance is re-derived on every load, including one served from retention", async () => {
  const root = await sqliteWorkspace("provenance-appears");
  const clean = await loadState(root, STREAM);
  expect(stateWasStreamMismatch(clean)).toBe(false);
  await plantResetLineageArchive(root);
  expect(stateWasStreamMismatch(await loadState(root, STREAM))).toBe(true);
});

test("the two-read safety argument: state_revision is strictly monotonic per lineage", async () => {
  // The token and the projection are two reads on one handle. That is safe only
  // because a revision never repeats within a lineage and a lineage id is never
  // reused — a writer landing between them can make the NEXT comparison miss,
  // never make a superseded state look current.
  const root = await sqliteWorkspace("monotonic");
  const revisions: number[] = [];
  for (let round = 0; round < 4; round++) {
    const state = await loadState(root, STREAM);
    revisions.push(state.stateRevision!);
    await save(root, state);
  }
  expect(revisions).toEqual([...revisions].sort((left, right) => left - right));
  expect(new Set(revisions).size).toBe(revisions.length);

  // And the bump is computed from the CAS-checked expectation, not from a value
  // the caller supplied — the one line that argument rests on.
  const writer = fs.readFileSync(path.resolve(import.meta.dir, "../store/write-packet.ts"), "utf8");
  expect(writer).toContain("frozen.expected.stateRevision + 1");
});

/** Design 301: a global-free save reuses the snapshot's untouched base file
 * rows and reads the repo records back — the result must equal a fresh
 * read-back exactly, and a stale snapshot must never be trusted. */
test("a repo-only save returns exactly the read-back while reusing the untouched files", async () => {
  const root = await sqliteWorkspace("repo-only");
  const before = await loadState(root, STREAM);
  const filesSpy = spyOn(storeFacade, "loadRawStateFromStore");
  let saved: SyncState | undefined;
  try {
    saved = await saveStateSource(root, before, {
      expectedStream: STREAM, sourceGlobalSeq: before.lastSyncedSequence,
      observedRepos: ["r"], values: { partial: { r: null } },
    });
    // The one read-back was told which rows it may skip.
    expect(filesSpy).toHaveBeenCalledTimes(1);
    expect(filesSpy.mock.calls[0]?.[1]).toEqual({ baseFiles: before.lastSyncedManifest.files });
  } finally {
    filesSpy.mockRestore();
  }
  expect(saved).toEqual((await loadRawState(root))!);
  expect(saved!.stateRevision).toBe(before.stateRevision! + 1);
});

test("a stale snapshot never gets its files reused", async () => {
  const root = await sqliteWorkspace("stale-snapshot");
  const stale = await loadState(root, STREAM);
  mutateStoreOutsideTheAdapter(root, "UPDATE state_lineage SET state_revision=state_revision+1");
  const filesSpy = spyOn(storeFacade, "loadRawStateFromStore");
  try {
    const saved = await saveStateSource(root, stale, {
      expectedStream: STREAM, sourceGlobalSeq: stale.lastSyncedSequence,
      observedRepos: ["r"], values: { partial: { r: null } },
    });
    // The accepted read-back had no reuse: the CAS token is two past the snapshot.
    expect(filesSpy.mock.calls.every((call) => call[1] === undefined)).toBe(true);
    expect(saved).toEqual((await loadRawState(root))!);
  } finally {
    filesSpy.mockRestore();
  }
});

test("a save that carries a global section reads everything back", async () => {
  const root = await sqliteWorkspace("global-readback");
  const before = await loadState(root, STREAM);
  const filesSpy = spyOn(storeFacade, "loadRawStateFromStore");
  let saved: SyncState | undefined;
  try {
    saved = await saveStateSource(root, before, {
      expectedStream: STREAM, sourceGlobalSeq: before.lastSyncedSequence + 1,
      globalManifest: { generatedAt: "2026-09-05T00:00:00.000Z", files: [] },
      observedRepos: [], values: {},
    });
    expect(filesSpy).toHaveBeenCalledTimes(1);
    expect(filesSpy.mock.calls[0]?.[1]).toBeUndefined();
  } finally {
    filesSpy.mockRestore();
  }
  expect(saved).toEqual((await loadRawState(root))!);
});
