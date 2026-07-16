# §130 — Follower stale-side-branch hygiene

> **Status: 🚧 DESIGN v9 — 2026-07-16.**
>
> **Review history.** Eight adversarial review rounds established the mechanisms in this
> document. v9 is a clean-room coherence rewrite: it removes the inline review archaeology
> and the abandoned writer-prevention design, preserves the agreed publisher and
> follower protocols, and adds the final P-repair transaction for ref or reflog movement
> after a crash.
>
> Field record: the Mac rbox-core replica accumulated **83 local-only commits across dozens
> of stale side branches**. Every branch had been squash-merged and deleted on the publisher.
> Because squash merges rewrite history, those tips were not ancestors of `main`;
> `tipOwnedByIncoming` could not prove publisher ownership, so every ref became a
> permanent §116 hold. They were cleared with `take-theirs` on three replicas. This
> design prevents the same accumulation.

## Problem and safety objective

The common publisher workflow—branch, pull request, squash merge, delete branch—strands the
old branch on followers. The follower still has tip `T`, but `T` is unreachable
from the incoming roots. The existing ownership proof correctly treats it as possible local
work and holds it forever. Non-fast-forward publisher rewrites have the same shape.

The consequences are unbounded held refs, misleading diagnostics, and compound strands:
§126 requires `heldRefs` to be empty before it may heal a stale `ORIG_HEAD`
breadcrumb.

The publisher knows the values it previously advertised for each ref. It therefore sends a
bounded history of superseded advertised values. A follower may prune or rewrite a held ref
only when all three facts agree:

1. the live ref still has a value in that authenticated history;
2. logical BASE is present and equals that same value; and
3. the complete follower proof, including the locked second proof, permits the operation.

Ancestry alone never authorizes the operation. Ambiguity always keeps the existing hold.

## Trust model and scope

Tombstones are authenticated assertions by an active workspace writer. Git sections are
E2EE, hash-bound to signed commits, and chain/pin verified, so the service cannot forge or
splice them. A malicious or compromised active writer can author tombstones just as it can
author arbitrary workspace content; design 12 treats that as full account compromise and
it remains out of scope. The preservation protocol below makes a bad assertion recoverable,
not truthful.

This version applies only to `refs/heads/*`. Tags and `refs/stash` have different
semantics, and the checked-out ref belongs to the journaled checkout plane. Automatic
tombstone consumption therefore applies only to non-checked-out branch refs not owned by a
sibling worktree.

## Publisher protocol

### Wire representation

Each Git section gains:

```ts
refTombstones: Record<
  string,
  Array<{ oid: string; ts: string; generation: number }>
>
refTombstoneGeneration: number
```

`refTombstones[R]` is a per-ref chain of every retained value of `R` that the
publisher previously advertised and has since superseded. Supersession includes
fast-forwards, non-fast-forward rewrites, and deletion. A latest-only value is insufficient:
a follower stopped at `S0: R=Q` must still find `Q` after `S1: R=T` and
`S2: R absent`.

`refTombstoneGeneration` is a persisted repository-wide safe-integer high-water mark.
Every supersession event increments it exactly once and assigns the result to the entry.
Consequently, generations observed for one ref are strictly increasing even across expiry,
eviction, and re-supersession without requiring an unbounded per-ref counter map. Overflow
refuses to author the event and logs the resulting safe-direction hold risk. Generation
orders events only; it is never a follower authorization, replay credential, or artifact
retirement key.

If an OID already retained for `R` is superseded again, its entry is replaced with the
current canonical timestamp and the new generation. It is not duplicated, and wall-clock
`max` is never used as a generation surrogate. A capable writer that encounters
fields truncated by an old writer begins a new monotonic counter lineage. No counter lineage
is security authority.

A capable reader additionally requires
`refTombstoneGeneration >= max(entry.generation)`, with zero valid only for an empty
chain. A section with a smaller high-water mark is invalid rather than a source of repeated
or decreasing allocations.

### Authoring rule

A tombstone is authored only for an **all→all** comparison: both
`RepoRecord.advertised`, the exact last acknowledged wire checkpoint, and the current
capture must have `refScope:"all"`. Scoped captures, pointer-worktree
current-branch-only captures, and detached HEAD captures never turn omission into deletion.
Transitions between all and scoped observations author nothing.

`RepoRecord.advertised`, not protected follower BASE, is the predecessor for this
comparison. This lets the publisher acknowledge a wire omission without claiming that a
follower performed a branch deletion.

### The single outbound normalization boundary

Every outgoing Git section passes through one final normalizer, regardless of whether the
planner produced it by fresh capture, slow identity carry, fingerprint fast path,
needs-resolution carry, empty/unborn handling, gitignored discovery, configuration change,
recovery, defer, or linked-pointer handling. No other path performs retention or cap logic.

The normalizer applies this order:

1. merge or refresh supersession entries and allocate generations;
2. expire entries older than the 90-day retention target;
3. enforce the per-ref cap, ordered by `(ts, oid)`;
4. enforce the repository cap, ordered by `(ts, ref, oid)`; and
5. canonically serialize entries, generations, and the high-water mark.

A `PENDING` carry is the only exemption and passes through byte-for-byte. Normalizing
it would change `gitIncomingKey` and orphan partial progress and deferral episodes
bound to that key. Retention pauses while the section is pending and resumes at the next
non-pending emit.

