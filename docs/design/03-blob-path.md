# Design 03 — Production Blob Path (Milestone 3)

**Status:** draft → pending codex adversarial review
**Implements:** roadmap M3. **Decision:** D3 (direct-to-R2 / large-blob path). **Unblocks:** M2 (`.git` packs > 25MB).
**Goal:** upload and download blobs of any realistic size (hundreds of MB) without OOM on client or Worker, without the 25MB cap, and resumably (a killed daemon picks up where it left off).

---

## 1. What exists today & why it's insufficient

- Client `push` does `fs.readFile(whole file)` then PUTs the full buffer (`sync.ts` `uploadBlobs`). **Client OOM** on a large file.
- Worker `blobPut` does `req.arrayBuffer()` (buffers the whole body) and rejects > `MAX_BLOB_BYTES` 25MB (`worker.ts:17,87`). **Worker OOM + hard cap.**
- Integrity: Worker hashes the full buffer with WebCrypto (`crypto.subtle.digest`) and rejects mismatches. Correct, but **requires buffering** — WebCrypto has **no streaming digest**, which is the central constraint of this milestone.

Real `.git/objects/pack/*.pack` and large assets exceed 25MB routinely, so M2 and general use need this fixed first.

---

## 2. The central constraint: no streaming WebCrypto digest

`crypto.subtle.digest("SHA-256", buf)` needs the whole buffer. To verify a large blob's sha without buffering it, we need a **streaming** SHA-256. Options:
- **(A) Pure-JS streaming SHA-256** updated as bytes flow through a `TransformStream` in the Worker. No buffering; verifies inline. Cost: JS hashing CPU (~100–200 MB/s) counts against the Worker CPU budget. Fine for tens-to-low-hundreds of MB (our case); not for multi-GB.
- **(B) Defer verification to a Queue consumer** that streams the object back through a JS hash. Needs Cloudflare Queues (Workers Paid) + a consumer; doubles R2 egress. Heavier infra.
- **(C) Trust the client sha, never verify.** Unacceptable — a buggy/malicious client poisons the content-addressed store for everyone (worse under M7 multi-tenancy).

**Chosen: (A) for M3** — a vetted streaming SHA-256 (`src/engine/sha256-stream.ts`, also usable client-side), run in the Worker as bytes stream to R2. Inline verification, no buffering, no Queues, fully autonomous to build+verify. (B) is noted as the scale path for multi-GB blobs and is *required* later for the presigned-direct path (§6) where the Worker never sees bytes. Keep the small-blob fast path on WebCrypto (buffer+digest) below a threshold.

---

## 3. Upload protocol

A size threshold `MULTIPART_THRESHOLD` (e.g. 8 MB) splits two paths:

### 3.1 Small blobs (≤ threshold): single streaming PUT
- Client streams the file (`fs.createReadStream`, **not** `readFile`) as the request body to `PUT /v1/blobs/:sha`.
- Worker pipes `request.body` through the streaming-SHA transform into `bucket.put(key, stream)` — no `arrayBuffer()`. On stream end, compare computed sha to the URL sha; mismatch → delete the R2 object, 400. Insert blob row.
- Removes both the buffer and the cap for the common case.

### 3.2 Large blobs (> threshold): R2 multipart, resumable
Use the R2 binding multipart API (no S3 credentials needed):
- `POST /v1/blobs/:sha/multipart` → Worker `bucket.createMultipartUpload(key)` → returns `{ uploadId }`. Worker records `(sha, uploadId, partSize)` in D1 `uploads` so it survives Worker restarts and other devices.
- `PUT /v1/blobs/:sha/multipart/:uploadId/part/:n` (body = one part) → Worker `mpu.uploadPart(n, body)` (streamed), records the returned `{ partNumber, etag }` + that part's streamed-sha contribution. **Per-part integrity:** the client sends the part's own sha in a header; Worker streams-hashes the part and rejects a mismatch immediately (cheap, bounded by part size).
- `POST /v1/blobs/:sha/multipart/:uploadId/complete` { parts } → Worker verifies it has all parts, `mpu.complete(parts)`. **Whole-object sha:** since we can't re-read 300MB to hash, the client commits the full-file sha (computed via the same streaming hash during scan) and the Worker trusts the per-part-verified assembly equals it; a sampled/lazy full re-verify is the (B) Queue path, deferred. Insert blob row; clear the `uploads` row.

### 3.3 Resumable token (prior-art §5)
Client persists `.rbox/state/uploads/<sha>.json` = `{ sha, uploadId, partSize, totalParts, uploadedParts: [{n, etag, sha}] }` (atomic write). On (re)start, before uploading a missing blob, the client checks for a token: if present and the Worker still has the `uploadId` live (`GET …/multipart/:uploadId` → known parts), it resumes from the first missing part instead of restarting. A killed daemon mid-300MB-pack resumes, doesn't re-send. Tokens for completed or stale (R2-expired) uploads are pruned.

