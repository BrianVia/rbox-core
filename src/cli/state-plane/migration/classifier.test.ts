import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AUTHORITY_MARKER_MAGIC } from "../authority-marker.js";
import { StateAuthorityCorruptError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { observePath } from "./artifact-observation.js";
import { classifyMigrationState, type MigrationObservation } from "./classifier.js";
import {
  encodeMigrationControl, MIGRATION_PHASES,
  type Cursor, type MigrationControl, type MigrationPhase, type MigrationWitness,
  type SourceWitness, type StagingProof,
} from "./control-codec.js";
import type { MigrationHalt } from "./health.js";

const locks = {} as unknown as HeldStatePlaneLocks;
const ID = "m1";
const AUTHORITY = "ab".repeat(16);
const HASH = "a".repeat(64);
const MARKER = Buffer.from(`${AUTHORITY_MARKER_MAGIC}\n${AUTHORITY}\n`, "latin1");
const HALT: MigrationHalt = { code: "filesystem-full", underlyingCode: "ENOSPC", required: 10, available: 1 };

// ---------------------------------------------------------------------------
// Fixtures. No SQLite anywhere: a database is matched by the physical bytes the
// control recorded, so the tests write those bytes directly.

function workspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rbox-classify-"));
  fs.mkdirSync(path.join(root, ".rbox", "state"), { recursive: true });
  return root;
}

function writeFile(file: string, bytes: Buffer | string, mode = 0o600): void {
  fs.writeFileSync(file, bytes, { mode });
}

/** The legacy document, bracketed exactly as the control records its source. */
function writeLegacy(root: string, body = '{"schemaVersion":1}\n'): SourceWitness {
  writeFile(statePath(root), body);
  const observed = observePath(statePath(root), true);
  if (observed.state !== "regular" || observed.sha256 === null) throw new Error("fixture legacy file is not regular");
  return {
    path: statePath(root), dev: observed.dev, ino: observed.ino,
    bytes: observed.bytes, sha256: observed.sha256, mtimeNs: observed.mtimeNs,
  };
}

function writeActive(root: string, body: string): StagingProof {
  writeFile(sqliteResetPaths.active(root), body);
  return proofOf(body);
}

const proofOf = (body: string): StagingProof => ({
  sha256: crypto.createHash("sha256").update(body).digest("hex"),
  bytes: Buffer.byteLength(body),
  semanticDigest: HASH, entryCount: 1, repoCount: 0, proofVersion: 1,
});

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
  readonly qSha256?: string;
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
        sha256: f.qSha256 ?? crypto.createHash("sha256").update(MARKER).digest("hex"),
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

