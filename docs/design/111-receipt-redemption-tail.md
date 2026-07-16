# 111 — Receipt-redemption tail on greenfield publish

Status: REVIEWED — ALIGNED, 2026-07-12. Four codex adversarial rounds
(ledger: `docs/design/REVIEW-111.md`); round 4 returned no findings.

Reduce the receipt-accounting tail exposed by the first large greenfield publish.
The recommended change keeps redemption as a bounded, idempotent operation, but
makes upload-time draining the normal path and raises the client/server batch cap
only to a measured, body-safe value. It does not fold cold-publish receipts into
the commit envelope and does not weaken the GC deletion-fence protocol.

## Problem and measured evidence

The first publish of `flat-meadow` on 2026-07-13 uploaded 49,382 unique blobs
(2.85 GB on the wire). Its compact first-publish report included
`redeem37400`: 37,400 ms accumulated inside receipt redemption.

That token needs careful interpretation. `beginFirstPublishTiming` arms the
per-attempt accumulator in `encryptAndUpload` (`src/cli/sync-recovery.ts:140`).
Every call to `redeemReceipts` times its complete serial drain loop, including
all HTTP batches and failure handling, and adds that wall to
`receiptRedemptionWallMs` in a `finally` (`src/cli/remote/commits.ts:163–215`).
`formatFirstPublishStats` renders that value as `redeem` (`upload-lane-timing.ts:145–146`).
The compact token does **not** render the separately collected
`receiptRedemptionOverlapMs`. Therefore 37.4s is proven redemption work, but it
is not by itself proof that all 37.4s extended time-to-files-synced. The actual
tail is approximately:

```
redemption tail = receiptRedemptionWallMs - receiptRedemptionOverlapMs
```

with one important caveat: the overlap field **as computed today overstates
overlap** and is not yet gate-grade. `redeemReceipts` snapshots
`overlappedAtStart` once; when any upload is active at drain start, the entire
drain — every serial batch until the map empties, including batches issued
after the last upload settled — is credited as overlap
(`remote/commits.ts:165, 208–209`). The clamped-interval math only runs in the
not-overlapped-at-start branch. Additionally, both upload schedules call
`firstPublishUploadEnd()` only on PUT success, not in a `finally`
(`sync-recovery.ts:403–409`; `publish-pipeline/pipeline.ts:362–368`), so a
failed PUT leaks `uploadActive` and can keep the overlapped-at-start branch
taken forever. Phase 0 (below) must repair this accounting — interval
intersection of redemption-active and upload-active periods, `finally`-paired
upload ends — before the subtraction above is used for any decision.

The commit attribution is already disjoint: `sync.ts:1015–1022` subtracts
redemption accumulated within `api.commit()` from `commitWallMs`.

### What a receipt is

A successful receipt-protocol PUT writes the ciphertext to its canonical R2 key
and returns a stateless HMAC receipt proving that this account recently uploaded
that encrypted SHA and its signed size (`apps/api/src/blobs.ts:12–15, 215–224`;
`receipts.ts:1–13`). The client stores one opaque receipt per SHA in
`RemoteContext.receipts`; a newer receipt for the same SHA replaces the older
generation (`src/cli/remote/context.ts:19–24, 52–55`). Batch PUT captures the
receipt before resolving the upload waiters (`remote/blob-batch.ts:855–867`),
and single PUT does the equivalent (`remote/blobs.ts:61, 113`).

Redemption converts that temporary upload proof into durable account state:
catalog `blobs.present=1`, charge previously unowned bytes, grant `blob_refs`,
and clear GC/prune candidates. A grant may precede publication; an orphan grant
is harmless. Publication still happens only when the later commit CAS advances
the workspace head.

## Root-cause analysis

The client and server both impose a 5,000-receipt batch maximum
(`remote/commits.ts:10`; `apps/api/src/commit-accounting.ts:45`). Consequently
49,382 receipts require ten requests: nine batches of 5,000 and one of 4,382.
`redeemReceipts` awaits those requests one after another while draining the map.
The observed 37.4s is therefore about 3.74s per request averaged across ten
serialized Worker/DO turns.

Each server request is substantial (`workspace-sync.ts:847–907`):

