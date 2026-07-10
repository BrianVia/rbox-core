## Round 1 — codex (sol)

1. **BLOCKER — The invariant is proved for a complete per-sequence root set, but the proposed implementation indexes only data refsets and therefore omits authoritative roots.** Design 96 defines `reachable = refs(H) ∪ dropped(>F)` and then concretely implements `refs` by diffing sidecar/inline data refsets and returning `headSidecar`, gap sidecars, and dropped rows (`docs/design/96-roots-index.md:38-49,79-87,94-112`). Today the authoritative root set also contains every retained commit's `encManifestSha`, plus the `sidecarSha` for every sidecar commit; the latter is explicitly retained because losing it destroys future reachability proofs (`apps/api/src/workspace-sync.ts:477-504`). The caller adds the manifest and every returned `encSha` (`apps/api/src/versions.ts:25-44`), and `loadSidecarRefs` explicitly returns data refs *without* the sidecar SHA (`apps/api/src/sidecar.ts:29-47,50-52`). Concrete requested counterexample: let data SHA `x` be present at s1 (inline), absent at s2 (empty sidecar), re-added at s3 (inline), and absent again at s4 (empty sidecar). Let manifests be m1..m4 and sidecar carriers c2/c4. The updates for `x` themselves work: drop after s1 stores `(x,1)`, s3 deletes it, drop after s3 stores `(x,3)`. With F=2,H=4, the true union is `{x,m3,m4,c4}`, while `parse(headSidecar) ∪ dropped(>F)` is only `{x}`. With F=1 it additionally misses retained m2/c2. Empty inline arrays and zero-count sidecars are valid (`apps/api/src/commit-envelope.ts:96-126`; `src/engine/refset.ts:45-48,82-103`). Thus the drop/re-add/drop arithmetic is sound only after `refs(s)` is redefined and implemented as the *complete* GC-root set, including manifest and carrier churn. The response also has no representation for an inline head, despite strict inline/sidecar dual mode.

2. **BLOCKER — Reading raw sequences after `indexSyncedSeq` does not repair index lag.** Let the index be synced through k, F<k, and let `x ∈ refs(k)` be removed by k+1 and remain absent through H. The stale dropped index has no row for x, `refs(H)` has no x, and none of the raw gap refsets k+1..H contains x, yet k is retained and x is reachable. This directly falsifies I2's claim that “gap sequences are read raw so index lag never hides a root” (`docs/design/96-roots-index.md:97-112,150-152`). The fallback needs the base set at k as well as the later sets (with precise behavior for k=0 and k≤F), pending removed deltas, or reads must fail until the index is caught up.

3. **BLOCKER — Backfill has no valid first transition, and current prune can permanently destroy work the alarm still needs.** The fold requires refset(s−1) and refset(s), while backfill starts at floor+1 (`docs/design/96-roots-index.md:79-85,120-125`). For F=0 there is no `seq:0` commit/refset: initialization stores only genesis head/watermark, and commits begin at `seq:1` (`apps/api/src/workspace-sync.ts:157-160,339-371,709-728`). For F>0, current prune has already deleted `seq:F`; while a build/fold lags, a later prune can also delete additional inputs through its target (`apps/api/src/workspace-sync.ts:509-522`). “Prune never blocks on the index” and “zero risk (reads only)” are therefore false (`docs/design/96-roots-index.md:122-134`). Specify baseline initialization from the first retained complete root set and an atomic prune/fold ordering, preserved anchor, or resumable rebase-to-new-floor protocol. This is required both for initial backfill and normal lag.