Both tombstone fields participate, in canonical sorted form, in `gitIncomingKey`
because they can change receiver mutation authorization. They are excluded from
`gitIdentityKey` and projected live identity.

### Publisher bounds

The chain cap is **16 entries per ref** and **512 entries per repository**. Eviction is
deterministic oldest-timestamp-first and is logged loudly on the publisher. Ninety days is
a target, not a promise: high churn may evict older entries sooner. A slow follower then
keeps today's hold, which is the safe direction. Worst-case wire size is approximately
70 KiB per repository; changes use the existing `git-set` delta.

## Follower state model

### Logical BASE and the absence invariant

For every syncable branch `R`:

> **`BASE[R]` may move from a present OID to absent only in the same successful
> expected-absent CAS ref transaction by which rbox performs and records that transition.**

An absent live ref, an already-converged shortcut, a wholesale section carry, partial
progress, journal recovery, or a state-file CAS is not equivalent to that act. Those paths
may materialize a transition already proved by its durable Git artifact; they may never
manufacture one.

The durable artifact is:

`A(R) = refs/rbox-local/base-absent/v1/<sha256(UTF-8 R)>`

Before preparing the ref transaction, rbox writes a blob `M` containing RFC 8785
canonical JSON:

`{"priorOid":"<L>","ref":"<R>","v":1}`

A valid `A(R)` is a direct ref to that blob, with the exact schema, an in-scope branch
ref, a 40-hex `priorOid`, and a namespace suffix equal to the hash of `ref`.
Malformed, unreadable, multiply decoded, or hash-colliding artifacts hard-hold and emit a
bounded warning. The blob records the prior OID as text rather than pointing into the
commit graph, so it does not prolong reachability.

`A(R)` is common-dir durable and excluded from capture and ordinary ref identity. It
is created expected-absent in the same prepared `git update-ref --stdin` transaction
that deletes `R` at its expected old value. It is the authoritative statement that
logical BASE is absent-by-CAS, not a marker alongside some other authority.

Serialized `RepoRecord.base` is a materialized view. Every BASE reader and writer
overlays all valid A artifacts first, removing their refs from logical BASE. A valid A wins
over stale serialized presence; an invalid A is never ignored into presence. An A target,
timestamp, generation, or incoming tombstone is never matched to authorize or retire it.

### Present-transition artifact

A separate short-lived artifact proves rbox transitions that end present:

`P(R) = refs/rbox-local/base-present/v1/<sha256(UTF-8 R)>`

Its target blob is canonical JSON:

`{"episode":"<128-bit hex>","nextOid":"<N>","priorOid":"<L-or-null>","ref":"<R>","v":1}`

It uses the same direct-ref, exact-schema, branch-scope, OID, and hash-suffix validation as
A. `P(R)` is created expected-absent in the same ref transaction as every rbox branch
create or update that may advance pull BASE. The transaction forces a reflog entry for
`R` whose message is the episode:

- present→present: `{create P(R), create K(P,*), update R N L}`;
- absent→present: `{create P(R), create K(P,*), create R N, delete A(R) M}`.

The same transaction creates one episode-scoped reachability ref for each non-null OID
named by P:

`K(P,slot) = refs/rbox-local/base-present-keep/v1/<sha256(R)>/<episode>/<prior|next>`.

Each K directly targets its OID and is excluded from capture and identity. K keeps P's
evidence available across user or old-binary movement, reflog truncation, and GC. A
standing P is invalid unless every required K exists at the exact OID. Exact settlement
deletes P and K only after BASE is durable. P-repair atomically creates permanent
human-origin pins for both referenced OIDs before deleting P and K. Rollback journals carry
the exact K targets and delete them in every inverse that deletes P. At two K refs per P,
the 256-P cap also bounds this namespace at 512 refs.

Only one P may stand for a ref. Another transition must first settle or repair it.
P is crash authorship only: it never matches a tombstone and never authorizes BASE absence.

### Prevalidated attestation map

After strict wire validation and before ref-plane planning, apply orchestration builds one
immutable attestation map keyed by branch ref and tombstoned OID. Each entry is bound to the
exact `gitIncomingKey` and contains the direct live OID, logical BASE OID, validated
A/P/K disposition, and the D2-revalidated pending evidence used to derive it.
`publishRefPlane` consumes this map; it never reparses raw tombstone or partial state.

Invalid wire input produces no partial attestations. A stale, mismatched, indirect, or
otherwise invalid map entry is a hard veto. The map is necessary orchestration evidence,
but it is not an alternative to live equality or present-and-equal BASE provenance.
Partial progress remains a crash hint only.

### The mandatory BASE composer

There is exactly one constructor for persisted `RepoRecord.base`:

`composeRepoBase(previous, candidate, authority, lockedProof)`.

Direct BASE construction, whole-section assignment, member deletion, legacy-map folding,
and raw whole-state persistence outside this function are forbidden by structural tests.
`authority` is a closed union:

- `pull-ref-transaction` carries exact A/P witnesses and locked live/reflog facts;
- `pull-carry` may retain ref members and change permitted non-ref fields, but may not
  change a ref member;
- `journal-recovery` carries the journal's exact transaction witnesses rather than
  trusting its intended section;
- `publisher-ack` may add or advance present members this device advertised, but may
  not remove them;
- `p-repair` may retire a quarantined P episode and materialize only the exact
  historically proved P transition under the pre-state rule below; it may never remove a
  BASE member or overwrite a later third positive value; and
