/**
 * The state-plane operator vocabulary: every halt, refusal, and disposition the
 * migration machine can end on, in the words the four external users read
 * (design 222 §6, design 163 R4-ROLLOUT M5).
 *
 * Three closed tables live here, each an exhaustive `satisfies Record<…>` over a
 * union declared in the state plane. Those `satisfies` clauses are the merge
 * gate: a new halt code, admission refusal, or genesis refusal cannot land
 * without its copy, because this file stops compiling.
 *
 * The tables hold WORDS only. `state-plane-report.ts` decides which one a given
 * outcome reaches and renders it; nothing here reads the filesystem, the control
 * record, or an outcome union.
 *
 * Two standing prohibitions from 163: never advise deleting the authority
 * marker, and never advise restoring a backup.
 */
import type { TriageFinding, TriageSeverity } from "./doctor-triage.js";
import { formatDecimalBytes } from "./quota-format.js";
import { RESET_MATERIALIZED_BYTE_LIMIT, resetParseBudgetBytes } from "./reset-io.js";
import type { AdmissionRefusal } from "./state-plane/migration/admission.js";
import type { MigrationProgress } from "./state-plane/migration/authority.js";
import type { MigrationHalt, MigrationHaltCode } from "./state-plane/migration/health.js";
import type { GenesisRefusal } from "./state-plane/genesis.js";

/**
 * One user-facing state-plane message.
 *
 * It IS a `TriageFinding` minus the id/severity the tables supply separately, so
 * doctor's `--json` twin and the machine triage surface carry one shape rather
 * than a second one that could drift.
 */
export interface OperatorCopy {
  readonly human: {
    readonly problem: string;
    readonly safety: string;
    readonly command?: string;
    /** The facts 163:3300 requires this outcome to PRINT rather than allude to,
     * rendered from the durable record and appended after `problem`. Returns
     * `undefined` when the record carries nothing to name — never the string
     * "unknown", which is not a measurement. */
    readonly measured?: (halt: MigrationHalt) => string | undefined;
  };
  readonly machine: { readonly id: string; readonly severity: TriageSeverity };
}

export type OperatorFinding = TriageFinding;

const bytes = (value: number | null): string | undefined =>
  value === null || !Number.isFinite(value) ? undefined : formatDecimalBytes(value);

/**
 * `source-oversize` records `required` = the document's own size and `available`
 * = the 512 MiB conversion ceiling, which the generic "N available against M
 * required" sentence renders exactly backwards. It gets its own line.
 */
const oversizeMeasured = (halt: MigrationHalt): string | undefined => {
  const actual = bytes(halt.required);
  const cap = bytes(halt.available) ?? formatDecimalBytes(RESET_MATERIALIZED_BYTE_LIMIT);
  return actual === undefined ? undefined : `This workspace's state file is ${actual}; the most rbox can convert is ${cap}.`;
};

/** Memory headroom, plus the exact budget value the remedy tells them to raise. */
const memoryMeasured = (halt: MigrationHalt): string | undefined => {
  const need = bytes(halt.required);
  const have = bytes(halt.available);
  if (need === undefined && have === undefined) return undefined;
  const budget = formatDecimalBytes(resetParseBudgetBytes());
  return `Converting it needs about ${need ?? "more"} of free memory and this machine could spare ${have ?? "less"}`
    + ` (the current limit, RBOX_RESET_PARSE_BUDGET_BYTES, is ${budget}).`;
};

/** Disk space, in the order a person checks it: what is free, what is needed. */
const diskMeasured = (halt: MigrationHalt): string | undefined => {
  const need = bytes(halt.required);
  const have = bytes(halt.available);
  if (need === undefined && have === undefined) return undefined;
  if (have === undefined) return `Converting it needs about ${need} of free disk space.`;
  if (need === undefined) return `This disk has ${have} free.`;
  return `This disk has ${have} free and the conversion needs about ${need}.`;
};

/**
 * The stable tokens the phase bodies put in `underlyingCode`, in plain English.
 *
 * They are a discriminator inside one halt code — `verification` alone covers
 * seven distinct refusals — so without this table a user is told "it didn't
 * match" and nothing more. Unknown values (an errno, a SQLite code, a detail
 * from a corruption halt) are rendered verbatim by the report module rather
 * than dropped: an unrecognised token is still evidence.
 */
export const UNDERLYING_TOKEN_COPY: Readonly<Record<string, string>> = {
  "staging-open": "the converted copy could not be opened for checking",
  "authority-mismatch": "the converted copy was not stamped by this conversion",
  "completion-tuple": "the converted copy's own record of what it imported did not match",
  "semantic-digest": "a content fingerprint of the converted copy did not match the original",
  "foreign-key-check": "the converted copy's internal links did not check out",
  "integrity-check": "the converted copy failed its own database integrity check",
  checkpoint: "the converted copy could not be settled onto the disk",
  "not-at-rest": "the converted copy still had working files beside it",
  "staging-inode": "the file being converted was not the one rbox recorded",
  "staging-identity-absent": "the file being converted was gone",
  "staging-identity-changed": "the file being converted was replaced while rbox was checking it",
};

