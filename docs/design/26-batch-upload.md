# §26 — Small-blob batch upload endpoint (P1)

> Status: **design (P1 — after §23 measurements)**. Decomposes into chunks when scheduled.
> Depends on §23 (receipts). **Do NOT build before measuring §23's effect** — §23 may
> already make first-push fast enough that the extra HTTP overhead doesn't dominate.

## Problem
Even with §23 (PUT = R2-only) and client concurrency 32, a many-tiny-files repo pays one
**HTTP request + auth + Worker invocation** per blob. For thousands of <1 KiB files that
per-request overhead (not D1, not R2 bytes) can become the next ceiling once §23 removes
the D1 cost. Dropbox's streaming-sync protocol batches block transfers for exactly this.

## Target
A `POST /v1/blobs/batch` that accepts **K small encrypted blobs in one request**, writes
each to R2 (sha-verified, individually — R2 has no multi-PUT), and returns **K receipts**.
Cuts request/auth/invocation overhead by ~K×; large blobs keep the single-PUT/multipart path.

## Sketch (to be chunked at scheduling time)
- Wire format: length-prefixed frames `[u8 shaLen? | 32-byte sha | u32 size | bytes]×K`, or
  multipart. Cap total body ~8–16 MB and K (e.g. ≤256) so the Worker can buffer safely.
- Server: auth once; for each frame, R2 `put(sha-verified)`; collect failures per-frame
  (partial success allowed — return per-blob `{sha, ok|err, receipt?}`). Concurrency within
  the request bounded.
- Client: bin pending small blobs (< some threshold) into batches; large blobs stay single.
  Mix batched + single uploads under the same concurrency pool.

## Risks / open
- Worker memory: buffering K blobs — enforce the body cap; stream-parse frames, don't hold all.
- Partial failure semantics + retry of just the failed frames.
- Interacts with §23 receipts (batch returns receipts) and the §23.5 quota advisory.
- **Measure first:** instrument §25 to confirm per-request overhead is actually the ceiling
  post-§23 before building this.

## Chunks (when scheduled)
20.1 wire format + parser · 20.2 server batch handler + per-frame receipts · 20.3 client
binning + mixed pool. Codex-review the buffering/partial-failure model.
