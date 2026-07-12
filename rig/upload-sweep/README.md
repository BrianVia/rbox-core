# rig/upload-sweep

Sweeps upload-batch **slot** concurrency to re-measure the ~35 Mbps upload ceiling
the fleet hits on every host (a slot×latency bound: ~364 blobs/s ⇒ ~2s per 32-blob
batch at 24 slots). Pairs with the `RBOX_UPLOAD_SLOTS` / `RBOX_DOWNLOAD_SLOTS` /
`RBOX_BATCH_RECORDS` knobs in `src/cli/remote/blob-batch.ts`.

## What it measures, and what it deliberately does not

- **Isolates the blob-batch PUT lane.** The corpus is a subset of **small
  (≤256 KiB), non-`.git`** files, and git-sync is disabled (`--git false`). So
  multipart (large blobs) and git-pack traffic never enter the number — this is the
  batch uploader's throughput alone.
- **Slots axis only** (`{24,48,96,192}`). The **records** axis is pinned at the
  server wire cap (`apps/api` `MAX_BATCH_RECORDS = 32`): the server 400s any larger
  batch, so records >32 cannot run against a live server. Sweeping records needs a
  coordinated client+server wire-cap bump and a dev deploy — out of scope for a
  client-only, prod-safe run.

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
RBOX=/tmp/rbox-sweep-build/rbox rig/upload-sweep/sweep.sh
```

Env overrides: `SRC` (default `~/code`), `ROOT` (`/tmp/rbox-sweep`), `TARGET_BYTES`
(400 MiB), `MAX_FILE` (256 KiB), `SLOTS`, `RECORDS`, `MAIN_ROOT` (`~/Development`),
`BACKUP` (`/tmp/rbox-id-backup`), `INSTALLED_RBOX` (`~/.rbox/bin/rbox` — the host's
real daemon is stopped/restarted with THIS binary, never the bench build).

Outputs `results/sweep.csv` and `results/sweep.md` under `ROOT`. Each point creates
junk blobs in one bench workspace whose `ws_…` id is printed and recorded in the
markdown — delete it server-side afterwards.

## Known host bugs worked around

- `rbox init --new --no-interactive` clobbers the machine device identity → restored
  in teardown.
- It also never exits headlessly after "rbox is set up" → run via `setsid … &`, poll
  the log for that line, then kill the process group.
