# 233 — Operation-scoped scratch-ref mutation observation

Status: implementation design for the `CODEX-LOOP-HUNT.md` defect.

## Protected contract

- Design 175's Linux+Parcel ref registry continues to classify and immediately
  pre-signal external `packed-refs.lock` transactions. The main watcher and all
  non-Linux behavior remain unchanged.
- Pending sections remain conservative: forced capture may supersede one only
  through the existing proof, and failures carry the pending section.
- Capture still deletes its exact `refs/rbox-wip/*` pins in `finally`; the
  existing age-guarded crash cleanup remains unchanged.
- Registry/ref-watch failure continues to degrade to the 60-second safety floor;
  observation may never make capture fail.
- Registry-originated signals pass through `PropagationTrace.eventSeen("git")`
  before entering the existing signal debouncer.

No supported behavior, migration, compatibility path, or fast path is approved
for deletion.

## Ownership and interface

`GitRefWatchRegistry` already owns Linux ref-event classification and delivery.
It gains one complete operation-scoped interface:

```ts
enterOwnedRefMutation(repoDir): Promise<{ finish(): Promise<void> } | undefined>
```

The registry resolves the physical common ref store, snapshots its committed
syncable ref surface excluding `refs/rbox-*`, and reference-counts overlapping
owned `git update-ref` operations for that store. While one of those commands is
active, only the common-dir `packed-refs.lock` pre-signal is withheld. Other
target, lock, structural, and nameless events retain design-175 behavior.

On the last `finish`, after the owned command exits, the registry checks
`packed-refs.lock`, reads the committed surface again, then checks the lock once
more. Equality plus lock absence proves the completed exclusive transaction was
scratch-only and emits nothing. Inequality proves an external committed ref
change; a still-present lock proves another/ambiguous transaction is in flight;
either emits the normal signal. An unreadable observation also signals
conservatively. The operation callback is best-effort and non-throwing to the
capture path.

The engine owns scratch-pin lifetime, not observation policy. `captureGitState`
accepts the optional daemon-neutral boundary and passes it to the scratch-pin
owner. `pins.ts` brackets each `git update-ref` used by create, exact cleanup,
and age-guarded crash cleanup; it never brackets bundle/encryption/upload work.
Its helper swallows boundary entry/finish errors while preserving update-ref
errors and exact cleanup. The existing `SyncDeps`/plan option bag carries that
single capability from the daemon composition root through
`GitDiscoveryContinuity.enterOwnedRefMutation`, which delegates only when a
live registry exists. Direct/foreground engine callers omit it and behave
exactly as today; absent/closed/reader-dead registry entry returns no lease.

## Invariants and races

- Physical-store identity, not worktree path, keys overlapping scopes.
- A first overlapping command owns the baseline; the last owns reconciliation. This
  prevents sibling captures from treating each other's scratch pins as external.
- Scratch refs are excluded from both snapshots by the existing syncable-ref
  policy. Git's exclusive packed-ref lock makes a successfully completed owned
  command's lock attributable. A concurrent external transaction either changes
  the snapshot or leaves the lock present after the owned command; either still
  signals even if its pre-signal arrived during that command. Outside those
  short commands, design 175 pre-signals immediately as before.
- Closing the registry fences new entries. A late finish is harmless and cannot
  reopen handles or throw into capture.
- `packed-refs.lock` classification, Git-busy retry behavior, and the 60-second
  backstop are untouched.

## Validation

1. Registry unit coverage: scratch-only lock is withheld and reconciles quiet;
   an external ref change within the same scope emits once; a lock held through
   finish emits conservatively; unrelated locks and external packed locks
   outside a scope still pre-signal.
2. Real Linux registry regression: forced pending capture with `ORIG_HEAD`
   creates/deletes scratch pins without a follow-up signal push.
3. Real Linux registry race: an external packed-ref transaction concurrent with
   capture still produces a signal.
4. Propagation wiring test pins `eventSeen("git")` before registry signal enqueue.
5. Run `bun test src/cli/daemon/ src/cli/sync-git/ src/engine/git/`, typecheck,
   and lint. Differential contract: existing design-175 lock/busy tests remain
   green. Crash contract: existing scratch cleanup tests remain green.

## Requirement challenge and deletion ledger

| Requirement | Cost | Decision |
|---|---|---|
| Attribute lock events from filenames alone | Impossible for `packed-refs.lock`; both internal and external transactions share the name | Reconcile committed refs at the operation boundary instead of adding heuristics |
| Suppress every lock during capture | Would lose external branch/stash latency and violate design 175 | Reject; suppress only common-dir `packed-refs.lock` |
| Add durable mutation state | New recovery/format authority for an ephemeral observation concern | Reject; in-memory scope plus existing 60-second backstop |

Safe deletion candidates: none. The classifier, busy retry, stale-pin cleanup,
and safety cadence are all active protected mechanisms.
