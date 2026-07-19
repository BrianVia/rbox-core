# Research 138 boundaries: raw material for design 163 v2

Research-only source audit. This report records the current JSON-state reset protocol so design 138's crash-window table can be re-derived for design 163's SQLite state plane. It proposes no replacement design.

Source snapshot: branch `163-v2`, current `HEAD` `9ad516b` (the reset implementation is unchanged from parent `614060d`). Current line references below are deliberately separate from design 138's historical line references embedded in its normative text.

## 1. Design 138 normative corpus — verbatim

The following blocks are copied verbatim from `docs/design/138-reset-path-hardening.md`. They include the authorization gate, correlated-classification invariant, exact notation, every P/R/I/Z row, every post-boundary rule, the exhaustiveness corrections that constrain the allow set, and the explicit recovery outcomes.

### `docs/design/138-reset-path-hardening.md:92-125` — authorization and correlated-boundary invariant

```markdown
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
```

### `docs/design/138-reset-path-hardening.md:127-185` — normative declaration and exact notation

```markdown
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
```

### `docs/design/138-reset-path-hardening.md:187-203` — correlated rows

```markdown
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
```

### `docs/design/138-reset-path-hardening.md:205-215` — rules after the listed durable boundaries

```markdown
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
```

### `docs/design/138-reset-path-hardening.md:217-269` — exhaustiveness and durability constraints

```markdown
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
```

### `docs/design/138-reset-path-hardening.md:271-273` — explicit outcomes

```markdown
Recovery outcomes (explicit): config=old + eligible → roll forward
(complete the reset exactly as today); config=next + eligible → complete
retirement/cleanup; anything else → halt.
```

## 2. Current implementation: artifacts, ordering, durability, signatures

### 2.1 Artifact paths and order inputs

| Artifact/order input | Current source | Current value/order |
|---|---|---|
| Live journal | `src/cli/reset-journal.ts:130` | `.rbox/state/reset-v1.json` |
| Candidate | `src/cli/reset-journal.ts:131` | `.rbox/state/reset-candidates/<journal-id>.json` |
| Old-lineage archive | `src/cli/reset-journal.ts:132` | `.rbox/state/lineages/<old-nonce>/<old-sha256>.json` |
| Incarnation marker | `src/cli/reset-journal.ts:133` | `.rbox/state/state-incarnation.json` |
| Active state | `src/cli/reset-journal.ts:134`; same public path at `src/cli/config.ts:342` | `.rbox/state.json` |
| Recovery-ref order `E1..En` | Z entries assembled at `src/cli/config.ts:1041-1053`, foreign active refs checked at `:1054-1060`, sorted at `:1071`, sorted again into the journal at `src/cli/reset-journal.ts:553-559`, and schema-valid order enforced at `:170-171` | Global `activeRef`, then `targetOid` lexical order |
| Active retirement order `D1..Dm` | `src/cli/reset-journal.ts:401-407` | Distinct `commonDirReal` lexical order; refs inside a group sorted by `activeRef` |
| Fresh journal handoff | `src/cli/config.ts:1240-1246`, then `:1252-1255` | Preparation calls `beginResetJournal` while the complete fence/state lock is held; after that scope releases, the standing journal is detected and `recoverResetJournal` reacquires the recovery fence/state lock at `src/cli/reset-journal.ts:514-529` |

The relevant directory identities are distinct: active destination parent is `<root>/.rbox` (`src/cli/reset-journal.ts:134,466`); candidate source parent is `<root>/.rbox/state/reset-candidates` (`:131,467`); journal and marker parent is `<root>/.rbox/state` (`:130,133`); and archive parent is `<root>/.rbox/state/lineages/<old-nonce>` (`:132`). Thus the active-parent fsync at `:469` and candidate-parent fsync at `:472` close different directory entries.

### 2.2 Durability primitives actually used

