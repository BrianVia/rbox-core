# 116 — Checkout follows sync

Status: **ALIGNED** (2026-07-13) — eight codex adversarial rounds (r1-r5
finding rounds, r6-r8 confirmation chain on the final keep-mine closure
seam); every finding adjudicated against code and folded, marked `(rN Fn)`
inline. Ledger: [REVIEW-116](./REVIEW-116.md). Phase 0 (incident
reproduction) is a mandatory pre-implementation gate and survived review
strengthened, not weakened. This is an active correctness design, not a
shelf note.

**Founder-set principle:** the checkout follows you. rbox promises: close the
laptop, open the desktop, keep typing. Design 93 made the full Git state part of
that promise. When host A moves a checkout and host B has no human-local
divergence, B must follow A. Deferring forever is a correctness failure, not a
conservative success.

## Field incident and root-cause audit

On 2026-07-13 a Mac checkout was found more than two weeks behind on a stale,
fully merged branch at a v0.9.18-era commit while ordinary file sync remained
healthy. The newest files had arrived; branch, HEAD, index, and associated Git
state had not.

The field diagnosis was that the file and Git planes had deadlocked:

```text
A publishes newer files + Git state
  -> B's file apply writes A's bytes first
  -> those bytes differ from B's old HEAD/index
  -> applyGitSections compares B's Git identity with its old Git base
  -> the dirty/divergence gate refuses the Git apply
  -> B keeps the old HEAD, so the synced bytes remain "dirty" forever
  -> every retry reaches the same refusal
```

`src/cli/sync/pull.ts` intentionally applies file actions before calling
`src/cli/sync-git/apply.ts::applyGitSections`. However, a 2026-07-13 audit of
this worktree found an important discrepancy that implementation must resolve
before changing code: current `localDivergedFromBase()` compares HEAD,
projected refs, index tree, and operation state, but **does not inspect working
bytes**; current `applyGitState()` has no porcelain dirty-tree gate either.
File apply alone therefore cannot trip that exact predicate in current HEAD.

The incident is real; the initially named current-code mechanism is not yet
proved. It may live in the released fleet binary, a historical revision, a
different apply refusal, or persisted base/pending state. Phase 0 is mandatory:
reproduce with the incident release/state (including `gitPendingRemote`,
`gitNeedsResolution`, repo records, and daemon log), pin a failing test, and
bisect the actual deferral site. No implementation may delete or replace
`localDivergedFromBase()` on this narrative alone.

The semantic distinction the implementation must make wherever the reproduced
gate lives remains:

- **sync-induced dirt:** the working bytes are exactly the bytes the file plane
  just applied; following the incoming checkout is required; and
- **human-local dirt:** a person edited B independently; moving the checkout
  must never clobber it.

The same broad deferral shape previously hid design-84 manifest-fold evidence:
one plane's incomplete local progress was allowed to suppress newer, already
verified truth from another plane. The fix is not a weaker safety gate. It is a
provenanced follow rule, independent progress for independent planes, and a
regression test tied to the actual failure site.

## Goals and hard invariants

1. If B's live, rbox-visible working tree equals the applied file manifest and
   B has no human-local Git metadata or local-only checkout commits, B follows
   the incoming checked-out branch/HEAD, index, operation state, and eligible
   stash state in the same pull. This is the default.
2. Sync-induced dirt never causes a Git checkout deferral.
3. Human-local files, staged/index state, operation state, stash work, and
   local-only commits are never overwritten or made unreachable.
4. Safe non-checkout refs and remote-tracking state advance independently even
   when the checkout plane defers. One protected ref does not freeze unrelated
   refs.
5. A deferred repo continues to carry the newest incoming section on push and
   retries without an echo commit or stale-state resurrection.
6. Every remaining deferral is durable and visible with a per-repo age and a
   closed reason class.
7. Design 43's `[v2]`–`[v6]` rules remain binding: scope projection, pointer
   ownership/filtering, pending-remote carry, absence-supersedes-pending,
   removal memories, conflict suppression, per-repo 422 recovery, containment,
   and decrypt/verify-before-mutate do not weaken.
8. File-plane last-writer-wins semantics and Git-plane follow semantics agree:
   in the absence of local human work, the newest accepted remote state wins.

The non-negotiable negative form is simpler: **never move a checkout with
human-local edits; never drop a local-only commit.** Recovery refs and trash are
defense in depth, not permission to violate either rule.

## What “checkout,” “ref plane,” and “remote tracking” mean

The implementation separates three mutation planes per repo:

| Plane | Owned state | Can advance while checkout is deferred? |
|---|---|---|
| checkout | current symbolic ref or detached HEAD, HEAD form, index, op-state, and the metadata/bytes coherence decision | no |
| ref | non-current local heads, tags, eligible `refs/stash`, and remote-tracking refs | yes, ref by ref, subject to reachability and design-43 ownership guards |
| config | design-93 allowlisted remote URLs, fetch refspecs, and branch upstream/rebase settings | yes, through its existing receiver-owned transaction |

The current engine does not run `git checkout` or `git reset` during apply. File
sync has already installed working-tree bytes; `applyGitState` imports objects,
publishes refs and HEAD, atomically installs the incoming index, and restores
operation state. “The checkout follows” therefore means Git metadata catches up
to already-applied bytes. The Git phase must not rewrite working-tree bytes.
That fact is load-bearing for ignored-path safety; any future implementation
that introduces a worktree-writing Git command must return to design review.

“Remote-tracking state” means both sides of Git's tracking model:

- design-93 config (`remote.*`, `branch.*`) in the config plane; and
- actual `refs/remotes/*` tips/symbolic remote HEADs in the ref plane.

Today `isSyncableRef()` deliberately rejects `refs/remotes/*`. Design 116
changes that contract explicitly rather than pretending the state already
travels. The encrypted Git section gains a distinct `tracking` field and
the manifest schema advances from 4 to 5. This is additive to, and does not
relax, design 43's `[v2]`–`[v6]` safety rules.

```ts
type TrackingRef =
  | { kind: "direct"; oid: string }
  | { kind: "symbolic"; target: string }; // refs/remotes/<remote>/<name>

interface GitSection {
  // existing fields unchanged
  /** Absent = legacy/no assertion. Present = complete, including empty. */
  tracking?: { sourceSequence: number; refs: Record<string, TrackingRef> };
}
```

Validation requires schema `>= 5` whenever `tracking` is present; caps the
map within the existing overall ref bound; permits only normalized
`refs/remotes/<valid-remote>/<valid-name>` keys; confines symbolic targets to
that same remote-tracking namespace; rejects cycles, NUL, `..`, duplicate
case-folded names, and invalid OIDs. Old clients reject schema 5 loudly via the
existing `KNOWN_MANIFEST_SCHEMA` gate. The rollout upgrades the founder fleet
together before schema-5 authorship is enabled. Field absence is never
delete-all: it means the writer did not participate in this lane. A present
empty `refs` map is the only complete-empty assertion.

The commit stamper emits schema 5 iff any section carries `tracking`; schema 4
remains valid when none do. After the reader floor enables authorship, capture,
base-carry, pending carry, 409 retry, 422 recovery, manifest-delta fold, and
versions restore all preserve `tracking` verbatim. No flag arm strips it. A
legacy/schema-4 incoming section makes no tracking mutation, so it cannot erase
a previously observed local tracking namespace by omission.

Remote-tracking refs are common-store state. Pointer/scoped sections cannot
independently snapshot and replay that shared namespace—the same fan-out would
recreate design 43's `[v2, B2]` stash bug. Capture planning therefore groups
discovered repos by resolved `commonDir`, takes one bracketed tracking snapshot
per group under the common-dir lock, and gives every newly authored member the
same `tracking` value and `sourceSequence`. Carried older members may retain an
older value.

