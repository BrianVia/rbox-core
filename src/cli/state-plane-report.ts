/**
 * The one renderer for every state-plane authority outcome (design 222 §6).
 *
 * `rbox migrate`, `rbox doctor --retry-state-migration`,
 * `rbox doctor --abort-state-migration`, `rbox upgrade`'s stop window, and
 * doctor's own migration check all end on one of the same handful of typed
 * outcomes. They share this module so there is one place a wording is decided,
 * one place the durable record is read for the facts a message must NAME, and
 * one `--json` twin the rig can drive.
 *
 * Nothing here mutates. The only filesystem read is the canonical control
 * record, which is file-level and never opens a database — the facts §6.3
 * defers to "the control witness" (a backup path, the reserved names) come from
 * that read.
 */
import {
  AUTHORITY_CORRUPT_COPY, GENESIS_REFUSAL_COPY, MIGRATION_DISPOSITION_COPY,
  MIGRATION_HALT_COPY, MIGRATION_REFUSAL_COPY, STATE_UNREADABLE_COPY, UNDERLYING_TOKEN_COPY,
  type OperatorCopy, type OperatorFinding,
} from "./state-plane-copy.js";
import type { AuthorityOutcome } from "./state-plane/authority-bootstrap.js";
import type { StatePlaneLockRefusal } from "./state-plane/locks.js";
import type { GenesisOutcome } from "./state-plane/genesis.js";
import type { MigrationOutcome } from "./state-plane/migration/authority.js";
import type { MigrationControl } from "./state-plane/migration/control-codec.js";
import { readCanonicalControl } from "./state-plane/migration/control-publication.js";
import type { MigrationHalt } from "./state-plane/migration/health.js";
import { migrationPaths, sqliteResetPaths } from "./state-plane/paths.js";

/** What one outcome is, for a human and for a machine. `ok` is the difference
 * between "rbox is done" and "somebody has to do something", and it is what the
 * commands turn into an exit code. */
export interface OperatorReport {
  readonly ok: boolean;
  /** The typed outcome this report came from, verbatim, for `--json` consumers. */
  readonly outcome: string;
  readonly finding: OperatorFinding;
  /** Facts the message NAMES: measured sizes, the condition inside a halt code,
   * and the paths a person has to go look at. One per line. */
  readonly facts: readonly string[];
}

const finding = (copy: OperatorCopy): OperatorFinding => ({
  id: copy.machine.id,
  severity: copy.machine.severity,
  problem: copy.human.problem,
  safety: copy.human.safety,
  ...(copy.human.command === undefined ? {} : { command: copy.human.command }),
});

const good = (id: string, outcome: string, problem: string, safety: string): OperatorReport => ({
  ok: true, outcome, facts: [],
  finding: { id, severity: "info", problem, safety },
});

/**
 * The condition inside a halt code, in plain English.
 *
 * `underlyingCode` is a stable token from the phase bodies, an errno, or — on
 * the corruption halts, which have no code of their own — a sentence. All three
 * are worth showing; only the first has a translation, and an unrecognised value
 * is quoted rather than dropped, because it is the only evidence of WHICH check
 * refused.
 */
function underlyingFact(halt: MigrationHalt): string | undefined {
  const raw = halt.underlyingCode;
  if (raw === null || raw.trim() === "") return undefined;
  // `hasOwn`, not truthiness: `underlyingCode` comes off a durable record a
  // tampered workspace controls, and a plain property lookup would resolve
  // `constructor` or `toString` to something that is not copy at all.
  const known = Object.hasOwn(UNDERLYING_TOKEN_COPY, raw) ? UNDERLYING_TOKEN_COPY[raw] : undefined;
  if (known !== undefined) return `What rbox saw: ${known}.`;
  if (/^[A-Z][A-Z0-9_]+$/.test(raw)) return `The system reported ${raw}.`;
  return `What rbox saw: ${raw}${raw.endsWith(".") ? "" : "."}`;
}

/**
 * The paths a halt tells the reader to go look at (§6.3's deferred facts).
 *
 * Derived from the migration id and this workspace's root — never stored a
 * second time — and taken from the live control only for the names that vary.
 * `verification` names the backup because that copy is the reassurance in its
 * safety line, and a reassurance the reader cannot locate is not one.
 */
