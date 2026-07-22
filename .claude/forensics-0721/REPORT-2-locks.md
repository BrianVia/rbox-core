The exact orphan source is the post-follow state-CAS proof bracket in `withRevalidatedGitPartialApplies`, not reflog protocol locks and not one giant Git `update-ref` transaction.

## Lock-lifecycle self-heal — design draft

### 1. Incident mechanism

After a repository successfully follows incoming Git state, `applyGitSections` logs `git-sync followed` and returns its proof/partial state ([apply.ts:1347](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1347)). Pull then enters `withRevalidatedGitPartialApplies` around the durable state save ([pull.ts:353](/home/via/Development/Personal/rbox-core/src/cli/sync/pull.ts:353), [pull.ts:373](/home/via/Development/Personal/rbox-core/src/cli/sync/pull.ts:373)).

That bracket:

1. Collects effective partial applies, whose `appliedRefs` preserve every successfully applied branch, tag, and `refs/stash` ref ([apply.ts:664](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:664), [apply.ts:1696](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1696)).
2. Maps every applied ref to `${commonDir}/${ref}.lock`, plus branch-proof artifact locks ([apply.ts:1705](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1705), [apply.ts:1724](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1724)).
3. Sorts and creates the complete set as zero-byte files with `fs.open(lockPath, "wx")` ([apply.ts:1737](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1737)).
4. Holds them across final proof and state save ([apply.ts:1748](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1748), [apply.ts:1771](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1771)).
5. Removes them only from a JavaScript `finally` ([apply.ts:1774](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1774)).

Process death closes the descriptors but does not unlink their directory entries. There is no durable transaction journal, owner PID/incarnation, marker, or startup recovery for this bracket.

The forensic ordering is decisive: the old daemon’s final line is `git-sync followed` at `21:34:13.472Z`, followed by a replacement boot without a pull summary, completed state-save line, or graceful-stop line ([mac-daemon-0721.log:2415](/home/via/Development/Personal/rbox-core/.claude/forensics-0721/mac-daemon-0721.log:2415)). That is 17:34:13 local, matching the lock cohort’s timestamp. Checkout’s earlier reservation bracket had already returned and released its locks before `git-sync followed` could be logged.

Related mechanisms are not the primary cause:

- Reflog protocol locks live under `rbox-locks/reflog/v1/<sha256>.lock`, not `refs/**/*.lock` ([protocol-locks.ts:187](/home/via/Development/Personal/rbox-core/src/engine/git/protocol-locks.ts:187)).
- Checkout does have an interactive prepared `git update-ref --stdin` transaction and a separate manual ref-reservation loop ([checkout-txn.ts:580](/home/via/Development/Personal/rbox-core/src/engine/git/checkout-txn.ts:580), [checkout-txn.ts:605](/home/via/Development/Personal/rbox-core/src/engine/git/checkout-txn.ts:605)). Those reservations have their own late-token crash window, but normal success removes them before the observed log boundary ([checkout-txn.ts:771](/home/via/Development/Personal/rbox-core/src/engine/git/checkout-txn.ts:771)).
- Existing checkout-journal recovery can delete prepared Git locks proved by inode token or exact expected bytes ([journal.ts:265](/home/via/Development/Personal/rbox-core/src/engine/git/journal.ts:265)). It has no authority over the later state-CAS locks.

### 2. Current shutdown semantics

The daemon intends SIGTERM to be graceful: `runDaemon` installs one-shot SIGTERM/SIGINT handlers calling `daemon.stop()` ([daemon.ts:2800](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:2800), [daemon.ts:2819](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:2819)), and `stop()` awaits the active `pumpRun` ([daemon.ts:803](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:803), [daemon.ts:836](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:836)).

That contract has three holes:

- Setting `stopped` prevents another pump iteration, but an existing `doPull` receives no shutdown gate. It can proceed from a long read/scan phase into Git mutation or the state-CAS lock bracket after shutdown began ([daemon.ts:1122](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1122), [daemon.ts:1191](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:1191)).
- `stop()` awaits watcher/ref-registry closure before `pumpRun`, without settling close failures. A close rejection can bypass the promised pump drain ([daemon.ts:833](/home/via/Development/Personal/rbox-core/src/cli/daemon/daemon.ts:833)).
- `rbox stop` escalates to SIGKILL after 60 seconds ([daemon-control.ts:432](/home/via/Development/Personal/rbox-core/src/cli/daemon-control.ts:432), [daemon-control.ts:446](/home/via/Development/Personal/rbox-core/src/cli/daemon-control.ts:446)). A long pull can therefore receive SIGTERM during a read phase, enter a mutation later, and be hard-killed there.

The first handler is registered with `once`; a second SIGTERM during a drain may also take the runtime’s default termination path.

