# §130 — Follower stale-side-branch hygiene (ref-deletion tombstones)

> **Status: 🚧 DESIGN v7 — 2026-07-16 (round-6 findings resolved; adversarially aligned).**
> v6 replaced v5's independent partial attestation, consumed marker, marker retirement,
> and marker-generation matching with one invariant: a follower may record a ref as absent
> from BASE only in the same expected-absent CAS ref transaction by which rbox proves and
> records that transition. v7 preserves that invariant and the A(R) mechanism unchanged;
> it closes the BASE-composition, crash-witness, rollback-floor, lifecycle, manual-resolution,
> repository-absence, and §126 enumeration edges found in round 6.
> Field record (same day): the Mac's rbox-core replica had accumulated **83 local-only
> commits across dozens of stale side branches** — every one a feature branch that was
> **squash-merged and deleted on the publisher**. Squash merges rewrite history, so deleted
> branch tips are never ancestors of `main`; `tipOwnedByIncoming` cannot prove them
> publisher-owned, and each becomes a permanent §116 per-ref hold on every follower —
> harmless-looking until §126 made "heldRefs empty" a waiver gate. Cleared today by
> operator `take-theirs` on three replicas; this design prevents re-accumulation.

## Problem

Publisher workflow (branch → PR → **squash-merge** → delete branch) strands a ref on every
follower: the follower holds tip `T`; `T` is unreachable from incoming roots; the ownership
proof correctly concludes "possibly local work" → per-ref hold, forever. Consequences:
unbounded held-ref accumulation, §126 waiver vetoes (compound strands), misleading
`show-me` output, and the same shape for non-fast-forward branch rewrites
(the `local-dev-prod` case).

## Design — advertised-value tombstones: equality+provenance proof, not ancestry

The publisher knows every value it ever *advertised* for a ref. Ship the superseded ones.
A follower may prune/adopt a held ref only when its value is **provably a stale advertised
value it received from the publisher** — never on ancestry guesses.

### Trust model (round-1 F15, explicit)

Tombstones are **authenticated assertions by an active workspace writer** (sections are
E2EE, hash-bound to signed commits, chain/pin-verified — the server cannot forge or splice
them). A malicious or compromised *active writer* can author tombstones, exactly as it can
already author arbitrary section content; design 12 declares a compromised active device a
full account takeover. Out of scope. Preservation (below) makes even a malicious assertion
recoverable, not truthful.

### Publisher side — capture (rounds-1 F1, F2, F10, F11)

- Git section gains `refTombstones: Record<ref, Array<{oid, ts, generation}>>` plus a
  persisted safe-integer `refTombstoneGeneration` high-water mark — a **per-ref chain of
  superseded advertised oids**, not a single latest value (F1 CRITICAL: latest-only
  recreates the missed-window bug — a follower stopped at S0's `R=Q` must find `Q` in the
  chain after S1 fast-forwards to `T` and S2 deletes; EVERY superseded advertised oid
  enters the chain, fast-forward transitions included). Each entry's `generation` is that
  ref's supersession counter value, allocated from the repo-wide high-water mark by
  incrementing it once for every supersession event. Thus the entries observed for any
  one ref are strictly monotonic even across expiry, eviction, and re-supersession; the
  repo-wide allocator avoids an unbounded map of counters for historical refnames.
  Overflow refuses to author the new tombstone and logs the safe-direction hold risk.
  Generations order events only — they are never follower authorization or replay
  credentials.
- **Authored only from complete observations** (F2 CRITICAL): a tombstone may be recorded
  only when BOTH the predecessor base section and the current capture have
  `refScope: "all"`. Scoped captures (pointer-worktree current-branch-only, detached HEAD)
  never author tombstones — scoped omission is not deletion, by that field's own contract.
  all↔scoped transitions author nothing.
- **Predecessor = the last agreed/published advertised checkpoint** (F10, restructured r3):
  tombstone capture compares against `RepoRecord.advertised`, the exact last acknowledged
  wire section, not the protected per-ref BASE anchor introduced below. This distinction
  lets a publisher acknowledge a wire omission without manufacturing follower-authorizing
  BASE absence. A single **final outbound normalization boundary** — one function through which EVERY
  outgoing git section passes regardless of which planner path produced it (fresh capture,
  slow identity carry, fingerprint fast path, needs-resolution, empty/unborn, gitignored
  discovery, config-modified, recovery/defer/linked-pointer carries — r3-F8: enumerating
  paths individually was already proven incomplete once; the boundary makes the list
  irrelevant). Exact order inside the boundary remains: merge/refresh → expiry → per-ref
  cap ordered `(ts, oid)` → repo cap ordered `(ts, ref, oid)` → canonical serialization
  (now including the counter high-water mark and entry generations).
  **Exemption (r3-F7): PENDING carries pass through byte-unchanged** — normalizing a
  pending section would change `gitIncomingKey` and orphan the partial markers and
  deferral episodes bound to it; pending sections therefore pause tombstone retention
  until they land or are dropped, and normalization resumes on the next non-pending emit.
  (This supersedes v3's "retention never pauses" line.) Re-supersession of a known oid
  **replaces that oid's entry** with the current canonical `ts` and the next strictly
  greater `generation`; it never uses wall-clock `max` as a generation surrogate and
  never appends a duplicate. `ts` remains only the 90-day retention input.
  A continuously protocol-1-authored lineage never derives the next value from retained entries;
  expiry and caps therefore cannot reset it. An old writer drops both the chain and the
  high-water mark only before protocol-1 activation, explicitly ending that pre-floor
  lineage under safe degradation; after activation the version floor rejects that writer.
  A later capable writer starts a new pre-floor lineage, and no generation value from any
  lineage is accepted as follower authority.
  (Retention behavior for pending carries: see the outbound-boundary exemption above.)
- **`refTombstones` and `refTombstoneGeneration` participate in `gitIncomingKey`**
  (r2-F7): tombstones change receiver mutation authorization, and that key binds partial
  markers and deferral episodes — canonical sorted representation included there;
  excluded from `gitIdentityKey` and projected live identity.
- Scope (F12): **`refs/heads/*` only** in v1. Tags and `refs/stash` have different
  semantics (stash follow inspects the whole reflog stack; top-oid equality proves nothing
  about the rest) — excluded, individually reviewable later.
- Bounds (F11, honest): per-ref chain cap **16**, per-repo total cap **512**, deterministic
  oldest-`ts`-first eviction, and eviction is **logged loudly** on the publisher. Wording:
  retention *targets* 90 days; under churn that exceeds the caps, the oldest tombstones
  drop sooner and affected slow followers simply keep today's hold behavior (safe
  direction — eviction can strand, never delete wrongly). Size: ≤~70 KiB/repo worst case;
  each change re-emits the git section via the existing `git-set` delta — acceptable, and
  chains only grow on branch deletion/rewrite events.

