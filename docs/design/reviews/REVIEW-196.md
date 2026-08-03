# Review 196 — Sudo upgrade home isolation

Reviewed against `src/cli/main-dispatch.ts` and
`src/cli/upgrade-cmd.ts` on 2026-07-24.

## Verdict

**NOT ALIGNED.** The home-isolation direction is sound, but the proposed split
between home-scoped non-root state and install-scoped root state breaks the
updater's cross-process ordering guarantee. The design also inherits two
anti-rollback failure modes that need to be made explicit and tested before
implementation.

## Findings

1. **BLOCKER — Root and non-root upgraders targeting the same executable use
   different locks and can rename in reverse version order.**

   The design keeps non-elevated `~/.rbox/upgrade.lock` while moving only the
   elevated lock to `<real-executable>.upgrade.lock`. Consider two processes
   started from binary version V1: an elevated process verifies V3 while a
   non-elevated process with write access to the install directory verifies V2.
   They acquire different locks, both pass their independent floors, V3 renames
   first, then V2 renames over it. The final installed binary is V2. This
   violates the existing comment in `upgrade-cmd.ts` that the lock prevents
   reverse-order renames and is not excluded by the stated invariant, which
   only mentions sharing among elevated processes.

   **Concrete fix:** define serialization by canonical executable target, not
   caller privilege. Every mutating upgrade targeting the same real executable
   must acquire the same install-scoped lock before its second floor check.
   Keep home state only as a compatibility input if necessary; it cannot remain
   the sole non-root mutation lock. Add an interleaving test with one elevated
   and one non-elevated command, different signed versions, and controlled
   barriers proving the highest version wins.

2. **BLOCKER — Recording the floor only after executable replacement leaves a
   crash/error window in which an already-running old process can roll back the
   new binary.**

   `upgrade-cmd.ts` intentionally holds the lock across rename and
   `recordVerifiedRelease`, but a crash, ENOSPC, fsync error, or permission
   failure after `renameSync(tmp, exe)` and before the sidecar is durable leaves
   the new executable installed with the old floor. A second process that
   started before replacement still has the old embedded `RBOX_VERSION`; after
   lock recovery it can accept and install a lower signed version. Moving the
   record beside the executable does not close this window. The design's claim
   that post-replacement recording preserves safe crash semantics is therefore
   too strong.

   **Concrete fix:** specify a durable install-scoped transaction state before
   rename. A verified target version must become a rollback floor before the
   executable changes, while an exact retry of that pending target remains
   allowed if replacement did not complete. After rename and directory fsync,
   transition the record to committed. Tests must inject failure/crash at each
   boundary and then run a still-old updater attempting an intermediate/lower
   version.

3. **HIGH — The current stale-lock recovery is not a safe serialization
   primitive under contention, and unconditional cleanup can remove another
   owner's lock.**

   `acquireUpgradeLock()` uses a PID-only `wx` file. On `EEXIST`, contenders
   independently read, unlink, and recreate a dead holder's path. A contender
   that observed the stale file can unlink a newly-created successor lock,
   allowing two owners into the critical section. The returned cleanup
   unconditionally `rm`s the path, so an old owner can also remove a successor's
   lock. Reusing this helper with a new path does not establish the design's
   promised concurrent-upgrade serialization.

   **Concrete fix:** replace the PID-only protocol with an ownership-token and
   fencing protocol whose reclaim and release operations verify the exact lock
   generation, or reuse a repository lock primitive that already provides
   those properties without refreshing home-scoped identity state. At minimum,
   never unlink on release unless the on-disk owner token is still this
   process's token. Add three-process stale-reclaim contention and
   old-owner/next-owner cleanup tests.

4. **HIGH — A malformed or unreadable install-scoped floor silently disables
   historical anti-rollback protection.**

   `highestVerified()` catches every error and returns `RBOX_VERSION`. Under the
   proposed design, a truncated, malformed, non-regular, or unexpectedly
   unreadable `<real-executable>.release.json` would therefore be treated as if
   no floor existed. This is especially dangerous after an out-of-band binary
   downgrade: the sidecar is the only surviving higher floor. A security state
   file must not fail open on corruption.

   **Concrete fix:** only `ENOENT` should mean “no prior record.” Open the
   sidecar without following symlinks, require a bounded regular file, validate
   its exact schema and semver, and fail closed on every other error. Add
   malformed, oversized, symlink, and permission-error tests.

