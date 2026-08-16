/**
 * Measured runtime registry for the src test partitioner (scripts/ci-shard-tests.ts).
 * Data only — no CLI, so `bun run guards` can import it and hold the revert-guard
 * that PR #314 silently defeated when it restored the coarse hand-written table
 * (issue #699). Regenerate by timing each unit the partitioner emits.
 */

export type SplitFile = {
  parts: number;
  weight: number;
  partWeights?: number[];
};

export type DedicatedTest = {
  name: string;
  weight: number;
  antiAffinityGroup: string;
};

/** Provenance of FILE_WEIGHTS/SPLIT_FILES/DEDICATED_TESTS below. */
export const WEIGHTS_MEASURED = "seconds per unit, measured serially 2026-08-16 (591s total across 425 units)";

/** Mean measured cost of the 322 files below the FILE_WEIGHTS cut-off. */
export const DEFAULT_WEIGHT = 0.2;

/**
 * Seconds per whole test file. These hints keep the runtime partition balanced
 * without hardcoding complete shard file lists; every test is still discovered
 * from src/**\/*.test.ts and anything absent here weighs DEFAULT_WEIGHT.
 */
export const FILE_WEIGHTS = new Map<string, number>(Object.entries({
  "src/cli/sync-git/follow.test.ts": 87.7,
  "src/cli/sync-git/follow-matrix.test.ts": 41.1,
  "src/engine/dircache-bench.test.ts": 39.4,
  "src/cli/git-cmd.test.ts": 21.8,
  "src/cli/state-plane/migration/crash-matrix.test.ts": 21.2,
  "src/cli/e2ee-sync.test.ts": 15.6,
  "src/cli/state-plane/store/reads-leave-the-store-at-rest.test.ts": 12.9,
  "src/cli/state-plane/migration/io-halt-matrix.test.ts": 12.1,
  "src/engine/dircache.test.ts": 10.3,
  "src/cli/state-plane/reset/crash-rig.test.ts": 9.6,
  "src/cli/daemon/watcher.test.ts": 8.2,
  "src/cli/daemon/daemon-activity.test.ts": 7.6,
  "src/cli/auth-cmd.test.ts": 6.8,
  "src/cli/daemon/key-delivery-fulfill.test.ts": 6.8,
  "src/cli/remote/blob-batch/blob-batch.test.ts": 6.6,
  "src/cli/sync-git/reset-journal.test.ts": 5.3,
  "src/cli/state-plane/genesis-admission-crash-gate.test.ts": 5.2,
  "src/cli/state-plane/reset/recovery.test.ts": 4.8,
  "src/cli/remote-network-resilience.test.ts": 4.5,
  "src/cli/sync-git/lazy-apply-probes.test.ts": 4.4,
  "src/cli/design85-layer-a.test.ts": 4.3,
  "src/cli/state-plane/no-regression.test.ts": 3.9,
  "src/cli/git-config-sync.e2e.test.ts": 3.9,
  "src/cli/e2ee-client.test.ts": 3.6,
  "src/cli/daemon/daemon-git-capture.test.ts": 3.6,
  "src/cli/state-plane/migration/authority-behavior.test.ts": 3.5,
  "src/engine/e2ee/roster.test.ts": 3.5,
  "src/cli/daemon/daemon-trusted-pull.test.ts": 3.3,
  "src/cli/state-plane/store/cas-operations.test.ts": 3.2,
  "src/cli/dispatch-json.test.ts": 3.2,
  "src/engine/e2ee/session.test.ts": 3,
  "src/cli/sync-git/p-repair-transaction.test.ts": 3,
  "src/cli/genesis-enrollment.test.ts": 2.9,
  "src/cli/sync-git/git-state-apply.test.ts": 2.9,
  "src/cli/sync-git/state-cas-locks-crash.test.ts": 2.7,
  "src/engine/manifest-delta.bench.test.ts": 2.5,
  "src/cli/publish-pipeline/pipeline.test.ts": 2.4,
  "src/cli/sync-git/state-cas-journal.test.ts": 2.4,
  "src/engine/lockfile.test.ts": 2.4,
  "src/cli/sync-git/capture-identity.test.ts": 2.3,
  "src/cli/versions-restore.test.ts": 2.3,
  "src/engine/e2ee/epoch.test.ts": 2.2,
  "src/cli/sync-git/checkout-txn.test.ts": 2.2,
  "src/engine/manifest-walk-concurrency.test.ts": 2.2,
  "src/cli/state-plane/migration/guard-coverage.test.ts": 2.1,
  "src/cli/sync-git/sync-git-config-push.test.ts": 2.1,
  "src/cli/state-plane/genesis-crash-matrix.test.ts": 2,
  "src/cli/sync-git/sync-git-config-pull.test.ts": 2,
  "src/cli/daemon/daemon-git-ref-integration.test.ts": 1.9,
  "src/cli/state-plane-cmd.test.ts": 1.9,
  "src/cli/remote/blob-batch/upload-grant.test.ts": 1.9,
  "src/cli/sync/sync.test.ts": 1.8,
  "src/cli/watcher-compiled.test.ts": 1.8,
  "src/cli/prompt-ink.test.ts": 1.8,
  "src/cli/login-device-fsm.test.ts": 1.8,
  "src/cli/login-attempt-journal.test.ts": 1.7,
  "src/cli/sync-git/reachability.test.ts": 1.7,
  "src/cli/adopt-git.test.ts": 1.6,
  "src/cli/state-plane/compat-matrix.test.ts": 1.6,
  "src/cli/sync-git/keep-pins.test.ts": 1.4,
  "src/cli/adopt-overlay.test.ts": 1.4,
  "src/cli/upload-lane-timing.test.ts": 1.4,
  "src/cli/files-first.test.ts": 1.3,
  "src/engine/e2ee/recovery-admit.test.ts": 1.3,
  "src/cli/reset-consent.test.ts": 1.3,
  "src/cli/sync-git/journal.test.ts": 1.3,
  "src/engine/e2ee/pull-verify.test.ts": 1.3,
  "src/cli/sync-git/base-artifacts.test.ts": 1.3,
  "src/cli/remote/multipart-instrumentation.test.ts": 1.3,
  "src/cli/sync-git/pending-supersession.test.ts": 1.2,
  "src/cli/sync-git/republish-chain.contract.test.ts": 1.2,
  "src/engine/crypto-pool/crypto-fused.test.ts": 1.2,
  "src/cli/genesis-witness.test.ts": 1.2,
  "src/cli/status-cmd.test.ts": 1.2,
  "src/cli/remote/blob-batch/pack-upload.test.ts": 1.2,
  "src/cli/state-plane/adapters/whole-state-compat.test.ts": 1.1,
  "src/cli/shell-init.test.ts": 1.1,
  "src/cli/setup-cmd.test.ts": 1,
  "src/engine/e2ee/e2ee-e2e.test.ts": 1,
  "src/cli/daemon/local-workspace-observer.contract.test.ts": 1,
  "src/cli/sync-git/base-composer-structure.test.ts": 1,
  "src/cli/sync-git/received-git-transition-commit.contract.test.ts": 1,
  "src/cli/doctor-cmd.test.ts": 0.9,
  "src/cli/doctor-triage.test.ts": 0.9,
}));

