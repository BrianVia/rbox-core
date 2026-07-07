# 77 - Batched blob transport: amortize request tax without packing blobs

Status: P0 upload lane timing shipped in PR #132; P0.5 server-side split
measured by a 2026-07-07 Analytics Engine query; P1 batch-get + download
coalescer is specced and pending implementation; P2 batch upload is deferred to
§26's measurement gate. Design only, no implementation.
Origin: 2026-07-07 fresh-join and first-publish measurements on a
94,777-blob / 4.9 GiB workspace.
Depends on: design 23 upload receipts, design 26 batch upload, design 27
download grants including Amendment A, design 33 per-account GC/quota barriers,
design 40 chunk sync as a non-goal, design 73 byte progress, design 74 pull lane
timing.

## 1. Baseline and problem

The current pull bottleneck is request count, not client concurrency.

1. **Join, measured.** After §27 Amendment A, a full workspace join of
   94,777 blobs / 4.9 GiB takes 176s wall at download concurrency 128. The lane
   split is 89.2ms per blob for fetch and 2.8ms for local decrypt+write, so the
   fetch lane is 97% of the pull. A re-check at concurrency 256 was flat
   (174s wall, per-blob fetch inflated to 145ms), which puts the practical
   ceiling near 535 blobs/s. The measured box can read about 130 MB/s, so the
   bandwidth floor for 4.9 GiB is about 38s; git clones the same repo set as
   3.2 GB packed bytes in 25s. We are paying fixed Worker/routing/R2 request tax
   about 93k times.
2. **P0.5 server split, measured.** Analytics Engine (`rbox_prod_metrics`) on
   191,251 `blob.get` ops with outcome `ok_grant_preauth` after Amendment A
   shows avg total 42.9ms, avg R2 span 42.9ms, avg D1 0ms. The hot path is now
   100% R2 server-side. Since the client observes 89.2ms per blob, about
   46ms/blob is client-edge request tax that batching can remove, while about
   43ms/blob is per-object R2 GET time that batching cannot remove but can
   overlap inside a batch. The same query on the legacy `ok` outcome before
   Amendment A, across 485k ops, showed 193.6ms avg with 129.9ms D1. That is
   retroactive confirmation that Amendment A removed the D1 queue; P1 is now
   about removing request tax and overlapping the remaining R2 term.
3. **Upload, measured wall but disputed lane theory.** First publish of the same
   workspace measured 1,381s on v0.9.4. Today every single
   `PUT /v1/blobs/:sha` still runs `authenticate()` before it reaches the
   receipts path. `authenticate()` is at least two D1 point reads per PUT
   (device lookup plus account tombstone lookup) plus a throttled `last_seen`
   update, so about 92k PUTs imply at least 184k bearer-auth point reads. That
   fact alone no longer justifies batch upload: §26's 2026-06-30 gate measured a
   blob PUT at about 126ms total, with about 120ms in the R2 write, and the
   simple upload-concurrency bump from 32 to 64 beat the endpoint. The
   publish-side batching theory is therefore disputed by §26's data; the P0
   push lane split decides whether request/auth overhead ever becomes dominant.
4. **Blob shape.** 94,777 blobs / 4.9 GiB averages about 55 KiB, heavily
   small-skewed from git objects and source files. Request tax hurts exactly
   where blobs are tiny.

## 2. Current code facts

1. `worker.ts` has a pre-auth branch only for `GET /v1/blobs/:sha` with
   `x-rbox-download-grant`. It calls `verifyGrantCredential()`, derives
   `accountId` only after MAC/TTL success, and then calls
   `blobGetWithVerifiedGrant()`. Any failure falls through to normal
   `authenticate()`.
2. `blobGetWithVerifiedGrant()` is intentionally D1-zero: it goes straight to
   `env.rbox_dev_blobs.get(blobKey(sha))` and returns uniform 404 on miss.
   `blobGet()` remains the authenticated fallback and treats an invalid grant as
   no grant.