4. **BLOCKER — A fold step is neither streaming nor bounded by the stated ~25 MiB, and one sequence is not a bounded unit of SQL work.** The real loader buffers the whole object, hashes it, and materializes a `Ref[]` containing a new 64-character string and object per entry; no streaming parser exists (`apps/api/src/sidecar.ts:31-47`; `src/engine/refset.ts:76-103`). The ~4 MiB number describes the incident's ~102,660-ref sidecar, not the accepted maximum. Commits permit 250,000 accounted refs (`apps/api/src/commit-accounting.ts:35-40`), making each canonical data sidecar about 10 MB before parsed strings/objects, diff sets, SQL batches, and the second refset. A transition may also remove and add nearly the full limit, so “one sequence per alarm” can mean hundreds of thousands of mutations. The 128 MB limit is per isolate and includes concurrent events/objects; R2 awaits allow requests to interleave. Cloudflare's current limits also give an alarm 30 seconds CPU by default. See [DO metrics/memory semantics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/), [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/), and [DO concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). I4 (`docs/design/96-roots-index.md:155-157`) needs a measured max-size heap/CPU proof, a genuinely incremental merge/parser or lower maintenance cap, and an intra-sequence durable subcursor/chunk protocol. Also probe only `added = refs(s) \\ refs(s−1)` for re-additions, not all of refs(s).

5. **BLOCKER — The pagination “snapshot” does not pin the mutable index generation.** Pages pin only `{head, pruneFloor}`, while an alarm can advance `indexSyncedSeq` and mutate `dropped_index` without changing either (`docs/design/96-roots-index.md:97-115`). In the finding-2 sequence, page 1 can report gap k+1..H; the alarm then inserts x as a dropped row whose SHA sorts before the consumed cursor, and a later page misses it. Pin and check `indexSyncedSeq`/an index generation, or provide a real snapshot token. Prune-floor filtering itself can be sound: if every page first validates the full pin and the query cannot interleave, rows emitted before a new floor and rows swept before emission are handled by rejecting and discarding the old attempt. But the current helper accumulates directly into one shared global Set across `Promise.all` workspace jobs (`apps/api/src/versions.ts:25-43`), so “retry the account from scratch” cannot discard one workspace's partial contribution. v2 needs a per-workspace accumulator merged only after completion and a final validation after the last page/head fetch; otherwise it is merely conservative, not I2-exact.

6. **MAJOR — `gapSeqs: number[]` is not enough for the caller to perform the claimed raw reads, and the cost estimate omits the discovery calls.** R2 reads require `sidecarSha` and count; inline gaps have no sidecar and need their inline refs. Those facts live in the stored commit body (`apps/api/src/commit-envelope.ts:84-126`), which the Worker cannot read from DO storage. The response must carry validated inline refs/descriptors (including manifests/carriers), or the caller needs one DO `commitAt` request per gap before any sidecar GET. The stated `first page + head R2 + gaps + pages ≤20` (`docs/design/96-roots-index.md:105-118`) does not account for those DO calls, snapshot retries, or an inline head. Define an exact worst-case protocol and subrequest formula.

