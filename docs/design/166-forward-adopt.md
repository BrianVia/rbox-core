# 166 — adopt-by-overlay: non-empty joins converge through the normal pipeline

Status: v5 — pending delta verification
Owner: Claude (founder-directed 2026-07-19: highest priority)
Severity: core adoption flow — binding a machine whose content is ahead is
currently safe-but-parked with no manual escape (`keep-mine` unimplemented).

## Problem (unchanged from v1; field evidence)

Rig scenario `scripts/rig/scenarios/git-join-ahead.ts` (the gate): machine B
joins a workspace with the same repo on disk, shared history, two commits
ahead, plus an untracked file. Today: B's git plane parks
(`local-commits` hold → pending-carry suppresses capture forever), the file
plane reverts B's newer working copies to A's older bytes (conflict
siblings preserve the data), and the fleet never converges. Root cause of
the wedge shape: B's content exists BEFORE any baseline, so no plane can
classify it as "changes since the workspace state" — the engine's entire
safety model keys off exactly that classification.

## Layer decision and v5 invariant

Adoption remains join-time orchestration. The layer is still the reason the
design works: init temporarily retains B's pre-join tree, establishes A as a
normal joined BASE through the existing default first sync, and then presents
B's state as post-BASE local change. v1's engine-side forward-carry composer
remains abandoned; classification, reconcile, wire format, and BASE authority
remain with the normal sync pipeline.

v3 removes v2's false equivalence between replacing a repository directory and
editing a repository in place. The phase-2 filesystem and `.git` incarnation
never get swapped out. Adoption has two explicit, non-destructive planes:

1. The Git plane considers B's branches from an admitted, self-contained stash
   repository but fetches only the exact journaled 40-hex OID of an individually
   proven-fast-forwardable branch, with `--no-tags`. It then advances that
   existing baseline branch only when scope, ownership, and compare-and-swap
   checks still match the journaled proof. No in-repository adoption namespace
   exists; every other value from an admitted Git source remains solely in its
   retained stash repository.
2. The file plane walks B's retained tree and overlays leaf entries one at a
   time. A colliding baseline leaf is moved to a journaled displaced tree before
   B's leaf lands. A type collision never evicts the baseline namespace.

The only sync-engine boundary additions are operational safety hooks: the
global adopt fence and explicit cache invalidation/full rescan. They do not add
a new merge, capture, ancestry, or publication authority. This preserves the
layer rationale accepted by both round-2 reviews while removing the repository
incarnation contradiction (`REVIEW-166-R2A.md` findings 1 and 5;
`REVIEW-166-R2B.md` findings 1 and 2).

The selective branch import and retained-stash boundary fold
`REVIEW-166-FINAL.md` finding 1.

The exact-OID fetch, checked-out-branch eligibility gate, and phase-0 refusal of
external pointer sources close `REVIEW-166-V4-DELTA.md` findings 1, 2, and 3.

Terminology below uses **A** for the workspace baseline materialized by phase 2
and **B** for the machine's pre-join content retained under `.rbox/adopt/`.

## Lifecycle

### Phase 0 — eligibility, consent, inventory, and journal publication

Before moving a byte, init:

- proves that the invocation is in the narrow scope below and holds a healthy,
  non-degraded workspace mutex;
- obtains a typed adoption-consent witness from the interactive caller or the
  explicit headless `--adopt` flag;
- validates `.rbox/adopt` and every control-path component with no-follow
  `lstat` checks;
- inventories the pre-join tree without following symlinks, records Git roots,
  leaf types and identities, rejects traversal through a symlinked parent, and
  refuses an unreadable or mount-point source before the first move;
- computes headroom using the honest peak: the full B tree retained in the
  stash plus the full A baseline live at the same time; and
- writes and fsyncs the typed journal and its parent directory before the first
  namespace mutation.

Special files are inventoried for reporting but are never opened or followed.
The overlay policy below decides their final disposition. The inventory is
revalidated entry by entry immediately before mutation; the mutex excludes
sync owners, while the identity check detects unrelated local writers
(`REVIEW-166-R2A.md` findings 3, 9, and 11).

For every Git root, preflight uses the existing shape probe to record whether
the source is a self-contained ordinary directory repository or a linked-
worktree/pointer repository, plus its resolved worktree/Git/common-directory
incarnation. Finding any linked-worktree or pointer-repository source refuses
that adoption invocation at this phase, before journal publication or any move,
and leaves the entire pre-join source in place without snapshotting it. The
command reports exactly: `linked worktree not adopted — its history travels
with its main clone`. Only self-contained ordinary directory repos and plain
files adopt; this source-shape rule does not alter the already-folded D2
treatment of non-repository file-plane entries. A separate invocation on the
self-contained ordinary main clone remains eligible and adopts normally
(`REVIEW-166-V4-DELTA.md` finding 3).

The admitted ordinary-repository inventory is only a candidate list: the no-
follow and realpath containment proof in phase 3 runs again immediately before
every repository mutation (`REVIEW-166-FINAL.md` findings 2 and 4).

### Phase 1 — retain B aside

Move the pre-join content, excluding the adoption control directory, into
`.rbox/adopt/stash/` on the same filesystem. This is a one-way retention step,
not a directory replacement decision: no retained repository or content
directory is later swapped back over A. The journal records each move and its
exact before/after identities. The stash remains a usable local fetch source
for eligible branch discovery, the sole parking/reporting surface for every
other Git value, and a source of file-plane leaves. `rbox adopt status` reads
the retained repositories directly; it does not need a live adoption ref
namespace (`REVIEW-166-FINAL.md` finding 1).

