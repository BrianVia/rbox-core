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
| **P1 — candidate created** (`src/cli/reset-journal.ts:278`, durable helper `:163-170`) | `prepared` | `O` | `N` | absent | `Mpre` | `R0` | `A0` | old: **roll-forward step archive-create** at `:279-280`; next: **complete-retirement from archive-create** |
| **P2 — archive created** (`src/cli/reset-journal.ts:279-280`, durable helper `:163-170`) | `prepared` | `O` | `N` | `O` | `Mpre` | `R0` | `A0` | old: **roll-forward step recovery-ref `E1`**, or ready-phase write if `n=0`; next: **complete-retirement from that step** |
| **P3.k — recovery ref `Ek` updated**, one row for every `1 ≤ k ≤ n` (`src/cli/reset-journal.ts:196-205`, called at `:281`) | `prepared` | `O` | `N` | `O` | `Mpre` | `Rk` | `A0` | old: **roll-forward step recovery-ref `E(k+1)`** if `k<n`, otherwise ready-phase write; next: **complete-retirement from that step** |
| **R0 — ready phase written** (`src/cli/reset-journal.ts:285`, phase write `:235-239`) | `ready` | `O` | `N` | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step candidate→active rename** at `:299-300`; next: **complete-retirement from candidate→active rename** |
| **R1 — candidate→active rename observed with candidate absent** (`src/cli/reset-journal.ts:299-301`) | `ready` | `N` | absent | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step installed-phase write**; next: **complete-retirement from installed-phase write** |
| **R2 — ready candidate re-created or resurrected** (`src/cli/reset-journal.ts:297`, durable helper `:163-170`; cross-parent rename at `:299-300`) | `ready` | `N` | `N` | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step redundant-candidate unlink + candidate-parent fsync**, then installed-phase write; next: **complete-retirement from that unlink** |
| **I0 — installed phase written** (`src/cli/reset-journal.ts:302`, phase write `:235-239`) | `installed` | `N` | absent | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step marker-write after under-fence exact-`N` revalidation**; next: **complete-retirement from marker-write** |
| **I1 — state check/repair completed** (`src/cli/reset-journal.ts:305-310`) | `installed` | `N` | absent | `O` | `Mpre` | `Rn` | `A0` | old: **roll-forward step marker-write** at `:311-316`; next: **complete-retirement from marker-write** |
| **I2 — marker written** (`src/cli/reset-journal.ts:311-316`) | `installed` | `N` | absent | `O` | `MN` | `Rn` | `A0` | old: **roll-forward step retire group `D1`**, or z-retired phase write if `m=0`; next: **complete-retirement from that step** |
| **I3.g — common-directory group `Dg` retired**, one row for every `1 ≤ g ≤ m` (`src/cli/reset-journal.ts:208-219`, called at `:321`) | `installed` | `N` | absent | `O` | `MN` | `Rn` | `Ag` | old: **roll-forward step retire group `D(g+1)`** if `g<m`, otherwise z-retired phase write; next: **complete-retirement from that step** |
| **Z0 — z-retired phase written** (`src/cli/reset-journal.ts:322`, phase write `:235-239`) | `z-retired` | `N` | absent | `O` | `MN` | `Rn` | `Am` | old: **roll-forward step journal unlink/fsync + candidate cleanup**; next: **complete-retirement from that cleanup** (`:325-335`) |

`I0` and `I1` are intentionally observationally identical and prescribe the
same next mutation.  On every allowed internally produced signature, the
conditional write at `src/cli/reset-journal.ts:305-310` is a no-op because state
is already `N`.  An actual repair write requires an unlisted precursor
(`absent`, `O`, or `other` active state while phase is `installed`); its recovery
action is `n/a`/halt.  The classifier must not admit that precursor merely to
make the old repair branch reachable.  The duplicate row records the requested
program boundary without widening the allow set or making action selection
ambiguous.

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
   recovery.  Hardened recovery must match `R2`, durably unlink the redundant
   candidate, and continue retirement, not quarantine/delete its own journal.
2. **Archive/ref idempotence needs an initiation invariant.**
   `expectedAbsentOrExact` accepts a pre-existing exact archive (`:163-170,
   :279-280`), and `createRecoveryRefs` skips any pre-existing exact recovery
   ref (`:201-204`).  Quarantine intentionally preserves deterministic recovery
   refs and the canonical archive.  A later journal can therefore begin with an
   exact archive while candidate is absent, or with an arbitrary bitmap of
   exact recovery refs.  F1c explicitly makes prepared
   archive-present/candidate-absent illegal and requires prefix semantics, so v2
   initiation using this table must refuse before journal publication unless it
   establishes the exact P0 baseline: archive absent and `R0`.  If ratification
   instead preserves shared artifacts by authenticating an initial
   archive/ref bitmap in journal v2, this table must first be regenerated with
   rows parameterized by that baseline; the present `Rk` table must not be
   called exhaustive under that alternative.
3. **Marker absence is legal, but CAS publication/removal is not one durable
   transaction.**  CAS publishes state at `src/cli/config.ts:563-565` and then
   removes the marker at `:567` without a parent-directory fsync.  A crash can
   leave a stale marker that is `other` relative to the later journal's old
   state.  Reset initiation must normalize or refuse that marker before journal
   publication; this table must not bless stale-marker `other`.
4. **The rename does not sync both parents.**  Candidate and active have
   different parent directories, while `src/cli/reset-journal.ts:299-300` fsyncs
   only the active-state parent.  A power loss may resurrect the candidate
   source entry.  A reboot before the next phase write produces `R2`; a reboot
   after later phase/marker/ref writes can instead produce an otherwise valid
   `installed` or `z-retired` signature with candidate `N`, which is deliberately
   absent from the table and therefore halts.  The implementation must fsync
   both parents before publishing `installed` to make source absence durable;
   `R2` recovery must use unlink plus candidate-parent fsync rather than another
   rename, because two names may resolve to the same inode.
