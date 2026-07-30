/**
 * Every durable transition of the canonical migration control (design 163
 * § "Durable phase publication and sole actor", :2692).
 *
 * This module is the ONLY writer of `.rbox/state/migration-v1.json`. Ordinary
 * publication and prepared-sibling promotion share one private replacement
 * primitive, so neither can grow its own rename: revalidate the target under
 * `expect`, no-follow revalidate the source inode/length/hash/canonical bytes,
 * rename, fsync `.rbox/state`, reread exactly.
 *
 * Synchronous throughout. It runs once per phase under the complete lock set,
 * and the state-plane write fence that consumes `readCanonicalControl` is itself
 * synchronous, so an async surface would buy interleaving nobody wants.
 *
 * `locks` is a compile-time witness that the complete lock set is held; it has
 * no runtime use and must not grow one.
 */
import { constants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import {
  decodeMigrationControl, type Inode, type MigrationControl,
} from "./control-codec.js";
import {
  controlFail as fail, digestBytes as digest, fsyncDirectorySync, readExactFile,
  removeOwnSibling, renderControlSibling, type PreparedControlIdentity,
} from "./control-sibling.js";
import type { MigrationHalt } from "./health.js";

/** The sibling namespace's own type lives with the module that renders it
 * (163's 400-line law). Re-exported because every existing consumer names this
 * module as the control's publication surface, and moving a file should not move
 * an import. */
export type { PreparedControlIdentity } from "./control-sibling.js";

/** The revision of a migration's first published control. */
export const FIRST_CONTROL_REVISION = 1;

/** What the canonical control must be right now for a publication to proceed.
 * Both members are `"absent"` together, or neither is. */
export interface PublishExpectation {
  readonly migrationId: string | "absent";
  readonly revision: number | "absent";
}

/** Discriminated so the nondurable branch carries NO next control: a caller
 * cannot keep publishing after a failed halt (163:3346). */
export type HaltPublication =
  | { readonly durable: true; readonly control: MigrationControl }
  | { readonly durable: false; readonly reason: unknown };

export type HaltResourceRole = "reserve" | "emergency";

/**
 * Which revision-scoped sibling paths a LIVE canonical record still owns as
 * artifacts, and which the sibling renderer's strand repair must therefore refuse
 * rather than rewrite (`control-sibling.ts`, wave 1A's wedge).
 *
 * Only the canonical record can answer this, which is why it is computed here and
 * passed down. Wave 3C's negative control is the reason it exists: the M6 runway
 * legitimately owns prepared siblings at `b+5`/`b+6` while the control sits at
 * `b+4`, and overwriting one leaves the final item unremovable. M7's terminal
 * sibling is the same case one phase later.
 */
function ownedRevisionPaths(root: string): readonly string[] {
  let canonical: MigrationControl | undefined;
  try {
    canonical = readCanonicalControl(root);
  } catch {
    // An unreadable canonical control cannot license a rewrite. Fail closed by
    // claiming every path in the namespace is owned.
    return [migrationPaths.control(root)];
  }
  const witness = canonical?.witness;
  if (!witness) return [];
  if (witness.phase === "M7") return [witness.terminalSibling.path];
  if (witness.phase !== "M6" || !witness.futureControls) return [];
  const ledger = witness.futureControls;
  return ledger.stage === "preparing"
    ? [ledger.halt.path, ledger.success.path]
    : [ledger.origin.path, ledger.preparedSuccess.path];
}

/**
 * Render this migration's revision-scoped sibling, telling the renderer which
 * paths a live record still owns. Kept as this module's exported name so no
 * consumer moves an import, and so the ownership question is never answered by a
 * module that cannot read the canonical record.
 */
export function renderPreparedControl(
  root: string, revision: number, next: MigrationControl, locks: HeldStatePlaneLocks,
): PreparedControlIdentity {
  return renderControlSibling(root, revision, next, locks, ownedRevisionPaths(root));
}

/** The canonical control plus the inode it currently occupies. The M6 runway's
 * promoted-halt retry needs the identity, because its whole admission test is
 * that this file IS the halt sibling that was renamed here (163:3089). */
export interface CanonicalControl extends Inode {
  readonly control: MigrationControl;
}

export function readCanonicalControlExact(root: string): CanonicalControl | undefined {
  const exact = readExactFile(migrationPaths.control(root));
  return exact && { control: decodeMigrationControl(exact.bytes), dev: exact.dev, ino: exact.ino };
}

export function readCanonicalControl(root: string): MigrationControl | undefined {
  return readCanonicalControlExact(root)?.control;
}

function assertExpectation(current: MigrationControl | undefined, expect: PublishExpectation): void {
  const absent = expect.migrationId === "absent";
  if (absent !== (expect.revision === "absent")) fail("cas", "expectation mixes an absent control with an exact revision");
  if (absent) {
    if (current) fail("cas", `expected no control, found ${current.migrationId} revision ${current.controlRevision}`);
    return;
  }
  if (!current) fail("cas", `expected ${String(expect.migrationId)} revision ${String(expect.revision)}, found no control`);
  else if (current.migrationId !== expect.migrationId || current.controlRevision !== expect.revision) {
    fail("cas", `expected ${String(expect.migrationId)} revision ${String(expect.revision)}, found ${current.migrationId} revision ${current.controlRevision}`);
  }
}

/** Revisions are exactly spaced. `r -> r+2` is the single permitted gap and is
 * the direct-M7 success transition alone (163:2919) — a halt promotion is
 * `r -> r+1` and doctor's retry promotion is `r+1 -> r+2`, both ordinary steps. */
function assertRevisionStep(expect: PublishExpectation, next: number, allowGapTwo: boolean): void {
  if (expect.revision === "absent") {
    if (next !== FIRST_CONTROL_REVISION) fail("cas", `a first control must be revision ${FIRST_CONTROL_REVISION}, not ${next}`);
    return;
  }
  const step = next - expect.revision;
  if (step === 1 || (allowGapTwo && step === 2)) return;
  fail("cas", `revision ${expect.revision} may not advance to ${next}`);
}

/**
 * The one canonical replacement. Every durable control write lands here, and no
 * entry point implements its own rename.
 */
function replaceCanonicalControl(
  root: string, expect: PublishExpectation, source: PreparedControlIdentity,
  promotion: boolean, locks: HeldStatePlaneLocks,
): MigrationControl {
  void locks;
  assertExpectation(readCanonicalControl(root), expect);
  const exact = readExactFile(source.path);
  if (!exact || exact.dev !== source.dev || exact.ino !== source.ino
    || exact.bytes.byteLength !== source.bytes || digest(exact.bytes) !== source.sha256) {
    fail("prepared-foreign", `${source.path} is not the recorded inode, length, and hash`);
  }
  const bytes = exact.bytes;
  const next = decodeMigrationControl(bytes);
  if (next.controlRevision !== source.revision) {
    fail("prepared-foreign", `${source.path} carries revision ${next.controlRevision}, not ${source.revision}`);
  }
  assertRevisionStep(expect, next.controlRevision, promotion && next.witness.phase === "M7");
  const file = migrationPaths.control(root);
  fs.renameSync(source.path, file);
  fsyncDirectorySync(path.dirname(file));
  const published = readExactFile(file);
  if (!published || !published.bytes.equals(bytes)) fail("reread", `${file} is not the record just published`);
  return next;
}

export function publishMigrationControl(
  root: string, expect: PublishExpectation, next: MigrationControl, locks: HeldStatePlaneLocks,
): MigrationControl {
  const prepared = renderPreparedControl(root, next.controlRevision, next, locks);
  try {
    return replaceCanonicalControl(root, expect, prepared, false, locks);
  } catch (error) {
    removeOwnSibling(prepared);
    throw error;
  }
}

/**
 * Promote an ALREADY-EXACT prepared sibling. No temp, no write, no truncate:
 * the shared primitive's pre-rename revalidation of the recorded inode, byte
 * length, SHA-256, and canonical bytes for this fixed revision is the whole
 * admission test, and anything else is foreign and is not renamed. Only the
 * direct-M7 success transition may take the `r -> r+2` gap.
 */
export function promotePreparedControl(
  root: string, expect: PublishExpectation, prepared: PreparedControlIdentity, locks: HeldStatePlaneLocks,
): MigrationControl {
  return replaceCanonicalControl(root, expect, prepared, true, locks);
}

/**
 * The terminal transition: the migration's coordination record ceases to exist.
 * Reached at a complete retirement prefix (163:2818) and at M7's finish
 * (163:3125), and it lives here because this module is the control's sole
 * writer — a deletion is a durable transition like any other.
 *
 * The CAS is the identity bracket. A control is a whole canonical record rather
 * than an inode, so matching the exact migration id and revision under the held
 * lock set proves more than a `dev`/`ino` pair would.
 */
export function retireCanonicalControl(
  root: string, expect: PublishExpectation, locks: HeldStatePlaneLocks,
): void {
  void locks;
  assertExpectation(readCanonicalControl(root), expect);
  const file = migrationPaths.control(root);
  fs.unlinkSync(file);
  fsyncDirectorySync(path.dirname(file));
}

/** ENOSPC and EDQUOT are the two conditions the prebuilt runway exists for. */
const isOutOfSpace = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
};

