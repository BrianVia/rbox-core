/**
 * The M6 cleanup cursor and M7 terminalization (design 222 §M-8; design 163
 * § "Correlated M6 cleanup to M7", :2856).
 *
 * M-8 is one correlated machine but two files, because one file is 636 lines
 * and 163:3994's 400-line ceiling is not negotiable. This half owns the cursor,
 * the identity-bracketed removal of a vector item, and M7; `cleanup-runway.ts`
 * owns the allocation-free preparation runway that the final item needs. The
 * dependency runs one way — the runway imports from here — so the split cannot
 * become a cycle.
 *
 * Two laws are load-bearing across both halves and are stated once, here:
 *
 * - **Only identity-bracketed targets are unlinked.** Every removal names a
 *   path the durable record itself recorded and re-proves the recorded inode
 *   immediately before removing it. For the generic reserve the bracket also
 *   re-reads all 128 header bytes (163's role-7 deletion rule).
 * - **Inertness is a file-level judgement.** A stranded publisher temp is inert
 *   by construction, and M7 asserts that over a closed named interval with
 *   `lstat`. Opening one to decide it is inert would deposit state on a file we
 *   are declining to touch — the ownership rule 163 v13 makes normative.
 *
 * The runway legitimately owns prepared siblings at `b+5`/`b+6` while the
 * canonical control still sits at `b+4`. That is why no code anywhere may "fix"
 * a stranded temp by overwriting it: two of them are live ledger-owned
 * artifacts. Slots are only ever rewritten in place, on their recorded inode.
 */
import crypto from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs";
import path from "node:path";
import { MigrationControlError } from "../errors.js";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths } from "../paths.js";
import type { PhaseReceipt } from "./classifier.js";
import type {
  ArtifactItem, FutureControls, MigrationControl, MigrationWitness, TerminalSibling,
} from "./control-codec.js";
import {
  FIRST_CONTROL_REVISION, publishMigrationControl, publishMigrationHalt,
  readCanonicalControlExact, retireCanonicalControl, type PublishExpectation,
} from "./control-publication.js";
import type { MigrationHalt } from "./health.js";
import { RESERVE_HEADER_BYTES } from "./reserve.js";

export type CleanupStep =
  | { readonly kind: "intent" | "retired" | "final-intent"; readonly control: MigrationControl }
  | { readonly kind: "halted"; readonly halt: MigrationHalt; readonly durableHalt: boolean };

export type M6Witness = Extract<MigrationWitness, { phase: "M6" }>;

// ---------------------------------------------------------------------------
// The primitives both halves of M-8 share. Exported for `cleanup-runway.ts`
// only; nothing outside M-8 consumes them.

export const digestHex = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex");
export const corruptCleanup = (detail: string): never => { throw new MigrationControlError("foreign", detail); };
export const errnoOf = (error: unknown): string => String((error as NodeJS.ErrnoException | undefined)?.code ?? error);
/** The two conditions the runway and the deferral halt exist for. Anything else
 * is a real fault and is rethrown rather than dressed up as a space problem. */
export const isOutOfSpace = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT";
};
export const deferredHalt = (underlyingCode: string | null): MigrationHalt =>
  ({ code: "cleanup-deferred", underlyingCode, required: null, available: null });
export const expectOf = (control: MigrationControl): PublishExpectation =>
  ({ migrationId: control.migrationId, revision: control.controlRevision });