**Tracking is capture dirt in its own right (r1 F4).** `gitIdentity` and the
§43 carry matrix do not see `refs/remotes/*`, so without a dedicated
predicate a tracking-only change (a fetch, a remote force-push) would carry
the old section forever and the LWW convergence claim would be vacuous. The
planner computes a canonical per-common-store `trackingKey` (hash of the
normalized tracking map) per group and compares it with the newest tracking
assertion carried by the group's base sections. A mismatch makes the group's
authoring member re-author with a fresh snapshot and restamped
`sourceSequence` even when Git identity is otherwise carry-clean. The
fingerprint/divergence caches must either incorporate `trackingKey` into
their trusted summaries or be bypassed for this decision, and
`gitDivergenceStatus` mirrors the same predicate so `rbox status` cannot
report "in sync" over unpublished tracking truth.

Apply groups incoming sections by the receiver's resolved commonDir and chooses
one tracking assertion for the group: greatest valid `tracking.sourceSequence`,
then lexicographically smallest repo key as a deterministic tie-break. The
source sequence is the candidate commit's `parentSequence + 1`, restamped only
when that tracking snapshot is freshly authored; carried assertions retain
their original sequence. A 409 rebuilds against the new parent before retry,
and pull rejects an assertion whose source sequence exceeds its authenticated
manifest commit sequence. This uses the sync stream's LWW order, never wall
clocks. It commits that complete map once, transactionally, under the
common-dir lock — transactional means all-or-none success, not atomic
observability: a concurrent reader may see a subset mid-commit (documented
`update-ref --stdin` behavior); rbox's own proofs run under its
serialization and never read mid-transaction. Thus an older carried
pointer section cannot regress a newer sibling assertion, and apply order is
irrelevant. When pointer-origin sections materialize as independent standalone
repos, each standalone common store receives its section's assertion; if those
stores later diverge, `sourceSequence` last-writer-wins resolves
them when they converge into one shared store again. A test pins that
cross-shape trace and two idle cycles; if it oscillates, `tracking` does not
ship and remote-tracking remains config-only until a separate store lane is
designed.

Index closure joins the bundle contract (r7): `git stash create` fails on an
unmerged index, so a partially resolved conflict's staged resolution blob can
be reachable from no WIP root and absent from `AUTO_MERGE` — in no bundle
link at all. Schema-5 capture therefore enumerates every OID in the staged
index (all stages, plus resolve-undo and sparse entries) and pins any not
already reachable into the capture-unique scratch namespace before bundling,
using the existing scratch-ref discipline. A section must never ship an
index artifact whose stage entries are not object-complete in its bundle
chain; capture defers when it cannot prove that.

Tracking refs never participate in `refScope` deletion semantics. A selected
present map is complete and last-writer-wins, including deletions; a displaced
unique tip is first retained under the local recovery namespace. Capture pins
every direct tracking tip into the verified bundle closure (using the existing
capture-unique scratch-ref discipline), including tips not reachable from the
current branch. Incremental-chain `tips` account for them as well; a section
must never advertise a tracking OID whose object closure is not in its bundle
chain.

## The applied-manifest oracle

### Ground truth

The oracle is not the old HEAD. It is the file manifest whose actions have
successfully landed on this receiver:

- during the current pull: the validated incoming `remote` manifest, after all
  file actions and the post-rule `.rboxignore` matcher have completed; and
- on a later pending retry: `SyncState.lastSyncedManifest.files`, the persisted
  applied file base installed by `saveStateSource`.

This reuses the existing state model. There is no second “expected checkout”
database and no inference from mtimes, Git status text, or the old commit.

### Exact comparison

The proof must not re-walk the workspace (r2 F3). Pull already holds a
complete pre-apply scan, the exact applied action list, and the stat/dircache
tokens; the post-apply receipt is **derived**: expected disk state = pre-apply
scan ⊕ applied actions, verified per repo subtree — directory inventory via
the existing dircache tokens, content identity re-hashed only for entries the
actions touched or whose stat tokens changed. Only a token mismatch widens to
a real re-scan of that repo subtree (never the workspace), and an unprovable
widening is `indeterminate`. File actions and their on-disk visibility
complete before any oracle work begins, so file-plane propagation
(publish→bytes-on-disk) is untouched; the rig gate below measures that
explicitly, and Git-follow work is off the file plane's critical path by
construction. For each repo, project both the
derived receipt and oracle to the repo subtree and compare:

- path presence and absence, including unignored extras;
- entry type;
- file content hash;
- symlink target; and
- executable mode.

Generated time and mtime do not participate. `.git/**`, rbox internals, and
paths excluded by the final `.rboxignore` matcher are removed symmetrically.
“Modulo `.rboxignore`” means ignored bytes do not block follow; it does not
authorize Git to write them. Since the Git phase is metadata-only, ignored
human files remain byte-for-byte untouched and may correctly appear dirty
against the newly installed index afterward.

For safety, a parent repo's oracle projection includes ordinary file-plane
paths under nested repos. A parent Git index could name those paths; assigning
them only to the deepest repo would under-protect the parent. Nested `.git`
metadata remains excluded by the built-in rules. This may conservatively block
a parent when a child has human-local dirt, which is preferable to clobbering
it.

Path comparison is byte-exact first, with an explicit receiver-filesystem
equivalence model (r1 F2): case-insensitive and Unicode-normalization-aliasing
behavior (APFS in this fleet) is **probed** at runtime, never assumed. When a
scan spelling and an oracle spelling differ only under the probed equivalence,
equality must be proved through filesystem identity of the single underlying
entry; two oracle-projected paths that collide under receiver equivalence, or
an incoming Git index naming receiver-colliding paths, are unprovable. The
oracle scan's own deferred-path set must be empty for the repo's projection —
a path the scanner deferred (permission/IO churn) is missing from the proof,
not proof of absence.

Unreadable paths, scan-deferred paths, scan churn, hashing failure, ambiguous
type changes, receiver path-equivalence collisions, or an
unprovable projection produce `indeterminate`, which defers the checkout as
human-local protection. Per-entry stat tokens are insufficient because they
cannot detect a newly created path. The derived receipt retains directory
inventory tokens; after all artifact, ref-plane, and config work, the checkout
commit boundary re-proves the SAME oracle result for that repo subtree via
entry-plus-directory inventory token comparison, widening to a real scoped
re-scan of only that subtree when any token moved (r2 F3: this boundary proof
is per-repo, token-first, and never a workspace walk).
Create/delete/rename churn and absent-path appearance therefore invalidate the
proof, not only edits to known files.

At that same boundary the engine runs the ordinary `gitBusy` probe **before**
creating its own locks, then acquires/reserves the index lock and expected-old
ref transaction. Lock acquisition failure is the post-probe race guard. Once
held, an ownership-aware busy probe ignores only the exact lock tokens owned by
this operation and still rejects every other Git lock; the current generic
`gitBusy` cannot be called naively because it would see rbox's own `index.lock`/
ref locks and self-defer forever. Under those locks the engine snapshots HEAD,
index, op-state, stash, and current tip again and re-runs every base/incoming
and graph predicate. Only then does it atomically commit the checkout subset;
index publication uses Git's lockfile/rename convention. A mismatch aborts
without checkout mutation.
The linearization point is this second proof while the checkout locks are held:
an edit completed before it is protected; an edit begun afterward is a new
post-follow edit, and the Git phase never rewrites its bytes. Git has no global
lock for arbitrary third-party filesystem writes, so the design does not claim
to serialize a hostile process that ignores Git locks; this is the same local-
attacker boundary design 43 accepts. Tests inject file create/delete/rename and
`git add`/commit/stash/op-state races on both sides of the linearization point.

### File equality is necessary, not sufficient

File sync never owns B's `.git/index`, per-worktree operation state, refs, or
stash. Those require separate provenance checks:

- **index:** safe when B's index identity still equals the prior applied Git
  base, is absent with no prior index, or already equals the incoming index;
  otherwise it is human-local staged state and checkout defers;
- **operation state:** safe under the same base-or-incoming rule, field by
  field; a locally started merge/rebase/cherry-pick is human-local;
- **current tip:** after the incoming bundle is decrypted, verified, and
  imported to scratch refs, safe only when B's attached current branch tip or
  detached HEAD is reachable from the incoming-ownership roots defined below;
  and