| Primitive | Current implementation | File-byte discipline | Directory discipline |
|---|---|---|---|
| `writeFileAtomic` | `src/engine/fsutil.ts:16-68` | Sibling temp is written and `fh.sync()`ed at `:34-40`, closed, then renamed at `:60-63` | None inside this helper |
| `durableWrite` | `src/cli/reset-journal.ts:226-234` | Calls `writeFileAtomic` at `:231`, therefore temp-file fsync before rename | Immediate parent fsync at `:232`; each newly created directory entry is published bottom-up at `:233` via `src/engine/fsutil.ts:114-123` |
| `boundedCopy` | `src/cli/reset-io.ts:245-266` | Destination sibling temp is streamed, `output.sync()`ed at `:255`, closed, then renamed at `:258` | Destination parent fsync at `:259`; newly created directory ancestors at `:260` |
| Recovery-ref update | `src/cli/reset-journal.ts:389-398` | One `git update-ref <recovery-ref> <target> ""` command per entry at `:396` | No application-side file or directory fsync; persistence is delegated to Git command completion/ref handling |
| Active-ref group retirement | `src/cli/reset-journal.ts:401-420` | One `git update-ref --stdin` delete transaction per common-directory group at `:416-419` | No application-side file or directory fsync; persistence is delegated to Git command completion/ref handling |
| Directory fsync | `src/engine/fsutil.ts:70-79` | n/a | Opens the directory and syncs its handle |

All journal phase publications (`prepared`, `ready`, `installed`, `z-retired`), the candidate write, and the marker write use `durableWrite`; each therefore has staged-byte fsync, atomic rename, immediate-parent fsync, and created-ancestor publication. The archive uses `boundedCopy` and receives the analogous discipline. Git ref operations do not receive a second fsync from reset code.

### 2.3 Exact ordered journalled sequence

Notation in the signature column is the executable classifier's notation from `src/cli/reset-journal-classifier.ts:3-23,37-41`. The complete row matcher is at `:43-72`. “Signature after boundary” means the physical observation produced when the current operation returns (and used by the crash hooks/tests). For Git-ref commands, reset code supplies no additional fsync guarantee beyond Git command completion; for the unsynced cross-directory rename sub-boundary, the table separately lists the allowed signatures that a restart may observe.

