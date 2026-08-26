## Verdict

Root cause: the standing P is local repository protocol state, not state-row or wire state. Resetting/re-adopting the record leaves `refs/rbox-local/base-present/v2/*` and its K pin untouched. Manual take-theirs then misroutes design 271’s typed “first BASE landing” condition into a hard preflight refusal.

Do not ship option (a) as a raw skip, and do not make P settlement synthesize an entire BASE as in (b). The smallest safe fix is (c): let manual resolution consume an exact, matching CREATE-shaped standing P as its existing design-285 `artifact` decision, reserve R/P/K through checkout, and let the existing post-landing settlement retire it once BASE exists.

## 1. Where `presentArtifacts` comes from

`prepareFollowerBranchProtocol` derives the current repository binding, then calls `scanBaseArtifacts(repoDir, binding)`; `presentArtifacts` is populated directly from `scan.present` at [follower-protocol.ts:55](/home/via/Development/Personal/rbox-core/src/cli/sync-git/follower-protocol.ts:55), [follower-protocol.ts:62](/home/via/Development/Personal/rbox-core/src/cli/sync-git/follower-protocol.ts:62), and [follower-protocol.ts:138](/home/via/Development/Personal/rbox-core/src/cli/sync-git/follower-protocol.ts:138).

The scan runs `git for-each-ref` over the local common ref store’s A/P/K namespaces, including `refs/rbox-local/base-present/v2` and `base-present-keep/v2`; it decodes the P blob and validates exact K pins at [base-artifact-scan.ts:46](/home/via/Development/Personal/rbox-core/src/cli/sync-git/base-artifact-scan.ts:46), [base-artifact-scan.ts:68](/home/via/Development/Personal/rbox-core/src/cli/sync-git/base-artifact-scan.ts:68), and [base-artifact-scan.ts:96](/home/via/Development/Personal/rbox-core/src/cli/sync-git/base-artifact-scan.ts:96).

Therefore:

- P/K come from this device’s local `.git`/common-dir protocol refs.
- R is observed separately as the live branch ref; it is not the source of `presentArtifacts`.
- Incoming `refTombstones` only contribute `pendingEvidence` and attestations after the artifact scan at [follower-protocol.ts:110](/home/via/Development/Personal/rbox-core/src/cli/sync-git/follower-protocol.ts:110).
- Neither the incoming bundle nor pending wire attestations contain the P.

If a deleted/re-adopted row still sees the P as `valid-owning`, the physical ref survived and its lineage/repository binding still matches; foreign lineage refs are classified separately at [base-artifact-scan.ts:78](/home/via/Development/Personal/rbox-core/src/cli/sync-git/base-artifact-scan.ts:78).

### Who minted it?

The receiving/follower device did. A branch transition from physically absent to present calls `prepareBasePresentArtifact(... priorOid:null ...)`, then atomically creates P, K-next, and R at [branch-transition.ts:176](/home/via/Development/Personal/rbox-core/src/cli/sync-git/branch-transition.ts:176), [branch-transition.ts:199](/home/via/Development/Personal/rbox-core/src/cli/sync-git/branch-transition.ts:199), and [branch-transition.ts:207](/home/via/Development/Personal/rbox-core/src/cli/sync-git/branch-transition.ts:207). Manual transitions have the same CREATE shape at [branch-transition.ts:285](/home/via/Development/Personal/rbox-core/src/cli/sync-git/branch-transition.ts:285).

It can stand for weeks because design 271 deliberately leaves a CREATE P standing after first-BASE landing; it is retired only by a later routed follow/settlement. Quiescent repositories do not automatically route through follow—the current gate requires divergence, reproof, forced refs, or `remoteChanged && baseSec` at [apply.ts:784](/home/via/Development/Personal/rbox-core/src/cli/sync-git/apply.ts:784). Deleting a state row does not delete local Git protocol refs.

## 2. Does manual LANDING compose it correctly?

There are two different answers.

The pure composer: yes. Given:

- previous BASE member absent;
- incoming member `N`;
- manual `artifact` decision with `beforeBaseOid:null`;
- P witness with `priorOid:null`, `nextOid:N`;
- exact locked proof;

the manual artifact arm accepts it at [base-composer.ts:465](/home/via/Development/Personal/rbox-core/src/cli/sync-git/base-composer.ts:465) and [base-composer.ts:487](/home/via/Development/Personal/rbox-core/src/cli/sync-git/base-composer.ts:487). I directly exercised that shape: it returned `terminal`, installed N, and minted `pull-p` provenance. The existing pure composer suite also passes: 14/14.

The current end-to-end manual path: no. It never supplies the standing P as that artifact decision:

1. Resolve preflight selects `presentArtifacts[0]` and calls exact settlement at [resolve-artifacts.ts:77](/home/via/Development/Personal/rbox-core/src/cli/git/resolve-artifacts.ts:77).
2. The BASE-less CREATE guard returns `base-absent` at [p-settlement.ts:84](/home/via/Development/Personal/rbox-core/src/cli/sync-git/p-settlement.ts:84).
3. Preflight maps every hold directly to refusal at [resolve-artifacts.ts:120](/home/via/Development/Personal/rbox-core/src/cli/git/resolve-artifacts.ts:120).
4. Consequently, `runTakeTheirsResolve` never receives progress containing the standing P witness.

