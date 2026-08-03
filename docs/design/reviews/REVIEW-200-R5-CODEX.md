# Design 200 v6 — Codex round 5 alignment review

Date: 2026-07-24

Verdict: **NOT-ALIGNED**

## Per-finding disposition

- **NOT-CLOSED — B1 / durable omission intent.** The record and sequence/identity policy fix
  v5's bad `advertised` inference, including its same-OID ABA, but v6 does not specify the
  pre-apply reconciliation lane required by an armed attempt; copying keep-mine's existing
  reconcile ordering resurrects `R` after a pre-POST crash.
- **CLOSED — B2 / exact-value tombstone authorship.** The fourth normalizer authority is bound
  to a current-lineage receipt's exact `priorOid`, candidate omission, all-ref scope, and
  `refs/heads/*`, with `(ref, oid)` deduplication; §3.3 rule 9 and invariant 10 close the
  unpublishable-scoped-receipt case. A tombstone at `X` cannot prune a peer at a different `Y`
  because receiver attestation requires live and logical BASE to equal the tombstoned OID.
- **NOT-CLOSED — B3 / A′ lock lifetime.** v6 names the right bracket, filters, two lock paths,
  strict read, and Z-leaf revalidation, but the bracket does not require successful acquisition:
  current blocked-lock handling clears only `outcome.partial` and still consumes the
  `local-absence` BASE proof and saves.
- **CLOSED — B4 / kill switch.** §11 consistently gates new capture only and keeps A′, A″,
  intent reconciliation, tombstone authorship, P1b, BASE composition, and strict reads live;
  both unsafe interpretations are stated.
- **CLOSED — B5 / P4-only pending assertion.** §9.6 now permits the unchanged whole pending
  section, inspects `partial` for the per-ref split, and explicitly rejects shrinking
  `pending.refs` as re-entering P4.

## New findings

### BLOCKER 1 — an armed omission needs reconcile-before-apply, unlike keep-mine

The arm itself is sound. `beforeCommitSend` really is the last client-side boundary before the
POST (`remote/api.ts:109-111`; `e2ee-remote.ts:810-813`), and the keep-mine implementation
durably installs its receipt there with no subsequent failure-capable client work
(`push.ts:784-818`). The sequence split in §3.2b is also sound:

- head sequence below the attempt means the POST did not land;
- the attempted section identity at the head means the omission is wire truth;
- a later different head cannot distinguish rejection from acceptance followed by
  supersession.

The analogy stops at reconciliation. Keep-mine deliberately calls `applyPulledManifest` while
the receipt is still installed and only clears the receipt afterwards
(`pull.ts:174-199`, especially `:190-198`). That is safe for keep-mine because its pending and
resolution lanes retain the disputed incoming state. It is unsafe for an absence omission:
§3.6a defines an armed intent as **not owed** (conjunct 4 requires no `attempt`).

Concrete pre-POST crash:

1. A has `A(X)`, BASE omits `R`, live `R` is absent, and unarmed intent `{X}`.
2. The push arms attempt `s`, then the process dies before the POST. The server remains at
   sequence `s - 1` and still asserts `R = X`.
3. The next pull must classify `S < s`, durably disarm to `{X}`, and only then run apply so A″
   suppresses the stale `X`.
4. If it copies `reconcileResolutionReceipt`, apply runs first against the armed intent. A″ is
   false, `logicalBaseRefs[R]` is absent, the ordinary `null → X` creation passes, and its
   transaction retires the receipt. Disarming afterwards is too late.

v6 says only “at the next pull” (§3.2b:936-944) and asserts the matrix outcome; it does not place
the reconciliation CAS before `applyPulledManifest`, say that apply receives the returned
post-reconciliation state, or define push-only reconciliation. This must be a distinct
reconciler even if it shares the hook and comparison primitive: classify the authenticated head,
conditionally disarm/consume under the repo-generation CAS, then apply that same head from the
installed state. A failed reconciliation save must leave the intent armed and must not apply.

The requested undecidable counterexample is real and is already disclosed adequately:
A's POST lands at `s`, A loses the ACK CAS, and B publishes a different section at `s + 1`
before A reconciles. The head is later and different, so A consumes an intent whose omission
really did land; its deletion is forgotten. §3.2b:944-950 and §13.4 item 7 explicitly name both
“rejected” and “accepted then superseded,” choose the file-history failure direction, and state
that the deletion may be lost. No additional finding is needed for that policy choice.

### BLOCKER 2 — first-seen incoming `Y` bypasses P1b and is overwritten

The receipt-backed tombstone itself cannot regress a different OID, but step C can discard the
section that carries that OID before P1b ever sees it.

Concrete no-crash state:

1. A has positive BASE/local `R = X`, no `pending`, and deletes local `R`.
2. Before A pulls, B advances and publishes `R = Y`.
3. A's new pre-shortcut step A sees BASE `X` plus local absence, writes `A(X)`, retires BASE,
   and mints intent `{X}`. Step C returns `reconciled` while explicitly leaving `pending`
   untouched (§3.6a:1676-1679).
4. Current apply initializes `pending` solely from the already-persisted pending map
   (`apply.ts:320-327`) and only later binds `remoteSec` and `pend` separately
   (`:558-560`). Therefore the first-seen section containing `Y` is not retained.