If any preflight or revalidation fails, no later entry moves. If the journal
already exists, init never starts a second adoption; it routes the user to
`rbox adopt status|resume|abort`.

### Phase 2 — establish the normal baseline

Run today's empty-root `init --workspace` join with the default
`firstSync=sync`. This materializes A, establishes the file BASE, repo records,
Git BASEs, config-lane state, and repository identities through existing code.

The global fence is already active. Only the adopting process may cross it,
using a private typed continuation whose single-use nonce and consumption state
are persisted in the journal and bound to the journal id, workspace, stream,
phase, and exact healthy mutex incarnation. The top-level baseline call consumes
the nonce once and propagates an invocation-local, unforgeable capability to
its nested pull/push fence checks. Borrowing that capability inside the same
call is not a second consumption; replaying it as another top-level call is
rejected. A wrong phase or binding, a degraded/lost/released mutex, or a
substituted mutex handle is rejected. No public command can construct the
capability. After a crash, only `rbox adopt resume` may invalidate the old nonce
and persist a fresh bound nonce, and only after durable journal validation and
acquisition of the exact healthy lock (`REVIEW-166-FINAL.md` finding 8).

### Phase 3 — Git fetch-union, never a repository swap (D1)

Phase 0 guarantees that every repository reaching this phase has a self-
contained ordinary source.

For each repository discovered in B's stash, open the baseline repository at
the same workspace-relative path. Its worktree path, Git directory, common
directory, config shape, checkout-journal binding, and physical identity remain
the phase-2 incarnation for the entire adoption.

Here “fetch-union” is deliberately narrow: it means importing the object closure
named by one exact, durably journaled 40-hex OID already proven eligible for a
fast-forward, never importing B's object/ref universe or manufacturing a
parking ref in A.

Before any fetch, ref, or index mutation, perform a no-follow component walk of
the target repository path and prove that its realpath remains inside the
workspace, using the `src/engine/fsutil.ts:81-148` containment precedent.
Revalidate the phase-2 repository incarnation and prove that the admitted
self-contained source's worktree, Git directory, common directory, and object
store all remain inside the retained stash. Repeat these checks immediately
before each named mutation. A failed proof performs no mutation for that
repository: its complete B state stays parked in the retained stash and status
reports the refusal (`REVIEW-166-FINAL.md` finding 4;
`REVIEW-166-V4-DELTA.md` finding 3).

Classify repository and ref ownership without importing anything:

- An admitted B source is always an ordinary directory repository. It may
  consider each B branch for which the phase-2 repository already has the
  corresponding branch.
- If the phase-2 target is a pointer repository, it may consider only its scoped
  branch, as returned by the same scoped-ref rule used by `readScopedRefs`;
  branches, tags, and stash in the target's shared external store are outside
  this adoption target's ownership. The B source is never a pointer repository.
- For each candidate, resolve B's branch tip from the stash and the baseline old
  tip, then prove from the retained source repository that the old tip is an
  ancestor of the incoming tip. Equal is a no-op. Behind, diverged, unrelated,
  missing-baseline, probe-error, detached, tag, stash, and B-only-repository
  values are never fetched. They remain solely in the retained stash repository
  and are reported from there.

For the baseline repository's currently checked-out branch, eligibility is
gated before preparing, fetch, or any ref/index mutation. It is eligible only
when `indexTree == HEAD tree` and no operation state exists, including no
`MERGE_HEAD`, rebase, or equivalent in-progress state. Failure to derive the
index tree, a tree mismatch, or any operation state PARKS that branch in the
retained stash and reports it with no prepared fast-forward; no fetch, CAS,
index copy, or `read-tree` runs. The user finishes the merge/rebase or index work
and reruns `rbox adopt resume`, which may freshly run candidate classification,
ancestry proof, and this gate because no prepared operation or stale proof
exists. The working tree need not be clean. Non-checked-out branches do not use
this index gate (`REVIEW-166-V4-DELTA.md` finding 2).

Before fetching a fast-forward candidate, enumerate linked-worktree ownership
with the design-165 `branchesCheckedOutElsewhere` rule. A branch checked out by
another linked worktree is ineligible. Journal the exact incoming 40-hex OID
and expected-old OID, source-ordinary/target-directory-or-pointer scope, target
`HEAD`, sibling ownership set, and reflog/ABA fingerprint. This records the
proved candidate but does not yet publish a prepared ref/index mutation.

Only after all of those proofs and, when applicable, the checked-out-branch
gate, fetch the exact journaled proved OID with the equivalent of:

```text
git fetch --no-tags --no-recurse-submodules --no-write-fetch-head \
  <stash-repo> <journaled-40-hex-oid>
```

The 40-hex argument requests only the proved commit and its required object
closure; it creates no destination ref, and `--no-write-fetch-head` leaves
`FETCH_HEAD` untouched. `--no-tags` prevents auto-followed live tags, and
`--no-recurse-submodules` prevents configured child/network mutation. No
configured import-everything refspec is used. A source writer moving the branch
after proof is irrelevant: the moved-to tip is never requested and remains
absent from A's object store. If the proved object has disappeared or been
garbage-collected, the fetch fails and the repository PARKS before any target
ref or index mutation. Thus the baseline repository's ref set can differ from
its pre-adoption set only in the tips of branches that complete the following
journaled fast-forward (`REVIEW-166-FINAL.md` finding 1;
`REVIEW-166-V4-DELTA.md` finding 1).

