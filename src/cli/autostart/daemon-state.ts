import path from "node:path";
import {
  currentWorkspaceId,
  readDaemonModeWitness,
  readDaemonPidRecord,
  startDaemon,
  stopDaemon,
  type DaemonLiveObservation,
  type DaemonModeIntent,
} from "../daemon-control.js";
import type { DaemonTraceStream } from "../daemon/process-control.js";
import { assertBindingUsable, resolveBindingScope } from "../scope/binding-scope.js";
import { withScopeTransitionLock } from "../scope/scope-lock.js";
import type { DaemonMode } from "../daemon/ambient-status.js";
import { requireFolderAdmission } from "./folder-admission-gate.js";
import type { FolderAdmission } from "../folder-inventory.js";
import {
  desiredContext,
  desiredMode,
  desiredRecordLock,
  desiredStatePath,
  desiredWithModes,
  mutateDesiredRecord,
  readDesiredRecord,
  resolveStartMode,
  resumeDesiredIdentity,
  sameDesiredGeneration,
  withDesiredRecordLock,
  type DaemonMaintenance,
  type DesiredDaemonState,
  type DesiredDaemonStateValue,
  type DesiredDeps,
} from "./desired-state.js";

export interface StartStopDeps extends DesiredDeps {
  startDaemon?: typeof startDaemon;
  stopDaemon?: typeof stopDaemon;
  /** Interactive-start-only trace selection; never written to desired state. */
  traceStreams?: readonly DaemonTraceStream[];
  modeWitnessTimeoutMs?: number;
  modeWitnessPollMs?: number;
  /** Resume-only generation guard; never supplied by an interactive start. */
  resumeExpected?: DesiredDaemonState;
  trustedDesiredIdentity?: DesiredDaemonState;
  trustedFolderAdmission?: Extract<FolderAdmission, { kind: "admitted" }>;
}

class StaleDesiredResumeError extends Error {}

async function readDesiredForStart(root: string, expected?: DesiredDaemonState): Promise<DesiredDaemonState | undefined | false> {
  const lock = await desiredRecordLock(root);
  try {
    const current = await readDesiredRecord(desiredStatePath(root));
    return expected !== undefined && !sameDesiredGeneration(current, expected) ? false : current;
  } finally {
    await lock.release();
  }
}

