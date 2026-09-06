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
import type { FileEntry } from "../../../engine/index.js";
import type { StateSavePacket, SyncState } from "../../sync-state-model.js";
import { elisionReceipt } from "../../sync-state-elision.js";
import { composeStateSavePacket, saveStateSource, type StateSource } from "../../sync-state.js";
import { authorityMarkerBytes } from "../authority-marker.js";
import { sqliteResetPaths, statePath } from "../paths.js";
import * as storeFacade from "../store-facade.js";
import * as readSnapshotModule from "../store/read-snapshot.js";
import { createStateStore, openStateStore, stateStoreDatabase } from "../store/open.js";
import { runStatement } from "../store/statements.js";
import { saveStateUnsafeLegacyOrTest } from "./legacy-json-store.js";
import { stateWasStreamMismatch } from "../reset-lineage.js";
import { readStateFreshnessFromStore } from "./read-only.js";
import { forgetState, memoizedDeltaFiles } from "./state-memo.js";
import { applyStateSavePacket, ensureTelemetryBindingId, loadRawState, loadState } from "./whole-state-compat.js";

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

const file = (filePath: string, value: number, extra: Partial<FileEntry> = {}): FileEntry => ({
  path: filePath, sha256: value.toString(16).padStart(64, "0"), size: value,
  mode: 0o644, mtimeMs: value, type: "file", ...extra,
});

const DELTA_BASE = [file("a.txt", 1), file("b.txt", 2), file("c.txt", 3)];

async function seedDeltaBase(root: string): Promise<SyncState> {
  const empty = await loadState(root, STREAM);
  return saveStateSource(root, empty, {
    expectedStream: STREAM, sourceGlobalSeq: 1,
    globalManifest: { generatedAt: "one", files: DELTA_BASE },
    observedRepos: [], values: {},
  });
}

function deltaSource(files: readonly FileEntry[], sourceGlobalSeq = 2): StateSource {
  return {
    expectedStream: STREAM, sourceGlobalSeq,
    globalManifest: { generatedAt: "two", files: [...files] },
    observedRepos: [], values: {}, baseIsUnscopedRemote: true,
  };
}