---

## 4. Download path
- Client streams `GET /v1/blobs/:sha` to a temp file (`fs.createWriteStream`), **streaming-hashing as it writes**, then verifies the sha before the atomic rename into the blob store / working tree. No buffering. (Today `getBlob` does `Buffer.from(arrayBuffer())` — replace with streamed write+verify.)
- `apply.writeEntry` already stages to temp then renames; it will consume the streamed blob rather than a full Buffer.

---

## 5. Client memory discipline
- `BlobStore.put/get` currently take/return `Uint8Array`/`Buffer` (whole-file). Add streaming variants (`putStream(sha, path)` / `getStream(sha, destPath)`) used for files over the threshold; keep the buffer API for small blobs and the local test store. The engine's `uploadManifestBlobs` and the CLI uploader switch to streaming for large files.
- Bounded-concurrency upload pool already exists; large-file streaming keeps memory flat regardless of file size or concurrency.

---

## 6. Presigned direct-to-R2 (the SaaS cost optimization) — gated on credentials
D3's end-state is bytes NOT flowing through the Worker (Worker CPU/egress cost at scale). That needs **R2 S3 API credentials** (access key id/secret + account S3 endpoint) as Worker secrets — created in the Cloudflare dash / via an account-scoped API token rbox's current Worker token may not be able to mint. **This is the one piece that may require human provisioning** (creating an R2 API token).

Plan: implement presigned PUT/GET generation in the Worker with **aws4fetch** (tiny, workerd-native — avoids the `@aws-sdk` bundling pain documented in prior-art §7). Gate it on the presence of the R2 credential secrets: if present, `/v1/blobs/:sha/upload-url` returns a presigned URL and the client uploads directly to R2 (verification then MUST be the (B) Queue path, since the Worker never sees bytes); if absent, the client transparently falls back to the streaming-through-Worker path (§3). So M3 ships fully working without the credentials, and flipping on presigned later is a secret + a Queue, not a rewrite. **Flagged as the expected human-intervention point.**

---

## 7. Files touched

| File | Change |
|---|---|
| `src/engine/sha256-stream.ts` | **new** — streaming SHA-256 (shared client + Worker) |
| `apps/api/src/worker.ts` | streaming PUT (no cap/buffer for ≤threshold); multipart endpoints; streamed GET; keep small-blob WebCrypto fast path |
| `apps/api/migrations/0002_uploads.sql` | **new** — `uploads(sha, upload_id, part_size, created_at)` for resumable multipart |
| `apps/api/src/presign.ts` | **new** — aws4fetch presigned URLs, credential-gated (§6) |
| `src/engine/blobstore.ts` | streaming `putStream`/`getStream` variants |
| `src/cli/remote.ts` | streaming upload/download; multipart client; resume check |
| `src/cli/sync.ts` | uploader uses streaming for large files; resumable token persistence |
| `apps/api/wrangler.jsonc` | (later) R2 credential secrets + optional Queue binding for (B) |

---

## 8. Verification plan
**Unit:** streaming SHA-256 matches WebCrypto on known vectors and on a multi-MB random buffer; resumable token round-trips; download verify rejects a corrupted stream.

**Local/live:** deploy; upload a 50MB and a 200MB random file (well past the old 25MB cap) → succeeds; `GET` streams back byte-identical (sha verify). Kill the client mid-large-upload, restart → resumes from the persisted token, doesn't re-send completed parts. Corrupt one part's claimed sha → Worker rejects that part.

**Cross-machine + M2 readiness:** on the prod host, sync a directory containing a >25MB file Mac↔prod (proves the cap is gone end-to-end), which is the prerequisite M2 needed.

## 9. Open questions for review
1. Streaming JS SHA-256 in the Worker — is the CPU cost within Workers' limits for ~200MB? Where's the realistic ceiling before (B) Queue verification becomes mandatory?
2. Whole-object integrity for multipart: is per-part-sha + client-committed full-sha acceptable for M3 (trusted dev), with full re-verify deferred to (B)? Or must M3 guarantee full-object verification inline?
3. R2 binding limits: max single `put` stream size; max parts / part-size constraints (R2 multipart min part size 5MiB except last?). Confirm thresholds.
4. Does `bucket.put(key, request.body)` actually stream without buffering in workerd, and is `request.body` re-readable if we also tee it for hashing? (TransformStream tee semantics.)
5. Presigned sequencing: ship M3 on streaming-through-Worker now and treat presigned+Queue as a follow-up needing the R2 token (human), or block M3 on provisioning?
6. Multipart upload TTL in R2 (incomplete uploads) vs our resumable token lifetime — prune policy.
