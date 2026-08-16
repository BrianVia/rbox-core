# Verdict: CHANGES-REQUIRED

R2 closes the three R1 counterexamples it explicitly targets, and the `MarkerObservation` tuple is compatible with normal hard-link semantics on APFS/ext4. However, the hard-link staging primitive introduces a new same-inode ambiguity: another same-user process can publish the staged inode before acquisition. Recovery then cannot distinguish that foreign link from one created by this transaction.

The staging sweep and batch receipt also need tighter durability and containment contracts before implementation.

## Findings

### CRITICAL — Pre-acquisition hard-linking of the staged inode defeats ownership attribution

R2 correctly observes that copied bytes, replacement files, and inode recreation produce an observation different from the staged observation. But the staged inode is itself a named, hard-linkable object, and its path is durably exposed in the journal before acquisition ([design:43](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:43), [design:54](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:54)).

Counterexample:

1. Transaction stages inode `I` and persists observation `O(I)`.
2. Before its acquisition call, another same-user process hard-links `stagedPath` to `lockPath`.
3. The transaction’s `fs.link` returns `EEXIST`, so the lock is only `blocked` in memory.
4. It crashes before the single `locked` write.
5. Recovery sees `lockPath` with exactly `O(I)`.
6. The unchanged gate at [state-cas-locks.ts:504](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:504) classifies it as owned and deletes a namespace entry this transaction did not create.

Mode `0700`/`0600` does not exclude another process running as the same user—the same class R1 explicitly considered. Random names do not help because the journal records `stagedPath`, and directory enumeration is also available to that user.

This is the same fundamental ambiguity as R1, shifted from “same bytes without identity” to “same prepublished inode without publication provenance.”

The clean primitive is an atomic no-replace move, such as Linux `renameat2(RENAME_NOREPLACE)` / Darwin `renamex_np(RENAME_EXCL)`, because successful acquisition consumes the staged name while contention leaves it present. Recovery can then require:

- target matches staged observation; and
- staged source is absent.

Both source and destination parent directories would need batched durability. If that cross-platform primitive is unacceptable, either per-entry durable publication provenance remains necessary or the same-user hard-link case needs an explicit product-level threat-model exclusion. The current exact-ownership invariant does not provide that exclusion.

### MAJOR — The staging sweep is not yet discoverable, bounded, or live-owner-safe

The lifecycle at [design:99](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:99) is incomplete.

For a crash before the prepared journal:

- There is no journal from which startup recovery can discover the affected common directory.
- `recoverStateCasLocks(root)` currently discovers common directories only through journals.
- The existing owner-liveness check operates on a journal owner. An orphan staging directory has no such record.
- An empty or partially populated directory may not contain enough marker evidence to derive one owner safely.

Therefore “no-journal staging dir is swept unless its owner is live” is not implementable from the stated authority. Specify whether orphan staging is merely eventual litter cleaned when that common directory is later discovered, or add a durable discoverability/owner primitive before staging begins.

The staging tree also needs its own containment helper; `safeBoundLockParent` only accepts `.lock` leaves ([lockfile.ts:322](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:322)). Required rules include:

- exact `<validated-common>/rbox-locks/staging/v1/<hex-txn>` derivation, never trusting journal `stagedPath` directly;
- no symlink component or substituted non-directory;
- common-directory identity validation before staging and again under the recovery fence before cleanup;
- no recursive deletion of a replaced/unvalidated transaction directory;
- fail-closed handling of empty, mixed-owner, malformed, unreadable, or concurrently changing contents;
- durable removal by syncing the surviving `staging/v1` parent.

Staging cleanup failures should not automatically increment the existing `indeterminate` lock-recovery count. Deferral hygiene converts that count into an unrelated Git-busy retention decision ([deferral-hygiene.ts:358](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/deferral-hygiene.ts:358)). Use separate staging-cleanup diagnostics unless the failure actually makes lock ownership indeterminate.

### MAJOR — §3.6 does not fully satisfy the six receipt requirements

The acquisition side is close, but requirement 4 is narrowed incorrectly. It says a flush failure cleans links in “the failed directory” ([design:132](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:132)). If directories A and B flush successfully and C fails, the entire acquisition fails; all links published by the transaction—A, B, and C—must be released exactly. The current catch path releases all held locks, and that behavior must remain protected.

The release-side computation is sufficient only if the receipt maps each successful unlink to its actual parent and derives each per-lock `durable` result from that parent’s batch result. No lock in a failed or unattempted parent may report `durable: true`.

Journal-retirement refusal is not complete across recovery. Today a failed release fsync keeps the journal during that call ([state-cas-locks.ts:254](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:254)), but a later recovery sees the lock absent and can retire the journal without retrying the lock-parent fsync ([state-cas-locks.ts:483](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:483), [state-cas-locks.ts:566](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:566)). Because the in-memory failed receipt is gone, recovery must flush the actual parent directories of absent acquired/pending entries before retiring their journal.

