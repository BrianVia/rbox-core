/**
 * The pull's one state-save: it turns the git-apply outcome and the scoped base
 * into the single StateSource the generation CAS consumes, and it is the only
 * place a design 267 elision receipt is minted.
 *
 * Receipts are pull-owned evidence, never inferred from packet shape. A degraded
 * mutex, an unscoped-base flip, a non-standalone pull line, an uninitialized
 * lineage — any of them simply yields no receipt, and the save composes the full
 * packet exactly as it always has.
 */
import type { GitSection, PhaseReport } from "../../engine/index.js";
import type { applyGitSections } from "../sync-git.js";
import { settleCommittedBranchArtifacts, withRevalidatedGitPartialApplies } from "../sync-git.js";
import type { prepareScopedPull } from "../scope/pull-scope.js";
import { stateWasStreamMismatch } from "../state-plane/reset-lineage.js";
import { workspaceSyncMutexDegraded } from "../sync-mutex.js";
import { elisionReceipt, type ElisionReceipt } from "../sync-state-elision.js";
import type { GlobalManifestMeta, SyncState } from "../sync-state-model.js";
import { observedRepoKeys, orderedRepoDeferralUpdates, saveStateSource, type RepoStateValues, type StateSource } from "../sync-state.js";
import { repoRecordsForState, syncStreamId, type WorkspaceConfig } from "../config.js";
import type { SyncDeps } from "./deps.js";
import { formatCasSteps } from "./format.js";

type GitOutcome = Awaited<ReturnType<typeof applyGitSections>>;
type ScopedPull = Awaited<ReturnType<typeof prepareScopedPull>>;

/**
 * Which lane ran this pull. A `standalone` pull is the whole cycle — it loaded
 * the state it reconciled against and observed every action — so it may mint a
 * design 267 elision receipt. `recovery` is a pull nested inside another
 * operation's retry loop (push's 409/pull-first arms): it observes a narrower
 * slice, so it never mints one.
 */
export type PullProvenance = "standalone" | "recovery";

export interface PullStateSave {
  root: string;
  cfg: WorkspaceConfig;
  deps: SyncDeps;
  report: PhaseReport;
  /** The snapshot this pull reconciled against, after lineage initialization. */
  state: SyncState;
  scoped: ScopedPull;
  gitOutcome: GitOutcome;
  sequence: number;
  manifestMeta?: GlobalManifestMeta | undefined;
  remoteGitRepos?: Record<string, GitSection> | undefined;
  /** The UNFILTERED reconcile action list was empty. `actions` is not it. */
  noActions: boolean;
  /** Only a standalone pull owns the whole observation a receipt claims. */
  provenance: PullProvenance;
}

/** Every gate on minting elision provenance, in one place. A degraded mutex
 * yields no receipt because a degraded pull's git lanes are disabled, so its
 * "nothing changed" is a statement about a narrower observation. */
export function pullElisionReceipt(
  input: Pick<PullStateSave, "deps" | "state" | "scoped" | "manifestMeta" | "noActions" | "provenance">,
): ElisionReceipt | undefined {
  if (input.provenance !== "standalone" || workspaceSyncMutexDegraded(input.deps.syncMutex)) return undefined;
  return elisionReceipt(input.state, {
    noActions: input.noActions,
    storedBaseIsRemote: input.scoped.storedBaseIsRemote,
    manifestMeta: input.manifestMeta,
  });
}

/** Every repo-state member the git outcome owns, read from the outcome AS IT
 * STANDS. The CAS window withdraws repositories by reassigning these containers,
 * so the packet must re-derive them inside the window (design 279 §0, #785). */
export function outcomeRepoValues(gitOutcome: GitOutcome, state: SyncState): RepoStateValues {
  return {
    bases: gitOutcome.gitRepos,
    branchBaseOrigins: gitOutcome.branchBaseOrigins,
    pending: gitOutcome.gitPendingRemote,
    removed: gitOutcome.gitReposRemoved,
    resolutions: gitOutcome.gitNeedsResolution,
    configLane: gitOutcome.configLane,
    deferrals: orderedRepoDeferralUpdates(repoRecordsForState(state), gitOutcome.deferrals),
    partial: gitOutcome.partial,
    attempt: gitOutcome.attempt,
    idxProj: gitOutcome.idxProj,
  };
}

export async function savePulledState(input: PullStateSave): Promise<SyncState> {
  const { root, cfg, deps, report, state, scoped, gitOutcome, sequence } = input;
  const values = outcomeRepoValues(gitOutcome, state);
  const receipt = pullElisionReceipt(input);
  const casStepMs: Record<string, number> = {};
  let casCounts: { locks: number; blocked: number } | undefined;
  const source: StateSource = {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: sequence,
    globalManifest: scoped.storedBase,
    observedRepos: scoped.probeKeys(observedRepoKeys(state, input.remoteGitRepos, values)),
    values,
    repoProofs: gitOutcome.repoProofs,
    elisionReceipt: receipt,
    baseIsUnscopedRemote: scoped.storedBaseIsRemote,
  };
  // The meta is persisted only alongside an unprojected remote base; a scoped
  // projection must never carry another base's meta forward.
  if (scoped.storedBaseIsRemote && input.manifestMeta) source.manifestMeta = input.manifestMeta;
  const savedState = await withRevalidatedGitPartialApplies(root, state, gitOutcome, () => {
    // Only the outcome-derived members are refreshed here: `observedRepos` is
    // key-set invariant across the window, and rebuilding the whole source would
    // drag probeKeys/receipt I/O inside the held locks (design 279 §0).
    source.values = outcomeRepoValues(gitOutcome, state);
    source.repoProofs = gitOutcome.repoProofs;
    return report.phase("state-save", () => saveStateSource(root, state, source, {
      allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
    }));
  }, {
    mutationBoundary: deps.mutationBoundary,
    observeStep: report.enabled ? (step, ms) => { casStepMs[step] = (casStepMs[step] ?? 0) + ms; } : undefined,
    observeLockCounts: (locks, blocked) => { casCounts = { locks, blocked }; },
  });
  const casDetails = casCounts ? { cas: casStepMs, casCounts } : { cas: casStepMs };
  report.appendDetails("state-save", casDetails, formatCasSteps(casStepMs, casCounts));
  const settleT0 = Date.now();
  const settled = await settleCommittedBranchArtifacts(root, savedState, gitOutcome, deps.mutationBoundary, deps.onGitLog);
  report.appendDetails("state-save", { settleArtifactsMs: Date.now() - settleT0 }, `settle${((Date.now() - settleT0) / 1000).toFixed(1)}`);
  return settled;
}
