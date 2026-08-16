# Verdict: CHANGES-REQUIRED

R3 makes the correct architectural retreat: it abandons staged-inode attribution, preserves per-lock durable observation, retains marker-content fsync, and attacks only representation and directory-flush cost. I found no new copied-marker, inode-reuse, or same-user hard-link deletion arm.

However, three design gaps remain:

1. `afterStateCasLockPersisted` does not retain its current boundary when lock-parent fsync is deferred.
2. A retained journal fd can become detached from the discoverable journal pathname unless each persisted append verifies that binding.
3. The v2 codec and v1 retirement/rollback contract are not yet strict enough.

## Findings

### MAJOR — The persisted seam’s boundary changes despite the preservation claim

R3 says the seam keeps its name and meaning at [design:48](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:48), and places the hook after the per-lock journal append but before the complete parent-directory flush at [design:104](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:104).

Today the callback runs only after `publishLockMarker()` completes ([state-cas-locks.ts:207](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:207)), and publication completion includes:

1. marker inode sync;
2. hard-link creation;
3. lock-parent directory fsync;
4. `afterCreate`;
5. exact post-fsync readback verification ([lockfile.ts:1367](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1367));
6. journal persistence;
7. `afterAcquisitionPersisted` ([state-cas-locks.ts:214](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:214)).

Under r3, at the proposed callback point the observation record is durable, but the lock’s directory entry is not yet durable. A machine crash can retain the journal append while losing the link. A SIGKILL test will not expose that difference.

This does not make recovery unsafe—the durable observation remains valid authority only if the exact inode is present—but it is not the same seam boundary.

The design must choose explicitly:

- Preserve `afterStateCasLockPersisted` by invoking it only after the batch flush and final exact readback. Add a differently named per-append seam if needed; or
- Approve and document the semantic change, rename the seam, and revise the crash contract.

It cannot preserve the current per-lock “journal and namespace both durable before later locks” callback boundary while also batching those namespace fsyncs.

This also means receipt requirement 3 is not yet met. Requirements 1, 2, 4, 5, and 6 are now adequately specified.

### MAJOR — Retained-fd appends need a discoverable-path binding check

The retained descriptor is a good performance primitive, but `fdatasync(fd)` proves durability of the inode referenced by `fd`; it does not prove that `journalPath` still names that inode.

Counterexample:

1. Header inode `J` is atomically published and its directory synced.
2. The retained fd references `J`.
3. The pathname is unlinked, renamed, or replaced.
4. An acquisition record is appended and `fdatasync` succeeds.
5. The callback fires and acquisition proceeds.
6. After a crash, recovery cannot discover `J`, or opens a different inode at the expected pathname.

The current full atomic rewrite re-establishes a durably named journal at every per-lock persisted instant. R3 must preserve that property.

After every successful `fdatasync`, before treating the append as persisted or invoking its seam, verify no-follow that:

- `journalPath` is a regular file;
- its `dev`/`ino` equals the retained fd’s identity;
- its length covers the completed append;
- the journal directory/path remains inside the validated workspace boundary.

A mismatch must fail acquisition, trigger exact cleanup of all transaction-published links, retain any discoverable authority, and never invoke the persisted hook. This check need not add a directory fsync.

### MAJOR — V2 parsing and compatibility need a stricter rollout contract

The high-level v2 representation is sound, but [design:81](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:81) does not yet define a sufficiently fail-closed fold.

The codec must require:

- explicit record discriminators for header, acquisition, locked, and committed records;
- exactly one valid header as the first record;
- acquisition paths drawn from the header allowlist;
- at most one acquisition outcome per lock;
- no acquired/blocked conflicts or duplicate phase records;
- `locked` only after every allowlisted lock has one durable outcome;
- `committed` only after `locked`;
- bounded line, record-count, and total-journal sizes;
- unknown record types, malformed newline-terminated records, invalid ordering, or malformed non-final records make the entire journal indeterminate.

Only one incomplete EOF suffix may be ignored. A parser must not skip arbitrary malformed lines and continue folding later records.

The torn-line equivalence claim is otherwise correct:

- If the acquired record is torn, recovery has an exact marker with no persisted observation and retains it.
- If a blocked record is torn, it loses the safe `blocked` classification and conservatively retains.
- If a phase record is torn, recovery observes the preceding phase.

Those are safe and equivalent to the corresponding current crash-before-atomic-rewrite windows.

The retirement statement also needs correction. “One release window” does not prove that no v1 journal can exist: a retained v1 journal can survive indefinitely because of a blocker, unknown owner, validation failure, or damaged filesystem. Under the house rules, retire v1 only after a concrete migration/absence gate, or retain the reader indefinitely.

