/**
 * C1: a superseded migration's artifacts are gone (design 222 §M-7, design 163
 * § "Durable source-change retirement subprotocol", :2777).
 *
 * A source change never authorizes an informal delete/restart. This module
 * CAS-publishes one durable retirement record before anything is unlinked, then
 * advances a one-target cursor whose every intermediate state is a durable row
 * the classifier already admits.
 *
 * Two rules from 163 v13 govern every line here:
 *
 *  - Retirement unlinks only artifacts this migration owns, and every unlink is
 *    preceded by an identity bracket against the exact recorded inode. Nothing
 *    a record names is trusted without that independent confirmation, at arming
 *    and again at every cursor step.
 *  - No path is discovered, and no path is believed. A control carries two paths
 *    verbatim — `stagingPath` and the M5 Q sibling's — and every vector item is
 *    held to the ONE path its role derives to from `(root, migrationId)`. A
 *    directory test is not enough: the live source, the fixed backup, and the
 *    reset journal all live directly inside the two directories a migration owns.
 *    The control-publisher temps (163's cleanup role 5) contribute nothing,
 *    because no control below M6 records a sibling path and enumerating them
 *    would need directory discovery.
 *
 * A caught I/O fault throws rather than publishing a halt: the four retry buckets
 * are M-9's, and `haltRunway` already returns `[]` for any control with a
 * retirement armed, so no vector item can be consumed as halt runway (163:3343).
 *
 * A crash between `renderPreparedControl` and its rename strands an inert
 * revision-scoped `.tmp` no vector cleans. Not a leak to fix here: it
 * coordinates nothing, a fresh M0 picks a new id, and the publisher's `O_EXCL`
 * plus exact-byte adoption means an occupied path cannot wedge a resume.
 *
 * It opens no database. The driver closes any staging handle and takes the
 * complete lock set before this module is reached.
 */
import fs from "node:fs";
import path from "node:path";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths } from "../paths.js";
import { fsyncDirectory } from "../store/artifact-proof.js";
import { isForeign, observePath, observeQSibling } from "./artifact-observation.js";
import type { PhaseReceipt } from "./classifier.js";
import {
  durableRetirementReason,
  type ArtifactItem, type C1Trigger, type Cursor, type HaltResourceDisposition,
  type MigrationControl, type MigrationRetirement,
} from "./control-codec.js";
import { publishMigrationControl, retireCanonicalControl, type PublishExpectation } from "./control-publication.js";
import type { MigrationHalt } from "./health.js";

/** A zero-write refusal. Its shape is the classifier's: the halt taxonomy has no
 * free-text slot, so the observed condition rides in `underlyingCode`. */
interface RetirementCorruption {
  readonly kind: "corrupt";
  readonly halt: MigrationHalt;
}

export type RetirementArming =
  | { readonly kind: "armed"; readonly control: MigrationControl }
  | RetirementCorruption;

export type RetirementStep =
  /** The next target is now durably claimed; nothing has been unlinked. */
  | { readonly kind: "intent"; readonly control: MigrationControl }
  /** The claimed target is durably absent and the prefix advanced. */
  | { readonly kind: "retired"; readonly control: MigrationControl }
  /** Complete prefix: the control itself is gone and a fresh M0 may begin. */
  | { readonly kind: "complete" }
  | RetirementCorruption;

const corrupt = (detail: string): RetirementCorruption =>
  ({ kind: "corrupt", halt: { code: "reserved-path", underlyingCode: detail, required: null, available: null } });

const expectationFor = (control: MigrationControl): PublishExpectation =>
  ({ migrationId: control.migrationId, revision: control.controlRevision });

/** Sidecars precede their main, and each carries its own fixed role (163:2800). */
const STAGING_SIDECAR_ROLES = ["staging-journal", "staging-wal", "staging-shm"] as const;

/**
 * The ONE path each role may hold, derived from `(root, migrationId)` alone.
 * `control-sibling` has none — no control below M6 records a sibling — so it can
 * never be a retirement item.
 *
 * This is the containment fence, and it is derivation equality rather than a
 * directory test because the files a directory test would admit are exactly the
 * ones that must never be touched: the live source, the fixed backup, and the
 * reset journal are all direct children of the two directories a migration owns.
 */