- **stash/non-current refs:** each mutation has its own reachability check. A
  receiver-only tip is protected even if the working tree matches the oracle.

“Index identity” is a versioned canonical semantic projection, not current
`indexTree` and not raw index bytes. `GitIndexIdentityV2` sorts every cache entry
by path/stage and records path bytes, stage, mode, OID, intent-to-add,
skip-worktree, assume-unchanged, and sparse-directory semantics, plus semantic
resolve-undo/sparse extension content. It excludes stat-cache fields,
fsmonitor/untracked/cache-tree/EOIE/IEOT performance extensions, padding, and
serialization version noise. The same parser projects live, prior-base, and
incoming indexes. Schema-5 captures stamp the projection hash beside the index
artifact; repo state caches the last successfully applied projection. A legacy
base derives it once from the decrypt-verified base index artifact and then
persists it—failure is `indeterminate`, never permission to overwrite. Tests
cover staged modes/OIDs, conflict stages, intent-to-add, skip-worktree,
assume-unchanged, sparse index entries, semantic extensions, and benign stat/
fsmonitor refreshes.

Split indexes are normalized before either hashing or transport; the wire never
carries a dangling `link` extension. Capture brackets/copies the live index,
then uses Git with a private `GIT_INDEX_FILE` and the source resolved gitdir to
run `update-index --no-split-index` against that copy. Git may read the source
`sharedindex.<oid>` but must write only the private candidate; before/after
tokens prove neither live index nor shared index changed. The resulting
self-contained full index is the artifact encrypted, projected, and installed
on B. If normalization cannot be proved stable, capture defers. A real
split-index round trip asserts flags/stages/semantic identity, no receiver
`sharedindex` dependency, and no source mutation. Adding shared-index artifacts
to the wire is explicitly rejected for v1 because pointer worktrees can share
them and would recreate a common-store ownership transaction.

Object presence in the imported bundle is not enough. Scratch WIP/pseudo-ref
pins, incremental-basis objects, and an object that already happened to exist
locally are not durable incoming ownership. There are two explicit graph
proofs:

1. **Incoming ownership:** roots are incoming HEAD (detached OID or its branch
   tip), incoming heads/tags/eligible stash, selected direct tracking tips, and
   commit-bearing incoming op-state roots. A receiver tip absent from this
   reachability set is local-only. Held/recovery/scratch refs are excluded.
2. **No-drop postcondition:** start with the planned durable ref graph after
   deletions/replacements, then include held receiver refs and recovery refs
   created by this mutation. Every protected receiver tip must remain reachable
   there. Scratch names are excluded.

The current checkout follows only when its tip passes incoming ownership. The
same ownership + no-drop pair runs per ref before deletion/replacement.

**Connectivity discipline (r1 F5).** Both proofs are complete-closure walks,
not tip-presence checks. They run with lazy/promisor fetch disabled
(`GIT_NO_LAZY_FETCH`/equivalent), peel tag roots explicitly, and treat every
missing object, peel failure, or walk error as `indeterminate` — defer, never
"unreachable". A shallow receiver store (shallow markers in the common dir)
defers the checkout plane, matching capture's structural refusal. The
incremental pack-chain import's link skip (advertised tip already present)
proves tip presence only; the ownership/no-drop walks must independently
verify closure over the roots they consult or defer.

For dir repos, protection enumerates every receiver `refs/stash` reflog OID,
not only the current stash tip. Older stash entries are often reachable only
from that reflog. A receiver-only stash holds the user-visible stash ref/stack
and defers checkout; before any eventual stash replacement/deletion, every
displaced reflog-only OID is pinned under
the content-addressed recovery namespace (`refs/rbox-local/keep/<oid>`, r2
F8) in the same ref transaction. Ordinary
apply retains design 43's existing wire meaning: it transfers the incoming
stash tip and creates one receiver reflog entry, not the sender's full reflog.
Pointer repos still never publish/capture stash. Tests use multi-entry local
and incoming stacks and assert `git stash list`, pop-ability, and reachability.

The old Git base remains useful only for proving whether receiver-owned Git
metadata changed locally. It no longer classifies synced working bytes as
human divergence.

## Follow decision

The checkout plane follows exactly when all of these are true:

```text
treeMatchesAppliedManifest
AND indexIsBaseOrIncoming
AND opStateIsBaseOrIncoming
AND currentTipHasNoLocalOnlyCommits
AND no design-43 ownership/busy/containment/artifact refusal
```

An already-converged incoming state remains a no-mutation success. A stale
branch is safe even when its name or OID differs from incoming, provided its
tip is reachable from the **incoming-ownership roots** defined above. Recovery
or held refs can prove no-drop but can never authorize checkout follow. That is
the field-incident shape: B's old branch contains no work A does not already
have, so B follows A instead of manufacturing a conflict.

Disposition examples:

| Working bytes | Local Git metadata | Current tip | Result |
|---|---|---|---|
| equal to applied manifest, dirty only vs old HEAD | unchanged from old base | contained by incoming | **follow** |
| equal to applied manifest | locally staged/mode-only index change | any | defer checkout: `local-index` |
| equal to applied manifest | locally started operation | any | defer checkout: `local-operation` |
| differ from applied manifest | any | any | defer checkout: `local-edits` |
| equal to applied manifest | base-clean | receiver-only commits | defer checkout: `local-commits` |
| equal to applied manifest | receiver-only non-current branch/tag | current tip safe | **follow**; hold that ref and advance unrelated refs |
| equal to applied manifest | base-clean | detached stale tip contained by incoming | **follow** |
| equal to applied manifest | receiver-only stash tip | otherwise safe | defer checkout: `local-stash`; stash ref does not move |

Reason precedence for one-line visibility is `local-edits` > `local-index` >
`local-operation` > `local-commits` > `local-stash` > operational reasons. All
guards are evaluated; precedence is display-only.

**Legacy conflict checkpoints are re-proved once (r2 F5).** Today a
`gitNeedsResolution` entry whose recorded identity still equals the live key
returns unconditionally before any other classification, and capture carries
the checkpointed base — a checkpoint stamped by an incident-era false
conflict would bypass the oracle forever. On a 116 client's first encounter
with a persisted checkpoint (and once per newer incoming identity), the full
follow classifier runs FIRST: if the frozen divergence proves sync-induced
(oracle passes, index/op-state base-or-incoming, tip incoming-owned), the
checkpoint clears and the checkout follows; genuine human divergence keeps
the checkpoint and today's suppression semantics, with the re-proof outcome
recorded per `incomingKey` so the check is idempotent, not a per-tick cost.
The remote-absence divergence examination (design 43 §13.5) keeps
`localDivergedFromBase` unchanged — it guards a preserve-vs-clear decision on
metadata only, never a checkout move, and 116 does not touch it.

## Independent ref-plane progress

### Prepare before mutate

As today, every bundle/index/op-state artifact is fetched, decrypted, hashed,
validated, and imported under private scratch refs before any mutation. The
engine then builds one mutation plan with a checkout subset, a safe ref subset,
a held ref subset, and a config disposition.

The current checked-out branch ref is always part of the checkout plane. It is
never moved independently of HEAD/index/op-state. For every other incoming
head/tag/stash/tracking ref:

1. apply design-43 scope and pointer filters first;
2. test whether replacing/deleting the receiver ref would make any receiver-
   only commit unreachable;
3. publish a safe ref immediately;
4. hold a human-local stash or otherwise user-owned local ref in place; and
5. for remote-tracking last-writer-wins replacement, transactionally pin a
   displaced unique tip at
   the content-addressed recovery namespace (`refs/rbox-local/keep/<oid>`,
   defined below) before advancing it.

