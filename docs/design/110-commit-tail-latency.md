# 110 — First-publish commit-tail latency

Status: UNDER REVIEW, 2026-07-12 — codex rounds 1-2 adopted (see
`docs/design/REVIEW-110.md`).

This design addresses the long synchronous tail of a greenfield first publish.
It deliberately does not change manifest semantics, the signed commit format, or
the atomic head advance. The proposed optimization is a genesis-only bulk
implementation of the existing full-ref admission predicate, guarded by a
server kill switch and shadowed against the current implementation before it
can enforce. The recommendation is **conditional**: it proceeds only if Phase 0
shows `acct` dominance and a Phase 0.5 prototype shows the bulk statement shape
actually wins (see "Round-trip reality" below — the win, if any, is
per-statement execution cost, not round trips).

## Problem

A field first publish of `flat-meadow` (timestamped 2026-07-13 UTC; drafted
2026-07-12 local) transferred 2.85GB and published 49,382 blobs.
`FirstPublishStats` reported `commit46100`: 46.1s of commit-phase wall
(redemption-subtracted). The push timing line attributed 41.7s to the commit
`p` token.

That tail matters independently of bulk upload throughput. By the time it is
visible, the files have uploaded and the user is waiting for the workspace head
to become durable. A forty-second final barrier also magnifies retries: a lost
response or late parent conflict repeats a conspicuously long operation.

The tempting description — “uploading a 118k-file manifest takes 41.7s” — is
not what the code measures. This design first pins the timing boundary, then
optimizes the work that can actually occur inside it.

## Evidence

### Field observation

| Signal | Value |
|---|---:|
| Workspace | `flat-meadow` |
| Date | 2026-07-13 UTC |
| First-publish wire bytes | 2.85GB |
| Published blobs | 49,382 |
| Manifest entries | approximately 118k files |
| `FirstPublishStats.commitWallMs` | 46.1s |
| push timing `p` | 41.7s |

This is one field sample, not yet a distribution, and the two headline values
identify a boundary without splitting the work within it. The raw
`srv/env/acct/ssc/cm/mir/rsp` values from that same push line must be preserved
in the gate record in Phase 0. Until that suffix is recovered, the sample does
**not** implicate any specific server stage: receipt redemption, Worker-side
pre-DO work, DO admission, and networking are all still candidates.

### What `p` measures

`formatCommitTimings` renders `p` from `CommitTimings.postMs`
(`src/cli/sync.ts:142-143`; the server suffix renderer is `:146-147`). `postMs`
starts immediately before `this.api.commitSigned(parentSequence, built.commit)`
and stops after that call returns (`src/cli/e2ee-remote.ts:886-895`). Before
this timer starts, the client has already:

1. built and uploaded the canonical refset sidecar for a large ref set
   (`src/cli/e2ee-remote.ts:780-809`);
2. encoded and encrypted the genesis snapshot (`:839-877`); and
3. uploaded the encrypted manifest blob (`:878-884`).

Those operations render separately as `sc`, `e`, `c`, and `u`. Therefore `p`
is **not** client-side manifest serialization, compression, encryption, or wire
transfer of the encrypted manifest blob.

There is one important client-side component inside `p`: `commitSigned` first
drains outstanding upload receipts through `redeemReceipts`, in batches of at
most 5,000, and only then sends the commit POST
(`src/cli/remote/commits.ts:220-236`; the drain loop is `:163-216`). Thus:

```
p = final receipt-redemption drain
  + Worker-side pre-DO work (authorizeWorkspace D1 lookup,
    MAX(account_epoch) D1 lookup, DO dispatch — apps/api/src/routes/sync.ts)
  + network / request transfer / response parse
  + serverTimings.totalMs (srv — DO handler wall only)
```

`srv` begins only at Durable Object handler entry
(`apps/api/src/workspace-sync.ts:356-358`); the Worker-side auth and epoch
queries before the DO stub fetch are **not** inside `srv` and must not be
lumped into “network” when interpreting `p - srv`. Design 109 (auth-call
storm) owns that lane; Phase 0 below only sizes it.

The final POST is small for this workload. A large workspace uses the binary
refset sidecar; the signed body contains its `{sidecarSha,count,totalBytes}`
descriptor, and the POST body is `{parentSequence, commit, receipts: {}}`, not
the 118k-entry manifest or the 49k-address refset.

