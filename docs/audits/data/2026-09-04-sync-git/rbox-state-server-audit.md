# State plane and sync server audit — 2026-09-04

Read-only audit of current worktree. Repository files unchanged. Experiments wrote scratch files/databases only under /private/tmp or OS temporary directory. All timings are single local Bun runs, not fleet or production measurements. Installed Bun is 1.3.14; package.json declares ^1.4.0. No production reads or writes performed.

## Verdict

The durable ownership model is substantially stronger than a naive file-sync implementation: SQLite owns the logical checkpoint, sealed artifacts bind CAS inputs, git effects retain distinct physical recovery, DO storage owns the remote sequence, and D1 accounting precedes publication. Preserve that. The most important remaining work is to remove workspace-sized transport, close post-commit liveness gaps, and put actual garbage collection behind the already-normalized local state. These are higher-value changes than splitting files.

Current local delta staging and loaded-state memo are IMPLEMENTED, so the August 18 audit's repeated-state-load complaint must not be presented as an unfixed issue. The same audit's single-carrier transport proposals remain unimplemented in the current files inspected.

## Verified findings and priorities

### 1. Local interned values grow without runtime reclamation; the existing collector lacks its essential index

**P1 operational durability/performance. Reproduced using production save path.**

- `src/cli/state-plane/store/plane-promotion.ts:115` interns every exact value; equality at :26 includes mtime, so even touch-only changes make distinct rows.
- `:126` / `:177` replace live plane references, leaving the old `entry_values` rows behind.
- `:193` exports `collectUnreferencedEntryValues`, but `rg -n collectUnreferencedEntryValues src scripts` finds only the definition, facade export, and mutator-audit allowlist. No runtime caller was found. This is an unused maintenance mechanism, not a proven dead feature to delete.
- `src/cli/state-plane/schema/v1.ts:81` defines `plane_entries`; the PK is `(lineage_id,plane,path)` and the other index is `(lineage_id,plane,path_order)`. Neither indexes `entry_id`.
- 50 actual saves of one unchanged-content file with differing mtimes produced **50 interned values, one live plane row**. Calling the existing collector removed 49.
- EXPLAIN for the collector showed `SCAN entry_values`, correlated `SCAN p`, and an additional FK `SCAN plane_entries`. Consequently, naively adding this full collector after each save can be disastrous.
- Scratch comparison with 3,000 live files and two versions (6,000 values): existing collector deleted 3,000 in **873.9 ms**. Same rows after rollback, then a scratch covering index on `plane_entries(entry_id,path,path_order)`: **11.3 ms**, approximately **77x faster**. This is collector-only, not sync speedup; index changes were solely in the temporary DB.

**Implement:** a sanctioned schema migration adding a reverse-reference index; StateStore-owned bounded orphan reclamation, ideally driven by entry IDs whose references were replaced/deleted in that transaction. Account for BASE and LOCAL referencing the same value. Idle incremental compaction is a separate physical-space concern: DELETE alone does not shrink a SQLite file. Expose live vs orphan count/bytes and a disk growth budget. Do not run unbounded GC under the sync mutex or issue full VACUUM per save.

**Gate:** long churn workload reaches bounded orphan backlog; shared values survive until the last plane reference disappears; indexed query plan; crash before/after cleanup; database-full recovery; validate supported old-binary/schema behavior.

### 2. Alarm failure after remote acceptance suppresses the fanout and ACK, and restart does not repair the missing alarm

**P1 liveness / uncertain publication outcome. Reproduced in a production-class stub, not real workerd.**

- `apps/api/src/workspace-sync.ts:714-740`: synchronous transaction advances head, writes signed commit, marks index lagging.
- `:758`: `await this.armAlarm(Date.now())` can throw before `:760` broadcast, `:768` D1 mirror, or successful response.
- `:894`: armAlarm calls asynchronous getAlarm/setAlarm.
- `:284`: initializeIndex immediately returns whenever `index_state` is already set; existing lagging state is not used to rearm a missing alarm on rehydration.
- Scratch experiment instantiates production WorkspaceSync with stub KV/D1/WS and injects setAlarm failure. Observed: `head=1`, `index_state=lagging`, request throws, **zero frames and zero mirror writes**. Retry is 409 head=1. Rehydrated /latest is 200 with the committed value, but no alarm is scheduled and index remains lagging.
- This does **not** prove data loss or actual Cloudflare persistence behavior: transaction is a synchronous in-memory stub, and real platform errors may affect the isolate differently. It does prove the source-level ordering and lack of bootstrap rearm.
- A **later successful new commit** calls armAlarm again and can heal indexing. An existing alarm may also heal it. If no later successful commit/alarm occurs, /latest alone does not heal it. Polling can still discover the committed sequence, preserving eventual pull correctness at fallback latency.

