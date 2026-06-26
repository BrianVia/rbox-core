# Design 03 — Production Blob Path (Milestone 3)

**Status:** ✅ IMPLEMENTED & VERIFIED. Design review #1 (2 blockers + 7 majors) + implementation code review (3 High + 1 Medium) — all resolved. Live-verified against deployed `rbox-dev-api`: 50MiB single-PUT, 120MiB multipart, resume-from-partial, concurrent same-sha, wrong-sha rejection, and a 40MB file synced cross-machine Mac↔prod (the cap is gone — M2 unblocked).

**Code-review fixes applied:** multipart assembles into a per-upload **staging key** and publishes to canonical only via `put(..., {sha256})` (R2 verifies on publish; canonical never written with unverified bytes nor deleted by a bad/losing upload — this also removed the bespoke JS hash from the verify path); `uploads` keyed by `upload_id` (not sha) so concurrent same-sha uploads don't clobber; created_at-based expiry → 410 so dead resumes don't wedge (client retries once fresh, or adopts a concurrently-finished blob); cleanup-always after a consumed MPU; partial temp files removed on any error in `getBlobToFile` and `apply.writeEntry`.
**Implements:** roadmap M3. **Decision:** D3 (direct-to-R2 / large-blob path). **Unblocks:** M2 (`.git` packs > 25MB).
**Goal:** upload and download blobs of any realistic size (hundreds of MB) without OOM on client or Worker, without the 25MB cap, and resumably (a killed daemon picks up where it left off).

---

## 1. What exists today & why it's insufficient

- Client `push` does `fs.readFile(whole file)` then PUTs the full buffer (`sync.ts` `uploadBlobs`). **Client OOM** on a large file.
- Worker `blobPut` does `req.arrayBuffer()` (buffers the whole body) and rejects > `MAX_BLOB_BYTES` 25MB (`worker.ts:17,87`). **Worker OOM + hard cap.**
- Integrity: Worker hashes the full buffer with WebCrypto (`crypto.subtle.digest`) and rejects mismatches. Correct, but **requires buffering** — WebCrypto has **no streaming digest**, which is the central constraint of this milestone.

Real `.git/objects/pack/*.pack` and large assets exceed 25MB routinely, so M2 and general use need this fixed first.

---

## 2. Integrity without buffering: R2-native sha + post-complete verify **[R#1-BLOCKER]**