### Follower side — authorization and consumption — v7

#### The one BASE invariant

For every syncable branch ref `R`:

> **`BASE[R]` may transition from a present oid to absent only inside a successful
> expected-absent CAS ref transaction executed by rbox itself.**

No observation is equivalent to that act. In particular, an already-converged shortcut,
a wholesale `baseSec` carry while another ref is held, partial-state recovery, journal
recovery, or an absent live ref may not manufacture the transition. They may only
materialize a transition already proved by its durable transaction record.

The durable record is an internal Git ref, the **BASE-absence ref**
`A(R) = refs/rbox-local/base-absent/v1/<sha256(UTF-8 R)>`. Before preparing the ref
transaction, rbox writes a Git blob `M` whose bytes are the RFC-8785 canonical JSON
`{"priorOid":"<L>","ref":"<R>","v":1}`. Loading the record requires all of: the ref is direct,
its target is a blob with exactly that schema, `ref` is a valid in-scope heads ref,
`priorOid` is 40-hex, and the namespace suffix equals the hash of `ref`. A malformed,
unreadable, duplicate-decoding, or hash-colliding record is a hard hold and bounded
warning. The blob records identity without pointing into the commit graph, so it does not
extend `L`'s reachability beyond the unchanged 90-day tombstone-origin keep pin.

Like `refs/rbox-local/keep/*`, `A(R)` is excluded from capture and ordinary ref identity,
is common-dir durable, and is created/deleted by the same prepared
`git update-ref --stdin` transaction as the user-visible ref mutation. Its target `M` is
diagnostic and supplies an expected-old value for retirement; follower authorization
never matches an incoming tombstone, oid, timestamp, or generation against `M` or its
payload.

`A(R)` is not a second marker beside BASE: **it is the authoritative record that
`BASE[R]` is absent-by-CAS**. The serialized `RepoRecord.base` is a materialized view.
Every BASE read and every repo-record composer first overlays all valid `A(R)` records,
removing those refs from the logical BASE; therefore a wholesale old `baseSec` carry
cannot put a consumed oid back into BASE. A valid absence record wins over stale
serialized presence. An undecodable, colliding, or otherwise invalid record is a hard
hold and bounded warning, never ignored into presence.

This overlay is also a **per-ref state-composition guard**. The unchanged-section shortcut,
already-converged shortcut, `base: held ? baseSec : remoteSec`, successful-follow wholesale
assignment, journal recovery, and legacy state-map folding must all merge BASE one ref at
a time. A candidate present→absent member is admitted only when locked revalidation sees
both `R` absent and valid `A(R)`; every other such member retains its prior BASE value and
keeps the incoming section pending. Thus an authorized prune of `R1` may materialize while
an unrelated held `R2` retains its old BASE, and an unproved remote omission cannot ride
either ref's success. The state-file CAS only materializes the Git transaction's result;
it is never the absence transition's linearization point.

#### The mandatory BASE composer and complete call-site inventory

**v7 (round-6), F6 — one chokepoint.** There is exactly one constructor for a persisted
`RepoRecord.base`: `composeRepoBase(previous, candidate, authority, lockedProof)`. Direct
`base:` construction, whole-section assignment, deletion, and legacy-map folding outside
this function are forbidden by lint/structural test. Its proof-bearing `authority` is a
closed union:

- `pull-ref-transaction`, carrying the exact validated `A(R)`/present-transition witnesses
  and locked live-ref/reflog observations produced by this apply;
- `pull-carry`, which may retain members and change non-ref section fields but may not
  change any ref member;
- `journal-recovery`, carrying the journal's exact transaction witnesses, never merely its
  opaque intended section;
- `publisher-ack`, which may add/advance present members that this device just advertised,
  but writes ref/repository omissions only to the separate advertised checkpoint and
  suppression bit below rather than deleting branch BASE members; and
- `migration`, usable only by the v7 floor migration and unable to remove a present member.

