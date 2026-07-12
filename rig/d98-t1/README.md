# Design 98 Tier 1 overlap harness — THROWAWAY

**THROWAWAY / MEASUREMENT-ONLY. Nothing here ships.** This harness creates a
seeded synthetic corpus under the OS temporary directory, invokes the real
production `encryptAndUpload` entry for the legacy and pipelined arms, and then
deletes every fixture. It never reads user files, uses no network, and emits no
file paths or content addresses.

Run:

```sh
bun rig/d98-t1/run.ts --files 500 --runs 5 --put-ms 15
```

Options are `--files N` (minimum 64), `--runs N`, `--put-ms N`,
`--missing-ms N` (default 30), and `--pool`. Crypto runs inline by default
(`RBOX_CRYPTO_WORKERS=0`); `--pool` allows the production worker-pool choice.

Each run alternates A/B order and uses fresh, identical workspaces. Arm A unsets
`RBOX_PUBLISH_PIPELINE`; Arm B sets it to `1`. Results are written to
`rig/d98-t1/results/REPORT.md` and `results.json` and contain counts, bytes, and
durations only.