**Implement:** remote commit owner guarantees post-commit maintenance recovery. Decouple fanout/response from a best-effort side effect only after preserving durable alarm scheduling/retry; reconcile `head > index_synced_seq` with missing alarm during initialization or another bounded recovery path. Consider a durable pending-maintenance marker/outbox only if existing head/index state cannot supply that truth. Do not add an independent commit authority.

**Gate:** real workerd failure injection before/after head commit, getAlarm/setAlarm, fanout, D1 mirror, response; commit discoverability, no duplicate sequence, eventual index catchup without a second user edit. Match-hash replay ACK is a possible refinement for uncertain acceptance, subject to exact old protocol behavior.

### 3. Server bulk fold repeatedly rescans the entire prefix

**P2 performance. Production function extracted and executed.**

`apps/api/src/workspace-sync.ts:1480` starts `for (const sha of left)` at the beginning for every `diffChunk`. `:834-854` repeatedly calls it, with a 5,000-output chunk (`:40`). A 250,000-ref disjoint set generates 50 chunks plus terminal probe and visits **6,625,000 values**, **26.5 visits/ref**. Local execution was ~209 ms; production wall impact is unmeasured and SQL/R2 remain additional work. Two fully disjoint sets incur this for both directions. Sparse changes are closer to linear.

**Implement:** retain one iterator across chunks within a live fold; use persisted lastSha to resume correctly only after restart. Alternatively sorted packed arrays plus one binary seek on recovery. Preserve transaction cursor atomicity and sorted iteration. Existing loop is memory-bounded but superlinear for large changes.

**Gate:** instrument visits <= O(parent+child) independent of SQL chunk count; crash between every chunk; empty/disjoint/near-identical sets; same dropped_index and roots as baseline.

### 4. The full refset still crosses the WAN and is re-read on every small content commit

**P1 scalability / largest transport improvement. Source verified, not newly invented: docs/audits/2026-08-18-sync-10x-hunt.md already proposed it.**

- `src/cli/e2ee-remote.ts:775-781`: serialize, hash, upload entire sidecar over >4,000 refs.
- `apps/api/src/workspace-sync.ts:613`: resolve/read child; `:363`: load/read parent; merge compares full byte sets.
- `apps/api/src/sidecar.ts:32-43`: each load does R2 GET, buffers, SHA-256, validates full set.
- Fold `workspace-sync.ts:809,830,880-886` loads and expands full refsets again; foldPrevCache avoids some previous-set loads but does not eliminate current-set O(N).
- Refset encoding is 18 + 40*N bytes. 127,086 refs yields **5,083,458 bytes**, before ciphertext/manifests. One-file change at this size should not require 5MB of metadata upload.
- `apps/api/wrangler.jsonc:112,194` configures delta *admission* enforce; that reduces D1 validation work, **not full refset bytes**. Do not confuse it with delta refset transport.

**Implement:** signed parent-bound refset delta plus periodic authenticated full checkpoint, with the WorkspaceSync owner updating an incremental root representation. GC must retain sufficient anchored history, delta carriers and manifests; admission must preserve entitlement, delete fences, epoch rotation, count/size accounting, and recovery. Cheaper interim: bounded immutable sidecar byte memo keyed by verified hash/count; keep current account authorization and freshness fence checks independent of cached bytes.

**Prize:** hundreds/thousands-fold metadata-byte reduction for sparse edits; end-to-end 10x is conditional on actual RTT, apply and git costs, not claimed from byte ratio.

### 5. Publication and receive still contain avoidable sequential protocol round trips

**P1 latency. Source verified; much is already proposed in the August 18 audit.**

