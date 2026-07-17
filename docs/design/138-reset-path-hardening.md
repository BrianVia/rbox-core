# 138 — Reset-path hardening: consent before rebind, recovery that works at fleet scale

v10 (ALIGNED — self-certified: Round-9's residual is benchmark-corpus
composition, an implementation-discoverable detail double-covered by the
2× safety factor and the CI sweep re-measurement; convergence
10→9→8→5→4→2→1→corpus-minutiae). v8 pinned Round-7's two orderings (below). v6/v7 folded Rounds 5-6 (fence cross-reference, durable rename-source unlink with destination-first fsync, measured multiplier M=24 default, manifest fsync before commit record). v4/v5 folded Rounds 3-4; the consent witness now binds every
known coordinate, the lock protocol is executable against the real
hierarchy, the classifier is a correlated row table, and quarantine/restore
are fenced, durable, crash-resumable transactions.

## Problem (field evidence, 2026-07-16 incident + fleet audit)

Unchanged from v2: (F1) stream mismatches trigger unconsented resets from
any caller (`config.ts:712-726`; `track-cmd.ts:85-116`; exported
`resetSyncState` with no authorization); a dev-pointed read-only `rbox
status` initiated a fenced-baseline reset against the production workspace.
(F2) `MAX_STATE_BYTES = 64MiB` makes journal recovery throw forever on all
three fleet machines (~77MB `state.json`). (F2b) failure mode is a per-cycle
hot loop and `rbox status` itself fails before rendering anything.

## Mechanism

### F1a: two-stage consent witness (R2-f1)

Consent is a module-private object (unforgeable by construction — only the
consent module can instantiate it), minted ONLY at real confirmation
boundaries, in two stages because a create-new `nextStream` cannot exist
before the create POST returns its workspace id:

- **Stage A — intent witness**, minted at the confirm prompt (setup's
  rebind confirm, extended to both rebind choices — see v2 text below).
  Binds `{root, observedOldStream, observedOldNonce, intent}` where intent
  carries EVERY next-stream coordinate known at confirm time (Round-3 f1):
  `rebind-to-existing{remoteUrl, workspaceId, projectId}` (all known) or
  `create-new{remoteUrl, projectId}` — the STREAM-SELECTING tuple only
  (Round-4 f1: the workspace NAME is prompted after the confirmation in
  the real flow, and it is display metadata that selects no stream — it
  is explicitly OUTSIDE the security binding). The create helper takes
  the witness and VERIFIES its stream-selecting call arguments
  (remoteUrl, projectId) against the bindings before POSTing — a
  substituted remote or project is refused; the name rides alongside
  unverified.
- **Stage B — narrowing**: for `create-new`, immediately after the create
  POST returns, the SAME invocation narrows the Stage-A witness to the
  concrete `nextStream` — single-use, one narrowing per witness, and the
  narrowing method verifies the id came from the create call made under
  this witness (the create helper takes the witness and stamps it; a
  returned/adopted id from anywhere else is refused — tested by attempting
  substitution and double-narrowing).
- The witness is consumed by the reset primitive exactly once; replay →
  typed error, no mutation.

Minting sites, refusal-before-remote-create ordering, `track`'s breaking
change, the `loadState` mismatch throw (typed `StreamMismatchError`), the
incarnation-marker coverage, the legacy undefined-stream adoption, and the
full 20-site caller inventory are unchanged from v2 (Round-1 f2/f3/f5
rulings stand).

### F1b: atomic authorization boundary (R2-f2)

Two distinct checks, explicitly separated:

1. **Side-effect-free witness validity** (pure): shape/expiry/consumed
   checks. May run anywhere; authorizes nothing by itself.
