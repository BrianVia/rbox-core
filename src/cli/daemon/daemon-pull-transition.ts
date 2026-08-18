import { actionPath, isIgnoreRuleFile, type Action, type Manifest } from "../../engine/index.js";
import type { DaemonActivity } from "../activity.js";
import type { SyncState } from "../config.js";
import { saveMetrics, type SyncMetrics } from "../metrics.js";
import { TrustedViewRefusalError, type TrustedLocalView } from "../sync.js";
import type { TelemetryRecorder } from "../telemetry/queue.js";
import type { LocalAuthority } from "./local-observation-transition.js";
import { gitTopologyChanged, type SkipCause, type TrustedPullViewResult } from "./manifest-update.js";

export interface PullTrustGate {
  readonly watcherTrusted: boolean;
  readonly manifestSettled: boolean;
  readonly fullWorkspaceSinceSeed: boolean;
  readonly resetReady: boolean;
  readonly matcherMatchesBase: boolean;
  readonly matcherObservationCurrent: boolean;
}

export interface PullTrustRecheck {
  readonly pendingEmpty: boolean;
  readonly watcherTrusted: boolean;
  readonly manifestSettled: boolean;
  readonly trustedView: () => TrustedLocalView;
}

/**
 * Evaluate predicate P (design 202 order, unchanged) — but drain FIRST, always.
 * Applying watch events to the local observer is mode- and trust-independent
 * bookkeeping, identical to the push prologue's drain; leaving it behind P1 let a
 * fused watcher on a pull-only host accumulate events for a whole fuse interval
 * while the non-empty queue held `externalLocalWorkSettled` false, interlocking
 * against the very trust recovery that would clear P1 (design 277 B3).
 * Trust is therefore sampled AFTER the drain; the pull keeps its pre-op base.
 * The kill switch alone precedes the drain: turning design 202 off must restore the
 * pre-202 pull lane whole, and that lane did not drain here.
 */
export async function buildTrustedPullView(
  trustedPullEnabled: () => boolean,
  drainPendingEvents: () => Promise<void>,
  trustGate: () => PullTrustGate,
  trustRecheck: () => PullTrustRecheck,
): Promise<TrustedPullViewResult> {
  if (!trustedPullEnabled()) return { skip: "kill-switch" };
  await drainPendingEvents();
  const before = trustGate();
  if (!before.watcherTrusted) return { skip: "p1-watcher" };
  if (!before.manifestSettled) return { skip: "p2-observation" };
  if (!before.fullWorkspaceSinceSeed) return { skip: "p5-seed" };
  if (!before.resetReady) return { skip: "p6-reset" };
  if (!before.matcherMatchesBase) return { skip: "p7-matcher" };
  if (!before.matcherObservationCurrent) return { skip: "p7-matcher-observation" };
  const after = trustRecheck();
  if (!after.pendingEmpty) return { skip: "p3-pending" };
  if (!after.watcherTrusted) return { skip: "p1-watcher" };
  if (!after.manifestSettled) return { skip: "p2-observation" };
  return { view: after.trustedView() };
}

export interface PullAttemptInputs {
  readonly preBase: SyncState;
  readonly watcherErrorGeneration: number;
  readonly notifyPendingAt: number | undefined;
}

export interface SealedPullRequest {
  readonly attemptId: string;
  readonly view: TrustedLocalView | undefined;
  readonly skip: SkipCause | "refused" | undefined;
  readonly watcherErrorGeneration: number;
}

export type DaemonPullOutcome =
  | {
      readonly kind: "applied";
      readonly attemptId: string;
      readonly actions: readonly Action[];
      readonly chainRepaired: boolean;
    }
  | { readonly kind: "local-untrusted"; readonly attemptId: string; readonly reason: string };

export interface PullTransitionPort {
  execute(request: SealedPullRequest): Promise<DaemonPullOutcome>;
  settleReport(): void;
}

export type PullFallbackCause = "chain-repair" | "ignore-rules" | "git-topology" | "watcher-drop";

