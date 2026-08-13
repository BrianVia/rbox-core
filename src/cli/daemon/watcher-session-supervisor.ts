import crypto from "node:crypto";
import type { IgnoreMatcher, WatchEvent, DiscoveredGitRepo } from "../../engine/index.js";
import { gitRefSideChannelEligible } from "./git-ref-watch.js";
import { createSignalDebouncer, startWatcher, type GitSignalBatch, type SignalDebouncer, type Watcher } from "./watcher.js";
import type { LocalObservationCommitOutcome } from "./local-observation-transition.js";

const REARM_DELAYS_MS = [120_000, 240_000, 480_000, 1_800_000] as const;

export interface WatcherArmAuthority {
  readonly matcherGeneration: number;
  readonly admission: readonly string[];
  readonly authorityFingerprint: string;
  readonly coverage: "complete" | "structural-conflict";
  readonly matcher: IgnoreMatcher;
}

export type WatcherArmCertification = Pick<WatcherArmAuthority, "admission" | "authorityFingerprint" | "coverage">;

export interface WatcherAttemptWitness {
  readonly attemptId: string;
  readonly sessionGen: number;
  readonly errorGenAtArm: number;
  readonly matcherGeneration: number;
  readonly admission: string;
  readonly authorityFingerprint: string;
  readonly recertified: boolean;
}

export interface WatcherRecoveryScanReceipt {
  readonly witness?: WatcherAttemptWitness;
  readonly coverage: "full-tree" | "pruned";
  readonly completeness: "complete" | "deferred";
  readonly deferredPaths: ReadonlySet<string>;
  readonly matcherGeneration: number;
  readonly commitDisposition: LocalObservationCommitOutcome;
}

export class WatcherRecoveryScanError extends Error {
  constructor(readonly cause: Error, readonly witness: WatcherAttemptWitness) {
    super(cause.message);
    this.name = "WatcherRecoveryScanError";
  }
}

export interface WatcherRearmTimer { cancel(): void; }
export interface WatcherRearmClock { setTimeout(fn: () => void, ms: number): WatcherRearmTimer; }

export interface WatcherSessionEffects {
  readonly root: string;
  rebuildArmAuthority(): WatcherArmAuthority;
  readArmCertification(): WatcherArmCertification;
  errorGeneration(): number;
  matcherGeneration(): number;
  retrustEnabled(): boolean;
  stopped(): boolean;
  onEvents(events: WatchEvent[]): void;
  onRawEvent(event: WatchEvent): void;
  onError(error: Error): void;
  onGitBatch(batch: GitSignalBatch): void;
  attachRefBackend(input: {
    backend: Watcher["backend"];
    initial: readonly DiscoveredGitRepo[];
    onSignal(): void;
    onArmed(): void;
  }): Promise<void>;
  detachRefBackend(): Promise<void>;
  abandonRefBackend(): Promise<void>;
  noteRefBackendUnavailable(): void;
  requestFullScan(): void;
  publishTrust(errorGeneration: number): void;
  sessionInstalled(admissionFingerprint: string): void;
  watchUnavailable(error: Error): void;
  log(message: string): void;
  startWatcher?: typeof startWatcher;
  createDebouncer?: typeof createSignalDebouncer;
  clock?: WatcherRearmClock;
}

interface LiveSession {
  readonly generation: number;
  readonly watcher: Watcher;
  readonly debouncer: SignalDebouncer;
  readonly id: string;
  readonly admission: string;
}

interface LiveAttempt {
  readonly attemptId: string;
  readonly sessionGen: number;
  readonly errorGenBeforeSubscribe: number;
  certification: "pending" | "valid" | "structural-conflict";
  witness?: WatcherAttemptWitness;
}

/**
 * The sole owner of watcher subscription replacement and fused recovery.
 * Safety/deep cadence remains boot-owned by RboxDaemon; this module owns only
 * one physical session, its generation fence, one live attempt, and one timer.
 */
