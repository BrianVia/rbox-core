# Implementation spec — design 268 r4 (CAS lock durability amortization)

Authority: `docs/design/268-cas-lock-amortization.md` (r4, ALIGNED —
CODEX-268-R4.md). Reviews CODEX-268-R1..R3.md hold the REJECTED
alternatives (marker-only recovery, staged-inode scheme, temp-fsync skip)
— do not reintroduce any of them.

## Objective

M0 (lock-count attribution) + M1 (append-structured journal v2) + M2
(batched directory fsyncs via sealed receipt). Acquire on the FM shape:
50.3s → ~9s expected. All recovery refusals, ownership gates, and
containment fences byte-identical in behavior.

## Deliverables

1. M0: `locks<N> blocked<M>` appended to the state-save span from the
   acquisition's FINAL result via the existing `casStepMs`/`appendDetails`
   channel (`pull.ts:481-483`); `holderMarker` bounded optional field on
   blocked journal entries (explicit `observeLockMarker` read at block
   time; `"unknown"` on raced read; never replaces the txn's own marker).
2. M1: journal v2 per design §M1 — atomic header at `prepared`; JSONL
   appends (acquisition/blocked/locked/committed) on a retained fd with
   `fdatasync` + the retained-fd path-binding check after EVERY append
   (no-follow stat: regular file, fd's dev/ino, length covers append,
   inside boundary; mismatch = fail acquisition + exact cleanup of all
   published links + no hook). Strict fold parser per design (single
   header first, allowlist-bound, unique outcomes, ordered phases,
   bounded sizes, ONE ignorable EOF suffix, otherwise whole-journal
   indeterminate). v1 parser retained fail-closed; no v1 write path.
3. M2: sealed batch receipt per design §M2 (six numbered requirements) —
   exact-parent accumulation, `flushAll()` → sealed receipt gating the
   `locked` append, all-links cleanup on ANY flush failure, release-side
   per-parent `durable` mapping, recovery re-fsync of absent-entry
   parents before journal retirement, single-use guard. Lockfile layer:
   batching strictly opt-in; `acquireLock`/`acquireFence`/all other
   consumers keep today's per-call fsync + hook contracts.
4. Seams: `afterStateCasLockAppended` + `afterStateCasBatchDurable`
   replace `afterStateCasLockPersisted` (deleted, not aliased); crash
   matrix kills at both. Post-link readback mismatch = fail-closed
   publication error (never `blocked`).

## Tests (design §5, implement every bullet)

Crash matrix `state-cas-locks.test.ts:370` keeps its END-STATE assertions
with the two new seams; new crash points (post-batch-flush pre-`locked`;
torn final append → fail-closed stale/retain with copied-marker fixture
:188 UNTOUCHED); v1/v2 compat incl. released-old-binary/v2-journal
fail-closed matrix (use a v1-parser-only harness stand-in for the old
binary if a real old binary is impractical — name the stand-in honestly);
receipt failure fixtures (acquisition flush fail → ALL links released +
journal retained; release flush fail → non-durable + retirement refused;
recovery re-fsync fixture); multi-directory refs under one common dir;
strict-fold rejection fixtures (malformed middle record, duplicate
outcome, misordered phase → indeterminate); fdatasync append durability
probe; path-binding mismatch fixture. `git-sync.test.ts:534` journal-leak
guard must stay green. Bench: timed acquire+release on the 140-lock
fixture, before/after, recorded in the design doc.

## Preflight (FIRST, before writing code)

`bun test src/cli/sync-git/state-cas-locks.test.ts` must execute and pass
in this worktree (wrap in a scratchpad script with a '268-' prefix under
/tmp/claude-1000/-home-via-Development-Personal-rbox-core/3df4bb89-5a2e-4699-bb8a-05b1f33f52a1/scratchpad
if the direct form is refused). If tests cannot run: STOP and report.

## Process

- `bun run test:affected` per iteration; ONE full `bun test src/cli
  src/engine` as the final gate.
- `bun run typecheck` green (clear .cache/tsbuildinfo on phantom flips).
- `bun run lint:affected`: zero warnings in every touched file (the only
  standing exceptions are the 3 documented persisted-field names in
  sync-state-model.ts, which this change should not touch). Restructure,
  never suppress. Files ≤500 lines; comments only for inexpressible
  constraints.
- Commit in logical commits on `cas-lock-amortize`. Do NOT push.

## Do NOT touch

- Recovery decision arms in `recoverStateCasLocks` beyond the specified
  re-fsync-before-retirement addition; the `:504-511` observation gate.
- `sync-mutex.ts`, the workspace mutex, scheduler, daemon loop.
- `engine/lockfile.ts` default contracts for non-CAS consumers.
- Anything in src/cli/state-plane/ (design 267's territory — a separate
  in-flight branch; expect a rebase over it before merge).
