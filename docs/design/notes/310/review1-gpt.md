NOT ALIGNED

- High: implementation is not restricted to CREATE-P. [branch-deletion-witness.ts](/home/via/Development/Personal/rbox-core/.claude/worktrees/settle-receipts/src/cli/sync-git/branch-deletion-witness.ts:170) checks only `nextOid === priorOid`; it never requires `p.payload.priorOid === null`. Consequently, UPDATE-P receipts are also retired, exceeding design 310’s explicit rule.

- Coverage: the added test deliberately plants a same-OID receipt after BASE capture, but does not cover different episodes, foreign/un-stamped BASE, foreign artifacts, mismatched keeps, concurrent settlement, or transaction abort/crash behavior.

For a genuine CREATE-P, I found no peer-work loss path: P creation and landing share an atomic ref transaction; retirement CAS-deletes the exact P target and episode-specific K ref while verifying the branch absent. Concurrent settlement can’t commit against those locked refs simultaneously, and verify/delete cannot partially commit. Different episodes are content-equivalent only because the ref and `nextOid` match; foreign artifacts and mismatched/orphan keeps still refuse.

Tests:

- `git-sync.test.ts -t 'design 31'`: 3 passed
- `p-settlement*.test.ts`: 9 passed
- No files modified.