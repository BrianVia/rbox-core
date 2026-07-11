# Design 99 Phase-0 A/B report

**THROWAWAY / MEASUREMENT-ONLY.** Synthetic data only.

DETERMINISM: PASS (33 boundary/property cases, byte-identical vs untouched oracle)

Host: linux x64, 32 logical CPUs; corpus + temps on OS tmpdir; ALL cells uniformly page-cache warmed after corpus generation; cell order interleaved (A then B cells per run); cold runs: unavailable (no drop_caches privilege) — warm-only, so the gate evidence is warm-cache only. Final N: 20000; workers: 16 (production configuredWorkers()); Arm A caller width = workers*2 (production poolMap).

## Corpus (avg across 2 passes, seeds differ per pass)

| Bucket | Count | Bytes |
|---|---:|---:|
| empty | 600 | 0 |
| tiny | 4400 | 1115824 |
| small | 6000 | 7686484 |
| med | 4400 | 22555019 |
| large | 2600 | 53522886 |
| xl | 1400 | 114261245 |
| near-cap | 400 | 78846805 |
| over-cap | 200 | 132599859 |

Fuse eligible (avg): 19800 files, 277988262 bytes. Content mix: seeded 60% compressible / 40% incompressible, all files unique (100% cache-miss population).

## A/B encrypt wall + RAM-vs-throughput curve (inflight=1)

settle=0 is the pure §5.3 null-sink encrypt critical path; settle=40 ms models upload-settlement lease residence (§4.1) and is the curve the budget is selected from.

| Budget MiB | dispatch cap | settle ms | A p50 ms | B p50 ms | Delta | B files/s | B peak RSS MiB | Budget HWM MiB | Peak held charges | Spill bytes |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 24 | 0 | 0 | 10008.4 | 1392.9 | 86.1% | 14258 | 661 | 20 | 0 | 0 |
| 48 | 0 | 0 | 10008.4 | 4426.3 | 55.8% | 4495 | 739 | 45 | 0 | 0 |
| 96 | 0 | 0 | 10008.4 | 6464.9 | 35.4% | 3012 | 770 | 65 | 0 | 0 |
| 192 | 0 | 0 | 10008.4 | 6399.1 | 36.1% | 3051 | 791 | 65 | 0 | 0 |
| 24 | 5 | 0 | 10008.4 | 1183.5 | 88.2% | 16893 | 593 | 20 | 0 | 0 |
| 48 | 5 | 0 | 10008.4 | 1310.6 | 86.9% | 15239 | 615 | 45 | 0 | 0 |
| 96 | 5 | 0 | 10008.4 | 1317.7 | 86.8% | 15140 | 620 | 65 | 0 | 0 |
| 192 | 5 | 0 | 10008.4 | 1236.1 | 87.6% | 16082 | 626 | 65 | 0 | 0 |
| 24 | 0 | 40 | 10008.4 | 1603.1 | 84.0% | 12436 | 678 | 24 | 2048 | 110906521 |
| 48 | 0 | 40 | 10008.4 | 4360.2 | 56.4% | 4498 | 737 | 48 | 1536 | 96776981 |
| 96 | 0 | 40 | 10008.4 | 6645.5 | 33.6% | 2909 | 801 | 82 | 3072 | 0 |
| 192 | 0 | 40 | 10008.4 | 6171.9 | 38.3% | 3163 | 792 | 84 | 2560 | 0 |
| 24 | 5 | 40 | 10008.4 | 1301.4 | 87.0% | 15092 | 646 | 24 | 2560 | 110946886 |
| 48 | 5 | 40 | 10008.4 | 1364.8 | 86.4% | 14494 | 620 | 48 | 2581 | 99999677 |
| 96 | 5 | 40 | 10008.4 | 1340.8 | 86.6% | 14523 | 636 | 87 | 2560 | 0 |
| 192 | 5 | 40 | 10008.4 | 1320.9 | 86.8% | 15120 | 657 | 86 | 2560 | 0 |

Arm A peak RSS 1042 MiB, peak FD 130; gate-cell B peak FD 102.

## Worker-count scaling diagnostic (pass 1, 1 run per cell — context, not the gate)

| Workers | A wall ms | B wall ms (192 MiB, settle 0) |
|---:|---:|---:|
| 4 | 1942 | 1279 |
| 8 | 3455 | 1431 |
| 16 | 13121 | 8600 |

Both arms degrade severely as worker count rises on this host/runtime (Bun 1.3.14, streaming zstd). See findings.

## Selection + gate

- SELECTED CIPHERTEXT_BUDGET_BYTES: 100663296 (96 MiB), dispatch cap 5 — smallest ZERO-SPILL budget within 5% of best throughput on the settle=40 ms residence curve (§4.2 health first).
- Secondary sweep: in-flight sweep not run.
- Headline gate delta (A vs B at selected budget, settle=0): 86.8% (p50), bootstrap 95% CI [84.1%, 87.7%].
- Memory: B peak RSS ≤ A + budget + 32 MiB: true. FD: B ≤ A: true.
- Pass-to-pass A wall p50 spread: 15.3% (per-pass p50s in results.json).

**GATE VERDICT: GO** — ≥30% with the full CI above the margin: true.
