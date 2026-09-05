# 297 — Fold roots with one live iterator per phase

Status: implemented for S3a in `plans/sync-git-improvements/plan.mdx`;
adversarial review aligned after two rounds.

## Owner and protected contract

`WorkspaceSync.foldSequence` remains the sole owner of roots-index fold
orchestration and `diff` remains its private ordered-set comparison primitive.
The CLI, HTTP routes, alarms, and storage adapter gain no policy.

Protected behavior is unchanged: `fold_subcursor` stays
`{phase:"removed"|"added",lastSha:string}`; every SQL chunk and its cursor write
remain in the same `transactionSync`; a crash resumes strictly after the last
committed SHA; the isolate-wide fold guard and 250,000-ref cap remain; sorted Set
insertion order remains required; `dropped_index`, `seq_roots`, readiness,
metrics, alarms, and the one-sequence-per-alarm contract retain their results.
This is not a migration or retirement, and no code is approved for deletion
beyond replacing `diffChunk` itself.

## Algorithm

Replace restart-based `diffChunk(left, right, after)` with generator
`diff(left, right, after)`. On its first advance, the generator walks `left`
past every SHA `<= after`, then yields each remaining SHA absent from `right` in
Set order. `foldSequence` constructs one iterator when entering each live phase
and repeatedly consumes at most `FOLD_CHUNK` values into the existing SQL
transaction by calling `iterator.next()` directly. It must not break from a
`for...of`, which would close the generator through `IteratorClose`. A phase
transition constructs the added iterator once. A new alarm after a crash
reconstructs the current phase iterator from persisted `lastSha`, paying the
prefix skip once.

Only each bounded SQL chunk is materialized. The fold still retains exactly the
existing previous and current Sets; it adds no ref-sized array, Set, cache,
sidecar, mode, flag, or fallback. The generator and bounded chunk are the
standard language primitives already needed by the operation.

For 20,000 disjoint refs on both sides, the old implementation visits 70,000
left entries per phase: 5k + 10k + 15k + 20k for result chunks, then 20k for
the terminal empty chunk. That is 140,000 visits across both phases. The live
iterators visit 40,000 total, at most `2 * N`, across eight result chunks plus
the two terminal reads.

## Requirements and ownership

The deterministic key-ordering requirement costs a sort while loading each
refset, but durable `lastSha` crash recovery depends on it; retain it at the
existing “Sorted insertion order is load-bearing” comment. Chunked synchronous
transactions bound mutations and provide atomic cursor recovery; retain them.
No incidental requirement is challenged or needs a product decision in this
performance-only slice.

## Gates

- A 20,000-ref counting-iteration test crosses at least four chunks per phase
  and observes no more than 40,000 Set visits.
- A test-local copy of legacy `diffChunk` drives a reference fold, never
  production code. Compare exact `dropped_index` and `seq_roots` contents for
  disjoint sets, sparse overlap, equal sets, empty previous, and empty current.
- Use inputs spanning multiple removed and added chunks. Inject a transaction
  crash after each data transaction in turn, then resume using a fresh
  `WorkspaceSync` and alarm until complete. Compare every final row with the
  uninterrupted result; duplicates remain impossible through the existing
  upsert/delete operations.
- Keep the sorted-insertion-order regression and its load-bearing comment.
- Run `bun run test:api`, `bun run typecheck`, and `bun run lint:affected` with
  no new warnings. Run `bun run rig` as the repository integration gate. The
  API suite exercises the real Durable Object storage stub, including
  transaction rollback and alarm recovery.

Compatibility is direct because no command, protocol, persisted format, or
storage schema changes. Crash validation covers the only physical-effect
boundary. The visit-count gate is the performance differential; result cases
are the behavioral differential.

## Rollback

Revert the commit. The cursor format is identical, so either implementation
resumes a cursor persisted by the other without migration or operator action.
