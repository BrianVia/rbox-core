# Design 200 v5 — Codex round 4 alignment review

Date: 2026-07-24

Verdict: **NOT-ALIGNED**

## Per-finding disposition

- **NOT-CLOSED — R5 / complete P4 cut.** The implementation mechanism, persisted field,
  switch, cost, and wire-content change are gone, but §9.6 still mandates that a tolerated
  `pending` section “names only held refs.” Current apply stores the whole `remoteSec`
  (`apply.ts:1447-1449`); satisfying that assertion requires the per-ref partition R5 cut.
- **CLOSED — R5 / landing order.** §11 now has exactly P2 + reporting → P3 → P1 + P1b
  (including their safety prerequisites), with no fourth step.
- **CLOSED — R5 / superseded-shape record.** §4.4 accurately records why hybrid BASE,
  BASE-follows-published, and mutual exclusivity each failed, including the distinct code
  invariant that killed each.
- **CLOSED (moot by cut) — round-3 B1, P4 self-echo.** No surviving publishing mechanism
  emits the merged section whose captured partition self-echoed.
- **NOT-CLOSED — round-3 B2, retire→publish crash completion.** A″ has both a false negative
  and an ABA false positive; `record.advertised` cannot prove who authored the current remote
  `R = X`.
- **NOT-CLOSED — P1's claimed existing tombstone path.** When BASE X came from `pull-p` but
  `advertised` never contained X, the normalizer has no authority from which to author the
  promised tombstone at X.
- **CLOSED (moot by cut) — round-3 B3, old-reader operational compatibility.** Design 200
  no longer moves a current bundle into a historical link.
- **CLOSED (moot by cut) — round-3 B4, uncovered BASE prerequisites.** No merged chain is
  composed.
- **CLOSED (moot by cut) — round-3 B5, `MAX_PACK_CHAIN` exhaustion.** No P4 self-echo chain
  grows.
- **CLOSED (moot by cut) — round-3 B6, invalid receipted pending HEAD.** Design 200 no
  longer removes selected refs from a composed section.
- **NOT-CLOSED — round-3 M1, settled-Z receipt projection.** The Z data projection is valid
  and implementable, but the push-side producer is unspecified: `plan.ts:781` calls the
  pre-probe where no `FollowerBranchProtocol` or receipt projection exists.
- **NOT-CLOSED — round-3 M2, A′ locked-proof lifetime.** The cited protocol preparation
  holds no lock, the state-CAS lock-request filter at `apply.ts:1847` still excludes
  `local-absence`, and the terminal body does not revalidate a Z receipt.
- **CLOSED — round-3 M3, `gitStatus` fault contract.** `exit: number | null` plus the exact
  `cause` can preserve every current `gitRaw` caller's returned stdout and thrown object;
  the strict reader's load-bearing test is `exit === 1`.
- **NOT-CLOSED narrowly — round-3 M4, partition claimed wholly moot.** No live mechanism
  partitions refs, but §9.6 reintroduces that requirement in a mandatory rig assertion.
- **CLOSED (moot by cut) — round-3 M5, carried-authorship reverse migration.** There is no
  `advertisedCarried` field or reverse migration.
- **CLOSED — A′/A″ predicate disjointness.** A′ requires serialized BASE positive and A″
  requires it absent; those predicates cannot both hold for one ref.
- **NOT-CLOSED — A′/A″ complete-coverage claim.** BASE absent + receipt X + local absence +
  `advertised[R] !== X` is an uncovered retire→publish state.
- **NOT-CLOSED — nine-row double-crash matrix.** Rows 5 and 9 omit an intervening same-X
  writer; the retry can be a newer destructive publication, not a no-op or delay.
- **CLOSED — `gitRaw` caller compatibility.** Production callers either consume stdout,
  propagate/catch the error, or inspect its existing `code`; throwing the carried cause
  preserves all of those observations.
- **CLOSED — strict-reader predicate and fourth strict site.** The exact predicate is
  `exit === 1 && stderr.trim() === ""`, and `apply.ts:1903` is correctly mandatory because
  failed `readAllRefs` makes `null === null`.
- **CLOSED — correction that `local-absence` does not settle A→Z.** The code filters
  settlement to `pull-ref-transaction`/`journal-recovery` (`apply.ts:1945,1957`).
- **NOT-CLOSED — design 201 acceptance criteria.** “Everything clears at worktree deletion
  through P1/P1b” is false: removing a worktree changes no ref; P1/P1b require the branch
  also to be deleted.