export class WatcherSessionSupervisor {
  private session?: LiveSession;
  private generation = 0;
  private attempt?: LiveAttempt;
  private timer?: WatcherRearmTimer;
  private backoffStep = 0;
  private replacement?: Promise<void>;
  private stopping = false;
  private recoveryTerminal = false;
  private readonly clock: WatcherRearmClock;

  constructor(private readonly effects: WatcherSessionEffects) {
    this.clock = effects.clock ?? {
      setTimeout: (fn, ms) => {
        const handle = setTimeout(fn, ms);
        handle.unref?.();
        return { cancel: () => clearTimeout(handle) };
      },
    };
  }

  get watcher(): Watcher | undefined { return this.session?.watcher; }
  get sessionId(): string | undefined { return this.session?.id; }
  get admissionFingerprint(): string | undefined { return this.session?.admission; }
  get sessionGeneration(): number { return this.generation; }
  get activeAttempt(): WatcherAttemptWitness | undefined { return this.attempt?.witness; }
  get rearmTimer(): WatcherRearmTimer | undefined { return this.timer; }
  get nextBackoffStep(): number { return this.backoffStep; }

  drainReplacement(): Promise<void> { return this.replacement ?? Promise.resolve(); }

  startBootSession(): Promise<void> { return this.replace(false); }

  /** Enter the parcel-only supervised loop. Chokidar remains terminal. */
  fused(): void {
    if (this.recoveryTerminal || this.session?.watcher.backend !== "parcel" || this.attempt) return;
    this.scheduleNext("watcher fused");
  }

  /** Every ordinary rebuild invalidates live testimony, including while fused. */
  matcherRebuilt(): void {
    if (this.attempt) this.failAttempt(this.attempt.attemptId, "matcher rebuilt");
  }

  fatalError(): void {
    if (this.attempt) this.failAttempt(this.attempt.attemptId, "fatal watcher error");
  }

  captureScanWitness(): WatcherAttemptWitness | undefined {
    const witness = this.attempt?.witness;
    return witness && this.session?.generation === witness.sessionGen ? { ...witness } : undefined;
  }

  settleScan(receipt: WatcherRecoveryScanReceipt): void {
    const witness = receipt.witness;
    if (!witness) return;
    if (witness.attemptId !== this.attempt?.attemptId) {
      this.effects.log(`watcher re-arm stale scan inert (attempt=${witness.attemptId})`);
      return;
    }
    if (!this.effects.retrustEnabled()) {
      this.cancelRecovery("kill switch disabled");
      return;
    }
    const certification = this.effects.readArmCertification();
    if (certification.coverage === "structural-conflict") {
      this.terminalRecovery("native admission cannot cover matcher");
      return;
    }
    const valid = witness.sessionGen === this.generation
      && this.session?.generation === witness.sessionGen
      && this.effects.errorGeneration() === witness.errorGenAtArm
      && this.effects.matcherGeneration() === witness.matcherGeneration
      && receipt.matcherGeneration === witness.matcherGeneration
      && receipt.coverage === "full-tree"
      && receipt.completeness === "complete"
      && receipt.deferredPaths.size === 0
      && receipt.commitDisposition === "advanced"
      && !this.effects.stopped()
      && !this.stopping
      && witness.recertified
      && fingerprint(certification.admission) === witness.admission
      && certification.authorityFingerprint === witness.authorityFingerprint;
    if (!valid) {
      this.failAttempt(witness.attemptId, "scan testimony rejected");
      return;
    }
    this.attempt = undefined;
    this.backoffStep = 0;
    this.clearTimer();
    this.effects.publishTrust(witness.errorGenAtArm);
  }

  scanThrew(error: WatcherRecoveryScanError): boolean {
    const { witness } = error;
    if (witness.attemptId !== this.attempt?.attemptId) {
      this.effects.log(`watcher re-arm stale thrown scan inert (attempt=${witness.attemptId})`);
      return true;
    }
    this.failAttempt(witness.attemptId, `scan threw: ${error.message}`);
    return true;
  }

