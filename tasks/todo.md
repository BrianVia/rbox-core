# Client phase metrics (design §35) — build plan

## Done
- [x] §35 upgraded: reconciled to the existing `SyncMetrics`/`onProgress` seam; added
      admin-surfacing (two planes) + the SQLite/DB/VM-image large-file-delta trigger.
- [x] `src/engine/phase-report.ts` — per-run `PhaseReport` collector (client `OpSpan`
      analogue): pure, no I/O, PII-free by construction, disabled-no-op default.
- [x] `src/engine/phase-report.test.ts` — aggregation, disabled no-op, header totals.

## Next — client coarse slice (the "easy bolt-on") — ✅ DONE (branch feat/phase-metrics-s35)
- [x] Add `report?: PhaseReport` to `SyncDeps`, defaulted off.
- [x] Wrap the coarse boundaries: push → scan / encrypt / upload / commit ;
      pull → scan / apply (download/decrypt/apply stay bundled until §36).
- [x] Populate `files`/`blobs` + the four bases (plaintext / ciphertext / wire / changed),
      one basis per phase; byte-basis computation gated behind `report.enabled`.
- [x] Surface env-gated by `RBOX_METRICS` via `beginReport(op)`: one-shot CLI prints the
      summary line; the daemon writes it to its log (`rbox logs`) via `logSummaryTo(log)`.
      No-op push tick + disabled path allocate nothing (report built after the short-circuit).
- [x] Tests: `phase-report.test.ts` (collector) + `sync.test.ts` §35 cases (push/pull phases +
      bases + disabled fallback). `bun test src/` green; root tsc clean.
- [x] `/simplify` applied (beginReport, logSummaryTo, enabled-gating, dead-param drop, type guard).
- Gate reasoning: `RBOX_METRICS` unset → `beginReport` returns `undefined` → disabled no-op →
  `logSummaryTo` never fires (no line); set → enabled report → one summary line. Verified by
  unit + sync tests; disabled-path cost confirmed near-zero by the efficiency review.

## STRETCH — SKIPPED (item 6): fold rolling aggregates into SyncMetrics for `rbox status`
Skipped deliberately: it only populates when `RBOX_METRICS` is on (the daemon builds no report
otherwise), so the `status` line would show phase data only for opt-in users — marginal value for
coupling always-on counters (`SyncMetrics`) with opt-in phase data. Revisit if we want an
always-on last-sync-timing line (would need a lightweight always-recorded wall-time, not the full report).

## Later — gated / separable
- [ ] Fine sub-phases (encrypt.hash/write/cthash, decrypt vs fs.apply) — land **with §36**.
- [ ] `pool.ts` enqueue→start hook for `upload.wait` / `download.wait`.
- [ ] `scripts/bench/` corpus harness + comparison script over the JSON sidecars.
- [ ] **Plane A** (admin): server AE → `adminOverview` read path — separable server slice;
      §25's four SQL queries already written (`docs/observability-server-metrics.md:79-161`).
- [ ] **Plane B** (admin): client opt-in aggregate upload — consent decision, deferred.
