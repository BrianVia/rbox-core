# REVIEW-214 — API GC module decomposition

## Round 1 — independent architecture, test, and adversarial review

Reviewers:

- GC ownership/dependency analysis
- API test-fixture/isolation analysis
- adversarial behavior-preservation review

### Findings and rulings

1. **BLOCKER — observation persistence and health presentation were one owner.**
   Accepted. `gc-observability.ts` now owns durable contracts/upsert/read, while
   `gc-health.ts` only aggregates and presents health. Mutation phases no longer
   import from a presentation module.

2. **BLOCKER — shared budgets would otherwise leak out of destructive purge.**
   Accepted. `gc-policy.ts` is a dependency-light leaf for budgets, timings, and
   `gcExecuteLimit`.

3. **BLOCKER — the first cycle was too broad if it included a size guard or test
   fixture migration.** Accepted. Cycle one is only the `versions.ts`
   decomposition, CODEMAP/import updates, and missing version-history
   characterization. Size enforcement and fixtures remain separate follow-ups.

4. **BLOCKER — `gcPurge` cleanup/observation ordering is easy to change while
   moving helpers.** Accepted. The entire purge closure moves as one unit with
   explicit invariants covering fail-closed throws, internal 500 conversion,
   lease release, observation replacement, and selected-response stability.

5. **BLOCKER — generic lease extraction could broaden the accepted key space or
   change pack-GC fencing.** Accepted. `gc-state.ts` preserves the exact
   two-key allowlist, value-CAS, expiry, renewal mutation, and retry semantics.

6. **MAJOR — root collection must remain indivisible and sequential.** Accepted.
   No parallelization, wrapping, or partial-global-set merge is permitted.

7. **MAJOR — staging uses a different liveness model.** Accepted.
   `staging-gc.ts` remains an independent owner.

8. **MAJOR — the version-history route lacks direct characterization.** Accepted.
   Route-level authorization, routing, ordering, shape, and limit tests are now
   required.

9. **TEST SCOPE — a shared stateless bootstrap helper is safe, but test files
   share Miniflare state (`maxWorkers:1`, `isolate:false`).** Recorded and
   deferred. A later fixture cycle must not introduce counters, global resets,
   centralized migration hooks, or implicit name randomization.

### Round-1 disposition

Design revised to r1. Re-dispatch required for alignment before implementation.

## Round 2 — dependency-graph alignment

### Findings and rulings

1. **BLOCKER — mixed arrow directions made the import graph ambiguous.**
   Accepted. The diagram is replaced by a normative `consumer -> imports`
   adjacency list.

2. **BLOCKER — roots and staging call the low-level metric helper but their
   observability edges were missing.** Accepted. `gc-roots` and `staging-gc`
   now import `gc-observability`; the complete phase dependencies are explicit.

3. **MAJOR — several test-visible exports were implicit.** Accepted.
   `GC_INSERT_ROWS`, `STALE_INTENT_MS`, `ADMIN_PURGE_DEADLINE_MS`,
   `GcPurgeOptions`, and all health warning constants now have explicit owners.

4. **TEST REVIEW — fixture deferral and history characterization approved.**
   Accepted. Implementation note: seed at least 51 history rows for the default
   limit test; cover `junk`, `0`, and `501` fallback inputs; cross-account access
   must return 404 despite populated target history.

### Round-2 disposition

Design revised to r2. Final alignment re-dispatch required before
implementation.

## Round 3 — final alignment gate

- GC ownership/dependency reviewer: **APPROVE**
- adversarial behavior-preservation reviewer: **APPROVE**
- test-scope reviewer: **APPROVE** (from round 2; no test-scope change in r2)

No blocker or major remains. Design 214 is implementation-ready.
