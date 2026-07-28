# Thermo-nuclear sweep #3 — 2026-07-28 (post-163-B0/212/1.11.0)

> Reviewer: codex gpt-5.6-sol, read-only, exclusion-listed against sweeps #1/#2
> and the agent-ergonomics roadmap. Orchestrator verification note: Tier 0 #4
> (AST gates red on Bun canary) did NOT reproduce on stable Bun 1.4.0 (11/11
> green locally) and main CI is green on canary — downgraded from defect to
> gate-hardening; the bounded-output/nonempty-assert plan still stands. Tier 0
> #1–#3 fixes dispatched 2026-07-28 (worktrees fix-scope-daemon,
> fix-republish-lock, fix-reserve-atomic). Tier 1 #1 (state-plane move) gates
> U1 slice 2.

## Sweep #3 verdict

Do not start U1 slice 2 yet. Four new Tier 0 defects exist, and two state-plane ownership seams must be established first. The core architectural verdict is:

- `src/cli/scope/` is the correct home for binding policy.
- SQLite/runtime persistence belongs in `src/cli/state-plane/`.
- `src/engine/` should own only SQLite-free ports and DTOs.
- The B0 files are separate protocols that need one folder, not one giant module.
- PR #549’s proposed `src/engine/sqlite-contract/` home is wrong even though its contents are test-only.

### Tier 0 — fix now

1. Scope edits can durably stop a previously running daemon.

Evidence: `ScopeIntent` records no restart obligation ([scope-transaction.ts:24](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/scope/scope-transaction.ts:24)). The transaction samples daemon liveness into ephemeral `wasRunning`, stops it, clears the intent, then attempts restart ([scope-transaction.ts:92](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/scope/scope-transaction.ts:92)). The stop adapter durably changes desired state to `"stopped"` ([autostart-cmd.ts:471](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/autostart-cmd.ts:471)). On recovery, the pid is gone, so `wasRunning` becomes false and restart is lost. A failure after intent clearing but before successful restart has no recovery cursor at all.

The crash test hides this by fixing `daemonRunning: () => true` ([scope-transaction.test.ts:56](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/scope/scope-transaction.test.ts:56)).

Executable plan:

- Add a daemon maintenance state carrying `{id, resumeState, priorGeneration}`.
- Persist the same ID and phase in `ScopeIntent`.
- Add exact-token `parkDaemonForMaintenance` and `resumeDaemonAfterMaintenance`.
- Retain the intent until matching restart succeeds.
- An explicit user stop must cancel the maintenance token.
- Fault-inject after intent, park, scope commit, witness, restart, and during a user-stop race.

Blast radius: include transactions, `track --include`, and daemon desired-state lifecycle only.

2. `git-republish.json` has unlocked, lossy read-modify-write operations.

Recording reads and rewrites the entire sidecar ([republish-requests.ts:146](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/sync-git/republish-requests.ts:146)); settlement reads, re-reads, then rewrites or removes it ([republish-requests.ts:192](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/sync-git/republish-requests.ts:192)). The CLI command runs outside the workspace mutex ([main-dispatch.ts:631](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/main-dispatch.ts:631)), concurrently with push settlement ([push.ts:455](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/sync/push.ts:455)).

Two recorders can both report success while the later rename drops one request. Worse, settlement maps a different-stream store to `absent` ([republish-requests.ts:91](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/sync-git/republish-requests.ts:91)), then may unlink that live new-stream store.

Executable plan:

- Require the existing `WorkspaceSyncMutex` token for record and settle mutations.
- Wrap `rbox git republish` in that mutex; push already owns it.
- Assert the token inside the mutation seam.
- Under the mutex, revalidate stream and exact request identity before write/unlink.
- Add controlled record/record, record/settle, and old-stream-settle/new-stream-record interleavings.

Blast radius: the local republish sidecar. Failure loses operator repair intent or causes unnecessary full bundles; it does not corrupt remote BASE.

3. Failed reserve creation can permanently poison its own final path.