export function fsyncDir(dir: string): void {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** `lstat`, with genuine absence separated from every other failure. */
export function statOrAbsent(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function m6(receipt: PhaseReceipt): { control: MigrationControl; witness: M6Witness } {
  const { control } = receipt;
  if (control.witness.phase !== "M6") return corruptCleanup(`cleanup requires an M6 receipt, not ${control.witness.phase}`);
  return { control, witness: control.witness };
}

/** Only the reserve and the emergency candidate can be M6 cleanup items; roles
 * 1-4 are asserted absences and roles 5-6 are never vector members (163:2866). */
export function resourceKey(role: ArtifactItem["role"]): "reserve" | "emergency" {
  if (role === "reserve" || role === "emergency") return role;
  return corruptCleanup(`role ${role} cannot be an M6 cleanup item`);
}

export function publishNext(
  root: string, control: MigrationControl, witness: M6Witness,
  edit: {
    cleanup?: M6Witness["cleanup"]; futureControls?: FutureControls;
    resources?: MigrationControl["haltResources"];
  },
  locks: HeldStatePlaneLocks,
): MigrationControl {
  const next: MigrationControl = {
    ...control,
    controlRevision: control.controlRevision + 1,
    haltResources: edit.resources ?? control.haltResources,
    witness: {
      ...witness,
      cleanup: edit.cleanup ?? witness.cleanup,
      futureControls: edit.futureControls === undefined ? witness.futureControls : edit.futureControls,
    },
  };
  return publishMigrationControl(root, expectOf(control), next, locks);
}

// ---------------------------------------------------------------------------
// Removing a vector item.

/** Present under its recorded identity, or genuinely absent. Anything else at
 * the path is foreign and nothing is removed. */
function observeItem(item: ArtifactItem): "absent" | "present" {
  const observed = statOrAbsent(item.path);
  if (!observed) return "absent";
  if (!observed.isFile() || Number(observed.dev) !== item.dev || Number(observed.ino) !== item.ino) {
    corruptCleanup(`${item.path} is not the ${item.role} this cleanup vector recorded`);
  }
  if (item.role === "reserve") assertReserveHeader(item);
  return "present";
}

/** 163's role-7 rule: byte-for-byte equality of all 128 header bytes with the
 * header the vector recorded, proven through the same descriptor that proves
 * the inode so no swap can slip between the two. */
function assertReserveHeader(item: ArtifactItem): void {
  if (item.sha256 === null) corruptCleanup(`${item.path} was recorded without its reserve header digest`);
  const fd = fs.openSync(item.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    const header = Buffer.alloc(RESERVE_HEADER_BYTES);
    if (Number(stat.dev) !== item.dev || Number(stat.ino) !== item.ino
      || fs.readSync(fd, header, 0, RESERVE_HEADER_BYTES, 0) !== RESERVE_HEADER_BYTES
      || digestHex(header) !== item.sha256) {
      corruptCleanup(`${item.path} does not carry the 128 reserve header bytes this migration recorded`);
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Unlink the item if it is there, and fsync the parent the record named. An
 * already-absent item is never recreated. */
export function releaseItem(item: ArtifactItem): void {
  if (observeItem(item) === "present") fs.unlinkSync(item.path);
  fsyncDir(item.parent);
}

/**
 * The guard is unreachable defense-in-depth, and deliberately kept: both
 * callers already prove the intent — `retryPromotedHalt` through
 * `isFinalIntentPromotedHalt`, and `completeFinalItem` because the prepared
 * records are pure functions of the whole control, so a moved cursor makes the
 * derived bytes disagree with the ledger's exact descriptors before this runs.
 * It stays because it is what makes the last-item index read safe locally, in
 * code whose next act is an unlink.
 */
export const finalItem = (witness: M6Witness): ArtifactItem => {
  const { items, currentIntent } = witness.cleanup;
  if (currentIntent?.index !== items.length) corruptCleanup("the final item is not the current cleanup intent");
  return items[items.length - 1]!;
};

/** The closed ledger the M6 revision that first records the final intent adds
 * atomically (163:3040). Both sibling paths are prebound here, in the record
 * that names them, so the ledger and the runway cannot disagree. */
export function buildPreparationLedger(root: string, migrationId: string, baseRevision: number): FutureControls {
  const at = (offset: number): string => migrationPaths.controlRevision(root, migrationId, baseRevision + offset);
  return {
    stage: "preparing", version: 1,
    baseRevision, readyRevision: baseRevision + 4,
    haltRevision: baseRevision + 5, successRevision: baseRevision + 6,
    halt: { kind: "halted-m6", path: at(5), disposition: { state: "absent" } },
    success: { kind: "m7", path: at(6), disposition: { state: "absent" } },
  };
}

// ---------------------------------------------------------------------------
// The cursor.

/** ENOSPC on a cursor transition publishes `cleanup-deferred` against the exact
 * same cursor. `haltRunway` already returns nothing at M6, so this halt can
 * never consume a vector item as its own runway (163:3343). */
function defer(root: string, control: MigrationControl, error: unknown, locks: HeldStatePlaneLocks): CleanupStep {
  const halt = deferredHalt(errnoOf(error));
  return { kind: "halted", halt, durableHalt: publishMigrationHalt(root, control, halt, locks).durable };
}

/**
 * One durable cursor transition. A nonfinal item is intended, removed, and
 * recorded absent; the final item's intent is the last thing this function
 * does, because from there the allocation-free runway owns the protocol.
 */
export async function stepCleanup(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<CleanupStep> {
  const { control, witness } = m6(receipt);
  const cursor = witness.cleanup;
  try {
    if (cursor.currentIntent === null) {
      if (cursor.durablePrefix >= cursor.items.length) {
        return corruptCleanup("the M6 cleanup cursor is complete but M7 was never published");
      }
      const index = cursor.durablePrefix + 1;
      const item = cursor.items[index - 1]!;
      const isFinal = index === cursor.items.length;
      return {
        kind: isFinal ? "final-intent" : "intent",
        control: publishNext(root, control, witness, {
          cleanup: { ...cursor, currentIntent: { index } },
          resources: { ...control.haltResources, [resourceKey(item.role)]: { disposition: "cleanup-intent" } },
          futureControls: isFinal
            ? buildPreparationLedger(root, control.migrationId, control.controlRevision + 1)
            : witness.futureControls,
        }, locks),
      };
    }
    const { index } = cursor.currentIntent;
    if (index === cursor.items.length) return { kind: "final-intent", control };
    const item = cursor.items[index - 1]!;
    releaseItem(item);
    return {
      kind: "retired",
      control: publishNext(root, control, witness, {
        cleanup: { ...cursor, durablePrefix: index, currentIntent: null },
        resources: { ...control.haltResources, [resourceKey(item.role)]: { disposition: "cleanup-absent" } },
      }, locks),
    };
  } catch (error) {
    if (!isOutOfSpace(error)) throw error;
    return defer(root, control, error, locks);
  }
}

// ---------------------------------------------------------------------------
// M7.

/**
 * M7 is already the canonical control when this runs, and that ordering is the
 * point: the record saying cleanup is complete becomes durable BEFORE the
 * artifacts it describes are retired. Then the unused prepared sibling goes,
 * and the control goes last.
 */
export async function finishMigration(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): Promise<void> {
  const { control } = receipt;
  if (control.witness.phase !== "M7") {
    return corruptCleanup(`finishMigration requires an M7 receipt, not ${control.witness.phase}`);
  }
  const canonical = readCanonicalControlExact(root)?.control;
  if (canonical?.migrationId !== control.migrationId || canonical.controlRevision !== control.controlRevision) {
    return corruptCleanup("M7 must be the canonical control before its artifacts are retired");
  }
  retireTerminalSibling(control.witness.terminalSibling);
  assertInertTemps(root, control);
  retireCanonicalControl(root, expectOf(control), locks);
}

/** Exact or delete-ahead absent, both admitted. Present means the recorded
 * inode at the recorded length; the bracket is `lstat`, because unlinking our
 * own prepared sibling never requires opening it. */
function retireTerminalSibling(sibling: TerminalSibling): void {
  const observed = statOrAbsent(sibling.path);
  if (!observed) return;
  if (!observed.isFile() || Number(observed.dev) !== sibling.dev
    || Number(observed.ino) !== sibling.ino || Number(observed.size) !== sibling.bytes) {
    corruptCleanup(`${sibling.path} is not the prepared sibling M7 recorded`);
  }
  fs.unlinkSync(sibling.path);
  fsyncDir(path.dirname(sibling.path));
}

/**
 * M7's "every non-control artifact is absent or exact-terminal" over role 5,
 * the publisher's own revision temps (163:2919). The set is closed and named —
 * one path per revision in this migration's own published interval — so no
 * directory is ever read and no path is ever discovered.
 *
 * For a role-5 path, an exact inert temp IS the exact-terminal disposition, and
 * inertness is decided by `lstat` alone. Opening one to judge it would deposit
 * state on a file we are declining to remove, and doctor's inert-temp
 * quarantine remains its only remover.
 */
function assertInertTemps(root: string, control: MigrationControl): void {
  for (let revision = FIRST_CONTROL_REVISION; revision <= control.controlRevision; revision++) {
    const file = migrationPaths.controlRevision(root, control.migrationId, revision);
    const observed = statOrAbsent(file);
    if (observed && !observed.isFile()) corruptCleanup(`${file} is neither absent nor an inert regular temp`);
  }
}
