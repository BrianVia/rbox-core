# Design 242 — daemon test process isolation

## Status

Implemented. Founder-ordered CI repair: remove the shared-state leaks; do not
regroup or serialize shards around them.

## 1. Failure and root cause

CI runs every whole-file unit assigned to a shard in one `bun test` process.
The rotating victims all use the direct-daemon harness, but their failed
assertions are downstream symptoms. Three test fixtures leave process-wide
state behind:

1. `daemon-trusted-pull.test.ts` deletes `RBOX_PULL_TRUST_WATCHER` and
   `RBOX_WATCHER_RETRUST` in every setup/teardown while saving only
   `RBOX_GIT_APPLY_LAZY`. The preload intentionally pins
   `RBOX_WATCHER_RETRUST=0`; after this file runs, later files see the production
   default instead of the shard baseline.
2. Direct-daemon fixtures publish their temporary roots into the one
   process-wide test folder catalog, but teardown removes only the directory.
   CI captured the resulting boundary refusal verbatim: an earlier
   `rbox-daemon-activity-*` root with the same workspace/device binding "also
   exists", after which 24 activity/notify/cursor tests failed or timed out.
3. `watcher-retrust.test.ts`, `daemon-trusted-pull.test.ts`, and
   `daemon-scan-defer.test.ts` partially dismantle daemon internals instead of
   awaiting `RboxDaemon.stop()`. Design 237 added a supervised 120-second
   watcher re-arm timer; the partial cleanup does not own or cancel it.

Four scan suites also install process-global `mock.module()` replacements for
`engine/hash.js`. Bun does not restore those replacements for later files, even
after `mock.restore()`. Their mutable closures are normally disarmed, but the
mocked module itself permanently changes every later importer and is therefore
not an isolated test primitive.

## 2. Protected functionality

- Keep duplicate live workspace/device binding refusal intact. It is a product
  safety boundary, not a test nuisance.
- Keep watcher re-trust, fuse, supervised re-arm, trusted-pull, lazy Git apply,
  manifest deferral, notify attribution, and cursor behavior unchanged.
- Keep CI's discovered weighted sharding and one-process-per-shard execution.
- Keep the real admitted-startup boundary in direct-daemon tests; do not add an
  admission bypass or weaken catalog inventory.
- Keep every command, protocol, durable format, compatibility path, migration,
  and performance fast path. This change is test lifecycle only, plus one
  behavior-neutral hashing seam used exclusively by tests.

## 2.1 Static state audit

The scoped search found 592 direct `process.env` assignments/deletions across 87
`src/cli/*.test.ts` and `src/cli/daemon/*.test.ts` files. Most already save and
restore their keys. Definite non-restoring writers were:

- `daemon-trusted-pull.test.ts`: two watcher flags;
- `daemon-mde-wiring.test.ts` and `e2ee-sync.test.ts`: four MDE flags;
- `remote-network-resilience.test.ts`: retry count;
- daemon binding/log/stop/logger/runtime/key-delivery fixtures: `RBOX_HOME`;
- account, doctor, JSON, keystore, genesis, login-journal, recovery-kit,
  update-check, and upgrade-daemon fixtures: `RBOX_HOME` and related
  credential/home variables.

Other direct env users in the requested trees either restore exact prior values,
or restore a complete environment snapshot.

The imported-module mutable-state search found no watcher, fuse, policy, or
monotonic-clock singleton. Relevant production globals were reviewed as follows:

- daemon trust/fuse/re-arm state is instance-owned;
- `daemon.ts`'s repository projection is a `WeakMap` keyed by caller-owned
  `SyncState` and cannot cross-contaminate fixtures;
- `local-workspace-observer.ts`'s monotonic sequence supplies identity only;
- `watcher.ts` caches an immutable native wrapper;
- warn-once, crypto-pool, credentials, genesis, recovery, style, and browser
  test hooks already have explicit reset/restore seams in their owning tests;
- immutable validation `Set`/`Map` tables are not mutable test state.

The exceptional process-global mechanism was Bun module mocking: four scan
files permanently replaced `engine/hash.js`, and an executable two-file probe
proved `mock.restore()` does not restore the later import.

## 3. Ownership and fix

### Environment

Each file that changes `process.env` saves prior values at the matching
`beforeEach`/`beforeAll` boundary and restores those exact values at
`afterEach`/`afterAll`. A preload-wide hook is deliberately rejected: Bun runs a
file's `afterAll` after preload `afterEach`, so a global hook would mask only
some omissions while claiming complete isolation. The edits repair every
definite clobber found by the audit; other audited writes already use exact
save/restore or a whole-environment snapshot.

### Daemon resources