| # | Current durable operation and exact source | Mutated artifact | Durability discipline | Crash-classifier signature after this boundary |
|---:|---|---|---|---|
| 0 | Before journal publication, each already-existing exact-target recovery ref is CAS-deleted with `git update-ref -d recoveryRef targetOid` at `src/cli/reset-journal.ts:561-580`; all refs are rescanned at `:581-585`. A pre-existing exact canonical archive is adopted by setting the in-memory `archiveBaseline=exact` at `:565-574`. | Deterministic recovery refs; journal object's not-yet-durable baseline. The archive is read/adopted, not rewritten. | One Git command per ref; no reset-code fsync. | No standing journal, therefore no P/R/I/Z classification. This establishes only the initiation precondition for future P0 (archive absent) or P0A (archive exact). |
| 1 | Construct journal at `src/cli/reset-journal.ts:548-560`; publish `prepared` via `writeJournal` at `:586`, whose implementation is `:377-380`; crash hook at `:587`. | Live journal. | `durableWrite`: staged journal file fsync, rename, journal-parent fsync, created-directory ancestor publication. | **P0** = `prepared,O,candidate absent,archive absent,Mpre,R0,A0,archiveBaseline absent`; or **P0A** = same except `archive O,archiveBaseline exact`. |
| 2 | On P0/P0A, create candidate with `expectedAbsentOrExact(candidate,nextBytes)` at `src/cli/reset-journal.ts:439-444`; helper at `:236-241`. | Candidate `N`. | `durableWrite`: staged file fsync, rename, candidate-parent fsync, created-ancestor publication. | P0 → **P1** = `prepared,O,N,archive absent,Mpre,R0,A0`. P0A → **P2**, because the old archive was already exact. |
| 3 | On P0/P1, verify active old hash, copy active to archive, then verify archive hash at `src/cli/reset-journal.ts:445-450`. P0A skips this write. | Canonical old archive `O`. | `boundedCopy`: staged archive fsync, rename, archive-parent fsync, created-ancestor publication (`src/cli/reset-io.ts:245-260`). | P1 → **P2** = `prepared,O,N,O,Mpre,R0,A0`. |
| 4 | Create recovery refs `E1..En` in journal order at `src/cli/reset-journal.ts:389-398`, called after reinspection at `:451-459`. Each entry revalidates repository identity and the active/recovery ref values before update. | One deterministic recovery ref `Ek` per iteration. | One Git `update-ref` command per ref; no explicit reset-code fsync. | After `Ek`: **P3.k** = `prepared,O,N,O,Mpre,Rk,A0`, for `1 ≤ k ≤ n`. For `n=0`, the physical row remains P2. |
| 5 | Verify complete recovery-ref prefix at `src/cli/reset-journal.ts:454-459`, then publish journal phase `ready` at `:460` through `setPhase` at `:382-386`. | Journal phase. | Durable journal overwrite. | **R0** = `ready,O,N,O,Mpre,Rn,A0`. |
| 6 | Only from R0, rename candidate → active at `src/cli/reset-journal.ts:465-469` (rename at `:468`). R1/R2 recovery paths never rename. | Active directory entry becomes `N`; candidate source entry becomes logically absent. | Atomic rename. Candidate bytes were file-synced at creation; no new active-file fsync. Neither parent is synced by this operation itself. | Immediate live observation is **R1**. Because neither parent is yet synced, a restart may still observe allowed R0 (rename lost), R1, or R2; any different correlation is unlisted and halts. This line alone is not a closed durable boundary. |
| 7 | Fsync destination/active parent at `src/cli/reset-journal.ts:466,469-470`. | Active-parent directory metadata. | Directory fsync; no file fsync. | Live **R1** = `ready,N,absent,O,Mpre,Rn,A0`. Before the source parent is fsynced, power loss may resurrect the candidate source entry, yielding allowed **R2** = `ready,N,N,O,Mpre,Rn,A0`. |
| 8 | Force-remove candidate at `src/cli/reset-journal.ts:471`; this runs for R0, R1, and R2. | Candidate directory entry. | Unlink only; not durably closed until step 9. | Live R1; before source-parent fsync, a crash may still recover as R2. |
| 9 | Fsync candidate/source parent at `src/cli/reset-journal.ts:472-474`. The R2 path therefore fsyncs destination, unlinks the redundant candidate, then fsyncs source, without renaming over active. | Candidate-parent directory metadata. | Source-directory fsync paired with step 7's destination-directory fsync. | **R1 only** = `ready,N,absent,O,Mpre,Rn,A0`. This is the closed active-install boundary. |
| 10 | Reinspect and require R1 at `src/cli/reset-journal.ts:475-478`; publish journal phase `installed` at `:479`; reinspection at `:480-481`. | Journal phase. | Durable journal overwrite. | **I0/I1 observational alias** = `installed,N,absent,O,Mpre,Rn,A0`. Current code has no distinct durable state-check write between these IDs; the classifier returns both at `src/cli/reset-journal-classifier.ts:62-64`. |
| 11 | If marker is not already `next`, publish next incarnation tuple at `src/cli/reset-journal.ts:484-488` (write at `:486`). | Incarnation marker `MN`. | `durableWrite`: staged marker fsync, rename, marker-parent fsync, created-ancestor publication. | Clean I0/I1 → marker-write path produces **I2** = `installed,N,absent,O,MN,Rn,A0`. On resume, an already-next marker can mean I2 or I3.g (`src/cli/reset-journal-classifier.ts:64-66`); then this write is skipped and the existing signature/group count is preserved before retirement resumes at `reset-journal.ts:489-491`. |
| 12 | Reinspect, then retire active Z-ref groups `D1..Dm` at `src/cli/reset-journal.ts:489-497`, using group loop/transaction at `:401-420`. Every group's refs are validated as uniformly present/absent; a present group is deleted in one transaction. | All active settled-absence refs in one common-directory group. | One Git `update-ref --stdin` transaction per group; no explicit reset-code fsync. | After `Dg`: **I3.g** = `installed,N,absent,O,MN,Rn,Ag`, for `1 ≤ g ≤ m`. For `m=0`, the physical row remains I2. |
| 13 | Reinspect and require all groups retired at `src/cli/reset-journal.ts:492-497`; publish phase `z-retired` at `:498`. | Journal phase. | Durable journal overwrite. | **Z0** = `z-retired,N,absent,O,MN,Rn,Am`. |
| 14 | Reinspect and require Z0 at `src/cli/reset-journal.ts:501-503`; unlink journal at `:504`; fsync journal parent at `:505`. | Live-journal directory entry. | Unlink followed by parent-directory fsync. | After the parent fsync there is **no standing-journal classification**; `inspectResetJournal` returns `none`. |
| 15 | Terminal candidate cleanup: lstat, force-remove, and conditionally fsync candidate parent if it existed at `src/cli/reset-journal.ts:506-509`. | Candidate entry, normally already absent under Z0. | Unlink plus conditional parent fsync. | `n/a`: the journal is already absent. |

