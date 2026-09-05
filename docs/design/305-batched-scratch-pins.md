# 305 — Batch scratch-pin creation

Status: implementation-ready. Roadmap 287 §G5c.

## Owner and change

`src/cli/sync-git/pins.ts:createScratchPins` remains the sole owner of scratch-pin
namespace allocation, creation, and failed-creation cleanup. It will replace its serial
`ownedUpdateRef` loop with one native `git update-ref -z --stdin` transaction containing
`create <ref>\0<sha>\0` records. The existing `OwnedRefMutationBoundary` lease surrounds
that transaction once. Empty input returns `{ refs: [] }` before allocating a namespace,
entering the boundary, or spawning Git.

The measured update-ref spawn count for 1 / 50 / 500 pins is currently 1 / 50 / 500 and
becomes 1 / 1 / 1. This changes process count only; the returned ordered ref list and each
ref's exact object value stay the same.

## Protected functionality

- Each call uses a capture-unique `refs/rbox-wip/<epochMs>-<random>/<n>` namespace, so
  concurrent sibling captures do not share or overwrite refs.
- `create` rejects collisions instead of overwriting an existing ref.
- Git's native transaction makes the batch atomic: an invalid object or locked target
  leaves every target absent and the original Git error reaches the caller unchanged.
- Failed creation still calls idempotent `deleteScratchPins` for every intended ref before
  rethrowing, preserving the existing cleanup contract. Cleanup failure remains tolerated.
- One observation lease covers one creation transaction; lease-entry and finish failures
  retain their current best-effort semantics.
- Ordered ref naming, capture and quarantine callers, bundle inputs, and cleanup after a
  successful capture remain unchanged.
- `deleteRefsBatch`, `ownedUpdateRef`, age-guarded stale pruning, protocol locks, ref-plane
  transactions, and keep pins are outside this change and remain untouched.

No persisted or wire format changes. No migration, compatibility path, command, safety
property, recovery behavior, or supported runtime is retired. There are no safe-deletion
candidates in this slice.

## Ownership and requirement challenge

The Module interface stays `createScratchPins(repoDir, shas, boundary?) -> ScratchPins`;
callers remain adapters to that complete operation and learn no transaction phases. Git
owns atomic ref mutation, while `createScratchPins` owns namespace and cleanup policy.

The cleanup attempt after an atomic failure is mechanically redundant, but it preserves an
explicit caller-visible contract and is therefore retained. No product decision, flag,
fallback mode, helper abstraction, or dependency is added.

## Gates

Real temporary repositories cover 0 / 1 / 50 / 500 inputs, exact ordered values, constant
spawn count, invalid-object atomic failure and cleanup, one held target lock, exactly one
boundary entry, and concurrent sibling namespaces. Existing capture and keep-pin suites
provide caller and compatibility coverage. The acceptance gate is:

```
bun test src/cli/sync-git/pins.test.ts src/cli/sync-git/capture.test.ts src/cli/sync-git/keep-pins.test.ts
bun run typecheck
bun run lint:affected
```

The focused real-repository suite is the differential and crash/lock gate. This slice has
no persisted-format compatibility matrix or meaningful in-process memory change; the
process-count assertion is its performance gate. Repository rig validation remains the
broader integration gate when available.

## Rollback

Revert creation to the serial `ownedUpdateRef` loop. There is no persisted format or rollout
state to migrate, and the same scratch refs remain readable and cleanable across rollback.
