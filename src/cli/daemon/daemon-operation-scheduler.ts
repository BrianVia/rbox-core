import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { writeFileAtomic } from "../../engine/index.js";
import type { DaemonMutexResult, WorkspaceSyncMutex } from "../sync-mutex.js";
import { selectPumpOperation, type PumpOperation, type Wants } from "./policy.js";
import type { JsonValue } from "../../json.js";

/**
 * `ServiceNextDaemonOperation` — the single-flight heart of the daemon (design 178).
 *
 * This owns WHICH operation runs next and under what conditions it may run at all:
 * the wakeup queue, the recovery episode's fairness counters and probe timer, the
 * workspace-mutex backoff and starvation episode, the active operation, and the
 * single-flight/drain state. Nothing else may hold a queue: a caller asks for work
 * with {@link DaemonOperationScheduler.request} or
 * {@link DaemonOperationScheduler.queue} and is told which operation to execute
 * through {@link DaemonOperationExecutor}.
 *
 * It owns no sync semantics. What a pull, push, scan, or recovery probe DOES —
 * and how a failure is recorded — belongs to the executor.
 */

const LOCK_STARVATION_MS = 15 * 60_000;
const LOCK_STARVATION_MAX_BYTES = 4 * 1024;
const MUTEX_BACKOFF_TIERS = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const MUTEX_EARLY_REPROBE_MS = 2_000;
/** Breaker for a selection the loop can neither run nor park on: selecting without
 *  consuming is an unbounded allocating spin, not a slow loop. */
const NO_PROGRESS_ITERATION_BOUND = 3;

/** The kinds of work a caller may ask the daemon to do. The recovery probe is not
 *  one: it is the scheduler's own response to a standing halt. */
export type DaemonWakeup = keyof Wants;

/** The recovery probe's timer seam. `THandle` is whatever the injected clock's
 *  `setTimeout` hands back — a Node `Timeout` in production, a test clock's own
 *  token under test. The scheduler never inspects it; it only ever returns it to
 *  the clock that issued it, so the issuer owns the type. */
export interface DaemonSchedulerClock<THandle = unknown> {
  setTimeout(fn: () => void, ms: number): THandle;
  clearTimeout(handle: THandle): void;
}

/** The standing halt, read-only: the halt RECORD is the runtime-observation owner's.
 *  The scheduler needs only which operation it holds and the identity it was armed
 *  against, so a superseded episode's timer cannot make a stale probe due. */
export interface StandingHaltFacts {
  readonly op: DaemonWakeup;
  readonly witness: string;
}

export interface DaemonSchedulerPorts {
  readonly root: string;
  now(): number;
  log(line: string): void;
  readonly recoveryClock: DaemonSchedulerClock;
  acquireMutex(root: string): Promise<DaemonMutexResult>;
  releaseMutex(handle: WorkspaceSyncMutex): Promise<void>;
  isStopped(): boolean;
  /** Re-entry after a drained loop is authorized only while the daemon is live and
   *  reset authority is ready. */
  readyForReentry(): boolean;
  standingHalt(): StandingHaltFacts | undefined;
  /** Count one starvation episode durably. Called at most once per episode. */
  countLockStarvation(): Promise<void>;
  /** Re-enter servicing from a timer callback. */
  wake(): void;
}

/** The typed transitions the scheduler drives. Each call is made with the workspace
 *  mutex held and exactly one selected operation. */
export interface DaemonOperationExecutor {
  /** Reset authority, crash-lock recovery, and binding revalidation, in that order.
   *  `false` ends the loop WITHOUT consuming the selected operation. */
  openOperationBoundary(mutex: WorkspaceSyncMutex): Promise<boolean>;
  /** The dequeued operation's own prologue, run before the active operation is
   *  published — bookkeeping that must still render against an idle active surface
   *  (the recovery probe's halt record) belongs here, not in `runOperation`. */
  beginOperation?(op: PumpOperation): void;
  /** Run the dequeued operation with its own bookkeeping and failure classification. */
  runOperation(op: PumpOperation, mutex: WorkspaceSyncMutex): Promise<void>;
  /** Persistence and report settlement at a completed operation's boundary, and
   *  once for a loop that completed none. */
  settleOperationBoundary(): Promise<void>;
}

export interface DaemonSchedulerDrainReceipt {
  /** True only if a loop is still in flight after the drain — never for a stop. */
  readonly servicing: boolean;
  readonly activeOperation: PumpOperation | undefined;
  readonly queued: Readonly<Wants>;
}

