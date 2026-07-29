import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORITY_MARKER_MAGIC } from "../authority-marker.js";
import { StateAuthorityCorruptError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { createStateStore, openStateStoreForWalTakeover, stateStoreDatabase } from "../store/open.js";
import { isForeign, observePath, observeQSibling } from "./artifact-observation.js";
import { classifyMigrationState, PhaseReceipt, type MigrationObservation } from "./classifier.js";
import {
  encodeMigrationControl, MIGRATION_PHASES,
  type Cursor, type MigrationControl, type MigrationPhase, type MigrationWitness,
  type SourceWitness, type StagingProof,
} from "./control-codec.js";
import type { MigrationHalt } from "./health.js";

const locks = {} as unknown as HeldStatePlaneLocks;
const ID = "m1";
const AUTHORITY = "ab".repeat(16);
const LINEAGE = "cd".repeat(16);
const HASH = "a".repeat(64);
const MARKER = Buffer.from(`${AUTHORITY_MARKER_MAGIC}\n${AUTHORITY}\n`, "latin1");
const HALT: MigrationHalt = { code: "filesystem-full", underlyingCode: "ENOSPC", required: 10, available: 1 };
const DEFERRED: MigrationHalt = { code: "cleanup-deferred", underlyingCode: null, required: null, available: null };
const INDETERMINATE: MigrationHalt = { code: "durability-indeterminate", underlyingCode: null, required: null, available: null };

// ---------------------------------------------------------------------------
// Fixtures.

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-classify-"));
  fs.mkdirSync(path.join(root, ".rbox", "state"), { recursive: true });
  return root;
}

function writeFile(file: string, bytes: Buffer | string, mode = 0o600): void {
  fs.writeFileSync(file, bytes, { mode });
}

function observeLegacy(root: string): SourceWitness {
  const observed = observePath(statePath(root), true);
  if (observed.state !== "regular" || observed.sha256 === null) throw new Error("fixture legacy file is not regular");
  return {
    path: statePath(root), dev: observed.dev, ino: observed.ino,
    bytes: observed.bytes, sha256: observed.sha256, mtimeNs: observed.mtimeNs,
  };
}

/** The legacy document, bracketed exactly as the control records its source. */
function writeLegacy(root: string, body = '{"schemaVersion":1}\n'): SourceWitness {
  writeFile(statePath(root), body);
  return observeLegacy(root);
}

const proofOf = (body: string): StagingProof => ({
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
  bytes: Buffer.byteLength(body),
  semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1,
});

function proofOfFile(file: string): StagingProof {
  const bytes = fs.readFileSync(file);
  return {
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength,
    semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1,
  };
}

/** Opaque bytes at the active path. Legitimate for the FROZEN window, which
 * decides identity from the physical witness and never opens the database. */
function writeOpaqueActive(root: string, body: string): StagingProof {
  writeFile(sqliteResetPaths.active(root), body);
  return proofOf(body);
}

/** A real state store at the active path, which every LIVE-window row needs:
 * identity there comes from `store_meta` and the completion singleton. */
function writeStore(
  root: string, over: { authorityId?: string; migrationId?: string } = {},
): StagingProof {
  const file = sqliteResetPaths.active(root);
  const store = createStateStore(file, {
    stream: "s1", authorityId: over.authorityId ?? AUTHORITY, lineageId: LINEAGE, createdBy: "test",
  });
  stateStoreDatabase(store)
    .query("UPDATE migration_completion SET origin_kind='migration', migration_id=? WHERE singleton=1")
    .run(over.migrationId ?? ID);
  store.close();
  return proofOfFile(file);
}

const artifactAt = (file: string) => ({ path: file, dev: 1, ino: 2, bytes: 3, sha256: HASH });
const cursorOf = (root: string): Cursor => ({
  items: [{ role: "reserve", path: migrationPaths.reserve(root), parent: path.dirname(migrationPaths.reserve(root)), dev: 1, ino: 9, sha256: null }],
  durablePrefix: 0,
  currentIntent: null,
});

interface Fixture {
  readonly source: SourceWitness;
  readonly staging?: StagingProof;
  readonly active?: StagingProof;
  readonly stagingMain?: { state: "absent" } | { state: "present"; dev: number; ino: number };
  readonly qDisposition?: { state: "absent" } | { state: "building" | "exact"; dev: number; ino: number };
}