- `migration` may import legacy positive state but may not remove a present member.

For every member of `keys(previous.refs) ∪ keys(candidate.refs)`, in canonical refname
order, unchanged presence is retained; a pull addition or change requires a valid P witness;
and present→absent requires locked `R` absence plus valid `A(R)`. Missing,
malformed, stale, or mismatched proof retains the previous member, keeps the incoming section
pending, and returns a typed hard hold. `publisher-ack` may add or advance present
members but retains omissions. Candidate non-ref fields follow their existing lane rules.

`lockedProof` means a prepared Git ref transaction, not an in-process mutex. It locks
every affected R and A/P/K ref in bytewise order. Absence verifies `R` absent and
`A(R)=M`. Exact P recovery verifies `R=N` and the exact P/K targets, with their
retirement committing only after the state CAS. Unchanged refs participating in a
reservation are also verified. The state-generation CAS runs while the Git locks remain
prepared. State failure aborts the ref transaction and leaves P/K; state success commits
the transaction.

The global order is:

`workspace mutex → common dirs by canonical real path → refs by bytewise name → state lock`.

No state writer may acquire a Git proof lock in the reverse order.

### Complete BASE-writer retrofit

Every current or future BASE writer routes through the composer. The implementation must
retrofit all of these existing sites:

- **Pull initialization and recovery (`src/cli/sync-git/apply.ts`):** map
  initialization, outcome packing, partial-progress local-identity reconstruction,
  recovered-record install/delete, and post-recovery reload. Recovery uses
  `journal-recovery` and never trusts `record.base` alone.
- **Pull repository absence and shortcuts (`apply.ts`):** remote-repository omission,
  unchanged-section advance, already-converged advance, and legacy-conflict composition.
  An already-converged changed value without P holds.
- **Pull intended and success records (`apply.ts`):** journal RepoRecord construction,
  the current held-vs-remote BASE choice, successful-follow input carry and assignment, and
  clean/legacy success assignment. Mixed-ref results compose per ref; no success assigns an
  incoming section wholesale.
- **Ref mutation and recovery (`src/cli/sync-git/follow.ts`):** safe-ref equality,
  deletion and update planning; pre-journal safe-ref publication; current-ref delete/update
  construction; intended-record capture; and journal recovery/landing. Every mutation
  returns its exact witness; equality observation returns none.
- **State folding and install (`src/cli/config.ts` and
  `src/cli/sync-state.ts`):** legacy-to-record folding, records-to-manifest
  serialization, packet installation, generic state save, source record construction,
  record-to-input copy, legacy reconstruction, and opaque journal-lane replacement/retry.
  `StateSource` names its authority and carries the proof result. Raw `saveState`
  is private to fresh non-Git initialization and refuses state containing Git BASE or repo
  records. Structural tests forbid any other whole-state persistence API or direct
  state-file write.
- **Telemetry binding (`ensureTelemetryBindingId` in
  `src/cli/config.ts`):** its whole-state rewrite must use the composer so it cannot
  drop or alter BASE or A/P/K/Q bookkeeping it did not read.
- **Push/capture and ACK composition (`src/cli/sync-git/plan.ts`):** initial BASE
  read; journal recovery rehydrate/delete; files-first early return; `syncGit:false`
  omission; outbound map comparison; owned/config, generic defer, needs-resolution,
  structural-drop, empty-repo, identity, pending, missing-directory, gitignored,
  fingerprint, and linked-pointer carry/delete paths; capture output; and post-commit BASE
  folding. Every outgoing arm reaches the final normalizer. Publisher removals update
  `advertised` and suppression while retaining BASE anchors.
- **Reset and rebind (`src/cli/config.ts`):** stream-mismatch freshening,
  missing-state/incarnation construction, and legacy and transactional reset paths use the
  artifact protocol below and never manufacture empty branch BASE.
- **Manual resolution (`src/cli/git-cmd.ts`):** the current wholesale
  `base: incoming` assignment is replaced by the per-ref manual protocol.
- **Publisher ACK source (`src/cli/sync/push.ts`):** the post-commit source is tagged
  `publisher-ack`, never generic pull authority.

The files-first path may emit empty Git only for true genesis: no BASE, advertised,
pending, A/P/K, or repository record may exist. Otherwise it enters the same carry and
normalization path.

## Follower authorization and transactions

### Tombstone authorization

For an incoming `refScope:"all"` section that omits `R`, a held non-checkout
branch at live `L` is authorized for deletion only if all of the following hold:

1. the prevalidated attestation map contains `refTombstones[R]` entry `oid=L`;
2. logical `BASE[R]` is **present** and equals that same `L`;
3. `A(R)` and `P(R)` are absent and no orphan or mismatched K exists;
4. the hard ownership proof is otherwise determinate and stable; and
5. `R` is neither the current ref nor owned by a sibling worktree.

Authorization is evaluated after receiver-equivalence ambiguity, forced prior holds,
sibling-worktree ownership, indeterminate proofs, reflog stability, busy state, and CAS
preconditions. It may bypass only the ancestry/no-drop `local-commits` conclusion.
It waives no other gate.

The prune transaction atomically creates all prepared keep pins, creates `A(R)=M`
expected-absent, and deletes `R=L` expected-old. Both ref preconditions must succeed.
Success makes live R and logical BASE absent at one linearization point; failure changes
neither. A itself is the durable consumed record; there is no second marker.