Deleting or force-replacing a ref also destroys its reflog, and reflog-only
commits (a pre-force-push tracking tip, an amended head) can be reachable from
nowhere else (r1 F6). The stash rule therefore generalizes: before ANY
ref-plane deletion or non-fast-forward replacement, the engine enumerates that
ref's reflog OIDs and pins every entry not reachable from the planned durable
graph under the recovery namespace, in the same ref transaction as the
displaced-tip pin. Pins are **content-addressed** (r2 F8):
`refs/rbox-local/keep/<oid>` — one ref per OID, create-only (expected-absent;
an existing identical pin is an idempotent no-op, so repeated NFF churn on
the same displaced history never duplicates), with a sidecar record mapping
oid → a **multi-origin set** of (original ref, episode, time) entries
(r3 F7). Origin classes are ordered: human (heads, tags, stash, current
checkout) dominates tracking, and promotion is monotonic — a pin that ever
acquires a human origin is permanent, even if it was first created by a
tracking displacement. Because tracking refs are LWW remote mirrors whose
force-replacement is routine, pins whose origin set is **tracking-only**
carry a bounded retention policy: pruned after a
fixed age (default 30 days, config-overridable) once unreferenced by any
journal or deferral episode. Pins with any human origin are never age-pruned
— the existing no-prune rule stands for them, and the retention sweep must
re-read the origin set under the common-dir lock at prune time. Promotion is
ordered for crash safety (r4 F3): the human origin is durably persisted
(atomic sidecar write) BEFORE the ref transaction that displaces the human
ref commits. A crash between the two leaves an orphan human-origin record —
harmless over-protection: the sweep never prunes an OID with a human origin,
and orphan records (no pin exists) are garbage-collected only when provably
unreferenced. The reverse order would let retention prune the sole
protection of a displaced human branch whose promotion never landed.

The recovery namespace is excluded from capture and ordinary identity exactly
like existing `refs/rbox-*`. It is surfaced with recovery instructions. The
only pruning design 116 defines is the tracking-only-origin retention above;
pins with any human origin are never age-deleted (r3 F7 — no contradiction:
"no pruning" applies to human-work protection, not to LWW tracking debris).
Creating a recovery ref is not a substitute for checkout protection. Current
branch and local stash remain held in their user-visible locations when their
human work blocks them.

Design-43 rules still win where they are stricter:

- pointer targets never publish stash/tags and never move a branch checked out
  by a sibling worktree;
- a filtered incoming HEAD branch defers the checkout as before;
- all-scope deletion occurs only on dir repos;
- remote absence never mutates local `.git`; and
- containment, busy, structural, and artifact refusals remain fail-closed.

“Ref-plane always advances” therefore means **always attempt every independent
safe ref in the same pull**, not “override a local-only-commit or worktree-
ownership guard.” One held ref cannot freeze unrelated safe refs.

### Partial-apply state

Partial progress cannot be represented by the current indivisible
`gitPendingRemote` entry alone. Add local-only, per-repo state to the design-93
generation-CAS `RepoRecord`:

```ts
interface GitPartialApply {
  incomingKey: string;                 // hash of every mutation-relevant field
  checkoutPending: boolean;
  appliedRefs: Record<string, { kind: "direct"; oid: string } | { kind: "symbolic"; target: string }>;
  heldRefs: Record<string, "local-commits" | "local-stash" | "ownership">;
  configApplied: boolean;
  /** Prior canonical config needed for a three-way retry after Git base moves. */
  configBase?: Record<string, string[]>;
}

interface GitDeferral {
  lane: "apply" | "capture" | "config";
  deferredSince: string;               // continuous until fully clear
  reasonSince: string;
  lastSeen: string;
  subjectKey?: string;                 // incomingKey for apply; local probe for capture
  reason: GitDeferralReason;            // closed enum
  checkout?: { kind: "branch" | "detached"; label?: string };
  /** r4 F9/r5 F2: working bytes changed while this deferral stood —
   * sender-local, restart-surviving; blocks the clean aggregate. */
  bytesChanged?: boolean;
}

// RepoRecord field: independent episodes can coexist.
type GitDeferrals = Partial<Record<GitDeferral["lane"], GitDeferral>>;
```

`incomingKey` is a canonical hash over every normalized mutation-relevant
section field: HEAD, ordinary refs, tracking direct/symbolic values, index,
op-state, config, scope, and artifact-chain identities. It is not the current
`gitIdentityKey`, which omits tracking/config/blob addresses. It is local
correctness state, never telemetry. `label` is a short local display value,
never a SHA. `gitPendingRemote` continues to carry the
complete newest incoming section; push carries it verbatim and suppresses
capture under design 43 `[v5]`. The repo's Git base does not fully advance until
checkout and every protected incoming ref disposition are complete. The config
lane advances/retries through independent markers and does not hold a safe Git
base transition.

On retry, the partial record makes already-published refs idempotent and
prevents those rbox-authored mutations from being mistaken for new human
divergence. A newly arriving section replaces the partial plan with a plan for
the newer truth. Remote absence clears pending, partial, and deferral state
under `[v6]`, records removal memory where required, and never touches local
Git. A pending 422 keeps the existing `[v6]` non-looping drop/refresh behavior.
No unchanged or “refs already match” shortcut may clear pending while the
checkout or a protected required ref is still held.

`appliedRefs` is a crash-recovery hint, never authority over live Git. Under the
common-dir lock, every retry and state save re-reads every recorded direct/
symbolic ref and compares it with the exact recorded value. If a human moved a
ref after partial publication, the marker is invalidated and that live tip goes
through incoming-ownership/no-drop classification; it is held or recovered,
never overwritten because state says rbox once applied it. Tests inject a
non-current ref move after partial publish, before state save, and after crash
before retry.

The config plane runs its design-93 receiver-owned transaction independently of
checkout follow. Its `cfgApplied/cfgToken/cfgSynced` transition and partial-ref
result land in the same per-repo CAS packet. A config failure does not roll back
already safe refs **or a safe checkout**. The Git base may advance while the
unchanged-shortcut's existing config-due predicate keeps retrying the config
lane. Because `cfgApplied/cfgToken/cfgSynced` are hashes/tokens and cannot
reconstruct design 93's three-way merge base, a failed due transaction stores
the prior bounded canonical `baseSec.config` in `GitPartialApply.configBase`
before advancing the Git base. Retry passes that exact value to
`applyConfigTransaction`; completion or a permanent policy skip clears it in
the same CAS transition. A newer incoming config retains the original pending
base until the transaction completes, while `incomingKey`/repo base identify
the newest target. Permanent ownership/shape/invalid-field policy skips never
block checkout; transient receiver-owned config failures are visible as config
deferrals but likewise do not make safe Git metadata stale. This is a
deliberate split of design 93's current combined Git+config rollback unit; the
lockfile, ownership, value grammar, and sync-point rules remain unchanged.

## State transitions and crash safety

Per repo, one pull performs:

```text
file apply completes
  -> derive post-apply oracle receipt (token-verified per repo subtree)
  -> decrypt/verify/import all Git artifacts
  -> classify human-local metadata and graph reachability
  -> atomically publish each safe non-current ref / recovery pin
  -> run config transaction if due
  -> write checkout journal (old bytes + incoming section)
  -> pre-commit connectivity/fsck proof over the planned durable graph
  -> prepare ref transaction + index lock; repeat oracle + metadata proof
  -> if still checkout-safe: commit refs+HEAD, publish index, restore op-state
  -> flip journal to published; save global file base + repo state/deferrals
  -> clear journal
```

The existing workspace mutex spans the operation. On filesystems where the
mutex degrades (lock/link unsupported — the same bucket that already disables
the config lane), follow and independent ref-plane publication are DISABLED
(r2 F7): degraded mode has no serialization for journal ownership or ref
classification, so the checkout keeps the legacy `=0`-equivalent disposition,
journal recovery still runs (rollback-only), and visibility remains
unconditional. Ref updates use Git's
expected-old-value transactions and common-dir serialization. The second proof
is intentionally after potentially slow ref/config work and immediately before
the checkout commit. A crash after a
safe ref update but before state save is recovered by comparing the exact
incoming value on retry; the update is idempotent and the old ref was either
not unique or was pinned first.