For every union member of `keys(previous.refs) ∪ keys(candidate.refs)`, the composer applies
these rules under the common-dir locks, ordered by canonical refname: unchanged presence is
retained; a changed/added pull value requires the durable present-transition witness below;
a present→absent candidate requires `R` absent plus valid `A(R)`; and any missing, malformed,
stale, or mismatched proof retains the previous member, records the incoming section as
pending, and returns a typed hard hold. `publisher-ack` may add/advance present values but
may not remove them. The composed section then takes candidate non-ref fields only when
their existing lane rules permit. Invalid `A(R)` or present witnesses hard-hold before any
composition. State generation CAS is still required after this proof; it is not proof.

`lockedProof` is literal, not an in-process mutex: the composer opens a prepared
`git update-ref --stdin` verification transaction over every affected R and A/P ref in
canonical refname order. Absence prepares `verify R <absent>` + `verify A(R) M`; present-P
recovery prepares `verify R N` + `delete P(R) P` (retirement commits only after state);
unchanged presence prepares `verify R expected` when it participates in a reservation.
The state generation CAS runs while those Git ref locks remain prepared. On state failure
the ref transaction aborts and P remains; on state success it commits, releasing verifies
and retiring the proved P. A process crash after state but before ref commit leaves the
redundant P recovery case. Global order is workspace mutex → common dirs by canonical real
path → refs by bytewise name → state lock; no state writer may acquire a Git proof lock in
the reverse order. This closes the proof-to-state race for generic saves and journal recovery.

The following is the exhaustive v7 retrofit list from the current code. Every listed site
must call the composer; the cited assignment/deletion is removed or becomes a caller:

- **Pull initialization and recovery (`apply.ts`):** map initialization
  (`src/cli/sync-git/apply.ts:269-270`), outcome packing (`:282-294`), partial-progress
  local-identity reconstruction (`:38-52`), recovered-record install/delete
  (`:452-455`), and the post-recovery reload (`:511-515`). Recovery must use
  `journal-recovery`; it may not trust `record.base` by itself.
- **Pull repository absence and shortcuts (`apply.ts`):** remote-repository omission
  (`:563-580`), unchanged-section advance (`:733-742`), already-converged advance
  (`:745-759`), and legacy-conflict composition (`:865-877`). Omission uses the retained
  anchor/suppression rule below; a changed already-converged value without a present
  witness holds rather than becoming BASE.
- **Pull intended/success records (`apply.ts`):** journal `RepoRecord` construction,
  including today's `base: held ? baseSec : remoteSec` (`:910-940`), successful follow
  input carry (`:943-955`), assignment (`:984-1000`), and clean/legacy success assignment
  (`:1051-1082`). Mixed-ref
  results are composed per ref; no success assigns `remoteSec` wholesale.
- **Ref mutation/recovery (`follow.ts`):** safe-ref equality/deletion/update planning
  (`src/cli/sync-git/follow.ts:605-670`), the pre-journal safe-ref publication and crash
  edge (`:737-756`), current-ref delete/update construction (`:810-854`), intended-record
  capture (`:876-900`), and journal recovery/landing (`:217-243`). Each branch mutation
  returns its exact witness to the composer; an equality observation returns none.
- **State folding/install (`config.ts` and `sync-state.ts`):** legacy-to-record BASE fold
  (`src/cli/config.ts:338-374`), records-to-manifest serialization (`:379-401`), packet
  installation (`:417-456`), generic whole-state `saveState` (`:566-568`), generic source record construction
  (`src/cli/sync-state.ts:171-210`), record-to-input copy (`:102-110`), legacy state
  reconstruction (`:225-254`), and opaque
  journal lane replacement/retry (`:320-447`). `StateSource` must name its authority and
  carry the proof result; `config.ts` accepts only already-composed BASE, and asserts that
  every candidate ref omission has its proof receipt. Under protocol 1, raw `saveState`
  is private to pre-activation/fresh non-Git initialization and refuses any state containing
  Git BASE/records; every existing whole-state caller moves to packet/composer save. A
  structural test forbids any other whole-state persistence API or direct state-file write.
- **Push/capture and ACK composition (`plan.ts`):** initial BASE read
  (`src/cli/sync-git/plan.ts:99-102`), journal-recovery rehydrate/delete (`:227-252`),
  files-first early return (`:187-197`),
  `syncGit:false` whole-map omission (`:198-210`), outbound map comparison/composition
  (`:148-186`),
  owned/config carries (`:269-313`), generic defer carry (`:375-384`), needs-resolution
  carry (`:441-450`), structural drop (`:472-484`), empty-repo carry (`:507-513`), identity
  carry (`:523-531`), pending carries (`:552-576`), missing-directory section removal
  (`:579-598`), gitignored carry (`:600-604`), fingerprint carry (`:618-634`), linked-pointer
  carry/delete (`:671-693`), capture output (`:741-751`), and post-commit BASE folding
  (`:797-813`). All carries pass through final outbound normalization; publisher removals
  update `advertised`, set repository suppression as applicable, and retain the branch
  anchor, while `gitBaseAfterCommit` uses `publisher-ack` instead of deleting old per-ref
  BASE members. The files-first arm may emit empty Git only after asserting no BASE,
  advertised, pending, A/P, or repo record exists (true genesis); otherwise it runs the
  same final normalization/carry path and cannot turn an early return into omission.
- **Reset/rebind (`config.ts`):** stream-mismatch freshening (`src/cli/config.ts:539-563`),
  missing-state/incarnation fresh construction (`:287-329`), and both legacy and
  transactional reset paths (`:603-665`) obey the rollback-floor and
  artifact refusal below. They cannot manufacture an empty branch BASE while protected
  protocol state exists.