The native Git ref update is atomic at its own commit point. The complete apply—safe refs, checkout refs/HEAD, index, operation state, and rbox state—is intentionally multi-phase and journal-recoverable, not globally crash-atomic. The design should preserve that model while making every rbox-created physical lock recoverable.

### 3. Graceful-stop bracket

Introduce a process-wide shutdown gate and mutation registry.

Invariant G1: once shutdown is observed, no new mutation boundary may begin.

Invariant G2: a mutation already inside its boundary reaches exactly one terminal state:

- prepared but uncommitted → explicit abort and child exit;
- commit started or refs committed → finish index/op-state/state persistence and exact lock release.

Required behavior:

- The first signal synchronously moves `running → stopping` and creates one idempotent `shutdownPromise`. All later SIGTERM/SIGINT deliveries remain handled and report that draining is in progress.
- Check the gate immediately before prepared `update-ref`, file mutation, and `withRevalidatedGitPartialApplies` lock acquisition. A stopped gate outside a critical section requeues the work without mutation.
- Register prepared Git transactions with phase, journal ID, common-dir identity, and child process incarnation. Cooperative shutdown aborts a prepared transaction; it drains one whose irreversible commit has begun.
- Register the state-CAS proof bracket as a short non-cancellable critical section once its first lock is acquired.
- Reorder `stop()` so ingress is fenced first, mutation registry and pump are drained second, and watcher/WebSocket/telemetry/cache closure runs afterward through `Promise.allSettled`. Ancillary close failure must not bypass mutation cleanup.
- Ordinary `rbox stop` must not perform a clock-only SIGKILL while a declared critical section remains active. It may report the active phase/repository and keep waiting. Any explicit force path must warn that startup journal recovery will be required.

### 4. Rbox-owned ref-reservation journal

Add a durable transaction journal for the state-CAS lock set and use the same ownership primitive for checkout’s manual reservations.

Before acquiring the first physical lock, durably record:

- transaction ID and phase;
- workspace stream/state nonce;
- daemon host, boot, PID, and process-start identity;
- canonical common-dir path plus filesystem identity;
- complete allowlisted lock-path set;
- expected ref/OID proof associated with each path;
- a unique random ownership marker for each lock.

Create each rbox reservation atomically using the established lockfile pattern: fsynced sibling temp, hardlink/O_EXCL publication, directory fsync, and no-follow verification. The final `.lock` contains the unique rbox marker rather than being empty. Git only needs the pathname to exist to reject a conflicting writer; it does not require these manually created reservations to be empty.

This closes both current gaps:

- Recovery authority exists before the first lock is created.
- A crash between creation and inode-token persistence remains recoverable from the exact marker.

Normal release must re-read and unlink only the exact marker/inode it created. The current state-CAS cleanup does an unconditional path removal after closing its old handle, so an unlink-and-replace race could make it delete a successor’s lock ([apply.ts:1774](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:1774)). Exact compare-before-unlink is required even without a crash.

Git-created prepared transaction locks cannot contain rbox markers. Continue using the checkout journal’s expected-byte/inode-token recovery for those, extended with the Git child’s boot/PID/start identity.

### 5. Startup and steady-state recovery

Replace the boolean-only busy probe with a structured common-dir result. Today `gitBusy` treats any shared `refs/**/*.lock` as busy ([shared.ts:591](/home/via/Development/Personal/rbox-core/src/engine/git/shared.ts:591)); consequently one orphan blocks the main clone and every linked worktree sharing that common dir.

| Classification | Meaning | Action |
|---|---|---|
| `live` | Positive rbox/Git owner-incarnation proof | Defer normally; never delete |
| `recoverable-rbox` | Valid journal, dead owner/child, exact unchanged markers/tokens | Recover under a common-dir recovery fence, then retry immediately |
| `stale-unattributed` | Stable old lock cohort, no positive live owner, but no valid ownership journal | Preserve; surface actionable attention |
| `indeterminate` | Read, path, identity, or liveness inspection failed | Fail closed, retain errno/detail, escalate if chronic |
| `quiescent` | No blockers | Proceed |

Recovery rules:

- Startup recovery runs after obtaining the workspace mutex but before watchers or pumps may mutate Git.
- Recovery is grouped once per canonical common dir, not repeated for each linked worktree.
- Steady-state busy detection attempts recovery once per stable blocker fingerprint. A successful recovery immediately requeues both pull and push for the whole repo family.
- Owner boot mismatch or PID/start mismatch is strong dead-owner evidence. OS process/open-file inspection is corroboration only.
- Age is an escalation heuristic, never ownership proof. Suggested policy: two stable observations over at least 30 seconds convert an unknown blocker from transient `git-busy` to `stale-unattributed`. Invalid/future timestamps remain indeterminate.
- Only journal-enumerated, exact-marker/token locks may be automatically removed. Unknown extra locks remain blockers.
- Before unlink, re-open no-follow and compare marker, device, inode, size, and mtime; serialize recovery with a fence; fsync each affected directory.
- Keep the journal until all owned locks are absent and post-recovery Git validation succeeds.

