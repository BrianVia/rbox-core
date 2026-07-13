# 109 — First-publish upload authentication call storm

Status: UNDER ADVERSARIAL REVIEW (round 1 revisions applied 2026-07-13) — see
`docs/design/REVIEW-109.md`.

## 1. Problem and measured evidence

A greenfield first publish on `flat-meadow` (2026-07-13) uploaded a 2.85 GB,
118k-file corpus and emitted:

```
FirstPublishStats ... authn2426 authms107700 ...
```

The upload critical path therefore contained **2,426 separately authenticated
batch-upload HTTP request attempts**, spanning **107.7s from the start of the
first to the end of the last**. Authentication is repeated at batch-request
cardinality, even though every request belongs to one process, one `RboxApi`,
one account, and one publish.

The current names need one precision correction. `authn` is not a count of
fresh tokens or grants acquired by the client, and `authms` is not the sum of
time spent inside server authentication. There is exactly one production
`firstPublishAuthStart()` call site, in
`BlobBatchUploader.dispatchBatch` (`src/cli/remote/blob-batch.ts`), immediately
around `ctx.fetch(POST /v1/blob-batch/put)`. The start increments `authCallCount`
**before the fetch settles**, so the 2,426 is attempted batch-PUT fetch
cardinality — it includes any aborted, thrown, non-OK, 503-deferred, or
malformed-response attempts, not only successful requests. The global
first-start/last-end timestamps make `authCriticalPathMs` the wall envelope
across concurrent batch requests. The field measurement proves a
request/authentication-cardinality storm on the critical path. It does not by
itself attribute all 107.7s to D1 authentication CPU/wall time.

### 1.1 How big can the win actually be? (honest bound)

The waste is real but bounded, and the bound must be stated before choosing a
fix. At 24 slots, mean slot occupancy per dispatch is
`107.7s × 24 / 2,426 ≈ 1.07s`. The client code itself records (comment at the
`DEFAULT_BATCH_PUT_SLOTS` constant, measured 2026-07-08) that **one batch PUT
settles in ~910ms regardless of record count**, attributed to the Worker's
per-invocation subrequest serialization on the R2 writes. That leaves roughly
~160ms of mean per-dispatch residual for *everything else* — network RTT,
Worker queueing, routing, and bearer authentication combined. Even if
authentication were the entire residual, removing it saves at most
`≈ 0.16s × 2,426 / 24 ≈ 16s` of the 107.7s envelope (~15%) on this corpus —
likely less.

Authentication itself is two D1 point reads plus a throttled `last_seen_at`
write per request (`apps/api/src/auth/authenticate.ts`: `devices LEFT JOIN
memberships` on the directory DB, then an `accounts` tombstone point read on
the account DB). Every batch PUT carries the same durable bearer
(`RemoteContext.protoAuth`) and Worker routing calls `authenticate()` before
dispatching it, so the multiplicative defect is genuine — but it may not be
the dominant term of the measured envelope.

**Attribution prerequisite (gate 0, §6.0):** the server already measures this.
The worker-level `request` op (`apps/api/src/worker.ts` `fetch()`) wraps
`route()` *including* `authenticate()`, while the handler-level `blob.batchPut`
op wraps only the handler; both emit `ms`/`dbMs`/`dbCalls` to Analytics Engine.
`request − blob.batchPut` per matched `POST /v1/blob-batch/put` event bounds
the pre-handler (auth + routing) cost per request using data we already
collect. This design proceeds to implementation only if that decomposition
shows a per-request pre-handler cost consistent with a material wall win
(§6.0); otherwise it is parked in favor of the batch-fill/slot levers.

## 2. Root-cause analysis

### 2.1 What an “auth call” is in this measurement

The relevant object graph is deliberately shared:

- `e2ee-client.ts` builds the authenticated sync dependencies and ultimately a
  single `RboxApi` for the workspace operation.
