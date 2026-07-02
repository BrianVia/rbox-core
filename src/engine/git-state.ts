// Barrel for the git-state feature (design 02 v3 + §28 + design 43). The implementation
// lives in ./git/* — split along its natural seams (shared primitives, refs/op-state,
// scratch pinning, preflight, identity, capture, apply, quarantine, containment) — but the
// import surface stays exactly here so no consumer (engine/index.ts, cli/sync.ts,
// cli/daemon.ts, the git test suites) has to change.

// Re-exported for compat: these moved to manifest-validate.ts (pure — validateManifest
// validates gitRepos values, and manifest-validate must stay node:*-free for the Worker).
export { isSyncableRef, validateGitSection } from "./manifest-validate.js";

export type { GitRepoKind } from "./git/shared.js";
export { gitPreflight, isGitBusy, type GitPreflightResult } from "./git/preflight.js";
export { gitIdentity, gitIdentityKey, projectIdentity, type GitIdentity } from "./git/identity.js";
export { captureGitState } from "./git/capture.js";
export { applyGitState, type ApplyGitResult } from "./git/apply.js";
export { quarantineAndWipeGitState, preserveGitConflict } from "./git/quarantine.js";
export { assertGitTargetWithinRoot } from "./git/containment.js";
