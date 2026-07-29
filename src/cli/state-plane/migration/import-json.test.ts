import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { stateFromRepoRecords, type RepoRecord, type SyncState } from "../../sync-state-model.js";
import { loadRawStateFromStore } from "../adapters/read-only.js";
import { compareUtf16 } from "../digest/codecs.js";
import { LegacyStateShapeError, normalizeLegacyStateV1 } from "../digest/legacy-state-plan.js";
import { legacyStateSemanticDigest, stateSemanticDigest } from "../digest/state-semantic-v1.js";
import { MigrationPhaseHaltError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, statePath } from "../paths.js";
import {
  openStateStore, openStateStoreForWalTakeover, stateStoreDatabase, type ClaimedInode,
} from "../store/open.js";
import { observePath, observeSidecars } from "./artifact-observation.js";
import { PhaseReceipt } from "./classifier.js";
import {
  encodeMigrationControl,
  type CompletionTuple, type MigrationControl, type MigrationWitness, type SourceWitness,
} from "./control-codec.js";
import { claimStagingMain, importOwnedStaging, preserveSource, proveStaging } from "./import-json.js";
import { publishBackup } from "./legacy-backup.js";

const locks = {} as unknown as HeldStatePlaneLocks;
const MIGRATION = "9f".repeat(8);
const AUTHORITY = "ab".repeat(16);
const ADMISSION = { sourceBytes: 1, requiredBytes: 52, budgetBytes: 1024 } as const;
const RESOURCES = {
  reserve: { disposition: "consumed-for-halt" },
  emergency: { disposition: "consumed-for-halt" },
} as const;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** Uniquified per test: tmpfs never recycles an inode here, but CI does, and
 * every fixture below asserts on inode identity. */
function workspace(label: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `rbox-u3-3a-${label}-${process.pid}-`));
  fs.mkdirSync(path.join(root, ".rbox", "state"), { recursive: true });
  roots.push(root);
  return root;
}

const hex = (width: number, value: number): string => value.toString(16).padStart(width, "0");

function section(value: number, extras: Record<string, unknown> = {}): GitSection {
  return {
    ...extras,
    bundleSha: hex(64, value + 1), bundleEncSha: hex(64, value + 2), bundleCipherSize: value + 100,
    head: "ref: refs/heads/main", refs: { "refs/heads/main": hex(40, value + 3) },
    config: {}, refScope: "all", generatedAt: `2026-07-29T00:${String(value % 60).padStart(2, "0")}:00.000Z`,
  } as GitSection;
}

/**
 * The two characters whose sort orders disagree, and the whole reason two
 * comparators exist.
 *
 * `path_order` is a big-endian UTF-16 blob, so its memcmp order is UTF-16
 * code-unit order — an astral character is a surrogate pair starting 0xD83D,
 * BELOW U+E000. `rel_path` and `field` are TEXT under BINARY collation, which
 * is memcmp over UTF-8, where the astral character starts 0xF0, ABOVE U+E000's
 * 0xEE. So this pair orders one way by `path_order` and the other by TEXT.
 *
 * Every ordered collection below carries the pair. A comparator applied to the
 * wrong column flips an order, the two digest walks disagree, and M4 halts —
 * which is the point: without the pair, a workspace holding both kinds of path
 * would be permanently unmigratable and nothing would have caught it.
 */
const BMP = "";
const ASTRAL = "\u{1F600}";

/**
 * Extras at every level, both git roles, a symlink, a compressed entry, the
 * divergent pair in every ordered collection, and a `resolutionIntent` the
 * import must strip.
 *
 * Every collection is supplied OUT of its stored order, deliberately. The
 * `files` array and `Object.entries` both preserve insertion order and the SQL
 * walk always reads back sorted, so a pre-sorted fixture would let a dropped
 * `.sort()` pass unnoticed — it did, until this fixture was shuffled.
 */
function fixtureState(): SyncState {
  const files: FileEntry[] = [
    { path: `z/${BMP}.txt`, sha256: hex(64, 7), size: 1, mode: 0o644, mtimeMs: 5, type: "file" },
    { path: "c/enc.bin", sha256: hex(64, 3), size: 4096, mode: 0o600, mtimeMs: 3.25, type: "file",
      encSha: hex(64, 4), comp: "zstd", payloadSha: hex(64, 5), cipherSize: 900 },
    { path: `z/${ASTRAL}.txt`, sha256: hex(64, 6), size: 1, mode: 0o644, mtimeMs: 4, type: "file", extensionNull: null },
    { path: "a/plain.txt", sha256: hex(64, 1), size: 3, mode: 0o644, mtimeMs: 1.5, type: "file" },
    { path: "b/link", sha256: hex(64, 2), size: 0, mode: 0o777, type: "symlink", mtimeMs: 2, symlinkTarget: "../a/plain.txt" },
  ] as FileEntry[];
  const records: Record<string, RepoRecord> = {
    [`repo-${BMP}`]: { repoGen: 3, sourceSeq: 41, base: section(4) } as RepoRecord,
    "repo-b": { repoGen: 0, sourceSeq: 0, pending: section(2), removedKey: "gone", resolutionIntent: "obsolete" } as unknown as RepoRecord,
    [`repo-${ASTRAL}`]: { repoGen: 5, sourceSeq: 41, base: section(6) } as RepoRecord,
    "repo-a": { repoGen: 2, sourceSeq: 41, base: section(1), extensionObject: {} } as RepoRecord,
  };
  return stateFromRepoRecords({
    extensionArray: [],
    stream: "workspace/project",
    lastSyncedSequence: 41,
    lastSyncedManifest: {
      generatedAt: "2026-07-29T12:00:00.000Z", manifestSchema: 2, files, extensionNull: null,
    } as never,
    manifestMeta: {
      encManifestSha: hex(64, 900), manifestHash: hex(64, 901), accountEpoch: 2, keyEpoch: 3,
      chain: [hex(64, 910), hex(64, 911)], chainBytes: 1234, snapshotBytes: 5678,
      gitRepos: {
        [`repo-${ASTRAL}`]: section(52), "repo-a": section(50),
        [`repo-${BMP}`]: section(53), "repo-b": section(51),
      },
    } as never,
    stateNonce: "c".repeat(32),
    stateRevision: 7,
    telemetryBindingId: "d".repeat(16),
  } as SyncState, records);
}

