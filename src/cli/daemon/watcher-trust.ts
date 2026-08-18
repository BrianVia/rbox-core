/** Never: subscription/re-arm attempt lifecycle, matcher generation/construction, scan execution, scheduler cadence/timers, drift records, or status persistence. */
import crypto from "node:crypto";
import {
  effectiveIgnoreRules,
  nativePruneCoverageComplete,
  nativePruneGlobs,
  type IgnoreMatcher,
} from "../../engine/index.js";
import {
  classifyWatcherError,
  recordWatcherDropEpisode,
  RETRUST_DROP_WINDOW_MS,
  RETRUST_FUSE_DROPS,
  RETRUST_HOLD_MAX_MS,
  RETRUST_MIN_QUIET_TICKS,
  retrustEnabled,
  SAFETY_SYNC_MS,
  type TrustState,
} from "./policy.js";

export interface WatcherArmAuthority {
  readonly matcherGeneration: number;
  readonly admission: readonly string[];
  readonly authorityFingerprint: string;
  readonly coverage: "complete" | "structural-conflict";
  readonly matcher: IgnoreMatcher;
}

export type WatcherArmCertification = Pick<WatcherArmAuthority, "admission" | "authorityFingerprint" | "coverage">;

export interface WatcherTrustClock {
  monotonicNow(): number;
}

export interface WatcherTrustPort {
  watcher(): { readonly backend: "parcel" | "chokidar" } | undefined;
  respectGitignore(): boolean;
  knownGitRepos(): readonly string[];
  externalLocalWorkSettled(): boolean;
  fuseSession(): void;
  fatalSession(): void;
  contaminateAudits(input: { watcherHealthy: false; trustState?: TrustState }): void;
  statusChanged(): void;
  pinSafetyFloor(): void;
  log(line: string): void;
}

export interface WatcherTrustSnapshot {
  readonly live: boolean;
  readonly state: TrustState;
  readonly degraded: boolean;
  readonly errorGeneration: number;
  readonly eventGeneration: number;
  readonly retrustEnabled: boolean;
}

export interface WatcherOperationWitness {
  readonly errorGeneration: number;
  readonly eventGeneration: number;
}

export type WatcherTrustObservation =
  | { readonly kind: "error"; readonly error: Error }
  | { readonly kind: "watch-activity" }
  | { readonly kind: "raw-event" }
  | {
    readonly kind: "scan";
    readonly operationErrorGeneration: number;
    readonly receipt: { readonly coverage: "full-tree" | "pruned"; readonly errorGenAtStart: number };
  }
  | {
    readonly kind: "operation-complete";
    readonly operationEventGeneration: number;
    readonly pendingEvents: boolean;
    readonly refreshedLocalTruth: boolean;
  }
  | { readonly kind: "safety-tick"; readonly churned: boolean }
  | { readonly kind: "session-installed"; readonly admissionFingerprint: string }
  | { readonly kind: "watch-unavailable" }
  | { readonly kind: "rearmed"; readonly errorGeneration: number }
  | { readonly kind: "matcher-rebuilt"; readonly matcher: IgnoreMatcher };

export class WatcherTrust {
  private healthy = true;
  private state: TrustState = "trusted";
  private degraded = false;
  private errorGeneration = 0;
  private lastTrustedErrorGeneration = 0;
  private transientDropTimestamps: number[] = [];
  private transientEpisodeFirstMs: number | undefined;
  private lastTransientDropMs = 0;
  private recoveryHoldMs = 0;
  private livenessSinceDrop = false;
  private cleanUnprunedScanThisEpisode = false;
  private consecutiveQuietSafetyTicks = 0;
  private unsettled = false;
  private unsettledGeneration = 0;
  private nativePruneKey: string;
  private monotonicLastMs: number;

  constructor(
    private readonly root: string,
    private readonly port: WatcherTrustPort,
    private readonly clock: WatcherTrustClock = { monotonicNow: () => performance.now() },
  ) {
    this.nativePruneKey = nativePruneGlobs(root).join("\n");
    const start = clock.monotonicNow();
    this.monotonicLastMs = Number.isFinite(start) ? Math.max(0, start) : 0;
  }