For an incoming-present non-fast-forward rewrite `R:L→N`, tombstone adoption may
bypass only `local-commits` under the same live, BASE, attestation, A/P, hard-gate, and
checkout-plane rules. Its transaction creates P and CAS-updates R from L to N. BASE then
advances through exact P recovery. If logical BASE is absent or A exists, the case is
re-advertisement rather than rewrite adoption.

### Preservation

Before any destructive ref mutation, the existing keep-pin protocol enumerates all
relevant reflog OIDs. The enumeration and its fingerprint are re-read **under the prepared
ref lock**; any change aborts. This prevents `T→U→T` from hiding reflog-only `U`
behind an expected-old check that still sees `T`.

Only the exact live tip whose live-and-BASE equality authorized a tombstone prune receives
the aging keep-pin origin `tombstone`, which expires after 90 days. Every other OID
found in the reflog receives the existing permanent `human` origin, even when the OID
also appears in a tombstone chain. Chain membership without exact BASE provenance is not a
proof that the object is discardable.

One bounded success line is emitted per prune:

`git-sync: pruned tombstoned branch <ref> (was <short-oid>)`

### All branch deletion planes

A is not tombstone-specific. Every rbox branch deletion that could remove a present BASE
member—ordinary safe-ref deletion, tombstone deletion, checkout-plane deletion, clean
materialization/wipe, and manual `take-theirs`—creates A in the exact transaction
that deletes R. A checkout journal may intend absent BASE only after that exact
subtransaction is published.

Clean apply records every exact A/P target and transition kind. Its atomic rollback
inverses are:

- `{create A, delete R L}` → `{create R L, delete A expected-M}`;
- `{create P, create K*, update R N L}` →
  `{update R L N, delete P expected-P, delete K* expected}`;
- `{create P, create K*, create R N}` →
  `{delete R N, delete P expected-P, delete K* expected}`; and
- `{create P, create K*, create R N, delete A M}` →
  `{delete R N, delete P expected-P, delete K* expected, create A M}`.

Existing pins remain conservatively over-protective. If any inverse CAS fails, rollback
does not claim restoration and recovery hard-holds. Destructive wipe helpers may not mutate
a branch outside this wrapper.

### Re-advertisement and A retirement

When logical BASE omits R and incoming advertises `R=N`, normal follow performs an
expected-absent create. If A exists, that same transaction creates P and deletes A by exact
target. Merely observing `live==incoming` is insufficient: a user-created occupant,
even at N, causes the create CAS to fail, leaves A in place, and holds. N need not equal
`A.priorOid`.

A retires only inside a protocol-capable v8-or-newer transaction that establishes a
present result. This includes the expected-absent create and the returning-capable-reader
revalidation path after an old binary legitimately applied a re-advertised ref while A
stood. Tombstone expiry, generation change, observation, state rewrite, and old binaries
never retire A.

That returning-reader path is an explicit **present revalidation transaction**, not an
already-converged shortcut. Because A still makes logical BASE absent, it requires a
positive serialized BASE candidate `RepoRecord.base[R]=N` written by the old apply,
validated incoming `R=N`, locked live `R=N`, exact `A(R)=M`, P absent,
stable reflog evidence, and every ordinary hard gate. Its prepared ref transaction contains
`verify R N + verify P(R) absent + delete A(R) M`. A is fully validated before
preparation, and the delete's expected target is its sole in-transaction A check. While
those locks remain prepared, `pull-ref-transaction` authority state-CASes that positive serialized
candidate and the revalidation receipt; A continues to overlay it until the ref transaction
commits. State failure aborts and retains A. State success commits the exact A deletion,
which exposes the already-persisted N as logical BASE at that linearization point. A crash
before ref commit therefore retries with A still blocking, while a crash after commit sees
the durable receipt and A absent. The planner then restarts from fresh observations.

This path deliberately resolves the same-OID old-writer/user-recreation ambiguity without
deleting anything. A later tombstone is a new decision and must pass fresh live, positive
BASE, attestation, preservation, and hard-gate proofs.

### Exact P recovery

While P stands, stale serialized BASE is unavailable for tombstone authorization. Exact
recovery prepares locks for R, P, and K, validates their exact targets, and requires live
`R=N` plus the top reflog entry with the exact episode and old/new values. The
CAS-protected BASE must still be P's pre-state or already N. It then materializes
`BASE[R]=N` by state CAS and compare-deletes P and K by expected target. A third
positive BASE, or unexpected absence for a present `priorOid`, is later state and
routes through P-repair even when R and its reflog still match.

There are two normal crash shapes:

- **pre-state:** the ref transaction committed and P proves the present transition, while
  serialized BASE still has the prior value or absence;
- **post-state, pre-retirement:** BASE already contains N and P is redundant.

Both settle through the same locked transaction. A crash after P retirement leaves
`BASE[R]=N`. A successful absent→present transaction leaves R=N, no A, and valid P
until one of these paths settles it. P never supplies absence authority.

### P-repair transaction

Exact recovery can fail after a crash because a user or old binary moved, deleted, or
recreated R, advanced or truncated its reflog, performed `N→U→N`, or wrote a later
protected BASE shape. A structurally valid P must not become a permanent artifact wedge.