1. Read and JSON-parse a capped body, then reject more than 5,000 entries.
2. Query entitled-and-present state, excluding prune markers and active delete
   intents, in bounded D1 batches (`workspace-sync.ts:1149–1167`).
3. Iterate the not-already-entitled entries and `await verifyReceipt` one at a
   time (`workspace-sync.ts:879–894`). The HMAC key import is cached, but the
   per-receipt sign/compare remains.
4. Run `commitAccounting` in sequential atomic super-batches of at most 3,000
   refs (`commit-accounting.ts:139–209`). Thus 49,382 new refs require about 17
   accounting transactions even if the HTTP batch is made larger.

Ten HTTP/DO dispatches and repeated entitlement prechecks amplify the cost, but
the irreducible work is still roughly 49k receipt verifications plus 17 D1
accounting super-batches. A larger wire batch alone cannot make that work vanish.

There are two client schedules today:

- The ordinary path finishes all uploads, then `commitSigned` awaits a complete
  receipt drain, and only then POSTs the commit with `receipts: {}`
  (`sync-recovery.ts:397–454`; `remote/commits.ts:217–239`). Redemption is a
  strict post-upload, pre-commit tail.
- The design-98 publish pipeline creates a single-flight `ReceiptDrainer`. At
  5,000 pending receipts it starts redemption during upload, applies backpressure
  above 10,000, and flushes before returning (`publish-pipeline/pipeline.ts:108–118,
  334–348, 376, 492`). This can hide redemption under uploads, but the pipeline
  is flag-gated and only selected for at least 64 new files
  (`sync-recovery.ts:62–64, 173–178`). Its drainer is single-flight, and each
  generation calls the same serial drain-to-empty function. Any residue still
  serializes before commit.

This explains the field result: a large cold publish creates ten wire batches
of expensive server accounting. Without the pipeline they all form a tail; with
it, `redeem37400` still reports the full work even when some is overlapped, and
only the structured overlap field tells us the remaining tail.

## Options evaluated

### A. Increase redemption batches only

This reduces HTTP/DO turns and duplicate precheck overhead, but leaves the 49k
HMAC checks and ~17 D1 transactions. It is useful as a complement, not the
primary fix.

It is also a coordinated wire change. The endpoint shares the 8 MiB
`MAX_REQUEST_BODY` cap with commits. The cap's comment estimates receipt maps at
about 375 bytes/ref and explicitly notes that cold pushes beyond about 20k do
not fit (`apps/api/src/commit-envelope.ts:16–25`). A single 49,382-entry request
would be about 18.5 MB and must remain invalid. Raising only the count cap would
therefore fail at the byte cap; raising the byte cap would weaken the isolate
heap defense around buffering plus `JSON.parse`.

### B. Pipeline redemption with upload completion

This attacks wall-clock tail without changing accounting semantics: redeem each
bounded group as receipts arrive, while later ciphertext continues uploading.
The repository already contains the single-flight drainer, generation-safe map
deletion, bounded backlog, error latch, and fence-reupload accumulator. Making
that schedule the normal cold-publish path is the smallest correctness-preserving
change. It reduces critical path even though total `redeem` work may remain high.

### C. Fold redemption into the commit request

The commit endpoint already accepts a receipts map and validates/accounts before
the head CAS (`workspace-sync.ts:395–410, 508–540`), so this is possible for a
small delta. It is wrong for this cold-publish problem: 49k receipts exceed the
8 MiB envelope cap, all accounting returns to the commit critical path, and a
stale-parent loser performs the expensive accounting before discovering the
conflict. It also couples delete-fence recovery to publication. Keep the commit
map empty after standalone redemption.

### D. Raise or remove server limits

An unbounded endpoint is rejected. A separate streaming parser or a higher body
cap would be an `apps/api` protocol and memory-safety project, not a quick client
optimization. Parallel receipt HMAC verification may later reduce total server
CPU wall, but it needs an independently measured concurrency bound; accounting
super-batches must remain ordered to preserve quota and fence behavior.

## Recommended design

### 1. Make bounded upload-time draining the default for cold publishes

Extract the existing `ReceiptDrainer` integration so both pipeline and ordinary
upload schedules notify it immediately after a PUT has captured its receipt.
Create it before the first upload, kick any pre-existing receipt backlog before
new PUTs, call `capture()` after each successful PUT, apply its bounded backlog
backpressure, and `flush()` after the last upload and before commit. Do not start
the commit until flush returns successfully.

