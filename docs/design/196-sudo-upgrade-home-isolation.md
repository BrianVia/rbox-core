# 196 — Sudo upgrade home isolation

Status: **ALIGNED**

## Scenario and problem

A user may intentionally install `rbox` in `/usr/local/bin` and run
`sudo rbox upgrade` because replacing that binary requires root. `sudo`
commonly preserves the invoking user's `HOME`. Root must not create or replace
files in that home: doing so leaves root-owned state that later non-root CLI
runs cannot safely update.

Today this route can write there in three independent ways:

1. `main()` refreshes the host-identity ledger before it knows that the command
   is `upgrade`;
2. the upgrade anti-rollback record and cross-process lock are rooted at
   `~/.rbox`; and
3. equal-version and successful upgrades inspect and restart user daemons,
   whose desired/runtime state is rooted at `~/.rbox`.

The configuration location does not change. Ordinary non-root commands still
use `$RBOX_HOME`/`$HOME/.rbox` exactly as before.

## Invariants

- An elevated `rbox upgrade`, including `--check`, never reads, creates,
  replaces, chmods, or removes a path derived from `HOME`, `RBOX_HOME`, or
  `XDG_CONFIG_HOME`.
- Elevation is determined from the effective uid (`geteuid() === 0`), not from
  spoofable or optional `SUDO_*` environment variables.
- Elevated upgrade remains supported. It may fetch release metadata and may
  mutate only the installed executable and upgrade metadata beside that
  executable.
- The anti-rollback floor and concurrent-upgrade serialization are canonical
  per real executable. Elevated and non-elevated processes targeting the same
  executable cannot rename in reverse version order.
- A verified target becomes a durable rollback floor before executable
  replacement. A crash or durability error after replacement cannot let an
  already-running old process install an intermediate version.
- Elevated upgrade never stops, starts, or otherwise manages user daemons.
  After a successful replacement it tells the user to run `rbox upgrade`
  once without sudo; the equal-version non-root path then performs the existing
  stale-daemon replacement pass without needing write access to the install
  directory.
- Non-elevated configuration, ordinary output, and daemon behavior remain
  compatible. Upgrade lock/state paths intentionally become executable-scoped;
  the legacy home floor is a transition input only.
- This change adds no sync-engine module and changes no ownership boundary, so
  `docs/CODEMAP.md` is unchanged.

## Design

### Dispatch boundary

Parse the top-level command before the best-effort system-lock identity refresh.
Skip that refresh only when the canonical raw command is `upgrade` and the
effective uid is root. `upgrade` is not a deprecated alias, so alias resolution
does not create a bypass. Version/help and all non-upgrade commands retain their
existing behavior.

Inject the identity refresh and elevation predicate through `MainDispatchDeps`
for a focused regression test. Inject the lazy upgrade import as well so the
test can prove routing without loading or mutating the real updater.

### Canonical command context

Resolve the real executable before selecting upgrade state paths.
Build one immutable context containing the elevation decision, real executable,
install directory, `<real-executable>.release.json`, and
`<real-executable>.upgrade.lock`. Pass this context or its explicit paths to
every state, lock, and daemon decision; do not recompute elevation.

The install-scoped paths are canonical for **all** mutating upgrades, regardless
of privilege. This is required because the serialization domain is the
executable being replaced, not the caller.

For compatibility, a non-elevated process may read the legacy
`~/.rbox/release.json` only when the install-scoped record is absent and uses
the greater of a readable, valid version and its embedded version as the initial
floor. This compatibility hint retains the old best-effort semantics: missing,
unreadable (including a root-owned `0600` file left by the previous sudo
updater), or malformed legacy state is ignored. Only canonical install-scoped
state fails closed.
It never uses the legacy lock. An elevated process never evaluates the legacy
path. Therefore elevated runs on an existing installation with no
install-scoped record can preserve only the embedded binary version, not a
higher legacy historical floor. That is the unavoidable transition tradeoff:
preserving the higher home record would violate the primary no-home-access
requirement. The reduced guarantee lasts until a mutating upgrade durably
publishes a canonical pending or committed record; checks and equal-version
runs do not claim to migrate it.

The downloaded binary temp file already lives beside the executable and remains
unchanged.

### Durable release transaction

The install-scoped record has an exact, versioned schema:

```json
{ "schema": 1, "version": "1.2.3", "phase": "pending" }
```

`phase` is `pending` or `committed`. `ENOENT` means no canonical record.
Any other read error, symlink/non-regular file, oversized body, unknown key,
invalid phase, invalid semver, or trailing/extra schema fails closed.

After the artifact is downloaded and its signed hash matches, but before the
executable rename, atomically publish and directory-fsync a `pending` record
for the target version. Only then replace and fsync the executable; afterward,
atomically publish and fsync the `committed` record.

Both phases establish the same rollback floor. A manifest strictly newer than
that floor is admitted. The exact version of a `pending` record is also admitted
as a replacement retry **only when the running process's embedded version is
lower**: the prior process may have failed before executable replacement. No
lower version is admitted. If the embedded version already equals the pending
version, the binary replacement succeeded; leaving the harmless pending phase
in place does not weaken the floor. A non-check call performs the normal
privilege-appropriate equal-version behavior without requiring install write
access, and a future mutating upgrade overwrites it. `--check` remains read-only.

