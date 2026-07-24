# REVIEW-166-V4-DELTA — targeted v3→v4 delta verification

Reviewed `REVIEW-166-FINAL.md` in full, `SYNTHESIS-166-FINAL.md`,
`FOLD-166-V4-NOTES.md`, the v3 pre-fold snapshot, and
`docs/design/166-forward-adopt.md` v4. Implementation spot-checks use the
current tree at `17e3104080262aac1e6ef439d8652166c4945366`.

## Verdict: CHANGES-REQUIRED

V4 correctly deletes the in-repository adoption namespace, removes the
import-everything fetch, supplies the requested literal fetch guards, preserves
the previously FOLDED material, and represents most of F2 plus F5–F8. It is not
aligned yet. The selective fetch still dereferences a mutable source ref after
the proof, so an unproved divergent tip can enter the baseline object store
while the new ref-set test remains green. The checked-out-index rule still
destroys valid A index state on the successful path while leaving operation
state live. Pointer-source ownership also conflicts with the new
inside-the-stash containment and sole-parking claims.

## Findings

### 1. BLOCKER — F1 fetches a mutable branch name, not the tip that was proved.

The design resolves and journals the exact incoming tip, proves ancestry, and
rechecks the source ref (`166:152-166`), but only afterward runs:

```text
git fetch --no-tags --no-recurse-submodules --no-write-fetch-head \
  <stash-repo> refs/heads/<name>
```

(`166:168-182`). No source-side reservation spans that later dereference. An
unrelated writer can move the stash branch from the proved fast-forward tip
`I` to a divergent tip `D` after the recheck. The literal fetch then imports
`D` and its objects, contradicting the rule that only the individually proved
branch state is fetched and that divergent state remains solely in the stash
(`166:130-132,152-157`). The later target CAS either fails because `I` was not
transferred or pauses, but it cannot remove the already imported `D` objects.

A literal local-Git probe reproduced exactly that schedule: the target gained
the divergent object, did not gain the journaled proved object, changed no ref,
and left `FETCH_HEAD` untouched. Consequently the mandatory complete-ref-set
assertions at `166:515,519-523` do not detect this violation. The existing safe
branch-transition precedent locks and rechecks the *target* ref, HEAD, sibling
ownership, and reflog at its prepared boundary
(`src/cli/sync-git/branch-transition.ts:294-333`); it does not reserve the
independent source repository.

Fetch the journaled exact incoming OID, or hold a source-ref verification lock
across fetch, and then recheck that the source branch still names that OID at
the target prepared boundary. A local probe confirmed that the exact-OID form

```text
git fetch --no-tags --no-recurse-submodules --no-write-fetch-head \
  <stash-repo> <journaled-40-hex-oid>
```

transfers only the recorded commit, creates no ref, and does not modify
`FETCH_HEAD`. Add binding rows for source movement before fetch, source movement
after fetch but before target CAS, and exact-object disappearance/GC. An
unrelated moved-to tip must remain absent from A's object store in every case.

### 2. BLOCKER — F3 supplies an abort inverse but does not close successful-path index/op-state destruction.

`REVIEW-166-FINAL.md` finding 3 did not object only to the absence of an abort
copy. It also showed that rebuilding the checked-out index erases synchronized
staged, sparse, intent-to-add, skip-worktree, and unmerged A state and can make
A's merge/rebase files incoherent. The accepted finding required either a
clean-index/no-operation-state eligibility gate or a retained, lock-protected
composition with an exact inverse.

V4 durably copies the old index, advances the branch, runs
`git read-tree --reset <post-ff-HEAD>`, and retains A's operation-state files
live (`166:194-205`). The copy is used only by abort (`166:200-202,436-449`). On
successful completion, the live index is still reset and the independently
live operation state is neither composed nor refused. The binding row repeats
that behavior but never requires the resulting successful Git state to remain
coherent (`166:529-530`).

A literal Git probe confirmed the original counterexample: during a conflicted
merge, the specified ref fast-forward plus `read-tree --reset` changed three
unmerged index entries to zero while leaving `MERGE_HEAD` present. The working
tree was then ordinary modified/deleted state under a still-declared merge.
This matches the implementation model: raw index and operation state are
captured independently (`src/engine/git/capture.ts:207-221`), and operation
state remains independently meaningful (`src/engine/git/refs.ts:31-45`).

Either park a checked-out branch unless `indexTree == HEAD tree` and no
operation state exists, or specify and bind a real successful-path
index/op-state composition. Merely retaining abort bytes does not close the
accepted safety finding.

### 3. HIGH — the F2 pointer-source route contradicts F4 containment and F1 stash-only parking.

V4 allows a B pointer repository's scoped branch to be considered
(`166:143-151`) and requires the source to remain inside the retained stash
before every fetch/ref/index mutation (`166:134-141`). It also says the retained
stash repository is the sole reachability and reporting surface for all
non-imported state (`166:90-98,152-157,207-211`).

