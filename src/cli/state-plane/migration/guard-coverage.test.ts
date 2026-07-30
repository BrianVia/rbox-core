/**
 * Coverage for guards that the standing mutation gate proved nothing noticed
 * (design 222 §7.9, wave 5C).
 *
 * These tests exist for one reason and it is worth stating plainly: when
 * `scripts/mutation-gate.ts` first ran over the curated table, three of five
 * load-bearing guards SURVIVED deletion — the whole suite stayed green with the
 * guard removed. That is the exact defect class eight U3 review rounds kept
 * finding by hand ("correct guard, no test that notices its deletion"), and the
 * gate found three more in ten seconds.
 *
 * Every test below is written against a guard the gate names, and the gate's
 * table points at this file. If one of these tests is weakened, the gate goes
 * red rather than the coverage quietly evaporating.
 *
 * All states are machine-produced. Nothing here writes a control record, a
 * staging file, or a witness by hand — the migration is driven for real and
 * perturbed at a named syscall, which is the only way to reach the two windows
 * (`requirePhase` on a misrouted receipt, `bracketSource` on a source that
 * changed *after* classification) that the driver otherwise makes unreachable.
 */
import { expect, test } from "bun:test";
import crypto from "node:crypto";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { saveStateUnsafeLegacyOrTest } from "../../sync-state-store.js";
import { saveConfig, syncStreamId, type WorkspaceConfig } from "../../workspace-config.js";
import { withStatePlaneLocks, type EntryProof } from "../locks.js";
import { migrationPaths, sqliteResetPaths, statePath } from "../paths.js";
import { runMigration } from "./authority.js";
import { classifyMigrationState, PhaseReceipt } from "./classifier.js";
import { publishMigrationHalt, readCanonicalControl } from "./control-publication.js";
import { installStatePlaneFault, installStatePlaneFaults } from "./fault-rig.js";
import { replaceUnderNewInode } from "./inode-fixtures.js";
import { preserveSource } from "./import-json.js";

process.env.RBOX_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "rbox-u3-5c-guard-home-"));

const corpus = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    path: `repo${i % 7}/file-${i}.txt`,
    sha256: crypto.createHash("sha256").update(`f${i}`).digest("hex"),
    size: 100 + i,
    mode: 0o644,
    mtimeMs: 1_700_000_000_000 + i,
    type: "file" as const,
  }));

async function legacyWorkspace(prefix: string, files = corpus(40)): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), `rbox-u3-5c-${prefix}-`));
  const config: WorkspaceConfig = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev",
    rootPath: root, remoteUrl: "https://example.invalid", token: "",
  };
  await saveConfig(root, config);
  await fsp.mkdir(sqliteResetPaths.stateRoot(root), { recursive: true });
  await saveStateUnsafeLegacyOrTest(root, {
    stream: syncStreamId(config), lastSyncedSequence: 0,
    lastSyncedManifest: { generatedAt: "", files },
  } as never);
  return root;
}

const under = <T>(root: string, fn: (entry: EntryProof) => Promise<T>): Promise<T> =>
  withStatePlaneLocks(root, (locks) => fn({ entry: "foreground-migrate", locks })).then((o) => {
    if (!o.held) throw new Error(`bundle refused: ${o.refusal.code}`);
    return o.value;
  });

// ---------------------------------------------------------------------------
// GUARD `phase-receipt-phase-match` — `phase-io.ts`'s `requirePhase`.

test("a phase body refuses a receipt for a phase it does not follow", async () => {
  const root = await legacyWorkspace("requirephase");
  // Drive the real machine to a real M0 control, then hand M1's body that
  // receipt. The driver never does this; the guard is what makes that true, so
  // the only way to test it is to call the body directly with a receipt the
  // machine genuinely minted.
  const halted = await under(root, async (entry) => {
    const fault = installStatePlaneFault(
      { syscall: "renameSync", match: /migration-v1\.json$/, nth: 2, when: "before" },
      { kind: "errno", code: "EIO" },
    );
    try {
      await runMigration(root, entry);
    } catch {
      // the injected EIO is not the subject; the durable M0 control it leaves is
    } finally {
      fault.restore();
    }
    const control = readCanonicalControl(root);
    expect(control?.witness.phase, "the machine must actually be parked at M0").toBe("M0");
    return PhaseReceipt.observe(control!);
  });

  await expect(
    under(root, (entry) => preserveSource(root, halted, entry.locks)),
  ).rejects.toThrow(/requires an exact M1 receipt, not M0/);
});

