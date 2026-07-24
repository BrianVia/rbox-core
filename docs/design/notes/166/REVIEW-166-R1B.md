# REVIEW-166-R1B — mechanism fidelity + implementability

Reviewed design v1 against commit
`3c8c9b818fb95ab37278bf08ce2764ead25211dc` and the uncommitted rig
scenario named by the design.

## Verdict: CHANGES-REQUIRED

The forward-adopt objective is sound, and change B is correct *conditional on*
change A producing the claimed settled record. The pull-side mechanism is not
implementable as written, however. The current scenario reaches oracle/index
deferral before the cited `local-commits` seam; the existing checkout path would
rewind the forward checkout if that seam were waived; and the mandatory BASE
composer refuses to advance an unmutated branch without a new typed authority.
The proposed file-plane TOCTOU fallback is also impossible at the stated
pipeline ordering.

## Findings

1. **BLOCKER — the cited `local-commits` hold sites are not the active first
   blocker for the reproduced join, and C leaves both earlier blockers in
   place.** On the current first join, the empty file BASE sends
   `repo/file.txt` through the conflict arm
   (`src/engine/reconcile.ts:53-70`), leaving `repo/b-only.txt` and the conflict
   sibling as extra paths in the repo subtree. `oracleFromPull` derives the
   post-action receipt and still compares it to the remote manifest
   (`src/engine/apply-receipt.ts:715-755`); its pull proof compares receipt and
   remote at `src/engine/apply-receipt.ts:461-508`. The result is `mismatch`,
   hence `local-edits` at `src/cli/sync-git/follow.ts:408-410`. Independently,
   B's ahead index differs from both the absent BASE index and A's incoming
   index, hence `local-index` at `follow.ts:417-431`. Both precede
   `local-commits` in `firstReason` (`follow.ts:384-389`). Therefore
   `followDivergedRepo` returns `status: "defer"` at `follow.ts:1041-1053`, and
   apply uses the defer branch at `src/cli/sync-git/apply.ts:1159-1202`; the
   cited settled branch at `apply.ts:1207-1232` is not reached.

   C removes the conflict action but does not fix this: the derived receipt now
   contains B's newer `file.txt` and `b-only.txt`, while the untouched design-116
   oracle remains A's older remote manifest, so it still reports
   `local-edits`. If that oracle were changed to accept B's receipt, the absent
   BASE versus B-ahead index still reports `local-index`. A forward-adopt path
   must explicitly bypass or redefine the checkout-authorizing oracle/index
   gates because it performs no checkout, rather than changing only the two
   graph hold sites. The design's statement that the post-apply oracle is
   “untouched” is incompatible with its desired result.

2. **BLOCKER — the existing follow path cannot produce “no checkout mutation”
   by reusing the cited witness machinery.** For the current branch, local-ahead
   means `oldOid !== newOid`; after classification passes, follow plans a branch
   transition from B's ahead OID back to A's incoming OID
   (`src/cli/sync-git/follow.ts:1085-1130`), constructs incoming HEAD/index/op
   state (`follow.ts:1133-1219`), and invokes `commitCheckout`
   (`follow.ts:1233-1248`). `commitCheckout` requires either incoming index bytes
   or explicit index absence (`src/engine/git/checkout-txn.ts:519-524`) and later
   publishes that index and incoming operation state
   (`checkout-txn.ts:743-757`). Thus merely admitting a descendant witness would
   rewind the ref and replace B's index—the opposite of A's contract.

   The implementation needs a distinct forward-carry terminal before checkout
   planning, plus a reservation-only boundary primitive (or a specified safe
   extraction of the reservation/second-proof portion of `commitCheckout`). It
   must lock the receiver OID, re-run every repo-wide ancestry predicate, and
   return without publishing refs, HEAD, index, or op-state. The current
   checkout transaction is not a no-op proof API.

