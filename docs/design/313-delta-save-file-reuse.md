# 313 — A delta-carrying save reuses the composer's file array instead of re-reading 198K rows

Status: proposed v2 (2026-09-06). Owner: `state-plane/adapters/state-memo.ts` (the reuse rule);
`whole-state-compat.ts` only routes. Parent: design 302 (global-free reuse), design 277 (memo), 269 (delta).

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

## Rule (v2, after review round 1 — `notes/313/review1-gpt.md`)

Owner: `state-memo.ts`, the design-277/302 memo layer — the ONE skip rule keyed by store
truth. The adapter never trusts the caller's array (`cas-translation.ts` and `read-only.ts`
keep their "never a caller's claim" contracts intact).

New memo operation, `memoizedDeltaFiles(root, delta, postToken)`, returns
`{ baseFiles }` only when ALL of:

1. the memo is enabled (`RBOX_STATE_LOAD_CACHE=0` disables it, same kill switch as 277/302);
2. the retained entry's token has the same `lineageId` and `stream` as the post-CAS token and
   `retained.baseGeneration + 1 === postToken.baseGeneration` (exactly one global landed: this
   one);
3. the retained state IS the delta's predecessor: `retained.state.stateNonce ===
   delta.binding.nonce && retained.state.stateRevision === delta.binding.stateRevision` (the
   binding the composer stamped from the snapshot it diffed against, and the same predicate
   the CAS checked);
4. `applyDeltaOps(retained.state.lastSyncedManifest.files, ops')` succeeds, where `ops'` are the
   delta's ops with every upsert entry passed through the store's own codec round-trip
   (`normalizeFileEntry` = `decodeFileEntry(rowOf(encodeFileEntryForConsume(entry)))`, a new
   export of `codecs/file-entry.ts` so normalization has one owner). A refusal
   (delete of an absent path, non-ascending ops) returns `undefined` → the existing paging path.

Why this equals the store's read-back: (2)+(3) prove the retained rows are the rows the CAS
applied the delta to (design 302's argument, same known edge: a manual backup restore to the
same lineage and generation with different rows); `applyDeltaOps` is the documented twin of
`applyDeltaOpsIntoPlane` (only named paths move, delete-absent refuses, exact result count);
(4) makes every upserted entry byte-for-byte what the file cursor decodes (the store interns
`admitted.canonical`, so `mtimeMs: -0`, key order and absent-vs-undefined members normalize
the same way). Nothing about the caller's `packet.global.manifest.files` is used.

Adapter change (`whole-state-compat.ts`, one expression): for an accepted packet,
`reuse = packet.global === undefined ? memoizedBaseFiles(root, token)
       : packet.globalDelta !== undefined ? memoizedDeltaFiles(root, packet.globalDelta, token)
       : undefined`. The ops are normalized before the CAS begins (same packet the store
stages from; the packet is the composer's frozen value, and the store itself reads it once).
`loadRawState` still never reuses. Full-global (non-delta) saves still page.

## Non-goals

- Full-global (non-delta) saves: keep paging (first save, order repair, reset lineage).
- Seeding design 303's audit-hash memo from the push's integrity hash (~0.85s first audit
  after each real change). Candidate 313b; separate slice.
- Repo transitions (0.3s for 258 records) — unchanged.

## Tests (`state-memo.test.ts`, following its helpers; plus one codec test)

- delta save after a retained load: file cursor never paged (spy `loadRawStateFromStore`'s
  `reuse` argument is the memo's derived array), returned state `toEqual` a fresh
  `loadRawState`, AND the next `loadState` is free and equal.
- normalization: upserts carrying `mtimeMs: -0`, extras, a symlink, and non-canonical key
  order — reused state equals `loadRawState` exactly (durable rows are the oracle).
- no retained predecessor (memo empty / foreign revision bump between load and save /
  nonce mismatch): reuse `undefined`, pages, equal.
- delta refused by `applyDeltaOps` (retained rows diverged: mutate the store outside the
  adapter so a delete targets an absent path) → pages, equal.
- CAS retry/recompute: the retried packet carries a NEW binding from the reloaded snapshot;
  the first attempt's stale binding never matches (3).
- full-global (non-ascending input → no delta) pages; kill switch pages.
- existing corrupted-row drift audit (`save-delta.test.ts`) unchanged and green.

## Expected result

Copied store: apply for the real push shape 2.8s → ~0.4s (records only). Desktop
`state-save slow:` lines for delta pushes drop below the 500ms slow threshold.