## New findings

### BLOCKER 1 — `advertised[R] === X` is neither necessary nor sufficient for an owed omission

`RepoRecord.advertised` is documented as the “exact last acknowledged wire checkpoint”
(`sync-state-model.ts:290`). It is not a per-writer lease on the current remote value.
Conjunct 4 therefore fails in both directions.

**False negative.** Device A pulls `R = X` from B, so A has positive BASE with a usable
`pull-p` origin, but A has never completed a publication containing X; its
`record.advertised` is absent or names an older value. A deletes X, writes the receipt,
retires BASE, and crashes before the first omitting push. The remote still contains B's
pre-deletion X, but conjunct 4 is false. On the next pull `follower-protocol.ts:88/106`
removes logical BASE, the ordinary `null → X` creation passes
`branch-transition.ts:105`, and `:136-152` destroys the receipt. This is exactly the
round-3 inversion, merely with another writer as the source of X.

**False positive / ABA.** Use matrix row 5: A's omission is accepted, then A crashes before
the advertised-state CAS, leaving durable `advertised[R] = X`. B subsequently re-creates
the same X and publishes it. A now pulls a causally newer X, but all four owed conjuncts
still hold, because the predicate ignores incoming identity and order. A suppresses B and
re-publishes the omission. That retry is not a wire no-op: it is newer than B's creation
and authors/carries the X tombstone (`publisher-tombstones.ts:108-122`). B's live and BASE
X then satisfy exact tombstone attestation (`tombstone-attestation.ts:91-110`) and are
pruned. A legitimate post-deletion recreation is lost.

The design needs durable omission intent independent of prior local advertisement, plus an
acknowledgement/causality rule that distinguishes “my omission is still unacknowledged” from
“a later writer re-created the same OID.” The four current conjuncts cannot do both.

### BLOCKER 2 — a pulled-but-never-advertised X produces no deletion tombstone

The false-negative state above exposes a second independent use of `advertised`. P1 says
that after BASE retirement, `normalizePublishedGitSection` authors the X tombstone it “already
knows.” The code authors new tombstones only by iterating `advertised.refs`
(`publisher-tombstones.ts:108-122`). `pendingRetention` contributes existing tombstone chains;
its positive refs are not deletion authority.

Therefore, if A pulled X from B and obtained a `pull-p` BASE origin but never completed an
acknowledged push containing X, a same-cycle capture after local deletion emits an omission
without an X tombstone. A v1.6.8+ follower at live/BASE X then has no attested deletion and
holds instead of pruning, contradicting §3.0's convergence semantic. A crash after pull state
save and before its push makes this state ordinary, so pull-then-push scheduling is not a
proof that `advertised` contains X. The receipt/positive origin must feed an explicit,
exact-value tombstone-authorship authority, or the design must prove and enforce a stronger
precondition before P1 can capture.

### BLOCKER 3 — A′'s claimed continuous lock does not exist, and Z is not revalidated

§3.6a says `prepareFollowerBranchProtocol` establishes repository protocol locks held through
the state CAS. It does not: `follower-protocol.ts:61-71` reads identity, lineage, A/P/K, and Z;
`scanBaseArtifacts` itself is not wrapped in a continuous operation lock.

The actual bridge is `withRevalidatedGitPartialApplies`, and it has two independent omissions:

1. The lock-request construction at `apply.ts:1847` accepts only
   `pull-ref-transaction`/`journal-recovery`. v5 changes only the second filter at `:1900`.
   A `local-absence` proof therefore does not necessarily acquire either `R.lock` or the
   receipt ref's lock through the CAS.
2. The terminal body at `apply.ts:1910-1917` re-reads only `source === "a"`. A′ explicitly
   admits settled Z, but no code revalidates the Z ledger target and exact leaf under lock.

Adding `local-absence` only to `:1900` leaves a ref-creation race after the strict read and a
receipt-removal/replacement race for both A and Z. Specify state-CAS requests for both the
physical branch ref and the exact A/Z receipt ref, revalidate the corresponding target (and
Z leaf) while those locks are held, then retain them through the CAS.

### BLOCKER 4 — the kill switch disables the recovery that existing receipts require

The §11 table says `RBOX_GIT_ABSENCE_CAPTURE=0` disables P1, P1b, A′, and A″. The next
paragraph says the opposite safety rule: the switch is stop-authoring only, and an existing
receipt must remain carried rather than become open to re-creation.