### 2.4 Non-journal and pre-publication branches adjacent to the sequence

| Branch | Current source | Durable behavior | Classifier consequence |
|---|---|---|---|
| A standing authorized transaction exists before a fresh reset | `src/cli/config.ts:1125-1131` | It is recovered through the same sequence before fresh preparation begins. | Its own current P/R/I/Z row applies; fresh initiation does not begin until it is terminal. |
| Legacy prior state needs a fenced lineage | `src/cli/config.ts:1218-1234` calls `applyStateSavePacket`; active publication and marker removal are at `:589-598` | Active uses `writeFileAtomic` (staged file fsync + rename, but no active-parent fsync here). Existing marker is then removed and its parent fsynced. | No reset journal yet; no P/R/I/Z row. The later initiation rechecks/normalizes the resulting state. |
| Reset preparation repairs/settles protocol artifacts | Complete-fence preparation is `src/cli/config.ts:870-1072`: checkout-journal recovery `:925-933`, P settlement/repair `:939-1018`, post-P rescan `:1021-1029`, A settlement `:1032-1038`, Z inventory `:1041-1060`, final active-state byte read/revalidation `:1061-1071` | Mutations are owned by their existing protocol helpers while the complete fence and state lock are held. | No reset journal yet; no P/R/I/Z row. These operations establish the inputs recorded by the later journal. |
| No prior durable state/config (genesis) | `src/cli/config.ts:1200-1214` | Writes active state and then marker with plain `writeFileAtomic`. Each temp file is fsynced before rename, but these call sites do not fsync either parent directory. | No reset journal and no correlated P/R/I/Z classification. |

## 3. State reads and reset classification

### 3.1 Every authorization gate, observation prerequisite, and physical row coordinate read by the correlated classifier

`observePhysical` is the single composition point for `ResetPhysicalObservation` at `src/cli/reset-journal.ts:324-340`. `inspectResetJournal` supplies the journal/stream authorization gates and calls the executable row table at `:353-374`. Journal schema/authorization and caller stream are gates, not row axes; repository incarnation is an observation prerequisite that can halt before a row is produced.

| Observed coordinate | Exact current read site | Classification/result |
|---|---|---|
| Standing journal bytes | `src/cli/reset-journal.ts:353-360`; unreadable fallback identity hash at `:356-358` | Missing → `none`; unreadable → halt; otherwise bytes are hashed and parsed. |
| Journal schema/version/durable authorization | Parse at `src/cli/reset-journal.ts:363-365`; v2 validation at `:194-204` | Malformed → halt; v1 → halt; v2 requires embedded `authorizedNextStream === next.stream`. |
| Caller-supplied runtime stream (authorization gate, not a physical row axis) | Argument at `src/cli/reset-journal.ts:353`; gate at `:366-368` | Must equal journal old or next stream; otherwise halt before physical observation. `inspectResetJournal` does not establish that the argument came byte-for-byte from durable config. |
| Active state | Path at `src/cli/reset-journal.ts:324-329`; streaming hash at `:330-332`; mapping at `:298-303` | `absent`, `old`, `next`, or `other`. |
| Candidate | Streaming hash at `src/cli/reset-journal.ts:330-332`; mapping at `:304-306` | `absent`, `next`, or `other`. |
| Old-lineage archive | Streaming hash at `src/cli/reset-journal.ts:330-332`; mapping at `:307-309` | `absent`, `old`, or `other`, correlated with authenticated `archiveBaseline`. |
| Incarnation marker | `markerDisposition` bounded read/parse at `src/cli/reset-journal.ts:311-321`, invoked at `:330-332` | Exact semantic old tuple, exact semantic next tuple, absent, or other. |
| Repository incarnation for every Z entry (observation prerequisite, not a physical row axis) | `verifyIdentity` at `src/cli/reset-journal.ts:252-255`, invoked from `observeRefs` at `:265-267` | Current identity hash must equal the journal-recorded identity; failure is caught as a physical-inspection halt at `:369-371`. |
| Recovery ref for every ordered Z entry | `readRef` at `src/cli/reset-journal.ts:243-250`; loop at `:263-270`; prefix reducer at `:257-261` | Exact-target presence vector becomes a global prefix count or `other`. |
| Active refs by sorted common-directory group | Group construction/read/reduction at `src/cli/reset-journal.ts:271-284` | Each group must be uniform; retired-group vector becomes a prefix count or `other`. |
| Correlated row | `src/cli/reset-journal.ts:372-374` calls `src/cli/reset-journal-classifier.ts:43-72` | No complete row → halt; exact row → recoverable. |