Retain single-flight draining. This bounds client request memory and avoids
competing mutations of the shared receipt map. A successful response deletes a
receipt only if the map still contains the same receipt string; a replacement
captured while the request was in flight survives for its own redemption.

The existing publish pipeline can continue using the same component. The
ordinary path gains the same scheduling rather than requiring the entire
design-98 producer/consumer pipeline to be enabled. This isolates the change to
receipt timing and avoids changing encryption, missing-check, or upload order.

### 2. Raise the bounded wire batch from 5,000 to 15,000

Raise both `RECEIPT_REDEEM_BATCH_MAX` and `MAX_RECEIPTS_PER_REDEEM` to 15,000,
**contingent on Phase 0 byte measurement**. The 15k number is a candidate, not
a decision: the code's ~375 B/ref figure (`commit-envelope.ts:16–25`) is a
comment estimate, and a real wire entry is the 64-hex sha key plus a receipt
of the form `<kid>.<base64url JSON payload {v,a,s,n,t,e}>.<base64url MAC>`
(`apps/api/src/receipts.ts:101–115`) — its size scales with the
account-id length and numeric widths and can exceed 375 B. Phase 0 records the
maximum measured per-entry and per-request serialized bytes on real accounts;
15k ships only if a maximally sized 15,000-entry request — the exact
`JSON.stringify({receipts: …})` payload including the envelope and per-entry
punctuation, not `15,000 × max_entry_bytes` alone — measures at or below
7 MiB. Otherwise pick the largest N whose full serialized request fits.

Client slicing becomes **count- and byte-bounded**: a batch closes at the count
cap or at a 7 MiB serialized-byte ceiling, whichever first (measured on the
exact `JSON.stringify` payload it will send). Count-only slicing cannot enforce
the wire gate; a count-valid oversized request would only be caught by the
server's 413.

The flat-meadow case falls from ten HTTP requests to four while preserving the
body cap and the 3,000-ref internal accounting super-batch.

This is an `apps/api` wire-cap change with a **decided** compatibility
mechanism: automatic fallback on `too_many_receipts`. The server already
returns `400 {error: "too_many_receipts", max}` for an oversized batch
(`workspace-sync.ts:867–870`); today's client throws a generic error on any
non-422 failure (`remote/commits.ts:189–193`). The new client:

1. starts each RemoteContext session with `sendCap = 15,000` (or the configured
   value) and slices by `min(sendCap, byteCeiling)`;
2. on `400 too_many_receipts`, parses `max`; if `max` is a positive integer
   strictly below the batch size just sent, sets `sendCap = max` for the rest
   of the session and re-slices the (untouched, generation-safe) receipt map —
   the rejected request performed no server work, so replay is trivially safe;
3. if `max` is absent, non-numeric, or does not shrink the batch, fails hard —
   no unbounded retry loop; the drain error latches as today.

This handles old servers (first oversized request costs one bounced round
trip, then the session runs at 5,000), the `RECEIPT_REDEEM_15K` flag being
rolled back mid-session (the next 400 clamps down), and self-hosted/lagging
servers — with no new handshake field or capability endpoint. No advertised
`receiptRedeemMax` is added.

Do not raise `MAX_REQUEST_BODY`, do not accept a 49k batch, and do not increase
`MAX_REFS_PER_TXN`. Server accounting and its atomic failure unit are unchanged.

### 3. Preserve commit and recovery ordering

`flush()` is a correctness barrier, not optional cleanup. Only after all receipts
are durably redeemed (or converted to `needsUpload`) may `commitSigned` send its
empty receipt map. A 422 delete-fence abort returns the server's caught accounting
super-batch as `needsUpload`; if detail is absent, the client conservatively uses
the whole submitted wire batch. The commit is blocked and existing reupload
recovery obtains fresh bytes and a replacement receipt.

Transport retry remains safe. Replaying redemption sees already-entitled refs,
charges zero, and performs idempotent grants. A socket close after server success
cannot double-charge. Quota failure may leave earlier accounting super-batches
granted, as today; retry observes them and charges only the residue.

