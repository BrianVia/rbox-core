/**
 * Design 269 §6 — the authority for the delta seam, at `saveStateSource` level.
 *
 * A projection-only comparison would hide row divergence identically in both
 * arms, so every case here compares the full read-back AND the durable
 * `plane_entries` rows including `changed_generation`.
 */
import { afterEach, expect, test } from "bun:test";
import { canonicalManifestHashStreaming, type FileEntry } from "../../../engine/index.js";
import { manifestFromMeta, type FileOnlyManifest, type StateSavePacket, type SyncState } from "../../sync-state-model.js";
import { elisionReceipt } from "../../sync-state-elision.js";
import { resetForceCompleteSaveForTests } from "../../sync-state-delta.js";
import { saveStateSource, type StateSource } from "../../sync-state.js";
import { sqliteResetPaths } from "../paths.js";
import { openStateStore, stateStoreDatabase } from "../store/open.js";
import { runStatement, selectRows } from "../store/statements.js";
import { loadRawState } from "./whole-state-compat.js";
import {
  capturing, cleanupElisionFixtures, file, LINEAGE, META_FIELDS, pullSource, seededSqlite, SEQ,
  STREAM, type Seeded,
} from "./save-elision.test-helper.js";

afterEach(() => {
  cleanupElisionFixtures();
  resetForceCompleteSaveForTests();
});

interface PlaneRow {
  path: string;
  sha256: string;
  changedGeneration: number;
}

function planeRows(root: string): PlaneRow[] {
  const store = openStateStore(sqliteResetPaths.active(root), { readonly: true });
  try {
    return selectRows<{ path: string; sha256: Uint8Array; changed_generation: number }>(
      stateStoreDatabase(store),
      `SELECT p.path,e.sha256,p.changed_generation FROM plane_entries p
       JOIN entry_values e ON e.entry_id=p.entry_id
       WHERE p.lineage_id=? AND p.plane='base' ORDER BY p.path_order`, LINEAGE,
    ).map((row) => ({
      path: row.path, sha256: Buffer.from(row.sha256).toString("hex"), changedGeneration: row.changed_generation,
    }));
  } finally {
    store.close();
  }
}

const BASE_FILES = [file("one.txt", 1), file("three.txt", 3), file("two.txt", 2)];

const manifestOf = (files: readonly FileEntry[]): FileOnlyManifest => ({
  generatedAt: "2026-08-16T00:00:00.000Z", files: [...files],
});

async function seeded(prefix: string): Promise<Seeded> {
  return seededSqlite(prefix, manifestOf(BASE_FILES));
}

function contentSource(seed: Seeded, files: readonly FileEntry[], overrides: Partial<StateSource> = {}): StateSource {
  return {
    expectedStream: STREAM,
    sourceGlobalSeq: SEQ + 1,
    globalManifest: manifestOf(files),
    manifestMeta: seed.meta,
    observedRepos: [],
    values: {},
    baseIsUnscopedRemote: true,
    ...overrides,
  };
}

/** Every op shape the walk can emit, in one save. */
const CHURNED = [
  file("aaa.txt", 7),
  file("one.txt", 1),
  file("two.txt", 99),
];

test("delta and forced-complete saves of the same result are indistinguishable on disk", async () => {
  const viaDelta = await seeded("delta-arm");
  const viaComplete = await seeded("complete-arm");
  const packets: StateSavePacket[] = [];

  const deltaState = await saveStateSource(viaDelta.root, viaDelta.state,
    contentSource(viaDelta, CHURNED), { apply: capturing(packets) });
  const completeState = await saveStateSource(viaComplete.root, viaComplete.state,
    contentSource(viaComplete, CHURNED, { forceCompleteSave: true }));

  expect(packets[0]!.globalDelta?.ops).toEqual([
    { kind: "upsert", entry: file("aaa.txt", 7) },
    { kind: "delete", path: "three.txt" },
    { kind: "upsert", entry: file("two.txt", 99) },
  ]);
  expect(deltaState).toEqual(completeState);
  expect(planeRows(viaDelta.root)).toEqual(planeRows(viaComplete.root));
  expect(planeRows(viaDelta.root)).toEqual([
    { path: "aaa.txt", sha256: file("aaa.txt", 7).sha256, changedGeneration: 3 },
    { path: "one.txt", sha256: file("one.txt", 1).sha256, changedGeneration: 1 },
    { path: "two.txt", sha256: file("two.txt", 99).sha256, changedGeneration: 3 },
  ]);
});

