# REVIEW-108 — adversarial review ledger for design 108 (files-first first publish)

Codex (gpt-5.6-sol) adversarial review loop against `docs/design/108-files-first-publish.md`.
Attack surface: design-93 atomicity violations, orphaned-history states, GC
interactions with pending-attach chains (retained roots), resume
double-charging, receiver repo-materialization races. Target: ALIGNED, cap 5
rounds.

## Round 1 (gpt-5.6-sol) — VERDICT: REVISE (2 BLOCKER, 8 MAJOR, 2 MINOR, 1 NIT)

Findings and dispositions (v1 → v2):

1. BLOCKER — `gitAttachRemaining` manifest scalar incompatible with design-84 fold /
   `FileOnlyManifest` / `manifestFromMeta` (reconstructs only generatedAt/files/schema/gitRepos).
   **DISPOSITION: ACCEPTED — dropped the wire count entirely from v1** (§3.5). The joiner-side
   "pending" signal is now a founder/follow-up question, not a v1 mechanism.
2. BLOCKER — `attachOwed` can't be atomically set via the existing ACK packet (deferred repos
   aren't in `observedRepoKeys`/`committed.gitRepos`; crash after commit-1 ACK forgets them).
   **DISPOSITION: ACCEPTED — dissolved.** v2 drops the cursor as a required mechanism: the owed
   set is DERIVED from "discovered repos absent from base.gitRepos" (base has no git after
   commit 1), re-computed each push exactly like today's git-plan → crash-safe by construction,
   nothing to atomically create.
3. MAJOR — owed-cursor lifecycle undefined on repo delete/identity-change/syncGit-off.
   **DISPOSITION: ACCEPTED — dissolved** by #2: the attach push captures CURRENT disk truth via
   ordinary `planGitSections`; removed/changed/disabled repos are handled by existing rules.
4. MAJOR — publisher-loss makes receiver "pending" non-self-healing (local-only cursor).
   **DISPOSITION: ACCEPTED — scoped + honest exposure.** Guarantee bounded to resumption by the
   same surviving publisher; git history lives in the publisher's local `.git`; §3.4 + §8 Q.
5. MAJOR — upload ≠ entitlement (design 98: PUT mints ephemeral receipt; only redemption grants
   `blob_refs`; missingBlobs reports unredeemed-present as unsatisfied).
   **DISPOSITION: ACCEPTED — corrected.** v2: git attaches through the ORDINARY commit
   redeem+admit path (commit 2 is a normal push); no separate "missingBlobs empty" pre-gate; the
   orphan window is the ordinary design-98 within-push window (§3.3).
6. MAJOR — 422 recovery asserted, not integrated with the real retry state machine.
   **DISPOSITION: ACCEPTED — dissolved:** commit 2 IS `runPushAttempt` scoped to git; 422 →
   `gitForceForMissingBlobs` → recapture is the existing loop verbatim (§3.3 trace).
7. MAJOR — receiver base-exclusion borrowed without git projection/delete-echo mechanics.
   **DISPOSITION: ACCEPTED — reframed:** every git section still arrives via a NORMAL commit, so
   all existing receiver git machinery (gitPendingRemote/gitReposRemoved/gitBaseAfterCommit)
   applies unchanged; §4.3 adds the explicit traces.
8. MAJOR — attach-lane vs mutex/daemon inconsistent (multi-hour hold vs release-between).
   **DISPOSITION: ACCEPTED — dissolved:** each attach is a SEPARATE ordinary push under the
   mutex, released between; no long hold (§3.1/§3.3).
9. MAJOR — genesis predicate is local-only; rebind/state-loss can false-genesis over a live
   remote (design-44 poisoned base).
   **DISPOSITION: ACCEPTED — hardened (§3.4):** files-first defers git ONLY on the genesis
   commit attempt; any 409/remote-head discovery drops to steady before any git decision;
   files-only commit on a fresh binding is design-44-safe (pushes files, never deletes).
