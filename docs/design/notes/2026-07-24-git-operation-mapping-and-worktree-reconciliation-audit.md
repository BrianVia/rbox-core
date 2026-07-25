# Git operation mapping and worktree reconciliation audit

Date: 2026-07-24; re-evaluated 2026-07-25

Original audited commit:
`621aed460c7ac3bcc8e1d18c460c2d3425837334` (`origin/main`)

Re-evaluation commit:
`f6013f2dc313c79f27268a280bedc40ac76fd096` (`origin/main`, v1.9.1)

Scope: CLI/daemon Git capture, apply, follow, manual resolution, worktree
ownership, and Git BASE persistence

Method: read-only structural review plus focused tests; no product code changed

## Executive conclusion

A nearly 1:1 mapping is the right organizational direction if the mapped unit
is an **rbox semantic operation**, not the Git porcelain command a user
previously ran.

The target relationship should be:

```text
one named rbox transition
  -> one deterministic, inspectable Git/filesystem effect plan
  -> one execution receipt
  -> one durable Git BASE transition
```

It should not be:

```text
source machine ran `git rebase`
  -> follower tries to infer and replay `git rebase`
```

Git endpoint state generally cannot distinguish all source operations. Squash
merges intentionally destroy ancestry correspondence, and different sequences
of merge, reset, cherry-pick, and commit operations can produce indistinguishable
endpoints. rbox is correctly built as a state replicator, but the mapping from
state decisions to concrete Git mutations is not currently explicit enough.

The original audit also found a correctness failure in the exact squash-merge
and branch-deletion reconciliation path: the physical Git transaction
succeeded, but the landed logical BASE retained the deleted branch. That
finding is no longer current on v1.9.1. Design 200 materially changed this
path, and the unchanged focused regression now passes on the re-evaluation
commit.

The remaining architectural finding is therefore not "squash reconciliation
is currently broken." It is that correct behavior is distributed across
increasingly large planning, proof, mutation, and BASE-composition modules
without one typed semantic-effect boundary. Design 200 improves the safety
model and recovery behavior, while making that consolidation more—not
less—valuable.

## Re-evaluation: the prior P0 is resolved on latest main

The focused integration test
`§130 follower prune crosses publishRefPlane, survives carry, fingerprints
reflog, and compacts A to Z` models the common workflow:

1. Create and publish `topic`.
2. Squash-merge `topic` into `main`.
3. Delete `topic` on the publisher.
4. Receive an authenticated branch tombstone.
5. Prune `topic` on the follower.
6. Preserve a raced reflog-only commit.

On the original audited commit, the Git-side assertions succeeded:

- the follower branch is deleted;
- the raced commit is retained under a keep pin;
- its human-origin record is present; and
- the successful prune log is emitted.

The final persisted-state assertion failed:

```text
Physical Git: refs/heads/topic is absent
Logical BASE: refs/heads/topic still equals the old topic tip
```

On the re-evaluation commit, that same test passes with 17 expectations. Blame
shows that the test body and terminal physical-ref/BASE assertions are unchanged
from their pre-design-200 form, so this is a behavioral fix rather than a
weakened regression. This audit did not bisect the smallest fixing commit;
the supported conclusion is that current `origin/main`, including the shipped
design 200 work, resolves the reproduced failure.

Design 200 also addresses the broader local lifecycle that produced the
incident:

1. A branch deleted outside rbox is omitted from capture.
2. A multi-clause witness proves that the omission is an authentic local
   deletion rather than an unreadable or incomplete ref observation.
3. A verify-only prepared ref transaction proves absence while holding the
   relevant ref lock.
4. Capture authors an exact-OID tombstone.
5. Publisher acknowledgement retires BASE only after the accepted wire state,
   under the same compare-and-swap.
6. If proof is incomplete, Step D carries the last synced section and defers
   the entire capture rather than publishing ambiguous absence.

This changes the operational conclusion: a squash-merged branch may remain
held while a linked worktree owns it, but once the worktree is gone and the
branch is deleted, the ordinary capture/tombstone protocol can reconcile the
fleet without manual BASE repair.

### Focused validation

The following isolated tests were run:

| Test area | Result |
|---|---:|
| Formerly failing §130 squash prune and BASE landing | passed, 17 expectations |
| Design 200 local deletion, tombstone, and BASE retirement | passed |
| Design 200 linked-worktree partial apply and completion | passed |
| Design 200 Step D atomic defer under real ref-lock contention | passed |
| Held-skip pure suite | 14 passed |
| Content-equivalence cache | 2 passed |
| Strict ref observation | 2 passed |
| Reachability classification | 25 passed |

The three design 200 integration cases passed together with 201 expectations.

## Current semantic operations and actual effects

The daemon does not independently implement Git semantics. It observes file/ref
activity, schedules work, and invokes the same push/pull implementation used by
foreground commands. Git policy primarily lives under `src/cli/sync-git` and
`src/engine/git`.

### Repository observation

Representative Git calls:

```text
git rev-parse --absolute-git-dir
git rev-parse --git-common-dir
git show-ref
git rev-parse --verify --quiet <ref>
git worktree list --porcelain
```

Representative direct filesystem observations:

- resolved gitdir `HEAD`;
- index bytes;
- merge/rebase/sequencer operation-state files;
- reflogs;
- lockfiles and repository identity metadata.

### Capture

Capture performs substantially more than `git bundle`:

1. Resolve the worktree gitdir and common dir.
2. Copy the live index into a private staging index.
3. Clear resolve-undo only in the private index.
4. Copy operation-state files.
5. Read HEAD and the scope-appropriate refs.
6. Run:

   ```text
   GIT_INDEX_FILE=<private-index> git stash create
   ```

   This creates a synthetic WIP commit without mutating the live index.

7. Create scratch refs using expected internal namespaces so WIP, index, and
   operation-state objects remain reachable.
8. Create a bundle:

   ```text
   git bundle create <path> <internal-exclusion> \
     --single-worktree --all [refs/stash] [scratch-refs] [^basis-tips]
   ```

   Pointer repositories instead use scoped refs.

9. Encrypt and upload bundle, index, and operation-state artifacts.
10. Remove scratch refs and staging files.

The manifest identity is based on endpoint state, not bundle bytes. This is
important because `git stash create` may mint a new synthetic commit on each
capture.

### Authenticated out-of-band branch deletion

Design 200 added a semantic operation that was missing from the original
mapping: turn a locally absent, previously published branch into an
authenticated replicated deletion.

Representative effects include:

```text
git show-ref
git update-ref --stdin
  start
  option no-deref
  verify refs/heads/<branch> 0000000000000000000000000000000000000000
  prepare
  <locked second proofs>
  commit
  # abort instead if a locked proof fails
```

The strict ref reader distinguishes a legitimately empty ref store (Git exit
1 with empty stderr) from an unreadable ref store. The planner then requires
the deletion witness: scoped capture, origin agreement, unchanged lineage,
settled artifacts, no worktree owner, no name collision, and stable HEAD
symref are among the named clauses exposed by current diagnostics.

The verify-only transaction is not the deletion itself. It is a locked
second proof that the ref is still absent before capture publishes the
tombstone-bearing state. BASE retirement happens only after publisher
acknowledgement. This is a good example of one rbox operation legitimately
mapping to several coordinated Git and state effects.

### Import

For each bundle link:

```text
git bundle verify <local-decrypted-bundle>
git fetch --no-tags --no-recurse-submodules \
  <local-decrypted-bundle> \
  +refs/*:refs/rbox-incoming/<episode>/*
```

The incoming namespace is apply-unique and cleaned after publication or defer.
The explicit no-submodule-recursion flag prevents a local artifact import from
turning into network activity or child-repository mutation.

### Ownership and reachability classification

Representative calls:

```text
git cat-file --batch-check=...
git rev-list --quiet --stdin
git merge-base --is-ancestor <tip> <root>
git worktree list --porcelain
```

The result is intentionally tri-state:

- owned;
- unowned; or
- indeterminate.

Missing objects, shallow stores, corrupt walks, and unexpected Git exit statuses
fail closed rather than being treated as proof that a ref is safe to replace.

At the process boundary, `gitStatus` now preserves successful output or returns
a structured failed result containing exit status, stdout, stderr, and the
original cause. `readAllRefsStrict` uses that distinction for proof-sensitive
ref observation. This is a meaningful improvement over treating every
non-zero result as "no refs," although it is not yet a semantic effect API.

