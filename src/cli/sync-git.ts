export { gitReposManifestSchema, gitIncomingKey, nextDeferral } from "./sync-git/shared.js";
export { gitConfigHash, shouldPublishGitConfig, type CachedLocalCfg } from "./sync-git/config-lane.js";
export {
  planGitSections,
  formatGitPushLine,
  formatGitPlanStats,
  gitBaseAfterCommit,
  gitForceForMissingBlobs,
  type GitPushPlan,
  type GitPlanStats,
  type GitPlanOptions,
} from "./sync-git/plan.js";
export {
  GIT_FINGERPRINT_VERSION,
  GIT_FINGERPRINT_RACY_CLEAN_MARGIN_MS,
  gitFingerprintVersionForBounds,
  type GitConfigWireBounds,
} from "./sync-git/fingerprint.js";
export { gitDivergenceFastRepoSource, classifyDivergenceCacheEntry, type GitDivergenceRepoHint } from "./sync-git/divergence-cache.js";
export {
  applyGitSections,
  revalidateGitPartialApplies,
  withRevalidatedGitPartialApplies,
  formatGitApplyMetrics,
  type GitPullOutcome,
  type GitApplyRunKind,
  type GitApplyRepoResult,
  type GitApplyRepoTiming,
  type GitApplyMetrics,
} from "./sync-git/apply.js";
export { gitDivergenceStatus, gitDivergenceCount, type GitDivergenceStatus, type GitDivergenceStatusOptions } from "./sync-git/status.js";