10. MAJOR — wire count not transactionally tied to owed set. **DISPOSITION: ACCEPTED — moot**
    (count dropped, #1).
11. MINOR — delta-off K cadence self-contradictory. **DISPOSITION: ACCEPTED — moot** for the v2
    baseline (single terminal git commit); resurfaces only in the OPTIONAL incremental mode
    (§3.7), where it's explicitly phase-0-gated with a hard K.
12. MINOR — per-repo multi-commit attach is unproven value vs its correctness surface; two-commit
    terminal should be the baseline. **DISPOSITION: ACCEPTED — this is now the v2 baseline**
    (§3.1); incremental size-ordered attach is split to a phase-0-gated OPTIONAL (§3.7).
13. NIT — "byte-identical to today" scope-fence assertion impossible (generatedAt/nonces/sigs).
    **DISPOSITION: ACCEPTED — gate 6 restated as semantic equivalence** (§7).

## Round 2 (gpt-5.6-sol) — VERDICT: REVISE (2 BLOCKER, 4 MAJOR, 2 MINOR, 1 NIT)

All precision fixes on the stable v2 baseline (no structural change). v2 → v3:

1. BLOCKER — git-only/empty-file genesis defers forever: no files ⇒ commit 1 is a no-op
   (`filesUnchanged && gitUnchanged`, sync.ts:767) ⇒ seq stays 0 ⇒ re-defers every push, git
   never captured. **ACCEPTED — fixed (§3.1/§3.4):** files-first activates ONLY when the file
   plane has a real diff vs base; a no-file/git-only workspace runs the ordinary (git-first)
   single commit.
2. BLOCKER — no component drives commit 2 in the successful init path (init calls push once,
   exits). **ACCEPTED — fixed (§3.1):** the init push branch performs TWO explicit top-level
   pushes (commit 1 files, then commit 2 git-attach), mutex released between; commit-2
   failure/interruption UX defined; daemon resume is the backstop, not the primary driver.
3. MAJOR — crash-safe derived-owed invariant overstated. **ACCEPTED — narrowed (§3.2):** stated
   as "after an acknowledged, sequence-advancing files-only commit from a genuinely-fresh state";
   deferral asserted to leave all git sidecars empty.
4. MAJOR — genesis gating contradicts stream-mismatch reality (`loadState` maps any mismatch to
   seq 0/empty base, so seq===0 INCLUDES rebind). **ACCEPTED — decided (§3.4):** files-first
   triggers only on a GENUINE first-init (`seq===0 ∧ !stateWasStreamMismatch(state)`); a rebind
   takes the ordinary path (design-44-safe, git inline). No wasted pre-409 upload.
5. MAJOR — 409 abort not wired as persistent attempt state. **ACCEPTED — specified (§3.2):**
   exact predicate inside `runPushAttempt` after `loadState` (`parentSequence===0 ∧ …`) PLUS a
   loop-carried `filesFirstAborted` latch set on any pull-first/409; retry-after-409 captures git.
6. MAJOR — first-publish metrics can't span two separate pushes. **ACCEPTED — resolved (§3.6):**
   commit 1's report renders `timeToFilesSyncedMs`; commit 2 (its own ordinary-push report)
   renders `gitAttach*`; use `beginReport("push")` convention, not `metricsEnabled()` to a ctor.
7. MINOR — gate 2 empirical, not byte-conservation. **ACCEPTED (§7):** freeze `RBOX_MDE_DELTA`
   identically both arms; keep the full ~47MB commit-2 snapshot in the candidate budget; gate is
   empirical.
8. MINOR — §4.3(e) daemon/init race not "unchanged." **ACCEPTED — explicit race trace added
   (§4.6).**
9. NIT — "empty/absent git section," not literal `{}` (`emptyToUndef`). **ACCEPTED — reworded.**

## Round 3 (gpt-5.6-sol) — VERDICT: REVISE (1 BLOCKER, 2 MAJOR, 2 MINOR, 1 NIT)

Reviewed v3 before the mid-round mutex fix; dispositions v3 → v4:

1. BLOCKER — two-push mutex lifecycle contradicted init's single-ownership contract (v3's
   "release → reacquire" was self-contradictory). **ACCEPTED — resolved by picking the
   retain-across-both-commits horn (§3.1):** init holds ONE first-sync mutex across commit 1 AND
   commit 2 (both inner pushes inherit `deps.syncMutex`, `init-cmd.ts:169/217/279`), identical to
   today's init hold across the full first publish — NO design-93 amendment needed, no
   release/reacquire. (Fixed mid-round; round 3 reviewed the stale text.)
2. MAJOR — all-files-deferred commit 1 starves git forever: if `encryptAndUpload` defers every
   file, `deferManifest` reduces committed to base, post-defer short-circuit returns
   `committed:false` seq 0 (sync.ts:845-851), genesis re-fires, git never captured. **ACCEPTED —
   fixed (§3.2):** `filesFirstAborted` latch is ALSO set when a files-first attempt commits
   nothing (no sequence advance); the retry then runs ordinary git-inclusive planning.
   Files-first is best-effort — it never starves git. Sole-unstable-file test added (§4.5).
