# 198 — Decompose CLI configuration and sync-state ownership

Status: IMPLEMENTED; integrated rig blocked by missing dev secrets (2026-07-24)

## 1. Problem

`src/cli/config.ts` is 1,438 lines and exposes 48 runtime/type exports across
four independently changing domains:

1. the machine-local workspace binding and its secret-stripping disk format;
2. the durable sync-state model, legacy projections, and manifest metadata;
3. state-file loading, generation-CAS publication, and telemetry identity;
4. the complete-fence reset transaction and repository-artifact preflight.

The file is not one necessary transaction island. In particular, workspace
binding changes require loading Git reset machinery, while reset review must
scan presentation-free config helpers and every state type. The current module
has poor locality and makes `config.ts` a 113-caller merge hotspot.

This is a behavior-preserving source decomposition. It does not change exports,
disk bytes, error text, lock acquisition order, reset ordering, validation,
state projection, or public call sites.

## 2. Goals and non-goals

Goals:

- make `config.ts` an explicit compatibility facade with no implementation;
- give each durable format and transaction exactly one owner;
- preserve every existing runtime and type export through the facade;
- retain state CAS and complete reset as intact deep modules;
- remove inward imports through the facade so dependency direction is acyclic;
- stop after this `config.ts` decomposition.

Non-goals:

- no schema, migration, reset, telemetry, locking, or warning-policy changes;
- no renaming of public exports or migration of the 113 existing callers;
- no new generic repository, persistence, or dependency-injection framework;
- no decomposition of `src/cli/sync-state.ts` or reset-journal modules;
- no opportunistic cleanup of behavior-sensitive code while relocating it.

## 3. Target ownership

### `src/cli/config.ts`

Explicit named value/type re-exports only. Never: filesystem I/O, validation,
state projection, locks, reset behavior, wildcard exports, or imports from
engine/reset implementations.

### `src/cli/workspace-config.ts`

Owns the machine-local workspace binding interface and disk format:

- `WorkspaceConfig`, `RBOX_DIR`, and normalized trash retention;
- manifest-stream identity;
- workspace-root discovery;
- typed config absence;
- config loading and atomic secret-stripping save.

It never owns credentials/keystore loading, sync-state persistence, reset
authorization, or repository state.

### `src/cli/sync-state-model.ts`

Owns the in-memory and persisted sync-state model:

- sync-state, manifest-meta, repository-record, deferral, partial-apply,
  resolution, packet, result, and option types;
- manifest-meta validation and exact-manifest reconstruction;
- legacy sidecar-to-record migration projection;
- record-to-persisted-state projection and Git-section sanitization;
- expected nonce and legacy-sidecar capacity.

This module is the single model seam shared by the state store, reset
transaction, sync composition, and Git lanes. It never reads or writes files,
acquires locks, recovers journals, or manufactures telemetry identity.

### `src/cli/sync-state-store.ts`

Owns ordinary durable state-file persistence:

- state and lock paths plus incarnation-marker interpretation;
- raw and stream-checked loading;
- whole-packet generation-CAS publication under the state lock;
- capable-lineage initialization;
- intentionally restricted whole-state compatibility writes;
- telemetry binding initialization under the state lock;
- reset-journal recovery encountered during ordinary `loadState`.
- one reset-only `installGenesisResetStateUnderHeldLock` primitive that asserts
  the logical state lock and exact physical lock, installs the byte-identical
  genesis state plus incarnation marker without acquiring locks, and returns
  the installed state.
- one reset-only `assertResetIncarnationMarkerNormalized` operation that keeps
  the marker path/schema private while preserving reset's exact refusal text;
- one internal `stateLockBusyDetail` formatter shared by ordinary CAS and reset
  state-lock acquisition.

The generation-CAS transaction remains direct and intact. The store consumes
the model's projections but never owns reset consent, complete repository
fencing, reset artifact preparation, or workspace config serialization.
`statePath` and `stateLockPath` remain existing public exports through the
facade. The incarnation-marker path/schema and state serialization remain
private here; the reset-only operations do not make policy decisions.

### `src/cli/reset-state.ts`

Owns the complete-fence reset transaction:

- reset hooks and the public `resetSyncState` entry point;
- repository inventory used to choose the complete recovery fence;
- checkout-journal and A/P/Z artifact preflight;
- P settlement/repair stabilization;
- consent rechecks, journal preparation/recovery, and old-binding sidecar
  cleanup.

It uses concrete workspace-config and state-store operations. The no-prior-state
branch calls `installGenesisResetStateUnderHeldLock` while already holding the
state lock, and marker preflight calls the store's narrow normalization
operation. It does not know the marker path/schema, construct or serialize the
state/marker, reimplement state CAS, parse workspace config, implement reset
journal durability, or define reset consent semantics.

