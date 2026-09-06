# 317 — Git artifact flush uses the shared bounded pool (F6a)

Status: proposed (2026-09-06). Owner: `src/cli/sync-git/plan-artifacts.ts` (`flushGitArtifacts`).
Roadmap: F6 (bounded transfer parallelism), first slice. Primitive: `engine/pool.ts` `poolMap`,
already the shape behind blob upload (push) and download (pull).

## Problem, measured

On every changed push the git-plan attribution shows `fn≈2850–3200` (finalize) for a single
captured repository (`Personal/rbox-core`, `cp≈1000`), e.g. `ms[t5504 … cp1002 … fn2850]`
on the 2026-09-06 14:13 push. Finalize is `artifacts.flush(captured)`: the pending git
artifacts of every captured repo — one bundle, one staged index, one op-state artifact per
linked worktree (`capture.ts` `artifact(...)`) — uploaded ONE AT A TIME
(`flushGitArtifacts`: `for … await flushGitArtifact`), each a `store.has` round trip plus a
`putFile`. Pending-supersession and resolution candidates are empty on the desktop (probed:
0 pending repos), so finalize is the sequential upload latency and nothing else.

## Rule

`flushGitArtifacts(store, pending, flushed)`:
1. dedupe `pending` by `encSha` and drop the already-`flushed` ones BEFORE launching;
2. `await poolMap(owed, GIT_ARTIFACT_FLUSH_CONCURRENCY /* 4 */, async (artifact) => {
   await flushGitArtifact(store, artifact); flushed.add(artifact.encSha); })`.

Failure semantics (review round 1, `notes/317/review1-gpt.md`): the first failure is
LATCHED (a flag, so a thrown `undefined` still fails the barrier), artifacts not yet started
are skipped, and the in-flight siblings DRAIN before `flushGitArtifacts` rejects — because
`planGitSections` disposes the retained ciphertext directory on rejection, and a detached
upload still reading it would race that sweep (the shape `poolMap`'s doc prescribes for
callers that must drain). Nothing is resumed from retention on the next push: the sweep
deletes the ciphertext, the next push recaptures, and the server's content-addressed
`has` check makes any artifact that did land a no-op. Uploads are idempotent; per-artifact
retry budget and the design-226 fail-closed rule are unchanged (tests assert them per
artifact now). Nothing downstream reads an artifact before the commit that references it,
and the commit runs after this `await`.

Bound (review round 2, `notes/317/review2-gpt.md`): the blob store routes a large
artifact through the pack lane, which waits a fill window (`PACK_FILL_QUIET_MS` 200 ms /
`PACK_FILL_ABSOLUTE_MS` 1000 ms) before sending; a sequential flush therefore paid that
window ONCE PER ARTIFACT — which is what `fn≈2.9s` for three-ish artifacts is. The bound
is `PACK_MIN_ACTIVATION_COUNT` (16) from `src/engine/blob-pack.ts` (one owner): all of a
typical capture's artifacts (one bundle, one index, one per op-state file per worktree —
potentially many, not "≤ 6") enqueue inside one fill window, and a capture with that many
artifacts also qualifies for a pack instead of the single-PUT fallback. Not a measured
knee; the field measurement is `fn` before/after on the desktop, and a 1/2/4/8/16 sweep is
the follow-up if `fn` stays above one fill window plus one PUT.

## Tests (`plan-artifacts.test.ts`, new)

- with a fake store whose `putFile` resolves after a short delay, 4 pending artifacts flush
  with ≥ 2 in flight at once and every `encSha` ends up in `flushed`;
- the same `encSha` listed twice (two repos sharing an artifact) is put once;
- an artifact already in `flushed` is skipped; a `store.has` true skips the put;
- a failing put rejects `flushGitArtifacts` and leaves that `encSha` out of `flushed`.

## Expected result

Desktop changed push: `fn≈2.9s` → roughly one artifact's latency (~0.7–1.0s). Every device
that captures git repos benefits.
