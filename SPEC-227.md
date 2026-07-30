# Implementation dispatch: design 227 — Phase 2 GC unwedge

The authoritative spec is `docs/design/227-phase2-gc-unwedge.md` (status ALIGNED
after 3 review rounds; provenance in `docs/design/notes/227/REVIEW-LOG.md`).
Implement it exactly. This file only adds dispatch mechanics: scope, traps,
acceptance. Where this file and the design disagree, the design wins.

## Scope

- `apps/api/src/**` and `apps/api/test/**` only, plus:
  - `apps/api/wrangler.jsonc` — set `RBOX_GC_PURGE_DISABLED: "1"` in BOTH the
    top-level vars and the production env vars (§4.1: the purge is currently
    armed and only the stale budget keeps it inert; raising the budget without
    flipping the flag arms deletion on the next 09 UTC tick).
  - `.agents/skills/account-cleanup/SKILL.md` line 42 — update the purge-order
    sentence to match the §2.3 reorder (DO purge before refs drop).
- NO new D1 migration (the design needs none — verified in review).
- Do NOT touch `src/cli/**`, `docs/design/**`, `apps/api/migrations/**`, or
  the tracked `SPEC.md` (it belongs to a previous cycle).

## The five pieces (§2 of the design)

1. **Budget raise + single owner.** `GC_BUDGET_SAFE` 800 → 8000 in
   `gc-policy.ts`; consolidate the three divergent maxW expressions
   (`gc-purge.ts:223`, `gc-mark.ts:21`, `gc-audit.ts:16` — gc-mark subtracts a
   bare 3 today) into ONE exported helper. §2.1's arithmetic: maxW becomes 88.
2. **D1-transaction-evaluated time guards** (§2.2 — the core; these are
   fail-closed safety seams, read §2.2's principle statement first):
   a. `openIntents` stamps `deleting_at` with the D1-evaluated ms expression
      (same `julianday` form as `fairuse.ts:215`), not JS `nowMs`.
   b. Receipt expiry carried into the publishing super-batch with a D1-time
      WHERE guard (`commit-accounting.ts` — the batch that commits at `:266`);
      rejection routes through the existing `needsUpload` path.
   c. Legacy single PUT + multipart: blobs insert + entitlement grant in one
      transaction carrying a `preReadTime + RECEIPT_TTL_MS` deadline anchored
      at the new pre-write fence read.
   d. Mint rejects (503, no receipt) when the post-write read is later than
      `preReadTime + RECEIPT_TTL_MS`. Reuse `RECEIPT_TTL_MS`; ZERO new
      constants anywhere in this change.
3. **account-delete reorder** (§2.3): purge workspace DOs and delete
   `workspaces` rows BEFORE dropping `blob_refs`/condemning. The tombstone at
   `account-delete.ts:203-211` already precedes both blocks.
4. **gc-health deletions** (§2.5): delete `GC_WARN_WORKSPACE_ROWS`,
   `GC_MAX_WORKSPACE_ROWS`, the `rows >=` warn disjunct (`:39`), and the
   `GcHealthV1.maxRows` field (type `:14`, population `:46`, log echo `:67`).
   **TRAP:** there are TWO different `maxRows` — `gc-purge.ts:248` /
   `gc-mark.ts:38` emit `maxRows: maxW` in the GC *observation* rows; those
   STAY (and will now read 88). Only the health-surface field dies. The
   health `warn` becomes the §2.4 orphan-ref integrity count, recorded by
   `gcPurge` beside `rows`/`purged`/`opened` (never a per-health-call scan).
5. **Tests** — all 12 in §3, in `apps/api/test/`. The seam for the four
   D1-time tests (5–8): the JS clock is controllable in tests while D1's
   `julianday('now')` is not — that asymmetry IS the property under test.
   Test 12's fixture inserts `blob_refs` without `blobs` (legal: no FK).

## Acceptance (all must pass; run them yourself and paste real output)

```
export PATH="/home/via/n/bin:$PATH"   # host default node is broken
rm -rf .cache/tsbuildinfo && bun run typecheck
bun run test:api
```

Zero failures. All 12 §3 tests present and green. `grep -rn "GC_BUDGET_SAFE"
apps/api/src` shows exactly one definition. `grep -n "RBOX_GC_PURGE_DISABLED"
apps/api/wrangler.jsonc` shows `"1"` in both var blocks.

## Do-not-relitigate (from the settled list; violations will be reverted)

- No kind filter on `openIntents` (strands unopened canonical rows).
- No new time/duration constants.
- Time comparisons guarding deletion are D1-evaluated, never JS-side.
- Every reachability belt and the per-key head() verify STAY.