function namedPaths(root: string, halt: MigrationHalt, control: MigrationControl | undefined): string[] {
  if (halt.code === "verification") {
    const witness = control?.witness;
    const backup = witness && witness.phase !== "M0" && witness.phase !== "M1"
      ? witness.fixedBackup.path
      : migrationPaths.fixedBackup(root);
    return [`Your original records are saved at ${backup}`];
  }
  if (halt.code !== "reserved-path") return [];
  const files = [
    sqliteResetPaths.authorityMarker(root),
    sqliteResetPaths.active(root),
    migrationPaths.reserve(root),
    ...(control ? [control.stagingPath] : []),
  ];
  return [`rbox keeps this workspace's sync records in: ${[...new Set(files)].join(", ")}`];
}

/** One halt, fully rendered. `durable` decides nothing about the words — a halt
 * that failed to publish suspends nothing — but it is reported so the rig and an
 * agent can tell "suspended until you retry" from "will be retried". */
export function describeMigrationHalt(
  root: string, halt: MigrationHalt, durableHalt: boolean,
  control: MigrationControl | undefined = readControl(root),
): OperatorReport {
  const copy: OperatorCopy = MIGRATION_HALT_COPY[halt.code];
  const facts = [
    copy.human.measured?.(halt),
    underlyingFact(halt),
    ...namedPaths(root, halt, control),
    durableHalt ? undefined : "rbox could not record this, so it will look again next time rather than stay stopped.",
  ].filter((line): line is string => line !== undefined);
  // `cleanup-deferred` is the one halt on a fully working workspace (222 §6.3,
  // ratified): the conversion is done and syncing normally, so it is not a
  // failure of the command that reported it.
  return { ok: halt.code === "cleanup-deferred", outcome: `halted:${halt.code}`, finding: finding(copy), facts };
}

function readControl(root: string): MigrationControl | undefined {
  try {
    return readCanonicalControl(root);
  } catch {
    // An unreadable control is itself reported as a corruption halt by the
    // classifier; the renderer must not turn it into a crash.
    return undefined;
  }
}

/** Everything `runMigration`, `retryHaltedMigration`, and `abortMigration` can
 * return. Exhaustive: a new outcome member fails to compile here. */
export function describeMigrationOutcome(root: string, outcome: MigrationOutcome): OperatorReport {
  switch (outcome.kind) {
    case "migrated":
      return good(
        "state-migration/migrated", "migrated",
        `This workspace's sync records are now in rbox's new format (${outcome.phases.length} steps, ${Math.round(outcome.elapsedMs / 1000)}s).`,
        "Nothing was lost, and a copy of the old records is saved. Syncing continues normally.",
      );
    case "already-migrated":
      return good(
        "state-migration/already-migrated", "already-migrated",
        "This workspace's sync records are already in rbox's new format.",
        "Nothing changed, and nothing needs to.",
      );
    case "nothing-to-abort":
      return good(
        "state-migration/nothing-to-abort", "nothing-to-abort",
        "There's no conversion in progress on this workspace, so there was nothing to stop.",
        "Nothing changed. Your sync records are exactly as they were.",
      );
    case "retired":
      return {
        ok: true, outcome: `retired:${outcome.fromPhase}`,
        finding: finding(MIGRATION_DISPOSITION_COPY["source-changed"]),
        facts: [`The partial work was thrown away and cleaned up (it had reached step ${outcome.fromPhase}).`],
      };
    case "refused":
      return describeAdmissionRefusal(root, outcome.refusal);
    case "halted":
      return describeMigrationHalt(root, outcome.halt, outcome.durableHalt);
  }
}

/** An M0 refusal: nothing was published, so `.rbox` is byte-identical. */
export function describeAdmissionRefusal(
  root: string, refusal: Extract<MigrationOutcome, { kind: "refused" }>["refusal"],
): OperatorReport {
  const copy = MIGRATION_REFUSAL_COPY[refusal.code];
  const facts = refusal.code === "reserve-foreign"
    ? [`The file is ${migrationPaths.reserve(root)} (${refusal.detail}).`]
    : refusal.code === "barrier-witness-missing"
      ? []
      : [`What rbox saw: ${refusal.detail}.`];
  return { ok: false, outcome: `refused:${refusal.code}`, finding: finding(copy), facts };
}

