# Review ledger — design 111 (receipt-redemption tail)

Adversarial codex review loop on `docs/design/111-receipt-redemption-tail.md`.
Judge: Claude (this worktree). Reviewer: gpt-5.6-sol via `codex exec`.

## Round 1 — VERDICT: CHANGES-REQUIRED

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | MAJOR | `redeem - redeemOverlap` tail formula and 80%-overlap gate rest on an unsound metric: `redeemReceipts` snapshots `overlappedAtStart` once and credits the ENTIRE drain as overlap when any upload is active at start (`remote/commits.ts:165,208-209`); clamped-interval math only runs in the other branch. Also `firstPublishUploadEnd()` is success-only (not `finally`-paired) in both upload schedules (`sync-recovery.ts:403-409`, `pipeline.ts:362-368`), so a failed PUT leaks `uploadActive`. | **ADOPT** — verified against code. Doc now: (a) caveats the formula in the evidence section; (b) makes Phase 0 repair overlap accounting (interval intersection, finally-paired upload ends) a prerequisite; (c) gates use the corrected metric only; final flush measured independently. |
| 2 | MAJOR | 15k compatibility protocol was left as "choose one of two mechanisms" — no handshake advertises a cap today, and the client throws a generic error on the server's `400 too_many_receipts` (`remote/commits.ts:189-193`), so "never send above the advertised/known cap" and safe flag rollback were unimplementable as written. | **ADOPT** — design now decides: automatic `too_many_receipts` fallback, no new handshake field. Specified: parse/validate `max` (positive integer, strictly shrinking), session-scoped `sendCap` clamp, re-slice the untouched generation-safe map, hard fail on absent/non-shrinking `max` (anti-loop), mid-session server rollback handled by the next 400. |
| 3 | MAJOR | Resource gate ("isolate peak memory and CPU within 5k baseline +25%") was un-instrumented (Phase 0 only added wall breakdowns) and conflated per-request safety with corpus-level totals — a 15k request legitimately does ~3x the per-request work (serial HMAC verify, entitlement lookup, 5 vs 2 accounting txns). | **ADOPT** — gate split: (a) per-request safety ceiling (≤50% platform CPU limit via Workers `cpuTime`; no CPU/memory/subrequest-limit errors), (b) corpus-total server CPU+wall regression ≤10% vs 5k baseline. Telemetry sources named; memory expressed as byte-cap bound + absence of isolate errors (no per-request memory API). |
| 4 | MINOR | ~375 B/ref is a comment estimate; the real wire entry (64-hex sha key + `<kid>.<b64url JSON payload>.<b64url MAC>`, `receipts.ts:101-115`) scales with account-id/numeric widths and can exceed it; count-only slicing cannot enforce the 7 MiB wire gate. | **ADOPT** — 15k made explicitly contingent on Phase-0 measured max entry bytes (`15,000 x max_entry_bytes <= 7 MiB`, else largest N that fits); client slicing is count- AND byte-bounded on the exact serialized payload. |

Codex confirmed (no findings): kill/resume receipt safety (in-memory receipts
lost on kill are re-established via missing → re-upload → fresh receipt;
idempotent accounting), early-grant GC safety (orphan grants harmless, roots
commit-derived), 422 fence whole-batch fallback, generation-safe deletion,
retry idempotency, RBOX_COMMIT_DELTA_ADMISSION interaction, and the decision
NOT to fold redemption into the commit envelope.

## Round 2 — VERDICT: CHANGES-REQUIRED

Round-1 fixes accepted as directionally right but imprecise in three places;
no new correctness attacks on draining/kill-resume/idempotency/fence/GC or the
fallback mechanism landed.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | MAJOR | Round-1 prescribed overlap repair ("clamp against `[uploadStartedAt, uploadEndedAt]`") still overstates overlap: those fields are the OUTER span; `uploadActive === 0` gaps inside it (encryption stalls, missing-check waits, retry backoff) would be falsely credited. | **ADOPT** — Phase 0 now accumulates the union of upload-active intervals on `uploadActive` 0→1/1→0 transitions and intersects redemption intervals with that union; required unit test: two upload intervals with an idle gap spanned by a drain. |
| 2 | MAJOR | Corpus-total resource gate compared "15k" against "the 5k baseline", confounding the batch-cap change with the scheduling change (Phase 0's baseline is 5k/post-tail; pipelining alters server concurrency independently). | **ADOPT** — batch-cap regression gate now explicitly 15k/pipelined vs 5k/pipelined; 5k/post-tail vs 5k/pipelined evaluates scheduling only. |
| 3 | MAJOR | p95 ≤ 10s gate over "at least five" runs is statistically meaningless (p95 of n=5 interpolates against the max). | **ADOPT** — small-sample gate is now median ≤ 5s and max ≤ 10s over the ≥5 fixed-corpus runs; the p95 form is reserved for the step-4 canary cohort at ≥20 publishes. |
| 4 | MINOR | 15k eligibility formula `15,000 × max_entry_bytes ≤ 7 MiB` omitted JSON framing (outer `{receipts:{}}` envelope, punctuation) — could approve 15k when a full request doesn't fit (client byte-slicing would then silently cap below 15k). | **ADOPT** — eligibility now measured on the exact maximally-sized `JSON.stringify({receipts: …})` request including framing; otherwise largest N whose full request fits. |

### Seam items (design 110 joint round)

- None raised in rounds 1–2. Codex did not push toward folding redemption into
  the commit envelope; option C's rejection stood unchallenged.
