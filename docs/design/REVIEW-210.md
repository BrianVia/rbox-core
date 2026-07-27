# Review 210 — JSON-backed packed placements

## Round 1

Two independent read-only reviews inspected the implementation, schema, prior
art, test harness, and this design.

### Findings

1. **MAJOR — placement aggregation scope.** A 2,000-row chunk inside the
   existing 33-ref loop would still emit about 152 statements for 5,000 refs,
   not 3. **Adopted:** aggregate packed refs per `MAX_REFS_PER_TXN`
   super-batch and append 2,000-row placement statements once per transaction.
2. **MAJOR — one JSON bind.** Binding `nowMs` separately does not meet the
   strictest reading of “bind ONE JSON parameter.” **Adopted:** interpolate
   trusted integer `nowMs` as a server-owned SQL literal, as the existing
   `blob_refs` statement does, and bind only the placement-row JSON.
3. **MAJOR — SQLite UPSERT parsing.** `INSERT ... SELECT ... FROM json_each(?)
   ON CONFLICT` is ambiguous in SQLite. **Adopted:** insert `WHERE true` before
   `ON CONFLICT`.
4. **MINOR — statement budget.** The exported per-chunk multiplier and its
   receipt-flow test describe the obsolete 13-row placement expansion.
   **Adopted:** model six per-accounting-chunk statements in the mixed case
   plus at most two placement statements per 3,000-ref transaction; expected
   worst case 548.
5. **RISK — statement ordering.** Aggregating placements moves them after
   canonical deletes. Public commit and redemption inputs are unique by SHA,
   so packed and canonical forms cannot overlap; add the required distinct-SHA
   mixed test to guard normal behavior.
6. **TEST FEASIBILITY.** Seed two ready pack inventories directly for 2,050
   SHAs, call `commitAccounting`, and query first/middle/last. The second pack
   supplies different valid offsets and pack metadata for the UPSERT proof.
   Spot checks also cover `storage` and a newer `installed_at`.

### Disposition

Revised. Both reviewers' required design corrections are adopted; round 1 is
**ALIGNED**. Proceed to implementation and executable round 2.

## Round 2

Two reviewers inspected the implemented diff and ran focused tests:

```text
bun run test:api -- --configLoader runner \
  test/blob-pack-redeem.test.ts test/receipts-flow.test.ts
```

Result: **2 files passed, 38 tests passed**.

One reviewer returned ALIGNED on the SQL, batching, transaction, budget, and
test coverage. The second found a semantic blocker despite green tests:

1. Destination pack P currently contains canonicalizing Y; packed X currently
   lives in Q and moves into P in the same mixed commit.
2. Appending aggregated placements after canonical deletes removes Y first.
   The last-location trigger marks P as a GC candidate.
3. Installing X into P does not clear that candidate, so the live destination
   pack is falsely fenced.

The reviewer reproduced this with migration-equivalent SQLite triggers:
old ordering produced candidate `[Q]`; the first implementation produced
`[P,Q]`.

**Adopted:** keep the canonical DELETE SQL and binds unchanged, but collect
those statements separately. Append all 2,000-row packed placement statements
first, then append the canonical deletes. Strengthen the mixed test to use the
P/Q direction above and assert P has no `pack_gc_candidates` row.

Round 2 verdict: **NOT ALIGNED**. Proceed to the final round 3 after the
ordering fix.

## Round 3

Both reviewers inspected the ordering fix. Each independently returned
**ALIGNED**; no round 4 is scheduled.

Executable evidence:

```text
Test Files  2 passed (2)
Tests       38 passed (38)
```

The final review confirmed that placements run before the unchanged canonical
deletes, all packs empty in the final state still receive candidates, the
false destination-pack candidate is prevented, and every blocker-1 batching,
typing, conflict, atomicity, and test requirement remains satisfied.

Final validation after the ordering fix:

```text
bun run test:api -- --configLoader runner
Test Files  52 passed (52)
Tests       849 passed | 4 skipped (853)

bun run typecheck
exit 0

git diff --check
exit 0
```
