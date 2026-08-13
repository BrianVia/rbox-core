# REVIEW-237 — awaited daemon pump join

## Round 1 — CHANGES REQUIRED

Forensic audit and executable review established the root cause:

- `DaemonOperationScheduler.service()` claimed an active caller joined the
  current flight but returned `Promise.resolve()` instead.
- The deterministic contract proof failed on the old implementation: the
  second completion became observable while the first operation was still
  gated and its queued successor had not run.
- Design-206 fuse/matcher/trust state is instance-local. The trusted-pull
  fixture uses fake watchers and opens no inotify/Parcel subscription, ruling
  both suspects out for an explicitly queued pull with `lines=[]`.

Review finding:

- **MAJOR:** the initial design put the active-flight check before the stopped
  check. That would make a post-stop `service()` caller join/drain, contradicting
  the protected contract that only `stop()` drains. The existing stop contract
  timed out under that ordering.

Disposition: corrected the matrix to stopped-first; documented standing-halt,
parked-boundary, and settlement-reentry semantics. Focused suite: 71/71 green.

## Round 2 — ALIGNED

The reviewer found no remaining blocker, major, or minor issue.

- stopped active/idle calls resolve immediately;
- live active callers join the authoritative `pumpRun`;
- settlement-time wakeups are covered by the parent flight's awaited re-entry;
- boundary refusal and standing halt retain their existing named/durable
  surfaces;
- no pull assertion was weakened;
- the unrelated `RBOX_GIT_APPLY_LAZY` harness leak is restored per test;
- temporary forensic logging is removed after the causal contract landed.

Executed evidence:

- scheduler contract: 17/17 green;
- scheduler + trusted-pull + WS reliability: 71/71 green;
- exact current CI shard 4 process, CPU constrained: 819 pass / 4 skip / 0 fail,
  plus 28/28 and 9/9 split groups;
- exact current CI shard 5 process, CPU constrained: 889 pass / 4 skip / 0 fail,
  plus 18/18 and 27/27 split groups;
- exact current CI shard 6 process, CPU constrained: 779 pass / 1 skip / 0 fail,
  plus 18/18 split group;
- complete daemon directory: 429/429 green;
- two-device live rig: PASS (bidirectional daemon sync, passive collision
  recovery, conflict convergence, both daemons healthy);
- typecheck and affected lint: pass (affected lint reports only pre-existing
  warnings outside the changed lines);
- `git diff --check`: clean.