/**
 * Exhaustive halt-code → copy map (design 222 §6.3).
 *
 * `reserved-path` is the one row whose 222 wording is amended here rather than
 * copied. It is the taxonomy's catch-all — `authority.ts`, `classifier.ts`, and
 * `retirement.ts` all raise it for conditions that are NOT an unexpected file,
 * including 163's authority-matrix row for a workspace with no state at all —
 * so "rbox found an unexpected file" is false at exactly the moment a user reads
 * it. The replacement is true for every producer, and the observed condition is
 * rendered beneath it. Its command is amended for the same reason: `rbox doctor`
 * as the remedy for something doctor is printing is not an action.
 */
export const MIGRATION_HALT_COPY = {
  "source-oversize": {
    human: {
      problem: "This workspace's sync records are too big for rbox to convert on this machine.",
      safety: "Nothing changed. The workspace keeps working exactly as it does now.",
      command: "run `rbox migrate` once on a machine with more memory, or set this workspace up again with `rbox adopt`",
      measured: oversizeMeasured,
    },
    machine: { id: "state-migration/source-oversize", severity: "blocked" },
  },
  "memory-admission": {
    human: {
      problem: "Converting this workspace's sync records needs more memory than this machine can spare.",
      safety: "Nothing changed. The workspace keeps working exactly as it does now.",
      command: "run `rbox migrate` once on a machine with more memory, or set this workspace up again with `rbox adopt`",
      measured: memoryMeasured,
    },
    machine: { id: "state-migration/memory-admission", severity: "blocked" },
  },
  "record-oversize": {
    human: {
      problem: "One entry in this workspace's sync records is too large to convert.",
      safety: "Nothing changed. The workspace keeps working exactly as it does now.",
      command: "rbox doctor --report",
    },
    machine: { id: "state-migration/record-oversize", severity: "blocked" },
  },
  "disk-preflight": {
    human: {
      problem: "There isn't enough free disk space to convert this workspace's sync records safely.",
      safety: "Nothing changed. The workspace keeps working exactly as it does now.",
      command: "free up disk space, then run `rbox migrate`",
      measured: diskMeasured,
    },
    machine: { id: "state-migration/disk-preflight", severity: "blocked" },
  },
  "filesystem-full": {
    human: {
      problem: "The disk filled up partway through converting this workspace's sync records, so rbox stopped rather than leave the job half done.",
      safety: "Your old sync records are still the ones in use, and they are intact.",
      command: "free up disk space, then run `rbox doctor --retry-state-migration`",
      measured: diskMeasured,
    },
    machine: { id: "state-migration/filesystem-full", severity: "blocked" },
  },
  "source-changed": {
    human: {
      problem: "Tidying up after an interrupted conversion didn't finish.",
      safety: "Your current sync records are untouched and still in use.",
      command: "rbox doctor --retry-state-migration",
    },
    machine: { id: "state-migration/retirement-source-changed", severity: "attention" },
  },
  verification: {
    human: {
      problem: "The converted copy of this workspace's sync records didn't match the original exactly, so rbox refused to switch to it.",
      safety: "Your original sync records are untouched and still in use, and rbox saved a copy of them.",
      command: "rbox doctor --report",
    },
    machine: { id: "state-migration/verification", severity: "blocked" },
  },
  "reserved-path": {
    human: {
      problem: "rbox stopped because the files it keeps this workspace's sync records in weren't the ones it expected.",
      safety: "Nothing was deleted, moved, or overwritten. Your files and your sync are unaffected.",
      command: "check the file named below; move anything that isn't rbox's aside yourself, then run `rbox migrate`",
    },
    machine: { id: "state-migration/reserved-path", severity: "blocked" },
  },
  "durability-indeterminate": {
    human: {
      problem: "rbox can't confirm its last write reached the disk, so it has paused writing to this workspace.",
      safety: "No data was lost. rbox is being careful on purpose.",
      command: "rbox doctor --retry-state-migration",
    },
    machine: { id: "state-migration/durability-indeterminate", severity: "blocked" },
  },
  "cleanup-deferred": {
    human: {
      problem: "The conversion finished; clearing away one leftover file didn't.",
      safety: "Your workspace is fully working on the new format and syncing normally.",
      command: "rbox doctor --retry-state-migration",
    },
    machine: { id: "state-migration/cleanup-deferred", severity: "attention" },
  },
} satisfies Record<MigrationHaltCode, OperatorCopy>;

/**
 * Refusals (222 §6.1): nothing was published and `.rbox` is byte-identical, so
 * every safety line here is allowed to be absolute.
 */
