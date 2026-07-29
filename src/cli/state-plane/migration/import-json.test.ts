import { afterEach, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { FileEntry, GitSection } from "../../../engine/index.js";
import { stateFromRepoRecords, type RepoRecord, type SyncState } from "../../sync-state-model.js";
import { loadRawStateFromStore } from "../adapters/read-only.js";
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

/** Extras at every level, both git roles, a symlink, a compressed entry, an
 * astral-plane path (where UTF-8 and UTF-16 orders disagree), and a
 * `resolutionIntent` the normalizer must strip before anything is derived. */
function fixtureState(): SyncState {
  const files: FileEntry[] = [
    { path: "a/plain.txt", sha256: hex(64, 1), size: 3, mode: 0o644, mtimeMs: 1.5, type: "file" },
    { path: "b/link", sha256: hex(64, 2), size: 0, mode: 0o777, type: "symlink", mtimeMs: 2, symlinkTarget: "../a/plain.txt" },
    {
      path: "c/enc.bin", sha256: hex(64, 3), size: 4096, mode: 0o600, mtimeMs: 3.25, type: "file",
      encSha: hex(64, 4), comp: "zstd", payloadSha: hex(64, 5), cipherSize: 900,
    },
    { path: "z/\u{1f600}.txt", sha256: hex(64, 6), size: 1, mode: 0o644, mtimeMs: 4, type: "file", extensionNull: null },
    { path: "z/.txt", sha256: hex(64, 7), size: 1, mode: 0o644, mtimeMs: 5, type: "file" },
  ] as FileEntry[];
  const records: Record<string, RepoRecord> = {
    "repo-a": { repoGen: 2, sourceSeq: 41, base: section(1), extensionObject: {} } as RepoRecord,
    "repo-b": { repoGen: 0, sourceSeq: 0, pending: section(2), removedKey: "gone", resolutionIntent: "obsolete" } as unknown as RepoRecord,
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
      gitRepos: { "repo-a": section(50), "repo-b": section(51) },
    } as never,
    stateNonce: "c".repeat(32),
    stateRevision: 7,
    telemetryBindingId: "d".repeat(16),
  } as SyncState, records);
}

/** A pre-record state: no `repoRecords`, five sidecar maps instead. */
function legacyMapState(): SyncState {
  return {
    stream: "workspace/legacy",
    lastSyncedSequence: 9,
    lastSyncedManifest: { generatedAt: "2026-07-29T00:00:00.000Z", files: [], gitRepos: { "repo-a": section(3) } } as never,
    gitReposRemoved: { "repo-x": "identity-x" },
    gitNeedsResolution: { "repo-y": "identity-y" },
    gitPendingRemote: { "repo-z": section(4) },
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
    expect(imported.completion.repoCount).toBe(2);
    expect(imported.completion.perTableCounts).toEqual({ entry_values: 5, plane_entries: 5, repo_records: 2 });
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
    // The fold that the JSON read path performs, performed once, at import.
    expect(imported.completion.repoCount).toBe(4);
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
    expect(loadRawStateFromStore(store)).toEqual(expected);
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
  const duplicate = { path: "a", sha256: hex(64, 1), size: 0, mode: 0o644, mtimeMs: 0, type: "file" };
  refuses({ ...base, lastSyncedManifest: { generatedAt: "", files: [duplicate, { ...duplicate }] } }, /repeats a path/);
  expect(() => normalizeLegacyStateV1(base as SyncState, "not-a-lineage")).toThrow(LegacyStateShapeError);
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