`ensureStateReserve` exclusively opens the final name, then writes the header and fill in place ([state-reserve.ts:175](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-reserve.ts:175)). A write, sync, or process failure leaves the partial inode behind; the catch returns without removing it. The next attempt classifies it as foreign `wrong-size` ([state-reserve.ts:129](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-reserve.ts:129)) and will never repair it.

Executable plan:

- Write and fsync a unique sibling temp.
- Publish with the existing atomic `moveNoClobber` primitive.
- Remove the temp after publication or collision; classify the winner on collision.
- Fault-inject after header, fill, fsync, and final-name claim.
- Preserve the current rule that externally pre-existing wrong-size files remain untouched.

Blast radius: the B0 migration reserve only.

4. Both load-bearing AST structural gates are red on CI’s Bun canary.

The shared AST sweep emits 7,768,795 bytes. Both consumers capture it through default `Bun.spawnSync` ([base-composer-structure.test.ts:27](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/sync-git/base-composer-structure.test.ts:27), [state-barrier-inventory.test.ts:89](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-barrier-inventory.test.ts:89)). On Bun `1.4.0-canary.1`, the child reports success but returns empty stdout; JSON parsing fails. CI explicitly uses floating canary ([ci.yml:117](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/.github/workflows/ci.yml:117)).

First-hand result: barrier inventory failed 3/4 tests; the targeted base-composer gate failed the same way.

Executable plan:

- Add query modes to the AST sweep so each test requests only relevant categories, files, callees, and argument fragments.
- Do not emit full argument source for unrelated calls.
- Assert nonempty output and a bounded output-size budget.

Blast radius: test tooling, but currently two correctness gates are ineffective.

### Tier 1 — structural blockers before U1 slice 2

1. Establish the state-plane vertical before adding production SQLite code.

The ratified design already specifies `src/cli/state-plane/**`, one SQLite-free `src/engine/state-port.ts`, and explicitly forbids engine imports of `bun:sqlite` ([design 163:3923](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/docs/design/163-state-plane-sqlite.md:3923), [design 163:3988](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/docs/design/163-state-plane-sqlite.md:3988)).

B0 instead landed as four top-level files with no CODEMAP owners. The typed future error taxonomy already lives inside [state-barrier.ts:33](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-barrier.ts:33), while [state-publish.ts:17](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-publish.ts:17) imports the entire legacy `SyncState` merely to read `stream`.

Pre-U1 move list:

- `state-barrier.ts` classification → `state-plane/authority-marker.ts`
- `state-barrier.ts` error classes → `state-plane/errors.ts`
- `state-witness.ts` → `state-plane/migration/last-writer-witness.ts`
- `state-reserve.ts` → `state-plane/migration/reserve.ts`
- `state-publish.ts` → `state-plane/adapters/legacy-json-publication.ts`
- Change `afterStatePublication(root,file,state,body)` to accept the scalar `stream`.
- Move/split barrier tests beside their owners and update the AST inventory.
- Add the state-plane CODEMAP section; leave no compatibility files at the old paths.

This is a folder consolidation, not a request to collapse four distinct durability protocols into one file.

Conditional #549 challenge: it is not merged at HEAD. Commit `c35274d1` places a test importing `bun:sqlite` at `src/engine/sqlite-contract/sqlite-contract.test.ts:1–6`. Move the proposed directory to `src/cli/state-plane/sqlite-contract/` before merge. Test-only runtime characterization is still store ownership, not engine ownership.

Blast radius: mechanical import changes across state/reset/doctor/deferral modules plus one scalar signature.

2. Design 212 introduced a state mutation for which design 163 has no bounded adapter.

Scope changes currently load whole `SyncState`, filter the N-sized BASE array, and publish a replacement manifest ([scope-transaction.ts:138](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/scope/scope-transaction.ts:138)). The 163 store API has no scope-prefix operation, and its claim that only four modules touch the N-sized file array is now stale ([design 163:4143](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/docs/design/163-state-plane-sqlite.md:4143)).

Executable plan:

- Define a consumer-owned `ScopeBaseForgetPort` in `src/cli/scope/base-forget-port.ts`.
- Move the current JSON state half of `pruneScopedSubtrees` into `state-plane/adapters/legacy-scope-base.ts`; leave trash movement in `scope/`.
- Add `state-plane/adapters/scope-base.ts` for SQLite:
  - take a logical snapshot;
  - page BASE rows;
  - build and seal a replacement stage omitting segment-aware prefixes;
  - apply it through the sole CAS packet with unchanged sequence/header and untouched repo rows;
  - retry only on snapshot change;
  - never materialize `Manifest` or `SyncState`.
- Inject the port into the scope transaction and pass its held mutex owner token.
- Contract-test prefix boundaries, stale-token retry, unchanged repo sidecars, and bounded cursor use.

Blast radius: scope transaction plus two state-plane adapters. No pull or Git semantics change.

3. Replace the barrier inventory’s unordered symbol check with a real publication boundary.

The inventory claims immediate-before/immediate-after safety, but `calleesIn` builds an unordered set ([state-barrier-inventory.test.ts:109](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-barrier-inventory.test.ts:109)); the assertion only checks that names occur somewhere in the function ([state-barrier-inventory.test.ts:138](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/state-barrier-inventory.test.ts:138)).

During the B0 move, route ordinary state publication through the typed legacy publication adapter and inventory that chokepoint. Keep reset’s byte-swap publications as a separately explicit contract. The test should prove call ordering, not name co-occurrence.

Blast radius: structural tests and legacy publication call sites.

### Tier 2 — queued

1. Move scope authority back out of the daemon god file.

The recent lane grew `daemon.ts` from 3,330 to 3,391 lines. Scope added three coupled fields ([daemon.ts:483](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/daemon/daemon.ts:483)), a 33-line authority method ([daemon.ts:1508](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/daemon/daemon.ts:1508)), and a repair special case.

Create `src/cli/scope/daemon-authority.ts` with one state value and a closed refresh result: `continue {pullOnly, scoped, generation}` or `stop {condition,message}`. `RboxDaemon` should retain one guard field, not three booleans/optionals. Fold this into the next already-queued daemon cycle; do not schedule another generic daemon decomposition.

Blast radius: daemon startup, operation boundary, and scoped chain-repair refusal.

## Concrete target layout

```text
src/engine/
  state-port.ts                    # SQLite-free DTO/cursor/receipt contracts only

src/cli/scope/                     # keep: machine-local binding policy
  base-forget-port.ts
  daemon-authority.ts
  ...

src/cli/state-plane/
  index.ts                         # facade only
  ports.ts                         # store/migration administration only
  errors.ts
  authority-marker.ts
  sqlite-contract/                 # #549 runtime characterization
  store/
    open.ts
    read-snapshot.ts
    write-packet.ts
    generations.ts
    transition-stages.ts
    operation-plans.ts
    local-plane.ts
  schema/
    application.ts
    v1.ts
    validate-open.ts
  migration/
    authority.ts
    reserve.ts
    last-writer-witness.ts
    import-json.ts
    finalize.ts
  digest/
  backup/
  codecs/
  adapters/
    legacy-json-publication.ts
    legacy-json-store.ts
    legacy-scope-base.ts
    scope-base.ts
    projections.ts
    planning.ts
    outcomes.ts
    wire.ts
    whole-state-compat.ts          # temporary U3→U4f only
  engine-adapter.ts
```

At U3, reduce `sync-state-store.ts` to a temporary compatibility facade: move its JSON open/write/CAS regions into `legacy-json-store.ts`, and select JSON versus SQLite in `whole-state-compat.ts`. Keep `sync-state-model.ts` as the legacy DTO; do not promote it into engine—the model directly depends on CLI Git authority composition ([sync-state-model.ts:12](/home/via/Development/Personal/rbox-core/.claude/worktrees/thermo-3/src/cli/sync-state-model.ts:12)). Delete the facade and whole-state adapter when U4f reaches zero callers.

Validation: pure scope suites passed 19/19; root and API typechecks passed. Filesystem-writing suites could not run in this read-only sandbox because `/tmp` creation returns `EROFS`; those were not counted as product failures. No new production `as any`, feature flags, engine→CLI imports, or message-sniff error taxonomy drift were found. PR #547 and the three excluded roadmaps were not re-derived; known #542 was also omitted.