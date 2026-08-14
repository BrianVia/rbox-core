# 248 — Bound push-gap telemetry writes

Status: ALIGNED r3 (issue #691 finding 1)

## 0. Yardstick

One accepted `sync_phase/push` sample must have a fixed, reviewable maximum
number of Analytics Engine writes. The server must validate both the
PhaseReport-derived gap cardinality and the request-wide emitted-point budget
before its first write, while the current client continues to report every gap
and tail value that fits the real producer contract.

## 1. Protected functionality and ownership

- `src/engine/phase-report.ts` remains the sole producer of phase-neighbor gaps
  and `tailMs`; its phase timing, accumulation, summary, and pure/no-I/O
  behavior do not change (CODEMAP line 390).
- `src/cli/telemetry/contract.ts` remains the client/server wire-contract owner,
  including the phase axes, numeric domains, gap key universe, cardinality, and
  request point budget (CODEMAP line 162).
- `src/cli/telemetry/sync-phase.ts` remains only the privacy-bounded projection
  of a completed report. Independent pull/push sampling cadence, strict outlier
  thresholds, integer clamping, `tailMs`, `prologue_ms`, `settle_ms`, and
  best-effort failure isolation remain unchanged (CODEMAP line 166).
- `apps/api/src/telemetry-ingest.ts` remains the sole fail-closed admission and
  Analytics Engine emission owner (CODEMAP line 44). Existing metric indexes,
  blob dimensions, and positional doubles remain byte-for-byte compatible.
- The schema-equality test remains capable of comparing the complete client and
  server contracts, including bounded point-producing records.

No command, migration, compatibility path, sampling behavior, metric index,
positional double, fast path, or supported timing field is approved for
retirement. The only deletion candidates are the server's generic numeric
record escape hatch, `syncPhaseGapKey`, and the normalized `extras` channel;
they are safe only after the bounded record owns the same legitimate gaps.

## 2. Contract

`PhaseReport` records a gap only at a `phase()` boundary and accumulates repeat
hits in a map. The production push surface has a finite adjacency graph even
though the generic accumulator accepts every `PhaseName`: the CLI pre-scan,
push attempt, pipeline/non-pipeline upload, bounded retry arms, nested conflict
pull, and resolution-receipt pull can produce only these 27 transitions:

```
start→state-load       start→validate
state-load→scan       scan→state-load       state-load→git-plan
git-plan→state-save   state-save→state-save state-save→address
git-plan→address      address→encrypt       address→upload
encrypt→missing      missing→upload        upload→commit
upload→state-load    commit→state-load     commit→state-save
commit→validate      state-load→latest     latest→validate
validate→scan        scan→reconcile        state-save→state-load
reconcile→apply      apply→cache-save      cache-save→git-apply
git-apply→state-save
```

The shared client contract enumerates these as `gap:<transition>` plus
`tailMs`, for a producer-derived cardinality of 28. Repeated attempts cannot
enlarge it because identical edges accumulate. This removes the server's
parser-like `syncPhaseGapKey`, rejects impossible endpoint combinations, and
preserves every gap from every current production push path. A future new
phase adjacency must update this contract and its equality/max-path tests in
the same change; otherwise the best-effort sampler emits no partial sample and
cannot affect sync.

`SyncPhaseSample.phases` becomes the fixed phase record it always claimed to
be. Push-only gap values move to a first-class `pointRecords.gaps` schema field
and a `gaps` sample member. Each admitted member preserves the current
`client.sync_phase.gap` index, `[index, op, key]` blobs, and one positional
duration double. The ordinary `client.sync_phase` point and its 20 positional
doubles are unchanged.

The shared total-write budget is:

```
TELEMETRY_POINT_BUDGET =
  TELEMETRY_BATCH_CAP * (1 + SYNC_PHASE_GAP_CARDINALITY)
  + TELEMETRY_DROP_POINT_BUDGET
```

`TELEMETRY_DROP_POINT_BUDGET` covers every distinct aggregate drop metric the
telemetry handler can emit together (`batch_cap` plus the four validation
reasons and the fail-closed `point_cap`; body-cap is a separate one-point 413
path). The server normalizes the capped batch and constructs all aggregate drop
points completely, rejects any over-cardinality record, and verifies the sum
of every planned Analytics Engine write before emitting the first sample or
drop point. The per-record bound makes the total guard redundant by
construction; retaining both is deliberate defense at the two required
ownership levels. A budget breach replaces the entire plan with one
low-cardinality `point_cap` drop, accepts no sample, and never partially emits
a sample.

## 3. Requirement challenges

| Requirement | Complexity cost | Evidence | Recommendation | Decision |
|---|---|---|---|---|
| Preserve gaps inside the generic fixed `phases` record | Requires a kind/op/field escape hatch and lets one batch slot mint hundreds of writes | Finding #691 and current `extraEntries` branch | Move gaps to one first-class bounded point record | Required by issue |
| Add a second unbounded normalized `extras` path | Keeps output amplification outside the schema | The only current user is push gaps | Normalize every accepted sample to one bounded point array | Reject |
| Change gap metric layout to one vector point | Would alter the existing one-double positional layout/dashboard meaning | Acceptance explicitly protects metric indexes and positional doubles | Preserve one point per bounded gap | Reject |
| Silently truncate producer gaps above the limit | Hides partial timing as complete | Telemetry is best effort and must not affect sync | Drop that telemetry sample atomically | Chosen |

## 4. Validation

- Contract equality: extend the API drift guard to compare bounded point-record
  keys, domains, output metadata, and maximum entries.
- Differential compatibility: keep the existing all-family positional-double
  fixture unchanged except for moving its two gap inputs to `gaps`; expected AE
  points remain identical.
- Adversarial bound: submit maximum-cardinality push records across the maximum
  batch plus a batch-cap drop and prove *all* writes stay within
  `TELEMETRY_POINT_BUDGET`; submit an over-cardinality record and prove it emits
  no partial base/gap points.
- Producer coverage: build a report traversing every production-reachable edge
  (reusing edges as needed to connect the walk), prove the sampler preserves all
  27 gap keys plus tail, and prove a non-contract edge fails best-effort without
  throwing into sync.
- Required gates: `bun run test:api`, `bun test src/cli/telemetry`,
  `bun run typecheck`, and `bun run lint:affected` with zero warnings on changed
  lines.
- Crash/failure: an Analytics Engine throw remains swallowed per point; no
  telemetry error reaches sync. Admission performs no write until the complete
  normalized batch and point budget are known.
- Performance: at most 64 samples, 1,856 sample points, and six aggregate drop
  points are normalized in memory; no new I/O, traversal of user data, or sync
  hot-path work is added.

No CODEMAP ownership changes or new modules are required.

## 5. Implementation validation

- Adversarial API fixture: one maximum 28-member gap record emits exactly 29
  sample points; an over-cardinality record emits only one aggregate
  `point_cap` point and no partial base/gap point.
- Client/server drift guard compares the transition/key arrays, cardinality,
  point-record schema, drop reserve, and total point budget. The existing
  all-family fixture preserves the exact base and one-double gap Analytics
  Engine layouts.
- `bun test src/cli/telemetry`: 30 passed, zero failed.
- `bun run test:api -- --configLoader runner`: 54 files passed; 886 tests
  passed, four skipped, zero failed. `--configLoader runner` is the documented
  sandbox workaround for the read-only shared dependency cache; Wrangler's
  separate read-only debug-log warning did not affect the green suite.
- `bun run typecheck`: passed for root, API, and scripts.
- `bun run lint:affected`: exited zero. It reports only pre-existing warnings on
  unchanged lines in the five touched files; this diff introduces no warning on
  a new line.
- `git diff --check`: passed.

Diff-scoped simplification found one schema-owned bounded point-record
primitive replacing the parser escape hatch and optional `extras` channel. It
adds no module, mode, flag, state authority, I/O, or sync orchestration. The
only deletions are the replaced gap predicate/escape path; no supported
functionality, migration, compatibility path, or fast path is retired.
