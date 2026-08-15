/**
 * The operator surface for the state plane (design 222 §3.2, §7.3, wave 5B).
 *
 * Three commands, one window:
 *
 * - `rbox migrate` — entry point B of §3.2. Foreground, with progress, and the
 *   only place a user asks for a conversion by name.
 * - `rbox doctor --retry-state-migration` — the ONE doctor authorization site
 *   (§7.9). It clears a suspended migration's halt and hands execution back to
 *   the same controller; it never implements a second repair path.
 * - `rbox doctor --abort-state-migration` — §7.3's pre-`Q` abandon.
 *
 * All three take the identical lock bundle through the identical helper, so the
 * exclusivity window, the refusal copy, the `--json` twin, and the exit code are
 * decided once. `rbox migrate` is unreachable from the daemon process (its own
 * dispatcher token is `__daemon-run`, which has no path here), and a daemon that
 * is merely RUNNING is refused by M0's own `migration-not-exclusive` condition
 * rather than by a second liveness check here.
 */
import { ResetCorruptionError } from "./reset-io.js";
import {
  acquireWorkspaceSyncMutex,
  releaseWorkspaceSyncMutex,
  WorkspaceSyncBusyError,
  WorkspaceSyncTimeoutError,
} from "./sync-mutex.js";
import { MIGRATION_STEP_COPY, PROGRESS_ANNOUNCE_AFTER_MS } from "./state-plane-copy.js";
import {
  describeAuthorityCorruption, describeGenesisAdmissionRefusal, describeLockRefusal,
  describeFormatTooNew, describeMigrationOutcome, describeUnreadableState, describeWorkspaceBusy,
  describeNoLegacyState,
  operatorReportJson, renderOperatorReport,
  type OperatorReport,
} from "./state-plane-report.js";
import { admitGenesisAuthority, observeStateAuthority } from "./state-plane/authority-bootstrap.js";
import { MigrationControlError, StateAuthorityCorruptError, StateFormatTooNewError } from "./state-plane/errors.js";
import { withStatePlaneLocks, type EntryPoint, type EntryProof } from "./state-plane/locks.js";
import { runMigration, type MigrationProgress } from "./state-plane/migration/authority.js";
import { abortMigration, retryHaltedMigration } from "./state-plane/migration/halt-recovery.js";
import { readGenesisIntent } from "./state-plane/genesis-intent.js";
import { readCanonicalControl } from "./state-plane/migration/control-publication.js";

export interface StatePlaneCmdOptions {
  readonly json?: boolean;
  /** Test seam: where the human surface goes. */
  readonly log?: (line: string) => void;
  /** Test seam for the 5-second progress threshold. */
  readonly now?: () => number;
}

/** Zero when rbox is done and nothing is owed; 1 when a person has to act. 222
 * §6's "every command is real and non-interactively twinned" needs both halves:
 * the words AND an exit code a script can branch on. */
function emit(report: OperatorReport, options: StatePlaneCmdOptions): number {
  const log = options.log ?? console.log;
  if (options.json === true) log(JSON.stringify(operatorReportJson(report), null, 2));
  else for (const line of renderOperatorReport(report)) log(line);
  return report.ok ? 0 : 1;
}

/**
 * The window every operator command shares.
 *
 * A refused bundle, a busy workspace, and a contradictory authority are all
 * reported as typed outcomes with copy — never as a stack trace out of the
 * fence, which is what a non-developer would otherwise see.
 */
async function inWindow(
  root: string, entry: EntryPoint, options: StatePlaneCmdOptions,
  body: (proof: EntryProof) => Promise<OperatorReport>,
): Promise<number> {
  try {
    const outcome = await withStatePlaneLocks(root, (locks) => body({ entry, locks }));
    if (outcome.held) return emit(outcome.value, options);
    return emit(describeLockRefusal(outcome.refusal), options);
  } catch (error) {
    if (error instanceof StateAuthorityCorruptError) {
      return emit(describeAuthorityCorruption(error.detail), options);
    }
    if (error instanceof MigrationControlError) {
      return emit(describeAuthorityCorruption("the migration control record is unreadable"), options);
    }
    // Believed unreachable from here (the inventory reads through the selecting
    // seam), and caught anyway: it is the one typed state-plane error with no
    // other translation, so an unhandled one is exactly the stack trace the
    // "no bare throws to the CLI" rule exists to prevent.
    if (error instanceof StateFormatTooNewError) {
      return emit(describeFormatTooNew(error.file), options);
    }
    if (error instanceof WorkspaceSyncBusyError || error instanceof WorkspaceSyncTimeoutError) {
      return emit(describeWorkspaceBusy(), options);
    }
    if (error instanceof ResetCorruptionError) {
      return emit(describeUnreadableState(error.message), options);
    }
    throw error;
  }
}

