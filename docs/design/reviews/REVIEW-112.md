# Review ledger — design 112 (batch fill + wire cap)

Adversarial codex review loop on `docs/design/112-batch-fill-wire-cap.md`.
Judge: Claude (this worktree). Reviewer: gpt-5.6-sol via `codex exec`.

**FINAL VERDICT: ALIGNED (round 4, 2026-07-12).** Rounds 1-3
CHANGES-REQUIRED (7+2, 4+0, 3+1 findings); round 4 confirmation: no
findings, all residuals verified resolved with code citations.

Implementation-binding seam item carried forward: when 112 enters
implementation, amend `REVIEW-109-111-seam.md`'s binding order list (112's
field evaluation must sit outside the step-4 shared-baseline window; 112
state frozen and recorded in every 110/111 measurement cell; 109 gate-0
attribution reruns if 109 unparks after 112 changes batch cardinality).

## Round 1 — VERDICT: CHANGES-REQUIRED

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | MAJOR | The "principally the 10 ms timer" root cause is not established by the field data: AE `blob.batchPut` carries only count/bytes/duration (no enqueue timestamps or dispatch reasons), and supply is wave-shaped — `flushChecks` (`pipeline.ts:162-241`) buffers missing-checks 50 ms / `ROLLING_CHECK_BATCH` and resolves a whole batch in one synchronous loop, so large waves form FULL batches and only residue is timer-drained. Idle-tail partials are also indistinguishable. | **ADOPT** (verified `flushChecks` wave resolution in code). Evidence section rewritten: mechanism enumeration stays code-proven (exactly two partial origins: timer, idle-tail), but share attribution is explicitly unproven; fill-v2 reframed as measurement-first with low-cardinality dispatch-reason counters (`full_records/full_bytes/quiet/absolute/idle_tail`) + queue depth/oldest age; the fill-v1 baseline must show timer/idle dominance before the causal claim is asserted. |
| 2 | MAJOR | The sliding-quiet policy may not raise fill under the asserted supply: any >10 ms producer gap (encrypt stall, fs variance, check-wave boundary) ships the partial; "queued + active records as supply evidence" cannot reveal upstream backlog (uploader sees only `putFile()` arrivals), and active records cannot fill the current queued batch. | **ADOPT (modified)** — the design keeps its no-cross-layer-API decision (rejects the producer-open signal option) but now states the limitation up front, frames fill-v2 as an experiment falsified by the fill gate, adds a fake-clock test pinning the >10 ms-gap behavior (limitation-documenting, not a pass gate), and uses dispatch-reason telemetry to turn a fill-gate failure into a diagnosis. |
| 3 | MAJOR | 32-server/64-client skew is correctness-safe but operationally UNBOUNDED — a 400 latches nothing (unlike 404/405, `blob-batch.ts:733-737`), so every subsequent batch repeats 400 + up to 64 singles; and the promised alert is unimplementable: the server collapses all parse failures to AE `bad_request` `count:0` (`apps/api/src/blob-batch.ts:73-76`). | **ADOPT (modified)** — codex's primary fix (rely on a machine-readable `max`) cannot help against OLD servers, which are the skew case. Adopted shape: (1) mandatory client 400 latch — session record cap monotonically drops to compiled floor 32 on any blob-PUT 400 at cap >32, one degraded request per process; (2) new server emits distinct `too_many_records` AE outcome + deployment alert; (3) new server's 400 also carries `max` (mirrors batch-GET "too many shas"), used with 111-style shrinking validation when present. |
| 4 | MAJOR | The validation sweep is not runnable with the current harness: `sweep.sh` has scalar `RECORDS`, loops only `SLOTS`, no fill selector, and no `RBOX_API` — default CLI config targets PROD (`api-base.ts:3`); phase-3 client build is also a prerequisite (older clients clamp records to 32). | **ADOPT** — validation section now specifies the harness change (`RECORDS_SET`/`FILL_SET` axes, randomized repeated cells, mandatory dev `RBOX_API`, hard refusal to run >32 or fill-v2 cells against prod, effective settings recorded per row) and names the phase-3 prerequisite. |
| 5 | MAJOR | Fill gate (p50/tail) and resource gate were unmeasurable from cited telemetry: tail batches unidentifiable, lane `queueMs` is one aggregate sum, "no material CPU/memory regression" and "serialization remains bounded" had no source or threshold. | **ADOPT** — gates rewritten with named sources: fill distributions from per-event AE `count`; tail = dispatch-reason `idle_tail`+`absolute`; resource gate now numeric (zero 1102s, p99 <10 s at 64, client RSS + `peakUploaderFramingBytes` within 10% of 32-cells, non-inferior fallback/retry counts); response size bounded analytically and pinned in boundary tests. |
| 6 | MAJOR | `duration64/duration32 < 1.8` is the wrong falsifier: the design's own six-wide wave model gives an ideal full-batch ratio of 11/6 ≈ 1.833, so the threshold sits inside noise of healthy scaling; comparing fill-v2/64 against underfilled fill-v1/32 also confounds fill policy with record count. | **ADOPT (modified)** — a ratio near 1.83 does mean no amortization win (so failing would be directionally correct), but the confound and the noise-width tightness are real. Gate replaced: matched fill-v2 cells only, total slot work (sum of handler durations) must fall ≥10%, p95 <5 s, non-inferior error rates; the doc records why a raw ratio was rejected. |
| 7 | MAJOR | 112 must be inserted into the binding 109/110/111 order: it moves the `blob.batchPut` count/duration baseline (109 gate-0, 110 upstream-of-DO context) and receipt-arrival cadence into 111's drainer; landing it inside the step-4 shared-baseline window invalidates comparability. | **ADOPT** — new §"Seam with the 109/110/111 binding order": 112 state frozen and recorded in every 110/111 measurement cell; no 112 transition inside such a window; seam ledger order list to be amended at 112 implementation time; 109 gate-0 attribution must be rerun post-112 if 109 unparks (89 ms was measured against 17.3-record batches). |
| 8 | MINOR | "+40 ms worst case" over-broad: idle-tail can flush sooner; `close(err)` never flushes (cancels timer, rejects waiters). | **ADOPT** — claim rescoped to "additional timer-induced queueing while the uploader remains open", with idle-tail and close behavior stated. |
| 9 | MINOR | Memory framing should use the 8 MiB body bound (64 × 256 KiB is unreachable — body cap binds near 31 max-size records) and note client double-buffering (~2× body per active slot). | **PARTIAL ADOPT** — the doc never actually claimed 16 MiB (that arithmetic came from the reviewer prompt), so the "should not use" premise is misattributed; the useful clarification is adopted: server payload bound stays 8 MiB, record raise only affects small-record batches, client peak framing ≈ 2 body buffers/slot tracked by `peakUploaderFramingBytes`. |