### Branch and safe-ref publication

Ref publication uses expected-old compare-and-swap forms:

```text
git update-ref <ref> <new> <expected-old>
git update-ref -d <ref> <expected-old>
git update-ref --stdin
```

Non-fast-forward displacement may first produce keep pins and origin records.
Branch transitions additionally author A/P/K proof artifacts. Tags and stash use
the safe-ref lane; stash publication also creates a reflog entry so the received
stash is usable by `git stash list` and `git stash pop`.

### Checkout publication

Checkout publication is not reducible to one ordinary Git command. It combines:

- a prepared native `git update-ref --stdin` transaction;
- `.lock` reservations;
- locked second proofs of refs, worktree ownership, and reflog state;
- direct publication of HEAD, index, and operation-state files;
- commit or abort of the prepared ref transaction; and
- connectivity checks:

  ```text
  git rev-list --quiet <roots> --
  git fsck --connectivity-only --no-dangling [...]
  ```

This is a strong example of why the desired 1:1 unit must be a semantic effect
plan rather than one Git subprocess.

### Conflict and manual resolution

Conflict preservation creates quarantine/recovery bundles and
`refs/rbox-conflict/...` refs. `take-theirs` reuses the follower transaction
path after quarantining and pinning local state. `keep-mine` captures current
local endpoint state and sends it through the ordinary publisher flow.

No production merge, rebase, cherry-pick, reset, or checkout porcelain command
is replayed on a follower.

## Why squash merge strands branches

The original stale-side-branch incident is accurately described by design 130:
a replica accumulated 83 local-only commits across stale branches that had been
squash-merged and deleted elsewhere.

For a normal fast-forward:

```text
old topic tip T -> incoming main contains T
```

An ancestry proof can show that deleting or replacing `T` does not discard
unknown work.

For a squash:

```text
topic: A-B-C
main:  A-S
```

`S` may contain the combined changes from `B` and `C`, but neither `B` nor `C`
is an ancestor of `S`. Git graph ancestry correctly cannot prove ownership of
the old topic tip.

Design 130 supplies missing authenticated history using branch tombstones. A
prune is authorized only when:

```text
live ref
  == authenticated tombstoned OID
  == logical BASE
  == valid positive branch origin
```

and all artifact, worktree-ownership, reflog, and locked second-proof gates
also succeed.

This is a sound authorization model. Patch equivalence or tree equality should
never replace it: those heuristics can explain similarity, but they cannot prove
that deleting local history is authorized.

## Worktree limitation

Current worktree support is tier 1:

- the main clone captures shared history with
  `git bundle create --single-worktree --all`;
- main-checkout index and operation-state are captured;
- branches checked out in linked worktrees remain ordinary shared refs;
- an in-tree pointer worktree is base-carried because its object history already
  travels with the main clone; and
- publication holds a branch owned by another worktree because raw
  `update-ref` would otherwise move it silently and dirty that worktree.

Per-worktree HEAD, index, operation-state, identity, and lifecycle remain an
explicit tier-2 non-goal.

Design 200 makes this tier materially less disruptive:

- a sibling-worktree ownership hold is eligible for a race-bracketed
  per-ref held-skip;
- that hold no longer escalates by itself into whole-repository deferral;
- unrelated fast-forwardable ref changes can continue through the design 174
  partial-apply path;
- `rbox doctor` reports leftover linked worktrees; and
- once the worktree and branch are removed, authenticated out-of-band deletion
  lets the repository self-heal.

The safety boundary remains appropriate. While a branch is active in a linked
worktree, rbox still lacks authenticated intent to decide whether that
worktree should:

- remain on the deleted branch;
- switch to `main`;
- detach at its current commit; or
- be removed.

The remaining synchronization limitation is narrower than the original audit
stated. A divergent held ref combined with an unrelated non-fast-forward
transition can still keep the larger pending section carried. The honest fix
is per-ref publishing/state, currently parked as design 201, rather than
pretending the worktree hold is repository-wide intent.

Replicating worktree identity and lifecycle would be a separate product
capability. It is no longer a prerequisite for the common
worktree-create/squash/delete/teardown lifecycle to converge.