The guard comment’s “landing composition treats both shapes identically” describes automatic pull’s typed `landing` result at [standing-branch-proof.ts:175](/home/via/Development/Personal/rbox-core/src/cli/sync-git/standing-branch-proof.ts:175), followed by observed-landing authority at [follow-repo-transition.ts:145](/home/via/Development/Personal/rbox-core/src/cli/sync-git/follow-repo-transition.ts:145). Manual resolution does not use that observed-landing route; it must construct a complete design-285 proof before journal creation.

A raw preflight skip is also incomplete:

- A matching side-branch P makes `artifactsClear` false, preventing the manual terminal at [ref-plane-publication.ts:107](/home/via/Development/Personal/rbox-core/src/cli/sync-git/ref-plane-publication.ts:107) and [ref-plane-publication.ts:131](/home/via/Development/Personal/rbox-core/src/cli/sync-git/ref-plane-publication.ts:131).
- A matching current-ref P can fall through the no-P terminal at [ref-plane-transaction.ts:248](/home/via/Development/Personal/rbox-core/src/cli/sync-git/ref-plane-transaction.ts:248), but `resolve-take-theirs` would then claim `artifactsClear:true` at [resolve-take-theirs.ts:163](/home/via/Development/Personal/rbox-core/src/cli/git/resolve-take-theirs.ts:163) despite the P still standing.
- If the new incoming OID differs from `P.nextOid`, planning another P targets the same branch-hashed P ref and collides rather than healing.

## 3. Options

| Option | Repositories healed | Invariant risk |
|---|---|---|
| **(a) Raw preflight skip** | At best, BASE-less repos where the P is on the current branch and already matches incoming. Matching side-branch Ps still lack a decision; differing incoming still collides. | Violates “no snapshot while unreserved exact P authority stands” from [resolve-artifacts.ts:1](/home/via/Development/Personal/rbox-core/src/cli/git/resolve-artifacts.ts:1), and can falsely assert `artifactsClear`. P/K are not included in the resolve snapshot because `readAllRefs` filters internal refs at [refs.ts:22](/home/via/Development/Personal/rbox-core/src/cli/sync-git/refs.ts:22). Reject. |
| **(b) Settle into absent BASE** | An existing BASE family with only this member absent is already supported: null matches `priorOid:null`, and settlement adds the member at [p-settlement.ts:87](/home/via/Development/Personal/rbox-core/src/cli/sync-git/p-settlement.ts:87) and [p-settlement.ts:120](/home/via/Development/Personal/rbox-core/src/cli/sync-git/p-settlement.ts:120). It does not solve an entirely missing BASE family. | A P contains only one branch transition; it cannot supply the incoming bundle/index/op-state/refScope family or prove sibling branches and safe refs. Synthesizing BASE here would move ownership into the settlement module and could advertise an incomplete or wrong GitSection. Reject. |
| **(c) Consume standing P as manual artifact proof** | BASE-less/recordless repos with one or more exact CREATE Ps whose `nextOid` equals the incoming candidate, including current and side branches. Nonmatching or advancing Ps continue to repair/refuse. | Safe only if each P’s R/P/K identity and reflog episode are validated and reserved through checkout. Never downgrade it to a no-P terminal. Recommended. |

### Minimal safe shape for (c)

Reuse existing mechanisms; add no new BASE authority:

1. Have manual preflight classify an exact `base-absent` CREATE P as a manual-landing receipt rather than a generic hold. It must first establish P/K validity, `R == nextOid`, and the exact reflog episode.
2. Feed that P through existing `branchWitnesses`/`branchLockedProofs`, with `beforeBaseOid:null`, only when `incoming.refs[ref] === P.nextOid`.
3. Let `RefPlaneTransaction` reserve R/P/K using its existing witness reservation loop at [ref-plane-transaction.ts:236](/home/via/Development/Personal/rbox-core/src/cli/sync-git/ref-plane-transaction.ts:236).
4. Let the unchanged manual composer install the incoming family.
5. Reuse the existing post-journal call at [resolve-take-theirs.ts:294](/home/via/Development/Personal/rbox-core/src/cli/git/resolve-take-theirs.ts:294); now that BASE exists, ordinary exact settlement updates provenance and retires P/K.

This preserves the important ownership split: incoming supplies the complete GitSection family, P proves its branch transition, the manual composer owns BASE selection, and settlement owns artifact retirement.

## Fresh-device / 2.0 relevance

A fresh second device cannot import these P/K refs.

Capture explicitly passes `--exclude=refs/rbox-*` to `git bundle create` at [capture.ts:42](/home/via/Development/Personal/rbox-core/src/cli/sync-git/capture.ts:42) and [capture.ts:334](/home/via/Development/Personal/rbox-core/src/cli/sync-git/capture.ts:334). The manifest ref map independently allows only heads, tags, and stash at [manifest-validate.ts:327](/home/via/Development/Personal/rbox-core/src/engine/manifest-validate.ts:327).

So #831 is not a wire-compatibility or fresh-device-import blocker. A fresh device may later mint its own local CREATE P while following, but it cannot inherit another device’s standing P.

For the 2.0 tag:

- Not a blocker on “fresh install/fresh second device” grounds.
- Still relevant if 2.0 promises in-place healing of existing/beta repositories—which the current release checklist explicitly does at [2.0-RELEASE-CHECKLIST.md:41](/home/via/Development/Personal/rbox-core/docs/2.0-RELEASE-CHECKLIST.md:41). The affected population is reused local repositories with already-minted Ps, not newly imported repositories.

No files changed; worktree remains clean. Write-based suites could not run under the read-only sandbox (`/tmp` returned `EROFS`); the pure composer suite passed 14/14.