**Checkout journal (r1 F1; rebuilt r2 F1/F2).** `applyGitState`'s
snapshot/rollback boundary is in-process only: refs, HEAD, index, and
op-state are separate filesystem mutations, and a power failure between them
cannot run `restoreLocal`, whose old index/op-state bytes live only in
memory. The checkout subset therefore adds a durable two-phase protocol.
Before the first checkout-plane mutation, the engine persists a **checkout
journal** under the workspace state dir
(`.rbox/state/git-journal/<repo-key-hash>/`, atomic write; workspace-owned so
it exists for fresh materializations before any gitdir does, and is
per-worktree-keyed so pointer repos sharing a common store cannot collide):

- the verbatim incoming `GitSection` (small — refs, HEAD, artifact
  descriptors) and its `incomingKey`;
- **byte-exact durable copies** of the old index and every old op-state file
  (a projection hash cannot reconstruct them), plus the old current-ref OID
  and HEAD form;
- **exact expected-NEW identities** (r3 F5): the hash of the transformed
  candidate index bytes actually staged for publication (post-normalization,
  post-resolve-undo-clear — NOT the wire `indexSha`), a per-op-state-file
  new-hash/absence map, and the new ref/HEAD values, so old/new/third
  arbitration is well defined per field;
- **incarnation binding** (r3 F2): the sync stream id, state nonce, and the
  resolved gitdir/commonDir realpaths plus worktree identity it was written
  against. Recovery requires an exact binding match; any mismatch (reset,
  rebind, a different repo now at that key) retires the journal to
  quarantine WITHOUT touching the repo. `resetSyncState` disposes the journal
  directory under the same lock that resets state;
- a created-fresh flag when this apply materializes a new `.git`, and — on
  the clean-materialization path — the **complete pre-wipe syncable ref map**
  (r3 F3): `quarantineAndWipeGitState` deletes non-current refs the field
  model above cannot see, so the wipe variant journals every deleted ref
  (name → OID) and rollback restores them all; the quarantine bundle remains
  defense in depth, not the recovery mechanism.

The journal is **two-phase** (r3 F1). It is written in `intent` phase before
the first checkout mutation; after the entire checkout publication (refs,
HEAD, index, op-state) completes, an atomic marker flips it to `published`
BEFORE the state save. Recovery of an `intent` journal is **rollback-only**
(r2 F2): restore the journaled old index/op-state bytes (and, for the wipe
variant, every journaled ref) and move the current ref/HEAD back with
expected-current semantics; the ordinary retry then re-attempts follow with
every proof from scratch. Recovery of a `published` journal keeps the new
checkout — the Git mutation is complete and only the state save is owed. That
save is NOT a replay (r4 F1): the `published` journal records the intended
per-lane post-record and the expected `repoGen`; recovery first runs a
semantic already-applied check (repo base advanced to this `incomingKey` →
just clear the journal), and otherwise composes a FRESH generation-CAS packet
from the current live records merged lane-wise with the journal's outcome —
stale field values are never replayed over lane transitions that landed after
the crash, and an already-landed save never advances `repoGen` again. This ordering makes
the r3 F1 trace impossible: state can never claim an incoming section applied
while recovery would still roll the checkout back, and a rolled-back checkout
always leaves state that still owes the apply. Roll-forward of Git state
never happens: working bytes are not
journaled, so completing the move without re-running the full file oracle
could bless a human edit made in the crash window as sync-authored.
A live field matching neither journaled value means a human
intervened mid-crash: that field is left untouched, the journal is retired to
the recovery namespace, and the repo takes the ordinary conflict path.
A created-fresh `intent` journal never deletes (r4 F2 — "still exactly
rbox-authored" is not decidable against hooks, loose objects, or arbitrary
third-party gitdir writers, and any scan-then-delete has a race): recovery
atomically RENAMES the entire partial `.git` into the workspace quarantine
area, restoring the no-mutation contract while preserving whatever a human
may have added in the crash window, and surfaces the quarantine path. The
in-process `removeFreshGit` cleanup inside a single uncrashed apply call
keeps its existing design-43 contract; the rename-to-quarantine rule governs
post-crash recovery only. If
the journaled old bytes are unreadable/corrupt, recovery defers with the
journal intact and surfaces loudly — it never guesses. Journal recovery runs
under the repo's common-dir lock and the workspace mutex, like the mutation
that wrote it. A crash
must never leave the current branch moved with old HEAD/index, or HEAD/index
moved without the verified file oracle, without a journal that makes the next
run repair it. Kill-injection tests cover every boundary: after safe refs,
after journal write, after the pre-commit connectivity proof, after prepare,
after the ref-transaction commit, after index publication, mid op-state
restore, between the published-marker flip and state save, before journal
clear — plus a human edit and a human ref move injected inside the crash
window, a reset/rebind with a surviving journal, and a crash mid
clean-materialization wipe.

