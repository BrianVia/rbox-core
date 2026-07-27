import type { CaseFoldCollisionGroup, Manifest } from "../../engine/index.js";
import { CommitRejectedError } from "../remote.js";
import { deferManifest } from "../sync-recovery.js";
import type { PushManifestOptions, PushResult } from "../sync/push.js";
import type { PushProvenance } from "./daemon.js";
import { cleanPath, LOG_PATHS_MAX } from "./render.js";

/**
 * `PublishLocalWorkspaceTransition` — the daemon side of the publish seam. It seals
 * one request from the daemon's current LOCAL/BASE/retry facts, hands it to the push
 * port, classifies the closed result, and reduces it into ONE ordered effect list
 * that the daemon applies verbatim.
 *
 * It owns no Git planning: candidate projection, commit execution, and publisher
 * acknowledgement are the push spine's (`src/cli/sync/`). What it owns is which facts
 * cross into a push and, exactly once, what the outcome is allowed to change here.
 *
 * Fail-closed: an outcome whose `attemptId` is not the one this transition sealed
 * performs NO effect at all.
 */

/** The daemon facts a publication is planned against, read once at attempt start. */
export interface PublishAttemptInputs {
  /** LOCAL head as this daemon believes disk to be. */
  readonly manifest: Manifest;
  /** `lastSyncedManifest`: what a GC-fenced path falls back to. Absent before BASE. */
  readonly appliedBase: Manifest | undefined;
  readonly gcFencedPaths: ReadonlySet<string>;
  readonly observationComplete: boolean;
  /** Carried, not cloned: preserve-mode publication must not clear a prior episode. */
  readonly caseCollisions: readonly CaseFoldCollisionGroup[];
  /** The fingerprint of a standing terminal push halt, so the remote can repeat or
   *  retire its refusal against the exact block the daemon is holding. */
  readonly blockedFingerprint: string | undefined;
}

/** Everything the push port may read. No mutable daemon map crosses here. */
export interface SealedPublishRequest {
  readonly attemptId: string;
  /** Deferral-pruned publication input. */
  readonly manifest: Manifest;
  readonly blockedFingerprint: string | undefined;
  readonly localFileObservation: NonNullable<PushManifestOptions["localFileObservation"]>;
}

export type DaemonPushOutcome =
  | { readonly kind: "committed"; readonly attemptId: string; readonly result: PushResult }
  | { readonly kind: "not-committed"; readonly attemptId: string; readonly result: PushResult }
  | { readonly kind: "terminal-block"; readonly attemptId: string; readonly fingerprint: string | undefined };

/** The one narrow port this adapter invokes, sealed to a single attempt: it owns the
 *  mutex and the metrics/telemetry report that attempt runs under. */
export interface PushTransitionPort {
  execute(request: SealedPublishRequest): Promise<DaemonPushOutcome>;
  /** Close out that attempt's report. A terminal refusal never reaches it — the
   *  attempt published nothing to sample or summarize. */
  settleReport(): void;
}

export type DaemonPublishEffect =
  | { readonly kind: "terminal-block"; readonly fingerprint: string | undefined }
  | { readonly kind: "record-git-capture-success" }
  | { readonly kind: "commit-published-subset"; readonly manifest: Manifest; readonly deferred: readonly string[] }
  | { readonly kind: "adopt-collision-observation"; readonly groups: readonly CaseFoldCollisionGroup[]; readonly observationComplete: boolean }
  | { readonly kind: "log"; readonly line: string }
  | { readonly kind: "note-published-sequence"; readonly sequence: number }
  | { readonly kind: "record-publish-activity"; readonly files: number; readonly sequence: number }
  | { readonly kind: "schedule-write-finish"; readonly paths: readonly string[] }
  | { readonly kind: "schedule-gc-fence"; readonly paths: readonly string[] }
  | { readonly kind: "refresh-durable-state" }
  | { readonly kind: "record-sync-metric" }
  | { readonly kind: "settle-report" };

export interface DaemonPublishReceipt {
  readonly attemptId: string;
  readonly outcome: DaemonPushOutcome["kind"];
  /** The sequence now in effect; absent when the remote refused terminally. */
  readonly sequence?: number;
  readonly effects: readonly DaemonPublishEffect[];
}