/** The witness is monotone, so each phase is its predecessor plus one layer. */
function witnessFor(root: string, phase: MigrationPhase, f: Fixture): MigrationWitness {
  const layers: readonly Record<string, unknown>[] = [
    {},
    { admission: { sourceBytes: f.source.bytes, requiredBytes: 520, budgetBytes: 4096 } },
    {
      history: artifactAt(migrationPaths.backupHistory(root, HASH)),
      fixedBackup: artifactAt(migrationPaths.fixedBackup(root)),
      stagingMain: f.stagingMain ?? { state: "absent" },
    },
    {
      completion: {
        migrationId: ID, importerVersion: "2.0.0", authorityId: AUTHORITY, sourceJsonSha256: f.source.sha256,
        sourceSemanticDigest: HASH, sourceBytes: f.source.bytes, entryCount: 1, repoCount: 0,
        perTableCounts: { files: 1 }, completedAt: 5,
      },
    },
    { staging: f.staging ?? proofOf("staging") },
    {
      active: f.active ?? proofOf("active"),
      qSibling: {
        path: migrationPaths.qSibling(root, ID), bytes: 58,
        sha256: crypto.createHash("sha256").update(MARKER).digest("hex"),
        disposition: f.qDisposition ?? { state: "absent" },
      },
    },
    { cleanup: cursorOf(root), futureControls: null },
    { terminalSibling: { ...artifactAt(migrationPaths.controlRevision(root, ID, 9)), disposition: "exact-or-absent-terminal" } },
  ];
  return Object.assign({ phase }, ...layers.slice(0, MIGRATION_PHASES.indexOf(phase) + 1)) as MigrationWitness;
}

function resourcesFor(phase: MigrationPhase): MigrationControl["haltResources"] {
  const available = { disposition: "available", dev: 1, ino: 20, bytes: 1_048_576, sha256: HASH } as const;
  if (phase === "M0") return { reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" } };
  if (phase === "M7") return { reserve: { disposition: "retired" }, emergency: { disposition: "retired" } };
  return { reserve: available, emergency: available };
}

function writeControl(
  root: string, phase: MigrationPhase, f: Fixture, over: Partial<MigrationControl> = {},
): MigrationControl {
  const control: MigrationControl = {
    version: 1, controlRevision: 1, migrationId: ID, authorityId: AUTHORITY,
    source: f.source, stagingPath: migrationPaths.staging(root, ID),
    witness: witnessFor(root, phase, f),
    haltResources: resourcesFor(phase),
    halt: null, retirement: null,
    ...over,
  };
  writeFile(migrationPaths.control(root), Buffer.from(encodeMigrationControl(control)));
  return control;
}

const retirementFor = (root: string, source: SourceWitness) => ({
  version: 1 as const, reason: "source-changed" as const, fromPhase: "M2" as const,
  fromControlRevision: 1, originalSource: source, triggeringSource: source, cursor: cursorOf(root),
});

/** A flipped workspace at `phase` whose active path holds a real store. */
function flipped(root: string, phase: "M5" | "M6" | "M7", over: Partial<MigrationControl> = {}): void {
  const source = writeLegacy(root);
  writeControl(root, phase, { source, active: writeStore(root) }, over);
  writeFile(statePath(root), MARKER);
}

/** A Q sibling of exactly these bytes, recorded at the given disposition. */
function sibling(root: string, bytes: Buffer, state: "building" | "exact"): Fixture["qDisposition"] {
  const file = migrationPaths.qSibling(root, ID);
  writeFile(file, bytes);
  const observed = observePath(file);
  if (observed.state !== "regular") throw new Error("fixture sibling is not regular");
  return { state, dev: observed.dev, ino: observed.ino };
}

// ---------------------------------------------------------------------------
// The zero-write proof: every entry under `.rbox`, byte for byte, plus the exact
// set of names and each file's mtime — so a sidecar that appeared and was
// removed, or a pure `utimes` bump, still fails.

function snapshot(root: string): string {
  const lines: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const rel = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        lines.push(`dir ${rel}`);
        walk(full, `${rel}/`);
        continue;
      }
      const stat = fs.lstatSync(full, { bigint: true });
      const digest = entry.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "-";
      lines.push(`file ${rel} ${stat.mode.toString(8)} ${stat.size} ${stat.dev}:${stat.ino} ${stat.mtimeNs} ${digest}`);
    }
  };
  walk(path.join(root, ".rbox"), "");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------

