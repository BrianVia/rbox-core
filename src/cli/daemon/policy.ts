import { UNPRUNED_DEADLINE_MS, ManifestChainError } from "../../engine/index.js";
import type { SuffixInfo } from "../chain-repair.js";
import { envInt } from "../remote/resilient.js";
import type { DaemonMutexResult } from "../sync-mutex.js";

export const SAFETY_SYNC_MS = 60_000; // frequent stat-only reconcile (heals dropped events)
const SAFETY_SYNC_MAX_MS = 5 * 60_000; // idle-backoff cap for the safety scan (design 49)
export const retrustEnabled = () => process.env.RBOX_WATCHER_RETRUST !== "0";
// Soak-tunable (design 104 §Constants): W / M / K, floored at 1 (envInt clamps).
export const RETRUST_DROP_WINDOW_MS = envInt("RBOX_WATCHER_RETRUST_W_MS", 10 * 60_000, 1, Number.MAX_SAFE_INTEGER);
export const RETRUST_EPISODE_COALESCE_MS = 5_000;
// M keeps its design-104 name/env surface, but design 237 deliberately changes
// its unit from raw error callbacks to first-drop-anchored overflow episodes.
export const RETRUST_FUSE_DROPS = envInt("RBOX_WATCHER_RETRUST_M", 6, 1, Number.MAX_SAFE_INTEGER);
export const RETRUST_HOLD_MAX_MS = SAFETY_SYNC_MAX_MS;
export const RETRUST_MIN_QUIET_TICKS = envInt("RBOX_WATCHER_RETRUST_K", 3, 1, Number.MAX_SAFE_INTEGER);
export const GC_FENCE_RETRY_MS = 6 * 60 * 60_000; // open purge intents live 24–48h; never hot-reupload
// Infrequent cache-bypassing re-hash (heals mtime+size-stable drift). Intentionally
// THE SAME constant as the dircache's unpruned deadline (design 85 §3.1 decision 8):
// the daemon's scheduled unpruned deep scan is exactly the periodic unpruned rebuild
// the dircache staleness bound relies on, so one knob governs both by design.
export const DEEP_SCAN_MS = UNPRUNED_DEADLINE_MS;
const RECONNECT_BASE_MS = 500;
const RECONNECT_MAX_MS = 30_000;
const RECONNECT_SPREAD_MS = 3_000;
export const WS_PING_MS = 25_000;
export const WS_KEEPALIVE_PERSIST_MS = 20_000;
export const WS_PONG_DEADLINE_DEFAULT_MS = 60_000; // 2 ping intervals (50s) + 10s grace
export const WS_CURSOR_CHECK_MS = 45_000;
export const POLL_BACKSTOP_DEFAULT_MS = 300_000; // 5 min = safety-scan idle cap
export const ACTIVITY_HEARTBEAT_MS = 30_000;
export const UPDATE_CHECK_TICK_MS = 60 * 60_000;

/** Stateful daemon policy for automatic chain repair. Exported as a narrow test
 * seam: the recovery mechanics live in repairChain; this owns only authorship
 * consent and terminal-head suppression. */
export class DaemonChainRepairPolicy {
  private terminalHeadFingerprint = "";
  private terminalHaltMessage = "";

  constructor(private readonly deviceId: string) {}

  confirmSupersede(suffix: SuffixInfo[]): boolean {
    return suffix.every((item) => item.deviceId === this.deviceId);
  }

  assertHeadAllowed(pin: { commitSeq: number; commitHash: string } | undefined): void {
    if (!pin || !this.terminalHeadFingerprint) return;
    if (`${pin.commitSeq}:${pin.commitHash}` === this.terminalHeadFingerprint) {
      throw new Error(this.terminalHaltMessage);
    }
  }

  halt(error: ManifestChainError, suffix: SuffixInfo[]): Error {
    const detail = suffix.map((item) => `${item.seq}:${item.deviceId}`).join(",");
    const message = `MANIFEST CHAIN HALT [${detail}] ${suffix[0]?.reason ?? error.reason}; run rbox recover`;
    if (error.head) {
      this.terminalHeadFingerprint = `${error.head.seq}:${error.head.hash}`;
      this.terminalHaltMessage = message;
    }
    return new ChainRepairHaltError(message);
  }

  clear(): void {
    this.terminalHeadFingerprint = "";
    this.terminalHaltMessage = "";
  }
}

export class ChainRepairHaltError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChainRepairHaltError";
  }
}

export type TrustState = "trusted" | "suspect" | "fused";
export const worseTrust = (a: TrustState, b: TrustState): TrustState => {
  const rank: Record<TrustState, number> = { trusted: 0, suspect: 1, fused: 2 };
  return rank[a] >= rank[b] ? a : b;
};

