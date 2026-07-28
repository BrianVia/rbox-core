# 214 — API GC module decomposition

Status: IMPLEMENTED — API checks green; rig product scenarios 6/6 green with
one host sampler limitation recorded below

## Goal

Make the first behavior-preserving cut in the `apps/api` maintainability
roadmap: replace the 1,071-line `versions.ts` catch-all with modules whose names
and dependency direction match the GC/version concepts they own. Preserve every
route, scheduled operation, response shape, SQL statement, metric, bound,
failure mode, and test-visible export.

This is deliberately the safest first cycle. It establishes the module pattern
for later `workspace-sync.ts`, `fairuse.ts`, and key-delivery decompositions
without combining their higher-risk state-machine changes into this diff.

## Problem

`docs/CODEMAP.md` sets a default `<600`-line source rule unless a file is a
named `§2.7` exception. `apps/api/src/versions.ts` is 1,071 lines and is not an
exception.

The file also has no single ownership:

- authoritative Durable Object root collection;
- global R2 mark rotation;
- staging-object reclamation;
- generic `gc_state` persistence and named leases;
- two-phase candidate purge;
- GC observations, health, warnings, and read-only audit;
- the unrelated ten-line version-history listing route.

The boundary leak is concrete: `pack-gc.ts` imports generic state/lease helpers
from `versions.ts`, while `gc-phase1.ts` imports root collection from it. Tests
also use `versions.ts` as a grab bag of internals.

## Constraints

1. Structural change only. Function bodies move byte-for-byte except for import
   paths and the minimum export visibility needed by their new owners.
2. No compatibility barrel in production imports. Every production consumer
   imports the canonical owner directly.
3. Tests also import canonical owners directly, so the old catch-all surface
   cannot silently regrow.
4. No new generic repository, service, dependency-injection, or class layer.
   Existing direct functions and explicit `Env`/`D1Database` parameters remain.
5. No SQL, cursor, lease, metric, timing, R2 ordering, response, constant, or
   error-handling changes.
6. Every new module receives its own `docs/CODEMAP.md` ownership/never-owns line.
7. Every new production TypeScript module in this cycle ends below 600 lines.
   The pre-existing larger modules remain on the ranked roadmap.

## Module map

The dependency graph is normative below and uses one convention throughout:
`consumer -> modules it imports`. Existing leaf dependencies such as `env`,
`db`, `util`, `metrics`, `sidecar`, and `d1-batch` are shown where they clarify
the boundary; no edge may point from state/observability/roots/policy back into
a phase owner.

```text
gc-policy         -> no new GC module
gc-state          -> util
gc-observability  -> gc-state, util, metrics
gc-roots          -> gc-observability, sidecar, env
gc-mark           -> gc-policy, gc-roots, gc-state, gc-observability
gc-purge          -> gc-policy, gc-roots, gc-state, gc-observability
gc-audit          -> gc-policy, gc-roots, db, util
gc-health         -> gc-roots, gc-observability, db, util
staging-gc        -> gc-state, gc-observability, d1-batch, db, util, metrics
gc-phase1         -> gc-roots
pack-gc           -> gc-state
version-history   -> db, util, env
worker/routes     -> concrete operation owners
```

### `gc-policy.ts`

Owns shared global-GC budgets and timing policy:

- `GC_BUDGET_SAFE`, `GC_FIXED_COST`, `GC_PER_EXECUTE`, `GC_P1_COST`
- `GC_P1_MAX_ROWS`, `GC_MAX_EXECUTE_ROWS`
- `PER_WORKSPACE_ROOTS_COST`, `INTENT_QUIESCENCE_MS`
- `gcExecuteLimit`

This leaf prevents mark and read-only audit from importing policy out of the
destructive purge implementation. Never owns storage, cursors, leases, metrics,
responses, or candidate mutation.

### `gc-roots.ts`

Owns authoritative retained-root collection and its bounds:

- `GcRootsCapExceeded`
- `reachableFromWorkspaces`
- `MAX_DROPPED_PAGES`
- `MAX_SEQROOTS_PAGES`
- `MAX_SNAPSHOT_RETRIES`
- `MAX_UNIQUE_ROOTS`
- the bounded global `workspaceSnapshot` and `exactWorkspaceCount` readers

Never owns candidate mutation, leases, R2 deletion, scheduling, observations,
or HTTP responses unrelated to root collection.

### `gc-state.ts`

Owns typed `gc_state` JSON persistence and named lease fencing:

- `readState` / `writeState`
- `PurgeLease`, `LeaseAcquisition`, `LeaseReleaseResult`
- `acquireLease`, `renewLease`, `releaseLease`,
  `releaseLeaseWithRetry`, `leaseGuard`
- `PURGE_LEASE_TTL_MS`, `TAKEOVER_QUIESCENCE_MS`

Never owns a particular GC phase, candidate query, R2 object key, metric, or
route response.

The state-key allowlist remains exact (`purge_lease` and
`pack_purge_lease`), as do value-CAS takeover, expiry comparison, in-place
renewal, release retries, and caller-provided state-key behavior.

### `gc-observability.ts`

Owns durable observation contracts and persistence:

- `GcObservationOutcome`, `GcObservationStage`, `GcObservationKey`
- `GcRootsSampleV1`, `GcObservationV1`
- parsing, monotonic upsert, and read/write helpers
- terminal-observation construction and the existing low-level GC metric helper

The observation SQL and timestamp/lower-bound tie-breaking move byte-for-byte.
Never owns health HTTP responses, candidate mutation, root traversal, or leases.

### `gc-mark.ts`

Owns the global R2 catalog mark cursor and candidate insertion performed by
`gcMark`, including `GC_INSERT_ROWS`, the mark cursor/prefix rotation, and
mark-specific metrics.

Never owns purge intent/execution, staging objects, leases, health, or version
history.

### `gc-purge.ts`

Owns candidate intent opening, final delete fencing, canonical R2 deletion,
purge cursor movement, bounded execution, and `gcPurge`, plus
`STALE_INTENT_MS`, `ADMIN_PURGE_DEADLINE_MS`, and `GcPurgeOptions`.

The complete `gcPurge` closure moves as one unit. In particular: executor
failures become the same 500 response; root failures throw fail-closed; lease
release remains in `finally`; release exhaustion may replace the observation
but never the already-selected response; old intents execute before new intents
open; and the final live-clock/lease check remains adjacent to R2 deletion with
no new `await`.

Never owns R2 mark enumeration, staging cleanup, health presentation, or
version history.

### `gc-health.ts`

Owns health aggregation/presentation:

- `GcHealthV1`
- `gcHealthData`, `gcHealth`, and `emitGcHealthWarning`
- `GC_MAX_WORKSPACE_ROWS`, `GC_WARN_WORKSPACE_ROWS`, and
  `GC_WARN_UNIQUE_ROOTS`

Never owns candidate mutation, leases, root traversal, or scheduling.

### `gc-audit.ts`

Owns the read-only candidate audit (`gcAudit`) and its response budgeting. It
imports policy and roots directly and uses its own read-row projection. It must
not import destructive purge internals, acquire a lease, move a cursor, open an
intent, or delete an object.

### `staging-gc.ts`

Owns `staging/` orphan discovery and deletion:

- `gcStagingSweep`
- `STAGING_ORPHAN_MIN_AGE_MS`
- `STAGING_SWEEP_PAGE`

Never shares the canonical blob candidate model or purge cursor.

### `version-history.ts`

Owns only `versionsList`, the D1-mirror history browsing response.

Never owns GC.

## Import rewrites

- `worker.ts`: concrete scheduled imports from `gc-mark`, `gc-purge`,
  `gc-health`, and `staging-gc`.
- `routes/admin.ts`: concrete imports from `gc-mark`, `gc-purge`, `gc-audit`,
  `gc-health`, and `staging-gc`.