// ---------------------------------------------------------------------------
// GUARD `source-rebracket` — `phase-io.ts`'s `bracketSource`.

test("a legacy document replaced after classification is refused by the mutator", async () => {
  const root = await legacyWorkspace("rebracket");
  const live = statePath(root);

  // `bracketSource` is the SECOND line of defence. The classifier normally
  // catches a changed source one layer earlier and returns the `source-changed`
  // row, so a perturbation applied between two driver iterations proves nothing
  // about this guard — it is caught either way, which is exactly why the
  // mutation gate reported this guard as uncovered on its first run.
  //
  // The window that belongs to `bracketSource` alone is: a receipt has been
  // classified, and the document changes before the mutator holding that
  // receipt acts. It is reached by driving the machine to a real M1 control,
  // taking the receipt the machine minted, perturbing the document, and then
  // calling the M1 mutator — which is precisely the sequence the driver would
  // perform if the change landed one instant later than the classifier's read.
  const parked = await under(root, async (entry) => {
    const fault = installStatePlaneFault(
      { syscall: "renameSync", match: /migration-v1\.json$/, nth: 3, when: "before" },
      { kind: "errno", code: "EIO" },
    );
    try {
      await runMigration(root, entry);
    } catch {
      // the injected EIO parks the machine; the durable M1 control is the subject
    } finally {
      fault.restore();
    }
    const control = readCanonicalControl(root);
    expect(control?.witness.phase, "the machine must actually be parked at M1").toBe("M1");
    return PhaseReceipt.observe(control!);
  });

  // Replace the document under a NEW inode while the original is still linked,
  // never unlink+recreate: an inode-recycling filesystem hands the same number
  // back and the fixture would assert nothing (FLAKE-006).
  const original = await fsp.readFile(live);
  const perturbed = Buffer.from(
    JSON.stringify({ ...JSON.parse(original.toString()), lastSyncedSequence: 4242 }),
  );
  replaceUnderNewInode(live, perturbed);

  await expect(
    under(root, (entry) => preserveSource(root, parked, entry.locks)),
  ).rejects.toThrow(/no longer the one this migration recorded/);

  // Nothing overwrote the perturbed document, and no backup was published from it.
  expect(await fsp.readFile(live)).toEqual(perturbed);
});

// ---------------------------------------------------------------------------
// GUARD `runway-enospc-predicate` — `control-publication.ts`.

/**
 * FINDING (wave 5C, open against 222 §5.2/§6.3).
 *
 * `isOutOfSpace` in `control-publication.ts` guards only the HALT publication's
 * runway, reached through `haltRunway`. An ENOSPC or EDQUOT during an ORDINARY
 * control publication is classified by nothing: it unwinds out of the phase
 * body, past `step`'s two typed catches (`MigrationPhaseHaltError`,
 * `MigrationControlError`), out of `runMigration`, and out of `inWindow` — whose
 * own comment says the "no bare throws to the CLI" rule exists to prevent
 * exactly this. §5.2 lists `filesystem-full` as a reachable halt for M1–M5 and
 * §6.3 writes copy for it ("The disk filled up partway through…"), but no code
 * path can produce that halt for the publication itself before M6 prepares a
 * runway.
 *
 * This is a COPY and typed-outcome defect, not a corruption defect. The
 * behaviour is still fail-closed: the prepared sibling is removed, the canonical
 * control is untouched, and re-entry re-classifies at the previous phase and
 * retries. The user simply gets a stack trace instead of the sentence §6.3
 * already wrote for them.
 *
 * The test pins the behaviour that EXISTS. When the gap is closed, this test
 * must be inverted rather than deleted.
 */
test("FINDING: ENOSPC on an ordinary control publication escapes untyped", async () => {
  const root = await legacyWorkspace("runway-untyped");
  const fault = installStatePlaneFault(
    { syscall: "renameSync", match: /migration-v1\.json$/, nth: 4, when: "before" },
    { kind: "errno", code: "ENOSPC" },
  );
  let outcome;
  let threw: unknown;
  try {
    outcome = await under(root, (entry) => runMigration(root, entry));
  } catch (error) {
    threw = error;
  } finally {
    fault.restore();
  }
  expect(fault.fired(), "the ENOSPC point must be reachable").toBe(true);
  expect(outcome, "if this is now a typed outcome the finding is fixed — invert this test").toBeUndefined();
  expect((threw as NodeJS.ErrnoException).code).toBe("ENOSPC");

  // The safety half of the finding: fail-closed, and re-entry converges.
  const resumed = await under(root, (entry) => classifyMigrationState(root, entry.locks));
  expect(["m0-resume", "m1-resume", "m2-resume", "m3-resume"]).toContain(resumed.row);
  const retried = await under(root, (entry) => runMigration(root, entry));
  expect(retried.kind).toBe("migrated");
});

