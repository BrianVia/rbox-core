# Verdict: CHANGES-REQUIRED

M1 reintroduces a deletion bug already reproduced during design-178 hardening: exact marker bytes without a persisted observation do not prove that this transaction acquired the inode. Combined with deferred `blocked` persistence, recovery can delete a lock that was never owned.

M2’s target ordering is valid, but its proposed hook/interface does not yet preserve that ordering or existing hook semantics. M2b is unsafe and should be rejected.

## Findings

### CRITICAL — M1’s marker-only recovery arm violates L2/L3 and the ratified exact-ownership invariant

Evidence:

- The prepared journal publishes every future marker before attempting any lock: [state-cas-locks.ts:152](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:152), [state-cas-locks.ts:177](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:177).
- Acquisition can then encounter an existing path and classify it `blocked`: [state-cas-locks.ts:207](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:207), [state-cas-locks.ts:217](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:217).
- M1 proposes deleting any exact-marker, observation-free lock after dead-owner/proof checks: [268-cas-lock-amortization.md:83](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:83).
- The current observation gate deliberately refuses this: [state-cas-locks.ts:504](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:504). The schema explicitly says marker bytes alone are never enough: [state-cas-locks.ts:75](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:75).
- The ratified invariant requires both marker and observation identity so replaced/stolen locks are never removed: [INVARIANTS.md:317](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/INVARIANTS.md:317).
- This is not hypothetical. The original implementation’s L2 failure—deleting a foreign inode containing a copied marker—was reproduced and drove the current hardening: [STATUS.md:1425](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/STATUS.md:1425).

Concrete counterexample:

1. Prepare durably exposes marker `M`.
2. Before acquisition, another same-user process, corruption, restore, or test fixture creates the target path with bytes `M`.
3. `publishLockMarker` returns `exists`; in memory the entry becomes `blocked`.
4. The process crashes before M1’s single `locked` journal write.
5. Durable state contains no observation and no `blocked` outcome.
6. Owner is dead and Git proofs still validate.
7. M1 freshly observes the foreign inode and deletes it.

The recovery fence protects against replacement after the fresh observation. It cannot establish ownership of the inode that existed before that observation. `validateJournalProofs` validates ref state, not lock provenance.

The “0600 journal” argument does not close this. L2/L3 and the ratified exact-ownership invariant contain no same-user, accidental-corruption, or marker-secrecy exception. Inode reuse is the same problem: without an earlier identity there is nothing to compare; the current observation tuple, including birth time where available, exists precisely to distinguish that case.

### MAJOR — Dropping per-blocked-entry persistence loses recovery-significant information

The blocked arm is not merely reporting data. Recovery uses it to decide that a mismatching lock was never ours and therefore need not retain the transaction journal: [state-cas-locks.ts:495](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:495), [state-cas-locks.ts:499](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:499).

Without the per-entry write, a mid-loop crash loses the distinction among:

- not attempted;
- blocked;
- successfully published but not observation-persisted.

For ordinary foreign bytes this degrades to journal retention until the blocker disappears. For exact copied bytes it combines with M1 into the CRITICAL deletion above.

Therefore [268-cas-lock-amortization.md:79](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:79) is incorrect: blocked outcomes cannot simply remain in memory if an observation-free entry is made deletion authority.

### CRITICAL — M2b breaks crash-safe complete-byte publication

Reject M2b.

`atomicCreateMarker` currently establishes marker-content durability by syncing the staging inode before linking it: [lockfile.ts:1222](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1222), [lockfile.ts:1226](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1226). A later directory fsync persists the name/link, not necessarily the inode’s data contents.

Without the temp-file fsync, these crash windows can expose a durable link with empty, partial, or stale marker contents:

- after `link`, before the batched directory fsync;
- after the batched directory fsync, before the `locked` journal write;
- after the `locked` journal write.

The prepare journal containing another copy of the intended marker does not make the linked inode’s contents durable. Recovery will observe a mismatch and fail closed, stranding the lock and journal. Reconstructing or overwriting the lock from journal bytes would itself be unsafe because the path may now be foreign.

This directly violates “complete bytes or not published at all”: [INVARIANTS.md:325](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/INVARIANTS.md:325), and the adopted publication pattern explicitly requires the fsynced sibling temp: [REPORT-2-locks.md:75](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/.claude/forensics-0721/REPORT-2-locks.md:75).

### MAJOR — M2 states the right ordering but does not specify an interface that preserves it