/**
 * What this halt may release to make its own publication possible, in order.
 * Only a resource recorded `available` qualifies, and none does while a
 * retirement or M6 cleanup cursor is running — those resources are vector items,
 * and a halt consumes no vector item as runway (163:3343).
 */
export function haltRunway(control: MigrationControl): readonly HaltResourceRole[] {
  const cursorActive = control.retirement !== null
    || control.witness.phase === "M6" || control.witness.phase === "M7";
  if (cursorActive) return [];
  return (["reserve", "emergency"] as const).filter((role) => control.haltResources[role].disposition === "available");
}

/**
 * Release one recorded halt resource so a halt publication has somewhere to
 * land. `available` is the only disposition that names a file, and it names it
 * by inode, length, AND content digest — all three are checked, through one
 * descriptor, so this can never unlink a path that stopped being the resource
 * it recorded. The digest is not decoration: an in-place rewrite keeps the
 * inode and the length, and inode plus length alone would release it.
 *
 * `sha256` here is the WHOLE file, the shape every other `{bytes, sha256}`
 * witness in the codec carries. It is deliberately not the same evidence as
 * `cleanup.ts`'s role-7 removal, which compares the 128 reserve header bytes
 * because 163 states that rule for the cleanup vector specifically. Both are
 * strict; they differ because the two records store different things about the
 * same file, and 222 §M-8 warns 4A not to conflate them.
 *
 * Exported for its refusal path alone. `publishMigrationHalt` is the only
 * production caller, and it reaches this function only after an allocation
 * failure — a state a unit test cannot manufacture — so wave 1A's review left
 * the refusal untested. It is tested directly instead.
 */
