# 174 round-3 ledger-closing review (Codex)

1. **NOT-CLOSED — complete blocker seam / non-vacuous skip.** Evidence: §4.1 now requires the merged classification+orchestration blocker union and `blockers.length > 0`, but test 10 covers only `local-stash + worktree-ownership` and composer-only pending, not the specifically requested held-ref + composer-pending mixed case (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:206-215,475-482`).
2. **CLOSED — literal ancestry proof.** Evidence: §4.2 requires `GIT_NO_REPLACE_OBJECTS=1` for every proof peel/walk/ancestor subprocess and test 10 pins the divergent-tip replace-ref adversary (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:336-344,480-482`).
3. **CLOSED — A test placement and call-count wording.** Evidence: tests 2 and 15 expressly allow prerequisite Git/composer work, assert the mandatory prepass ran first, and constrain zero work/no BASE mutation to the final skip (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:450-455,497-500`).
4. **CLOSED — exhaustive journal recovery disposition.** Evidence: §4.2 makes `fresh-quarantined` carry P and requires an exhaustive `never` check, mirrored by test 11 over all named proceeding and blocking statuses (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:305-314,483-487`).
5. **CLOSED — ACK-gated sidecar clears and retained BASE.** Evidence: test 1 pins exact pending/partial/attempt/predecessor-bound-deferral clearing plus omitted branch/origin retention, while test 7 table-tests byte-identical preservation across capture, upload, 422, commit error, and 409 (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:440-449,467-469`).
6. **CLOSED — post-acceptance ACK boundary.** Evidence: §4 states that local clearing occurs only after accepted commit in the generation-CAS ACK transition and explicitly preserves sidecars across an accepted-commit/state-save crash; the later trace consistently sequences commit before the atomic local ACK clear (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:197-202,356-358`).
7. **CLOSED — editorial drift.** Evidence: the non-goals no longer say “v0, to be ratified,” and F is now numbered §4.5 after §4.4 (`docs/design/174-apply-side-perf-and-held-repo-livelock.md:160-170,409-436`).

New fold-introduced defects: none found in the immediate context of the seven edits.

Verdict: CHANGES-REQUIRED
REVIEW-COMPLETE