When failure is specifically a locked live-ref, top-reflog, or protected-BASE-shape
mismatch, v9 executes
`p-repair` under the same workspace/common-dir/ref/state lock order. It:

1. revalidates P at its exact target, verifies the current R value or absence, verifies A
   absent, and re-reads and fingerprints the reflog while the relevant locks are prepared;
2. writes and durably fsyncs a canonical quarantine blob of at most 8 KiB containing the P
   ref and target, canonical P payload, current live and logical-BASE observations, reflog
   fingerprint and top entry, state generation, incoming key, canonical repair timestamp,
   and mismatch reason; its direct recovery ref is
   `Q(P) = refs/rbox-recovery/base-present/v1/<lineage-hash>/<sha256(R)>/<episode>`,
   where `lineage-hash` is SHA-256 over the workspace, stream/incarnation, and
   canonical repository identity with length-delimited fields;
3. creates permanent `human` keep pins for every non-null OID named by P
   (`priorOid` and `nextOid`);
4. computes BASE from the state protected by that CAS: if BASE still equals
   `P.priorOid` (including absent for `priorOid:null`), materialize
   `P.nextOid`; if BASE already equals `nextOid`, leave it unchanged; if BASE is
   absent when `priorOid` was present, or is any third positive value, preserve that
   later state rather than regress or invent provenance;
5. replaces P-bound partial progress with a terminal `p-repaired` receipt naming Q
   and the chosen BASE disposition. For a multi-ref or checkout journal, only that member is
   superseded; every unrelated member and the journal's published/rollback state is
   preserved, and recovery never attempts the obsolete P inverse;
6. runs the state-generation CAS through `p-repair` authority with that BASE result
   and typed receipt; and
7. atomically creates Q at the quarantine blob expected-absent, creates the
   deterministically named permanent keep pins, and compare-deletes P and every K by
   expected target in the prepared ref transaction.

Unavailable referenced objects, malformed or colliding P, contradictory live A+P,
indeterminate reads, busy locks, and preservation failures are corruption or operational
holds, not movement repair. Any quarantine, pin, state-CAS, or expected-target failure
leaves P authoritative and the operation retries or hard-holds.

The prepared lock set contains R, A, P, K, Q, and every permanent keep ref in the global
bytewise order.
It also holds the common-dir reflog-maintenance lock for R. The reflog fingerprint is
compared again immediately before commit, so concurrent reflog expiry or direct replacement
aborts with P intact just like a ref movement.

The steps are crash-idempotent. An unreferenced quarantine blob or pin origin written
before an aborted ref transaction is harmless over-protection. A crash after state CAS but
before ref commit leaves P and retries. After ref commit, Q, quarantine data, and pins are
durable and P/K are absent. Q is excluded from capture, live identity, and authorization and
is retained with its recovery lineage for forensic/manual recovery. The lineage/ref/episode
name is deterministic; a pre-existing Q while the exact P still stands is an artifact
contradiction and hard-holds rather than overwriting forensic state.

Q is capped at **256 records per active lineage**. Before adding the 257th, the same
transaction expected-target-deletes the oldest valid Q by `(repairedAt, refname)`.
Its permanent human pins remain, so eviction drops forensic metadata rather than object
recovery. Eviction is warned and counted by `doctor`. Deleting a whole retired lineage
locks and validates that lineage's Q prefix, expected-target-deletes all remaining Q refs in
canonical order, independently enumerates the same lineage-hash repair-pin origin prefix,
and removes only those origins; objects with another origin stay pinned. Active-lineage
repair-pin origins otherwise do not age, so their potentially unbounded object-graph cost
is diagnosed rather than hidden.

After success, the entire old plan, attestation map, partial witness, and ref/reflog
snapshots are discarded. Locks are released and normal evaluation restarts from disk and
the incoming section. P itself—not the moved live ref or damaged top reflog—is the authority
for landing its historical transition only when BASE is still its exact pre-state. A later
positive BASE is never overwritten.

P-repair does not itself authorize a deletion. Fresh evaluation may subsequently authorize
one from the resulting positive BASE under all ordinary rules. This is intentional when a
ref moved back to P's `priorOid`: the exact value incarnation cannot be recovered after
the movement, but Q plus permanent pins preserve both OIDs, and the new destructive
transaction must still pass attestation, live equality, stable reflog, preservation, and
every hard gate. Any remaining disagreement is an ordinary, diagnosable conflict rather
than a P-artifact wedge.

### Crash reconstruction and partial progress

Before a deletion transaction commits, no A exists and BASE cannot become absent. After it
commits, A alone reconstructs logical absence, the locked expected-absence reservation, and
the transition even if the process died before partial state, the checkout journal, or the
state CAS, and even if the tombstone later expired or was evicted.

If serialized BASE still contains R, this unmaterialized committed transition reconstructs
`tombstone-pruned-this-cycle` exactly once. Once the locked state CAS materializes the
absence, later cycles do not raise the same-cycle veto merely because A remains.

`GitPartialApply.appliedRefs` may record
`{kind:"absent", artifactOid:M}` or
`{kind:"present", oid:N, artifactOid:P, episode}`.
`{kind:"direct"}` is valid only for unchanged equality. These records are
pending-key-bound, D2-revalidated hints. Raw or prevalidated partial presence never
establishes BASE provenance or authorizes a tombstone, and the hints may be rebuilt from
A/P.

### Value-incarnation boundary

