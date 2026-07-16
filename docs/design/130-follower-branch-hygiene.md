# §130 — Follower stale-side-branch hygiene

> **Status: 🚧 DESIGN v11 — 2026-07-16.**
>
> **Review history.** Ten adversarial review rounds established the mechanisms in this
> document. v11 preserves the v10 protocol and closes the final composer-contract gap:
> mixed outcomes now carry exact create/update/delete witnesses for syncable non-branch
> refs, including crash reconstruction, and the closed authority union includes confirmed
> no-P manual settlement. A/P and positive branch provenance remain branch-only.
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

### Lineage and logical-repository binding

Proof refs live in a common object/ref store, but the authority they record belongs to one
logical `RepoRecord`. Linked worktrees can share that store, and two workspace roots can
point at it, so a refname keyed only by branch name is unsafe. Every A/P/K/Q and absence
archive below is therefore bound to both a repository identity and a state lineage.

`RepoIdentityV1` has these fields, in this exact order:

1. the validated POSIX `RepoRecord` key (`.` or its canonical relative path);
2. repository kind, the ASCII literal `dir` or `pointer`;
3. `worktreeId`, `gitDirReal`, and `commonDirReal` from the existing
   `CheckoutJournalBinding` (`follow.ts:207-214`, `journal.ts:9-15`); and
4. the common-directory `dev`, `ino`, and nanosecond birthtime, each as an unsigned
   decimal ASCII integer, from the same bigint `stat` used by
   `config-lane.ts:88-104`; unavailable/non-positive birthtime uses the existing
   ASCII `0` sentinel.

Its canonical byte encoding is ASCII `rbox-repo-identity-v1\0`, followed by each field as
an unsigned 64-bit big-endian byte length and that many UTF-8 bytes. Existing path
validation and `realpath` happen before encoding; there is no further Unicode, case, slash,
or locale normalization. `repositoryIdentityHash` is SHA-256 of those bytes.

The state lineage encoding is ASCII `rbox-lineage-v1\0`, followed by the same
length-delimited encoding of `workspaceRootReal`, `SyncState.stream`, the 32-hex
`stateNonce`, and the complete `RepoIdentityV1` bytes. `lineageHash` is its SHA-256.
A legacy or degraded state without a nonce cannot author or retire these artifacts; it can
only carry BASE and hold. Including the physical incarnation prevents a replacement repo at
the same path from inheriting proof, while the record key distinguishes logical records
that intentionally share a common dir.

All payloads repeat `lineageHash` and `repositoryIdentityHash`, and their namespaces include
`lineageHash`. A reader validates namespace, payload, current state lineage, repository
identity, branch hash, and direct target as one unit. An artifact for another lineage or
logical record never overlays or advances this record's BASE. A valid foreign artifact for
the same branch in the same common dir is a mutation veto until its owning lineage settles
or is sealed; artifacts for unrelated branches are ignored. Malformed, colliding, or
unclassifiable artifacts hard-hold the common-dir group.

### Logical BASE and the absence invariant

For every syncable branch `R`:

> **`BASE[R]` may move from a present OID to absent only in the same successful
> expected-absent CAS ref transaction by which rbox performs and records that transition.**

An absent live ref, an already-converged shortcut, a wholesale section carry, partial
progress, journal recovery, or a state-file CAS is not equivalent to that act. Those paths
may materialize a transition already proved by its durable Git artifact; they may never
manufacture one.

The durable artifact is:

`A(R) = refs/rbox-local/base-absent/v2/<lineageHash>/<sha256(UTF-8 R)>`

Before preparing the ref transaction, rbox writes a blob `M` containing RFC 8785
canonical JSON:

`{"lineageHash":"<64hex>","priorOid":"<L>","ref":"<R>","repositoryIdentityHash":"<64hex>","v":2}`

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

Positive branch BASE also carries provenance. `RepoRecord.branchBaseOrigins` is an exact
map for `refs/heads/*` only:

```ts
type BranchBaseOrigin =
  | { v: 1; oid: string; lineageHash: string; kind: "pull-p"; episode: string }
  | { v: 1; oid: string; lineageHash: string; kind: "publisher-ack";
      sourceSeq: number; incomingKey: string }
  | { v: 1; oid: string; lineageHash: string; kind: "manual"; episode: string }
```

An origin is usable only when its key is R, its OID equals `base.refs[R]`, and its lineage
is current. Exact P settlement and P-repair write `pull-p`; an accepted push ACK may write
`publisher-ack` only for a value this device actually captured and committed; confirmed
manual mutation writes `manual`. The composer changes the BASE member and origin together.
Carry retains a matching origin, absence removes it, and a changed/missing/mismatched origin
makes that positive BASE `legacy-untrusted`. Migration, equality observation, the
already-converged shortcut, legacy map folding, and old writers can neither create nor
upgrade provenance. Tombstone authorization requires a usable positive origin in addition
to live and BASE equality. Thus an old writer that drops the map causes a hold, while one
that preserves a stale map cannot bind it to a different OID.

### Present-transition artifact

A separate short-lived artifact proves rbox transitions that end present:

`P(R) = refs/rbox-local/base-present/v2/<lineageHash>/<sha256(UTF-8 R)>`

Its target blob is canonical JSON:

`{"episode":"<128-bit hex>","lineageHash":"<64hex>","nextOid":"<N>","priorOid":"<L-or-null>","ref":"<R>","repositoryIdentityHash":"<64hex>","v":2}`

It uses the same direct-ref, exact-schema, branch-scope, OID, and hash-suffix validation as
A. `P(R)` is created expected-absent in the same ref transaction as every rbox branch
create or update that may advance pull BASE. The transaction forces a reflog entry for
`R` whose message is the episode:

- present→present: `{create P(R), create K(P,*), update R N L}`;
- absent→present: `{create P(R), create K(P,*), create R N, delete A(R) M}`.

The same transaction creates one episode-scoped reachability ref for each non-null OID
named by P:

`K(P,slot) = refs/rbox-local/base-present-keep/v2/<lineageHash>/<sha256(R)>/<episode>/<prior|next>`.

Each K directly targets its OID and is excluded from capture and identity. K keeps P's
evidence available across user or old-binary movement, reflog truncation, and GC. A
standing P is invalid unless every required K exists at the exact OID. Exact settlement
deletes P and K only after BASE is durable. P-repair durably creates permanent human-origin
pins in its prior pin-only phase before deleting P and K. Rollback journals carry
the exact K targets and delete them in every inverse that deletes P. At two K refs per P,
the 256-P cap also bounds this namespace at 512 refs.

Only one P may stand for a ref **within a lineage**. Any foreign P for the same R is a
hard mutation veto, so another record cannot recover, retire, or compose from it. Another
transition in the owning lineage must first settle or repair its P. P is crash authorship
only: it never matches a tombstone and never authorizes BASE absence.

### Prevalidated attestation map

After strict wire validation and before ref-plane planning, apply orchestration builds one
immutable attestation map keyed by branch ref and tombstoned OID. Each entry is bound to the
exact `gitIncomingKey` and contains the direct live OID, logical BASE OID, validated
positive-origin disposition, owning-lineage A/Z/P/K disposition, same-branch foreign
artifact scan, and the D2-revalidated pending evidence used to derive it.
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

- `pull-ref-transaction` carries exact branch A/P witnesses, exact non-branch safe-ref
  witnesses, and locked live/reflog facts;