- `routes/sync.ts`: `versionsList` from `version-history`.
- `gc-phase1.ts`: roots/bounds from `gc-roots`.
- `pack-gc.ts`: state/lease primitives from `gc-state`.
- Tests: direct imports from the same canonical modules.
- Delete `versions.ts`; do not retain a re-exporting compatibility barrel
  because the API source is repository-internal and every consumer is in-tree.

## Non-goals

- No source-size guard in this cycle. It belongs in a separate, reviewed guard
  change because it must define temporary treatment for the four pre-existing
  over-limit API modules and update synthetic guard fixtures.
- No `pack-gc.ts` or `gc-phase1.ts` restructuring beyond import rewrites.
- No shared test fixture or giant test-file split.
- No GC policy, SQL, orchestration, or performance change.

## Test-fixture decision

The duplicated API `bootstrap()` helpers and giant test files are real debt, but
mixing their migration into the GC source move would broaden the review surface
without improving the safety of the move. This design therefore defers fixture
consolidation to the next independent cycle unless review identifies a fixture
needed to keep the GC move legible.

Tests move imports only; test bodies and test-file boundaries stay unchanged.

One exception is required characterization for the otherwise uncovered
`GET /v1/ws/:ws/proj/:proj/versions` route: authorization-before-read,
account-scoped routing, descending result shape, default limit, valid requested
limit, and invalid/out-of-range fallback. These tests pin the tiny
`version-history.ts` extraction rather than changing its behavior.

## Validation

1. `bun run typecheck`
2. `bun run test:api`
3. `bun run guards`
4. Search proves there are no imports of `versions.js`.
5. Search proves no moved symbol has duplicate implementations.
6. Compare old/new exported symbol inventories and intentionally account for
   every removed or relocated export.
7. Inspect `git diff --stat` and moved-body diffs to ensure the change is
   structural rather than a hidden rewrite.
8. Run `bun run rig` (or the repository-approved equivalent) because the
   development flow requires a rig/local-fleet validation beyond unit tests.

### Validation evidence — 2026-07-27

- `bun run typecheck`: pass.
- `bun run guards`: pass.
- Full API suite: 53 files passed, 848 tests passed, 4 skipped.
- Focused affected API suite after final whitespace cleanup: 6 files and 115
  tests passed.
- No `versions.js` or `versions.ts` reference remains in API source, tests, or
  CODEMAP.
- All ten extracted production modules are below 600 lines; the largest is
  `gc-purge.ts` at 380 lines.
- Rig fast suite: six product scenarios passed
  (`onboard-smoke`, `two-device-live`, `mass-delete-guard`, `type-flip`,
  `git-entanglement`, and `git-join-ahead`). `daemon-idle-cpu` kept both
  daemons healthy and below its RSS bound but failed its capture prerequisite
  because the installed Apple container runner produced zero matched stats
  samples. Direct diagnosis found two host/harness incompatibilities: Apple
  `container stats` requires container names before `--no-stream` to terminate,
  and its JSON records identify containers with `id` while the parser accepts
  only name-like fields. A Docker fallback is unavailable on this host. No rig
  harness change is included in this API-only cycle.

## Acceptance

- All existing validation is green.
- `apps/api/src/versions.ts` no longer exists.
- Production and tests import concrete canonical owners.
- `pack-gc.ts` no longer depends on a module named for version history.
- CODEMAP describes every new owner and forbidden responsibility.
- Every new module is below 600 lines.
- The version-history route has direct characterization coverage.
- Runtime behavior and externally visible API shapes are unchanged.

## Follow-up roadmap

Separate reviewed cycles, in order:

1. source-size guard with explicit temporary baselines;
2. shared API test client/fixtures and large test-file decomposition;
3. `workspace-sync.ts` runtime/commit/roots-index decomposition;
4. fair-use typed phase driver and module split;
5. key-delivery key-codec/state/HTTP split.