`git-cmd.ts` is outside the four requested files but is another actual writer: today's
manual wholesale `base: incoming` at `src/cli/git-cmd.ts:700-714` is replaced by the manual
protocol below. `src/cli/sync/push.ts:661` supplies the publisher ACK source and therefore
must tag it `publisher-ack`, not generic pull authority.

#### Repository absence is suppression, not branch-BASE absence

**v7 (round-6), F1.** A remotely absent repository, `syncGit:false`, a structurally dropped
publisher section, and a locally missing repository directory do not run branch ref CASes.
They therefore may not delete branch members from BASE. `RepoRecord.base` remains the last
per-ref provenance anchor. `RepoRecord.advertised` is a distinct, non-authoritative exact
copy of the last acknowledged wire section and may reflect branch/repository omission; it
is used only for outbound delta/tombstone composition and can never satisfy BASE provenance.
A new local-only `repoAbsent`/existing `removedKey` disposition suppresses the repository
from `lastSyncedManifest.gitRepos`, outbound capture, and ordinary remote-equality decisions.
`stateFromRepoRecords` emits `advertised` into the last-synced wire checkpoint only when
`repoAbsent` is false, while the BASE composer and pull planner read `base`. On publisher
ACK, `gitBaseAfterCommit` becomes a two-output composer: exact committed wire state goes to
`advertised`; `base` admits present additions/advances but retains every omitted member.
This preserves anti-resurrection behavior, prevents repeated re-supersession (the next
tombstone diff uses the already-omitted `advertised`), and never claims a branch became
absent. Reappearance clears suppression only through normal apply/capture; the protected
anchor is the provenance predecessor while `advertised` is the wire predecessor.
Active-lineage repository-record GC never removes the anchor,
including when local `.git` is gone; the existing repo cap bounds these records. A reset
archives the entire old lineage as described below rather than rewriting its BASE absent.

#### All branch deletion planes use A(R)

**v7 (round-6), F2.** A(R) is not tombstone-only. Every rbox branch deletion that could
remove a present BASE member—ordinary safe-ref deletion, tombstone-authorized deletion,
current-ref checkout deletion, clean materialization/wipe, and manual `take-theirs`—puts
`create A(R) M` and `delete R <expected-old>` in the same prepared update-ref transaction.
Checkout transactions attach the A(R) create to the exact primary or post-HEAD transaction
that deletes R. A checkout journal is not allowed to intend absent BASE until that exact
subtransaction is published. Tags/stash remain outside the branch invariant and v1 scope.

Clean apply's rollback snapshot and journal gain every exact A/P target and the transition
kind. If later work fails, rollback executes the exact inverse in one ref transaction:
deletion `{create A, delete R L}` inverts to `{create R L, delete A expected-M}`;
present update `{create P, update R N L}` inverts to
`{update R L N, delete P expected-P}`; fresh create `{create P, create R N}` inverts to
`{delete R N, delete P expected-P}`; and re-advertisement
`{create P, create R N, delete A M}` inverts to
`{delete R N, delete P expected-P, create A M}`. Existing pins remain over-protective.
If any inverse CAS cannot succeed, rollback refuses to claim restoration and recovery
hard-holds. Thus rollback cannot leave restored R beside authoritative absence or a stale
P claiming the rolled-back value. Destructive wipe helpers may not mutate a branch outside
this transaction-aware wrapper.

#### Authorization and the consuming transaction

A held, non-checkout branch `R` at live value `L` is tombstone-authorized for deletion iff
the incoming section has `refScope:"all"`, omits `R`, and ALL of:

1. **Live equality:** `L` equals an `oid` in `refTombstones[R]`.
2. **Exact BASE provenance:** logical `BASE[R]` equals the same `L`, and `A(R)` is absent.
   There is no partial-marker alternative and no consumed-marker/generation lookup. In particular,
   `A(R)` means logical BASE is absent and makes this test fail even if a stale serialized
   base section still says `R=L`.
3. **Gate placement** (F4): authorization is evaluated AFTER the hard ownership gates and
   may bypass ONLY the ancestry/no-drop `local-commits` conclusion. It never waives
   receiver-equivalence ambiguity, forced prior holds, sibling-worktree ownership,
   indeterminate proofs, unstable reflog evidence, or busy/CAS failures.
4. **Not the checkout plane** (F5): the current ref and any sibling-worktree-owned ref are
   excluded in v1 — those live in the journaled checkout transaction, a different protocol.

For an incoming deletion, the authorized prune transaction contains, atomically, the
prepared keep-pin creates, `create A(R) M` (the expected-absent CAS), and
`delete R L` (the expected-live CAS). Both ref preconditions must succeed. Success makes
`R` absent and logical `BASE[R]` absent at one linearization point; failure does neither.
The `A(R)` record is therefore also the consumed record — there is no second consumed
marker to match, expire, reconstruct, or retire.

For an incoming-present non-fast-forward rewrite `R:L→N` (`N != L`), tombstone adoption
may bypass only `local-commits` iff `live[R]=L`, logical `BASE[R]=L`, an entry in
`refTombstones[R]` has `oid=L`, `A(R)` is absent, and the same hard gates and checkout-plane
exclusions above all pass. The transaction atomically preserves the required oids and
CAS-updates `R` from expected old `L` to `N`; BASE then advances to the present value `N`,
so it never enters the absence protocol. If logical BASE is absent or `A(R)` exists, the
incoming-present case is re-advertisement and must use the expected-absent path below,
not rewrite adoption. Present-to-present crash recovery requires P(R), never observational
already-converged acceptance. After P settles, a later user move back to `L` mismatches
`BASE[R]=N` and holds.

