# §26 — Small-blob batch upload endpoint (P1)

> Status: **design (P1 — gated by post-§23 measurements)**. Decomposes into chunks
> when scheduled.
> Depends on §23 (receipts) and §25 (server observability). **Do NOT build before
> measuring §23's effect** — this endpoint is only justified if fixed per-request
> overhead becomes the ceiling for small-blob pushes.

## Problem
After §23, a blob `PUT` is intentionally boring: auth + sha-verified R2 write + an upload
receipt, with D1 accounting deferred to commit. For a repo with thousands of tiny encrypted
blobs, the remaining cost may be one **HTTP request + auth + Worker invocation** per blob.
If §25 shows that fixed per-request overhead, not D1 or R2 bytes, dominates post-§23
small-blob pushes, batch upload can amortize that overhead across K blobs.

## Target
A `POST /v1/blobs/batch` that accepts **K small encrypted blobs in one request**, writes
each blob to R2 individually, and returns **one §23 receipt per successful frame**. This is
only a transport-layer optimization over the §23 receipt flow: the commit path still validates
receipts, grants blob refs, and charges quota.

## Non-goals
- Not an R2 multi-PUT. R2 still receives one `put(blobKey(sha), ...)` per blob, with sha
  verification per object.
- Not metadata batching. The request carries no paths, workspaces, commits, entitlement
  grants, or quota/accounting mutations; §23.4 remains the only commit-time grant/charge step.
- Not block-level delta sync. rsync/Syncthing-style block discovery, rolling checksums,
  reusable block indexes, and file reconstruction are separate future research.
- Not a large-blob path. Large blobs keep the single-PUT or multipart flow.

## Measurement gate
Only schedule implementation after §25 is live on the blob/commit path and §23 has been
deployed to dev:

1. Run the existing small-file push sweep before and after §23.
2. Confirm blob `PUT` metrics show near-zero D1 on the hot path and commit metrics show
   batched D1 work as designed in §23.4.
3. Confirm the remaining ceiling for many-tiny-blob pushes is fixed per-request work:
   request count, auth/handler time, and Worker invocation latency dominate p95/p99, while
   R2 write time tracks bytes and is not the bottleneck.
4. If D1, commit accounting, R2 bytes, or client-side hashing/concurrency still dominate,
   do not build §26; fix the measured bottleneck first.

## Wire contract
Initial format should be a compact binary frame stream, not multipart, unless multipart can
enforce the same invariants:

```
batch  = magic("RBB1") u16 frameCount frames[frameCount]
frame  = u32 payloadLen u8 shaAlg 32-byte encSha payload[payloadLen]
shaAlg = 1  // sha256 over the encrypted payload
```

Rules:
- `frameCount` is K and MUST be `1 <= K <= MAX_BATCH_FRAMES`.
- `payloadLen` is the per-frame content length and MUST be `0 < payloadLen <= MAX_FRAME_BYTES`.
- The sum of framing bytes + payload bytes MUST be `<= MAX_BATCH_BODY_BYTES`.
- `encSha` MUST match the sha256 of the encrypted payload. The server enforces this with the
  same R2 sha verification used by §23.2; a mismatch fails only that frame.
- A receipt MUST be minted from the server-measured R2 object size (`obj.size`), not from the
  client-declared `payloadLen`. If `obj.size !== payloadLen`, the frame fails and no receipt
  is returned.

## Server behavior
1. Authenticate once and derive the account from the request auth context.
2. Validate `frameCount` and total body cap before accepting work when `Content-Length` is
   present; otherwise count bytes while streaming and abort at the cap.
3. Stream-parse frames in order. For each frame:
   - reject invalid length/sha metadata before writing;
   - write exactly that frame's payload to R2 with sha verification;
   - mint a §23 receipt bound to `{ accountId, encSha, obj.size }` only after R2 accepts it;
   - record a per-frame result.
4. Bound R2 concurrency inside the request. The parser MUST NOT materialize all K payloads.

Well-formed batches return `200` with per-frame status:

```json
{
  "ok": true,
  "results": [
    { "index": 0, "sha": "hex...", "ok": true, "size": 832, "receipt": "..." },
    { "index": 1, "sha": "hex...", "ok": false, "error": "sha_mismatch" }
  ]
}
```

Request-level failures stay request-level:
- `401/403` auth failure: no frames processed.
- `413` body, frame, or K safety cap exceeded: stop processing; no receipt for unprocessed
  frames. Already-written frames are replay-safe if the client retries.