3. `blobPut()` already has the §23 receipts branch keyed by
   `UPLOAD_RECEIPTS_V1` (`x-rbox-protocol: upload-receipts-v1`). In the live code
   this branch writes `blobKey(sha)` directly with R2 sha verification, then calls
   `mintReceipt()`, and does zero `blobs` / `blob_refs` / `used_bytes` D1 work.
4. The legacy non-receipts PUT path still uses `wouldExceedCap()` before writing
   and `grantEntitlementWithQuota()` after R2 accepts. The receipts commit path
   uses `validateCommitRefs()` plus `commitAccounting()` to verify receipts,
   catalog `present=1`, charge, grant, and clear §33 markers.
5. Pull file apply already runs a bounded pool. `apply.ts` defaults
   `RBOX_DOWNLOAD_CONCURRENCY` to 128, and `RBOX_LANE_TIMING=1` records fetch vs
   decrypt+write at `stageEntryToTemp()`.
6. `src/cli/remote/blobs.ts` has the transport seams P1 needs:
   `getBlob()`, `getBlobToFile()`, and download integrity verification against
   the requested sha. `RemoteContext` already carries both bearer auth and
   `authDownload` for grants, and `captureGrant()` already records grants from
   `latest()` / `latestCommit()`.

## 3. Decision

Batch the transport, not the storage.

R2 stays one immutable object per blob at `blobKey(sha)`. There is no packfile,
bundle, tar stream, or server-side multi-object format in this design. Blob-level
dedup is load-bearing for convergent sync, receipts, commit accounting, and GC.
Batching only reduces the number of HTTP requests and grant/bearer verifications
needed to move the same set of objects.

The active endpoint is:

1. `POST /v1/blob-batch/get` - download path, P1.

The old draft route `POST /v1/blobs/batch-get` is rejected. On old servers it
collides with the `/v1/blobs/:sha` matcher and returns
`badRequest("invalid sha256")` after authentication, not a router 404. The
`/v1/blob-batch/*` prefix is outside `/v1/blobs/`, so old servers produce a
genuine route-absent 404 that the client can safely use as its compatibility
probe. If upload is ever reopened under §26, its additive route is
`POST /v1/blob-batch/put`.

## 4. Wire framing

Content type is `application/x-rbox-blobs`. Multipart MIME is explicitly
rejected: it adds parser complexity and boundary ambiguity without buying
anything over a small fixed binary frame.

Each response record is:

```
sha256[32 raw bytes] | u32be lengthWord | payload[length]
```

Rules:

1. `lengthWord & 0x80000000 === 0` means a data record. `lengthWord` is the
   ciphertext byte length, and `payload` is exactly those ciphertext bytes.
2. `lengthWord & 0x80000000 !== 0` means a status record. The lower 31 bits are
   the length of a compact UTF-8 JSON status payload, capped at 4 KiB. Status
   records are valid only in `batch-get` responses.
3. Data lengths are capped at `MAX_BATCH_RECORD_BYTES`, initially 256 KiB and
   env-tunable. Batch bodies are capped at `MAX_BATCH_BODY_BYTES`, initially
   8 MiB. Record count is capped at `MAX_BATCH_RECORDS`, initially 32.
4. All integer fields are big-endian. The stream ends at EOF after a complete
   record. EOF in the middle of `sha256`, `lengthWord`, or `payload` is malformed
   framing and fails the request/response.
5. A status record's JSON shape is:
   `{"status":"missing"|"too_large"|"error","code"?:string,"size"?:number}`.
   It never carries raw R2 errors or account/blob metadata beyond the requested
   sha already present in the frame header.

The high-bit status form is chosen over HTTP trailers because trailers are
poorly supported through fetch clients, proxies, and Workers tooling. Per-record
status also preserves partial success: one missing sha is a frame, not a failed
batch.

## 5. P1 - `POST /v1/blob-batch/get`

Request:

```json
["64hex...", "64hex..."]
```

with bearer auth and, when held, `x-rbox-download-grant: <grant>`. The request
array is capped at 32 unique sha256 hex strings. Duplicates are removed before
work is scheduled. The server reads the JSON body with an actual-byte cap using
the `readBodyCapped` pattern from `commit-envelope.ts` / `workspace-sync.ts`;
it must never trust `Content-Length` or call unbounded `req.json()`.

Authentication and authorization:

1. Extend the `worker.ts` pre-auth branch to match only
   `POST /v1/blob-batch/get` with a grant header.
2. Call `verifyGrantCredential(env, grant, { nowMs })` first. Only on `ok` may
   the handler derive `accountId` from the verified grant payload.
3. Any grant failure falls through to normal `authenticate()`. The authenticated
   batch-get fallback is required, not optional: after bearer authentication, it
   must apply exactly today's single `blobGet()` semantics per sha, namely
   `isEntitled(env, accountId, sha)` before R2 for each sha. A batched SQL form is
   allowed only if it is behavior-identical to serial `isEntitled()` calls.
4. On the authenticated fallback, unentitled shas and absent shas both emit the
   identical `{"status":"missing"}` status frame. This preserves the no-oracle
   property of single GET 404s.
5. The happy path does one grant verification and zero D1 reads for the whole
   batch.

R2 behavior:

1. Start all `env.rbox_dev_blobs.get(blobKey(sha))` calls in parallel. Sequential
   R2 inside a batch is a hard bug: the rejected d76 shape had a 3,699s lower
   bound because it serialized the R2 work behind one stream.
2. Emit data/status frames in completion order, not request order. Frames carry
   the sha, so order is free.
3. Missing sha emits a status frame with `{"status":"missing"}`.
4. Objects above `MAX_BATCH_RECORD_BYTES`, or objects that would push the
   response beyond `MAX_BATCH_BODY_BYTES`, emit
   `{"status":"too_large","size":...}`. The client retries those with the
   existing single streaming GET.
5. 32 R2 gets per request is far below the Workers subrequest budget of 1000.

This endpoint inherits §27 Amendment A verbatim. The grant is still scoped to
account + TTL and authorizes only "GET blob by sha." Batching amortizes the
verification; it does not widen the credential.

## 6. P2 - deferred to §26

Batch upload is cut from §77. Reopening upload batching means reopening
docs/design/26-batch-upload.md, whose endpoint spec is preserved there and whose
measurement gate already failed on 2026-06-30: a blob PUT measured about 126ms
total with about 120ms in the R2 write, so the bottleneck was R2 bytes rather
than fixed request overhead, and upload concurrency 32->64 won.

The reopened gate is strict: use the P0 push lane split shipped in PR #132 on a
real first publish and show that per-request/auth overhead, not local
hash/encrypt, R2 bytes, or remaining concurrency headroom, is dominant. Because
§26's own gate failed once already, the burden of proof is on P0 data.

If §26 is reopened, leave this reviewer dispute unresolved until there is data:
opus F3 argues that a batch endpoint should do no quota admission and remain
D1-zero, because the live receipts PUT path (`blobs.ts` receipts branch) does
zero admission and relies on commit-time `commitAccounting()` as the cap guard;
any orphan R2 bytes are GC-reclaimable, identical to single receipt PUTs. §26's
resolution and the codex review argue the opposite: batching amplifies the
over-cap orphan-write abuse surface, so a reopened batch upload must add
admission before accepting R2 cost. Whoever reopens §26 resolves that conflict
with measurements and an explicit abuse model.

## 7. Client coalescer

Download:

1. The P1 client work item is a DataLoader-style scatter/gather layer above
   `apply.ts`'s existing per-entry `poolMap` (`apply.ts` defaults to 128). Small
   fetches requested by independent apply tasks coalesce into one
   `POST /v1/blob-batch/get`; data/status frames then distribute back to the
   waiting decrypt+write tasks.
