# #823 — per-record elision needs an observation seq

*Design note, 2026-09-01. Evidence read on main @ `d8d2658e9`. No code changed.*

## The problem

Per-record elision is filed as "on a receive, only send the repo records that
actually changed". As filed it can never elide anything: every record differs
from its stored self on one field the receive itself stamps, so the "would this
change?" test always answers yes.

## The mechanism, on current main

`sourceRecord` opens the composed record by stamping the global sequence into it
(`src/cli/sync-state.ts:267` — `const composedRecord: RepoRecordInput = { sourceSeq: source.sourceGlobalSeq };`),
and the elision test is a whole-record deep equality
(`src/cli/sync-state-elision.ts:119-120` — `isDeepStrictEqual(current, composed)`),
called at `src/cli/sync-state.ts:322-324` inside the observed-repo loop.

A receive advances `sourceGlobalSeq`, so `composed.sourceSeq > stored.sourceSeq`
for every observed repo, the deep equal fails for every observed repo, and
`repos` carries a transition for all of them. A 1-file receive emits O(repos)
transitions, not O(change).

The same field is also the retention-ordering token:

- `src/cli/sync-state.ts:244` — `if (current.sourceSeq > source.sourceGlobalSeq)` returns the stored record untouched

That is the ordering half of the generation CAS: an older source may not regress
a newer success. So `sourceSeq` does two unrelated jobs in one number — "when was
this path last observed" and "which write wins" — and elision needs the first to
stand still while the second keeps moving.

## Proposed change

Split the two jobs. The **ordering seq** keeps today's meaning, name, `:244`
comparison, and `source.sourceGlobalSeq` stamp. The **observation seq** advances
only when some other field actually changes — on an elided record it is simply
not written, because the record is not written.

Then drop the ordering seq out of the equality input at
`sync-state-elision.ts:119`, and an unchanged repo composes to a byte-identical
record and elides.

`sourceSeq` has no reader outside the state plane — the only other mentions in
`src/` are the persistence normalizations at `sync-state-records.ts:90` and
`:96`, and there is no occurrence anywhere under `apps/`. The server never sees
it, which keeps the split local.

## The safety property at risk, and how it is proven

**Retention must still hold: an older source must never regress a newer
success.** A lagging observation seq is safe for this because retention reads
the *ordering* seq, which still advances on every source. Two proofs to write:

1. **Lagging-observation retention.** Elide repo R at seq N (its stored ordering
   seq stays at M < N); an older source at M-1 then arrives. `:244` compares
   `M > M-1` and retains — unchanged from today, because elision never wrote a
   smaller number, it wrote nothing.
2. **Recompute after rejection.** `composeStateSavePacket` re-runs against the
   fresh snapshot on every rejection and the receipt is spent by construction
   (`sync-state.ts:302-315`: `receiptBoundTo`, then `globalElisionAudit`). With
   `proven === undefined` the elision branch at `:322` is unreachable and the
   recompute emits every observed repo — a rejection strictly widens the packet
   and can never carry a stale elision forward.

Both are unit-level against `composeStateSavePacket` — no rig needed.

## Acceptance measurement

`packet.repos.length` for a one-file receive on a workspace with ≥100 repos:
today the observed-repo count, after the change the changed-repo count.

## Not worth it if…

…#819's WS commit-in-frame path already collapses the receive into a frame small
enough that per-record transitions are not the pole. This is sequenced *after*
#819 for exactly that reason: measure on top of it before spending the split.
Also not worth it if the split tempts anyone into a second ordering authority —
one number decides who wins, and that must stay true.