### Executable-scoped lock

Use the repository's existing fenced `acquireLock()` protocol with
`skipIdentityRefresh: true`. Its hardlink publication, exact inode/marker
observations, process-incarnation marker (`hostId`, `bootId`, `pid`,
`startTime`, random token), reap fence, exact-observation unlink, and
exact-observation release already close stale-observation/successor races.
Skipping the identity-ledger refresh retains OS host/boot/process probing but
does not read or write home state.

Extend that primitive with an exact `markerMode` option, defaulting to its
current private `0600`. Upgrade uses exact `0644` because lock metadata contains
no secret and must remain inspectable across root/non-root invocations even
under umask `077`. Release state likewise uses exact `0644`. Mutation authority
still comes from write permission on the executable directory; readability
does not grant lock or binary replacement authority. The canonical lock is
shared by all callers targeting the executable. `markerMode` is applied by
`fchmod` before the temp marker is fsynced and hardlinked, and propagates to
both the primary marker and every reap-fence marker.

If acquisition reports held/unsupported/error, upgrade fails without mutation.
Release failure is an upgrade error rather than silently claiming clean
serialization.

### Daemon boundary

Compute elevation once at command entry. Admission is evaluated before generic
equal-version handling:

- `--check` retains its existing output and never restarts daemons;
- exact pending with embedded version below the pending version reports the
  pending target as an available/retryable update; non-check proceeds to the
  locked replacement retry;
- manifest/floor at or below the embedded version is a true equal/older result:
  elevated non-check prints `already up to date (...)`, while non-elevated
  non-check retains the stale-daemon pass;
- a floor newer than the embedded version means another process (or a prior
  replacement) advanced the installed target. This old process never runs
  daemon filtering against its stale `RBOX_VERSION`; it reports that the update
  completed elsewhere and asks for one fresh non-sudo `rbox upgrade`.

The same rules apply after lock acquisition and floor re-read. After a
successful elevated replacement, print the
normal version result, skip the full daemon pass, and print a concise instruction to run
`rbox upgrade` without sudo to restart stale user daemons. A non-elevated
successful replacement retains the unconditional daemon pass.

Normative admission table: `E` is the embedded version; `P` is the canonical
record version, or for a non-elevated caller with no canonical record, the
applicable valid legacy version; `F = max(E, P)` when `P` exists and otherwise
`F = E`; `M` is the manifest version. Evaluate rows top-to-bottom (so the exact
pending repair exception precedes the generic newer-manifest row):

| State | `--check` | non-check |
| --- | --- | --- |
| pending `F=M` and `E<F` | report repairable update `M`; no mutation | acquire lock, re-read, retry replacement |
| `M>F` | existing “update available” output | acquire lock, re-read, replace |
| `M<=F` and `F>E` and not the pending retry above | report that verified floor `F` is newer than this running process | same report; no daemon pass |
| otherwise (`M<=F<=E`) | existing “already up to date (`E`)" output | root: same output/no daemon; non-root: existing stale-daemon pass |

After acquiring the lock, a row-1/row-2 loser re-evaluates against the fresh
record. If it lands in row 3, it reports the newer verified floor and exits
without daemon work; a fresh invocation from the installed binary owns that
work. This avoids using a stale process's embedded version as the daemon target.

No elevated branch calls a daemon helper or evaluates a home-derived daemon
path.

## Tests

Extend `src/cli/upgrade-cmd.test.ts`:

Use disjoint install, `HOME`, `RBOX_HOME`, and `XDG_CONFIG_HOME` roots.

1. elevated `--check` performs no filesystem operation beneath any poison home
   root and creates no state;
2. elevated equal-version non-check does not call daemon dependencies or touch
   a poison root;
3. elevated successful replacement writes a committed install-scoped record,
   removes its install-scoped lock, performs no poison-root operation, and does
   not call daemon dependencies;
4. a pre-existing newer install-scoped floor prevents rollback;
5. malformed, oversized, symlinked, and unreadable canonical records fail
   closed;
6. injected failure after pending publication and after executable rename
   leaves a floor that blocks an intermediate-version old process while
   permitting exact-target repair;
7. elevated and non-elevated contenders share the same lock, and a controlled
   V3/V2 interleaving finishes at V3;
8. reuse the lockfile primitive's successor/reap tests and add upgrade coverage
   proving `skipIdentityRefresh` and exact cross-privilege `0644` markers under
   umask `077`;
9. existing non-elevated tests continue proving legacy-floor compatibility and
   daemon replacement.

Add focused dispatch coverage proving an elevated `upgrade` skips the identity
refresh while a non-elevated `upgrade` and an unrelated elevated command retain
it.

## Validation

```text
bun run typecheck
bun test src/cli/upgrade-cmd.test.ts src/cli/upgrade-daemons.test.ts \
  src/cli/upgrade.test.ts <new dispatch test>
bun run guards
```

Use a syscall trace or focused filesystem instrumentation around a compiled
entrypoint smoke when practical; the unit fixture's disjoint poison roots and
dependency assertions are necessary but not claimed as process-wide proof.
Inspect the final import/dispatch/diff graph for any remaining home-derived call
reachable from elevated upgrade branches, including entrypoint cleanup.
