import { actionPath, isIgnoreRuleFile, type Action, type Manifest } from "../../engine/index.js";
import type { SyncState } from "../config.js";
import { TrustedViewRefusalError, type TrustedLocalView } from "../sync.js";
import type { SkipCause, TrustedPullViewResult } from "./manifest-update.js";

/**
 * `ApplyRemoteWorkspaceTransition` — the daemon side of the receive seam. It seals one
 * request from the daemon's current trust facts, hands it to the pull port, classifies
 * the closed result, and reduces it into ONE ordered effect list the daemon applies
 * verbatim.
 *
 * It owns no Git policy: reconciliation, apply, and the mass-delete breaker are the
 * receive spine's (`src/cli/sync/`, `src/cli/sync-git/`). What it owns is which local
 * view crosses into a pull, how a refusal is retried, and exactly once, what the
 * outcome is allowed to change here.
 *
 * Fail-closed: an outcome whose `attemptId` is not the one this transition sealed
 * performs NO effect at all, and a scan-backed run is never allowed to refuse.
 */

/** Design 202/206 trust predicate P, one accessor per clause. */
export interface PullTrustFacts {
  /** F5: the kill switch is engaged, so nothing downstream may be trusted. */
  killSwitchOff(): boolean;
  watcherTrusted(): boolean;
  manifestSettled(): boolean;
  fullWorkspaceSinceSeed(): boolean;
  resetReady(): boolean;
  matcherMatchesBase(): boolean;
  matcherObservationCurrent(): boolean;
  drainPendingEvents(): Promise<void>;
  pendingEmpty(): boolean;
  trustedView(): TrustedLocalView;
}

/**
 * Returns the single-use local view, or the named clause that withheld it. P3's drain
 * is deliberately last: it is the only clause with a side effect, so a kill-switched or
 * otherwise untrusted daemon behaves exactly as it did before design 202. The drain
 * awaits, so the two conditions it can itself invalidate are re-read afterwards — each
 * re-check reporting its own clause, never a token of its own.
 */
export async function buildTrustedPullView(facts: PullTrustFacts): Promise<TrustedPullViewResult> {
  if (facts.killSwitchOff()) return { skip: "kill-switch" };                       // F5
  if (!facts.watcherTrusted()) return { skip: "p1-watcher" };                      // P1
  if (!facts.manifestSettled()) return { skip: "p2-observation" };                 // P2
  if (!facts.fullWorkspaceSinceSeed()) return { skip: "p5-seed" };                 // P5
  if (!facts.resetReady()) return { skip: "p6-reset" };                            // P6
  if (!facts.matcherMatchesBase()) return { skip: "p7-matcher" };                   // P7
  // Design 206 §2: provenance alone would re-engage trust over a manifest whose
  // inclusion decisions predate the current matcher.
  if (!facts.matcherObservationCurrent()) return { skip: "p7-matcher-observation" };
  await facts.drainPendingEvents();                                                // P3
  if (!facts.pendingEmpty()) return { skip: "p3-pending" };
  if (!facts.watcherTrusted()) return { skip: "p1-watcher" };
  if (!facts.manifestSettled()) return { skip: "p2-observation" };
  return { view: facts.trustedView() };
}

/** The daemon facts one receive attempt is planned against, read once at op start. */
export interface PullAttemptInputs {
  readonly trust: TrustedPullViewResult;
  /** F2's "before" side, captured before anything can move it. */
  readonly preBase: SyncState;
  /** F1/P4, captured at op start and re-checked by the patch install. */
  readonly watcherErrorGeneration: number;
  /** When a WS notify caused this pull, the moment it became pending. */
  readonly notifyPendingAt: number | undefined;
}