2. **Fenced lineage recheck — executable lock protocol** (Round-3 f2):
   the fence follows the REPOSITORY protocol-lock order exactly
   (`src/engine/git/protocol-locks.ts:8-19`: operation(3) → reflog(4) →
   origin(5) → git(6) → … → state(10)) — for EVERY common directory the
   reset touches, in canonical sorted identity order, with `state`
   acquired LAST (Round-4 f2: v4's operation→state order inverted against
   P settlement's internal reflog/origin/git acquisitions —
   `p-settlement.ts:92-100,146-152`, `p-repair-transaction.ts:375-398`).
   The witness recheck of `{stream, stateNonce}` runs under the COMPLETE
   fence, and every preparation step that today self-acquires — exact-P
   settlement's `withRepoProtocolLocks` + prepared transactions, P
   repair, checkout-journal recovery, the legacy-lineage migration CAS
   (`config.ts:1069-1085`), and `applyStateSavePacket`
   (`config.ts:498-570`) — gains a HELD-LOCK-AWARE variant that accepts
   the already-held set and asserts (never re-enters) it. The invariant
   stated positively: NO reset-side mutation occurs before the fenced
   recheck, and no lock is ever acquired out of protocol order while the
   fence is held. A **protocol-lock trace test** (recording acquisition
   order through injected lock fakes) covers exact settlement AND moved-P
   repair inside the fence, in addition to the nonce barrier snapshot.
- **Barrier test** (mandated): advance the state nonce after witness
  validation but before journal publication → reset refused, and a
  directory + git-ref snapshot proves neither `.rbox` nor any Git artifact
  changed.

### F1c: journal authorization witness + physical-state classifier (R2-f3/f4)

**Journal format v2**: the reset journal gains a durable authorization
record `{version: 2, authorizedNextStream, consentKind:
"setup-rebind"|"setup-create", mintedAtRevision}` written atomically with
the journal (it IS part of the journal document, covered by the existing
hash/validation). Recovery eligibility:

- Journal is v2 with a witness AND `authorizedNextStream ===
  journal.next.stream` AND the caller's config stream is `old.stream` or
  `next.stream` → proceed to physical-state classification.
- **Legacy v1 journal (no witness) → ambiguous → halt + doctor.** (Policy:
  pre-hardening journals only exist for crashes that predate the upgrade;
  conservative halt with an operator path beats guessing.)
