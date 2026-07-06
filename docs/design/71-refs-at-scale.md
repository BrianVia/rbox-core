# Design 71 — Refs at scale: let a 123k-file workspace publish

**Status:** v2 (v1 numbers corrected per codex adversarial review; the receipts
body-cap wall found in that review is now the centerpiece)
**Driver:** live stress test — `~/Development`, 122,983 files across ~140 git
repos, on a Pro plan. 6.7 GB of blobs uploaded fine; the workspace has **never
published a commit** (remote sequence still 0 after four days).

## 1. Problem — TWO walls, not one

Every rbox commit carries the **full unique blob-ref set** of its manifest.
Below 4,000 refs they ride inline in the signed body; above that they move to
the §24 refset sidecar and the body carries `{sidecarSha, count, totalBytes}`.
A workspace of this size hits two independent hard stops, in this order:

1. **The receipts map blows the request body cap.** `commitSigned` sends ALL
   still-valid upload receipts in the commit JSON body (`commits.ts:77`); one
   receipt entry is ~370–380 bytes, and `readBodyCapped` rejects the request at
   `MAX_REQUEST_BODY = 8 MiB` (`commit-envelope.ts:25`, `workspace-sync.ts:138`)
   — **before** `blobRefset.count` is ever inspected. A cold first publish
   carries a receipt per new ref: the cap is hit at roughly **22k receipts**.
   123k receipts ≈ 44.6 MiB; this workspace 400s with `body_too_large`.
2. **The refs cap.** If the body were accepted, the DO rejects
   `mode.count > MAX_REFS_PER_COMMIT = 50_000` with a 413 `too_many_refs`
   (`workspace-sync.ts:219`). Note the effective accounting set is
   `count + 2` — the server appends `encManifestSha` and `sidecarSha` carriers
   (`workspace-sync.ts:232`).

And a client-side failure mode that turns both into an invisible hang:

3. **Deterministic 4xx treated as retryable.** `commitSigned` special-cases
   409/422; everything else lands in `translateRemoteError` → generic
   `commit failed` → daemon halt → pump retries forever. The user sees
   "will be retried" for rejections that can never succeed.

## 2. Cost model (corrected — from the review's recomputation)

Receipts+sidecar commit path (`validateCommitRefs` + `commitAccounting`), with
`N` data refs, `M = N + 2` accounted refs:

| N | sidecar bytes | `/blobs/check` preflight | `validateCommitRefs` | accounting txns | total commit-path D1 (incl. mirror) |
|---:|---:|---:|---:|---:|---:|
| 123k | ~4.9 MB | 46 | 41 | 42 | ~130 |
| 250k | ~10 MB | 92 | 82 | 84 | ~259 |
| 500k | ~20 MB | 184 | 164 | 167 | ~516 |

(The legacy non-receipts `missingBlobs` 2-pass path doubles the validate
numbers; it is not what a current client executes.)

- Statement bound: a full 3,000-ref accounting txn is `ceil(3000/33) × 5 =`
  **455 statements** (5 per 33-ref chunk since §33 added the prune-marker
  DELETE). Param maxima: 99 (`INSERT blobs`), 91 (validate), 81 (80-sha
  lookups) — all under D1's 100.
- Platform subrequest cap (1,000/request): 123k ≈ 130 (13%), 250k ≈ 259 (26%),
  500k ≈ 516 (52%). 250k has honest headroom; 500k does not, once retries and
  ws-fanout ride the same request.
- **DO memory**: `loadSidecarRefs` + `parseRefset` materialize the full refset;
  a measured V8 heap probe puts 250k refs (+derived sets/arrays) at ~78 MiB —
  within the 128 MiB isolate but close enough that the refset must not be
  duplicated wholesale again in the commit path. 123k (~38 MiB) is comfortable.
- **CPU**: cold-publish receipt verification is one HMAC per missing ref
  (`commit-accounting.ts:88`, `receipts.ts:117`) — 123k HMACs in one request
  is seconds of CPU on top of everything else. §3.1 removes this from the
  commit request entirely.

## 3. Decision

### 3.1 Batched pre-commit receipt redemption (the body-cap fix)

New DO route `POST …/receipts/redeem`: body `{receipts: {...}}` capped at
**5,000 receipts** per call (~1.9 MiB, comfortably under 8 MiB). The DO
verifies each receipt HMAC and runs the existing idempotent
`commitAccounting` catalog+charge+grant for the verified refs. Response:
`{granted: n}` (or `quota_exceeded`, unchanged semantics — partial
super-batches staying charged is already the §30 contract).