export function describeGenesisOutcome(root: string, outcome: GenesisOutcome): OperatorReport {
  if (outcome.kind === "established") {
    return good(
      "state-genesis/established", "genesis-established",
      "rbox set up this workspace's sync records in its new format.",
      "There was nothing to convert — this workspace is starting fresh.",
    );
  }
  if (outcome.kind === "already-established") {
    return good(
      "state-genesis/already-established", "genesis-already-established",
      "This workspace's sync records are already set up.",
      "Nothing changed, and nothing needs to.",
    );
  }
  const copy = GENESIS_REFUSAL_COPY[outcome.reason];
  const facts = outcome.reason === "artifact-present"
    ? [`The file is ${sqliteResetPaths.active(root)}.`]
    : [];
  return { ok: false, outcome: `genesis-refused:${outcome.reason}`, finding: finding(copy), facts };
}

/** The lock bundle was never held, so nothing ran at all. */
export function describeLockRefusal(refusal: StatePlaneLockRefusal): OperatorReport {
  if (refusal.code === "degraded-fence") {
    return {
      ok: false, outcome: "refused:degraded-fence",
      finding: finding(MIGRATION_REFUSAL_COPY["degraded-fence"]),
      facts: [`What rbox saw: ${refusal.detail}.`],
    };
  }
  const copy = MIGRATION_HALT_COPY["memory-admission"];
  return {
    ok: false, outcome: "refused:memory-admission",
    finding: finding(copy),
    // Not a halt: this is measured while READING the workspace, before anything
    // durable exists, so the numbers come from the refusal's own sentence.
    facts: [`What rbox saw: ${refusal.detail}.`],
  };
}

/**
 * The workspace mutex was held by somebody else for the whole bounded wait, so
 * the window never opened.
 *
 * It is the same condition M0's `migration-not-exclusive` describes — something
 * else is using this workspace — reached one layer earlier, so it reuses that
 * copy rather than inventing a second wording for one fact.
 */
export function describeWorkspaceBusy(): OperatorReport {
  return {
    ok: false, outcome: "refused:migration-not-exclusive",
    finding: finding(MIGRATION_REFUSAL_COPY["migration-not-exclusive"]),
    facts: ["Something else is using this workspace right now."],
  };
}

export function describeAuthorityOutcome(root: string, outcome: AuthorityOutcome): OperatorReport {
  return outcome.domain === "genesis"
    ? describeGenesisOutcome(root, outcome.outcome)
    : describeMigrationOutcome(root, outcome.outcome);
}

/**
 * The document could not be read, so nothing was ever locked.
 *
 * 163's "malformed JSON, non-exact sentinel, special/unreadable legacy path" row
 * halts before any database open. It surfaced as an escaping `ResetCorruptionError`
 * from the inventory read until wave 5B — a non-developer's first sight of the
 * feature would have been a stack trace naming a JSON parser.
 */
export function describeUnreadableState(detail: string): OperatorReport {
  return {
    ok: false, outcome: "refused:source-unreadable",
    finding: finding(STATE_UNREADABLE_COPY),
    facts: [`What rbox saw: ${detail}.`],
  };
}

/** 222 §6.4: never a halt, never offered a retry. */
export function describeAuthorityCorruption(detail: string): OperatorReport {
  return {
    ok: false, outcome: "authority-corrupt",
    finding: finding(AUTHORITY_CORRUPT_COPY),
    facts: [`What rbox saw: ${detail}.`],
  };
}

/** The human surface: problem, the facts it names, the safety line, one command.
 * Never a stack trace, and never an internal noun. */
export function renderOperatorReport(report: OperatorReport): string[] {
  const lines = [report.finding.problem, ...report.facts, report.finding.safety];
  if (report.finding.command) lines.push(`Next: ${report.finding.command}`);
  return lines;
}

/** The non-interactive twin the rig, CI, and an agent drive. */
export function operatorReportJson(report: OperatorReport): Record<string, unknown> {
  return {
    schemaVersion: 1,
    ok: report.ok,
    outcome: report.outcome,
    id: report.finding.id,
    severity: report.finding.severity,
    problem: report.finding.problem,
    safety: report.finding.safety,
    ...(report.finding.command === undefined ? {} : { command: report.finding.command }),
    facts: report.facts,
  };
}
