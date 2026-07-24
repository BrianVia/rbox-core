# Adversarial Review — Design 174 (apply-side perf + held-repo livelock), Round 1 (Opus)

Reviewer: independent adversarial. Scope: verified every §-anchor against
`src/cli/sync-git/{apply,follow,plan,fingerprint,divergence-cache}.ts`,
`src/engine/git/{reachability,apply,checkout-txn,shared}.ts`,
`src/cli/sync/pull.ts`, `src/cli/sync-git/{shared,publisher-tombstones}.ts`,
`src/engine/types.ts`, and the governing model `docs/design/130`.

Field-evidence (§1) is well corroborated: the log line "local commits on branch
main" ↔ `follow.ts:455` (`local-commits`, "current tip has receiver-only
commits"); "stash reflog contains receiver-only work; incoming checkout ref
could not be published safely" ↔ `follow.ts:466` + `publishRefPlane`
checkoutRefDetail; the "applied=1 yet held/deferred" shape ↔
`apply.ts:1219-1222` (a `status:"followed"` result with `held.length>0` sets
`pending[rel]=remoteSec` + `setDeferral(...)` and still logs `git-sync
followed`, returning `result:"applied"`). The deadlock mechanism in §1.3 is
accurate. The only §1 inaccuracy is a line anchor (Finding 5).

---

## Finding 1 — BLOCKER — §4.2 silently regresses `refTombstones` / `refTombstoneGeneration` on pending-clear

§4.2's supersession definition enumerates refs (heads/tags/stash), opState,
head, index and config, and is **completely silent on `refTombstones` and
`refTombstoneGeneration`** — the highest-risk lane per §130. It waves the risk
away with "supersession authors no tombstones and deletes no refs." That is
true but *insufficient*: the harm is not authoring, it is **dropping / regressing
a chain the pending section `P` already carried** when the fresh capture is
re-normalized.

Concrete code path, confirmed:
- Clearing `gitPendingRemote[rel]` means the byte-for-byte pending exemption in
  `normalizeOutgoingGitSections` (`publisher-tombstones.ts:181-184`) no longer
  fires, so the fresh capture goes through `normalizePublishedGitSection(
  advertised[rel], freshCapture, now)` (`plan.ts:172-173`).
- In that normalizer `generation = max(advertised.gen, candidate.gen)`
  (`publisher-tombstones.ts:70`) and the chain map is seeded **only** from
  `advertised` + `candidate` (`:76-85`). A fresh `captureGitState` carries no
  tombstones and no generation → `candidate.gen = 0`. So the output tombstone
  state is entirely `advertised`'s.
- Therefore correctness depends on `record.advertised` already containing `P`'s
  full chain and generation. It does **not**, in general: `advertised` is only
  written by this device's own push-ACK (`publisher-ack`), whereas a pending `P`
  is delivered by **pull**. The first push after a pull that installed `P` has
  `advertised` = this device's *previous* published section (pre-`P`), whose
  generation `G0 < P.gen` and whose chains omit `P`'s.

Consequence (code-backed, not hypothetical): the emitted section carries
`refTombstoneGeneration = max(G0, 0) = G0 < P.gen`. §130 (lines 88-89): "A
capable reader additionally requires `refTombstoneGeneration >= max(entry.
generation)` … a section with a smaller high-water mark is **invalid**." So a
follower that already observed `P` will **reject the fresh section as invalid**
(hard-hold), and any slow follower that needed a chain entry only present in `P`
loses it — exactly the permanent-held-ref accumulation §130 exists to prevent.

Scope honesty: in the *specific* savvy-core repro this is masked, because the
sole rbox writer is the Mac and `P` is the Mac's own seq-83 push echoed back, so
`advertised == P` and generation is preserved. But item B ships **default-on
fleet-wide with only a global kill switch and no topology guard**; it fires on
any `local ⊒ P.refs`, including every genuine multi-writer rbox workspace and
even one-writer setups whose pending originated from a peer's push. 173 is
"reserved" but nothing *prevents* B from running there.