At the prepared mutation boundary after fetch, recheck the target ref, `HEAD`,
linked-worktree ownership, reflog fingerprint, repository incarnations, and
containment, but do not dereference or require stability of the source branch
name. For a checked-out branch, also acquire the live index lock and repeat the
`indexTree == HEAD tree` and no-operation-state gate immediately before the pre-
operation index copy and ref CAS. Any target, ownership, reflog, incarnation,
or containment change persists a `paused` classifier state; it is never
reinterpreted as a fresh proof. Lock failure, a changed index tree, or newly
present operation state instead PARKS before CAS or `read-tree` and does not
advance the candidate to a prepared mutation, so the fresh-resume rule above
applies. Exact-OID objects already fetched in that case may remain harmlessly
unreachable. The successful path therefore rebuilds only an index that still
satisfies the gate at its mutation boundary (`REVIEW-166-FINAL.md` finding 2;
`REVIEW-166-V4-DELTA.md` findings 1 and 2).

Record every intended fast-forward, including exact before/after OIDs, durably
before `git update-ref refs/heads/<name> <incoming> <expected-old>`, and record
its result durably afterward. For a non-checked-out eligible branch, that CAS is
the only live-state mutation. A failed CAS enters a journaled pause: resume may
classify the recorded old value as not-started, the recorded new value plus the
expected reflog transition as completed, or any third/ABA/ownership state as a
continuing mismatch. It never silently retries or derives a new operation from
the stale ancestry proof. Abort likewise rolls back only by the recorded inverse
CAS and pauses on mismatch (`REVIEW-166-FINAL.md` finding 2).

For an eligible currently checked-out branch only, durably copy the pre-
operation index file (or an explicit absent-index state), its full hash, and
identity into the adopt area before the ref CAS. That retained copy is the
inverse. After the CAS, run lock-protected
`git read-tree --reset <post-ff-HEAD>` against the live index without updating
the worktree, and journal the resulting index identity. A crash before or after
the CAS/read-tree is classified from the saved index, exact ref/reflog
transition, and live index. Abort first rolls the branch back by its recorded
CAS, then identity-gated restores the exact saved index; a mismatch pauses.
Non-checked-out branches never touch an index. This does not transplant B's
index or operation-state files; those remain in its retained source repository.
An ineligible dirty-index or mid-operation A branch never reaches this rebuild
path (`REVIEW-166-FINAL.md` finding 3;
`REVIEW-166-V4-DELTA.md` finding 2).

B-only admitted ordinary repositories have no target incarnation to replace.
Their file-plane leaves may overlay as ordinary files, while their Git
administrative state is retained under the adoption area and reported as
unplaced Git state. The retained stash repository is the only reachability and
reporting surface for that state (`REVIEW-166-FINAL.md` finding 1).

Nested repositories require no ownership ordering: every Git union targets its
own already-materialized baseline repository, and the file walker excludes each
recognized Git administrative path from the file plane. No ancestor or child
repository directory is renamed.

This retains the already-folded nested-swap and incarnation decisions from
`REVIEW-166-R2A.md` finding 5 and `REVIEW-166-R2B.md` finding 2, and folds the
remaining ref-scope, ownership, and index inverses in
`REVIEW-166-FINAL.md` findings 2 and 3.

The exact-OID source read, checked-out eligibility gate, and phase-0 linked-
source refusal fold `REVIEW-166-V4-DELTA.md` findings 1, 2, and 3.

### Phase 4 — per-file overlay with retained collisions (D2)

Walk B's stash with no-follow `lstat` traversal and the containment guards used
by `src/engine/fsutil.ts:81-148`. Directories are namespace scaffolding: when
both sides are directories, descend and merge their children; never rename or
evict the directory as a unit. A missing destination directory may be created
after validating every parent, but populated directories are never installed
by rename.

For every non-Git-administrative leaf:

- **Destination absent:** rename B's leaf into the live path. This is a pure
  move; its stash slot empties after the durable journal transition.
- **Destination present, same leaf type:** first rename A's leaf to
  `.rbox/adopt/displaced/<path>`, fsync the affected parent directories, and
  then rename B's leaf into the live path. A's pre-join value is retained at an
  exact journaled location rather than overwritten or deleted.
- **Type collision (`file ↔ directory ↔ symlink`):** leave A at the live path
  and retain B at `.rbox/adopt/unplaced/<path>`. If B's side is a directory,
  retain its whole subtree there. Never evict a baseline directory to make B
  fit. Report the collision and both locations.
- **FIFO, device, or socket:** do not materialize it into the live tree. Retain
  or leave it in the journaled unplaced set and report the skipped special
  entry.

A-only live paths are untouched because the walk is driven solely by B's
entries. Moving individual leaves preserves B hardlink topology across the
batch; moving colliding A leaves into `displaced/` likewise preserves their
inodes and links. Every destination parent is revalidated immediately before a
rename, and a symlinked-parent escape is a hard stop, never a followed path.

This folds `REVIEW-166-R2A.md` findings 2, 3, 5, and 9. In particular, it
removes the A-only deletion and directory type-flip contradictions rather than
asking the normal sync to repair a namespace loss that adoption manufactured.

Each move above is an identity-gated, no-clobber `verify-then-rename` through
source and destination parent dirfds held with `O_NOFOLLOW` (or a proven
platform-equivalent primitive). The implementation re-stats through those held
directories and uses a no-replace rename when the journal requires an absent
destination; it never validates a raw path and then performs an overwriting
path-based rename. A destination created after the check or a parent exchanged
for a symlink produces a journaled pause, not an overwrite or escape
(`REVIEW-166-FINAL.md` finding 5).