The bounded file readers backing these observations are identity-stable, no-follow reads: `boundedStream` at `src/cli/reset-io.ts:136-201`, `boundedRead` at `:203-216`, and `boundedHash` at `:218-222`.

### 3.2 Other uses of the same physical observation axes

| Use | Exact read sites | Purpose |
|---|---|---|
| P0/P0A initiation preflight | Parallel active/candidate/archive/marker/`observeRefs` reads at `src/cli/reset-journal.ts:561-564`, plus the distinct exact-recovery-ref scan implemented at `:287-295` and invoked in that same `Promise.all`; invariant at `:565-570`; ref rescan after normalization at `:581-584` | Establish a normalized initiation state before the journal exists. `exactRecoveryRefs` separately records which exact refs must be CAS-deleted. |
| Reset-initiation marker normalization | Call at `src/cli/config.ts:1182`; bounded marker read and exact schema/old-lineage tuple comparison at `:858-868` | Refuse a stale/foreign marker before journal publication; exact-old or absence can proceed to P0/P0A initiation. |
| Quarantine restore active-state disposition | `src/cli/reset-quarantine.ts:316-328` | Classifies active hash as original precondition, already recovered target, or advanced/refusal before any restore publication. |
| Quarantine restore marker/ref precondition | Bundled journal bytes at `src/cli/reset-quarantine.ts:332-334`; parser/observation adapter at `src/cli/reset-journal.ts:344-350`; marker/ref comparison at `src/cli/reset-quarantine.ts:335-338` | Re-observes the physical marker/ref plane before republishing a quarantined journal. |
| Quarantine restore standing-journal disposition | `src/cli/reset-quarantine.ts:340-348` | Classifies journal destination as exact already-restored, absent/eligible, or different/refusal. |

### 3.3 Production entry points that classify a standing journal

| Surface | Exact current site(s) | Role |
|---|---|---|
| Stable read-only adapter | `src/cli/reset-halt-inspection.ts:6-7` | Direct wrapper over `inspectResetJournal`. |
| `rbox status` | `src/cli/status-cmd.ts:318-325` | Classifies before every state-dependent section. |
| Daemon startup operation boundary | Caller at `src/cli/daemon/daemon.ts:460-470`, especially `:465`; classifier implementation at `:772-776` | Classifies before startup `loadState` and the direct startup scan. |
| Every daemon pump operation | Caller at `src/cli/daemon/daemon.ts:913-938`, especially `:936`; classifier implementation at `:772-776` | Classifies before pull, push, full-scan, or deep-scan work. |
| Daemon post-recovery verification | `src/cli/daemon/daemon.ts:784-798`, reclassification at `:792` | Requires journal absence before bootstrap. |
| Doctor display | `src/cli/reset-journal-doctor.ts:191-201` | Read-only status/report. |
| Doctor quarantine pre-fence | `src/cli/reset-journal-doctor.ts:112-122`, call at `:114` | Derives fence requests and standing identity. |
| Doctor quarantine under fence | `src/cli/reset-journal-doctor.ts:123-140`, call at `:124` | Authoritative reclassification before quarantine. |
| `loadState` auto-recovery | Journal probe at `src/cli/config.ts:731`; recovery call at `:741` | Enters authoritative recovery/classifier passes. |
| Reset primitive, pre-existing transaction | `src/cli/config.ts:1125-1131` | Completes only an independently authorized standing transaction. |
| Reset primitive, freshly published transaction | `src/cli/config.ts:1252-1255` | Drives the newly standing journal forward. |
| Recovery outer preflight | `src/cli/reset-journal.ts:514-524`, classifier at `:517` | Classifies before deriving/acquiring repository fences. |
| Recovery under held fence | Initial classification at `src/cli/reset-journal.ts:430-434`; boundary rechecks at `:451`, `:454`, `:461`, `:475`, `:480`, `:489`, `:492`, `:502` | Validates the exact correlated row before each following durable mutation/phase publication. |

