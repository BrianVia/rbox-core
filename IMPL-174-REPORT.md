# Design 174 U1+U2 implementation report

## Outcome

Implemented the core design-174 units from `SPEC-174-IMPL.md` against the ALIGNED v4 design. U1 held-skip and U2 pending supersession are default-on, independently kill-switchable, fail closed on unstable or incomplete proof inputs, and preserve the existing BASE authority model.

## U1 — held-skip

- Added the closed `TypedBlocker` provenance union and made every follow result carry the complete classification blocker set.
- Merged ref-plane, checkout/boundary, protocol-hold, and composer-pending blockers before recording a held attempt.
- Added the local-only `RepoRecord.attempt` sidecar with omission-preserves/null-clears generation-CAS behavior.
- Bound attempts to the incoming key, stable fingerprint bracket/version, exact consulted reflog byte digests, repository identity, state nonce, BASE/origin hash, partial disposition, sorted blockers, and observation time.
- Added the post-P/K-settlement attempt rebind so the immediately following pull can use the final durable BASE/origin and physical fingerprint.
- Added the non-vacuous `{local-commits, local-stash}` allowlist, one-hour safety floor, fingerprint-miss warning canary, attempt refresh, and `RBOX_GIT_HELD_SKIP=0` kill switch.
- Placed the skip decision after journal recovery, protocol/P settlement, and partial revalidation. The skip performs only the ordered apply-deferral `lastSeen` refresh and reports `skippedHeld` in Git apply metrics.
- Added structural preflight rejection for `info/grafts` and `shallow.lock`; literal graph classification disables replace objects as well as lazy fetch.

## U2 — pending supersession

- Added a fingerprint-gated pending pre-probe that carries P on busy/unreadable/unsupported state and admits only provisional candidates to forced capture.
- Added an exhaustive `JournalRecoveryResult.status` gate with a compile-time `never` check. Blocking/corrupt/human/fresh-quarantined outcomes carry P.
- Added final normalized candidate proof for branch FF/equality, exact tags/stash/HEAD/refScope/config/op-state/index semantics, with every graph peel/ancestor command using `GIT_NO_REPLACE_OBJECTS=1` and `GIT_NO_LAZY_FETCH=1`.
- Extended tombstone normalization with P as an explicit retention/high-water source while leaving advertised-only authoring predecessor semantics unchanged.
- Protected P, partial, attempt, and every deferral lane from all pre-ACK planner/upload/commit/retry writes. Capture failure, upload failure, 422, commit error, and 409 retain the complete P-bound record byte-for-byte.
- Added candidate-bound supersession receipts. Only the accepted publisher-ACK transition removes P, clears partial and attempt, and predecessor-conditionally clears the apply deferral; unrelated deferral lanes survive.
- Added `RBOX_GIT_PENDING_SUPERSEDE=0`. Baseless/composer-owned pending state fails closed and remains an exact carry.
- Preserved the existing typed BASE composer and publisher-ACK authority; no new BASE authority arm or direct BASE write was added.

## Required regression coverage

- Real-transition livelock regression: busy pull creates P; the writer advances `main`, retains an omitted prior branch/origin, carries an exact stash created off a side branch, supersedes through final-candidate proof, clears the four ACK sidecars, and converges on a fresh follower.
- Held-skip ordering/correctness, ref mutation invalidation, non-Git blocker refusal, floor refresh/warning, kill switch, state nonce/repository identity/fingerprint-version invalidation, and no-BASE-mutation assertion.
- Pending missing/non-FF/equal proofs, final-candidate race, replace-ref laundering refusal, pending-only tombstone retention/high-water, busy/kill-switch behavior, and exhaustive journal dispositions.
- Pre-ACK failure coverage for capture/upload, 422, commit error, and multi-writer 409 with byte-exact P/partial/attempt/deferral assertions.
- Reflog-only T→U→T mutation, mixed blocker non-skip cases, empty blocker refusal, graft rejection, and structural ownership gates.

## Validation

- `bun run typecheck` — passed.
- `bun test src/cli src/engine` — passed: 2,610 passed, 16 skipped, 0 failed across 214 files (2,626 total).
- Focused design-174 suites — passed: held-skip/pending/state/structural tests, six A orchestration tests, and four B/422 integration tests.
- `bun run test:api` — sandbox startup failure before test execution because Vite attempted to write the read-only shared path `/home/via/Development/Personal/rbox-core/node_modules/.vite-temp/...`.
- `bunx vitest run --configLoader runner` from `apps/api` — passed the same API suite: 781 passed, 4 skipped, 0 failed across 46 files (785 total). Wrangler emitted a non-fatal read-only log-file warning.
- `git diff --check` — passed.

## Deviations

None. The API command-line workaround changes only Vitest config loading to avoid the sandbox's read-only shared dependency cache; it does not change source or test behavior.

## Files touched

- Ownership/docs: `docs/CODEMAP.md`, `IMPL-174-REPORT.md`.
- State/contracts: `src/cli/config.ts`, `src/cli/sync-state.ts`, `src/cli/sync/pull.ts`, `src/cli/sync/push.ts`.
- U1: `src/cli/sync-git/held-skip.ts`, `src/cli/sync-git/apply.ts`, `src/cli/sync-git/follow.ts`, `src/engine/git/preflight.ts`, `src/engine/git/reachability.ts`.
- U2: `src/cli/sync-git/pending-supersession.ts`, `src/cli/sync-git/plan.ts`, `src/cli/sync-git/publisher-tombstones.ts`.
- Tests: `src/cli/apply-stats-format.test.ts`, `src/cli/e2ee-sync.test.ts`, `src/cli/sync-git/follow.test.ts`, `src/cli/sync-git/git-sync.test.ts`, `src/cli/sync-git/held-attempt-state.test.ts`, `src/cli/sync-git/held-skip.test.ts`, `src/cli/sync-git/pending-supersession.test.ts`, `src/cli/sync-git/publisher-tombstones.test.ts`.