## Structural findings

### 1. No semantic Git-effect boundary

`gitRaw`, `git`, `gitWithIndexFile`, `gitStatus`, and `gitOk` accept arbitrary
argument arrays. There are now 131 direct wrapper invocations across the
relevant production trees. Raw `update-ref` authority remains spread across
11 production modules.

The existing structure test counts approved source sites. It does not establish:

- the semantic operation responsible for a command;
- preconditions;
- accepted exit statuses;
- permitted ref namespaces and filesystem writes;
- inverse/recovery effects; or
- the required state receipt.

`gitStatus` is genuine progress: it makes exit status, output, stderr, and
process cause data, and the strict ref reader uses it to distinguish an empty
repository from an unreadable one. `gitOk` still collapses failures to a
boolean, however, and callers can still issue arbitrary argv. The process
result type does not encode the semantic operation, accepted statuses,
namespace authority, preconditions, or matching BASE transition.

### 2. Planning, effects, and state construction are interleaved

Relevant module sizes at the re-evaluation commit:

| Module | Lines |
|---|---:|
| `src/cli/daemon/daemon.ts` | 3,475 |
| `src/cli/sync-git/apply.ts` | 2,114 |
| `src/cli/sync-git/follow.ts` | 1,784 |
| `src/cli/sync-git/plan.ts` | 1,383 |
| `src/cli/git/resolve-command.ts` | 1,065 |
| `src/engine/git/lockfile.ts` | 1,425 |
| `src/engine/git/checkout-txn.ts` | 1,013 |

`apply.ts` and `follow.ts` mix:

- state classification;
- object import;
- ownership/reflog proof;
- ref mutation;
- checkout publication;
- journal recovery;
- config application;
- telemetry;
- pending/partial/attempt construction; and
- BASE proof construction.

The daemon is large, but Git policy should not be moved into it. Its useful
refactoring seam is scheduling and lifecycle management; the Git architecture
work belongs in the sync-git/effect layer.

### 3. Overlapping ref mutation engines

Clean apply, divergent follow, and manual resolution contain overlapping
ancestry, pinning, expected-old update, hold classification, and receipt logic.
Rollback and quarantine add further raw mutation paths.

The existing thermo-nuclear roadmap recommends extracting
`publishRefTransition` from `engine/git/apply.ts`. The stronger target is a
canonical branch/safe-ref transaction API used by all three user-facing paths,
with specialized executors beneath one mutation-authority boundary.

### 4. Operator visibility improved, but is not end-to-end

Design 200 added typed `deletion-pending` and `ref-read-unreadable` reasons,
named witness-clause diagnostics, and a leftover-worktree section in
`rbox doctor`. That materially improves the exact incident investigated here.
It still does not expose one end-to-end record connecting observation,
decision, effects, and BASE acknowledgement.

An `rbox git explain <repo>` surface should display, for each relevant lane:

```text
LIVE       refs/heads/topic = T
BASE       refs/heads/topic = T
INCOMING   absent
TOMBSTONE  T, authenticated
WORKTREE   checked out by ../topic-worktree
DECISION   hold: worktree ownership
PLANNED    delete branch with expected-old T; preserve displaced reflog tips
```

The JSON representation should expose the same plan with bounded/sanitized
paths, refs, and object identifiers.

### 5. Worktree documentation is stale

`docs/usage.md` still says primary clones containing linked worktrees are
ineligible and pointer worktrees are captured. Current design and code instead
capture the main clone and base-carry eligible in-tree pointer worktrees. This
should be corrected independently of behavioral changes.

## Recommended architecture

### Layer 1: observation

Produce an immutable `GitObservation` containing:

- repository/worktree identity;
- HEAD and refs;
- index projection;
- operation-state projection;
- worktree ownership;
- reflog fingerprints;
- lock/busy state; and
- relevant object/reachability results.

Observation may call read-only Git commands but may not mutate refs or files.

### Layer 2: pure decision

A pure planner consumes:

```text
logical BASE + authenticated incoming state + GitObservation + policy
```

and returns either:

- `GitEffectPlan`; or
- a typed hold with explicit failed gates.

The planner must not run Git commands or write state.

### Layer 3: effect execution