For a real linked worktree, however, the `.git` file in the moved worktree
resolves its per-worktree Git directory and shared common/object/ref store
outside that worktree. That is the repository's explicit model
(`src/engine/git/shared.ts:281-328`), and `readScopedRefs` reads the current
branch from that external store (`src/engine/git/refs.ts:17-23`). A literal
worktree move into an adoption stash left both `--absolute-git-dir` and
`--git-common-dir` outside the stash.

If F4 containment covers the resolved Git/common/object paths, every such
pointer source refuses and the pointer-source candidate route is not
implementable. If it covers only the stashed worktree path, fetch and status
follow mutable external state, so neither source containment nor stash-only
parking is true. Specify a self-contained retained snapshot for an external
pointer source, or explicitly refuse that shape before mutation and make the
pointer binding row state that disposition. This is a v4 delta contradiction
among changed F1/F2/F4 text, not a reopening of unrelated FINAL findings 9–11.

## F1–F8 closure audit

| Ruling | Result | Delta verification |
| --- | --- | --- |
| F1 — selective fast-forward fetch | **INCOMPLETE** | The adoption namespace and wildcard fetch are gone; `--no-tags --no-recurse-submodules --no-write-fetch-head`, stash-backed status, and complete-ref-set assertions are present. The mutable-source race above still imports unproved objects and evades the ref-set test. |
| F2 — scope, ownership, pause | **INCOMPLETE** | Directory/pointer scope, sibling ownership, HEAD/reflog observations, before/after journaling, CAS pause, ABA handling, and no-stale-proof resume are present. Source reservation/order and the pointer-source physical scope remain unresolved. |
| F3 — checked-out index inverse | **INCOMPLETE** | The exact pre-op index copy, post-CAS `read-tree`, crash classifier, and abort restoration are specified, but the accepted successful-path index/op-state defect remains. |
| F4 — Git-plane containment | **INCOMPLETE** | Target no-follow/realpath and incarnation revalidation close the A-symlink escape. Source containment is not defined coherently for the pointer source F2 admits. |
| F5 — identity/no-clobber | **CLOSED** | Every regular leaf is streamed and hashed without a size threshold; full identity is recorded; mismatch pauses; dirfd/`O_NOFOLLOW` revalidation and no-replace rename plus writer-race tests are binding (`166:258-302,535-536,545-546`). This needs a new native/platform-equivalent adapter because current high-level rename APIs are path-based, but the required primitive and refusal semantics are specified. |
| F6 — shared fence | **CLOSED** | The fence moves to the shared mutation-mutex acquisition path, enumerates the named direct/ceremonial owners, covers manifest publishers/appliers with a repository assertion, and binds them in one row (`166:312-331,540`). Current mutex ownership and caller-inventory tests provide implementable seams (`src/cli/sync-mutex.ts:125-184`; `src/cli/sync-mutex.test.ts:122-199`). |
| F7 — cache generations | **CLOSED** | Hash, directory/scan, trackedness, matcher, uncached full-scan, durable generation, daemon acknowledgement, and abort are all explicit and tested (`166:340-358,447-449,469-475,537,552-553`). The daemon's held-mutex reset operation boundary is a viable precedent (`src/cli/daemon/daemon.ts:772-810`). |
| F8 — continuation authority | **CLOSED** | Persisted single-use consumption, full tuple/mutex-incarnation binding, invocation-local nested propagation, rejection/replay rules, and validated resume reminting are explicit and binding (`166:110-121,327-338,430-435,539,541-542`). |

## Previously FOLDED regression audit

No regression was found in material that `REVIEW-166-FINAL.md` marked FOLDED.
The fold agent's explicit pre-edit v3 snapshot
(`sha256 7f61ceeee4bd48ca81da6214b16c6cdc033517809d5ebdf63ea0fbd1aed141a4`)
was compared directly with v4:

- the no-swap layer statement, phase-2 incarnation, and nested
  no-directory-rename passages are byte-identical;
- the complete original D2 stash-driven leaf-overlay block is byte-identical;
  v4 only appends F5 no-clobber mechanics after it;
- D5's scope/refusal/consent body and all of D6's ordinary incremental finish
  semantics are byte-identical; and
- the A-only, same-type collision, type-flip, nested-repository, same-stream,
  unsupported-mode, consent, Git-incarnation, and 20+ finish-fanout rows are
  byte-identical.

The full v4 search also confirms that no `refs/adopt/*`, `refs/rbox-adopt/*`,
`+refs/*`, or equivalent destination parking namespace remains. The three
findings above are confined to the newly changed F1–F4 mechanics; no previously
FOLDED decision regressed.

V4 should return for another delta verification after those three findings are
closed.
