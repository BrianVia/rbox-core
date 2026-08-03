/**
 * Entry point A of design 222 §3.2 — the state conversion `rbox upgrade` runs
 * inside its own stop window.
 *
 * `rbox upgrade` already stops every live daemon and restarts it afterwards. The
 * gap between those two is the only moment on a fleet host when a workspace is
 * provably idle AND a person is waiting, which is exactly what a migration
 * needs. So this is where a conversion happens without anyone asking for one.
 *
 * The contract this module exists to hold is a NEGATIVE one: nothing here may
 * prevent the restart. `upgrade-cmd.ts` calls it inside a `try` whose `finally`
 * restarts the daemon, and this function never throws — every outcome, including
 * a contradictory authority, comes back as a line to print. A workspace whose
 * conversion failed must still be a workspace whose daemon came back.
 */
import { ResetCorruptionError } from "./reset-io.js";
import { WorkspaceSyncBusyError, WorkspaceSyncTimeoutError } from "./sync-mutex.js";
import {
  describeAuthorityCorruption, describeAuthorityOutcome, describeLockRefusal,
  describeFormatTooNew, describeUnreadableState, describeWorkspaceBusy, renderOperatorReport,
  type OperatorReport,
} from "./state-plane-report.js";
import { establishStateAuthority } from "./state-plane/authority-bootstrap.js";
import { StateAuthorityCorruptError, StateFormatTooNewError } from "./state-plane/errors.js";
import { withStatePlaneLocks } from "./state-plane/locks.js";
import { runMigration } from "./state-plane/migration/authority.js";

export interface StateWindowOutcome {
  /** False only when a person has to do something about this workspace. */
  readonly ok: boolean;
  /** Already-prefixed lines, ready to print beside the other per-workspace
   * upgrade lines. Empty when there was nothing to say. */
  readonly lines: readonly string[];
}

/**
 * What is worth saying while a person is watching an upgrade.
 *
 * `rbox upgrade` is about the binary and the daemons; the conversion rides along.
 * So it speaks only when rbox CHANGED something, or when a conversion is stuck
 * part-way and someone has to act. Every refusal is deliberately silent: a
 * refusal means nothing was published and `.rbox` is byte-identical, and
 * `rbox doctor` is the surface that explains why a workspace has not converted.
 * An upgrade that printed a paragraph per already-converted or not-yet-eligible
 * workspace would bury the restart lines that are the command's actual answer.
 */
const worthSaying = (outcome: string): boolean =>
  !outcome.startsWith("refused:")
  && !outcome.startsWith("genesis-refused:")
  && outcome !== "already-migrated"
  && outcome !== "genesis-already-established";

/**
 * The escape hatch out of that silence, and the reason `ok` is not a dead field.
 *
 * Suppressing every refusal outright means a workspace that is BLOCKED — the
 * measured case is `memory-admission`, where a small-memory host cannot read the
 * document at all — emits nothing from `rbox upgrade`, forever, on every
 * upgrade. Doctor knows, but nobody runs doctor on a workspace they have no
 * reason to suspect.
 *
 * So a blocked refusal gets ONE line, not its paragraph. `severity` is the
 * discriminator rather than `ok`, because `ok` is also false for the routine
 * pre-B0 states: `barrier-witness-missing` is `info` and describes every
 * workspace on the fleet until it syncs once, and a line per workspace per
 * upgrade for a self-clearing condition is the noise this policy exists to
 * prevent.
 */
const quietSummary = (report: OperatorReport, key: string): string[] =>
  // Genesis refusals are excluded on top of the severity test. `evidence-missing`
  // is `blocked` and correctly so for `rbox migrate` — the user asked and got
  // nothing — but during an upgrade it means "this directory is not a workspace
  // rbox sets up", which is not a conversion that is stuck.
  report.finding.severity === "blocked" && !report.outcome.startsWith("genesis-refused:")
    ? [`daemon ${key}: sync records not converted — ${report.finding.problem} Run rbox doctor here.`]
    : [];

/**
 * Convert this workspace's sync records, if they need it, while its daemon is
 * stopped. Never throws.
 */
export async function migrateStateInUpgradeWindow(root: string, key: string): Promise<StateWindowOutcome> {
  const report = await observe(root);
  if (!worthSaying(report.outcome)) return { ok: report.ok, lines: quietSummary(report, key) };
  return { ok: report.ok, lines: renderOperatorReport(report).map((line) => `daemon ${key}: ${line}`) };
}

async function observe(root: string): Promise<OperatorReport> {
  try {
    const outcome = await withStatePlaneLocks(root, async (locks) =>
      describeAuthorityOutcome(root, await establishStateAuthority(
        root, { entry: "upgrade-stop-window", locks }, runMigration,
      )));
    return outcome.held ? outcome.value : describeLockRefusal(outcome.refusal);
  } catch (error) {
    if (error instanceof StateAuthorityCorruptError) return describeAuthorityCorruption(error.detail);
    if (error instanceof StateFormatTooNewError) return describeFormatTooNew(error.file);
    if (error instanceof WorkspaceSyncBusyError || error instanceof WorkspaceSyncTimeoutError) {
      return describeWorkspaceBusy();
    }
    if (error instanceof ResetCorruptionError) return describeUnreadableState(error.message);
    // Anything else is a defect, not a state-plane verdict — but the restart in
    // `upgrade-cmd.ts`'s `finally` still has to happen, so it is reported rather
    // than raised. §3.2's `recordWorkspaceOutcome(error)` is this line.
    return describeUnexpected(error);
  }
}

function describeUnexpected(error: unknown): OperatorReport {
  return {
    ok: false,
    outcome: "unexpected",
    // The MESSAGE is deliberately not interpolated. This branch exists for
    // defects, so the string is whatever threw — a Node `Error:` with an
    // absolute path and an errno is the likely shape, and that is not copy.
    // `rbox doctor --report` collects it; `error` is named so the argument is
    // not silently unused.
    facts: [`rbox recorded what stopped it (${error instanceof Error ? error.name : "unknown failure"}); \`rbox doctor --report\` collects the details.`],
    finding: {
      id: "state-migration/unexpected",
      severity: "attention",
      problem: "rbox couldn't finish converting this workspace's sync records during the upgrade.",
      safety: "Your files and your current sync records are unaffected, and the background sync was restarted.",
      command: "rbox migrate",
    },
  };
}