### Exact-identity journal and crash protocol (D3)

`.rbox/adopt/journal.json` is a versioned, typed protocol, not a phase marker.
It binds the absolute/resolved workspace path, stream, adoption nonce, baseline
establishment state, single-use continuation consumption and mutex incarnation,
cache-generation state, Git repo/ref/index operations, and every file move.
Per-entry records contain the logical path, entry kind, intended source and
destination, displaced or unplaced location, operation state, and exact
observed identities. Every displaced or overlaid regular leaf gets a streamed
content hash regardless of size, plus the identity tuple
`(ino, size, mtimeNs, birthtime)`; `dev` and kind are recorded additionally,
and a platform without birthtime records an explicit unavailable value rather
than silently weakening tuple comparison. Symlinks include their link text and
kind. Ref records contain exact old/new OIDs, scope/ownership reservations,
reflog fingerprint, and CAS result. Index records contain the retained pre-op
copy/absence, before/after hashes and identities, and read-tree state
(`REVIEW-166-FINAL.md` findings 2, 3, 5, and 8).

V5 additionally records the exact proved source OID and the
`indexTree == HEAD tree` and no-operation-state eligibility observations. The
existing index-copy/read-tree fields are populated only for an eligible
checked-out branch (`REVIEW-166-V4-DELTA.md` findings 1 and 2).

Every physical transition follows the same ordering:

1. Persist and fsync the intended operation.
2. Revalidate the source, destination, and parents against the recorded
   identities.
3. Perform one dirfd-bound no-clobber rename, ref CAS, or other named mutation.
4. Fsync every changed source and destination parent directory with
   `fsyncDirectory`.
5. Advance and fsync the journal state.

On resume, the closed classifier compares the live names and full identities
with the recorded before/after states, following the reset-journal precedent at
`src/cli/reset-journal.ts:324-379`. An exact match may proceed or be recorded as
completed; any mismatch persists a `paused` state with exact paths and recovery
guidance. There is no size threshold, stat-only alias, or “presence means ours”
case. The classifier never overwrites or moves an unrecognized live value. The
crash model includes process death and power loss, including a rename visible
before its journal advance (`REVIEW-166-FINAL.md` finding 5).

The storage promise is correspondingly narrow and honest: at peak, all of B is
retained in the stash while all of A is live. Displaced and unplaced entries
move within that envelope; the design does not claim that only A-only content
needs headroom.

This folds `REVIEW-166-R2A.md` finding 3 and the containment/durability parts of
finding 9.

### Global adopt fence and completion boundary (D4)

The validated typed adopt record is a global workspace fence. Its check lives in
the shared workspace sync-mutex acquisition path: after acquiring and validating
the lock but before returning any mutation-capable handle, that single choke
point discovers and validates the adopt journal. It is not a per-command memo or
an optional caller check. Every mutating owner therefore refuses an incomplete
or physically unclassified adoption with `rbox adopt status|resume|abort`
guidance (`REVIEW-166-FINAL.md` finding 6).

The binding inventory includes daemon operations, one-shot sync, direct push,
direct pull, export, restore, versions-restore, Git resolve, `ignore --purge`,
chain repair, and recover, plus a repository assertion that every current or
future manifest publisher/applier acquires this same mutation handle. A daemon
starting after init crashes cannot publish a partially overlaid tree. The only
phase-2 exception is the private consumed continuation described above: its
invocation-local capability propagates through nested pull/push checks at this
same choke point. Validated adopt resume/abort receive only their phase-specific
recovery authority; no public sync owner can reuse either exception
(`REVIEW-166-FINAL.md` findings 6 and 8).

New adoption, resume, and abort refuse a degraded mutex
(`workspaceSyncMutexDegraded`); read-only status remains available. A
continuation also fails if its mutex is lost, released, degraded, or replaced.
The kill switch controls only whether a new adoption may start. It never
disables journal discovery, the fence, status, resume, abort, or clean for an
adoption that already exists (`REVIEW-166-FINAL.md` finding 8).

After the last Git and file operation is classified complete, adoption creates
an explicit scan-mutation boundary. It invalidates every overlaid, displaced,
and restored leaf in the hash cache; discards the workspace directory cache and
scan tokens; removes the persistent Git trackedness cache; rebuilds matchers
from the final live rule files; and requires the next scan to be full,
unpruned, and uncached. It then durably bumps a workspace cache generation.
Only after that invalidation and bump are durable may the journal enter
`complete`. Abort performs the identical invalidation and generation bump after
all inverse mutations classify complete and before the journal enters
`aborted`. A validated terminal record no longer fences sync
(`REVIEW-166-FINAL.md` finding 7).

Every resident daemon watches the durable workspace generation at its held-mutex
operation boundary. Before its first apply or publish at a newer generation, it
drops resident manifest/hash/directory/trackedness/matcher state, performs the
required full scan, and durably acknowledges the generation. This applies to a
generation produced by complete, resume, or abort; deleting disk caches alone
is never treated as a resident-daemon transition
(`REVIEW-166-FINAL.md` finding 7).

Thus the fence lifts after the local tree is coherent and before the finish
sync. The complete journal remains as the retention/status record until an
explicit clean; `complete` does not mean that the fleet has already published
or settled the changes.

This folds `REVIEW-166-R2A.md` finding 4 and `REVIEW-166-R2B.md` finding 1.

## Scope and consent (D5)

Adoption applies only when all of the following are true:

- the command is `init --workspace` joining an existing workspace;
- the root is non-empty and is not already bound;
- the join uses the default `firstSync=sync`; and
- the caller supplies a typed affirmative adoption witness.