## Correctness requirements

1. **No head before refs.** The commit CAS must never advance until every newly
   referenced blob has durable, entitled `blob_refs` state. Early standalone
   grants are allowed; late grants are not.
2. **Fence semantics are unchanged.** Entitled+present excludes
   `blob_ref_candidates` and active `gc_candidates`. Accounting must atomically
   regrant and clear prune markers; an active delete-fence abort must become
   `needsUpload`, never a partial publish. This is the design-102 fence invariant
   (`docs/design/102-ochange-commit-admission.md:415–449`).
3. **GC roots remain commit-controlled.** Redemption changes entitlement, not
   workspace reachability. The complete retained root set and asynchronous
   design-96 index continue to derive from accepted commits; no redemption event
   is a published root (`docs/design/96-roots-index.md:300–322`).
4. **Idempotency and generations.** Duplicate redemption charges zero; only the
   exact submitted receipt generation may be deleted from client state.
5. **Bounded resources.** Raw bodies remain capped at 8 MiB, client backlog is
   bounded, and server D1 accounting retains 3,000-ref atomic super-batches.
6. **Failure stops publication.** Drainer, quota, authentication, and malformed
   response errors latch and abort the upload scope; they cannot degrade to an
   empty-receipt commit attempt.

## Flag and rollout

Add a client kill switch `RBOX_RECEIPT_DRAIN_DURING_UPLOAD`:

- unset / `1`: new upload-time drainer schedule;
- `0`: current post-upload drain behavior.

Keep the server's larger accepted count behind an environment flag
`RECEIPT_REDEEM_15K`; flag off preserves the 5,000 limit. The client discovers
the effective cap via the `too_many_receipts` fallback above and never retries
above a learned cap within a session. These flags are independent: the overlap
schedule can ship at 5,000, and the server cap can be rolled back without
turning off safe pipelining — a rollback just bounces one request per active
session before the client clamps down.

Rollout order:

1. Land measurement and tests with both behavior flags off in production.
2. Deploy API support for 15k, validate body/heap/D1 gates, then advertise it.
3. Release the compatible client; enable upload-time draining first at 5k.
4. Canary 15k for internal greenfield publishes, then expand if gates hold.
5. Keep both kill switches for at least one stable CLI/API release.

No merge touching `apps/api/**` proceeds without the dev-first deployment and
fleet validation in `docs/DEPLOYMENTS.md`; after merging to integration-only
`main`, explicitly promote the verified candidate to `production`.

## Validation plan

### Phase 0 — measurement before either flag

First, **repair the overlap accounting** so the tail subtraction is
trustworthy: accumulate the **union of upload-active intervals** on
`uploadActive` transitions (`0→1` opens an interval, `1→0` closes it — the
outer `[uploadStartedAt, uploadEndedAt]` span is NOT sufficient, since
encryption stalls, missing-check waits, or retry backoff can open upload-free
gaps inside it), compute `receiptRedemptionOverlapMs` as the intersection of
each redemption interval with that union, and drop the whole-drain
`overlappedAtStart` credit. Pair every `firstPublishUploadStart()` with a
`finally`-scoped `firstPublishUploadEnd()` in both upload schedules so a
failed PUT cannot leak `uploadActive`. A unit test must cover two upload
intervals separated by an idle gap that a redemption drain spans: only the
in-interval portions count. The pre-fix overlap field is not used for any
gate.

Then use the first-publish stats. Preserve compact `fp ... redeemN ...` output
and add the corrected `receiptRedemptionOverlapMs` to the compact tokens as
`redeemOverlapN` (structured output already has it). Add low-cardinality
receipt details to the phase report: receipt count, redemption request count,
maximum serialized per-entry and per-request bytes, and final flush wall
(post-last-upload drain measured on its own, independent of the overlap
field). On the server, use the existing `receipts.redeem` op and add numeric
timing details for entitlement precheck, receipt verification, and accounting
so the 37.4s can be assigned rather than inferred. Server resource telemetry
is named, not implied: per-request CPU time from Workers observability
(`cpuTime` in the invocation logs / Workers analytics for the
`receipts.redeem` route) and the `op` wall breakdown; isolate memory has no
per-request API, so the memory gate is expressed as the byte-cap bound plus
absence of isolate OOM/eviction errors in the run logs.