/**
 * A pre-record state: no `repoRecords`, five sidecar maps instead.
 *
 * `legacy_state_maps.rel_path` is the one column ordered by UTF-8 rather than
 * `path_order`, so the divergent pair lives here too — and out of order, so the
 * sort is load-bearing.
 */
function legacyMapState(): SyncState {
  return {
    stream: "workspace/legacy",
    lastSyncedSequence: 9,
    lastSyncedManifest: {
      generatedAt: "2026-07-29T00:00:00.000Z", files: [],
      gitRepos: { [`repo-${ASTRAL}`]: section(7), "repo-a": section(3), [`repo-${BMP}`]: section(8) },
    } as never,
    gitReposRemoved: { [`repo-${ASTRAL}`]: "identity-astral", "repo-x": "identity-x", [`repo-${BMP}`]: "identity-bmp" },
    gitNeedsResolution: { [`repo-${BMP}`]: "resolve-bmp", "repo-y": "identity-y", [`repo-${ASTRAL}`]: "resolve-astral" },
    gitPendingRemote: { "repo-z": section(4), [`repo-${ASTRAL}`]: section(9) },
    gitDeferrals: { "repo-a": { blockers: [] } as never },
    gitPartial: { "repo-a": { incomingKey: "k", checkoutPending: false, appliedRefs: {}, configApplied: true, configBase: {} } as never },
  } as SyncState;
}

// ---------------------------------------------------------------------------
// Control fixtures. Nothing here encodes unless the test is about the bytes.

function writeLegacy(root: string, state: SyncState): SourceWitness {
  fs.writeFileSync(statePath(root), JSON.stringify(state), { mode: 0o600 });
  const observed = observePath(statePath(root), true);
  if (observed.state !== "regular" || observed.sha256 === null) throw new Error("fixture source is not regular");
  return {
    path: statePath(root), dev: observed.dev, ino: observed.ino,
    bytes: observed.bytes, sha256: observed.sha256, mtimeNs: observed.mtimeNs,
  };
}

function control(root: string, source: SourceWitness, witness: MigrationWitness): MigrationControl {
  return {
    version: 1, controlRevision: 1, migrationId: MIGRATION, authorityId: AUTHORITY,
    source, stagingPath: migrationPaths.staging(root, MIGRATION),
    witness, haltResources: RESOURCES, halt: null, retirement: null,
  };
}

const receiptFor = (control: MigrationControl): PhaseReceipt => PhaseReceipt.observe(control);

interface Imported {
  root: string;
  source: SourceWitness;
  identity: ClaimedInode;
  completion: CompletionTuple;
  stagingPath: string;
  m2: Awaited<ReturnType<typeof preserveSource>>;
}

/** M2 → claim → M3, the sequence M-9 will drive. */
async function importState(label: string, state: SyncState): Promise<Imported> {
  const root = workspace(label);
  const source = writeLegacy(root, state);
  const m1 = control(root, source, { phase: "M1", admission: ADMISSION });
  const m2 = await preserveSource(root, receiptFor(m1), locks);

  const beforeClaim = control(root, source, { phase: "M2", admission: ADMISSION, ...m2 });
  const claim = await claimStagingMain(root, receiptFor(beforeClaim), locks);
  expect(claim.kind).toBe("claimed");

  const published = control(root, source, {
    phase: "M2", admission: ADMISSION, ...m2,
    stagingMain: { state: "present", ...claim.identity },
  });
  const m3 = await importOwnedStaging(
    root, { identity: claim.identity, receipt: receiptFor(published) }, locks,
  );
  return {
    root, source, identity: claim.identity, completion: m3.completion,
    stagingPath: published.stagingPath, m2,
  };
}

function m3Control(imported: Imported): MigrationControl {
  return control(imported.root, imported.source, {
    phase: "M3", admission: ADMISSION, ...imported.m2,
    stagingMain: { state: "present", ...imported.identity },
    completion: imported.completion,
  });
}

// ---------------------------------------------------------------------------
// The fidelity gate.

test("the JSON and SQL sides of state-semantic-v1 agree on a realistic import", async () => {
  const state = fixtureState();
  const imported = await importState("fidelity", state);
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  try {
    const sql = stateSemanticDigest(stateStoreDatabase(store));
    const lineage = store.header.active_lineage_id;
    const json = legacyStateSemanticDigest(normalizeLegacyStateV1(state, lineage));
    expect(json).toBe(sql);
    expect(imported.completion.sourceSemanticDigest).toBe(sql);
    expect(imported.completion.entryCount).toBe(5);
    expect(imported.completion.repoCount).toBe(4);
    expect(imported.completion.perTableCounts).toEqual({ entry_values: 5, plane_entries: 5, repo_records: 4 });
  } finally {
    store.close();
  }
});

test("a pre-record legacy state imports its five sidecar maps as evidence and as records", async () => {
  const state = legacyMapState();
  const imported = await importState("legacy-maps", state);
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  try {
    const db = stateStoreDatabase(store);
    expect(legacyStateSemanticDigest(normalizeLegacyStateV1(state, store.header.active_lineage_id)))
      .toBe(stateSemanticDigest(db));
    const maps = db.query("SELECT field,rel_path FROM legacy_state_maps ORDER BY field,rel_path").all() as Array<{ field: string }>;
    expect(new Set(maps.map((row) => row.field))).toEqual(new Set([
      "gitReposRemoved", "gitNeedsResolution", "gitPendingRemote", "gitDeferrals", "gitPartial",
    ]));
    const completion = db.query("SELECT source_repo_records_present FROM migration_completion WHERE singleton=1")
      .get() as { source_repo_records_present: number };
    expect(completion.source_repo_records_present).toBe(0);
    // The fold that the JSON read path performs, performed once, at import:
    // every repository any of the five maps or the git layer mentions.
    expect(imported.completion.repoCount).toBe(6);
    // The divergent pair really is stored under this UTF-8-ordered column.
    const relPaths = (db.query("SELECT DISTINCT rel_path FROM legacy_state_maps").all() as Array<{ rel_path: string }>)
      .map((row) => row.rel_path);
    expect(relPaths).toContain(`repo-${BMP}`);
    expect(relPaths).toContain(`repo-${ASTRAL}`);
  } finally {
    store.close();
  }
});