3. **BLOCKER — zero `heldRefs` does not let the settled branch advance BASE.**
   On this first join the previous branch BASE is absent and the candidate BASE
   contains A's positive `refs/heads/main`. `proofFor` always supplies
   `pull-ref-transaction` authority (`src/cli/sync-git/apply.ts:1066-1090`). With
   no branch mutation there is no `BranchTransitionWitness`, so
   `composeRepoBase` retains the old value and records
   `missing-branch-proof` (`src/cli/sync-git/base-composer.ts:421-428`). Any hold
   makes the whole family pending (`base-composer.ts:494-515`). Consequently the
   exact settled code requested for review sees
   `composedFollow.disposition === "pending"` and records pending plus an
   `artifact` deferral even when `follow.heldRefs` is empty
   (`src/cli/sync-git/apply.ts:1207-1228`). The same problem occurs in
   `intendedFor` before checkout publication (`apply.ts:1093-1131`).

   A needs a new closed composer authority and locked proof for forward-carry,
   covering each candidate branch's incoming OID, reserved receiver OID, and
   boundary ancestry result. “No hold” is classification, not BASE authority.
   Tests must call `composeRepoBase` with previous BASE absent and prove that the
   new authority alone reaches `terminal`; a `followDivergedRepo` assertion is
   insufficient.

4. **BLOCKER — the claimed TOCTOU fallback cannot occur without changing the
   pipeline.** Pull chooses all file actions at
   `src/cli/sync/pull.ts:164-179` and applies them at `pull.ts:198-209`. The Git
   verdict is not recomputed until `applyGitSections` at `pull.ts:253-267`. If
   the pre-reconcile probe says forward-carry, reconcile emits no conflict
   action. If the later Git proof disagrees, the already-completed file phase
   cannot retroactively create a conflict sibling; Git can only park pending.
   Worse, a subsequent push independently publishes the retained local file
   delta (`src/cli/sync/push.ts:372-404`) while the pending gate carries A's Git
   section (`src/cli/sync-git/plan.ts:618-629`), producing the file/Git split the
   design says it avoids.

   Test 9's “TOCTOU disagreement -> conservative fallback” is therefore not
   implementable under the stated order. Either weaken the fallback contract to
   the actual no-overwrite outcome and specify the resulting state/publication
   rules, or add a pre-file-apply reproof/replan or a later compensating file
   phase. The latter options are design-116 pipeline changes and need to be
   reviewed as such.

5. **MAJOR — the per-ref implementation map is incomplete even after the
   current-branch special case is added.** For a non-current local-ahead branch,
   removing the first hold at `src/cli/sync-git/follow.ts:653-673` is undone by
   the fixed-point no-drop pass: `plannedRefs` still contains the older incoming
   OID, so `noDropProof` at `follow.ts:695-721` reports that the receiver tip
   would be dropped and reinstalls `local-commits`. An equal incoming/local
   branch with no prior BASE also bypasses the cited range and is held by the
   separate “equality cannot invent branch P/A authority” arm at
   `follow.ts:742-790`. Later code would otherwise plan mutations against the
   incoming values.

   Repo-wide forward-carry needs a two-phase ref plan computed before any
   mutation: classify every eligible branch, choose receiver OIDs as the
   no-mutation durable plan, run no-drop against those values, and only then
   publish ordinary non-forward refs or return the all-or-nothing terminal.
   The design must also define whether “ANY effective incoming ref” means every
   effective branch only, what a missing receiver value means, and how
   tags/stash/local-only refs veto the repo. The current “branch-only witness”
   wording and repo-wide quantifier do not define one total predicate.

6. **MAJOR — C grants Git ancestry authority over untracked file-plane paths.**
   `reconcile` operates on every manifest path under the selected subtree, not
   on Git-tracked paths (`src/engine/reconcile.ts:48-75`). The proposed
   “paths INSIDE a repo” override therefore includes colliding untracked files;
   for a root repo it includes the entire workspace. Git branch ancestry proves
   nothing about those bytes. Treating remote as BASE makes an untracked local
   collision “local ahead,” after which B's push replaces A's file-plane value
   without the normal conflict sibling. This is a semantic expansion beyond
   colliding tracked paths and is not covered by the scenario, whose scratch
   file is outside `repo` (`scripts/rig/scenarios/git-join-ahead.ts:78-84`).

   Scope the adopt baseline to a precisely proved tracked-path set (including
   the index/HEAD and nested/root-repo rules), or explicitly justify and test
   subtree-wide last-writer authority. Add a colliding untracked file inside a
   forward-carry repo; it should retain ordinary file-plane conflict semantics
   unless the design intentionally changes that contract.