Fix direction: before clearing pending, fold `P.refTombstones` and
`P.refTombstoneGeneration` into the normalization baseline for `rel` this push
(e.g. seed the fresh candidate, or pass `P` as the `advertised` argument for
that repo so `max()`+merge provably carry them), **or** gate B to fire only when
`advertised.refTombstones ⊇ P.refTombstones ∧ advertised.gen ≥ P.gen` (i.e. this
device provably already published `P`'s tombstone state). Add a test to §5: B on
a repo whose `P` carries a live tombstone chain absent from `advertised` must
preserve chain+generation (or refuse to supersede).

## Finding 2 — MAJOR — §4.1 allowlist claim is false for `local-stash`: the fingerprint does not cover reflogs

§4.1 condition 3 asserts the allowlisted reasons are those "whose classification
inputs (ownership proofs over refs/**reflogs**) are fully covered by the git
fingerprint." The fingerprint does **not** cover reflogs. `gitFingerprint`
(`fingerprint.ts:280-298`) composes `dotGitToken` + `gitDirFingerprint`
(HEAD, index, index.lock, HEAD.lock, config.worktree, opState —
`:268-278`) + `commonDirFingerprint` (shallow, alternates, config, modules,
worktrees, gc.pid, packed-refs(+lock), and `refs/` statTree — `:204-227`).
**No path hashes `logs/`.**

`local-stash` is produced by enumerating the stash reflog:
`classifyCheckout` → `enumerateStashReflogOids(ctx.repoDir)`
(`follow.ts:462-468`) → `enumerateRefReflogOids(repoDir,"refs/stash")`
(`reachability.ts:241-245`), i.e. `logs/refs/stash`. A reflog-only mutation that
leaves `refs/stash` tip unchanged — `git stash drop stash@{1}`, or a
`T→U→T` bounce (§130's own preservation hazard) — changes the enumerated OID set,
hence the ownership answer, **without changing the fingerprint**. So a
`local-stash` hold whose offending reflog OID was dropped stays wrongly skipped
until the 1h floor, and — worse for the design's own safety story — when the
floor forces a re-follow that legitimately now progresses, §4.1's "fingerprint-
miss WARNING" canary **fires on a legitimate reflog change**, crying wolf on the
exact signal meant to catch coverage bugs. It also falsifies §4.1's invalidation
claim that "any … stash change … alters one of the two keys."

This is non-destructive (a skip only holds; it never publishes/deletes) and
floor-bounded, so not a BLOCKER — but the central §4.1 coverage invariant is
wrong as written. Fix: either drop `local-stash` from the allowlist; or extend
the fingerprint to hash `logs/refs/stash` (and the branch/HEAD reflogs that feed
the preservation gate) under the same racy-clean margin; or explicitly document
the reflog-blind, floor-bounded staleness and reclassify the canary so a
reflog-only change is not reported as a fingerprint-coverage defect.

## Finding 3 — MAJOR — §4.2 does not pin the pending/deferral clear to the *accepted* commit; a 409 can orphan the hold

§4.2 step 3 lists the deletions (`gitPendingRemote[rel]`, `partial[rel]`, the
apply deferral, `attempt`) but never says *when* they commit relative to the
push CAS. Push persists a **deferral-only state save before the commit CAS**:
`saveStateSource(...)` at `push.ts:471-485` writes `pending`, `deferrals`,
`removed`, `resolutions` for `changedSidecarRepoKeys`, and only afterwards does
`api.commit(parentSequence, …)` run (`push.ts:646`) with its 409 branch
(`push.ts:656`, `kind:"pull-first"`). If B routes its clear through that
pre-commit sidecar save (deferrals + pending are exactly its `deferralValues`),
a **409-losing push persists the hold/pending clear locally while the remote
still carries `P`.** The repo is then momentarily un-held against a stale remote
section until the next pull re-establishes pending — a window the design does not
acknowledge and does not bound.

The §4.2 multi-writer paragraph *asserts* the desired behavior ("the parent-
sequence guard (409) makes the push lose, the next pull delivers the newer
section as pending") but the code will only deliver that if the clear is atomic
with the **accepted** commit. Fix: specify that B's pending/partial/deferral/
attempt clear is emitted **only** in the post-commit ACK path
(`push.ts:665-682`), never in the pre-commit deferral-only save; on any
409/epoch-stale/repair-conflict return, `P` and its hold must remain byte-intact.
Add §5 coverage: 409 during a superseding push leaves pending+deferral unchanged.

## Finding 4 — MAJOR — §4.1 "divergence cache already proves this primitive sound" is an over-transfer

§4.1 justifies reusing `gitFingerprint` for the held-skip by analogy: "The
divergence cache already proves this primitive sound for skip decisions on the
push side." The divergence cache uses the fingerprint to gate **identity /
preflight / config-presence** decisions (`fingerprintHitProbe` →
`CachedDivergenceProbe{busy, preflightOk, identityKey, parentRel}` +
`cachedLocalCfg`, `divergence-cache.ts:254-274`) — all inputs the fingerprint's
stat/statTree scheme genuinely observes. It **never** used the fingerprint to
stand in for a reachability/ownership proof or a reflog enumeration. Item A
extends the same hash to gate `local-commits`/`local-stash` holds, whose inputs
include the stash reflog (Finding 2) and — co-occurring — the working-tree
oracle (`proveRepo`/`reproveRepo`, `follow.ts:408`), which the fingerprint also
does not cover (it is `.git`-only, not the worktree). The `local-commits` proof
itself *is* covered (currentTip via HEAD+refs, roots via `incomingKey`, ancestry
immutable), so the working-tree gap is benign (any worktree edit still holds,
only the reason label goes stale). But the blanket "already proven sound" claim
should be replaced with a per-input coverage argument, and the stash-reflog gap
(Finding 2) closed rather than inherited by analogy.

## Finding 5 — MINOR — `fsck` anchor is wrong; item-C timing would instrument the wrong call

§1.4 ("`git fsck --connectivity-only` (apply.ts:712) was NOT observed") and §4.3
("`fsckMs` (apply.ts:712)") point at `src/cli/sync-git/apply.ts:712`, which is
config-due logic (`configDue = gitConfigHash(...) !== lane.cfgApplied …`), not an
fsck. The real fsck on the **follow hot path** is the checkout connectivity
proof at `checkout-txn.ts:282-284` (gated by `connectivityProof`,
`:563-566`); `engine/git/apply.ts:712` is the *legacy* diverged-apply fsck that
the design-116 follow path does not take. Item C should time
`checkout-txn.ts:282` (and label it as the connectivity proof), or it will
attribute 0ms to a call the wedged repo never makes and miss the one it does.

## Finding 6 — MINOR — §4.4 D cannot drain the very repo it targets while B is unlanded

§4.4 runs the conflict-ref retention pass "at the end of a successful capture."
A held/wedged repo suppresses capture (`plan.ts:625-632` carries pending and
`continue`s past the capture pool), so savvy-core — the repo with **810
`refs/rbox-conflict/*`** — never reaches a successful capture and D never runs on
it until B clears the hold and a fresh capture occurs. This is a correct ordering
(D depends on B) but should be stated: D does not relieve a still-wedged repo;
item A is what removes the 8.5s ref-transaction cost meanwhile (by skipping the
re-follow entirely). Separately, note that pruning a conflict ref whose commit is
reachable from a branch leaves its `refs/rbox-local/keep/<oid>` origins intact
(harmless over-protection per §130) — fine, but call it out so the status count
(`N prunable`) isn't read as "objects freed."

## Finding 7 — MINOR — §4.2 head/opState sub-lanes under-specified

- `P.head`: §4.2 only handles a **symbolic** head naming a locally-present
  branch. A **detached** `P.head` (40-hex) is unaddressed; it must explicitly
  block supersession (a detached pending head has no branch to prove subsumption
  against). State it.
- `P.opState`: §4.2 checks only "opState commit candidates owned by local tips,"
  matching `opStateCommitCandidates` in `reachability.ts:39-47`. But opState also
  carries non-commit files (MERGE_MSG, `rebase-apply/**` scratch). Clearing a
  non-empty `P.opState` when local has no in-progress operation is defensible in
  the one-writer model (local is truth) but is discarding information the
  definition never compared. Either require local opState ⊇ P.opState (commit
  candidates + presence) or state explicitly that a non-empty `P.opState`
  divergent from local blocks supersession, consistent with the index/config
  rule.

## Finding 8 — MINOR — §4.2 "no data destroyed" phrasing conflates local-reachable with follower-visible (stash lane)

The stash rule accepts supersession when `P.refs["refs/stash"]` is "reachable
from local stash reflog oids or local branch tips." A stash OID reachable **only
via the local reflog** is present on this device but is **not** re-emitted by a
fresh capture, which advertises the current `refs/stash` tip only (bundles carry
ref tips, not reflog history). Followers holding `P` (stash=X) then converge to
the new tip and never receive X. This matches existing stash-sync semantics and
is acceptable, but it contradicts §4.2's absolute "no data destroyed (every oid
in the old pending was provably already in local history)" — that guarantee is
about *local* reachability, not *follower-visible* content. Soften the claim or
scope it to branch/tag lanes.

## Finding 9 — EDITORIAL — cross-doc line anchors have drifted

§1.3's `plan.ts:622-633` is accurate (pending carry at `:625-632`). §130's own
citation `plan.ts:566-576` for the same behavior has drifted (that range is now
empty-repo baseSec carry + the §7 matrix comment). Not load-bearing for 174, but
a refresh pass on 130↔174 anchors is warranted before implementation keys off
them.

---

## §130-contract audit (attack priority 6)
- **Composer**: item A skips work and emits nothing, so it never bypasses
  `composeRepoBase`; the held-followed `composeRepoBase` at `apply.ts:1209` that
  A skips is idempotent under unchanged keys (its non-held members already
  advanced on the first follow), so §5 test 11's "composer call-count zero for
  skipped repos" is sound. ✓
- **Pending byte-for-byte exemption** (§130:121-123): A preserves pending
  unchanged (no emit); respected. ✓
- **A/P/K / tombstone plane**: B "authors no tombstones, deletes no refs" is
  literally true, but violates the *preservation* half of §130 (Finding 1) — the
  "S0 must still find Q" guarantee and the monotonic-generation reader rule.
- **Raw update-ref allowlist**: D's `update-ref -d` on `refs/rbox-conflict/*` is
  within §130:491-492's scratch/conflict allowlist. ✓

## Item E (attack priority 4) — acceptable, with a caveat to record
Reusing `lastSyncedManifest` as `local` cannot mask a destructive local mutation
into data loss, because the **apply-time** delete guard reads real disk:
`deleteEntry` removes only when `sameContent(current, expectedLocal)` and
otherwise moves the file to a visible conflict copy (`engine/apply.ts:403-425`);
the mass-delete guard (`pull.ts:170-178`) counts reconcile output identically
whether `local` was scanned or reused (a reused `local==base` yields the same
remote-driven delete count). Worst case of a watcher miss is a spurious conflict
copy or a delayed publish — bounded by the untouched safety-scan cadence.
Caveat to state in §4.5: the git oracle (`oracleFromPull({preScan: local, …})`,
`pull.ts:242-251`) feeds `proveRepo`/`reproveRepo`; a stale reused scan there
could falsely prove a git working tree clean and admit a checkout over uncommitted
work. E's reuse gate ("no dirty candidates per healthy watcher") must therefore be
the *same* authority the git oracle trusts, and §5 test 9's differential test
should include a git repo with an unscanned working-tree edit.

---

## Verdict counts
- BLOCKER: 1 (Finding 1)
- MAJOR: 3 (Findings 2, 3, 4)
- MINOR: 4 (Findings 5, 6, 7, 8)
- EDITORIAL: 1 (Finding 9)

Verdict: CHANGES-REQUIRED
