# 256 — Three owners replace the git-plan closure

Status: ALIGNED r3 (architecture loop task #37; review 3 aligned)

## 0. Yardstick

`planGitSectionsWithRetention` becomes a short composition loop over three deep
owners: one plan accumulator, one repository-scoped capture attempt, and one
plan-lifetime artifact lifecycle. CODEMAP's "one closure unit, helper order is
semantic" warning disappears. The `plan.ts` size pin is always re-measured and
lowered; its exception disappears only if the cohesive result naturally clears
both hard bands. Supported plan surfaces and physical-effect order remain
unchanged.

Measured at `590fee6e1`: `plan.ts` is 1,560 nonblank lines / 81,004 bytes;
`planGitSectionsWithRetention` spans lines 198–1545, contains 20 arrow closures
and 26 `for` loops, and the nested `processRepoSlowPath` spans lines 714–891.
The checked-in 1,447 / 73,664 size pin is stale and is not a valid baseline.

## 1. Protected-functionality ledger

| Contract | Owner after the change | Validation |
|---|---|---|
| Every `GitPushPlan` field, sort/order rule, changed decision, design-244 b2 flag-armed log, and log-once scope | `GitPlanAccumulator` | old-fixture/new surface differential plus existing suites |
| Pending is authoritative and byte-exact until accepted ACK; failed capture/proof restores the original pending object; forced non-P drop and unreadable-ref carry remain distinct | repository capture attempt + accumulator mutation methods | pending, 422, unreadable, supersession suites |
| #701/#573 supersession refusal memo records only a candidate that reached final proof, against the bracketed pre-probe fingerprint/identity/kind | repository capture attempt | existing supersession memo tests plus differential fixture |
| Config carry and capture preserve ownership, receiver, bounds, transient/permanent deferral, base-config fallback, and authorship semantics | one repository-scoped config operation used by both carry and capture | focused config-lane table test exercises both entry modes |
| Retained ciphertext is read locally before upload, pending/chain artifacts read through remotely, `flushed` advances only after satisfaction, each `encSha` flushes once, and one final sweep runs on success or throw | `PlanArtifactLifecycle` | artifact unit tests and existing resolution/capture tests |
| Flush point 1 excludes late-decided repos; flush point 2 covers the final captured set; irreversible proof/pin effects remain before the all-or-nothing final flush | orchestration calling the lifecycle | move-fidelity audit and existing capture tests |
| `ms[]` top-level buckets remain an identical non-overlapping partition: setup, discover, removal-prune, journal-preloop, carry excluding fingerprint, fingerprint, capture, projection, finalize, hygiene, divergence-cache excluding fingerprint, residual other | accumulator timing record + unchanged stage boundaries in orchestration | timing partition test and existing stats assertions |
| Removal-memory pruning requires genuine `.git` disappearance; ignored present repos carry; structural refusal and repo absence keep current purge-safety exclusions | orchestration + repository attempt | existing removal/ignore/structural tests |
| Deferral arrays, typed capture/config projections, observations, pointer policy skips, absence proofs, packed-ref baselines, conflict-ref budget, and cache invalidation stay ordered as today | accumulator + orchestration | full sync-git/engine-git suites |

No command, output, protocol, persisted/wire format, migration path, safety
property, compatibility path, fast path, or active readiness path is approved
for deletion or retirement.

## 2. Ownership and Interfaces

### `GitPlanAccumulator`

- **Owns:** all mutable plan output and bookkeeping, normalization/final plan
  assembly, timing/stat counters, byte-progress accounting, and bounded logs.
- **Must never own:** Git probing/capture, artifact upload/read-through, journal
  recovery, absence authorization, or cache persistence.
- **Interface:** named domain mutations (`carry`, `capture`, `defer`, `revert`,
  observations/proofs), `measure(bucket, effect)`, `noteRepoBytes`, `logOnce`,
  `finalizeOutgoing`, and `plan`.
- **Depth:** replaces dozens of shared closure bindings with one authority for
  every returned field and the timing partition.

### `RepoCaptureAttempt`

- **Owns:** one repository's journal recovery, identity/preflight/cache-write,
  carry/capture admission, config-lane decision, capture settlement, packed-ref
  observation/absence authorization, and late resolution or #701 proof. Its
  state is bound to one `relPath`; callers cannot interleave another repository
  through it. Bracketed supersession evidence stays private from pre-probe
  through final proof.
- **Must never own:** whole-plan finalization or proof collections, artifact
  retention/flush, cross-repo pointer policy, hygiene, or durable state writes.
  It does own one repo's absence authorization effects and emits one closed
  proof/refusal command; only the accumulator stores/projects that command.
- **Interface:** `recoverJournal()`, `classify() -> queued | settled`,
  `capture(artifacts)`, `finalizeCapture()`, and
  `finalizeAfterProjection(artifacts)`. The composition root enforces these
  phases and applies bounded concurrency only to `capture`. An attempt emits
  closed repo commands (`carry`, `defer`, `captured`, `removed`, `proof`,
  `observation`) to the accumulator; it receives snapshots and those commands,
  never accumulator collections or a generic mutable context.
- **Depth:** collapses `carryOwnedWithConfig` and `captureWithConfig` instead of
  moving their near-duplicate protocols into two methods.

### `PlanArtifactLifecycle`

- **Owns:** scratch directory creation, retained `encSha -> ciphertextPath`,
  pending uploads by repo, flushed identities, lazy local-first read-through,
  the two flush barriers, and final cleanup.
- **Must never own:** which candidate survives, proof policy, progress, plan
  fields, or remote commit behavior.
- **Interface:** `startIfNeeded`, `retain(repo, uploads)`, `store`, `flush(repos)`,
  and `dispose`.
- **Depth:** callers name owed repositories; they cannot coordinate retained,
  pending, read-through, and flushed collections independently.

`plan.ts` remains the adapter/composition root: files-first/opt-out, discovery,
cross-repo pointer policy, capture-pool scheduling, hygiene budget/common-dir
coordination, and cache refresh ordering. Repository policy inside every stage
lives on the attempt. Stage helpers remain ordinary functions in `plan.ts`, not
new state owners. Exported plan types and pure formatters remain where locality
warrants; they will not be moved merely to game the size gate.

### State crossing the boundary

The accumulator solely owns `state/base/durablePending/pending`, `out`,
repo-absent/removal/resolution memories, every returned collection, timings,
stats, logging/progress totals, and final normalization. An attempt solely owns
its `rel/kind/baseSec`, fast probe, queued/captured disposition, parent pointer,
stable-hygiene eligibility, resolution disposition under construction, and
bracketed supersession evidence. The attempt may read an immutable
`RepoPlanSnapshot` and submit a discriminated `RepoPlanCommand`; it cannot read
or mutate another repo. The accumulator applies commands synchronously and is
the only code that changes plan-wide collections.

`noteRepoBytes` preserves its unusual exact rule: a lower absolute observation
updates that repo's baseline without decreasing aggregate bytes or emitting;
an equal/higher observation adds only the delta and emits progress immediately
with the current completed-capture count. Capture settlement then increments
the completed count and emits once even when byte count is zero.

### Line budgets

| unit | budget |
|---|---:|
| `planGitSectionsWithRetention` composition function | about 250 physical lines |
| `plan.ts` total | measured downward from 1,560 / 81,004; it may remain allowlisted |
| each new production module | <400 nonblank and <25 KiB |

The repo owner may use private stateless leaf implementations for slow-path,
absence, and late-proof algorithms so each file passes the hard gate. They are
not independent authorities: they accept/return only the attempt's private
state/commands, own no durable or plan-wide state, and are not exported from the
sync-git public barrel. This is a physical size accommodation, not a new seam.

## 3. Migration and move fidelity

1. Characterize the baseline plan surface and config modes.
2. Introduce the artifact lifecycle behind the existing two flush sites and
   outer `finally` without changing ordering.
3. Move plan fields and closure helpers into the accumulator, preserving
   statement order verbatim wherever possible.
4. Move the slow path and later repo-bound phases into the repository-scoped
   attempt, then replace the two config-lane protocols with one operation whose
   policy is the following complete matrix. This dedup is the only deliberate
   behavior-bearing structural delta.

| Case | carry mode | capture mode |
|---|---|---|
| lane disabled | base section verbatim | captured section with BASE config restored |
| shape/scope ineligible | base verbatim; owned dir only | captured config stripped; requires dir + `refScope=all` |
| receiver throws | treated as unowned via caught `undefined`, legacy ownership message | caught with error-bearing capture-ownership message; config stripped |
| receiver says unowned | base verbatim | config stripped |
| config read throws | preserve existing propagation behavior of `readConfigForPush` call | convert to transient `read-error` failure |
| over bounds | defer without durable config deferral; base verbatim | defer without durable config deferral; captured section with BASE config restored |
| permanent failure | defer without durable config deferral; base verbatim | same durability; captured section with BASE config restored |
| transient failure | defer and durable config deferral; base verbatim | same durability; captured section with BASE config restored |
| valid config not due | base verbatim | embed config and author hash |
| valid config due | embed config only when `shouldPublishGitConfig` says due; author `localCfg.cached.hash` | always embed; author `gitConfigHash(embedded.config)` |

The implementation may express this as one decision over a closed `carry |
capture` policy, but must not hide arbitrary branches behind callbacks.
5. Route the composition loop through those Interfaces, remove the closure,
   always re-pin plan.ts downward to the measured result, and update CODEMAP
   ownership. Delete the allowlist reason/pin only when the cohesive result
   naturally clears both 400 nonblank and 25 KiB; do not move exports to force
   that outcome.

The implementation report will enumerate verbatim moves separately from the
config dedup and lint-only rewrites. No dead implementation is claimed or
deleted beyond superseded local closures and the obsolete size/map ceremony.

## 4. Requirement challenges

| Requirement | Complexity cost | Evidence | Recommendation | Decision |
|---|---|---|---|---|
| Preserve helper declaration order as semantic coupling | Prevents independent ownership and makes all mutation ambient | CODEMAP §2.7 and the 1,348-line closure | Replace with explicit owner Interfaces and stage order | In scope |
| Keep separate config carry/capture implementations | Duplicates ownership/read/refusal/fallback protocol and lets lanes drift | Current near-clones at plan.ts:610–687 | One repo-scoped operation with explicit policy inputs | In scope; differential test required |
| Keep plan.ts on the size allowlist with a lower pin | Retains some debt, but exported types/formatters and ordered cross-repo coordination may remain cohesive | User explicitly requires a downward measured pin; hard gate is 400 / 25 KiB | Re-pin downward to measured output; delete both entries only if the cohesive result naturally clears both bands | Required/conditional |
| Change any pending, purge, timing, or deferral behavior while moving | Multiplies review ambiguity and compatibility risk | Safety contracts above | Preserve exactly | Not approved |

## 5. Validation gates

- **Differential:** before editing, run the old planner on a real one-commit repo
  with an owned config and capture upload, canonicalize generated timestamps,
  path-bound 64-hex identities, encrypted artifact hashes, and timing stats,
  and check that canonical JSON in as a golden. Canonical identities use a
  stable first-seen bijection (`encSha-1`, `encSha-2`, `binding-1`, …) reused
  across the plan and recorded uploads, preserving alias/equality relationships
  and upload order. Numeric artifact/cipher sizes are compared exactly, never
  replaced by placeholders.
  The new test recreates the same repo and compares its canonical plan plus
  upload count/section references to that frozen old output. This crosses
  accumulator, repo capture/config, and artifact retention; existing targeted
  pending/#701 tests cover the late branch. No old implementation remains.
- **Config dedup:** a focused table covers both modes for every matrix row above,
  including exact section fallback, authorship hash, deferred item, durable
  typed projection, observation, and log text/read count. Existing config-push
  suite stays green.
- **Timing attribution ledger (identical to current code):**

  | bucket | exact effects |
  |---|---|
  | setup | entry through republish input, state projection, cache load, owner construction |
  | discover | `discoverGitRepos` only |
  | removalPrune | removal-memory `.git` `lstat` loop only |
  | journalPreloop | lazy ctx warmup + ordered journal/binding recovery loop |
  | carry | post-journal classification through pointer-policy settlement, minus only the two explicitly measured fast `fingerprintHitProbe` calls |
  | fingerprint | those two fast probes plus post-cleanup refresh `gitFingerprint`; slow-path initial/recomputed fingerprints remain charged to carry |
  | capture | bounded capture pool plus packed-ref observation and absence authorization |
  | projection | normalize outgoing + proof-backed tombstone exactness/revert |
  | finalize | early flush, keep-mine reports/pins, #701 final proof/memo/revert, final flush |
  | hygiene | conflict-ref prune loop only |
  | divergenceCache | post-cleanup refresh + dead-key prune + save, minus its explicitly measured refresh fingerprint |
  | other | `max(0, total - sum(all named buckets))` |

  The accumulator accepts an injected monotonic clock in its focused test. The
  test drives named stage markers with unequal deterministic deltas, including
  the carry/divergence fingerprint subtractions, and pins exact bucket values;
  call-site move review pins which effects enter each marker.
- **Crash/effects:** scratch cleanup still runs from one `finally`; flush failure
  propagates; cache save remains best-effort; journal/state failures retain
  their current propagation.
- **Compatibility:** no persisted or wire shape changes; old/new binaries see
  identical `GitSection` and `GitPushPlan` projections.
- **Performance:** no extra discovery, fingerprint, Git subprocess, artifact
  read/upload, state read, or cache traversal. Config dedup must not add a read.
- `bun test src/cli/sync-git src/engine/git`, `bun run typecheck`,
  `bun run lint:affected`, and the module-size gate all pass with zero failures.
- Direct full-file lint gate: baseline
  `bunx oxlint --config .oxlintrc.json src/cli/sync-git/plan.ts` reports 9
  anti-slop warnings at `590fee6e1` (the prompt's ~46 has drifted). Run direct
  oxlint over plan.ts plus every new/touched production module and require zero
  warnings; report the 9 -> 0 plan.ts delta separately from `lint:affected`.

## 6. Safe deletion and ceremony kill

Safe in this slice after differential equivalence: the superseded closure-local
implementations. The CODEMAP confession that helper order is semantic is
replaced by three ownership lines. The plan.ts allowlist reason and pin are
replaced with lower measured values; they are deleted only if the cohesive file
falls below both hard bands. Nothing else is approved for deletion, retirement,
or support-window change.

## 7. Exact purge/removal compatibility

This refactor preserves current behavior, including its asymmetry: the
removal-memory prune loop maps every `.git` `lstat` rejection to `undefined` and
deletes the memory; it does **not** distinguish permission/I/O errors there.
Later repo-absence classification does distinguish present-but-unreadable and
carries BASE. Pending + structural refusal carries P; BASE + structural refusal
drops the section and marks repo-absent; ignored-but-present BASE carries with no
removal memory; a genuinely absent repo directory removes and marks absent.
Changing the prune asymmetry would be a separate approved fix, not this move.