  stop(): Promise<void> {
    if (!this.stopping) {
      this.stopping = true;
      this.cancelRecovery("daemon stopping");
      this.generation++;
    }
    return this.finishStop();
  }

  /** Narrow compatibility seam for tests that directly model watcher presence. */
  installForTest(watcher: Watcher | undefined, sessionId?: string): void {
    this.generation++;
    this.session = watcher ? {
      generation: this.generation,
      watcher,
      debouncer: { push: () => {}, dispose: () => {} },
      id: sessionId ?? "test-session",
      admission: "",
    } : undefined;
  }

  private replace(rearm: boolean): Promise<void> {
    if (this.replacement) return this.replacement;
    const run = this.runReplace(rearm).finally(() => {
      if (this.replacement === run) this.replacement = undefined;
    });
    this.replacement = run;
    return run;
  }

  private async runReplace(rearm: boolean): Promise<void> {
    if (this.stopping || this.effects.stopped()) return;
    this.clearTimer();
    this.attempt = undefined;
    const generation = ++this.generation;
    await this.closeSession();
    if (this.stopping || this.effects.stopped()) return;

    const authority = this.effects.rebuildArmAuthority();
    const admission = fingerprint(authority.admission);
    if (rearm && authority.coverage === "structural-conflict") {
      this.terminalRecovery("native admission cannot cover matcher");
      return;
    }
    const attempt: LiveAttempt | undefined = rearm ? {
      attemptId: crypto.randomBytes(12).toString("hex"),
      sessionGen: generation,
      errorGenBeforeSubscribe: this.effects.errorGeneration(),
      certification: "pending",
    } : undefined;
    this.attempt = attempt;
    const live = () => generation === this.generation && !this.stopping;
    const debouncer = onceDisposable((this.effects.createDebouncer ?? createSignalDebouncer)(
      (batch) => { if (live()) this.effects.onGitBatch(batch); }, 400, 3000,
    ));
    let initial: readonly DiscoveredGitRepo[] = [];
    let candidate: Watcher | undefined;
    try {
      candidate = await (this.effects.startWatcher ?? startWatcher)(
        this.effects.root,
        authority.matcher,
        (events) => { if (live()) this.effects.onEvents(events); },
        {
          signalDebouncer: debouncer,
          parcelAdmission: authority.admission,
          onInitialGitRepos: async (repos) => { initial = repos; },
          onRawEvent: (event) => { if (live()) this.effects.onRawEvent(event); },
          onError: (error) => { if (live()) this.effects.onError(error); },
          onArm: rearm ? () => this.recertifyArm(attempt!, admission) : undefined,
        },
      );
      const terminalChokidar = rearm && candidate.backend !== "parcel";
      if (!live()) {
        await candidate.close().catch(() => {});
        debouncer.dispose();
        return;
      }
      if (rearm && !terminalChokidar && attempt?.certification === "structural-conflict") {
        this.generation++;
        await candidate.close().catch(() => {});
        debouncer.dispose();
        await this.effects.abandonRefBackend().catch(() => {});
        this.terminalRecovery("native admission cannot cover matcher");
        return;
      }
      if (rearm && !terminalChokidar && (
        !this.attempt?.witness
        || !this.attempt.witness.recertified
        || this.attempt.attemptId !== attempt?.attemptId
      )) {
        this.generation++;
        await candidate.close().catch(() => {});
        debouncer.dispose();
        if (this.attempt?.attemptId === attempt?.attemptId) this.attempt = undefined;
        await this.effects.abandonRefBackend().catch(() => {});
        if (!this.timer && this.effects.retrustEnabled()) this.scheduleNext("arm invalidated");
        return;
      }
      if (terminalChokidar) this.attempt = undefined;
      if (gitRefSideChannelEligible(process.platform, candidate.backend)) {
        await this.effects.attachRefBackend({
          backend: candidate.backend,
          initial,
          onSignal: () => { if (live()) debouncer.push("signal"); },
          onArmed: () => { if (live()) debouncer.push("other"); },
        });
      } else this.effects.noteRefBackendUnavailable();
      if (!live()) {
        await candidate.close().catch(() => {});
        debouncer.dispose();
        await this.effects.abandonRefBackend().catch(() => {});
        return;
      }
      this.session = {
        generation,
        watcher: candidate,
        debouncer,
        id: crypto.randomBytes(16).toString("hex"),
        admission,
      };
      this.effects.sessionInstalled(admission);
      if (rearm && this.attempt?.witness) this.effects.requestFullScan();
    } catch (error) {
      if (candidate) await candidate.close().catch(() => {});
      debouncer.dispose();
      await this.effects.abandonRefBackend().catch(() => {});
      if (generation === this.generation) this.generation++;
      if (rearm) {
        this.attempt = undefined;
        this.effects.log(`watcher re-arm failed: ${error instanceof Error ? error.message : String(error)}`);
        this.scheduleNext("replacement failed");
      } else this.effects.watchUnavailable(error instanceof Error ? error : new Error(String(error), { cause: error }));
    }
  }

