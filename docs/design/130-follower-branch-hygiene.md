# §130 — Follower stale-side-branch hygiene (ref-deletion tombstones)

> **Status: 🚧 DESIGN v5 — 2026-07-16 (rounds 1–4 applied; ROUND 5 PENDING — next session
> runs the confirmation round before any implementation).**
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

- Git section gains `refTombstones: Record<ref, Array<{oid, ts}>>` — a **per-ref chain of
  superseded advertised oids**, not a single latest value (F1 CRITICAL: latest-only
  recreates the missed-window bug — a follower stopped at S0's `R=Q` must find `Q` in the
  chain after S1 fast-forwards to `T` and S2 deletes; EVERY superseded advertised oid
  enters the chain, fast-forward transitions included).
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
  irrelevant). Exact order inside the boundary: merge/refresh → expiry → per-ref cap
  ordered `(ts, oid)` → repo cap ordered `(ts, ref, oid)` → canonical serialization.
  **Exemption (r3-F7): PENDING carries pass through byte-unchanged** — normalizing a
  pending section would change `gitIncomingKey` and orphan the partial markers and
  deferral episodes bound to it; pending sections therefore pause tombstone retention
  until they land or are dropped, and normalization resumes on the next non-pending emit.
  (This supersedes v3's "retention never pauses" line.) Re-supersession of a known oid **merges by
  oid with `ts = max(existing, current)`** (r2-F6 — keeping the original ts could expire a
  freshly renewed tombstone; appending would duplicate). (Retention behavior for pending carries: see the outbound-boundary exemption above.)
- **`refTombstones` participates in `gitIncomingKey`** (r2-F7): tombstones change receiver
  mutation authorization, and that key binds partial markers and deferral episodes —
  canonical sorted representation included there; excluded from `gitIdentityKey` and
  projected live identity.
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

### Follower side — authorization (rounds-1 F3, F4, F5, F6, F7)

A held ref `R` at live value `L` is tombstone-authorized iff ALL of:

1. **Live equality**: `L` equals some `oid` in `refTombstones[R]` (LIVE is always the
   destructive-operation comparand, re-checked with expected-old CAS at mutation time —
   the existing transaction discipline).
2. **Provenance** (F3 CRITICAL — equality alone can't distinguish publisher residue from a
   user's deliberate recreation or a coincidental local ref): `BASE[R]` equals that same
   oid (the follower's own transactional record says "I received this value as this ref
   from the publisher"), or an rbox-authored partial-apply marker attests it. Once a
   tombstone deletion advances BASE to absence, a recreated `R@T` **holds** — recreation
   is user intent.
3. **Gate placement** (F4): authorization is evaluated AFTER the hard ownership gates and
   may bypass ONLY the ancestry/no-drop `local-commits` conclusion. It never waives
   receiver-equivalence ambiguity, forced prior holds, sibling-worktree ownership,
   indeterminate proofs, or busy/CAS failures.
4. **Not the checkout plane** (F5): the current ref and any sibling-worktree-owned ref are
   excluded in v1 — those live in the journaled checkout transaction, a different protocol.

Action on authorization: deletion tombstone → delete `R`; rewrite tombstone → adopt the
incoming value. Mechanics hardened in round 2:

- **Preservation = the atomic keep-pin protocol**, with two round-2 corrections: (r2-F3)
  the reflog enumeration is re-read/fingerprinted UNDER the prepared ref lock and the
  transaction aborts if it changed — a concurrent `T→U→T` move must not slip reflog-only
  `U` past an expected-old check that still sees `T`; stable reflog evidence is a hard
  authorization gate. (r2-F4, narrowed r3) tombstone prunes use a NEW pin origin `"tombstone"` that
  **ages out after 90 days** — applied ONLY to the authorized live tip itself, whose
  publisher provenance rules 1–2 just proved. Every OTHER oid found during reflog
  enumeration keeps today's permanent `human`-origin pins, including oids that happen to
  appear in the tombstone chain — chain membership without the BASE/marker provenance
  proof is not a provenance proof, and aging an unproven pin could age out real local
  work.
- **Replay protection is a consumed-tombstone artifact, not BASE advancement** (r2-F1,
  semantics completed in r3): the delete/adopt transaction atomically writes a **consumed
  marker keyed `(ref, oid)` — GLOBAL, not per-incomingKey** (r3: per-key lookup would
  permit replay after any unrelated incoming-key change). Markers cover BOTH consumption
  shapes: deletion (marker on the deleted oid) and rewrite-adoption (marker on the OLD
  oid). **Retirement rule (r4-F1 — retirement must be an ACT, not an observation)**: a marker
  for `(R, T)` retires ONLY when the follower itself **creates `R@T` through an
  expected-absent CAS** driven by a later incoming section that re-advertises it — the
  transaction that sets the ref is the same transaction that retires the marker
  (linearized; observing a re-advertisement without acting on it retires nothing, so
  re-advertise → retire → delete can never prune a ref the USER recreated in the gap —
  a user-created `R@T` makes the expected-absent CAS fail, the marker stays live, and
  authorization rule 2 keeps holding). Alternatively `T` expiring from `refTombstones[R]`
  retires the marker — with **generation fencing (r4-F2)**: the marker records its
  tombstone's `ts`; a RENEWED tombstone for the same oid (higher ts) is a NEW generation
  that a retired/expired marker cannot match — resurrection across expiry is impossible
  by construction. Marker clearing is atomic with the state it reconstructed. `GitPartialApply.appliedRefs`
  gains an **expected-absent variant**. Authorization rule 2 additionally requires NO
  live marker for `(R, L)` — a user recreation of `R@T` holds even across crash/defer
  windows.
- **Crash reconstruction** (r2-F2 completed in r3): after the `after-safe-refs` crash
  boundary the marker survives but partial state may not. On retry the marker is the
  RECONSTRUCTION source for BOTH consumption shapes (r4-F2): deletion (live+incoming
  absent → rebuild expected-absent, feed the locked reservation, raise the cycle veto)
  and rewrite-adoption (live == incoming == new value, marker on old oid → raise the
  cycle veto only; the adoption itself committed with the refs). A consumed marker with no matching tombstone and no partial state is
  logged and ignored (stale artifact, retired at its tombstone's expiry).
- **Attestation is prevalidated** (r2-F5): apply orchestration hands `publishRefPlane` a
  prevalidated attestation map — pending-key-bound, exact-direct-OID, D2-revalidated;
  stale/invalid markers are a hard veto (never raw `record.partial` presence).
- One bounded log line per prune: `git-sync: pruned tombstoned branch <ref> (was <short-oid>)`.

### §126 interaction (r1-F6, corrected r2-F2 — the one-cycle delay alone doesn't close it)

Tombstone-authorized **expected absences are carried into the checkout reservations and
verified under the ref locks at the second proof** — an absent ref is a reserved fact, not
an unchecked gap (next-cycle recreation between the ref-plane snapshot and the locked proof
would otherwise still race a stale-emptiness waiver). Same-cycle breadcrumb waivers after a
tombstone prune remain prohibited (`tombstone-pruned-this-cycle` joins the structured veto
object, precedence after `held-refs`). The heal fires next cycle with absences verified
under locks. Together §126+§130 cover today's full field shape autonomously.

### Version skew (F13, F14)

- Old readers: `validateGitSection` is unknown-field tolerant (verified) — no schema bump.
  New clients strictly validate the field (container shape, `refs/heads/` grammar, 40-hex
  oids, chain caps, canonical ISO ts, no duplicate oids per ref) before consumption.
- Old WRITERS: an old binary's capture rebuilds the section from known fields and
  **drops the chains** (multi-device workspaces). Accepted with the safe failure
  direction: affected refs fall back to today's holds; nothing is wrongly deleted.
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
  repeated non-FF rewrites; delete/recreate cycles; per-ref and per-repo cap eviction
  (oldest-first, logged); expiry on both capture and carry paths.
- Scoped-capture safety: pointer-worktree branch switch and detached HEAD author NO
  tombstones; all↔scoped transitions author nothing.
- Provenance: BASE mismatch (user recreated `R@T` post-prune) → holds; coincidental local
  ref at a tombstoned oid with no BASE record → holds; partial-marker attestation path.
- Authorization placement: ambiguity/forced/sibling/indeterminate holds are NEVER waived;
  CAS expected-old failure aborts; current ref excluded.
- Preservation: reflog-only `U` atop pruned `T` gets its keep pin atomically; pin-proof
  indeterminate → hold.
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