5. **HIGH — The transition discards the existing home-scoped historical floor
   on the first elevated upgrade.**

   A user may have `~/.rbox/release.json = V5`, then reinstall or restore a V3
   executable. Today an upgrade process consults V5 and rejects V4. Under this
   design the first elevated run cannot read the home record and has no
   install-scoped record, so it accepts V4. This is a real compatibility
   regression in the anti-rollback guarantee, even though it is necessary that
   root not inspect the user's home.

   **Concrete fix:** define an explicit transition. Prefer making install-scoped
   floor state the canonical state for all mutating upgrades, seeded by the
   installer and mirrored/migrated by a non-root release before users rely on
   the elevated path. If a zero-touch migration cannot preserve the old floor
   without violating home isolation, state the reduced first-run guarantee
   precisely (never below the embedded version) and obtain explicit acceptance
   rather than claiming the floor is unchanged.

6. **MEDIUM — The proposed tests prove absence of created files, not the
   stronger “never reads/chmods/removes a home-derived path” invariant.**

   “Home entirely absent” can pass even if elevated code probes home paths and
   receives `ENOENT`. It also does not cover `src/cli/index.ts` before/after
   `main()` (prompt policy and the `shutdownCryptoPool` finally import), or
   module-import side effects. In addition, the current
   `upgrade-cmd.test.ts` puts both `process.execPath` and `RBOX_HOME` beneath the
   same temporary directory; that fixture cannot distinguish a permitted
   install-side write from a forbidden home-derived write.

   **Concrete fix:** use four disjoint roots in tests: install, `HOME`,
   `RBOX_HOME`, and `XDG_CONFIG_HOME`. Instrument sync and async filesystem
   operations (or use a syscall-trace integration test on a supported platform)
   and reject any read or mutation beneath the three poison roots. Exercise the
   real CLI entrypoint for elevated `upgrade --check`, equal-version, successful
   replacement, post-lock equal-version, invalid flags, and failure paths.
   Keep the focused dependency-injected dispatch test as a fast unit test, but
   do not treat it as proof of the process-wide invariant.

7. **MEDIUM — Elevation and path selection need one explicit command context,
   not independently recomputed predicates.**

   The design says dispatch computes/injects elevation and that `upgradeCmd`
   computes it again at entry, but does not define how the selected real
   executable and state paths flow through helpers. Independent decisions make
   branch coverage easy to miss, especially at the second floor gate and in
   direct `upgradeCmd` tests.

   **Concrete fix:** have `upgradeCmd` create one immutable context after
   standalone/URL validation, containing `elevated`, canonical executable,
   install directory, floor path, and lock path. Pass that context or explicit
   paths to every floor/lock/daemon decision. Inject `effectiveUid` (or
   `isElevated`) and executable resolution through `UpgradeCommandDeps`. Add a
   table test covering both privilege modes at the initial equal gate,
   `--check`, the under-lock equal gate, success, and each error boundary.

## Required design revision

Before implementation, the design should:

1. make the mutation lock canonical per real executable across privilege modes;
2. specify a crash-recoverable floor/replace transaction;
3. replace or harden stale-lock ownership and reclaim;
4. fail closed on an existing invalid floor;
5. document and test the legacy-floor migration story; and
6. strengthen validation from “no files created” to “no filesystem operation
   beneath any home-derived root.”

## Round 2

### Verdict

**NOT ALIGNED.** The revision closes the privilege-split serialization domain,
adds the right pending/committed transaction shape, fails closed on canonical
record corruption, explicitly accepts the legacy-floor transition, and
substantially strengthens the home-isolation validation. Two blockers and
several state-machine contradictions remain.

### Findings

1. **BLOCKER — Rename-to-tombstone is not a compare-and-swap and can still
   steal a live successor lock.**

   The revised protocol says a contender reads owner A as dead/invalid and then
   renames the canonical lock directory to its unique tombstone. Between those
   operations, contender B can tombstone A and publish its own live canonical
   directory. The first contender's rename then moves B, not the A it observed;
   a third contender can publish while B is still in its critical section.
   Token-checking before release has the same race: after the check, a reclaimer
   can move the old directory and publish a successor before the old owner's
   rename, causing the old owner to tombstone its successor. Unique tombstone
   names prevent deletion collisions but do not bind rename to the observed
   directory generation. Lines 128–130 therefore claim a property POSIX
   pathname rename does not provide.

   **Concrete fix:** use a lock protocol with an actual acquisition/reap fence
   and exact-generation ownership, such as the repository's existing
   `acquireLock` protocol with `skipIdentityRefresh` plus an explicitly
   home-free identity source, if its guarantees are accepted for this use.
   Otherwise use a platform advisory lock held by an open descriptor. Do not
   specify stale reclaim as `read owner; rename canonical` without an atomic
   conditional operation. The test needs a hook specifically between stale
   observation and reclaim, with a successor published in that gap.