## 4. Dependency direction

```text
config.ts (explicit compatibility facade)
  ├── workspace-config.ts
  ├── sync-state-model.ts
  ├── sync-state-store.ts
  └── reset-state.ts

sync-state-store.ts ──> workspace-config.ts + sync-state-model.ts
reset-state.ts ───────> workspace-config.ts + sync-state-model.ts
                        + sync-state-store.ts
sync-state-model.ts ──> engine Git model + sync-git/base-composer.ts
workspace-config.ts ──> engine fsutil.ts

sync-state-store.ts ──> reset-journal.ts ──> sync-state-model.ts
sync-state-store.ts ──> telemetry/contract.ts ──> sync-state-model.ts
reset-state.ts ───────> sync-git/p-settlement.ts
                         └──> sync-state-store.ts + sync-state-model.ts
reset-state.ts ───────> sync-git/p-repair-state.ts
                         └──> sync-state-store.ts + sync-state-model.ts
```

No owner module imports `config.ts`. `sync-state-store.ts` does not import
`reset-state.ts`, so ordinary loading cannot form a reset/store cycle.
`reset-journal.ts`, `sync-git/p-settlement.ts`, and
`sync-git/p-repair-state.ts` migrate their type imports to
`sync-state-model.ts` and state-operation imports to `sync-state-store.ts`.
`telemetry/contract.ts` likewise imports `GitDeferralReason` directly from the
model instead of the facade.
No production module transitively imported by an owner may import the
compatibility facade.

`sync-state-model.ts` additionally exposes an owner-internal
`normalizeStateCounter` operation, not re-exported by `config.ts`. The model,
store, and reset transaction import this single definition directly; duplicate
counter normalization is forbidden. Reset imports the store-internal
`stateLockBusyDetail` formatter directly to preserve lock refusal strings.

## 5. Behavior-preservation invariants

1. Every existing runtime and type export remains available from
   `src/cli/config.ts` with the same assignability.
2. `workspace.json` paths, formatting, atomic publication, errors, and runtime
   secret stripping are unchanged; token, KEK, account ID, and epochs never
   persist.
3. Missing state remains genesis, corrupt state remains fatal, and stream
   mismatch remains a typed refusal with the same active-state versus
   incarnation-marker source.
4. Legacy repo maps fold into records identically, unknown record fields keep
   round-tripping, and persisted BASE/P sections pass through the same
   sanitizer/composer.
5. A state packet still acquires exactly the same physical state lock, checks
   stream/nonce/global sequence/all repository generations before publication,
   writes once, rechecks lock ownership before rename, and removes the marker
   only after acceptance.
6. Reset-only genesis installation asserts the logical state lock and exact
   held physical lock, acquires no lock, writes the same state and marker bytes
   in the same order, and exposes no general-purpose state-write interface.
7. Incarnation-marker normalization uses one store operation with its
   path/schema private; model, store, and reset share one counter normalizer;
   ordinary CAS and reset share one state-lock busy-detail formatter.
8. State-packet rejection remains all-or-nothing; state nonce/revision and
   manifest-meta invalidation semantics are unchanged.
9. `loadState` recovers a standing reset journal only while holding the same
   non-degraded workspace mutex and retains the same release behavior.
10. Complete reset retains lock order:
   workspace mutex → repository recovery fence → physical state lock.
   No state writer or P settlement reacquires the held state lock.
11. Reset consent is validated before mutation and rechecked under the complete
   fence before consumption; repository identity, checkout journals, A/P/Z
   artifacts, state bytes, and incarnation are revalidated at the same points.
12. Sidecar cleanup occurs only after reset journal recovery and retains the
    same failure behavior.
13. Telemetry binding initialization remains state-lock protected and rejects
    absent or foreign-stream state.

## 6. Migration sequence

1. Add runtime and compile-time facade surface fixtures before moving code.
2. Extract `workspace-config.ts` as one contiguous ownership group.
3. Extract `sync-state-model.ts`, preserving type names and projection bodies.
   Give store and reset one direct internal `normalizeStateCounter` definition
   without adding it to the compatibility facade.
4. Extract `sync-state-store.ts`, preserving the CAS and load transactions
   without helper reordering. Keep `statePath`/`stateLockPath` public; keep the
   incarnation path private behind reset marker assertion and genesis
   installation operations; retain one internal busy-detail formatter.
5. Extract the complete reset block into `reset-state.ts` without splitting its
   transaction island. Replace only its no-prior-state write pair with the
   reset-only held-lock store primitive.