**Lock protocol and capability floor (r1 F3; hardened r2 F4).** "Acquire the
checkout locks" is pinned to this sequence: (1) normalize/stage the candidate
index privately (the resolve-undo clear runs against the staged candidate via
a private `GIT_INDEX_FILE`, never `git update-index` on the live index);
(2) run the connectivity/fsck proof **now, pre-commit** — incoming objects
are already imported under scratch refs, so the closure of the planned
durable graph is provable before any ref moves; (3) open one
`git update-ref --stdin` transaction carrying expected-old values for every
checkout-plane ref update, including HEAD via `symref-update` (verified old
symbolic target); (4) `prepare` — this takes the ref locks; (5) create
`index.lock` via O_CREAT|O_EXCL; (6) run the second oracle + metadata proof
using **lock-free reads only** — direct file reads and plumbing that takes no
locks; no Git command that acquires index/ref locks may run between prepare
and commit; (7) on proof failure: `abort` the transaction, remove the owned
`index.lock`, remove the journal, defer — an explicit, tested path; (8) on
success: `commit` the ref transaction FIRST, while `index.lock` is still
held; (9) write the candidate index bytes into the owned `index.lock` and
publish by Git's own convention — rename `index.lock` → `index`; (10) restore
op-state, flip the journal to `published`, save state. Holding `index.lock`
across the ref commit is the writer reservation (r3 F6): no human `git add`
can install a competing index anywhere inside the mutation window, so a
crash there provably contains no human index write and journal rollback of
the index bytes is safe. The new-refs/old-index interleaving a concurrent
`git status`/IDE may observe between (8) and (9) is transient display dirt,
not loss, and is pinned by a test. Op-state files have no native lock; a
human racing operation-state creation inside this same held-lock window is
the accepted design-43 local-attacker boundary, restated here explicitly. No
post-commit fsck rollback exists anymore (the connectivity proof ran at (2)),
so the r2 F4 clobber trace (user
commits after lock release, unconditional restore discards their tip) is
structurally gone. Any in-process failure after the ref commit repairs
through the journal's expected-current arbitration — never through
`restoreLocal`'s unconditional ref writes. `symref-update`
inside `--stdin` transactions requires a modern Git; the engine probes the
capability once per binary+git-version and on an unsupported Git defers the
checkout with a typed `unsupported` reason (legacy disposition) rather than
running a weaker partial protocol. The ownership-aware busy probe (defined at
the oracle's checkout boundary above) ignores exactly the lock tokens this
sequence created and nothing else.

## Visibility

The current state stores only a pull-side pending section; reason and age vanish
with the log line, and push-side `GitPushPlan.deferred` is not persisted at all.
Every apply, capture, and config episode now stores an independent
`GitDeferrals` entry in the authoritative repo record.

Closed reason enum:

```text
local-edits | local-index | local-operation | local-commits | local-stash
conflict | git-busy | worktree-ownership | ignored-target | unreadable
artifact | config | containment | unsupported | other
```

`deferredSince` is preserved per lane across newer incoming identities/local
probe values and reason changes for as long as that lane never reaches a fully
non-deferred state. This is the chronic age displayed to the user: a busy
workspace cannot reset “14d” to minutes by publishing another blocked section.
`reasonSince` resets when the closed reason class changes; `lastSeen` advances
on retry. Success, convergence, or remote absence clears the apply age. A
conflict checkpoint does NOT clear it (r5 F3): a new or re-proved-genuine
`gitNeedsResolution` checkpoint is an unresolved condition, so it holds an
apply-lane deferral with reason `conflict` and continuous age until actual
resolution — a local identity change, a `rbox git resolve` verb, or remote
absence. The checkpoint's early-return suppression never makes the repo
ambiently invisible. Capture age clears only when that planner row captures/carries
successfully or the repo is intentionally removed; config age clears on
completion or permanent policy skip.

`planGitSections` returns typed capture dispositions. As soon as planning
settles—and before upload/commit/mass-delete/network work—the operation saves
only the capture-lane set/clear transitions through the existing sidecar-only
generation-CAS path, with no global manifest/base claim. This save is required
for every push shape, not only no-op/base-carry: a later upload, 409, network,
mass-delete, or commit failure cannot erase the fact that capture deferred.
Clearing likewise records that the local capture blocker is gone; it does not
claim the remote publication succeeded. The later successful-commit packet
merges rather than recreates these fields, under an explicit ordering rule
(r2 F6): a lane-only save **never stamps an unaccepted global sequence** — it
carries the loaded accepted sequence, and `GitDeferral` lanes merge per lane
(each lane's own `lastSeen`/episode identity), excluded from any whole-record
`sourceSeq`-newer-wins comparison. A deferral recorded against a candidate
commit that later fails can therefore never make a genuine same-sequence
transition read as stale; acceptance remains the existing `expectedRepoGen`
CAS with reload-recompute-retry. Apply and capture episodes may
coexist and both render. Validation forces a capture defer followed by a
post-plan push failure, restart, newer remote truth, and eventual clear.

`rbox status` prints the existing aggregate and one line per deferred repo,
oldest first:

```text
git-sync: 12 repos synced · 1 deferred
  git deferred 14d: local edits on branch release/0.9 (repo)
```

Detached state renders `detached checkout`; it never prints an OID. The daemon
emits the same concise line after the state save that made the episode durable,
then only on reason transition and coarse age-boundary changes (1h, 1d, 7d,
14d, 30d) to avoid per-tick spam. Visibility is unconditional even when the
follow feature is killed.

Privacy boundary: local status and local daemon logs may name the local repo
and branch, as the operator needs them to resolve the block. Metrics, analytics,
support diagnostics, and uploaded reports contain only counts, closed reason
enums, and coarse age buckets—never repo paths, branch/ref names, commit OIDs,
incoming identities, or free-form Git errors. The diagnostics log collector
must redact these new local forensic lines to `{reason, ageBucket, count}`
before upload. This filter covers **all** current and legacy Git
defer/conflict/partial log forms, including existing
`git-sync deferred <rel>: <free-form reason>` lines—not only the new renderer.
Adversarial diagnostics tests inject paths, branch/ref names, control
characters, OIDs, and raw Git errors and prove none survive the uploaded
payload. If structural redaction cannot prove that, diagnostics omit the Git
log lines and upload only the aggregate typed projection.

`rbox status --json` exposes a stable local `git.deferrals[]` shape with repo,
reason, `deferredSince`, `reasonSince`, age seconds, and checkout kind/label; it
omits OIDs and raw errors. This is local command output, not telemetry.

## UX: irreconcilable divergence (founder-set direction)

Post-follow-rule, the only deferral class left standing is true human
divergence: local-only commits, or human dirt on both sides. Three normative
decisions govern it; mechanics below are reviewable, the direction is not.

**1. Surface it ambiently, everywhere the user already looks.** The typed
deferral (reason + continuous age) renders on all three existing ambient
surfaces: the macOS menu bar (`RboxBarAmbientStatus` gains the deferred-repo
count and oldest age, design 88), `rbox status` (the per-repo line already
specified in Visibility), and shell integration (design 46: the prompt
segment shows the deferral when the shell is cd'd into that repo's subtree).
The v1 `shell.line` record is one workspace-wide line, its parser accepts
only `v1` and treats trailing fields as the workspace name, and its default
path spawns no subprocess (r4 F8, r5 F4) — so `shell.line` itself is NOT
extended. A **separate** sidecar, `shell.deferrals` (versioned `v1` of its
own), carries one line per deferred repo: percent-encoded rel-path,
reason class, age bucket, and the `bytesChanged` flag, tab-separated. Only
new plugin versions read it, via pure-shell `$PWD` matching against the
decoded rel-paths — on path-component boundaries only, selecting the
longest enclosing repo (r6 minor: `repo` must not match `repository`, and
nested repos resolve to the deepest) — no per-prompt subprocess, preserving
design 88's ≤5 ms budget; the sidecar is row- and byte-bounded, with
malformed/oversized fixtures validated against that p99 gate; old plugins
never open the file and render exactly today's line. All three surfaces read the
same authoritative repo-record deferral state; no fourth
bookkeeping source. The same privacy boundary applies: repo/branch names
render locally only.

**2. The file plane never freezes for a divergent repo.** Files keep
converging while the Git plane defers, deliberately. The trade is explicit:
`.git` is never file-synced, so the divergent human work — local commits,
branches, stash, index — is structurally untouchable by file sync; colliding
working-file edits are already protected by conflict copies (design 50);
and freezing a repo's files would reintroduce compounding per-repo drift,
which is the disease this design exists to cure. A frozen repo diverges more
every hour it waits for a human, making eventual resolution harder — the
opposite of the founder principle. Working bytes on a deferred repo may
therefore be newer than its checkout; the deferral line says so.

The stale-porcelain hazard is named, classified, and surfaced (r4 F9;
scoped honestly r5 F2): a
user who runs `git reset --hard`/`git checkout -- .` against the deferred
old HEAD restores old bytes, and the file plane publishes them as ordinary
deliberate edits — LWW file semantics, working as specified; the displaced
newer content stays recoverable in version history. What the SENDER must
never do is call that state fully in sync: a deferred repo whose working
bytes change while the deferral stands sets `bytesChanged: true` on its
persisted `GitDeferral` record (a schema field, restart-surviving), rendered
on every local surface, and the workspace aggregate cannot report clean
while any repo carries it. The marker is deliberately **sender-local, not
transported**: on a receiver the resulting state — tree matching the applied
manifest but dirty against the followed checkout — is indistinguishable from
a legitimate unstaged sender edit and is treated identically (ordinary
post-follow dirt); inventing wire semantics to distinguish them would add
schema surface without a decidable receiver-side test. Design 50's conflict
copies do not cover this path and are not claimed to.

**3. One-command exit: `rbox git resolve <repo> [show-me|take-theirs|
keep-mine]`** (verb positional, default `show-me`; `--json` output;
non-interactive confirmation via `--confirm <token>` where the token is the
snapshot identity `show-me` printed — r4 F11). Deferral must never be a dead
end. Implementation may be phased; semantics are fixed:

- `show-me` (default): summarizes the divergence — local-only
  commits (tips absent from the incoming-ownership roots, with subjects),
  incoming checkout target, oracle dirt classification, index/op-state/stash
  divergence, and the deferral age — and prints the snapshot identity token.
  "Read-only" means the `rbox status` footprint (r4 F10): no user-visible
  refs/index/op-state/worktree mutation; identity probes may add unreferenced
  objects (`git write-tree`), and ownership inspection may import into
  scratch refs, exactly as status/apply preparation already do.
- `take-theirs`: follow the incoming checkout DESPITE local divergence.
  The confirmation is a complete lock-bound CAS (r4 F5): the snapshot
  identity covers the incarnation (stream + nonce), `incomingKey`, `repoGen`,
  the full live ref map and reflog tips, HEAD, the semantic index
  projection, op-state map, stash reflog OIDs, and the oracle receipt hash.
  Execution quarantines first (capture-grade bundle + index/op-state copies,
  the §43 conflict discipline), pins every local-only tip and stash reflog
  OID as human-origin recovery pins, then runs the NORMAL follow pipeline —
  journal, locks, second proof — with the human-divergence gates waived
  only for divergences enumerated in the confirmed snapshot; the snapshot is
  revalidated at the ordinary second-proof boundary under the checkout
  locks, and ANY state not in the snapshot (new dirt, a new op-state, a
  moved ref, a replaced incoming section) aborts and re-shows. The
  resolution episode (verb + snapshot identity) rides the checkout journal,
  so crash recovery attributes it correctly. Pointer/ownership rules are
  design-43-strict (r4 F7): stash pinning applies only to owning dir repos —
  a pointer repo never touches the shared stash namespace; a
  sibling-worktree collision remains a refusal, and the verb reports it as
  an actionable result naming the sibling (resolution happens there), not a
  silent no-op. Under `RBOX_GIT_FOLLOW=0` the verb STILL WORKS: the kill
  switch disables oracle-AUTHORIZED automatic movement, and an explicit
  human-confirmed resolution is manual authorization through the same
  machinery — stated in the flag section too. Metadata-only like every
  follow: working bytes are never rewritten; local edits survive as ordinary
  dirt against the new HEAD.
- `keep-mine`: make local the truth. Ordering is protect-then-clear
  (r4 F6): first fetch, decrypt, closure-verify, and import the discarded
  pending/incoming section's artifacts and pin its tips locally — incoming
  heads, tags, checkout tips, stash roots, AND every commit-bearing incoming
  op-state root are **human-origin (permanent) pins**: they are another
  human's work, and server-history retention is not
  a substitute (r4 F4); only the section's tracking entries take tracking
  provenance. Pins alone cannot hold the section's index and op-state — they
  are artifacts, not refs (r5 F1) — and byte copies alone are unusable once
  their referenced objects are GC'd: a staged resolution blob may be
  reachable only through the capture WIP root, and `AUTO_MERGE` can name a
  tree, not a commit (r6 F1). The protect step therefore retains, in the
  workspace quarantine area, the **decrypt-verified incoming artifact files
  themselves** — the full bundle chain (self-contained closure by
  construction: capture pinned WIP/pseudo-ref roots into it) plus the index
  and op-state bytes — never relying on the repo object store to keep the
  discarded section's objects alive. Because legacy (pre-r7) sections may
  predate the index-closure bundle contract, the protect step VERIFIES
  closure — enumerating the retained index artifact's stage OIDs against the
  retained chain — and packs any missing objects still present locally into
  a supplementary quarantine pack; if closure cannot be completed, keep-mine
  refuses (protect-then-clear holds: no clear without closure), leaving the
  explicit loud override as the only path (r7). A staged conflict resolution
  or paused
  operation that existed only in the discarded section survives keep-mine
  byte-exactly and object-complete. The episode record naming these
  quarantine artifacts is durable and survives the deferral/checkpoint clear
  (r6 minor): `show-me` and recovery instructions can locate them until the
  operator explicitly discards the episode. Only after those pins land does the verb clear the
  deferral/checkpoint — and that clear rides the SAME accepted-commit state
  transition as the force-captured push, so a failed import, capture,
  network error, or rejected commit leaves the deferral (and its ambient
  warning) fully intact. A 409 means someone published meanwhile: the verb
  re-fetches, re-shows, and requires a fresh confirmation rather than
  retrying blindly. If the pending artifacts are no longer fetchable, the
  verb refuses keep-mine until a pull refreshes pending or the operator
  passes an explicit, loudly-logged override acknowledging the incoming
  section cannot be locally preserved. `keep-mine` weakens NOTHING on
  receivers: the other machine's apply still runs its own follow/no-drop
  classification, so a ref that exists only there is held and pinned there,
  never silently deleted by this machine's `refScope:"all"` section — the
  other machine then shows its own deferral until resolved there
  (receiver-local resolution is inherent, not a livelock: no mutation
  ping-pong occurs and both sides surface).

## Flag and rollout

`RBOX_GIT_FOLLOW` is default **ON**:

- unset, `1`, or any value other than exact `0`: the applied-manifest oracle can
  authorize checkout follow;
- exact `RBOX_GIT_FOLLOW=0`: checkout uses the legacy pre-116 identity-
  divergence disposition. It never treats the oracle as permission to move.
  An explicit human-confirmed `rbox git resolve take-theirs` still works
  under `=0` (r4 F7): the switch kills oracle-authorized AUTOMATIC movement;
  manual, snapshot-confirmed resolution is human authorization through the
  same journaled machinery.

Safe ref-plane progress, tracking/config lanes, typed deferrals, and visibility
are unconditional in both arms. This follows the requested flag boundary: the
kill switch stops the new checkout-follow decision, while “ref plane always
advances” remains true when follow cannot run. A schema-5 section under `=0`
can therefore never be falsely acknowledged: its tracking lane applies (or is
recorded partial), and checkout/base clear only according to the legacy gate.

Schema-5 authorship is controlled by the reader-first release stage, not this
runtime safety switch — through a concrete interlock (r1 F8): a checked-in
build constant (`GIT_TRACKING_AUTHORSHIP`, alongside the release version
gate), shipped `false` in the reader-stage release and flipped only in the
follow-up release after the fleet crosses the schema-5 reader floor. It is
not an env var and cannot be toggled at runtime. Every stamp site — capture,
base/pending carry, 409 rebuild, 422 recapture, and versions restore — must
consult it, pinned by a static test that enumerates the sites and by tests
proving no path emits schema 5 while the constant is false. Once flipped,
tracking authorship remains enabled in either flag arm; rollback is by feature
behavior, not by emitting a lossy schema-4 rewrite. Readers remain schema-5
capable permanently after rollout.

Founder ship-live sequence:

1. Ship schema-5 readers, partial-state readers, and unconditional visibility
   to every founder host while schema-5 authorship remains release-disabled.
2. Verify mixed schema-4 reads, legacy pending state, status, and kill-switch
   behavior on the dev fleet.
3. Enable default-on authorship/follow in the next CLI build and upgrade all
   daemons together.
4. Run the field reproduction and two idle cycles. Keep `=0` available as the
   live kill switch; do not roll binaries below the schema-5 reader floor.

No user-facing opt-in is added. Safety comes from proof, not from leaving the
promise disabled.

## Validation

### Phase 0 — prove the incident path

Evidence first, scrubbing second (r1 F7): stop the daemon on the affected
host, then take an immutable, permission-restricted RAW snapshot — state.json
(repo records, pending, needs-resolution, removal memories, generations),
daemon logs, the exact released binary/version, HEAD/refs/reflogs, index and
op-state metadata, every lockfile, manifest meta, and the trash inventory.
The OIDs, ref spellings, and identity keys inside it are exactly what
distinguish the candidate mechanisms; the privacy-scrubbed archive is derived
FROM that snapshot, never taken instead of it. A daemon retry, log rotation,
or a cleared sidecar can silently destroy the chronic state and leave only a
lookalike to reproduce.

Before any historical bisect, check the live current-code candidates against
the snapshot: a `gitNeedsResolution` checkpoint whose recorded identity still
equals the live key (the unconditional early return in
`applyGitSections`), the busy-probe defer loop (including an editor- or
crash-created stale lockfile), and pending-carry capture suppression. Then
reproduce the chronic defer with the incident release/state and make the test
fail for the same persisted reason/transition. Record the release commit and
bisect
whether the refusal is in an older dirty-tree gate, identity/base state,
pending/needs-resolution suppression, ownership, or another path. If current
HEAD already follows the exact sync-dirt case, retain that passing regression
and scope the incident fix to the reproduced blocker. The oracle is still the
normative proof that distinguishes an unstaged B edit from synced bytes; it
must be added/used as that safety decision without being falsely credited for a
different incident mechanism. The founder-set semantics and visibility/ref-
plane requirements still apply regardless of the bisected site.

### Generated disposition matrix

For each incoming topology—same-branch fast-forward, branch switch, and
detached HEAD—generate all 16 combinations of these receiver postures:

```text
syncDirt        ∈ {0,1}  // dirty vs old HEAD, but equal to applied manifest
humanDirt       ∈ {0,1}  // tree differs from applied manifest
localCommits    ∈ {0,1}  // current tip absent from incoming-ownership roots
localStash      ∈ {0,1}  // receiver-only stash work
```

That is 48 principal cases, and the principal set is not the whole state
space (r1 F9). `indexDiverged` and `opStateDiverged` join as crossed
dimensions, and pairwise coverage is required across
`{syncDirt, humanDirt, localCommits, localStash, indexDiverged,
opStateDiverged, incomingStash, trackingOnly, configOnly, schemaMix,
pointerShape, legacyBase}` × `{ff, switch, detached}` — the fully-crossed 48
remain the core, the pairwise closure catches interaction cells. Every
checkout mutation boundary additionally gets a crash-injection row (after
safe refs, after journal write, after the connectivity proof, after prepare,
after index publication, after ref commit, mid op-state, before journal
clear, before state save),
plus receiver path-equivalence alias rows (case and Unicode-normalization)
and a scan-deferred-path row. Checkout follows iff `humanDirt=0`,
`localCommits=0`, `localStash=0`, index/op-state are base-or-incoming, and no
operational guard blocks it. `syncDirt` never changes that answer. A
receiver-only stash is local-only commit evidence: it holds the stash ref and
defers checkout while unrelated safe refs still advance. No case may delete or
hide it. Add a separate incoming-stash row to prove A's stash advances when B
has no local stash divergence.

Every matrix case asserts:

- working bytes are unchanged by the Git phase;
- symbolic versus detached HEAD form exactly matches the expected disposition;
- current branch/tip, semantic index identity, mode-only staging, op-state, and
  eligible stash state are correct;
- safe non-current heads/tags and tracking refs advance on deferred rows;
- protected refs and every receiver-only commit remain reachable;
- config/upstream state advances or has a typed config defer;
- base, pending, partial, removal, resolution, and deferral records are exact;
- retry/restart is idempotent and preserves `deferredSince`; and
- clearing the local blocker lets the pending checkout follow without another
  remote commit.

### Safety and compatibility cases

- staged-only edit with working bytes equal to the oracle;
- mode-only index edit;
- local merge/rebase/cherry-pick state;
- non-fast-forward current tip already contained by another incoming tip;
- attached→detached and detached→attached transitions;
- modify/create/delete/rename after the first oracle scan; `git add`, commit,
  checkout, stash, and op-state creation before the checkout linearization
  point; the same operations after it remain ordinary post-follow work;
- unignored extra, delete, chmod, symlink/type flip, unreadable file, and scan
  churn;
- ignored human file stays byte-identical and does not block metadata follow;
- pointer repo, sibling-worktree branch collision, shared common-dir locking,
  and pointer stash/tag filters;
- local-only non-current ref, local-only remote-tracking tip, symbolic remote
  HEAD, and recovery-ref atomicity; a receiver-only non-current branch/tag is
  held and reachable while the safe checkout follows;
- human moves a partially applied non-current ref before state save and across
  crash/retry; live state wins over the partial hint;
- remote absence while partial, pending-only absence, pending 422, artifact
  failure, and config failure after safe ref progress;
- design-43 removal-memory and needs-resolution paths unchanged;
- schema 4↔5 validation/stamping, old-reader loud refusal, reader-first rollout,
  and `RBOX_GIT_FOLLOW` unset/default/invalid/`0` arms;
- visibility transition/continuous-age rendering across newer incoming
  sections, restart persistence, JSON shape, daemon de-duplication, and
  structural diagnostic redaction of legacy and new Git log lines.
- chronic push-side busy/unreadable/preflight/capture deferral through no-op
  base carries, restart, newer remote sections, and eventual clear.

Primary homes are `src/cli/sync-git/git-sync.test.ts`, the engine Git tests,
`src/cli/sync-state.test.ts`, `src/cli/e2ee-sync.test.ts`,
`src/cli/status-{cmd,view}.test.ts`, and daemon/diagnostics tests.

### Rig and live field gate

Extend `scripts/rig/scenarios/git-entanglement.ts`. Its current churn adds an
untracked file, which does not reproduce this bug because Git identity ignores
untracked bytes. The new round must modify an already tracked file while A
moves HEAD, then let B's file plane land the bytes before Git apply.

Pinned live scenario:

1. B starts on a stale branch/commit; that tip is reachable from A's incoming-
   ownership roots and B has no human-local work.
2. A modifies a tracked file and performs each of: same-branch FF, branch
   switch, and detached-HEAD move.
3. One B sync lands files first and Git metadata second.
4. B ends with A's HEAD form, current tip, index/op-state, safe refs, tracking
   refs, and config; `gitPendingRemote`/partial/deferral are absent.
5. Two idle cycles publish zero sequences and produce no deferral.
6. Repeat with a B-local edit, local commit, staged-only change, and stash; each
   remains byte-for-byte/reachability safe while unrelated refs advance and the
   aged reason is visible.

Validation is complete only after a dev CLI build is shipped to the local
fleet or `bun run rig` exercises the scenario. Unit tests alone do not close
the field incident.

## Implementation map

| Area | Change |
|---|---|
| `src/cli/sync/pull.ts` | build the post-file applied-manifest oracle once; pass proof/tokens into Git apply; persist typed outcomes atomically |
| `src/cli/sync-git/apply.ts` | replace old-HEAD tree divergence with the follow predicates; orchestrate checkout/ref/config planes and partial retries |
| `src/cli/sync-git/plan.ts` | pending/partial carry remains newest-remote; capture tracking refs/index projection under schema 5; emit/persist typed capture deferrals even on no-op base carry |
| `src/cli/sync-git/shared.ts` | flag parser, ref-plane classification, canonical incoming/partial keys |
| `src/cli/sync-git/status.ts` | keep outbound divergence mirror; add read-only typed deferral projection rather than treating pending as invisible |
| `src/engine/git/*` | staged import/mutation plan, graph reachability, per-ref transaction/recovery pins, tracking-ref capture/apply, checkout transaction |
| `src/engine/types.ts`, `manifest-validate.ts` | schema 5, canonical index identity, and bounded `tracking` wire shape |
| `src/cli/config.ts`, `sync-state.ts` | `RepoRecord` partial-apply, config retry base, and per-lane deferral fields under existing generation CAS |
| `src/cli/status-cmd.ts`, `status-view.ts` | human and JSON age/reason surfaces |
| `src/cli/daemon/*`, `activity.ts` | durable post-save daemon line; no correctness state in best-effort activity.json |
| diagnostics | redact new forensic lines to counts/enums/age buckets before upload |
| rig/tests | 48-case principal matrix, race/compatibility cases, tracked-file field reproduction |

If implementation adds or changes ownership of a module under
`src/cli/sync*`, `src/cli/daemon*`, or `src/engine/`, the same change updates
its one-line owner/non-owner entry in `docs/CODEMAP.md`.

## Non-goals and residuals

- No server/API/D1 change: Git sections remain inside the encrypted manifest;
  schema 5 changes only client-encrypted content.
- No automatic merge/rebase of genuinely divergent human work.
- No pruning policy for human-work `refs/rbox-local/*` pins (heads, stash,
  current-checkout recovery) in this design; tracking-plane pins alone carry
  the bounded retention defined in the ref-plane section (r2 F8).
- No worktree-byte mutation by the Git phase.
- No weakening of structural preflight, ignored-target containment, mass-delete,
  E2EE, or design-43 lifecycle rules.

The post-apply proof adds work to pull, bounded by the derived-receipt rule
(r2 F3): token verification per repo subtree, re-hash only for action-touched
or token-moved entries, subtree-scoped widening. The rollout's rig gate must
measure publish→bytes-on-disk propagation before and after and show it
unchanged, and record the pull wall-time delta, before default-on ships. The
residual cost is bounded local I/O off the file plane's critical path. The
field incident's residual cost was an indefinitely wrong checkout.