- `pull-carry` may retain ref members and change permitted non-ref fields, but may not
  change a ref member;
- `journal-recovery` carries the journal's exact transaction witnesses rather than
  trusting its intended section;
- `publisher-ack` may add or advance present members this device advertised, but may
  not remove them;
- `manual` carries the freshly confirmed snapshot, the locked second proof, and the exact
  per-ref terminal decision. It may land only that confirmed candidate. Branch absence
  still requires A/Z; a branch transition that created P still settles through P; and an
  already-terminal positive branch with positive previous BASE, for which the confirmed
  episode performed no ref mutation, receives a new `manual` origin rather than invented P
  authority;
- `p-repair` may retire a quarantined P episode and materialize only the exact
  historically proved P transition under the pre-state rule below; it may never remove a
  BASE member or overwrite a later third positive value; and
- `migration` may import legacy positive state but may not remove a present member.

The proof rules are expressly limited to `refs/heads/*`. For each branch in
`keys(previous.refs) ∪ keys(candidate.refs)`, canonical refname order, unchanged presence
and its matching positive origin are retained; a pull addition or change requires a valid
current-lineage P witness; and present→absent requires locked R absence plus the exact
current-lineage A or settled-absence entry. A publisher ACK may add or advance a branch
only with a new `publisher-ack` origin and retains omissions. Migration may import a
positive member only as `legacy-untrusted`. Missing, malformed, foreign, stale, or
mismatched proof retains the previous member, keeps the incoming section pending, and
returns a typed hard hold.

Syncable non-branch refs use a distinct witness which is never valid for
`refs/heads/*`:

```ts
type SafeRefWitness =
  | { kind: "safe-ref"; proof: "expected-old-transaction";
      beforeOid: string | null; afterOid: string | null }
  | { kind: "safe-ref"; proof: "locked-terminal-observation";
      afterOid: string | null }
```

The map key is the refname. It must be `refs/tags/*` or `refs/stash` in a dir repo and be
admitted by the repo's effective scope. Non-null OIDs are strict 40-hex values. An
`expected-old-transaction` witness is returned only after the generic update-ref
transaction commits one exact non-no-op shape: absent→`afterOid` create,
`beforeOid`→`afterOid` expected-old update, or `beforeOid`→absent expected-old delete.
`beforeOid` is the locked live expected-old value, which need not equal previous BASE;
`afterOid` must equal the candidate member, and the two endpoints must differ.

A `locked-terminal-observation` verifies the candidate OID or absence under the D2 ref
reservation and exists so retry can reconstruct a mutation that crashed after Git commit
but before partial persistence without inventing its unknowable expected-old value. It is
valid only while the same `incomingKey`, previous BASE projection, candidate member, and
terminal live value all match. Thus create, change, and delete are all expressible,
including `afterOid:null`; a user move away from the terminal value invalidates the witness
and holds. A pending-key-identical, D2-valid transaction witness is retained across retries
instead of being downgraded to a later equality observation. For `refs/stash`, either form
with a present `afterOid` also requires successful idempotent reflog verification/repair
before it is accepted; an absent terminal verifies ref absence, while the preservation gate
has already pinned displaced reflog OIDs.

This is the typed form of today's generic safe-ref loop: after the hold/ambiguity and
preservation gates it emits `update`, `create`, or `delete` with the exact expected old
value (`src/cli/sync-git/follow.ts:605-675`). Tags/stash never create or consume A/P/K,
never receive `BranchBaseOrigin`, and a `SafeRefWitness` can neither authorize a branch
BASE change nor satisfy tombstone provenance.

The rest of the section is total and deliberately preserves today's whole-section lane
semantics rather than inventing hybrids:

- For a dir repo, `refs/tags/*` and `refs/stash` use the existing generic expected-old safe-ref
  publication; all-scope omission may delete them. Stash additionally protects every stash
  reflog OID and creates/repairs its reflog. For a pointer repo, effective refs contain only
  `refs/heads/*` and omission never deletes (`follow.ts:482-489,529-675`). Tags and stash
  never require or produce A/P, and they never satisfy branch provenance.
- If any ref is held or checkout remains pending, persisted BASE carries **all** previous
  tags/stash and all previous non-ref fields: `head`, the complete index artifact tuple plus
  `indexTree`, `opState`, `config`, `refScope`, `generatedAt`, `bundleSha`,
  `bundleEncSha`, `bundleCipherSize`, compression/payload fields, and `packChain`.
  The whole incoming section remains `pending`. Exact safe physical changes live only in
  `partial.appliedRefs`; for each non-branch `safe-ref` key, retry overlays the member from
  previous BASE (including its absence) when reconstructing the previous logical identity.
  The transaction's `beforeOid` is physical CAS evidence, not necessarily logical BASE.
  `checkoutPending:false` says the incoming
  HEAD/index/op-state were journal-published; config completion lives in the config lane.
  Retry uses `withoutRboxAuthoredRefs` (`apply.ts:25-52,767-779`).
- With no held ref and a completed checkout, candidate tags/stash and every non-ref field
  advance wholesale. This is the current `base: held ? baseSec : remoteSec` intended-record
  contract and outcome packing (`apply.ts:910-940,984-1000`). The legacy clean path has the
  same old-whole-BASE plus pending on a hold, incoming-whole-BASE on success behavior
  (`apply.ts:1051-1087`).
- Config remains independently retryable. A config failure carries `configBase` and its
  partial marker; unchanged/already-converged Git may still advance the incoming section
  while the config lane retries (`apply.ts:606-617,724-759`).
- Bundle and pack-chain fields describe artifact families, not independently composable
  values. A mixed outcome keeps the entire prior family in BASE and the entire incoming
  family in pending; a terminal outcome replaces the family wholesale. Incoming staging
  and pack import do not by themselves advance it (`follow.ts:220-286,740-806`).

On push, pending is carried byte-for-byte and suppresses capture (`plan.ts:566-576`). Other
carry paths retain the whole BASE, except the independently owned config projection
(`plan.ts:270-385,441-453,507-513,579-607,671-715`). Fresh capture replaces the whole
capture family, with incremental capture only appending the prior pack links
(`plan.ts:741-754`, `shared.ts:219-237`). After commit, a pending repo retains its old
whole BASE; otherwise the committed section advances wholesale (`plan.ts:797-813`,
`push.ts:661-682`). These rules cover every field in `GitSection` and are compile-time
exhaustive when that interface grows.

`lockedProof` means a prepared Git ref transaction, not an in-process mutex. It locks
every affected R, safe ref, and A/P/K ref in bytewise order. Absence verifies `R` absent and
`A(R)=M`. Exact P recovery verifies `R=N` and the exact P/K targets, with their
retirement committing only after the state CAS. Unchanged refs participating in a
reservation are also verified. The state-generation CAS runs while the Git locks remain
prepared. State failure aborts the ref transaction and leaves P/K; state success commits
the transaction.

For a non-branch safe ref whose generic update-ref transaction already committed, the
prepared settlement transaction is verify-only: it reserves the ref and verifies the exact
`afterOid` or absence during the BASE state CAS. State failure releases that reservation
but does not claim to undo the earlier Git commit; previous BASE, pending, and any persisted
transaction witness remain retryable. State success advances the terminal whole-section
lane and discards the witness. The crash-rebuilt terminal-observation form uses the same
verify-only boundary. A no-P manual branch decision likewise verifies exact locked live N
through its state CAS.

