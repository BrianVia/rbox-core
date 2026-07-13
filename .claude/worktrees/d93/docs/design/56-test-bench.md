# 56 — The local test bench: two ephemeral devices, real workloads, live telemetry

Status: **draft — design only, implementation phased.**

Today, "did this change break sync?" is answered by the founder hand-testing on
his own machine, against prod, with his own real data on the line. That is how
the 2026-07-01 mass-delete (design 44: 8,603 files) and the 2026-07-02
empty-base conflict storm (design 55) were *found* — by nearly losing real
work. The whole class of bug rbox keeps hitting is **destructive-apply on a
device holding genuine divergence**, and it is invisible on a pristine test
machine (nothing differs → nothing conflicts → the bug hides) and catastrophic
on a working one. We cannot keep discovering these by bleeding on them.

Designs 52 and 53 were parked with an explicit "founder: stability first"
mandate. **This bench is that stability investment.** It stands up two throwaway
Linux devices, mints throwaway accounts, syncs *real* workloads (including the
Conductor snapshot and `~/Development`) between them through the real dev
control plane, and captures client logs *and* server telemetry live and after
the fact — so any change can be validated for correctness, CPU behaviour, and
git entanglement **before it ships**, on data that actually looks like a
working machine, without risking a working machine.

## 1. Relationship to prior art

- **Supersedes `docs/benchmarking-and-observability.md` §4** (the two-VM e2e
  bench sketch). That doc's §4 proposed a host-adaptive Apple-`container`/Docker
  runner whose primary goal was *perf numbers*; this doc's rig is
  correctness-first (perf gating comes late, §12) and commits to Apple
  `container` concretely rather than sketching an interface. **This doc inherits,
  unchanged, that doc's privacy ban-list** (§5's metadata threat model — no path
  hashes, no raw IDs as dimensions, coarse buckets only, time-window correlation)
  and its corpus generator (`scripts/bench/corpus.ts`). The micro-bench half of
  that doc (§2.1, §3, §6) stands; only §4 is replaced by this rig.
- **Generalizes `scripts/bench/savvy-two-host.sh`.** That script already runs a
  headless two-`$HOME` push/pull convergence test against the deployed dev
  worker (`savvy-two-host.sh:12`, `login --bootstrap … --no-interactive` at
  `:32`, second-host join at `:41`). It is the direct ancestor of the rig; the
  rig replaces its two `$HOME`s-on-one-host trick with two real container-isolated
  devices, and its single hardcoded scenario with a scenario engine.
- **Exercises the guards the incidents produced.** The bench is the regression
  net for design 44 (mass-delete guard), design 49 (daemon idle IO-priority +
  safety-scan backoff), design 50 (type-flip abort + trash tier), and design 55
  (reconcile base continuity + `--allow-mass-reconcile`).
- **Cites design 34 (WAF)**: a 64-wide concurrent blob fan-out tripped
  Cloudflare's infra WAF into opaque 403s (`34-per-account-rate-fairness.md:22`,
  `:25`); the rig throttles concurrency against the real dev worker (§7).
- **Cites design 37 (deletion)**: the bench's per-run account teardown *is* a
  recurring live exercise of the `DELETE /v1/account` cascade
  (`apps/api/src/account-delete.ts:123`).

## 2. What exists today (the bench composes these — it rebuilds nothing)

