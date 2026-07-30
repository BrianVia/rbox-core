/**
 * M-9 — the migration driver (design 222 §M-9, §5).
 *
 * One loop: classify, dispatch the row to the phase body that owns it, act on
 * that body's outcome, repeat until a terminal outcome. Every iteration begins
 * with a fresh observation, so the driver holds no state across a durable
 * transition and a kill anywhere inside one re-enters through `classify` and
 * converges on the same row the interrupted iteration was on.
 *
 * Two rules give this module its shape:
 *
 * - **It performs no filesystem, crypto, or SQLite operation** (§7.9). Every
 *   syscall belongs to a phase body; the driver only sequences them and owns the
 *   durable transitions the bodies hand back as witness layers. A structural
 *   test walks this module's import graph.
 * - **It never constructs a `PhaseReceipt` from a control it made up.** Receipts
 *   come from `classifyMigrationState`, or from `PhaseReceipt.observe` applied to
 *   a record `control-publication.ts` just read back off disk. The one place the
 *   protocol requires the second form is M3's interstitial publication (§5.2).
 *
 * FINDING 5 (§M-9): no genesis outcome and no genesis dispatch. This module
 * neither imports nor is injected with anything from `genesis.ts`; the
 * coordinator rules genesis out before `runMigration` is called.
 */
import { MigrationControlError, MigrationPhaseHaltError } from "../errors.js";
import type { EntryProof, HeldStatePlaneLocks } from "../locks.js";
import type { AdmissionRefusal } from "./admission.js";
import { beginMigration, provisionRunway } from "./begin.js";
import { flipAuthority } from "./authority-flip.js";
import { classifyMigrationState, PhaseReceipt, type MigrationObservation } from "./classifier.js";
import { completeFinalItem, stepFutureControlPreparation } from "./cleanup-runway.js";
import { finishMigration, stepCleanup } from "./cleanup.js";
import type {
  C1Trigger, MigrationControl, MigrationPhase, MigrationWitness,
} from "./control-codec.js";
import {
  publishMigrationControl, publishMigrationHalt, readCanonicalControl,
} from "./control-publication.js";
import { publishPreparedDatabase, stepQSibling } from "./finalize.js";
import type { MigrationHalt } from "./health.js";
import { claimStagingMain, importOwnedStaging, preserveSource } from "./import-json.js";
import { proveStaging } from "./prove-staging.js";
import { armRetirement, stepRetirement, type ArmOptions } from "./retirement.js";

export type MigrationOutcome =
  | { readonly kind: "migrated"; readonly phases: readonly MigrationPhase[]; readonly elapsedMs: number }
  | { readonly kind: "already-migrated" }
  /** Abort only: there was no migration to abort, and the workspace is unchanged
   * on legacy JSON. Distinct from `already-migrated` (SQLite is authority) so 5B
   * does not tell a user on a pristine workspace that their state was migrated. */
  | { readonly kind: "nothing-to-abort" }
  | { readonly kind: "refused"; readonly refusal: AdmissionRefusal }
  /** §M-9 prints `trigger: C1Trigger`. A retirement resumed from a durable record
   * carries no trigger — the record stores the one durable `reason` both
   * dispositions map to plus the phase it armed from, and synthesizing a trigger
   * from `triggeringSource` would invent a disposition the record deliberately
   * does not keep. The two facts the record does hold are reported instead. */
  | { readonly kind: "retired"; readonly reason: "source-changed"; readonly fromPhase: MigrationPhase }
  | { readonly kind: "halted"; readonly halt: MigrationHalt; readonly durableHalt: boolean };

export interface MigrationProgress {
  readonly phase: MigrationPhase | "start";
  readonly step: string;
}
export type MigrationProgressSink = (progress: MigrationProgress) => void;

/**
 * Which phase bodies each observation row may call. Data rather than only
 * control flow, because §M-6's stale-witness containment is a property of "who
 * reads what on which row" and the driver is the first row dispatcher — the
 * thing that could break it. `authority.test.ts` crosses this table against what
 * each body actually reads, so a future edit that routes a stale member to its
 * consumer fails a test instead of misclassifying a workspace.
 */
export const ROW_DISPATCH = {
  "no-control-json": ["beginMigration"],
  "m0-resume": ["provisionRunway"],
  "m1-resume": ["preserveSource"],
  "m2-resume": ["claimStagingMain", "importOwnedStaging"],
  "m3-resume": ["proveStaging"],
  "m4-resume": ["publishPreparedDatabase"],
  "m5-resume": ["stepQSibling", "flipAuthority", "armRetirement"],
  "m5-artifact-ahead-q": ["flipAuthority"],
  "m6-cleanup": ["stepCleanup", "stepFutureControlPreparation", "completeFinalItem"],
  m7: ["finishMigration"],
  "terminal-sqlite": [],
  "source-changed": ["armRetirement"],
  "retirement-cursor": ["stepRetirement"],
  halted: [],
  corruption: [],
} as const satisfies Record<MigrationObservation["row"], readonly string[]>;

