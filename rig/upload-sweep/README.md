# rig/upload-sweep

Sweeps upload-batch fill policy and wire-cap settings to measure the upload lane.
Pairs with the `RBOX_UPLOAD_SLOTS`, `RBOX_BATCH_RECORDS`, and
`RBOX_BATCH_FILL` client knobs.

## What it measures, and what it deliberately does not

- **Isolates the blob-batch PUT lane.** The corpus is a subset of **small
  (≤256 KiB), non-`.git`** files, and git-sync is disabled (`--git false`). So
  multipart (large blobs) and git-pack traffic never enter the number — this is the
  batch uploader's throughput alone.
- **Three-axis repeated sweep.** The harness runs the full
  `SLOTS × RECORDS_SET × FILL_SET` cross-product (defaults `24`, `32`, and
  `v1`), repeats it `REPEATS` times, and randomizes the complete point list when
  `shuf` is available. Slots are deliberately held at 24 by default per
  [design 112](../../docs/design/112-batch-fill-wire-cap.md) (#245 says not to
  sweep slots upward here). `v1 × records>32` cells are **skipped with a note**:
  the client clamps fill-v1 records to 32, so running them would record a
  mislabeled cell and poison the matched-cell gates.

## How it runs (safety model)

Sequential, one point at a time — never parallel publishes. **One** `rbox init --new`
for the whole sweep (a single device-identity clobber), with the main daemon stopped
so the clobber is inert. Each point re-salts every file (fresh content → fresh blobs
→ a real full re-upload) and runs a foreground `rbox sync` with the knob set.

Teardown restores the host's real device identity from `/tmp/rbox-id-backup`
(`e2ee/` + `credentials.json`) and restarts the main daemon.

## Run

```sh
# On the bench host, with a branch-built binary (NOT in a live workspace):
RBOX=... RBOX_API=https://rbox-dev-api.<acct>.workers.dev RECORDS_SET="32 64" FILL_SET="v1 v2" REPEATS=3 rig/upload-sweep/sweep.sh
```

`RBOX_API` is mandatory and should name the dev worker. The harness refuses
`api.rbox.to` (case-insensitive) by default because every run creates a junk
workspace and thousands of junk blobs. `ALLOW_PROD=1` is the conscious operator
override.

`RBOX_API` only sets the client's *default* remote — stored credentials override
it (`init-plan.ts`, `e2ee-client.ts`). After init the harness therefore asserts
the effective remote in `~/.rbox/credentials.json` matches `RBOX_API` and aborts
(with identity restore + daemon restart, via an EXIT trap) if it does not: log in
against the dev worker first, or move the credentials file aside.

Env overrides: `SRC` (default `~/code`), `ROOT` (`/tmp/rbox-sweep`), `TARGET_BYTES`
(400 MiB), `MAX_FILE` (256 KiB), `SLOTS`, `RECORDS_SET`, `FILL_SET`, `REPEATS`,
`MAIN_ROOT` (`~/Development`), `BACKUP` (`/tmp/rbox-id-backup`), and
`INSTALLED_RBOX` (`~/.rbox/bin/rbox` — the host's real daemon is stopped/restarted
with THIS binary, never the bench build). Legacy `RECORDS` supplies the
`RECORDS_SET` default when `RECORDS_SET` is unset.

Records greater than 32 require both a phase-3 client build and a dev server
deployed with acceptance cap 64. Older clients clamp `RBOX_BATCH_RECORDS` to 32;
an old server returns 400 for oversized batches. The harness cannot detect either
prerequisite.

Outputs `results/sweep.csv` and `results/sweep.md` under `ROOT`. Each point creates
junk blobs in one bench workspace whose `ws_…` id is printed and recorded in the
markdown — delete it server-side afterwards.

Every CSV row records the effective `slots`, `records`, and `fill`, total client
slot work (`slot_work_s` — the lane summary's total upload seconds, i.e. the sum
of per-request HTTP durations), the six per-reason dispatch counts (`NA` when the
lane line or dispatch segment is absent — never fabricated zeros), a compact raw
dispatch list, and the `api` base + client `build` version, alongside the existing
throughput and timing measurements. The markdown table includes fill, slot work,
and dispatch.

The markdown's **Gates (design 112)** section averages repeats per cell and reports:

- the fill-v1 dominance baseline: whether `fixed_timer + idle_tail` exceeds 50%
  of dispatches, the precondition for the timer/idle causal claim;
- a matched `(slots, records)` fill gate: fill-v2 must reduce mean slot work by at
  least 10% versus fill-v1;
- a matched fill-v2 cap gate: each higher records cell must reduce mean slot work
  by at least 10% versus that slots value's lowest records baseline. Fill versions
  are never crossed for this cap comparison.

These are informational harness gates from
[design 112](../../docs/design/112-batch-fill-wire-cap.md); missing telemetry or
cells are reported as `n/a` and do not change the script exit status.

## Known host bugs worked around

- `rbox init --new --no-interactive` clobbers the machine device identity → restored
  in teardown.
- It also never exits headlessly after "rbox is set up" → run via `setsid … &`, poll
  the log for that line, then kill the process group.