The safety contract observes ref value plus available reflog history, not an unbounded Git
ref-incarnation identity. A `T→U→T` move or delete/recreate-T completed before rbox's
first snapshot can be indistinguishable if its reflog is absent or truncated; this version
may treat stable T as the BASE value. Reflog-only U is still permanently pinned. Movement
after an rbox present transition is caught by the P episode, and recreation while A exists
still fails expected-absent creation.

## Repository absence and suppression

A remotely absent repository, `syncGit:false`, structural section drop, or missing
local directory performs no branch CAS and therefore cannot delete branch BASE members.
`RepoRecord.base` retains the per-ref provenance anchor.

`RepoRecord.advertised` is a separate, non-authoritative copy of the exact last
acknowledged wire section. It is used only for outbound delta and tombstone composition and
can never satisfy follower provenance. A local `repoAbsent` or existing
`removedKey` disposition suppresses the repository from the last-synced projection,
outbound capture, and ordinary equality decisions.

Publisher ACK produces two outputs: exact committed wire state goes to `advertised`;
BASE admits present additions and advances but retains every omitted ref. This prevents
resurrection and repeat re-supersession without claiming an unperformed deletion.
Reappearance clears suppression only through normal apply or capture. Active-lineage record
GC never removes the BASE anchor, even when `.git` is gone.

## Manual resolution

`take-theirs` retains snapshot confirmation, quarantine, permanent human pins, and the
locked second proof. It never writes wholesale BASE.

Preflight first settles an exactly recoverable P or performs P-repair for a valid moved P.
It then discards the old confirmation context, takes a new snapshot, and obtains or
revalidates confirmation against that snapshot. If P appears or changes during the second
proof, the command aborts and restarts. A malformed or unpreservable P remains fail-closed
and must be restored from known-good state or isolated by binding a fresh root; this design
does not define a raw-artifact retirement escape.

For incoming absence, a present R uses `{create A, delete R expected}`. If R is already
absent while prior BASE is present, confirmed manual authority uses
`verify R absent + create A` before BASE may become absent. Incoming absence with a
valid A retains it.

Incoming presence from logical absence normally uses expected-absent create. If a confirmed
user occupant blocks it, manual authority may CAS-update or delete that exact snapshotted
value while atomically deleting A and creating P; quarantine and pins preserve what was
displaced. Incoming presence from present likewise creates P around the expected-old update.
Any snapshot, reflog, A/P/K, sibling-worktree, or CAS mismatch aborts without BASE change.
Only the mandatory composer lands the journal result.

## Artifact lifecycle, reset, and diagnostics

A survives ordinary state saves and tombstone expiry. It retires only through a successful
present transaction. P normally survives until exact present BASE materialization, and a
valid moved P survives until P-repair has quarantined and pinned it. K has exactly P's
lifetime; Q has the bounded recovery-lineage lifetime above. All artifact namespaces are
common-dir state, excluded from capture and identity, and scanned by ref rather than by
loose blob contents. Blobs written before failed ref transactions are unreachable
non-authority and ordinary Git GC may collect them.

A common dir may contain at most **4,096 A refs**, **256 P refs**, **512 P-lifetime K
refs**, and **256 Q refs per active lineage**. At an A/P/K cap, a new transition hard-holds
before mutation; those live proof artifacts are never evicted. Q alone uses its safe
metadata-eviction rule. `doctor` reports all counts, repair-pin origin counts and
bounded lexicographic examples; the daemon emits one bounded warning per boot.

Reset, rebind, and stream-mismatch freshening scan every in-workspace common dir. They first
settle an exactly recoverable P or run P-repair for a valid moved P, then rescan state and
artifacts. They never raw-delete P. Any remaining A, P, malformed artifact, unpreservable
repair, orphan or mismatched K, or published checkout journal refuses reset; degraded and fence-free reset are
forbidden.

When none remain, reset atomically renames the complete old state to a read-only,
nonce-addressed lineage archive and creates a distinct stream/incarnation. Repair
quarantine remains associated with the recovery/archive lineage and its keep pins remain
reachable. Archives never participate in authorization and may be deleted only as whole
retired lineages. An old executable can still rewrite state without observing these rules;
the next capable reader rediscovers A/P/K and fails closed or repairs P.

## §126 interaction

Expected absences and their exact A targets are carried into checkout reservations and
verified under the ref locks at §126's second proof. An absence is a reserved fact, not an
unchecked gap. A next-cycle recreation between the initial snapshot and locked proof
therefore cannot race a stale-breadcrumb waiver.

A tombstone prune vetoes breadcrumb healing in the same cycle. After a crash, A plus stale
serialized BASE reconstructs that veto once. After BASE materializes the absence, A does not
veto every later cycle; the next cycle may heal with both absence and A verified under
locks.

Both §126 proofs, §130, logging, and tests use one closed enum,
`BreadcrumbVetoGate`, and one total order, `BREADCRUMB_VETO_ORDER`:

`held-refs > tombstone-pruned-this-cycle > in-progress-present >
reason-local-edits > reason-local-index > reason-local-operation >
reason-local-commits > reason-local-stash > reason-worktree-ownership >
reason-git-busy > reason-unreadable > reason-artifact > reason-containment >
reason-unsupported > reason-other > indeterminate > boundary`.

