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
 *  - No path is discovered. The vector comes from the old exact control's own
 *    witness plus the fixed path policy, so no record can name a victim. Two
 *    consequences: the control-publisher temps (163's cleanup role 5) contribute
 *    nothing, because no control below M6 records a sibling path and enumerating
 *    them would need directory discovery; and the current source, the immutable
 *    history, and the fixed backup can never enter the vector.
 *
 * It opens no database. The driver closes any staging handle and takes the
 * complete lock set before this module is reached.
 */
import fs from "node:fs";
import path from "node:path";
import type { HeldStatePlaneLocks } from "../locks.js";
import { migrationPaths, sqliteResetPaths, stateRootPath } from "../paths.js";
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

/**
 * The two directories a migration artifact may live in: `.rbox/state` for
 * everything but the Q sibling, which sits beside `L` in `.rbox`.
 *
 * Every vector item is checked against them at arming AND at every step, because
 * the one path a control carries verbatim is its `stagingPath`, and a record
 * with a tampered one would otherwise make the sidecar and staging-main roles
 * name a victim anywhere on the disk. The comparison is exact rather than
 * normalizing: a path that needs `..` or `.` resolved to look owned is not one
 * this module wrote. The recorded parent must also BE the item's parent, or the
 * fsync after an unlink would be aimed somewhere else.
 */
function outsideOwnedDirectories(root: string, items: readonly ArtifactItem[]): string | undefined {
  const stateRoot = stateRootPath(root);
  const owned = new Set([stateRoot, path.dirname(stateRoot)]);
  for (const item of items) {
    if (!owned.has(item.parent) || item.parent !== path.dirname(item.path)) {
      return `${item.path} is not inside the directories this migration owns`;
    }
  }
  return undefined;
}

/** Sidecars precede their main, and each carries its own fixed role (163:2800). */
const STAGING_SIDECARS = [
  ["staging-journal", "-journal"], ["staging-wal", "-wal"], ["staging-shm", "-shm"],
] as const;

// ---------------------------------------------------------------------------
// Arming.

/**
 * Publish the initial retirement revision. `reason` is always the one durable
 * reason both C1 dispositions map to, and the trigger's witness is stored
 * verbatim as the diagnostic `triggeringSource`: it comes from the classifier,
 * the barrier inventory's one reader of the legacy document, and retirement
 * never interprets it.
 */
export function armRetirement(
  root: string, receipt: PhaseReceipt, trigger: C1Trigger, locks: HeldStatePlaneLocks,
): RetirementArming {
  const { control } = receipt;
  if (control.retirement) return corrupt("a retirement is already armed");
  if (control.halt) return corrupt("a halted migration arms no retirement");
  const fromPhase = control.witness.phase;
  if (fromPhase === "M6" || fromPhase === "M7") {
    return corrupt(`${fromPhase} is past the authority flip, where C1 cannot arm`);
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
  const next: MigrationControl = { ...control, controlRevision: control.controlRevision + 1, retirement };
  return { kind: "armed", control: publishMigrationControl(root, expectationFor(control), next, locks) };
}

/**
 * The bounded fixed-role vector, in 163:2800's order, deduplicated by path. A
 * role contributes an item only when the control already owns it AND the path
 * still holds exactly what the control recorded; a mismatch is not a smaller
 * vector but a refusal, because entry publication requires every listed item to
 * match its control-owned starting disposition. Returns the refusal detail as a
 * string.
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
      push("q-sibling", witness.qSibling.path, recorded.dev, recorded.ino,
        observed.state === "exact" ? witness.qSibling.sha256 : null);
    }
  }

  for (const [role, suffix] of STAGING_SIDECARS) {
    const file = `${control.stagingPath}${suffix}`;
    const observed = observePath(file);
    if (observed.state === "foreign") return `${file} is not a regular file`;
    if (observed.state === "regular") push(role, file, observed.dev, observed.ino, null);
  }

  // M5 records `stagingMain: "absent"`, so only M4 can observe the rename that
  // moved the recorded inode to the active path one phase ahead.
  const staging = "stagingMain" in witness ? witness.stagingMain : { state: "absent" } as const;
  if (staging.state === "present") {
    const observed = observePath(control.stagingPath);
    if (observed.state === "regular") {
      if (observed.dev !== staging.dev || observed.ino !== staging.ino) {
        return `${control.stagingPath} is not the recorded staging inode`;
      }
      push("staging-main", control.stagingPath, observed.dev, observed.ino, null);
    } else if (!(observed.state === "absent" && witness.phase === "M4")) {
      return `${control.stagingPath} does not hold the recorded staging main`;
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

  for (const [role, file] of [
    ["emergency", migrationPaths.emergency(root, control.migrationId)],
    ["reserve", migrationPaths.reserve(root)],
  ] as const) {
    const recorded = control.haltResources[role];
    if (recorded.disposition !== "available") continue;
    const observed = observePath(file, true);
    if (observed.state !== "regular" || observed.dev !== recorded.dev || observed.ino !== recorded.ino
      || observed.bytes !== recorded.bytes || observed.sha256 !== recorded.sha256) {
      return `${file} is not the recorded ${role} resource`;
    }
    push(role, file, observed.dev, observed.ino, recorded.sha256);
  }
  return outsideOwnedDirectories(root, items) ?? items;
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
  if (control.halt) return corrupt("a halted retirement resumes only through doctor");
  const { items, durablePrefix, currentIntent } = retirement.cursor;

  const detail = outsideOwnedDirectories(root, items)
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