test("the imported store reads back as the state the JSON path would have produced", async () => {
  const state = fixtureState();
  const imported = await importState("differential", state);
  await proveStaging(imported.root, receiptFor(m3Control(imported)), locks);
  const store = openStateStore(imported.stagingPath, { readonly: true });
  try {
    const expected = JSON.parse(JSON.stringify(state)) as SyncState;
    delete (expected.repoRecords!["repo-b"] as Record<string, unknown>).resolutionIntent;
    // The one difference the import is allowed to make, stated rather than
    // hidden: manifest entries come back in `path_order`, because that is the
    // order `plane_entries` stores and the read path is a cursor over it. The
    // source array's own order carries no meaning and survives nothing.
    const readBack = loadRawStateFromStore(store);
    expect(readBack.lastSyncedManifest.files.map((entry) => entry.path))
      .toEqual([...expected.lastSyncedManifest.files].map((entry) => entry.path).sort(compareUtf16));
    expect(readBack).toEqual({
      ...expected,
      lastSyncedManifest: {
        ...expected.lastSyncedManifest,
        files: [...expected.lastSyncedManifest.files].sort((a, b) => compareUtf16(a.path, b.path)),
      },
    });
  } finally {
    store.close();
  }
});

test("every imported entry is stamped with the BASE head generation", async () => {
  // `plane_entries.changed_generation` is structurally OUTSIDE the semantic
  // digest: the SQL walk selects from `entry_values` and joins `plane_entries`
  // only to order and filter, so it never reads this column. A wrong stamp
  // would be invisible to the entire M4 fidelity gate.
  //
  // It is deliberately NOT added to the grammar. That digest compares a SQL
  // projection against a projection of the legacy JSON, and the legacy document
  // has no concept of a generation — the JSON side would have to invent the
  // value it is supposed to be checking. A storage stamp with no source
  // counterpart belongs in an invariant, which is what this is.
  const imported = await importState("changed-generation", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  try {
    const db = stateStoreDatabase(store);
    const head = db.query("SELECT generation FROM plane_heads WHERE plane='base'").get() as { generation: number };
    const rows = db.query("SELECT plane,changed_generation FROM plane_entries").all() as
      Array<{ plane: string; changed_generation: number }>;
    expect(rows).toHaveLength(5);
    expect(new Set(rows.map((row) => row.changed_generation))).toEqual(new Set([head.generation]));
    expect(new Set(rows.map((row) => row.plane))).toEqual(new Set(["base"]));
    // And the head is the generation the whole import is pinned to.
    const lineage = db.query("SELECT active_base_generation,local_revision FROM state_lineage").get() as
      { active_base_generation: number; local_revision: number };
    expect(lineage.active_base_generation).toBe(head.generation);
    expect(lineage.local_revision).toBe(head.generation);
    const meta = db.query("SELECT base_generation FROM global_manifest_meta").get() as { base_generation: number };
    expect(meta.base_generation).toBe(head.generation);
    const git = db.query("SELECT DISTINCT base_generation FROM manifest_git_sections").all() as
      Array<{ base_generation: number }>;
    expect(git.map((row) => row.base_generation)).toEqual([head.generation]);
  } finally {
    store.close();
  }
});

test("resolutionIntent is stripped before the digest, not routed to extras", () => {
  const state = fixtureState();
  const stripped = JSON.parse(JSON.stringify(state)) as SyncState;
  delete (stripped.repoRecords!["repo-b"] as Record<string, unknown>).resolutionIntent;
  const lineage = "e".repeat(32);
  expect(legacyStateSemanticDigest(normalizeLegacyStateV1(state, lineage)))
    .toBe(legacyStateSemanticDigest(normalizeLegacyStateV1(stripped, lineage)));
  expect(JSON.stringify(normalizeLegacyStateV1(state, lineage))).not.toContain("resolutionIntent");
});

/**
 * The fixture's two ordering preconditions, pinned so they cannot silently
 * lapse — because when they did, they produced a pair of mutation verdicts that
 * looked contradictory and were not.
 *
 * The earlier fixture listed its entries in exactly UTF-16 order. So deleting
 * the `.sort()` was a no-op and survived, while swapping its comparator still
 * reordered the last two paths and was killed. Both verdicts followed from
 * ordering, consistently; what was wrong was the assumption that the two
 * comparators agree on this fixture. They never did — they disagree on exactly
 * the `U+E000` / astral pair, which is the whole reason that pair is here.
 *
 * Two independent properties, so a future edit cannot quietly disarm either
 * mutant:
 *   1. the comparators DISAGREE  → a swapped comparator changes the digest;
 *   2. insertion order is NOT the stored order → a deleted sort changes it too.
 */
test("the fixture keeps both ordering mutants reachable", () => {
  const paths = fixtureState().lastSyncedManifest.files.map((entry) => entry.path);
  const byUtf16 = [...paths].sort(compareUtf16);
  const byUtf8 = [...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  expect(byUtf16, "the two comparators must disagree, or a swapped one is invisible").not.toEqual(byUtf8);
  expect(paths, "insertion order must not already be the stored order, or a deleted sort is a no-op")
    .not.toEqual(byUtf16);
  // `path_order` is UTF-16, so the stored order is the UTF-16 one.
  expect(byUtf16.at(-2)).toContain("\u{1F600}");
  expect(byUtf16.at(-1)).toContain("");

  const repos = Object.keys(fixtureState().repoRecords!);
  expect([...repos].sort(compareUtf16))
    .not.toEqual([...repos].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  expect(repos).not.toEqual([...repos].sort(compareUtf16));
});

test("the source-shape presence bits distinguish an absent key from an empty one", () => {
  const lineage = "e".repeat(32);
  const withKey = normalizeLegacyStateV1({
    stream: "s", lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [], gitRepos: {} } as never,
  } as SyncState, lineage);
  const withoutKey = normalizeLegacyStateV1({
    stream: "s", lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] } as never,
  } as SyncState, lineage);
  expect(withKey.shapeFlags.lastSyncedManifest.gitRepos).toBe(true);
  expect(withoutKey.shapeFlags.lastSyncedManifest.gitRepos).toBe(false);
  expect(legacyStateSemanticDigest(withKey)).not.toBe(legacyStateSemanticDigest(withoutKey));
});

