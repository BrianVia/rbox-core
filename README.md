# rbox

**Dropbox for devs.** Continuous, dev-aware sync of your working directories across machines — source, configs, and uncommitted git state move; `node_modules`, build output, and secrets stay local and get *regenerated* per machine.

Built as a **SaaS** on Cloudflare (Workers + D1 + R2 + Durable Objects), with a Bun/TypeScript client. The wedge isn't sync — it's *understanding what not to sync, and how to rehydrate the rest.*

## Why it's different from Dropbox/Syncthing

- **It doesn't sync `node_modules`.** It syncs the lockfile and rebuilds dependencies locally (`rbox deps install`, temporarily disabled — design 51) — no OS-specific binaries over the wire, no multi-GB transfers, no conflicts in regenerable trees.
- **It syncs uncommitted git state safely.** Index, HEAD, stashes, and rebase state ride along via `git bundle` (never a torn copy of a live `.git`).
- **Secrets never leave by default.** `.env`, `*.pem`, keys are ignored; opt-in secret sync is E2EE-only (arrives with full-manifest encryption).
- **It's daemon-friendly.** The watcher debounces and prunes ignored dirs, so an `npm ci` or a giant clone never pegs your machine.

## Status — roadmap complete ✅

All milestones (M1–M9) are implemented, codex-reviewed, and verified live against Cloudflare (Mac ↔ remote Linux host). See [`docs/roadmap.md`](docs/roadmap.md) and the per-milestone specs in [`docs/design/`](docs/design/).

| Area | What works |
|---|---|
| **Sync** | continuous daemon (chokidar + content-addressed manifests), three-way reconcile, conflict copies, optimistic-concurrency commits via a Durable Object sequencer |
| **Git** | uncommitted index/HEAD/stash/op-state via `git bundle` (on by default, `--git false` to opt out) |
| **Blobs** | content-addressed R2, streaming PUT + resumable multipart, convergent AES-256-GCM encryption |
| **Auth** | per-device tokens (device-code + bootstrap flows), revocation |
| **Multi-tenancy** | account isolation, blob entitlement, cross-account 404, audit log |
| **Billing** | plan-gated storage/workspace quotas, atomic usage accounting (Stripe pending keys) |
| **Onboarding** | `rbox init` guided wizard (zero-dep), fully scriptable for CI |
| **Hydration** | `rbox deps install/list/check` — reconstruct deps from lockfiles (CLI surface temporarily disabled, design 51) |
| **Hardening** | client conflict-retry tests, cold-scan tuned (50k files in ~2.4s), Miniflare worker tests |

**Pending human setup:** Stripe keys + price IDs (billing), `rbox.to` nameservers → Cloudflare, and the IdP decision (Cloudflare Zero Trust/Access + BetterAuth vs Clerk).

## Quickstart

```bash
bun install

# Just run `rbox` in a terminal — it opens a guided menu:
#   1 Set up a new workspace   2 Connect this machine   3 Just log in
rbox

# Connecting a new machine in ~2 steps (lowest friction):
rbox pair                        # on a machine you're already signed into → prints a token
#   → on the new machine: `rbox` → "Connect this machine" → paste the token
# (or the classic device-code flow: `rbox login` then approve it elsewhere)

# Scriptable equivalents (no menu / CI):
rbox init --new --bootstrap <secret>          # first device on a new account
RBOX_PAIR_TOKEN=<token> rbox login            # redeem a pairing token headlessly
rbox init --workspace <id> --no-interactive   # join

# Continuous background sync:
rbox start
rbox status                      # workspace state + sync metrics

# Support diagnostics: `rbox doctor`; dependency rebuild (`rbox deps ...` / `hydrate` / `detect`) remains disabled (design 51).
```

Everything interactive has a `--no-interactive` flag-driven path (CI/Docker never depends on a TTY). `NO_COLOR` / `FORCE_COLOR` honored.

## CLI

```
(no args)                          guided onboarding menu (setup / connect / log in)
init    [--new|--workspace <id>]   guided first-time setup (--no-interactive for CI)
login   [--bootstrap <secret>]     authorize this device
pair                               mint a token to connect a new machine (~2 steps)
device  <approve|list|revoke>      manage devices
track   <path> [--workspace <id>]  bind a directory to a workspace
push | pull | sync [path]          upload / apply / both
status  [path]                     workspace state + conflict metrics
ignore  <glob> | --list            manage .rboxignore
start | stop | logs [path]         background sync (daemon)
key     <status|backup>            encryption status / recovery phrase
versions <path> | restore <p>@<n>  version history & restore
```

Full reference (always in sync with the binary): `rbox help`, or
[`docs/usage.md`](docs/usage.md) for the narrative version. Support
diagnostics (`rbox doctor`, the opt-in report upload, and how the operator
retrieves reports): [`docs/diagnostics.md`](docs/diagnostics.md).

## Architecture

```
src/engine/   pure sync core — manifests, reconcile, apply, hashing, ignore,
              git-state capture, convergent crypto, project detection
src/cli/      client — daemon, watcher, sync (push/pull/conflict-retry),
              auth, init wizard, hydrate, remote client
apps/api/     Cloudflare Worker control plane — blobs (R2), manifests + the
              WorkspaceSync Durable Object (per-(ws,proj) commit sequencer +
              hibernating-WebSocket fanout), D1 (auth/accounts/quota), GC
docs/         design specs (one per milestone), ADRs, learnings, pricing
```