The order is implemented as `Record<BreadcrumbVetoGate, number>` with an exhaustive
`never` check. `in-progress-present` means any classified in-progress op-state
root exists; `indeterminate` means the proof returned no classified reason; and
`boundary` means the second-proof snapshot or lock boundary changed. No free-form
`reasons[...]` gate exists.

A centralized logger emits at most once per workspace, repository, and gate per daemon
boot:

`git-sync: breadcrumb waiver vetoed for <repo>: <gate>`

## Version skew: reader-side distrust

An old standalone binary can execute directly and write refs or state. Safety comes from
what a capable reader refuses to infer:

1. Tombstone authorization always requires positive, present-and-equal BASE. BASE absence
   never authorizes anything, so an old binary's inability to create A can only preserve a
   hold.
2. A live A blocks tombstone authorization for that ref regardless of surrounding state.
   Old binaries neither create nor touch `refs/rbox-local/*`.
3. A retires only in a v8-or-newer transaction that establishes or revalidates a present
   result.
4. A live P blocks use of serialized BASE until a capable reader settles exact recovery or
   v9 quarantines and retires a moved P through P-repair.
5. Old readers ignore the unknown wire fields. Capable readers strictly validate container
   shape, `refs/heads/*` grammar, 40-hex OIDs, canonical timestamps, caps, duplicate
   OIDs, strictly increasing per-ref generations, and the safe-integer high-water mark
   before building any attestation.
6. An old writer may drop tombstone chains and the high-water mark at any time. This loses
   authorization and causes holds; it cannot create authorization.

The required v8→old→v8 walk is:

- v8 prunes `R=T`, atomically creating A and making logical BASE absent;
- during the old interval, the binary may leave R absent, legitimately re-apply a
  publisher re-advertisement and record `R=T, BASE=T`, rewrite state, or coexist with
  a user recreation;
- returning v8 sees A and cannot delete R, regardless of the positive state around it;
- its normal present revalidation transaction may then retire A; and
- a later tombstone must earn fresh live equality, fresh positive BASE equality, and all
  hard gates again.

If the old interval moves refs, reflogs, or state while P stands, returning v9 performs
exact recovery when possible and P-repair otherwise. It never treats the old interval as
write-free and never derives deletion authority from ambiguity.

## Tests

### Publisher and wire

- Chain walk: follower at `S0:Q` prunes after `S1:T` and `S2:absent`;
  repeated rewrites; delete/recreate; re-supersession under equal or regressing clocks;
  high-water persistence across expiry/eviction; overflow refusal.
- All→all authoring: pointer-worktree switch, detached HEAD, scoped→scoped, all→scoped, and
  scoped→all author no tombstones.
- Final normalizer: every capture/carry/recovery path reaches the one boundary; expiry and
  both cap orders are deterministic and logged; PENDING is byte-identical and resumes
  normalization only after landing or dropping.
- Validation and keys: malformed refs/OIDs/timestamps/generations/caps/high-water and
  duplicate OIDs fail before attestation; require high-water ≥ every retained generation
  and zero only for an empty chain. Tombstone changes affect `gitIncomingKey` but not
  identity.

### BASE, composer, and repository state

- Structural tests permit BASE construction only in `composeRepoBase` and fixture
  every enumerated `apply.ts`, `follow.ts`, `config.ts`,
  `sync-state.ts`, `plan.ts`, `git-cmd.ts`, push-ACK, and
  `ensureTelemetryBindingId` site. A new direct assignment, raw state write, or
  unhandled authority member fails.
- Cross previous `{R1=L1,R2=L2}` with absent/same/changed candidates and
  valid/missing/malformed/mismatched A/P. Only locked absence+A removes a member; only P
  advances pull presence; publisher ACK never removes; refusal retains prior and pending.
  A valid R1 prune composes beside an unrelated held R2.
- Race every proof→state boundary, fail the state CAS, and stress multi-repo lock ordering.
  Pins and P retirement commit only with their intended transaction.
- Present revalidation after an old-writer apply exercises exact R/A/P verifies, state CAS,
  A deletion, every crash boundary, and concurrent R/A/state movement. Execute the literal
  valid stdin shape `verify R + verify P-absent + delete A expected`, with no duplicate
  A command. A overlay hides the serialized candidate before commit and exposes it only
  after exact A deletion. It never deletes R; a later tombstone must pass a fresh proof.
- Repository suppression matrix: remote omission, missing local directory, structural
  drop, `syncGit:false`, missing-dir push, and publisher ACK retain BASE anchors,
  update only advertised, suppress the wire projection, do not resurrect, and do not
  re-supersede twice. True-genesis is the only files-first empty path.

### Authorization, preservation, and branch transactions

- Exact live+tombstone+present BASE equality through the prevalidated map authorizes;
  BASE mismatch, A/P/K inconsistency, coincidental same-OID local ref, stale map, or partial state
  alone holds.
- Ambiguity, forced hold, sibling ownership, indeterminate proof, unstable reflog, busy
  state, and current ref are never waived; only `local-commits` may be bypassed.
- Atomic delete creates pins+A and deletes expected R together. Inject every CAS failure
  and crash boundary. Exercise every deletion plane and every exact rollback inverse.
- Rewrite adoption `T→N` creates P around expected-old CAS. After settled BASE=N, a
  user return to T holds.
- Reflog `T→U→T` between proofs aborts; stable reflog-only U receives a permanent
  pin. Only the proven tip receives the aging tombstone origin. A's metadata blob does not
  retain T after that pin expires.

