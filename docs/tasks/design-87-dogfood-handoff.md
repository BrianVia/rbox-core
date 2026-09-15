# Design 87 dogfood → reliability handoff (via-desktop-ubuntu, 2026-07-08)

First real agent-key join: `RBOX_KEY` minted on the Mac (key
`agent_fyA477u1fBBCVuU1r3gn1Q`, 90d), then on a fresh Ubuntu x86_64 box:
`curl rbox.to/agent.sh | sh -s -- --workspace=ws_2b6e15da… --dir ~/Development
--force --daemon`. Workspace: 119,813 files / ~14GB written / 98 git repos,
over ethernet. Outcome: **join succeeded end-to-end, git parity byte-exact
(same HEAD, index/stash intact), but it took a kill + manual `rbox pull` to
get there.** Fix list below, priority order — this is for the perf/reliability
flow, not the feature flow.

## P0 — populate-pull hangs forever on a lost blob completion

The initial pull wedged at **119,812/119,813** and sat 25+ minutes doing
literally nothing: all 42 threads in **untimed `FUTEX_WAIT`** (strace), **zero
open TCP sockets** (`ss -tnp`), **zero IO delta** (`/proc/<pid>/io` sampled
6s apart, write_bytes frozen at 14,022,443,008). One blob download's
completion was lost and the pull's join awaited a promise that can never
resolve. No error, no retry, no timeout, no progress line — indistinguishable
from "slow" without strace.

- PR #128's 60s deadlines cover **control fetches**; the populate-pull **blob
  path evidently has no deadline** (or designs 80/81 batch-download/worker-pool
  can drop a completion — the last file's callback never fired).
- Fix shape: per-blob fetch deadline + bounded retries, AND a
  liveness watchdog on the pull join (if downloaded-count hasn't moved in N
  seconds, log which shas are outstanding and retry them). The silent variant
  is the killer; even a crash would have been better.
- Repro odds unknown (1 blob in 119,813) — treat as race, not fluke: the same
  class produced the 110-min black holes #128 killed on the control plane.
- Recovery data point (good news): after `kill`, a plain `rbox pull` **resumed
  perfectly** — re-scanned, fetched exactly the 1 missing file, no
  re-download. Resume is solid; only the hang is broken.

## P1 — keyed setup doesn't persist credentials → daemon dies with the shell

`rbox setup --workspace --key…` keeps auth ONLY in the invoking process env
(`RBOX_TOKEN` etc. from `materialize`). No `~/.rbox/credentials.json` is
written. Consequences observed:

- Any other shell: `rbox status` → "account not signed in (run rbox login)".
- `--daemon` starts a watcher that survives until reboot at most; after
  reboot the box has a keystore (device.json/mk.key) but **no bearer** —
  fully enrolled cryptographically, unable to authenticate.
- Fix: keyed setup (at minimum when `--daemon` is passed) must persist the
  bearer to `credentials.json` (mode 600), same as interactive setup. The
  CI one-shot case can keep env-only via `materialize`, but `setup` is the
  durable-join porcelain and should behave durably.
- (The test box was fully torn down afterward — key revoked
  (`agent_fyA477u…`, revocation verified in `rbox key list`), ~/Development
  and ~/.rbox wiped. Re-running the dogfood after fixes = mint a fresh key,
  same one-liner. Raw logs: `docs/tasks/dogfood-evidence/`.)

## P2 — status/prompt lie during the initial populate pull

While the 20-minute initial pull ran, `rbox status` (and the zsh prompt
integration) reported: "background sync not running — rbox start" and
"**120,058 local changes to sync (120,058 new)** · sequence 0". To a user this
reads as broken-and-about-to-push-everything, mid-download. Brian hit exactly
this over ssh.

- Fix: populate-sync should hold a state/lock file that `status` (and the
  prompt line) surfaces as "initial sync in progress — N/M files"; the
  local-changes counter should not be computed against an empty baseline
  while a populate is in flight.

## P3 — two cosmetic-but-real UX wrinkles

- **Killed-pull residue becomes conflicts:** the post-kill `rbox pull` surfaced
  2 conflicts for files that changed upstream between the original snapshot
  and the retry (kept both copies — correct and safe). But conflict artifacts
  from an aborted POPULATE are noise; a populate-retry against sequence 0
  could treat the partially-written tree as resumable-target, not as local
  edits. (Cleaned up manually this time.)
- **Excluded secrets read as git deletions:** rbox rightly never syncs `.env*`,
  but git-sync restores an index that references them, so every repo with
  committed-then-excluded env files shows ` D .env.production` on the new
  machine. Technically correct, reads as data loss. Consider a
  `git-divergence`-style note (the state file already exists) or docs FAQ.

## Perf numbers for the flow's baseline

- Initial pull: 119,812 files (~14GB written, 3.9GB cancelled writes) in
  **~4–5 min** on ethernet before the hang — the designs 79/80 transfer path
  is genuinely fast at this scale.
- Retry: scan of 120k existing files + 1 blob fetch + **git-sync apply of 98
  repos ≈ 5–6 min** end-to-end; git-sync apply is the visible tail (bundle
  apply is serial per repo — possible parallelism win, one for the perf
  backlog).
- On-disk: 7.1GB vs 44.9GiB account `used_bytes` (history + git lanes +
  GC-eligible) — see design 89 (usage decomposition, doc pending) and the GC review task
  (~2026-07-15): 111.8GiB total in R2, ~67GiB unreferenced, purge never run
  (`POST /v1/admin/gc?phase=purge` is manual-only; hourly cron is Phase 1
  only).

## Box context

- via-desktop-ubuntu is on **ethernet** (enp5s0), not wifi as assumed.
- Another agent session on this box manages self-hosted GH Actions runners
  for rbox-core (observed runner pruning) — relevant when CI acts weird.
- The rbox-dev-api **Workers Build fails on every merge** (2/2: PRs #159,
  #163) while prod passes; manual `wrangler deploy` from `apps/api` works.
  Unrelated to this box but unowned — build log is behind the CF dashboard
  (bot-challenges agent browsers).