#### Durable present-transition witness

**v7 (round-6), F3/F4.** A separate, short-lived internal ref records rbox-authored
transitions that end present; it does not change A(R)'s meaning:

`P(R) = refs/rbox-local/base-present/v1/<sha256(UTF-8 R)>`.

Its blob is canonical JSON
`{"episode":"<128-bit hex>","nextOid":"<N>","priorOid":"<L-or-null>","ref":"<R>","v":1}`
and is validated with the same direct-ref/blob/exact-schema/hash-suffix rules as A(R).
`P(R)` is created expected-absent in the same ref transaction as every rbox branch create
or update that could advance pull BASE. The update-ref transaction uses the episode as its
reflog message and forces a reflog entry for R. A present→present transaction is
`{create P(R), update R N L}`; an absent→present re-advertisement is
`{create P(R), create R N, delete A(R) M}`. A standing P(R) must be settled before another
transition for R, so there is never more than one episode.

While P(R) exists it dominates stale serialized presence just as A(R) dominates it:
locked recovery accepts `nextOid` only when live R equals N and R's top reflog entry has
that episode and exact old/new values. It then materializes `BASE[R]=N` by state CAS.
Missing/moved/recreated refs, a missing episode, or any other top reflog entry hard-holds;
serialized prior BASE is not exposed for authorization while P(R) is outstanding. After
the state CAS durably contains N, a locked compare-and-delete retires P(R) by expected M.
A crash before state leaves P; a crash after state but before retirement leaves redundant
P; a crash after retirement leaves BASE=N. This resolves both the rewrite `L→N` crash and
the re-advertisement create+early-A-retirement crash, including the double-crash return to L.
P is crash authorship only: it is never compared with tombstones and never authorizes a
present→absent transition.

Mechanics retained from rounds 1–4:

- **Preservation = the atomic keep-pin protocol**, with two round-2 corrections: (r2-F3)
  the reflog enumeration is re-read/fingerprinted UNDER the prepared ref lock and the
  transaction aborts if it changed — a concurrent `T→U→T` move must not slip reflog-only
  `U` past an expected-old check that still sees `T`; stable reflog evidence is a hard
  authorization gate. (r2-F4, narrowed r3) tombstone prunes use a NEW pin origin
  `"tombstone"` that
  **ages out after 90 days** — applied ONLY to the authorized live tip itself, whose
  authorization rules 1–2 just proved. Every OTHER oid found during reflog
  enumeration keeps today's permanent `human`-origin pins, including oids that happen to
  appear in the tombstone chain — chain membership without the exact BASE provenance
  proof is not a provenance proof, and aging an unproven pin could age out real local
  work.
- **Normal re-advertisement and retirement (updated by v7 round-6 F4):** if logical BASE omits `R` and incoming
  advertises `R=N`, the BASE-transition guard excludes the already-converged and wholesale
  shortcuts and routes through ordinary follow's `create R N` expected-absent CAS. When
  `A(R)→M` exists, the same ref transaction also contains `delete A(R) M` and
  `create P(R)`. Only its success retires the absence record; P then spans the state CAS
  and permits BASE to advance to present `N`.
  Merely observing `live==incoming` is not enough: if the user recreated `R` — even at
  exactly `N` — the create CAS fails, `A(R)` remains, logical BASE remains absent, and the
  ref holds. The incoming value need not match `A(R)`'s target; this is normal follow from
  an absent BASE, not marker matching. Tombstone expiry and generation changes never
  retire `A(R)`.
- **Crash reconstruction is an overlay, not inference:** before the prune transaction
  commits there is no `A(R)` and BASE cannot become absent. After it commits, `A(R)` is
  durable even if the process dies at `after-safe-refs`, before `GitPartialApply`, before
  the checkout journal, or before the repo-generation state CAS; enumeration of the
  internal refs reconstructs logical BASE absence and the locked expected-absence
  reservation even if the matching incoming tombstone has since expired or been evicted.
  If serialized BASE still contains `R`, that unmaterialized committed transition also
  reconstructs `tombstone-pruned-this-cycle`; after the locked state CAS materializes the
  absence, later cycles do not re-raise the same-cycle veto merely because `A(R)` remains.
  A successful re-advertisement transaction leaves `R=N`, no `A(R)`, and valid P(R); a
  crash before the state CAS takes the proof-bearing P recovery path, never an observational
  present-value convergence shortcut. A failed transaction
  leaves both refs unchanged. There is no torn state to interpret.
- **Partial machinery is non-authoritative:** `GitPartialApply.appliedRefs` gains a direct
  `{kind:"absent", artifactOid:M}` progress shape and a
  `{kind:"present", oid:N, artifactOid:P, episode}` shape; ordinary `{kind:"direct"}` is
  valid only for unchanged equality. Generic exact-ref revalidation can
  require both `R` absent and `A(R)→M` valid under locks for both refnames, acquired in
  canonical order with the rest of the common-dir lock set, or require R=N, P(R)→P, and
  the exact top-reflog episode. These are only pending-key-bound,
  D2-revalidated crash hint. Raw or prevalidated partial presence never establishes BASE
  provenance, never authorizes a tombstone, and may be dropped and rebuilt entirely from
  A/P.
