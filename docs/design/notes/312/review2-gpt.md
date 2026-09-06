NOT ALIGNED

1. **High — unreadable registry fails open.** [plan.ts:40](/home/via/Development/Personal/rbox-core/.claude/worktrees/foreign-receipts/src/cli/sync-git/plan.ts:40) uses `readDesiredDaemonRows()`, whose tolerant implementation converts unreadable directories/files and malformed rows into an empty/partial list. The promised “unreadable registry keeps receipts standing” behavior therefore does not exist; `readDesiredDaemonRowsStrict()` already provides it.

2. **High — the Q guard does not cover finding 1’s crash state.** After the foreign workspace’s state CAS succeeds but before P/K→Q commits, Q is absent. If that workspace’s desired row is unreadable—or it is a tracked foreground workspace that never registered a daemon row—the registry returns no claim and the witness deletes P/K. Recovery then observes accepted receipt + P/K/Q absent and enters `corruption-hold`.

Thus guard (a) covers only Q-present repair states; guard (b) covers only successfully parsed registered workspaces. Neither protects the concrete fail-open path above.

Requested test: **8 passed, 0 failed**. It injects the registry answer and does not exercise the production tolerant reader or accepted-state/pre-Q crash.