Direct interactive init explains the baseline-first, fetch-union, file-overlay,
retention, and collision behavior and turns confirmation into that typed
witness. The setup wizard owns its prompt and passes the witness explicitly
even though its downstream init flags contain `no-interactive=true`. Declining
continues with today's join-in-place behavior. Direct headless init requires an
explicit `--adopt`; `--no-interactive` alone is not consent and preserves
today's behavior.

An already-bound root, including same-stream re-init, is not allowed to enter
or fall through the non-empty join route: `init --workspace` refuses with
guidance rather than pretending phase 2 established a fresh BASE. Adoption also
refuses `--pull-only`, `--no-sync`, and keyed/agent setup. `setup-keyed` retains
its existing explicit `--force` and pull-only contract; adoption cannot be
smuggled through its no-interactive call. Unsupported-mode refusals happen
before journal publication or content movement.

`init --new` is unchanged because its existing content is the workspace being
created, not state being adopted into an existing stream.

This folds `REVIEW-166-R2A.md` findings 6, 7, and 11 and the wizard-route part
of `REVIEW-166-R2B.md` finding 4.

## Finish sync semantics (D6)

Once cache invalidation is durable, mark the journal complete, lift the fence,
and invoke one ordinary `sync` (pull then push). This is an ordinary large-change
sync, not an adoption transaction or all-repository barrier:

- publication may use multiple manifest sequences or pull-first retries;
- repository capture remains bounded and concurrent exactly as it is today;
- one repository may defer or fail while another publishes; and
- a later ordinary sync may still be required for the fleet to settle.

Local adoption remains complete if that sync partially publishes or fails. The
command must report the ordinary sync results and say which changes remain
deferred or need another sync; it must not claim one-cycle convergence,
all-repository atomicity, or that retained data is safe to clean merely because
the journal is complete. The rig inspects state immediately after init's own
finish sync, before any extra pull or push can mask a missed mutation boundary.

This folds `REVIEW-166-R2B.md` findings 3 and 4.

## Recovery and retention commands (D7)

`rbox adopt status|resume|abort|clean` is a direct-path command family. It finds
and validates `.rbox/adopt/journal.json` from the supplied/current directory
without workspace-config discovery, so it works after a crash before
`workspace.json` exists.

- `status` is read-only. It reports phase/classification, incomplete operations,
  fast-forwarded branches, every retained-only Git value inspected directly in
  the stash repositories, skipped special files, type collisions, and every
  retained `stash/`, `displaced/`, and `unplaced/` location
  (`REVIEW-166-FINAL.md` finding 1).
  It additionally reports parked dirty-index/mid-operation branches
  (`REVIEW-166-V4-DELTA.md` finding 2).
- `resume` acquires a healthy mutex, revalidates the journal binding and all
  touched identities, invalidates any prior continuation nonce, and durably
  mints a fresh single-use nonce bound to the validated journal id, phase, and
  new exact mutex incarnation. It proceeds only from classifier output and works
  even when the new-adoption kill switch is set
  (`REVIEW-166-FINAL.md` finding 8).
- `abort` before phase 2 restores phase-1 stash moves to their exact original
  locations using the journal. After phase 2 begins, it keeps A as the live
  baseline: B-only overlaid leaves return to retained storage, displaced A
  leaves return to their live paths, and any fast-forwarded baseline ref is
  rolled back only by its recorded CAS. For the checked-out branch, successful
  ref rollback is followed by identity-gated restoration of the journaled A
  index; a ref or index mismatch pauses. Objects fetched for a proven branch may
  remain harmlessly unreachable in A's object store, while every non-imported
  Git value remains in the retained stash and is reported. Every inverse file
  move uses the same full identity and dirfd-bound no-clobber primitive; any
  intervening mismatch pauses rather than guessing. After all inverses classify
  complete, abort performs the cache invalidation and generation transition in
  D4 before it becomes terminal (`REVIEW-166-FINAL.md` findings 1, 2, 3, 5,
  and 7).
- `clean` is the only operation that clears retained adoption data. It is
  allowed only for a validated terminal (`complete` or `aborted`) journal,
  acquires the mutex, lists what will be removed, and requires an explicit user
  action; there is no automatic expiry in v1 of this feature.

Retention is local recovery, not a claim that remote versions can reconstruct
never-published B state.

This folds `REVIEW-166-R2A.md` finding 12, plus the recovery-classifier part of
finding 3 and the hidden-retention concern in `REVIEW-166-R2B.md` finding 4.

## Ignore independence (D8)

Adoption's file walk is ignore-independent. Every non-`.rbox` file-plane entry
is considered regardless of built-in ignores, `.gitignore`, `.rboxignore`, or
the workspace's `respectGitignore` setting. Recognized Git administrative paths
are excluded because D1 owns them, not because an ignore matcher excluded them.

Rule files themselves overlay under the same collision policy as any other
file. After the overlay, the completion boundary discards stale scan caches and
the persistent Git trackedness cache, rebuilds matchers from the final rule
files, and bumps the daemon-watched workspace generation before the full finish
scan, using the rule-file-first precedent in
`src/cli/sync/pull.ts:151-163`. Normal sync then decides which live files
publish. Adoption never uses A's old matcher to decide whether B's bytes are
restored (`REVIEW-166-FINAL.md` finding 7).

This folds `REVIEW-166-R2A.md` finding 10 and the stale-cache mechanism in
`REVIEW-166-R2B.md` finding 1.

## Safety properties

