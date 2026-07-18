# 156 — Affected-only test loop (`test:affected`)

Founder ask: the nightly verify loop is `bun run test:api` (~60s) + `bun test
src/cli` (~190s), run many times per night, almost always to check a change
touching ~3 files. Select and run only the suites affected by the diff.
Companion ask: the same-SHA metadata-heal test fails on clean `main` on dev
machines, taxing every run with a hand-attribution ("that one's pre-existing").

## Scope

Local dev-loop accelerator only. CI keeps running the full sharded suites
(`scripts/ci-shard-tests.ts` + the vitest shards) and remains the merge gate.
A green `test:affected` is necessary, not sufficient.

## Design

`scripts/test-affected.ts` (+ `bun run test:affected`):

1. **Diff**: BASE → working tree (committed + staged + unstaged + untracked),
   BASE = `--base REF` or merge-base(HEAD, origin/main). This is "everything I
   changed on this branch, including what I haven't committed yet".
2. **Graph**: static import graph over `src/`, `scripts/`, `apps/api/`
   (relative imports, `.js`→`.ts` resolution, `index.ts`, `?raw` assets),
   plus repo-path **string literals** — a test that `Bun.spawn`s
   `scripts/foo.ts` or reads a fixture by path depends on it without importing
   it. False edges over-select (safe); missing edges under-select (unsafe), so
   literals are included.
3. **Selection**: a test file runs iff a changed file is in its transitive
   dependency closure. Every selected test prints the changed file that pulled
   it in (provenance), and changed files that reach **no** test are listed
   rather than silently dropped.
4. **Conservative fallbacks** (correctness over speed):
   - `package.json`, `bun.lock`, `bunfig.toml`, `tsconfig.json`,
     `scripts/test-preload.ts`, or the selector itself changed → full bun
     suite (`bun test ./src/ ./scripts/gc-drain.test.ts`).
   - Anything reaching `apps/api/src/**`, `wrangler.jsonc`, `migrations/`,
     or `vitest.config.ts` → full `vitest run`. The api tests exercise the
     composed Worker over `SELF` inside one shared workerd
     (`isolate: false`), so per-file selection there is only sound for pure
     test-file (+ helper) changes.
   - Affected tests living outside the two nightly suites (rig,
     storage-truth, release tooling) are reported but not run — those suites
     have their own invocation requirements.
5. **Runtime parity**: bun tests run with `--timeout 15000` (same as the CI
   shard runner) and the root `bunfig.toml` preload applies as usual.

Selector overhead measured at ~150ms (graph over ~1,100 files).

## Non-goals

- No CI wiring. The import graph is static analysis; CI must keep running
  everything.
- No test-name-level selection (file granularity only).
- No caching of the graph between runs (150ms doesn't earn a cache).

## Known limits

- Deep-core files (e.g. `src/cli/sync/push.ts`) legitimately fan out to
  40–70 test files — the graph is honest about coupling; the win is on
  leaf/feature edits, which are the common case.
- Runtime-only dependencies expressed neither as imports nor as repo-path
  literals (e.g. a test reading a path assembled from fragments) are
  invisible. The conservative fallbacks and the "reaches no test" report are
  the mitigation; CI is the backstop.

## Metadata-heal companion (see git history for the fix commit)

`same-SHA size mismatch commits a metadata heal without re-encrypting or
conflicting` (src/cli/sync/sync.test.ts) is red on clean `main` on dev
machines while CI stays green — a known tolerated flake per the design-123
registry. A red known-failure means "green" never actually means green, so it
is being fixed or quarantined alongside this design (root-cause notes in the
commit that touches the test).
