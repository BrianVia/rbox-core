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
| 3 | Server timing / observability **✅ SHIPPED** | [`design/25-server-observability.md`](design/25-server-observability.md) | Done (`babacb3`): `metrics.ts` (OpSpan + D1-binding proxy + `startOp`), instrumented request/commit/blob.*/multipart.*; → Analytics Engine. Live baseline: `blob.put` = **7 D1 calls, ~956ms (89% of its time)** — §23's target. Schema+SQL: [`observability-server-metrics.md`](observability-server-metrics.md). |

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
| 10 | Block-level hashes / delta-index / streaming overlap | Future-only, gated behind P0 server-throughput work + measurements: Dropbox-style block hashes, rsync/Syncthing-style delta indexes, and need-block/upload-download overlap. Not part of the current server-D1 fix. |

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

- **Client fetch timeouts (bench finding, 2026-07-03):** a one-shot `rbox init --workspace` hung 110 minutes at 0 CPU inside a rig guest — a blob/commit fetch black-holed and the CLI awaits forever (no timeout/abort on sync-path fetches; retry-on-same-args succeeded instantly). Design 45 gave the status probe an AbortController for exactly this class; push/pull/init network calls need the same treatment (generous timeouts + bounded retry, careful not to abort legitimately slow big-blob transfers — size/progress-aware deadlines rather than flat ones).

- **Workers `ratelimits` binding silently no-ops (platform, 2026-07-04):** design 64's rate limiters deploy cleanly (wrangler ≥4.107 binds all five with correct numbers on dev+prod) but `.limit()` resolves `{success:true}` unconditionally — verified with a minimal throwaway worker (fixed key, `limit: 2, period: 60`, 10 sequential requests, zero refusals, zero throws). Not our config: the guard, keys, and binding names are correct; the failure is account/platform-side (namespace never enforcing). The guard fails open by design so nothing breaks; the D1 device cap (the per-account backstop) enforces independently and its tests pass. Follow-ups: (a) re-probe occasionally (the first probe run showed brief enforcement, so provisioning may be laggy), (b) consider a zone WAF rate-limiting rule on `api.rbox.to/v1/auth/*` as the enforcing layer meanwhile (design 64 §3.4 backstop — dashboard config, document in AGENTS.md if added), (c) if it persists, Cloudflare support ticket with the probe repro.

- **Gitcap upload hardening (stress-test finding, 2026-07-06):** a 140-repo first push lost its largest repo (6GB git bundle) to `blob PUT rejected: ciphertext no longer hashes to declared encSha` — the ciphertext temp lives in `os.tmpdir()` across the entire hash-pass→multipart-upload window (`src/engine/crypto.ts:113` → `src/cli/remote/multipart.ts:74`, minutes-long for GB blobs) and something external (tmp reaper / disk-pressure eviction / a stray cleanup) truncated it there. Code trace confirmed rbox's own ordering is race-free (every cleanup awaits the upload; unique mkdtemp per repo; concurrency-4 pool is per-dir isolated). Three fixes, all shovel-ready: (a) stage gitcap under the repo's `.rbox` instead of `os.tmpdir()` — the apply side already refuses `os.tmpdir()` for exactly this hazard (`apply.ts:146-148`); capture never got the same treatment; (b) retry parity: file blobs re-encrypt + retry on `BlobShaMismatchError` (`sync-recovery.ts:134-141`) but the git path has no catch anywhere between `putGitArtifact` and the per-repo deferral (`sync-git.ts:321`) — one transient fault permanently defers the repo's cycle; (c) pass `uploadsDir` for git multipart (`src/cli/remote/api.ts:178` omits it) so GB-scale uploads resume instead of restarting. Note: 4-way capture concurrency stages up to ~4×(bundle+ct) in tmp at peak — (a) also relieves that pressure.

- **Push-path network resilience + error translation (stress-test finding #2, 2026-07-06):** the same 140-repo initial push later died wholesale on ONE transient socket close near the end (`✗ rbox: The socket connection was closed unexpectedly. For more information, pass \`verbose: true\` in the second argument to fetch()`): (a) confirms the client-fetch-timeouts backlog item above and raises it — a multi-GB first push is exactly when a transient TCP fault is near-certain, and today it discards the whole run (content-addressed blobs DO dedupe on re-run via the has-check, so a retry is cheap — the CLI just never takes it); bounded retry-with-backoff on transient network faults for uploads/commits is the fix, careful to distinguish from server 4xx/5xx which translateRemoteError already owns; (b) the raw Bun fetch error string leaks verbatim through the `✗ rbox:` format — network-layer exceptions need translation to a human message that says the one thing the user needs: "safe to re-run, uploaded data is skipped." Gitcap bundles are NOT cached across runs (re-run redoes ~35 min of bundling on that tree) — worth noting in whatever design picks this up.

- **Daemon scan must tolerate vanishing files (crash, 2026-07-06):** the 0.8.0 daemon on ~/Development died fatally (`✗ rbox: ENOENT ... open '.../worktrees/progress-report/skills-lock.json'`) when a file was deleted between the scan walk and the hash read — an unhandled ENOENT killed the whole daemon (autostart's no-KeepAlive design means it stayed down until manually restarted). Agent-heavy workspaces churn worktrees constantly, so this TOCTOU is routine, not exotic. Fix: drainHashes/scan treats ENOENT/ENOTDIR on individual entries as "file gone — drop from manifest this cycle," never fatal; audit the pull/apply side for the same hazard.

- **Multipart resume can accept a GC-condemned blob (design-73 review find, 2026-07-06):** the receipts-protocol `/v1/blobs/check` path ignores `gc_candidates` (only the legacy branch checks them — `apps/api/src/blobs.ts:54` vs the legacy `missingBlobs` NOT-EXISTS), so `putBlobMultipart`'s complete-failed fallback (`src/cli/remote/multipart.ts:109`) can declare success for a `present=1` + entitled + condemned blob. Self-heals at commit (validateCommitRefs' candidate barrier forces re-upload) so the cost is a wasted upload cycle, not data — but the check paths should agree. Fix: fold the `gc_candidates` exclusion into the receipts-path check query (same NOT-EXISTS the other three satisfiability queries use).

- **Daemon ignores SIGTERM mid-multipart (2026-07-06, observed twice):** a daemon deep in a GB-scale multipart upload never reaches its shutdown check — `rbox stop` sends SIGTERM, the process keeps uploading for minutes (tonight: until SIGKILL). Two restarts in a row needed `kill -9`, which also discards receipts held in memory. Fix: check a shutdown flag between multipart parts (8 MiB granularity is a fine drain point) and persist/abandon cleanly; `stop` should say "draining (large upload in progress)" instead of silently hanging.