// ---------------------------------------------------------------------------
// Hostile sources.

const refuses = (state: unknown, detail: RegExp): void => {
  expect(() => normalizeLegacyStateV1(state as SyncState, "e".repeat(32))).toThrow(detail);
};

test("the normalizer refuses shapes the schema cannot hold", () => {
  const base = { stream: "s", lastSyncedSequence: 0, lastSyncedManifest: { generatedAt: "", files: [] } };
  refuses({ ...base, stream: "" }, /stream is not nonempty text/);
  refuses({ ...base, lastSyncedManifest: [] }, /lastSyncedManifest is not an object/);
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [], complete: true } }, /collides with a plane_heads column/);
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [], sourceSequence: 1 } }, /collides with a plane_heads column/);
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: {} } }, /files is not a list/);
  refuses({ ...base, stateNonce: "not-hex" }, /stateNonce is not the lowercase hex identity/);
  refuses({ ...base, telemetryBindingId: "zz" }, /telemetryBindingId is not the lowercase hex identity/);
  // `generated_at` is TEXT NOT NULL: a non-string reaches the column as a bound
  // number and the read path hands it back as one.
  refuses({ ...base, lastSyncedManifest: { generatedAt: 20260729, files: [] } }, /generatedAt is not text/);
  refuses({ ...base, lastSyncedManifest: { generatedAt: null, files: [] } }, /generatedAt is not text/);
  // `manifest_schema IS NULL OR >= 1`: zero is a CHECK violation mid-transaction
  // rather than a typed refusal, and a fraction is not a schema version at all.
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: 0 } }, /manifestSchema is not a schema version/);
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: -1 } }, /manifestSchema is not a schema version/);
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [], manifestSchema: 1.5 } }, /manifestSchema is not a schema version/);
  const duplicate = { path: "a", sha256: hex(64, 1), size: 0, mode: 0o644, mtimeMs: 0, type: "file" };
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [duplicate, { ...duplicate }] } }, /repeats a path/);
  expect(() => normalizeLegacyStateV1(base as SyncState, "not-a-lineage")).toThrow(LegacyStateShapeError);
});

/**
 * The typed-refusal seam. The normalizer runs `encodeFileEntry`,
 * `encodeRepoRecord`, and `encodeGitSection` purely to reject before anything
 * opens SQLite. Drop any of those calls and the installer still throws when it
 * re-encodes — but from INSIDE the transaction, as a raw `TypeError` rather
 * than a `MigrationPhaseHaltError`, and after the staging database was opened
 * and written. The halt's `wrote` flag would then be a lie, which is precisely
 * what this module's contract says cannot happen.
 */
test.each([
  ["a malformed manifest entry", (state: SyncState) => {
    (state.lastSyncedManifest.files as unknown as Array<Record<string, unknown>>)[0]!.mode = 99999;
  }],
  // Not a negative counter: `repoRecordsForState` normalizes those to zero by
  // design, so they never reach the encoder. This is a member no seam launders.
  ["a malformed repository record", (state: SyncState) => {
    (state.repoRecords!["repo-a"] as unknown as Record<string, unknown>).removedKey = 42;
  }],
  ["a malformed git section", (state: SyncState) => {
    (state.lastSyncedManifest.gitRepos as unknown as Record<string, unknown>)["repo-a"] = { bundleSha: "nope" };
  }],
])("%s refuses before SQLite opens, with wrote=false", async (_label, corrupt) => {
  const root = workspace("typed-refusal");
  const state = JSON.parse(JSON.stringify(fixtureState())) as SyncState;
  corrupt(state);
  const source = writeLegacy(root, state);
  const m1 = control(root, source, { phase: "M1", admission: ADMISSION });
  const m2 = await preserveSource(root, receiptFor(m1), locks);
  const claim = await claimStagingMain(
    root, receiptFor(control(root, source, { phase: "M2", admission: ADMISSION, ...m2 })), locks,
  );
  const published = control(root, source, {
    phase: "M2", admission: ADMISSION, ...m2, stagingMain: { state: "present", ...claim.identity },
  });
  const failure = await importOwnedStaging(root, { identity: claim.identity, receipt: receiptFor(published) }, locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).wrote).toBe(false);
  // Nothing opened it: still the zero-byte inode the claim published.
  expect(observePath(published.stagingPath)).toMatchObject({ state: "regular", bytes: 0, ...claim.identity });
  expect(observeSidecars(published.stagingPath)).toEqual([]);
});

/**
 * M3's guarded parse is the import path's ONLY read of the source, so each of
 * its checks is the sole guard of its own fact. Each row doctors exactly one
 * dimension of the recorded witness and drives `importOwnedStaging` directly —
 * the earlier `preserveSource` tests exercise `bracketSource`, which is a
 * different seam and cannot stand in for these.
 */
test.each([
  ["hash", (w: SourceWitness): SourceWitness => ({ ...w, sha256: "b".repeat(64) }), /does not hash to its recorded digest/],
  ["inode", (w: SourceWitness): SourceWitness => ({ ...w, ino: w.ino + 1 }), /not the inode this migration recorded/],
  ["device", (w: SourceWitness): SourceWitness => ({ ...w, dev: w.dev + 1 }), /not the inode this migration recorded/],
  ["length", (w: SourceWitness): SourceWitness => ({ ...w, bytes: w.bytes - 1 }), /not the length this migration recorded/],
  ["mtime", (w: SourceWitness): SourceWitness => ({ ...w, mtimeNs: "1" }), /written since this migration recorded it/],
])("the import refuses a source whose %s is not the recorded one", async (label, doctor, detail) => {
  const root = workspace(`parse-${label}`);
  const real = writeLegacy(root, fixtureState());
  const m2 = await preserveSource(root, receiptFor(control(root, real, { phase: "M1", admission: ADMISSION })), locks);
  const claim = await claimStagingMain(
    root, receiptFor(control(root, real, { phase: "M2", admission: ADMISSION, ...m2 })), locks,
  );
  const published = control(root, doctor(real), {
    phase: "M2", admission: ADMISSION, ...m2, stagingMain: { state: "present", ...claim.identity },
  });
  const failure = await importOwnedStaging(root, { identity: claim.identity, receipt: receiptFor(published) }, locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).message).toMatch(detail);
  expect((failure as MigrationPhaseHaltError).wrote).toBe(false);
  // Refused before SQLite opened: still the zero-byte claimed inode.
  expect(observePath(published.stagingPath)).toMatchObject({ state: "regular", bytes: 0, ...claim.identity });
});

