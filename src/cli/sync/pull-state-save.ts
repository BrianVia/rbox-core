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
import { observedRepoKeys, orderedRepoDeferralUpdates, saveStateSource, type StateSource } from "../sync-state.js";
import { repoRecordsForState, syncStreamId, type WorkspaceConfig } from "../config.js";
import type { SyncDeps } from "./deps.js";
import { formatCasSteps } from "./format.js";

type GitOutcome = Awaited<ReturnType<typeof applyGitSections>>;
type ScopedPull = Awaited<ReturnType<typeof prepareScopedPull>>;

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
  /** Only the standalone pull line carries elision provenance. */
  elisionEligible: boolean;
}

/** Every gate on minting elision provenance, in one place. A degraded mutex
 * yields no receipt because a degraded pull's git lanes are disabled, so its
 * "nothing changed" is a statement about a narrower observation. */
export function pullElisionReceipt(
  input: Pick<PullStateSave, "deps" | "state" | "scoped" | "manifestMeta" | "noActions" | "elisionEligible">,
): ElisionReceipt | undefined {
  if (!input.elisionEligible || workspaceSyncMutexDegraded(input.deps.syncMutex)) return undefined;
  return elisionReceipt(input.state, {
    noActions: input.noActions,
    storedBaseIsRemote: input.scoped.storedBaseIsRemote,
    manifestMeta: input.manifestMeta,
  });
}

export async function savePulledState(input: PullStateSave): Promise<SyncState> {
  const { root, cfg, deps, report, state, scoped, gitOutcome, sequence } = input;
  const values = {
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
  const receipt = pullElisionReceipt(input);
  const casStepMs: Record<string, number> = {};
  const source: StateSource = {
    expectedStream: syncStreamId(cfg),
    sourceGlobalSeq: sequence,
    globalManifest: scoped.storedBase,
    observedRepos: scoped.probeKeys(observedRepoKeys(state, input.remoteGitRepos, values)),
    values,
    repoProofs: gitOutcome.repoProofs,
    elisionReceipt: receipt,
  };
  // The meta is persisted only alongside an unprojected remote base; a scoped
  // projection must never carry another base's meta forward.
  if (scoped.storedBaseIsRemote && input.manifestMeta) source.manifestMeta = input.manifestMeta;
  const savedState = await withRevalidatedGitPartialApplies(root, state, gitOutcome, () =>
    report.phase("state-save", () => saveStateSource(root, state, source, {
      allowLegacyStreamReplacement: deps.syncMutex === undefined && stateWasStreamMismatch(state),
    })), {
    mutationBoundary: deps.mutationBoundary,
    observeStep: report.enabled ? (step, ms) => { casStepMs[step] = (casStepMs[step] ?? 0) + ms; } : undefined,
  });
  report.appendDetails("state-save", { cas: casStepMs }, formatCasSteps(casStepMs));
  const settleT0 = Date.now();
  const settled = await settleCommittedBranchArtifacts(root, savedState, gitOutcome, deps.mutationBoundary);
  report.appendDetails("state-save", { settleArtifactsMs: Date.now() - settleT0 }, `settle${((Date.now() - settleT0) / 1000).toFixed(1)}`);
  return settled;
}