- `src/cli/remote/commits.ts:328` awaits receipt redemption, then :336 sends commit with `receipts:{}` despite server admission already accepting receipts.
- `src/cli/e2ee-remote.ts:781` uploads sidecar; envelope remains separately uploaded before commit.
- `apps/api/src/workspace-sync.ts:708` holds full signed envelope; :760 broadcasts only `{type,sequence,deviceId}`.
- `:768-777` awaits a best-effort nonauthoritative D1 mirror before sender gets success. Fanout already precedes mirror and a test pins this; do not report mirror blocking fanout.

**Implement:** let small receipt sets and encrypted manifest envelope ride the commit, and let the existing signed commit/encrypted envelope ride bounded WS frames. Receiver verifies chain/signature/pin before using it, then falls back to authenticated pull on gap/mismatch. Perform independent account-key refresh and upload work concurrently without loosening epoch freshness. Return commit ACK without waiting on nonauthoritative mirror only if mirror eventual recovery is explicitly owned. Receiver can prefetch immutable ciphertext immediately on notification while waiting for its apply mutex.

**Gates:** request-count/bytes budget; exact frame-vs-/latest equality; revoked socket closure; frame-size cap; old clients; unknown/duplicate/out-of-order frames; bounded prefetch; retained 409/422/quota/uncertain-ACK semantics. Aim for one blob lane plus one commit RTT on small edits rather than claiming one request for every workload.

### 6. History endpoint is count-bounded, not byte-bounded

**P2 memory/backpressure risk, static upper-bound finding.**

`apps/api/src/workspace-sync.ts:1280-1295` reads/parses all commits into one array and JSON encodes one response. `commit-envelope.ts:28` MAX_COMMIT_SPAN=5,000; :16 allows 1MiB commit bodies. Nominal count limit therefore permits gigabytes of body data. This bound does not say realistic current workspaces hit it, and no huge allocation was attempted.

**Implement:** explicit byte-capped pages or a bounded framed stream, with parent/sequence continuity and client verification across pages. Never advance pin based on partial/unverified history. Gate 5,000 near-cap bodies with bounded memory, cancellation, interrupted resume, pruning/rebaseline behavior, and old-client compatibility.

## Existing improvements verified (preserve; do not re-propose as missing)

- SQLite relative save staging: `src/cli/state-plane/adapters/sqlite-state-save.ts:133-149`; whole state remains a fallback at :150-159.
- Loaded-state memo checked against live authority/lineage/stream/revision/telemetry token: `src/cli/state-plane/adapters/state-memo.ts:42-61`. Shared immutable-state assumption should continue to be exercised by RBOX_STATE_FREEZE sweep.
- Fused verify-and-copy sealed artifacts: `state-plane/store/stage-artifacts.ts`, `write-packet.ts:100-172`; owned anonymous copy and sealed header prevent TOCTOU substitution.
- Local state delta counts still perform `COUNT(*) WHERE lineage_id,plane` at `plane-promotion.ts:184`; caller composes a whole-manifest delta walk. This is residual O(N), not fully O(change). Future maintain a transactional file count with deep periodic audit, preserving forged-count refusal. At 119k this is secondary to remote wire work.
- Packed blobs, coalesced range reads and measured batch concurrency already exist: `apps/api/src/blob-batch.ts:46`, `src/cli/remote/blob-batch/config.ts:14-39`. Defaults reflect observed knees. Do not suggest blindly raising slots or adding packing.
- Server early stale reject and O(change) admission configured in dev/prod.

## Local benchmark and test evidence

| Check | Result | Limit |
|---|---|---|
| Existing `scripts/bench/state-plane.ts`, N=10,000 | cold save230ms, full steady161ms, delta compose1.9ms, delta save19.3ms, no-op8.1ms, full load21.5ms | one run, local disk/Bun |
| Same benchmark, N=119,000 | cold2426ms, full steady1738ms, delta compose18.2ms, delta save45.3ms, no-op13.8ms, full load288ms | existing implemented fast path ~38x save-only / ~27x inclusive compose vs whole save |
| delta-cas + fused-consume tests | **20 pass, 0 fail**, 76 assertions | Bun 1.3.14; no live fleet |
| Broader 4-file run including memo + elision-races | 34 pass,15 fail | failed lock-backed branches report compatible lock identity unavailable / unsupported; environment limitation, not classified as product regression |
| churn experiment | 50 values for 1 live file;49 collectable | actual save path, temp DB |
| collector experiment | 873.9ms ->11.3ms with reverse index (~77x) | 3k deleted,3k live; temp schema only |
| alarm failure | accepted head; thrown request; zero fanout/mirror;409 replay; restart not rearmed | production class with fake DO/D1, not workerd |
| diffChunk visits | 6,625,000 for250k refs;26.5x linear visits | exact extracted function, local runtime |

