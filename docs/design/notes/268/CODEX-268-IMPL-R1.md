# Verdict: CHANGES-REQUIRED

## Findings

### CRITICAL — acquisition-failure authority is retained internally, then deleted by the production caller

The acquisition catch correctly cleans published links and calls `releaseStateCasLocks(..., { retainJournal: true })` at [state-cas-locks.ts:198](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:198>).

However, when acquisition rejects, the caller never assigns `acquired.held` to its outer `held` variable at [received-git-transition-commit.ts:294](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/received-git-transition-commit.ts:294>). Its unconditional `finally` then performs a second release with `held=[]` and without `retainJournal` at [received-git-transition-commit.ts:323](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/received-git-transition-commit.ts:323>).

That second call:

1. Starts with `exact=true`.
2. Flushes no lock parents because the held list is empty.
3. Observes the cleaned lock paths as absent.
4. Removes the journal at [state-cas-locks.ts:252](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.ts:252>).

I reproduced this through `withRevalidatedGitPartialApplies` with an injected batch-finalization failure:

```json
{"failed":true,"journals":[],"locks":0}
```

This violates both “retain discoverable authority” and the M2 flush-failure contract. More seriously, after a parent-fsync failure the inner cleanup may have unlinked a lock without making that unlink durable. The empty outer release never re-fsyncs that parent, yet deletes the journal. A crash can therefore resurrect the lock dentry without recovery authority.

The direct acquisition tests at [state-cas-lock-batch.test.ts:60](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-lock-batch.test.ts:60>) and [state-cas-journal.test.ts:136](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-journal.test.ts:136>) miss this because they do not exercise the production wrapper’s `finally`.

### MINOR — non-CAS lock acquisition is not literally byte-identical

Batching is opt-in and the default fsync/hook ordering remains intact, but the shared generic path changed for every `acquireLock` and recovery-fence acquisition:

- `atomicCreateMarker` now performs an additional staged-inode `fstat` at [lockfile.ts:1227](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1227>).
- `finalizeCreated` now unconditionally performs another no-follow read and staged-inode comparison at [lockfile.ts:1378](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1378>).
- Both `acquireFence` and `acquireLock` traverse this changed path at [lockfile.ts:1432](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1432>) and [lockfile.ts:1584](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/engine/lockfile.ts:1584>).

The stricter same-inode check is sensible hardening, but it changes race behavior and adds syscalls to non-CAS fast paths. Either scope it to the CAS opt-in or explicitly approve and document the broader lockfile change.

No MAJOR findings.

## Contract audit

- **M1 journal v2:** The codec itself is aligned. Appends use `FileHandle.datasync()`, full-write loops, no-follow reopening, dev/inode identity, length coverage, regular-file checks, and validated-root containment. The public appended seam fires only after binding succeeds. The strict fold enforces one first-position header, allowlisted unique outcomes, phase ordering, bounded input, and one discarded unterminated EOF suffix. Known v1 records remain fail-closed and recoverable.
- **M2 receipt:** Internally aligned: transaction-bound single-use receipt, complete outcomes, exact parent derivation, all-parent attempts, final readbacks, and per-parent release durability. The critical finding is the caller composition around failure, not the receipt primitive.
- **Recovery:** The exact observation gate and copied-marker refusal remain behaviorally intact; the copied-marker fixture at [state-cas-locks.test.ts:187](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/state-cas-locks.test.ts:187>) is untouched. The only substantive recovery addition is absent-parent re-fsync before retirement.
- **Seams:** The old source hook is fully deleted. The real-process matrix invokes `SIGKILL` at both `afterStateCasLockAppended` and `afterStateCasBatchDurable`, with the previous journal/lock end-state assertions preserved.
- **Rejected alternatives:** None reappeared. Recovery still requires exact persisted observations; publication remains hardlink-based rather than staged-inode authority; marker temp files still call `sync()`.
- **Post-rebase M0:** Correctly relocated. Counts originate from the completed acquisition result at [received-git-transition-commit.ts:307](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync-git/received-git-transition-commit.ts:307>), are assigned—not accumulated—in [pull-state-save.ts:102](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync/pull-state-save.ts:102>), and render through [format.ts:48](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/src/cli/sync/format.ts:48>). There is no double-count or crash-seam telemetry reuse.
- **Ownership:** The journal and batch modules are coherent deep modules, and `CODEMAP.md` records their ownership. No unapproved deletion or retirement beyond the old hook was found.

## Validation

- Focused suites excluding the sandbox-blocked crash process: **130 passed, 2 skipped, 0 failed**.
- `bun run typecheck`: green.
- `bun run lint:affected`: green.
- Real-process crash test could not complete here because Bun child-process stdin writes are denied with `EPERM`; static inspection confirms both kill points and preserved assertions.
- `git diff --check origin/main..HEAD` is not clean: trailing whitespace at [CODEX-268-IMPL-LAST.md:41](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/CODEX-268-IMPL-LAST.md:41>).

The CRITICAL double-release/retirement defect must be fixed before alignment.