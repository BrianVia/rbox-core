/**
 * Behavioral coverage for wave 5A's new logic — the tests the sandbox review
 * flagged as missing when `authority.test.ts` was entirely static.
 *
 * Two harnesses:
 *
 * - a REAL migratable workspace under a REAL `withStatePlaneLocks` bundle, which
 *   drives the whole loop M0→M7 for real: every phase body, every publication,
 *   and `publishHalt`. 5A read this harness's M4 stop as a fixture limitation
 *   ("the empty corpus cannot pass M4 fidelity") and pinned it as expected. It
 *   was not: M4 compared the two completion tuples with `JSON.stringify`, so a
 *   control that had been through the record's own canonical bytes could never
 *   match, and NO corpus could ever pass. A durable halt now has to be induced
 *   (`haltedControl`) rather than being whatever the harness happened to hit.
 * - synthetic controls with a cast lock bundle (the enumerated test exception to
 *   §7.9's cast gate) for the strand-repair and halt-clearing units, which touch
 *   no lock at runtime.
 */
import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../workspace-config.js";
import { MigrationControlError, MigrationPhaseHaltError } from "../errors.js";
import { withStatePlaneLocks, type EntryProof, type HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { openStateStoreForWalTakeover, stateStoreDatabase } from "../store/open.js";
import { runMigration, SQLITE_LIVE_ROWS, type MigrationOutcome } from "./authority.js";
import { ABORT_AFTER_FLIP, abortMigration } from "./halt-recovery.js";
import { beginMigration, EMERGENCY_CANDIDATE_BYTES, provisionRunway, restoreHaltRunway } from "./begin.js";
import { PhaseReceipt } from "./classifier.js";
import { decodeMigrationControl, encodeMigrationControl, type C1Trigger, type MigrationControl } from "./control-codec.js";
import { FIRST_CONTROL_REVISION, readCanonicalControl, renderPreparedControl } from "./control-publication.js";
import { armRetirement } from "./retirement.js";

process.env.RBOX_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-u3-5a-home-"));

const castLocks = {} as unknown as HeldStatePlaneLocks;
const digest = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
const TRIGGER: C1Trigger = {
  disposition: "source-changed",
  replacement: { path: "/w/.rbox/state.json", dev: 9, ino: 99, bytes: 24, sha256: "b".repeat(64), mtimeNs: "42" },
};

async function migratable(prefix: string): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config), lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  return root;
}

const under = <T>(root: string, fn: (entry: EntryProof) => Promise<T>): Promise<T> =>
  withStatePlaneLocks(root, (locks) => fn({ entry: "foreground-migrate", locks })).then((o) => {
    if (!o.held) throw new Error(`bundle refused: ${o.refusal.code}`);
    return o.value;
  });

// ---------------------------------------------------------------------------
// M0 / M1 / the driver loop — organic, under a real bundle.

test("beginMigration publishes the first control at FIRST_CONTROL_REVISION", async () => {
  const root = await migratable("rbox-u3-5a-m0-");
  const outcome = await under(root, (entry) => beginMigration(root, entry));
  expect(outcome.kind).toBe("began");
  const control = readCanonicalControl(root);
  expect(control?.controlRevision).toBe(FIRST_CONTROL_REVISION);
  expect(control?.controlRevision).toBe(1);
  expect(control?.witness.phase).toBe("M0");
  expect(control?.halt).toBeNull();
  expect(control?.haltResources).toEqual({
    reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" },
  });
});

test("runMigration sequences M0→M7 with real publications and migrates the workspace", async () => {
  const root = await migratable("rbox-u3-5a-loop-");
  const steps: string[] = [];
  const outcome = await under(root, (entry) => runMigration(root, entry, (p) => steps.push(`${p.phase}:${p.step}`)));
  expect(steps).toEqual([
    "start:observing", "M0:published", "M1:published", "M2:published", "M3:published",
    "M4:published", "M5:published", "M6:published", "M7:published", "M7:finished",
  ]);
  expect(outcome).toMatchObject({ kind: "migrated" });
  // M7 retires the control: SQLite is the authority and nothing blocks writes.
  expect(readCanonicalControl(root)).toBeUndefined();
  // The second pass IS asserted now. Wave 5B closed 222 §3.2's annotated debt —
  // `inspectInventory` reads through the selecting seam — so a migrated workspace
  // yields a bundle and the driver reports the row it is on rather than throwing
  // `StateFormatTooNewError` at a user whose binary is the newest one there is.
  expect(await under(root, (entry) => runMigration(root, entry))).toEqual({ kind: "already-migrated" });
});