async function startDaemonAndRecordDesiredImpl(root: string, deps: StartStopDeps): Promise<boolean> {
  const abs = path.resolve(root);
  const read = await readDesiredForStart(abs, deps.resumeExpected);
  if (read === false) return false;
  const previous = read;
  // Design 212 §3.1b layer 3: scope is the authority for the mode. A halted binding
  // never starts at all; a scoped one starts pull-only no matter what the desired
  // record says, what flags were passed, or how the record was corrupted.
  const seal = await resolveBindingScope(abs);
  assertBindingUsable(seal);
  const identity = deps.trustedDesiredIdentity === undefined
    ? await desiredContext(abs, "running", deps)
    : resumeDesiredIdentity(abs, deps.trustedDesiredIdentity);
  if (deps.trustedFolderAdmission === undefined) await requireFolderAdmission(abs);
  const requested = seal.kind === "scoped"
    ? { mode: "pull-only" as const, intent: "explicit" as const, explicit: true }
    : resolveStartMode(previous, deps);
  const fresh = (state: DesiredDaemonStateValue): DesiredDaemonState => ({
    ...identity,
    state,
    at: (deps.now ?? (() => new Date()))().toISOString(),
  });
  let spawnParked = false;
  let liveRecorded = false;
  let resumeClaimed = false;
  let witnessHandled = false;
  let recordedPending = previous?.pendingModeIntent;
  let explicitParkedGeneration: DesiredDaemonState | undefined;
  let claimedGeneration: DesiredDaemonState | undefined;
  const requireResumeGeneration = (current: DesiredDaemonState | undefined): void => {
    if (deps.resumeExpected !== undefined && !resumeClaimed && !sameDesiredGeneration(current, deps.resumeExpected)) {
      throw new StaleDesiredResumeError("desired daemon state changed before resume");
    }
  };
  if (requested.explicit) {
    explicitParkedGeneration = await mutateDesiredRecord(abs, (current) => {
      requireResumeGeneration(current);
      // The flag itself is the durable user action. Record it before daemon
      // admission so retry-later, UNKNOWN, and MISMATCH cannot lose a changed
      // mind. Preserve liveness until a daemon callback proves it changed.
      const next = desiredWithModes(fresh(current?.state ?? "stopped"), desiredMode(current), requested.mode);
      recordedPending = requested.mode;
      return next;
    });
    resumeClaimed = true;
  }
  const requireExplicitGeneration = (current: DesiredDaemonState | undefined): void => {
    if (explicitParkedGeneration !== undefined && !sameDesiredGeneration(current, explicitParkedGeneration)) {
      throw new StaleDesiredResumeError("desired daemon mode intent changed before start admission");
    }
  };
  const recordLive = async (observation?: DaemonLiveObservation): Promise<void> => {
    const recorded = await mutateDesiredRecord(abs, (current) => {
      requireResumeGeneration(current);
      requireExplicitGeneration(current);
      if (observation !== undefined) {
        const live = readDaemonPidRecord(abs);
        if (live.pid !== observation.pid || (observation.bootId !== undefined && live.bootId !== observation.bootId)) {
          throw new Error("background sync exited or changed before its desired running state was recorded");
        }
      }
      recordedPending = requested.explicit ? requested.mode : current?.pendingModeIntent;
      return desiredWithModes(fresh("running"), desiredMode(current), recordedPending);
    });
    if (recorded === undefined) throw new Error("background sync desired state changed before live admission");
    claimedGeneration = recorded;
    explicitParkedGeneration = undefined;
    liveRecorded = true;
    resumeClaimed = true;
  };
  let result;
  try {
    result = await (deps.startDaemon ?? startDaemon)(identity.rootPath, {
      pullOnly: requested.mode === "pull-only",
      modeIntent: requested.intent,
      traceStreams: deps.traceStreams,
      ...(deps.modeWitnessTimeoutMs === undefined ? {} : { modeWitnessTimeoutMs: deps.modeWitnessTimeoutMs }),
      ...(deps.modeWitnessPollMs === undefined ? {} : { modeWitnessPollMs: deps.modeWitnessPollMs }),
      onLive: recordLive,
      onSpawned: async ({ pid, bootId }) => {
        const recorded = await mutateDesiredRecord(abs, (current) => {
          requireResumeGeneration(current);
          requireExplicitGeneration(current);
          const live = readDaemonPidRecord(abs);
          if (live.version !== "v2" || live.pid !== pid || live.bootId !== bootId) {
            throw new Error("spawned background sync exited or changed before its desired mode intent was recorded");
          }
          // A bare start resumes existing intent but never authors one. Explicit
          // flags are the only operation allowed to create or replace pending.
          recordedPending = requested.explicit ? requested.mode : current?.pendingModeIntent;
          return desiredWithModes(fresh("running"), desiredMode(current), recordedPending);
        });
        if (recorded === undefined) throw new Error("spawned background sync desired state changed before mode admission");
        claimedGeneration = recorded;
        explicitParkedGeneration = undefined;
        spawnParked = true;
        resumeClaimed = true;
      },
      onModeWitness: async (witness) => {
        witnessHandled = true;
        const expectedPending = spawnParked || liveRecorded ? recordedPending : previous?.pendingModeIntent;
        await mutateDesiredRecord(abs, (current) => {
          const pidfile = readDaemonPidRecord(abs);
          const currentWitness = readDaemonModeWitness(abs, witness.bootId);
          if (pidfile.version !== "v2" || pidfile.bootId !== witness.bootId
            || currentWitness.kind !== "known" || currentWitness.mode !== requested.mode) return undefined;
          if (current?.state === "stopped" || current?.pendingModeIntent !== expectedPending) return undefined;
          if (expectedPending !== undefined && expectedPending !== requested.mode) return undefined;
          if (claimedGeneration !== undefined && !sameDesiredGeneration(current, claimedGeneration)) return undefined;
          return desiredWithModes(fresh("running"), requested.mode);
        });
      },
    });
  } catch (error) {
    if (error instanceof StaleDesiredResumeError) return false;
    throw error;
  }
  if (result === "already-running-unknown-mode") {
    if (!liveRecorded) {
      try {
        await recordLive();
      } catch (error) {
        if (error instanceof StaleDesiredResumeError) return false;
        throw error;
      }
    }
    return true;
  }
  if (result !== "started" && result !== "already-running") return spawnParked || liveRecorded;
  if (witnessHandled) return true;
  // Compatibility for injected starters: returning a witnessed-success result
  // without driving onModeWitness retains the historical test/dependency seam.
  const expectedPending = spawnParked || liveRecorded || requested.explicit
    ? recordedPending
    : previous?.pendingModeIntent;
  const promoted = await mutateDesiredRecord(abs, (current) => {
    if (deps.resumeExpected !== undefined && !resumeClaimed && !sameDesiredGeneration(current, deps.resumeExpected)) return undefined;
    if (current?.state === "stopped" && (spawnParked || liveRecorded)) return undefined;
    const expectedGeneration = claimedGeneration ?? explicitParkedGeneration;
    if (expectedGeneration !== undefined && !sameDesiredGeneration(current, expectedGeneration)) return undefined;
    if (current !== undefined && current.pendingModeIntent !== expectedPending) return undefined;
    if (expectedPending !== undefined && expectedPending !== requested.mode) return undefined;
    return desiredWithModes(fresh("running"), requested.mode);
  });
  return promoted !== undefined;
}

