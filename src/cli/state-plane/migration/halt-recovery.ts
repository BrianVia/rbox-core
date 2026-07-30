/**
 * Halt recovery — doctor's two authorized interventions on a suspended migration
 * (design 222 §M-9's four retry buckets, and §7.3's abort).
 *
 * This is the ONLY code in the tree that clears a halt, and it is split from the
 * driver because the two are different protocols over the same rows:
 * `authority.ts` drives a migration FORWARD from whatever row it is on, and this
 * module is what makes a suspended row drivable again before delegating back to
 * it. 163's 400-line law forced the split; the seam is real, and the dependency
 * runs strictly one way — recovery imports the driver, never the reverse.
 *
 * Same rule as the driver: no filesystem, crypto, or SQLite primitive is named
 * here. Recreating what a halt spent belongs to `begin.ts`, because it is the same
 * allocation M1 performs and it must not become a second implementation of it.
 */
import type { EntryProof, HeldStatePlaneLocks } from "../locks.js";
import {
  armMigrationRetirement, corruptionHalt, runMigration, SQLITE_LIVE_ROWS,
  type MigrationOutcome, type MigrationProgressSink,
} from "./authority.js";
import { restoreHaltRunway } from "./begin.js";
import { classifyMigrationState, type PhaseReceipt } from "./classifier.js";
import { retryPromotedHalt } from "./cleanup-runway.js";
import { isFinalIntentPromotedHalt, type C1Trigger, type MigrationControl } from "./control-codec.js";
import { publishMigrationControl } from "./control-publication.js";

const corrupt = (detail: string): MigrationOutcome =>
  ({ kind: "halted", halt: corruptionHalt(detail), durableHalt: false });

const expectation = (control: MigrationControl) =>
  ({ migrationId: control.migrationId, revision: control.controlRevision });

// ---------------------------------------------------------------------------
// The four retry buckets.

/** Exhaustive over the halted rows, keyed on the classified control. A
 * `Record<HaltBucket, …>` handler table is what makes it exhaustive: a bucket
 * added without a handler does not compile. */
export type HaltBucket = "ordinary" | "cursor" | "terminal" | "promoted";

/**
 * Order is load-bearing, and each conjunct is pinned by a negative control.
 *
 * `promoted` first: a promoted halt is an M6 final-intent control, so every later
 * test also matches it, and 163:3141 says its clear IS the rename — a bucket that
 * CAS-cleared it would publish an unhalted M6 at the revision the prepared M7
 * sibling already occupies and destroy the terminal path.
 */
export function classifyHaltBucket(control: MigrationControl): HaltBucket {
  if (isFinalIntentPromotedHalt(control)) return "promoted";
  if (control.retirement !== null) return "cursor";
  if (control.witness.phase === "M7") return "terminal";
  if (control.witness.phase === "M6") return "cursor";
  return "ordinary";
}

/**
 * Doctor's `--retry-state-migration`. The four buckets of §M-9, and the only code
 * in the tree that clears a halt.
 *
 * 222 §M-6 left a constraint on whichever wave introduced clearing: `haltRunway`
 * returns `[]` only at M6/M7, so a halt at M5 may have spent BOTH resources, and
 * clearing it without recreating them would reach the flip with an empty cleanup
 * vector — a post-rename `reserved-path` refusal no row can clear. Bucket 1
 * recreates them and republishes both `available` in the SAME publication that
 * clears, so the wedge is unreachable rather than excluded. That is why neither of
 * §M-6's two escapes is taken.
 */
export async function retryHaltedMigration(
  root: string, entry: EntryProof, onProgress: MigrationProgressSink = () => undefined,
): Promise<MigrationOutcome> {
  const observation = await classifyMigrationState(root, entry.locks);
  if (observation.row !== "halted") {
    return observation.row === "corruption"
      ? { kind: "halted", halt: observation.halt, durableHalt: false }
      : corrupt(`there is no halt to retry on row ${observation.row}`);
  }
  const outcome = await BUCKETS[classifyHaltBucket(observation.receipt.control)](
    root, observation.receipt, entry.locks,
  );
  if (outcome.kind === "halted") return outcome;
  return await runMigration(root, entry, onProgress);
}