`FirstPublishStats.commitWallMs` is **not** a cross-check on `p`'s composition:
the timer wraps the entire `api.commit` call — account refresh, sidecar
build/upload, manifest encode/encrypt/upload, and `commitSigned` — and then
subtracts receipt-redemption wall accrued during that interval
(`src/cli/sync.ts:1016-1022`). It is a superset of `p` minus redemption, so
46.1s vs 41.7s constrains the split only weakly. No conclusion about whether
`p` is drain, Worker, or DO time can be drawn from these two numbers alone.

### Genesis receipts are already drained at commit time

Because `commitSigned` drains every accumulated receipt before the POST and
then sends `receipts: {}`, the genesis commit normally arrives with **all data
refs already entitled and present** (redemption granted them). Inside
`validateCommitRefs` this means the have-set SELECTs cover essentially the
whole refset, `newRefs` is empty or near-empty, and `commitAccounting` returns
immediately (`apps/api/src/commit-accounting.ts:128`). Two consequences:

- The genesis `acct` interval is dominated by the **have-set validation
  SELECTs**, not by catalog/charge/grant work. Any bulk optimization targets
  exactly that read path.
- The heavyweight per-ref accounting work happened earlier, inside the
  receipt-redemption requests — which are either overlapped with upload or in
  the final drain **inside `p`**. If the recovered suffix shows a small `acct`,
  the redemption lane (design 111) is the more plausible pole, not admission.

### Server decomposition

Design 97 defines the suffix precisely:

| Token | Boundary |
|---|---|
| `srv` | Durable Object commit handler wall |
| `env` | capped request read, JSON parse, envelope checks |
| `acct` | ref validation and (usually no-op at genesis) accounting |
| `ssc` | sidecar entitlement, R2 fetch, hash/shape parse |
| `cm` | synchronous DO head/epoch/watermark CAS |
| `mir` | alarm scheduling and best-effort D1 mirror |
| `rsp` | response assembly |

The implementation matches those boundaries in
`apps/api/src/workspace-sync.ts:356-478,516-529,545-558,650-722`. The narrow
tokens do not exhaust `srv`; Phase 0 computes the residual explicitly.

Prior production evidence on a roughly 114k-ref workspace found 5.8–6.6s of a
6.8–7.5s `srv` in `acct` (design 102 §1). The `flat-meadow` result is
materially slower and must not inherit those ratios without its actual suffix.
It does, however, take the genesis path that performs full admission
regardless of the design-102 mode.

## Root-cause analysis

### Genesis is a full snapshot, by design

Design 84 requires genesis/no-proven-base commits to emit a snapshot: there is
no authenticated base against which a delta can be computed. Compression may
shrink that snapshot, but manifest deltas help only subsequent commits
(`docs/design/84-manifest-delta-encoding.md:325-340`). The server is
zero-knowledge and treats the encrypted manifest as an opaque blob; it cannot
validate or reconstruct its plaintext.

That explains why the first commit has a full manifest blob, but not the 41.7s
`p`: that blob was uploaded under `u` before `p` began.

### Genesis also falls back to full server admission

For sidecar commits under delta admission, `WorkspaceSync.computeCommitDelta`
immediately returns `fallback: "first_commit"` when `parent === 0`
(`apps/api/src/workspace-sync.ts:276-287`). Both
`RBOX_COMMIT_DELTA_ADMISSION=shadow` and `enforce` therefore materialize the
full child refset and call the existing `validateCommitRefs` plus
`commitAccounting` path (`workspace-sync.ts:572-618`). With delta admission
`off`, `computeCommitDelta` is never called at all: the sidecar branch invokes
`runFullAdmission` directly over the full resolved refset
(`workspace-sync.ts:568-570`). Either way, genesis performs full-set
validation. This is correct: at genesis every ref is logically added and there
is no accepted parent whose durability can be inherited.