async function captureReuse<T>(run: () => Promise<T>): Promise<{
  result: T;
  reuse: Array<Parameters<typeof storeFacade.loadRawStateFromStore>[1]>;
}> {
  const original = storeFacade.loadRawStateFromStore;
  const reuse: Array<Parameters<typeof storeFacade.loadRawStateFromStore>[1]> = [];
  const spy = spyOn(storeFacade, "loadRawStateFromStore").mockImplementation((...args) => {
    reuse.push(args[1]);
    return original(...args);
  });
  try {
    return { result: await run(), reuse };
  } finally {
    spy.mockRestore();
  }
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

/** Design 302: after a global-free save the retained rows are still the store's
 * rows, so the read-back pages none — and still equals a fresh materialization
 * (`loadRawState` never reuses, so the drift audit keeps its fresh view). */
async function pagedFileRows(run: () => Promise<void>): Promise<number> {
  const original = readSnapshotModule.openReadSnapshot;
  let pages = 0;
  const spy = spyOn(readSnapshotModule, "openReadSnapshot").mockImplementation((store) => {
    const snapshot = original(store);
    const files = snapshot.files.bind(snapshot);
    snapshot.files = (plane, after, batch) => { pages += 1; return files(plane, after, batch); };
    return snapshot;
  });
  try { await run(); } finally { spy.mockRestore(); }
  return pages;
}

test("a repo-only save reads back without paging file rows and equals a fresh materialization", async () => {
  const root = await sqliteWorkspace("files-memo");
  const before = await loadState(root, STREAM); // retained with its rows
  let saved: SyncState | undefined;
  const pages = await pagedFileRows(async () => {
    saved = await saveStateSource(root, before, {
      expectedStream: STREAM, sourceGlobalSeq: before.lastSyncedSequence,
      observedRepos: ["r"], values: { partial: { r: null } },
    });
  });
  expect(pages).toBe(0);
  expect(saved!.stateRevision).toBe(before.stateRevision! + 1);
  expect(saved).toEqual((await loadRawState(root))!);
});

test("a load after a foreign revision bump re-reads records but not the untouched rows", async () => {
  const root = await sqliteWorkspace("files-memo-foreign");
  await loadState(root, STREAM);
  mutateStoreOutsideTheAdapter(root, "UPDATE state_lineage SET state_revision=state_revision+1");
  let loaded: SyncState | undefined;
  const pages = await pagedFileRows(async () => { loaded = await loadState(root, STREAM); });
  expect(pages).toBe(0);
  expect(loaded).toEqual((await loadRawState(root))!);
});

test("a global save advances the base generation and the next read-back pages fresh rows", async () => {
  const root = await sqliteWorkspace("files-memo-global");
  const before = await loadState(root, STREAM);
  let saved: SyncState | undefined;
  const pages = await pagedFileRows(async () => {
    saved = await saveStateSource(root, before, {
      expectedStream: STREAM, sourceGlobalSeq: before.lastSyncedSequence + 1,
      globalManifest: { generatedAt: "2026-09-05T00:00:00.000Z", files: [] },
      observedRepos: [], values: {},
    });
  });
  expect(pages).toBeGreaterThan(0);
  expect(saved).toEqual((await loadRawState(root))!);
});

test("loadRawState never reuses retained rows", async () => {
  const root = await sqliteWorkspace("files-memo-raw");
  await loadState(root, STREAM);
  const pages = await pagedFileRows(async () => { await loadRawState(root); });
  expect(pages).toBeGreaterThan(0);
});

test("RBOX_STATE_LOAD_CACHE=0 disables base-file reuse too", async () => {
  process.env.RBOX_STATE_LOAD_CACHE = "0";
  const root = await sqliteWorkspace("files-memo-off");
  const before = await loadState(root, STREAM);
  const pages = await pagedFileRows(async () => {
    await saveStateSource(root, before, {
      expectedStream: STREAM, sourceGlobalSeq: before.lastSyncedSequence,
      observedRepos: ["r"], values: { partial: { r: null } },
    });
  });
  expect(pages).toBeGreaterThan(0);
});

test("design 313: a delta-carrying save reuses retained rows and equals a fresh raw load", async () => {
  const root = await sqliteWorkspace("delta-reuse");
  const before = await seedDeltaBase(root);
  const files = [DELTA_BASE[0]!, file("b.txt", 9), DELTA_BASE[2]!];
  expect(composeStateSavePacket(before, deltaSource(files)).globalDelta).toBeDefined();

  const captured = await captureReuse(() => saveStateSource(root, before, deltaSource(files)));
  const raw = (await loadRawState(root))!;
  expect(captured.reuse).toHaveLength(1);
  expect(captured.reuse[0]?.baseFiles).toEqual(raw.lastSyncedManifest.files);
  expect(captured.result).toEqual(raw);
  expect(await countMaterializations(async () => { await loadState(root, STREAM); })).toBe(0);
  expect(await loadState(root, STREAM)).toEqual(raw);
});

test("design 313b: a zero-op delta keeps the retained file array by identity", async () => {
  const root = await sqliteWorkspace("delta-zero-op");
  const before = await seedDeltaBase(root);
  const source = {
    ...deltaSource(before.lastSyncedManifest.files),
    globalManifest: { generatedAt: "two", files: before.lastSyncedManifest.files },
  };
  expect(composeStateSavePacket(before, source).globalDelta?.ops).toEqual([]);

  const saved = await saveStateSource(root, before, source);
  expect(saved.lastSyncedManifest.files).toBe(before.lastSyncedManifest.files);
  expect(saved).toEqual((await loadRawState(root))!);
});

test("design 313: upserts normalize like the store", async () => {
  const cases: FileEntry[] = [
    { extraZ: null, ...file("b.txt", 9, { mtimeMs: -0 }), extraA: { nested: true } } as FileEntry,
    file("b.txt", 9, { type: "symlink", symlinkTarget: "target" }),
  ];
  for (const [index, changed] of cases.entries()) {
    const root = await sqliteWorkspace(`delta-normalize-${index}`);
    const before = await seedDeltaBase(root);
    const files = [DELTA_BASE[0]!, changed, DELTA_BASE[2]!];
    const captured = await captureReuse(() => saveStateSource(root, before, deltaSource(files)));
    const raw = (await loadRawState(root))!;
    expect(captured.reuse[0]?.baseFiles).toEqual(raw.lastSyncedManifest.files);
    expect(captured.result).toEqual(raw);
  }
});

test("design 313: no retained predecessor pages", async () => {
  const root = await sqliteWorkspace("delta-no-predecessor");
  await seedDeltaBase(root);
  forgetState(root);
  const before = (await loadRawState(root))!;
  const files = [DELTA_BASE[0]!, file("b.txt", 9), DELTA_BASE[2]!];
  const captured = await captureReuse(() => saveStateSource(root, before, deltaSource(files)));
  expect(captured.reuse.every((reuse) => reuse === undefined)).toBe(true);
  expect(captured.result).toEqual((await loadRawState(root))!);

  const racedRoot = await sqliteWorkspace("delta-foreign-revision");
  const racedBefore = await seedDeltaBase(racedRoot);
  let interleaved = false;
  const apply: typeof applyStateSavePacket = async (...args) => {
    if (!interleaved) {
      interleaved = true;
      mutateStoreOutsideTheAdapter(racedRoot, "UPDATE state_lineage SET state_revision=state_revision+1");
    }
    return applyStateSavePacket(...args);
  };
  const raced = await captureReuse(() => saveStateSource(
    racedRoot, racedBefore, deltaSource(files), { apply },
  ));
  expect(raced.reuse.every((reuse) => reuse === undefined)).toBe(true);
  expect(raced.result).toEqual((await loadRawState(racedRoot))!);
});

test("design 313: the memo refuses a delta its retained rows cannot satisfy", async () => {
  const root = await sqliteWorkspace("delta-refusal");
  const state = await seedDeltaBase(root);
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  const token = readStateFreshnessFromStore(store);
  store.close();
  if (state.stateNonce === undefined || state.stateRevision === undefined) throw new Error("seed lacks delta binding");
  expect(memoizedDeltaFiles(root, {
    binding: { nonce: state.stateNonce, stateRevision: state.stateRevision },
    ops: [{ kind: "delete", path: "absent" }],
  }, { ...token, baseGeneration: token.baseGeneration + 1 })).toBeUndefined();
});

test("design 313: caller mutation after the call cannot reach staging or the memo", async () => {
  const root = await sqliteWorkspace("delta-detach");
  const before = await seedDeltaBase(root);
  const files = [DELTA_BASE[0]!, file("b.txt", 9), DELTA_BASE[2]!];
  const packet = composeStateSavePacket(before, deltaSource(files));
  expect(packet.globalDelta).toBeDefined();
  if (packet.globalDelta === undefined) return;
  const callerOps = [...packet.globalDelta.ops];
  const mutablePacket: StateSavePacket = { ...packet, globalDelta: { ...packet.globalDelta, ops: callerOps } };
  const pending = applyStateSavePacket(root, mutablePacket);
  callerOps.push({ kind: "upsert", entry: file("z.txt", 10) });
  const result = await pending;
  expect(result.status).toBe("accepted");
  if (result.status === "accepted") expect(result.state).toEqual((await loadRawState(root))!);
});

test("design 313: a delta never carries an elisionExpectation", async () => {
  const root = await sqliteWorkspace("delta-expectation");
  const before = await seedDeltaBase(root);
  const files = [DELTA_BASE[0]!, file("b.txt", 9), DELTA_BASE[2]!];
  const receipt = elisionReceipt(before, { noActions: true, storedBaseIsRemote: true });
  expect(receipt).toBeDefined();
  const packet = composeStateSavePacket(before, { ...deltaSource(files), elisionReceipt: receipt });
  expect(packet.global).toBeDefined();
  expect(packet.globalDelta).toBeDefined();
  expect(packet.elisionExpectation).toBeUndefined();
});

test("design 313: full-global saves page and the cache kill switch refuses delta reuse", async () => {
  const root = await sqliteWorkspace("delta-full-pages");
  const before = await seedDeltaBase(root);
  const reversed = [...DELTA_BASE].reverse();
  expect(composeStateSavePacket(before, deltaSource(reversed)).globalDelta).toBeUndefined();
  const full = await captureReuse(() => saveStateSource(root, before, deltaSource(reversed)));
  expect(full.reuse.every((reuse) => reuse === undefined)).toBe(true);

  const offRoot = await sqliteWorkspace("delta-cache-off");
  const offBefore = await seedDeltaBase(offRoot);
  process.env.RBOX_STATE_LOAD_CACHE = "0";
  const files = [DELTA_BASE[0]!, file("b.txt", 9), DELTA_BASE[2]!];
  const off = await captureReuse(() => saveStateSource(offRoot, offBefore, deltaSource(files)));
  expect(off.reuse.every((reuse) => reuse === undefined)).toBe(true);
});
