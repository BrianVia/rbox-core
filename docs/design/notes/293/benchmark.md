# Design 293 no-drop ancestry benchmark

Recorded 2026-09-05 on Linux 7.0.0-30-generic x86_64, Bun 1.4.0, Git 2.54.0. Command: `bun scripts/bench/nodrop-ancestry.ts`.

```text
warmups=5 samples=20 roots=5
30 tips | legacy p50=109.68ms p95=112.59ms spawns=68 | batched p50=7.56ms p95=8.28ms spawns=4
500 tips | legacy p50=1675.79ms p95=1772.37ms spawns=1008 | batched p50=15.24ms p95=16.16ms spawns=4
```

The corpus deliberately preserves positional duplicates: every protected tip and all five roots resolve to the same commit. This is the cheapest all-owned topology and therefore understates the legacy nested-loop cost; it still demonstrates that the batched path's four Git subprocesses are independent of protected-tip count.