/** The rows on which `Q` is already live, so the flip has deleted the document
 * `control.source` and `completion.sourceJsonSha256` describe. Disjoint from
 * `m5-resume` by which authority the live document holds, which is the whole
 * containment for those two members (§M-6). */
export const SQLITE_LIVE_ROWS = ["m5-artifact-ahead-q", "m6-cleanup", "m7", "terminal-sqlite"] as const;

/** A phase never reached, so a loop that cannot advance is a bug rather than a
 * hang. Every iteration either returns or makes exactly one durable transition,
 * and the longest legal migration is eight phases plus one interstitial plus a
 * two-item cleanup vector and its five-row runway. */
const MAX_ITERATIONS = 64;

/** A zero-write corruption halt. The taxonomy has no free-text slot and U3 adds
 * no halt code, so the observed condition rides in `underlyingCode` — the same
 * choice the classifier made, and shared with `halt-recovery.ts` so the two
 * cannot drift into two spellings of one verdict. */
export const corruptionHalt = (detail: string): MigrationHalt =>
  ({ code: "reserved-path", underlyingCode: detail, required: null, available: null });

const expect = (control: MigrationControl) =>
  ({ migrationId: control.migrationId, revision: control.controlRevision });

/** One durable same-migration transition. The driver owns every publication a
 * phase body does not do itself, so the phase order lives in exactly one place. */
function publish(
  root: string, control: MigrationControl, witness: MigrationWitness, locks: HeldStatePlaneLocks,
): MigrationControl {
  return publishMigrationControl(
    root, expect(control), { ...control, controlRevision: control.controlRevision + 1, witness }, locks,
  );
}

/**
 * The driver. Classify, dispatch, handle, repeat.
 *
 * `onProgress` is bound by the entry site rather than threaded through the
 * coordinator (lane 2D's amendment 2): genesis has no progress surface, so a
 * sink on `establishStateAuthority` would be a parameter only one branch reads.
 */
export async function runMigration(
  root: string, entry: EntryProof, onProgress: MigrationProgressSink = () => undefined,
): Promise<MigrationOutcome> {
  const startedAt = Date.now();
  const phases: MigrationPhase[] = [];
  onProgress({ phase: "start", step: "observing" });
  for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
    const observation = await classifyMigrationState(root, entry.locks);
    const outcome = await step(root, entry, observation, phases, onProgress);
    if (outcome) {
      return outcome.kind === "migrated"
        ? { kind: "migrated", phases: [...phases], elapsedMs: Date.now() - startedAt }
        : outcome;
    }
  }
  // Non-convergence is a bug, but the surface stays typed: a caller handles one
  // union, never a mix of outcomes and thrown errors. `MAX_ITERATIONS` has wide
  // margin over the longest legal trace, so reaching it means the classifier and
  // a mutator disagree about whether a row advanced.
  return { kind: "halted", halt: corruptionHalt(`migration did not converge in ${MAX_ITERATIONS} observations`), durableHalt: false };
}

/**
 * One iteration: `undefined` means a durable transition landed and the next
 * observation decides what follows.
 *
 * Every halt a phase body raises is published HERE, because 163's "a failed halt
 * publication is the final mutation of the trace" is a property of the trace, not
 * of a phase — and because `wrote` is the one fact the driver cannot recompute,
 * which is why the bodies raise `MigrationPhaseHaltError` rather than returning.
 * A `MigrationControlError` is a determinate refusal about the record itself: it
 * is reported as a zero-write corruption halt and NEVER dressed as
 * `durability-indeterminate`, which would raise the SQLite fence over nothing.
 * `StateAuthorityCorruptError` is neither and propagates untouched.
 */
async function step(
  root: string, entry: EntryProof, observation: MigrationObservation,
  phases: MigrationPhase[], onProgress: MigrationProgressSink,
): Promise<MigrationOutcome | undefined> {
  try {
    return await dispatch(root, entry, observation, phases, onProgress);
  } catch (error) {
    if (error instanceof MigrationPhaseHaltError) return publishHalt(root, error, entry.locks);
    if (error instanceof MigrationControlError) {
      return { kind: "halted", halt: corruptionHalt(`migration control ${error.reason}`), durableHalt: false };
    }
    throw error;
  }
}

/**
 * Publish the halt the phase body named, at the same phase and the next revision.
 *
 * A row with no receipt has no control to CAS against — M0's own failures, and
 * every corruption row — so the halt is in-process only, exactly as §5.2's M0 row
 * requires. On `{durable: false}` the driver returns IMMEDIATELY and performs no
 * further migration write (§M-9).
 */