Codex confirmed (no findings): timer genuinely non-sliding; timer path drains
ALL queued partials; exactly two partial-dispatch origins; 8 producers / ≤512
consumers structure; full-only dispatch would deadlock the putFile contract;
server SHA-dedup → parallel `putOneRecord` → single amortized fence → ordered
receipts; fence failure stays whole-request 503 (never singles-fallback); 64
records far below the 10k subrequest ceiling; linear projection arithmetic
correct and the doc honest that the 64 win may be near zero; per-request
skew fallback non-looping; old-client/new-server compatible;
`/v1/blobs/check`, commit shape, ciphertext format untouched; no violation of
111's 5,000-receipt cap or clamp contract; slots stay 24 (respects #245).

## Round 2 — VERDICT: CHANGES-REQUIRED

Codex verified round-1 fixes 2 (supply-gap limitation), 4 (harness spec), 6
(seam section), 7 (latency/memory bounds — confirming `floor(8 MiB /
(256 KiB + 36)) = 31`) as resolved; 1, 3, 5 partially, with the residuals
below. No CRITICAL or MINOR findings.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | MAJOR | Measurement-first framing contradicted by residual categorical causality: "Root cause" still asserted the timer "closes a batch too early … eagerly converts producer burstiness into half-full requests", and Option A predicted fill "will still average about 17 under 64" — unsupported, since under a wave-residue mechanism a larger cap CAN absorb a whole check wave into one fuller partial. | **ADOPT** — section renamed "Constraints and hypotheses"; item 1 is now an explicitly conditional hypothesis asserted only if the fill-v1 dispatch-reason baseline demonstrates it; Option A rejection re-based (no fill mechanism + no telemetry to interpret the result; D strictly contains A) instead of the unsupported ~17 prediction. |
| 2 | MAJOR | The 400 latch does not guarantee "one degraded request per process": with 24 slots, several oversized requests can be in flight when the first 400 lands, each independently falling back to singles; queued-batch re-carve after the cap drop was unspecified. | **ADOPT** (weaken-to-proven-bound option; the alternative >32 probation mechanism rejected as needless serialization of a rollback-only path) — bound restated as ≤ in-flight oversized requests at latch time (≤ slots), re-carve semantics specified (mutable session cap read at carve time; queued groups re-carve at 32), and a 24-concurrent-oversized test added with settle-exactly-once assertions. |
| 3 | MAJOR | `idle_tail + absolute = tail` is internally false: the doc itself diagnoses `absolute` as slow trickle, and a genuine end-of-producer tail can ship via `quiet`; a combined "tail" bucket in the fill gate could misdiagnose the experiment. | **ADOPT** — dispatch reasons now reported independently; only `idle_tail` is called an observed idle-tail dispatch; the doc states a true end-of-producer marker is unavailable without a producer-closed signal this design does not add; fill gate uses per-reason breakdown, no combined bucket. |
| 4 | MAJOR | `peakUploaderFramingBytes` is a per-invocation max (`blob-batch.ts:779,800`), not an aggregate across up-to-24 concurrent encodes, so the resource gate was not testing the stated slots × body bound and "already tracked" was wrong. | **ADOPT** (redefine option; aggregate in-flight counter rejected as instrumentation burden duplicating RSS signal) — metric explicitly redefined as per-request framing peak; aggregate client memory assessed via process peak RSS; gate 5 names both with their semantics. |