7. **MAJOR — the promised rig gate and test matrix do not close the mechanism
   gaps.** `git-join-ahead` is registered but is not in `FAST_SUITE`
   (`scripts/rig/scenarios/index.ts:16-41`), so it is not currently a PR gate.
   Its post-join checks assert B's primary contents but do not assert absence of
   `*.conflict.*`, do not run `git status --porcelain`, and do not inspect the
   immediate repo record for no pending/deferral (`git-join-ahead.ts:89-99`).
   The settlement step at `git-join-ahead.ts:117-124` is the first A-push/B-pull
   after publication, not an additional idle cycle. The ahead+diverged and
   behind variants do not exist in the current scenario.

   In addition to the design's listed tests, require: (a) direct BASE-composer
   authority tests from finding 3; (b) byte/identity assertions that forward
   carry leaves HEAD, every ref, index, op-state, reflog, and checkout journal
   untouched; (c) oracle/bypass tests for the local receipt; (d) non-current
   ahead and baseless-equal branches through the no-drop pass; (e) root and
   nested repo path ownership; (f) an inside-repo untracked collision; and (g)
   the real late-disagreement state, after finding 4's contract is decided.

8. **MINOR — several citations exist at the named lines but do not support the
   stated mechanism.** The full audit is below. Most ranges are current, but the
   take-theirs and anti-republish citations need correction, and the
   settled-with-held range is not the active path for this fixture.

## Change B end-to-end trace (conditionally confirmed)

Assume A is repaired to persist exactly: `base = remoteSec`, `pending` absent,
`resolutionKey`/`gitNeedsResolution` absent, apply deferral absent, and partial
null/absent.

1. `planGitSections` sees neither the pending gate
   (`src/cli/sync-git/plan.ts:618-629`) nor the needs-resolution gate
   (`plan.ts:492-504`). `partial` is not a capture-suppression input.
2. The fast carry requires `carryMatrixMatches` (`plan.ts:671-688`). For a dir
   repo, that is exact identity equality with BASE
   (`src/cli/sync-git/shared.ts:68-73`). B's live HEAD/ref/index identity is
   ahead, and identity includes HEAD, `indexTree`, refs, and op-state
   (`src/engine/git/identity.ts:92-99`), so fast carry misses.
3. The slow path repeats the same carry matrix at `plan.ts:568-585`; it also
   misses and appends the repo to `toCapture` at `plan.ts:586-595`. Capture then
   runs at `plan.ts:775-804`. Existing based repos are not admission-capped.
4. `sourceSeq` is not consulted by either capture decision. Push computes the
   file delta against the applied manifest (`src/cli/sync/push.ts:347-390`), and
   the ahead files make the no-op branch at `push.ts:498-540` inapplicable. MDE
   delta selection only chooses encoding when the persisted base sequence is
   coherent (`push.ts:620-633`); it does not suppress the commit. The commit CAS
   parent is the applied sequence (`push.ts:636-640`).

Therefore no `plan.ts` change is needed for B once A genuinely produces the
claimed state. If implementation needs a plan exception, A has not met its
record contract or a new design condition has been introduced.

## Exact pull insertion/plumbing audit for C

The scheduling point exists: after the local scan and E2EE key gate
(`src/cli/sync/pull.ts:114-149`) and immediately before `pathOf`/`reconcile` at
`pull.ts:164-165`. This is before either `applyActions` call and does not by
itself reorder design 116.

