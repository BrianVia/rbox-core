Verdict: NOT ALIGNED

1. High — foreign retirement can corrupt another workspace’s accepted P-repair recovery row.

   A crash after P-repair’s state CAS but before its prepared P/K→Q transaction commits leaves:

   - foreign workspace state: accepted `pRepaired` receipt
   - shared Git state: P/K present, Q absent

   Design 312 can then atomically delete that foreign P/K pair in [branch-deletion-witness.ts:176](/home/via/Development/Personal/rbox-core/.claude/worktrees/foreign-receipts/src/cli/sync-git/branch-deletion-witness.ts:176). On restart, the owning workspace inspects its accepted receipt before ordinary P settlement. The resulting `receipt=matching, P=absent, K=absent, Q=absent` row is explicitly `corruption-hold` in [p-repair.ts:356](/home/via/Development/Personal/rbox-core/.claude/worktrees/foreign-receipts/src/cli/sync-git/p-repair.ts:356), not the claimed absent-P no-op.

   This contradicts the safety argument in [design 312:29](/home/via/Development/Personal/rbox-core/.claude/worktrees/foreign-receipts/docs/design/312-same-repository-create-receipts.md:29). The pre-Q repair origins/pins can also remain orphaned while the foreign workspace stays held.

2. High — repository identity plus target OID provides no temporal or ownership proof.

   A same-identity CREATE-P planted after this device captured BASE is indistinguishable from a historical abandoned-lineage receipt. Content equality proves only the commit, not that the foreign workspace’s transition was already incorporated or retired. The new rule therefore changes `active-foreign` into deletion authority without consulting that workspace’s state or proving its lineage retired.

   The shared operation lock prevents simultaneous ref races, but it cannot repair the accepted-state/crashed-ref-transaction case above.

3. Test coverage misses the unsafe case.

   The added test plants a P/K pair and immediately retires it. It does not model:

   - a second active workspace;
   - an accepted `pRepaired` receipt;
   - crash at `after-state-cas`;
   - post-BASE receipt ordering;
   - recovery after cross-lineage retirement.

Crash during the witness’s own Git transaction is safe: branch absence plus all selected P/K deletions commit atomically or abort. Exact expected targets also prevent partial mismatched-K deletion. The blocker is durable state owned by another workspace, outside that transaction.

Validation:

- `bun test ...git-sync.test.ts -t 'design 31'`: 6 passed.
- Requested settlement command: 9 passed; no `base-artifact-scan*.test.ts` file exists, so only `p-settlement.test.ts` ran.
- Additional P-repair/standing-proof suite: 54 passed.
- `git diff --check`: passed.
- No files modified.

Foreign-lineage retirement is not safe until inactive lineage is durably proven, or cross-workspace retirement participates in/recoverably resolves the foreign P-repair state machine.