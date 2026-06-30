# rbox — engineering backlog (master index)

The single place to see everything not-yet-done, grouped by priority, each linked to
its design doc. Updated 2026-06-29. Shipped work lives in `docs/learnings.md` +
`docs/perf-improvements.md`; go-live/ops items in `docs/go-live-todo.md`.

> Priorities are **throughput-driven** (the current focus). The measured pivot:
> client-side sync is ~solved (v0.1.2); the wall is now **server-side per-blob D1
> cost** (~5 round-trips/blob). See `docs/design/22-server-throughput.md` (codex +
> Dropbox.tech research) for the analysis that orders this list.

---

## ✅ Recently shipped (for context)
- Concurrent push/pull (worker pool, default conc 32) — **v0.1.2**.
- Empty-file / dup-content / temp-collision correctness fixes — **v0.1.1**.
- Signed auto-updater (`rbox upgrade`) + CI release pipeline — **v0.1.0–0.1.2**.
- Benchmark harness (`scripts/bench/`) + concurrency sweep.

## 🔴 P0 — next, server-side throughput (the big wins)
| # | Item | Design | One-liner |
|---|------|--------|-----------|
| 1 | Upload receipts + commit-time batched accounting | [`design/23-upload-receipts.md`](design/23-upload-receipts.md) | PUT → ~R2-only; account once at commit. Kills ~5 D1 trips/blob. **Biggest win.** |
| 2 | blobRefs → R2 sidecar | [`design/24-blobref-sidecar.md`](design/24-blobref-sidecar.md) | Move the ref list out of the signed commit body; unlocks 50k-file repos. |
| 3 | Server timing / observability | [`design/25-server-observability.md`](design/25-server-observability.md) | Per-op R2/D1/DO timing → Analytics Engine. Don't optimize blind; do this around #1. |

## 🟠 P1 — after P0 measurements
| # | Item | Design | One-liner |
|---|------|--------|-----------|
| 4 | Small-blob batch upload endpoint | [`design/26-batch-upload.md`](design/26-batch-upload.md) | K tiny blobs per request → fewer HTTP/auth/Worker round-trips. Depends on #1. |
| 5 | Short-lived download capabilities | [`design/27-download-capabilities.md`](design/27-download-capabilities.md) | Batch GET tokens so pull doesn't do a D1 entitlement read per blob. |
| 6 | Account-hot metadata path | _stub below_ | If multi-tenant load appears: Account DO SQLite / sharded D1 for blob_refs+usage (D1 is single-threaded per DB). |

## 🟡 P2 — later / when measured
| # | Item | One-liner |
|---|------|-----------|
| 7 | Queues for reconciliation + GC | Orphan-R2 purge, used_bytes reconcile, webhook retry. **Never** on the commit-accept path (at-least-once/async). |
| 8 | Smart Placement / route-split Workers | Split metadata vs blob Workers; placement may help D1-heavy routes, not user→R2 uploads. Measure separately. |
| 9 | Cache API for post-auth blob reads | Only if pull stays R2-bound. Auth first, cache second, no negative caching. |

## 🧪 Smaller perf items (tracked in `perf-improvements.md`)
- **Encrypt double-pass** — `encryptFileToTemp` re-hashes plaintext the scan already hashed. Bench the win, then reuse the scan's sha. Small, client-side.
- **Chain-verify growth** — `verifyCommitChain` is history-linear on pull; add a verified-checkpoint/pin cache past some depth.
- **Download-concurrency sweep** — default 32 set by analogy with upload; sweep it directly to confirm.

## 📊 Benchmarking & observability program (`benchmarking-and-observability.md`)
Phased P0–P4. P0 (harness skeleton) partially done (`scripts/bench/`). Remaining:
micro-benches (encrypt/decrypt/diff/chain-verify), `compare.ts` regression gating,
host-adaptive e2e (Apple `container`/Docker), client telemetry (`SyncMetrics`+`doctor`),
production Analytics Engine + dashboard. Server timing is pulled forward as P0 item #3.

## 🚧 Go-live / human-gated (`go-live-todo.md`)
- `rbox.to` nameservers → Cloudflare (custom domain already live; this is the last DNS bit).
- Stripe live activation residuals; prod Clerk DNS CNAMEs.
- (Done) web dashboard, prod worker, CI auto-deploy, billing grace.

---

### Decision rules baked into this list (from §22 codex review)
- **Dumb content server, smart metadata journal** (Dropbox Magic Pocket / FileJournal):
  R2 = content-addressed bytes only; DO+D1 = sequencing + accounting. Every blob PUT
  mutating metadata is the anti-pattern we're undoing.
- **Strong consistency stays in the DO.** Never move commit head / quota / entitlements
  / GC candidates to KV (eventual) or Queues (async). Those are read-after-write critical.
- **D1 `batch()` for write coalescing**, respecting limits (100 params, 100 KB/stmt,
  single-threaded per DB).
