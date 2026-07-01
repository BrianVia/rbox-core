# Client phase metrics (design §35) — build plan

## Done
- [x] §35 upgraded: reconciled to the existing `SyncMetrics`/`onProgress` seam; added
      admin-surfacing (two planes) + the SQLite/DB/VM-image large-file-delta trigger.
- [x] `src/engine/phase-report.ts` — per-run `PhaseReport` collector (client `OpSpan`
      analogue): pure, no I/O, PII-free by construction, disabled-no-op default.
- [x] `src/engine/phase-report.test.ts` — aggregation, disabled no-op, header totals.

## Next — client coarse slice (the "easy bolt-on")
- [ ] Add `report?: PhaseReport` to `SyncDeps` (`sync.ts:42`), defaulted off.
- [ ] Wrap the coarse boundaries that already exist via `onProgress`:
      push → scan / encrypt / upload / commit ; pull → download / decrypt / apply.
- [ ] Populate `files`/`blobs` + the four bases (plaintext / ciphertext / wire / changed)
      from the sets already computed in sync (`toEncrypt` / `missing` / `cipherSize`).
- [ ] Daemon: when enabled, write `summaryLine()` to the daemon log (`rbox logs`); fold a
      couple of rolling aggregates into `SyncMetrics` for the `rbox status` line.
      **Never allocate a report on a no-op tick.**
- [ ] Validation gate: no-op daemon tick stays near-zero with metrics enabled.

## Later — gated / separable
- [ ] Fine sub-phases (encrypt.hash/write/cthash, decrypt vs fs.apply) — land **with §36**.
- [ ] `pool.ts` enqueue→start hook for `upload.wait` / `download.wait`.
- [ ] `scripts/bench/` corpus harness + comparison script over the JSON sidecars.
- [ ] **Plane A** (admin): server AE → `adminOverview` read path — separable server slice;
      §25's four SQL queries already written (`docs/observability-server-metrics.md:79-161`).
- [ ] **Plane B** (admin): client opt-in aggregate upload — consent decision, deferred.
