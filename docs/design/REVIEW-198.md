# Review 198 — Config decomposition

## Round 1

Verdict: not aligned.

The architecture review found two blockers and one validation gap:

1. the proposed four-owner graph omitted transitive cycles through
   `reset-journal.ts`, `sync-git/p-settlement.ts`, and
   `sync-git/p-repair-state.ts`;
2. reset's no-prior-state branch directly serialized both active state and its
   incarnation marker, contradicting the store's claimed single ownership;
3. the existing closed persistence allowlists and invariant enforcement paths
   were not explicit migration gates.

Revision:

- added the complete owner-reachable dependency graph and mandatory direct
  import migrations for reset journal, P settlement, and P repair;
- strengthened structural validation to reject cycles and facade imports over
  the complete production graph reachable from an owner;
- added one narrow held-lock genesis-reset store primitive, keeping state and
  marker serialization private to the store without moving reset policy;
- pinned pre/post persistence allowlist totals and categories;
- made the four affected invariant-location updates and byte-golden durable
  format checks explicit validation gates.

## Round 2

Verdict: not yet aligned.

The reset/store ownership and validation blockers were resolved. The complete
graph check found one remaining cycle:
`sync-state-store.ts → telemetry/contract.ts → config.ts`. The telemetry
contract's type-only `GitDeferralReason` import still pointed through the
facade.

Revision:

- added `telemetry/contract.ts → sync-state-model.ts` to the dependency graph
  and mandatory direct-import migration.

## Round 3

Verdict: architecture reviewer aligned; ownership reviewer found three
remaining ambiguities.

The design simultaneously described public state paths as private, assigned
marker normalization to reset while keeping marker interpretation in the
store, and did not assign the counter normalizer or shared state-lock error
formatting used by both store and reset.

Revision:

- kept existing `statePath`/`stateLockPath` public while retaining the
  incarnation path/schema privately behind narrow store operations;
- moved reset marker normalization behind
  `assertResetIncarnationMarkerNormalized`;
- assigned one owner-internal `normalizeStateCounter` to the model and forbade
  duplicate implementations;
- assigned one owner-internal `stateLockBusyDetail` formatter to the store.

## Round 4

Verdict: aligned.

Both reviewers confirmed that the four modules are deep, no owner or facade
participates in a cycle, public compatibility is explicit, and the store/reset
seams preserve lock ownership, marker interpretation, counter normalization,
and error formatting without duplication. Implementation may proceed under
the design's migration and validation gates.

Implementation discovery: the wider engine graph contains a pre-existing
crypto import cycle reachable from these modules. The structural gate was
therefore narrowed to the intended property: neither an owner nor the facade
may belong to a strongly connected component, and no owner may reach the
facade. It does not claim to eliminate unrelated engine-internal cycles.

## Final code review

Both reviewers approved after four verification findings were resolved:

- raw whole-state allowlists exclude the separately surface-pinned facade, so
  operation-category totals remain unchanged;
- cycle wording and enforcement both cover owner/facade SCC membership without
  claiming to repair unrelated reachable engine cycles;
- state and reset-genesis byte goldens are manually shaped rather than derived
  from returned implementation objects;
- the reset-fence invariant cites both artifact-preflight helpers and the
  fenced orchestration call site.

No behavior-safety or ownership findings remain.
