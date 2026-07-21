# Bun ref-watch contract probe results

Date: 2026-07-21

## v2 outcome

**PASS.** The three asserted behavioral cases passed five attempts each from
source and from an executed `bun build --compile` binary. In every attempt the
Parcel fixture delivered at least 100 callback entries from directories that
existed before subscription. Every ref mutation then overlapped a fresh,
sustained burst and another 100 or more Parcel entries arrived inside the same
five-second window as the Bun ref callback.

The harness is `scripts/probe/bun-refwatch-contract.ts`. It imports no rbox
product code and makes no runtime-version-dependent decisions. A normal source
invocation runs the source cases, compiles itself into a temporary native
binary, executes that binary, and requires its independent 3/3 PASS marker.

## Environment

```text
bun --version
1.3.14

Linux 6.17.0-35-generic x86_64
git version 2.54.0
@parcel/watcher 2.5.6 (lock-selected)
```

## Command and observed result

```text
$ bun scripts/probe/bun-refwatch-contract.ts

execution mode: source
case                              result  attempts  callback latency  churn ops  Parcel events/attempt  callback
fast git init -> empty commit     PASS    5/5       4.1-4.7ms         204608     4653-4672              refs/heads/main.lock
atomic move-in -> empty commit    PASS    5/5       4.0-4.2ms         204160     4666-4672              refs/heads/main.lock
populated ref subtree move-in     PASS    5/5       1.5-1.7ms         204608     4659-4672              refs/heads/x/y/z/deepest

root replacement REPORT: tuple=(66311,29127652) reused after 1 recreation(s); removal callbacks within 5000ms=rename/<null>; post-recreate callbacks within 5000ms=none; expected=rename/<null> then none
Bun ref-watch contract PASSED (3/3 cases)

execution mode: compiled
case                              result  attempts  callback latency  churn ops  Parcel events/attempt  callback
fast git init -> empty commit     PASS    5/5       3.8-4.7ms         204608     4662-4672              refs/heads/main.lock
atomic move-in -> empty commit    PASS    5/5       4.0-4.5ms         204160     4669-4672              refs/heads/main.lock
populated ref subtree move-in     PASS    5/5       1.5-2.5ms         204608     4650-4672              refs/heads/x/y/z/deepest

root replacement REPORT: tuple=(66311,29127652) reused after 1 recreation(s); removal callbacks within 5000ms=rename/<null>; post-recreate callbacks within 5000ms=none; expected=rename/<null> then none
Bun ref-watch contract PASSED (3/3 cases)
Compiled execution PASSED (3/3 cases)
```

`Parcel events/attempt` excludes the baseline event and is asserted per
attempt, not in aggregate. `churn ops` is the total number of filesystem
operations issued across the five attempts for that row. Parcel's callback
entries are coalesced and are not expected to equal the operation count.

## What v2 proves

- **Fast init:** after a repository is created while Parcel churn is active,
  the positive Bun watch layout observes the first commit's loose-ref target or
  adjacent lock within the deadline.
- **Atomic repository move-in:** after a populated repository is atomically
  moved into the workspace while Parcel churn is active, the armed layout
  observes the next commit's loose-ref target or adjacent lock.
- **Populated ref-subtree move-in:** `x/y/z` and two ref files are built outside
  the recursive `refs/heads` watch root. The top `x` directory is atomically
  renamed under `refs/heads`; after its arrival callback synchronizes the
  recrawl, an already-existing deepest file is overwritten. The required
  callback is for that exact deepest file. This establishes Bun's live
  descendant recrawl for a populated arriving subtree, not merely attachment
  to an empty immediate child.
- **Real Parcel pressure:** sixteen directories exist before subscription. The
  harness first requires an exact baseline child event, then creates, renames,
  and removes files directly inside those established directories. It requires
  at least 100 delivered flood entries before each ref mutation. Each mutation
  then starts alongside a fresh, sustained 4,096-file burst; the harness fails
  if that burst completes before the Bun callback and also requires at least
  100 more Parcel entries within the same five-second ref deadline. The
  observed total per attempt was 4,650-4,672 callback entries.
- **Same-identity root replacement:** a raw recursive `refs` watch is proved
  live, the root is removed, and the same path is recreated until its exact
  `(dev, ino)` tuple is reused. Both source and compiled runs reported the
  removal as `rename/<null>` and, over a full five-second observation window,
  delivered no callback for recreation or for a ref written below the
  recreated root. This is report-only evidence of the dead-handle behavior that
  generation-dirty handling must repair; it is not one of the three PASS cases.
- **Compiled execution:** the probe uses literal host-native Parcel binding
  imports so `bun build --compile` embeds the binding. The generated binary is
  executed and must independently report the same 3/3 PASS result.

## What remains unproven

- The probe creates material concurrent callback traffic but does not force or
  recover from `IN_Q_OVERFLOW`, inotify descriptor exhaustion, descriptor-add
  failure, or a fatal Bun reader error.
- The populated move-in case synchronizes on the top-directory callback before
  mutating the deepest file. It does not claim delivery in the unavoidable
  zero-window before Bun has processed the move and installed descendant
  watches.
- The root-replacement observation demonstrates why equal `(dev, ino)` cannot
  preserve a handle. It does not implement or validate the product registry's
  generation-dirty detach/re-arm behavior.
- These measurements cover this Linux x64 host, filesystem, Bun version, and
  native Parcel build. They do not establish behavior on other kernels,
  filesystems, architectures, macOS, or future runtimes; the probe is the gate
  those environments must run.
- The probe covers the narrow runtime/watch premise only. It does not validate
  repository discovery, linked-worktree ownership, reftable behavior, safety
  scan policy, daemon lifecycle, or end-to-end sync correctness.

## v1 note

The 2026-07-20 v1 result used a nested directory created after subscription,
accepted any nonzero Parcel event count, and only bundled without executing the
output. Those weaker claims are superseded by v2 above.