- Config = neither stream → halt (the incident's shape).

**Physical-state classification is a CORRELATED row table keyed by write
boundary** (Round-3 f3 — independent per-axis sets admit impossible
cross-products): for each crash window between consecutive write
operations in `reset-journal.ts`, the design table enumerates the exact
legal combination row: active state (absent | exact-old | exact-new |
other, streaming hash), incarnation marker (absent | old | new | other —
including the ordinary-CAS-removed state, `config.ts:563-568`),
candidate/archive presence+hash AS A PAIR (archive-present/candidate-
absent is legal only for the journal-authenticated exact-archive baseline), RECOVERY refs separately from ACTIVE
refs (recovery refs may be a PREFIX subset within a common directory —
they are created one at a time, `reset-journal.ts:196-205,272-285`), and
active-ref retirement per common-directory GROUP (groups retire
atomically but the group SET may be partially processed,
`:208-219,305-322`). Recovery proceeds only when the observed combination
matches a legal row; anything else — including same-stream wrong
nonce/hash — classifies ambiguous → halt, zero writes. Classification is
READ-ONLY (streaming hashes, lstat, ref reads); the classifier itself never
persists anything (see F2b ownership). Tests: for each phase, one
in-expected-set case that recovers identically to today, plus injected
deviations on every axis proving halt + zero-write snapshots.

**The row table itself** (Round-4 f3 — derived from the code's write
sequence by mechanical audit, ratified into this design; the table below is
NORMATIVE and the implementation's classifier must match it row-for-row):

# Design 138 F1c — correlated physical-signature allow table

This is the safety-critical allow set for a **standing, valid, authorized v2
reset journal**.  The authorization gate runs before this table: the journal
witness must authorize `journal.next.stream`, and durable config must name
either `journal.old.stream` or `journal.next.stream`.  A config naming neither
stream has action `n/a` and halts without writes.

Every axis is correlated by row.  An observation that matches no complete row
below is ambiguous and **must halt without writes**.  In particular, `other` on
any byte/hash/marker/ref axis, a non-prefix recovery-ref disposition, a mixed
disposition within one common-directory active-ref group, or an unlisted
candidate/archive pair is not recoverable.

## Exact notation

- `O` / `N` in the active-state column mean byte-hash-exact
  `journal.old.stateSha256` / `journal.next.stateSha256`, respectively.  The
  latter bytes are the canonical encoded `journal.next.state`.  No row admits
  active state `absent` or `other`.
- Candidate `N` means the exact canonical next-state bytes.  Archive `O` means
  bytes whose streaming SHA-256 is exactly `journal.old.stateSha256`.
- `archiveBaseline=exact` means initiation observed those exact archive bytes
  before publication and recorded that fact in the journal. `P0A` is legal only
  with that witness; an archive appearing beside an `absent` baseline is not.
- Marker `MO` / `MN` means a schema-exact marker whose semantic tuple is
  exactly `{stream,stateNonce,stateRevision}` from `journal.old` /
  `journal.next`.  This is semantic equality, not serialization equality:
  existing marker writers do not all use the same whitespace. `M∅` means
  absent.  Before the reset writes `MN`, `M∅` is legal because ordinary state
  CAS removes the marker after publishing state
  (`src/cli/config.ts:563-568`).  `Mpre` means exactly `{MO, M∅}`.  After the
  marker write, only `MN` is legal.
- Let journal Z entries be `E1..En` in journal order.  Validation requires that
  order to be the global `activeRef`/`targetOid` order
  (`src/cli/reset-journal.ts:125-126`), and recovery-ref creation iterates that
  same order (`src/cli/reset-journal.ts:196-205`).  `Rk` means recovery refs for
  exactly `E1..Ek` exist at their exact `targetOid`, while `E(k+1)..En` are
  absent.  `R0` and `Rn` are the empty and complete prefixes.  The prefix is
  global; its projection into a common directory is not a separately chosen
  prefix.
- Let `D1..Dm` be the distinct `commonDirReal` groups in lexical order, which is
  the retirement loop order (`src/cli/reset-journal.ts:209-212`).  `Ag` means
  every active ref in `D1..Dg` is absent and every active ref in
  `D(g+1)..Dm` is exact at its entry's `targetOid`.  A group is indivisible:
  the helper verifies a uniform group and deletes it in one `update-ref
  --stdin` transaction (`src/cli/reset-journal.ts:213-219`).  `A0` is all
  exact-present; `Am` is all absent.
- In the action column, `old:` is the next physical roll-forward step when
  durable config still names the old stream.  `next:` is the F1c outcome when
  config already names the next stream: complete retirement beginning at the
  named remaining step.  Thus “complete-retirement from X” still performs X
  and all later state/marker/ref/journal steps; it is not cleanup-only.
- When `n=0`, `R0 = Rn` and there are no `P3.k` rows.  When `m=0`, `A0 = Am`
  and there are no `I3.g` rows.

## Correlated rows

| Window id and durable boundary | Journal phase on disk | Active state | Candidate | Archive | Marker | Recovery refs | Active refs per common-dir group | Recovery action for a match |
|---|---|---|---|---|---|---|---|---|
| **P0 — prepared journal published**, before the first recovery artifact write (`src/cli/reset-journal.ts:391-392`) | `prepared` | `O` | absent | absent | `Mpre` | `R0` | `A0` | old: **roll-forward step candidate-create** at `:278`; next: **complete-retirement from candidate-create** |
| **P0A — prepared journal adopts a pre-existing exact canonical archive** (`archiveBaseline=exact`) | `prepared` | `O` | absent | `O` | `Mpre` | `R0` | `A0` | old: **roll-forward step candidate-create**, then skip the already-satisfied archive copy; next: **complete-retirement from candidate-create** |
| **P1 — candidate created** (`src/cli/reset-journal.ts:278`, durable helper `:163-170`) | `prepared` | `O` | `N` | absent | `Mpre` | `R0` | `A0` | old: **roll-forward step archive-create** at `:279-280`; next: **complete-retirement from archive-create** |
| **P2 — archive created** (`src/cli/reset-journal.ts:279-280`, durable helper `:163-170`) | `prepared` | `O` | `N` | `O` | `Mpre` | `R0` | `A0` | old: **roll-forward step recovery-ref `E1`**, or ready-phase write if `n=0`; next: **complete-retirement from that step** |
| **P3.k — recovery ref `Ek` updated**, one row for every `1 ≤ k ≤ n` (`src/cli/reset-journal.ts:196-205`, called at `:281`) | `prepared` | `O` | `N` | `O` | `Mpre` | `Rk` | `A0` | old: **roll-forward step recovery-ref `E(k+1)`** if `k<n`, otherwise ready-phase write; next: **complete-retirement from that step** |
| **R0 — ready phase written** (`src/cli/reset-journal.ts:285`, phase write `:235-239`) | `ready` | `O` | `N` | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step candidate→active rename** at `:299-300`; next: **complete-retirement from candidate→active rename** |
| **R1 — candidate→active rename observed with candidate absent** | `ready` | `N` | absent | `O` | `Mpre` | `Rn` | `A0` | old: active is already exact-new; **fsync the active parent, remove candidate with absent-success semantics, fsync the candidate parent, then publish `installed`**; never re-create or rename the candidate. next: **complete-retirement with the identical physical ordering** |
| **R2 — ready candidate re-created or resurrected** | `ready` | `N` | `N` | `O` | `Mpre` | `Rn` | `A0` | old: revalidate active and candidate as exact-new, **fsync the active parent, durably unlink the redundant candidate, fsync the candidate parent, then publish `installed`**; never rename it over active. next: **complete-retirement from that unlink with the identical ordering** |
| **I0 — installed phase written** (`src/cli/reset-journal.ts:302`, phase write `:235-239`) | `installed` | `N` | absent | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step state exactness check/repair** at `:305-310`; next: **complete-retirement from that check** |
| **I1 — state check/repair completed** (`src/cli/reset-journal.ts:305-310`) | `installed` | `N` | absent | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step marker-write** at `:311-316`; next: **complete-retirement from marker-write** |
| **I2 — marker written** (`src/cli/reset-journal.ts:311-316`) | `installed` | `N` | absent | `O` | `MN` | `Rn` | `A0` | old: **roll-forward step retire group `D1`**, or z-retired phase write if `m=0`; next: **complete-retirement from that step** |
| **I3.g — common-directory group `Dg` retired**, one row for every `1 ≤ g ≤ m` (`src/cli/reset-journal.ts:208-219`, called at `:321`) | `installed` | `N` | absent | `O` | `MN` | `Rn` | `Ag` | old: **roll-forward step retire group `D(g+1)`** if `g<m`, otherwise z-retired phase write; next: **complete-retirement from that step** |
| **Z0 — z-retired phase written** (`src/cli/reset-journal.ts:322`, phase write `:235-239`) | `z-retired` | `N` | absent | `O` | `MN` | `Rn` | `Am` | old or next: **complete-retirement** by journal unlink/fsync and idempotent candidate cleanup (`:325-335`) |

`I0` and `I1` are intentionally observationally identical.  On every allowed
internally produced signature, the conditional write at
`src/cli/reset-journal.ts:305-310` is a no-op because state is already `N`.
An actual repair write requires an unlisted precursor (`absent`, `O`, or
`other` active state while phase is `installed`); the classifier must not admit
that precursor merely to make the old repair branch reachable.  The duplicate
row records the requested program boundary without widening the allow set.

After journal unlink and its parent fsync (`src/cli/reset-journal.ts:328-329`),
there is no standing-journal classification.  Its recovery action is `n/a`;
the candidate cleanup at `:330-335` is terminal and idempotent.

## Exhaustiveness constraints exposed by the current implementation

The table above is the strict F1c allow set.  Ratification must also require the
implementation changes below; otherwise the current code can itself publish or
encounter signatures that this table correctly classifies as ambiguous.

1. **The ready retry has an omitted write boundary.**  Line `:297` durably
   re-creates a missing candidate before the second rename.  `R2` is therefore
   required even though the prose enumeration mentions only the prepared
   candidate creation.  Worse, current lines `:291-294` treat `R2`
   (`ready + active N + candidate N`) as an intervening-state abort on the next
   recovery.  Hardened recovery must match `R2` and continue retirement, not
   quarantine/delete its own journal.
2. **Archive/ref idempotence needs an initiation invariant.**
   `expectedAbsentOrExact` accepts a pre-existing exact archive (`:163-170,
   :279-280`), and `createRecoveryRefs` skips any pre-existing exact recovery
   ref (`:201-204`).  Quarantine intentionally preserves deterministic recovery
   refs and the canonical archive.  A later journal can therefore begin with an
   exact archive while candidate is absent, or with an arbitrary bitmap of
   exact recovery refs.  Initiation records a byte-exact pre-existing archive as
   `archiveBaseline=exact`, admitting only `P0A`, while exact-target recovery
   refs are re-derivable and are old-value-CAS deleted back to `R0` before
   publication. Wrong archive bytes or wrong ref targets refuse. A bare `Rk`
   claim is exhaustive only with that invariant.
3. **Marker absence is legal, but CAS publication/removal is not one durable
   transaction.**  CAS publishes state at `src/cli/config.ts:563-565` and then
   removes the marker at `:567` without a parent-directory fsync.  A crash can
   leave a stale marker that is `other` relative to the later journal's old
   state.  Reset initiation must normalize or refuse that marker before journal
   publication; this table must not bless stale-marker `other`.
4. **The rename does not sync both parents.**  Candidate and active have
   different parent directories, while `src/cli/reset-journal.ts:299-300` fsyncs
   only the active-state parent.  A power loss may resurrect the candidate
   source entry.  That produces the already-listed `R2` signature, but the
   implementation should fsync both parents so `R1` is the promised durable
   post-rename boundary.



Row-action corrections (Round-5 f2): the R2 crash window (post-rename)
requires a DURABLE candidate unlink — recovery completing a rename must
fsync the DESTINATION parent before unlinking the source and then fsync
the SOURCE parent, so a resurrected rename-source can never coexist with
the installed active state after recovery declares the window closed; the
R1/R2 recovery actions in the table are amended accordingly.

Two further code-level corrections the derivation surfaced (both become
implementation requirements): reset initiation must normalize-or-refuse a
stale incarnation marker left by an ordinary state CAS (config.ts:563-568
removes it without a parent fsync — a crash can leave `other`-relative
markers that the table must not bless), and the candidate→active rename
must fsync BOTH parent directories (reset-journal.ts:299-300 fsyncs only
the active parent; power loss can resurrect the candidate source entry).

Recovery outcomes (explicit): config=old + eligible → roll forward
(complete the reset exactly as today); config=next + eligible → complete
retirement/cleanup; anything else → halt.

### F2: bounded-memory reads — initiation included (R2-f5)

v2's streaming rewrite of the recovery hash/equality/copy cluster stands,
with these additions:

- EVERY reset-preparation read is capped: `loadRawState` gains the same
  bounded read (hard byte counter + open-handle identity + post-read
  size/identity revalidation) — including its uses at `config.ts:906,958`
  and the raw reads at `:799-803,1009-1014,1084-1096`. One shared
  `boundedRead`/`boundedStream` primitive serves both whole-file
  materialization (where parse is semantically required) and streaming
  sites; a pre-stat + naked `readFile` is no longer an accepted pattern in
  reset paths.
- **Two ceilings with stated math** (Round-3 f4, Round-4 f4): streaming
  operations (hash/equality/copy) keep the 2GiB size ceiling. WHOLE-
  MATERIALIZATION paths use a multiplier M that is MEASURED, not assumed
  (Round-5 f3, Round-6): NO fixed constant is claimed as worst-case. The
  mandated benchmark measures peak expansion for a state-SHAPED document
  (small-node-heavy, matching real manifests) at build/test time, and the
  runtime bound is **measured-M × 2 safety factor**. `availableBudget` is
  DEFINED: `B − currentRSS` sampled immediately before the parse (B =
  explicit process budget, default 4GiB, env-overridable). ONE
  authoritative rule (Round-7 — the prior static/dynamic pair conflicted):
  the DYNAMIC check `fileSize × (measuredM × 2) ≤ B − currentRSS` is THE
  admission gate; 512MiB is a separate static file-size cap applied
  first (a UX bound, not a memory claim). The benchmark corpus is the
  JSON-GRAMMAR worst case, NOT the schema's (Round-8: `JSON.parse` runs
  before any schema validation, so the bound must hold for arbitrary
  admitted bytes): a maximum-admitted-size SWEEP of minimal-token flood families —
  minimal arrays, objects, strings, and mixed containers — with M
  pinned from the MAXIMUM measured expansion across the family (Round-9:
  no single shape is assumed the allocator's worst; the CI
  re-measurement runs the same sweep), so ANY input passing the size
  gate is covered regardless of validity; pathological deep nesting is handled separately — the
  parser's RangeError is caught and mapped to the typed
  reset-corruption error (test mandated). M is pinned from THAT
  measurement, recorded beside the constant, with a CI
  re-measurement assertion so parser drift breaks the build rather than
  the bound. The pre-allocation
  check computes `fileSize × M ≤ availableBudget` and fails cleanly
  BEFORE allocating. Constrained-memory tests run AT each effective
  ceiling under an enforced budget. The 65MiB fleet regression test
  stands. (Fleet reality: 77MB states — >6× headroom, early-warning at
  half the ceiling.)

### F2b: daemon halt/heal state machine (R2-f6/f7)

- **Op-boundary classification**: after acquiring the sync mutex and BEFORE
  any scan, pull, or push work, every daemon op runs the read-only journal
  check (an lstat when no journal exists — cheap; full classification only
  when one appears). This is unconditional — cached `syncBase` does not
  bypass it; full/deep scans are gated by the same boundary.
- **State machine**: `ready → halted` → `recovering` (bounded retry: at
  halt entry, then hourly) → `bootstrapping` → `ready` — with a
  **three-way agreement gate before bootstrapping** (Round-3 f5): under
  the operation fence, the daemon's boot-time stream, a FRESHLY loaded
  durable config stream, and the recovered active-state stream/nonce must
  all agree; on any disagreement (e.g. init crashed after reset but
  before config save — `init-cmd.ts:188-212` — or an external rebind
  while the daemon was live) the daemon REMAINS HALTED awaiting rebind
  completion or a clean restart; it never seeds `RboxDaemon.start()`
  state from a stale binding. Bootstrapping re-runs the startup seeding
  exactly once without duplicating watchers/WS/timers (armed-but-ignored
  during halt). The DIRECT startup scan (`daemon.ts:454-471`) sits inside
  the universal pre-scan boundary, not only the pump-loop check. While
  halted: status/health live, watcher events dropped, WS ignored, no
  scan/pull/push, no state writes.
- **Health ownership resolves the zero-write contradiction**: the
  CLASSIFIER is pure. The DAEMON (already a mutating process) is the sole
  writer of the persisted health side-file (`.rbox/state/health-halt.json`:
  reason, journal identity hash, timestamp) — written on halt entry,
  cleared exactly once on successful heal or when the journal disappears
  (operator quarantine). Read-only CLI commands NEVER write health: direct
  `rbox status` renders the degraded block from its own in-memory
  classification plus the side-file if present.
- **Status degraded path**: when classification (or the side-file) says
  halt, status renders an early degraded block — workspace header from
  config, the halt line (`"sync halted: a state-recovery record can't be
  processed (<reason>). Files on disk are untouched; run \`rbox doctor
  reset-journal\`."`), daemon liveness from the pid file — and SKIPS every
  state-dependent section (`status-cmd.ts:280-405,500-623` never
  dereference a state that doesn't exist). `--json` gains `{halted: true,
  reason}` with the same skip semantics. Stale side-file (journal gone,
  daemon not yet cycled) renders as `"recovering"`.
- Log suppression: bounded LRU map policy from v2 stands. Tests: poisoned
  startup; poison inserted mid-run with warm `syncBase`; heal transition
  exactly-once (no duplicate watchers/timers — assert by handle counts);
  direct-CLI-vs-daemon race on the side-file; restart after heal.

### F2c: quarantine as a crash-recoverable transaction (R2-f8/f9)

- **Namespace**: `.rbox/state/quarantine/<ts>/` — structurally OUTSIDE
  `TRASH_REL`, so `pruneTrash` (age, cap, `trash empty` —
  `engine/trash.ts:109-185`) can never touch it. Tests prove survival under
  all three pruning modes.
- **Eligibility by phase** (from the classifier): `prepared` and `ready`
  with active=exact-old → eligible. `ready` with active=exact-new and
  `installed` → NOT eligible for quarantine (the state has progressed;
  forward recovery is the only safe operation — doctor says exactly that).
  Malformed metadata → eligible for a JOURNAL-ONLY quarantine: the journal
  file moves; candidate/archive are left untouched (they cannot be safely
  identified) and the manifest records that bounded scope.
- **Durable archives are COPIED, never moved**: the old-lineage archive is
  rebind provenance consumed by `hasResetLineageArchive`
  (`config.ts:331-345,727-733`) and must remain at its canonical path.
- **Mutual exclusion (Round-3 f6, Round-5 f1)**: doctor's quarantine AND
  restore acquire the SAME canonical recovery fence as recovery itself —
  the F1b repository-order fence (workspace mutex, then per common
  directory operation→reflog→origin→git… in canonical order, state LAST;
  the earlier operation→state shorthand is superseded), then
  RECLASSIFY under the fence before acting — eligibility judged from a
  pre-fence classification is discarded. The fence is held through the
  quarantine's journal-removal or the restore's publication point, so
  doctor can never race recovery past a phase transition or expose TOCTOU
  on the active-hash/marker/ref preconditions.
- **Commit protocol (durable, Round-3 f7)**: (1) create bundle dir +
  `manifest.json` (artifact list, streaming hashes, phase, active-state
  hash, marker/ref preconditions); (2) copy artifacts in; (3) fsync every
  copy; (4) verify against manifest; (4b) fsync `manifest.json` itself (Round-5 f4 — the record's
  self-validation is only as durable as the manifest it hashes); (5)
  write the commit record — a single
  self-validating file CONTAINING the manifest's hash and the bundle
  inventory hash (Round-4 f5) — via tmp-write → fsync → atomic rename →
  bundle-dir fsync → parent fsync, so the commit point is durable AND
  resume can verify record↔manifest↔bundle consistency before trusting
  it; a record that fails self-validation is treated as no-commit
  (partial-bundle cleanup applies, originals intact); (6) remove the original JOURNAL +
  fsync its parent (the system leaves halt); (7) remove remaining MOVABLE
  originals — where resume removes a canonical original ONLY if it is
  absent or still manifest-exact (a replacement written by a NEW reset is
  never touched). **Deterministic recovery refs are LEFT IN PLACE** —
  they are derived from old-lineage/target (`reset-journal.ts:120,
  196-205`) and may be legitimately shared with a subsequent reset from
  the same lineage; quarantine never deletes refs (bounded growth, 130's
  existing ref-cap hygiene applies). Crash resume: no `COMMITTED` →
  delete partial bundle, originals intact; `COMMITTED` present → finish
  6-7 under the fence with the absent-or-manifest-exact rule.
- **Restore protocol (crash-resumable, Round-3 f8)**: preconditions under
  the fence — durable config stream must be ELIGIBLE for the journal (old
  or next, same rule as recovery), no journal at the original path, every
  non-journal destination absent-or-manifest-exact, active state still
  manifest-exact. Then: revalidate bundle hashes → copy/fsync/verify all
  INERT artifacts first → **publish the journal LAST, atomically**
  (rename + parent fsync) — a crash before publication leaves no journal
  and a retry that passes the same preconditions; a crash after
  publication is indistinguishable from a normal standing journal and
  recovery/classification takes over. Already-restored and
  already-recovered exact states are recognized and treated as success
  (idempotent) before bundle removal.

## Tests the implementation MUST write

v2's list stands, updated/extended: two-stage witness (substitution +
double-narrowing refused); barrier/TOCTOU test (nonce advance between
validation and publication → zero writes incl. git refs); journal-v2
witness round-trip + legacy-v1 halt; expected-signature table per phase
(in-set recovery pinned, every-axis deviations halt); constrained-memory
recovery AND initiation; bounded `loadRawState` everywhere in reset paths;
op-boundary halt with warm `syncBase`; heal exactly-once without duplicate
watchers/timers; status degraded text + JSON with zero state dereference;
health side-file single-writer + stale-record rendering; quarantine commit
protocol crash-resume at every step boundary; archive copied-not-moved;
restore refusal after state advance; quarantine survival under age/cap/
`trash empty` pruning.

## Non-goals

Unchanged from v2 (wizard behavior = 137; no `--force-rebind` flag; no
server-side changes; whole-parse of state where semantically required is
retained under bounded reads). Plus: no journal v1→v2 migration tooling —
v1 journals halt into the doctor path by design.

## Acceptance

Unchanged from v2, plus: the incident's forensic journal (foreign
`next.stream`, v1 format) must classify ambiguous → halt → doctor
quarantine (journal-only mode) → daemon heals — replayed end-to-end in a
scratch workspace.

## Rulings

Round 1 (10 findings): all accepted — see v2 rulings (unchanged).
Round 2 (9 findings): all ACCEPT. f1 two-stage witness with stamped
narrowing. f2 pure validity check separated from the lock-fenced recheck
held through first mutation; preparatory mutations reordered behind the
fence; barrier test. f3 journal v2 authorization witness; legacy v1 →
halt; explicit config=old/next/neither outcomes. f4 expected-signature
physical-state table, deviation ⇒ halt, complete by construction. f5
bounded reads at every initiation site incl. loadRawState; constrained
initiation test. f6 unconditional op-boundary classification + explicit
halted→recovering→bootstrapping→ready machine. f7 pure classifier;
daemon-owned health side-file; degraded status/JSON path with no state
dereference; stale-record rule. f8 phase-eligibility; archives copied not
moved; manifest+COMMITTED crash-resumable protocol; restore preconditions
incl. active-hash equality. f9 quarantine outside TRASH_REL with pruning-
survival tests.
Round 3 (8 findings): all ACCEPT, folded in v4 — f1 Stage-A binds every
known next-stream coordinate + create-helper argument verification; f2
canonical lock order (ws mutex → sorted common-dir locks → state lock) with
held-lock-aware CAS/save APIs and the legacy-migration CAS moved inside the
fence; f3 correlated row table per write boundary (recovery refs prefix-
legal, active refs group-partial-legal, paired candidate/archive, CAS-
removed marker state); f4 split ceilings — 512MiB whole-parse with
pre-allocation budget check, 2GiB streaming, tests AT each ceiling; f5
three-way agreement gate (boot/config/state) before bootstrapping, startup
scan inside the universal boundary; f6 quarantine/restore acquire the
recovery fence + reclassify under it; f7 durable COMMITTED before journal
unlink, absent-or-manifest-exact resume rule, deterministic refs left in
place; f8 inert-artifacts-first + journal-last atomic restore publication,
config-eligibility precondition, idempotent already-restored handling.