`validateCommitRefs` checks every address for present+entitled state and for
the GC-candidate and delete-intent barriers (`blob_ref_candidates`,
`gc_candidates.deleting_at`) via its have-set predicate; the `rbox_delete_fence`
abort itself lives in `commitAccounting`'s mutating batch, not in the
validator. `commitAccounting` then catalogs, charges, grants, and clears
barriers for refs not already admitted — at genesis, normally none. The whole
interval is reported as `acct`. Only after it succeeds does the DO atomically
compare parent/epoch/watermark and store the signed commit.

### Round-trip reality: statements vs subrequests

The validator is **not** one round trip per 90 refs. The 90-param IN-list
SELECTs are grouped 34-per-`db.batch()` (`SELECTS_PER_BATCH`), and each
`db.batch()` is one D1 subrequest (`apps/api/src/commit-accounting.ts:35-37,
90-93`). Actual shape:

| Refs | IN-list statements | D1 subrequests |
|---:|---:|---:|
| 49,382 | 549 | 17 |
| ~118k | ~1,312 | ~39 |
| 250k (max) | 2,778 | 82 |

A bulk `json_each` implementation chunked at 2k–5k SHAs issues 10–25 / 24–59 /
50–125 statements respectively — fewer statements, but not obviously fewer
subrequests unless those statements are themselves batched, and at the 2k end
it can *increase* round trips. Therefore the plausible win is **per-statement
execution cost** (statement planning, and the two correlated `NOT EXISTS`
probes evaluated per candidate row across 549 statements), not network round
trips. Whether that win is real and how large it is must be established by a
prototype benchmark (Phase 0.5) before implementation; the prior 5.8–6.6s
`acct` at 114k refs across only ~38 subrequests (~150–170ms per batch) is
consistent with per-statement/per-row execution cost dominating, which is
encouraging but unproven for the bulk shape.

This yields the working diagnosis:

- **Not client manifest work:** it finished before `p` and has separate tokens.
- **Not encrypted-manifest transfer:** that is `u`; the final POST carries an
  opaque hash and a refset descriptor.
- **Possibly the final receipt drain:** quantified by a new final-drain timer
  (Phase 0), and owned by design 111 if dominant.
- **Possibly Worker-side pre-DO work:** quantified by `p - finalDrain - srv`
  and split further under design 109 if dominant.
- **Possibly genesis have-set validation:** confirmed only if the recovered
  `acct` is dominant. If instead `env` is dominant, the premise is falsified
  and the request path must be investigated.

No single candidate is asserted as the pole until the suffix is recovered.

### Why the server cannot validate after publication

The current order is an integrity invariant, not incidental latency:

```
resolve authenticated refset
→ prove every referenced blob satisfiable and account it
→ atomic head CAS/store
→ acknowledge success
```

Advancing the head and validating asynchronously would permit an accepted head
to reference absent, fenced, or unentitled blobs. Future pulls could then be
irrecoverably broken. Returning success before the CAS would also violate the
existing meaning of commit success. A submit/poll protocol could move waiting
between requests, but would not reduce validation work or end-to-end publish
latency and would add pending-state, expiry, conflict, and epoch semantics.

## Options considered

### A. Stream or compress the genesis manifest upload

Design 84 already supports compressed snapshot envelopes, and a streaming
encoder/uploader could reduce peak memory and `u` for very large manifests.
This is worthwhile only if `e/c/u` is the bottleneck. It cannot remove the
observed `p` tail because the encrypted manifest upload completes before `p`.
It also requires fleet-wide reader capability before a new encoding is written.

**Decision:** not the fix for this design. Keep as an independent manifest-lane
optimization.

### B. Validate asynchronously after accepting the commit

This would make the response fast by weakening what the response means. It
violates manifest/ref integrity and commit atomicity. A safe two-phase variant
must finish admission before the final CAS, so it merely relocates the wait.

**Decision:** reject post-publish validation. Do not change success semantics.

### C. Overlap client manifest preparation with the upload lane

Today final manifest construction occurs after encryption/upload because churn
can defer files and the committed snapshot may include only the stable subset
(`src/cli/sync.ts:957-983`; `src/cli/sync-recovery.ts:478-491`). Encoding
mutable entries earlier risks publishing a descriptor for bytes that were
deferred or changed. An incremental serializer could stage settled entries,
then finalize the sorted manifest/hash after the lane, but the remaining
finalization is not inside `p` and the complexity is disproportionate to this
symptom.