Client (`e2ee-remote` push): after uploads, drain `ctx.receipts` through
redeem in 5k batches (sequential; each call is idempotent and safe to retry
under the #92 rules — a duplicate redeem re-grants 0). THEN commit with an
**empty receipts map**. `validateCommitRefs` finds every ref already entitled
in `blob_refs`, so the commit request does no receipt crypto at all.

- Old clients keep sending inline receipts and stay under 8 MiB for normal
  workspaces — the route is additive; no server-side removal.
- GC safety: redeemed-but-not-yet-committed grants are exactly the state the
  §33 prune barrier + `granted_at` grace already handle (identical to today's
  "commit accepted receipts then failed later" partial states).
- Per-redeem-call work: ≤5k HMACs, ≤2 accounting txns — small, bounded, and
  spread across requests instead of spiking one.

### 3.2 Raise `MAX_REFS_PER_COMMIT` to 250,000 — as an M-inclusive check

- The guard becomes `mode.count + CARRIERS > MAX` (carriers = 2 today) so the
  constant is a true bound on accounted refs; the loadSidecarRefs size gate
  keys off the same constant as now.
- 250k per the cost table: ≤26% of the subrequest budget, ~78 MiB peak heap
  (documented ceiling), accounting txns bounded. NOT 500k — that flies at the
  isolate's memory and subrequest ceilings; past 250k the answer is the
  delta-refs protocol (§5), not a bigger constant.
- **Static budget tests** in `apps/api`: compute statements-per-txn (455),
  params-per-statement (≤99), and subrequests-at-MAX from the real constants
  (`IN_LIST_CHUNK`, `STMTS_PER_BATCH`, `MAX_REFS_PER_TXN`, receipts batch cap)
  and assert stated margins. Bumping any constant trips the math in-repo.

### 3.3 Bound the 422 `missing` response

At 250k refs a full miss list is ~17 MB of JSON. Cap the serialized `missing`
array at 10,000 shas + `{missingTotal}`; the client's re-upload pass treats it
as "at least these" and re-runs the preflight after acting (it already loops
push attempts). With §3.1 redemption, large misses become rare (misses mean
lost receipts, and redemption consumes receipts promptly after upload).

### 3.4 Terminal client errors + honest halt

- `too_many_refs` (and `body_too_large` from a commit) become a dedicated
  `CommitRejectedError` carrying `{reason, count, max}`; server adds `count`
  to the 413 body.
- Message: `workspace needs N blob refs per commit; the server cap is M.
  Exclude large directories with \`rbox ignore\` or split the workspace.`
- Daemon halt gains `terminal: { fingerprint: string }` — fingerprint = the
  refset **sidecarSha** (already computed at `e2ee-remote.ts:379`; exact, not
  the count heuristic). The pump skips further PUSH attempts while the current
  refset's sidecarSha equals the fingerprint; any manifest change producing a
  new sidecarSha (or a daemon restart, or pull/other ops — unaffected) retries
  naturally. This also answers "what clears it": a different fingerprint or a
  push success (existing same-op heal at `daemon.ts:353`).
- `rbox status`: terminal halt renders red WITHOUT "will be retried" — the one
  case where red-and-stopped is the truth; transient halts keep the #100 amber.

### 3.5 Observability

- Keep `emit(count)("too_many_refs")`; add the commit's ref count and the
  redeem-call count to the §25 commit metrics line — the next wall (250k)
  must be visible in telemetry before a user hits it.

## 4. Explicitly deferred (with the review's evidence)

- **Delta-refs commits** — O(changes) steady state; needs signed-body,
  GC-root, and re-baseline redesign. Trigger: telemetry approaching 250k.
- **GC/roots at scale** (`workspace-sync.ts:338` walks every retained commit's
  full refset; one 250k root ≈ 16 MiB JSON before `reachableFromWorkspaces`
  unions): acceptable at 123k–250k with bounded retention, but the delta-refs
  design must fix this too (streaming/merkle roots). Documented, not fixed here.
- **`commits?since` span-5000 re-baseline** (`verifiedHead` doesn't catch
  `NeedsRebaselineError`, `e2ee-remote.ts:188`): a real pre-existing bug for
  5,000+-commit histories, orthogonal to ref count — backlogged separately.
- **Per-plan caps**: one global cap until there's a product reason.

## 5. Rollout / verification

1. Server: redeem route + M-inclusive 250k cap + 422 bound + budget tests →
   deploy `rbox-prod-api`.
2. Client: redemption drain in push, `CommitRejectedError`, terminal halt +
   status rendering.
3. E2E on the incident workspace with a local dev build (docs/dev-loop.md):
   restart daemon → receipts drain in ~25 redeem calls → commit with empty
   receipts → **sequence 0 → 1**. That is the acceptance test for the design:
   the stress-test workspace publishes, then stays in steady-state sync.
4. Watch steady-state commit latency (~1–2 s predicted at 123k) and the §3.5
   telemetry; material regressions pull the delta-refs design forward.