The exact global order and P-repair's additional locks are specified below; no state writer
may acquire a Git proof or origin lock in reverse order.

### Complete BASE-writer retrofit

Every current or future BASE writer routes through the composer. The implementation must
retrofit all of these existing sites:

- **Pull initialization and recovery (`src/cli/sync-git/apply.ts`):** map
  initialization, outcome packing, partial-progress local-identity reconstruction,
  recovered-record install/delete, and post-recovery reload. Recovery uses
  `journal-recovery` and never trusts `record.base` alone.
- **Pull repository absence and shortcuts (`apply.ts`):** remote-repository omission,
  unchanged-section advance, already-converged advance, and legacy-conflict composition.
  An already-converged changed branch value without P or confirmed `manual` authority
  holds; an admitted non-branch value uses the exact `safe-ref` terminal witness above.
- **Pull intended and success records (`apply.ts`):** journal RepoRecord construction,
  the current held-vs-remote BASE choice, successful-follow input carry and assignment, and
  clean/legacy success assignment. Mixed-ref results compose per ref; no success assigns an
  incoming section wholesale.
- **Ref mutation and recovery (`src/cli/sync-git/follow.ts`):** safe-ref equality,
  deletion and update planning; pre-journal safe-ref publication; current-ref delete/update
  construction; intended-record capture; and journal recovery/landing. Every mutation
  returns its exact witness. Unchanged present equality may return only `direct`; admitted
  non-branch create/update/delete returns `safe-ref`, and crash retry may rebuild it only
  from the locked terminal observation. Branch mutation returns only A/P witnesses.
- **State folding and install (`src/cli/config.ts` and
  `src/cli/sync-state.ts`):** legacy-to-record folding, records-to-manifest
  serialization, packet installation, generic state save, source record construction,
  record-to-input copy, legacy reconstruction, and opaque journal-lane replacement/retry.
  Concretely this includes `config.ts:336-374,379-466,566-600`,
  `sync-state.ts:102-223,225-291`, and the published-intent merge/save at
  `sync-state.ts:320-457`; that merge composes BASE rather than replace-copying its
  apply fields. `StateSource` carries `repoProofs[relPath]`, whose closed per-repo value
  contains per-ref authority/witnesses: one pull packet can mix carry, A, P, non-branch
  safe-ref, manual, and repair outcomes across and within repos, so a scalar packet
  authority is forbidden. Raw `saveState`
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
  `base: incoming` assignment is replaced by the per-ref `manual` authority protocol.
- **All four production state sources:** pull's mixed apply/global source
  (`src/cli/sync/pull.ts:258-286`), push's deferral-only save
  (`src/cli/sync/push.ts:452-469`), push's no-op bookkeeping save
  (`push.ts:509-523`), and accepted post-commit ACK (`push.ts:665-682`). The first has
  per-repo/per-branch proof; both bookkeeping sources are carry-only; only the fourth is
  `publisher-ack` and may create publisher positive origins.

State construction coverage alone is insufficient. Every production mutation of a
syncable branch routes through a typed branch-transition planner/executor that requires
lineage, logical BASE effect, and A/P/K/settled-absence plan, and returns the exact committed
witness. Rollback consumes its typed inverse. The allowlisted sites are non-current safe
refs (`follow.ts:605-675`), current-ref checkout plans (`follow.ts:817-874`), low-level
checkout command construction/commit (`engine/git/checkout-txn.ts:315-350,567-730`), legacy
engine create/update/delete (`engine/git/apply.ts:466-575`), clean wipe
(`engine/git/quarantine.ts:60-76`), legacy snapshot restore
(`engine/git/rollback.ts:26-50`), and journal old/new arbitration
(`engine/git/journal.ts:419-441`). Raw `update-ref` remains allowlisted only for
non-syncable scratch, conflict, keep, and protocol refs. Structural tests fixture every
site and reject a new command capable of naming `refs/heads/*` without a typed plan and
inverse.

The files-first path may emit empty Git only for true genesis: no BASE, advertised,
pending, A/P/K, or repository record may exist. Otherwise it enters the same carry and
normalization path.

## Follower authorization and transactions

### Tombstone authorization

For an incoming `refScope:"all"` section that omits `R`, a held non-checkout
branch at live `L` is authorized for deletion only if all of the following hold:

1. the prevalidated attestation map contains `refTombstones[R]` entry `oid=L`;
2. logical `BASE[R]` is **present** and equals that same `L`;
3. `branchBaseOrigins[R]` is usable, current-lineage positive provenance for L;
4. the owning lineage's A/settled-absence entry and P are absent, no orphan or
   mismatched K exists, and no active foreign A/P/K/settled-absence entry names R;
5. the hard ownership proof is otherwise determinate and stable; and
6. `R` is neither the current ref nor owned by a sibling worktree.

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
- `{create P, create K*, create R N, update Z Znext Zprior}` →
  `{delete R N, delete P expected-P, delete K* expected, update Z Zprior Znext}`; and
- when removing R's last settled leaf,
  `{create P, create K*, create R N, delete Z Zprior}` →
  `{delete R N, delete P expected-P, delete K* expected, create Z Zprior}`.

Existing pins remain conservatively over-protective. If any inverse CAS fails, rollback
does not claim restoration and recovery hard-holds. Journals carry both predecessor and
successor Z targets/tree OIDs, so recovery never rebuilds a tree from current state.
Destructive wipe helpers may not mutate a branch outside this wrapper.

### Re-advertisement and A retirement

When logical BASE omits R and incoming advertises `R=N`, normal follow performs an
expected-absent create. If a live A exists, that transaction creates P/K, creates R=N, and
compare-deletes A. If the absence was already compacted, it creates P/K and R while
CAS-updating the settled-absence tree to remove R's exact leaf. Merely observing
`live==incoming` is insufficient: a user-created or old-binary-created occupant, even at
N, fails expected-absent creation, leaves the absence authority in place, and holds. N need
not equal the recorded prior OID.

A or its settled entry retires only inside a capable transaction that **actually
establishes presence**: the expected-absent create above, or an explicitly confirmed manual
CAS that quarantines and pins the exact occupant while creating P/K. Tombstone expiry,
generation change, equality observation, already-converged apply, positive legacy state,
migration, state rewrite, and old binaries never retire absence authority. There is no
automatic returning-reader revalidation path.

This is intentionally conservative when an old binary legitimately applied a
re-advertisement. The operator may delete the occupant and let expected-absent creation
retry, or confirm `take-theirs`; automatic code cannot distinguish that event from a user's
same-OID recreation. Consequently the g1/g2/g3 laundering walk stops at g2: A/settled
absence still overlays the old writer's `BASE=T`, the old positive has no usable origin,
and g3 cannot consume a tombstone.

### Exact P recovery

While P stands, stale serialized BASE is unavailable for tombstone authorization. Exact
recovery prepares locks for R, P, and K, validates their exact targets, and requires live
`R=N` plus the top reflog entry with the exact episode and old/new values. The
CAS-protected BASE must still be P's pre-state or already N. It then materializes
`BASE[R]=N` plus its exact `pull-p` origin by state CAS and compare-deletes P and K
by expected target. Already-N without the matching origin repairs the origin only while
the exact P proof still stands. A third
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