Receipt redemption is a safer overlap target: it is idempotent and already has
first-publish overlap instrumentation. Any residual final drain should be
reduced separately by continuously draining during upload, while retaining the
final barrier. That improves `p - srv`, not `srv/acct`. Design 111 owns the
redemption lane.

**Decision:** retain as a conditional client follow-up if Phase 0 finds an
unoverlapped receipt tail above the gate; do not couple it to the server fix.

### D. Pre-admit genesis asynchronously, then finalize with a token

A server could validate/account the full refset into durable state, record a
token bound to account/workspace/project/epoch/refset, and later consume it
before the head CAS. This can be correct if delete-fence and account-deletion
invariants remain live until finalize. In the present client, however, the
final refset is not uploaded until immediately before snapshot encoding, so the
available overlap is only the small `e/c/u` tail unless a substantially larger
session protocol is introduced. It shifts work and adds token recovery without
making the work cheaper.

**Decision:** reserve for a later design only if bulk admission cannot meet the
latency gate.

### E. Bulk full-ref admission for genesis

Genesis cannot reduce the validated set, but it may be able to reduce
per-statement execution cost: feed bounded chunks through one JSON parameter
and `json_each(?)` (or an equivalently measured D1-supported bulk relation),
join that relation once against `blobs`, `blob_refs`, `blob_ref_candidates`,
and active `gc_candidates`, and return exactly the same per-SHA classification
as `validateCommitRefs`. The hypothesis is that one join over a 2k–5k-row
relation beats 22–55 planned IN-list SELECTs each evaluating two correlated
`NOT EXISTS` probes per row — a hypothesis, not an established fact, per
"Round-trip reality" above.

This remains synchronous and full-set: it changes the execution shape, not the
predicate or ordering. Chunk size, JSON parameter size limits, and per-chunk
statement cost are Phase 0.5 benchmark results, not constants chosen in this
draft; D1's documented ≤100 bound-parameter guidance says nothing about the
supported size of a single JSON-string parameter (a 5k-SHA array is ~330KB),
so that limit must be established empirically before the design is
implementable.

**Decision:** recommended **only if** Phase 0 confirms `acct` dominance and the
Phase 0.5 prototype shows a material win, and a D1 rig proves semantic parity
and resource bounds.

## Recommended design

### 1. Add a genesis bulk validator, not a new admission model

Add `validateCommitRefsBulk` beside `validateCommitRefs` in
`apps/api/src/commit-accounting.ts`. Its inputs and result are identical:

```
(env, db, accountId, shas, receipts, nowMs)
  → { ok: true, newRefs }
  | { ok: false, needsUpload }
```

For shadow comparison, both validators are additionally refactored to expose
one normative **pure classification**:

```
{ have: Set<sha>, new: Array<{sha, size}>, missing: string[] }
```

where `have` is the set satisfying the current predicate, `new` are non-have
SHAs with a valid receipt (size from `verifyReceipt` only), and `missing` is
the rest, both in **input order** (the current iteration order,
`commit-accounting.ts:97-107`). `validateCommitRefs` computes exactly this
today internally (`commit-accounting.ts:73-109`); exposing it is a pure
refactor. Shadow compares this structure. Receipt verification is
side-effect-free but must not be paid twice per SHA: a per-request cache keyed
by `(sha, receipt)` and evaluated with the request's single `nowMs` is
populated lazily for the union of both classifiers' non-have sets; neither
classifier's execution order may affect the other's result — each consults
only the cache, never the other's classification.

Normative requirements:

1. Input SHAs remain the verified canonical child refset plus carriers and
   manifest-chain addresses, deduplicated exactly as today.
2. For every SHA, “have” means `blobs.present=1` joined with an account
   `blob_refs` entitlement, with `NOT EXISTS` on the account's
   `blob_ref_candidates` marker and `NOT EXISTS` on
   `gc_candidates.deleting_at IS NOT NULL` — the current predicate
   (`commit-accounting.ts:80-89`), unchanged.
3. A non-have SHA enters `new` only with a valid receipt; chargeable size is
   derived only from `verifyReceipt`, never from the sidecar.
