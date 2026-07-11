# REVIEW-101 — adversarial review ledger for design 101

Reviewer: codex (`gpt-5.6-sol`, read-only), attacking
`docs/design/101-parallel-multipart-transfer.md` against audit Finding 10.
Loop cap: 5 rounds. Alignment target: `VERDICT: ALIGNED`.

## Round 1 — VERDICT: REVISE (14 items)

| # | Item | Disposition |
|---|------|-------------|
| 1 | G1 becomes contradictory: G-measure re-scopes the 2x gate to "part share" while rollout still ships on G1 even when end-to-end 2x is impossible. Keep two immutable gates. | FIXED. G1 (end-to-end 2x) is now immutable and reported truthfully as pass/fail; a new **G-part** (part-phase 2x) is the Phase-1 ship gate. No redefinition. §5, §7.2. |
| 2 | Byte budget bounds occupancy, not bandwidth; a replenished window still saturates the uplink; the 24-slot lane gets no fairness guarantee; G3's "no large blob present" control is impossible on a capacity-bound link. | FIXED. Reframed the budget as an occupancy bound (not a starvation proof); added an explicit fairness mechanism (multipart yields when batch-PUT work is queued); G3 now compares parallel-mixed vs **serial-large-mixed control** with a defined acceptable regression. §3.2, §7.2. |
| 3 | Scheduler fairness unspecified (queue order, cancellation, oversized semantics). | FIXED. Specified FIFO, abortable waiters, head-of-line reservation for an oversized part, and the three fairness tests. §3.2. |
| 4 | Orphan cleanup over-asserted: deleting the D1 row does not abort the R2 MPU, and a *completed* staging object is not an incomplete MPU (7-day lifecycle does not cover it). | FIXED. Added a per-failure-point object-state inventory (§8 table) and an explicit **`staging/`-prefix reaper** (R2 lifecycle rule) that covers completed-but-abandoned staging objects; noted it is a pre-existing gap this design does not worsen. §8, DEPLOYMENTS note. |
| 5 | Parallel first-error must not let completion/re-init race surviving in-flight PUTs. Require structured concurrency. | FIXED. §3.1 now requires: stop launching, abort in-flight, **await settlement of every launched part**, then classify/re-init. AbortController per part. |
| 6 | "Serial-correct fallback on any doubt" undefined at runtime. | FIXED. Defined: the flag picks serial-vs-parallel at attempt START; "fallback" = the existing outer `putBlobMultipart` recovery, entered only after the §3.1 drain, reusing the server-authoritative part set. §3.1, invariant. |
| 7 | G2 "zero already-landed parts" conflicts with lost-ack; "+1 part" bound too tight. | FIXED. G2 redefined in terms of server-observed completed set after all requests settle; ambiguous retransmission bounded by max in-flight; serial-vs-parallel under identical fault schedules. §7.2. |
| 8 | Completion timing can't be both returned and include `finally` cleanup. | FIXED. `cleanupMs` is metric-only (runs after response serialization, design-97 rule); the returned object carries totalMs/assemble/reread/accounting; client completion wall documented to include cleanup, reconciled via the metric. §5 P0.2. |
| 9 | Ranged-download revocation boundary incomplete. | FIXED by descope (see #11): ranged download becomes a measurement-outcome + follow-on design; the revocation boundary is named as a required question for that follow-on, not claimed unchanged here. §6. |
| 10 | G4 unfalsifiable. | FIXED by descope: G4 removed; replaced by a single Phase-0 **download-pole measurement gate** with a defined pole-share threshold that only decides whether to open the follow-on design. §5, §6. |
| 11 | Phase 2 (ranged download) is a separate design-sized feature; drifts beyond Finding 10. | FIXED. Ranged download descoped to a follow-on (design 102) gated on the Phase-0 measurement; this doc's shipped scope is multipart upload + completion measurement only. §6. |
| 12 | Completion-mitigation track not design-ready; can't be "promoted to required" while Phase 1 ships regardless; R2 capability unverified. | FIXED. Decoupled from the Phase-1 gate; mitigation requires verifying R2 capability FIRST; added the explicit statement that no checksum composition equals verifying `encSha` unless R2 validates the exact assembled byte sequence. §7.3. |
| 13 | Prohibit satisfying gates by retuning shipped 24/48/64 lanes / compression / thresholds. | FIXED. Added as a hard constraint. §7.2, §10. |
| 14 | Phase 0 (measurement-only) cannot sweep parallel concurrency before Phase 1 exists. | FIXED. Split: Phase 0 = shipped instrumentation on the SERIAL baseline (+ completion split); the concurrency-knee **sweep** runs as a Phase-1 experimental harness (flag on, not default) before the shipped default is chosen. §5, §9. |

Revised doc for Round 2.

## Round 2 — VERDICT: REVISE (10 items; R1 items 1, 3, 5, 6, 8-14 confirmed resolved; R1 2/4/7 needed more)

| # | Item | Disposition |
|---|------|-------------|
| 1 | G2 is not a ship gate — "no resume regression" unenforced. | FIXED. Phase 1 ships iff **G-part AND G2 AND G3** on the same configuration. §7.2, §9. |
| 2 | G2 too weak/tautological (max-in-flight bound as acceptance; omits resume wall, bytes, re-init count, success rate). | FIXED. G2 now requires no statistically material regression in resume completion wall + total retransmitted bytes, and no-worse re-init count/success rate, under identical fault schedules; the max-in-flight bound demoted to a separate correctness-ceiling invariant. §7.2. |
| 3 | 24h staging rule silently aborts resumable MPUs — resume regression. | FIXED. Split into rule A (abort incomplete MPUs at 7d — retention UNCHANGED, ≥ client 6d resume window) and rule B (delete completed objects at 24h — provably outside every resume path: a completed staging object only exists after its MPU is consumed). Boundary tests both sides of each age. §8.1. |
| 4 | Lifecycle mechanism not design-ready (two distinct actions; ownership/verify/rollback unspecified; simultaneously "prerequisite" and "open question"). | FIXED. Two explicit rules with actions named; operational spec (dev-first buckets, owner, post-apply verification incl. P0.3 probe, rollback); explicitly a proposal pending §11 Q2 capability confirmation, with a cron-Worker fallback if per-prefix rules are unsupported. §8.1, §11 Q2. |
| 5 | Orphan inventory misses canonical-orphan states (death between canonical put / blobs insert / grant / response). | FIXED. §8 table rows out each boundary: canonical-put→insert (row-less verified canonical = documented P2-reapable orphan, healed by retry overwrite-adopt + re-account), insert→grant (entitlement-gated check reads missing → retry grants), grant→response (existing missingBlobs lost-ack recovery). Named heal-or-reap for every state. |
| 6 | "Reserved floor" reserves nothing; mechanism is adaptive throttling, not a bandwidth guarantee; busy-transition undefined; permit zero-admission extreme. | FIXED. Renamed adaptive throttling throughout; busy-transition semantics defined (in-flight parts settle, no new admissions above reduced cap, restore on drain); `…_WHEN_BATCH_BUSY = 0` (no new admissions while batch queued) is a first-class G3 candidate. §3.2. |
| 7 | G3 tunable into an unfalsifiable loop. | FIXED. Preregistered finite candidate set {32 MiB, 16 MiB, 8 MiB, 0}, one run each in order, first-pass selected, G-part+G2 must hold on the SAME candidate, and "no candidate passes → Phase 1 does not ship" is the recorded outcome. §7.2. |
| 8 | Starvation coverage too narrow (aggregates only). | FIXED. G3 adds p99/max batch queue wait (≤ 2× serial-large control) and a sustained-arrival sub-workload (small batches start after multipart steady state) with throttle time-to-effect measured. §7.2, §3.2. |
| 9 | Abort propagation through retry underspecified. | FIXED. `retryTransient`/`uploadPartWithRetry` observe the signal: abort interrupts backoff sleep, forbids further attempts, rejects budget waiters; tests for abort during fetch, backoff, and budget wait. §3.1. |
| 10 | G1 informational — must not claim Finding 10 achieved. | FIXED. "Finding 10 stays OPEN until G1 AND G2 pass"; Phase 1 on G-part alone is recorded as a scoped sub-result / audit recommendation partially achieved. §7.2, §9. |
| 11 | (Positive) download/completion fencing correct — keep unchanged. | KEPT. No changes to §6, §7.3 fencing, chunk-sync exclusion, shipped-lane freeze. |

Revised doc for Round 3.

## Round 3 — VERDICT: REVISE (7 items; R2 items 1, 3, 6, 7, 8, 9, 10 confirmed resolved; no new integrity/revocation/chunk-sync/shipped-work findings)

| # | Item | Disposition |
|---|------|-------------|
| 1 | §7.3 reintroduces the G2 ship-gate bug ("ships on G-part+G3"). | FIXED. §7.3 now states the identical three-gate condition (G-part AND G2 AND G3, same configuration). |
| 2 | G2 still insufficiently falsifiable (no fault matrix, sample counts, or explicit bounds; sparse counts mishandled). | FIXED. Predeclared fault classes F1-F6 (lost ack, active-fetch kill, backoff abort, k-accepted/j-in-flight kill, dead MPU, completion-response loss); 10 runs per class per mode; explicit bounds: success rate 100% both modes (categorical), wall p50 ≤ 1.10× serial per class, retransmitted bytes p50 ≤ 1.10× serial per class, re-init counts summed across the whole matrix ≤ serial's sum; max-in-flight ceiling per run kept as a separate invariant test. §7.2. |
| 3 | G3 "one run per candidate" incompatible with its tail statistics; p99 unsupportable at 10 samples. | FIXED. A "run" = the full preregistered sample set (10 samples per sub-workload per mode); tail statistics computed on POOLED per-batch queue-wait observations (hundreds-to-thousands per sample); max wait reported, not gated. §7.2. |
| 4 | Canonical-orphan cleanup unnamed/unbounded; P0.3 didn't count row-less canonicals. | FIXED. §8.2 adds a named reaper: admin-triggered canonical-orphan audit (RBOX_PLATFORM_SECRET surface) that lists the canonical prefix, and for keys with no `blobs` row and R2 upload age ≥ 7d inserts a `gc_candidates` intent — design-95 P1/P2 then deletes under its existing quiescence/fence/activity-unwind. Eligibility proof: 7d > 6d client expiry; a live retry restores rows or is unwound by P2's re-checks. P0.3 extended to inject canonical-put→insert and insert→grant deaths and count row-less canonicals. §8, §8.2, §5 P0.3, §7.1. |
| 5 | §8.1 fallback only replaced rule B; rule A unprovided if per-prefix rules unsupported. | FIXED. Rule A's fallback is R2's bucket-wide default incomplete-MPU abort at 7d (the TTL `blobs.ts:107` already assumes), verified by listing lifecycle config; if BOTH per-prefix and the default are absent, the cron fallback also aborts >7d `staging/` MPUs. Every branch meets the prerequisite. §8.1. |
| 6 | batchLaneBusy check/admission race defeats "no new admissions". | FIXED. Busy flag flipped synchronously in `enqueue` before any await; admissions re-read at grant time on the single event loop; residual interleave bounded at ONE part and folded into G3's measured time-to-effect. §3.2. |
| 7 | Orphan invariant overclaims ("every state reaped", counts "reach zero") without per-class bounds or a server-side path for client-absent states. | FIXED. Explicit per-class bounds added (MPU ≤ 7d; completed staging ≤ 24h; stale D1 rows: next init sweep or §8.2 audit; canonical orphan: next client retry or §8.2 audit ≥ 7d); §7.1 req 4 restated as healed-or-reaped within those bounds; §8.2 supplies the server-side path. §8, §7.1. |

Revised doc for Round 4.

## Round 4 — VERDICT: REVISE (4 items; R3 items 1, 3, 5 confirmed resolved; no new integrity/revocation/chunk-sync/shipped-work findings)

| # | Item | Disposition |
|---|------|-------------|
| 1 | G2's F4 (j ≥ 2 in flight) cannot run identically on the serial control. | FIXED. Split: **F4a** (k ≥ 2 accepted, exactly j = 1 in flight) is the control-compatible regression class; **F4b** (j ≥ 2) is a parallel-only correctness/ceiling test (success rate, max-in-flight ceiling, resume-set correctness) feeding NO regression statistic. §7.2. |
| 2 | "One extra admission" bound did not follow — a synchronous release/drain burst can grant many waiters before the enqueue task runs. | FIXED. Grant loop is the shared linearization point: re-checks the busy flag before EACH permit, stops on flip, and **yields to the event loop between permits (one permit per turn)** — restoring the one-part bound with a real mechanism (negligible cost per ≥ 8 MiB part). Test added: enqueue racing a many-waiter drain admits ≤ 1 part post-flip. §3.2. |
| 3 | "Next audit run" is not a falsifiable bound (admin-triggered, unspecified cadence). | FIXED. Audit is SCHEDULED on design 95's existing daily GC cron (admin trigger kept for tests); explicit end-to-end bounds: canonical orphan ≤ 10d (7d eligibility + ≤ 1d cron + ≤ 2d P2 quiescence/execution), stale rows ≤ 7d + 1d; overdue work emits the GC drain's existing overdue signal. §8, §8.2. |
| 4 | The `0` busy-cap candidate can pass G3 while starving the large blob (G-part measured only in isolation). | FIXED. G3 gains a large-blob liveness bound on the sustained-arrival sub-workload: parallel completion wall ≤ 1.10 × serial-large mixed control p50 — binding the `0` candidate specifically; a starving candidate fails G3 and is recorded. §7.2. |

Revised doc for Round 5.

## Round 5

Verdict: _pending_
</content>