- `RboxApi` constructs one `RemoteContext` and one `BlobBatchUploader`
  (`src/cli/remote/api.ts`). The context holds one durable device/PAT bearer,
  the receipt map, and the download-grant state.
- `remote.ts` is only the public barrel; the actual header and credential state
  is in `src/cli/remote/context.ts`. `protoAuth` returns that same bearer plus
  `x-rbox-protocol: upload-receipts-v1`.
- Every batch uploader dispatch calls `firstPublishAuthStart()`, sends one batch
  PUT with `protoAuth`, and calls `firstPublishAuthEnd()` when the entire fetch
  settles. No multipart request, single-blob PUT, missing check, receipt
  redemption, commit, E2EE key operation, or download-grant refresh increments
  `authn` today.

Thus the measured unit is **one batch-upload request**, not one file, multipart,
lane, repository, cryptographic key, token mint, or grant acquisition. The
server nevertheless does perform full bearer authentication once for each such
measured request.

### 2.2 Why one publish creates 2,426 requests

The batch uploader accepts ciphertext records up to 256 KiB. A request is
carved at the first of these bounds:

- 32 records (`DEFAULT_BATCH_RECORDS` and the server's matching
  `MAX_BATCH_RECORDS`);
- 8 MiB framed body;
- the records currently available when the 10ms partial-flush timer fires;
- the idle-tail flush: when the last active dispatch settles and queued work
  remains (`active === 0`), the residue dispatches immediately without waiting
  for the timer (`dispatchPartial` from `launch`'s `finally`).

There are 24 concurrent PUT slots by default. The producer feeds encrypted
files into this queue while encryption and upload overlap. Full groups dispatch
at 32 records, while a temporarily under-filled queue is flushed after 10ms or
on the idle tail. Consequently request count is approximately
`ceil(batchable ciphertext records / effective records per request)`, with
additional requests from partial flushes. File count is not request count:
unchanged/already-present ciphertext is skipped, duplicate addresses coalesce,
large ciphertext bypasses this batch path for single/multipart upload, and one
file can have a different blob representation from another.

The observed 2,426 is therefore the number of attempted batch-PUT fetches in
this run (§1: counted before settle). At the hard 32-record maximum those
calls can carry at most 77,632 distinct batch records; any partial batches
reduce that number. The 118k corpus size alone is insufficient to recover the
exact average fill, and the design must not manufacture one. **Batch fill is
already observable without new code**: every server `blob.batchPut` metric
event carries `count` (records) and `bytes`, so the fill distribution for the
FM window is a query away — pull it as part of gate 0 (§6.0). What is exact is
the multiplicative defect: **one bearer authentication per dispatch attempt,
2,426 times for one publish**.

### 2.3 The existing grant does not help uploads

`RemoteContext` already caches a download grant obtained from `latest()`.
`ensureFreshDownloadGrant(GRANT_REFRESH_AFTER_MS)` coalesces concurrent refresh
behind one Promise after four minutes. The Worker accepts that five-minute HMAC
credential before `authenticate()` only for `GET /v1/blobs/:sha` and
`POST /v1/blob-batch/get`.

The upload path neither requests nor presents an upload grant. The four-minute
constant is called only by the batch downloader, so lengthening it cannot
change `authn2426`. The upload receipt is also not an auth credential: it proves
that particular ciphertext was staged and is redeemed at commit; it does not
authorize an account to stage arbitrary new records.

## 3. Options considered

### A. Lengthen the existing download grant — reject

This changes only GET behavior. It cannot authorize batch PUT safely and does
not touch the measured call site.

### B. Cache bearer authentication in a module-global Worker map — reject

Worker isolates are ephemeral and requests may land in different isolates.
Such a cache would be neither reliable nor a coherent revocation boundary. A
central cache/DO would replace D1 reads with another network lookup per request,
not remove request-cardinality authorization.

### C. Share a cached upload grant across uploader lanes — recommend

Mint one narrow, short-lived, stateless HMAC credential during an already
authenticated publish preflight, retain it on the shared `RemoteContext`, and
present it on every batch PUT. Worker routing verifies the MAC/TTL locally and
derives the account only after successful verification, bypassing full bearer
authentication for that exact endpoint. This is the write-side analogue of the
existing download-grant pre-auth route and matches the actual object lifetime:
one context is already shared by all 24 lanes.

### D. Increase batch size/amortization — defer as an independent optimization,
but measure fill FIRST

Larger record counts could reduce both HTTP and auth request counts, but the
32-record server limit and 8 MiB framing/RSS bounds make it a wire and resource
change. Partial flushes also reflect the live producer cadence. Batch fill for
the observed run is already recoverable from existing `blob.batchPut` AE events
(`count` per request — §2.2), and gate 0 (§6.0) requires pulling it *before*
implementation: if fill is poor (say, mean well under 32), raising effective
fill attacks the same 2,426 multiplier for every per-request cost at once
(auth, RTT, subrequest serialization) and may dominate this design's bounded
win (§1.1). Auth should still be O(1) per publish even when small batches are
correct for latency or memory, but this design must not proceed on the
assumption that it is the dominant term.

### E. Proactively refresh a grant off the critical path — include as resilience,
not the primary fix

A five-minute credential covers the measured 107.7s upload. Long publishes can
refresh once through the shared Promise before expiry. Starting refresh at a
safe age while existing requests continue using the still-valid grant prevents
lanes from blocking on refresh; it does not justify a materially longer
revocation window.

## 4. Recommended design

### 4.1 Narrow upload grant

Add a domain-separated `rbox.upload-grant.v1` HMAC credential, using the same
current/previous-key rotation pattern as `grants.ts` but a distinct domain tag
so neither download grants nor receipts can verify as upload grants. Its signed
payload contains version, account id, mint time, and expiry. V1 is valid only
for `POST /v1/blob-batch/put` with `upload-receipts-v1`; it is not accepted for
single PUT, multipart, check, receipt redemption, commit, keys, workspace, or
account routes.

TTL is five minutes. The abuse bound must be stated honestly, per what the
batch-PUT path actually enforces:

- **Per-request bounds remain in force**: framing, ≤32 records, ≤256 KiB
  record, ≤8 MiB body, per-record SHA verification, and the amortized GC
  delete-fence read before receipt minting (`mintFenceCheckedReceipts`).
  There is **no quota check on this path today** — neither bearer- nor
  grant-authenticated staging PUTs consult billing/quota (quota acts at
  commit/entitlement time), so the grant does not remove one.
- **Aggregate authority within the TTL is unbounded in request count**: a
  stolen grant lets an attacker issue arbitrarily many batch PUTs for five
  minutes, each writing verified content-addressed objects to canonical R2 and
  minting receipts bound to the signed account. The blast radius is
  platform-level write amplification and orphaned canonical objects (P2-reapable
  GC garbage): the receipts are inert without a live bearer, because receipt
  redemption and commit remain fully bearer-authenticated, so none of the
  staged bytes can become account-entitled, quota-billable, or committed state.
- **Revocation/deletion lag is explicit**: a grant minted before a device
  revocation or account tombstone keeps authorizing staging PUTs and receipt
  mints for up to the TTL, because the pre-auth path skips `authenticate()`'s
  live-device and account-tombstone reads. This is accepted, mirrored from the
  shipped download grant but on the write side; it is bounded by the TTL, the
  writes cannot be redeemed or committed by a revoked principal, and account
  purge runs long after any in-flight TTL. §6.1 requires tests pinning both
  behaviors (accepted within TTL, rejected after).

A grant cannot read or decrypt ciphertext, commit a manifest, redeem receipts,
change keys, or act as another account.

Mint the optional grant on the authenticated `/v1/blobs/check` response,
**only in the `usesReceipts(req)` branch** (the batch uploader always speaks
`upload-receipts-v1`; legacy-protocol clients would never use one, and minting
for them would distort mint/fallback telemetry). That call already precedes
upload and has resolved the full principal/account. Add
`uploadGrant?: string` alongside `missing`; old clients ignore it. The client
changes `missingBlobs` to capture it on the existing shared `RemoteContext`,
then `BlobBatchUploader` adds `x-rbox-upload-grant` to every eligible batch PUT.
No extra acquisition round trip is introduced.

In `worker.ts`, before normal `authenticate()` and only for the exact batch-PUT
route (alongside the existing §27 download-grant pre-auth block), verify the
upload grant's shape, key id, MAC, TTL, and protocol. Only a successful
verification supplies `accountId` to `blobBatchPut`; every missing, invalid,
expired, disabled, or old-server case falls through to today's bearer path.
The client continues sending the bearer for compatibility and fallback. The
route must never parse an unverified account id, and must not expose whether a
key id or account exists.

**Auth-path echo (required for observability, §4.3):** the batch-PUT response
carries a low-cardinality header `x-rbox-auth-path: grant | bearer` on both
paths. Without it the client cannot distinguish "grant accepted" from "grant
silently rejected, bearer fallback" — both credentials ride every request —
and the §6 gates would be unfalsifiable from the client side.

### 4.2 Sharing and refresh

Store `{credential, capturedAt}` and one optional refresh Promise on
`RemoteContext`, exactly where download-grant and receipt state already live.
All upload slots therefore share one credential without lane-local state. The
credential is opaque to the client (no payload parsing); freshness is judged
by local capture age with a conservative margin:

- **Attach window**: a dispatch attaches the grant only while
  `now − capturedAt < TTL − safety margin` (e.g. 4.5 of the 5 minutes). Each
  dispatch snapshots the credential once when building headers. A grant that
  expires server-side mid-flight is **harmless for correctness** — the Worker
  falls through to the bearer that is always present — the cost is only one
  bearer-path request; the margin exists to keep that rare.
- **Refresh trigger**: at four minutes of age, the first dispatch noticing
  staleness starts a coalesced refresh; dispatches never await it while an
  attach-window credential (or the bearer fallback) is available. A later
  dispatch picks up the refreshed credential from the shared context.
- **Refresh failure discipline** (this is a fire-and-forget promise, unlike
  the awaited download-grant refresh, so ownership must be explicit): the
  stored refresh Promise has its rejection handled internally — failure clears
  the in-flight marker, records a last-failure timestamp, and a **minimum
  retry interval** (e.g. 15s) prevents single-flight coalescing from
  degenerating into continuous sequential retries. On persistent failure or
  expiry, dispatches simply stop attaching the grant and ride the bearer path;
  the publish never fails because of grant refresh. The refresh call is a
  context-level control call, deliberately outside the uploader's `inFlight`
  set — `close()` does not await it, and an unresolved refresh after close is
  inert (it only writes context fields).

Refresh transport: the server accepts an empty-shas `/v1/blobs/check` today
(`{shas: []}` → `{missing: []}`), but `RemoteContext.missingBlobs([])`
short-circuits locally without a request, so refresh MUST use a dedicated
context method (an explicit empty check POST with the receipts protocol
header), not `missingBlobs`. If review of the implementation finds that shape
unacceptable, the alternative is a narrow authenticated grant-refresh
endpoint; either way an API test pins the chosen shape.

### 4.3 Metric semantics

Keep the existing `FirstPublishStats` tokens and their numbers-only/privacy
contract. The client **cannot** classify a dispatch at send time — every
request carries both credentials and the server's grant rejection is a silent
bearer fallback — so classification happens at settle time from the §4.1
auth-path echo:

- Each batch-PUT dispatch captures its start timestamp locally. When the fetch
  settles, the dispatch is classified **bearer-path** unless the response
  carried `x-rbox-auth-path: grant`. Thrown/aborted fetches and responses
  without the header (old server, disabled flag) classify as bearer-path.
- `authn` counts bearer-path dispatches; `authms` folds only bearer-path
  dispatches' start/end into the first-to-last envelope (still an envelope,
  never summed server auth time). With the fast path healthy both are zero;
  with an old server or broken grants, `authn` truthfully reports every
  dispatch — the gate in §6 cannot be passed by a silently rejected grant.

