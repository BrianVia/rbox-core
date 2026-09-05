# 306 — Carried repos reuse the classify-stage repository context

Status: implementation pending desktop measurement.

## Owner and change

The `plan.ts` capture stage owns the post-capture packed-refs baseline and
branch-absence authorization pass. A trusted fingerprint-hit carry already
contains the fresh `diskCtx` resolved by classification. The capture stage now
reuses that exact context. Captured repositories and non-hit carries still
resolve a fresh context because capture or a slow/deferred path may have moved
repository state. The state snapshot's repository records are likewise folded
once before the pass instead of once per repository.

The older pre-classification memo is still cleared before capture. It is not the
authority for this optimization; the fingerprint result is. Finalization and
hygiene therefore continue to observe fresh disk state.

## Equivalence and protected semantics

For a fingerprint-hit carry, the trusted fingerprint covers the repository
metadata that supplied `diskCtx`, so re-reading the unchanged `.git` layout in
the post-capture pass adds no authority. A `.git` pointer changed before
classification makes the fingerprint miss; a test-only mutation after the
decision is outside the carried contract. Captured repositories and carried
pending/recovery/busy/slow paths do not rely on that equivalence and retain their
fresh context read.

The optimization does not skip `observePackedRefsIdentity`: its live `fs.stat`
still advances present/absent baselines, preserves unreadable handling, and feeds
`packedRefsMtimeRegressed`. The fingerprint token is content-based while this
guard is mtime-based, so the stat is intentionally independent. Captured-repo
absence witnesses, refusal fallback, pending carry, misses, untrusted probes,
and legacy planning remain unchanged.

## Validation and rollback

A real-repository differential test compares legacy and reused-context plan JSON
with timings removed, verifies that fingerprint-carried repos need no fresh
post-capture context read or capture-stage `rev-parse`, and verifies that a moved
packed-refs mtime advances the plan baseline. In this checkout
`repoCtxFromDisk` is already filesystem-only; the explicit context-read seam is
the non-vacuous regression oracle. Existing capture and held/absence suites
protect captured and non-hit behavior. Typecheck and affected lint remain
required.

Rollback is a direct revert: restore the fresh context read for every repo.
Before/after desktop `carried=` timings remain to be recorded on the measured
125-repository workspace.