`RboxDaemon.stop()` remains the sole complete lifecycle interface. Harnesses
must await it; they must not duplicate a list of currently known timers and
queues. This automatically includes future resources owned by the daemon.

### Folder admission fixture

`folder-admission.test-helper.ts` owns the complete fixture lifecycle:
`prepareDaemonFolderAdmission(root, cfg)` publishes the real binding/catalog
pair and `releaseDaemonFolderAdmission(root)` forgets that exact catalog entry.
Each caller releases once after every daemon for that root has stopped and
before deleting the root. Release is fail-safe even when shutdown rejects. For
fixtures that temporarily select another catalog with `RBOX_HOME`, the strict
order is: stop daemons, release while that same environment is installed,
restore the environment, then remove the filesystem. No global reset is used,
so concurrent roots cannot erase one another. The release is a thin call to the
existing locked/CAS `forgetFolder(root)` operation; repeated prepares of one
root still have one `(catalog, normalized root)` lifecycle.

### Hash fault injection

`engine/hash.ts` owns a tiny test-only override with an idempotent reset handle.
The handle clears only the exact override it installed, so a stale handle cannot
erase a newer override. Tests delegate ordinary work to the captured real
`hashFile`; they do not duplicate its small-file/streaming policy. The four fault
suites install in `beforeEach` and reset in `afterEach`. This removes permanent
`mock.module` state while preserving the real hash module and production call
sites. Exporting a live function binding adds no per-hash condition; the normal
binding points directly at the existing implementation.

## 4. Requirement challenges

| Incidental requirement | Cost | Decision |
|---|---|---|
| Keep catalog entries for deleted test roots | Accumulates shard-global authority and lets delayed work revive duplicates | Delete; fixture publication and release are one lifecycle. |
| Manually clear the timers a test currently knows about | Every new daemon resource creates another invisible leak | Delete; call the lifecycle owner. |
| Mock the whole hash module to fault one call | Permanently replaces code for unrelated files in Bun | Delete; inject only the physical hash effect and reset it. |
| Regroup/serialize shards | Hides ordering dependence and slows CI | Reject by founder direction. |

## 5. Safe deletion candidates

- The four `mock.module(hash)` blocks and their dynamic-import ordering are safe
  to delete once the resettable hash-effect seam covers the same faults.
- Manual `retryQueue.stop()`, watcher close, safety timer, deep timer, and drift
  timer teardown in affected harnesses is safe to delete only where
  `await daemon.stop()` supersedes it.
- No production behavior or safety check is a deletion candidate.

## 6. Validation

1. Before implementation, run the exact current shard-5/shard-6 one-process
   commands and preserve their output. The current local Bun did not replay the
   historical CI scheduling race unaided, so add deterministic end-of-file
   invariants to the files already in those exact shards and rerun the otherwise
   unchanged shard commands to expose the ambient leaks. These invariants are
   regression coverage, not a substitute for the exact-shard runs.
2. Run the exact current shard 5 and shard 6 commands three times each.
3. Run `bun test src/cli/` twice.
4. Run focused lifecycle/hash tests, `bun run typecheck`,
   `bun run lint:affected`, and `git diff --check`.
5. Crash/compatibility: existing daemon stop/drain, duplicate-binding refusal,
   watcher supervisor, manifest deferral, and trusted-pull contracts remain
   unchanged and green.
6. Performance: cleanup adds one catalog mutation per direct-daemon test and no
   production runtime work. The hash seam is a live binding to the existing
   implementation, not an extra branch in the file-hash hot path; focused scan
   timing must remain within ordinary filesystem variance.

## 7. Captured red proof

The unmodified exact local shard commands first passed on Bun canary
`6c12afd8e`; poisoned CI ran canary `b7a043103`, so scheduling alone did not
replay locally. Without changing either current file list or process shape, an
end-of-file invariant exposed the leaked ambient value in the owning file:

- exact shard 5 (`--shard-index 4`) with inherited
  `RBOX_HOME=/tmp/rbox-shard5-sentinel`: 913 pass / 2 skip / **1 fail**;
  expected the sentinel, received `undefined` in `daemon-stop.test.ts`;
- exact shard 6 (`--shard-index 5`): 846 pass / 4 skip / **1 fail**; expected
  preload `RBOX_WATCHER_RETRUST="0"`, received `undefined` in
  `daemon-trusted-pull.test.ts`.

The production-boundary failure was independently captured in CI: after an
earlier direct-daemon fixture remained live/catalogued, 24 rotating
activity/notify/cursor tests halted on `ambiguous: the same workspace and device
binding also exists at /tmp/rbox-daemon-activity-*`. These outputs identify the
leaked state rather than merely the rotating victims.