When failure is specifically a locked live-ref, reflog, or protected-BASE-shape mismatch,
v11 executes `p-repair`. It first enumerates the current observation set

`Sobs = {P.priorOid when non-null, P.nextOid, live R when present} ∪ {every non-zero old/new OID in R's complete reflog}`.

Because origin preparation precedes the ref/state transaction, an aborted earlier attempt
may already have added the exact repair origin to other OIDs. Let `Sprior` be every valid
sidecar OID key already carrying `(ref=Q(P), episode=P.episode)`, and define cumulative
`Skeep = Sobs ∪ Sprior`. The entire reflog is read as bytes, every member of Skeep must
exist, and every member receives or retains a permanent pin. This deliberately does not
apply reachability filtering: post-P
reflog-only U in `N→U→N` is human evidence and must survive truncation and GC. The
reflog bytes and Sobs are re-read under the final lock boundary while the locked sidecar
reconstructs Sprior; any difference, missing cumulative member, or
unpreservable object leaves P/K intact.

#### Bounded Q record

`Q(P)` is the deterministic direct ref

`refs/rbox-recovery/base-present/v2/<lineageHash>/<sha256(UTF-8 R)>/<episode>`.

It targets RFC 8785 canonical JSON with this exact closed schema:

```ts
type ByteProjection = {
  bytes: number;          // full source byte count, safe unsigned integer
  sha256: string;         // full source bytes
  prefixB64: string;      // base64 of at most the field cap's first bytes
  truncated: boolean;     // exactly bytes > cap
};

type PRepairQ = {
  v: 1;
  kind: "p-repair";
  lineageHash: string;
  repositoryIdentityHash: string;
  p: {
    artifactRef: ByteProjection;       // cap 384 source bytes
    artifactOid: string;
    payload: {
      v: 2;
      lineageHash: string;
      repositoryIdentityHash: string;
      ref: ByteProjection;             // cap 768 UTF-8 bytes
      episode: string;
      priorOid: string | null;
      nextOid: string;
    };
    payloadBytes: number;
    payloadSha256: string;
  };
  observed: {
    liveOid: string | null;
    baseOid: string | null;             // serialized RepoRecord.base.refs[R]
    repoGen: number;
    stateRevision: number;
    incomingKey: string | null;
    reflog: {
      bytes: number;
      entries: number;
      sha256: string;
      top: ByteProjection | null;       // cap 2,048 raw bytes
    };
  };
  preserved: { count: number; oidsSha256: string };
  repair: {
    at: string;                         // canonical UTC RFC 3339 milliseconds
    reason: "live-mismatch" | "reflog-mismatch" | "base-shape-mismatch";
    baseDisposition: "advance-prior-to-next" | "already-next" |
      "preserve-absent" | "preserve-third";
  };
};
```

Every hash and OID has its ordinary exact lowercase-hex width; episode is 32 lowercase hex;
counters are non-negative safe integers. If mismatches coexist, `repair.reason` uses the
fixed priority `base-shape-mismatch > live-mismatch > reflog-mismatch`.
`payloadSha256` covers the full canonical P blob bytes. `oidsSha256` covers sorted unique
Skeep as concatenated decoded 20-byte OIDs, not textual
JSON. Base64 prevents JSON escaping from expanding arbitrary reflog bytes. Projection
prefixes stop only at the byte cap; the full byte count, full hash, and `truncated` flag
preserve oversized-valid-content evidence. With all prefixes maximal, canonical Q is below
8,192 bytes; construction has no data-dependent field outside these caps. A valid moved P
is therefore always quarantinable. A max-fixture byte-count test is normative.

#### Existing keep-pin model and repair origin

Permanent refs retain their existing deterministic, content-addressed name:

`refs/rbox-local/keep/<oid>`.

There are no lineage-named permanent pin refs. The shared
`<commonDir>/rbox-keep-origins.json` remains
`Record<oid, KeepPinOrigin[]>`, where the actual model is
`{ref,episode,time,class}` (`keep-pins.ts:12-31,66-105`). For every OID in Skeep, repair merges:

```ts
{ ref: Q(P), episode: P.episode, time: originTime, class: "human" }
```

Existing merge identity is exact `(ref, episode)` and human promotion is monotonic; retry
retains that OID's stored time when the exact origin already exists, otherwise
`originTime = Q.repair.at`. Time is diagnostic and receipt validation checks only ref,
episode, and class. The implementation adds a strict,
bounded sidecar parser, locked filter/rewrite support, and a lower-level create-only pin
helper. Repair first commits the idempotent **pin-only** transaction for every Skeep OID,
then merges and fsyncs the origins. This reverses current `prepareKeepPins`' internal order
only for repair: a crash in the gap leaves a reachable, possibly originless pin, never an
origin whose post-P object can be GC'd. Such a pin is harmless over-protection and is
diagnosed and is never automatically deleted; future pin sweep/cleanup must take the
common-dir and sidecar locks. Provenance
is still durable before the destructive P retirement. The final repair transaction verifies
the exact keep refs rather than first creating them. A lineage
cleanup removes only origins whose `ref` has that lineage's strict Q prefix and whose
episode syntax is valid, including origins for evicted Q metadata; it compare-deletes a
content pin only when no origin of either class remains.

#### Repair, receipt, and BASE disposition

After the Q bytes and pin origins are durable, repair computes BASE from the exact
CAS-protected serialized `RepoRecord.base.refs[R]`; while P stands this observed member is
not independently usable logical BASE. Prior value (including absent for `priorOid:null`) advances to
`nextOid` with a `pull-p` origin; already-next retains or repairs that same origin; an
unexpected absence or third positive is preserved without provenance invention. It replaces
only the P-bound partial/journal member with a bounded `p-repaired` receipt. Unrelated
members and published/rollback state stay intact, and recovery never attempts the obsolete
P inverse.

The receipt contains the exact lineage/repository/ref/episode, P ref+target, every K
ref+target, Q ref+target, the complete bounded `PRepairQ` value, the exact origin identity,
Skeep count/hash, reflog byte count/hash, chosen BASE disposition, and
`eviction:null | { qRef:string; targetOid:string }`. When the Q cap requires eviction,
that field freezes the oldest `(Q.repair.at, refname)` victim and exact expected target
before the state CAS. Keeping Q's bounded value
in state is required: after state CAS but before Q ref creation, GC may collect an otherwise
unreferenced Q blob; retry rewrites the canonical bytes and verifies the same object OID.
The receipt remains until ref-side completion is observed.

After the pin-only transaction, repair reacquires/revalidates the current R/reflog view and
extends cumulative Skeep if necessary. Any extension loops back through pin-only creation,
then origin merge+fsync, then revalidation; final preparation begins only when a complete
iteration leaves Sobs/Skeep unchanged. While the final Git transaction remains prepared,
`p-repair` generation-CASes that BASE and receipt. It then atomically creates Q
expected-absent, verifies every content-addressed keep ref, and compare-deletes P and every K. Unavailable objects,
malformed/colliding/foreign P, contradictory A/P, indeterminate reads, or preservation
failure are holds, not movement repair.

#### Exact lock order