The plan must also document downgrade behavior. A released old binary will parse a v2 JSONL file as malformed and retain it. That is fail-closed for safety but not operationally compatible. Either:

- stage a read-compatible release before enabling v2 writes;
- explicitly declare downgrade unsupported for that window with an operational recovery path; or
- provide another rollout mechanism that released-old and candidate binaries both understand.

The proposed validation currently tests new-reader/v1 and new-reader/v2 restart only; it needs a released-old/candidate matrix.

### MINOR — `fdatasync` is sufficient, with explicit failure and filesystem qualifications

The core durability assumption is correct. POSIX data-integrity completion includes the data and filesystem information required to retrieve it. Linux explicitly includes changed file size among metadata that `fdatasync` must persist. Node exposes that operation as `FileHandle.datasync()`. [POSIX definitions](https://pubs.opengroup.org/onlinepubs/9799919799/basedefs/V1_chap03.html), [Linux `fdatasync(2)`](https://man7.org/linux/man-pages/man2/fsync.2.html), [Node filesystem API](https://nodejs.org/download/release/latest-v17.x/docs/api/fs.html)

Therefore:

- Data-only sync is sufficient for an append; full inode-metadata `fsync` is unnecessary.
- No per-append directory fsync is needed because the header’s inode/name was already atomically published and its directory synced.
- The changed file length is part of data-retrieval metadata and must be persisted by `fdatasync`.
- A returned `fdatasync` error means the append is not proven durable and must fail closed.
- Writes must use append semantics and complete the entire encoded record before syncing; partial-write handling must be explicit.
- Network filesystems, unusual FUSE implementations, controller caches, and storage that falsely acknowledges barriers remain implementation-specific caveats. The same broad limitation already applies to current `fsync`; ext4/APFS probes plus fail-closed error behavior are proportionate.

The proposed native probe is useful, though an ordinary process-crash test cannot by itself prove power-loss durability.

### MINOR — The requirement-challenge ledger is correct in form, but its alternative needs tightening

Recording the deeper win without building it is exactly the right house-rule treatment: the expensive requirement remains protected, its cost is visible, and removal requires a founder decision.

However, [design:131](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:131) should say native support **and** a threat-model ruling, not “AND/OR.”

An atomic no-replace rename solves the link+unlink crash window, but under the current deliberate same-user model another process can itself consume the discoverable staged name into the target before this transaction’s syscall. After a crash, “source absent plus target matches” still does not identify which process performed the rename. Native rename alone therefore does not establish recovery attribution under the exact threat model that rejected r2.

The future options are:

- native consumed-name publication plus explicit exclusion of deliberate same-user consumption;
- a stronger unforgeable OS capability/isolated namespace primitive; or
- continued per-acquisition durable provenance.

## Direct answers

1. **Per-lock durable provenance:** Yes, the append representation preserves it, provided the fd/path binding check and strict codec rules above are added. A torn final acquisition line safely collapses to today’s unobserved-publication arm.

2. **`fdatasync` durability:** Yes. It is sufficient for append data and required retrieval metadata such as file length. An already durably named inode needs no repeated directory fsync. Errors and unsupported/filesystem-specific behavior must fail closed.

3. **V1/v2 compatibility:** New-reader compatibility is conceptually correct, but the rollout is incomplete. V1 cannot retire merely after elapsed release time, and old-reader handling of v2 must be specified and tested.

4. **Six receipt requirements:** Requirements 1, 2, 4, 5, and 6 are now met. Requirement 3 is not: both `afterCreate` and `afterStateCasLockPersisted` currently imply lock-parent durability, which is absent at the proposed per-append callback point.

5. **New defects:** No new lock-deletion/provenance defect. New specification defects are the changed seam boundary, retained-fd/path detachment, insufficiently strict JSONL folding, and incomplete downgrade/retirement gates.

6. **Ledger framing:** Acceptable and desirable, after correcting the future alternative to acknowledge that native no-replace rename alone does not defeat a deliberate same-user consumer.

## Protected functionality and non-approvals

Still protected:

- exact observation-based ownership and release;
- copied-marker, replacement, and inode-reuse preservation;
- marker inode content fsync;
- no-follow, containment, and common-directory identity fences;
- non-blocking contention;
- per-acquisition durable provenance before later acquisition;
- complete transaction cleanup on any acquisition failure;
- per-actual-parent release durability;
- absent-entry parent re-fsync before recovery retirement;
- journal-retirement refusal on incomplete durability;
- other lockfile consumers’ existing publication and hook contracts;
- fail-closed malformed-journal behavior;
- v1 compatibility until evidence-backed retirement.

No current recovery refusal, durability guard, compatibility reader, or callback contract is approved for deletion or silent narrowing. The expected 2.5–3× / 15–20s estimate is appropriately framed as a measured hypothesis rather than a promised result.