/** Everything the pull port may read. No mutable daemon map crosses here. */
export interface SealedPullRequest {
  readonly attemptId: string;
  readonly view: TrustedLocalView | undefined;
  /** Why the main line has no trusted view, kept separate from the view itself so a
   *  refusal names itself instead of reappearing as a bare `local=scan`. */
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

/** The one narrow port this adapter invokes: it owns the mutex, the sync deps, and the
 *  metrics/telemetry report the whole op runs under — across BOTH authorized calls. */
export interface PullTransitionPort {
  execute(request: SealedPullRequest): Promise<DaemonPullOutcome>;
  settleReport(): void;
}

export type PullFallbackCause = "chain-repair" | "ignore-rules" | "git-topology" | "watcher-drop";

export type DaemonPullEffect =
  | { readonly kind: "clear-chain-repair" }
  | { readonly kind: "record-propagation"; readonly pendingAt: number }
  | { readonly kind: "settle-report" }
  | { readonly kind: "record-file-conflicts"; readonly count: number }
  | { readonly kind: "refresh-matcher" }
  | { readonly kind: "adopt-post-base" }
  | { readonly kind: "install-pull-patch" }
  | { readonly kind: "scan-local" }
  | { readonly kind: "log"; readonly line: string };

export interface DaemonPullReceipt {
  readonly attemptId: string;
  /** The child attempts this transition authorized, in order. */
  readonly children: readonly string[];
  readonly local: "trusted" | "scan";
  readonly skip: SkipCause | "refused" | undefined;
  readonly fallback: PullFallbackCause | undefined;
  readonly effects: readonly DaemonPullEffect[];
}

/** One pump operation's two per-op resources, in the order they must be created. */
export interface PullOperation {
  /** Read the daemon's trust facts once, at op start. */
  seal(): Promise<PullAttemptInputs>;
  /** Opened only AFTER sealing, so the trust predicate's drain is never billed to the
   *  metrics report this op's engine calls run under. */
  open(): PullTransitionPort;
}

export interface DaemonPullEffects {
  clearChainRepair(): void;
  recordPropagation(pendingAt: number): void;
  recordFileConflicts(count: number): Promise<void>;
  refreshMatcher(): Promise<void>;
  /** Reload BASE, emit durable Git deferrals, and adopt the sequence the pull advanced. */
  adoptPostBase(): Promise<SyncState>;
  gitTopologyChanged(before: SyncState, after: SyncState): boolean;
  installPullPatch(
    view: TrustedLocalView,
    actions: readonly Action[],
    postBase: Manifest,
    watcherErrorGeneration: number,
  ): "watcher-drop" | undefined;
  scanLocal(previous: Manifest): Promise<void>;
  log(line: string): void;
}

export function sealPullRequest(attemptId: string, inputs: PullAttemptInputs): SealedPullRequest {
  return {
    attemptId,
    view: inputs.trust.view,
    skip: inputs.trust.skip,
    watcherErrorGeneration: inputs.watcherErrorGeneration,
  };
}

export function sealScanFallbackRequest(attemptId: string, refused: SealedPullRequest): SealedPullRequest {
  return { attemptId, view: undefined, skip: "refused", watcherErrorGeneration: refused.watcherErrorGeneration };
}

/**
 * The only failure this seam may absorb: a pre-action refusal of the trusted view the
 * request carried — nothing touched disk, so the op may re-run scan-backed. A refusal
 * raised against a scan-backed request has no safer run left and propagates.
 */
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

/** The two whole-op facts a pull's actions carry: conflict count and rule mutation. */
export function summarizePullActions(actions: readonly Action[]): { fileConflicts: number; rulesWritten: boolean } {
  let fileConflicts = 0;
  let rulesWritten = false;
  for (const action of actions) {
    if (action.kind === "conflict") fileConflicts++;
    if (isIgnoreRuleFile(actionPath(action))) rulesWritten = true;
  }
  return { fileConflicts, rulesWritten };
}

export function reducePullSettlement(
  outcome: Extract<DaemonPullOutcome, { kind: "applied" }>,
  context: { readonly notifyPendingAt: number | undefined },
): readonly DaemonPullEffect[] {
  const { fileConflicts, rulesWritten } = summarizePullActions(outcome.actions);
  const effects: DaemonPullEffect[] = [{ kind: "clear-chain-repair" }];
  if (context.notifyPendingAt !== undefined) {
    effects.push({ kind: "record-propagation", pendingAt: context.notifyPendingAt });
  }
  effects.push({ kind: "settle-report" });
  if (fileConflicts > 0) effects.push({ kind: "record-file-conflicts", count: fileConflicts });
  // A pull that WROTE an ignore-rule file must refresh the matcher before the rescan
  // below and the pump's follow-up push — otherwise that push publishes files the
  // freshly pulled rules exclude (the same hazard the publish side guards on events).
  if (rulesWritten) effects.push({ kind: "refresh-matcher" });
  effects.push({ kind: "adopt-post-base" });
  return effects;
}

export type PullRefreshPlan =
  | { readonly kind: "no-trusted-view" }
  | { readonly kind: "fallback"; readonly cause: Exclude<PullFallbackCause, "watcher-drop"> }
  | { readonly kind: "install-patch" };

/**
 * Design 202: the O(applied) refresh, or the cause that sends it back to the scan.
 * Every cause is NAMED by the check that decides it — including F1, which the patch
 * itself reports — so none is ever reconstructed by elimination. F2 is a pure pre/post
 * base comparison and is what keeps repo discovery (ref registry + safety floor) with
 * the scan that does it right.
 */
export function planPullRefresh(facts: {
  readonly trusted: boolean;
  readonly chainRepaired: boolean;
  readonly rulesWritten: boolean;
  readonly topologyChanged: boolean;
}): PullRefreshPlan {
  if (!facts.trusted) return { kind: "no-trusted-view" };
  if (facts.chainRepaired) return { kind: "fallback", cause: "chain-repair" };  // F4
  if (facts.rulesWritten) return { kind: "fallback", cause: "ignore-rules" };   // F3
  if (facts.topologyChanged) return { kind: "fallback", cause: "git-topology" };// F2
  return { kind: "install-patch" };
}

/**
 * Fleet-greppable provenance, three distinct questions: which local view the pull's
 * main line read, why it had none (`skip=`), and why the post-pull O(applied) refresh
 * gave way to a scan (`fallback=`).
 */
export function reducePullRefresh(facts: {
  readonly trusted: boolean;
  readonly skip: SkipCause | "refused" | undefined;
  readonly fallback: PullFallbackCause | undefined;
}): readonly DaemonPullEffect[] {
  const effects: DaemonPullEffect[] = [];
  // Deferred paths carry the POST-pull base entry, never the pre-pull manifest —
  // carrying pre-pull truth would let the follow-up push publish a stale entry over
  // the version this pull just applied.
  if (!facts.trusted || facts.fallback !== undefined) effects.push({ kind: "scan-local" });
  const skip = facts.skip === undefined ? "" : ` skip=${facts.skip}`;
  const fallback = facts.fallback === undefined ? "" : ` fallback=${facts.fallback}`;
  effects.push({ kind: "log", line: `pull local=${facts.trusted ? "trusted" : "scan"}${skip}${fallback}` });
  return effects;
}

export class ApplyRemoteWorkspaceTransition {
  private attempts = 0;