Server-side, emit **one dedicated low-cardinality AE event per batch PUT**
when the server flag is on — op `blob.batchPut.auth`, outcome exactly one of
`fast_path | fallback_missing | fallback_invalid | fallback_expired` — leaving
the existing `blob.batchPut` handler outcomes (`ok/partial/bad_request/
retry_later`) untouched. `fallback_missing` is the expected class for old
clients; gates compare matched client versions only. Batch count/fill needs no
new metric — `blob.batchPut` already carries `count`/`bytes` per request.

No credential, hash, account/workspace id, filename, or raw path is emitted by
any of this. Tests must continue to assert that the rendered `fp` line
contains no path-shaped or 64-hex value.

### 4.4 E2EE and compatibility invariants

E2EE is unchanged. Files are encrypted and content-addressed before transport;
the grant neither carries nor derives encryption keys. Receipt minting,
redeem-then-admit accounting, signed commit verification, manifest signatures,
epoch/roster validation, and the rule that committed refs must be
present+entitled remain byte-for-byte on their existing paths.

This requires a Worker-side change in `apps/api` for mint, pre-auth verify,
and the auth-path echo header, plus the client capture/header/classification
change. Roll out the Worker first. The compatibility matrix must distinguish
the data plane from observability:

- **Data plane** (uploads, receipts, commits): correct in every combination.
  New client + old Worker: the unknown request header is ignored, bearer auth
  is still present, uploads proceed as today. Old client + new Worker: no
  grant header, bearer path, unchanged. Missing Worker key or disabled flag:
  no mint / verify fails → bearer path.