// ---------------------------------------------------------------------------
// The zero-write proof: every entry under `.rbox`, byte for byte, plus the exact
// set of names — so a SQLite sidecar that appeared and was removed still fails.

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
      const stat = fs.lstatSync(full);
      const digest = entry.isFile() ? crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex") : "-";
      lines.push(`file ${rel} ${stat.mode.toString(8)} ${stat.size} ${stat.dev}:${stat.ino} ${digest}`);
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
  // --- JSON authority -------------------------------------------------------
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
      writeControl(root, "M4", { source, staging: writeActive(root, "db-bytes") });
      return "m4-resume";
    },
  },
  {
    name: "L + exact M5 with the sibling absent resumes M5",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: writeActive(root, "db-bytes") });
      return "m5-resume";
    },
    check: (o) => expect(o.row === "m5-resume" && o.sibling).toEqual({ state: "absent" }),
  },
  {
    name: "L + M5 reports a partially built Q sibling",
    build: (root) => {
      const source = writeLegacy(root);
      const sibling = migrationPaths.qSibling(root, ID);
      writeFile(sibling, MARKER.subarray(0, 20));
      const observed = observePath(sibling);
      if (observed.state !== "regular") throw new Error("fixture");
      writeControl(root, "M5", {
        source, active: writeActive(root, "db-bytes"),
        qDisposition: { state: "building", dev: observed.dev, ino: observed.ino },
      });
      return "m5-resume";
    },
    check: (o) => expect(o.row === "m5-resume" && o.sibling).toEqual({ state: "building", bytes: 20 }),
  },
  {
    name: "L + M5 reports a complete Q sibling",
    build: (root) => {
      const source = writeLegacy(root);
      const sibling = migrationPaths.qSibling(root, ID);
      writeFile(sibling, MARKER);
      const observed = observePath(sibling);
      if (observed.state !== "regular") throw new Error("fixture");
      writeControl(root, "M5", {
        source, active: writeActive(root, "db-bytes"),
        qDisposition: { state: "exact", dev: observed.dev, ino: observed.ino },
      });
      return "m5-resume";
    },
    check: (o) => expect(o.row === "m5-resume" && o.sibling).toEqual({ state: "exact" }),
  },
  {
    name: "a changed source arms C1 instead of resuming",
    build: (root) => {
      writeControl(root, "M1", { source: writeLegacy(root) });
      writeLegacy(root, '{"schemaVersion":2}\n');
      return "source-changed";
    },
    check: (o) => expect(o.row === "source-changed" && o.trigger.disposition).toBe("source-changed"),
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

  // --- The authority marker -------------------------------------------------
  {
    name: "Q + a matching database + no control is terminal SQLite",
    build: (root) => {
      writeFile(statePath(root), MARKER);
      writeActive(root, "db-bytes");
      return "terminal-sqlite";
    },
  },
  {
    name: "Q + exact M5 is the artifact-ahead boundary",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: writeActive(root, "db-bytes") });
      writeFile(statePath(root), MARKER);
      return "m5-artifact-ahead-q";
    },
  },
  {
    name: "Q + exact M6 reports the cleanup cursor",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeActive(root, "db-bytes") });
      writeFile(statePath(root), MARKER);
      return "m6-cleanup";
    },
    check: (o) => expect(o.row === "m6-cleanup" && o.cursor.items.length).toBe(1),
  },
  {
    name: "Q + exact M7 retires the control only",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M7", { source, active: writeActive(root, "db-bytes") });
      writeFile(statePath(root), MARKER);
      return "m7";
    },
  },
  {
    name: "Q + a halted M6 stays suspended under SQLite authority",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeActive(root, "db-bytes") }, { halt: { ...HALT, code: "cleanup-deferred" } });
      writeFile(statePath(root), MARKER);
      return "halted";
    },
  },

  // --- Corruption: zero-write halts ----------------------------------------
  {
    name: "an orphan database under L with no control is not adopted",
    build: (root) => { writeLegacy(root); writeActive(root, "db-bytes"); return "corruption"; },
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
      writeActive(root, "db-bytes");
      return "corruption";
    },
  },
  {
    name: "an M6 control under legacy authority is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeActive(root, "db-bytes") });
      return "corruption";
    },
  },
  {
    name: "an M5 active database that is not the proved one is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: proofOf("db-bytes") });
      writeActive(root, "other-by");
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
    name: "an absent legacy path with no genesis is manual damage",
    build: () => "corruption",
  },
  {
    name: "a legacy path that is neither JSON nor the marker is manual damage",
    build: (root) => { writeFile(statePath(root), " binary"); return "corruption"; },
  },
  {
    name: "a retirement cannot survive the authority flip",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeActive(root, "db-bytes") }, { retirement: retirementFor(root, source) });
      writeFile(statePath(root), MARKER);
      return "corruption";
    },
  },
  {
    name: "Q with a pre-flip control phase is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M3", { source });
      writeActive(root, "db-bytes");
      writeFile(statePath(root), MARKER);
      return "corruption";
    },
  },
  {
    name: "a Q sibling that survived the authority rename is corruption",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: writeActive(root, "db-bytes") });
      writeFile(statePath(root), MARKER);
      writeFile(migrationPaths.qSibling(root, ID), MARKER);
      return "corruption";
    },
  },

  // --- Contradictory authority: hard, never retryable ------------------------
  {
    name: "Q with no database is contradictory authority",
    build: (root) => { writeFile(statePath(root), MARKER); return "corrupt"; },
  },
  {
    name: "Q naming a different authority than the control is contradictory",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: writeActive(root, "db-bytes") }, { authorityId: "cd".repeat(16) });
      writeFile(statePath(root), MARKER);
      return "corrupt";
    },
  },
  {
    name: "Q with a database the migration did not publish is contradictory",
    build: (root) => {
      const source = writeLegacy(root);
      writeControl(root, "M6", { source, active: proofOf("db-bytes") });
      writeActive(root, "other-by");
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
        // The zero-write proof: the whole `.rbox` tree, names and bytes and
        // inodes, is exactly what it was before the classification.
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

  // Design 222 §7.9: the classifier performs no writes and contains no genesis
  // row. Asserted on code, not comments, so a mention proves nothing either way.
  test("the classifier names no write primitive, no SQLite, and no genesis row", () => {
    const forbidden = /writeSync|writeFileSync|unlinkSync|renameSync|rmSync|mkdirSync|ftruncateSync|O_CREAT|O_WRONLY|O_RDWR|O_TRUNC|bun:sqlite|new Database|genesis/i;
    for (const name of ["classifier.ts", "artifact-observation.ts"]) {
      const code = fs.readFileSync(path.join(import.meta.dir, name), "utf8")
        .split("\n")
        .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
        .join("\n");
      expect(forbidden.test(code), `${name} names a write primitive, SQLite, or genesis`).toBeFalse();
    }
  });

  test("a receipt carries the exact control revision it was observed from", async () => {
    const root = workspace();
    try {
      const source = writeLegacy(root);
      const control = writeControl(root, "M1", { source }, { controlRevision: 7 });
      const observation = await classifyMigrationState(root, locks);
      expect(observation.row).toBe("m1-resume");
      if (observation.row !== "m1-resume") throw new Error("unreachable");
      expect(observation.receipt.phase).toBe("M1");
      expect(observation.receipt.control).toEqual(control);
      expect(observation.receipt.control.controlRevision).toBe(7);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // The negative control for the zero-write proof: the snapshot must be able to
  // see the exact thing the classifier is forbidden to do. A read-only open of a
  // cleanly checkpointed WAL database creates `-wal`/`-shm` and leaves them
  // behind, which is why nothing in the classifier opens SQLite.
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

  test("classifying twice leaves the tree byte-identical", async () => {
    const root = workspace();
    try {
      const source = writeLegacy(root);
      writeControl(root, "M5", { source, active: writeActive(root, "db-bytes") });
      writeFile(statePath(root), MARKER);
      const before = snapshot(root);
      await classifyMigrationState(root, locks);
      await classifyMigrationState(root, locks);
      expect(snapshot(root)).toBe(before);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