test("two consecutive delta saves land exactly what two complete saves would", async () => {
  const viaDelta = await seeded("delta-two-save");
  const viaComplete = await seeded("complete-two-save");
  const second = [file("aaa.txt", 7), file("one.txt", 42)];

  let deltaState = await saveStateSource(viaDelta.root, viaDelta.state, contentSource(viaDelta, CHURNED));
  deltaState = await saveStateSource(viaDelta.root, deltaState,
    { ...contentSource(viaDelta, second), sourceGlobalSeq: SEQ + 2 });
  let completeState = await saveStateSource(viaComplete.root, viaComplete.state,
    contentSource(viaComplete, CHURNED, { forceCompleteSave: true }));
  completeState = await saveStateSource(viaComplete.root, completeState,
    { ...contentSource(viaComplete, second, { forceCompleteSave: true }), sourceGlobalSeq: SEQ + 2 });

  expect(deltaState).toEqual(completeState);
  expect(planeRows(viaDelta.root)).toEqual(planeRows(viaComplete.root));
  expect(deltaState.lastSyncedManifest.files).toEqual(second);
});

test("an interleaved writer rejects the delta and the retry composes a fresh one", async () => {
  const seed = await seeded("delta-retry");
  const packets: StateSavePacket[] = [];
  const interleave = async (): Promise<void> => {
    const live = (await loadRawState(seed.root))!;
    await saveStateSource(seed.root, live, contentSource(seed, [file("one.txt", 1)], { forceCompleteSave: true }));
  };

  const saved = await saveStateSource(seed.root, seed.state, contentSource(seed, CHURNED),
    { apply: capturing(packets, interleave) });

  expect(packets).toHaveLength(2);
  // The first delta was composed against the seeded snapshot; the second against
  // the state the interleaved writer left behind, so both the binding and the
  // ops it needs to reach the same result are different.
  expect(packets[0]!.globalDelta!.binding).not.toEqual(packets[1]!.globalDelta!.binding);
  expect(packets[1]!.globalDelta!.ops).toEqual([
    { kind: "upsert", entry: file("aaa.txt", 7) },
    { kind: "upsert", entry: file("two.txt", 99) },
  ]);
  expect(saved.lastSyncedManifest.files).toEqual(CHURNED);
  expect(planeRows(seed.root).map((row) => row.path)).toEqual(["aaa.txt", "one.txt", "two.txt"]);
});

test("a corrupted base row is detected by the idle audit and healed by a complete save", async () => {
  const seed = await seeded("delta-heal");
  // Content saves proceed relatively while drift is undetected — the documented
  // §2.4 window. The corruption re-points one path at another path's value.
  const store = openStateStore(sqliteResetPaths.active(seed.root), { readonly: false });
  runStatement(stateStoreDatabase(store),
    "DELETE FROM plane_entries WHERE lineage_id=? AND plane='base' AND path='two.txt'", LINEAGE);
  store.close();

  const drifted = (await loadRawState(seed.root))!;
  expect(drifted.lastSyncedManifest.files.map((entry) => entry.path)).toEqual(["one.txt", "three.txt"]);

  const packets: StateSavePacket[] = [];
  const auditSource = pullSource({ ...seed, state: drifted }, {
    globalManifest: manifestOf(BASE_FILES),
    baseIsUnscopedRemote: true,
    elisionReceipt: elisionReceipt(drifted, {
      noActions: true, storedBaseIsRemote: true, manifestMeta: seed.meta,
    }),
  });
  const healed = await saveStateSource(seed.root, drifted, auditSource, { apply: capturing(packets) });

  // The audit failed on content, so this very save composed a COMPLETE global —
  // the sole repair authority — and the corrupted row is gone.
  expect(packets).toHaveLength(1);
  expect(packets[0]!.globalDelta).toBeUndefined();
  expect(packets[0]!.global?.manifest.files).toEqual(BASE_FILES);
  expect(healed.lastSyncedManifest.files).toEqual(BASE_FILES);
  expect(planeRows(seed.root).map((row) => row.sha256))
    .toEqual(BASE_FILES.map((entry) => entry.sha256));

  // Heal accepted: the next content save is relative again.
  const after = await saveStateSource(seed.root, healed,
    { ...contentSource(seed, CHURNED), sourceGlobalSeq: SEQ + 2 }, { apply: capturing(packets) });
  expect(packets[1]!.globalDelta).toBeDefined();
  expect(after.lastSyncedManifest.files).toEqual(CHURNED);
});

test("the meta a delta save persists still describes the manifest it landed", async () => {
  const seed = await seeded("delta-meta");
  const saved = await saveStateSource(seed.root, seed.state, contentSource(seed, CHURNED));
  const persisted = { ...META_FIELDS, ...saved.manifestMeta };

  expect(canonicalManifestHashStreaming(manifestFromMeta(saved.lastSyncedManifest, persisted)))
    .toBe(canonicalManifestHashStreaming(manifestFromMeta({ ...saved.lastSyncedManifest, files: CHURNED }, persisted)));
  const reloaded: SyncState = (await loadRawState(seed.root))!;
  expect(reloaded.manifestMeta).toEqual(saved.manifestMeta);
});