test("an unparseable or changed source halts the import with zero staging writes", async () => {
  const root = workspace("hostile-source");
  fs.writeFileSync(statePath(root), "{ not json", { mode: 0o600 });
  const observed = observePath(statePath(root), true);
  if (observed.state !== "regular" || observed.sha256 === null) throw new Error("fixture");
  const source: SourceWitness = {
    path: statePath(root), dev: observed.dev, ino: observed.ino,
    bytes: observed.bytes, sha256: observed.sha256, mtimeNs: observed.mtimeNs,
  };
  const m1 = control(root, source, { phase: "M1", admission: ADMISSION });
  const m2 = await preserveSource(root, receiptFor(m1), locks);
  const claim = await claimStagingMain(
    root, receiptFor(control(root, source, { phase: "M2", admission: ADMISSION, ...m2 })), locks,
  );
  const published = control(root, source, {
    phase: "M2", admission: ADMISSION, ...m2, stagingMain: { state: "present", ...claim.identity },
  });
  const failure = await importOwnedStaging(root, { identity: claim.identity, receipt: receiptFor(published) }, locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  // The adopter cleans up after itself: the claimed inode and its sidecars go.
  expect(observePath(published.stagingPath).state).toBe("regular");
  expect(observePath(published.stagingPath)).toMatchObject({ bytes: 0 });
});

test("a source that changed since the control recorded it never reaches a mutator", async () => {
  const root = workspace("source-changed");
  const source = writeLegacy(root, fixtureState());
  fs.writeFileSync(statePath(root), "{}", { mode: 0o600 });
  const failure = await preserveSource(root, receiptFor(control(root, source, { phase: "M1", admission: ADMISSION })), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).wrote).toBe(false);
  expect(fs.existsSync(migrationPaths.fixedBackup(root))).toBe(false);
});

test("the source hash alone decides identity, independent of size and mtime", async () => {
  // Kills the mutant that drops the SHA-256 clause from the identity bracket:
  // `mtimeNs` is forgeable and the byte length is not a content check, so the
  // hash has to be load-bearing on its own.
  const root = workspace("source-hash");
  const source = writeLegacy(root, fixtureState());
  const lying = { ...source, sha256: "f".repeat(64) };
  const failure = await preserveSource(root, receiptFor(control(root, lying, { phase: "M1", admission: ADMISSION })), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).wrote).toBe(false);
});

// ---------------------------------------------------------------------------
// M2.

test("both backups live under legacy-json, out of the state.json neighbourhood", () => {
  // 163 v6 moved the fixed backup here on purpose: it is the path a person
  // restores by reflex, and a restored pre-migration baseline silently re-elects
  // a stale JSON state with an advanced server — the mass-delete shape. Keeping
  // it beside the immutable history, out of the `state.json` naming
  // neighbourhood, is half of that mitigation; the preamble is the other half.
  const root = "/workspace";
  expect(migrationPaths.fixedBackup(root)).toBe("/workspace/.rbox/state/legacy-json/pre-163-latest.json.bak");
  expect(path.dirname(migrationPaths.fixedBackup(root)))
    .toBe(path.dirname(migrationPaths.backupHistory(root, "a".repeat(64))));
  expect(path.dirname(migrationPaths.fixedBackup(root)))
    .not.toBe(path.dirname(statePath(root)));
});

test("M2 writes preamble-prefixed backups and preserves a differing prior under its own hash", async () => {
  const root = workspace("m2-backups");
  const source = writeLegacy(root, fixtureState());
  const priorBody = '{"stream":"old"}';
  const priorSha = crypto.createHash("sha256").update(priorBody).digest("hex");
  fs.mkdirSync(path.dirname(migrationPaths.fixedBackup(root)), { recursive: true });
  fs.writeFileSync(migrationPaths.fixedBackup(root), `RBOX-LEGACY-STATE-BACKUP-v1 ${priorSha}\n${priorBody}`, { mode: 0o600 });

  const witness = await preserveSource(root, receiptFor(control(root, source, { phase: "M1", admission: ADMISSION })), locks);
  const history = fs.readFileSync(migrationPaths.backupHistory(root, source.sha256), "utf8");
  expect(history.startsWith(`RBOX-LEGACY-STATE-BACKUP-v1 ${source.sha256}\n`)).toBe(true);
  expect(() => JSON.parse(history)).toThrow();
  expect(history.slice(history.indexOf("\n") + 1)).toBe(fs.readFileSync(statePath(root), "utf8"));
  // No unique bytes were overwritten.
  expect(fs.existsSync(migrationPaths.backupHistory(root, priorSha))).toBe(true);
  expect(witness.history.sha256).not.toBe(source.sha256);
  expect(witness.stagingMain).toEqual({ state: "absent" });
  expect(fs.existsSync(migrationPaths.backupTemp(root, MIGRATION))).toBe(false);
});

test("M2 is idempotent: a resume reuses both backup inodes and republishes identical bytes", async () => {
  const root = workspace("m2-idempotent");
  const source = writeLegacy(root, fixtureState());
  const receipt = receiptFor(control(root, source, { phase: "M1", admission: ADMISSION }));
  const first = await preserveSource(root, receipt, locks);
  const second = await preserveSource(root, receipt, locks);
  expect(second).toEqual(first);
  const record = (witness: typeof first): Buffer => encodeMigrationControl({
    ...control(root, source, { phase: "M2", admission: ADMISSION, ...witness }), controlRevision: 2,
  });
  // The wedge close: the M2 record is a pure function of durable facts, so the
  // sibling a crash stranded in the render->rename window recurs byte-for-byte.
  expect(record(second).equals(record(first))).toBe(true);
});