- **No Git replacement:** A's phase-2 Git incarnation stays live. Fetch is an
  object-store union; only ancestry-proved, CAS-guarded fast-forwards touch live
  branch refs. Divergent values stay locally reachable and reported from B's
  retained stash repository; no adoption ref namespace exists
  (`REVIEW-166-FINAL.md` findings 1 and 2).
- **No mutable-source import:** fetch requests only the exact journaled,
  ancestry-proved OID. A later source-branch tip is never requested and remains
  absent from A's object store (`REVIEW-166-V4-DELTA.md` finding 1).
- **No external-source capture:** linked-worktree/pointer sources are refused at
  phase 0 before journal publication or movement, and the invocation is left in
  place because their history travels with the main clone. Only a separate
  invocation on a self-contained ordinary source proceeds
  (`REVIEW-166-V4-DELTA.md` finding 3).
- **No manufactured deletion:** A-only paths are never overlay inputs and remain
  live. A colliding leaf moves to `displaced/` before B lands. A type collision
  leaves A live and B in `unplaced/`.
- **No guessed recovery:** exact identities plus ordered directory fsyncs close
  the rename-before-journal and intervening-writer cases. Every regular leaf is
  content-hashed and every destructive move is dirfd-bound and no-clobber;
  ambiguity pauses (`REVIEW-166-FINAL.md` finding 5).
- **No partial publication:** any incomplete adopt record fences all normal sync
  owners in the shared mutex-acquisition choke point. Trackedness/hash/directory
  invalidation, a workspace-generation bump, and a full-scan requirement precede
  fence lift (`REVIEW-166-FINAL.md` findings 6 and 7).
- **No implied global commit:** the finish sync has ordinary best-effort,
  incremental semantics; local adoption completion and fleet settlement are
  reported separately.
- **Mixed-version safety:** no wire or manifest schema changes are required.
  Older machines observe only ordinary published file and Git updates; retained
  Git values stay under `.rbox/adopt/stash/`, outside every normal scan and
  capture surface (`REVIEW-166-FINAL.md` finding 1).

## Binding test matrix

Every row is mandatory. Unit tests own pure routing/classifier cases; integration
tests own filesystem, mutex, cache, and command behavior; the rig owns end-to-end
publication and fleet settlement. In row labels, `final-N` cites
`REVIEW-166-FINAL.md` finding N, and `delta-N` cites
`REVIEW-166-V4-DELTA.md` finding N.