2. **BLOCKER — The required non-sudo daemon pass cannot read canonical metadata
   unless cross-privilege modes are part of the design.**

   Canonical-record corruption now correctly fails closed. But the current
   writer uses mode `0600`, and a root-created record will then return `EACCES`
   when the user follows the required instruction to run `rbox upgrade`
   without sudo. That command fails before reaching the equal-version stale
   daemon pass. A restrictive root umask can create the same problem for the
   lock owner record/directory, causing a legitimate non-root contender to
   classify a live root owner as unreadable/invalid and attempt reclaim.

   **Concrete fix:** specify exact cross-privilege modes. The release record
   contains no secret and should be a root-owned, non-root-readable regular file
   (for example exact `0644`) published through a readable install directory.
   Lock metadata must likewise be readable by every legitimate upgrader (for
   example directory `0755`, exact owner file `0644`) regardless of root's
   umask. Only directory write permission should control mutation. Add a test
   that writes state/lock as effective root under umask `077`, then reads the
   committed state and executes the equal-version daemon path as the invoking
   user.

3. **HIGH — Pending is an exception to the equal-version gates, but the design
   simultaneously says both gates return as “already up to date.”**

   Lines 106–113 admit an exact pending target as a repair and require a
   non-check invocation with embedded version equal to pending to commit the
   record under the lock. Lines 135–139 say that at both equal-version gates an
   elevated non-check prints and returns, while `--check` retains its existing
   output. Those rules conflict. They also leave these cases undefined:

   - embedded V1, pending V3, manifest V3 (`--check` and non-check);
   - embedded V3, pending V3, manifest V3 (metadata-only repair);
   - embedded V1, pending V3, manifest V4;
   - inability of a non-root V3 process to commit a root-owned pending record
     in `/usr/local/bin`.

   **Concrete fix:** replace the prose “equal-version gates” with a normative
   state table keyed by record phase, embedded version vs floor, manifest vs
   floor, check mode, and elevation. Evaluate pending-repair eligibility before
   the generic `manifest <= floor` return. `--check` should report pending
   repair accurately rather than claim the running V1 is up to date at V1. If
   embedded equals pending but the non-root caller cannot mutate install state,
   it should still be able to perform the stale-daemon pass and print a precise
   instruction to repair metadata with sudo, rather than failing before daemon
   handling.

4. **HIGH — A post-lock loser can run daemon logic using the old process's
   embedded version, not the newly installed version.**

   In the controlled V3/V2 race, the V2 contender may have started from
   embedded V1. After acquiring the lock it observes the winner's V3 floor and
   enters the second “equal” branch. The current stale-only daemon helper
   compares daemon versions to that process's `RBOX_VERSION` (V1), so it can
   leave V1 daemons running even though V3 is installed. Its
   `already up to date (${RBOX_VERSION})` output is also false about the
   executable on disk.

   **Concrete fix:** distinguish initial equality from “another process
   advanced the canonical floor while I waited.” The latter old process must
   not use its embedded version as the installed-version oracle or run the
   stale filter. Safest is to print that another process completed the upgrade
   and require one fresh non-sudo `rbox upgrade` invocation; elevated callers
   must still avoid daemon helpers. Extend the V3/V2 interleaving test to assert
   output and daemon behavior, not only final binary bytes.

5. **MEDIUM — “Non-elevated behavior and paths remain unchanged” now
   contradicts canonical install-scoped state and locking.**

   Lines 46 and 72–80 cannot both be true: mutating non-root upgrades no longer
   use the home lock, create/read install-side metadata, and can now fail on an
   invalid or unwritable canonical record. This is a justified compatibility
   change, but the invariant should describe what actually remains compatible:
   configuration location, normal output/daemon behavior, and legacy floor as
   a transition input.

   The transition text also says “all subsequent runs use the canonical
   record,” but elevated `--check`, equal-version, and failed pre-pending runs
   create none. The reduced historical guarantee lasts until the first durable
   pending/committed canonical publication, not merely the first elevated run.

   **Concrete fix:** rewrite the invariant and transition sentence with those
   precise boundaries. Add a test proving repeated elevated checks/equal runs
   do not accidentally consult home and do not claim canonical migration has
   occurred.

