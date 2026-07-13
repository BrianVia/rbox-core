# Design 93 confirmation review — round 11

## Verdict: PASS

The round-10 blocker is closed. The v10 mutex disposition is complete for the
actual production caller set, the previously unassigned init/setup and export
paths now have the required owner/exemption, the purge decision boundary is
concrete and testable, §12 permits every closure-site change, and `SPEC.md`
step 4 carries the full v10 implementation contract.

No review-blocking omission remains.

## Production caller-set confirmation

I re-grepped executable TypeScript under `src/` and `apps/`, excluding tests and
verification scripts, then audited every production import of `src/cli/sync.ts`
and every use of the imported `pull`/`pushManifest` symbols. The complete set is:

| Production caller | Direct operation(s) | v10 disposition |
|---|---|---|
| `src/cli/daemon.ts:531,689` | `pushManifest`, `pull` | Named owner: each daemon pump iteration. The nested 409 pull at `sync.ts:461` inherits that handle. |
| `src/cli/main-dispatch.ts:237,259` | `push`→`pushManifest`, `pull` | Named owners: CLI `push` and CLI `pull`. |
| `src/cli/sync-cmd.ts:43,50` | `pull`, `sync`→`pull`+`pushManifest` | Named owner: CLI `sync` (including pull-only dispatch). |
| `src/cli/recover-cmd.ts:70,74` | injectable fallback `pull`, `push`→`pushManifest` | Named owner: `rbox recover`. The parenthesized `(deps.pull ?? pull)(...)` call is included even though a simple `pull(` grep misses it. |
| `src/cli/ignore-cmd.ts:93` | `pushManifest` | Named owner: the `ignore --purge` command; after confirmation it must recompute the final deletion set while holding the mutex. |
| `src/cli/init-cmd.ts:216,237,260` | first-sync `push`, `sync`, or `pull` | Named owner: init/setup first-sync across the whole decision→mutation→state-save interval. Both setup front doors delegate to `runInit`, so they share this owner. |
| `src/cli/export-cmd.ts:319` | `pull` | Explicit exemption: the target is a random per-export, per-workspace staging directory (`.rbox-export-staging-<pid>-<random>/.pull-<random>`), removed or atomically published after use; it cannot touch a live workspace tree/state. |
| `src/cli/sync.ts:371,461,699` | internal `pushManifest`, 409-recovery `pull`, combined-sync `pull` | Internal calls only. They execute beneath the initiating named owner and receive the single held handle; they must never acquire independently. |

No other production module imports `pull` or `pushManifest` from
`src/cli/sync.ts`, and no namespace/dynamic import or alias adds another
production call path. `scripts/dl-integrity-gate.ts` and test files are
verification harnesses, not production entry points, so they are outside the
production-owner inventory requested here.

The §6 current-disposition sentence therefore matches the live tree: daemon,
push/pull/sync, recover, ignore purge, init/setup first-sync, and reset/rebind
are named owners; export staging is the sole explicit production exemption.

## Round-10 closure audit

| Required closure | Round-11 result |
|---|---|
| Purge owner and decision boundary | **Closed.** §6 names `ignore-cmd.ts` as the command owner and requires post-confirmation final-set computation/recomputation under the mutex; stale preview commit is forbidden and pinned by test. |
| Init/setup first-sync | **Closed.** §6 names the owner across all three first-sync branches and the full decision/mutation/save interval. |
| Export staging pull | **Closed.** §6 explicitly exempts it with the private-target justification, which the production path substantiates. |
| Complete disposition | **Closed.** §6 states the complete current owner/exemption set and retains the static caller-enumeration drift gate. |
| Implementation scope | **Closed.** §12 adds `ignore-cmd.ts`, `init-cmd.ts` first-sync, and `export-cmd.ts` for its exemption comment/static mapping, alongside daemon/sync/entry glue. |
| Binding implementation spec | **Closed.** `SPEC.md` step 4 says v10 and includes the complete owner set, export exemption, caller-enumeration test, daemon requeue, stream+nonce revalidation, `expectedNonce` with the `legacy` sentinel rule, and locked reset nonce regeneration. |

## Contract re-verification

- Save-packet incarnation remains sound: a nonce-less load emits
  `expectedNonce: "legacy"`; it matches only nonce-less state; the first accepted
  save installs a real nonce; delayed legacy and pre-reset packets then reject.
- Acquisition remains once at the top level. The `pushManifest` 409 pull and
  `sync()`'s pull→push sequence run under the passed handle without reacquisition.
