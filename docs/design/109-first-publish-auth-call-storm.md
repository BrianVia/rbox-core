# 109 — First-publish upload authentication call storm

Status: INITIAL DESIGN DRAFT (2026-07-12) — no adversarial review yet.

## 1. Problem and measured evidence

A greenfield first publish on `flat-meadow` (2026-07-13) uploaded a 2.85 GB,
118k-file corpus and emitted:

```
FirstPublishStats ... authn2426 authms107700 ...
```

The upload critical path therefore contained **2,426 separately authenticated
batch-upload HTTP requests**, spanning **107.7s from the start of the first to
the end of the last**. Authentication is repeated at batch-request cardinality,
even though every request belongs to one process, one `RboxApi`, one account,
and one publish.

The current names need one precision correction. `authn` is not a count of
fresh tokens or grants acquired by the client, and `authms` is not the sum of
time spent inside server authentication. There is exactly one production
`firstPublishAuthStart()` call site, in
`BlobBatchUploader.dispatchBatch` (`src/cli/remote/blob-batch.ts`), immediately
around `ctx.fetch(POST /v1/blob-batch/put)`. The start increments `authCallCount`;
the global first-start/last-end timestamps make `authCriticalPathMs` the wall
envelope across concurrent batch requests. The field measurement proves a
request/authentication-cardinality storm on the critical path. It does not by
itself attribute all 107.7s to D1 authentication CPU/wall time.

That distinction does not make the waste benign. Every batch PUT carries the
same durable bearer (`RemoteContext.protoAuth`), and Worker routing calls
`authenticate()` before dispatching it. Authentication hashes the token, reads
the directory database (`devices LEFT JOIN memberships`), reads the account
database to reject a missing/tombstoned account, and may perform the throttled
`last_seen_at` write. Those point reads occur once per batch request. With 24
default upload slots, many overlap, but they consume D1 work and add latency to
the request fleet that defines the upload wall.

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