Scratch sources: `/private/tmp/rbox-state-audit-experiment.ts`, `/private/tmp/rbox-state-gc-perf.ts`, `/private/tmp/rbox-do-alarm-audit.ts`, `/private/tmp/rbox-fold-audit.ts` (extracts current production function).

## Protected contract / ownership and architecture

| Owner | Owns | Must never own | Improvement interface |
|---|---|---|---|
| Local StateStore | lineage, BASE/LOCAL, repo records, atomic checkpoint, maintenance | git filesystem transaction policy or network publication | existing complete save/CAS plus bounded maintain() |
| Git physical recovery | ref/index/worktree effect and roll-forward/rollback | independent logical checkpoint | preserve existing state-CAS handoff |
| WorkspaceSync | single remote sequence and retained history/root maintenance | plaintext manifest semantics or client merge | acceptCommit + verified feed + roots |
| Blob admission/accounting | entitlement/quota/delete fence/durable bytes | sequence authority | admit referenced delta/carriers |
| Transport adapters | bounded request/frame encoding and retries | alternative publication truth | publish/feed/prefetch |

Retain: old supported formats, rollback/equivocation detection, account-key rotation, dirty worktree safety, same-account authorization, quota and GC fences, manifest hash integrity, fsync durability, valid crash recovery. No reduction in durability merely to improve microbenchmarks.

Requirement challenges needing explicit product choice:

1. Full refset checkpoint on every commit vs parent-bound deltas: new wire/GC compatibility requirement, not silent deletion.
2. Durable sealed SQLite artifact for every in-process no-op repo stage (`sqlite-state-save.ts:170-182` creates one even when repos=[]): benchmark no-op floor13.8ms. An in-memory transaction input may reduce fsync scaffolding but must reproduce isolation/proof/crash contracts; low priority versus seconds on wire. Do not simply remove stage proof.
3. Single global D1 database: `apps/api/src/db.ts:44-48` deliberately N=1 despite routing seam. Account sharding is a future throughput option with directory/account split and global-GC consequences; it is NOT a 10x single-user sync claim. Measure contention first.
4. History/prune kill switches: `apps/api/wrangler.jsonc:105,194` disables history pruning and production GC purge; packed GC shadow. These are active operational guards, not stale dead code, and must not be toggled by an audit.
5. Notification-only WS: widen it with authenticated opaque payloads only after revocation, size and old-client compatibility gates.

Safe deletion candidates: NONE approved by this read-only audit. The uncalled collector should be integrated behind clear ownership, not deleted. Unused wrapper/codec candidates require exports/build/docs/release-window audit before deletion. Flag removal requires recorded rollout completion.

## Recommended order

1. Characterize current fleet: one-file / agent burst / 119k / multi-worktree / reconnect; p50,p95,p99 sequence acceptance to applied state; bytes, RTT count, CPU, fsyncs, orphan rows, fold lag.
2. Fix alarm post-commit liveness and local state reclamation (with reverse index) in independent behavior-preserving cycles.
3. Remove repeated fold-prefix scans and bound history response bytes.
4. Deliver bounded signed envelope WS transport and receipt/envelope coalescing; preserve fallback.
5. Refset delta protocol + checkpointed incremental server roots; then full-path O(change) manifest/hash representation if measurements justify the compatibility cost.
6. Only after wire/apply budgets are measured, consider account sharding, speculative pre-upload/prefetch, or a new local representation.

The meaningful 10x is a change-proportional protocol end to end. The current system already has a measured >10x local save optimization; the remaining task is to carry that discipline across transport, maintenance and receive rather than replacing its correctness model.
