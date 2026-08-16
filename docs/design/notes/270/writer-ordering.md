# 270 §7 — artifact-plane writer ordering

Requirement (design 270 §7, r4): every writer of the five rbox artifact
namespaces must land **before** the per-repo held classification, or **inside**
`rebindHeldAttemptsAfterSettlement`'s reach — otherwise a stored held attempt can
carry a digest that no longer describes the plane.

Namespaces (the canonical list is `ARTIFACT_PLANE_PREFIXES`,
`src/cli/sync-git/base-artifact-scan.ts:46`): `refs/rbox-local/base-absent/v2`,
`refs/rbox-local/base-present/v2`, `refs/rbox-local/base-present-keep/v2`,
`refs/rbox-local/base-absent-settled/v1`, `refs/rbox-recovery/base-present/v2`.

Anchors, verified by reading each line:

- classification: `held.recordClassification` at `src/cli/sync-git/apply.ts:1021`
  (the `afterHeldClassification` callback opened at `:1016`).
- rebind: `rebindHeldAttemptsAfterSettlement` at
  `src/cli/sync-git/received-git-transition-commit.ts:395`, the final statement of
  `settleCommittedBranchArtifacts`, after its per-repo settle loop.

Every ref mutation in these namespaces funnels through three executors:
`commitProtocolRefTransaction` (`base-artifacts.ts:515`),
`runUpdateRefTransaction` / `runPreparedUpdateRefTransaction`
(`keep-pins.ts:187`, `:346`), and `commitCheckout` (`checkout-txn.ts:602`) —
plus one raw `update-ref --stdin` in `reset-z-runtime.ts:136-140`.

## Writers and their phase

| # | Writer | Entry point | Phase |
|---|---|---|---|
| W1 | `commitPlannedBranchTransition` (`branch-transition.ts:339`) — A/P/K create, Z retire | `publishObservedRefPlane` (`ref-plane-publication.ts:238`) → `follow.ts` → `apply.ts:987` | BEFORE (`follow.ts` publishes before `classifyCheckout` at `:164`, which precedes both `afterHeldClassification` sites at `:179`/`:246`) |
| W2 | Checkout transaction splice (`checkout-txn.ts:355-380`) | `RefPlaneTransaction.commitCheckout` ← `follow.ts:194` ← `apply.ts:987` | BEFORE (`follow.ts:194` ≪ `:246`) |
| W3 | `settleExactPresentArtifact` (`p-settlement.ts:89`), `runPRepairAttempt` / `resumeAcceptedPRepair` (`p-repair-transaction.ts:376`, `:478`) | `settleStandingBranchProof`, `apply.ts:879` | BEFORE (`apply.ts:879` ≪ `:1021`); the shredder at `apply.ts:835-837` additionally clears the attempt whenever standing P work is present |
| W4 | Clean-materialization branch transitions (`clean-materialization.ts:132`, rollback `:143`) | `materializeCleanGit` ← `apply.ts:1090` | ALTERNATIVE BRANCH — reached only when the follow path already returned, so `recordClassification` never runs for that repo in that cycle; its artifacts are settled by W5 |
| W5 | `settleBaseAbsentArtifact` (`base-artifacts.ts:522`), `settleExactPresentArtifact` (`received-git-transition-commit.ts:382`) | `settleCommittedBranchArtifacts` (`:336`) ← `sync/pull-state-save.ts:108` | INSIDE the rebind reach — the settle loop is `:360-393`, the rebind is `:395` |
| W9-pull | Checkout-journal ref rollback (`journal.ts:962`, lines from `planAtomicRefRollback` `:505`) | `recoverAndLandFollowJournal` ← `apply.ts:379-431` | BEFORE |

W9 is in scope because the journaled `branchInverses` schema explicitly admits
non-primary lines under `refs/rbox-local/` and `refs/rbox-recovery/`
(`journal.ts:375`), and those inverses are exactly the A/P/K deletes built at
`branch-transition.ts:165-168`.

## Writers outside both anchors — what actually covers them

Three entry points mutate the artifact plane outside the pull's classification
and rebind anchors. None of them is a pull, so none of them can be re-ordered
into the anchors; the digest is what covers them.

- **W6 — `rbox git resolve`** (`src/cli/git/resolve-command.ts`): deletes P/K
  (`:470`), runs P-repair (`:494`, `:496`, `:502`), settles A→Z (`:527`), and
  follows with `manualResolution` — which is exactly the path that skips
  `afterHeldClassification` (`follow.ts:203`). Verified directly: the file
  contains **zero** references to `rebindHeldAttemptsAfterSettlement` and **zero**
  references to the held attempt at all, so a stored attempt survives a resolve
  that mutated the plane. This is the sharpest justification for §2.3 in the
  whole design — and it is a pre-existing hole, not one this change opens.
- **W7 — reset preflight** (`prepareResetArtifactsUnderFence`,
  `reset-state.ts:166`, `:205`, `:207`, `:215`, `:244`) and **W8 — reset journal
  recovery** (`reset-z-runtime.ts:136-140`, reached from `reset-journal.ts:477`
  and `state-plane/reset/recovery.ts:325`), plus W9 invoked from
  `reset-state.ts:145`. Reset replaces the whole state stream, so held attempts
  are discarded with it — but that is an indirect argument. **I could not find an
  explicit `clearAttempt` on these paths, and I am recording that rather than
  asserting the invariant holds.** The digest covers them regardless.

## What I could not prove

- I did not trace `resetSyncState` (`reset-state.ts:292`) up to its CLI dispatch
  site, so the "reset discards the attempt with the stream" argument above is
  reasoned from the reset's contract, not from a read call chain.
- The enumeration is of *production* writers. `state-plane/reset/crash-rig-child.ts:81-82`
  writes `base-absent-settled/v1` directly but is a test-only spawned fixture.
- Incidental finding, not owned here: `cleanupPRepairLineage` /
  `cleanupLockedPRepairLineage` (`p-repair-transaction.ts:283`, `:287`) and
  `withPreparedRepairOriginCleanup` (`keep-pins.ts:580`) have no callers anywhere,
  including tests. The Q namespace therefore has no wired GC path — Q refs are
  retired only by `finalLines` eviction (`p-repair-transaction.ts:301`) under
  `MAX_P_REPAIR_Q_PER_LINEAGE`. Per the feature-retirement rule this is a
  deletion *candidate* needing its own evidence, not a deletion.

## Conclusion

Every pull-path writer (W1-W3, W9-on-pull) lands strictly before
`apply.ts:1021`; W5 is the only writer inside the rebind's reach and is anchored
at `received-git-transition-commit.ts:395`; W4 bypasses classification only on a
cycle where no classification is recorded. The design's ordering requirement
holds for the pull path.

The three out-of-band writers (resolve, reset preflight, reset journal recovery)
are **not** reachable by either anchor, which means the artifact-plane digest is
not merely prudent for them — it is the only thing that invalidates a stale
attempt after a manual `rbox git resolve`. That also sets the flag's real cost:
with `RBOX_GIT_HELD_SKIP_COMPOSER=0` the resolve path is unguarded exactly as it
is on `main` today, so the kill switch restores the status quo and nothing worse.
Red-first backstops for the resolve and reset orderings are NOT in this change's
test set; they are named here as the follow-up the §7 requirement implies.