test("the backup copy refuses bytes that do not hash to the declared digest", async () => {
  // `publishBackup` is reached directly, without `preserveSource`'s bracket, so
  // the in-flight body hash inside `renderBackupCopy` is the only guard left —
  // which is exactly its job when the source is rewritten in place mid-copy.
  const root = workspace("backup-body-hash");
  const source = writeLegacy(root, fixtureState());
  fs.mkdirSync(path.dirname(migrationPaths.backupTemp(root, MIGRATION)), { recursive: true });
  const lying: SourceWitness = { ...source, sha256: "b".repeat(64) };
  const control = { migrationId: MIGRATION } as MigrationControl;
  expect(() => publishBackup(root, control, migrationPaths.fixedBackup(root), lying))
    .toThrow(/changed while it was being preserved/);
  // The temp is removed and no backup is published from unverified bytes.
  expect(fs.existsSync(migrationPaths.backupTemp(root, MIGRATION))).toBe(false);
  expect(fs.existsSync(migrationPaths.fixedBackup(root))).toBe(false);
});

test("a preamble whose digest is the wrong length is not a backup", async () => {
  const root = workspace("backup-preamble-length");
  const source = writeLegacy(root, fixtureState());
  fs.mkdirSync(path.dirname(migrationPaths.fixedBackup(root)), { recursive: true });
  // 63 hex characters: the right shape, the wrong width.
  fs.writeFileSync(migrationPaths.fixedBackup(root), `RBOX-LEGACY-STATE-BACKUP-v1 ${"a".repeat(63)}\n{}`, { mode: 0o600 });
  const failure = await preserveSource(root, receiptFor(control(root, source, { phase: "M1", admission: ADMISSION })), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("reserved-path");
  expect((failure as MigrationPhaseHaltError).message).toMatch(/does not carry the legacy backup preamble/);
});

test("a backup path holding something that is not a backup halts with zero writes", async () => {
  const root = workspace("m2-foreign");
  const source = writeLegacy(root, fixtureState());
  fs.mkdirSync(path.dirname(migrationPaths.fixedBackup(root)), { recursive: true });
  fs.writeFileSync(migrationPaths.fixedBackup(root), '{"stream":"restorable"}', { mode: 0o600 });
  const failure = await preserveSource(root, receiptFor(control(root, source, { phase: "M1", admission: ADMISSION })), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("reserved-path");
});

// ---------------------------------------------------------------------------
// M3's four observations.

async function stagedAt(label: string): Promise<{ root: string; source: SourceWitness; m2: Awaited<ReturnType<typeof preserveSource>> }> {
  const root = workspace(label);
  const source = writeLegacy(root, fixtureState());
  const m2 = await preserveSource(root, receiptFor(control(root, source, { phase: "M1", admission: ADMISSION })), locks);
  return { root, source, m2 };
}

test("observation 1: an absent staging main is created exclusively and bracketed", async () => {
  const { root, source, m2 } = await stagedAt("claim-absent");
  const claim = await claimStagingMain(root, receiptFor(control(root, source, { phase: "M2", admission: ADMISSION, ...m2 })), locks);
  expect(claim.kind).toBe("claimed");
  const observed = observePath(migrationPaths.staging(root, MIGRATION));
  expect(observed).toMatchObject({ state: "regular", bytes: 0, mode: 0o600, ...claim.identity });
});

test("observation 2: the sole create-ahead shape is adopted, keeping its inode", async () => {
  const { root, source, m2 } = await stagedAt("claim-create-ahead");
  const file = migrationPaths.staging(root, MIGRATION);
  fs.writeFileSync(file, "", { mode: 0o600 });
  const before = observePath(file);
  const claim = await claimStagingMain(root, receiptFor(control(root, source, { phase: "M2", admission: ADMISSION, ...m2 })), locks);
  expect(claim.identity).toEqual({ dev: (before as ClaimedInode).dev, ino: (before as ClaimedInode).ino });
});

test("observation 3: an incomplete recorded main is reset in place, never replaced", async () => {
  const { root, source, m2 } = await stagedAt("claim-incomplete");
  const file = migrationPaths.staging(root, MIGRATION);
  fs.writeFileSync(file, "half a database", { mode: 0o600 });
  fs.writeFileSync(`${file}-wal`, "frames", { mode: 0o600 });
  const recorded = observePath(file) as ClaimedInode;
  const claim = await claimStagingMain(root, receiptFor(control(root, source, {
    phase: "M2", admission: ADMISSION, ...m2, stagingMain: { state: "present", dev: recorded.dev, ino: recorded.ino },
  })), locks);
  expect(claim.kind).toBe("claimed");
  // The identity the M2 revision already published survives the rebuild, so no
  // second staging identity is ever CAS-published.
  expect(claim.identity).toEqual({ dev: recorded.dev, ino: recorded.ino });
  expect(observePath(file)).toMatchObject({ bytes: 0, dev: recorded.dev, ino: recorded.ino });
  expect(observeSidecars(file)).toEqual([]);
});

test("observation 4: a committed completion for this migration is reported, not rebuilt", async () => {
  const imported = await importState("claim-completed", fixtureState());
  const claim = await claimStagingMain(imported.root, receiptFor(control(imported.root, imported.source, {
    phase: "M2", admission: ADMISSION, ...imported.m2,
    stagingMain: { state: "present", ...imported.identity },
  })), locks);
  expect(claim.kind).toBe("completed");
  expect(claim.kind === "completed" && claim.completion).toEqual(imported.completion);
  expect(claim.identity).toEqual(imported.identity);
});

test("anything else at the staging path is a reserved-path halt with zero writes", async () => {
  const { root, source, m2 } = await stagedAt("claim-foreign");
  const file = migrationPaths.staging(root, MIGRATION);
  fs.writeFileSync(`${file}-wal`, "orphan", { mode: 0o600 });
  const failure = await claimStagingMain(root, receiptFor(control(root, source, { phase: "M2", admission: ADMISSION, ...m2 })), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("reserved-path");
  expect((failure as MigrationPhaseHaltError).wrote).toBe(false);
  expect(observePath(file).state).toBe("absent");
});

test("a completed import belonging to another migration halts rather than being adopted", async () => {
  const imported = await importState("claim-foreign-completion", fixtureState());
  const foreign: MigrationControl = {
    ...control(imported.root, imported.source, {
      phase: "M2", admission: ADMISSION, ...imported.m2,
      stagingMain: { state: "present", ...imported.identity },
    }),
    migrationId: "other-migration",
    stagingPath: imported.stagingPath,
  };
  const failure = await claimStagingMain(imported.root, receiptFor(foreign), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("reserved-path");
});

// ---------------------------------------------------------------------------
// M3's determinism, and M4.

test("the M3 completion tuple recurs exactly across a resume", async () => {
  const imported = await importState("m3-determinism", fixtureState());
  const claim = await claimStagingMain(imported.root, receiptFor(control(imported.root, imported.source, {
    phase: "M2", admission: ADMISSION, ...imported.m2, stagingMain: { state: "present", ...imported.identity },
  })), locks);
  expect(claim.kind === "completed" && claim.completion).toEqual(imported.completion);
  // Same bytes, therefore an adoptable render->rename sibling.
  const record = (completion: CompletionTuple): Buffer => encodeMigrationControl({
    ...m3Control({ ...imported, completion }), controlRevision: 3,
  });
  expect(record(claim.kind === "completed" ? claim.completion : imported.completion)
    .equals(record(imported.completion))).toBe(true);
});

test("M4 verifies on the owning connection and leaves the staging file at S0", async () => {
  const imported = await importState("m4-prove", fixtureState());
  const witness = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks);
  expect(observeSidecars(imported.stagingPath)).toEqual([]);
  expect(witness.staging.semanticDigest).toBe(imported.completion.sourceSemanticDigest);
  expect(witness.staging.entryCount).toBe(5);
  expect(witness.staging.proofVersion).toBe(1);
  const observed = observePath(imported.stagingPath, true);
  expect(observed).toMatchObject({ state: "regular", sha256: witness.staging.sha256, bytes: witness.staging.bytes });
});

test("M4 is repeatable and its proof recurs byte-for-byte", async () => {
  const imported = await importState("m4-determinism", fixtureState());
  const receipt = receiptFor(m3Control(imported));
  const first = await proveStaging(imported.root, receipt, locks);
  const second = await proveStaging(imported.root, receipt, locks);
  expect(second).toEqual(first);
});

test("a rebuilt import reproduces the same lineage and the same rows", async () => {
  // The lineage id is derived from the migration and authority ids, not minted:
  // a resume that had to rebuild the staging file must produce a database whose
  // digest still equals the one the source predicts, or the fidelity gate would
  // pass only on the first attempt.
  const imported = await importState("rebuild-determinism", fixtureState());
  const published = control(imported.root, imported.source, {
    phase: "M2", admission: ADMISSION, ...imported.m2,
    stagingMain: { state: "present", ...imported.identity },
  });
  // Reset the recorded inode exactly as observation 3 does, then import again.
  fs.truncateSync(imported.stagingPath, 0);
  for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(`${imported.stagingPath}${suffix}`, { force: true });
  const again = await importOwnedStaging(
    imported.root, { identity: imported.identity, receipt: receiptFor(published) }, locks,
  );
  const { completedAt: _first, ...before } = imported.completion;
  const { completedAt: _second, ...after } = again.completion;
  expect(after).toEqual(before);
});

test("the SQL walk's ORDER BY is what fixes the token order", async () => {
  // The importer writes in sorted order and every ordered table has a covering
  // index in that same order, so dropping an `ORDER BY` changes nothing on an
  // ordinary plan — the clause looks like dead weight and mutates as an
  // equivalent. `reverse_unordered_selects` is SQLite's own switch for exactly
  // this: it reverses the row order of any SELECT whose order is not pinned,
  // and leaves an `ORDER BY` alone. Under it, a missing clause is a different
  // digest, so every one of them is now load-bearing and falsifiable.
  const imported = await importState("order-by", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  try {
    const db = stateStoreDatabase(store);
    const ordered = stateSemanticDigest(db);
    db.exec("PRAGMA reverse_unordered_selects=ON");
    expect(stateSemanticDigest(db)).toBe(ordered);
    db.exec("PRAGMA reverse_unordered_selects=OFF");
    // The switch has to actually move an unordered read, or it proved nothing.
    db.exec("PRAGMA reverse_unordered_selects=ON");
    const reversed = db.query("SELECT rel_path FROM repo_records").all() as Array<{ rel_path: string }>;
    db.exec("PRAGMA reverse_unordered_selects=OFF");
    const forward = db.query("SELECT rel_path FROM repo_records").all() as Array<{ rel_path: string }>;
    expect(reversed.map((row) => row.rel_path)).toEqual([...forward.map((row) => row.rel_path)].reverse());
    expect(forward.length).toBeGreaterThan(1);

    // `role` leads the git ordering, and it has to: the same relPath is stored
    // under BOTH roles, so ordering by `path_order` alone leaves those two rows
    // tied and their relative order to the query planner. Assert the tie really
    // exists, then that roles come out grouped rather than interleaved.
    const git = db.query("SELECT role,rel_path FROM manifest_git_sections ORDER BY role,path_order")
      .all() as Array<{ role: string; rel_path: string }>;
    const shared = git.filter((row) => row.rel_path === "repo-a");
    expect(shared.map((row) => row.role)).toEqual(["manifest-projection", "meta-wire"]);
    const roles = git.map((row) => row.role);
    expect(roles).toEqual([...roles].sort());
    expect(new Set(roles).size).toBe(2);
  } finally {
    store.close();
  }
});

test("the import lineage id is the pinned domain-separated derivation", async () => {
  // Determinism alone does not pin this: any stable function of the two ids
  // passes a same-input-same-output test, including one with no domain
  // separation at all. The exact value is the contract, because two migrations
  // in one workspace must not collide and a bare concatenation of two hex ids
  // is ambiguous about where one ends.
  const expected = crypto.createHash("sha256")
    .update(`rbox-state-lineage-v1\n${MIGRATION}\n${AUTHORITY}`)
    .digest("hex").slice(0, 32);
  const imported = await importState("lineage-id", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  try {
    expect(store.header.active_lineage_id).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{32}$/);
    // Domain separation is load-bearing, not decoration.
    expect(expected).not.toBe(crypto.createHash("sha256").update(`${MIGRATION}\n${AUTHORITY}`).digest("hex").slice(0, 32));
    expect(expected).not.toBe(crypto.createHash("sha256").update(`${MIGRATION}${AUTHORITY}`).digest("hex").slice(0, 32));
  } finally {
    store.close();
  }
});

test("computing the SQL digest leaves the database able to reach S0", async () => {
  // The regression that made M4 unimplementable a second time: `db.query`
  // caches its statement on the connection, and a connection still holding one
  // cannot let SQLite remove `-wal`/`-shm` at close. Every statement on the
  // path to `S0` is prepared and finalized; this is what proves it.
  const imported = await importState("s0-after-digest", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  try {
    stateSemanticDigest(stateStoreDatabase(store));
  } finally {
    store.close();
  }
  expect(observeSidecars(imported.stagingPath)).toEqual([]);
});

test("M4 halts on verification when the imported rows no longer reproduce the digest", async () => {
  const imported = await importState("m4-tamper", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  stateStoreDatabase(store).query("UPDATE state_lineage SET last_synced_sequence=last_synced_sequence+1").run();
  store.close();
  const failure = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
});

test("M4 halts when the committed completion row is not the one M3 published", async () => {
  // `entry_count` is outside the semantic digest's token stream, so only the
  // tuple comparison can catch it.
  const imported = await importState("m4-completion", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  stateStoreDatabase(store).query("UPDATE migration_completion SET entry_count=entry_count+1 WHERE singleton=1").run();
  store.close();
  const failure = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
});

test("M4 refuses a staging database whose authority is not the one the control names", async () => {
  // Tampering the DB side is caught earlier by `validateOpen`'s coherence
  // invariant (asserted below). The check this pins is the other direction: the
  // database is internally perfect but belongs to a different authority than
  // the control that is about to publish a proof about it.
  const imported = await importState("m4-authority", fixtureState());
  const foreign = m3Control({
    ...imported,
    completion: { ...imported.completion, authorityId: "f".repeat(32) },
  });
  const failure = await proveStaging(imported.root, receiptFor(foreign), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).message).toMatch(/different authority/);
});

test("a staging database that will not open as a valid store is a halt, not a raw store error", async () => {
  const imported = await importState("m4-unopenable", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  stateStoreDatabase(store).query("UPDATE store_meta SET authority_id=? WHERE singleton=1").run("f".repeat(32));
  store.close();
  const failure = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).message).toMatch(/did not open as a valid store/);
});

test("M4 refuses a dangling plane entry that integrity_check calls healthy", async () => {
  // `integrity_check` validates pages and indexes; it does not chase foreign
  // keys. An orphaned `plane_entries` row is structurally perfect and
  // semantically dangling — the shape a partial import leaves — so this is the
  // check that catches it, and the two are not interchangeable.
  const imported = await importState("m4-fk", fixtureState());
  const store = openStateStoreForWalTakeover(imported.stagingPath);
  const db = stateStoreDatabase(store);
  db.exec("PRAGMA foreign_keys=OFF");
  db.query(`INSERT INTO plane_entries(lineage_id,plane,path,path_order,entry_id,changed_generation)
    VALUES ((SELECT lineage_id FROM state_lineage),'base','orphan.txt',x'0000','no-such-entry',0)`).run();
  expect((db.query("PRAGMA integrity_check").all() as Array<Record<string, unknown>>)
    .map((row) => Object.values(row)[0])).toEqual(["ok"]);
  expect(db.query("PRAGMA foreign_key_check").all().length).toBeGreaterThan(0);
  store.close();
  const failure = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("verification");
  expect((failure as MigrationPhaseHaltError).message).toMatch(/foreign key violations/);
});

test("M4 halts rather than publishing when the checkpoint cannot reach rest", async () => {
  // A second connection holding an open read keeps frames in the WAL, so
  // `wal_checkpoint(TRUNCATE)` comes back busy. That is a durability question,
  // not a corruption one, and it must be a typed halt rather than a raw throw.
  const imported = await importState("m4-busy", fixtureState());
  const reader = openStateStoreForWalTakeover(imported.stagingPath);
  const readerDb = stateStoreDatabase(reader);
  readerDb.exec("BEGIN");
  readerDb.query("SELECT count(*) AS n FROM entry_values").get();
  try {
    const failure = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks)
      .then(() => undefined, (error: unknown) => error);
    expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
    expect((failure as MigrationPhaseHaltError).halt.code).toBe("durability-indeterminate");
    // A halt AFTER the database was opened and recovered reports that honestly.
    expect((failure as MigrationPhaseHaltError).wrote).toBe(true);
  } finally {
    readerDb.exec("ROLLBACK");
    reader.close();
  }
});

test("M4 refuses a staging path that is no longer the recorded inode", async () => {
  const imported = await importState("m4-foreign", fixtureState());
  // Build the replacement at a DIFFERENT path first, so the swap cannot be
  // handed back the inode it just freed. tmpfs never recycles and ext4 always
  // does, so a fixture that unlinks before it creates passes here and asserts
  // nothing in CI — hence the construction, and the assertion that it worked.
  const copy = `${imported.stagingPath}.other`;
  fs.copyFileSync(imported.stagingPath, copy);
  fs.rmSync(imported.stagingPath);
  fs.renameSync(copy, imported.stagingPath);
  const swapped = observePath(imported.stagingPath);
  expect(swapped.state).toBe("regular");
  expect(
    `${(swapped as ClaimedInode).dev}:${(swapped as ClaimedInode).ino}`,
    "the fixture must actually produce a different inode",
  ).not.toBe(`${imported.identity.dev}:${imported.identity.ino}`);
  const failure = await proveStaging(imported.root, receiptFor(m3Control(imported)), locks)
    .then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(MigrationPhaseHaltError);
  expect((failure as MigrationPhaseHaltError).halt.code).toBe("reserved-path");
});
