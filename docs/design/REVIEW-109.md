
## Gate 0 — EVALUATED 2026-07-13 (existing AE data, FM A/B window 23:50–01:10 UTC)

- `request` op (`POST /v1/blob-batch/put`): n=1,930, avg **822ms** total.
- `blob.batchPut` handler: n=2,360, avg **733ms**, avg **17.3/32 records**,
  avg **148KB** body (8MiB cap).
- Pre-handler auth/routing ≈ **89ms/request (~11%)** → ~9s of the 107.7s
  envelope at 24 lanes. Small.
- Batch fill is the dominant lever: half-empty on records, **~2% of the byte
  cap** — per-batch settle (~733ms) is paid ~2,360 times for ~8.5KB/blob
  payloads.

**VERDICT: gate 0 fails for the auth refactor — design 109 PARKS in favor of
option D (batch fill / more bytes per round trip), per §6.0.** Option D aligns
with the #245 sweep verdict (server-side settle latency + the 32-record wire
cap are the honest levers; a records-cap raise is a coordinated client+server
wire change). The auth work stays shelved unless a future gate-0 rerun shows
the pre-handler share growing after fill improves.

## Gate 0 — EVALUATED 2026-07-13 (existing AE data, FM A/B window 23:50–01:10 UTC)

- `request` op (`POST /v1/blob-batch/put`): n=1,930, avg **822ms** total.
- `blob.batchPut` handler: n=2,360, avg **733ms**, avg **17.3/32 records**,
  avg **148KB** body (8MiB cap).
- Pre-handler auth/routing ≈ **89ms/request (~11%)** → ~9s of the 107.7s
  envelope at 24 lanes. Small.
- Batch fill is the dominant lever: half-empty on records, **~2% of the byte
  cap** — per-batch settle (~733ms) is paid ~2,360 times for ~8.5KB/blob
  payloads.

**VERDICT: gate 0 fails for the auth refactor — design 109 PARKS in favor of
option D (batch fill / more bytes per round trip), per §6.0.** Option D aligns
with the #245 sweep verdict (server-side settle latency + the 32-record wire
cap are the honest levers; a records-cap raise is a coordinated client+server
wire change). The auth work stays shelved unless a future gate-0 rerun shows
the pre-handler share growing after fill improves.