- `400` malformed framing or truncated body: no receipt for the malformed/incomplete frame.

## Partial success, replay, and retry
Partial success is expected. A successful frame has the same semantics as a successful §23.2
single `PUT`: the client can attach its receipt to the commit, and retry only frames that
returned `{ ok: false }` or produced no response.

Successful frames are replay-safe:
- Re-uploading the same `{ encSha, payload }` is an idempotent R2 write by content key.
- Reusing or reminting a receipt does not grant entitlement or charge quota.
- Double-accounting is prevented because §23.4 accounts only at commit time using
  `INSERT OR IGNORE`/new-ref semantics.

If the whole request loses its response, the client may retry the whole batch or split it
into smaller batches. That can waste upload bandwidth, but it must not create duplicate
entitlements or charges.

## Limits and memory rule
Initial operational limits should be conservative and configurable:
- `MAX_BATCH_BODY_BYTES`: start at 8 MiB; do not raise above 16 MiB without Worker memory
  tests.
- `MAX_BATCH_FRAMES`: start at 256.
- `MAX_FRAME_BYTES`: the small-blob eligibility threshold, tuned from §25 metrics.
- `MAX_BATCH_R2_CONCURRENCY`: small fixed number, e.g. 2-4.

The memory rule is load-bearing: **stream-parse frames and keep at most bounded in-flight
payload data resident**. The implementation may buffer one frame if the R2 API requires it,
but it MUST NOT buffer all K blobs. Worst-case resident payload memory must be bounded by
`MAX_FRAME_BYTES * MAX_BATCH_R2_CONCURRENCY` plus parser overhead, and every cap violation
must fail closed with the status behavior above.

## Prior-art boundary
Dropbox's [streaming-sync design](https://dropbox.tech/infrastructure/streaming-file-synchronization)
is useful here because it separates block-data transfer from metadata/FileJournal work and
uses bounded transfer requests; our equivalent separation is §23 receipts plus commit-time
accounting. Dropbox [content-hash](https://www.dropbox.com/developers/reference/content-hash)
and [Syncthing BEP](https://docs.syncthing.net/specs/bep-v1.html) are useful integrity
references because they validate bounded data units by hash. Git's
[object model](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects) is the storage
analogy: content objects stay separate from commit metadata.

That prior art does **not** make §26 a block protocol. rsync delta transfer, Syncthing-style
block availability, and Dropbox-style file blocklists would change the object/ref model and
belong in a later design. The [rsync delta-transfer](https://www.samba.org/rsync/tech_report/)
model is future research, not this endpoint.

## Chunks (when scheduled)
26.1 measurement review + go/no-go · 26.2 wire format + streaming parser · 26.3 server batch
handler + per-frame receipts · 26.4 client binning, mixed concurrency pool, and failed-frame
retry. Codex-review the parser, memory bound, and partial-failure semantics before code.

---

## Benchmarking this change (against **dev**, not prod)

Validate on the **dev** worker `rbox-dev-api` — real Cloudflare D1/R2/DO, the only place
the latency/contention this change targets actually shows up (local Miniflare has ~0
network latency and would hide it). The dev deploy is a **separate, manual** step —
**do NOT push to `main` to test**: push-to-`main` auto-deploys *prod* (`deploy-api.yml`).

```bash
# on a branch/worktree with the change (server + the client binary if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api (dev only; prod untouched)
bun build --compile --target=bun-darwin-arm64 \      # match your platform; only if the client changed
  ./src/cli/index.ts --outfile /tmp/rbox
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

- **Compare base vs head back-to-back** (deploy baseline → sweep → deploy change → sweep) so
  dev's shared-instance noise cancels — relative deltas are valid even though absolute dev
  numbers wander vs prod.
- **Drive the path this change affects:** push via `push-sweep.ts`; pull/clone-side changes
  by timing a fresh `rbox init --workspace <id>` into an empty dir (a clone-sweep is a TODO).
- **Success metric = this doc's Target/Goal section.** Once the §25 server metrics are live on
  dev you can read the server-side split (`d1Calls` / `d1Ms` / `r2Ms` per op) directly instead
  of inferring it from client wall-time — land §25 on dev first.
- Only merge to `main` (→ prod) once it's proven on dev.
- For an **isolated, repeatable** target (no contention with other dev work, wipe-and-repeat),
  set up a dedicated `[env.bench]` → `rbox-bench-api` + throwaway `rbox-bench-db`/`-blobs` and
  point `--remote` at it. (See the README "Benchmarking" section.)