The intended rule is sound:

> Write the `locked` journal only after every containing directory of every published link has been fsynced.

If the temp-file fsync remains and every actual `path.dirname(lock.path)` is flushed, there is no window where the durable `locked` journal names a nondurable link.

But the proposed “opt-in batching hook” is insufficiently specified:

- `publishLockMarker` currently returns success only after `finalizeCreated` performs the directory fsync, invokes `afterCreate`, and verifies the inode: [lockfile.ts:1284](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1284), [lockfile.ts:1367](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1367).
- `afterCreate` currently means “after directory durability,” not merely “after link”: [lockfile.ts:1381](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1381).
- Release reports per-lock `durable`, and the caller refuses journal retirement when it is false: [lockfile.ts:1329](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1329), [state-cas-locks.ts:254](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:254).

The design must define a batch object/receipt that owns:

1. exact parent-directory accumulation;
2. flush-before-`locked` ordering;
3. delayed `afterCreate` semantics or an explicitly revised hook contract;
4. cleanup of all exact links if a batch flush fails;
5. release-directory flush before journal retirement;
6. failure reporting without falsely returning `durable: true`.

Also, batching must be by actual containing directory, not merely Git common directory. Ref paths can occupy several directories under one common dir.

### MAJOR — Validation misses the counterexamples that decide M1

The proposed copied-marker fixture covers only “persisted mismatching observation”: [268-cas-lock-amortization.md:154](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:154). That preserves the easy arm but does not exercise the newly dangerous one.

Required cases before reconsideration:

- copied exact marker installed before acquisition; acquisition returns `blocked`; crash before `locked`;
- original link replaced by a copied-marker inode before any observation becomes durable;
- exact-marker inode reuse/recreation in the observation-free window;
- crash after link but before batched directory flush;
- M2b-specific crash after directory flush with marker-file contents not fsynced;
- batched directory-fsync failure during acquisition and release;
- multiple actual lock-parent directories under one common dir.

The existing copied-marker test proves the protected behavior M1 would narrow: [state-cas-locks.test.ts:188](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.test.ts:188).

### MINOR — M0 incorrectly says blocked entries already contain holder identity

A blocked entry currently records only `acquisition: "blocked"`; its `marker` is this transaction’s planned marker, not the holder’s marker: [state-cas-locks.ts:75](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:75), [state-cas-locks.ts:217](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:217). `publishLockMarker` returns only `exists`, without inspection evidence: [lockfile.ts:1290](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1290).

Thus [268-cas-lock-amortization.md:63](/home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md:63) needs correction or an explicit additional read.

## Direct answers to the six attacks

1. **M1 restored arm:** unsafe. It cannot distinguish “published then crashed” from “blocked by an exact copied marker,” or a pre-observation replacement/reused inode. It violates L2/L3 and the current exact-ownership invariant.

2. **M2 durability ordering:** the stated ordering is correct only if every actual containing directory is flushed and the temp fsync remains. The proposed hook mechanism does not yet prove that contract.

3. **Dropping blocked writes:** yes, it loses recovery information. At minimum it causes excess journal retention; with M1 it permits deletion of a never-acquired exact-marker blocker.

4. **M2b:** refuted. Directory fsync does not substitute for syncing the marker inode’s contents.

5. **Tests pinning per-lock journal durability:** no test requires a full O(N) journal rewrite as the representation. They do pin exact observation-based ownership, copied-marker preservation, and the meaning of the `afterStateCasLockPersisted` crash seam. The optimization may change storage mechanics, but not those semantics.

6. **L1:** the prepare write satisfies the superficial “named before acquisition” wording, but not L1 as part of L1–L3. A durable record is not a recovery authority unless it can safely identify what may be deleted. The current prepare record supplies names and markers, but not exact inode ownership.

## Recommended re-frame

The promising primitive is to stage and fsync all sibling temp markers first, capture their inode observations, then publish one prepared journal containing those observations before hardlink acquisition. Successful hardlinks inherit the already-journaled inode identity. This can eliminate full-journal rewrites while preserving exact ownership; blocked links never match their staged inode.

Do not remove per-lock marker-file fsyncs, exact observation identity, copied-marker protection, or release durability. No deletion or retirement of those semantics is approved.

Test execution was attempted, but the environment is read-only: all 38 focused tests failed in `beforeEach` with `EROFS` creating `/tmp` fixtures, so no runtime result is claimed.