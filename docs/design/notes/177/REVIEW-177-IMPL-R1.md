Verdict: **CHANGES-REQUIRED**

1. **HIGH — Rider refusal can become untyped and may omit protected pending state.** [plan.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/sync-git/plan.ts:702) handles `recoveryBlocked` before rider admission. It returns no `GitPushPlan.resolution`, violating the typed 1:1 disposition contract. During forced 422 recapture, `force.has(rel)` also prevents carrying `pend`, so a raced recovery block can make the repository disappear from the outgoing manifest instead of conservatively retaining P.

2. **HIGH — The durable receipt is armed before the actual last pre-POST boundary.** [e2ee-remote.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/e2ee-remote.ts:808) arms the receipt before calling `commitSigned`, but [commits.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/remote/commits.ts:311) still performs receipt redemption before the manifest POST at line 320. A redemption failure therefore produces `ack-uncertain` and leaves publication state even though no commit was sent, contrary to §1’s “failure before commit send: no resolution state persisted.”

3. **MEDIUM — Receipt mismatch reconciliation is silent in ordinary push/pull.** [push.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/sync/push.ts:61) discards the reconciliation result, while [pull.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/sync/pull.ts:94) returns only actions. Thus mismatch + retained pending never surfaces the required fresh-preview message outside the immediate 409 resolver path.

4. **MEDIUM — The intent normalizer is not load-time.** [config.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/config.ts:840) returns raw loaded state, including `resolutionIntent`. Stripping occurs only when `repoRecordsForState()` is later called at line 520. The test masks this by normalizing before asserting at [sync-state.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/sync-state.test.ts:123). Unrelated transactional saves do correctly shed the field.

5. **HIGH — The mandatory scratch/pseudo-ref/index pinning tests are non-discriminating.**

   - [capture-stability.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/engine/git/capture-stability.test.ts:39) moves A to descendant B, so B/WIP already reaches A without captured-ref scratch pinning.
   - At [line 151](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/engine/git/capture-stability.test.ts:151), pseudo-ref A is also current HEAD, so A is already rooted independently.
   - The index “replacement” only adds another entry, leaving all staged-A objects reachable from WIP(B).
   - The ordinary `MERGE_HEAD` fixture at [line 196](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/engine/git/capture-stability.test.ts:196) repeats the A-equals-HEAD problem. No discriminating `AUTO_MERGE` case exists.

6. **HIGH — Mandatory ambient-churn coverage is missing end-to-end.** [capture-stability.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/engine/git/capture-stability.test.ts:62) only edits and stages one file around `captureGitState`. It performs no background commits, has no pending/discard report, and never attempts publication, so it cannot prove “never stale discard.”

7. **HIGH — Several other mandatory assertions are incomplete or vacuous.**

   - Preview drift at [git-cmd.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/git-cmd.test.ts:919) adds an empty descendant commit, leaving the discard set unchanged.
   - Receipt ordering at [resolution-receipt.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/sync/resolution-receipt.test.ts:91) checks only the successful final state; it would not detect a receipt-first, clears-second implementation.
   - The mismatch/no-pending/no-preview branch is absent; [git-sync.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/sync-git/git-sync.test.ts:1643) covers only pending retained.
   - The degraded mutex test invokes `take-theirs`, not keep-mine’s distinct refusal path, at [git-cmd.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/git-cmd.test.ts:1187).

8. **LOW — Deleted intent machinery remains as dead test assertions.** Assertions at [git-cmd.test.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/177-sync-confirm/src/cli/git-cmd.test.ts:1027), plus lines 1056, 1094, and 1115, read a field no longer present and can only pass. No unintended production `resolutionIntent` lifecycle remains; the binding/report code is still legitimately used by preview and confirmation.

| Mandatory test | Status |
|---|---|
| 1. Synchronous confirm | Pass |
| 2. Ambient churn | Fail |
| 3. Lock wait/timeout | Partial—synthetic holder, not an active push |
| 4. Preview discard-set drift | Fail |
| 5. Presence-aware op-state | Pass |
| 6. Bundle pinning | Fail—vacuous reachability |
| 7. Legacy intent shedding | Pass, but not load-time |
| 8. take-theirs regression | Pass |
| 9. Receipt policy | Partial |
| 10. Capture coherence | Fail—endpoint cases pass, ABA cases are vacuous |
| 11. Receipt retention/ordering | Partial |

The core §4 implementation itself is otherwise faithful: staged index-derived `indexTree`, staged pseudo-ref reads, captured-ref scratch roots, staged-presence veto, presence-bit endpoint comparison, staged-index closure pinning, and cleanup are all present.

Validation run: `git diff --check`, typecheck, 93 focused unit tests, and all 5 design-177 integration tests passed. The passing tests do not invalidate the coverage defects above.