- 32 records (`DEFAULT_BATCH_RECORDS` and the server's matching maximum);
- 8 MiB framed body;
- the records currently available when the 10ms partial-flush timer fires.

There are 24 concurrent PUT slots by default. The producer feeds encrypted
files into this queue while encryption and upload overlap. Full groups dispatch
at 32 records, while a temporarily under-filled queue is flushed after 10ms.
Consequently request count is approximately
`ceil(batchable ciphertext records / effective records per request)`, with
additional requests from partial timer flushes. File count is not request count:
unchanged/already-present ciphertext is skipped, duplicate addresses coalesce,
large ciphertext bypasses this batch path for single/multipart upload, and one
file can have a different blob representation from another.

The observed 2,426 is therefore the number of successful attempted batch
dispatches in this run. At the hard 32-record maximum those calls can carry at
most 77,632 distinct batch records; any partial batches reduce that number.
The 118k corpus size alone is insufficient to recover the exact average fill,
and the design must not manufacture one without the accompanying `uniq` and
batch-fill observations. What is exact is the multiplicative defect:
**one bearer authentication per dispatch, 2,426 times for one publish**.

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

### D. Increase batch size/amortization — defer as an independent optimization

Larger record counts could reduce both HTTP and auth request counts, but the
32-record server limit and 8 MiB framing/RSS bounds make it a wire and resource
change. Partial flushes also reflect the live producer cadence. It is useful to
measure batch fill and tune later, but auth should be O(1) per publish even when
small batches are correct for latency or memory.

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

TTL is five minutes. A stolen grant has only the narrow ability to stage
bounded ciphertext batches into its signed account and obtain receipts during
that window; existing body, record-count, record-size, quota/fence, hash, and
receipt checks remain in force. It cannot read or decrypt ciphertext, commit a
manifest, change keys, or act as another account. The explicit short revocation
lag is the same class of trade as the shipped download grant and is bounded by
the TTL.

Mint the optional grant on the authenticated `/v1/blobs/check` response. That
call already precedes upload and has resolved the full principal/account. Add
`uploadGrant?: string` alongside `missing`; old clients ignore it. The client
changes `missingBlobs` to capture it on the existing shared `RemoteContext`,
then `BlobBatchUploader` adds `x-rbox-upload-grant` to every eligible batch PUT.
No extra acquisition round trip is introduced.

In `worker.ts`, before normal `authenticate()` and only for the exact batch-PUT
route, verify the upload grant's shape, key id, MAC, TTL, and protocol. Only a
successful verification supplies `accountId` to `blobBatchPut`; every missing,
invalid, expired, disabled, or old-server case falls through to today's bearer
path. The client continues sending the bearer for compatibility and fallback.
The route must never parse an unverified account id, and must not expose whether
a key id or account exists.

### 4.2 Sharing and refresh

Store `{credential, capturedAt}` and one optional refresh Promise on
`RemoteContext`, exactly where download-grant and receipt state already live.
All upload slots therefore share one credential without lane-local state.

At four minutes, the first lane noticing staleness starts a coalesced refresh
using an authenticated control call; it does not await refresh while the old
credential remains unexpired. A later dispatch uses the refreshed credential.
If refresh fails or expiry wins, requests simply use/fall through to bearer
authentication. V1 may use the existing missing-check request shape for refresh
only if an empty check is already accepted; otherwise add a narrow authenticated
grant-refresh endpoint rather than replaying the full SHA list. This detail is
implementation-gated by an API test, not assumed.

### 4.3 Metric semantics

Keep the existing `FirstPublishStats` tokens and their numbers-only/privacy
contract. Move the production `firstPublishAuthStart/End` guard so it wraps a
batch PUT only when that dispatch has no usable upload grant and therefore
requires the bearer path. `authn` then means “batch PUTs sent through the full
bearer-auth path”; `authms` remains the first-to-last envelope of those requests,
not summed server auth time. With the fast path healthy both should be zero.

Add server-side low-cardinality counters for upload-grant `fast_path`,
`fallback_missing`, `fallback_invalid`, and `fallback_expired`, plus numeric
batch count/fill observations if not already available. No credential, hash,
account/workspace id, filename, or raw path is emitted. Tests must continue to
assert that the rendered `fp` line contains no path-shaped or 64-hex value.

### 4.4 E2EE and compatibility invariants

E2EE is unchanged. Files are encrypted and content-addressed before transport;
the grant neither carries nor derives encryption keys. Receipt minting,
redeem-then-admit accounting, signed commit verification, manifest signatures,
epoch/roster validation, and the rule that committed refs must be
present+entitled remain byte-for-byte on their existing paths.

This requires a Worker-side change in `apps/api` for mint and pre-auth verify,
plus the client capture/header change. Roll out the Worker first. New client +
old Worker remains correct because bearer auth is still present and the unknown
header is ignored; old client + new Worker remains on the current path; a
missing Worker key or disabled flag omits/rejects grants and falls back safely.

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

### 6.1 Unit and integration gates

- Instrumentation: enumerate the sole production auth-timing call site; a
  bearer batch increments `authn`, a grant batch does not, concurrent bearer
  batches retain envelope (not sum) semantics, and finalization resets state.
- Client: one missing check captures one grant; 24 concurrent uploader slots
  present the same grant; refresh is single-flight; invalid/expired/no-grant and
  old-server responses fall back to bearer without losing receipts or uploads.
- Worker: valid grant reaches only exact batch PUT; wrong domain, MAC, key id,
  account, protocol, method, route, future timestamp, overlong TTL, and expiry
  all fail closed to normal authentication. Current/previous key rotation works.
- Security/invariants: batch caps, SHA verification, fence, quota, receipt
  redemption, commit admission, E2EE round trip, revocation-after-TTL, and
  cross-account isolation are identical flag-on/off.
- Privacy: client `fp` and server metrics are numeric/enum-only and contain no
  raw path, filename, SHA, credential, account, workspace, or device id.

### 6.2 Rig and field measurement using existing fp tokens

Run matched greenfield publishes of the same staged corpus and network class,
at least three flag-off and three flag-on runs, recording the complete existing
`fp` line. The primary existing-token gates are:

- flag off reproduces request cardinality near the baseline (`authn` tracks
  batch dispatches; investigate corpus/config drift rather than requiring
  exactly 2,426);
- flag on yields `authn0 authms0` with server `fast_path` equal to batch PUT
  count and no unexpected fallback classifications;
- `unsat`, `skip`, `uniq`, `dup`, and `resume` remain equivalent for matched
  runs, falsifying any receipt/E2EE/correctness regression;
- compare `up` and `filesSynced` medians against flag-off. Success requires no
  regression and a material reduction consistent with removing full D1 auth
  from every batch. Because old `authms107700` was an envelope, do **not** claim
  a 107.7s saving; the observed `up`/`filesSynced` delta is the causal field KPI.

Also run a forced >5-minute throttled publish: refresh occurs once per TTL
window (not per lane), upload never pauses while the old grant is valid, and
expiry/refresh failure degrades to nonzero `authn` rather than a failed publish.

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
- Treating `authms` as server-exclusive authentication time; server timings may
  be added in a later measurement design if the field delta needs decomposition.
