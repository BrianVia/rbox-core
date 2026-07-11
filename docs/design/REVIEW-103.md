# REVIEW-103 — adversarial review ledger for design 103

Reviewer: codex (gpt-5.6-sol), read-only, adversarial. Cap 5 rounds.
Target: `docs/design/103-steady-sync-quick-wins.md` + audit Findings 2–3.

Attack surface requested each round: GC-fence/regrant holes for carried refs,
422-recovery interactions, epoch-rotation races, early-return response shape vs
client retry logic, unfalsifiable gates, scope creep into server-side delta
admission (design 102's territory).

---

## Round 1 — VERDICT: REVISE (11 items)

| # | Item (summary) | Disposition |
|---|---|---|
| 1 | 422-recovery threading doesn't exist: `reupload` action carries `unsatisfiedTotal` but NOT the SHA list; v1 claimed it "already carries" it. Narrowed retry could compute an empty candidate set and 422 forever. | **ACCEPTED — real bug in v1.** Verified `sync.ts:464`: the list is dropped after deriving `gitForce`. v2 specifies `unsatisfiedBlobs: string[]` as a NEW action field, a page accumulator in the push loop, `recoverAddresses` on `EncryptAndUploadOptions`, plus a carried-only-missing-ref acceptance test. |
| 2 | Carried-ref GC proof conflates detection with repair: an actively delete-fenced ref 422s but the re-PUT cannot mint through the open fence; the `isDeleteFenceAbort` path was uncovered. | **ACCEPTED.** v2 replaces the single-sentence claim with a three-state repair machine: (1) prune-marked/lost → 422 → re-PUT → regrant/un-condemn/marker-clear; (2) open fence → 422 → PUT 503 `retry_later` → defer → bounded fail-this-cycle, converges after fence resolution (same as flag-off — design 95's "no authority spans a delete"); (3) fence raised mid-accounting → `isDeleteFenceAbort` → 422 → path (2). All three are named rig scenarios. |
| 3 | 422 pages are capped (`MAX_MISSING_SHAS_RESPONSE`); "one extra round-trip" false for multi-ref/fence cases; convergence bound unspecified. | **ACCEPTED.** Verified cap = 10,000 + `missingTotal`; the push loop already has a progress-based budget (retry free while `unsatisfiedTotal` strictly decreases, `sync.ts:515–520`, `MAX_ATTEMPTS=5`). v2 names both, scopes the one-round-trip claim to a single ref, accumulates pages across retries, and adds a >10k multi-page convergence gate. |
| 4 | Epoch claim too strong: forwarded snapshot doesn't close the Worker-read→DO-commit rotation window; "no new race" isn't a proof. | **ACCEPTED (wording).** v2 states Part A preserves the existing best-effort epoch snapshot semantics exactly — window neither widened nor narrowed, no atomic-revalidation claim — and adds controlled-rotation tests in both orderings. |
| 5 | "Byte-identical response bodies" inaccurate (`serverTimings` values differ); contract is structural; combined stale-parent+stale-epoch precedence untested. | **ACCEPTED.** v2 defines the structural contract (status/error/head/currentEpoch/parseable serverTimings), routes acceptance through `commitSigned` + the `sync.ts` branches, and pins conflict-before-epoch precedence (early path checks parent first, mirroring txn order) with a doubly-stale test. |
| 6 | Zero-`sidecarMs`/`accountingMs` gate is not identifying (timer resolution); no sample size — p50 over one request is meaningless. | **ACCEPTED.** v2 adds an `earlyReject: 1` numeric metric detail as the identifying signal and sets ≥10 samples per stale scenario with p50/p95/range per the audit's statistical discipline. |
| 7 | "Clean commit latency unchanged" unfalsifiable; suites unnamed. | **ACCEPTED.** v2: 10 warm flag-on vs 10 warm flag-off, p50 of client POST wall + `serverTimings.totalMs` within +5%; suites named explicitly (server: gc-phase1, gc-purge, receipts-flow, sidecar-flow, worker, blob-check-batch; client: sync, remote-commits, sync-scan-defer, git-sync). |
| 8 | Part B complexity gate underspecified: "count == 1 (+ residue)" unassertable; dedup/deferral shrink counts. | **ACCEPTED.** v2 adds per-class counters (`introduced`/`recover`/`sent`/`fullAudit`) and gates on unique post-defer introduced addresses, not file counts. |
| 9 | Resumed-upload residue class is scope creep on an unvalidated abstraction over `.rbox/state/uploads`. | **ACCEPTED — class REMOVED.** Proof of redundancy added: an interrupted push never advances the base, so its files remain non-carried → class 1 covers them; `putBlobFile` already resumes from upload state when the address is re-uploaded. The reverted-file edge leaves an orphan blob unreferenced by the commit. |
| 10 | `/blobs/check` cap is not "behaviorally inert": old clients send ~7.9MB full-workspace bodies near the 8MB cap; compat/rollout unspecified. | **ACCEPTED.** v2: client-first rollout (chunked fallback ships and fleet upgrades → then server cap with a dedicated `BLOBS_CHECK_MAX_BODY` + `413 too_many_shas`), client 413 handling specified as fatal-actionable, tests for both limits. |
| 11 | Design-102 boundary too advisory for a correctness dependency. | **ACCEPTED.** v2 hardens it: `RBOX_PREFLIGHT_DELTA` must not remain enabled alongside a design-102 narrowed admission until 102's acceptance proves carried-ref fence/prune/loss handling; plus a regression test pinning that today's admission checks carried refs. |

All 11 items folded into v2 of the design.

## Round 2 — VERDICT: REVISE (6 actionable items; item 7 confirmed the 102 boundary holds)

| # | Item (summary) | Disposition |
|---|---|---|
| 1 | Early preflight placed before the sidecar 413 count check changes precedence: a stale+oversized commit would 409 instead of 413; "strict subset"/"zero behavioral diff" false beyond successful admission. | **ACCEPTED.** v3 places the preflight after each branch's cheap structural checks (413 count caps keep precedence — a terminal `CommitRejectedError` must not be masked by a retryable 409) and before the branch's first I/O. The I/O-derived re-ordering (stale+bad-sidecar / stale+unsatisfied → 409 first, 400/422 rediscovered post-pull) is specified as intentional with pinning tests. "Strict subset" reworded to "rejects only what the transaction would reject; ordering vs I/O outcomes changes deliberately". |
| 2 | Accumulator bound wrong: decreasing-total retries are budget-free, so the union is bounded by `missingTotal ≤ MAX_REFS_PER_COMMIT` (≈25 pages), not MAX_ATTEMPTS·10k. | **ACCEPTED.** v3 states the real bound (250k shas ≈ 17MB transient worst case), adds `RECOVER_ACCUM_MAX = 100_000` with fallback to the chunked full-audit preflight, and a unit test for the cap→fallback flip. |
| 3 | Carried-only scenario underspecified: a zero-change push no-ops before `encryptAndUpload`/commit, so a lost carried blob is neither detected nor repaired; the text implied ordinary zero-change pushes repair it. | **ACCEPTED.** v3 adds an explicit detection-boundary note (no-op short-circuit precedes the preflight in BOTH modes — flag-on == flag-off, no regression but no repair; proactive detection stays `--verify`), and the acceptance scenario becomes one changed file + one lost carried ref. The zero-change Effect/gate wording is scoped to git-identity-only pushes that still commit (the soak shape). |
| 4 | "Same terminal state as flag-off" too weak for the open-fence rig; mixed repairable+fenced pages can earn free retries before the fence consumes budget. | **ACCEPTED.** v3 enumerates the state-2 assertions (fenced address stays referenced; head never advances; unchanged-total 422s consume budget; terminates at MAX_ATTEMPTS; post-fence retry uploads fresh bytes + mints before head advance) and adds the mixed-page scenario asserting budget consumption starts exactly when the total stops decreasing. |
| 5 | "After Worker read" epoch test not falsifiable via a direct DO test with a chosen header. | **ACCEPTED.** v3 specifies the Worker seam: pause the route after its epoch query (`routes/sync.ts:42` hook), rotate D1, release, assert the forwarded pre-rotation epoch and identical flag-on/off decision. |
| 6 | `earlyReject` is a server metric, invisible to `commitSigned`; the gate conflated client and server assertions. | **ACCEPTED.** v3 splits the gate: (a) client integration proves retry classification through `commitSigned` + `sync.ts`; (b) server metric capture proves `earlyReject: 1` + declared-ref count on early 409s and its absence on transaction-path 409s. |
| 7 | Design-102 boundary now holds (confirmation, no change requested). | **NOTED.** No change. |

All six actionable items folded into v3.

## Round 3 — VERDICT: ALIGNED

Codex verified all v3 dispositions against the code and confirmed, point by
point: (1) carried-ref safety holds — the narrowed preflight is not
authoritative, `validateCommitRefs` still checks the complete refset, the 422
SHA threading closes the retry hole, and the three-state fence machine is
correct; (2) the paging bound is accurate and the 100k accumulator cap +
full-audit fallback is falsifiable; (3) the zero-change/no-op boundary matches
code and the changed-file-plus-lost-carried-ref scenario actually reaches
admission; (4) early-reject placement preserves structural-error (400/413)
precedence while the I/O-outcome reorder is intentional and pinned;
(5) the early 409 contract matches `commitSigned` and the `sync.ts` branches,
parent-before-epoch precedence preserved; (6) epoch semantics stated honestly,
route-pause seam makes both rotation orderings observable; (7) telemetry and
performance gates falsifiable; (8) the design-102 boundary holds.

No items. Loop closed at round 3 of 5.
</content>
