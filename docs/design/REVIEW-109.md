# REVIEW-109 — adversarial review ledger for design 109 (first-publish auth-call storm)

Reviewer: codex (`codex exec`, gpt-5.6-sol). Judge: Claude (fable-5).
Doc under review: `docs/design/109-first-publish-auth-call-storm.md`.
Branch: `design/109-review`.

## Round 1 — 2026-07-13

Verdict: **CHANGES-REQUIRED** (2 BLOCKER, 8 MAJOR, 4 MINOR, 1 NIT).

All findings were independently checked against the code before adjudication;
every finding's cited file:line was confirmed accurate.

| # | Sev | Finding (compressed) | Decision | Rationale / doc change |
|---|-----|----------------------|----------|------------------------|
| 1 | BLOCKER | Doc claimed "quota … checks remain in force" on batch PUT — no quota check exists on that path (`blob-batch.ts` `writeBatchPutRecords` → `directWriteVerified` + `mintFenceCheckedReceipts` only); stolen-grant aggregate authority (unbounded request cardinality × 8 MiB) unanalyzed. | **ADOPT** | Verified: no billing/quota call anywhere in the batch-PUT path (bearer path included). §4.1 rewritten: quota claim removed, honest abuse bound added (unbounded request count within TTL; platform-level R2 write amplification + orphaned GC-reapable objects; receipts inert without a live bearer since redeem/commit stay bearer-authenticated). §7 notes staging-PUT quota is out of scope with bearer/grant parity. |
| 2 | BLOCKER | Proposed `authn` semantics ("no usable grant → bearer path") unobservable client-side: server grant rejection is a silent bearer fallback, so `authn0 authms0` could be emitted while all requests ran bearer auth — primary §6 gate passable with the feature broken; >5-min degradation gate also unworkable. | **ADOPT** | §4.1 adds a required `x-rbox-auth-path: grant\|bearer` response echo on batch PUT; §4.3 redefines `authn`/`authms` as settle-time classified from the echo (missing header / thrown fetch ⇒ bearer). §4.4 splits data-plane vs observability compatibility; §6.2 gate now cannot pass on a silently rejected grant. |
| 3 | MAJOR | Revocation/account-deletion regression understated: pre-auth grant path skips `authenticate()`'s live-device + tombstone reads for up to TTL; "same class as download grant" insufficient for a write credential. | **ADOPT** | §4.1 now states the revocation/deletion lag explicitly as an accepted, TTL-bounded trade with the mitigating facts (unredeemable/uncommittable by revoked principal); §6.1 requires tests pinning accepted-within-TTL and rejected-after, plus revoked-bearer-cannot-redeem. |
| 4 | MAJOR | "2,426 successful attempted batch dispatches" wrong — `firstPublishAuthStart()` counts before settle; includes aborts, transport errors, 404/405, 503 retry_later, non-OK, malformed responses. | **ADOPT** | §1/§2.2 corrected to "attempted batch-PUT fetch cardinality" with the failure classes enumerated. |
| 5 | MAJOR | Auth not established as a dominant term: 107.7s×24/2,426 ≈ 1.07s mean slot occupancy vs ~910ms/batch already attributed to Worker R2 subrequest serialization (client comment, measured 2026-07-08); residual ≈160ms/dispatch ⇒ ≤~16s upper-bound win. | **ADOPT** | New §1.1 carries the quantitative bound. New §6.0 gate 0: attribution from EXISTING AE data (`request` op wraps `authenticate()`, `blob.batchPut` wraps only the handler — verified in `worker.ts` `fetch()`), with an explicit go/no-go threshold before implementation. |
| 6 | MAJOR | Batch-amortization (option D) dismissed before measuring fill; dispatch-trigger list omitted the idle-tail flush (`active === 0` → `dispatchPartial` in `launch`'s `finally`). | **ADOPT** | §2.2 adds the idle-tail trigger; notes fill is already recoverable from `blob.batchPut` `count`/`bytes` AE fields; §3.D and §6.0 make the fill pull a gate-0 prerequisite with an explicit park-109 branch. |
| 7 | MAJOR | Fire-and-forget refresh ownership unspecified (rejection handling, retry bound, close() interaction — uploader `close()` awaits only its own `inFlight`). | **ADOPT** | §4.2 specifies internally-handled rejection, last-failure timestamp + minimum retry interval, refresh outside the uploader's `inFlight`, `close()` does not await it, publish never fails on refresh failure. §6.1 tests added. |
| 8 | MAJOR | `{credential, capturedAt}` insufficient: near-expiry lanes can send server-expired grants; needs snapshot/attach-window/clearing rules. | **ADOPT** (with correction of emphasis) | §4.2 adds attach window (TTL − margin), per-dispatch snapshot, opaque credential (no client payload parsing). Judged correction: an expired grant mid-flight is *correctness-harmless* (server bearer fallback) — the doc says so and treats the margin as a latency/observability optimization, not a safety mechanism. |
| 9 | MAJOR | Proposed server counters don't fit the metrics model: `op.done` emits one event/one outcome, already consumed by `blob.batchPut` (`ok/partial/bad_request/retry_later`); no denominator/exactly-one rule; `fallback_missing` swamped by old clients. | **ADOPT** | §4.3 specifies a dedicated `blob.batchPut.auth` AE event (exactly one per batch PUT when server flag on) with outcome enum `fast_path\|fallback_missing\|fallback_invalid\|fallback_expired`, existing handler outcomes untouched, matched-client-version comparison rule. |
| 10 | MAJOR | fp-equivalence gate overclaims: `uniq/dup/resume` are encryption-side counters and can't falsify receipt/E2EE regressions (silent bearer single-PUT fallback leaves them unchanged). | **ADOPT** | §6.2 downgrades them to necessary-not-sufficient consistency signals; correctness proven by §6.1 suite + receipts redeemed + commit accepted with same ref set flag-on/off. |
| 11 | MINOR | Empty-check acceptance is not uncertain: server accepts `{shas: []}` → `{missing: []}` today; the real obstacle is `missingBlobs([])`'s local short-circuit. | **ADOPT** | §4.2 resolves the conditional: refresh uses a dedicated context method (explicit empty check POST), never `missingBlobs`; API test pins the shape. |
| 12 | MINOR | Mint placement ambiguous across `blobsCheck`'s two response branches (receipts vs legacy). | **ADOPT** | §4.1: mint only in the `usesReceipts(req)` branch, with the telemetry rationale. |
| 13 | MINOR | >5-min gate not derivable from fp tokens (no refresh counters); single-flight alone permits continuous sequential retry. | **ADOPT** | §6.2 reassigns the assertion to server mint/`blob.batchPut.auth` events + `RBOX_DEBUG` logs (fp line NOT extended); §4.2's minimum retry interval bounds retries, pinned by §6.1 tests. |
| 14 | MINOR | Compat matrix conflated data compatibility with observability compatibility. | **ADOPT** | Folded into finding 2's fix: §4.4 now has separate data-plane / observability-plane matrices. |
| 15 | NIT | `ROUTE_VOCAB` needs no addition (`blob-batch`, `put` already present). | **ADOPT (no-op)** | The doc never claimed a vocab change; recorded here so implementation doesn't add one. |

No findings rejected this round — all fifteen were verified accurate against
the code.

## Round 4 — 2026-07-13 (final)

Verdict: **ALIGNED** — no findings. Codex re-verified R3-1 against
`worker.ts` (`request` op route dimension includes the templated
`POST /v1/blob-batch/put`; outer span includes `authenticate()`),
`blob-batch.ts` (handler op scope), and `metrics.ts` (no correlation id), and
confirmed the exact-count-reconciliation gate-0 wording plus a full-doc skim
with no regressions.

Review closed: 4 rounds to ALIGNED. Rounds 1-3 findings: 17 total
(2 BLOCKER, 11 MAJOR, 4 MINOR, 1 NIT counting the R2/R3 residuals), all
adopted, none rejected.

## Round 3 — 2026-07-13

Verdict: **CHANGES-REQUIRED** (1 MAJOR residual; R2-1 verified resolved).

| # | Sev | Finding (compressed) | Decision | Rationale / doc change |
|---|-----|----------------------|----------|------------------------|
| R3-1 | MAJOR | R2-2 fix still claimed to "exclude `request` rows with no matching handler outcome" — without a correlation id, unmatched rows cannot be identified, so they cannot be excluded from aggregates; the FM-window fallback cannot honor that promise. | **ADOPT** | §1.1/§6.0 rewritten: gate 0 filters `request` rows by their route dimension (the `request` op is emitted with `${method} ${routeTemplate}`), REQUIRES exact count reconciliation with `blob.batchPut` for the window (a dedicated dev-worker publish provides this), and otherwise keeps unmatched rows IN and reports the count mismatch as uncertainty — never a silent exclusion. |

## Round 2 — 2026-07-13

Verdict: **CHANGES-REQUIRED** (2 MAJOR residual on round-1 material; findings
1–4, 6–8, 10–15 verified resolved; 5 and 9 partially resolved).

| # | Sev | Finding (compressed) | Decision | Rationale / doc change |
|---|-----|----------------------|----------|------------------------|
| R2-1 | MAJOR | §1.1's "~16s upper bound" not mathematically established: `107.7×24/2,426` is a concurrency-envelope *ceiling on mean request duration* (slots are not fully occupied through ramp-up/gaps/idle tail), and the ~910ms figure is from a different corpus/window and shows slot-flatness, not record-count invariance — so subtracting it does not yield an upper bound on removable residual. | **ADOPT** | §1.1 rewritten: 1.07s labeled a concurrency-envelope ceiling on mean duration, ~910ms labeled a cross-run measurement with its transfer assumption explicit, ~16s downgraded to a rough estimate ("plausibly low tens of seconds at best"); gate 0 owns the real number. |
| R2-2 | MAJOR | Gate 0 assumed per-request `request` − `blob.batchPut` subtraction, but AE events carry no correlation id (dimensions are op/route/outcome only), so pairing is impossible; `request` rows can exist with no handler event. | **ADOPT** | §1.1 and §6.0 now specify an *aggregate* decomposition over an isolated window (dedicated dev-worker publish preferred; otherwise FM window with outcome/count reconciliation), comparing means/sums with stated uncertainty; explicitly notes per-request correlation instrumentation is NOT required or added. |

Codex additionally verified (no findings): auth-path echo header is
enum-only/no-store/not CORS-exposed; settle-time classification coherent with
`retries: 0`, watchdog abort, and 503 retry_later paths; refresh timing spec
internally consistent; empty receipts-protocol check enters the receipts
branch and can mint without D1 lookup work; §6 gates otherwise falsifiable.

### Seam items (for the joint 109/110/111 round — not folded into 109's scope)

- **111 (redemption tail)**: 109 deliberately keeps receipt redemption
  bearer-authenticated and leans on that for its stolen-grant abuse bound
  ("receipts are inert without a live bearer"). If 111 amortizes or pre-auths
  redemption (e.g. a redemption grant or moving redemption into batch-PUT
  responses), that bound weakens and 109 §4.1's threat model must be re-argued
  jointly. Also: if 111 changes the `/v1/blobs/check` request/response shape
  (109 adds `uploadGrant` to its receipts-branch response and uses an empty
  check as refresh transport), the two designs touch the same wire surface.
- **110 (commit tail)**: 109 asserts commit admission stays fully
  bearer-authenticated and byte-identical. Any 110 change to commit-path auth
  or to the `request`-op instrumentation used by 109's gate 0 (§6.0) should be
  cross-checked in the seam round.
- **Shared metric surface**: 109 adds a `blob.batchPut.auth` AE op and an
  `x-rbox-auth-path` response header. If 110/111 add analogous per-route auth
  classification, the enum vocabulary and header name should be unified once.
