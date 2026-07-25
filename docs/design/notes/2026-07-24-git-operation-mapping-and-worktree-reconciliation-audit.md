# Git operation mapping and worktree reconciliation audit

Date: 2026-07-24

Audited commit: `621aed460c7ac3bcc8e1d18c460c2d3425837334` (`origin/main`)

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

The audit also found a current correctness failure in the exact squash-merge
and branch-deletion reconciliation path. The physical Git transaction succeeds,
but the landed logical BASE retains the deleted branch. This is the highest
priority finding.

## P0: squash pruning can leave physical Git and logical BASE split

The focused integration test
`§130 follower prune crosses publishRefPlane, survives carry, fingerprints
reflog, and compacts A to Z` models the common workflow:

1. Create and publish `topic`.
2. Squash-merge `topic` into `main`.
3. Delete `topic` on the publisher.
4. Receive an authenticated branch tombstone.
5. Prune `topic` on the follower.
6. Preserve a raced reflog-only commit.

On the audited `origin/main`, the Git-side assertions succeed:

- the follower branch is deleted;
- the raced commit is retained under a keep pin;
- its human-origin record is present; and
- the successful prune log is emitted.

The final persisted-state assertion fails:

```text
Physical Git: refs/heads/topic is absent
Logical BASE: refs/heads/topic still equals the old topic tip
```

The companion safety test,
`§130 checked-out branch without live/BASE equality holds and never invents P
authority`, passes. The pure publisher-tombstone, tombstone-attestation, and
BASE-composer suites also pass. This localizes the observed failure after
successful ref publication, around the transition from `applyGitSections`
through `saveStateSource` and artifact settlement.

This should be treated as a correctness failure rather than merely an
observability or refactoring concern. A follower that physically deleted a ref
but retained it in BASE begins the next sync from a false predecessor.

### Focused validation

The following isolated tests were run:

| Test area | Result |
|---|---:|
| Publisher tombstone protocol | 31 passed |
| Tombstone attestation | 4 passed |
| Pure BASE composer | 12 passed |
| Checked-out branch safety hold | passed |
| Squash prune and BASE landing | failed at final persisted BASE assertion |

The source-structure allowlist suite could not be evaluated in this worktree
because it invokes Node directly and the worktree has no local `node_modules`;
Node resolved an older home-level TypeScript package without
`typescript/unstable/sync`. That is a validation-environment limitation, not a
product finding.

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

Consequently, design 130 can automatically clean a stale squash-merged branch
only when it is not checked out in another worktree. If it remains active in a
linked worktree, rbox lacks authenticated intent to decide whether that
worktree should:

- remain on the deleted branch;
- switch to `main`;
- detach at its current commit; or
- be removed.

The current safety hold is correct. Seamless fleet behavior requires a product
model for worktree intent.

## Structural findings

### 1. No semantic Git-effect boundary

`gitRaw`, `git`, `gitWithIndexFile`, and `gitOk` accept arbitrary argument
arrays. There are 122 direct wrapper invocations across the relevant production
trees. Raw `update-ref` authority remains spread across numerous production
modules.

The existing structure test counts approved source sites. It does not establish:

- the semantic operation responsible for a command;
- preconditions;
- accepted exit statuses;
- permitted ref namespaces and filesystem writes;
- inverse/recovery effects; or
- the required state receipt.

`gitOk` is particularly weak for proof-sensitive operations because it
collapses all failures into a boolean. Some callers correctly distinguish Git
exit status 1 from I/O, missing-object, and process failures, but that discipline
is not encoded at the command boundary.

### 2. Planning, effects, and state construction are interleaved

Relevant module sizes at the audited commit:

| Module | Lines |
|---|---:|
| `src/cli/daemon/daemon.ts` | 3,475 |
| `src/cli/sync-git/apply.ts` | 1,995 |
| `src/cli/sync-git/follow.ts` | 1,664 |
| `src/cli/sync-git/plan.ts` | 1,180 |
| `src/cli/git/resolve-command.ts` | 1,018 |
| `src/engine/git/lockfile.ts` | 1,261 |
| `src/engine/git/checkout-txn.ts` | 999 |

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

### 4. Operator visibility is symptom-oriented

The audited HEAD commit fixed a case where a concrete ref-publication error was
classified and then discarded, leaving operators with only a generic failure.
That is evidence for a structured execution receipt rather than another
collection of log strings.

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

## WorktreeReplica model for tier-2 support

True seamless worktree behavior needs an explicit replicated entity:

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

Without those facts, the current hold is the correct behavior.

## Recommended sequence

1. Fix and permanently gate the current squash-prune/BASE persistence failure.
2. Update `docs/usage.md` to describe the implemented worktree model.
3. Add structured Git decisions and `rbox git explain`.
4. Introduce typed effect plans and execution receipts.
5. Route clean apply, divergent follow, and manual resolution through one
   canonical ref-transaction authority.
6. Separate pure planning from effects in `apply.ts` and `follow.ts`.
7. Design and implement the tier-2 `WorktreeReplica` lifecycle protocol.
8. Keep daemon scheduling refactors separate from Git semantic refactors.

## Final assessment

The current implementation contains substantial and generally careful safety
machinery: authenticated tombstones, tri-state reachability, expected-old
updates, linked-worktree ownership guards, quarantine, keep pins, journals,
locked second proofs, and A/P/K artifacts.

The main architectural deficit is not a lack of Git safety mechanisms. It is
the absence of a single, inspectable semantic effect boundary connecting those
mechanisms to one durable state receipt. The observed squash-prune failure is a
concrete example: Git reached the intended terminal state, but replicated state
did not.

A semantic-operation-to-effect-plan mapping preserves rbox's endpoint-state
replication model while making each Git mutation rigorous, testable,
explainable, and recoverable.