The generic lockfile implementation already supplies the right precedent: PID plus process-start liveness ([lockfile.ts:696](/home/via/Development/Personal/rbox-core/src/engine/git/lockfile.ts:696)), exact double-read unlink ([lockfile.ts:765](/home/via/Development/Personal/rbox-core/src/engine/git/lockfile.ts:765)), and fenced dead-owner reaping ([lockfile.ts:830](/home/via/Development/Personal/rbox-core/src/engine/git/lockfile.ts:830)).

Unjournaled legacy/foreign locks must not be auto-deleted merely because they are old and `lsof` finds nothing. Instead, stop the endless generic deferral: persist the common-dir blocker fingerprint and first-seen time, show lock count/sample/oldest age, and give an inspect/repair command. Current status incorrectly describes every `git-busy` as “Another Git process” ([status-view.ts:282](/home/via/Development/Personal/rbox-core/src/cli/status-view.ts:282)).

### 6. Invariants

- L1: Every rbox-created Git lock is either released before process exit or named by a durable recovery authority published before acquisition.
- L2: Automatic deletion requires exact rbox ownership; age and process absence alone never authorize deletion.
- L3: Recovery never follows symlinks, escapes the journal-bound common dir, or deletes a replaced inode/marker.
- L4: Unknown locks fail closed but transition to a visible, durable diagnosis instead of remaining generic `git-busy` forever.
- L5: One common-dir blocker produces one recovery/escalation episode, irrespective of linked-worktree count.
- L6: After recovery, refs are wholly pre-transaction or post-transaction according to the native Git transaction/journal phase; never a synthesized mixed state.
- L7: Shutdown cannot begin a new mutation after its gate closes, and ancillary shutdown failures cannot bypass critical-section drain.

### 7. Tests

1. Real-process crash injection in `withRevalidatedGitPartialApplies`:

   - after durable journal, before first lock;
   - after lock N of ~140;
   - after final lock, before proof;
   - during state save;
   - after state save, before cleanup.

   Restart must remove every exact owned lock and converge without manual intervention.

2. Replacement safety:

   - replace a lock after acquisition with a foreign inode/marker;
   - symlink/non-regular replacement;
   - wrong common-dir binding or path traversal;
   - malformed journal;
   - two concurrent recoverers;
   - unlink/fsync failure.

   Recovery must preserve the replacement, retain its journal, and surface the refusal.

3. Graceful signals:

   - SIGTERM before the mutation gate starts no transaction;
   - SIGTERM during native prepare explicitly aborts and waits for the child;
   - SIGTERM during state-CAS drains through save and cleanup;
   - watcher close rejection does not bypass pump drain;
   - two SIGTERMs remain graceful;
   - a read phase exceeding 60 seconds is not later SIGKILLed inside mutation.

4. Busy classification:

   - live rbox owner, live Git child, dead/reused PID, prior boot;
   - journal-owned dead marker;
   - old unjournaled empty lock;
   - lstat/readdir denial;
   - future mtime;
   - unknown extra lock beside recoverable owned locks.

5. Linked-worktree regression:

   A common dir with a main clone and multiple linked worktrees receives one ~140-lock recovery episode. Recovery clears all family deferrals and immediately retries them; an unrelated common dir continues normally.

6. Native transaction consistency:

   Hard-kill at every prepared/commit/index/op-state phase. Restart must yield old or new coherent state and remove only journal-owned Git locks. Existing prepared-child SIGKILL coverage is a starting point ([checkout-txn.test.ts:350](/home/via/Development/Personal/rbox-core/src/engine/git/checkout-txn.test.ts:350)).

Prior-art note: `MAXLOCK-INVESTIGATION.md` correctly argues for typed causes and exact ownership rather than collapsing everything into “unsupported.” The untracked [lock-doctor.ts](/home/via/Development/Personal/rbox-core/src/cli/lock-doctor.ts:1) should not be copied as-is: despite saying “never mutates,” it refreshes/creates the identity ledger, creates `.rbox`, acquires the workspace mutex, and never releases that handle ([lock-doctor.ts:30](/home/via/Development/Personal/rbox-core/src/cli/lock-doctor.ts:30)). A future lock doctor should be inspect-only by default and release every diagnostic acquisition in `finally`.

This was a read-only investigation; no files were changed or tests run.