## Round 3 — VERDICT: CHANGES-REQUIRED

All four findings are precision defects in the round-1/2 adopted fixes
(prescribed-fix residuals); codex confirmed the section rename/Option A
re-basing, the ≤in-flight latch bound + concurrency test, independent reason
reporting, and the per-request framing definition as otherwise resolved.

| # | Sev | Finding | Disposition |
|---|-----|---------|-------------|
| 1 | MAJOR | The fill-v1 causal-baseline prerequisite is unevaluable with the declared reason vocabulary: `quiet`/`absolute` are fill-v2 semantics; fill-v1's fixed non-sliding timer path has no reason name. | **ADOPT** — per-version enums: fill-v1 emits `full_records/full_bytes/fixed_timer/idle_tail`; fill-v2 emits `full_records/full_bytes/quiet/absolute/idle_tail`; the baseline dominance test is defined on v1's `fixed_timer`+`idle_tail`. |
| 2 | MAJOR | Per-reason fill distributions cannot be derived from server AE per-event `count` joined with independent client reason counters. | **ADOPT** — client records a per-dispatch `(reason, records, bytes)` observation under lane-timing/sweep mode (numbers + one enum, local output, no identifiers); the sweep reports per-reason counts and record-count histograms; AE remains the source for overall fill only. |
| 3 | MAJOR | Resource-gate contradiction: `peakUploaderFramingBytes` (per-request) necessarily grows with fill (~2×547 KB at full 64 vs ~2×274 KB at 32), so "within 10% of 32-cells / no growth expected" was self-contradictory with the fill gate. | **ADOPT** — per-request framing now gets an analytical ceiling (~2× (body cap + headers)), with expected growth stated; only process peak RSS (aggregate, slots × body-cap bounded, unchanged) keeps the 10% comparison. |
| 4 | MINOR | Rollout table still said the latch makes skew "one-shot per process", contradicting the corrected ≤in-flight bound. | **ADOPT** — table now says "one latch event plus a bounded in-flight burst (≤ slots)". Also tightened per codex's residual note: the mutable session cap is specified to replace `config.records` at both read sites (`dispatchFull()` fullness check and `carve()` take limit). |

## Round 4 — VERDICT: ALIGNED

Confirmation round: no findings. All four round-3 residuals verified resolved
with code citations (per-version enums; client `(reason, records, bytes)`
observations with AE limited to overall fill; analytic ~2× framing ceiling
with RSS keeping the 10% aggregate comparison — matching the two-buffer
instrumentation at `blob-batch.ts:775`; latch bound wording + both
`config.records` read sites confirmed at `blob-batch.ts:643`/`674`).