  constructor(private readonly effects: DaemonPullEffects) {}

  async apply(op: PullOperation): Promise<DaemonPullReceipt> {
    const parent = `pull-${++this.attempts}`;
    const inputs = await op.seal();
    let request = sealPullRequest(`${parent}/1`, inputs);
    const port = op.open();
    const children: string[] = [request.attemptId];
    let outcome = this.bind(request, await port.execute(request));
    if (outcome.kind === "local-untrusted") {
      // Pre-action refusal: NOTHING touched disk. Re-run scan-backed exactly once per
      // op — that run's guard behaves as it always has (a real wave still halts).
      this.effects.log(`pull local=trusted refused=${outcome.reason}`);
      request = sealScanFallbackRequest(`${parent}/2`, request);
      children.push(request.attemptId);
      outcome = this.bind(request, await port.execute(request));
      if (outcome.kind === "local-untrusted") {
        throw new Error(`pull transition: ${request.attemptId} re-ran scan-backed and still reported local-untrusted`);
      }
    }
    const applied = outcome;
    const plan = reducePullSettlement(applied, { notifyPendingAt: inputs.notifyPendingAt });
    let postBase: SyncState | undefined;
    for (const effect of plan) postBase = (await this.applyEffect(effect, port)) ?? postBase;
    const refresh = planPullRefresh({
      trusted: request.view !== undefined,
      chainRepaired: applied.chainRepaired,
      ...summarizePullActions(applied.actions),
      topologyChanged: this.effects.gitTopologyChanged(inputs.preBase, postBase!),
    });
    const fallback = refresh.kind === "fallback" ? refresh.cause
      : refresh.kind === "install-patch"
        ? this.effects.installPullPatch(request.view!, applied.actions, postBase!.lastSyncedManifest, request.watcherErrorGeneration)
        : undefined;
    const tail = reducePullRefresh({ trusted: request.view !== undefined, skip: request.skip, fallback });
    for (const effect of tail) await this.applyEffect(effect, port, postBase!);
    return {
      attemptId: parent,
      children,
      local: request.view === undefined ? "scan" : "trusted",
      skip: request.skip,
      fallback,
      effects: [...plan, ...(refresh.kind === "install-patch" ? [{ kind: "install-pull-patch" } as const] : []), ...tail],
    };
  }

  private bind(request: SealedPullRequest, outcome: DaemonPullOutcome): DaemonPullOutcome {
    if (outcome.attemptId !== request.attemptId) {
      throw new Error(`pull transition: outcome for attempt ${outcome.attemptId} does not match ${request.attemptId}`);
    }
    return outcome;
  }

  private async applyEffect(
    effect: DaemonPullEffect,
    port: PullTransitionPort,
    postBase?: SyncState,
  ): Promise<SyncState | undefined> {
    switch (effect.kind) {
      case "clear-chain-repair": this.effects.clearChainRepair(); return undefined;
      case "record-propagation": this.effects.recordPropagation(effect.pendingAt); return undefined;
      case "settle-report": port.settleReport(); return undefined;
      case "record-file-conflicts": await this.effects.recordFileConflicts(effect.count); return undefined;
      case "refresh-matcher": await this.effects.refreshMatcher(); return undefined;
      case "adopt-post-base": return await this.effects.adoptPostBase();
      // Applied inline above: its RESULT (F1) selects the effects that follow it, so it
      // cannot be replayed blindly from the plan. It appears in the receipt for order.
      case "install-pull-patch": return undefined;
      case "scan-local": await this.effects.scanLocal(postBase!.lastSyncedManifest); return undefined;
      case "log": this.effects.log(effect.line); return undefined;
    }
  }
}