  observe(observation: Extract<WatcherTrustObservation, { kind: "raw-event" }>): { wasUnsettled: boolean };
  observe(observation: Exclude<WatcherTrustObservation, { kind: "raw-event" }>): void;
  observe(observation: WatcherTrustObservation): void | { wasUnsettled: boolean } {
    switch (observation.kind) {
      case "error": this.observeError(observation.error); return;
      case "watch-activity": this.livenessSinceDrop = true; return;
      case "raw-event": {
        const wasUnsettled = this.unsettled;
        this.livenessSinceDrop = true;
        this.unsettled = true;
        this.unsettledGeneration++;
        return { wasUnsettled };
      }
      case "scan": this.observeScan(observation.operationErrorGeneration, observation.receipt); return;
      case "operation-complete":
        if (this.unsettled
          && this.unsettledGeneration <= observation.operationEventGeneration
          && !observation.pendingEvents
          && observation.refreshedLocalTruth) this.unsettled = false;
        return;
      case "safety-tick":
        this.consecutiveQuietSafetyTicks = observation.churned ? 0 : this.consecutiveQuietSafetyTicks + 1;
        return;
      case "session-installed":
        this.nativePruneKey = observation.admissionFingerprint;
        if (this.state === "fused") this.port.fuseSession();
        return;
      case "watch-unavailable":
        this.degraded = true;
        this.port.statusChanged();
        return;
      case "rearmed":
        this.lastTrustedErrorGeneration = observation.errorGeneration;
        this.setState("trusted", `re-armed after witnessed full-tree scan (errorGen=${observation.errorGeneration})`);
        this.degraded = false;
        this.resetSuspectEpisode();
        this.port.statusChanged();
        return;
      case "matcher-rebuilt": this.observeMatcherRebuilt(observation.matcher); return;
    }
  }

  trustedForPull(): boolean {
    return this.liveForPrunedScan() && this.state === "trusted" && !this.degraded;
  }

  liveForPrunedScan(): boolean {
    return this.port.watcher() !== undefined && this.healthy;
  }

  liveEnoughToSkipSafetyScan(): boolean {
    return this.liveForPrunedScan() || (retrustEnabled()
      && this.state === "suspect"
      && this.livenessSinceDrop
      && this.cleanUnprunedScanThisEpisode
      && this.consecutiveQuietSafetyTicks >= RETRUST_MIN_QUIET_TICKS);
  }

  localSettled(): boolean {
    return !this.unsettled && this.port.externalLocalWorkSettled();
  }

  captureOperation(): WatcherOperationWitness {
    return { errorGeneration: this.errorGeneration, eventGeneration: this.unsettledGeneration };
  }

  snapshot(): WatcherTrustSnapshot {
    return {
      live: this.liveForPrunedScan(),
      state: this.state,
      degraded: this.degraded,
      errorGeneration: this.errorGeneration,
      eventGeneration: this.unsettledGeneration,
      retrustEnabled: retrustEnabled(),
    };
  }

  armAuthority(matcherGeneration: number, matcher: IgnoreMatcher): WatcherArmAuthority {
    return { matcherGeneration, matcher, ...this.armCertification(matcher) };
  }

  armCertification(matcher: IgnoreMatcher): WatcherArmCertification {
    const admission = nativePruneGlobs(this.root);
    const authorityFingerprint = crypto.createHash("sha256").update(JSON.stringify({
      respectGitignore: this.port.respectGitignore(),
      knownGitRepos: [...this.port.knownGitRepos()].sort(),
      rules: effectiveIgnoreRules(this.root),
    })).digest("hex");
    return {
      admission,
      authorityFingerprint,
      coverage: nativePruneCoverageComplete(this.root, admission, matcher) ? "complete" : "structural-conflict",
    };
  }