/** `"corrupt"` is the hard contradictory-authority error, which is thrown rather
 * than returned: it is not a migration row at all. */
type ExpectedRow = MigrationObservation["row"] | "corrupt";

interface Row {
  readonly name: string;
  /** Builds the workspace and returns the row that workspace must classify as. */
  readonly build: (root: string) => ExpectedRow;
  /** Extra assertions on the returned observation. */
  readonly check?: (observation: MigrationObservation) => void;
}

const ROWS: readonly Row[] = [
  // --- JSON authority: positive rows ---------------------------------------
  {
    name: "L + no control is eligible for M0",
    build: (root) => { writeLegacy(root); return "no-control-json"; },
  },
  {
    name: "L + exact M0 resumes M0",
    build: (root) => { writeControl(root, "M0", { source: writeLegacy(root) }); return "m0-resume"; },
  },
  {
    name: "L + exact M1 resumes M1",
    build: (root) => { writeControl(root, "M1", { source: writeLegacy(root) }); return "m1-resume"; },
  },
  {
    name: "L + M2 with no staging main reports it absent",
    build: (root) => { writeControl(root, "M2", { source: writeLegacy(root) }); return "m2-resume"; },
    check: (o) => expect(o.row === "m2-resume" && o.staging).toEqual({ state: "absent" }),
  },
  {
    name: "L + M2 admits the sole zero-byte create-ahead staging shape",
    build: (root) => {
      writeControl(root, "M2", { source: writeLegacy(root) });
      writeFile(migrationPaths.staging(root, ID), "");
      return "m2-resume";
    },
    check: (o) => expect(o.row === "m2-resume" && o.staging).toEqual({ state: "create-ahead" }),
  },
  {
    name: "L + M2 reports the recorded staging main and its own sidecars",
    build: (root) => {
      const source = writeLegacy(root);
      const staging = migrationPaths.staging(root, ID);
      writeFile(staging, "partial");
      writeFile(`${staging}-wal`, "w");
      const observed = observePath(staging);
      if (observed.state !== "regular") throw new Error("fixture");
      writeControl(root, "M2", { source, stagingMain: { state: "present", dev: observed.dev, ino: observed.ino } });
      return "m2-resume";
    },
    check: (o) => expect(o.row === "m2-resume" && o.staging).toEqual({ state: "recorded", bytes: 7, sidecars: ["-wal"] }),
  },
  {
    name: "L + exact M3 resumes M3",
    build: (root) => { writeControl(root, "M3", { source: writeLegacy(root) }); return "m3-resume"; },
  },
  {
    name: "L + exact M4 with no active database resumes M4",
    build: (root) => { writeControl(root, "M4", { source: writeLegacy(root) }); return "m4-resume"; },
  },
  {
    name: "L + M4 admits the M5 rename running one phase ahead",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M4", { source, staging: writeOpaqueActive(root, "db-bytes") });
      return "m4-resume";
    },
  },
  {
    name: "L + exact M5 with the sibling absent resumes M5",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: writeOpaqueActive(root, "db-bytes") });
      return "m5-resume";
    },
    check: (o) => expect(o.row === "m5-resume" && o.sibling).toEqual({ state: "absent" }),
  },
  {
    name: "L + M5 reports a partially built Q sibling",
    build: (root) => {
      const source = writeLegacy(root);
      const qDisposition = sibling(root, MARKER.subarray(0, 20), "building");
      writeControl(root, "M5", { source, active: writeOpaqueActive(root, "db-bytes"), qDisposition });
      return "m5-resume";
    },
    check: (o) => expect(o.row === "m5-resume" && o.sibling).toEqual({ state: "building", bytes: 20 }),
  },
  {
    name: "L + M5 reports a complete Q sibling",
    build: (root) => {
      const source = writeLegacy(root);
      const qDisposition = sibling(root, MARKER, "exact");
      writeControl(root, "M5", { source, active: writeOpaqueActive(root, "db-bytes"), qDisposition });
      return "m5-resume";
    },
    check: (o) => expect(o.row === "m5-resume" && o.sibling).toEqual({ state: "exact" }),
  },
  {
    name: "an armed retirement reports its cursor",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M2", { source }, { retirement: retirementFor(root, source) });
      return "retirement-cursor";
    },
    check: (o) => expect(o.row === "retirement-cursor" && o.cursor.durablePrefix).toBe(0),
  },
  {
    name: "a halted phase suspends the migration",
    build: (root) => { writeControl(root, "M2", { source: writeLegacy(root) }, { halt: HALT }); return "halted"; },
    check: (o) => expect(o.row === "halted" && o.halt.code).toBe("filesystem-full"),
  },
  {
    name: "a halted retirement suspends at its cursor",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M2", { source }, { retirement: retirementFor(root, source), halt: HALT });
      return "halted";
    },
  },

  // --- Every term of the source identity bracket, one at a time -------------
  ...(["dev", "ino", "bytes", "sha256", "mtimeNs"] as const).map((term) => ({
    name: `a source whose ${term} alone differs arms C1`,
    build: (root: string): ExpectedRow => {
      const live = writeLegacy(root);
      const value = live[term];
      const changed = typeof value === "number" ? value + 1 : `1${value}`.slice(0, value.length);
      writeControl(root, "M1", { source: { ...live, [term]: changed } });
      return "source-changed";
    },
    check: (o: MigrationObservation) => expect(o.row === "source-changed" && o.trigger.disposition).toBe("source-changed"),
  })),

  // --- The authority marker: positive rows ----------------------------------
  {
    name: "Q + a matching store + no control is terminal SQLite",
    build: (root) => { writeStore(root); writeFile(statePath(root), MARKER); return "terminal-sqlite"; },
  },
  {
    name: "Q + exact M5 is the artifact-ahead boundary",
    build: (root) => { flipped(root, "M5"); return "m5-artifact-ahead-q"; },
  },
  {
    name: "Q + exact M6 reports the cleanup cursor",
    build: (root) => { flipped(root, "M6"); return "m6-cleanup"; },
    check: (o) => expect(o.row === "m6-cleanup" && o.cursor.items.length).toBe(1),
  },
  {
    name: "Q + exact M7 retires the control only",
    build: (root) => { flipped(root, "M7"); return "m7"; },
  },
  {
    name: "Q + a writable cleanup-deferred halt stays suspended, not corrupt",
    build: (root) => { flipped(root, "M6", { halt: DEFERRED }); return "halted"; },
  },
  {
    name: "Q + a write-blocking halt stays in the frozen window",
    build: (root) => { flipped(root, "M6", { halt: INDETERMINATE }); return "halted"; },
  },

  // --- Corruption: zero-write halts ----------------------------------------
  {
    name: "an orphan database under L with no control is not adopted",
    build: (root) => { writeLegacy(root); writeOpaqueActive(root, "db-bytes"); return "corruption"; },
  },
  {
    name: "a malformed control is corruption",
    build: (root) => {
      writeLegacy(root);
      writeFile(migrationPaths.control(root), "{not json");
      return "corruption";
    },
  },
  {
    name: "a database before the migration built one is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M1", { source });
      writeOpaqueActive(root, "db-bytes");
      return "corruption";
    },
  },
  {
    name: "an M6 control under legacy authority is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeOpaqueActive(root, "db-bytes") });
      return "corruption";
    },
  },
  {
    name: "an M5 active database that is not the proved one is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: proofOf("db-bytes") });
      writeOpaqueActive(root, "other-by");
      return "corruption";
    },
  },
  {
    name: "an M5 active database of a different length is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: proofOf("db-bytes") });
      writeOpaqueActive(root, "db-bytes-and-more");
      return "corruption";
    },
  },
  {
    name: "an M5 active database that is gone is corruption",
    build: (root) => {
      writeControl(root, "M5", { source: writeLegacy(root), active: proofOf("db-bytes") });
      return "corruption";
    },
  },
  {
    name: "an M4 rename-ahead database that is not the staged one is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M4", { source, staging: proofOf("db-bytes") });
      writeOpaqueActive(root, "other-by");
      return "corruption";
    },
  },
  {
    name: "a frozen active database with a sidecar is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: writeOpaqueActive(root, "db-bytes") });
      writeFile(`${sqliteResetPaths.active(root)}-wal`, "frames");
      return "corruption";
    },
  },
  {
    name: "a symlink at the active path is never followed",
    build: (root) => {
      const source = writeLegacy(root);
      const real = path.join(root, ".rbox", "state", "real.db");
      writeFile(real, "db-bytes");
      fs.symlinkSync(real, sqliteResetPaths.active(root));
      writeControl(root, "M4", { source, staging: proofOf("db-bytes") });
      return "corruption";
    },
  },
  {
    name: "a staging sidecar without its main is corruption",
    build: (root) => {
      writeControl(root, "M2", { source: writeLegacy(root) });
      writeFile(`${migrationPaths.staging(root, ID)}-wal`, "w");
      return "corruption";
    },
  },
  {
    name: "a nonzero unrecorded staging main is corruption",
    build: (root) => {
      writeControl(root, "M2", { source: writeLegacy(root) });
      writeFile(migrationPaths.staging(root, ID), "unrecorded");
      return "corruption";
    },
  },
  {
    name: "a world-readable zero-byte staging main is not the create-ahead shape",
    build: (root) => {
      writeControl(root, "M2", { source: writeLegacy(root) });
      writeFile(migrationPaths.staging(root, ID), "", 0o644);
      return "corruption";
    },
  },
  {
    name: "an absent legacy path with no genesis is manual damage",
    build: () => "corruption",
  },
  {
    name: "a legacy path that is neither JSON nor the marker is manual damage",
    build: (root) => { writeFile(statePath(root), " binary"); return "corruption"; },
  },
  {
    name: "a symlinked legacy path is manual damage",
    build: (root) => {
      writeFile(path.join(root, ".rbox", "elsewhere.json"), '{"schemaVersion":1}\n');
      fs.symlinkSync(path.join(root, ".rbox", "elsewhere.json"), statePath(root));
      return "corruption";
    },
  },
  {
    name: "a regular file where .rbox/state must be a directory is manual damage",
    build: (root) => {
      writeLegacy(root);
      fs.rmSync(path.join(root, ".rbox", "state"), { recursive: true });
      writeFile(path.join(root, ".rbox", "state"), "not a directory");
      return "corruption";
    },
  },
  {
    name: "a retirement cannot survive the authority flip",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeStore(root) }, { retirement: retirementFor(root, source) });
      writeFile(statePath(root), MARKER);
      return "corruption";
    },
  },
  {
    name: "Q with a pre-flip control phase is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M3", { source });
      writeStore(root);
      writeFile(statePath(root), MARKER);
      return "corruption";
    },
  },
  {
    name: "a Q sibling that survived the authority rename is corruption",
    build: (root) => {
      flipped(root, "M5");
      writeFile(migrationPaths.qSibling(root, ID), MARKER);
      return "corruption";
    },
  },
  {
    name: "a frozen Q window with a database sidecar is corruption",
    build: (root) => {
      flipped(root, "M5");
      writeFile(`${sqliteResetPaths.active(root)}-wal`, "frames");
      return "corrupt";
    },
  },
  {
    name: "a Q sibling longer than the authority marker is foreign",
    build: (root) => {
      const source = writeLegacy(root);
      const qDisposition = sibling(root, Buffer.concat([MARKER, Buffer.from("x")]), "exact");
      writeControl(root, "M5", { source, active: writeOpaqueActive(root, "db-bytes"), qDisposition });
      return "corruption";
    },
  },

  // --- Contradictory authority: hard, never retryable ------------------------
  {
    name: "Q with no database is contradictory authority",
    build: (root) => { writeFile(statePath(root), MARKER); return "corrupt"; },
  },
  {
    name: "Q with a zero-byte database is contradictory authority",
    build: (root) => {
      writeFile(sqliteResetPaths.active(root), "");
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "Q naming a different authority than the control is contradictory",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeStore(root) }, { authorityId: "cd".repeat(16) });
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "a frozen Q window whose database is not the published one is contradictory",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: proofOf("db-bytes") });
      writeOpaqueActive(root, "other-by");
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "terminal Q over bytes that are not a database is contradictory",
    build: (root) => {
      writeFile(sqliteResetPaths.active(root), Buffer.alloc(100, 0x41));
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "terminal Q over a truncated database is contradictory",
    build: (root) => {
      writeStore(root);
      const file = sqliteResetPaths.active(root);
      writeFile(file, fs.readFileSync(file).subarray(0, 4096));
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "terminal Q over a store carrying a foreign authority is contradictory",
    build: (root) => {
      writeStore(root, { authorityId: "ff".repeat(16) });
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "a live Q window whose store was published by another migration is contradictory",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeStore(root, { migrationId: "someone-else" }) });
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
];