- **Observability plane**: new client + old Worker produces no
  `x-rbox-auth-path` echo, so the client classifies every dispatch bearer-path
  and `authn` reports full cardinality — which is the truth (the old Worker
  did bearer-authenticate every request). There is no combination in which
  `authn0` can be reported while the server actually ran bearer auth.

## 5. Flag and rollout

Use `RBOX_UPLOAD_GRANTS` as the kill switch on both surfaces:

- Worker unset/`0`: do not mint or accept upload grants; all requests use the
  existing authenticated route.
- Client `0`: do not retain/present an upload grant even if returned.
- Initial default is off in production, on only in the dev fleet/rig. After the
  gates below pass, enable mint/accept server-side first, then client use, then
  make it default-on while retaining `0` as the emergency rollback.

Rollback changes performance only. Receipts and writes created through a valid
grant have the same format and lifecycle as bearer-authenticated writes, so no
data migration or cleanup is required.

## 6. Validation and measurement plan

### 6.0 Gate 0 — attribution before implementation (existing data only)

Before any code is written, pull from Analytics Engine for the FM run window
(or a fresh dev-worker publish):

- per-request `request` vs `blob.batchPut` decomposition for
  `POST /v1/blob-batch/put` (`ms`, `dbMs`, `dbCalls`): the difference bounds
  pre-handler auth + routing cost per request;