export const MIGRATION_REFUSAL_COPY = {
  "degraded-fence": {
    human: {
      problem: "This workspace's folder can't be locked reliably on this disk, so rbox won't move its sync records here.",
      safety: "Nothing changed. Your files and your sync are unaffected.",
      command: "rbox doctor",
    },
    machine: { id: "state-migration/degraded-fence", severity: "attention" },
  },
  "quarantine-pending": {
    human: {
      problem: "There's a paused repair of this workspace's sync records to finish first.",
      safety: "Nothing changed. Your data is intact.",
      command: "rbox doctor reset-journal",
    },
    machine: { id: "state-migration/quarantine-pending", severity: "attention" },
  },
  "barrier-witness-missing": {
    human: {
      problem: "This workspace was last written by an older rbox. It needs one ordinary sync with this version before its records can be converted.",
      safety: "Nothing changed.",
      command: "rbox sync",
    },
    machine: { id: "state-migration/barrier-witness-missing", severity: "info" },
  },
  "migration-not-exclusive": {
    human: {
      problem: "rbox only converts a workspace's sync records while nothing else is using it.",
      safety: "Nothing changed.",
      command: "rbox stop, then rbox migrate",
    },
    machine: { id: "state-migration/not-exclusive", severity: "attention" },
  },
  "reserve-foreign": {
    human: {
      problem: "A file rbox keeps as spare room doesn't look like one rbox wrote, so it left the file alone.",
      safety: "Nothing was deleted, claimed, or changed.",
      command: "check the file named below; move it aside yourself, then run `rbox migrate`",
    },
    machine: { id: "state-migration/reserve-foreign", severity: "attention" },
  },
} satisfies Record<AdmissionRefusal["code"], OperatorCopy>;

/** Genesis refusals (222 §6.1). Same renderer, same shape. */
export const GENESIS_REFUSAL_COPY = {
  "legacy-present": {
    human: {
      problem: "This workspace got its old sync records back while rbox was setting it up, so rbox stopped and kept them.",
      safety: "Nothing was replaced.",
      command: "rbox migrate",
    },
    machine: { id: "state-genesis/legacy-present", severity: "attention" },
  },
  "artifact-present": {
    human: {
      problem: "There's already something where rbox keeps this workspace's sync records, so rbox didn't start fresh.",
      safety: "Nothing was deleted or overwritten.",
      command: "check the file named below; move it aside yourself, then run `rbox migrate`",
    },
    machine: { id: "state-genesis/artifact-present", severity: "blocked" },
  },
  "evidence-missing": {
    human: {
      problem: "rbox can't confirm this workspace is set up, so it won't create sync records for it.",
      safety: "Nothing changed.",
      command: "rbox adopt",
    },
    machine: { id: "state-genesis/evidence-missing", severity: "blocked" },
  },
} satisfies Record<GenesisRefusal, OperatorCopy>;

/**
 * The two outcomes that are neither halts nor refusals: rbox threw its own
 * partial work away and the workspace never left its old records (222 §6.2).
 */
export const MIGRATION_DISPOSITION_COPY = {
  "source-changed": {
    human: {
      problem: "This workspace's sync records changed while rbox was converting them, so rbox threw the partial work away.",
      safety: "Your current sync records are untouched and still in use.",
      command: "rbox migrate",
    },
    machine: { id: "state-migration/source-changed", severity: "info" },
  },
} satisfies Record<"source-changed", OperatorCopy>;

/**
 * 222 §6.4: "the `migrating` state renders in plain English past 5 s per phase".
 *
 * One clause per phase, in the words of what is happening to the user's data —
 * never the phase name, which means nothing outside this codebase. `M0` and
 * `start` both describe looking rather than changing, and they say so.
 */
export const MIGRATION_STEP_COPY = {
  start: "looking at this workspace",
  M0: "checking there's room and that nothing else is using this workspace",
  M1: "setting aside spare room on the disk",
  M2: "saving a copy of the current sync records",
  M3: "converting the sync records",
  M4: "checking the converted copy matches the original exactly",
  M5: "putting the converted records in place",
  M6: "switching over to the converted records",
  M7: "clearing away the leftovers",
} satisfies Record<MigrationProgress["phase"], string>;

export const PROGRESS_ANNOUNCE_AFTER_MS = 5000;

/**
 * The sync records could not be READ at all, so no authority verdict exists.
 *
 * Reached before anything is locked: 163's "malformed JSON, non-exact sentinel,
 * special/unreadable legacy path" row, which halts before any database open or
 * cleanup. It is not a migration halt — there is nothing durable to describe —
 * and it must never advise deleting the file, because `rbox doctor` can say
 * whether the workspace can be rejoined instead.
 */
export const STATE_UNREADABLE_COPY: OperatorCopy = {
  human: {
    problem: "rbox can't read this workspace's sync records, so it won't convert them.",
    safety: "Nothing changed. Your files are untouched.",
    command: "rbox doctor",
  },
  machine: { id: "state-migration/source-unreadable", severity: "blocked" },
};

/** 222 §6.4: never a halt, never offered a retry. The remedy is re-adoption, and
 * it is spelled out rather than named, because "re-adopt" is not a thing a
 * non-developer knows how to do. */
export const AUTHORITY_CORRUPT_COPY: OperatorCopy = {
  human: {
    problem: "This workspace says it uses rbox's new sync-record format, but the records themselves are missing or don't match.",
    safety: "rbox has changed nothing and will not try to repair this by itself.",
    command: "rbox stop, move this workspace's `.rbox` folder aside, then run `rbox adopt` here to rebuild it from the server",
  },
  machine: { id: "state-authority/corrupt", severity: "blocked" },
};