### Replay, crash, and interleaving walks

- Keep the g1/g2/g3 laundering walk: begin `live=BASE=T`; g1 tombstones T and the
  successful transaction creates A and deletes R. At g2 the publisher re-advertises T
  after the user recreated `R=T`; expected-absent create fails, so A remains and BASE
  stays absent. Expire g1, supersede g2, and tombstone T again at g3. Live equality holds
  but BASE equality does not, so it holds. Extend through gN; only a successful rbox
  expected-absent create while R is absent can establish consumable provenance.
- A crash matrix kills after safe refs and before partial, journal, and state writes. A
  alone reconstructs logical absence, reservation, and the one-time veto after tombstone
  expiry or eviction. Invalid A hard-holds.
- Exact P recovery covers present `L→N`, absent→N, and ordinary create at every
  prepare/commit/state/retirement boundary, with distinct pre-state and
  post-state/pre-retirement assertions. Exact R/reflog plus a third-positive or unexpected
  absent BASE routes to P-repair rather than regressing state.
- Interleave outstanding P with `N→L`, `N→U→N`, delete/recreate-N, extra or
  truncated reflog entries, and old-binary ref/state writes. Exact matches recover; valid
  movement takes P-repair.
- Execute v8→old→v8 with the old interval leaving absence, legitimately applying the
  re-advertised value, user recreation, BASE/state rewrite, and tombstone/high-water
  truncation. A always blocks ambiguous deletion; returning capable evaluation only
  over-refuses or revalidates.

### P-repair

- For both present→present and absent→present P shapes, cover moved, deleted,
  delete/recreate-same, `N→U→N`, extra-reflog, and truncated-reflog cases.
- Verify the quarantine contains the exact P target/payload and locked live, BASE, reflog,
  state-generation, incoming-key, and mismatch observations; `priorOid` and
  `nextOid` are reachable through K from P creation and receive permanent pins before
  expected-target P/K retirement.
- Assert the BASE disposition table: pre-state `priorOid` or null lands
  `nextOid`; already-next is unchanged; third-positive or unexpected absence is
  preserved. Current N then converges normally, current U becomes an ordinary live/BASE
  conflict, and an old writer's later positive BASE is never regressed.
- Walk pre-state `L→N` followed by live `N→L`: repair lands BASE=N and pins L/N,
  so a tombstone for L cannot use stale BASE. If a later writer instead recorded a distinct
  positive BASE=U, repair preserves U and any later destructive decision remains
  recoverable through Q and permanent pins.
- Assert `p-repair` supplies no tombstone attestation, discards the old plan, and
  restarts from fresh observations.
- Crash or fail at quarantine write/fsync, pin preparation, ref preparation, state CAS,
  ref commit, and pre-replan. Concurrent R/P/reflog/state movement leaves P; retries are
  idempotent and do not duplicate pins. Race reflog expiry/direct replacement immediately
  before commit. A contradictory pre-existing Q hard-holds.
- Multi-ref clean/checkout journal: repair one moved-P member into a typed
  `p-repaired` receipt while another member still recovers or rolls back. The
  journal remains published, its unrelated members remain intact, and reset cannot bypass
  it.
- Move R, truncate/expire its reflog, run Git GC, and only then return v9. K keeps every
  P-referenced OID available, so repair still pins, quarantines, and retires without an
  artifact wedge. Missing or mismatched K is corruption, not this movement case.
- Fill Q to 256, repair once more, and verify deterministic expected-target eviction of the
  oldest Q while its permanent pins remain. Whole-lineage deletion removes the exact Q
  prefix and only its lineage repair-pin origins; shared origins remain.
- Missing referenced object, malformed/colliding P, A+P contradiction, and preservation
  failure remain fail-closed and are distinguished from repairable movement.
- Manual resolution settles or repairs P, takes a fresh confirmation snapshot, and catches
  a second-proof race. Reset/rebind/freshening settles or repairs valid P and rescans, but
  still refuses A, malformed P, unpreservable P, and published checkout journals.

### §126, lifecycle, and diagnostics

- Tombstone prune plus breadcrumb mismatch in one cycle defers; the next cycle heals with
  absence and A verified under locks. A crash reconstructs the veto once, not forever.
- Table-test every `BreadcrumbVetoGate` at both proof sites and in the logger; assert
  the total order verbatim and compile-fail an unranked enum member.
- Artifact caps 4,096 A / 256 P / 512 K refuse before mutation without proof eviction; Q
  caps at 256 per active lineage using metadata-only eviction. Orphan blobs GC; settled A
  persists and settled P/K retire; Q and repair-pin diagnostics and once-per-boot logs are
  bounded.
- Same-OID tests distinguish pre-snapshot movement with missing/present reflog from
  post-P movement. Reflog-only work remains reachable.
- Manual incoming present/absent × live present/absent × A/P present/absent verifies
  quarantine, pins, exact CAS, second proof, and the absence of wholesale BASE writes.

## Non-goals

- Automatically backfilling pre-§130 residue; `take-theirs` remains the migration
  tool.
- Tombstones for tags, `refs/stash`, or the checked-out ref.
- Age-based branch pruning without live equality and positive BASE provenance.
- Preventing an old standalone binary from executing or writing. Mixed-version safety is
  provided by reader-side distrust and conservative repair.
- Resistance to a compromised active workspace writer.