/**
 * Files too slow to fit a shard whole. Split by test names discovered from the
 * source at runtime; the partitioner's guard verifies every discovered test name
 * in these files is covered exactly once.
 */
export const SPLIT_FILES = new Map<string, SplitFile>(Object.entries({
  "src/cli/sync-git/git-sync.test.ts": { parts: 12, weight: 64.4, partWeights: [4.1, 3.9, 3.9, 5.1, 5.2, 6.3, 5.1, 6, 4.9, 10.8, 5.5, 3.6] },
  "src/cli/sync-git/git-nested.test.ts": { parts: 4, weight: 3.6, partWeights: [0.7, 1, 1.1, 0.8] },
}));

/**
 * Subprocess-heavy end-to-end workflows that have repeatedly exhausted their caps
 * together on contended runners. Standalone units let the partitioner spread them
 * without depending on source-order bucket positions.
 */
export const DEDICATED_TESTS = new Map<string, DedicatedTest[]>(Object.entries({
  "src/cli/sync-git/git-sync.test.ts": [
    { name: "design 53: fresh join fetch/import work is bounded by repos times MAX_PACK_CHAIN", weight: 1, antiAffinityGroup: "git-sync-process" },
    { name: "git artifact sha_mismatch re-encrypts and retries with resumable uploadsDir", weight: 0.3, antiAffinityGroup: "git-sync-process" },
    { name: "D2 apply deferral keeps chronic age across newer truth and resets reason age", weight: 0.7, antiAffinityGroup: "git-sync-process" },
    { name: "pending + 422: failed retries preserve P and all sidecars byte-for-byte", weight: 1.1, antiAffinityGroup: "git-sync-process" },
    { name: "clean materialization with a ref-wiping hook defers before stranding a sibling worktree branch", weight: 0.6, antiAffinityGroup: "git-sync-process" },
  ],
}));

/**
 * Files whose transport family is subprocess/crypto heavy as a whole. Kept unsplit
 * so nested describe names retain Bun's normal matching semantics.
 */
export const WHOLE_FILE_ANTI_AFFINITY = new Map<string, string>(Object.entries({
  "src/cli/e2ee-sync.test.ts": "git-sync-process",
}));