- **Arbitrary-depth replay/laundering proof (round-5 g1/g2/g3):** start with
  `live[R]=BASE[R]=T`. Generation g1 tombstones `T`; the successful transaction creates
  `A(R)→M1` and deletes `R`, so logical BASE is absent. At g2 the publisher re-advertises
  `R=T`, but the user has already recreated `R=T`. Normal follow still issues an
  expected-absent create; it fails, so the equal live value is not accepted, `A(R)` does
  not retire, and BASE does not advance. Let g1 expire, let g2 be superseded, and let a
  later g3 tombstone `T` again with any greater generation. At g3 live equality holds but
  BASE equality does not: `A(R)` still makes BASE absent, so the user's ref holds. Adding
  g4…gN cannot change that result. The only exit is a successful rbox expected-absent
  create while `R` is actually absent; that act makes the later value rbox-authored and a
  subsequent tombstone legitimately consumable.
- **Value-incarnation boundary (v7 (round-6), F5):** the safety contract observes ref
  value plus available reflog history, not an unbounded Git ref-incarnation identity. A
  user `T→U→T` or delete/recreate-T completed before rbox's first snapshot is
  indistinguishable when the reflog is absent/truncated; v1 may treat that stable T as the
  BASE value. Reflog-only U is still permanently pinned. Movement after an rbox present
  transition is detected by P's forced episode, and recreation while A exists still fails
  the expected-absent create. Tests and user-facing claims use this precise boundary; v7
  does not promise preservation of pre-snapshot same-OID branch-name intent.
- One bounded log line per prune: `git-sync: pruned tombstoned branch <ref> (was <short-oid>)`.

#### Manual resolution

**v7 (round-6), F7.** `take-theirs` never writes wholesale BASE. It retains today's
snapshot confirmation, quarantine, permanent human pins, and second proof, then uses the
same per-ref transaction protocols. Incoming absent deletes a present R with
`{create A(R), delete R expected}`; if R is already absent but prior BASE was present, the
explicitly confirmed transaction uses `verify R <absent>` plus `create A(R)` before BASE
may become absent. Incoming present from logical absence normally uses expected-absent
create. If the confirmed user recreation occupies R, manual authority may instead CAS
update/delete that exact snapshotted value to N while atomically deleting A(R) expected-M
and creating P(R); the quarantine/pins preserve what the operator displaced. Incoming
present from present likewise creates P around the exact expected-old update. Incoming
absent with an existing valid A retains it. Any snapshot, reflog, A/P, sibling-worktree,
or CAS mismatch aborts without BASE change. The journal carries the resulting witnesses,
and only the mandatory composer lands its intended record.

#### Artifact lifecycle, reset, and bounds

**v7 (round-6), F8.** A(R) survives ordinary state saves and remains until a successful
re-advertisement/manual present transaction retires it; tombstone expiry never does.
P(R) survives only until its present BASE is state-CASed and is then compare-and-deleted.
Both namespaces are common-dir state, excluded from capture/identity, and scanned only by
ref—not by loose blob contents. Blobs written before a failed ref transaction are
unreachable non-authority and ordinary Git GC may collect them.

A common dir may hold at most **4,096 A refs and 256 P refs**. At the cap, a new deletion
or present transition hard-holds before mutation; existing records are never evicted.
Counts and bounded lexicographic examples appear in `doctor`, and one bounded warning is emitted per boot.
This deliberately bounds indefinite one-off-branch retention in the safe direction.

Reset/rebind and stream-mismatch freshening first scan every in-workspace common dir. If
any A/P ref or published checkout journal exists, reset/refill refuses and identifies the
repo; degraded/fence-free reset is forbidden. The operator must finish with the current
protocol-capable binary (including `take-theirs`) or bind a fresh root. With none present,
reset atomically renames the complete old state to a read-only, nonce-addressed lineage
archive and creates a new stream/incarnation with a distinct BASE namespace; it never
writes an absent member into the old BASE. Lineage archives are excluded from authorization
and may be deleted only as whole retired lineages. Thus an old-stream A can never silently
overlay a fresh stream, reset cannot erase the serialized half of a standing witness, and
no reset path presents a present→absent BASE transition to a later tombstone check.

### §126 interaction (r1-F6, corrected r2-F2 — the one-cycle delay alone doesn't close it)

Tombstone-authorized **expected absences and their `A(R)` records are carried into the
checkout reservations and verified under the ref locks at the second proof** — an absent
ref is a reserved fact, not an unchecked gap (next-cycle recreation between the ref-plane
snapshot and the locked proof would otherwise still race a stale-emptiness waiver).
Same-cycle breadcrumb waivers after a tombstone prune remain prohibited
(`tombstone-pruned-this-cycle` joins the structured veto object). After a crash, an `A(R)` whose transition is not yet materialized in
serialized BASE reconstructs the same veto exactly once; a settled absence does not veto
every later cycle. The heal fires next cycle with absences and their records verified
under locks. Together §126+§130 cover today's full field shape autonomously.

**v7 (round-6), F10 — one closed veto enum.** Both §126 proofs, this interaction, logging,
and tests use exactly `BreadcrumbVetoGate` and `BREADCRUMB_VETO_ORDER`:

`held-refs > tombstone-pruned-this-cycle > in-progress-present > reason-local-edits >`
`reason-local-index > reason-local-operation > reason-local-commits > reason-local-stash >`
`reason-worktree-ownership > reason-git-busy > reason-unreadable > reason-artifact >`
`reason-containment > reason-unsupported > reason-other > indeterminate > boundary`.

The enum is closed (a `Record<BreadcrumbVetoGate, number>` plus exhaustive `never` check).
`in-progress-present` means any classified in-progress op-state root exists;
`indeterminate` means the proof returned no classified reason; and `boundary` means the
second-proof snapshot/lock boundary changed. No free-form `reasons[...]` gate exists.