function derivedPath(root: string, migrationId: string, role: ArtifactItem["role"]): string | undefined {
  const staging = migrationPaths.staging(root, migrationId);
  switch (role) {
    case "q-sibling": return migrationPaths.qSibling(root, migrationId);
    case "staging-journal": return `${staging}-journal`;
    case "staging-wal": return `${staging}-wal`;
    case "staging-shm": return `${staging}-shm`;
    case "staging-main": return staging;
    case "prepared-active-db": return sqliteResetPaths.active(root);
    case "emergency": return migrationPaths.emergency(root, migrationId);
    case "reserve": return migrationPaths.reserve(root);
    case "control-sibling": return undefined;
  }
}

/**
 * Every step re-derives the durable cursor's paths: a control read back from
 * disk is a record, not a construction. Arming needs no such pass — the builder
 * below emits `derivedPath` results and nothing else. The recorded parent must
 * also BE the item's parent, or the post-unlink fsync is aimed elsewhere.
 */
function notDerived(root: string, migrationId: string, items: readonly ArtifactItem[]): string | undefined {
  for (const item of items) {
    if (item.path !== derivedPath(root, migrationId, item.role) || item.parent !== path.dirname(item.path)) {
      return `${item.path} is not the path this migration's ${item.role} derives to`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Arming.

/**
 * Publish the initial retirement revision. `reason` is always the one durable
 * reason both C1 dispositions map to, and the trigger's witness is stored
 * verbatim as the diagnostic `triggeringSource`: it comes from the classifier,
 * the barrier inventory's one reader of the legacy document, and retirement
 * never interprets it.
 */
/** `clearHalt` is the operator-abort discipline (163:2614: pre-`Q` abort is the
 * path for "essentially every case", halted included). It publishes `halt: null`
 * in the SAME revision that arms the retirement — bucket-1 discipline, so a
 * workspace is never observable as armed-but-still-halted. No runway restoration
 * is needed: `haltRunway` returns `[]` once a retirement is armed, and a halt that
 * consumed reserve/emergency left them `consumed-for-halt`, which
 * `retirementVector` already skips. The C1 path leaves it `false`, so a halted
 * migration still cannot auto-arm C1 from the driver. */
export interface ArmOptions {
  readonly clearHalt?: boolean;
}

export function armRetirement(
  root: string, receipt: PhaseReceipt, trigger: C1Trigger, locks: HeldStatePlaneLocks,
  options: ArmOptions = {},
): RetirementArming {
  const { control } = receipt;
  if (control.retirement) return corrupt("a retirement is already armed");
  if (control.halt && !options.clearHalt) return corrupt("a halted migration arms no retirement");
  const fromPhase = control.witness.phase;
  if (fromPhase === "M6" || fromPhase === "M7") {
    return corrupt(`${fromPhase} is past the authority flip, where C1 cannot arm`);
  }
  // The two paths a control carries verbatim. Both must be what this migration's
  // id derives to before either is observed, let alone unlinked.
  if (control.stagingPath !== migrationPaths.staging(root, control.migrationId)) {
    return corrupt("the control's staging path is not the one its migration id derives to");
  }
  if (control.witness.phase === "M5"
    && control.witness.qSibling.path !== migrationPaths.qSibling(root, control.migrationId)) {
    return corrupt("the control's Q-sibling path is not the one its migration id derives to");
  }

  const items = retirementVector(root, control);
  if (typeof items === "string") return corrupt(items);
  const retirement: MigrationRetirement = {
    version: 1,
    reason: durableRetirementReason(trigger),
    fromPhase, fromControlRevision: control.controlRevision,
    originalSource: control.source, triggeringSource: trigger.replacement,
    cursor: { items, durablePrefix: 0, currentIntent: null },
  };
  const next: MigrationControl = {
    ...control, controlRevision: control.controlRevision + 1, retirement,
    halt: options.clearHalt ? null : control.halt,
  };
  return { kind: "armed", control: publishMigrationControl(root, expectationFor(control), next, locks) };
}

/**
 * The bounded fixed-role vector, in 163:2800's order, deduplicated by path. A
 * role contributes an item only when the control already owns it AND the path
 * still holds exactly what the control recorded; a mismatch is not a smaller
 * vector but a refusal, because entry publication requires every listed item to
 * match its control-owned starting disposition. Returns the refusal detail as a
 * string. Every path it emits comes from `derivedPath`.
 *
 * `sha256` is recorded only where a small artifact's exact bytes are already
 * known. Deleting a file needs OBJECT identity, which `dev`/`ino` settles; the
 * staging main and its sidecars are mid-import and have no content to pin, and
 * hashing them would make the per-step re-sweep digest a multi-gigabyte database
 * once per item — O(N²) work to learn what the inode already said.
 */
function retirementVector(root: string, control: MigrationControl): ArtifactItem[] | string {
  const items: ArtifactItem[] = [];
  const seen = new Set<string>();
  const push = (role: ArtifactItem["role"], file: string, dev: number, ino: number, sha256: string | null): void => {
    if (seen.has(file)) return;
    seen.add(file);
    items.push({ role, path: file, parent: path.dirname(file), dev, ino, sha256 });
  };
  const witness = control.witness;

  if (witness.phase === "M5") {
    const recorded = witness.qSibling.disposition;
    if (recorded.state !== "absent") {
      const observed = observeQSibling(witness.qSibling);
      if (isForeign(observed)) return observed.foreign;
      push("q-sibling", derivedPath(root, control.migrationId, "q-sibling")!, recorded.dev, recorded.ino,
        observed.state === "exact" ? witness.qSibling.sha256 : null);
    }
  }

  for (const role of STAGING_SIDECAR_ROLES) {
    const file = derivedPath(root, control.migrationId, role)!;
    const observed = observePath(file);
    if (observed.state === "foreign") return `${file} is not a regular file`;
    if (observed.state === "regular") push(role, file, observed.dev, observed.ino, null);
  }

  // M5 records `stagingMain: "absent"`, so only M4 can observe the rename that
  // moved the recorded inode to the active path one phase ahead.
  const staging = "stagingMain" in witness ? witness.stagingMain : { state: "absent" } as const;
  if (staging.state === "present") {
    const file = derivedPath(root, control.migrationId, "staging-main")!;
    const observed = observePath(file);
    if (observed.state === "regular") {
      if (observed.dev !== staging.dev || observed.ino !== staging.ino) {
        return `${file} is not the recorded staging inode`;
      }
      push("staging-main", file, observed.dev, observed.ino, null);
    } else if (!(observed.state === "absent" && witness.phase === "M4")) {
      return `${file} does not hold the recorded staging main`;
    }
  }

  if (witness.phase === "M4" || witness.phase === "M5") {
    const proof = witness.phase === "M5" ? witness.active : witness.staging;
    const file = sqliteResetPaths.active(root);
    const observed = observePath(file, true);
    if (observed.state === "regular") {
      if (observed.sha256 !== proof.sha256) return `${file} is not the database this migration proved`;
      push("prepared-active-db", file, observed.dev, observed.ino, proof.sha256);
    } else if (!(observed.state === "absent" && witness.phase === "M4")) {
      return `${file} does not hold the database this migration proved`;
    }
  }

  for (const role of ["emergency", "reserve"] as const) {
    const file = derivedPath(root, control.migrationId, role)!;
    const recorded = control.haltResources[role];
    if (recorded.disposition !== "available") continue;
    const observed = observePath(file, true);
    if (observed.state !== "regular" || observed.dev !== recorded.dev || observed.ino !== recorded.ino
      || observed.bytes !== recorded.bytes || observed.sha256 !== recorded.sha256) {
      return `${file} is not the recorded ${role} resource`;
    }
    push(role, file, observed.dev, observed.ino, recorded.sha256);
  }
  return items;
}

// ---------------------------------------------------------------------------
// The cursor. One target, one durable transition, per call (163:2821).

/**
 * Advance the armed cursor by exactly one durable row. Every call first
 * re-establishes the whole vector's admitted image — earlier items absent, later
 * items still matching what arming bracketed — so a target is never unlinked on
 * the strength of the record alone.
 */
export function stepRetirement(
  root: string, receipt: PhaseReceipt, locks: HeldStatePlaneLocks,
): RetirementStep {
  const { control } = receipt;
  const retirement = control.retirement;
  if (!retirement) return corrupt("no retirement is armed");
  // Names the command, not the surface. 163:3461 makes `--retry-state-migration`
  // the ONLY thing that clears a halt, so a detail that said "through doctor"
  // reached the user as `rbox doctor` — which prints the halt again and changes
  // nothing (wave 5B renders this string verbatim).
  if (control.halt) return corrupt("a halted retirement resumes only through rbox doctor --retry-state-migration");
  const { items, durablePrefix, currentIntent } = retirement.cursor;

  const detail = notDerived(root, control.migrationId, items)
    ?? vectorMismatch(items, durablePrefix, currentIntent !== null);
  if (detail) return corrupt(detail);

  if (durablePrefix === items.length) {
    retireCanonicalControl(root, expectationFor(control), locks);
    return { kind: "complete" };
  }
  const target = items[durablePrefix]!;
  if (!currentIntent) {
    const cursor: Cursor = { items, durablePrefix, currentIntent: { index: durablePrefix + 1 } };
    return { kind: "intent", control: publishCursor(root, control, retirement, cursor, target, "retirement-intent", locks) };
  }

  // The codec pins the intent to `durablePrefix + 1`, so `target` is it. Only
  // this item may be owned-present or already absent; an absent one is never
  // recreated, and its parent is fsynced either way, because the crash image
  // this resumes may be an unlink whose parent fsync did not land.
  const observed = observePath(target.path, target.sha256 !== null);
  if (observed.state !== "absent") {
    if (observed.state !== "regular" || observed.dev !== target.dev || observed.ino !== target.ino
      || (target.sha256 !== null && observed.sha256 !== target.sha256)) {
      return corrupt(`${target.path} is not the artifact this retirement bracketed`);
    }
    fs.unlinkSync(target.path);
  }
  fsyncDirectory(target.parent);
  const cursor: Cursor = { items, durablePrefix: durablePrefix + 1, currentIntent: null };
  return { kind: "retired", control: publishCursor(root, control, retirement, cursor, target, "retirement-absent", locks) };
}

/** Absence ahead of the current intent and any later-item change are both
 * corruption, not a broader artifact-behind allowance (163:2830). */
function vectorMismatch(
  items: readonly ArtifactItem[], durablePrefix: number, claimed: boolean,
): string | undefined {
  for (const [index, item] of items.entries()) {
    if (index < durablePrefix) {
      if (observePath(item.path).state !== "absent") {
        return `${item.path} is behind the retirement prefix but is present`;
      }
      continue;
    }
    if (claimed && index === durablePrefix) continue;
    const observed = observePath(item.path);
    if (observed.state !== "regular" || observed.dev !== item.dev || observed.ino !== item.ino) {
      return `${item.path} no longer matches the identity this retirement armed`;
    }
  }
  return undefined;
}

/** Publishing the cursor and relabelling a halt resource are one CAS: no absent
 * resource is ever described as `available` (163:2827). */
function publishCursor(
  root: string, control: MigrationControl, retirement: MigrationRetirement,
  cursor: Cursor, target: ArtifactItem, disposition: RetirementDisposition,
  locks: HeldStatePlaneLocks,
): MigrationControl {
  const next: MigrationControl = {
    ...control,
    controlRevision: control.controlRevision + 1,
    haltResources: resourcesFor(control, target, disposition),
    retirement: { ...retirement, cursor },
  };
  return publishMigrationControl(root, expectationFor(control), next, locks);
}

type RetirementDisposition = Extract<HaltResourceDisposition, "retirement-intent" | "retirement-absent">;

function resourcesFor(
  control: MigrationControl, target: ArtifactItem, disposition: RetirementDisposition,
): MigrationControl["haltResources"] {
  const { haltResources } = control;
  if (target.role === "reserve") return { ...haltResources, reserve: { disposition } };
  if (target.role === "emergency") return { ...haltResources, emergency: { disposition } };
  return haltResources;
}
