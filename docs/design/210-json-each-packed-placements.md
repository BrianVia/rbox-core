# Design 210 — JSON-backed packed-placement inserts

**Status:** APPROVED
**Issue:** #504 blocker 1

## Problem

`commitAccounting` currently expands packed `blob_locations` rows into
six-bound-parameter `VALUES` tuples and chunks them at 13 rows. A 5,000-ref
packed commit therefore adds about 385 D1 statements. The 2026-07-27 canary
measured receipt redemption at `redeem7103` versus `redeem3701` without this
overhead.

## Scope and invariants

Only packed-placement statement construction changes.

- The existing per-33-ref `blobs`, account charge, `blob_refs`,
  `gc_candidates`, and `blob_ref_candidates` statements are byte-for-byte
  unchanged.
- The canonical `DELETE FROM blob_locations` remains per accounting chunk and
  unchanged.
- Placement installation remains in the same `db.batch()` transaction and
  therefore keeps the existing cap/delete-fence failure unit.
- Packed placement statements run before the unchanged canonical deletes. This
  preserves the prior *same-chunk* trigger ordering and **fixes** the prior
  *cross-chunk* ordering. Previously the placement inserts were emitted inside
  the per-33-ref loop, so a canonical `DELETE` in chunk 0 that emptied pack A
  ran BEFORE a chunk-1 placement insert that refilled it. That fired
  `blob_locations_delete_pack_candidate` and left a spurious
  `pack_gc_candidates` row for a pack that is still live. The row is not a
  data-loss risk — `pack-gc.ts` unmarks candidates that regained locations and
  re-checks emptiness before setting `deleting_at` — but until it is unmarked,
  `fenceRead` in `blob-pack.ts` rejects every read/PUT of that pack, because it
  treats any `pack_gc_candidates` row as a fence. Grouping all placement
  inserts ahead of all canonical deletes closes that window.
- The `blob_locations` column order and conflict behavior stay:
  `sha256`, `storage='pack'`, `pack_id`, `offset`, `length`, `pack_sha256`,
  `installed_at=nowMs`; conflict updates every existing mutable placement
  field except `storage`, exactly as today.
- No request, response, receipt, or other wire shape changes.

## Change

For each `MAX_REFS_PER_TXN` super-batch, collect all refs with a pack
placement. After constructing the unchanged per-33-ref accounting statements,
chunk those packed refs at 2,000 and append one placement statement per chunk:

```sql
INSERT INTO blob_locations
  (sha256, storage, pack_id, offset, length, pack_sha256, installed_at)
SELECT
  j.value->>'$.sha256',
  'pack',
  j.value->>'$.pack_id',
  CAST(j.value->>'$.offset' AS INTEGER),
  CAST(j.value->>'$.length' AS INTEGER),
  j.value->>'$.pack_sha256',
  ${nowMs}
FROM json_each(?) AS j
WHERE true
ON CONFLICT(sha256) DO UPDATE SET
  pack_id=excluded.pack_id,
  offset=excluded.offset,
  length=excluded.length,
  pack_sha256=excluded.pack_sha256,
  installed_at=excluded.installed_at
```

The serialized objects contain `sha256`, `pack_id`, `offset`, `length`, and
`pack_sha256`, so the statement binds exactly one parameter:
`JSON.stringify(rows)`. The trusted integer `nowMs` is interpolated as the
server-owned SQL literal, matching the existing `blob_refs.granted_at`
construction without repeating it in every JSON object. Explicit casts
preserve integer `offset` and `length`; `nowMs` is already an integer.
`WHERE true` avoids SQLite's documented parsing ambiguity between a `SELECT`
join clause and the UPSERT `ON CONFLICT`. Each JSON value remains far below
D1's bound-value limit: 2,000 rows of two 64-hex SHAs, a 32-hex pack id, a
10-digit offset and an 8-digit length measure **484,001 bytes**, roughly 4x
under D1's documented 2,000,000-byte string limit (and ~2x under 1 MiB). The
chunk cannot grow past 2,000 rows: `packed` is bounded by `MAX_REFS_PER_TXN`
and then re-chunked at `PACKED_PLACEMENT_CHUNK` regardless of commit size.

At 5,000 packed refs, the two existing super-batches contain 3,000 and 2,000
refs, producing two plus one placement statements: 385 → 3.

## Tests

Extend `apps/api/test/blob-pack-redeem.test.ts`:

1. Seed ready pack inventory for 2,050 unique refs without exercising the pack
   upload member cap. Call `commitAccounting` directly and assert exactly 2,050
   `blob_locations` rows. Directly query the first, middle, and last SHA and
   compare `pack_id`, numeric `offset`, numeric `length`, and `pack_sha256`.
2. Seed a second ready inventory for the same SHAs, re-commit placements, assert
   the row count remains 2,050, and verify the spot checks changed to the
   second pack. Also assert `storage='pack'` and the deliberately newer
   `installed_at`. This proves the conflict path updates rather than duplicates
   while covering every placement column's semantics.
3. In a mixed packed/canonical commit, preinstall locations for both SHAs,
   commit one packed and one canonical ref, and assert the packed location is
   updated while the canonical SHA's row is deleted.
4. Cross-chunk ordering regression: place a pack's only member, then commit that
   SHA as canonical alongside 32 canonical fillers (filling chunk 0) plus a
   second placement into the SAME pack (chunk 1). Assert no `pack_gc_candidates`
   row survives. This test is RED against the pre-210 implementation — test 3
   alone is not, because both its refs share one 33-ref chunk.

Run the focused test file during review, then `bun run test:api` and
`bun run typecheck`.

## Risks

- Moving placement construction outside the per-33-ref loop changes statement
  order only for packed inserts. Queue the unchanged canonical deletes
  separately and append them after all placement inserts. Inputs reaching
  accounting are unique by SHA; there is no packed/canonical overlap.
- The existing static statement-budget test must describe the new accounting
  bound rather than the obsolete “four placement statements per 33 refs”
  model: at 3,000 refs the worst mixed transaction is
  `ceil(3000/33) * 6 + ceil(3000/2000) = 548` statements.
