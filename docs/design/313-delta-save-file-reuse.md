# 313 — A delta-carrying save reuses the composer's file array instead of re-reading 198K rows

Status: approved for implementation v3+ (2026-09-06; rounds 1–3 in `notes/313/`; cap reached). Owner: `state-plane/adapters/state-memo.ts` (the reuse rule);
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
4. `applyDeltaOps(retained.state.lastSyncedManifest.files, sealed.ops)` succeeds, where `sealed`
   is the DETACHED delta described below. A refusal (delete of an absent path, non-ascending
   ops) returns `undefined` → the existing paging path.

### The detached delta (review round 2, findings 1–2)

`StateSavePacket` is mutable and the caller keeps a reference, so neither staging nor the
memo may read `packet.globalDelta` twice. In `applyStateSavePacket`, BEFORE the CAS, the
adapter builds ONE private value, `sealed = detachGlobalDelta(packet.globalDelta)`: a fresh
`{ binding: {...}, ops: [...] }` whose every upsert entry is `normalizeFileEntry(entry)`.
The store is given `{ ...packet, globalDelta: sealed }` (staging reads `sealed.ops`
synchronously, `sqlite-state-save.ts`), and `memoizedDeltaFiles` is given the same `sealed`.
A caller mutation after that point changes nothing either side sees.

`normalizeFileEntry` (new export of `codecs/file-entry.ts`, the one owner of "what the file
cursor returns") reproduces staging exactly: `fileEntryFromCanonical(encodeFileEntryForConsume
(entry).canonical)` — the sealed canonical text, which is what the store interns (so
`mtimeMs: -0` becomes `0`, key order and absent members canonicalize) — then re-encoded to a
`FileEntryRow` and passed through `decodeFileEntry`. The oracle in tests is an actual store
cursor over a staged row, never the codec's own output. Because canonicalization is
idempotent, staging `sealed` seals the same canonical bytes and logical digest as staging
the caller's ops would have.

Why this equals the store's read-back: (2)+(3) prove the retained rows are the rows the CAS
applied the delta to (design 302's argument, same known edge: a manual backup restore to the
same lineage and generation with different rows); `applyDeltaOps` is the documented twin of
`applyDeltaOpsIntoPlane` (only named paths move, delete-absent refuses, exact result count),
and both consume the same `sealed` value. Nothing about the caller's
`packet.global.manifest.files` or the caller's `globalDelta` object is used after detachment.

Adapter change (`whole-state-compat.ts`): for an accepted packet,
`reuse = packet.global === undefined ? memoizedBaseFiles(root, token)
       : sealed !== undefined ? memoizedDeltaFiles(root, sealed, token) : undefined`.
`loadRawState` still never reuses. Full-global (non-delta) saves still page.

Expectation-carrying deltas do not exist: `composeStateSavePacket` sets `packet.global`
only when `proven === undefined` and `elisionExpectation` only when `proven !== undefined`
(`sync-state.ts`), so a delta is never paired with an expectation. Pinned by a test rather
than handled by a branch.

## Non-goals

- Full-global (non-delta) saves: keep paging (first save, order repair, reset lineage).
- Seeding design 303's audit-hash memo from the push's integrity hash (~0.85s first audit
  after each real change). Candidate 313b; separate slice.
- Repo transitions (0.3s for 258 records) — unchanged.

## Tests (`state-memo.test.ts`, following its helpers; plus one codec test)

- delta save after a retained load: file cursor never paged (spy `loadRawStateFromStore`'s
  `reuse` argument is the memo's derived array), returned state `toEqual` a fresh
  `loadRawState`, AND the next `loadState` is free and equal.
- normalization: upserts carrying `mtimeMs: -0`, extras, a symlink, a compressed entry and
  non-canonical key order — reused state equals `loadRawState` exactly (durable rows are the
  oracle), and `normalizeFileEntry(entry)` equals the store cursor's row for the same staged
  entry (codec test, cursor as oracle).
- no retained predecessor (memo empty / foreign revision bump between load and save /
  nonce mismatch): reuse `undefined`, pages, equal.
- direct memo test: after a retained load, call `memoizedDeltaFiles` with a sealed delta whose
  delete names a path the retained rows do not hold → `undefined` (the memo itself refuses,
  independent of the store's own StageChangedError refusal, which is tested separately).
- detachment: the caller mutates `packet.globalDelta.ops` (push an upsert) right after
  `applyStateSavePacket` is called but before it resolves → the accepted state equals a fresh
  `loadRawState` (both staging and the memo consumed the sealed copy).
- exclusivity pin: a receipt-carrying source with a differing global composes NO
  `elisionExpectation`; a delta packet never carries one.
- CAS retry/recompute: the retried packet carries a NEW binding from the reloaded snapshot;
  the first attempt's stale binding never matches (3).
- full-global (non-ascending input → no delta) pages; kill switch pages.
- existing corrupted-row drift audit (`save-delta.test.ts`) unchanged and green.

## Expected result

Copied store: apply for the real push shape 2.8s → ~0.4s (records only). Desktop
`state-save slow:` lines for delta pushes drop below the 500ms slow threshold.

## Review round 3 disposition (cap reached; Claude's call)

Accepted as changes:
- (3) the guard also requires equal `authorityId` (it is already in the token).
- (1) `plane-promotion.ts` interning `EXACT_MATCH` also compares `canonical_bytes` and
  `retained_estimate`, so a corrupted pre-existing intern row is never selected for a new
  upsert (a strict improvement, independent of reuse); tested with a corrupted candidate.

Recorded, not changed — the same trust boundary design 302 shipped with:
- (2) a memo entry retained from a fully-elided `acceptedProjection` is the caller's LOADED
  state plus the accepted token, which design 267/302 already define as the durable state and
  design 302 already reuses rows from. 313 adds no new trust.
- (4) hand-built delta+expectation packets: the memo rule never reads `elisionExpectation`;
  the CAS decides it. The composer's exclusivity is pinned only as documentation.
- (5) same-lineage, same-generation backup restore with different rows is the known 277/302
  edge; 313 does not widen it (the next full-global save or `loadRawState` re-reads). Kill
  switch `RBOX_STATE_LOAD_CACHE=0` remains the operator escape.
