# §130 — Follower stale-side-branch hygiene (ref-deletion tombstones)

> **Status: 🚧 DESIGN v6 — 2026-07-16 (round-5 rebuild; adversarially aligned).**
> v6 replaces v5's independent partial attestation, consumed marker, marker retirement,
> and marker-generation matching with one invariant: a follower may record a ref as absent
> from BASE only in the same expected-absent CAS ref transaction by which rbox proves and
> records that transition.
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
- **Predecessor = the last agreed/published BASE section** (F10, restructured r3): a
  single **final outbound normalization boundary** — one function through which EVERY
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
  A continuously v6-authored lineage never derives the next value from retained entries;
  expiry and caps therefore cannot reset it. An old writer drops both the chain and the
  high-water mark, explicitly ending that lineage under the existing safe-degradation
  rule; a later v6 writer starts a new lineage, and no generation value from either
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

### Follower side — authorization and consumption — v6 (round-5 rebuild)

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
not rewrite adoption. Present-to-present already-converged crash recovery remains valid.
A later user move back to `L` mismatches `BASE[R]=N` and holds.

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
- **Normal re-advertisement and retirement:** if logical BASE omits `R` and incoming
  advertises `R=N`, the BASE-transition guard excludes the already-converged and wholesale
  shortcuts and routes through ordinary follow's `create R N` expected-absent CAS. When
  `A(R)→M` exists, the same ref transaction also contains `delete A(R) M`. Only its
  success retires the absence record and permits BASE to advance to the present `N`.
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
  A successful re-advertisement
  transaction leaves `R=N` and no `A(R)`; a crash before the state CAS takes the ordinary
  present-value convergence path and materializes `BASE[R]=N`. A failed transaction
  leaves both refs unchanged. There is no torn state to interpret.
- **Partial machinery is non-authoritative:** `GitPartialApply.appliedRefs` gains a direct
  `{kind:"absent", artifactOid:M}` progress shape so generic exact-ref revalidation can
  require both `R` absent and `A(R)→M` valid under locks for both refnames, acquired in
  canonical order with the rest of the common-dir lock set. It is only a pending-key-bound,
  D2-revalidated crash hint. Raw or prevalidated partial presence never establishes BASE
  provenance, never authorizes a tombstone, and may be dropped and rebuilt entirely from
  `A(R)`.
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
- One bounded log line per prune: `git-sync: pruned tombstoned branch <ref> (was <short-oid>)`.

### §126 interaction (r1-F6, corrected r2-F2 — the one-cycle delay alone doesn't close it)

Tombstone-authorized **expected absences and their `A(R)` records are carried into the
checkout reservations and verified under the ref locks at the second proof** — an absent
ref is a reserved fact, not an unchecked gap (next-cycle recreation between the ref-plane
snapshot and the locked proof would otherwise still race a stale-emptiness waiver).
Same-cycle breadcrumb waivers after a tombstone prune remain prohibited
(`tombstone-pruned-this-cycle` joins the structured veto object, precedence after
`held-refs`). After a crash, an `A(R)` whose transition is not yet materialized in
serialized BASE reconstructs the same veto exactly once; a settled absence does not veto
every later cycle. The heal fires next cycle with absences and their records verified
under locks. Together §126+§130 cover today's full field shape autonomously.

### Version skew (F13, F14)

- Old readers: `validateGitSection` is unknown-field tolerant (verified) — no schema bump.
  New clients strictly validate the field (container shape, `refs/heads/` grammar, 40-hex
  oids, chain caps, canonical ISO ts, safe-integer generations strictly increasing per
  ref, no duplicate oids per ref, and a valid persisted high-water mark) before consumption.
- Old WRITERS: an old binary's capture rebuilds the section from known fields and
  **drops the chains and generation high-water mark** (multi-device workspaces). Accepted
  with the safe failure direction: affected refs fall back to today's holds; nothing is
  wrongly deleted.
  Documented + tested (old-writer recapture truncates → follower holds). Fleet practice
  upgrades all devices together; no capability negotiation in v1.

### Diagnostic rider — §126 veto observability (F16)

Both proofs return a **structured veto object** (deterministic gate precedence:
`held-refs > in-progress-present > reasons[...] > indeterminate > boundary`), and a
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
- Provenance/invariant: exact live+tombstone+BASE equality consumes; BASE mismatch and a
  coincidental local ref at a tombstoned oid hold; partial state alone never authorizes;
  already-converged, wholesale-base-carry, journal recovery, and live-absent shortcuts
  cannot create BASE absence. Enumerating `A(R)` overlays stale serialized BASE presence.
- Atomic consumption: metadata-blob write + keep pins + expected-absent `A(R)→M` create +
  expected-live `R` delete commit together; inject each CAS failure and every transaction
  crash boundary and prove all-or-nothing refs, BASE view, reservation, and same-cycle veto.
- Re-advertisement: absent live ref is created by expected-absent CAS and atomically retires
  `A(R)`, then BASE advances present; a user recreation at either the same or a different
  oid makes the CAS fail, retains `A(R)`, and holds. Re-advertisement to an oid different
  from the recorded deleted oid follows normally without marker matching.
- Generation laundering: execute the documented g1 delete → user recreation → g2
  re-advertisement CAS failure → g1 expiry/g2 supersession → g3 re-tombstone sequence,
  then extend it across multiple further generations; every attempt holds until an actual
  rbox expected-absent create succeeds.
- Crash reconstruction: kill after safe refs and before partial, journal, and state writes;
  `A(R)` alone reconstructs BASE absence, even after tombstone expiry/eviction, plus the
  locked reservation and one-time reconstructed cycle veto. Kill after successful
  re-advertisement create+retirement but before state; ordinary present convergence repairs
  BASE. Invalid/undecodable absence refs hard-hold and warn.
- BASE composition: exercise the unchanged and already-converged shortcuts, whole-section
  `baseSec` carry, successful-follow assignment, journal recovery, and legacy folding;
  none may admit an unrecorded absent member. In a mixed repo, `R1` prunes while `R2`
  holds, and the saved BASE merges their two outcomes per ref.
- Rewrite adoption: tombstoned `T→N` uses expected-old adoption with no absence artifact;
  crash before state may advance only present BASE, and a later user recreation of `T`
  mismatches `BASE[R]=N` and holds. BASE mismatch, `A(R)` presence/logical BASE absence,
  or any hard-gate failure forbids rewrite adoption.
- Authorization placement: ambiguity/forced/sibling/indeterminate holds are NEVER waived;
  CAS expected-old failure aborts; current ref excluded.
- Preservation: reflog-only `U` atop pruned `T` gets its keep pin atomically; pin-proof
  indeterminate → hold; `A(R)`'s metadata blob does not retain `T` after the 90-day
  tombstone-origin pin ages out.
- §126 same-cycle prohibition: tombstone prune + breadcrumb mismatch in one cycle → defer,
  heal next cycle (end-to-end reproduction of today's compound field shape, zero operator).
- Skew: old reader ignores; old writer recapture truncates chains → follower holds (never
  deletes); strict-validation rejects malformed fields per-entry.
- Veto logging: each gate exactly once per boot, correct precedence.

## Non-goals

- Backfilling pre-§130 residue (cleared manually today; `take-theirs` remains the tool).
- Tags / `refs/stash` / current-ref tombstones (v1 scopes to non-checked-out `refs/heads/*`).
- Age-based pruning without tombstone proof.
- Writer capability negotiation for mixed-version fleets (safe-direction degradation instead).
- Compromised-active-writer resistance (design 12 scope).
