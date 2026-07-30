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
  FORMAT_TOO_NEW_COPY, MIGRATION_HALT_COPY, MIGRATION_REFUSAL_COPY, STATE_UNREADABLE_COPY,
  type OperatorCopy, type OperatorFinding,
} from "./state-plane-copy.js";
import {
  RESERVED_PATH_CLASS_COPY, RESERVED_PATH_TOKEN_COPY, UNDERLYING_TOKEN_COPY,
  UNDERLYING_UNKNOWN_LINE, type ReservedPathClass,
} from "./state-plane-detail-copy.js";
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

/** An operating-system or SQLite error code, which reads as one. Anything else
 * that is not a known token is a sentence rbox wrote for itself. */
const looksLikeErrno = (raw: string): boolean => /^[A-Z][A-Z0-9_]{2,}$/.test(raw);

/** `hasOwn`, not truthiness: `underlyingCode` comes off a durable record a
 * tampered workspace controls, and a plain property lookup would resolve
 * `constructor` or `toString` to something that is not copy at all. */
const tokenCopy = (raw: string): string | undefined =>
  Object.hasOwn(UNDERLYING_TOKEN_COPY, raw) ? UNDERLYING_TOKEN_COPY[raw] : undefined;

/**
 * The condition inside a halt code, in plain English.
 *
 * `underlyingCode` is a stable token from the phase bodies, an errno, or — on the
 * corruption halts, which have no code of their own — a sentence rbox wrote for
 * itself. Only the first two are shown as themselves.
 */
function underlyingFact(halt: MigrationHalt): string | undefined {
  const raw = halt.underlyingCode;
  if (raw === null || raw.trim() === "") return undefined;
  const known = tokenCopy(raw);
  if (known !== undefined) return `What rbox saw: ${known}.`;
  if (looksLikeErrno(raw)) return `The system reported ${raw}.`;
  // NEVER the raw string. It is a developer sentence — "no durable config stream
  // to bind its reserve to" is what one producer stores — and the copy bar is
  // four people, two of them non-technical. The detail stays in the record.
  return UNDERLYING_UNKNOWN_LINE;
}

/**
 * Which of `reserved-path`'s ~40 producers raised this one, to the resolution
 * its remedy needs (see `RESERVED_PATH_CLASS_COPY`).
 *
 * Default `internal`, deliberately: a durable path-occupancy halt carries no
 * discriminator, because the stable-token rule keeps prose out of the record. So
 * an unclassified halt is told to send the report rather than pointed at a file
 * list that, after the flip, includes the workspace's LIVE sync records.
 */
function reservedPathClass(halt: MigrationHalt): ReservedPathClass {
  const raw = halt.underlyingCode;
  if (raw === null || raw.trim() === "") return "internal";
  if (looksLikeErrno(raw)) return "environment";
  return tokenCopy(raw) === undefined ? "internal" : "path-occupied";
}

/** The copy one halt actually gets: the table row, unless `reserved-path`'s
 * class or one of its named tokens has a truer one. */
function haltCopy(halt: MigrationHalt): OperatorCopy {
  if (halt.code !== "reserved-path") return MIGRATION_HALT_COPY[halt.code];
  const token = halt.underlyingCode;
  if (token !== null && Object.hasOwn(RESERVED_PATH_TOKEN_COPY, token)) {
    return RESERVED_PATH_TOKEN_COPY[token]!;
  }
  return RESERVED_PATH_CLASS_COPY[reservedPathClass(halt)];
}

/**
 * The paths a halt tells the reader to go look at (§6.3's deferred facts).
 *
 * Derived from the migration id and this workspace's root — never stored a
 * second time — and taken from the live control only for the names that vary.
 * `verification` names the backup because that copy is the reassurance in its
 * safety line, and a reassurance the reader cannot locate is not one.
 *
 * `reserved-path` names a path ONLY in the `path-occupied` class. The blanket
 * "rbox keeps this workspace's sync records in: …" list this replaced included
 * the live `state.db` on every post-flip producer, under a command that told the
 * reader to move things aside.
 */