The current code already has these nested orders: workspace sync mutex
(`sync-mutex.ts:122-170`) → per-common-dir in-process `chainLock` keyed by resolved path
(`apply.ts:1114-1140`) → checkout prepared Git locks → explicit ref reservations →
`ORIG_HEAD.lock` → `index.lock` (`checkout-txn.ts:560-645`). A branch-switch primary
commit then releases its prepared locks before acquiring the arbitration `HEAD.lock` and
the exceptional post-HEAD ref transaction (`checkout-txn.ts:677-730`). Separately, partial
persistence takes sorted ref locks → `<state>.lock` (`apply.ts:1197-1247`,
`config.ts:415-460`). `config.lock` is a standalone transaction under the workspace/common
prefix and is released before any proof-boundary lock is acquired
(`config-txn.ts:354-390`). The in-process queue is not a cross-workspace lock, but it is
still an earlier lock class.

The normative global order is:

1. workspace sync mutex;
2. per-common-dir in-process `chainLock`, with nested/multi-dir acquisitions in canonical
   common-dir realpath byte order;
3. durable `<commonDir>/rbox-operation.lock` locks in that same order, using the existing
   owned-marker/reaping implementation; every A/P/K/Q/Z or shared-origin mutator takes it;
4. optional per-R reflog-maintenance locks in bytewise R order at
   `<commonDir>/rbox-locks/reflog/v1/<sha256(UTF-8 R)>.lock`;
5. optional `<commonDir>/rbox-keep-origins.json.lock`;
6. the primary prepared Git transaction's ref, symref/HEAD, packed-ref, reflog, protocol,
   and content-pin locks, commands supplied in bytewise refname order;
7. checkout-only explicit unchanged-ref reservation locks in bytewise refname order;
8. checkout-only `ORIG_HEAD.lock`;
9. checkout-only `index.lock`;
10. workspace `<state>.lock`.

P-repair uses 1→6 for its pin-only transaction, then 1→6→10 for its final prepared
transaction; it never acquires checkout classes 7–9. Ordinary checkout uses 1→3→6→7→8→9
and never acquires state while those checkout locks stand. After the primary commit, the
documented Git compatibility exception acquires branch-switch `HEAD.lock` and then the
post-HEAD ref transaction while reservations/index remain; these two are a separate
checkout phase, never coexist with class 6 or state, and no other path may copy that
inversion. Checkout releases all such locks before partial persistence reacquires class-6
sorted ref locks and then state. `config.lock` never nests with classes 4–10.

Release is reverse within each phase; no holder of a later class may acquire an earlier
one except the named post-HEAD compatibility phase. All rbox reflog expiry/rewrite takes
class 4. Prepared R.lock excludes ordinary Git reflog expiry; the final byte fingerprint
detects a hostile direct filesystem replacement.

#### Idempotent retry matrix

| Durable observation | Required action |
|---|---|
| No receipt; P/K exact; Q absent | Recompute repair. Unreferenced Q blobs or already-merged exact origins are harmless over-protection. |
| Ref prepare or state CAS rejected | Abort the ref transaction; P/K remain authority; reload. |
| Matching accepted receipt; P/K exact; Q absent; live/reflog still match; frozen eviction victim is present at its exact target (or eviction is null) | This is the state-CAS-success/ref-commit-crash case. Recreate Q bytes from the receipt, enumerate sidecar keys with the exact `(Q ref,P episode)` origin, verify Skeep count/hash, revalidate A/R/P/K and the victim, then commit the **same ref-side transaction** without recomposing BASE or changing time. |
| Matching accepted receipt; P/K exact; Q absent; live/reflog changed | Remain in repair: compute and pin cumulative Skeep, build a new bounded Q, and generation-CAS replace **only** the receipt. BASE is already next/preserved and cannot regress. Retry until one stable receipt commits; older origins remain included harmless over-protection. |
| Matching receipt; Q exact; P/K absent; all keep refs exact; frozen eviction victim absent (or eviction null) | Commit completed. Compact terminal bookkeeping and restart from disk. |
| Commit outcome unknown | Inspect under the same locks; only one of the preceding two complete shapes is accepted. |
| Q and P coexist without the matching accepted receipt, wrong Q target, partial K retirement, missing/wrong keep ref, origin-set hash mismatch, or a mixed/wrong eviction-victim shape | Artifact contradiction; hard-hold. Never overwrite forensic state. |
| Q exists and P is absent but an old writer dropped the receipt | Q proves preservation, not BASE movement. Restore only bounded terminal bookkeeping when binding and targets validate, preserve current BASE, and restart. |
| Q absent, P absent, no matching receipt | Corruption hold. |

After success the old plan, attestation map, and snapshots are discarded and evaluation
restarts. P-repair itself never supplies tombstone attestation. P is historical authority
only when BASE is still its exact pre-state; a later positive BASE is never overwritten.

Q is capped at **256 records per active lineage**. Before adding the 257th, the same
transaction expected-target-deletes the oldest valid Q by `(Q.repair.at, refname)`.
Its permanent human pins remain, so eviction drops forensic metadata rather than object
recovery. Eviction is warned and counted by `doctor`. Deleting a whole retired lineage
locks and validates that lineage's Q prefix, expected-target-deletes all remaining Q refs in
canonical order, then filters the shared sidecar by the same strict internal Q prefix and
episode grammar. Objects with another origin stay pinned. Active-lineage repair-pin origins
otherwise do not age, so their potentially unbounded object-graph cost is diagnosed rather
than hidden.

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
commits, A reconstructs logical absence, the locked expected-absence reservation, and
the transition even if the process died before partial state, the checkout journal, or the
state CAS, and even if the tombstone later expired or was evicted.

If serialized BASE still contains R, this unmaterialized committed transition reconstructs
`tombstone-pruned-this-cycle` exactly once. Once the locked state CAS materializes the
absence, later cycles do not raise the same-cycle veto merely because A or its compacted Z
leaf remains.

`GitPartialApply.appliedRefs` may record
`{kind:"absent", artifactOid:M}` or
`{kind:"present", oid:N, artifactOid:P, episode}` for branches, and either
`SafeRefWitness` form above for admitted tags/stash. The A/P forms are invalid for a
non-branch ref; `safe-ref` is invalid for a branch. `{kind:"direct"}` is valid only for
unchanged present equality and is observation-only: it cannot stand for a BASE-changing
transition. Existing symbolic equality remains observation-only as well.

All records are pending-key-bound, D2-revalidated hints. A valid persisted
`expected-old-transaction` safe-ref witness survives a retry that now observes direct
equality. If the process crashed before persisting it, retry may construct only the
`locked-terminal-observation` form, never a fictional `beforeOid`. Raw or prevalidated
partial presence never establishes branch BASE provenance or authorizes a tombstone. A/Z/P
may rebuild only branch hints; the locked terminal rule may rebuild only non-branch hints.
No witness changes BASE by itself: a mixed outcome keeps previous BASE and pending, while
terminal composition consumes the typed witnesses and advances the whole candidate lane.

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
BASE admits present additions and advances with exact `publisher-ack` origins but retains
every omitted ref and its matching origin. This prevents
resurrection and repeat re-supersession without claiming an unperformed deletion.
Reappearance clears suppression only through normal apply or capture. Active-lineage record
GC never removes the BASE anchor, even when `.git` is gone.

## Manual resolution

`take-theirs` retains snapshot confirmation, quarantine, permanent human pins, and the
locked second proof. It never writes wholesale BASE.

