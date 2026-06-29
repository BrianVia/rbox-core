# §16 — Server-side throughput review (codex, research-grounded)

> Codex adversarial review of `docs/architecture.html` + `perf-improvements.md` +
> `benchmarking-and-observability.md` + the server hot path, with **live research**
> from the Dropbox engineering blog (dropbox.tech) and Cloudflare primary docs.
> Brief: how to reach Dropbox-like throughput; weigh every Cloudflare primitive.
> Run: 2026-06-29. This is the design basis for the next (server-side) cycle.

**Bottom Line**
Yes: “make PUT ~R2-only and move blob metadata/accounting to commit-time batching” is the right next move. But not as a straight code shuffle. If `PUT` stops writing `blob_refs`, current commit validation breaks because [missingBlobs](/Users/via/Development/Personal/rbox-core/apps/api/src/workspace-sync.ts:159) only trusts D1 entitlements, while [blobPut](/Users/via/Development/Personal/rbox-core/apps/api/src/blobs.ts:52) currently grants entitlement immediately after R2 hash verification. The design needs upload receipts plus a commit-time grant transaction.

**Dropbox Lessons**
Dropbox’s useful lesson is not “use their infra”; it is the separation of concerns. Magic Pocket stores immutable encrypted content blocks, while mutability lives above it in FileJournal. That maps cleanly to rbox: R2 should be the dumb content-addressed byte store; DO/D1 should own commit/accounting metadata. ([dropbox.tech](https://dropbox.tech/infrastructure/inside-the-magic-pocket))

Dropbox’s older sync protocol also had the same shape rbox wants: commit blocklist, receive “need blocks”, upload blocks, retry/finish commit. Crucially, the block data server is just hash-to-encrypted-content, while metadata/namespace sequencing is elsewhere. ([dropbox.tech](https://dropbox.tech/infrastructure/streaming-file-synchronization)) rbox should borrow the batching/journal shape, not Dropbox’s plaintext namespace model.

Nucleus reinforces that correctness comes from a strict data model and one clear control thread for coordination. rbox’s WorkspaceSync DO is the right primitive for per-workspace commit sequencing. Do not weaken that with KV or Queue-based commit advancement. ([dropbox.tech](https://dropbox.tech/infrastructure/-testing-our-new-sync-engine))

The Dropbox metadata caching lesson also matters: clients relied on read-after-write metadata semantics, so weak caches were not acceptable. ([dropbox.tech](https://dropbox.tech/infrastructure/meet-chrono-our-scalable-consistent-metadata-caching-solution)) For rbox, KV is fine for read-mostly non-authoritative data, but wrong for commit heads, entitlements, GC condemnation, or quota.

**Primitive Calls**
- **D1 batch/transactions: YES, P0.** Cloudflare explicitly says `batch()` reduces D1 round trips and runs statements transactionally; use it for commit-time accounting. Respect D1 limits: 100 bound params, 100 KB statement, 30s query/batch ceiling, and single-threaded DB throughput. ([developers.cloudflare.com](https://developers.cloudflare.com/d1/worker-api/d1-database/?utm_source=openai)) ([developers.cloudflare.com](https://developers.cloudflare.com/d1/platform/limits/))
- **D1 indexes: NOT THE HOT FIX.** Existing `(account_id, sha256)` PK fits entitlement checks. Add `blob_refs(sha256)` later for GC/purge, not first-sync throughput.
- **R2: YES for bytes and sidecar objects.** R2 writes are strongly consistent and can verify `sha256`; use it for blob PUTs and blobRef sidecars. There is no batch PUT, but delete supports up to 1000 keys for GC. ([developers.cloudflare.com](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/))
- **R2 multipart: YES for large single blobs only.** It does not solve many-small-files. Keep current MPU path, but do not make small files multipart.
- **R2 conditional writes: LIMITED.** Good for idempotent sidecars. Do not use conditional no-op as possession proof; rbox needs the server to receive bytes and R2 to verify `sha256`.
- **Durable Object: YES for sequencing; MAYBE for account accounting.** Workspace DO stays the commit sequencer. Add an AccountAccounting DO if exact quota/ref grants are hard to express safely in D1 batch. Do not route every blob PUT through a DO.
- **Queues: NO for the commit hot path. YES for GC/reconciliation.** Queues are at-least-once and async; good for orphan cleanup, reconciled usage, webhook retries, slow analytics. Wrong for “commit accepted means blobs are readable.” ([developers.cloudflare.com](https://developers.cloudflare.com/queues/reference/how-queues-works/?utm_source=openai))
- **KV: NO for authoritative sync state.** Eventually consistent, cached reads can be stale. Wrong for head, quota, entitlements, missingBlobs, GC candidates. ([developers.cloudflare.com](https://developers.cloudflare.com/kv/concepts/how-kv-works/?utm_source=openai))
- **Analytics Engine: YES.** Use it for bucketed latency/throughput metrics, not correctness. The existing observability doc’s privacy constraints are right. ([developers.cloudflare.com](https://developers.cloudflare.com/analytics/analytics-engine/get-started/?utm_source=openai))
- **Smart Placement: WHEN measured.** It may help D1-heavy metadata endpoints, but blob uploads are user-to-R2 heavy. Consider splitting metadata and blob Workers before enabling globally. ([developers.cloudflare.com](https://developers.cloudflare.com/workers/configuration/placement/?utm_source=openai))
- **Cache API: MOSTLY NO.** Not for auth/metadata. Maybe later for post-auth encrypted blob GETs, with auth checked before cache lookup; it is per-datacenter and not a sequencing tool. ([developers.cloudflare.com](https://developers.cloudflare.com/workers/runtime-apis/cache/?utm_source=openai))
- **Hyperdrive: NO.** It is for external databases with connection pooling/query caching, not D1/R2/DO-native rbox. ([developers.cloudflare.com](https://developers.cloudflare.com/hyperdrive/?utm_source=openai))

**P0 Recommendations**
1. **Move blob grants/accounting to commit-time, with upload receipts.**  
   Change: `PUT /v1/blobs/:sha` does auth + R2 `put(..., { sha256 })`, returns signed/HMAC receipt `{account, sha, size, uploadedAt, exp}`. Commit accepts refs that are already entitled or have valid receipts, then performs one batched grant/accounting step before advancing head.  
   Impact: removes the measured ~5 D1 round trips per blob from [blobPut](/Users/via/Development/Personal/rbox-core/apps/api/src/blobs.ts:66) and [grantEntitlementWithQuota](/Users/via/Development/Personal/rbox-core/apps/api/src/billing.ts:39); 1041 blobs goes from ~5200 D1 trips to O(chunks). This is the biggest throughput win.  
   Risk: quota shifts from per-blob fail-fast to commit-time rejection; failed/abandoned uploads create orphan R2 bytes until GC. Mitigate with receipt TTL shorter than GC grace, optional one-shot upload reservation/preflight, and orphan cleanup Queue.

2. **Make commit-time accounting exact, not approximate.**  
   Change: update `used_bytes` synchronously for newly granted refs only. Prefer one AccountAccounting DO per account if D1 SQL cannot safely compute “new refs sum” in one transactional batch.  
   Impact: preserves billing correctness while removing per-PUT D1 pressure.  
   Risk: concurrent commits across workspaces in the same account can double-charge if implemented as “SELECT existing in Worker, then UPDATE” outside a serialized transaction. Avoid that.

3. **Move `blobRefs` out of the signed commit body.**  
   Change: store a compact canonical sidecar in R2, referenced by hash/count from the signed body. DO fetches/parses it for validation/accounting/GC roots.  
   Impact: required for 50k-file repos; current 1 MB cap is explicitly interim in [workspace-sync.ts](/Users/via/Development/Personal/rbox-core/apps/api/src/workspace-sync.ts:4).  
   Risk: GC `roots()` currently parses refs from DO-stored commit bodies; sidecar design must update GC to fetch sidecars or maintain a compact retained-root index.

4. **Add server timing before and after P0.**  
   Change: structured route timings for R2/D1/DO and Analytics Engine datapoints with bucketed dimensions only.  
   Impact: not a throughput win by itself, but prevents optimizing blind; current docs correctly call server timing the visibility gap.  
   Risk: telemetry metadata leakage. Keep the ban list in [benchmarking-and-observability.md](/Users/via/Development/Personal/rbox-core/docs/benchmarking-and-observability.md:262).

**P1 Recommendations**
5. **Add a small-blob batch upload endpoint only after P0 measurements.**  
   Change: batch K tiny encrypted blobs per request, cap body at maybe 8-16 MB, still write each object to R2 with sha verification.  
   Impact: reduces HTTP/auth/Worker invocation overhead for many tiny files.  
   Risk: Worker buffering/parser complexity; not a substitute for commit-time D1 batching.

6. **Introduce short-lived download capabilities.**  
   Change: after latest/commit sidecar validation, issue per-blob or batch-scoped GET tokens so pull does not perform a D1 entitlement read per blob.  
   Impact: improves clone/pull throughput after upload is fixed.  
   Risk: token expiry/revocation/GC candidate semantics must be tight.

7. **Move account-hot metadata off the single global D1 path if multi-tenant load appears.**  
   Change: Account DO SQLite or per-account/per-shard D1 for `blob_refs` and usage, with D1 as mirror/admin index.  
   Impact: avoids one D1 database becoming the serialized write bottleneck for all users; Cloudflare notes each D1 DB processes queries one at a time. ([developers.cloudflare.com](https://developers.cloudflare.com/d1/platform/limits/))  
   Risk: operational complexity and migrations.

**P2 Recommendations**
8. **Queues for reconciliation and GC, not acceptance.** Use Queues to reconcile `used_bytes`, purge orphan R2, retry failed mirrors, and audit. Never let “commit accepted” depend on a future queue consumer.
9. **Smart Placement or route-split Workers.** Metadata routes may benefit; blob routes may not. Measure separately.
10. **Cache API for post-auth blob reads only if pull remains R2-bound.** Auth first, cache second, no negative caching.

**What I’d Do First**
1. Design and implement upload receipts + commit-time batched grants/accounting. Remove per-PUT quota/accounting D1 from the small-blob hot path.
2. Move `blobRefs` to an R2 sidecar in the same protocol pass, because 50k-file support otherwise still fails at commit size.
3. Add server timing around `blobPut`, commit validation, D1 batch, R2 put/head, and DO transaction, then rerun the existing concurrency sweep.

The Dropbox lesson that changes my thinking most: Dropbox’s block server is deliberately dumb, and metadata advances in a journal/namespace layer. rbox currently violates that by making every content PUT mutate metadata. The fix is not just batching; it is restoring that boundary.