4. Missing output preserves the existing bounded/deterministic 422 contract.
5. `commitAccounting` remains unchanged: quota triggers, the
   `rbox_delete_fence` abort, and idempotent partial accounting remain its
   authority for whatever `new` set exists. Note that at genesis `new` is
   normally empty (receipts pre-drained), so accounting is normally a no-op;
   the design claims **behavior parity** with the current genesis path for
   in-progress account deletion, not a new guarantee — the current genesis
   path performs no `account_deletions` probe (the probe inside
   `computeCommitDelta` sits after its `first_commit` early return,
   `workspace-sync.ts:286-289`), and the bulk path must not add or remove one.
6. Any bulk-query error fails closed to the current validator before the CAS.
   It never skips a ref and never converts an error into success. The combined
   worst case (bulk chunks attempted + full validator + accounting) must be
   budgeted and tested; see the resource gates.

The implementation must use a bounded JSON array per statement, and the guard
against silent truncation, unsupported JSON behavior, or a query-plan mistake
operates at two levels: (a) the bulk relation itself rejects duplicate input
values, and the query must yield exactly one classification row per input SHA
even under unexpected table multiplicity (collapse via `GROUP BY` on the input
SHA or detect and fail on duplicate joined rows — a duplicated row must never
be silently first- or last-write-wins in the result map); (b) the returned
classification cardinality must equal the input cardinality, with
duplicate/unknown returned rows rejected. Chunk-size and total JSON bytes get
explicit caps fixed at no more than 50% of the failure boundary measured in
Phase 0.5, with boundary±1 behavior tested.

### 2. Invoke it only for genesis commits on the receipts+sidecar path

In `WorkspaceSync.commit`, preserve `computeCommitDelta` and
`shouldUseDeltaAdmission`. The genesis test is `parent === 0`, checked ahead of
the delta-mode branch — necessarily so, because with
`RBOX_COMMIT_DELTA_ADMISSION=off` the `first_commit` fallback string is never
produced (`computeCommitDelta` is not called). When all of these hold:

- receipts protocol;
- sidecar mode;
- `parent === 0`; and
- the genesis bulk flag permits it,

run the bulk validator over the full resolved child refset plus carriers and
chain addresses — the same set `runFullAdmission` receives today on both the
delta-off path (`workspace-sync.ts:569`) and the delta-mode `first_commit`
fallback path (`:574-582,615-616`). This requires a small call-site refactor
routing both branches through one genesis helper, with two normative
telemetry/shape rules:

- **`first_commit` emission is preserved explicitly.** Today, delta
  `shadow`/`enforce` genesis reaches `computeCommitDelta`, gets the
  `first_commit` fallback, and emits `emitDelta("fallback",
  {reason:"first_commit"})` (`workspace-sync.ts:583-585`). Routing genesis
  ahead of that call must synthesize the same emission (same event, reason,
  and count) whenever `deltaMode != off`, and the correctness matrix asserts
  its count/tags — otherwise design-102 soak dashboards silently change.
- **Exactly two classification passes at genesis under bulk shadow:** bulk
  plus the authoritative validator, then one accounting pass. Design-102's
  `readShadowFlags` comparison never runs at genesis today (the `first_commit`
  fallback bypasses the `delta && deltaMode === "shadow"` branch,
  `workspace-sync.ts:586`) and must not start running under the genesis
  helper.

The refactor must otherwise be behaviorally unchanged for every non-genesis
commit and for genesis with the flag `off`.

The final `transactionSync` parent/epoch/watermark CAS is untouched. Sidecar
resolution remains before admission. Mirror and response semantics are
untouched. No signed or stored format changes.

### 3. Shadow is compare-only; enforce has a fail-safe fallback

The new mode is independent of, but compatible with,
`RBOX_COMMIT_DELTA_ADMISSION`:

| Delta admission | Genesis bulk shadow | Genesis bulk enforce |
|---|---|---|
| `off` | current full result authoritative; compare bulk classification | bulk result authoritative; current validator on internal error |
| `shadow` | current full result authoritative; compare bulk | bulk authoritative for genesis only, after its own shadow gate; delta telemetry still records `first_commit` |
| `enforce` | same as `shadow` — genesis remains a delta fallback | bulk handles only genesis; subsequent commits retain delta enforce |