At that point a helper can receive `root`, `cfg.syncGit`, the exact
`gitFollowEnabled()` value, `state.lastSyncedManifest`, `remote.gitRepos`, and
the discovered local repo metadata. It must return a typed per-repo snapshot,
not just booleans: effective branch refs, local durable OIDs, selected current
witness, tracked-path scope, ambiguity/shape disposition, and the facts that
must be recomputed at the locked Git boundary. The result then needs three
consumers:

- a per-path BASE resolver (or a synthetic reconcile BASE) at `pull.ts:165`;
- the oracle/no-checkout policy at `pull.ts:242-251`; and
- the Git apply forward-proof path passed at `pull.ts:257-267`, culminating in
  the new BASE-composer authority.

Only adding a probe before `reconcile` is insufficient. `reconcile` currently
accepts one workspace-wide BASE, and `applyGitSections` currently receives no
advisory snapshot or path ownership map. Nested repos also require a declared
precedence rule when a path is inside both a forward parent and a non-forward
child. If this work adds a sync-git module or changes an existing module's
ownership, `docs/CODEMAP.md:54,67-75,179-185` requires the corresponding map
update.

## File:line citation audit

| Design citation | Audit |
|---|---|
| `apply.ts:30-34` | Accurate for `src/cli/sync-git/apply.ts`: no BASE makes any usable local identity diverged. |
| `apply.ts:1207-1222` | Range is accurate for settled composition/pending, but this fixture currently exits through `1159-1202`; zero held refs still leave composer pending per finding 3. |
| `plan.ts:618-629` | Accurate: pending carries the pending section and suppresses capture. |
| `pull.ts:198-267` | Accurate: file actions complete before oracle construction and Git apply. |
| `reconcile.ts:69-70` | Accurate conflict action (with the both-diverged comment beginning at line 68). |
| `git-cmd.ts:740-757` | Accurate: `keep-mine` returns `not-yet-supported`. |
| `git-cmd.ts:767-777` | Inaccurate for shelving/adoption: this range only runs take-theirs artifact preflight. Quarantine/pinning are at `836-842`; manual follow begins at `939-973`. |
| `reachability.ts:106-122` | Accurate: it asks whether `tip` is an ancestor of any root and is fail-closed on indeterminate walks. |
| `follow.ts:453-455` | Accurate current-tip reachability check, but not the earlier oracle/index gates. |
| `follow.ts:653-673` | Accurate first per-ref ownership hold, but not the later no-drop/equality holds. |
| `follow.ts:1298-1317` | Accurate for design 165's exact-equality self-root boundary recheck; it does not perform the new descendant proof. |
| `plan.ts:458-462` | This is a safety comment around the busy gate, not the enforcing anti-republish branch. The actual needs-resolution enforcement is `492-503`. |
| `reconcile.ts:66` | Accurate local-ahead arm. |
| `apply.ts:25-29` | Accurate policy comment for divergence-from-nothing, but unrelated-history non-clobber also depends on the later follow proofs. |
| `follow.ts:695-719` | Accurate no-drop fixed-point/call; it presently re-holds a non-current forward branch rather than having “nothing new to drop.” |
| `follow.test.ts:858` | Accurate current local-ahead-defers test. The prose should not call 165's tests “unmodified” and then say this test is updated. |

## Execution evidence

- PASS: `bun test src/cli/sync-git/follow.test.ts --test-name-pattern 'design 165 local-ahead tip unreachable'` (1 pass).
- PASS: `bun test src/cli/sync-git/git-sync.test.ts --test-name-pattern 'cap: new repos beyond the cap are deferred LOUDLY; base-carrying repos always carry AND still capture'` (1 pass), corroborating the conditional B trace.
- PASS: `bun test src/engine/apply-receipt.test.ts --test-name-pattern 'unignored extras mismatch'` (1 pass), corroborating the oracle blocker.
- `bun run typecheck:rig` is currently blocked by the pre-existing
  `scripts/rig/scenarios/git-shapes.ts:630` possibly-undefined error, not by
  `git-join-ahead.ts`.
- The live rig scenario could not be executed in this environment: `bun run rig
  doctor` reached the DEV health endpoint and resolved secrets (redacted), but
  Docker socket access was denied. No claim of a live scenario run is made.