| Area | Required scenario | Binding acceptance condition |
| --- | --- | --- |
| Forward gate (`final-1/2/3`, `delta-1/2`) | Existing `git-join-ahead`: B is two commits ahead with an untracked file; A's checked-out branch has `indexTree == HEAD tree` and no operation state | Init's own finish sync sees the overlay; the exact journaled OID is fetched, B's branch fast-forwards by journaled CAS, the saved-index inverse/read-tree completes, the baseline ref-set delta is exactly that branch-tip change, no conflict sibling appears for the ahead files, the untracked file publishes, A later fast-forwards, both records settle, and an idle cycle stays settled. |
| A-only survival (`r2a-2`) | A has a synced Git-untracked file absent on B | The file survives phase 4 and B's next push; no deletion appears locally, remotely, or on A. |
| File collision (`r2a-2/3`) | Same-type file and symlink collisions | B lands live, A is at the exact `displaced/` path, both identities match the journal, and abort restores A without losing B. |
| Type flips (`r2a-2/9`) | File→directory and directory→file/symlink in both directions | A stays live, B's complete leaf/subtree stays in `unplaced/`, no directory is evicted, and status reports both locations. |
| Literal selective fetch (`final-1`, `delta-1`) | Eligible ahead branch with source tags, submodule recursion configured, and a pre-existing `FETCH_HEAD` | Recorded argv has the exact journaled 40-hex proved OID, never a branch name, plus `--no-tags --no-recurse-submodules --no-write-fetch-head`; no tag/ref other than the final CAS branch tip changes, `FETCH_HEAD` is byte-identical, and no child or network access occurs. |
| source-moved-before-fetch (`delta-1`) | After incoming OID I is proved and journaled, the source branch moves to divergent D before fetch | Fetch still requests exact I; if present, only I's required object closure transfers. D is ABSENT from A's object store, no destination ref is created, and `FETCH_HEAD` is byte-identical. |
| source-moved-after-proof (`delta-1`) | The source branch moves to divergent D after exact-I fetch but before target CAS | The movement is irrelevant to the prepared proof and CAS, which can name only journaled I. D is ABSENT from A's object store and no unproved ref appears. |
| proved-object-GC'd (`delta-1`) | Journaled I disappears before exact-OID fetch while the source branch moves to D | Fetch fails and the repository PARKS retained and reported; no target ref/index mutation occurs, and D is ABSENT from A's object store. |
| Diverged branch (`r2a-1`, `final-1`) | B branch diverges from A and owns a unique object | Nothing from that branch is fetched into the baseline object store, `refs/heads/*` and the complete baseline ref set are unchanged, the retained stash repo still resolves the branch/object, status reports it from the stash, and finish sync never publishes it. |
| B behind (`r2a-8`, `r2b-4`, `final-1`) | B's branch is behind with B-only data and a Git stash | No Git ref/object import occurs; working-tree additions overlay; B's branch/stash/tags/extras remain reachable only from the retained stash repository, and status reports them before clean. |
| Detached HEAD (`r2a-8`, `final-1`) | B source repository has a unique detached HEAD tip | The tip is not fetched into the baseline object store, baseline refs and `HEAD` are unchanged, the retained stash repo resolves the tip, and status reports it from there. |
| Stash and tags (`r2a-8`, `r2b-4`, `final-1`) | B has `refs/stash` and annotated/lightweight tags with unique objects | None is fetched or creates a baseline ref; the retained stash repo remains their sole reachability/reporting surface, and the baseline ref set differs only by separately eligible fast-forwarded branch tips. |
| B-only repository (`final-1`) | B has a repository with no phase-2 target | No object/ref import occurs; its Git state stays in the retained stash repository, its eligible file-plane leaves overlay as ordinary files, and status reports the retained repository. |
| Nested repos (`r2a-5`, `r2b-2`) | Root/child/grandchild repositories with mixed ahead/diverged branches | Every union targets its original phase-2 incarnation, every file admin path is excluded from overlay, and no ancestor/child directory identity changes. |
| Pointer target scope (`final-2`, `delta-3`) | B is an admitted ordinary source and the phase-2 target is a pointer repository whose shared store has additional ahead branches, tags, and stash | Only the branch in the target pointer's scoped-ref ownership can become a candidate; no target shared-store extra is fetched or advanced, and status reports retained B source state. |
| linked-worktree source (`delta-3`) | One invocation targets a linked-worktree/pointer source; a separate invocation targets its self-contained main clone | Phase-0 inventory refuses the linked-worktree invocation before journal publication, move, or mutation, leaves it byte-for-byte in place, and reports `linked worktree not adopted — its history travels with its main clone`; the separate main-clone invocation adopts normally. |
| Linked-worktree ownership (`final-2`) | Eligible branch is checked out in a sibling worktree, then ownership changes during a prepared operation | `branchesCheckedOutElsewhere`, target `HEAD`, ownership, ref, and reflog are checked at preparation and mutation; sibling ownership refuses or pauses without fetching/updating the branch. |
| CAS/ABA classifier (`final-2`) | Probe error, actual CAS mismatch, concurrent checkout, third-value write, and old→third→old ABA around a prepared fast-forward | Each before/after transition is journaled; mismatch/ABA enters `paused`; resume never re-proves or retries the stale operation, recognizes `new` only with the expected reflog transition, and CAS-blocked abort also pauses. |
| conflicted-merge repo (`final-3`, `delta-2`) | A's checked-out branch has an unmerged/mismatching index or merge/rebase operation state at the initial gate, or that state appears before the prepared mutation-boundary recheck | The branch is PARKED retained and reported; initial failure occurs before fetch, and boundary failure after exact-OID fetch still occurs before CAS/index mutation. A's ref, exact index, worktree, and operation state remain unchanged, no `read-tree` rebuild runs, and resume freshly classifies only when no prepared fast-forward exists. |
| clean repo (`final-3`, `delta-2`) | A's checked-out branch has `indexTree == HEAD tree` and no operation state at both the initial and prepared mutation-boundary gates | The gate observations are journaled, the exact pre-op index/absence is copied and fsynced, exact-OID fetch and the journaled CAS complete, and `read-tree` targets post-FF HEAD without worktree writes; abort restores A's exact saved index after ref rollback. |
| Ref/index crash matrix (`final-3`, `delta-2`) | On an eligible clean-index/no-operation checked-out branch, kill after index copy, after ref CAS, during/after read-tree, and after journal advance | Resume classifies from the saved index plus ref/reflog/index identities and either safely finishes or pauses; post-index abort restores the old ref and exact old index without touching a non-checked-out branch index. |
| Git-plane containment (`final-4`, `delta-3`) | An admitted self-contained B repo path is below an A symlink to an outside repository; source or target incarnation changes before fetch/ref/index mutation | No-follow walk, realpath-inside-workspace/source-stash proof, and incarnation revalidation refuse before that repository mutation; the outside repo is byte/ref-identical and B remains reported in the retained stash. |
| Same-stream re-init (`r2a-6`) | Already-bound root invokes `init --workspace` for the same stream | The command refuses with guidance before journal publication or movement; it does not fall through to stale-BASE behavior. |
| Unsupported modes (`r2a-7`) | `--pull-only`, keyed/agent setup, and `--no-sync` attempt adoption | Each refuses before mutation; keyed setup's existing `--force`/pull-only contract remains unchanged. |
| Consent routes (`r2a-11`, `r2b-4`) | Direct interactive accept/decline, wizard accept/decline, headless with/without `--adopt` | Only affirmative typed witnesses enter adoption; wizard reaches the identical journal/overlay/recovery mechanism; decline or absent headless consent uses today's behavior. |
| Journal kill matrix (`r2a-3`, `final-5`) | `kill -9` at every journal state | Resume classifies each entry from full hashes and identities and completes without byte loss or duplicate overwrite; a mismatch persists `paused`. |
| Power-loss shape (`r2a-3`, `final-5`) | Dirfd-bound rename/ref CAS is durable but its journal advance is absent, plus partially persisted directory entries | Ordered parent fsync and classifier state yield an exact recorded-before/after match or a safe pause; presence alone is never accepted. |
| Abort phases (`r2a-12`, `final-2/3/7`) | Abort before phase 2 and after representative Git/ref/index/file moves in phase 3/4 | Pre-phase-2 restores B exactly; post-phase-2 keeps A live, restores `displaced/`, CAS-restores refs and the checked-out saved index, retains/reports B, then invalidates all cache classes and bumps the generation before `aborted`. |
| Crash before config (`r2a-12`) | Kill after journal publication but before `workspace.json` | Direct-path status/resume/abort work without workspace discovery. |
| Degraded mutex (`r2a-4`, `final-8`) | Lock acquisition returns `workspaceSyncMutexDegraded`, or the continuation's exact handle is lost/released/substituted | New adoption/resume/abort and continuation use refuse before mutation; status works; ordinary sync still sees and obeys an existing fence. |
| Shared fence choke point (`r2a-4`, `final-6`) | Incomplete adoption followed by daemon, one-shot, push, pull, export, restore, versions-restore, Git resolve, `ignore --purge`, chain repair, and recover | Every owner refuses from the shared mutation-mutex acquisition path; a repository assertion covers every manifest publisher/applier, and no partial overlay reaches the fleet. |
| Continuation propagation (`final-8`) | Phase-2 top-level baseline sync invokes its nested pull and push | One persisted nonce is consumed once, the invocation-local capability crosses both common fence checks under the same journal/phase/mutex incarnation, and baseline establishment proceeds. |
| Continuation rejection (`final-8`) | Wrong journal/phase/workspace/stream, public-owner construction, wrong/lost/degraded/released mutex, top-level replay, and crash/resume | Every bad tuple or replay refuses; only validated resume under a new healthy exact lock invalidates the old nonce and durably mints a fresh single-use continuation. |
| Kill switch (`r2a-4`) | Disable adoption before a new run and during an existing journal | New run uses today's behavior; existing status/resume/abort/fence remain unconditional. |
| Hardlinks (`r2a-9`) | B hardlinks span multiple overlay entries; A hardlinks include colliding and A-only names | B link topology survives landing and A's topology survives across live plus `displaced/`; journal identities remain classifiable. |
| Large-file identity alias (`final-5`) | Writer changes a large regular leaf in place while preserving inode/size/mtime and colliding stat tokens | Streamed full-content hash detects the change regardless of size; resume/abort pauses and never moves or overwrites the unrecognized value. |
| No-clobber writer races (`final-5`) | Writer creates the absent destination after validation or exchanges a validated parent for a symlink | `O_NOFOLLOW`-held dirfds, re-stat, and no-replace rename make both races pause without overwrite or escape; rollback under an ambiguous writer also pauses. |
| Symlink escape (`r2a-9`) | A destination parent is a symlink outside the workspace | Preflight or per-entry revalidation refuses; nothing is written through the link. |
| Mode-000 directory (`r2a-9`) | Source or destination traversal contains an unreadable mode-000 directory | Preflight refuses before the first move with the exact path; there is no chmod, silent skip, partial mutation, or escape. |
| Mount point (`r2a-9`) | A source entry in B is a mount point or crosses devices | Preflight refuses before the first move with the exact path; no partial `EXDEV`/`EBUSY` overlay exists. |
| Special entries (`r2a-9`) | FIFO, device, and socket in B | Entry is never followed or materialized live; it remains in/reaches `unplaced/` and is reported. |
| Ignore independence (`r2a-10`) | A/B invert `.rboxignore` and `.gitignore` decisions for colliding and B-only files | Every B file-plane entry overlays independent of the old matcher; final matcher comes from final rule files and only normal sync decides publication. |
| Warm cache (`r2b-1`, `final-7`) | Warm phase-2 hash/dir/trackedness caches; overlay same-size different bytes and B-only/tracked names with colliding index and file stat tokens | Completion removes trackedness plus directory/scan state, invalidates hash leaves, bumps generation, rebuilds the matcher, and init's own unpruned uncached full scan reads B's bytes/names and publishes the correct manifest. |
| Resident daemon generation (`final-7`) | Already-running daemon spans adoption complete, resume, and abort | At its held-mutex boundary it observes each durable generation, drops all resident manifest/hash/directory/trackedness/matcher state, full-scans, durably acknowledges, and only then applies or publishes; the first post-abort scan sees restored A. |
| Git incarnation (`r2b-2`) | Assert config shape, repository identity hash, checkout-journal binding, and branch-origin lineage across adoption | All phase-2 physical identities stay unchanged; no foreign-artifact or mixed-incarnation transition occurs. |
| Finish fanout (`r2b-3`) | 20+ based repositories, a capture failure, and a 409 pull-first retry | Local adoption completes once coherent; ordinary sync may publish subsets/sequences, reports deferrals accurately, and a later sync settles without an atomicity claim. |
| Retention lifecycle (`r2a-12`, `r2b-4`, `final-1`) | Completed adoption with displaced, unplaced, and retained-only Git state | Status lists all retained values directly from stash repositories and retention trees; nothing auto-expires; only explicit `adopt clean` removes retained adoption data. |

## Non-goals

- A new engine merge/classification/BASE-composer authority.
- Automatically publishing diverged, unrelated, B-only, tag, stash, detached,
  index, or operation-state Git values.
- Importing B's index or in-progress Git operation into A's repository
  incarnation.
- `keep-mine`/bulk resolve UX.
- Adoption in `init --new`, pull-only, no-sync, keyed/agent setup, or an already
  bound workspace.
- Atomic all-repository publication or guaranteed one-cycle fleet convergence.

## Rollout

Default-on means enabled for every eligible, affirmatively consented path: the
interactive init/wizard prompt defaults to adoption, and headless automation
opts in with `--adopt`. `RBOX_ADOPT_OVERLAY=0` prevents only new adoptions and
falls back to today's join-in-place behavior; it never disables recovery or the
global fence for an existing journal.

The founder's desktop bind is live validation only after the complete binding
matrix and rig gate are green. Retention makes that run locally recoverable, but
the CLI must still distinguish local adoption completion from ordinary sync and
fleet settlement.
