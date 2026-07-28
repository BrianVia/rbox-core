# Round 1

## Verdict: NOT ALIGNED

### Blocking — the proposed SQLite half of the differential can be tautological

The design says to exercise “the SQLite compatibility check over its raw
projection,” but it does not name such a checker or define where that check
lives. There is no `adapters/whole-state-compat.ts` in the current tree, and
T0.2 intentionally deletes the only SQLite API that accepts
`expectedStream`. After that deletion, the production SQLite surface has only
`loadRawStateFromStore(store)`, which cannot throw a stream mismatch because it
does not receive an expected stream.

A test-local adapter that reads the raw projection and then constructs
`new StreamMismatchError(root, expected, raw.stream, "state")` will trivially
match the JSON error, but it does not prove that a SQLite wrong-stream read
refuses anything. It tests the test harness. This is especially misleading if
the test asserts identical `source`: SQLite does not currently own the
JSON loader's `activePresent ? "state" : "incarnation-marker"` source decision.

Revise the design to spell out the honest contract and exact harness:

1. The real JSON `loadState(root, expected)` must reject with
   `StreamMismatchError`.
2. The SQLite raw projection must retain the observed non-empty authority
   unchanged (observed stream, sequence, and a non-empty manifest/repository
   witness), never return an expected-stream genesis.
3. A test-only backend-neutral comparison helper may translate that observed
   mismatch to the stable typed error for field/message comparison, but the
   test must call it out as compatibility-boundary contract evidence, not as a
   production SQLite refusal path.
4. Add a static/export assertion (or equivalent compile-time proof) that
   `loadStateFromStore`, `readOnlyAdapters`, and `StateStoreReadAdapters` are
   absent, so production cannot invoke the fabricating path.

Alternatively, name and test a real production compatibility boundary, but
adding one appears outside this deliberately policy-free T0.2 slice. The first
option matches the requested deletion and does not pretend an unwired policy
path exists.

### Important — preserve the public error export explicitly

The design says `sync-state-store.ts` “imports and uses” the moved class while
`config.ts` continues to re-export it from the stable surface. Today
`config.ts` re-exports `StreamMismatchError` *from `sync-state-store.ts`*.
Merely importing the class there will break that surface. Specify either:

- import it for local use and explicitly re-export it from
  `sync-state-store.ts`, leaving `config.ts` unchanged; or
- change `config.ts` to re-export from `state-plane/errors.ts`.

The former minimizes surface churn. Preserve the exact constructor fields,
`name`, and message, including its state/incarnation path rendering, and keep
the existing config surface/typecheck tests green.

### Important — make the scripts project ownership exact

The proposed `scripts/tsconfig.json` is directionally correct:
`extends: "../tsconfig.json"` and child-relative includes for
`rig/**/*.ts`, `tui-compiled-smoke.ts`, and
`tui-performance-budget.ts` will cover the two entrypoints and their imported
rig binary helper. Its exclusions should be stated literally enough to avoid
accidentally checking generated artifacts while still excluding all current
rig tests, for example:

- `rig/**/*.test.ts`
- `rig/runs/**`
- `rig/cache/**`

Decide explicitly whether the now-unreferenced `scripts/rig/tsconfig.json` is
deleted. Leaving two script project definitions invites coverage drift; the
new owning project should replace the old one.

`package.json` should define `typecheck:scripts` as
`tsc -p scripts/tsconfig.json` and the ordinary `typecheck` chain should invoke
it. The CI checks job already runs `bun run typecheck`, so this does wire the
new project into CI transitively; rename the step near line 181 to
`Typecheck (root + apps/api + scripts)` so the ownership is review-visible.
No separate CI command is required if the package command is the single
source of truth.

### T0.4

Aligned. Deleting the transition constant, using literal `expectedExit: 0`
for both outside-workspace status workloads, and narrowing `measure` to one
numeric expected exit correctly removes the waiver. The validation should
invoke each TUI script without required binary arguments and assert that it
reaches its own usage error (rather than failing on an import/parse error).
Run the real compiled budget lane only when both usable binaries exist, and
record the concrete blocker otherwise.

### Baseline execution

Executed:

```text
bun run typecheck:rig
```

Result: failed as expected with `TS2322` at
`scripts/rig/scenarios/worktree-squash-lifecycle.ts:238`; the conditional
environment object contains an optional `undefined` concurrency property and
is not assignable to `Record<string, string>`.

### Scope audit

The design correctly forbids edits to `sync-state.ts`,
`sync-state-model.ts`, and `sync-git/base-composer*`. This review did not edit
or execute changes against those T0.1-owned files.

# Round 2

## Verdict: ALIGNED

The revision resolves every Round 1 issue and is implementable within the
user's requested scope.

### T0.2

The differential now states the actual evidence correctly:

- real legacy JSON `loadState(root, expected)` supplies the production typed
  refusal;
- SQLite is exercised only through its surviving raw projection;
- the SQLite assertions prove that the observed non-empty authority remains
  intact, including stream, sequence, manifest, and repository witnesses;
- any conversion to `StreamMismatchError` is explicitly test-only
  compatibility-boundary evidence rather than a claim that an unwired
  production SQLite expected-stream API exists.

That combination proves the defect cannot recur through the current SQLite
surface: the fabricating function is deleted, its exports/types are guarded
absent, and the raw primitive preserves durable authority rather than
manufacturing genesis. For the absence guard, runtime export assertions
appropriately cover the two value exports while a type-level assertion covers
`StateStoreReadAdapters`.

The error move is also exact now. Importing and explicitly re-exporting
`StreamMismatchError` from `sync-state-store.ts` preserves `config.ts`'s
existing stable export graph while allowing the implementation to live in
`state-plane/errors.ts`. Preserving the constructor, fields, `name`, and
message is sufficient to retain the public behavior and existing surface
tests.

### T0.3

The scripts project has one clear owner:

- `scripts/tsconfig.json` extends `../tsconfig.json`;
- its includes cover all rig production TypeScript plus both TUI entrypoints;
- its explicit exclusions cover current rig tests and generated `runs`/`cache`;
- the superseded nested project is deleted;
- `typecheck:scripts` replaces `typecheck:rig`;
- root `typecheck` invokes root, API, and scripts;
- the CI checks job continues to call that root command and advertises all
  three owners in its step label.

This closes the #560-class import hole without introducing a second drifting
project definition. The imperative `Record<string, string>` construction
directly fixes the reproduced `TS2322`.

### T0.4 and validation

T0.4 remains aligned: literal exit `0` for both outside-workspace status
workloads and a scalar `measure` contract fully retire the waiver. The
validation plan covers the requested typecheck, state-plane suite, usage-level
execution of both TUI scripts, and the compiled performance lane when usable
binaries exist, with a concrete blocker required otherwise.

The forbidden-file and named-staging audits protect the parallel T0.1 work.
No further design changes are required before implementation.