test("a durable halt is CAS'd against the interstitially-advanced control", async () => {
  const { root, control } = await haltedControl("rbox-u3-5a-halt-cas-");
  expect(control.witness.phase).toBe("M3");
  expect(control.halt?.code).toBe("verification");
  expect(control.halt?.underlyingCode).toBe("semantic-digest");
  // Rev > M0+1, which is exactly the stale-receipt regression `publishHalt`'s
  // re-read fixes: the halt lands on the control M1..M3 advanced, not on M0's.
  expect(control.controlRevision).toBeGreaterThan(FIRST_CONTROL_REVISION + 1);
});

test("a second run over the durable halt reports it, without re-clearing", async () => {
  const { root, control: before } = await haltedControl("rbox-u3-5a-rehalt-");
  const outcome = await under(root, (entry) => runMigration(root, entry));
  expect(outcome).toEqual({ kind: "halted", halt: before.halt!, durableHalt: true });
  // The driver never clears a halt; the record is byte-unchanged.
  expect(readCanonicalControl(root)!.controlRevision).toBe(before.controlRevision);
});

test("beginMigration fails closed, in-process, when the workspace has no config stream", async () => {
  const root = await migratable("rbox-u3-5a-nostream-");
  await fsp.rm(path.join(root, ".rbox", "workspace.json"));
  const outcome = await under(root, (entry) => runMigration(root, entry));
  expect(outcome).toMatchObject({ kind: "halted", durableHalt: false });
  // In-process: no control was published, the workspace is untouched.
  expect(readCanonicalControl(root)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// B1 — the emergency candidate's strand repair (provisionRunway).

async function m0Receipt(root: string): Promise<PhaseReceipt> {
  await under(root, (entry) => beginMigration(root, entry));
  return PhaseReceipt.observe(readCanonicalControl(root)!);
}

test("B1: provisionRunway repairs its own torn emergency-candidate write in place", async () => {
  const root = await migratable("rbox-u3-5a-b1-repair-");
  const receipt = await m0Receipt(root);
  const file = migrationPaths.emergency(root, receipt.control.migrationId);
  // A torn own write: a strictly shorter all-zero prefix.
  fs.writeFileSync(file, Buffer.alloc(4096));
  const torn = fs.statSync(file);

  const witness = await under(root, () => provisionRunway(root, receipt, castLocks));
  expect(witness.resources.emergency.disposition).toBe("available");
  const repaired = fs.statSync(file);
  expect(repaired.size).toBe(EMERGENCY_CANDIDATE_BYTES);
  expect(Number(repaired.ino), "repaired in place, not unlink-and-recreate").toBe(Number(torn.ino));
  expect(fs.readFileSync(file).equals(Buffer.alloc(EMERGENCY_CANDIDATE_BYTES))).toBe(true);
});

test("B1: a foreign (nonzero) occupant of the candidate path is refused, not repaired", async () => {
  const root = await migratable("rbox-u3-5a-b1-foreign-");
  const receipt = await m0Receipt(root);
  const file = migrationPaths.emergency(root, receipt.control.migrationId);
  const foreign = Buffer.alloc(4096); foreign[0] = 1;   // not all-zero
  fs.writeFileSync(file, foreign);
  await expect(under(root, () => provisionRunway(root, receipt, castLocks)))
    .rejects.toThrow(/occupied by something other than this migration's candidate/);
  expect(fs.readFileSync(file).equals(foreign), "the foreign file is left untouched").toBe(true);
});

test("restoreHaltRunway re-establishes both resources as available", async () => {
  const root = await migratable("rbox-u3-5a-restore-");
  const receipt = await m0Receipt(root);
  await under(root, () => provisionRunway(root, receipt, castLocks));
  const resources = await under(root, () => restoreHaltRunway(root, receipt.control));
  expect(resources.reserve.disposition).toBe("available");
  expect(resources.emergency.disposition).toBe("available");
});

// ---------------------------------------------------------------------------
// The strand repair conjuncts (renderPreparedControl / isOwnStrand / B2).

function strandRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(sqliteResetPaths.stateRoot(root), { recursive: true });
  return root;
}

/** A minimal valid control at a given id/revision, for rendering into the
 * sibling namespace. Phase M0 so the witness is a bare `{phase}`. */
const controlAt = (migrationId: string, revision: number): MigrationControl => ({
  version: 1, controlRevision: revision, migrationId, authorityId: "a1",
  source: { path: "/w/.rbox/state.json", dev: 1, ino: 2, bytes: 10, sha256: "a".repeat(64), mtimeNs: "1" },
  stagingPath: "/w/.rbox/state/state.db.migrate." + migrationId,
  witness: { phase: "M0" }, halt: null, retirement: null,
  haltResources: { reserve: { disposition: "not-created" }, emergency: { disposition: "not-created" } },
});

test("isOwnStrand: a complete record for a DIFFERENT migration id is refused", () => {
  const root = strandRoot("rbox-u3-5a-strand-id-");
  const next = controlAt("m1", 2);
  const foreign = encodeMigrationControl(controlAt("other", 2));
  fs.writeFileSync(migrationPaths.controlRevision(root, "m1", 2), foreign);
  expect(() => renderPreparedControl(root, 2, next, castLocks)).toThrow(/occupied by something other/);
});

test("isOwnStrand: a complete record at the WRONG revision is refused", () => {
  const root = strandRoot("rbox-u3-5a-strand-rev-");
  const next = controlAt("m1", 2);
  fs.writeFileSync(migrationPaths.controlRevision(root, "m1", 2), encodeMigrationControl(controlAt("m1", 3)));
  expect(() => renderPreparedControl(root, 2, next, castLocks)).toThrow(/occupied by something other/);
});

test("isOwnStrand: a same-id same-revision record is adopted/repaired in place", () => {
  const root = strandRoot("rbox-u3-5a-strand-ok-");
  const next = controlAt("m1", 2);
  const file = migrationPaths.controlRevision(root, "m1", 2);
  // Same id+rev but different bytes (a different source hash): recognizably ours.
  fs.writeFileSync(file, encodeMigrationControl({ ...next, source: { ...next.source, sha256: "c".repeat(64) } }));
  const before = fs.statSync(file);
  const identity = renderPreparedControl(root, 2, next, castLocks);
  expect(Number(fs.statSync(file).ino), "repaired in place").toBe(Number(before.ino));
  expect(identity.sha256).toBe(digest(encodeMigrationControl(next)));
});

test("isOwnStrand: a torn PREFIX long enough to carry our id+revision is repaired", () => {
  const root = strandRoot("rbox-u3-5a-strand-prefix-");
  const next = controlAt("m1", 2);
  const full = encodeMigrationControl(next);
  const file = migrationPaths.controlRevision(root, "m1", 2);
  // The encoded id and revision both sit well inside the first ~120 bytes; take a
  // prefix past them but short of the whole record.
  fs.writeFileSync(file, full.subarray(0, full.byteLength - 8));
  const before = fs.statSync(file);
  const identity = renderPreparedControl(root, 2, next, castLocks);
  expect(Number(fs.statSync(file).ino)).toBe(Number(before.ino));
  expect(identity.sha256).toBe(digest(full));
});

test("isOwnStrand: a prefix too short to carry the id is refused, not repaired", () => {
  const root = strandRoot("rbox-u3-5a-strand-short-");
  const next = controlAt("m1", 2);
  const full = encodeMigrationControl(next);
  const file = migrationPaths.controlRevision(root, "m1", 2);
  fs.writeFileSync(file, full.subarray(0, 5));   // just `{"aut`
  expect(() => renderPreparedControl(root, 2, next, castLocks)).toThrow(/occupied by something other/);
  expect(fs.readFileSync(file).equals(full.subarray(0, 5)), "the short occupant is left untouched").toBe(true);
});

test("B2: a corrupt canonical control fails the render closed, not permissively", () => {
  const root = strandRoot("rbox-u3-5a-b2-");
  fs.writeFileSync(migrationPaths.control(root), "not a control record");
  const next = controlAt("m1", 2);
  const file = migrationPaths.controlRevision(root, "m1", 2);
  // A strand that IS this migration's own (same id+rev, different bytes), so it
  // WOULD be repaired if `ownedRevisionPaths` swallowed the corrupt-canonical
  // throw and returned the permissive empty list. Correct behaviour is to refuse:
  // an unreadable canonical cannot license any rewrite.
  const strand = encodeMigrationControl({ ...next, source: { ...next.source, sha256: "d".repeat(64) } });
  fs.writeFileSync(file, strand);
  expect(() => renderPreparedControl(root, 2, next, castLocks)).toThrow(MigrationControlError);
  expect(fs.readFileSync(file).equals(strand), "the strand is not rewritten under a corrupt canonical").toBe(true);
});

// ---------------------------------------------------------------------------
// B3 — abort clears a halt in the same publication that arms retirement.

/**
 * A REAL durable halt, induced rather than stumbled into. The empty corpus now
 * migrates cleanly, so the halt has to come from somewhere: a row tampered in
 * the instant after M3 publishes is the shape a partial import leaves, and M4's
 * semantic digest is what catches it. `state_lineage` is outside the completion
 * tuple, so the tuple comparison passes and the digest check is the one that
 * refuses — which is what `underlyingCode` is asserted on above.
 */
async function haltedControl(prefix: string): Promise<{ root: string; control: MigrationControl }> {
  const root = await migratable(prefix);
  await under(root, (entry) => runMigration(root, entry, (progress) => {
    if (progress.phase !== "M3" || progress.step !== "published") return;
    const store = openStateStoreForWalTakeover(readCanonicalControl(root)!.stagingPath);
    try {
      stateStoreDatabase(store).query("UPDATE state_lineage SET last_synced_sequence=last_synced_sequence+1").run();
    } finally {
      store.close();
    }
  }));
  const control = readCanonicalControl(root)!;
  if (control.halt === null) throw new Error("the fixture did not produce a durable halt");
  return { root, control };
}

test("B3: armRetirement without clearHalt refuses a halted migration", async () => {
  const { root, control } = await haltedControl("rbox-u3-5a-b3-refuse-");
  expect(control.halt).not.toBeNull();
  const armed = armRetirement(root, PhaseReceipt.observe(control), TRIGGER, castLocks);
  expect(armed.kind).toBe("corrupt");
});

test("B3: armRetirement with clearHalt arms retirement and clears the halt in one revision", async () => {
  const { root, control } = await haltedControl("rbox-u3-5a-b3-clear-");
  const armed = armRetirement(root, PhaseReceipt.observe(control), TRIGGER, castLocks, { clearHalt: true });
  expect(armed.kind).toBe("armed");
  const after = readCanonicalControl(root)!;
  expect(after.halt, "the halt is gone").toBeNull();
  expect(after.retirement, "a retirement is armed").not.toBeNull();
  expect(after.controlRevision, "one durable revision, not two").toBe(control.controlRevision + 1);
});

test("B3/abort: abortMigration drives a halted pre-Q migration to retired", async () => {
  const { root } = await haltedControl("rbox-u3-5a-abort-halted-");
  const outcome = await under(root, (entry) => abortMigration(root, entry));
  expect(outcome).toEqual({ kind: "retired", reason: "source-changed", fromPhase: "M3" });
  // Abort ran C1 to completion: the control is gone, legacy JSON is authoritative.
  expect(readCanonicalControl(root)).toBeUndefined();
});

// ---------------------------------------------------------------------------
// B4 — the post-flip data-loss fence.

test("B4: SQLITE_LIVE_ROWS is exactly its four members", () => {
  expect([...SQLITE_LIVE_ROWS].sort()).toEqual(
    ["m5-artifact-ahead-q", "m6-cleanup", "m7", "terminal-sqlite"].sort(),
  );
});

/**
 * B4's actual net (wave 5B ride-along).
 *
 * The guard at `halt-recovery.ts`'s `SQLITE_LIVE_ROWS` check is what prevents an
 * abort from running the C1 retirement vector over a workspace whose authority
 * has already flipped — the one path in U3 that could destroy live data. It was
 * MUTATION-INVISIBLE: deleting the check left every test in the tree passing,
 * because the only thing exercising it asserted a non-zero exit and the presence
 * of a next step, both of which the fall-through also produces.
 *
 * All four rows, from REAL records. The migration is driven to completion once
 * and the canonical control is snapshotted at each publication; restoring one of
 * those snapshots over the finished workspace is not fabrication — it is exactly
 * the crash image that phase leaves ("M6 published, killed before M7"), which is
 * the population the guard exists for. `terminal-sqlite` is the finished
 * workspace with no control at all.
 */
test("B4: every row past the authority flip refuses the abort, from real records", async () => {
  const root = await migratable("rbox-u3-5b-b4-rows-");
  const snapshots = new Map<string, Buffer>();
  const outcome = await under(root, (entry) => runMigration(root, entry, () => {
    const control = migrationPaths.control(root);
    const record = readCanonicalControl(root);
    if (record) snapshots.set(record.witness.phase, fs.readFileSync(control));
  }));
  expect(outcome.kind, "the fixture must reach SQLite authority for this test to mean anything").toBe("migrated");
  expect(readCanonicalControl(root), "M7 unlinks the control").toBeUndefined();

  // Row 4: the finished workspace, exactly as it stands.
  const terminal = await under(root, (entry) => abortMigration(root, entry));
  expectRefusedPastFlip(terminal);

  // Rows 1-3: restore each phase's own durable record over the flipped artifacts.
  // M6 is `m6-cleanup` and M7 is `m7` verbatim. `m5-artifact-ahead-q` needs the
  // M5 control the LADDER published rather than the one M5 itself did: M5
  // publishes the sibling `absent` and the ladder advances that one field to
  // `exact` through same-phase revisions the driver's progress sink never sees.
  // So it is reconstructed — same phase, same witness, that one field carrying
  // the live marker's real identity, which is what the ladder would have written.
  for (const phase of ["M5", "M6", "M7"] as const) {
    const bytes = snapshots.get(phase);
    expect(bytes, `the run published no ${phase} control`).toBeDefined();
    // A faithful crash image has the database AT REST: M4 checkpoints and closes
    // before M5 is published, and the classifier rightly calls a fenced M5 with
    // live sidecars corruption. The sidecars here are debris from the reads this
    // test just performed, so removing them is what makes the fixture the row it
    // claims to be rather than a different fault.
    for (const suffix of ["-wal", "-shm"]) {
      fs.rmSync(`${sqliteResetPaths.active(root)}${suffix}`, { force: true });
    }
    fs.writeFileSync(migrationPaths.control(root), phase === "M5" ? ladderedM5(root, bytes!) : bytes!);
    const refused = await under(root, (entry) => abortMigration(root, entry));
    expectRefusedPastFlip(refused, phase);
    if (phase === "M5") {
      // The property `fencedUnderMarker` exists to protect, asserted where it
      // bites. `M5 + Q` is the ONE row that reads a live `-wal`/`-shm` as
      // corruption, and the lock bundle's own inventory read would deposit
      // exactly those if it opened the store here — turning this recoverable
      // crash image into a never-retryable `StateAuthorityCorruptError`. The
      // refusal above proves classification reached the row; this proves the
      // acquisition that got there left the database at rest.
      for (const suffix of ["-wal", "-shm"]) {
        expect(
          fs.existsSync(`${sqliteResetPaths.active(root)}${suffix}`),
          `the fenced inventory deposited a ${suffix} sidecar on the one row that cannot tolerate it`,
        ).toBe(false);
      }
    }
  }
  fs.rmSync(migrationPaths.control(root), { force: true });

  // The list this guard reads is the list the test covered.
  expect([...SQLITE_LIVE_ROWS]).toHaveLength(4);
});

/** The M5 revision the `Q`-sibling ladder publishes: identical to M5's own
 * except that the sibling it prebound is now `exact`, carrying the identity of
 * the file the flip renamed over `state.json`. */
function ladderedM5(root: string, bytes: Buffer): Buffer {
  const control = decodeMigrationControl(bytes);
  if (control.witness.phase !== "M5") throw new Error("the M5 snapshot is not an M5 witness");
  const live = fs.statSync(statePath(root));
  return Buffer.from(encodeMigrationControl({
    ...control,
    witness: {
      ...control.witness,
      qSibling: {
        ...control.witness.qSibling,
        disposition: { state: "exact", dev: Number(live.dev), ino: Number(live.ino) },
      },
    },
  }));
}

/** The refusal, asserted on its STABLE token rather than on an exit code that a
 * fall-through would also produce. */
function expectRefusedPastFlip(outcome: MigrationOutcome, label = "terminal"): void {
  expect(outcome.kind, label).toBe("halted");
  if (outcome.kind !== "halted") throw new Error("expected a halt");
  expect(outcome.durableHalt, label).toBe(false);
  expect(outcome.halt.underlyingCode, label).toBe(ABORT_AFTER_FLIP);
}

test("B4: abortMigration on a pristine workspace reports nothing-to-abort, not migrated", async () => {
  const root = await migratable("rbox-u3-5a-abort-pristine-");
  // The invert mutant (`!includes`) would route this non-live row into the
  // past-the-flip refusal; the reused-`already-migrated` bug would mislabel it.
  expect(await under(root, (entry) => abortMigration(root, entry))).toEqual({ kind: "nothing-to-abort" });
});