function publishHalt(
  root: string, raised: MigrationPhaseHaltError, locks: HeldStatePlaneLocks,
): MigrationOutcome {
  // Re-read, rather than reusing the observation's receipt. An iteration may
  // already have published a revision before the halt was raised — M3's
  // interstitial staging identity is the case that exists today — and a halt CAS'd
  // against the row's ORIGINAL revision would be refused as stale, silently
  // downgrading a durable halt to an in-process one. A halt is phase-preserving,
  // so the current canonical record is exactly what it must be published over.
  let canonical: MigrationControl | undefined;
  try {
    canonical = readCanonicalControl(root);
  } catch {
    // A control that cannot be read cannot be CAS'd against. In-process only.
    canonical = undefined;
  }
  if (!canonical) return { kind: "halted", halt: raised.halt, durableHalt: false };
  return {
    kind: "halted", halt: raised.halt,
    durableHalt: publishMigrationHalt(root, canonical, raised.halt, locks).durable,
  };
}

async function dispatch(
  root: string, entry: EntryProof, observation: MigrationObservation,
  phases: MigrationPhase[], onProgress: MigrationProgressSink,
): Promise<MigrationOutcome | undefined> {
  const locks = entry.locks;
  const advanced = (phase: MigrationPhase): undefined => {
    phases.push(phase);
    onProgress({ phase, step: "published" });
    return undefined;
  };
  switch (observation.row) {
    case "no-control-json": {
      const begun = await beginMigration(root, entry);
      if (begun.kind === "refused") return { kind: "refused", refusal: begun.refusal };
      return advanced("M0");
    }
    case "m0-resume": {
      const runway = await provisionRunway(root, observation.receipt, locks);
      const control = observation.receipt.control;
      publishMigrationControl(root, expect(control), {
        ...control, controlRevision: control.controlRevision + 1,
        witness: { phase: "M1", admission: runway.admission }, haltResources: runway.resources,
      }, locks);
      return advanced("M1");
    }
    case "m1-resume": {
      const layer = await preserveSource(root, observation.receipt, locks);
      const control = observation.receipt.control;
      if (control.witness.phase !== "M1") return corrupt("an m1-resume row carried a non-M1 witness");
      publish(root, control, { ...control.witness, phase: "M2", ...layer }, locks);
      return advanced("M2");
    }
    case "m2-resume":
      return await importPhase(root, observation.receipt, locks, advanced);
    case "m3-resume": {
      const layer = await proveStaging(root, observation.receipt, locks);
      const control = observation.receipt.control;
      if (control.witness.phase !== "M3") return corrupt("an m3-resume row carried a non-M3 witness");
      publish(root, control, { ...control.witness, phase: "M4", ...layer }, locks);
      return advanced("M4");
    }
    case "m4-resume": {
      const layer = await publishPreparedDatabase(root, observation.receipt, locks);
      const control = observation.receipt.control;
      if (control.witness.phase !== "M4") return corrupt("an m4-resume row carried a non-M4 witness");
      publish(root, control, { ...control.witness, phase: "M5", ...layer }, locks);
      return advanced("M5");
    }
    case "m5-resume": {
      // The ladder's own rungs publish; only `ready` may proceed, and it must do
      // so in this same iteration — a `ready` that returned would re-observe
      // `ready` forever.
      const rung = await stepQSibling(root, observation.receipt, locks);
      if (rung.kind !== "ready") return undefined;
      return await flip(root, PhaseReceipt.observe(rung.control), locks, advanced);
    }
    case "m5-artifact-ahead-q":
      // `Q` is live. `flipAuthority`'s resume branch is the ONLY thing this row
      // may call: it completes the parent fsync and publishes M6, and it is
      // deliberately the one body that does not re-read the deleted source
      // document (§M-6's stale-witness table).
      return await flip(root, observation.receipt, locks, advanced);
    case "m6-cleanup":
      return await cleanupPhase(root, observation.receipt, locks, advanced);
    case "m7":
      await finishMigration(root, observation.receipt, locks);
      onProgress({ phase: "M7", step: "finished" });
      return { kind: "migrated", phases: [], elapsedMs: 0 };
    case "terminal-sqlite":
      return { kind: "already-migrated" };
    case "source-changed":
      return armMigrationRetirement(root, observation.receipt, observation.trigger, locks);
    case "retirement-cursor": {
      const stepped = stepRetirement(root, observation.receipt, locks);
      if (stepped.kind === "corrupt") return { kind: "halted", halt: stepped.halt, durableHalt: false };
      if (stepped.kind !== "complete") return undefined;
      const retirement = observation.receipt.control.retirement;
      if (!retirement) return corrupt("a retirement-cursor row carried no retirement record");
      return { kind: "retired", reason: retirement.reason, fromPhase: retirement.fromPhase };
    }
    case "halted":
      // The driver never clears a halt. Clearing is `retryHaltedMigration`'s, and
      // it is reached only through doctor's explicit authorization.
      return { kind: "halted", halt: observation.halt, durableHalt: true };
    case "corruption":
      return { kind: "halted", halt: observation.halt, durableHalt: false };
    default:
      // A new observation row is a compile error here, not a runtime `undefined`
      // return that spins to `MAX_ITERATIONS`.
      return assertNever(observation);
  }
}