### Version skew and activation floor

- Old readers: `validateGitSection` is unknown-field tolerant (verified) — no schema bump.
  New clients strictly validate the field (container shape, `refs/heads/` grammar, 40-hex
  oids, chain caps, canonical ISO ts, safe-integer generations strictly increasing per
  ref, no duplicate oids per ref, and a valid persisted high-water mark) before consumption.
- Pre-activation old writers may rebuild the section and drop the chains/high-water mark;
  this remains safe-direction truncation and followers hold.

**v7 (round-6), F9 — two-stage migration/refusal rule.** Local A/P semantics do not
activate under today's permissive skew. Rollout is:

1. Ship a bridge release that understands a signed workspace minimum-client floor and a
   local `gitBaseProtocol` floor, preserves both fields, and refuses pull, push, reset,
   manual resolution, and state writes when the floor exceeds its supported value. It
   does not author A/P or BASE-absent semantics.
2. Enforce that bridge release as the server/launcher minimum for every workspace writer;
   sync requests carry `supportedGitBaseProtocol`, and the server's per-workspace floor
   rejects a lower value before manifest read/write. The signed launcher refuses to exec
   a binary older than the bridge once that workspace floor is cached. Only after this
   fleet gate is observed does v7, under workspace mutex + state lock and before any Git
   mutation, write `gitBaseProtocol:1` to state/state-incarnation and create the direct
   common-dir ref `refs/rbox-local/base-protocol/v1` targeting the exact canonical blob
   `{"floor":1,"v":1}`. Common-dir refs are written first in canonical path order, then
   state; the bridge and v7 scan both, so a crash can only over-refuse or be completed by
   v7. State/file CAS may proceed only when every copy equals 1. The floor is monotonic and
   reset cannot lower it.
3. A v7 manifest that carries tombstones also carries signed minimum protocol 1. The
   server rejects writer commits below it, so an old writer cannot truncate an activated
   lineage. A reader below it refuses before apply.

New→old→new proof: v7 first installs all refusal floors, then may create A/P and compose
new BASE. Rolling to the bridge binary reads floor 1 > supported 0 and performs **zero**
Git, state, reset, or wire writes; pre-bridge binaries are rejected by the already-raised
server/launcher floor. Rolling forward to v7 finds the unchanged state and artifacts,
revalidates them, settles P or overlays A, and continues. Therefore the old interval can
neither manufacture BASE absence, expose stale presence, retire A/P, truncate tombstones,
nor permanently strand the workspace—the capable binary resumes without repair. Failure
to establish the bridge/server floor blocks activation; mixed-version safe degradation is
not claimed after protocol 1.

### Diagnostic rider — §126 veto observability (F16)

Both proofs return a **structured veto object** using the single closed enum/order above, and a
centralized `logVetoOnce` (module-lifetime set keyed workspace/repo/gate) emits one bounded
line per gate per daemon boot: `git-sync: breadcrumb waiver vetoed for <repo>: <gate>`.
Today's diagnosis required SSH archaeology; this makes the next one a log grep.

## Tests

- Chain semantics: follower at S0's `Q` prunes correctly after S1 (FF) + S2 (delete);
  repeated non-FF rewrites; delete/recreate cycles; re-supersession replaces the oid with
  a strictly greater generation even under equal/regressing clocks; the high-water mark
  survives expiry/eviction; overflow refuses authoring; per-ref and per-repo cap eviction
  (oldest-first, logged); expiry on both capture and carry paths.
- Scoped-capture safety: pointer-worktree branch switch and detached HEAD author NO
  tombstones; all↔scoped transitions author nothing.
- Mandatory-composer structure: AST/lint test permits `RepoRecord.base` construction only
  in `composeRepoBase`; fixture every cited `apply.ts`, `follow.ts`, `config.ts`,
  `sync-state.ts`, `plan.ts`, `git-cmd.ts`, and push-ACK call site so adding a new direct
  assignment/deletion, raw state-file write, or protocol-1 whole-state save fails.
  `saveState` accepts only fresh non-Git pre-activation state. Exhaustively instantiate
  every authority union member and compile-fail an added member without a handler.
- BASE composition matrix: for every cited shortcut, carry, success, recovery, legacy
  fold, and ACK path, cross previous `{R1=L1,R2=L2}` with candidate members
  absent/same/changed and valid/missing/malformed/mismatched A/P proofs. Only valid A plus
  locked absence admits present→absent; pull present changes require P; publisher ACK may
  advance present but never remove; every refusal retains the old member and pending.
  Mixed `R1` prune + unrelated held `R2` persists the two per-ref outcomes. Race user
  updates at every proof→state boundary and verify prepared Git locks exclude them; inject
  state-CAS failure to prove P retirement aborts. Multi-repo lock-order stress has no
  reverse acquisition or deadlock.
- Repository absence/suppression: remote repo deletion, local directory deletion,
  structural drop, `syncGit:false`, missing-dir push, and post-commit ACK all retain the
  hidden branch anchor, update the exact non-authoritative advertised checkpoint, set
  suppression, omit the wire section, and cannot resurrect it. A second steady capture
  does not re-supersede the already-omitted ref, and `advertised` can never authorize a
  follower deletion.
  Files-first with true genesis may emit empty; inject any BASE/advertised/pending/A/P/record
  and prove it normalizes/carries instead of returning an omission.
  Reappearance clears suppression through normal apply; active-lineage record GC never
  removes the anchor, even after `.git` disappears.
