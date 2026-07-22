The status was stale. The one-hour floor does not expire deferrals, successful pulls do not clear capture-lane records, and the current status/ambient paths do no cause revalidation.

## What clears a deferral today

Deferrals are independent `apply`, `capture`, and `config` lanes. `nextDeferral` preserves the episode’s `deferredSince`, changes `reasonSince` when the reason changes, and has no TTL or expiry logic: [shared.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/shared.ts:115).

Apply-side behavior:

- `git-busy` is asserted before identity comparison: [apply.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:601).
- A terminal successful follow clears only `apply`: [apply.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1361).
- Remote absence clears the whole repo’s deferrals: [apply.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:617).
- Successful apply does not clear `capture`; published-journal merging deliberately retains capture state: [sync-state.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-state.ts:377).

Capture-side behavior:

- Every push turns planner failures into capture deferrals: [push.ts](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:420).
- A capture deferral clears when a later push observes that repo and finds no current capture failure. A real capture is unnecessary; clean carry/observation suffices: [push.ts](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:439).
- Protected-pending repos are explicitly excluded from that clearing pass: [push.ts](/home/via/Development/Personal/rbox-core/src/cli/sync/push.ts:429).
- The planner observes only `discovered ∪ base ∪ pending`, not all durable repo records: [plan.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:303), [plan.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/plan.ts:316).

Therefore an idle repo is normally reconsidered by a later push even when no commit is needed, but it can linger indefinitely if:

- the push pump is halted;
- the repo disappears from discovery and has neither base nor pending state; or
- it is protected by pending incoming state.

Pulls and status reads do not rescue those cases.

## The one-hour floor

The design-174 floor is solely a safety bound on the held-apply optimization:

- Design contract: [design 174](/home/via/Development/Personal/rbox-core/docs/design/174-apply-side-perf-and-held-repo-livelock.md:254), [design 174](/home/via/Development/Personal/rbox-core/docs/design/174-apply-side-perf-and-held-repo-livelock.md:268).
- Constant and comparison: [held-skip.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/held-skip.ts:26), [held-skip.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/held-skip.ts:205).
- It is consulted only inside the pending apply path: [apply.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1108).

After one hour, rbox performs a full follow instead of reusing a matching held attempt. It does not delete any deferral merely because it aged. Existing integration coverage confirms re-follow/refresh behavior: [follow.test.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/follow.test.ts:1416).

## The ten repos at 23:45

The initial push summary identifies main plus nine worktrees as capture-busy: [mac-daemon-0721.log](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2440).

At 23:45 their lifecycle was:

| Repo | Durable situation | Current self-clear trigger |
|---|---|---|
| `Dfinitiv/savvy-core` | Stale capture `git-busy`, plus a real apply `local-commits` hold after the successful follows | Apply lane clears when pending actually converges/resolves. Capture lane remains protected while pending exists; after pending settles, it needs another clean push observation. |
| `…-cohort-notification-completed` | Stale capture `git-busy` | First resumed clean push that rediscovers it |
| `…-express-dev` | Same | Same |
| `…-express-stage` | Same | Same |
| `…-fidelity` | Same | Same |
| `…-flagmig` | Same | Same |
| `…-hotfix` | Same | Same |
| `…-pr6` | Same | Same |
| `…-pr7` | Same | Same |
| `…-pr8` | Stale capture `git-busy`; it disappeared from later discovery | No guaranteed trigger; rediscovery, explicit record hygiene, or remote absence is required |

The successful follows at 23:39, 23:41, and 23:43 are visible at [mac-daemon-0721.log](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2910). They updated/cleared main’s apply-side busy assertion but could not touch any capture lane.

`pr8` is the strongest proof of the structural hole: late push summaries dropped from ten current planner deferrals to nine, yet the durable status remained ten because the now-unobserved record was never cleared.

## Why status repeats the stale assertion

Both status paths treat durable records as unquestioned facts:

- `gitDivergenceStatus` copies deferrals before probing the filesystem: [status.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/status.ts:72).
- Even when its divergence probe discovers `busy === false`, that result only affects the divergence count, not the copied records: [status.ts](/home/via/Development/Personal/rbox-core/src/cli/sync-git/status.ts:177).
- `status-cmd` directly enumerates persisted lanes: [status-cmd.ts](/home/via/Development/Personal/rbox-core/src/cli/status-cmd.ts:75).
- Ambient status similarly collapses raw repo records into ten repo-level rows: [ambient-status.ts](/home/via/Development/Personal/rbox-core/src/cli/daemon/ambient-status.ts:239).
- The daemon feeds that projection its cached `syncBase`; a heartbeat is presentation refresh, not lifecycle reconciliation: [daemon.ts](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1818).

## Proposed hygiene contract

A deferral must be a current assertion about the world, not merely evidence that an earlier operation encountered something.

Implement a shared, cause-aware reconciler, initially for `reason === "git-busy"`:

1. Before every computed `rbox status`, and on every daemon hygiene cycle, collect all busy lanes from durable repo records—including repos absent from discovery/base/pending.
2. Resolve repo contexts and run the existing fail-closed busy probe: [preflight.ts](/home/via/Development/Personal/rbox-core/src/engine/git/preflight.ts:112), [shared.ts](/home/via/Development/Personal/rbox-core/src/engine/git/shared.ts:591).
3. Deduplicate shared-common-dir inspection so the nine worktrees do not repeat the shared refs scan. Per-worktree `index.lock`/`HEAD.lock` still require their own checks.
4. If the authoritative result is “not busy,” clear only the exact stale lane. Never clear pending, partial, held attempt, or another lane.
5. If context resolution or inspection fails, retain the record—fail closed.
6. Persist with state nonce/repo-generation CAS and an exact predecessor episode match. A stale hygiene result must never erase a newer deferral.
7. After an accepted daemon save, replace `syncBase` so ambient and shell status reflect the clear immediately. On a CAS loss, reload and project the winner.

This would have immediately removed the ten stale capture-busy assertions after lock deletion. `savvy-core` would still correctly remain “needs attention” for its genuine `apply:local-commits` condition.

## Required tests

- Idle discovered repo: seed `capture:git-busy`, remove lock, run status hygiene, assert durable lane and displayed row disappear without a push.
- Disappeared repo: no discovery/base/pending, stale busy record still gets swept.
- Protected pending: clear stale capture busy without touching pending, partial, attempt, or apply lane.
- Mixed lanes: clear capture busy while retaining apply local-commits and repo-level attention.
- Live lock and inspection failure: retain the episode byte-for-byte.
- Shared main/worktrees: common-dir lock probes once; all affected stale lanes clear after removal.
- CAS race: a concurrent newer reason/episode survives a stale clear.
- Daemon cycle: accepted sweep updates ambient count on the next heartbeat.
- Floor regression: the one-hour held-attempt test continues to force re-follow and never acts as deferral expiry.

No files were changed; this was a read-only audit.