  private recertifyArm(attempt: LiveAttempt, admitted: string): void {
    if (this.attempt?.attemptId !== attempt.attemptId) return;
    const recertified = this.effects.rebuildArmAuthority();
    if (recertified.coverage === "structural-conflict") {
      attempt.certification = "structural-conflict";
      return;
    }
    const valid = fingerprint(recertified.admission) === admitted
      && this.effects.errorGeneration() === attempt.errorGenBeforeSubscribe;
    attempt.certification = valid ? "valid" : "pending";
    attempt.witness = {
      attemptId: attempt.attemptId,
      sessionGen: attempt.sessionGen,
      errorGenAtArm: attempt.errorGenBeforeSubscribe,
      matcherGeneration: recertified.matcherGeneration,
      admission: admitted,
      authorityFingerprint: recertified.authorityFingerprint,
      recertified: valid,
    };
  }

  private failAttempt(attemptId: string, reason: string): void {
    if (this.attempt?.attemptId !== attemptId) return;
    this.attempt = undefined;
    this.effects.log(`watcher re-arm attempt failed: ${reason}`);
    this.scheduleNext(reason);
  }

  private scheduleNext(reason: string): void {
    if (this.recoveryTerminal || this.timer || this.stopping || this.effects.stopped()) return;
    if (!this.effects.retrustEnabled()) {
      this.cancelRecovery("kill switch disabled");
      return;
    }
    const delay = REARM_DELAYS_MS[Math.min(this.backoffStep, REARM_DELAYS_MS.length - 1)]!;
    this.backoffStep++;
    this.effects.log(`watcher re-arm scheduled in ${delay}ms (${reason})`);
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined;
      if (!this.effects.retrustEnabled() || this.stopping || this.effects.stopped()) {
        this.cancelRecovery("timer cancelled");
        return;
      }
      void this.replace(true);
    }, delay);
  }

  private cancelRecovery(reason: string): void {
    this.clearTimer();
    if (this.attempt) this.effects.log(`watcher re-arm cancelled: ${reason}`);
    this.attempt = undefined;
  }

  private terminalRecovery(reason: string): void {
    this.recoveryTerminal = true;
    this.cancelRecovery(reason);
    this.effects.log(`watcher re-arm terminal: ${reason}; restart required`);
  }

  private clearTimer(): void {
    if (this.timer === undefined) return;
    this.timer.cancel();
    this.timer = undefined;
  }

  private async closeSession(): Promise<void> {
    const previous = this.session;
    this.session = undefined;
    await Promise.allSettled([
      previous?.watcher.close(),
      this.effects.detachRefBackend(),
    ]);
    previous?.debouncer.dispose();
  }

  private async finishStop(): Promise<void> {
    await this.replacement?.catch(() => {});
    await this.closeSession();
  }
}

const fingerprint = (admission: readonly string[]): string => admission.join("\n");

function onceDisposable(inner: SignalDebouncer): SignalDebouncer {
  let disposed = false;
  return {
    push: (reason, candidate) => { if (!disposed) inner.push(reason, candidate); },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      inner.dispose();
    },
  };
}
