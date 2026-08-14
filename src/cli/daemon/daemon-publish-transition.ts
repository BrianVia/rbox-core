import type { CaseFoldCollisionGroup, Manifest } from "../../engine/index.js";
import type { DaemonActivity } from "../activity.js";
import { saveMetrics, type SyncMetrics } from "../metrics.js";
import { CommitRejectedError } from "../remote.js";
import { deferManifest } from "../sync-recovery.js";
import type { PushManifestOptions, PushResult } from "../sync/push.js";
import type { GitCaptureSample } from "../telemetry/contract.js";
import type { TelemetryRecorder } from "../telemetry/queue.js";
import type { PushProvenance } from "./daemon.js";
import type { LocalAuthority } from "./local-observation-transition.js";
import type { LocalRetryQueuePort } from "./local-workspace-observer.js";
import { cleanPath, LOG_PATHS_MAX } from "./render.js";

/** The daemon facts a publication is planned against, read once at attempt start. */
export interface PublishAttemptInputs {
  readonly manifest: Manifest;
  readonly appliedBase: Manifest | undefined;
  readonly gcFencedPaths: ReadonlySet<string>;
  readonly observationComplete: boolean;
  readonly caseCollisions: readonly CaseFoldCollisionGroup[];
  readonly blockedFingerprint: string | undefined;
}

export interface SealedPublishRequest {
  readonly attemptId: string;
  readonly manifest: Manifest;
  readonly blockedFingerprint: string | undefined;
  readonly localFileObservation: NonNullable<PushManifestOptions["localFileObservation"]>;
}

export type DaemonPushOutcome =
  | { readonly kind: "committed"; readonly attemptId: string; readonly result: PushResult }
  | { readonly kind: "not-committed"; readonly attemptId: string; readonly result: PushResult }
  | { readonly kind: "terminal-block"; readonly attemptId: string; readonly fingerprint: string | undefined };

/** The real per-attempt seam: the sync engine and its report lifecycle. */
export interface PushTransitionPort {
  readonly appliedBase: Manifest | undefined;
  execute(request: SealedPublishRequest): Promise<DaemonPushOutcome>;
  settleReport(publishTransitionMs: number): void;
}

export interface DaemonPublishReceipt {
  readonly attemptId: string;
  readonly outcome: DaemonPushOutcome["kind"];
  readonly sequence?: number;
}

/** Stable deep owners used directly instead of callback projections of daemon fields. */
export interface PublishTransitionState {
  readonly root: string;
  readonly local: LocalAuthority;
  readonly retries: LocalRetryQueuePort;
  readonly activity: DaemonActivity;
  readonly metrics: SyncMetrics;
  readonly telemetry: TelemetryRecorder;
}

/** The two genuine adjacent services that cannot be owned by the transition. */
export interface PublishTransitionServices {
  log(line: string): void;
  refreshDurableState(): Promise<void>;
}

export function gitCaptureSampleForProvenance(provenance: PushProvenance): GitCaptureSample | undefined {
  if (provenance.signal) return { kind: "git_capture", signalPushes: 1, candidatePushes: 0, scanPushes: 0 };
  if (provenance.candidate) return { kind: "git_capture", signalPushes: 0, candidatePushes: 1, scanPushes: 0 };
  if (provenance.scan) return { kind: "git_capture", signalPushes: 0, candidatePushes: 0, scanPushes: 1 };
  return undefined;
}

export function sealPublishRequest(attemptId: string, inputs: PublishAttemptInputs): SealedPublishRequest {
  return {
    attemptId,
    manifest: inputs.gcFencedPaths.size > 0 && inputs.appliedBase
      ? deferManifest(inputs.manifest, inputs.appliedBase, inputs.gcFencedPaths)
      : inputs.manifest,
    blockedFingerprint: inputs.blockedFingerprint,
    localFileObservation: inputs.observationComplete
      ? { authority: "authoritative" }
      : { authority: "preserve", caseCollisions: inputs.caseCollisions },
  };
}

/** Classify only the repeat terminal refusal; every other failure propagates. */
export async function classifyPublishOutcome(
  request: SealedPublishRequest,
  run: () => Promise<PushResult>,
): Promise<DaemonPushOutcome> {
  let result: PushResult;
  try {
    result = await run();
  } catch (error) {
    if (error instanceof CommitRejectedError && error.stillBlocked) {
      return { kind: "terminal-block", attemptId: request.attemptId, fingerprint: error.fingerprint };
    }
    throw error;
  }
  return { kind: result.committed ? "committed" : "not-committed", attemptId: request.attemptId, result };
}

/**
 * Owns the daemon's publish-local episode state and settles one classified result
 * directly. No effect vocabulary or callback-per-effect interpreter crosses this
 * boundary; callers supply only the engine/report operation port.
 */