5. The pull state save advances to B's global sequence, but the repo now has BASE without `R`
   and no pending section. The same cycle's push has no P1b input, captures an omission, authors
   only the exact `X` tombstone, and commits over B's `Y`.

This is the exact mismatch §3.2 says must carry, but the equality check is reachable only for an
already-persisted `pending.refs[R]`. Matrix row 8's claim that `Y` applies “on the next cycle” is
false: after A's accepted omission, the server no longer carries `Y`; it returns only if B later
republishes it. The same hole exists when A′ completes after B advanced to `Y`, and when A″
suppresses the first pull of `Y`.

On every early `reconciled` return, retain the complete effective incoming section as ordinary
whole-section pending (unless it is already the acknowledged omission), or add an equivalent
pre-capture/current-incoming binding. Then P1b's exact `priorOid === pending.refs[R]` rule can do
the job v6 assigns it. This is not P4: it preserves the section byte-for-byte.

### BLOCKER 3 — a requested A′ lock can be blocked and the BASE CAS still runs

v6 correctly identifies `withRevalidatedGitPartialApplies` as the only bracket spanning
under-lock observation through state save and correctly requires both
`${witness.ref}.lock` and `${witness.artifactRef}.lock`. It misses the bracket's blocked-lock
semantics.

`acquirePreparedStateCasLocks` returns acquired and blocked locks separately. The caller handles
each blocked path only by setting `outcome.partial[rel] = null`
(`apply.ts:1878-1896`). It does not remove/refuse `outcome.repoProofs[rel]`, and the proof loop
still runs (`:1898-1920`) before `save()` runs at `:1922`. A terminal read can therefore pass
while another Git process owns the branch or artifact lock, after which that process can change
the ref/artifact across the state CAS.

For `local-absence`, failure to acquire **either** required lock must throw or otherwise remove
the retirement and its intent mint from the packet. A request plus a proof in the recovery
journal is not evidence that the live process held the lock.

### MAJOR 1 — the raw packet can carry the field, but the normal state-source lane cannot

The new field is representable at the lowest layer: `StateSavePacket.repos[].newRecord` is a full
`RepoRecordInput` (`sync-state-model.ts:315-332`), so adding `absenceOmission` to `RepoRecord`
makes a direct packet capable of atomically carrying BASE retirement plus mint. The
`beforeCommitSend` direct-packet pattern demonstrates that shape (`push.ts:799-814`).

The apply and ACK saves do not normally build direct records. They use `StateSource.values`,
whose closed `RepoStateValues` projection has no omission lane (`sync-state.ts:53-81`), and
`sourceRecord` reconstructs records by enumerating those lanes (`:206-257`). Merely adding the
field to `RepoRecord` therefore does not make mint/consume/discard survive this path. The ACK
currently enters through `ackValues` and `saveStateSource` (`push.ts:945-1005`), exactly where
v6 says consumption must share the `advertised` CAS.

Specify an `absenceOmission` per-repository/per-ref transition lane in `RepoStateValues`,
`GitPullOutcome`, `observedRepoKeys`, apply save values, and ACK values. Its CAS-recompute merge
must implement the stated predicates rather than replace the whole map: arm only the observed
unarmed `(ref, priorOid)`, consume only the matching attempted section key, disarm only the
matching `(key, sequence)`, and discard only with the matching receipt retirement. Otherwise a
repo-generation retry can erase a concurrently minted ref intent or clear a newer attempt.

This is plumbing rather than a flaw in the proposed record, so it is major rather than a fourth
blocker; the same-CAS claim is expressible once this lane is pinned.

## Verified closures and residuals

- The rejected tombstone-chain shortcut is accurately evidenced: normalization merges only
  `advertised`, `pendingRetention`, and `candidate`, and takes their maximum generation
  (`publisher-tombstones.ts:65-86`); a peer's applied section is not a source.
- The rejected section-identity shortcut is accurately evidenced:
  `gitIncomingKey` hashes section content, including refs and tombstones, not server order
  (`shared.ts:86-99`), so identical content can reproduce the key.
- The exact receipt tombstone cannot directly prune a superseding `Y`: receiver authorization
  requires both live and logical BASE to equal the tombstoned OID
  (`tombstone-attestation.ts:91-110`). The regression is the missing retention of the whole
  incoming `Y` section identified above, not the fourth normalizer input.
- §3.3 rule 9 rejects capture before a scoped omission can create a forever-owed intent, and
  §7 invariant 10 pins the corresponding authorship boundary.
- §11's stop-authoring-only table is internally consistent and covers all eight named read
  sites. Its rollback direction is safe.
- §9.6 no longer contains a per-ref pending partition requirement.

## Shortest remaining list

1. Define omission reconciliation as a CAS **before** applying the authenticated head, with
   apply continuing from the installed state; cover pull and push-only entry points.
2. Preserve a first-seen effective incoming section on every A/A′/A″ early reconciliation so
   P1b can carry a mismatching `Y`.
3. Make any blocked branch or receipt lock refuse the `local-absence` BASE proof and state save.
4. Pin the conditional `absenceOmission` state-source lane used by mint, arm, ACK consume,
   disarm, and receipt retirement.

**NOT-ALIGNED.**