The composer's `manual` authority is bound to the episode, `snapshotId`, `incomingKey`,
candidate, state generation, fresh confirmation, locked second-proof receipt, and exact
per-ref witnesses. It is single-use. Once the second proof succeeds, the checkout journal
records that bounded receipt; recovery derives only `journal-recovery` from the recorded
decision. A crash before the receipt is durable requires a fresh snapshot and confirmation,
not inference from live equality.

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
value while atomically deleting A or the exact Z leaf and creating P; quarantine and pins
preserve what was displaced. Incoming presence from present likewise creates P around the
expected-old update. P settlement records `pull-p`; a manual no-P terminal decision records
the exact `manual` origin. That no-P case is limited to a positive branch whose freshly
confirmed candidate already equals locked live R, whose previous logical BASE is also
positive, and for which the episode performs no branch mutation. It revalidates reflog,
ownership, lineage artifacts, state generation, and the absence of any owning or foreign
A/Z/P/K contradiction. It may replace that positive BASE member and origin, but cannot
cross logical absence, remove a member, infer absence, retire A/Z, bypass P, or be reused by
another incoming key. Manual tag/stash create/update/delete uses only
`SafeRefWitness`; it never creates A/P or any branch origin.
Any snapshot, reflog, A/P/K, sibling-worktree, or CAS mismatch aborts without BASE change.
Only the mandatory composer lands the journal result.

## Artifact lifecycle, reset, and diagnostics

A survives ordinary state saves and tombstone expiry until serialized absence is durable.
It then compacts into the owning lineage's settled-absence ledger:

`Z = refs/rbox-local/base-absent-settled/v1/<lineageHash>`.

Z directly targets an immutable Git tree. Its root contains `meta`, a canonical JSON blob
`{"count":<n>,"lineageHash":"<64hex>","repositoryIdentityHash":"<64hex>","v":1}`,
and one exact A-payload blob at
`entries/<first-two-refHash-hex>/<remaining-62-hex>`. Names, modes, object types, count,
payload lineage, ref hash, and duplicate/collision absence are all validated. Point lookup
is by ref hash; the leaf's full R resolves hash collisions. The blob records OIDs as text,
so Z does not keep commits reachable.

After the state CAS has removed R from serialized BASE and its origin map, a new Z tree is
built and one ref transaction CAS-creates/updates Z while compare-deleting A. A crash leaves
either A or the Z leaf, never neither. Logical absence is their union. Re-advertisement
builds the successor Z tree without that leaf and atomically creates P/K/R while
CAS-updating or deleting Z. Old immutable trees become ordinary unreachable GC material.
Thus the **4,096 A cap bounds only unsettled crash artifacts**, not lifetime deletions;
normal settlement compacts immediately and the 4,097th sequential prune remains available.

P normally survives until exact positive BASE and origin materialization; a valid moved P
survives until P-repair has quarantined and pinned it. K has exactly P's lifetime. Q has the
bounded recovery-lineage lifetime above. All namespaces are excluded from capture and
identity. A common dir may contain at most **4,096 unsettled A refs**, **256 P refs**,
**512 P-lifetime K refs**, **one active Z per logical lineage/repository**, and **256 Q refs
per active lineage**. A/P/K caps refuse before mutation without eviction. `doctor` reports
active and foreign counts, Z entry counts/tree OIDs, repair-origin counts and bounded
lexicographic examples; the daemon emits one bounded warning per boot.

Reset, rebind, and stream-mismatch freshening use the same lock order and recover a standing
reset journal before any ordinary state load. They settle or P-repair every valid P,
compact every valid A into Z, and refuse malformed artifacts, orphan/mismatched K,
unpreservable repair, or published checkout journals. Valid settled absence is no longer a
reset refusal. Degraded or fence-free reset is forbidden.

The journal path is `<root>/.rbox/state/reset-v1.json`; candidates live at
`.rbox/state/reset-candidates/<id>.json`, and the exact old state archive is
`.rbox/state/lineages/<oldStateNonce>/<oldStateSha256>.json`. The journal is a no-follow,
atomically written+fsynced file with this exact bounded schema:

```ts
type ResetJournalV1 = {
  v: 1;
  id: string; // 32 lowercase hex
  phase: "prepared" | "ready" | "installed" | "z-retired";
  createdAt: string;
  old: {
    stream: string;
    stateNonce: string;
    stateRevision: number;
    stateSha256: string; // exact pre-reset state.json bytes
    z: Array<{
      lineageHash: string;
      repositoryIdentityHash: string;
      repositoryIdentity: {
        relPath: string; kind: "dir" | "pointer";
        worktreeId: string; gitDirReal: string; commonDirReal: string;
        dev: string; ino: string; birthtime: string;
      };
      activeRef: string;
      targetOid: string;
      recoveryRef: string;
    }>;
  };
  next: {
    stream: string;
    stateNonce: string;
    stateRevision: number;
    stateSha256: string;
    state: {
      stream: string;
      stateNonce: string;
      stateRevision: number;
      lastSyncedSequence: 0;
      lastSyncedManifest: { generatedAt: ""; files: [] };
      repoRecords: {};
      telemetryBindingId?: string;
    };
  };
};
```

Hashes/OIDs/nonces have their ordinary exact widths; timestamps and counters use the Q
rules. Z entries are sorted by `(activeRef,targetOid)` and bounded by the 256-repository
limit. `recoveryRef` is exactly
`refs/rbox-recovery/base-absent/v1/<lineageHash>/<targetOid>`. The candidate/archive paths
are derived from validated journal fields, never accepted from JSON. A recorded common-dir
path is used only after its complete `RepoIdentityV1` re-encodes to the recorded hash and
its realpath/stat incarnation still matches. The next-state bytes are RFC 8785 canonical
JSON plus one LF; `next.stateSha256` covers those exact bytes, while the old hash covers the
pre-existing raw bytes verbatim. A journal with an
unknown field, bad ownership marker, unsafe path derivation, duplicate Z ref, or mismatched
hash is a reset-corruption hold and is never overwritten.

The cutover is:

1. Under all locks, verify exact old state bytes/stream/nonce/generation, repository
   identities, Z targets, and absence-shaped BASE. Construct the small exact `next.state`
   with a fresh nonce (preserving `telemetryBindingId` when present), hash it, and fsync the
   `prepared` journal before changing refs or active state.
2. Write/fsync the exact next-state candidate; copy the exact old bytes expected-absent to
   the hash-addressed archive (an existing byte-identical file is idempotent); and create
   every recovery Z ref expected-absent or verify its exact target. Revalidate old state and
   active Z, then fsync phase `ready`.
3. Atomically rename the candidate **over** `.rbox/state.json` and fsync `.rbox`; there is
   no missing-state window. Fsync phase `installed`, then write the matching
   `state-incarnation.json` marker.
4. Revalidate the exact new state/marker and every active/recovery Z pair, compare-delete
   the journal-listed active Z refs, fsync phase `z-retired`, then delete the journal and
   candidate directory entry durably.

Recovery is deterministic:

| Phase/observation | Recovery action |
|---|---|
| `prepared`, active state exactly old | Regenerate/verify candidate, archive, and recovery Z copies; if all exact, advance to `ready`. |
| `prepared`, active state differs from old | No cutover was authorized in this phase. Preserve the intervening state and every active Z, quarantine any candidate, retain forensic copies, clear the journal, and restart from fresh observations. |
| `ready`, candidate exists and active state changed | Cutover did not occur. Apply the same preserve/quarantine/restart action. |
| `ready`, candidate exists, active state exactly old | Perform the atomic replacement and advance to `installed`. |
| `ready`, candidate absent | Rename committed before the phase fsync. Recreate exact next bytes from `journal.next.state`, install/verify them, and advance to `installed`; an old-binary rewrite after the rename is archived but cannot cancel the confirmed reset. |
| `installed`, active state missing/old/other | Reinstall exact bounded `next.state`, then repair/verify the incarnation marker. Never expose or compose from the intervening bytes. |
| `installed`, active state and marker exact; each active Z is either exact-present or absent | Per common dir, compare-delete the exact-present remainder; exact-absent entries are already retired. Advance only when all are absent. |
| `z-retired`, active Z absent and recovery copies exact | Delete journal; reset is complete. |
| Candidate/archive/recovery ref has a wrong target, active Z has a wrong target, or one common-dir transaction has a physically impossible mixed result | Corruption hold; preserve all bytes/refs and report exact paths/targets. |

Thus a crash before cutover keeps old Z authoritative; a forensic-Z copy committed before
cutover is harmless. A crash after the atomic replacement is recognizable by the missing
candidate even if an old binary rewrites or recreates active state before phase fsync. A
cutover never retires Z until exact new state and marker are durable. Recovery-namespace
Z/Q is forensic only and does not veto the new lineage. Any other active foreign A/Z/P/K
for R remains a physical-mutation veto. Whole retired-lineage deletion removes its state
archive and recovery metadata together, then uses the shared-origin filter above; shared
pin origins survive.

## §126 interaction

Expected absences and their exact A targets or Z tree/leaf targets are carried into checkout
reservations and verified under the ref locks at §126's second proof. An absence is a
reserved fact, not an unchecked gap. A next-cycle recreation between the initial snapshot
and locked proof therefore cannot race a stale-breadcrumb waiver.

A tombstone prune vetoes breadcrumb healing in the same cycle. After a crash, A plus stale
serialized BASE reconstructs that veto once. After BASE materializes the absence, A or Z
does not veto every later cycle; the next cycle may heal with both absence and A/Z verified
under locks.

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

1. Tombstone authorization requires positive, present-and-equal BASE **and** a matching
   current-lineage positive origin. Equality or legacy state alone never authorizes.
2. A live A or active Z leaf blocks tombstone authorization for that ref regardless of surrounding state.
   Old binaries neither create nor touch `refs/rbox-local/*`.
3. Absence authority retires only in a capable transaction that expected-absent creates a
   present result, or by explicit confirmed manual CAS; it is never revalidated from old
   positive state.
4. A live P blocks use of serialized BASE until a capable reader settles exact recovery or
   v11 quarantines and retires a moved P through P-repair.
5. Old readers ignore the unknown wire fields. Capable readers strictly validate container
   shape, `refs/heads/*` grammar, 40-hex OIDs, canonical timestamps, caps, duplicate
   OIDs, strictly increasing per-ref generations, and the safe-integer high-water mark
   before building any attestation.
6. An old writer may drop tombstone chains and the high-water mark at any time. This loses
   authorization and causes holds; it cannot create authorization. Dropping
   `branchBaseOrigins` likewise converts positives to legacy-untrusted.

The required capable→old→capable walk is:

- capable rbox prunes `R=T`, atomically creating A and making logical BASE absent;
- during the old interval, the binary may leave R absent, legitimately re-apply a
  publisher re-advertisement and record `R=T, BASE=T`, rewrite state, or coexist with
  a user recreation;
- returning capable rbox sees A/Z and cannot delete R or auto-retire absence, regardless of
  the positive state around it;
- expected-absent creation can proceed only after the occupant is absent; otherwise explicit
  manual confirmation is required; and
- a later tombstone requires a fresh usable positive origin as well as live/BASE equality
  and every hard gate.

If the old interval moves refs, reflogs, or state while P stands, returning v11 performs
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
  every enumerated `apply.ts`, `follow.ts`, `config.ts`, `sync-state.ts`, `plan.ts`,
  `git-cmd.ts`, all four pull/push `StateSource` constructors, published-intent merge,
  push ACK, and telemetry site. AST fixtures cover every branch mutation and inverse in
  engine apply/quarantine/checkout/journal/rollback. A new direct assignment, raw state
  write, unproved `refs/heads/*` command, or unhandled authority member fails.
- Cross previous `{R1=L1,R2=L2}` with absent/same/changed candidates and
  valid/missing/malformed/mismatched A/Z/P and positive origins. Only locked absence+A/Z
  removes a member; only P, publisher ACK, or manual authority creates a usable positive
  origin; publisher ACK never removes; refusal retains prior and pending. Migration,
  equality, and old-state positives remain legacy-untrusted. A valid R1 prune composes
  beside an unrelated held R2.
- Total field matrix: dir versus pointer; branch versus tag versus stash; generic tag
  expected-old behavior; stash reflog preservation/publication; current branch through the
  checkout journal; side-ref hold before and after successful checkout; config failure;
  no-hold success; pending push carry. Mixed outcomes retain the complete previous
  non-branch/non-ref/bundle family in BASE and exact incoming whole section in pending;
  terminal outcomes advance it wholesale.
- Cross `safe-ref` create/update/delete for a tag and stash, including `beforeOid:null` and
  `afterOid:null`; persisted transaction versus crash-rebuilt locked-terminal proof; direct
  equality never standing for a change; prior transaction proof surviving later equality;
  and stash reflog repair on retry. Wrong ref class/scope, pending key, candidate, live
  value/absence, before/after shape, or malformed OID holds. Reject A/P on tag/stash,
  `safe-ref` on a branch, and every non-branch witness for a pointer repo. Identity retry
  overlays previous BASE rather than transaction `beforeOid`.
- Exhaust the closed authority union, including `manual`. A no-P manual positive requires
  positive previous BASE, the fresh snapshot, and locked terminal branch equality, and
  writes a matching `manual` origin; it cannot cross absence, remove BASE, retire A/Z,
  bypass P, cross incoming keys, or survive a
  state-generation/artifact/ownership/reflog race. Crash before its journal receipt requires
  reconfirmation; exact journal recovery is single-use.
- Race every proof→state boundary, fail the state CAS, and stress multi-repo lock ordering.
  Pins and P retirement commit only with their intended transaction.
- Old-writer re-advertisement with `live=BASE=N` while A/Z stands always holds; no automatic
  verify/delete-A transaction exists. Only a capable expected-absent create/P transaction
  or confirmed manual CAS retires absence. Exercise old writers that drop the origin map,
  preserve a stale matching-OID origin, or change BASE while preserving a stale origin.
- Repository suppression matrix: remote omission, missing local directory, structural
  drop, `syncGit:false`, missing-dir push, and publisher ACK retain BASE anchors,
  update only advertised, suppress the wire projection, do not resurrect, and do not
  re-supersede twice. True-genesis is the only files-first empty path.

### Authorization, preservation, and branch transactions

- Exact live+tombstone+present BASE+usable-origin equality through the prevalidated map
  authorizes; BASE/origin mismatch, A/Z/P/K inconsistency, coincidental same-OID local ref,
  stale map, or partial state alone holds.
