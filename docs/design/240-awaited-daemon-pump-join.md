# Design 237 — awaited daemon pumps join the service flight

## Status

Implemented and validated. Forensic follow-up to the CI signature
`FORENSIC pull-line-missing lines=[]` seen on PRs #648 and #652.

## 1. Root cause

`DaemonOperationScheduler` is the sole owner of daemon pump single-flight.
Its `service()` contract says a second caller joins the loop already in flight,
but its implementation returns a newly resolved promise when `pumping` is true:

```ts
if (this.pumping || this.ports.isStopped()) return Promise.resolve();
```

That makes this ordinary test and product sequence dishonest:

```ts
daemon.want.pull = true;
await daemon.pump();
// The requested pull may still not have run.
```

If an event, timer, or prior operation already entered the service loop, the
explicit caller resumes immediately. In the trusted-pull tests it observes an
empty log sink before the in-flight loop emits `pull local=...`. In WS tests it
observes attribution before the pull consumes its carrier. Teardown can also
begin while the service flight still owns the fixture, making the shared folder
catalog briefly observe two live temporary roots with the same fixture binding;
PR #652 logged the resulting named boundary refusal:

```
sync halted: rbox cannot run this folder (ambiguous):
the same workspace and device binding also exists at /tmp/...
```

The existing contract test accidentally pins the bug: after starting a gated
pull it awaits a second `service()` call and asserts that the call returned
before the gate opened.

## 2. Protected-functionality ledger

| Contract | Protection |
|---|---|
| At most one service loop runs per daemon | Retain the `pumping` guard; never start a second loop. |
| Wakeups coalesce in the scheduler-owned boolean queue | Do not add request identities, waiter queues, modes, or counters. |
| An in-flight loop drains work queued before its selection/exit boundary | The joining caller awaits that same loop. |
| Timer and watcher callers remain fire-and-forget | Existing `void pump()` call sites remain unchanged. |
| A stopped daemon starts no new work | Stopped calls resolve immediately even while a flight drains; only `stop()` waits for that flight. |
| Boundary refusal preserves the queued want and names its reason | Existing folder/reset/binding logs and parked-queue behavior remain unchanged. |
| Mutex contention retains work and backs off | No mutex or dequeue behavior changes. |
| Pull safety, watcher trust/fuse, matcher provenance, and recovery semantics | No pull-domain state or predicate changes. |

Active migrations and compatibility paths are untouched. There is no command,
wire, persistence, output, or performance-fast-path retirement.

## 3. Ownership and smallest fix

`DaemonOperationScheduler.service()` already owns both the single-flight flag
and `pumpRun`, the promise representing that flight. Its complete Interface is:

- idle + live: create and return one service flight;
- active + live: return the existing `pumpRun`;
- stopped: return a resolved promise; `stop()` remains the sole drain Interface.

The implementation change is one branch:

```ts
if (this.ports.isStopped()) return Promise.resolve();
if (this.pumping) return this.pumpRun;
```

This reduces the semantic concepts from “service flight plus a false completion
receipt” to one authoritative completion promise. No adapter reconstructs
orchestration, and no new abstraction is introduced.

The receipt is intentionally conditional: an awaited `service()` joins the
current flight only while the daemon remains live. A stopped scheduler resolves
immediately, a standing halt can make its matching ambient want ineligible, and
a named operation-boundary refusal parks the want for a later external wakeup.
Those paths keep their existing stop/drain or logged/durable refusal surfaces;
they do not falsely report that an eligible live service flight completed.

A wake queued during exit settlement is still inside the joined receipt.
Settlement runs with `pumping=true`; the parent flight then clears the flag,
synchronously observes the wake, and awaits the re-entered service flight before
the parent `pumpRun` resolves.

## 4. Deterministic red proof

Change the scheduler contract test to start a gated pull, queue a push, and call
`service()` again. Before releasing the gate, prove that the second promise is
still pending. After release, await both promises and prove both operations ran
through the one flight.

The old implementation fails locally because the join promise resolves before
the gate. The fix makes it green without sleeps or timing-sensitive assertions.

This is the local causal reproduction of `lines=[]`: replace the second queued
operation with pull logging and the premature completion is exactly the CI
observation.

## 5. Rejected suspects and global-state audit

- **inotify/Parcel exhaustion:** impossible for this signature. The trusted-pull
  fixture installs fake watcher objects and opens no native subscription.
  Production watcher startup rejection is caught and logged after safety/deep
  reconciliation is armed. A later subscription gap could lose a future
  watcher wakeup, but cannot consume an explicitly set `want.pull`.
- **design-206 fuse latch:** `trustState`, matcher generation/provenance,
  watcher health, and watcher error generation are per-daemon fields. The fuse
  tests mutate only their fixture daemon. A fused daemon would still log
  `pull local=scan skip=p1-watcher`, not `lines=[]`.
- **environment:** the suite restores `RBOX_PULL_TRUST_WATCHER`. Its combined
  design-202/203 test deletes `RBOX_GIT_APPLY_LAZY` without restoring an ambient
  value; clean that harness leak while here, but it cannot suppress a pump.
- **folder catalog:** it is intentionally process-global in the test process and
  correctly refuses duplicate live bindings. Do not weaken this product safety
  assertion. Awaiting the scheduler owner before assertions/teardown removes the
  false overlap rather than bypassing admission.

## 6. Requirement challenge ledger

| Requirement | Complexity cost | Evidence | Decision |
|---|---|---|---|
| A second awaited pump may return before the shared flight | Callers need private `pumpRun` knowledge and race assertions/teardown | Contradicts the Interface comment and two CI failure clusters | Delete this accidental behavior. |
| Preserve the existing contract test's immediate-return assertion | Enshrines a false completion receipt | It was introduced with the scheduler split, not as product behavior | Replace with a true join assertion. |
| Isolate each daemon test by bypassing folder admission | Would weaken production duplicate-binding safety and hide lifecycle races | CI's admission log is correct evidence | Reject. Keep the real boundary. |
| Raise inotify limits in CI | Runner-specific mechanism with no causal connection | Trusted fixture uses no native watcher | Reject. |

## 7. Safe deletion candidates

- Remove the temporary `FORENSIC pull-line-missing` console dump after the
  deterministic scheduler contract covers the cause. The pull-line assertions
  themselves remain unchanged.
- No product module, command, compatibility path, or safety branch is approved
  for deletion.

## 8. Validation gates

1. **Red/green differential:** scheduler join contract fails before and passes
   after the one-branch fix.
2. **Focused compatibility:** trusted-pull and WS reliability suites pass with
   every existing assertion intact.
3. **Exact CI process shape:** run current six-way shard membership for affected
   shards in one Bun process, including a CPU-constrained run where practical.
4. **Daemon regression:** `bun test src/cli/daemon/` passes.
5. **Repository gates:** typecheck and `bun run lint:affected` pass.
6. **Crash/stop semantics:** existing stop, refused-boundary, contention, and
   exit-time re-entry scheduler contracts stay green. No durable effect ordering
   changes, so no new crash point is introduced.
7. **Performance:** fire-and-forget callers allocate nothing new; concurrent
   awaited callers reuse the existing promise. No scan/network path changes.
