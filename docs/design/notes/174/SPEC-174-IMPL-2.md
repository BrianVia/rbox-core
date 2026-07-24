# SPEC-174-IMPL-2 — dispatch contract (periphery units U3-U5)

Authoritative design: docs/design/174-apply-side-perf-and-held-repo-livelock.md
(ALIGNED v4), §4.3 (C + C2), §4.4 (D), §4.5 (F). Where silent, the design doc
wins. U1+U2 are already built and committed — do NOT modify held-skip.ts,
pending-supersession.ts, or any U1/U2 behavior; U3 instruments AROUND them.

## INVIOLABLES
I1. Timer plumbing only in U3/U5 — zero behavior change on any sync path.
    Leaf timers are EXCLUSIVE intervals plus an explicit residual; nested
    parents (classifyMs) reported separately, never summed. Acceptance:
    `repoWall − union(leafIntervals) ≤ 10%` on the many-ref fixture (design
    §5 test 14).
I2. C2 `sync_phase` rides the EXISTING design-120 telemetry queue,
    lane-accumulator, contract validation, and fleet-only privacy model — no
    new endpoint, no repo paths or workspace-identifying strings in samples.
    Sampling: every 8th completed op + unconditional emit when wallMs exceeds
    pull>20s / push>15s. Server: extend apps/api telemetry-ingest contract
    for the new kind (schema-validated, additive — reject nothing existing).
    Wrangler env flags: add to BOTH top-level and env.production vars if any
    are needed (pattern in #218); vitest env passthrough for flag-on tests.
I3. D (conflict-ref retention) runs as an independently bounded hygiene phase
    after a stable probe/carry OR capture; ≤64 deletions per push;
    reachability-check → 90-day floor per design §4.4; old-OID-checked
    `update-ref -d` transactions; fail closed on any reachability error;
    refresh/invalidate the repo's divergence-cache entry after each batch;
    never touches refs outside `refs/rbox-conflict/*`; `rbox status` line
    `conflict snapshots: N (M prunable)` only when N > 0. No kill switch
    (bounded hygiene per design §6) — but the pass must be a no-op when the
    namespace is empty (zero subprocess cost on repos without conflict refs:
    gate on the fingerprint's refs statTree or a cheap existence check).
I4. F is instrumentation ONLY: `missing` and `commit` sub-timing detail
    (chunk count, per-chunk p95, payload bytes) in the push summary. No
    optimization.

## Units
U3. C sub-timers (GitChainTimings extension + per-repo token + p50/p95
    aggregates + connectivity leaf at checkout-txn.ts:282-284) and C2
    sync_phase telemetry (client emitter + apps/api ingest contract +
    accumulator handling). MUST tests: design §5 tests 13, 14.
U4. D retention pass + status surfacing. MUST tests: design §5 test 12.
U5. F push-tail sub-timing. Test: format/regression coverage in the push
    summary tests.

## Out of scope
Anything touching U1/U2 logic, BASE composition, follow/plan control flow
beyond adding timing probes and the D hygiene hook, migrations, dashboard UI
(cockpit chart is a separate rbox-admin task).

## Acceptance (worktree root)
bun run typecheck && bun test src/cli src/engine && bun run test:api (or the
vitest configLoader workaround). Append a "U3-U5" section to
IMPL-174-REPORT.md; last line of the section exactly: IMPL2-COMPLETE
