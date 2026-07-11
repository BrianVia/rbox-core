# Design 99 Phase-0 harness — THROWAWAY

**THROWAWAY / MEASUREMENT-ONLY. Nothing here ships.** Synthetic seeded data
only; no real user files; no file paths in any emitted artifact. Compares the
real per-file `CryptoPool` control (Arm A, driven at production caller
concurrency) with the design-99 fused, byte-bounded in-memory prototype
(Arm B) and emits the §5.3 gate evidence + the RAM-vs-throughput curve that
selects `CIPHERTEXT_BUDGET_BYTES`.

Spec: `SPEC-P0.md`. Design: `docs/design/99-fused-crypto-worker-jobs.md` §5.

Run:

```sh
bun rig/d99-p0/run.ts --determinism-only
bun rig/d99-p0/run.ts --files 20000 --budgets 24,48,96,192 --runs 5 --passes 2 --settle 0,40 --inflight 1,2
```

Outputs land in `rig/d99-p0/results/` (`REPORT.md`, `results.csv`,
`results.json`). `--settle N` holds each per-file ciphertext charge for N ms to
model upload-settlement lease residence (§4.1); `settle=0` is the pure §5.3
null-sink encrypt critical path. A worker-count scaling diagnostic (A and B at
4/8/prod workers) runs on pass 1; `--no-scaling` skips it.