`readResetJournal` at `src/cli/reset-journal.ts:221-224` reads and parses only; it does not correlate physical axes. Reset health reads (`src/cli/status-cmd.ts:324`, `src/cli/daemon/daemon.ts:776`) are lifecycle/advisory reads, not classifier authority.

`inspectResetJournal` does not load workspace config itself: the stream gate is its `callerStream` argument at `src/cli/reset-journal.ts:353,366-374`. Each production surface derives that runtime value. For example, status merges credential remote URL into raw config before calling at `src/cli/status-cmd.ts:309-312,323`; the daemon passes its boot config at `src/cli/daemon/daemon.ts:775,792`, whose authenticated remote construction can override `remoteUrl` at `src/cli/e2ee-client.ts:303-304,317,325-335`. This is narrower than independently proving that the argument is the byte-for-byte durable config stream.

### 3.4 Complete production `loadState` call inventory

Every call below can enter journal recovery through `src/cli/config.ts:731-745`. The repository's inventory test pins 19 call expressions at `src/cli/reset-consent.test.ts:151-173`.

| Module | Current call sites | Count |
|---|---|---:|
| `src/cli/sync/pull.ts` | `:38`, `:76`, `:114` | 3 |
| `src/cli/sync/push.ts` | `:63`, `:345` | 2 |
| `src/cli/status-cmd.ts` | `:366`, `:388` | 2 |
| `src/cli/doctor-cmd.ts` | `:389` | 1 |
| `src/cli/ignore-cmd.ts` | `:110` | 1 |
| `src/cli/chain-repair.ts` | `:36`, `:67` | 2 |
| `src/cli/daemon/daemon.ts` | `:716` | 1 |
| `src/cli/git-cmd.ts` | dependency-injectable `(deps.loadState ?? loadState)` at `:272`; direct calls at `:621`, `:655`, `:687`, `:730`, `:960`, `:975` | 7 |
| **Total** |  | **19** |

### 3.5 Complete production `loadRawState` read inventory

`loadRawState` does not itself classify a standing reset journal. It is included because it is the raw state/marker read seam design 163 must replace or preserve. Its definition reads active state first and falls back to the incarnation marker at `src/cli/config.ts:384-401`.

| Module | Current call sites |
|---|---|
| `src/cli/config.ts` | `:534`, `:614`, `:632`, `:751`, `:808`, `:961`, `:1013`, `:1099`, `:1133`, `:1158`, `:1173` |
| `src/cli/doctor-cmd.ts` | `:315` |
| `src/cli/setup-keyed.ts` | `:85` |
| `src/cli/setup-cmd.ts` | dependency-selected reader `const readRawState = deps.loadRawState ?? loadRawState` at `:618`; calls at `:664`, `:738` |
| `src/cli/sync-state.ts` | `:544` |
| `src/cli/sync-git/apply.ts` | `:975`, `:1040` |
| `src/cli/sync-git/p-repair-state.ts` | `:72`, `:114`, `:125` |
| `src/cli/sync-git/p-settlement.ts` | `:110`, `:157` |
| `src/cli/track-cmd.ts` | `:50`, `:107` |
| `src/cli/init-cmd.ts` | `:194`, `:378` |

Reset-specific raw reads inside `resetSyncState` are therefore: initial unfenced state at `src/cli/config.ts:1099`; post-standing-recovery state for repository inventory at `:1133`; complete-fence state at `:1158`; and barrier state immediately before mutation/journal preparation at `:1173`. The final byte-exact state reads are at `src/cli/config.ts:1064-1071` and `:1241-1244`.

### 3.6 Ordered state/config/journal read gates inside `resetSyncState`