- Provenance/invariant: exact live+tombstone+BASE equality consumes; BASE mismatch and a
  coincidental local ref at a tombstoned oid hold; partial state alone never authorizes.
  Enumerating `A(R)` overlays stale serialized presence; no observation-only path creates
  logical or serialized BASE absence.
- Atomic consumption: metadata-blob write + keep pins + expected-absent `A(R)→M` create +
  expected-live `R` delete commit together; inject each CAS failure and every transaction
  crash boundary and prove all-or-nothing refs, BASE view, reservation, and same-cycle veto.
- Universal deletion planes: ordinary safe ref, tombstone-held ref, current checkout ref,
  clean apply/wipe, and manual absent resolution each create A in the exact transaction
  deleting R. Inject clean-apply failure after deletion, present update, fresh create, and
  A-retiring re-advertisement: rollback performs the specified exact A/P inverse atomically;
  every inverse CAS failure hard-holds with no false restored state or stale P.
- Re-advertisement: absent live ref transaction creates R and P while atomically retiring
  A, then P advances BASE present. A user recreation at same/different oid before the
  transaction fails its create and retains A. Re-advertisement to an oid different from
  the recorded deleted oid follows normally without marker matching.
- Generation laundering: execute the documented g1 delete → user recreation → g2
  re-advertisement CAS failure → g1 expiry/g2 supersession → g3 re-tombstone sequence,
  then extend it across multiple further generations; every attempt holds until an actual
  rbox expected-absent create succeeds.
- Crash reconstruction: kill after safe refs and before partial, journal, and state writes;
  `A(R)` alone reconstructs BASE absence, even after tombstone expiry/eviction, plus the
  locked reservation and one-time reconstructed cycle veto. Invalid/undecodable A/P refs
  hard-hold and warn.
- Present-witness crash matrix: for present `L→N` rewrite, absent→N re-advertisement, and
  ordinary create, kill before ref prepare/commit, after ref commit, before/after state
  CAS, and before/after P retirement. At every boundary exactly one of old state, valid P,
  or materialized N is authoritative. During outstanding P inject `N→L`, `N→U→N`, and
  delete/recreate-N; top-reflog episode mismatch holds and stale L is never exposed.
  Missing/truncated/colliding P likewise holds. Extend to the double-crash prune-before-
  state → re-advertise → crash-before-state → user-return-to-L history.
- Rewrite adoption: tombstoned `T→N` creates P around expected-old adoption; P, not
  observational convergence, repairs a pre-state crash. After BASE=N/P retirement, a
  later stable user return to T mismatches BASE and holds. BASE mismatch, A presence,
  outstanding/malformed P, or any hard-gate failure forbids adoption.
- Same-OID contract: pre-first-snapshot delete/recreate-T and `T→U→T` with missing versus
  present reflogs demonstrate the documented value-incarnation boundary; reflog-only U is
  preserved. The same movements after a P episode are detected; recreation while A exists
  still fails expected-absent creation.
- Authorization placement: ambiguity/forced/sibling/indeterminate holds are NEVER waived;
  CAS expected-old failure aborts; current ref excluded.
- Preservation: reflog-only `U` atop pruned `T` gets its keep pin atomically; pin-proof
  indeterminate → hold; `A(R)`'s metadata blob does not retain `T` after the 90-day
  tombstone-origin pin ages out.
- Manual resolution: incoming present/absent × live present/absent × A/P present/absent;
  exact snapshot CAS and second-proof mismatch injection. Verify quarantine + permanent
  pins precede mutation, A is created/retained/retired exactly as specified, P spans every
  present result, and no path writes wholesale BASE.
- Artifact lifecycle/bounds: orphan pre-ref blobs are never scanned and GC safely;
  settled A persists, settled P retires by expected target, caps 4,096/256 refuse before
  mutation without eviction, and diagnostics are bounded. Reset, stream mismatch, rebind,
  degraded reset, and fence-free fallback all refuse with any A/P/published journal and
  succeed only when none exists; successful reset atomically archives the complete old
  lineage and cannot expose any archived BASE member to new-stream authorization.
- §126 same-cycle prohibition: tombstone prune + breadcrumb mismatch in one cycle → defer,
  heal next cycle (end-to-end reproduction of today's compound field shape, zero operator).
- Skew before activation: old reader ignores unknown wire fields; old writer truncation
  holds; strict validation rejects malformed entries. Activation ordering fault-injects
  every bridge/server/local-floor boundary and permits only over-refusal.
- Skew after activation: execute new→bridge-old→new and new→pre-bridge request→new. The old
  interval performs zero Git/state/reset/wire writes; pre-bridge server/launcher requests
  fail; new settles the original A/P without repair. Attempt old-writer tombstone
  truncation and reader apply below signed protocol 1; both refuse.
- Veto enum: both proof sites and logger return every closed `BreadcrumbVetoGate` value;
  table-test the one total order verbatim, including `tombstone-pruned-this-cycle`, and
  compile-fail an unranked new enum member. Each selected gate logs exactly once per boot.

## Non-goals

- Backfilling pre-§130 residue (cleared manually today; `take-theirs` remains the tool).
- Tags / `refs/stash` / current-ref tombstones (v1 scopes to non-checked-out `refs/heads/*`).
- Age-based pruning without tombstone proof.
- Mixed-version operation after `gitBaseProtocol:1` activation (older clients refuse).
- Compromised-active-writer resistance (design 12 scope).