- the batch-fill distribution from `blob.batchPut` `count`/`bytes`.

Go/no-go: implement this design only if the measured pre-handler cost times
request count, divided by slot width, is a wall-time win worth the new
credential surface (working threshold: ≥5s projected on the FM corpus — versus
the §1.1 upper bound of ~16s). If fill is the larger lever, record that and
park 109 in favor of the fill/slot work (option D).

### 6.1 Unit and integration gates

- Instrumentation: enumerate the sole production auth-timing call site; a
  settle-classified bearer dispatch increments `authn`, a server-confirmed
  grant dispatch (`x-rbox-auth-path: grant`) does not; thrown/aborted fetches
  and header-less responses classify bearer; concurrent bearer dispatches
  retain envelope (not sum) semantics; finalization resets state.
- Client: one missing check captures one grant; 24 concurrent uploader slots
  present the same snapshot credential; refresh is single-flight with a
  minimum retry interval and internally-handled rejection; invalid/expired/
  no-grant and old-server responses fall back to bearer without losing
  receipts or uploads; `close()` does not await an in-flight refresh.
- Worker: valid grant reaches only exact batch PUT; wrong domain, MAC, key id,
  protocol, method, route, future timestamp, overlong TTL, and expiry all fail
  closed to normal authentication; the auth-path echo header is `grant` only
  on verified-grant requests. Current/previous key rotation works.