| Capability | Where | Notes |
|---|---|---|
| Headless bootstrap onboarding | `apps/api/src/auth/bootstrap.ts` (`POST /v1/auth/device/bootstrap`, doc'd `:9`) | Creates account + owner user + **genesis device** (`mintDevice`, `:29`). Gated by `RBOX_BOOTSTRAP_SECRET` (`:13`), constant-time compare `ctEqual` (`:14`). **Does NOT do E2EE enrollment** — that is completed client-side by `rbox init` (§8). Plan hardcoded `free` at `:23` today (§8 changes this). |
| Headless CLI onboarding contract | `src/cli/init-plan.ts` | Non-interactive auth planner; `headlessHint` at `:86`/`:115`/`:134`. `rbox login --bootstrap <secret> --remote <url> --no-interactive` then `rbox init --new --no-interactive --remote <url>`. |
| Second-device pairing | `src/cli/auth-cmd.ts` | `pairCreate` prints a token (`:168`); device B redeems via `redeemPair` (`:197`) from stdin, or `RBOX_PAIR_TOKEN` env (`:39`). |
| Working two-host convergence bench | `scripts/bench/savvy-two-host.sh` | Direct ancestor (see §1). |
| Seeded corpus generator | `scripts/bench/corpus.ts` | `SHAPES` incl. `tiny` (100 files); deliberately seeds empty + duplicate-content files. |
| Concurrency sweep | `scripts/bench/push-sweep.ts` | Prior art for concurrency knobs. |
| Remote override + prod default | `src/cli/credentials.ts:25` (`PROD_REMOTE = "https://api.rbox.to"`); `src/cli/index.ts:19` (`DEFAULT_REMOTE = RBOX_API ?? PROD_REMOTE`) | **CLI defaults to prod.** `RBOX_API` overrides. This is exactly why §7's prod-URL hard refusal exists. |
| Client daemon logs | Path scheme in `src/cli/daemon-control.ts` (`RBOX_HOME` `:16`, `workspaceKey` `<basename>-<hash8>` `:22`, `daemonRuntimeDir` `:33`, `LOG_FILE` `:11`); ISO-prefixed plaintext lines written in `src/cli/daemon.ts:30` | `~/.rbox/daemons/<basename>-<hash8>/daemon.log`. Plain text, no levels, no JSON, no request IDs. `rbox logs [--follow] [--lines N]` tails it (`index.ts:444`, `logsDaemon` `daemon-control.ts:224`, `DEFAULT_LOG_LINES=50`). |
| Client sync counters | `src/cli/metrics.ts:38` | `.rbox/state/metrics.json` — `{ syncs, commitConflicts409, fileConflicts }`. `RBOX_METRICS=1` opt-in phase timing (`:20`, §35). |
| Concurrency knobs | `RBOX_UPLOAD_CONCURRENCY` (`sync-recovery.ts:36`, default 64), `RBOX_ENCRYPT_CONCURRENCY` (`:29`, default 8), `RBOX_DOWNLOAD_CONCURRENCY` (`apply.ts:104`, default 64), `RBOX_DEBUG` (`:189`), `RBOX_WATCHER` (`watcher.ts:71`, default `parcel`) | The rig sets these per run. |
| Server telemetry | `apps/api/src/metrics.ts` — `OpSpan` (`:98`) / `startOp` (`:170`); one Analytics Engine point per op (`writeDataPoint` `:78–82`): `blob1=op, blob2=route(templated), blob3=outcome` (`:80`); `double1..8 = ms,dbMs,storeMs,doMs,bytes,count,ratio,dbCalls` (`:82`) | AE **binding** `rbox_metrics` in both envs; **datasets** `rbox_dev_metrics` (`wrangler.jsonc:30`) / `rbox_prod_metrics` (`:103`). Queryable via AE SQL HTTP API with the account-scoped `CF_AE_TOKEN` (same token rbox-admin uses). |
| Live server logs | `apps/api/wrangler.jsonc` `observability.enabled:true, head_sampling_rate:1` (`:33` dev / `:104` prod) | `wrangler tail rbox-dev-api --format json` is the reliable stream. A Tail Worker exists (`apps/api/tail/`, `rbox-dev-tail`) but its `tail_consumers` binding is **commented out** (`wrangler.jsonc:39`/`:106`) — don't rely on it. |
| Environments | `apps/api/wrangler.jsonc` | Top-level = dev worker `rbox-dev-api` (`:2`; D1 `rbox-dev-db` `:8`, R2 `rbox-dev-blobs` `:15`); `env.production` = `rbox-prod-api` (`:85`) at `api.rbox.to` (`:135`). A live deployed dev worker exists. |
| Cross-compiled linux-arm64 binary | `.github/workflows/release.yml` | Targets `darwin-arm64` (`:98`), `linux-x64` (`:100`), `linux-arm64` (`:102`) via `bun build --compile`, native watcher embedded per target; each runs `__watcher-selftest` on a native runner (`:117`) as a release gate. **A real linux-arm64 rbox binary is already a shipped artifact** — §6 reuses this. |
| Guards to respect/exercise | mass-delete guard (`src/cli/sync.ts:34` `MASS_DELETE_MIN_FILES=100`, enforced `:155` via `SyncDeps.allowMassDelete` `:76`; separate push-side `allowMassDeletePush` `:82`/`:461`); design 55 `--allow-mass-reconcile` is **design-only, not in code yet**; design 49 idle backoff + IO priority (shipped v0.6.5). | |
| Plans | `apps/api/src/plans.ts:18` | `free` = 2 GiB / 1 workspace / 16 MiB manifest cap. Plans: `free`, `solo`, `pro`, `team`. No CLI/API path to change plan except Stripe checkout or the platform-secret-gated `POST /v1/admin/account/:id/plan` (`apps/api/src/routes/admin.ts:39`, `adminSetPlan` `:41`, `isPlatform` `:40`; header `x-rbox-platform` vs `RBOX_PLATFORM_SECRET`, `authz.ts:73–74`). |
| Account teardown | `apps/api/src/account-delete.ts:123` | Owner-only `DELETE /v1/account`; tombstone + 7-day grace (`DELETION_GRACE_MS` `:28`) + `account_deletions` ledger + cron/queue cascade (design 37). |

**Known live bug the bench must catch:** type-flip (symlink↔dir) pull-abort —
`writeEntry` runs `fs.rename(tmp, abs)` into an EISDIR when a path flips type
(`src/engine/apply.ts:150`,`:256`; the design-50 flat-meadow outage). Design 50's
heal is *implemented*; the bench keeps it honest and covers the un-fixed edges.

## 3. Architecture overview

The control plane is **workerd** — it cannot run inside a Linux guest. So the
Mac host runs everything Cloudflare-shaped (the rig, optional `wrangler dev`,
`wrangler tail`, AE SQL queries), and the two containers are *pure clients* —
each a fresh Linux device with its own `$HOME`, running the exact CLI surface a
real user gets.

```
┌──────────────────────────── macOS 26 host (M2 Max, 96 GB / 12 cores) ─────────────────────────────┐
│                                                                                                    │
│   scripts/rig/rig.ts  ──────────────────────────────────────────────────────────┐                 │
│     • orchestrates run       • copies out logs/metrics    • samples container stats                │
│     • runs AE SQL queries    • drives wrangler tail                              │                 │
│                                                                                  ▼                 │
│   wrangler tail rbox-dev-api ──► server-tail.jsonl        AE SQL (CF_AE_TOKEN) ──► server-metrics   │
│                                                                                                    │
│   [ local mode only ] wrangler dev  ◄── host.container.internal DNS rule (reboot-wiped, §7)         │
│                                                                                                    │
│   ┌──────────────── Apple `container` (rbox-net) ────────────────┐                                 │
│   │  container A  (rig-dev-a)          container B  (rig-dev-b)   │                                 │
│   │   fresh Linux device                fresh Linux device        │                                 │
│   │   own $HOME, own ~/.rbox            own $HOME, own ~/.rbox     │                                 │
│   │   rbox CLI (source|binary)          rbox CLI (source|binary)  │                                 │
│   │   daemon.log ─┐        pair token ─► RBOX_PAIR_TOKEN          │                                 │
│   │   workspace ──┼── copied from RO workload mount ──────────────┼─┐                               │
│   └───────────────┼──────────────────────────────────────────────┘ │                               │
│                   │ container stats (2s) ─► stats-a/b.jsonl          │                               │
└───────────────────┼──────────────────────────────────────────────────┼───────────────────────────┘
                    │                                                    │
                    ▼  (dev mode: real HTTPS)                            ▼
         ┌──────────────────────────────────────────────────────────────────────┐
         │  rbox-dev-api  (deployed dev Worker)                                   │
         │    D1 rbox-dev-db   •   R2 rbox-dev-blobs   •   AE rbox_dev_metrics    │
         └──────────────────────────────────────────────────────────────────────┘
```

Both containers reach each other over a `container network` (macOS 26 is
required for container-to-container networking; the host qualifies). In dev mode
they talk to the deployed worker over real HTTPS; in local mode they reach the
host's `wrangler dev` via the `host.container.internal` DNS rule.

## 4. The rig CLI

Harness home: `scripts/rig/` (TypeScript, Bun), entry `scripts/rig/rig.ts`,
wired as a `package.json` script so `bun run rig -- <cmd>` works. Subcommands:

- **`rig doctor`** — host preflight, prints fix-it commands (never mutates):
  macOS ≥ 26; `container` installed and at the **pinned** version;
  `container system start` running; (local mode) the `host.container.internal`
  DNS rule present; `CF_AE_TOKEN` in env for AE queries. Example fixes it
  emits: `brew install ... && container --version` (assert pin),
  `container system start`, `sudo container system dns create
  host.container.internal --localhost <ip>`. **`container` is not yet installed
  on the host — `rig doctor` is the bootstrap that installs and pins it.**
- **`rig up`** — `container build` the device image (§6), create the
  `rig-net` network and named volumes, start containers `rig-dev-a`/`rig-dev-b`.
- **`rig run <scenario> [--api dev|local] [--cli source|binary] [--workload <name>]`**
  — the workhorse: provision account/workspace (§8), stage the workload (§9),
  execute the scenario (§10), capture observability (§11), write the run dir.
- **`rig watch`** — interleaved live tail: both containers' `daemon.log`
  (`container logs -f`) + `wrangler tail` (dev mode), each line prefixed
  `[A] / [B] / [srv]`, so a propagation can be watched crossing the wire in real
  time.
- **`rig report [runDir]`** — render/re-render `report.md`+`report.json` from a
  run dir (also runs at the end of `rig run`).
- **`rig down [--all] [--keep-account]`** — tear down containers, named volumes,
  and the network (all namespaced `rig-*`); `--all` sweeps every `rig-*`
  resource; account teardown is default-on, `--keep-account` skips it.
- **`rig deploy-dev`** — push the current branch's worker to `rbox-dev-api`
  before merge, so a scenario can test un-merged server code (§12).

## 5. Device image + CLI provisioning modes

The image is an arm64 (native M2 Max) Linux base with Bun and the rig's runtime
prerequisites. Apple `container` has **no snapshot/clone verb** — the *image* is
the repeatability primitive, built once via `container build` (BuildKit VM,
Dockerfile) and reused for every run.

Two CLI provisioning modes (`--cli`):

- **`source`** (default) — the repo is bind-mounted **read-only** and the CLI
  runs via `bun` inside the container. Tests the *working tree*; fast iteration,
  no build step. This is the PR-loop mode.
- **`binary`** — cross-compile `bun build --compile --target=bun-linux-arm64`
  reusing the release pipeline's approach (native `@parcel/watcher` embed), then
  run `__watcher-selftest` in-container as a gate before any scenario. Tests the
  *shipped artifact* — the thing users actually get — and catches
  compile/embed regressions the source mode can't.

## 6. Control-plane modes + networking

Two modes (`--api`), with one non-negotiable safety rail up front: **the rig
refuses to run if the resolved API URL matches prod** (`api.rbox.to` or
`rbox-prod-api`), checked against *both* env (`RBOX_API`) and flags before any
container starts. The CLI's own default is prod (§2), so this refusal is the
thing standing between a bench run and real user data.

- **`dev`** (default) — the deployed `rbox-dev-api` with real D1/R2/AE. This is
  the mode that yields real server telemetry, and the mode that can trip the
  design-34 WAF, so it throttles concurrency (§13).
- **`local`** — `wrangler dev` on the host; containers reach it via
  `host.container.internal`. **Caveat, load-bearing:** that host-reachability
  DNS rule (`sudo container system dns create host.container.internal
  --localhost <ip>`) is a packet-filter rule that is **wiped on every host
  reboot** and **disables iCloud Private Relay while active**. `rig doctor`
  detects its absence and `rig up`/`run` in local mode re-create it. Local mode
  misses Worker cold starts, real R2 multipart latency, and real AE — use it for
  fast offline correctness loops, not for latency claims.

## 7. Account + workspace lifecycle (per run)

1. **Bootstrap on A.** `rbox login --bootstrap <dev-secret> --no-interactive`
   against the resolved dev URL → `POST /v1/auth/device/bootstrap` creates the
   account + owner user + genesis device on A. Then `rbox init --new
   --no-interactive` completes **E2EE enrollment client-side** and creates the
   workspace. (Bootstrap alone does not enroll E2EE — §2.)
2. **Pair A→B.** `rbox pair` on A (via `container exec`, stdout captured) prints
   a token; the rig pipes it into B as `RBOX_PAIR_TOKEN`.
3. **Join on B.** `rbox init --workspace <id> --no-interactive` binds B to the
   same workspace, second E2EE device enrolled.
4. **Teardown.** `DELETE /v1/account` with the device's own owner creds
   (default-on; `--keep-account` skips for cross-run incremental scenarios).
   This doubles as a recurring exercise of the design-37 deletion cascade.

**The one API change this doc requires** (decision, not option): bootstrap
optionally accepts `"plan": "solo" | "pro"`, honoured **only** when a new env
flag `RBOX_ALLOW_BOOTSTRAP_PLAN` is set — set on the **dev worker only, never
prod**. This lets the punishing workload tiers (§9) clear the free-plan caps
(2 GiB / 1 workspace / 16 MiB manifest) without touching Stripe or the
platform-secret admin route. Today `bootstrap.ts:23` hardcodes `free`; this
change is a small, dev-gated widening of that. **No new admin API, and nothing
in rbox-admin** — rbox-admin stays a read-only Cloudflare-Access cockpit;
account creation for the bench is the *existing* bootstrap route.

## 8. Workload tiers (`scripts/rig/workloads/`)

Real data is the whole point — the bugs hide on pristine trees. Every workload
enters via a **read-only** bind mount and is **copied into the container-local
workspace dir** before tracking (sync needs rw, and must never mutate the host
copy of real data).

| Tier | Source | Shape | Plan needed |
|---|---|---|---|
| `smoke` | generated via `corpus.ts` | ~500 files, `<2 min` end-to-end | free |
| `conductor` | `~/Downloads/conductor-workspaces-backup-2026-07-02.tar.gz` (138 MB compressed, ~33k entries; path configurable) | Real nested git repos; **the harness must strip a stale `workspaces/.rbox/` dir before tracking**. Extraction cached in a content-hash-keyed named volume. | `solo`+ |
| `development` | arbitrary big host path, e.g. `~/Development` | The deliberately punishing tier | `pro` (bootstrap plan override, §7) |

Named volumes (not anonymous — anonymous volumes do **not** auto-clean under
`--rm`, so the rig uses named volumes with explicit lifecycle) hold the cached
extraction and the container-local workspaces.

## 9. Scenario engine + the initial suite

Scenarios are small TS modules: `{ name, workload, run(ctx), assert(ctx) }`.
`ctx` exposes `a`/`b` device handles (`exec`, `rbox`, `readFile`, a
`container stats` sampler), a **convergence waiter** (poll both trees until
byte-identical or timeout), and the run dir. This keeps a scenario to a few
lines of intent and puts all the container/log/stat plumbing behind the ctx.

Initial suite:

- **`onboard-smoke`** *(the PR gate)* — zero → bootstrap → init → pair → join →
  push on A → pull on B. **Assert:** trees byte-identical; both accounts
  enrolled; teardown clean. Catches: onboarding/auth/enrollment regressions,
  the whole happy path. `<2 min`, source+dev.
- **`two-device-live`** — daemons up both sides. A-edit → assert B converges;
  B-edit → assert A converges; then a **concurrent edit** to the same file →
  assert conflict handling is consistent with design 55 (bounded conflict copy,
  **no conflict blast, no `--allow-mass-reconcile` trip**). Catches: watcher/
  propagation regressions, conflict-storm regressions.
- **`conductor-initial-sync`** — big push on A + join/pull on B; wall + phase
  timings recorded (`RBOX_METRICS=1`), concurrency throttled. **Assert:**
  convergence; **zero WAF 403s** in `server-tail.jsonl`. Catches: the design-34
  fan-out regression, first-push correctness at real scale.
- **`git-entanglement`** — after convergence, for **every** nested repo:
  `git fsck` clean, `git status --porcelain` identical across A/B, HEAD + all
  refs equal; then branch-switch churn under a live daemon and re-assert.
  Catches: the class rbox fears most — sync corrupting or entangling real git
  state (design 43).
- **`type-flip`** — symlink on A vs materialized dir on B.
  **EXPECTED-FAIL**, documenting the design-50 live bug at its un-healed edges;
  the bench turns it green when the fix fully lands. Catches: regressions in
  type-flip handling.
- **`daemon-idle-cpu`** — post-convergence 5-min idle soak, `container stats`
  sampled every 2s. **Assert:** CPU% and RSS below explicit budgets. Catches:
  design-49 idle-backoff / safety-scan regressions (the 81s-startup class).
- **`mass-delete-guard`** — delete `>100` files on A. **Assert:** B **refuses**
  without `--allow-mass-delete` (daemon halts loudly, tree intact), then
  proceeds with it. Catches: regressions in the design-44 safety net.
- **`chaos-restart`** — kill container A mid-push, restart, resume. **Assert:**
  clean recovery, no guard trips, no data loss, convergence. Catches:
  partial-state / resume regressions.

## 10. Observability

Each run writes a gitignored dir `scripts/rig/runs/<ts>-<scenario>/`
(`scripts/rig/runs/` must be added to `.gitignore` in P1 — `bench-results/`
already is). Time-window correlation only; the design privacy ban-list applies
verbatim — no raw account/device/workspace IDs, no path hashes as AE dimensions.

Run-dir layout:

```
runs/<ts>-<scenario>/
  daemon-a.log        daemon-b.log        # copied out of both containers
  metrics-a.json      metrics-b.json      # .rbox/state/metrics.json, both devices
  phases-a.json       phases-b.json       # RBOX_METRICS=1 phase timings (always on in the rig)
  stats-a.jsonl       stats-b.jsonl       # container stats, 2s interval
  server-tail.jsonl                       # wrangler tail over the run window (dev mode)
  server-metrics.json                     # AE SQL query over the run window (dev mode)
  report.md  report.json                  # assertions, timings, CPU peaks, error excerpts, AE summary
```

- **Live** (`rig watch`): interleaved `[A]/[B]/[srv]` tail of both daemon logs
  plus `wrangler tail` — watch a propagation cross the wire.
- **After the fact**: `server-metrics.json` is a post-run AE SQL query over the
  run's time window (op latencies, outcome histogram, error rate) using
  `CF_AE_TOKEN`. `container stats --format json --no-stream` supplies
  `cpuUsageUsec / memoryUsageBytes / networkRx/TxBytes / blockRead/WriteBytes /
  numProcesses` for the CPU/RSS budgets.

**New product capability (not just bench plumbing) — `rbox doctor --report`.**
Revive the benchmarking doc's opt-in diagnostics bundle: local-preview-first,
explicit-consent upload of `{ daemon.log tail, metrics.json, version/platform }`
— **no file contents or paths beyond what the log already holds** — via a new
`POST /v1/diagnostics` (auth'd device, ~1 MB cap, R2 `diagnostics/` with 30-day
retention, rate-limited). It serves real support cases *and* lets the bench
exercise the exact path a user would use. Phased late (§12, P3).

## 11. CI & automation

- **Dev auto-deploy.** Extend `.github/workflows/deploy-api.yml` (today deploys
  only `--env production` on main push) to **also** deploy the dev worker on
  main push, so `rbox-dev-api` always mirrors current server code and the bench
  never tests stale server. `rig deploy-dev` covers the pre-merge case.
- **`.github/workflows/e2e.yml`** — manual dispatch + nightly schedule on a
  **self-hosted runner on the founder's M2 Max**. Be honest: GitHub-hosted
  runners can't do macOS 26 + vmnet reliably, so this *must* be self-hosted.
  Manual/nightly-fast runs `onboard-smoke` + `two-device-live` +
  `daemon-idle-cpu`; nightly adds `conductor-initial-sync` + `git-entanglement`.
  Each run uploads its run dir as an artifact.
- **Local habit**: `bun run rig run onboard-smoke` before PRs (~2 min).
- **Perf budgets** (wall-time, CPU) become tolerance-banded regression gates
  **only after ~2 weeks of baseline data** establishes the noise floor — not
  day one (same burn-in discipline as the benchmarking doc §6).

## 12. Safety rails (mandatory)

1. **Prod-URL hard refusal** — the rig aborts if the resolved API URL is
   `api.rbox.to` / `rbox-prod-api`, checked against env *and* flags (§6). The
   CLI defaults to prod, so this is the primary rail.
2. **Dev bootstrap secret stays out of the repo** beyond the existing gitignored
   local file. **Cleanup item:** `savvy-two-host.sh:13` currently hardcodes it
   as a default (`BOOT="${RBOX_DEV_BOOTSTRAP:-dev-e2ee-…}"`); the rig is env-only
   and this ancestor should be migrated to env-only too.
3. **Account teardown default-on** (`DELETE /v1/account`); `--keep-account` is
   the deliberate exception.
4. **All rig resources namespaced `rig-*`** (`rig-net`, `rig-dev-a`,
   `rig-dev-b`, named volumes); `rig down --all` sweeps them.
5. **Read-only workload mounts** — the bench copies real data into
   container-local dirs and can never mutate the host copy (§8).
6. **Concurrency throttle default (~16) against the dev worker** — below the
   64-wide fan-out that tripped the design-34 WAF.
7. **Memory-ballooning note** — Apple `container` returns freed guest memory to
   macOS only partially; long soak loops (`daemon-idle-cpu`, repeated scenarios)
   restart containers between scenarios rather than reusing one long-lived guest.

## 13. Phased delivery

- **P0 — rig core.** `rig doctor` / `up` / `down`, the device image, `source`
  mode, `onboard-smoke` green vs the dev worker. Prod-URL refusal + `rig-*`
  namespacing from the first commit. *Outcome: one-command fresh-device
  onboarding + convergence.*
- **P1 — observability capture + report.** Run-dir layout, log/metrics copy-out,
  `container stats` sampler, `wrangler tail` capture, AE SQL query,
  `report.md`/`report.json`; `rig watch`; `scripts/rig/runs/` gitignored.
  *Outcome: every run is inspectable live and after the fact.*
- **P2 — scenario suite.** `two-device-live`, `conductor-initial-sync` (+
  conductor workload plumbing, `.rbox/` strip, cached extraction),
  `git-entanglement`, `type-flip` (expected-fail), `daemon-idle-cpu`,
  `mass-delete-guard`; `binary` provisioning mode. *Outcome: the guard/entangle/
  idle regression net.*
- **P3 — API additions.** Bootstrap `plan` param behind `RBOX_ALLOW_BOOTSTRAP_
  PLAN` (unlocks `development` tier); `rbox doctor --report` + `POST
  /v1/diagnostics`. *Outcome: punishing workloads + a real diagnostics path.*
- **P4 — CI + chaos + perf gates.** Dev auto-deploy, self-hosted `e2e.yml`
  (manual + nightly), PR smoke habit; `chaos-restart`; perf budgets flipped from
  report-only to gating once burn-in data exists. *Outcome: automated,
  regression-gated.*

## 14. Non-goals

- **Not a server load-test rig.** Two devices, not a fleet; this stresses the
  client and the wire and *reads* server telemetry — it does not synthesize
  server load. (Load testing is the benchmarking doc's separate concern.)
- **Not multi-account tenancy testing.** One throwaway account per run; sharing/
  cross-account isolation is out of scope.
- **Not Windows or x86 coverage initially.** arm64 Linux guests on an arm64 Mac.
  amd64-via-Rosetta is possible but not pursued.
- **Not a macOS-client bench.** The guests are Linux; a real macOS client
  (APFS, FSEvents, case sensitivity) is validated by running the CLI natively on
  the host, not in a guest (benchmarking doc §4 honesty).
- **Not a replacement for the unit/vitest layers.** This is the end-to-end net
  *above* them; it does not test what the type system or `src/**/*.test.ts`
  already cover.

## 15. Open questions

1. **Self-hosted runner security posture.** A self-hosted GitHub runner on the
   founder's personal M2 Max executes PR-authored code with access to
   `CF_AE_TOKEN` and the dev worker. Restrict to `workflow_dispatch` +
   `schedule` (no untrusted PR triggers)? Ephemeral runner per job?
2. **`container` version pinning strategy.** Pre-1.0, minor versions break
   subcommand syntax. Pin one version in `rig doctor`; what's the bump cadence,
   and does the image need to move in lockstep?
3. **AE token provisioning for CI.** `CF_AE_TOKEN` is account-scoped; how is it
   surfaced to the self-hosted runner without landing in the repo?
4. **Should `type-flip`'s expected-fail block nightly?** An expected-fail that
   flips to pass is a *good* signal (the fix landed); an expected-fail that
   starts *passing unexpectedly* or an unrelated failure must not mask the
   nightly result. Track it as a known-state assertion, not a hard fail?
5. **Idle-CPU budget numbers.** `daemon-idle-cpu` needs concrete CPU% and RSS
   ceilings; those come from the first weeks of baseline data (§11), not a guess
   today. What are the initial provisional ceilings while data accrues?
6. **Convergence-waiter timeout policy.** Byte-identical polling needs a
   per-tier timeout (smoke seconds, `development` minutes); a too-tight timeout
   flakes, a too-loose one hides a hang. Tie it to workload size?

## 16. Sibling scope (not this doc)

Two adjacent ideas surfaced while designing this; they want their own design
(57 candidate), not a ride-along here:

- **Recovery kit.** Interactive setup should offer (default-yes prompt, never
  silent, never in headless paths) to write a 1Password-style recovery-kit file
  (`rbox-recovery-kit-<account8>-<date>.txt`, 0600) to `~/Downloads`, since
  terminal scrollback is where recovery phrases go to die. The bench interacts
  with this only negatively: headless bootstrap must stay kit-free so `rig`
  runs never litter the host, and `onboard-smoke` should assert that.
- **Key rotation.** There is still no re-wrap/rotate story if a recovery phrase
  leaks (design 19 remains unimplemented); the bench's throwaway accounts make
  a future rotation flow cheaply testable end-to-end.