/** Start and record, composable: callers that already hold the scope-transition
 *  lock (the resume path) or that cannot be racing an edit use this. */
export async function startDaemonAndRecordDesired(root: string, deps: StartStopDeps = {}): Promise<void> {
  await startDaemonAndRecordDesiredImpl(root, deps);
}

/**
 * `rbox start` and every other command-level start. It takes the scope-transition
 * lock because a scope edit parks the daemon precisely so nothing runs while
 * folders are being trashed and committed: a start landing mid-edit would boot the
 * daemon into a half-applied scope AND drop the maintenance token on its way past,
 * and the resume fence can only decline to restart afterwards — it cannot put the
 * daemon back to sleep. Waiting for the edit, then reporting it, is the only safe
 * answer.
 *
 * With no edit in flight the user still wins outright: the record is rebuilt from a
 * fresh identity, so an orphaned window left by a crashed edit is cancelled by the
 * very act of starting.
 */
export async function startDaemonForUser(root: string, deps: StartStopDeps = {}): Promise<void> {
  const abs = path.resolve(root);
  await withScopeTransitionLock(abs, () => startDaemonAndRecordDesiredImpl(abs, deps), deps.lockWaitMs);
}

export async function resumeDesiredDaemon(
  expected: DesiredDaemonState,
  deps: Pick<StartStopDeps, "startDaemon" | "modeWitnessTimeoutMs" | "modeWitnessPollMs" | "trustedFolderAdmission"> = {},
): Promise<boolean> {
  return startDaemonAndRecordDesiredImpl(expected.rootPath, {
    ...deps,
    resumeExpected: expected,
    trustedDesiredIdentity: expected,
  });
}

/** Stop the daemon and return the record that records it. Caller supplies the
 *  critical section; this never takes the lock itself. */
async function stopUnderDesiredLock(
  abs: string,
  deps: StartStopDeps,
  identity: DesiredDaemonState,
  current: DesiredDaemonState | undefined,
  maintenance?: DaemonMaintenance,
): Promise<DesiredDaemonState> {
  let accepted = desiredMode(current);
  let pending = current?.pendingModeIntent;
  if (pending !== undefined) {
    const witness = readDaemonModeWitness(abs);
    if (witness.kind === "known" && witness.mode === pending) {
      accepted = pending;
      pending = undefined;
    }
  }
  await (deps.stopDaemon ?? stopDaemon)(abs);
  const stopped = desiredWithModes({
    ...identity,
    state: "stopped",
    at: (deps.now ?? (() => new Date()))().toISOString(),
  }, accepted, pending);
  return maintenance === undefined ? stopped : { ...stopped, maintenance };
}

/** A user stop is the last word: rebuilding the record from a fresh identity drops
 *  any maintenance token, so an in-flight scope edit will not resurrect the daemon
 *  the user just asked to switch off. */
export async function stopDaemonAndRecordDesired(root: string, deps: StartStopDeps = {}): Promise<void> {
  const abs = path.resolve(root);
  const identity = await desiredContext(abs, "stopped", deps);
  await mutateDesiredRecord(abs, (current) => stopUnderDesiredLock(abs, deps, identity, current));
}