`crypto.subtle.digest` needs the whole buffer (no streaming WebCrypto). Per-part SHAs **cannot** prove the whole-object SHA (SHA-256 isn't composable) — the prior draft's "per-part + client full-sha" was an integrity hole. Resolved per path:

- **Single PUT → R2 native integrity.** `bucket.put(key, request.body, { sha256: <expected> })` makes **R2 verify the content hash server-side** and reject a mismatch. No JS hashing, no buffering, plan-agnostic. This is the clean fix codex pointed to; the bespoke streaming-JS-hash in the Worker is unnecessary for single PUT.
- **Multipart → post-complete full-object verify.** After `mpu.complete`, the Worker `bucket.get(key)` and streams the assembled object through a JS streaming SHA-256 (`src/engine/sha256-stream.ts`), compares to the claimed sha, and **only then inserts the `blobs` row** (mismatch → delete object + 412). One extra full read; CPU is fine on Paid for moderate sizes (note the ceiling). For multi-GB / scale this moves to a **Queue consumer** (Queues confirmed available) — same code, async — that's the documented scale path, not M3.
- **Never `tee()` to hash+store [R#1-MAJOR]** — the slower branch buffers unboundedly. Single-consumer streams only (R2-native for PUT; pass-through hashing transform for downloads).
- A buggy/malicious client therefore can never land bytes that don't match their content address (the threat C the draft rejected).

---

## 3. Upload protocol — single PUT vs multipart, bounded by CF's body cap **[R#1-BLOCKER]**

Cloudflare caps inbound request bodies (~100MB Pro/standard) **independent of our app cap** — so streaming a single `request.body` removes our 25MB limit but not CF's. Therefore:

- `SINGLE_PUT_MAX = 90 MiB` (margin under the 100MB CF cap). Files ≤ this use single PUT; **> this MUST use multipart.**
- Multipart part sizing respects R2 limits **[R#1-MAJOR]**: 5 MiB min (except last), 5 GiB max, ≤ 10,000 parts, uniform non-final sizes. `partSize = max(8 MiB, ceil(total / 9000) rounded up to MiB)` so even multi-GB files stay under 10,000 parts. All sizes in MiB constants.

### 3.1 Single PUT (≤ 90 MiB)
- Client streams the file (`fs.createReadStream`, never `readFile`) as the body to `PUT /v1/blobs/:sha`.
- Worker: `bucket.put(blobKey(sha), request.body, { sha256: sha })` — streamed, R2-verified. Insert blob row. (Keep a tiny in-memory fast path only for very small blobs if measurably simpler.)

### 3.2 Multipart (> 90 MiB), resumable
- `POST /v1/blobs/:sha/multipart` { size } → Worker computes partSize, `bucket.createMultipartUpload(blobKey)` → persists `uploads(sha, upload_id, part_size, total_parts, size, created_at)` in D1. Returns `{ uploadId, partSize, totalParts }`.
- `PUT /v1/blobs/:sha/multipart/:uploadId/part/:n` (body = one part ≤ partSize) → `bucket.resumeMultipartUpload(blobKey, uploadId).uploadPart(n, request.body)` (streamed). Persist `upload_parts(upload_id, part_number, etag, size, created_at)` — **server-authoritative part state [R#1-MAJOR]**. (Per-part client sha optional sanity check; the real integrity gate is the post-complete whole-object verify.)
- `POST /v1/blobs/:sha/multipart/:uploadId/complete` → load parts from `upload_parts` (ordered), `mpu.complete(parts)` using the stored `R2UploadedPart.etag` values **[R#1-MINOR: composite ETag is not the content hash]**; then **post-complete verify (§2)**; on success insert `blobs` row + clear `uploads`/`upload_parts`; on mismatch delete object + 412.

### 3.3 Resumable token (prior-art §5) — server is the source of truth **[R#1-MAJOR]**
Client persists `.rbox/state/uploads/<sha>.json` = `{ sha, uploadId, partSize, totalParts }` as a **cache/hint** (atomic write). On (re)start, before uploading a missing blob the client asks the server `GET /v1/blobs/:sha/multipart/:uploadId` → server returns the authoritative set of completed part numbers from `upload_parts`; client resumes from the first missing part. If the server doesn't know the uploadId (R2's 7-day TTL elapsed / never existed), the client starts fresh. A killed daemon mid-large-pack resumes; it never trusts its local token over server state.

---

## 4. Download path — streamed end-to-end, including apply **[R#1-MAJOR]**
- Client streams `GET /v1/blobs/:sha` to a temp file (`fs.createWriteStream`), **streaming-hashing as it writes** (single pass-through, no tee), verifies the sha, then renames. No buffering. Today `remote.getBlob` does `Buffer.from(arrayBuffer())` (`remote.ts:46`) — replace with streamed write+verify.
- **`apply.writeEntry` must also stream [R#1-MAJOR].** Today it does `store.get(sha)` (whole Buffer) then `fs.writeFile(tmp, bytes)` (`apply.ts:90`). Change to stream the blob into the existing temp file, then the precondition-check + rename flow runs unchanged. So large blobs never materialize in client memory on either upload or download.
- Both upload buffering sites are plumbed to streaming **[R#1-MAJOR]**: `sync.uploadBlobs` (`sync.ts:48`) and `engine.uploadManifestBlobs` (`apply.ts:24`) switch to streaming variants for files over a small threshold.

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
| `apps/api/migrations/0002_uploads.sql` | **new** — `uploads(sha, upload_id, part_size, total_parts, size, created_at)` + `upload_parts(upload_id, part_number, etag, size, created_at)` (server-authoritative resumable state) |
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

## 9. Review #1 resolutions
- [x] BLOCKER multipart whole-object integrity → §2 (R2-native `sha256` for single PUT; post-complete full-object re-hash before inserting `blobs` for multipart; per-part shas never trusted as the whole)
- [x] BLOCKER CF request-body cap → §3 (`SINGLE_PUT_MAX=90MiB`; multipart mandatory above; documented)
- [x] MAJOR no `tee()` → §2/§4 (R2-native sha for PUT; single-consumer pass-through hash for downloads)
- [x] MAJOR JS-SHA CPU → Paid confirmed; post-complete hash bounded; Queue path noted for multi-GB
- [x] MAJOR resumable server state → §3.2/§3.3 (`upload_parts` authoritative; client token is a cache; `resumeMultipartUpload`)
- [x] MAJOR R2 multipart constraints → §3 (MiB constants; 5MiB min/5GiB max/10k parts; dynamic partSize; 7-day TTL)
- [x] MAJOR download/apply streaming → §4 (stream into `apply.writeEntry` temp/precondition/rename; both upload sites streamed)
- [x] MINOR presigned provisioning → §6 ("provisioning required", attempt via API token, fallback to streaming)
- [x] MINOR ETag → §3.2 (use `R2UploadedPart.etag` for complete only; never as content-address)

**M3 scope to unblock M2:** single-PUT (R2-native-verified) lifts the cap to 90MiB — covers typical git repos immediately; multipart (verified, resumable) covers the rest. Presigned-direct is an additive cost optimization, credential-gated, with a transparent streaming fallback so M3 ships and verifies fully without it.