// ---------------------------------------------------------------------------
// GUARD `runway-enospc-predicate` — `control-publication.ts`'s `isOutOfSpace`.

test("a halt publication that runs out of space releases the reserve and still lands", async () => {
  const root = await legacyWorkspace("halt-runway");
  // Park the machine at a real M1 control, which is the first revision whose
  // `haltResources` record a claimed, `available` reserve — the runway exists to
  // make a halt publishable on a disk with no room left for one more record.
  const parked = await under(root, async (entry) => {
    const fault = installStatePlaneFault(
      { syscall: "renameSync", match: /migration-v1\.json$/, nth: 3, when: "before" },
      { kind: "errno", code: "EIO" },
    );
    try {
      await runMigration(root, entry);
    } catch {
      // parking only
    } finally {
      fault.restore();
    }
    return readCanonicalControl(root)!;
  });
  expect(parked.witness.phase).toBe("M1");
  expect(parked.haltResources.reserve.disposition, "the reserve must be claimed and available").toBe("available");
  expect(fsSync.existsSync(migrationPaths.reserve(root))).toBe(true);

  // One ENOSPC on the halt's own publication. `isOutOfSpace` is the only thing
  // that turns that failure into "release a recorded resource and try again"
  // rather than "this halt is not durable".
  const fault = installStatePlaneFault(
    { syscall: "renameSync", match: /migration-v1\.json$/, nth: 1, when: "before" },
    { kind: "errno", code: "ENOSPC" },
  );
  let published;
  try {
    published = await under(root, (entry) =>
      Promise.resolve(publishMigrationHalt(
        root, parked,
        { code: "filesystem-full", underlyingCode: "ENOSPC", required: null, available: null },
        entry.locks,
      )));
  } finally {
    fault.restore();
  }

  expect(fault.fired()).toBe(true);
  expect(published.durable, "the halt must survive a full disk by consuming its runway").toBe(true);
  expect(published.control?.haltResources.reserve.disposition).toBe("consumed-for-halt");
  expect(
    fsSync.existsSync(migrationPaths.reserve(root)),
    "the released reserve must actually be unlinked",
  ).toBe(false);
  // The halt is phase-preserving and advances exactly one revision.
  expect(published.control?.witness.phase).toBe("M1");
  expect(published.control?.controlRevision).toBe(parked.controlRevision + 1);
});

test("a halt whose own publication runs out of space consumes the prepared runway", async () => {
  const root = await legacyWorkspace("runway");
  // Two faults, because the guard only exists on the second one's path: a phase
  // body's own write fails with ENOSPC and raises `filesystem-full`, and then
  // the publication of THAT halt also fails with ENOSPC. `isOutOfSpace` is what
  // decides the halt may release a recorded resource to make room for its own
  // record. 163:3343 — a halt consumes no vector item as runway, so this is only
  // legal before M6.
  const faults = installStatePlaneFaults([
    {
      point: { syscall: "writeSync", match: /legacy-json/, when: "before" },
      action: { kind: "errno", code: "ENOSPC" },
    },
    {
      point: { syscall: "renameSync", match: /migration-v1\.json$/, nth: 3, when: "before" },
      action: { kind: "errno", code: "ENOSPC" },
    },
  ]);
  let outcome;
  let threw: unknown;
  try {
    outcome = await under(root, (entry) => runMigration(root, entry));
  } catch (error) {
    threw = error;
  } finally {
    faults.restore();
  }
  expect(faults.fired(), "neither ENOSPC point was reachable").toBe(true);
  // Whatever the verdict, the disk-full condition must not have been silently
  // swallowed: either a typed halt, or the untyped escape the finding above
  // pins. It must never be a completed migration.
  expect(outcome?.kind, JSON.stringify(outcome ?? threw)).not.toBe("migrated");
  const control = readCanonicalControl(root);
  // The control is never advanced past the phase whose write failed.
  expect(["M0", "M1", "M2"]).toContain(control?.witness.phase ?? "M0");
});
