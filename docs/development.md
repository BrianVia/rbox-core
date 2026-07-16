# Development

```bash
bun install
bun run typecheck          # tsc (root) + tsc (apps/api)
bun run test               # engine + client tests (bun:test, scoped to ./src/)
bun run test:api           # Worker integration tests (Miniflare/workerd: D1+R2+DO)
bun run test:all           # both suites
```

The control plane deploys with `wrangler deploy` from `apps/api/`. Secrets (`RBOX_BOOTSTRAP_SECRET`, `RBOX_PLATFORM_SECRET`, and later `STRIPE_*`) are Wrangler secrets — never committed.

## Benchmarking

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
[`benchmarking-and-observability.md`](benchmarking-and-observability.md);
measured wins are logged in [`perf-improvements.md`](perf-improvements.md).

### Runtime knobs

| Variable | Default | Notes |
| --- | ---: | --- |
| `RBOX_PULL_JOIN_WATCHDOG_MS` | `90000` | Pull batch-join liveness window before retrying outstanding blob downloads. |
| `RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS` | `3` | Consecutive zero-progress watchdog firings before a pull join fails loudly. |
| `RBOX_NET_BLOB_MIN_TIMEOUT_MS` | `120000` | Minimum total deadline for size-aware blob downloads. |
| `RBOX_NET_BLOB_MAX_TIMEOUT_MS` | `3600000` | Maximum total deadline for size-aware blob downloads. |

### Benchmarking a server-side change (dev, not prod)

The control plane is benchmarked against the **dev** worker `rbox-dev-api` — real
Cloudflare D1/R2/DO. That's deliberate: the cost we optimize (per-blob D1 round-trips)
is latency/contention-bound and only shows up on real D1; local Miniflare has ~0 network
latency and hides it. **The dev deploy is a separate, manual step — never promote
untested server changes to `production`**: `main` is integration-only, while a
`production` update deploys prod through Cloudflare Workers Builds.

```bash
# on a branch/worktree with the server change (+ rebuild the CLI if it's a protocol change):
cd apps/api && bunx wrangler deploy                  # → rbox-dev-api ONLY (prod untouched)
bun scripts/bench/push-sweep.ts --bin /tmp/rbox \
  --remote https://rbox-dev-api.brian-via.workers.dev --conc 8,16,32,64
```

Compare base vs head **back-to-back** (deploy baseline → sweep → deploy change → sweep) so
dev's shared-instance noise cancels — relative deltas hold even though absolute dev numbers
wander vs prod. Merge proven changes to `main`, then explicitly promote the green candidate
to `production`. For an isolated,
repeatable target, add a dedicated `[env.bench]` (`rbox-bench-api` + throwaway
`rbox-bench-db`/`-blobs`) and point `--remote` at it. Each server-side design doc
(`docs/design/23`–`27`) carries this same loop with its own success metric.