Also strengthen the type-level ordering: `flushAll()` should return a sealed success receipt containing the complete acquisition outcomes, and only that sealed value should permit `writeLocked`. An observations list alone does not prove that all blocked outcomes and all parent flushes were incorporated.

### MAJOR — `after-lock-N` keeps the end assertions, but not its existing semantic contract

The existing hook is explicitly named and documented as `afterStateCasLockPersisted` ([received-git-transition-commit.ts:254](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/received-git-transition-commit.ts:254)). The current test kills after that persisted boundary ([state-cas-locks.test.ts:406](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.test.ts:406)).

Moving it to immediately after `link` means the SIGKILL test will probably retain the same visible assertions:

- recovery reports no indeterminate journal;
- journal directory ends empty;
- no `.lock` remains.

But those assertions no longer prove the same boundary. SIGKILL does not model loss of unflushed directory metadata, and “after link” is not “after persisted.” Thus [design:169-172](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:169) cannot simultaneously claim relocation and preserved hook contract.

Rename the relocated hook to `afterStateCasLockLinked`, update the test name, and add a separate seam after the complete parent-directory batch flush. Do not reuse the per-link crash callback for telemetry; counts are already available from the final acquired/blocked result.

### MINOR — A successful link with mismatching readback is not `blocked`

The design says a post-link observation mismatch becomes `exists`/blocked ([design:67](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:67)). If `fs.link` returned success, no existing holder caused `EEXIST`. A mismatch means replacement race, unsupported filesystem semantics, or indeterminate publication. It must be a fail-closed publication error, with exact cleanup where possible and journal retention—not a blocked acquisition attributed to another holder.

### MINOR — Resolve the schema and holder-record shape in the design

The version decision cannot remain deferred at [design:57-61](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:57). The current v1 parser accepts an observation only when `acquisition === "acquired"`; prepared staged observations intentionally change that meaning. Specify a v2 schema while retaining fail-closed v1 parsing and old/new restart compatibility.

The holder marker also needs a separate bounded optional field. It must not replace the transaction marker, because recovery requires the persisted observation’s `raw` to equal the transaction marker. A raced-away blocker should record `unknown`, not pretend an “actual marker” was captured.

## Direct answers

1. **R1 copied/replacement/reuse variants:** Yes. An independently copied marker, a copied-marker replacement before `locked`, and inode reuse/recreation all differ from the staged observation and are retained. Birth time strengthens inode-reuse detection where available. However, a foreign hard link to the staged inode is a new counterexample and remains unsafe.

2. **Hard-link observation inheritance:** For ordinary POSIX hard links, the published path has the same device, inode, size, mtime, birth time, and bytes. Link creation changes ctime/link count, neither of which `sameMarkerObservation` compares ([lockfile.ts:1298](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1298)). I found no APFS/Darwin-specific reason for a false mismatch. Add native APFS and ext4 tests asserting staged and linked observations compare equal; fail closed if a supported runtime violates it.

3. **Staging lifecycle:** Not sufficient. Containment needs a dedicated no-follow/common-identity fence; no-journal orphan discovery and live-owner proof are unspecified; cleanup results must be separated from Git-lock classification so unrelated litter does not poison deferral hygiene.

4. **Batch receipt:** Requirements 1–3 and 6 are substantially addressed. Requirement 4 must clean all transaction-published links, not only the failed directory. Requirement 5 needs per-parent release result mapping plus absent-path parent fsync during later recovery before journal retirement.

5. **After-lock-N:** The current end-state assertions can remain green after relocation, but the test no longer asserts the same persisted boundary. Rename the seam and add a post-batch-flush crash seam.

6. **New defects:** The pre-acquisition hard-link alias is critical. Additional new gaps are orphan-staging discoverability/containment, partial-batch cleanup wording, later recovery retirement without re-establishing release durability, and misclassification of post-link readback mismatch.

## Protected functionality and non-approvals

Protected without change:

- exact observation-based release and copied-marker preservation;
- L1–L3, including no deletion based on age, absence, or bytes alone;
- per-marker content fsync;
- no-follow/symlink/common-directory fences;
- non-blocking contention;
- other lockfile consumers’ existing fsync and `afterCreate` contracts;
- release durability and journal-retirement refusal;
- deferral-hygiene classification semantics;
- O(N) journal bytes and batched-directory performance objective.

M2b remains rejected. No existing recovery refusal, compatibility path, or durability check is approved for deletion or retirement.

Test execution was attempted: all 38 focused tests failed in `beforeEach` because the environment is read-only (`EROFS` creating `/tmp/rbox-state-cas-locks-*`). No runtime pass is claimed.