/**
 * Entry point B of §3.2 — foreground `rbox migrate`.
 *
 * It calls the coordinator, not the driver: a workspace with no records at all
 * is genesis's business, and one entry point that dispatched only migration
 * would leave that workspace with no command at all.
 */
export async function migrateCmd(root: string, options: StatePlaneCmdOptions = {}): Promise<number> {
  const progress = startProgress(options);
  try {
    // The explicit command owns the file-level fork. A surviving genesis intent
    // is recovered through ordinary admission; raw absence is inert; every
    // migration candidate enters the existing coordinator under its full fence.
    let runExplicitMigration = false;
    try {
      const mutex = await acquireWorkspaceSyncMutex(root, "cli");
      try {
        const observation = await observeStateAuthority(root);
        const intent = readGenesisIntent(root);
        let control;
        try {
          control = readCanonicalControl(root);
        } catch (error) {
          if (error instanceof MigrationControlError) {
            return emit(describeAuthorityCorruption("the migration control record is unreadable"), options);
          }
          throw error;
        }
        if (intent && !control) {
          const admitted = await admitGenesisAuthority(root, mutex);
          return emit(
            admitted.kind === "refused"
              ? describeGenesisAdmissionRefusal(admitted.refusal)
              : describeMigrationOutcome(root, { kind: "already-migrated" }),
            options,
          );
        }
        if (observation.kind === "uninitialized" && !control) {
          return emit(describeNoLegacyState(), options);
        }
        runExplicitMigration = true;
      } finally {
        await releaseWorkspaceSyncMutex(mutex);
      }
    } catch (error) {
      if (error instanceof WorkspaceSyncBusyError || error instanceof WorkspaceSyncTimeoutError) {
        return emit(describeWorkspaceBusy(), options);
      }
      throw error;
    }
    if (!runExplicitMigration) throw new Error("migration entry classification did not settle");
    return await inWindow(root, "foreground-migrate", options, async (proof) =>
      describeMigrationOutcome(root, await runMigration(root, proof, progress.observe)));
  } finally {
    progress.stop();
  }
}

/** §7.9's one doctor authorization site. */
export async function retryStateMigrationCmd(root: string, options: StatePlaneCmdOptions = {}): Promise<number> {
  const progress = startProgress(options);
  try {
    return await inWindow(root, "foreground-migrate", options, async (proof) =>
      describeMigrationOutcome(root, await retryHaltedMigration(root, proof, progress.observe)));
  } finally {
    progress.stop();
  }
}

/** §7.3's abort: pre-`Q` only, and `halt-recovery.ts` is what refuses the rest. */
export async function abortStateMigrationCmd(root: string, options: StatePlaneCmdOptions = {}): Promise<number> {
  return await inWindow(root, "foreground-migrate", options, async (proof) =>
    describeMigrationOutcome(root, await abortMigration(root, proof)));
}

/**
 * 222 §6.4: "the `migrating` state renders in plain English past 5 s per phase".
 *
 * Silence under five seconds is the point — a conversion that takes 200 ms
 * should print nothing but its verdict — so the decision is a clock comparison,
 * never "an event happened".
 *
 * It is checked from BOTH edges, and each covers what the other cannot. A phase
 * that does slow work and reports nothing (M3's import is the real one) has no
 * event to check on, so the timer is the only thing that can speak; a phase that
 * emits while the interval happens not to have fired would otherwise stay silent
 * past the threshold on a fast host. The earlier build had only the timer, which
 * made the rule unobservable without real wall-clock time — the reason §6.4 went
 * unverified through the whole wave.
 *
 * `unref` keeps the timer from holding the process open past the verdict.
 */
function startProgress(options: StatePlaneCmdOptions): {
  observe: (event: MigrationProgress) => void; stop: () => void;
} {
  if (options.json === true) return { observe: () => undefined, stop: () => undefined };
  const log = options.log ?? console.log;
  const now = options.now ?? Date.now;
  let current: MigrationProgress | undefined;
  let since = now();
  let announced: string | undefined;
  const announceIfSlow = (): void => {
    if (!current || now() - since < PROGRESS_ANNOUNCE_AFTER_MS) return;
    const text = MIGRATION_STEP_COPY[current.phase];
    if (text === announced) return;
    announced = text;
    log(`still ${text}…`);
  };
  const timer = setInterval(announceIfSlow, 1000);
  timer.unref?.();
  return {
    observe: (event) => {
      if (current?.phase !== event.phase) {
        since = now();
        announced = undefined;
      }
      current = event;
      announceIfSlow();
    },
    stop: () => clearInterval(timer),
  };
}