- Ambiguity, forced hold, sibling ownership, indeterminate proof, unstable reflog, busy
  state, and current ref are never waived; only `local-commits` may be bypassed.
- Atomic delete creates pins+A and deletes expected R together. Inject every CAS failure
  and crash boundary. Exercise every deletion plane and every exact rollback inverse.
- Re-advertisement from a non-final and final Z leaf journals exact predecessor/successor
  tree targets; force clean/checkout rollback and verify its CAS inverse restores Z while
  deleting R/P/K. Crash before, during, and after each inverse commit.
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
- Mixed non-branch/manual walk: start a dir repo with previous BASE
  `{topic:L, v1:T0, old:TD, stash:S0}`, no `v2`, and incoming
  `{topic:N, v1:T1, v2:T2, stash:S1}` with `old` omitted. Let live `topic=N` be an
  already-terminal user value that lacks P and therefore holds branch BASE. The generic
  safe-ref path expected-old updates `v1`, creates `v2`, deletes `old`, updates stash, and
  repairs its reflog; then crash after those Git commits but before partial persistence.
  Restart under the same incoming key: locked terminal observations prove
  `T1/T2/absent/S1`, retry overlays `T0/absent/TD/S0` from previous BASE, persists the four
  safe-ref hints, retains the entire old BASE family, and keeps incoming pending while the
  branch still holds. `take-theirs` then takes a fresh snapshot and locked second proof;
  because `topic=N` is stable and no P or branch mutation exists, the new `manual`
  authority lands `BASE[topic]=N` with a manual episode origin. With no hold and checkout
  complete, terminal composition advances tags/stash and the non-ref family wholesale and
  drops pending/partial. Assert live=BASE=incoming, no A/P/K or branch origin exists for any
  tag/stash, and the sole new branch origin is `manual`. Race any non-branch terminal or the
  branch after its respective proof: settlement aborts and resnapshots rather than wedging.
- Exact P recovery covers present `L→N`, absent→N, and ordinary create at every
  prepare/commit/state/retirement boundary, with distinct pre-state and
  post-state/pre-retirement assertions. Exact R/reflog plus a third-positive or unexpected
  absent BASE routes to P-repair rather than regressing state.
- Interleave outstanding P with `N→L`, `N→U→N`, delete/recreate-N, extra or
  truncated reflog entries, and old-binary ref/state writes. Exact matches recover; valid
  movement takes P-repair.
- Execute capable→old→capable with the old interval leaving absence, legitimately applying the
  re-advertised value, user recreation, BASE/state rewrite, and tombstone/high-water
  truncation. A/Z always blocks ambiguous deletion; returning capable evaluation never
  auto-revalidates old positive BASE.
- Two logical records and two workspace roots share one common dir. Distinct relPath,
  stream, nonce, worktree identity, or repository replacement produce distinct lineage
  hashes. B's P cannot advance A's BASE, and A's tombstone cannot mutate R while B has an
  active A/Z/P/K. Namespace/payload/hash collisions hard-hold.

### P-repair

- For both present→present and absent→present P shapes, cover moved, deleted,
  delete/recreate-same, `N→U→N`, extra-reflog, and truncated-reflog cases.
- Verify Q contains the exact fixed P fields, full payload hash, bounded ref/reflog byte
  projections, locked live/BASE/state/incoming observations, and Skeep count/hash. Maximal
  384/768/2,048-byte prefixes, a much longer valid ref, and arbitrary reflog bytes always
  serialize at or below 8,192 bytes with correct truncation/full hashes.
- For `N→U→N` and longer post-P histories, every reflog old/new OID plus live and P
  endpoints receives `refs/rbox-local/keep/<oid>` and the exact shared-sidecar human origin
  before P/K retirement. Truncate reflog and run GC afterward; U remains reachable.
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
- Acquisition tracing asserts all classes and each permitted path-specific subsequence of
  workspace→chain→operation→reflog→origin→Git→reservation→ORIG_HEAD→index→state,
  including that checkout releases index before later ref→state persistence. Assert the
  isolated HEAD/post-HEAD phase, reverse release, multi-common-dir sorting, and rejection
  of every unlisted inversion.
- Crash after the pin-only transaction before origin fsync and again after origin fsync;
  expire the reflog and run GC before retry. Every Skeep object, including post-P U,
  remains reachable; the first shape is diagnosed as safe originless over-protection.
- Move R and append a new reflog-only OID between origin fsync and final prepare; repair
  loops through pin-only+origin again and prepares only after Sobs/Skeep stabilizes.
- Specifically crash after state CAS with a matching receipt while P/K stand and Q is
  absent, run GC, reconstruct Q bytes from the receipt, and finish the exact transaction.
  Then repeat with post-CAS `N→U`, `N→U→N`, and reflog expiry: refresh only the
  receipt/Skeep/Q under generation CAS, never regress BASE, and finish once stable. Include
  an aborted S1 attempt followed by truncation/new S2 and verify Q commits the cumulative
  origin set rather than wedging on prior over-protection. Inspect
  every valid/invalid row of the retry matrix.
- Multi-ref clean/checkout journal: repair one moved-P member into a typed
  `p-repaired` receipt while another member still recovers or rolls back. The
  journal remains published, its unrelated members remain intact, and reset cannot bypass
  it.
- Move R, truncate/expire its reflog, run Git GC, and only then return v11. K keeps every
  P-referenced OID available, so repair still pins, quarantines, and retires without an
  artifact wedge. Missing or mismatched K is corruption, not this movement case.
- Fill Q to 256, repair once more, and verify deterministic expected-target eviction of the
  oldest Q while its permanent pins remain. Crash after receipt CAS and inspect
  new-Q/victim pre-commit, post-commit, and every mixed target shape. Whole-lineage deletion
  removes the exact Q prefix and only its lineage repair-pin origins; shared origins remain.
- Missing referenced object, malformed/colliding P, A+P contradiction, and preservation
  failure remain fail-closed and are distinguished from repairable movement.
- Manual resolution settles or repairs P, takes a fresh confirmation snapshot, and catches
  a second-proof race. Reset/rebind/freshening settles or repairs valid P and rescans, but
  compacts valid A, and still refuses malformed A/Z/P, unpreservable P, and published
  checkout journals.

### §126, lifecycle, and diagnostics

- Tombstone prune plus breadcrumb mismatch in one cycle defers; the next cycle heals with
  absence and A/Z verified under locks. A crash reconstructs the veto once, not forever.
- Table-test every `BreadcrumbVetoGate` at both proof sites and in the logger; assert
  the total order verbatim and compile-fail an unranked enum member.
- Artifact caps 4,096 unsettled A / 256 P / 512 K refuse before mutation without proof
  eviction; Q caps at 256 per active lineage using metadata-only eviction. Settle A→Z at
  every crash boundary, prune 4,097 sequential branches, remove a Z leaf during
  expected-absent recreation, and validate corrupt tree/leaf/count cases.
- Reset/rebind crash at every journal phase: valid A compacts, recovery Z preserves old
  absence provenance, new lineage never consumes it, active foreign artifacts veto, and
  whole-lineage cleanup removes only matching shared origins. Cover candidate/archive
  absent, exact, and wrong-hash states; forensic Z before cutover; atomic replacement before
  phase fsync; old-binary active-state writes before and after replacement; marker lag; and
  per-common-dir partial Z retirement using every recovery-matrix row.
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
