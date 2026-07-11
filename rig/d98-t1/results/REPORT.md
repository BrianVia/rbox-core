# Design 98 Tier 1 A/B overlap report

**THROWAWAY / MEASUREMENT-ONLY.** Seeded synthetic data only. Correctness guard passed for every paired run.

Configuration: 200 files, 1421099 plaintext bytes, 3 runs per arm, PUT latency 15.0 ms, missing-check latency 30.0 ms, receipt latency 5.0 ms, crypto inline.

| Arm | Wall p50 ms | Wall range ms | PUT count p50 | Check calls p50 | Max concurrent PUTs p50 | Stored bytes p50 |
|---|---:|---:|---:|---:|---:|---:|
| A (serialized) | 111.3 | 97.2–159.6 | 200 | 1 | 200 | 669589 |
| B (pipeline) | 2093.2 | 2090.3–2107.9 | 200 | 25 | 8 | 669589 |

Overlap factor: **0.053×**  
Overlap headroom: **-1981.9 ms**

Finding: Arm B did not recover overlap on this small synthetic workload. Its 25 p50 rolling checks exceeded Arm A's 1; this is behavior of the production pipeline reached through the real entry point.