6. **MEDIUM — Lock owner liveness is underspecified and PID plus random token
   does not identify a process incarnation.**

   A dead lock whose PID has been reused by an unrelated process is “live” if
   liveness means only `kill(pid, 0)`. The random token proves record ownership
   only to the releasing process; it cannot be checked against the OS process.
   This can wedge upgrades for the lifetime of an unrelated reused PID.

   **Concrete fix:** include and validate boot identity plus process start time
   in the owner record, using a home-free system identity/probe path. Specify
   exact owner schema, size bound, no-follow reads, and the behavior for
   unsupported probes. Add PID-reuse and cross-uid `EPERM` tests.

### Round 2 closure status

- **Closed:** privilege-independent canonical mutation domain.
- **Closed in design shape:** pre-rename pending floor and post-rename committed
  transition.
- **Closed:** canonical floor fail-closed parsing.
- **Closed with an explicitly documented limitation:** legacy home-floor
  transition.
- **Closed:** immutable command context and stronger poison-root/import-graph
  validation.
- **Still open:** race-safe lock implementation, cross-privilege metadata
  readability, complete pending state semantics, and post-lock daemon behavior.

## Round 3

### Verdict

**ALIGNED AFTER TWO CONCISE CLARIFICATIONS.** Reusing the fenced lock primitive,
exact cross-privilege modes, the pending retry rule, fresh-process daemon
handoff, and corrected transition language close the Round 2 blockers. The
design is implementable, but two details should be made normative before
dispatch.

### Residual findings

1. **HIGH — Define `F` explicitly and remove the row-2/row-3 overlap.**

   The table calls `F` the “effective floor” but never states in one normative
   formula that `F = max(E, canonical-record version, applicable legacy
   version)`. That formula is essential: if an implementation treated `F` as
   only the persisted record, `E=3`, committed record `2`, and manifest `2.5`
   would match `M>F` and downgrade the executable.

   Rows 2 and 3 also overlap when `M>F>E`. The prose says any `F>E` process
   reports and exits, while the table places `M>F` first and could admit the
   newer manifest. Either policy is rollback-safe, but it changes whether an
   old process mutates and runs post-success daemon handling.

   **Concrete fix:** define `F := max(E, persisted/legacy floor)` and state that
   the table uses first-match order, or make the rows disjoint. For example:
   pending exact retry first; `M>F` second; `F>E && M<=F` third; otherwise
   equal/older. Qualify the prose's “floor newer” branch the same way.

2. **MEDIUM — `markerMode` must cover reap-fence markers, not only the
   canonical lock marker.**

   `acquireLock()` currently threads creation through both the canonical marker
   and `${lockPath}.reap` in `acquireFence()`. If `markerMode: 0o644` is applied
   only to the first `atomicCreateMarker()` call, a root process under umask
   `077` can leave an unreadable reap fence after a crash and permanently block
   the non-root follow-up.

   **Concrete fix:** specify that `AcquireLockOptions.markerMode` is passed to
   every marker created for that acquisition, including reap fences, and that
   the temp inode is set to the exact mode before fsync and hardlink
   publication. Extend the umask test to inspect both canonical and reap-fence
   markers. Update the existing `skipIdentityRefresh` comment, which currently
   says it is used solely by the host-ledger lock.

### Round 3 closure status

- **Closed:** race-safe cross-privilege serialization via the existing fenced
  lock.
- **Closed:** root/non-root readability with exact `0644` state and markers.
- **Closed:** pending retry versus equal-version behavior.
- **Closed:** stale post-lock process daemon semantics.
- **Closed:** compatibility and legacy-transition wording.
- **Pending clarification only:** effective-floor formula/table precedence and
  propagation of marker mode to reap fences.

## Implementation Review

### Verdict

**NOT READY.** The core canonical-floor transaction, shared fenced lock,
marker-mode propagation, elevated dispatch boundary, and daemon suppression are
implemented cleanly. One transition bug breaks the exact sudo-upgrade scenario,
and several required integration tests are absent.

### Findings