Shadow must not double-run `commitAccounting`. Within one request the ordering
is fixed: the bulk classification read runs first, then the authoritative
`validateCommitRefs` read, then (single) accounting on the authoritative
result. Both reads are pre-accounting, but they are separate chunked D1 reads
with no shared snapshot, so concurrent GC marking, redemption, or entitlement
changes between and within them can produce divergence that is noise rather
than a bug — the same chunk-boundary caveat design 102 records at
`workspace-sync.ts:588-590`. No sequence of separate reads can *prove* which
earlier observation was correct, so the protocol is fail-closed: **ambiguity
blocks the gate; only externally corroborated concurrency can be excused, and
only in soak review, never automatically.**

For each request: bulk result `B`, authoritative result `A` (read after `B`),
and — when harmful divergence is detected — a re-probe `R` of the divergent
SHAs with the current predicate, taken after both:

- The re-probe is capped at one validator batch (≤ 34 × 90 = 3,060 SHAs). If
  more SHAs diverge, none are re-probed and **all** count as `divergence` —
  a systematic bulk defect can diverge on the entire refset and must never be
  sampled into an excuse.
- `A == R != B`: recorded as `divergence`, gate-blocking. This is either a
  stable bulk defect or unprovable concurrency; both block.
- `R != A` (state moved after the authoritative read, including three-way
  histories): recorded as `state_moved`, **also gate-blocking by default**. A
  `state_moved` event may be excused only in soak review with independent
  corroborating evidence — the divergent SHAs overlap a logged GC
  mark/purge/deletion tick or redemption activity for that account in the
  request window — and every excusal is written into the gate record with its
  evidence.
- Rig comparisons run with GC and redemption quiesced and require strict zero
  events of every class.
- The production soak enforcement gate is zero `divergence` and zero unexcused
  `state_moved` events.

Emit only counts, timings, and a bounded digest/sample under the same privacy
rules as design 102; never paths or manifest plaintext.

In enforce, cardinality mismatch, query error, timeout, or unsupported D1
feature immediately runs `validateCommitRefs`. This can be slower but cannot be
less safe; its combined resource cost is bounded by the gates below.

### 4. Preserve manifest and scan integrity

This design never decrypts, parses, or rewrites the manifest. Design 84's
snapshot/delta envelope, AEAD, canonical hash, chain completeness, epoch rule,
and fail-closed reader behavior are unchanged. Designs 83/85's “doubt does more
work, never loses a change” rule applies directly: a bulk fast-path doubt falls
back to full validation before publication.

The committed manifest is still formed only from carried base entries or files
whose final bytes/descriptors survived churn checks. No preparation is moved
across the decision→upload→state-save interval.

## Flag and rollout

Add a server environment variable:

```
RBOX_GENESIS_BULK_ADMISSION = "off" | "shadow" | "enforce"
```

Unset, empty, unknown, and `"0"` mean `off`. `off` executes the exact current
path and is the kill switch: each request captures one mode at entry, so
flipping to `off` stops all **new** requests from using the bulk path while
in-flight requests finish under their captured mode. No D1 migration, client
capability, or wire-format change is required; rollback requires no stored
state or protocol downgrade.

Rollout order:

1. Phase 0 (field attribution) and Phase 0.5 (limits/prototype benchmark) gate
   everything below.
2. Land instrumentation and the bulk classifier with the flag `off`.
3. Deploy the API to dev first, per `docs/DEPLOYMENTS.md`.
4. Run the D1/DO rig and dev fleet with `shadow` across the workload matrix
   below. Do not enable enforcement with any `divergence` or unexcused
   `state_moved` event.
5. Enable dev `enforce`; run forced conflict, epoch, quota, 422, deletion-fence,
   and response-loss retries.
6. Deploy prod code with `off`, then `shadow`. Require the sample-count gate.
7. Enable prod `enforce`.

## Validation plan

### Phase 0 — preserve and classify the field sample

Before implementation, capture the complete `flat-meadow` push timing line and
FirstPublishStats object. Add/confirm numbers-only fields for:

- receipt count, batch count, total redemption wall, overlap wall, and — a new
  field — the **final-drain wall**: the exact duration of the `redeemReceipts`
  call made inside `commitSigned` (the only drain enclosed by `postMs`).
  `receiptRedemptionWallMs` aggregates all drains including overlapped ones
  outside `p` and must not be substituted;