The table's literal behavior is unsafe. With BASE absent, A/Z(X), local R absent, and remote
X, disabling A″ lets protocol preparation delete logical BASE and the ordinary creation path
retire the receipt while creating X. P1b being disabled does not protect the pull lane.
Rollback must leave A′/A″ receipt recovery/suppression active; only new receipt authorship may
be disabled.

### BLOCKER 5 — §9.6 retains a P4-only per-ref pending assertion

The proposed relaxed rig gate says a carried pending section is tolerated but must “name only
held refs (it must not carry refs that applied cleanly).” Current state deliberately stores
the whole incoming section in `pending[rel]` and records the per-ref split separately in
`partial.appliedRefs`/`partial.heldRefs` (`apply.ts:1435-1449`).

Shrinking `pending.refs` to held refs would change its section identity, partition a section,
and require bundle/HEAD/non-ref semantics—the P4 problem. Relax this to permit the unchanged
whole pending section, and inspect `partial` if the rig needs to prove which refs applied.

### MAJOR 1 — the push-side receipt projection has no specified producer

The Z loop can populate `absenceWitnesses` correctly from its existing payload and
`entryOids`; that part is sound. But the proposed projection lives on
`FollowerBranchProtocol`, which is constructed in the pull/apply path. The push planner calls
`pendingSupersessionPreProbe(root, rel, pend)` at `plan.ts:781`, before it has any such
protocol object. The final proof has the same issue.

Specify one current-lineage A/Z reader usable by the push planner, its repository/lineage
binding and failure behavior, and pass the same immutable result to both the pre-probe and
final proof. Merely adding a fourth parameter leaves its caller with no value to pass.

### MAJOR 2 — design 201's deletion gate does not match design 200

Design 201 says worktree deletion clears through P1/P1b. Design 200 is more precise:
“Once the worktree goes **and the branch is deleted**” (§4.2), and its fixture explicitly
notes that `git worktree remove` changes no ref (§9.1). If the ref remains, ordinary ownership
follow clears the hold; P1/P1b do not run. Amend the AC so 201 does not promise absence capture
for a present branch.

### MINOR 1 — the A→Z rationale contradicts the corrected settlement behavior

§3.2a and §11 say A″ needs Z because suppression “must survive A→Z compaction,” while
§3.6a and §13.3 correctly say `local-absence` A does not compact. Z is still needed for
ordinary pull-settled receipts and P1b; state that reason instead of repeating the corrected
false compaction story without qualification.

### MINOR 2 — the `gitStatus` text has three completeness nits

- The strict-reader bullet still says `code === 1`; `GitRunResult` has `exit`, and the later
  exact predicate correctly uses `exit === 1`.
- “All four failure shapes” omits observer throws, stdin temp setup/open/write/close/remove
  failures, non-EPIPE stdin errors, and `onStdoutChunk` callback failures in
  `shared.ts:145-229`. The never-rejects contract is implementable only if `gitStatus` catches
  outside the entire legacy operation, including `finally`; add that sentence and at least a
  cleanup/callback test.
- `readLocalGitConfigEntries` is not the only existing `error.code === 1` consumer:
  `parseConfigSnapshot` has the same idiom at `config-txn.ts:203-216`. Exact carried cause
  keeps it behavior-compatible, but the prose should either migrate it too or stop claiming
  the second idiom is eliminated.

### MINOR 3 — design 201's held-ref AC is permissive about the local divergent value

“The held ref itself waits” is followed only by “not published at a value this device does
not hold” and “not superseded.” Literally that permits publishing this device's local
divergent held value. State whether the held incoming transition remains pending and no
replacement is authored while held; otherwise the AC does not uniquely express the ruled
waiting semantic.

## Shortest remaining list

1. Replace A″'s `advertised` heuristic with durable omission intent plus acknowledgement
   causality that covers non-local prior advertisements and same-OID ABA, and give P1 exact
   receipt-backed tombstone authorship when X was never locally advertised.
2. Connect `local-absence` A/Z proofs to exact branch + receipt state-CAS locks and strict
   under-lock terminal revalidation.
3. Make the kill switch stop new receipt authorship only; never disable recovery of receipts
   already on disk.
4. Remove the last P4 partition requirement from §9.6 and correct design 201's deletion AC.

**NOT-ALIGNED.**
