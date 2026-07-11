# Design 98 Tier 1 A/B overlap report

**THROWAWAY / MEASUREMENT-ONLY.** Seeded synthetic data only. Correctness guard passed for every paired run.

Configuration: 2000 files, 12538611 plaintext bytes, 3 runs per arm, PUT latency 20.0 ms, missing-check latency 30.0 ms, receipt latency 5.0 ms, crypto inline.

| Arm | Wall p50 ms | Wall range ms | PUT count p50 | Check calls p50 | Max concurrent PUTs p50 | Stored bytes p50 |
|---|---:|---:|---:|---:|---:|---:|
| A (serialized) | 1492.4 | 1412.4–1597.7 | 2000 | 1 | 40 | 5156941 |
| B (pipeline) | 1339.7 | 1206.4–1354.3 | 2000 | 7 | 40 | 5156941 |

Overlap factor: **1.114×**  
Overlap headroom: **152.6 ms**

Finding: Arm B recovered positive overlap headroom on this small synthetic workload.
