/**
 * The allocation-free future-control runway (design 222 §M-8; design 163
 * § "V5 future-control preparation and halted-retry closure", :3033).
 *
 * The M6 cursor's final item cannot be deleted the ordinary way: publishing the
 * record that says it is gone needs disk, and the reason it is being deleted may
 * be that there is none. So the two records that could follow — a halted M6 at
 * `b+5` and the terminal M7 at `b+6` — are rendered in full BEFORE the deletion,
 * across revisions `b..b+4`. At `b+4` both are exact, and the last deletion is
 * followed by a rename of a file that already exists.
 *
 * Everything here is a pure function of the durable ledger plus two inodes.
 * Nothing chooses a revision, deletes a partial, or creates a second pair: a
 * crash at any point leaves one of the five rows and preparation resumes it.
 *
 * `cleanup.ts` owns the cursor, the identity bracket, and M7; this file imports
 * from it and never the reverse.
 */
import { constants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import type { HeldStatePlaneLocks } from "../locks.js";
import type { PhaseReceipt } from "./classifier.js";
import {
  corruptCleanup, deferredHalt, digestHex, errnoOf, expectOf, finalItem, fsyncDir, isOutOfSpace,
  m6, publishNext, releaseItem, resourceKey, statOrAbsent, type M6Witness,
} from "./cleanup.js";
import {
  encodeMigrationControl, isFinalIntentPromotedHalt,
  type FutureControls, type Inode, type MigrationControl,
} from "./control-codec.js";
import {
  promotePreparedControl, readCanonicalControlExact,
  type PreparedControlIdentity, type PublishExpectation,
} from "./control-publication.js";
import type { MigrationHalt } from "./health.js";

export type PreparationStep =
  | { readonly kind: "advanced" | "ready"; readonly control: MigrationControl }
  | { readonly kind: "halted"; readonly halt: MigrationHalt; readonly durableHalt: false };

export type FinalItemOutcome =
  | { readonly kind: "finished" | "promoted-halt"; readonly control: MigrationControl }
  | { readonly kind: "halted"; readonly halt: MigrationHalt; readonly durableHalt: false };

/** Fault-observation seam for the runway's persistence tests, mirroring
 * `reserve.ts`'s creation hooks. Production passes nothing. */
export type RunwayStep = "claim-halt" | "claim-success" | "write-halt" | "write-success";
export interface RunwayHooks { readonly onStep?: (step: RunwayStep) => void }

type Preparing = Extract<FutureControls, { stage: "preparing" }>;
type SlotRef = { readonly kind: string; readonly path: string };

// ---------------------------------------------------------------------------
// The two prepared records.

/** The prepared halted-M6 record: same phase, same final intent, the generic
 * deferral halt, and the ledger consumed into its promoted-halt form. Its bytes
 * depend only on the two inodes, so every runway revision derives the same
 * record — which is what makes `b+2`'s expected-hash check meaningful. */
function haltedRecord(control: MigrationControl, ledger: Preparing, halt: Inode, success: Inode): MigrationControl {
  const witness = control.witness as M6Witness;
  return {
    ...control,
    controlRevision: ledger.haltRevision,
    halt: deferredHalt(null),
    witness: {
      ...witness,
      futureControls: {
        stage: "promoted-halt",
        origin: { path: ledger.halt.path, revision: ledger.haltRevision, dev: halt.dev, ino: halt.ino },
        preparedSuccess: {
          path: ledger.success.path, revision: ledger.successRevision, dev: success.dev, ino: success.ino,
        },
      },
    },
  };
}

/**
 * The prepared M7 record — identical on both branches, because it is a pure
 * function of the halted-M6 record's canonical bytes plus the M7 inode that
 * record already names. That is what lets the promoted-halt retry recompute the
 * exact bytes the ledger deliberately never stored (163:3092).
 */
function successRecord(halted: MigrationControl, haltedBytes: Buffer): MigrationControl {
  const witness = halted.witness as M6Witness;
  const ledger = witness.futureControls;
  if (ledger?.stage !== "promoted-halt") return corruptCleanup("the halted-M6 record carries no promoted-halt ledger");
  const { items } = witness.cleanup;
  const haltResources = { ...halted.haltResources };
  for (const item of items) haltResources[resourceKey(item.role)] = { disposition: "retired" };
  return {
    ...halted,
    controlRevision: ledger.preparedSuccess.revision,
    halt: null,
    haltResources,
    witness: {
      ...witness,
      phase: "M7",
      cleanup: { items, durablePrefix: items.length, currentIntent: null },
      futureControls: null,
      terminalSibling: {
        path: ledger.origin.path, dev: ledger.origin.dev, ino: ledger.origin.ino,
        bytes: haltedBytes.byteLength, sha256: digestHex(haltedBytes),
        disposition: "exact-or-absent-terminal",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Slot I/O. Never a second inode, never a replacement pair.

/** The sole artifact-ahead allowance in an `absent` descriptor: the prebound
 * path may already hold one no-follow regular 0600 zero-byte inode, which is
 * adopted rather than replaced (163:3068). */
function claimSlot(slot: SlotRef): Inode {
  let fd: number;
  let created = true;
  try {
    fd = fs.openSync(slot.path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    fd = fs.openSync(slot.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    created = false;
  }
  try {
    const found = fs.fstatSync(fd);
    if (!created && (!found.isFile() || Number(found.size) !== 0 || (Number(found.mode) & 0o7777) !== 0o600)) {
      corruptCleanup(`${slot.path} is neither absent nor the sole zero-byte create-ahead`);
    }
    fs.fsyncSync(fd);
    fsyncDir(path.dirname(slot.path));
    return { dev: Number(found.dev), ino: Number(found.ino) };
  } finally {
    fs.closeSync(fd);
  }
}

/** The recorded inode, still here, still regular, still no longer than the
 * image it is allowed to hold. A `building` slot may carry any power-loss byte
 * image of length `0..expected.bytes`; nothing ever interprets a partial one. */
function bracketSlot(slot: SlotRef, recorded: Inode, maxBytes: number): void {
  const observed = statOrAbsent(slot.path);
  if (!observed || !observed.isFile()
    || Number(observed.dev) !== recorded.dev || Number(observed.ino) !== recorded.ino) {
    corruptCleanup(`${slot.path} is not the ${slot.kind} inode this ledger recorded`);
  } else if (Number(observed.size) > maxBytes) {
    corruptCleanup(`${slot.path} holds ${observed.size} bytes, past its expected ${maxBytes}`);
  }
}

/** Rewrite the recorded inode from offset zero and truncate. No new inode, no
 * temp, no rename: a descriptor may never be reset to `absent`. */
function writeSlot(slot: SlotRef, recorded: Inode, bytes: Buffer, revision: number): PreparedControlIdentity {
  const fd = fs.openSync(slot.path, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (Number(stat.dev) !== recorded.dev || Number(stat.ino) !== recorded.ino) {
      corruptCleanup(`${slot.path} changed identity before its ${slot.kind} bytes were written`);
    }
    // A short write means the device would not take the rest, which is ENOSPC by
    // any other name. Classifying it as one matters: the result is a bounded
    // partial image of the recorded inode, which is precisely the `building`
    // state this row is allowed to be in, so the runway must leave the ledger
    // where it is and resume — not call it corruption and wedge.
    const written = fs.writeSync(fd, bytes, 0, bytes.byteLength, 0);
    if (written !== bytes.byteLength) {
      throw Object.assign(
        new Error(`${slot.path} took only ${written} of ${bytes.byteLength} bytes`), { code: "ENOSPC" },
      );
    }
    fs.ftruncateSync(fd, bytes.byteLength);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDir(path.dirname(slot.path));
  return readSlotExact(slot, recorded, bytes, revision);
}

/** Identity-stable reread: the recorded inode holding exactly these bytes. */
function readSlotExact(slot: SlotRef, recorded: Inode, bytes: Buffer, revision: number): PreparedControlIdentity {
  const fd = fs.openSync(slot.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    const read = Buffer.alloc(bytes.byteLength);
    if (Number(stat.dev) !== recorded.dev || Number(stat.ino) !== recorded.ino
      || Number(stat.size) !== bytes.byteLength
      || fs.readSync(fd, read, 0, read.byteLength, 0) !== read.byteLength || !read.equals(bytes)) {
      corruptCleanup(`${slot.path} is not the exact ${slot.kind} record this ledger prepared`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return {
    path: slot.path, revision, dev: recorded.dev, ino: recorded.ino,
    bytes: bytes.byteLength, sha256: digestHex(bytes),
  };
}

// ---------------------------------------------------------------------------
// b..b+4.

/**
 * One durable preparation row (163's five-row table at :3103). Preparation
 * always resumes the same stage and the same inode; it never deletes a partial,
 * chooses a new revision, or creates a second pair.
 *
 * A caught allocation failure here publishes NO alternate control — 163's named
 * scoped exception to f6, because publishing a durable halt would need exactly
 * the allocation this runway exists to avoid. The operator sees
 * `durableHalt: false` and the durable row stays resumable.
 */
export async function stepFutureControlPreparation(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks, hooks: RunwayHooks = {},
): Promise<PreparationStep> {
  const { control, witness } = m6(receipt);
  const ledger = witness.futureControls;
  if (ledger?.stage !== "preparing") return corruptCleanup("the M6 control carries no preparation ledger");
  if (witness.cleanup.currentIntent?.index !== witness.cleanup.items.length) {
    return corruptCleanup("the preparation runway runs only under a durable final-item intent");
  }
  try {
    return advanceRunway(root, control, witness, ledger, locks, hooks);
  } catch (error) {
    if (!isOutOfSpace(error)) throw error;
    return { kind: "halted", halt: deferredHalt(errnoOf(error)), durableHalt: false };
  }
}

function advanceRunway(
  root: string, control: MigrationControl, witness: M6Witness, ledger: Preparing,
  locks: HeldStatePlaneLocks, hooks: RunwayHooks,
): PreparationStep {
  const halt = ledger.halt.disposition;
  const success = ledger.success.disposition;
  const advance = (next: Preparing): PreparationStep =>
    ({ kind: "advanced", control: publishNext(root, control, witness, { futureControls: next }, locks) });
  const withHalt = (disposition: Preparing["halt"]["disposition"]): Preparing["halt"] =>
    ({ ...ledger.halt, disposition });
  const withSuccess = (disposition: Preparing["success"]["disposition"]): Preparing["success"] =>
    ({ ...ledger.success, disposition });

  if (halt.state === "absent" && success.state === "absent") {
    hooks.onStep?.("claim-halt");
    const inode = claimSlot(ledger.halt);
    return advance({ ...ledger, halt: withHalt({ state: "building", ...inode, expected: null }) });
  }
  if (halt.state === "building" && halt.expected === null && success.state === "absent") {
    bracketSlot(ledger.halt, halt, 0);
    hooks.onStep?.("claim-success");
    const inode = claimSlot(ledger.success);
    const bytes = encodeMigrationControl(haltedRecord(control, ledger, halt, inode));
    return advance({
      ...ledger,
      halt: withHalt({ ...halt, expected: { bytes: bytes.byteLength, sha256: digestHex(bytes) } }),
      success: withSuccess({ state: "building", ...inode, expected: null }),
    });
  }
  if (halt.state === "building" && halt.expected !== null && success.state === "building" && success.expected === null) {
    bracketSlot(ledger.success, success, 0);
    bracketSlot(ledger.halt, halt, halt.expected.bytes);
    const halted = haltedRecord(control, ledger, halt, success);
    const bytes = encodeMigrationControl(halted);
    if (bytes.byteLength !== halt.expected.bytes || digestHex(bytes) !== halt.expected.sha256) {
      return corruptCleanup("the halted-M6 record is not the one this ledger expected");
    }
    hooks.onStep?.("write-halt");
    writeSlot(ledger.halt, halt, bytes, ledger.haltRevision);
    const successBytes = encodeMigrationControl(successRecord(halted, bytes));
    return advance({
      ...ledger,
      halt: withHalt({ state: "exact", dev: halt.dev, ino: halt.ino, bytes: bytes.byteLength, sha256: digestHex(bytes) }),
      success: withSuccess({
        ...success, expected: { bytes: successBytes.byteLength, sha256: digestHex(successBytes) },
      }),
    });
  }
  if (halt.state === "exact" && success.state === "building" && success.expected !== null) {
    const halted = haltedRecord(control, ledger, halt, success);
    const haltBytes = encodeMigrationControl(halted);
    readSlotExact(ledger.halt, halt, haltBytes, ledger.haltRevision);
    bracketSlot(ledger.success, success, success.expected.bytes);
    const bytes = encodeMigrationControl(successRecord(halted, haltBytes));
    if (bytes.byteLength !== success.expected.bytes || digestHex(bytes) !== success.expected.sha256) {
      return corruptCleanup("the M7 record is not the one this ledger expected");
    }
    hooks.onStep?.("write-success");
    writeSlot(ledger.success, success, bytes, ledger.successRevision);
    return advance({
      ...ledger,
      success: withSuccess({
        state: "exact", dev: success.dev, ino: success.ino, bytes: bytes.byteLength, sha256: digestHex(bytes),
      }),
    });
  }
  if (halt.state === "exact" && success.state === "exact") return { kind: "ready", control };
  return corruptCleanup("the future-control ledger is in no admitted preparation row");
}

/** Both prepared siblings, re-derived and re-proven byte-for-byte. Deriving
 * rather than trusting the recorded lengths is what makes a swapped sibling
 * unusable even if it somehow kept the recorded inode. */
function readyPair(
  control: MigrationControl, ledger: Preparing,
): { halt: PreparedControlIdentity; success: PreparedControlIdentity } {
  const halt = ledger.halt.disposition;
  const success = ledger.success.disposition;
  if (halt.state !== "exact" || success.state !== "exact") return corruptCleanup("the final-item runway is not ready");
  const halted = haltedRecord(control, ledger, halt, success);
  const haltBytes = encodeMigrationControl(halted);
  const successBytes = encodeMigrationControl(successRecord(halted, haltBytes));
  return {
    halt: readSlotExact(ledger.halt, halt, haltBytes, ledger.haltRevision),
    success: readSlotExact(ledger.success, success, successBytes, ledger.successRevision),
  };
}

/**
 * The one deletion the whole runway was built for, at `r = b+4`.
 *
 * A caught allocation failure in the unlink or its parent fsync — and only
 * there — may promote the already-durable halted sibling instead. Once the M7
 * promotion is entered no lower revision is published: its failure is an
 * in-process `durability-indeterminate` block, and restart observes either the
 * old M6 or the new M7.
 */
export async function completeFinalItem(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<FinalItemOutcome> {
  const { control, witness } = m6(receipt);
  const ledger = witness.futureControls;
  if (ledger?.stage !== "preparing" || control.controlRevision !== ledger.readyRevision) {
    return corruptCleanup("the final item may be completed only at the runway-ready revision");
  }
  const pair = readyPair(control, ledger);
  const item = finalItem(witness);
  try {
    releaseItem(item);
  } catch (error) {
    if (!isOutOfSpace(error)) throw error;
    try {
      return { kind: "promoted-halt", control: promotePreparedControl(root, expectOf(control), pair.halt, locks) };
    } catch {
      return { kind: "halted", halt: deferredHalt(errnoOf(error)), durableHalt: false };
    }
  }
  return promoteSuccess(root, expectOf(control), pair.success, locks);
}

function promoteSuccess(
  root: string, expect: PublishExpectation, success: PreparedControlIdentity, locks: HeldStatePlaneLocks,
): FinalItemOutcome {
  try {
    return { kind: "finished", control: promotePreparedControl(root, expect, success, locks) };
  } catch (error) {
    return {
      kind: "halted", durableHalt: false,
      halt: { code: "durability-indeterminate", underlyingCode: errnoOf(error), required: null, available: null },
    };
  }
}

/**
 * Doctor's single-use delegation for the one halted row whose clear is a rename
 * (163:3141). There is no separate durable clear: the expected-`r+1` rename of
 * the exact M7 sibling IS the halt clear and the phase advance.
 *
 * The admission test is that this canonical control IS the halt sibling that was
 * renamed here — its inode must equal the recorded origin, and the origin path
 * must now be absent. A path match alone is never enough.
 */
export async function retryPromotedHalt(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<FinalItemOutcome> {
  const { control, witness } = m6(receipt);
  const ledger = witness.futureControls;
  if (!isFinalIntentPromotedHalt(control) || ledger?.stage !== "promoted-halt") {
    return corruptCleanup("only an exact final-intent promoted halt may be retried");
  }
  const canonical = readCanonicalControlExact(root);
  if (!canonical || canonical.control.migrationId !== control.migrationId
    || canonical.control.controlRevision !== control.controlRevision
    || canonical.dev !== ledger.origin.dev || canonical.ino !== ledger.origin.ino) {
    return corruptCleanup("the canonical control is not the halt sibling this ledger promoted");
  }
  if (statOrAbsent(ledger.origin.path)) {
    return corruptCleanup(`${ledger.origin.path} must be absent once its record is canonical`);
  }
  const bytes = encodeMigrationControl(successRecord(control, encodeMigrationControl(control)));
  const success = readSlotExact(
    { kind: "m7", path: ledger.preparedSuccess.path }, ledger.preparedSuccess, bytes,
    ledger.preparedSuccess.revision,
  );
  try {
    releaseItem(finalItem(witness));
  } catch (error) {
    if (!isOutOfSpace(error)) throw error;
    return { kind: "halted", halt: deferredHalt(errnoOf(error)), durableHalt: false };
  }
  return promoteSuccess(root, expectOf(control), success, locks);
}