| Order | Exact current read site | Classification/gate supplied |
|---:|---|---|
| 1 | Initial raw state and config at `src/cli/config.ts:1099-1101` | Derives the unfenced old stream/nonce/revision for side-effect-free witness validation. |
| 2 | Initial pure witness inspection/comparison at `src/cli/config.ts:1102-1113` | Requires the witness's old tuple and next stream to match the initial state/config view. |
| 3 | Standing-journal probe at `src/cli/config.ts:1125-1131`, especially `readResetJournal` at `:1128` | If present, routes through independent journal authorization/classification/recovery before fresh preparation. |
| 4 | Post-recovery raw state at `src/cli/config.ts:1133-1139` | Supplies repository descriptors used to choose the complete repository fence. |
| 5 | Under-fence raw state and fresh config at `src/cli/config.ts:1158-1169` | Re-derives old stream and requires exact equality with the confirmed old lineage. |
| 6 | Barrier raw state and config at `src/cli/config.ts:1172-1180` | Rechecks stream/nonce/revision after the injected barrier and immediately before consent consumption/preparation. |
| 7 | Marker normalization read at `src/cli/config.ts:1182`, implemented at `:858-868` | Requires marker absence or exact semantic agreement with the fenced old state. |
| 8 | Final active-state byte read/parse after protocol-artifact preparation at `src/cli/config.ts:1061-1071` | Requires active state still present with the same stream/nonce; supplies exact bytes and Z inventory to the finish callback. |
| 9 | Byte-exact active-state revalidation immediately before `beginResetJournal` at `src/cli/config.ts:1240-1245` | Requires bytes unchanged and state-lock ownership still held before prepared publication. |
| 10 | Post-publication journal probe at `src/cli/config.ts:1252-1255` | Detects the new standing journal and enters classifier-gated recovery. |

## 4. Consent witness threading: design 137/138 seam

### 4.1 End-to-end threading table

