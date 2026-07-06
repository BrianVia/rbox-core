# SPEC — CI sharding, caching, latest-runtime action pins

## Objective
Rework .github/workflows/ci.yml so each shard's TEST step is ≤30s, setup is
cache-minimized, and all pinned actions run on current (non-deprecated) Node.

## Measured baseline (2026-07-06)
- CI job total 122-196s: setup ~20s (checkout 1s, setup-bun 3s, cache 6s,
  install 1s), typecheck 8s, `bun test ./src/` 115s, apps/api vitest 24s.
- Local split: `bun test ./src/engine/` ≈ 33s wall, `./src/cli/` ≈ 79s wall.

## Requirements
1. **Shard the bun test mass** into a matrix so every shard's test step is
   ≤30s (founder target; ~3-4 shards expected — 3 preferred, 4 acceptable if
   30s is otherwise unreachable). CRITICAL — no file left behind: do NOT
   hardcode per-shard file lists. Use deterministic hash/index partitioning
   computed at runtime (e.g. a small script that globs src/**/*.test.ts,
   sorts, assigns index % SHARD_COUNT, and passes that shard's files to
   `bun test`). Add a guard (in one shard) asserting the union of all
   partitions equals the full glob, so a partition bug fails loudly.
   Balance matters more than directory purity: measure per-file durations
   once (bun test prints timings; or time per directory) and if naive
   modulo packing leaves a shard >30s, use a static weight hint list for
   the handful of heavy files (git-sync, git-nested, e2ee-sync, daemon
   tests) with modulo for the rest — document the mechanism in a comment.
2. **Fold the small steps**: typecheck + @inquirer guard + apps/api vitest
   distributed across shards so no shard is idle-light (vitest 24s can be
   its own matrix entry paired with typecheck+guard ≈ 32s total — fine).
3. **Cache aggressively in front of every step**:
   - keep the bun install store cache (works — install is 1s warm);
   - add tsc incremental: emit .tsbuildinfo (tsc --incremental) for both
     tsconfigs, cached via actions/cache keyed on a source hash with
     restore-keys fallback — typecheck 8s → ~2-3s warm;
   - cache apps/api vitest/miniflare artifacts if a cacheable dir exists
     (check what vitest-pool-workers puts where; skip if nothing stable);
   - do NOT cache node_modules dirs themselves (bun install from warm store
     is already 1s; a node_modules cache is staleness risk for no gain).
4. **Latest-Node action pins** (the deprecation warning: "actions target
   Node.js 20 forced to Node 24"): bump EVERY pinned action in ALL FOUR
   workflows (ci.yml, release.yml, deploy-web.yml, e2e.yml) to the latest
   released major (actions/checkout v5.x, actions/cache v4.x latest,
   oven-sh/setup-bun latest, actions/setup-node v5.x, cloudflare/
   wrangler-action latest v3.x) — keep the repo's pin-by-full-SHA-with-
   version-comment convention (fetch SHAs via gh api releases/tags). Do not
   change any workflow LOGIC outside ci.yml; the others get pin bumps only.
5. Keep `concurrency` cancel-in-progress semantics; matrix shards must all
   be required for merge (they will be, as jobs of the same workflow).

## Acceptance criteria
- `act` isn't available; validate by (a) YAML parses (yq/python -c yaml),
  (b) the partition script runs locally producing N non-empty disjoint
  shards whose union == full glob (run it, show output), (c) local dry-run
  of each shard's exact `bun test <files>` command passes (run them).
- Local full `bun run typecheck` + `bun run test` still green (partition
  script and any package.json script additions must not break them).
  Known baseline failures: 4 shell-init/completions, status --json
  environmental, watcher flake.
- Return: the final shard packing with measured/estimated per-shard times,
  the partition mechanism, cache keys added, the action pin bump table
  (old→new SHA per workflow), and anything you could not validate locally.