2. The batching stage groups small encrypted file fetches into batch-get calls
   of at most 32 shas. Four batch requests can therefore cover roughly the same
   128 in-flight blobs the current pool uses.
3. `stageEntryToTemp()` has the size and `encSha`, so the batching decision
   belongs at the apply/download boundary, not hidden inside
   `RemoteBlobStore.getToFile()` where the size hint is missing.
4. Large blobs keep the existing `getBlobToFile()` streaming GET. They are
   bandwidth-bound, and putting them into frames would add memory pressure
   without reducing the real bottleneck.
5. The client tracks the requested set of up to 32 shas. When the response ends,
   including a clean EOF, any requested sha with neither a data frame nor a status
   frame is retried via single GET. A truncated-but-well-framed stream is possible
   and is not a batching-disable event.
6. The client hashes every received data-frame payload against the frame's sha
   before writing/decrypting. The single-GET path already verifies this; batch
   frames must keep the same acceptance rule.
7. Status frames from `batch-get` are retried by single GET. A missing status
   maps to the same user-facing "remote blob not found - run rbox sync again"
   class as today's GET 404.
8. Before dispatching a batch, if the held grant is older than about 4 minutes,
   refresh it through the existing `latest()` handshake and `captureGrant()`.
   Happy path stays pre-auth; the authenticated fallback above covers races where
   a grant expires between the freshness check and the server.

Compatibility and controls:

1. New client against old server: only a genuine 404 from `/v1/blob-batch/get`
   (route absent) permanently disables batching for the session. Probe once, not
   once per batch.
2. 401, 403, 5xx, expired/invalid grants, entitlement failures, malformed frames,
   and partial response failures never disable batching permanently. They retry
   or fall back to single GET per requested sha according to the existing retry
   budget.
3. Old client against new server: unchanged; endpoints are additive.
4. `RBOX_BATCH_BLOBS=0` disables the coalescer. Batch record count, byte caps,
   concurrent batch slots, and small-blob threshold get env knobs for bench
   sweeps.
5. `RBOX_LANE_TIMING=1` remains the acceptance instrument for pull.

## 8. Phasing

1. **P0 - upload lane split.** Shipped in PR #132. It separates encrypt time
   from upload/network time per pushed blob (commit/receipt-redeem walls remain
   visible via the §35 phase report) so first-publish upload projections are
   measured, not inferred.
2. **P0.5 - server-side split.** Measured on 2026-07-07 in
   `rbox_prod_metrics`: `ok_grant_preauth` is 42.9ms total / 42.9ms R2 / 0ms D1
   across 191,251 ops, while legacy `ok` was 193.6ms total / 129.9ms D1 across
   485k ops. This makes the P1 join projection a measured request-tax removal
   plus R2-overlap claim, not an inference-only D1-removal claim.
3. **P1 - batch-get + download coalescer.** This is the adoption-facing join win.
   It is also the lower-risk half because §27 Amendment A already made the valid
   grant the credential for the read path.
4. **P2 - batch upload.** Deferred to §26. Do not implement from §77.

## 9. Projections

Measured means observed directly on the workload named in §1. Inferred means the
estimate follows from that measurement but still needs the phase acceptance run.

| Workload | Today | With batching |
|---|---:|---:|
| join 94,777 blobs / 4.9 GiB | 176s measured | 60-90s inferred; bandwidth floor 38s |
| first publish | 1,381s measured wall, lane split pending real first-publish use of P0 | deferred to §26 |
| steady-state increments | already fast (~199 KiB, seconds) | unchanged |

The join estimate no longer depends only on inference: P0.5 measured the
removable term at about 46ms of the 89.2ms client-observed per-blob fetch, and
batching also overlaps the remaining 42.9ms average R2 GET term within a batch.
The estimate keeps the 60-90s range because a batch slot completes at its
slowest member's R2 fetch, so effective parallelism is lower than
32 x concurrent batch slots. The mitigation is completion-order streaming, enough
concurrent batch slots to keep the pipe full (env-tunable, default about 8), and
the measured 42.9ms average R2 term keeping tails short. Batching trades tail
coupling for request-tax removal; the P0.5 split shows that trade is favorable.