function assertNever(value: never): never {
  throw new Error(`unhandled observation row: ${JSON.stringify(value)}`);
}

const corrupt = (detail: string): MigrationOutcome =>
  ({ kind: "halted", halt: corruptionHalt(detail), durableHalt: false });

/**
 * M3, whose middle step is the driver's own (§5.2): claim the staging main, then
 * CAS-publish the SAME-PHASE M2 revision recording that exact identity, so no
 * database is ever opened at a path no durable record names.
 *
 * The republication is conditional on the identity having changed. Publishing it
 * unconditionally would burn one revision per observation and never converge.
 */
async function importPhase(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
  advanced: (phase: MigrationPhase) => undefined,
): Promise<MigrationOutcome | undefined> {
  const claim = await claimStagingMain(root, receipt, locks);
  let control = receipt.control;
  if (control.witness.phase !== "M2") return corrupt("an m2-resume row carried a non-M2 witness");
  const recorded = control.witness.stagingMain;
  if (recorded.state !== "present" || recorded.dev !== claim.identity.dev || recorded.ino !== claim.identity.ino) {
    control = publish(root, control, { ...control.witness, stagingMain: { state: "present", ...claim.identity } }, locks);
  }
  const published = PhaseReceipt.observe(control);
  const layer = claim.kind === "completed"
    ? { completion: claim.completion }
    : await importOwnedStaging(root, { identity: claim.identity, receipt: published }, locks);
  if (control.witness.phase !== "M2") return corrupt("the republished M2 revision is not an M2 witness");
  publish(root, control, { ...control.witness, phase: "M3", ...layer }, locks);
  return advanced("M3");
}

/** The one rename that elects SQLite. It owns its own publication and its own
 * `.rbox` fsync (4A's amendment), so the driver only routes its two outcomes. */
async function flip(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
  advanced: (phase: MigrationPhase) => undefined,
): Promise<MigrationOutcome | undefined> {
  const outcome = await flipAuthority(root, receipt, locks);
  if (outcome.kind === "arm-retirement") return armMigrationRetirement(root, receipt, outcome.trigger, locks);
  return advanced("M6");
}

/** Publish the initial C1 retirement revision. Exported because `halt-recovery.ts`
 * arms the same retirement for an abort, and a second call site of `armRetirement`
 * would be a second reading of what a corrupt arming means. */
export function armMigrationRetirement(
  root: string, receipt: PhaseReceipt, trigger: C1Trigger, locks: HeldStatePlaneLocks,
  options: ArmOptions = {},
): MigrationOutcome | undefined {
  const armed = armRetirement(root, receipt, trigger, locks, options);
  return armed.kind === "corrupt" ? { kind: "halted", halt: armed.halt, durableHalt: false } : undefined;
}

/**
 * M6's cursor, its allocation-free runway, and the one deletion the runway exists
 * for — one durable row per iteration, so the kill matrix has one window per call
 * rather than a nest of them.
 */
async function cleanupPhase(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
  advanced: (phase: MigrationPhase) => undefined,
): Promise<MigrationOutcome | undefined> {
  const stepped = await stepCleanup(root, receipt, locks);
  if (stepped.kind === "halted") {
    return { kind: "halted", halt: stepped.halt, durableHalt: stepped.durableHalt };
  }
  if (stepped.kind !== "final-intent") return undefined;
  const prepared = await stepFutureControlPreparation(root, PhaseReceipt.observe(stepped.control), locks);
  if (prepared.kind === "halted") {
    return { kind: "halted", halt: prepared.halt, durableHalt: prepared.durableHalt };
  }
  if (prepared.kind !== "ready") return undefined;
  const final = await completeFinalItem(root, PhaseReceipt.observe(prepared.control), locks);
  if (final.kind === "halted") return { kind: "halted", halt: final.halt, durableHalt: final.durableHalt };
  // `promoted-halt` is durable by construction: the promotion IS the publication.
  if (final.kind === "promoted-halt") {
    return { kind: "halted", halt: final.control.halt ?? corruptionHalt("a promoted halt carries no halt"), durableHalt: true };
  }
  return advanced("M7");
}