export interface DaemonPublishEffects {
  sealAttemptInputs(): PublishAttemptInputs;
  /** The last sequence this daemon logged, so a repeat stays silent. */
  lastPublishedSequence(): number | undefined;
  noteTerminalBlock(fingerprint: string | undefined): void;
  recordGitCaptureSuccess(provenance: PushProvenance): void;
  commitPublishedSubset(next: Manifest, deferred: readonly string[]): void;
  adoptCollisionObservation(groups: readonly CaseFoldCollisionGroup[], observationComplete: boolean): void;
  log(line: string): void;
  notePublishedSequence(sequence: number): void;
  recordPublishActivity(files: number, sequence: number): void;
  scheduleWriteFinish(paths: readonly string[]): void;
  scheduleGcFence(paths: readonly string[]): void;
  refreshDurableState(): Promise<void>;
  recordSyncMetric(): Promise<void>;
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

/**
 * The only failure this seam may absorb: the remote repeated a terminal refusal
 * against the fingerprint the request carried. Every other failure — including a
 * FIRST terminal refusal, which the pump must still record as a halt — propagates.
 */
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

export function reduceDaemonPublishOutcome(
  outcome: DaemonPushOutcome,
  context: { readonly lastPublishedSequence: number | undefined },
): readonly DaemonPublishEffect[] {
  if (outcome.kind === "terminal-block") {
    // The attempt may have established the capable state lineage before the remote
    // repeated its refusal. Adopt that durable nonce just as a completed push does,
    // or the next pump mistakes our own initialization for an idle rebind.
    return [{ kind: "terminal-block", fingerprint: outcome.fingerprint }, { kind: "refresh-durable-state" }];
  }
  const result = outcome.result;
  const deferred = result.deferred ?? [];
  const groups = result.caseCollisions.map((group) => ({ paths: [...group.paths] }));
  const effects: DaemonPublishEffect[] = [
    { kind: "record-git-capture-success" },
    // The committed subset differs from what push was handed only at the DEFERRED
    // paths — those carry the base entry, not observed disk truth, so they stay
    // unsettled exactly like a scan's or a watcher's deferrals (design 108).
    { kind: "commit-published-subset", manifest: result.manifest, deferred },
    {
      kind: "adopt-collision-observation",
      groups,
      observationComplete: result.localFileObservationAuthority === "authoritative" && groups.length === 0,
    },
  ];
  // Gated on `committed` (design 44): a push whose internal 409-recovery PULLED a
  // remote sequence and then no-opped must not be logged as if THIS daemon published
  // it — and the steady-state no-op stays silent so it does not fill the log.
  if (result.committed && result.sequence !== context.lastPublishedSequence) {
    const note = deferred.length > 0
      ? `; deferred ${deferred.length}: ${deferred.slice(0, LOG_PATHS_MAX).map(cleanPath).join(" ")}`
      : "";
    effects.push({ kind: "log", line: `push: published sequence ${result.sequence} (${result.manifest.files.length} files${note})` });
  }
  effects.push({ kind: "note-published-sequence", sequence: result.sequence });
  if (result.committed) effects.push({ kind: "record-publish-activity", files: result.manifest.files.length, sequence: result.sequence });
  if (deferred.length > 0) {
    const retryLater = new Set(result.retryLater ?? []);
    const writeFinish = [...new Set(deferred.filter((path) => !retryLater.has(path)))];
    if (writeFinish.length > 0) effects.push({ kind: "schedule-write-finish", paths: writeFinish });
    if (retryLater.size > 0) effects.push({ kind: "schedule-gc-fence", paths: [...retryLater] });
  }
  effects.push({ kind: "refresh-durable-state" }, { kind: "record-sync-metric" }, { kind: "settle-report" });
  return effects;
}

export class PublishLocalWorkspaceTransition {
  private attempts = 0;

  constructor(private readonly effects: DaemonPublishEffects) {}

  /** The port is supplied per attempt because the mutex and metrics report it runs
   *  under belong to exactly one pump operation. */
  async publish(provenance: PushProvenance, port: PushTransitionPort): Promise<DaemonPublishReceipt> {
    const request = sealPublishRequest(`publish-${++this.attempts}`, this.effects.sealAttemptInputs());
    const outcome = await port.execute(request);
    if (outcome.attemptId !== request.attemptId) {
      throw new Error(`publish transition: outcome for attempt ${outcome.attemptId} does not match ${request.attemptId}`);
    }
    const plan = reduceDaemonPublishOutcome(outcome, { lastPublishedSequence: this.effects.lastPublishedSequence() });
    for (const effect of plan) await this.apply(effect, provenance, port);
    return {
      attemptId: request.attemptId,
      outcome: outcome.kind,
      ...(outcome.kind === "terminal-block" ? {} : { sequence: outcome.result.sequence }),
      effects: plan,
    };
  }

  private async apply(effect: DaemonPublishEffect, provenance: PushProvenance, port: PushTransitionPort): Promise<void> {
    switch (effect.kind) {
      case "terminal-block": this.effects.noteTerminalBlock(effect.fingerprint); return;
      case "record-git-capture-success": this.effects.recordGitCaptureSuccess(provenance); return;
      case "commit-published-subset": this.effects.commitPublishedSubset(effect.manifest, effect.deferred); return;
      case "adopt-collision-observation": this.effects.adoptCollisionObservation(effect.groups, effect.observationComplete); return;
      case "log": this.effects.log(effect.line); return;
      case "note-published-sequence": this.effects.notePublishedSequence(effect.sequence); return;
      case "record-publish-activity": this.effects.recordPublishActivity(effect.files, effect.sequence); return;
      case "schedule-write-finish": this.effects.scheduleWriteFinish(effect.paths); return;
      case "schedule-gc-fence": this.effects.scheduleGcFence(effect.paths); return;
      case "refresh-durable-state": await this.effects.refreshDurableState(); return;
      case "record-sync-metric": await this.effects.recordSyncMetric(); return;
      case "settle-report": port.settleReport(); return;
    }
  }
}