export class PublishLocalWorkspaceTransition {
  private attempts = 0;
  private lastSequence: number | undefined;
  private terminalBlocked = false;
  private lastTerminalBlockFingerprint = "";
  private collisions: CaseFoldCollisionGroup[] = [];
  private publishActivityDirty = false;

  constructor(
    private readonly state: PublishTransitionState,
    private readonly services: PublishTransitionServices,
  ) {}

  get lastPublishedSequence(): number | undefined { return this.lastSequence; }
  get isTerminalBlocked(): boolean { return this.terminalBlocked; }
  get activeCaseCollisions(): readonly CaseFoldCollisionGroup[] { return this.collisions; }
  get activityDirty(): boolean { return this.publishActivityDirty; }

  adoptPublishedSequence(sequence: number): void { this.lastSequence = sequence; }
  clearTerminalBlock(): void { this.terminalBlocked = false; }
  acknowledgeActivityWrite(): void { this.publishActivityDirty = false; }

  adoptCollisionObservation(groups: readonly CaseFoldCollisionGroup[], observationComplete: boolean): void {
    this.collisions = groups.map((group) => ({ paths: [...group.paths] }));
    this.state.local.setObservationComplete(observationComplete);
  }

  async publish(provenance: PushProvenance, port: PushTransitionPort): Promise<DaemonPublishReceipt> {
    const request = sealPublishRequest(`publish-${++this.attempts}`, {
      manifest: this.state.local.manifest,
      appliedBase: port.appliedBase,
      gcFencedPaths: this.state.retries.gcFencedPaths,
      observationComplete: this.state.local.observationComplete,
      caseCollisions: this.collisions,
      blockedFingerprint: this.terminalFingerprint(),
    });
    const outcome = await port.execute(request);
    const publishTransitionT0 = performance.now();
    if (outcome.attemptId !== request.attemptId) {
      throw new Error(`publish transition: outcome for attempt ${outcome.attemptId} does not match ${request.attemptId}`);
    }
    if (outcome.kind === "terminal-block") {
      this.noteTerminalBlock(outcome.fingerprint);
      await this.services.refreshDurableState();
      return { attemptId: request.attemptId, outcome: outcome.kind };
    }
    await this.settle(outcome.result, provenance, port, publishTransitionT0);
    return { attemptId: request.attemptId, outcome: outcome.kind, sequence: outcome.result.sequence };
  }

  private terminalFingerprint(): string | undefined {
    const halt = this.state.activity.halt;
    return halt?.op === "push" ? halt.terminal?.fingerprint : undefined;
  }

  private noteTerminalBlock(fingerprint: string | undefined): void {
    this.terminalBlocked = true;
    if (!fingerprint || this.lastTerminalBlockFingerprint === fingerprint) return;
    this.lastTerminalBlockFingerprint = fingerprint;
    const reason = this.state.activity.halt?.reason ?? "push is blocked";
    this.services.log(`push blocked: ${reason} — change the workspace or raise limits`);
  }

  private async settle(
    result: PushResult,
    provenance: PushProvenance,
    port: PushTransitionPort,
    publishTransitionT0: number,
  ): Promise<void> {
    const sample = gitCaptureSampleForProvenance(provenance);
    if (sample) this.state.telemetry.record(sample);
    const deferred = result.deferred ?? [];
    this.state.local.commitPatch(
      result.manifest,
      { kind: "partial", source: "push-committed", paths: new Set(deferred) },
      { add: deferred },
    );
    const groups = result.caseCollisions.map((group) => ({ paths: [...group.paths] }));
    this.adoptCollisionObservation(
      groups,
      result.localFileObservationAuthority === "authoritative" && groups.length === 0,
    );
    if (result.committed && result.sequence !== this.lastSequence) {
      const note = deferred.length > 0
        ? `; deferred ${deferred.length}: ${deferred.slice(0, LOG_PATHS_MAX).map(cleanPath).join(" ")}`
        : "";
      this.services.log(`push: published sequence ${result.sequence} (${result.manifest.files.length} files${note})`);
    }
    this.lastSequence = result.sequence;
    if (result.committed) {
      this.state.activity.lastPush = {
        at: new Date().toISOString(),
        files: result.manifest.files.length,
        sequence: result.sequence,
      };
      this.publishActivityDirty = true;
    }
    const retryLater = new Set(result.retryLater ?? []);
    const writeFinish = new Set(deferred.filter((path) => !retryLater.has(path)));
    if (writeFinish.size > 0) this.state.retries.scheduleWriteFinish(writeFinish);
    if (retryLater.size > 0) this.state.retries.scheduleGcFence(retryLater);
    await this.services.refreshDurableState();
    this.state.metrics.syncs += 1;
    await saveMetrics(this.state.root, this.state.metrics);
    port.settleReport(Math.max(0, performance.now() - publishTransitionT0));
  }
}