Capture at least five same-host greenfield runs at approximately 50k unique
uploads for each configuration: current 5k/post-tail baseline, 5k/pipelined,
and 15k/pipelined. Keep upload slots and corpus fixed. Also retain a small
steady-sync cohort to detect regressions.

### Falsifiable gates

- Primary: `redeem - redeemOverlap` (corrected interval-intersection overlap)
  median ≤ 5s and **maximum** ≤ 10s over the ≥5 fixed-corpus runs of each
  **rollout candidate** (5k/pipelined and 15k/pipelined) — the 5k/post-tail
  configuration is the non-blocking control, expected to fail this bound by
  construction (its measured tail is the 37.4s problem statement); it exists
  only to quantify the improvement. Five runs cannot support a
  percentile-tail claim, so the small-sample gate uses median/max; the
  p95 ≤ 10s form applies only to the step-4 canary cohort once it reaches ≥20
  greenfield publishes. No regression in `filesSynced` median greater than 5%.
- Scheduling: with upload-time draining enabled, at least 80% of redemption
  wall overlaps upload on the 2.85 GB corpus (corrected metric), unless total
  redemption wall itself is below 5s. The final flush is inherently
  non-overlapped; at threshold 5,000 the expected residue is under two batches,
  which this budget accommodates — if it does not, the gate fails honestly and
  the threshold is revisited.
- Wire: every request remains below 7 MiB measured serialized bytes (the
  client's byte ceiling, enforced in slicing) and the API returns no
  `body_too_large`; 15,001 is rejected when the 15k flag is on and 5,001 is
  rejected when it is off; a 15k-sliced client against a 5k server converges
  via one `too_many_receipts` bounce and completes the drain.
- Resource, split in two: (a) per-request safety — no `receipts.redeem`
  invocation exceeds 50% of the platform CPU limit (Workers `cpuTime`) and no
  Worker CPU-limit, isolate memory, or D1 subrequest-limit errors occur in 20
  cold runs at 15k; (b) corpus totals — summed server redemption CPU and wall
  across a full ~50k publish for **15k/pipelined versus 5k/pipelined** do not
  regress beyond 10% (per-request cost may triple; total cost must not grow).
  The scheduling comparison (5k/post-tail versus 5k/pipelined) is evaluated
  only by the primary and scheduling gates above — pipelining changes server
  concurrency independently of batch size, so the batch-cap gate must hold
  scheduling fixed. If either resource gate fails, keep pipelining and revert
  the batch increase.
- Correctness: total newly granted refs equals unique successful uploads; a
  second redemption grants zero; accepted commit refs all have live
  entitled+present rows; retained-root/GC rig results are identical flag-on/off.

### Tests and rig

Extend `remote-commits.test.ts` for count+byte slicing at 15k, the
`too_many_receipts` clamp-down (valid `max`, missing `max`, non-shrinking
`max` → hard fail), exact generation deletion, retries, 422 whole-batch
fallback, and body-cap errors.
Extend receipt-drainer and ordinary sync-recovery tests to prove redemption
starts before the last upload settles, backlog bounds hold, flush precedes
commit, and a latched error starts no commit. API tests cover both count flags,
the byte cap, idempotent replay, quota after an earlier super-batch, and a delete
fence crossing a 3,000-ref accounting boundary.

Run `bun run rig` with forced SIGINT/SIGKILL during upload, in-flight redemption,
and final flush; resume must converge without double charge or premature commit.
Run the design-102 fence scenarios (marked regrant, active-intent abort, fresh
reupload) and design-96 retained-root/GC validation unchanged. Finally ship a dev
CLI/API build to the local fleet and reproduce the fixed-corpus measurements;
unit tests alone do not satisfy this design.

## Out of scope

- Raising the 8 MiB request-body cap or accepting all 49k receipts in one body.
- Streaming JSON receipt parsing or a new binary redemption protocol.
- Folding cold-publish receipts into the commit envelope.
- Changing D1 accounting transaction size, quota semantics, GC reachability, or
  commit/ref-delta semantics from designs 96 and 102.
- Parallel server HMAC verification until server phase timings show it remains a
  material bottleneck after overlap and bounded larger batches ship.