- Daemon contention cannot consume a wakeup: step 4 and §6 both require requeue
  with backoff, followed by binding revalidation under the mutex at iteration
  start.
- Reset/rebind changes both stream ownership and `stateNonce` under the sync
  mutex plus state lock, covering A→B→A and same-binding resets.
- The lock liveness implementation still matches §7: same-host/cross-boot is
  DEAD; uncertain same-host/same-boot probing is LIVE-defer.

## IMPLEMENTATION RISK

1. **The three state-save sites in `src/cli/sync.ts` are likely to retain
   whole-file thinking.** Pull-apply, no-op bookkeeping, and ACK currently load
   and save independently; a mechanical wrapper around `saveState` could omit
   observed-absence transitions, reconstruct `gitRepos` from stale global data,
   or partially accept a packet. This risks violating §6 lines 131–143 and
   190–208: `expectedStream`+`expectedNonce`, per-repo generations,
   bidirectional whole-packet source atomicity, in-operation recompute, and
   gitRepos reconstruction solely from merged records.

2. **Mutex ownership is spread across command glue and the daemon pump.** It is
   easy to acquire below a decision, reacquire in the 409 pull, clear a daemon
   want before a contended acquire, or let init release between reset and first
   sync. This risks violating §6 lines 145–188, especially purge's locked
   post-confirmation recomputation, init's whole first-sync interval, single
   acquisition/handle passing, daemon requeue, and per-iteration rebind check.

3. **Push-lane fast exits in `src/cli/sync-git.ts` can silently lose config or
   claim false authorship.** The slow carry, both whole-entry fast-set sites,
   transient/deferred paths, structural drops, pending rows, non-owned rows,
   and forced-422 recapture do not share one obvious exit. This risks violating
   §6 lines 248–292: authorship only when config was actually embedded,
   over-bounds carry-base with no authorship, cache-bound predicate parity, and
   verbatim carry on every non-publishing path.

4. **Pull integration can advance base/pending before config reaches its commit
   point.** The due predicate must precede both unchanged shortcuts, config must
   run last inside `applyGitState`, and cleanup after rename must be non-fatal or
   moved earlier. This risks violating §6 lines 294–315: no base advance or
   pending clear before completed config apply, old-base preservation on
   config-only failure, conflict checkpoint behavior, and the distinct ordinary
   rollback versus clean-materialization PENDING disposition.

5. **Capture can accidentally mix snapshots, ownership shapes, or partial
   over-bounds output.** Step 7 crosses `config-sync.ts`, `shared.ts`,
   `config-txn.ts`, discovery identity, and the wire embed point; reusing a live
   `git config` read or treating over-bounds as an empty/partial config would
   reintroduce credential and oscillation failures. This risks violating §4
   lines 56–86, §6 lines 266–292, §7 lines 382–388, and §9 lines 399–407:
   distinguishable `{overBounds}`, snapshot-only parsing, stability bracketing,
   carry-base on defer, receiver-shape ownership, and authorship only for a
   config actually embedded on the wire.

Step 8 should target these five seams directly, not merely the happy-path
two-root loop: the §11 interleavings, unchanged shortcuts, contention/requeue,
locked purge recomputation, clean-materialization failure, and static caller
inventory are the tests most likely to catch implementation drift.

## Non-blocking documentation cleanup

- §11 still groups `unknown-liveness` with “foreign classes.” Under §7 it is
  LIVE-defer, not FOREIGN. The intended never-remove assertion is still clear,
  but the label should be corrected.
- §4 still says the canonicalizer “currently filters silently,” while commit
  `cef1510` already implements and tests the distinguishable over-bounds
  outcome. This is stale status prose, not a contract defect.
- `SPEC.md`'s introduction still says “v4+” and “reviewed through 4+ rounds.”
  Step 4 correctly binds v10, so this does not create implementation ambiguity,
  but the header can be refreshed.

## Verification performed

- Re-enumerated all production `src/cli/sync.ts` importers and every direct or
  injectable-fallback `pull`/`pushManifest` call; mapped each to §6.
- Traced setup and keyed-setup into `runInit`, and verified export's staging
  roots are random, ephemeral, and separate from live workspace state.
- Re-read §6 mutex/save-packet/nonce rules, §7 liveness, §11 gates, §12 scope,
  and all of `SPEC.md` step 4.
- `bun test src/engine/git/lockfile.test.ts`: **10 pass, 0 fail**.
- `bun run typecheck`: **pass**.