export interface DaemonPullReceipt {
  readonly attemptId: string;
  readonly children: readonly string[];
  readonly local: "trusted" | "scan";
  readonly skip: SkipCause | "refused" | undefined;
  readonly fallback: PullFallbackCause | undefined;
}

export interface PullOperation {
  seal(): Promise<PullAttemptInputs>;
  trustedPullEnabled(): boolean;
  drainPendingEvents(): Promise<void>;
  trustGate(preBase: SyncState): PullTrustGate;
  trustRecheck(): PullTrustRecheck;
  open(): PullTransitionPort;
}

export interface PullChainRepairPolicy { clear(): void }
export interface PublishedSequenceOwner { adoptPublishedSequence(sequence: number): void }

export interface PullTransitionState {
  readonly root: string;
  readonly local: LocalAuthority;
  readonly metrics: SyncMetrics;
  readonly telemetry: TelemetryRecorder;
  readonly chainRepairPolicy: PullChainRepairPolicy;
  readonly publishTransition: PublishedSequenceOwner;
  now(): number;
}

export interface PullTransitionServices {
  log(line: string): void;
  refreshMatcher(): Promise<void>;
  loadAndSurfacePostBase(): Promise<SyncState>;
  installPullPatch(
    view: TrustedLocalView,
    actions: readonly Action[],
    postBase: Manifest,
    watcherErrorGeneration: number,
  ): "watcher-drop" | undefined;
  scanLocal(previous: Manifest): Promise<void>;
}

export function sealPullRequest(
  attemptId: string,
  trust: TrustedPullViewResult,
  watcherErrorGeneration: number,
): SealedPullRequest {
  return {
    attemptId,
    view: trust.view,
    skip: trust.skip,
    watcherErrorGeneration,
  };
}

export function sealScanFallbackRequest(attemptId: string, refused: SealedPullRequest): SealedPullRequest {
  return { attemptId, view: undefined, skip: "refused", watcherErrorGeneration: refused.watcherErrorGeneration };
}

export async function classifyPullOutcome(
  request: SealedPullRequest,
  run: (view: TrustedLocalView | undefined) => Promise<readonly Action[]>,
  chainRepaired: () => boolean,
): Promise<DaemonPullOutcome> {
  let actions: readonly Action[];
  try {
    actions = await run(request.view);
  } catch (error) {
    if (request.view !== undefined && error instanceof TrustedViewRefusalError) {
      return { kind: "local-untrusted", attemptId: request.attemptId, reason: error.reason };
    }
    throw error;
  }
  return { kind: "applied", attemptId: request.attemptId, actions, chainRepaired: chainRepaired() };
}

export interface PullActionSummary { fileConflicts: number; rulesWritten: boolean }

export function summarizePullActions(actions: readonly Action[]): PullActionSummary {
  let fileConflicts = 0;
  let rulesWritten = false;
  for (const action of actions) {
    if (action.kind === "conflict") fileConflicts++;
    if (isIgnoreRuleFile(actionPath(action))) rulesWritten = true;
  }
  return { fileConflicts, rulesWritten };
}

export type PullRefreshPlan =
  | { readonly kind: "no-trusted-view" }
  | { readonly kind: "fallback"; readonly cause: Exclude<PullFallbackCause, "watcher-drop"> }
  | { readonly kind: "install-patch" };

export function planPullRefresh(facts: {
  readonly trusted: boolean;
  readonly chainRepaired: boolean;
  readonly rulesWritten: boolean;
  readonly topologyChanged: boolean;
}): PullRefreshPlan {
  if (!facts.trusted) return { kind: "no-trusted-view" };
  if (facts.chainRepaired) return { kind: "fallback", cause: "chain-repair" };
  if (facts.rulesWritten) return { kind: "fallback", cause: "ignore-rules" };
  if (facts.topologyChanged) return { kind: "fallback", cause: "git-topology" };
  return { kind: "install-patch" };
}