IMPL-COMPLETE

## Quality pass

Completed `FIX-PLAN-174-QUALITY.md` against the committed partial pass. Each ID was first audited in the current tree; none was fully already-applied, and the partially placed A3 invariant was completed at its required declaration. The design contracts and all five `SPEC-174-IMPL.md` inviolables remain unchanged.

- S1 — applied: both ownership-indeterminate paths now retain physical held-ref state while emitting only the `indeterminate` typed blocker; later ref-plane and checkout projections cannot re-add `local-commits`/`local-stash` blockers.
- R1 — applied: both local canonicalizers were removed in favor of `canonicalString`; audited inputs contain only supported JSON values and non-negative integer sizes/generations.
- R2 — applied: `graphEnv` is exported from reachability and is the sole pending-proof graph environment.
- R3 — applied: `indexArtifact` is exported with strict/throwing mode and the pending-proof copy was removed.
- D1 — applied: removed duplicated `metrics.skippedHeld` state; the `skippedHeld=` summary token now reads `results.skipped` directly.
- D2 — applied: all 14 attempt clears use the separate `clearAttempt` helper.
- D3 — applied: both partial-state lookups use `currentPartial`.
- D4 — applied: attempt omission uses destructuring rather than an IIFE/delete copy.
- D5 — applied: the two hand-built blocker returns use the shared progress/defer path.
- D6 — applied: `deferResult` removes repeated reason/detail/blocker construction from defer returns.
- D7 — applied: repeated four-field sidecar serialization uses `sidecarSnapshot`.
- D8 — applied: `HELD_SKIP_SAFETY_FLOOR_MS` is module-private.
- E1 — applied: removed the discarded `readAllRefs` call from held observation.
- E2 — applied: missing pending state short-circuits before `observeHeldInputs`.
- E3 — applied: the stable pending pre-probe fingerprint/preflight/identity snapshot is threaded into and reused by the slow path.
- E4 — applied: post-settlement attempt rebinds use one multi-repo state packet and one reload while retaining each repo's exact generation CAS.
- E5 — applied: independent per-ref supersession proofs run through `Promise.all`.
- A1 — applied: post-settlement attempt CAS rebind is the exported `rebindHeldAttemptsAfterSettlement` collaborator in `held-skip.ts`.
- A2 — applied: capture commit/revert bookkeeping is paired through named helpers next to the state it updates.
- A3 — applied: the two-line normalize-once/prove-exact-object invariant is at the `finalizedOutgoing` declaration.
- C1 — applied: CODEMAP now names pending-candidate flow, held-skip orchestration, and batched attempt rebind ownership.

Binding skipped items:

- skipped: no shared fetch-and-project-index helper was introduced.
- skipped: `IMPL-174-REPORT.md` was retained and extended.
- skipped: attempt clearing remains separate from deferral helpers.

Acceptance:

- `bun run typecheck` — passed.
- `bun test src/cli src/engine` — passed: 2,610 passed, 16 skipped, 0 failed across 214 files.
- `bunx vitest run --configLoader runner` from `apps/api` — passed: 781 passed, 4 skipped, 0 failed across 46 files; the existing non-fatal Wrangler read-only log warning was emitted.
- Focused quality/design-174 suites and `git diff --check` — passed.
- Independent adversarial re-audit — all IDs applied; binding skips and inviolables intact; no remaining correctness issue found.

QUALITY-COMPLETE

## U3-U5 (periphery; codex cut at founder's 15-min box after substance complete, residue closed by orchestrator)

- U3: GitChainTimings exclusive leaves (refTxnExclusiveMs, ownershipMs, reflogMs,
  connectivityProofMs) + residual; classifyMs reported as nested parent, excluded
  from the leaf sum. C2 `sync_phase` telemetry: client emitter
  (src/cli/telemetry/sync-phase.ts, N=8 + outlier always-emit pull>20s/push>15s),
  contract kind (contract.ts), server ingest (apps/api telemetry-ingest.ts,
  additive). No repo paths in samples.
- U4: conflict-retention (src/cli/sync-git/conflict-retention.ts): namespace-
  confined inventory (structural throw on escape), prune = owned-by-branch OR
  >90d namespace timestamp, indeterminate → prune nothing, cap 64/push,
  old-OID-checked single transaction, divergence-cache refresh via onBatch.
  `rbox status` surfaces `conflict snapshots: N (M prunable)`.
- U5: push-tail sub-timing (src/cli/push-tail-timing.ts) — missing/commit chunk
  counts, per-chunk p95, payload bytes in the push summary.
- Orchestrator additions in the same window: the design-§4.2 mandated
  `git-sync superseded pending <rel>` line at the accepted-ACK clear (was
  missing); rig scenario scripts/rig/scenarios/git-held-livelock.ts (registered,
  explicit-only).
- Gates (native): typecheck 0; cli+engine 2636/0 across 217 files; API green.
IMPL2-COMPLETE