describe("migration classifier", () => {
  for (const row of ROWS) {
    test(row.name, async () => {
      const root = workspace();
      try {
        const expected = row.build(root);
        const before = snapshot(root);
        if (expected === "corrupt") {
          await expect(classifyMigrationState(root, locks)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
        } else {
          const observation = await classifyMigrationState(root, locks);
          expect(observation.row).toBe(expected);
          row.check?.(observation);
        }
        // The zero-write proof: names, modes, bytes, inodes, and mtimes under
        // `.rbox` are exactly what they were. The live window opens the store as
        // its owner, so this also proves that open leaves nothing behind.
        expect(snapshot(root), "the classifier mutated the workspace").toBe(before);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  test("every observation row is covered", () => {
    // Compiler-enforced exhaustive: a row added to the union without a fixture
    // fails to typecheck here before it fails to assert.
    const ALL: Record<ExpectedRow, true> = {
      "no-control-json": true, "m0-resume": true, "m1-resume": true, "m2-resume": true,
      "m3-resume": true, "m4-resume": true, "m5-resume": true, "source-changed": true,
      "retirement-cursor": true, "m5-artifact-ahead-q": true, "m6-cleanup": true, "m7": true,
      "terminal-sqlite": true, "halted": true, "corruption": true, "corrupt": true,
    };
    const covered = new Set<ExpectedRow>();
    for (const row of ROWS) {
      const root = workspace();
      try { covered.add(row.build(root)); } finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
    expect(Object.keys(ALL).filter((row) => !covered.has(row as ExpectedRow))).toEqual([]);
    expect(new Set(ROWS.map((row) => row.name)).size, "two fixtures share a name").toBe(ROWS.length);
  });

  // B1 REGRESSION. Once the write fence lifts the store is in ordinary use, and
  // `cleanup-deferred`'s shipped copy tells the user the workspace "is fully
  // working on the new format and syncing normally" (222:1293). A physical
  // `{bytes, sha256}` check goes stale on the first save and would raise a
  // never-retryable `StateAuthorityCorruptError` on a healthy workspace.
  for (const [name, phase, over, expected] of [
    ["M6", "M6", {}, "m6-cleanup"],
    ["M6 + cleanup-deferred", "M6", { halt: DEFERRED }, "halted"],
    ["M7", "M7", {}, "m7"],
  ] as const) {
    test(`an ordinary save after ${name} does not brick the workspace`, async () => {
      const root = workspace();
      try {
        flipped(root, phase, over);
        const store = openStateStoreForWalTakeover(sqliteResetPaths.active(root));
        stateStoreDatabase(store).query("UPDATE state_lineage SET last_synced_sequence=7").run();
        store.close();
        expect((await classifyMigrationState(root, locks)).row).toBe(expected);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  }

  // B2 REGRESSION. A `-wal` carrying committed frames changes the logical
  // content — including `store_meta.authority_id` — while the main file stays
  // byte-identical. The owning open takes recovery, so the frames are seen.
  // This is the one fixture that legitimately mutates: checkpointing is what an
  // owning opener is obliged to do, so the assertion is that no sidecar remains.
  test("a foreign -wal beside a byte-identical main is caught", async () => {
    const root = workspace();
    try {
      flipped(root, "M6");
      const file = sqliteResetPaths.active(root);
      const mainBefore = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
      const writer = openStateStoreForWalTakeover(file);
      stateStoreDatabase(writer).query("UPDATE store_meta SET authority_id=? WHERE singleton=1").run("ff".repeat(16));
      expect(crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"), "the WAL must be uncheckpointed").toBe(mainBefore);
      try {
        await expect(classifyMigrationState(root, locks)).rejects.toBeInstanceOf(StateAuthorityCorruptError);
      } finally {
        writer.close();
      }
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        expect(fs.existsSync(`${file}${suffix}`), `${suffix} was left behind`).toBeFalse();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // A FIFO makes a blocking `open(2)` hang forever, and being synchronous it
  // blocks the event loop, so no timeout above could rescue it (issue #556).
  for (const target of ["state.json", "state.db"] as const) {
    test(`a FIFO at ${target} is refused, not waited on`, async () => {
      const root = workspace();
      try {
        if (target === "state.json") {
          execFileSync("mkfifo", [statePath(root)]);
        } else {
          writeControl(root, "M1", { source: writeLegacy(root) });
          execFileSync("mkfifo", [sqliteResetPaths.active(root)]);
        }
        expect((await classifyMigrationState(root, locks)).row).toBe("corruption");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    }, 5000);
  }

  // The negative control for the zero-write proof: the snapshot must be able to
  // see the exact thing the classifier is forbidden to do in the frozen window.
  test("the snapshot catches the sidecars a read-only SQLite open would leave", () => {
    const root = workspace();
    try {
      const file = sqliteResetPaths.active(root);
      const writer = new Database(file, { create: true, readwrite: true });
      writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE t(x); INSERT INTO t VALUES(1);");
      writer.query("PRAGMA wal_checkpoint(TRUNCATE)").get();
      writer.close();
      const before = snapshot(root);
      const reader = new Database(file, { create: false, readonly: true });
      reader.query("SELECT x FROM t").get();
      reader.close();
      expect(snapshot(root), "a read-only open left no trace, so the proof proves nothing").not.toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Design 222 §7.9: the classifier and its observations perform no writes and
  // contain no genesis row. `active-store-proof.ts` is the one sanctioned opener
  // and is deliberately not in this list. Asserted on code, not comments.
  test("the classifier names no write primitive, no SQLite, and no genesis row", () => {
    const forbidden = new RegExp([
      "writeSync", "writeFileSync", "appendFile", "unlinkSync", "renameSync", "rmSync", "rmdirSync",
      "mkdirSync", "ftruncateSync", "truncateSync", "utimesSync", "chmodSync", "chownSync", "symlinkSync",
      "linkSync", "copyFileSync", "createWriteStream", "Bun\\.write", "fs\\.promises", "node:fs/promises",
      "O_CREAT", "O_WRONLY", "O_RDWR", "O_TRUNC", "O_APPEND", "bun:sqlite", "new Database",
      "openSync\\([^)]*[\"'][waxr]\\+?[\"']", "genesis",
    ].join("|"), "i");
    for (const name of ["classifier.ts", "artifact-observation.ts"]) {
      const code = fs.readFileSync(path.join(import.meta.dir, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      expect(forbidden.test(code), `${name} names a write primitive, SQLite, or genesis`).toBeFalse();
    }
  });

  test("a receipt carries the exact control it was observed from and cannot be respread", async () => {
    const root = workspace();
    try {
      const source = writeLegacy(root);
      const control = writeControl(root, "M1", { source }, { controlRevision: 7 });
      const observation = await classifyMigrationState(root, locks);
      if (observation.row !== "m1-resume") throw new Error(`expected m1-resume, got ${observation.row}`);
      expect(observation.receipt.phase).toBe("M1");
      expect(observation.receipt.control).toEqual(control);
      expect(observation.receipt.control.controlRevision).toBe(7);
      // @ts-expect-error a spread drops the private field, so a doctored receipt
      // is not a receipt — the `unique symbol` brand it replaced was type-level
      // only and let exactly this through.
      const forged: PhaseReceipt = { ...observation.receipt, phase: "M0" };
      void forged;
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // Two rules cannot be reached through `classifyMigrationState` — the control
  // read short-circuits every ENOTDIR, and the Q sibling's hash comparison
  // subsumes its length rule — so they are pinned directly, at the level where
  // they are the only discriminator.
  describe("observation primitives", () => {
    test("only ENOENT is absence; ENOTDIR is foreign", () => {
      const root = workspace();
      try {
        const blocker = path.join(root, ".rbox", "state", "blocker");
        writeFile(blocker, "not a directory");
        expect(observePath(path.join(root, ".rbox", "state", "gone")).state).toBe("absent");
        expect(observePath(path.join(blocker, "under-a-file")).state).toBe("foreign");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    test("a Q sibling longer than the marker is refused by its length rule (163:2650)", () => {
      const root = workspace();
      try {
        const file = migrationPaths.qSibling(root, ID);
        writeFile(file, Buffer.concat([MARKER, Buffer.from("x")]));
        const observed = observePath(file);
        if (observed.state !== "regular") throw new Error("fixture");
        const result = observeQSibling({
          path: file, bytes: 58, sha256: crypto.createHash("sha256").update(MARKER).digest("hex"),
          disposition: { state: "building", dev: observed.dev, ino: observed.ino },
        });
        expect(isForeign(result) && result.foreign).toContain("longer than the authority marker");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  test("classifying twice leaves the tree byte-identical", async () => {
    const root = workspace();
    try {
      flipped(root, "M6");
      const before = snapshot(root);
      await classifyMigrationState(root, locks);
      await classifyMigrationState(root, locks);
      expect(snapshot(root)).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