3. MAJOR — metrics finalize (`finishFirstPublishStats`) before 409/422/epoch checks ⇒ failed
   attempts record a success KPI; single `deps.report` ⇒ two pushes double-render. **ACCEPTED —
   fixed (§3.6):** stats finalize only after successful admission + state save; each push gets a
   FRESH report + exactly one `logSummaryTo`; 409/422 no-premature-render tests.
4. MINOR — §4.6 loser trace wrong post-fix (loser reads fresh state under the mutex → no-op, not
   a 409). **ACCEPTED — corrected (§4.6).**
5. MINOR — "commit 2 attaches all git" overstates (planGitSections may defer on capture-fail /
   busy / config-fault / admission-cap). **ACCEPTED — reworded to "all currently
   capturable/admitted git"; deferred repos stay owed, re-derived next push, no delete-echo;
   partial ⇒ "history still uploading" (§3.1/§3.5).**
6. NIT — state the design-84 schema-0/file-only → schema-2/git-attach transition precisely +
   test. **ACCEPTED (§3.5 note).**

## Round 4 (gpt-5.6-sol) — VERDICT: REVISE (1 BLOCKER, 1 MAJOR, 2 MINOR, 1 confirming NIT)

NIT 5 confirms the round-3 mutex/predicate/schema fixes all hold (no TTL on the design-93 lock;
genesis carry can't false-negative; §4.6 loser trace accurate). v4 → v5:

1. BLOCKER — anti-starvation "same run retries" isn't wireable: a `committed:false` no-op is
   `done:true` and EXITS the loop (sync.ts:557,634,849). **ACCEPTED — fully specified (§3.2):**
   a distinct nonterminal `RecoveryAction {kind:"files-first-fallback"}`; `filesFirstAborted`
   added to `PushAttemptState`; the loop arm sets the latch and re-plans WITHOUT pull/epoch-
   refresh/reupload, does NOT consume `MAX_ATTEMPTS` (independent fallback cap = 1), rebuilds
   `state.local` via the normal re-scan/re-plan. Pinned by the unstable-sole-file test.
2. MAJOR — module-global `firstPublishTiming` stays enabled after non-success/no-upload exits and
   leaks into later work; fresh reports don't isolate it. **ACCEPTED — fixed (§3.6):** every
   attempt that doesn't transfer ownership to finalized stats resets `firstPublishTiming` in a
   `finally`; finalization disables timing even when it returns no stats; sequential
   failed/no-upload-push → unrelated-push test added.
3. MINOR — `timeToFilesSyncedMs` must capture the ACK timestamp at the accepted commit response,
   not at post-save finalization. **ACCEPTED — clarified (§3.6).**
4. MINOR — the second init push is "git attach" only if commit 1 was a sequence-advancing
   files-only commit; otherwise it's a no-op/wrong label. **ACCEPTED — conditioned (§3.1):** init
   schedules the attach push only when commit 1's `PushResult` signals a files-only
   sequence-advancing commit (git still owed); a bypass/fallback commit 1 already captured git →
   no second push.

## Round 5 (gpt-5.6-sol) — FINAL (round cap reached)

- CONFIRMED — §3.2 anti-starvation nonterminal `files-first-fallback` action is implementable
  against the real recovery model (bypasses `consumesAttempt`, independent cap, latch,
  `state.local` rebuild; returning from the post-deferral site is safe — uncommitted, idempotent
  ciphertext, rerun reconstructs disk truth).
- CONFIRMED — §3.6 closes the singleton timing leak + double-render; conditional `PushResult`
  signal prevents a spurious second init push. **Codex found NO remaining delete-echo,
  partial-chain, entitlement/double-charge, GC, receiver-race, mutex, genesis-gating, or
  two-commit semantic defect.**
- 1 residual MAJOR (metric DEFINITION precision, not a correctness defect): `timeToFilesSyncedMs`
  must start at the COMMAND-LEVEL milestone (before scan), not `firstPublishTiming.startedAt`.
  **APPLIED per codex's exact prescription (§3.6)** — new field + formatter, start captured at
  init push initiation, end at accepted ACK, rendered post-state-save, scan-delay-inclusion test.

**Close (round cap 5):** All correctness findings across rounds 1–4 resolved; round 5 confirmed
the two round-4 must-fixes and surfaced no correctness defect. The final residual — a metric
start-timestamp definition — was applied verbatim from the reviewer's prescription, so the
document carries no open BLOCKER/MAJOR correctness item. Effective state: CORRECTNESS-ALIGNED at
the cap, with the founder decisions in §8 (publisher-loss git semantics, joiner pending signal,
incremental-attach value) explicitly deferred to the founder rather than the review.