- final commit POST request bytes;
- existing `p`, `srv/env/acct/ssc/cm/mir/rsp`;
- existing design-102 `admit_stmts`, `admitAccountMs`, `childParseMs`, fallback
  reason, and D1 call count.

Derive, recording the **raw signed residuals** alongside any clamped
presentation value (the client timers, the drain timer, and the server tokens
use different clocks and rounded millisecond fields; repeated negative
residuals are instrumentation evidence, not zero transport cost):

```
upstream-of-DO = p - finalDrainMs - srv          (signed; clamp only for display)
server residual = srv - env - acct - ssc - cm - mir - rsp   (likewise)
```

`upstream-of-DO` includes Worker-side auth + epoch D1 lookups and DO dispatch
as well as network; if it dominates, split it under design 109 (which already
instruments the auth lane) before concluding anything about transport.

Screening gate — three reproduced first publishes; every statistic below is
the **median of the three samples** (a screening signal, not a distribution):

- Proceed with genesis bulk admission iff `median(acct) >= 0.5 * median(p)`
  **or** `median(acct) >= 10s`.
- Independently: if `median(finalDrainMs) >= 10s`, the redemption lane
  proceeds under design 111. Both clauses may pass and both lanes then proceed
  — they share no mechanism (but see the seam note in `REVIEW-110.md`:
  commit-request-shape changes from 111 alter this design's premise).
- If `median(env) >= 10s`, Worker→DO request streaming/body buffering must be
  investigated and explained first (the small request-byte measurement must
  agree), before either lane's implementation starts.

Phase 0 also computes the **maximum possible speedup**: the end-to-end and
`acct` shares that admission can even theoretically recover. From it, fix the
Phase 0.5 go/no-go threshold **before** the prototype runs (see below).

### Phase 0.5 — D1 limits and prototype benchmark

Before the design is implementable, measure on a real D1 database:

- the maximum accepted size of a single JSON string parameter and any SQL
  statement-length limit at that size;
- `json_each` join cost vs the current IN-list SELECT shape at 2k/3k/5k-row
  chunks against production-shaped `blobs`/`blob_refs`/`blob_ref_candidates`/
  `gc_candidates` tables at realistic row counts;
- per-`db.batch` wall for both shapes, and Worker heap while holding the
  sidecar buffer, SHA strings, JSON encodings, and result maps simultaneously
  at 250k refs.

Output: the chunk size and JSON byte cap (each fixed at ≤ 50% of the measured
failure boundary), the concrete measurement methods for CPU/heap (named
Workers observability metrics or rig-harness heap snapshots; if peak heap
cannot be measured reliably, the caps must instead be justified by an
analytical worst-case sum of the named retained buffers kept under 50% of the
128MB isolate limit), and a measured projected `acct` improvement.

**Independent stop rule, fixed before the prototype runs:** the prototype must
project an `acct` reduction of at least 50% of the Phase-0-measured `acct`
wall **and** at least 3s absolute at the reproduced 49k workload. Anything
less: stop, record the numbers in this document, and close the design as a
measured no-op. The prototype cannot weaken its own gate — the implementation
gate below is then expressed against this projection, not vice versa.

### Correctness matrix

Run each with bulk `off`, `shadow`, and `enforce`, and with
`RBOX_COMMIT_DELTA_ADMISSION=off|shadow|enforce`:

1. Genesis at 0, 1, 49,382, approximately 118k, and the protocol maximum refs.
2. All refs already entitled (the normal pre-drained genesis state); all refs
   receipt-backed at commit time — note this is a **direct-API/fixture
   variant** with the client drain deliberately bypassed, since a failed
   `commitSigned` drain never reaches the POST
   (`src/cli/remote/commits.ts:220-236`); mixed; duplicate content collapsing
   to one ref; missing receipt; bad/expired receipt.
3. Missing manifest carrier, missing sidecar carrier, corrupt/truncated/unsorted
   sidecar, descriptor count/bytes mismatch, and oversized refset.
4. Account quota crossed in the first, middle, and last accounting super-batch
   (receipt-backed variant); retry proves idempotent charge/grant behavior.
5. `blob_ref_candidates`, active delete intent, mark landing between bulk
   classification and the authoritative read (asserting the `state_moved`
   classification and that it blocks the gate), a divergence exceeding the
   re-probe cap (asserting all of it counts as `divergence`), and in-progress
   account deletion (asserting parity with the current genesis path's
   behavior).
6. Parent race (two genesis writers), epoch rotation before admission and before
   CAS, lost success response, and exact retry.
7. Manifest snapshot raw and zstd, plus a subsequent one-file delta commit, to
   prove design-84 behavior and delta admission are unchanged — including the
   count and tags of the synthesized `first_commit` fallback emission under
   delta `shadow`/`enforce`.
8. Kill switch flipped while requests are in flight; each request uses its
   captured mode and returns an ordinary current-contract result.
9. Injected bulk failure at the **last** chunk of a maximum-ref,
   **all-receipt-backed** request (the only variant that drives accounting to
   its 84-super-batch worst case) in enforce, proving the fail-closed fallback
   completes within the resource budget: combined bulk-attempt statements/
   subrequests + 82 full-validator subrequests + 85 accounting subrequests
   (1 plan lookup + 84 super-batches), measured via the existing op.span
   counters.

Shadow acceptance requires zero `divergence` and zero unexcused `state_moved`
events across every rig case (rig runs GC-quiesced: strict zero of every
class) and the production soak. Benign ordering differences are not accepted
silently: `missing` and `new` are normalized to the input-order contract
before comparison.

### Performance and resource gates

Use the same CLI/API build, daemon stopped, same workspace and network path.
For each of 49k, approximately 118k, and maximum-ref genesis workloads, collect
10 warm successful samples per mode plus three cold-isolate samples. Report
p50, p95, and range for client commit wall, `p`, every design-97 server token,
D1 calls/statements, CPU time, and peak Worker heap.

Gates are finalized from Phase 0's measured `acct` share and Phase 0.5's
projected improvement — the current validator already runs only ~17/~39
subrequests at these scales, so improvement bounds cannot be assumed. The
provisional targets below stand only until then and any revision must record
its Phase-0/0.5 justification here:

- 49k and ~118k genesis `acct` p50 reduced by at least 80% of the Phase-0.5
  projected reduction (the projection itself already passed the fixed stop
  rule: ≥50% of measured `acct` and ≥3s absolute at 49k), and in no case
  slower than flag-off;
- end-to-end commit-wall p50 improvement consistent with the Phase-0 maximum
  possible speedup (no fixed 2x claim — commit wall contains sidecar,
  manifest, refresh, and pin work this change cannot touch), with no
  regression above 10% in `ssc`, `cm`, or `mir`;
- maximum-ref request stays within the named platform limits with at least
  20% headroom **including the injected-failure combined path** (matrix case
  9): the ~1,000-subrequest cap per invocation (the limit that bit gc-phase1,
  `apps/api/src/gc-phase1.ts:10-12`), the 128MB isolate memory limit, and the
  Workers CPU budget, each measured by the Phase-0.5-named method; no bulk
  JSON chunk exceeds its Phase-0.5 cap;
- subsequent one-file commit p50 changes by no more than 5%;
- zero `divergence` / unexcused `state_moved` shadow events, broken accepted
  heads, double charges, or missed delete fences.

Validation is not complete with unit tests. Ship a dev build to the local fleet
and reproduce a greenfield publish, or run the full `bun run rig` first-publish
scenario, then perform the dev deployment soak required above. Finish with the
repository test suites covering commit accounting, workspace sync, remote
commit parsing, and E2EE sync, plus `git diff --check`.

## Out of scope

- Changing design 84's rule that genesis is a full snapshot.
- A new manifest wire encoding or streaming manifest implementation.
- Returning commit success before admission and the atomic head CAS.
- Removing the full validator; it remains the permanent fail-safe.
- Optimizing non-genesis admission beyond design 102.
- The receipt-redemption lane (server-side redemption cost and eager/continuous
  client draining) — design 111 owns it; Phase 0 here only sizes the final
  drain.
- The Worker auth/epoch pre-DO lane — design 109 owns it; Phase 0 here only
  sizes `upstream-of-DO`.