The join estimate does not assume packed bytes or compression. R2 still performs
one GET per object.

## 10. Security

Batch-get:

1. Inherits §27 Amendment A's model. A valid grant is an account-bound,
   HMAC-signed, 5-minute credential for the narrow read action. Revoked devices
   and account deletion retain the same <=5-minute read lag for already-minted
   grants; writes and commits still authenticate normally.
2. Amortization does not widen scope. A grant still authorizes exactly `GET blob
   by sha`; a batch just verifies once and carries up to 32 shas.
3. Stolen-grant probing expands per request from one known `encSha` to 32 known
   `encSha`s. That is not a material confidentiality delta: the attacker still
   needs a live grant within TTL and still must know the ciphertext addresses.
   Unknown `encSha`s remain infeasible to guess under the E2EE model, and bytes
   are opaque ciphertext.
4. Ordering is load-bearing. Failed grant verification must never produce an
   unauthenticated account id for either the D1 fallback or the R2 path.
5. Authenticated fallback preserves the no-oracle boundary: absent and
   unentitled shas are byte-identical `{"status":"missing"}` frames.

## 11. What we are not doing

1. No packfiles or storage batching. R2 remains one object per encrypted blob.
2. No compression in this design. The 4.9 GiB encrypted-byte volume versus git's
   3.2 GB packed-byte volume is a separate future design. Compress-before-encrypt
   also has a convergence caveat: zstd output is not byte-deterministic across all
   versions/settings unless pinned as a consensus parameter.
3. No chunk/block sync. §40 remains the large-file-delta design if metrics ever
   justify changing blob granularity.
4. No multipart MIME and no large-blob framed transport. Existing single PUT,
   streaming GET, and multipart paths stay for large blobs.
5. No sequential R2 inside a batch. That is the rejected d76 failure mode.
6. No weakening of §27 grants, §23 receipts, §33 candidate-aware barriers, or E2EE
   verification.
7. No batch upload in §77. Upload batching belongs to §26 if its gate is reopened
   and passed.

## 12. Acceptance and verification

P0:

1. Upload lane timing exists from PR #132 and can be used on a real first publish
   to settle whether request/auth overhead is actually dominant before §26 is
   reopened.

P1:

1. `POST /v1/blob-batch/get` verifies grants with `verifyGrantCredential()` in
   the pre-auth branch and keeps the valid-grant path D1-zero like
   `blobGetWithVerifiedGrant()`.
2. Authenticated fallback is required and behavior-identical to today's
   `blobGet()` entitlement semantics: `isEntitled()` before R2 per sha, with
   absent and unentitled shas folded into byte-identical `{"status":"missing"}`
   frames.
3. Server tests cover actual-byte capped JSON parsing, malformed JSON, too many
   shas, bad grant fallback, valid grant D1-zero, missing sha status frame,
   too-large status frame, completion order, parallel-not-sequential R2
   scheduling, and unentitled-vs-absent no-oracle folding on the authed fallback.
4. Client tests cover old-server 404 fallback, non-404 failures not disabling
   batching, `RBOX_BATCH_BLOBS=0`, grant freshness refresh near 4 minutes,
   status-frame retry by single GET, requested-set reconciliation when a response
   omits a requested sha, data-frame sha hash verification, and effective
   in-flight count staying bounded near the existing 128.
5. Fresh join of the 94,777-blob / 4.9 GiB workload improves from 176s to the
   60-90s inferred range or records the new measured ceiling.

P2:

1. Deferred to §26. Do not implement batch upload from this document.
2. If §26 is reopened, acceptance criteria live there and must explicitly settle
   the no-admission-vs-admission dispute with data.