- Security/invariants: batch caps, SHA verification, delete fence, receipt
  redemption (bearer-only), commit admission (bearer-only), E2EE round trip,
  and cross-account isolation are identical flag-on/off. Revocation lag is
  pinned both ways: a grant minted before device revocation or account
  tombstone is accepted within its TTL (documented §4.1 trade) and rejected
  after; a revoked bearer can neither redeem nor commit receipts minted via a
  still-live grant.
- Privacy: client `fp` and server metrics are numeric/enum-only and contain no
  raw path, filename, SHA, credential, account, workspace, or device id.

### 6.2 Rig and field measurement

Run matched greenfield publishes of the same staged corpus and network class,
at least three flag-off and three flag-on runs, recording the complete existing
`fp` line plus the server `blob.batchPut.auth` events. The gates are:

- flag off reproduces request cardinality near the baseline (`authn` tracks
  batch dispatch attempts; investigate corpus/config drift rather than
  requiring exactly 2,426);
- flag on yields `authn0 authms0` — meaningful because `authn` is
  server-echo-classified (§4.3), so it cannot read zero while the server ran
  bearer auth — **corroborated by** server `fast_path` equal to the matched
  run's batch PUT count with no unexpected fallback classifications;
- `unsat`, `skip`, `uniq`, `dup`, and `resume` remain equivalent for matched
  runs. These are consistency signals, necessary but not sufficient: they are
  encryption-/check-side counters and cannot by themselves prove receipt
  preservation or commit admission. Correctness is proven by the §6.1 suite
  plus each run's receipts redeeming and its commit being accepted with the
  same ref set flag-on/off;
- compare `up` and `filesSynced` medians against flag-off. Success requires no
  regression and a reduction consistent with the gate-0 attribution (§6.0) —
  the honest expectation is bounded (§1.1), not the 107.7s envelope. The
  observed `up`/`filesSynced` delta is the causal field KPI.

Also run a forced >5-minute throttled publish. Refresh behavior is asserted
from the server's mint events / `blob.batchPut.auth` classifications and
client `RBOX_DEBUG` logs — the fp line carries no refresh tokens and is not
extended for this: refresh attempts are bounded (single-flight + minimum retry
interval, verified in §6.1 tests), upload never pauses while an attach-window
grant or the bearer path is available, and expiry/refresh failure degrades to
nonzero `authn` (visible via the auth-path echo) rather than a failed publish.

Final validation is `bun run rig` plus a dev build shipped to the local fleet
and a `flat-meadow` A/B on a disposable benchmark workspace. Production enable
requires green CI, zero cross-account/authz failures, zero receipt/commit
invariant differences, and the kill switch verified live.

## 7. Out of scope

- Increasing the 32-record batch wire limit or changing framing/body caps.
- Caching a durable bearer or principal in process-global Worker memory.
- Extending upload grants to single PUT, multipart, commit, download, or other
  API surfaces.
- Changing encryption, key hierarchy, signatures, receipt semantics, or commit
  admission.
- Adding quota enforcement to staging PUTs (none exists today on the bearer
  path either — §4.1; grant/bearer parity is preserved, adding it is a
  separate design).
- Treating `authms` as server-exclusive authentication time; gate 0 (§6.0)
  uses the existing `request` vs `blob.batchPut` decomposition instead, and a
  richer server timing design remains future work if the field delta needs
  further decomposition.