| Stage | Exact current threading point | Bound value/effect |
|---|---|---|
| Opaque capability representation | `src/cli/reset-consent.ts:8-10`; private record/`WeakMap` at `:46-60`; authenticity, expiry, consumed checks at `:97-107` | Object shape or TypeScript cast cannot forge the invocation-local witness. |
| Existing-workspace prior-lineage observation | `src/cli/setup-cmd.ts:663-668` | Reads config/raw state and derives old stream, nonce, revision, plus fully known destination coordinates. |
| Existing-workspace consequence confirmation and mint | Prompt at `src/cli/setup-cmd.ts:672-680`; mint/pass coordinates at `:681-689`; implementation at `src/cli/reset-consent.ts:118-140` | Binds root, old stream/nonce/revision, remote URL, workspace id, project id, and therefore the complete next stream. |
| Existing-workspace handoff to init | `src/cli/setup-cmd.ts:691-698` | Passes witness as `resetConsent` into init. |
| Standard existing-workspace `runInit` bridge | Witness preflight at `src/cli/init-cmd.ts:173`; forwarding into `executeInitPlan` at `:174-180` | Preserves `resetConsent` from setup's ordinary existing-workspace path into the common init executor. |
| Create-new prior-lineage observation | `src/cli/setup-cmd.ts:734-745` | Reads config/raw state before remote creation. |
| Create-new consequence confirmation and Stage-A mint | Prompt at `src/cli/setup-cmd.ts:749-760`; mint at `:761-768`; implementation at `src/cli/reset-consent.ts:143-159` | Binds root, old stream/nonce/revision and remote/project intent; workspace id/next stream do not yet exist. |
| Refusal-before-POST seam | `src/cli/setup-cmd.ts:802-809` calls `preflightInitRebind`; pure preflight is `src/cli/init-cmd.ts:189-220`, witness inspection call at `:203`, inspection implementation at `src/cli/reset-consent.ts:196-205`, and full tuple/intent comparison at `src/cli/init-cmd.ts:206-219` | Direct/scripted or substituted rebind is refused before remote create or local reset writes. In setup create-new, the workspace mutex was already acquired at `src/cli/setup-cmd.ts:771-773`. |
| Create-new Stage-B narrowing | Setup call at `src/cli/setup-cmd.ts:817-824`; helper at `src/cli/reset-consent.ts:167-193` | Helper checks remote/project before POST callback at `:172-184`; the id returned by that callback stamps the same witness at `:190-193`; double narrowing is refused at `:178-181`. |
| Design-137 structured continuation handoff | Setup passes `{workspaceId, syncMutex, resetConsent}` at `src/cli/setup-cmd.ts:836-844`; continuation type at `src/cli/init-cmd.ts:233-237` | Created workspace id and held workspace mutex cross the existing 137 continuation seam together with the narrowed 138 witness. |
| Continuation adoption/recheck/forwarding | `src/cli/init-cmd.ts:260-294`; plan/root/mutex checks and witness preflight at `:269-278`; forwarding at `:279-290`; release at `:292-294` | Preserves all three values through init and transfers mutex ownership exactly once. |
| Actual precreated resource extraction | `adoptPrecreatedWorkspaceResources` at `src/cli/init-cmd.ts:245-253`; called from `executeInitPlan` at `:333-335` | Extracts the precreated `workspaceId` and already-held `syncMutex` from the same continuation that carries `resetConsent`; marks mutex ownership as transferred rather than reacquired. |
| Generic non-continuation create path | `src/cli/init-cmd.ts:335-342` | Also narrows through `createWorkspaceWithConsent` and retains the same witness. |
| Reset decision and primitive call | `src/cli/init-cmd.ts:368-380` | Passes `opts.resetConsent` to `resetSyncState(root,nextStream,syncMutex,...)`. |
| Initial side-effect-free witness inspection | `src/cli/config.ts:1097-1113`, especially `:1105-1110`; implementation `src/cli/reset-consent.ts:208-221` | Checks root, observed old stream/nonce/revision, narrowed next stream, validity/expiry/non-consumption before locking/preparation. |
| Complete-fence lineage recheck | Recovery fence/state lock begins at `src/cli/config.ts:1142-1145`; state/config reread and witness comparison at `:1158-1169`; injected barrier and second reread at `:1172-1179` | Requires the currently fenced lineage to equal the confirmed lineage before any fresh reset preparation mutation. |
| Single-use consumption | Call at `src/cli/config.ts:1184-1197`; implementation at `src/cli/reset-consent.ts:224-240` | Rechecks root/old stream/old nonce/next stream and sets `consumed=true` at `reset-consent.ts:239`. |
| Conversion to durable authorization record | `src/cli/config.ts:1192-1197` | Produces `{version:2,authorizedNextStream,consentKind,mintedAtRevision}`. |
| Authorization passed into journal creation | `src/cli/config.ts:1240-1245` | Passes the record to `beginResetJournal` while the state lock/complete fence remains held. |
| Journal creation validates and embeds witness | Input validation at `src/cli/reset-journal.ts:532-543`; journal construction at `:553-560`; prepared publication at `:586` | The durable prepared journal carries the narrowed authorization. |
| Recovery validates the durable witness | Schema and destination binding at `src/cli/reset-journal.ts:194-204`; eligibility/config-stream gate at `:363-368` | Legacy v1, malformed/mismatched authorization, or caller stream naming neither old nor next halts before recovery writes. |

### 4.2 Seam summary as data flow

| Seam segment | Current value threaded |
|---|---|
| Setup confirmation → witness module | `{root, observedOldStream, observedOldNonce, mintedAtRevision, intent}` |
| Create callback → narrowed witness | Adds concrete `nextStream` derived from the id returned by the verified POST callback |
| Setup → design-137 continuation | `{workspaceId, syncMutex, resetConsent}` |
| Continuation/init → reset primitive | Same `resetConsent`, plus held `syncMutex` and computed `nextStream` |
| Fenced reset primitive → journal | Consumed witness converted to `{version:2, authorizedNextStream, consentKind, mintedAtRevision}` |
| Journal → recovery gate | Embedded authorization must bind `journal.next.stream`; caller config stream must name journal old or next stream |

The concrete 137/138 seam is the precreated-workspace continuation: design 137's created `workspaceId` and already-held `syncMutex` are accompanied by design 138's narrowed `resetConsent`; init preserves all three, the reset primitive consumes the witness only after the complete-fence lineage/barrier recheck, and `beginResetJournal` persists the resulting authorization in the `prepared` journal.