export function releaseHaltResource(root: string, control: MigrationControl, role: HaltResourceRole): void {
  const recorded = control.haltResources[role];
  if (recorded.disposition !== "available") fail("cas", `${role} is ${recorded.disposition}, not available`);
  const file = role === "reserve" ? migrationPaths.reserve(root) : migrationPaths.emergency(root, control.migrationId);
  const fd = fs.openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const observed = fs.fstatSync(fd);
    const content = Buffer.alloc(observed.isFile() ? Number(observed.size) : 0);
    if (!observed.isFile() || Number(observed.dev) !== recorded.dev
      || Number(observed.ino) !== recorded.ino || Number(observed.size) !== recorded.bytes
      || fs.readSync(fd, content, 0, content.byteLength, 0) !== content.byteLength
      || digest(content) !== recorded.sha256) {
      fail("prepared-foreign", `${file} is not the recorded ${role}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  fs.unlinkSync(file);
  fsyncDirectorySync(path.dirname(file));
}

/**
 * Publish the same phase at the next revision with the exact halt and the
 * updated resource dispositions. If publication needs space it releases the
 * exact previously-`available` resources in order and records each
 * `consumed-for-halt`; it never relabels a current intent, because an intent is
 * never `available`.
 */
export function publishMigrationHalt(
  root: string, control: MigrationControl, halt: MigrationHalt, locks: HeldStatePlaneLocks,
): HaltPublication {
  const expect: PublishExpectation = { migrationId: control.migrationId, revision: control.controlRevision };
  const runway = haltRunway(control);
  let haltResources = control.haltResources;
  for (let attempt = 0; ; attempt++) {
    const next: MigrationControl = { ...control, controlRevision: control.controlRevision + 1, halt, haltResources };
    try {
      return { durable: true, control: publishMigrationControl(root, expect, next, locks) };
    } catch (error) {
      const role = runway[attempt];
      if (role === undefined || !isOutOfSpace(error)) return { durable: false, reason: error };
      try {
        releaseHaltResource(root, control, role);
      } catch {
        return { durable: false, reason: error };
      }
      haltResources = { ...haltResources, [role]: { disposition: "consumed-for-halt" } };
    }
  }
}
