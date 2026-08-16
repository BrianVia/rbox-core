Implementation is complete and the full required suite is green, but I could not create commits because the sandbox mounts the worktree’s Git administrative directory read-only.

### Deliverables

- M0 — complete: final acquisition results now emit `locks<N> blocked<M>` through `casStepMs`; blocked records carry a bounded observed `holderMarker`, with `"unknown"` for raced/error/absent reads.
- M1 — complete: strict v2 JSONL journal with atomic header, retained no-follow append FD, full-write loop, `fdatasync`, pathname/FD binding verification after every append, bounded strict folding, one tolerated torn EOF suffix, and retained fail-closed v1 parsing. The directory remains `/v1` so old readers encounter and reject v2 safely.
- M2 — complete: exact-parent acquisition/release batches, unforgeable single-use transaction-bound receipt, all-parent flushing, exact cleanup on acquisition failures, per-parent release durability, and recovery re-fsync before retirement.
- Seams — complete: `afterStateCasLockAppended` and `afterStateCasBatchDurable` replace the deleted old seam. Post-link mismatches are publication errors, never contention.
- Compatibility/safety — copied-marker gate and recovery decision arms remain intact except for the specified retirement re-fsync addition. Rejected marker-only, staged-inode, and temp-fsync-skip alternatives were not introduced.
- Documentation — ownership map and benchmark close-out are recorded in [design 268](</home/via/Development/Personal/rbox-core/.claude/worktrees/cas-lock-amortize/docs/design/268-cas-lock-amortization.md>).

### Tests

- Preflight: **38 pass / 0 fail / 814 expects** in 2.36s.
- Focused design-268 and leak-guard suites: **231 pass / 3 skip / 0 fail / 2,354 expects** in 69.02s.
- Required full `bun test src/cli src/engine`: **5,479 pass / 20 skip / 0 fail / 48,127 expects**, 5,499 tests across 403 files in 550.02s.
- `test:affected`: **4,569 pass / 15 skip / 1 fail / 40,872 expects**. The sole failure was an unrelated suite-pressure heap threshold in `cas-operations.test.ts`—31.3 MiB observed versus 16 MiB. Isolated rerun: **23 pass / 0 fail / 123 expects**.
- File-size ratchet: **6 pass / 0 fail / 201 expects**.
- `git diff --check`: clean.
- Old hook-name search: no matches.

### 140-lock benchmark

Median of five acquire+release runs:

| Phase | Before | After | Change |
|---|---:|---:|---:|
| Acquire | 98.678 ms | 85.528 ms | -13.3% |
| Release | 32.964 ms | 27.716 ms | -15.9% |
| Total | 130.718 ms | 113.039 ms | -13.5% |

### Static checks

- `bun run lint:affected`: **green, zero warnings** across 12 changed lintable files.
- `bun run typecheck`: **green** for root, `apps/api`, and scripts.

### Deviations and blockers

- **No commits were created.** Git failed with:
  `Unable to create .../.git/worktrees/cas-lock-amortize/index.lock: Read-only file system`
  
  The work remains unstaged on `cas-lock-amortize`; nothing was pushed.
- The final `test:affected` invocation was not green due to the unrelated memory-sensitive test described above, although that file passes alone and the larger required full suite passes.
- The new/refactored CAS modules are all ≤500 lines, but the surgically touched pre-existing deep modules `lockfile.ts` (1,621 lines) and `pull.ts` (528 lines) remain above the literal limit. Splitting those cohesive modules would have been an out-of-scope move-only refactor.
- The FM field re-pull and APFS-specific lane were unavailable on this Linux/NVMe runner; the required local 140-lock before/after benchmark was completed.