`GitEffectPlan` should be a discriminated union with operations such as:

- `CaptureSnapshot`;
- `ImportPackChain`;
- `PublishBranchTransition`;
- `PublishSafeRefTransition`;
- `PublishCheckout`;
- `PreserveConflict`;
- `QuarantineLocal`;
- `RecoverJournal`; and
- `SettleProofArtifacts`.

Each plan should include:

- repository/worktree binding;
- expected old values;
- exact ordered Git commands and filesystem effects;
- expected exit-status interpretation;
- required locks/reservations;
- rollback or recovery action;
- resulting proof artifacts; and
- intended BASE post-state.

Only effect executors may issue mutating Git calls or publish Git metadata
files. Specialized implementations such as the prepared checkout transaction
may remain separate modules, but they should implement one typed authority
surface.

### Layer 4: receipt-driven state commit

Execution returns a structured `GitExecutionReceipt`. The state layer consumes
that receipt exactly once to construct the new `RepoRecord`.

The key invariant should be:

```text
no successful branch mutation without a durable receipt
no BASE transition without the matching receipt
no repeated composition that can reinterpret the receipt differently
```

Tests should assert the terminal physical Git state and persisted `RepoRecord`
from the same receipt.

## Optional WorktreeReplica model for tier-2 product semantics

Design 200 demonstrates that rbox does not need to replicate worktrees merely
to survive the normal ephemeral-agent lifecycle. Current safety holds,
per-ref held-skip, authenticated out-of-band deletion, and later reconciliation
are sufficient for that lifecycle.

If the product goal expands to making the same logical worktree exist, switch,
or close across machines, then it needs an explicit replicated entity:

```text
WorktreeReplica {
  logicalWorktreeId
  repositoryId
  desiredCheckout: branch | detached OID
  acknowledgedHead
  acknowledgedIndex
  acknowledgedOperationState
  lifecycle: active | switched | closed
}
```

The identity cannot be derived from absolute paths because paths and worktree
sets differ across machines.

A follower should automatically retire or switch a squash-merged worktree only
when:

1. the publisher supplied authenticated branch deletion and worktree
   closure/switch intent;
2. the follower worktree still equals its acknowledged predecessor;
3. the index and worktree are clean;
4. no Git operation is in progress;
5. no machine-local commits or reflog-only work would be discarded;
6. local state is quarantined or pinned first; and
7. checkout mutation and replicated-state acknowledgement share one receipt.

Without those facts, the current hold is the correct behavior. This protocol
should be considered only if cross-machine worktree identity is an intentional
product feature; it should not displace the nearer-term per-ref publication
and semantic-effect-boundary work.

## Recommended sequence

1. Keep the resolved squash-prune/BASE regression and the design 200 lifecycle
   rig as permanent gates.
2. Update `docs/usage.md` to describe the implemented worktree model.
3. Introduce typed effect plans and execution receipts.
4. Route clean apply, divergent follow, and manual resolution through one
   canonical ref-transaction authority.
5. Separate pure planning from effects in `apply.ts` and `follow.ts`.
6. Add an end-to-end `rbox git explain` view over observations, holds, plans,
   execution receipts, and BASE acknowledgement.
7. Implement design 201 per-ref publishing when the larger wire/state
   migration is scheduled.
8. Consider `WorktreeReplica` only if replicating worktree lifecycle becomes
   a deliberate product promise.
9. Keep daemon scheduling refactors separate from Git semantic refactors.

## Final assessment

The current implementation contains substantial and generally careful safety
machinery: authenticated tombstones, tri-state reachability, expected-old
updates, linked-worktree ownership guards, quarantine, keep pins, journals,
locked second proofs, and A/P/K artifacts.

The main architectural deficit is not a lack of Git safety mechanisms. It is
the absence of a single, inspectable semantic effect boundary connecting those
mechanisms to one durable state receipt. Design 200 resolves the reproduced
squash-prune/BASE failure and makes the common ephemeral-worktree lifecycle
self-healing. It also grows the largest policy modules and the number of direct
Git wrapper calls, strengthening the maintainability case for consolidation.

A semantic-operation-to-effect-plan mapping preserves rbox's endpoint-state
replication model while making each Git mutation rigorous, testable,
explainable, and recoverable.