export class DaemonMaintenanceConflictError extends Error {
  constructor() {
    super("another rbox command is already holding background sync for maintenance — re-run this in a moment");
    this.name = "DaemonMaintenanceConflictError";
  }
}

/** The open maintenance window on this workspace, if any. */
export async function readDaemonMaintenance(root: string): Promise<DaemonMaintenance | undefined> {
  return (await readDesiredRecord(desiredStatePath(path.resolve(root))))?.maintenance;
}

/**
 * Stop the daemon under a durable obligation to bring it back: the record reads
 * "stopped for maintenance, resume to X", never a bare "stopped". Claim and stop
 * share ONE critical section — the token is on disk before the process is touched,
 * and no `rbox stop` can slip between the two writes and have its cancellation
 * overwritten by the second one.
 */
export async function parkDaemonForMaintenance(root: string, id: string, deps: StartStopDeps = {}): Promise<void> {
  const abs = path.resolve(root);
  const identity = await desiredContext(abs, "running", deps);
  const at = (deps.now ?? (() => new Date()))().toISOString();
  await withDesiredRecordLock(abs, async (io) => {
    const current = await io.read();
    const held = current?.maintenance;
    // Someone else's live window. Scope transitions are serialized by their own
    // lock, so this can only mean that lock did not hold — never take it over.
    if (held !== undefined && held.id !== id) throw new DaemonMaintenanceConflictError();
    const maintenance: DaemonMaintenance = { id, resume: held?.resume ?? current?.state ?? "running", at };
    await io.write({ ...(current ?? identity), maintenance });
    await io.write(await stopUnderDesiredLock(abs, deps, identity, current, maintenance));
  });
}

/**
 * Close the maintenance window opened by exactly `id`. Any other token means the
 * obligation is not ours: a no-op.
 *
 * The obligation is consumed LAST. The commitment to resume is written first, with
 * the token retained, so a start that fails or a crash before it completes still
 * leaves a window for the next attempt to find — and because the start is fenced on
 * the exact record that commitment wrote, a concurrent `rbox stop` either lands
 * before it (the window is already gone) or after it (its record wins and the start
 * stands down), never in between. Re-entering with the daemon already up simply
 * consumes the window.
 */
export async function resumeDaemonAfterMaintenance(root: string, id: string, deps: StartStopDeps = {}): Promise<boolean> {
  const abs = path.resolve(root);
  const committed = await mutateDesiredRecord(abs, (current) => {
    if (current?.maintenance?.id !== id) return undefined;
    if (current.maintenance.resume !== "running") {
      const { maintenance: _closed, ...rest } = current;
      return rest;
    }
    return { ...current, state: "running" as const, at: (deps.now ?? (() => new Date()))().toISOString() };
  });
  if (committed?.state !== "running" || committed.maintenance?.id !== id) return false;
  const started = await startDaemonAndRecordDesiredImpl(abs, {
    ...deps,
    resumeExpected: committed,
    trustedDesiredIdentity: committed,
  });
  if (!started) return false;
  await clearMaintenance(abs, id);
  return true;
}

async function clearMaintenance(abs: string, id: string): Promise<void> {
  await mutateDesiredRecord(abs, (current) => {
    if (current?.maintenance?.id !== id) return undefined;
    const { maintenance: _consumed, ...rest } = current;
    return rest;
  });
}

/** Opportunistically accept durable user intent when the current pidfile and
 * ambient status provide a matching, boot-bound daemon witness. Intent remains
 * durable if this helper is never called or cannot prove a match. */
export async function promotePendingModeIntent(root: string, deps: Pick<DesiredDeps, "now"> = {}): Promise<boolean> {
  const abs = path.resolve(root);
  const observed = await readDesiredRecord(desiredStatePath(abs));
  if (observed?.pendingModeIntent === undefined) return false;
  let promoted = false;
  await mutateDesiredRecord(abs, (current) => {
    const pending = current?.pendingModeIntent;
    if (current === undefined || current.state !== "running" || pending === undefined) return undefined;
    if (current.workspaceId !== currentWorkspaceId(abs)) return undefined;
    const witness = readDaemonModeWitness(abs);
    if (witness.kind !== "known" || witness.mode !== pending) return undefined;
    promoted = true;
    return desiredWithModes({
      ...current,
      at: (deps.now ?? (() => new Date()))().toISOString(),
    }, pending);
  });
  return promoted;
}