  private observeError(error: Error): void {
    if (!retrustEnabled()) {
      if (this.healthy) this.port.log(`watcher error: ${error.message} — safety scan pinned to its ${Math.round(SAFETY_SYNC_MS / 1000)}s floor`);
      this.healthy = false;
      this.degraded = true;
      this.errorGeneration++;
      this.port.contaminateAudits({ watcherHealthy: false });
      this.port.statusChanged();
      this.port.pinSafetyFloor();
      return;
    }
    this.degraded = true;
    this.errorGeneration++;
    this.resetSuspectEpisode();
    const fatal = classifyWatcherError(error.message) === "fatal";
    if (fatal) this.port.fatalSession();
    if (this.state === "fused") {
      this.port.statusChanged();
      this.port.pinSafetyFloor();
      return;
    }
    if (fatal) {
      this.port.log(`watcher error (fatal): ${error.message} — fused pending supervised re-arm`);
      this.setState("fused", "fatal error");
      this.port.fuseSession();
    } else {
      const now = this.monotonicNow();
      const episodes = recordWatcherDropEpisode({
        currentFirstMs: this.transientEpisodeFirstMs,
        startsMs: this.transientDropTimestamps,
      }, now);
      this.transientEpisodeFirstMs = episodes.currentFirstMs;
      this.transientDropTimestamps = [...episodes.startsMs];
      this.lastTransientDropMs = now;
      this.logTransientDropDiagnostic(now);
      const drops = this.transientDropTimestamps.length;
      if (drops >= RETRUST_FUSE_DROPS) {
        this.port.log(`watcher trust FUSED: ${drops} transient drop episodes within ${RETRUST_DROP_WINDOW_MS}ms — safety-scan-only pending supervised re-arm`);
        this.setState("fused", `fuse ${drops}/${RETRUST_FUSE_DROPS}`);
        this.port.fuseSession();
      } else {
        this.recoveryHoldMs = Math.min(SAFETY_SYNC_MS * 2 ** (drops - 1), RETRUST_HOLD_MAX_MS);
        if (this.state === "trusted") this.port.log(`watcher error (transient overflow): ${error.message} — safety scan pinned; recovering`);
        this.port.log(`retrust drop: window=${drops}/${RETRUST_FUSE_DROPS} wouldFuse=n hold=${this.recoveryHoldMs}ms`);
        this.setState("suspect", `transient drop ${drops}`);
      }
    }
    this.port.statusChanged();
    this.port.pinSafetyFloor();
  }

  private observeScan(operationErrorGeneration: number, receipt: { coverage: "full-tree" | "pruned"; errorGenAtStart: number }): void {
    const stable = this.port.watcher() !== undefined && this.degraded && this.errorGeneration === operationErrorGeneration;
    if (stable) {
      this.degraded = false;
      this.port.statusChanged();
    }
    if (!retrustEnabled()) return;
    const clean = this.port.watcher() !== undefined
      && receipt.coverage === "full-tree"
      && receipt.errorGenAtStart === this.errorGeneration;
    if (!clean || this.state !== "suspect") return;
    this.cleanUnprunedScanThisEpisode = true;
    if (this.errorGeneration > this.lastTrustedErrorGeneration
      && this.monotonicNow() - this.lastTransientDropMs >= this.recoveryHoldMs) {
      this.lastTrustedErrorGeneration = this.errorGeneration;
      this.setState("trusted", `re-trusted after clean full-tree scan (errorGen=${this.errorGeneration})`);
      this.degraded = false;
      this.resetSuspectEpisode();
      this.port.statusChanged();
    }
  }

  private observeMatcherRebuilt(matcher: IgnoreMatcher): void {
    const backend = this.port.watcher()?.backend;
    if (backend === undefined || this.state === "fused") return;
    const admission = nativePruneGlobs(this.root);
    const stale = backend === "chokidar"
      || admission.join("\n") !== this.nativePruneKey
      || !nativePruneCoverageComplete(this.root, admission, matcher);
    if (!stale) return;
    this.port.log("watcher downgraded: ignore-rule change alters native watch coverage — pulls scan pending supervised re-arm");
    this.setState("fused", "native watch coverage changed");
    this.port.fuseSession();
    this.port.statusChanged();
    this.port.pinSafetyFloor();
  }

  private setState(next: TrustState, reason: string): void {
    if (this.state === next) return;
    this.state = next;
    this.healthy = next === "trusted";
    if (next !== "trusted") this.port.contaminateAudits({ watcherHealthy: false, trustState: next });
    this.port.log(`watcher trust ${this.state} (${reason})`);
  }

  private resetSuspectEpisode(): void {
    this.livenessSinceDrop = false;
    this.cleanUnprunedScanThisEpisode = false;
    this.consecutiveQuietSafetyTicks = 0;
  }

  private monotonicNow(): number {
    const raw = this.clock.monotonicNow();
    if (Number.isFinite(raw)) this.monotonicLastMs = Math.max(this.monotonicLastMs, raw);
    return this.monotonicLastMs;
  }

  private logTransientDropDiagnostic(atMs: number): void {
    setTimeout(() => {
      const lagMs = Math.max(0, this.monotonicNow() - atMs);
      this.port.log(`watcher transient drop diagnostic: monotonicMs=${Math.floor(atMs)} eventLoopLagMs=${Math.floor(lagMs)}`);
    }, 0);
  }
}