The blob layer is content-addressed: a file's identity is `sha256(bytes)`, so dedup, integrity, and GC fall out for free. Commits are sequenced by the DO with optimistic concurrency — a stale parent gets a 409 and the client pulls, re-scans, and retries.

## Plans

| Plan | Storage | Workspaces | Retention |
|---|---|---|---|
| Free | 2 GiB | 1 | 7 days |
| Solo | 50 GiB | ∞ | 30 days |
| Pro | 250 GiB | ∞ | 90 days (advanced hydration) |
| Team | 150 GiB/seat | ∞ | 90 days |

Details: [`docs/pricing.md`](docs/pricing.md).

## Development

```bash
bun install
bun run typecheck          # tsc (root) + tsc (apps/api)
bun run test               # engine + client tests (bun:test, scoped to ./src/)
bun run test:api           # Worker integration tests (Miniflare/workerd: D1+R2+DO)
bun run test:all           # both suites
```

The control plane deploys with `wrangler deploy` from `apps/api/`. Secrets (`RBOX_BOOTSTRAP_SECRET`, `RBOX_PLATFORM_SECRET`, and later `STRIPE_*`) are Wrangler secrets — never committed.

### Benchmarking

`scripts/bench/` measures real sync throughput against a running worker (network
latency is the point — bench against the dev worker, not local Miniflare). The
corpus generator seeds the shapes that stress the engine (duplicate + empty files).

```bash
# 1. be enrolled (E2EE) against the target remote — a fresh account avoids the
#    1-workspace free-tier cap; the sweep creates its own workspace under ~/code/bench-ws
rbox login --bootstrap "$RBOX_DEV_BOOTSTRAP_SECRET"

# 2. upload-concurrency sweep — cold first-push of a fixed-shape corpus, fresh
#    unique content per run (a true cold push each time)
bun scripts/bench/push-sweep.ts \
  --bin /path/to/rbox \          # the compiled binary to drive (defaults to /tmp/rbox-fixed)
  --shape small \                # tiny | small | repo  (see scripts/bench/corpus.ts)
  --conc 8,16,32,64 \            # RBOX_UPLOAD_CONCURRENCY values to sweep
  --runs 1

# generate a corpus standalone (e.g. for manual push/pull timing):
bun scripts/bench/corpus.ts ~/code/bench-ws small 42   # <dir> <shape> <seed>
```

Output: a wall-time / blobs-per-sec table (best concurrency highlighted) plus a JSONL
row in `bench-results/` (gitignored). Concurrency is also tunable at runtime via
`RBOX_UPLOAD_CONCURRENCY` / `RBOX_DOWNLOAD_CONCURRENCY` / `RBOX_ENCRYPT_CONCURRENCY`.
Methodology + the broader (micro-bench, e2e, observability) plan live in
[`docs/benchmarking-and-observability.md`](docs/benchmarking-and-observability.md);
measured wins are logged in [`docs/perf-improvements.md`](docs/perf-improvements.md).

#### Benchmarking a server-side change (dev, not prod)

The control plane is benchmarked against the **dev** worker `rbox-dev-api` — real
Cloudflare D1/R2/DO. That's deliberate: the cost we optimize (per-blob D1 round-trips)
is latency/contention-bound and only shows up on real D1; local Miniflare has ~0 network
latency and hides it. **The dev deploy is a separate, manual step — never push to `main`
to test a server change**: push-to-`main` auto-deploys *prod* (`.github/workflows/deploy-api.yml`).

```bash
# on a branch/worktree with the server change (+ rebuild the CLI if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api ONLY (prod untouched)
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

Compare base vs head **back-to-back** (deploy baseline → sweep → deploy change → sweep) so
dev's shared-instance noise cancels — relative deltas hold even though absolute dev numbers
wander vs prod. Only merge to `main` (→ prod) once it's proven on dev. For an isolated,
repeatable target, add a dedicated `[env.bench]` (`rbox-bench-api` + throwaway
`rbox-bench-db`/`-blobs`) and point `--remote` at it. Each server-side design doc
(`docs/design/23`–`27`) carries this same loop with its own success metric.

## Docs

- [`docs/usage.md`](docs/usage.md) — CLI usage guide (commands, config files, `.rboxignore` semantics)
- [`docs/roadmap.md`](docs/roadmap.md) — milestone status
- [`docs/design/`](docs/design/) — one spec per milestone (each carries its codex review resolutions)
- [`docs/learnings.md`](docs/learnings.md) — append-only build log of non-obvious findings
- [`docs/backlog.md`](docs/backlog.md) — engineering backlog (not-done work, by priority)
- [`docs/perf-improvements.md`](docs/perf-improvements.md) — measured perf wins (+ benchmarking how-to above)
- [`docs/architecture.html`](docs/architecture.html) — client/server architecture + bottleneck diagram
- [`docs/adr/`](docs/adr/) — architecture decision records
- [`docs/rbox-architecture-v2.md`](docs/rbox-architecture-v2.md) — design + decision log
- [`docs/pricing.md`](docs/pricing.md) — plans