type BucketHandler = (
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
) => Promise<{ readonly kind: "cleared" } | Extract<MigrationOutcome, { kind: "halted" }>>;

const cleared = { kind: "cleared" } as const;

const BUCKETS: Record<HaltBucket, BucketHandler> = {
  /** 1. Ordinary halted M0-M5: recreate whatever the halt spent, republish the
   * same phase with both dispositions `available`, and clear — one publication,
   * so a workspace is never observable as cleared-but-unprovisioned. */
  ordinary: async (root, receipt, locks) => {
    const control = receipt.control;
    const resources = await restoreHaltRunway(root, control);
    publishMigrationControl(root, expectation(control), {
      ...control, controlRevision: control.controlRevision + 1, halt: null, haltResources: resources,
    }, locks);
    return cleared;
  },
  /** 2. A C1 or M6-cleanup cursor halt: the cursor is preserved EXACTLY. Nothing
   * is recreated, because a cursor's resources are vector items rather than
   * runway (`haltRunway` already returns `[]` here), and resuming means resuming
   * that one target — including a terminal-prefix step. */
  cursor: async (root, receipt, locks) => {
    const control = receipt.control;
    publishMigrationControl(
      root, expectation(control), { ...control, controlRevision: control.controlRevision + 1, halt: null }, locks,
    );
    return cleared;
  },
  /** 3. Ordinary halted M7: CAS-clear, and the driver's `m7` row then runs
   * `finishMigration`. */
  terminal: async (root, receipt, locks) => {
    const control = receipt.control;
    publishMigrationControl(
      root, expectation(control), { ...control, controlRevision: control.controlRevision + 1, halt: null }, locks,
    );
    return cleared;
  },
  /** 4. The final-intent promoted halt: NO clear. The expected-`r+1` rename of the
   * exact prepared M7 sibling IS both the clear and the phase advance, and it is a
   * single-use in-process delegation. */
  promoted: async (root, receipt, locks) => {
    const outcome = await retryPromotedHalt(root, receipt, locks);
    return outcome.kind === "halted"
      ? { kind: "halted", halt: outcome.halt, durableHalt: outcome.durableHalt }
      : cleared;
  },
};

// ---------------------------------------------------------------------------
// Abort.

/**
 * Doctor's `--abort-state-migration`, pre-`Q` only (§7.3). C1 is run to
 * completion and the control is unlinked last, leaving the exact `L`
 * authoritative. Post-`Q` there is no abort: re-adoption is the only path, so the
 * request is refused rather than half-served.
 */
export async function abortMigration(root: string, entry: EntryProof): Promise<MigrationOutcome> {
  const observation = await classifyMigrationState(root, entry.locks);
  if ((SQLITE_LIVE_ROWS as readonly string[]).includes(observation.row)) {
    return corrupt(`a migration past the authority flip cannot be aborted (row ${observation.row})`);
  }
  // No control means nothing to abort, which is the same end state an abort
  // produces: nothing to do, zero mutation. That is exactly what
  // `already-migrated` means on §5.3's terminal row, so it is reused rather than
  // widening the union with a member every consumer would have to handle.
  if (observation.row === "no-control-json") return { kind: "already-migrated" };
  if (observation.row === "corruption") {
    return { kind: "halted", halt: observation.halt, durableHalt: false };
  }
  if (!("receipt" in observation)) return corrupt(`row ${observation.row} carries no control to abort`);
  const control = observation.receipt.control;
  if (!control.retirement) {
    const armed = armMigrationRetirement(root, observation.receipt, abortTrigger(control), entry.locks);
    if (armed) return armed;
  }
  return await runMigration(root, entry);
}

/** An abort is a source-change retirement whose trigger is the operator. The
 * replacement witness is the control's own recorded source, because the document
 * has NOT changed — what changed is the decision — and `triggeringSource` is
 * explicitly diagnostic, never authority (§M-7). */
const abortTrigger = (control: MigrationControl): C1Trigger =>
  ({ disposition: "source-changed", replacement: control.source });