/** Owns trust admission, the single scan retry, and direct pull settlement. */
export class ApplyRemoteWorkspaceTransition {
  private attempts = 0;

  constructor(
    private readonly state: PullTransitionState,
    private readonly services: PullTransitionServices,
  ) {}

  async apply(op: PullOperation): Promise<DaemonPullReceipt> {
    const parent = `pull-${++this.attempts}`;
    const inputs = await op.seal();
    const trust = await buildTrustedPullView(
      () => op.trustedPullEnabled(),
      () => op.drainPendingEvents(),
      () => op.trustGate(inputs.preBase),
      () => op.trustRecheck(),
    );
    let request = sealPullRequest(`${parent}/1`, trust, inputs.watcherErrorGeneration);
    const port = op.open();
    const children: string[] = [request.attemptId];
    let outcome = this.bind(request, await port.execute(request));
    if (outcome.kind === "local-untrusted") {
      this.services.log(`pull local=trusted refused=${outcome.reason}`);
      request = sealScanFallbackRequest(`${parent}/2`, request);
      children.push(request.attemptId);
      outcome = this.bind(request, await port.execute(request));
      if (outcome.kind === "local-untrusted") {
        throw new Error(`pull transition: ${request.attemptId} re-ran scan-backed and still reported local-untrusted`);
      }
    }
    const fallback = await this.settle(outcome, request, inputs, port);
    return {
      attemptId: parent,
      children,
      local: request.view === undefined ? "scan" : "trusted",
      skip: request.skip,
      fallback,
    };
  }

  private bind(request: SealedPullRequest, outcome: DaemonPullOutcome): DaemonPullOutcome {
    if (outcome.attemptId !== request.attemptId) {
      throw new Error(`pull transition: outcome for attempt ${outcome.attemptId} does not match ${request.attemptId}`);
    }
    return outcome;
  }

  private async settle(
    applied: Extract<DaemonPullOutcome, { kind: "applied" }>,
    request: SealedPullRequest,
    inputs: PullAttemptInputs,
    port: PullTransitionPort,
  ): Promise<PullFallbackCause | undefined> {
    this.state.chainRepairPolicy.clear();
    if (inputs.notifyPendingAt !== undefined) {
      this.state.telemetry.record({
        kind: "propagation",
        deliveryToApplyMs: Math.max(0, this.state.now() - inputs.notifyPendingAt),
      });
    }
    port.settleReport();
    const summary = summarizePullActions(applied.actions);
    if (summary.fileConflicts > 0) {
      this.state.metrics.fileConflicts += summary.fileConflicts;
      this.state.metrics.lastConflictAt = new Date().toISOString();
      await saveMetrics(this.state.root, this.state.metrics);
    }
    if (summary.rulesWritten) await this.services.refreshMatcher();
    const postBase = await this.services.loadAndSurfacePostBase();
    this.state.publishTransition.adoptPublishedSequence(postBase.lastSyncedSequence);
    const refresh = planPullRefresh({
      trusted: request.view !== undefined,
      chainRepaired: applied.chainRepaired,
      rulesWritten: summary.rulesWritten,
      topologyChanged: gitTopologyChanged(inputs.preBase, postBase),
    });
    const fallback = refresh.kind === "fallback"
      ? refresh.cause
      : refresh.kind === "install-patch"
        ? this.services.installPullPatch(
            request.view!,
            applied.actions,
            postBase.lastSyncedManifest,
            request.watcherErrorGeneration,
          )
        : undefined;
    if (request.view === undefined || fallback !== undefined) {
      await this.services.scanLocal(postBase.lastSyncedManifest);
    }
    const skip = request.skip === undefined ? "" : ` skip=${request.skip}`;
    const fallbackNote = fallback === undefined ? "" : ` fallback=${fallback}`;
    this.services.log(`pull local=${request.view === undefined ? "scan" : "trusted"}${skip}${fallbackNote}`);
    return fallback;
  }
}
