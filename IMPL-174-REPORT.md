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