/** One tier of the workspace-mutex backoff: how long to wait, and whether this
 *  tier is the first observation worth logging. */
export interface MutexBackoffStep {
  delayMs: number;
  shouldLog: boolean;
}

export interface LockStarvationEpisode {
  holderKey: string;
  firstSeenAt: number;
  warnedAt?: number;
  countedAt?: number;
}

/** The decoded episode file, keyed by the members this record owns: exactly what
 *  `JSON.parse` produced for its bytes. */
type LockStarvationEpisodeCandidate = Partial<Record<keyof LockStarvationEpisode, JsonValue>>;

export const lockStarvationPath = (root: string): string => path.join(root, ".rbox", "state", "lock-starvation.json");

const episodeTime = (value: JsonValue | undefined): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

export async function readLockStarvationEpisode(root: string): Promise<LockStarvationEpisode | undefined> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(lockStarvationPath(root), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > LOCK_STARVATION_MAX_BYTES) return undefined;
    const raw = await handle.readFile("utf8");
    if (Buffer.byteLength(raw) > LOCK_STARVATION_MAX_BYTES) return undefined;
    const parsed = JSON.parse(raw) as LockStarvationEpisodeCandidate;
    const keys = Object.keys(parsed);
    if (keys.some((key) => !["holderKey", "firstSeenAt", "warnedAt", "countedAt"].includes(key))) return undefined;
    if (typeof parsed.holderKey !== "string" || !/^[0-9a-f]{64}$/.test(parsed.holderKey)) return undefined;
    if (!episodeTime(parsed.firstSeenAt)) return undefined;
    if (parsed.warnedAt !== undefined && !episodeTime(parsed.warnedAt)) return undefined;
    if (parsed.countedAt !== undefined && !episodeTime(parsed.countedAt)) return undefined;
    return {
      holderKey: parsed.holderKey,
      firstSeenAt: parsed.firstSeenAt,
      ...(parsed.warnedAt === undefined ? {} : { warnedAt: parsed.warnedAt }),
      ...(parsed.countedAt === undefined ? {} : { countedAt: parsed.countedAt }),
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function saveLockStarvationEpisode(root: string, episode: LockStarvationEpisode): Promise<void> {
  await fs.mkdir(path.dirname(lockStarvationPath(root)), { recursive: true });
  await writeFileAtomic(lockStarvationPath(root), JSON.stringify(episode));
}

export function lockStarvationAgeBucket(ageMs: number): "15m" | "1h" | "1d" {
  if (ageMs >= 24 * 60 * 60_000) return "1d";
  if (ageMs >= 60 * 60_000) return "1h";
  return "15m";
}

export class DaemonOperationScheduler {
  readonly wants: Wants = { pull: false, push: false, fullScan: false, deepScan: false };
  /** The single-flight guard and the in-flight loop shutdown drains. */
  pumping = false;
  pumpRun: Promise<void> = Promise.resolve();
  activePumpOp?: PumpOperation;
  recoveryDue = false;
  recoveryDequeuesSinceDue = 0;
  recoveryTimer?: unknown;
  lockStarvationEpisode?: LockStarvationEpisode;
  mutexBackoffController?: AbortController;
  private mutexHolderKey?: string;
  private mutexBackoffTier = 0;
  private mutexLoggedTier = -1;
  private lastMutexEarlyReprobeAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly ports: DaemonSchedulerPorts) {}

  /** An external wakeup: queue the work and cut a parked mutex backoff short. */
  request(wakeup: DaemonWakeup): void {
    this.wants[wakeup] = true;
    this.signalMutexEarlyReprobe();
  }

  /** Queue work without disturbing an in-flight backoff — the caller is already
   *  inside the loop, or is re-queueing work the loop just failed to complete. */
  queue(wakeup: DaemonWakeup): void {
    this.wants[wakeup] = true;
  }

  /** True when nothing is queued and nothing is running. */
  get quiescent(): boolean {
    return this.activePumpOp === undefined
      && !this.wants.pull
      && !this.wants.push
      && !this.wants.fullScan
      && !this.wants.deepScan;
  }

  /** Which operation this iteration would run. A standing halt makes its own
   *  operation ineligible ambiently: only its matching recovery probe may heal it. */
  nextOperation(): PumpOperation | undefined {
    const eligible = { ...this.wants };
    const halt = this.ports.standingHalt();
    if (halt) eligible[halt.op] = false;
    return selectPumpOperation(eligible, this.recoveryDue, this.recoveryDequeuesSinceDue);
  }

  /** Retire the published active operation at the executor's own bookkeeping
   *  boundary, before it renders anything that reads the active surface. */
  markOperationIdle(): void {
    this.activePumpOp = undefined;
  }

  // ---- recovery episode ----------------------------------------------------

  /** Arm the standing probe. The witness is re-checked when the timer fires so a
   *  superseded episode's timer can never make a retired probe due. */
  armRecoveryProbe(delayMs: number, witness: string): void {
    this.clearRecoveryTimer();
    this.recoveryTimer = this.ports.recoveryClock.setTimeout(() => {
      this.recoveryTimer = undefined;
      if (this.ports.standingHalt()?.witness !== witness) return;
      this.recoveryDue = true;
      this.recoveryDequeuesSinceDue = 0;
      this.ports.wake();
    }, delayMs);
  }

  /** Retire the episode: healed, or parked because this daemon cannot service it. */
  clearRecoveryEpisode(): void {
    this.clearRecoveryTimer();
    this.recoveryDue = false;
    this.recoveryDequeuesSinceDue = 0;
  }

  /** A fresh failure supersedes the due probe; the caller re-arms from its record. */
  disarmRecoveryDue(): void {
    this.recoveryDue = false;
  }

  private clearRecoveryTimer(): void {
    if (this.recoveryTimer) this.ports.recoveryClock.clearTimeout(this.recoveryTimer);
    this.recoveryTimer = undefined;
  }

  // ---- mutex backoff and starvation ---------------------------------------

  signalMutexEarlyReprobe(): void {
    if (!this.mutexBackoffController) return;
    const now = this.ports.now();
    if (now - this.lastMutexEarlyReprobeAt < MUTEX_EARLY_REPROBE_MS) return;
    this.lastMutexEarlyReprobeAt = now;
    this.mutexBackoffController?.abort();
  }

  abortMutexBackoff(): void {
    this.mutexBackoffController?.abort();
  }

  mutexDelay(holderKey: string): MutexBackoffStep {
    if (this.mutexHolderKey !== holderKey) {
      this.mutexHolderKey = holderKey;
      this.mutexBackoffTier = 0;
      this.mutexLoggedTier = -1;
    } else {
      this.mutexBackoffTier = Math.min(this.mutexBackoffTier + 1, MUTEX_BACKOFF_TIERS.length - 1);
    }
    const shouldLog = this.mutexLoggedTier !== this.mutexBackoffTier;
    if (shouldLog) this.mutexLoggedTier = this.mutexBackoffTier;
    return { delayMs: MUTEX_BACKOFF_TIERS[this.mutexBackoffTier]!, shouldLog };
  }

  resetMutexBackoff(): void {
    this.mutexHolderKey = undefined;
    this.mutexBackoffTier = 0;
    this.mutexLoggedTier = -1;
    this.lastMutexEarlyReprobeAt = Number.NEGATIVE_INFINITY;
  }

  async waitForMutexBackoff(delayMs: number): Promise<void> {
    if (this.ports.isStopped()) return;
    const controller = new AbortController();
    this.mutexBackoffController = controller;
    try {
      await delay(delayMs, undefined, { signal: controller.signal });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== "AbortError") throw error;
    } finally {
      if (this.mutexBackoffController === controller) this.mutexBackoffController = undefined;
    }
  }

  async clearLockStarvationEpisode(): Promise<void> {
    if (!this.lockStarvationEpisode) return;
    this.lockStarvationEpisode = undefined;
    await fs.rm(lockStarvationPath(this.ports.root), { force: true });
  }

  async observeLockContention(contention: Extract<DaemonMutexResult, { status: "contended" }>): Promise<void> {
    const reason = contention.warningReason;
    if (!reason) {
      await this.clearLockStarvationEpisode();
      return;
    }
    const now = this.ports.now();
    let episode = this.lockStarvationEpisode;
    if (!episode || episode.holderKey !== contention.holderKey) {
      episode = { holderKey: contention.holderKey, firstSeenAt: now };
      this.lockStarvationEpisode = episode;
      await saveLockStarvationEpisode(this.ports.root, episode);
      return;
    }
    const age = Math.max(0, now - episode.firstSeenAt);
    if (age < LOCK_STARVATION_MS) return;
    if (episode.warnedAt === undefined) {
      this.ports.log(`lock starved: reason=${reason} age=${lockStarvationAgeBucket(age)}`);
      episode = { ...episode, warnedAt: now };
      this.lockStarvationEpisode = episode;
      await saveLockStarvationEpisode(this.ports.root, episode);
    }
    if (episode.countedAt === undefined) {
      episode = { ...episode, countedAt: now };
      this.lockStarvationEpisode = episode;
      // Persist the episode fence before the metric: a crash may lose one count,
      // but can never count the same starvation episode twice.
      await saveLockStarvationEpisode(this.ports.root, episode);
      await this.ports.countLockStarvation();
    }
  }

  // ---- servicing ------------------------------------------------------------

  /** Single-flight: a second caller joins the loop already in flight. */
  service(executor: DaemonOperationExecutor): Promise<void> {
    if (this.ports.isStopped()) return Promise.resolve();
    if (this.pumping) return this.pumpRun;
    this.pumping = true;
    const run = this.serviceLoop(executor);
    this.pumpRun = run;
    return run;
  }

  /** Disarm every scheduler timer and drain the in-flight loop. The committed
   *  operation completes; only queued work is skipped. */
  async stop(): Promise<DaemonSchedulerDrainReceipt> {
    this.abortMutexBackoff();
    this.clearRecoveryTimer();
    await this.pumpRun.catch(() => {});
    return { servicing: this.pumping, activeOperation: this.activePumpOp, queued: { ...this.wants } };
  }

  /** Consume the selected operation. Returns undefined when the probe's halt has
   *  already been retired and there is nothing to service. */
  private dequeue(op: PumpOperation): PumpOperation | undefined {
    if (op === "recoveryProbe") {
      const halt = this.ports.standingHalt();
      this.recoveryDue = false;
      this.recoveryDequeuesSinceDue = 0;
      if (!halt) return undefined;
      this.wants[halt.op] = false;
      return op;
    }
    this.wants[op] = false;
    if (this.recoveryDue) this.recoveryDequeuesSinceDue++;
    return op;
  }

  private async serviceLoop(executor: DaemonOperationExecutor): Promise<void> {
    // A refused boundary — or a selection this loop cannot consume — parks the
    // queue: only the NEXT external wakeup may retry it. Exit-time re-entry
    // would hot-loop against the same refusal with the wants unconsumed.
    let parked = false;
    let noProgress = 0;
    let settled = false;
    try {
      while (!this.ports.isStopped()) {
        // Resolve WHICH op this iteration runs up front — the executor's halt
        // bookkeeping is keyed on it (a halt is only healed by a success of the
        // SAME kind).
        const op = this.nextOperation();
        if (!op) break;
        const acquired = await this.ports.acquireMutex(this.ports.root);
        if (acquired.status === "contended") {
          // Do not clear wants[op]: contention must requeue, never consume, this tick.
          await this.observeLockContention(acquired).catch(() => {
            this.ports.log("lock starvation state unavailable");
          });
          const backoff = this.mutexDelay(acquired.holderKey);
          if (backoff.shouldLog) this.ports.log(`pump op ${op}: sync busy; re-queued (backoff ${backoff.delayMs}ms)`);
          await this.waitForMutexBackoff(backoff.delayMs);
          noProgress = 0;
          continue;
        }
        this.resetMutexBackoff();
        await this.clearLockStarvationEpisode().catch(() => {
          this.ports.log("lock starvation state unavailable");
        });
        const syncMutex = acquired.handle;
        try {
          if (!await executor.openOperationBoundary(syncMutex)) { parked = true; break; }
          const dequeued = this.dequeue(op);
          if (!dequeued) {
            if (++noProgress < NO_PROGRESS_ITERATION_BOUND) continue;
            this.ports.log(`pump op ${op}: selected but not serviceable ${noProgress}x; parking the queue`);
            parked = true;
            break;
          }
          noProgress = 0;
          executor.beginOperation?.(dequeued);
          this.activePumpOp = dequeued;
          try {
            await executor.runOperation(dequeued, syncMutex);
          } finally {
            this.activePumpOp = undefined;
          }
        } finally {
          await this.ports.releaseMutex(syncMutex);
        }
        // The lane has handed off, so settle HERE and not once the whole queue is
        // empty: a completed push's report used to wait out every later queued
        // operation — in the field, a 47s pull it had itself provoked (#661).
        await executor.settleOperationBoundary();
        settled = true;
      }
      if (!settled) await executor.settleOperationBoundary();
    } finally {
      this.pumping = false;
      // A timer/watcher can queue work after the loop observes no operation but
      // before exit-time persistence completes. Re-enter after dropping the
      // single-flight guard so that wakeup cannot be lost.
      if (!parked && this.ports.readyForReentry() && this.nextOperation()) await this.service(executor);
    }
  }
}