1. **BLOCKER — A legacy root-owned release record prevents the required
   non-sudo follow-up from reaching daemon repair.**

   The release that first introduces this fix is itself installed by the old
   updater. Under `sudo`, that old updater writes
   `~/.rbox/release.json` as root with mode `0600`. On the next non-elevated
   `rbox upgrade`, `effectiveFloor()` sees no canonical sidecar and
   `readLegacyFloor()` calls strict `readJsonNoFollow()`. The resulting
   `EACCES` becomes `legacy upgrade release state is unreadable`, so the command
   exits before `restartStaleDaemonsIfAny()`. Repeated elevated equal-version
   runs do not publish canonical state, so they do not heal this transition.

   This is not hypothetical corruption; it is the on-disk state produced by the
   user scenario before the fixed binary can execute its new code.

   **Concrete fix:** keep canonical state fail-closed, but preserve the old
   updater's best-effort semantics for an unreadable/malformed legacy-only
   record. When the manifest is at or below the embedded version, a non-root
   caller must still reach the stale-daemon pass. For a prospective mutation,
   use the embedded version as the minimum floor and warn that the inaccessible
   legacy historical floor could not be imported, or require an explicit
   migration policy. Add a regression fixture containing a root-owned-equivalent
   unreadable `0600` legacy record, no canonical record, and an equal manifest;
   assert the non-root daemon pass still runs.

2. **HIGH — The required mixed-privilege concurrency test is not implemented.**

   The “post-lock loser” test mutates the legacy floor through a manifest getter
   in one process. It does not create two contenders, does not exercise an
   elevated and non-elevated caller against the same canonical lock, and does
   not prove the controlled V3/V2 interleaving finishes at V3. The generic
   lockfile tests prove the primitive, but not upgrade's path selection,
   under-lock floor re-read, or loser daemon behavior as one integrated flow.

   **Concrete fix:** add the design's two-process/barrier test with distinct
   privilege predicates and signed V3/V2 fixtures. Assert one canonical lock
   path, final V3 bytes and committed floor, no reverse rename, and no daemon
   filtering from the stale losing process.

3. **MEDIUM — Home-isolation tests prove “no path was created,” not “no
   filesystem operation occurred.”**

   The elevated tests only check that poison roots remain absent. A probe/read
   receiving `ENOENT` would pass, despite the invariant prohibiting reads.
   The dispatch test replaces the updater import, so it also does not exercise
   the real entrypoint/import/cleanup graph.

   **Concrete fix:** add focused filesystem-operation instrumentation around
   elevated check, equal, success, and failure branches, or the compiled
   syscall-trace smoke required by the design. Fail on any operation whose path
   is beneath `HOME`, `RBOX_HOME`, or `XDG_CONFIG_HOME`, not only on resulting
   files.

4. **MEDIUM — Release failure in `finally` masks the causal upgrade error.**

   `releaseLock.release()` is awaited in `finally`, and its failure throws a new
   error unconditionally. If download, pending publication, rename, committed
   publication, or daemon restart already failed, the lock-release error
   replaces that primary exception. This makes the most important repair state
   much harder to diagnose.

   **Concrete fix:** retain the primary exception and attach/aggregate the
   release failure. Throw the standalone release error only when the protected
   body otherwise succeeded.

5. **LOW — Required negative canonical-state coverage is incomplete.**

   The canonical-state test covers malformed JSON, symlink, and oversize, but
   not unreadable files, non-regular files, unknown keys/phases/schema, invalid
   semver, or a read-time replacement. The exact `0644` test observes only the
   canonical marker; reap-fence propagation is covered in the lockfile suite,
   which is sufficient for the shared primitive.

   **Concrete fix:** table-drive the canonical parser/read failures listed in
   the design, especially unreadable and unknown-schema cases.

### Validation observed

- Focused upgrade/daemon/signature/dispatch suites: **36 passed, 0 failed**.
- Lockfile suite: the new marker-mode/reap-fence test passed, along with 41
  other tests. Two unrelated existing macOS tests failed because `/var` resolves
  through a symlink to `/private/var`; the same two failures reproduce when the
  lockfile suite is run alone.

## Final Implementation Re-review

### Verdict

**ALIGNED — READY.** The implementation blocker is closed.

- Legacy-only unreadable, malformed, or invalid state now retains the old
  best-effort behavior and falls back to the embedded version, so a root-owned
  legacy `0600` record cannot block the first non-sudo stale-daemon repair.
- Canonical executable-scoped state still fails closed.
- The regression test exercises an unreadable legacy record with no canonical
  state and proves the daemon restart path is reached.
- Elevated and non-elevated contenders are verified to use the same canonical
  lock.
- Canonical unreadability is covered separately and remains fatal.
- A primary upgrade exception is preserved when lock release also fails; the
  release problem is attached as its cause when possible.

Focused re-review validation: **16 passed, 0 failed** across
`upgrade-cmd.test.ts` and `main-dispatch-upgrade.test.ts`. `git diff --check`
passes for the reviewed files.
