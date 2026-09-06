# 313 — A delta-carrying save reuses the composer's file array instead of re-reading 198K rows

Status: proposed (2026-09-06). Owner: `state-plane/adapters` (cas-translation.ts +
whole-state-compat.ts). Parent: design 302 (global-free reuse), design 277 (memo), 269 (delta).

## Problem, measured

Every push that carries a real change lands `state-save slow: compose≈60 apply≈2400–3000
repos=258 global=delta ops=1..10` on the desktop (v2.0.2-dev+a9baae0). On the copied
desktop store (198,728 entries, 258 records):

| packet | apply |
|---|---|
| delta only, 1 op, 0 repos | 2382 / 2466 ms |
| 258 repos, no global | 274 / 294 ms |
| both (the real push shape) | 2779 ms |
| `loadRawStateFromStore` alone | 2343 / 2357 ms |

The whole cost is the post-CAS read-back: `translateCasResult` calls
`loadRawStateFromStore(store)` with no `reuse` because design 302 offers the memo's rows
only for a `packet.global === undefined` packet. A 1-file change pays a full 198K-row page.

## Rule

For an ACCEPTED packet that carried `globalDelta`, the adapter offers
`{ baseFiles: packet.global.manifest.files }` as the reuse. Nothing else changes:
records, meta, git projections and every token are still read from the store, and
`finishProjection()` still asserts the token (302's shape, one more admission case).

Why this is store truth and not a caller's claim:

1. `composeGlobalDelta` returns a delta ONLY when both `previous` (the snapshot's rows) and
   `next` (the composer's array) are strictly ascending by `path` (JS string order =
   UTF-16 code-unit order = the store's `path_order` / `utf16beOrderKey`). So the array's
   order IS the store's read-back order.
2. The CAS's `expected.baseGeneration` predicate proves the plane's rows at apply time are
   the snapshot's rows the delta was computed against (design 302's argument).
3. `applyDeltaOpsIntoPlane` moves only the named paths, refuses a delete of an absent path,
   and asserts the final row count equals the sealed `resultFiles`; `applyDeltaOps` in
   `sync-state-delta.ts` is the same semantic and yields exactly `next`.
4. Empirical: on the copied store, after a delta save, `isDeepStrictEqual(loadRawState().
   lastSyncedManifest.files, packet.global.manifest.files)` is true (entries and order);
   the same check with a non-ascending array yields NO delta (full global), which this
   design deliberately does not reuse — a full-global save still pages fresh rows.

Kill switch and deletion condition: identical to 302/277 (`RBOX_STATE_LOAD_CACHE=0`
disables the offer). `loadRawState` still never reuses (drift audit fresh view, pinned).

## Non-goals

- Full-global (non-delta) saves: keep paging. The staged entries would match too, but the
  order proof does not hold and the case is rare (first save, order-repair, reset).
- Seeding design 303's audit-hash memo from the push's integrity hash (would remove the
  ~0.85s first audit after each real change). Candidate 313b; separate slice.
- Repo transitions (0.3s for 258 records) — unchanged.

## Tests (state-memo.test.ts / cas-translation)

- A delta save reads no file rows (spy the file cursor / assert `reuse` received) and the
  returned state deep-equals a fresh `loadRawState`.
- A full-global save (non-ascending input → no delta) still pages fresh rows.
- Kill switch pages.
- Existing corrupted-row drift audit (`save-delta.test.ts`) unchanged and green.

## Expected result

Copied store: apply for the real push shape 2.8s → ~0.4s (records only). Desktop
`state-save slow:` lines for delta pushes drop below the 500ms slow threshold.
