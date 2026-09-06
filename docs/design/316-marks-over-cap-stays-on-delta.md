# 316 — An over-cap mark probe stays on the delta admission path (design 102 Q3, as decided)

Status: DECISION PENDING (founder) after review round 1 (`notes/316/review1-gpt.md`), 2026-09-06. Owner: `apps/api/src/commit-delta.ts` (`shouldUseDeltaAdmission`)
+ `apps/api/src/workspace-sync.ts` (the enforce branch). Parent: design 102 (§3.5A.4, §7.1 Q3).

## Problem, measured (prod, 2026-09-06 11:00–14:00Z, `commit.delta` analytics)

| metric | value |
|---|---|
| commits | 36 |
| `admitAccountMs` | avg 3,868 ms, p95 6,654 ms |
| D1 batch calls in admission | ~22 per commit |
| `fallback` reason | `marks_over_cap` on every delta-eligible commit (22/22) |
| `marks_over_cap` observed | 50,001 (= `FENCE_SET_MAX + 1`) |
| refs actually added per commit (`sizes`) | avg 1.6, p95 5 |

`blob_ref_candidates` for the founder account holds **224,096** rows (read-only D1 count),
growing ~39K/day since 08-31 (Phase-1 mark runs capped at 2,000 rows/hour; purge lags).
Every push on every device of that account therefore pays a full ~200K-ref admission
(4–7 s server time, `commit … srv4.0 acct3.4` on the client) to add one or two blobs.

## What design 102 already decided

§7.1 **Q3 decision (prod-soak evidence)**: "Keep `FENCE_SET_MAX` for the safety-critical
active-intent probe: over-cap still falls back. An over-cap `blob_ref_candidates` probe
instead skips the optional carried-ref regrant; this is benign marker divergence, never a
full fallback. The delta path therefore runs independently of mark-table size." §8 item 3
repeats it: "Mark-probe over-cap skips regrant and stays on the delta path; the missed
marker clear is benign because Phase-1 resurrects a head-reachable ref."

The code does the opposite. `loadFenceProbe` correctly returns `markedSet = ∅,
markedProbeSkipped = true` (memory stays bounded), and `mergeAddedShas` correctly yields
`markedCarried = []` — but `shouldUseDeltaAdmission` requires `!delta.markedProbeSkipped`,
and the enforce branch emits `fallback marks_over_cap`. So the one condition the decision
said must never cause a full fallback is exactly the one that does, and it is the steady
state of any account whose mark table exceeds 50K (a 200K-ref workspace after a purge).

## Review round 1 correction: the fallback is deliberate, not drift

GPT found (and `git log 1cf847d7f` confirms) that commit "fix: design 102 — fence probe
scaling (soak unblock)" implemented Q3 for SHADOW mode only and kept, on purpose, "ENFORCE
safety: when the marked probe is skipped, enforce falls back to full child validation (never
silently unfenced)". Design 204 §3.1 then made that fallback a hard precondition of the
enforce flip and pinned it (`commit-delta-shadow.test.ts:207`). So the current behaviour is
a product decision: with the mark probe skipped, a prune-marked CARRIED ref cannot be folded
into `admitData` for a presence+entitlement re-check, and the full-refset validation is the
only remaining detector of that loss class (a carried ref whose `blob_refs` row Phase-1
purge dropped). The 4–7 s per commit is the price of that detector on any account whose
mark table exceeds 50K.

What the detector defends against: a carried ref that GC purged although a head still
referenced it. Purge only drops refs absent from the DO-roots reachable set, recomputed per
tick (`runPhase1`), with `marked_at` ≥ 24 h grace and an EXISTS-still-marked guard; a
carried ref is in the parent head, so it is reachable in any snapshot younger than the
parent commit. The unguarded case is therefore a GC bug (stale or truncated reachability),
not a protocol race — which is exactly the class a defense-in-depth detector exists for.

## Decision for the founder (two options)

- **A. Keep the detector (status quo).** Every push on every device pays ~4 s server
  accounting while this account's marks stay > 50K. Marks are 224K and growing ~39K/day;
  purge throughput is unknown (the phase-1 outcome logs need Workers Observability access
  the current token lacks). Nothing to ship.
- **B. Implement Q3 in enforce (this design's Rule).** ~4 s saved per push, every device,
  immediately on promotion. Cost: the loss detector for prune-marked carried refs is
  inactive while marks > 50K; correctness then rests on Phase-1's reachability + grace
  invariants alone (today's argument above). Ships with the tests below plus a stale-
  snapshot/publish/purge interleaving test that bounds snapshot age below grace.

Recommendation: **B**, with one rider — a cheap per-commit metric that counts marks so
we see when the table drops back under the cap, and a follow-up on purge throughput.

## Rule

`shouldUseDeltaAdmission(deltaMode, delta, fallback)` = `deltaMode === "enforce" && !!delta
&& !fallback`. `markedProbeSkipped` no longer vetoes the delta path; it only means
`markedCarried` is empty (no regrant of carried marked refs this commit). The enforce branch
keeps emitting a metric for the condition, renamed from `fallback/marks_over_cap` to
`marks_over_cap` (already emitted by `computeCommitDelta` with the observed count), so the
`fallback` series again means what §7 gate 8 measures.

Safety argument, unchanged from 102: the active-intent probe (`gc_candidates … deleting_at
IS NOT NULL`) is the fence that protects against a concurrent purge, and its over-cap still
falls back (`fence_over_cap`). A carried ref that is merely MARKED is not being deleted;
if it is head-reachable, Phase-1 purge resurrects it (deletes the mark) on its next pass;
if it is not head-reachable, the child does not carry it. Skipping the regrant therefore
loses nothing but an early mark clear. Shadow mode's `classifyShadow` already treats a
skipped probe's marker divergence as benign (`commit-delta.test.ts`).

## Tests (`apps/api/test/commit-delta.test.ts`, `workspace-sync` route tests if present)

- `shouldUseDeltaAdmission("enforce", { …, markedProbeSkipped: true }, undefined)` → true
  (flip the existing pin at ~line 74); `fallback` set → false; `shadow` → false.
- enforce route with an over-cap mark table: admission validates `carriers + chain +
  delta.added` only (assert the shas passed to `validateCommitRefs`), no `fallback` metric
  is emitted, `marks_over_cap` metric is.
- `fence_over_cap` (intent probe over cap) still falls back to full admission.

## Rollout

Merge → DEV Workers Builds deploys automatically; verify on `rbox-dev-api` (a dev account
with >50K marks can be manufactured by inserting rows into `blob_ref_candidates` on the dev
D1, or by lowering nothing — the unit tests cover the decision). Production only by the
founder's explicit promotion. Expected on prod: `admitAccountMs` from ~4 s to the
delta-path cost (validate ≤ a handful of refs: ~100–300 ms), on every device.

## Not in scope

- Why marks reach 224K and whether Phase-1 purge keeps up (separate GC observation;
  `gc_candidates` holds 511K non-deleting rows, oldest 2026-07-17). Delta admission must
  not depend on it — that is the point of Q3.
- `FENCE_SET_MAX` itself (unchanged, 50K; memory bound stays `FENCE_SET_MAX + 1`).