export function classifyWatcherError(message: string): "transient" | "fatal" {
  const m = message.toLowerCase();
  return m.includes("were dropped") || m.includes("must be re-scanned") ? "transient" : "fatal";
}

export interface WatcherDropEpisodes {
  /** First drop of the current half-open coalescing interval. */
  currentFirstMs?: number;
  /** First drop of each episode still inside the strict rolling window. */
  startsMs: readonly number[];
}

/** Pure design-237 episode arithmetic. `now` is supplied by the daemon's clamped
 * monotonic clock, so wall-clock jumps cannot stretch or collapse an episode. */
export function recordWatcherDropEpisode(
  state: WatcherDropEpisodes,
  now: number,
  coalesceMs = RETRUST_EPISODE_COALESCE_MS,
  windowMs = RETRUST_DROP_WINDOW_MS,
): WatcherDropEpisodes & { started: boolean } {
  const startsMs = state.startsMs.filter((ts) => ts > now - windowMs);
  const first = state.currentFirstMs;
  const inCurrent = first !== undefined && now >= first && now < first + coalesceMs;
  if (inCurrent) return { currentFirstMs: first, startsMs, started: false };
  return { currentFirstMs: now, startsMs: [...startsMs, now], started: true };
}

export interface Wants {
  pull: boolean;
  push: boolean;
  fullScan: boolean;
  deepScan: boolean;
}

export type PumpOperation = keyof Wants | "recoveryProbe";
export const RECOVERY_PROBE_SERVICE_BOUND = 8;
export const RECOVERY_PROBE_BASE_MS = 5_000;
export const RECOVERY_PROBE_CAP_MS = 120_000;

/** Design 178 B full-jitter episode delay. Failure 1 has a 5s ceiling. */
export function recoveryProbeDelayMs(consecutiveFailures: number, random: () => number = Math.random): number {
  const exponent = Math.max(0, Math.trunc(consecutiveFailures) - 1);
  const ceiling = Math.min(RECOVERY_PROBE_CAP_MS, RECOVERY_PROBE_BASE_MS * 2 ** exponent);
  return Math.floor(Math.max(0, Math.min(0.999999999999, random())) * ceiling);
}

export function selectPumpOperation(
  want: Wants,
  recoveryDue: boolean,
  dequeuedSinceDue: number,
): PumpOperation | undefined {
  const ambient: keyof Wants | undefined = want.deepScan ? "deepScan" : want.fullScan ? "fullScan" : want.pull ? "pull" : want.push ? "push" : undefined;
  if (recoveryDue && (ambient === undefined || dequeuedSinceDue >= RECOVERY_PROBE_SERVICE_BOUND)) return "recoveryProbe";
  return ambient;
}

/** Contention disposition pin: only a successful acquire authorizes consuming
 * the queued daemon wakeup. */
export const daemonConsumesWakeup = (result: DaemonMutexResult): boolean => result.status === "acquired";

/** ± up to 25% jitter (multiplier 0.75–1.25) so a fleet of daemons never aligns its
 *  ticks/reconnects. `random` injected for deterministic tests. */
export const jitter = (ms: number, random: () => number = Math.random) => Math.round(ms * (0.75 + random() * 0.5));

/** Reconnect delay (design 105 §5): the FIRST post-close attempt is spread
 *  uniform(0, RECONNECT_SPREAD_MS) so a deploy's fleet-wide socket close never
 *  re-handshakes in lockstep; subsequent attempts keep the existing 500ms→30s
 *  exponential backoff with ±25% jitter. Pure — `random` injected for tests. */
export function reconnectDelayMs(attempt: number, random: () => number = Math.random): number {
  if (attempt === 0) return Math.floor(random() * RECONNECT_SPREAD_MS);
  return jitter(Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** attempt), random);
}

/**
 * Next safety-scan delay (design 49), decided when a tick fires. Quiet interval
 * with a live watcher → double, capped at 5m. Churn, or no live watcher (the
 * scan is the sync mechanism there), → back to the 60s floor. Pure — the
 * doubling/cap/reset table is unit-tested without timers.
 */
export function nextSafetyDelay(current: number, opts: { watcherLive: boolean; churned: boolean; degradedBackoffEligible?: boolean; pinToFloor?: boolean }): number {
  if (opts.pinToFloor) return SAFETY_SYNC_MS;
  if (opts.churned) return SAFETY_SYNC_MS;
  if (!opts.watcherLive && !opts.degradedBackoffEligible) return SAFETY_SYNC_MS;
  return Math.min(current * 2, SAFETY_SYNC_MAX_MS);
}
