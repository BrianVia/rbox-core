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
