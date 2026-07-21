# Design 175 adversarial review — round 3 (Codex)

## Verdict: ALIGNED

V3 resolves every round-2 finding against the actual source seams and is
decision-complete for clear-spec implementation dispatch. No new MAJOR+
finding emerged. The two residual wording issues below are editorial only:
the exact floor formula, pointer carve, and invariant 4 already determine the
implementation unambiguously.

## Round-2 convergence ledger

| R2 finding | V3 disposition after source verification |
|---|---|
| 1. Reftable authority/cache carry | **Resolved.** The design now makes repository config (`extensions.refStorage`) the single authority for both `gitPreflight` and registry pre-attach, rather than inferring from the misleading `refs/heads` sentinel layout (`docs/design/175-git-ref-sidechannel.md:283-290`). A live Git 2.54 check returned `reftable` for `git init --ref-format=reftable`. The required `GIT_FINGERPRINT_SCHEMA_VERSION` increment closes the trusted-carry bypass: the schema contributes to `GIT_FINGERPRINT_VERSION` (`src/cli/sync-git/fingerprint.ts:7-30`), the divergence-cache file version is exactly that value (`src/cli/sync-git/divergence-cache.ts:10-13`), and a mismatch discards all cached probes (`src/cli/sync-git/divergence-cache.ts:88-97`). The seeded-old-cache regression is mandatory. |
| 2. Floor formula/pointer contradiction | **Resolved normatively.** The formula now pins only for an authoritative in-tree `dir`, a **dir-owned** armed/attaching/failed root, or reader death; pointer-only and out-of-root pointer shapes are expressly non-pinning and outside invariant 4 (`docs/design/175-git-ref-sidechannel.md:243-259,376-383`). This matches the chosen 172-parity policy. The added realpath canonicalization and containment check is necessary because `repoCtxFromDisk` only uses lexical `path.resolve` (`src/engine/git/shared.ts:299-328`) and now closes invariant 5 before attach (`docs/design/175-git-ref-sidechannel.md:261-264`). |
| 3. False descriptor bound | **Resolved.** V3 withdraws the lifetime-descriptor bound, states the count-to-attach and populated-move-in exceptions, and replaces the claim with a fully specified admission walk: streaming `opendir`, no symlink following, combined heads+tags accounting, 512-directory and 8192-entry defaults, early stop at budget+1, and fail-to-shallow/pending disposition (`docs/design/175-git-ref-sidechannel.md:177-195`). That matches Bun 1.3.14: initial recursive attach performs its own `walkAndAdd`, and live directory arrival calls `addOne` plus `walkAndAdd` before the JS batch flush while ignoring descendant-add results. The required race/growth tests cover both unavoidable holes. |
| 4. Busy retry/`packed-refs.lock` | **Resolved.** V3 requires `packed-refs.lock` in both busy state and fingerprint invalidation; both are absent today (`src/engine/git/shared.ts:562-572`, `src/cli/sync-git/fingerprint.ts:204-224`). `SyncDeps.onGitBusyDeferred` is the sole, non-throwing seam immediately after every completed plan and before state-save/upload/commit, which is the source-valid placement directly after `planGitSections` in `runPushAttempt` (`src/cli/sync/push.ts:398-414`). One workspace episode owns absolute +2s/+8s retries, retry reports cannot extend it, close cancels it, and completion of retry two resets it (`docs/design/175-git-ref-sidechannel.md:113-128`). The final-callback-suppressed test explicitly covers both branch and packed-ref locks. |
| 5. Observer settlement | **Resolved.** The observer now uses the source type `readonly DiscoveredGitRepo[]`, is awaited and non-rejecting, and settles only after every input is armed or pending/floor with the arm handshake queued (`docs/design/175-git-ref-sidechannel.md:218-230`). The two named insertion points are real: genesis discovers immediately before its early return and the ordinary path discovers before planning work (`src/cli/sync-git/plan.ts:224-247`). The closed-registry no-op also matches daemon shutdown, which closes the watcher before draining the active pump (`src/cli/daemon/daemon.ts:699-735`). |
| 6. Reconcile ordering/snapshot horizon | **Resolved.** All inputs now enter one epoch-serialized pump; superseded generations cannot publish and must close new handles. The sole shrinking safety snapshot carries both start epoch and completeness, cannot remove post-start-touched owners, and becomes non-shrinking on I/O failure or relevant epoch advance (`docs/design/175-git-ref-sidechannel.md:164-175`). This directly covers the source hazard that `discoverGitRepos` currently converts a failed `readdir` into an empty listing (`src/engine/git-discover.ts:28-52`). Both stale-attach and candidate-during-snapshot races are mandatory tests. |
| 7. Candidate/provenance carrier | **Resolved.** Today's `SignalDebouncer.push()` and no-argument flush cannot carry either candidate work or ancestry (`src/cli/daemon/watcher.ts:98-101,140-165`). V3 changes the seam to `push(reason, candidate?)`, ORs reason bits, monotonically coalesces bounded per-owner `{dirty, discover}` state, atomically snapshots/clears it, performs targeted discovery first, and only then merges provenance into the queued push (`docs/design/175-git-ref-sidechannel.md:83-92`). Overflow degrades to ordinary full-plan discovery without entering the file plane. This is sufficient for pointer rewrite/delete and recreate coalescing. |
| 8. Enqueue and terminal boundaries | **Resolved.** Every enqueue is converted to `requestPush(reason)` with explicit reason mapping; this includes the current direct startup assignment and the scan/pull/retry sites (`src/cli/daemon/daemon.ts:515-516,747-755,1003-1042,1335-1380`). The provenance snapshot occurs where `want[op]` is consumed, remains active across `pushManifest`'s internal recovery loop, and reasons arriving meanwhile remain pending (`docs/design/175-git-ref-sidechannel.md:301-317`). Every normal return, including `committed:false`, counts before later daemon bookkeeping; throws and terminal-blocked returns discard only the active snapshot. The site-enumerated conversion test prevents an untyped enqueue from surviving. |
| 9. Lost dispatch scope | **Resolved.** The mandatory product-level Parcel flood test is restored (`docs/design/175-git-ref-sidechannel.md:410-413`), and the same-PR `docs/CODEMAP.md` ownership/never-own entry for the new daemon module is explicit in sizing (`docs/design/175-git-ref-sidechannel.md:429-434`). |

## Non-blocking editorial cleanup

1. The heading still calls the fix a “bounded Bun `fs.watch` side-channel”
   (`docs/design/175-git-ref-sidechannel.md:28`) even though the descriptor
   bound is explicitly withdrawn at lines 181-185. “Admission-budgeted” or
   simply deleting “bounded” would keep the summary aligned with the settled
   contract.

2. The bounds/backoff shorthand says all over-cap/read-fault/attach-failed
   repos are “floor-eligible” or “pending/floor”
   (`docs/design/175-git-ref-sidechannel.md:177-201`). Qualifying those phrases
   with “for dir-backed ownership” would mirror the exact formula at lines
   246-258. This does not create an implementation choice: that formula says
   “ONLY dir-backed ownership pins,” and invariant 4 repeats the pointer carve.

The architecture, lifecycle seams, failure dispositions, concurrency ordering,
telemetry boundaries, and required evidence are now aligned. Implementation
can dispatch from v3 without inventing policy.

R175R3-DONE