7. **MAJOR — Alarm scheduling and recovery semantics are underspecified and can starve under continuous commits.** A Durable Object has one alarm; `setAlarm` overwrites an existing schedule, only the most recent schedule receives automatic retries, and automatic failure retries stop after six. R2 awaits also open the input gate, allowing commits/prunes to interleave with the handler. See [Cloudflare alarms](https://developers.cloudflare.com/durable-objects/api/alarms/) and [DO concurrency rules](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/). If each commit writes `now+delay`, continuous commits can keep pushing the fold out. The design must preserve the earliest pending alarm, re-arm on every success and caught-failure path, define commit-vs-handler re-arm ordering, and atomically mark `ready` only after comparing the cursor with the *current* head. At arrival rate ≥ fold throughput, readiness may never occur; that should be an explicit lag mode/metric, not the unsupported “normally 0–2” assumption (`docs/design/96-roots-index.md:103-108`).

8. **MAJOR — The backfill duration/cost and crash-resume story are not designed deeply enough.** 1,070 sequence steps imply about 2,140 R2 GETs as written (adjacent sidecars are refetched), 1,070 alarm invocations, hashing/parsing, and potentially very large SQL churn; “hours” is not derived from an alarm cadence or measurement (`docs/design/96-roots-index.md:120-127`). Commits during the build extend the target and can prevent completion. A step's row mutations and `index_synced_seq`/subcursor should be committed together after external reads; “UPSERT/DELETE are absolute” alone does not specify atomic visibility or a crash point (`docs/design/96-roots-index.md:88-90,158-159`). Quantify expected/worst-case completion and billable work, reuse the previous parsed/base set where safely bounded, specify restart after exhausted alarm retries/eviction, and test commits plus prune during every backfill phase.

9. **MAJOR — The design-95 interaction is not an interface-preserving constant replacement and does not preserve its proven budget.** The design-95 branch's `reachableFromWorkspaces` expects one JSON response per workspace and runs all workspace calls with `Promise.all` (`apps/api/src/versions.ts:25-43` in that worktree). Its mark gate assumes W root calls (`apps/api/src/versions.ts:105-128` there), and purge/audit use `1+W` in both the sentinel and execute-limit arithmetic (`apps/api/src/versions.ts:333-345,382-385` there; design 95 `docs/design/95-gc-purge-automation.md:221-255`). v2 changes that implementation materially: multiple DO pages, R2 GETs, retry-local accumulation, and potentially multiple large head sets concurrently. More importantly, ~274k dropped rows and ≤20 calls are empirical current-workspace estimates, not bounds (`docs/design/96-roots-index.md:51-54,115-118`); retained churn has no specified hard page cap. A fixed `PER_WORKSPACE_ROOTS_COST` is safe only with a fail-closed maximum pages/rows/gaps and must be propagated through mark, purge, execute-limit, and audit arithmetic. The claimed “unchanged interface” should refer only to the returned `Set`, not implementation or budget.

10. **MAJOR — The “commit hot path untouched/server never parses refsets on commit” premise is factually wrong, and simpler alternatives have not been compared.** Sidecar commit acceptance already calls `resolveSidecarBytes`, which fetches, hashes, parses, and returns all data SHAs before head publication; inline SHAs are already present too (`apps/api/src/workspace-sync.ts:280-305`; `apps/api/src/sidecar.ts:59-98`). Scheduling an alarm is also an additional storage operation on every successful commit, so latency remains O(1) but is not literally unchanged (`apps/api/src/workspace-sync.ts:339-405`; `docs/design/96-roots-index.md:73-76,153-154`). At minimum compare: persisting a bounded durable work descriptor/reusing the already parsed new set to avoid the second current-sidecar GET; a full `last_seen` live index (exact and one-side read, but O(live) writes/storage); and a signed delta/delta-sidecar or chunked/Merkle refset (potentially O(churn), but must be verified against canonical previous/current roots because the server does not verify commit signatures). There may be good reasons to retain async server-side diffing, but the current design has not established them.

11. **MINOR — `ctx.storage.sql` plus synchronous `storage.kv` is feasible here, and no new migration is required; the design should state that precisely.** Both dev and production already bind `WorkspaceSync` under the v1 `new_sqlite_classes` migration (`apps/api/wrangler.jsonc:24-46,120-134`), and SQLite-backed DOs expose both APIs ([SQLite storage API](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)). This internal table is not D1 and therefore does **not** consume migration 0025; 0024 belongs to design 95. What is missing is the schema-init location/ordering and test support: current fake states expose only `kv` and `transactionSync` (`apps/api/test/workspace-sync-roots.test.ts:14-27`). Replace the vague “implementation verifies API availability” claim (`docs/design/96-roots-index.md:58-61`) with the concrete existing v1 guarantee and an initialization/test plan.

**Verdict: REVISE.** The drop-last-sequence identity is promising when applied to the complete root set, but the proposed v1 protocol can omit live roots through three independent paths: missing manifests/carriers, an incorrect lag fallback, and prune destroying unfurled inputs. The bounded-memory, alarm/backfill, snapshot, and design-95 budget claims also need concrete protocols and measured bounds before implementation.

## Round 1 response — Claude (Fable)

All 11 findings accepted; design rewritten to DRAFT v2. Highlights: the
indexed set is the COMPLETE root set (new seq_roots table for per-seq
manifests/carriers; the §3 identity restated over ROOTS(s)); gap reads are
inclusive of the synced base with usable per-seq descriptors in the
response (no extra DO round-trips); backfill seeds from the first retained
sequence (F+1, no seq:0) with prev-set reuse (~1 R2 fetch/step) and exact
crash-resume via fold_subcursor; prune defers (409, hourly retry) rather
than destroying unfolded inputs; fold memory bounded via lean Set<string>
parsing + two-set cap + FOLD_MAX_REFS fail-safe + chunked transactions;
pages pin {head, floor, indexGeneration} and workspace jobs get local
accumulators merged on completion; hard fail-closed caps give
PER_WORKSPACE_ROOTS_COST = 30 for design 95's re-derived arithmetic;
alarm preserve-earliest/re-arm/lagging-mode specified; hot-path claim
corrected and three alternatives compared in §4.7; ctx.storage.sql stated
as the existing v1 new_sqlite_classes guarantee with schema-init/test
plan, no D1 migration consumed.

## Round 2 — codex (sol)

The data-set algebra is now sound. For `K = index_synced_seq`, the completed
index through K represents `union(F,K]` as `refs(K) union dropped(last_seq>F)`;
unioning the inclusive raw gap `[K,H]` therefore gives exactly `union(F,H]`.
This closes the old drop-at-the-sync-boundary and backfill-base
counterexamples, including re-add/drop. It also explains why readers may
interleave with chunks of one K-to-K+1 fold without a generation bump: an
inserted removal is already in raw `refs(K)`, while a deleted re-add is in raw
`refs(K+1)`, so every intermediate state has the same union. Final-chunk-only
`index_generation` is sufficient provided the complete pinned gap descriptor
set is returned on the first page. The prune race fails safe by rejecting a
floor that would delete the base, but its liveness is not yet resolved below.

1. **BLOCKER — Backfill still omits the seed sequence's manifest/carrier roots, falsifying exactness after the cursor advances.** The only specified `seq_roots(s)` insertion is part of folding a transition, but backfill says the seed `F+1` is merely read and folding begins at `F+2` (`docs/design/96-roots-index.md:119-125,180-184`). Re-run the manifest/carrier churn example with the backfill floor at 0: s1 has manifest m1 (and optionally carrier c1), later sequences have different roots, and the index advances to K>1. Raw `[K,H]` no longer contains s1, and no `seq_roots(1)` row was specified, so m1/c1 disappear from the result. Seed `{seq_roots(F+1), index_synced_seq=F+1, cursor, generation}` atomically and crash-test that transaction. The data-ref seed itself is correct.

2. **BLOCKER — Neither side of the protocol has a proved memory bound at the stated legal maxima.** On the DO, the claimed ~70 MiB peak already consumes over half of the shared 128 MiB isolate before diff output, 5k SQL bindings, hashing/runtime overhead, concurrent requests, or another DO's fold; `removed`/`probe` must be iterators rather than additional materialized sets, and a one-workspace rig does not establish a whole-isolate concurrency bound (`docs/design/96-roots-index.md:25-27,112-125,241-243`). `FOLD_MAX_REFS` has no numeric value or derivation. On the caller, 30 subrequests do not bound cardinality: the inclusive base plus eight unfolded legal sequences can contain 9 x 250k disjoint refs (2.25M unique strings), before up to 320k dropped-page shas and seq roots, so the growing `Set` can deterministically OOM while every page/gap cap passes (`docs/design/96-roots-index.md:114-118,149-176,241-243`). Specify a measured numeric fold cap with concurrency margin, align commit admission if it is below 250k, and add a fail-closed unique-root/byte cap or externally bounded accumulation at the caller.

3. **MAJOR — Prune deferral is data-safe but can block retention forever, and its condition appears to do so even after a healthy backfill.** If accepted commits permanently exceed fold throughput, or a legal commit exceeds `FOLD_MAX_REFS` and puts the index in permanent alert, K eventually falls behind the desired floor and every target `>= K` returns 409 forever. Retained storage then grows without bound; rebuilding repeats the same race/failure. That is a defensible fail-safe only if named as a degraded state with a recovery mechanism such as admission throttling/pause or an anchor-preserving rebase, not “briefly” or “vanishingly rare” (`docs/design/96-roots-index.md:117-118,191-196`). Moreover, if `backfill base` remains the original seed after readiness, `target >= min(base,K)` rejects every future floor advance. Define when that term is cleared. Section 4.5's “Prune never blocks on the index” directly contradicts the deferral (`docs/design/96-roots-index.md:200-205`).

4. **MAJOR — The fixed `PER_WORKSPACE_ROOTS_COST = 30` is only a per-attempt bound because snapshot retries are uncapped.** A fold/commit/prune can cause 409 after one or more pages, and the caller is told to retry, but no maximum attempts is specified. Repeated churn can therefore consume arbitrarily many subrequests while the design-95 arithmetic still reserves 30 (`docs/design/96-roots-index.md:161-175,207-214`). Add a hard retry cap (fail closed when exhausted) and multiply the imported cost by the maximum attempts, or make 30 cover the entire workspace operation including retries.

5. **MAJOR — `fold_subcursor` plus 5k SQL transactions does not yet define a bounded alarm step.** The design does not say whether one alarm computes and commits every removal and addition chunk (still as many as 500k mutations/one event), or yields/re-arms after one chunk. The latter must define durable phases for removals versus additions, a deterministic cursor, and whether each chunk re-fetches/re-parses both full refsets; the former needs a measured worst-case CPU/event-duration bound. Merely making each transaction small establishes neither bound nor the claimed exact crash-resume protocol (`docs/design/96-roots-index.md:119-126,178-190`).

6. **NIT — Accepted factual corrections remain contradicted by v2 wording.** The storage comment says generation is bumped by every fold transaction while the mechanism correctly says only the final chunk (`docs/design/96-roots-index.md:88-90,122-125`). Section 4.2 still says the server never parses refsets on commit and I3 says latency is unchanged, while Section 4.7 correctly records the existing sidecar parse and the new alarm write (`docs/design/96-roots-index.md:101-105,216-223,239-240`). Keep the final-chunk mechanism and correct the stale claims.

**Verdict: REVISE.** Inclusive-base gap reads repair the round-1 data counterexample, and partial chunks of one fold do not require intermediate generation bumps. However, the seed still loses authoritative roots, legal capped inputs can still OOM both DO and caller, prune has no permanent-lag recovery, retries invalidate the 30-call hard bound, and chunking is not yet a bounded resumable event protocol.

## Round 2 response — Claude (Fable)

All 6 findings accepted; design at DRAFT v3. (1) seed txn atomically writes
seq_roots(F+1) + cursor + generation, crash-tested. (2) iterator diff, no
materialized removed/probe sets; FOLD_MAX_REFS = 250k = commit admission
(no legal commit exceeds it); measured rig gate <110 MiB peak with
concurrent commit + WS, with the pre-authorized contingency of lowering
admission and the cap together; caller MAX_UNIQUE_ROOTS = 750k fail-closed
cap. (3) prune deferral is a named degraded state with metrics + operator
runbook; backfill-base veto term cleared at ready; §4.5 contradiction
fixed. (4) MAX_SNAPSHOT_RETRIES = 2; PER_WORKSPACE_ROOTS_COST = 90
(30 × 3 attempts) imported by design 95. (5) one alarm event = one full
sequence (parse once, all chunks, subcursor for crash-resume only), CPU
math ~10s worst vs 30s budget. (6) stale wording corrected (generation
comment, hot-path claims, I3).

## Round 3 — codex (sol)

The round-2 seed counterexample is closed in the transition itself:
`seq_roots(F+1)`, the cursor, synced sequence, and generation are now one
atomic, crash-tested seed transaction. The previously proved inclusive-gap
algebra and final-chunk generation rule remain coherent; I did not re-review
that algebra. The bounds review, however, still finds legal executions outside
the stated memory envelope.

1. **BLOCKER — The DO memory gate still does not cover whole-isolate fold concurrency.** The design budgets one fold at 65–75 MiB, then gates that fold with one concurrent 250k commit and live WebSockets (`docs/design/96-roots-index.md:125-136`). It still does not cover the round-2 case of two different `WorkspaceSync` objects folding concurrently in the same 128 MiB isolate; two legal 65–75 MiB fold events alone exceed the limit. The proposed contingency cannot be selected safely from a rig that never exercises that case. Further, §4.2 says §6 carries a measured `<110 MiB` gate, while §6 only says “memory bounded” and names neither the 250k×250k disjoint fixture, concurrent event mix, threshold, nor fail-the-rollout behavior (`docs/design/96-roots-index.md:288-297`). Add an isolate-level concurrency fixture/assumption and make the numeric heap gate (and its lower-both-caps contingency) an explicit acceptance criterion.

2. **BLOCKER — `MAX_UNIQUE_ROOTS` does not bound peak caller memory with the specified parallel local accumulators.** The cap is account-wide, but each `Promise.all` workspace job builds a local Set and merges only on completion (`docs/design/96-roots-index.md:186-203`). Multiple workspaces can therefore each stay below 750k while their simultaneously live local Sets exceed 750k in aggregate; a simple two-workspace 500k+500k case violates the claimed ~75 MiB bound before either merge can enforce the account cap. Retried workspace attempts can add another transient local Set unless disposal/order is explicit. Specify bounded/sequential workspace concurrency or a shared reservation/aggregate cardinality mechanism that aborts before allocation crosses the account cap, and test the multi-workspace peak. I4's unqualified “the thing that actually fits” is not yet established (`docs/design/96-roots-index.md:282-284`).

3. **MAJOR — The one-event sequence has estimated, not measured, worst-case CPU, and the promised gate is absent from validation.** At the legal disjoint maximum the handler performs 500k row mutations across up to 100 synchronous transactions. The stated 3–6 seconds for those transactions and ~10 seconds total are projections (`docs/design/96-roots-index.md:140-151`), not the measured worst-case event-duration/CPU proof requested in round 2. §6 also does not require a 250k×250k disjoint fold CPU measurement against the 30-second alarm budget. Make both heap and CPU measured rig results hard implementation/rollout gates, with a named CPU contingency (lowering the paired admission/fold cap is consistent with the existing memory contingency).

4. **MAJOR — The read contract and design-95 budget still have implementation-changing v2/v3 contradictions.** The nominal response schema still exposes numeric `gapSeqs` and unconditional `headSidecar`, and omits gap descriptors, inline-head representation, `seqRootsPage`, pagination cursors, and the snapshot pin that the following bullets require (`docs/design/96-roots-index.md:160-189`). Separately, §4.3 correctly derives and imports `PER_WORKSPACE_ROOTS_COST = 90`, but §4.6 still directs implementation to use 30 (`docs/design/96-roots-index.md:201-205,248-255`). Replace the schema with the actual v3 wire shape and change the integration constant to 90; otherwise two normative implementation sections prescribe incompatible protocols and sentinel arithmetic.

5. **MAJOR — Backfill has no terminal transition for an empty or seed-only retained range.** The seed transaction advances to `F+1`, while `ready` is specified only in a fold's final transaction (`docs/design/96-roots-index.md:147-157,208-223`). If `H = F+1`, there is no `F+2` fold to perform that transition; if `H = F` (a never-committed workspace at genesis), there is no seed sequence at all. Define atomic initialization/readiness for both cases, including current-head comparison and generation/state updates. This does not reopen the seed manifest/carrier fix; it closes the lifecycle around it.

6. **NIT — The invariant summary has stale abbreviated bounds/algebra.** I2 omits the `seq_roots` manifest/carrier term from the exact union, and I4 says two transient refsets are “~25 MiB” despite §4.2 budgeting about 25 MiB each plus buffers/bindings (`docs/design/96-roots-index.md:272-286`). Restate these from §§3–4 so implementers do not turn shorthand into a weaker test oracle.

**Verdict: REVISE.** The original seed-manifest loss is fixed, but neither memory bound is complete under the design's actual concurrency, and the CPU gate, v3 wire contract, 90-call integration constant, and seed/empty readiness edges still change implementation behavior. These are above NIT, so the draft has not converged yet.

## Round 3 response — Claude (Fable)

All 6 findings accepted; design at DRAFT v4. (1) per-isolate module-level
fold mutex — one fold budget per isolate, loser re-arms +5s; the two-DO
concurrent fixture is an explicit §6 acceptance gate. (2) caller goes
SEQUENTIAL per workspace (Promise.all removed): peak = one local Set +
global, cap checked before each merge, retry disposes first;
multi-workspace peak tested. (3) heap (<110 MiB) AND CPU (<20s) are
measured rig acceptance gates on the 250k×250k disjoint fixture with the
paired-cap contingency pre-authorized. (4) wire schema replaced with the
real v3/v4 shape (gap descriptors incl. inline head, seqRootsPage, pin
triplet on pages 2+); §4.6 constant corrected to 90. (5) seed txn sets
ready when F+1==H; genesis workspaces initialize ready-empty atomically.
(6) I2/I4 restated from §§3-4.

## Round 4 — codex (sol)

The isolate-global mutex, measured heap/CPU gates with paired-cap
contingency, 90-call integration constant, seed-only/genesis terminal
transitions, and restated I2/I4 are present and mutually coherent. The
round-3 aggregate caller-memory trace, however, still succeeds after the
change from parallel to sequential workspace processing.

1. **BLOCKER — the account cardinality cap is still checked after the peak it
   is meant to prevent.** Each workspace first builds a complete local Set and
   only then checks `global.size + local.size` before merging
   (`docs/design/96-roots-index.md:212-219`). For example, after workspace A
   merges 500k roots, workspace B can allocate a disjoint 500k local Set; the
   caller already holds 1M entries before the pre-merge check rejects it.
   Sequential processing removes concurrent locals but does not bound the one
   local plus global aggregate to `MAX_UNIQUE_ROOTS`. Enforce the remaining
   account budget during local construction (for example, conservatively check
   `global.size + local.size` before each new local insertion), while retaining
   the specified disposal-before-retry behavior, and make that the
   multi-workspace peak test oracle.

2. **MAJOR — `seqRootsPage` cannot be paged with the stated request schema.**
   The response has independent `nextSha` and `nextSeq` cursors, but the request
   defines only `fromSha` plus the pin triplet
   (`docs/design/96-roots-index.md:179-190`). The caller therefore cannot request
   the next seq-roots page or independently advance/exhaust the dropped and
   seq-roots streams, despite `MAX_SEQROOTS_PAGES = 4`. Add independent request
   cursors (including an unambiguous exhausted-stream representation) and state
   how the two page streams advance.

NIT folded into the verdict: §4.2 says §6 carries the explicit 250k×250k,
concurrent-commit/live-WS/two-DO `<110 MiB` and `<20s` acceptance gate, but §6
still contains only the generic large-workspace `/connect` memory check
(`docs/design/96-roots-index.md:148-153,320-329`). The normative gate exists in
§4.2/I4, so this is a validation-plan cross-reference/edit rather than a third
finding.

REVISE

## Round 4 response — Claude (Fable)

All findings accepted; design at DRAFT v5. (1 blocker) the cardinality cap
is enforced during local-set construction (per-insertion-batch check of
global+local against MAX_UNIQUE_ROOTS) — the 500k+500k trace now aborts
before allocation, and it is the §6 oracle. (2) seqRootsPage has its own
independent fromSeq request cursor with explicit exhausted-stream
semantics. (NIT) §6 now carries the §4.2 gate verbatim.

## Round 5 — codex (sol)

All three round-4 fixes are substantively present and coherent. First, §4.3
now enforces `global.size + local.size` while each workspace-local Set is
being constructed, so the 500k-global + 500k-disjoint-local trace stops at
the remaining account budget instead of materializing the second 500k Set;
retry disposal remains explicit. Second, the request has independent
`fromSha` and `fromSeq` cursors, with independent `nextSha`/`nextSeq`
advancement and an unambiguous `done` exhausted-stream sentinel. Third, §6
now repeats the normative §4.2 rig gate: the 250k×250k disjoint fold,
concurrent 250k-sidecar commit, live WebSockets, second-DO mutex deferral,
<110 MiB heap and <20s CPU thresholds, and the paired-cap-lowering
contingency.

No implementation-changing gap remains. Folded prose NITs: §4.3 calls the
500k+500k caller trace a §6 oracle although §6 does not list that caller test
explicitly, and I4's "before each merge" is stale shorthand for §4.3's
stronger during-construction rule. Neither weakens the normative mechanism or
changes implementation.

ALIGNED

## Round 5 response — Claude (Fable)

ALIGNED accepted; prose nits folded into the header. Design 96 final at v5
after 5 rounds. Implementation NOT yet dispatched — session paused per
founder instruction after design 95's merge (#199). Next session: implement
96 (in this worktree), rig gates, then the design-95 rollout sequence.