6. Replace `config.ts` with exhaustive explicit named re-exports.
7. Make owner-to-owner imports direct. Explicitly migrate `reset-journal.ts`,
   `sync-git/p-settlement.ts`, `sync-git/p-repair-state.ts`, and
   `telemetry/contract.ts` away from the facade to eliminate transitive runtime
   cycles. Leave unrelated external callers importing the facade in this PR.
8. Update `docs/CODEMAP.md` with one line per owner module and the facade.
9. Update `sync-git/base-composer-structure.test.ts` by moving its closed
   persistence allowlist to the new owners. Pre/post total occurrences and
   allowed operation categories must remain identical; only owner paths change.
10. Refresh `docs/INVARIANTS.md` enforcement paths for state incarnation
    fencing, packet atomicity, ABA prevention, and the complete reset fence
    without changing their claims.

Every relocation is followed by focused tests and typechecking. No public
caller migration is mixed into the move.

## 7. Compatibility contract

`config-surface.test.ts` locks down:

- exact runtime export keys;
- explicit facade exports and absence of wildcard exports;
- absence of owner-module imports from `config.ts`;
- absence of imports of `config.ts` from every production module transitively
  reachable from an owner;
- no owner or facade belongs to a strongly connected component in the complete
  production import graph. Pre-existing engine-internal cycles merely reachable
  through an owner are outside this structural refactor.

`config-surface.typecheck.ts`, included by the root TypeScript project, imports
every public interface/type through the facade and asserts bidirectional
assignability against its owning module.

Existing behavioral tests continue importing `config.ts`; owner-direct tests
are additive only when required to cover an otherwise private seam.

## 8. Validation

Required:

1. `bun test src/cli/config-surface.test.ts src/cli/config-presence.test.ts`
2. byte-golden workspace secret stripping, ordinary CAS state, reset-genesis
   state, and reset-genesis incarnation-marker tests;
3. `bun test src/cli/sync-git/base-composer-structure.test.ts`;
4. state-model/meta and telemetry tests;
5. sync-state CAS, lock, retry, and legacy compatibility tests;
6. reset-consent, reset-journal, reset-halt, and reset-doctor tests;
7. Git config/follow/settlement tests that persist repository records;
8. `bun run typecheck`;
9. `bun run guards`;
10. `bun test src/cli`;
11. `bun run typecheck:rig`;
12. `bun run test:rig`;
13. `bun run dev:install -- --outfile /tmp/rbox-config-198`;
14. `/tmp/rbox-config-198 --help`;
15. `bun run rig`.

If the integrated rig is unavailable because of host prerequisites, record the
exact blocker and retain all completed local gates.

## 9. Review bar

Fail review if:

- the facade contains logic or wildcard exports;
- any module transitively imported by an owner imports through the facade;
- an owner or the facade belongs to a production import cycle;
- state CAS, reset, or workspace-save steps are reordered;
- a durable schema or error string changes;
- reset lock ownership becomes implicit across a new interface;
- reset reads the incarnation-marker path/schema directly or duplicates counter
  normalization/state-lock error formatting;
- the reset-genesis primitive accepts no held lock, acquires a lock, or exposes
  general state publication;
- the model is split into pass-through files that fail the deletion test;
- external callers are migrated merely to demonstrate the new files;
- persistence allowlist totals or categories change rather than merely moving;
- `config.ts` exceeds 250 lines after the split.

## 10. Result

Implemented the four-owner split with a 59-line explicit compatibility facade:

- `workspace-config.ts`: 162 lines;
- `sync-state-model.ts`: 438 lines;
- `sync-state-store.ts`: 448 lines;
- `reset-state.ts`: 495 lines.

The exact runtime/type facade surface, owner/facade cycle exclusion, workspace
secret-stripping bytes, ordinary state bytes, reset-genesis state/marker bytes,
and closed persistence allowlists are checked. State CAS, manifest metadata,
telemetry identity, reset consent, reset journal recovery, BASE composition,
activity/status consumers, typechecking, guards, rig typechecking, and the
compiled CLI smoke test pass. Both final adversarial reviewers approved the
implementation.

The broad CLI suite continues to expose unrelated failures already present on
main in design-166 adoption, macOS credential ancestor safety fixtures, and
Git-resolution tests whose isolated timeout was reproduced in a detached
`origin/main` worktree. Rig library tests pass 145/146; the remaining daemon-log
harvest fixture is outside this diff. `rig doctor` reaches the healthy local
container runtime and dev API but cannot run an integrated scenario without
`RBOX_DEV_BOOTSTRAP` and `RBOX_DEV_PLATFORM_SECRET`.