function namedPaths(root: string, halt: MigrationHalt, control: MigrationControl | undefined): string[] {
  if (halt.code === "verification") {
    const witness = control?.witness;
    const backup = witness && witness.phase !== "M0" && witness.phase !== "M1"
      ? witness.fixedBackup.path
      : migrationPaths.fixedBackup(root);
    return [`Your original records are saved at ${backup}`];
  }
  if (halt.code !== "reserved-path" || reservedPathClass(halt) !== "path-occupied") return [];
  // The one occupied path this class can name from the record it has.
  return control ? [`The file is ${control.stagingPath}`] : [];
}

/** One halt, fully rendered. `durable` decides nothing about the words — a halt
 * that failed to publish suspends nothing — but it is reported so the rig and an
 * agent can tell "suspended until you retry" from "will be retried". */
export function describeMigrationHalt(
  root: string, halt: MigrationHalt, durableHalt: boolean,
  control: MigrationControl | undefined = readControl(root),
): OperatorReport {
  const copy: OperatorCopy = haltCopy(halt);
  const facts = [
    copy.human.measured?.(halt),
    underlyingFact(halt),
    ...namedPaths(root, halt, control),
    durableHalt ? undefined : "rbox could not record this, so it will look again next time rather than stay stopped.",
  ].filter((line): line is string => line !== undefined);
  // `cleanup-deferred` is the one halt on a fully working workspace (222 §6.3,
  // ratified): the conversion is done and syncing normally, so it is not a
  // failure of the command that reported it.
  //
  // The outcome carries the DISCRIMINATOR for the named `reserved-path` tokens,
  // because `halted:reserved-path` is what forty different conditions would
  // report and a script cannot branch on it.
  const token = halt.underlyingCode;
  const named = halt.code === "reserved-path" && token !== null && Object.hasOwn(RESERVED_PATH_TOKEN_COPY, token);
  return {
    ok: halt.code === "cleanup-deferred",
    outcome: named ? `halted:${halt.code}:${token!}` : `halted:${halt.code}`,
    finding: finding(copy),
    facts,
  };
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
      : [safeDetail(refusal.detail)];
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
      facts: [safeDetail(refusal.detail)],
    };
  }
  const copy = MIGRATION_HALT_COPY["memory-admission"];
  return {
    ok: false, outcome: "refused:memory-admission",
    finding: finding(copy),
    // Not a halt: this is measured while READING the workspace, before anything
    // durable exists, so the numbers come from the refusal's own sentence, which
    // is authored copy naming its own limit rather than an exception message.
    facts: [safeDetail(refusal.detail)],
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
    facts: [safeDetail(detail)],
  };
}

/**
 * A detail a user may read, from a string written for a developer.
 *
 * Exception messages compose: `StateAuthorityCorruptError`'s detail carries the
 * store's open reason, which carries a Node `Error:` with an absolute path and an
 * errno. Interpolating that into copy puts a stack-shaped string in front of the
 * two non-technical users. A short, path-free, code-free detail is worth showing;
 * anything else becomes the pointer at `rbox doctor --report`, where the whole
 * thing is collected verbatim.
 */
function safeDetail(detail: string): string {
  const trimmed = detail.trim();
  const developerShaped = trimmed.length > 120
    || /\bError\b|\bat \/|node_modules|[/\\](?:tmp|home|Users|var)[/\\]|\bE[A-Z]{3,}\b/.test(trimmed);
  return developerShaped ? UNDERLYING_UNKNOWN_LINE : `What rbox saw: ${trimmed}${trimmed.endsWith(".") ? "" : "."}`;
}

/**
 * The 1.x fail-closed barrier, met by a 2.0 binary that should never meet it.
 *
 * Believed unreachable from the operator commands — they read through the
 * selecting seam — but "believed unreachable" is precisely how a stack trace
 * reaches a non-developer, and this file exists to stop that.
 */
export function describeFormatTooNew(file: string): OperatorReport {
  return {
    ok: false, outcome: "refused:format-too-new",
    finding: finding(FORMAT_TOO_NEW_COPY),
    facts: [`The records are at ${file}.`],
  };
}

/** 222 §6.4: never a halt, never offered a retry. */
export function describeAuthorityCorruption(detail: string): OperatorReport {
  return {
    ok: false, outcome: "authority-corrupt",
    finding: finding(AUTHORITY_CORRUPT_COPY),
    facts: [safeDetail(detail)],
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
