# 272 r4 delta-confirm findings (verdict: CHANGES-REQUIRED)

Reviewer basis: design 6b9df680f. All anchors independently re-verified by the
reviewer. Findings verbatim-in-substance below; ratified fold decisions at end.

## BLOCKING

**B-r4-1 — §7's B1 pin stops discriminating once §2.4 ships (line 595).**
"must NOT return match … Without §2.3's root scoping this test returns match;
that is the red state" is now false: without root scoping, a grammar-matching
root/ancestor empties both sides BY THE GRAMMAR, arming the guard, so the
verdict is indeterminate — which satisfies "NOT match". §2.3 could be deleted
and the pin stays green. The pin must assert the positive verdict
(mismatch/local-edits for a diverged tree), not the negative.

**B-r4-2 — §7's FIFO state-oracle sibling is masked by the guard (605-611).**
Under the rejected literal substitution at :718, a grammar-matching FIFO is
silently skipped, files=[]; if nothing else comparable exists, the manifest
side is empty too, the guard arms via the same grammar exclusion, and the
prove returns indeterminate — the asserted value. Fix: fixture must carry ≥1
surviving non-conflict comparable pair, or assert the specific why
("unsupported entry type in repo subtree"), not the population-emptied reason.

**B-r4-3 — §2.4's verdict rule names no site; the obvious site is wrong
(236-243).** proveFresh reads two alignments (:495 compareEntries over
expected×oracle, :505 alignPaths over expected×inventory.entries) and returns
semantic DIRECTLY, bypassing settle(). Applied at :495 the rule is harmful: a
repo whose manifest projection is emptied by the grammar while the walk finds
real files today reaches :509 → scanAndCompareProjected → mismatch/local-edits;
the guard at :495 would return indeterminate and permanently defer it. Specify
the rule as DOWNGRADING A FINAL match VERDICT (both the records.set return in
proveFresh and the one in scanAndCompareProjected), not firing on the first
zero-pair alignment.

**B-r4-4 — §4's placement contradicts the precedent it copies.** §4 puts
conflictCopies inside StatusLocalCountsBase while its wiring bullets cite the
TOP-LEVEL carriers (:455, status-render.ts:150, :318). status-contract.ts:
218-221: "Deliberately top-level rather than inside counts, which is entangled
with counts.source"; status-render.ts:148-150: "deliberately OUTSIDE the local
block, which is emitted only for a daemon snapshot"; renderStatusJson:151-162
gates the local block on counts.source === "daemon", so a counts field is
invisible on the computed branch. Pick one placement.

**B-r4-5 — the two branches count different populations on a scoped binding.**
Daemon branch: this.local.manifest.files — whole workspace. Computed branch:
localManifest at status-projection.ts:360 — scope-projected. Same hazard the
code documents for `deleted` at status-projection.ts:306-309 (daemon branch
deliberately reports 0 on a scoped binding). §4 must say which population
conflictCopies means and make both branches produce it.

## Corrections (fold before ALIGNED)

1. Record the projection-scoping dependency for the arming rule: project()'s
   filter at :468-469 walks the ENTIRE manifest; the empty-git-init
   discrimination survives only because inProjection(...) && comparable(...)
   short-circuits, so out-of-projection entries never reach the grammar arm.
   Record it like the normalizeRel ordering dependency (lines 186-190).
2. §2.5's restructure snippet (296-300) omits the child.isDirectory() arm —
   read literally every directory throws unsupported-entry. State it replaces
   :718-722 only, or compute type including "dir" (inventory's type at
   :610-611 includes "dir").
3. §2.3/§6 demotion undersells root-scoping: with the guard shipping, dropping
   §2.3 makes every repo under a conflict-named ancestor PERMANENTLY
   indeterminate — an availability property (the FM wedge in a different
   color), not an "addressing nicety". This also supplies B-r4-1's red state.
4. §2.4 "Cost, stated" is incomplete: the guard re-defers a repo whose entire
   comparable population is conflict copies (indeterminate rather than match).
   Field impact zero — all 14 census mints sit in repos with other content —
   state that honest bound.
5. §4 "Zero new scan" is true of the filesystem only: the daemon-branch count
   adds an O(files) pass (path-component split + regex) on every
   enqueueActivityWrite, riding an already-O(files) function (diffManifests at
   :2262) — constant factor, state it per the perf-differential rule.

## Editorial nits

- status-contract.ts anchor: :121-131 (not :120-131; :120 is blank).
- §0 line 44-45: two "other" arms (:622, :720) → "eighth and ninth" drift
  sites; §2.6's r4 title already says "on either walk".
- §2.6 line 290 quotes a sentence that now lives in §2.5 line 280 — repoint.

## Verified-clean in r4 (do not re-open)

All §3.4 re-anchors exact; oracleReceipt has zero persistence sites. §4
producer chain anchors all correct; localSnapshot already O(files) per
enqueueActivityWrite so the sourcing decision is sound and pull-only
availability holds. §5 arithmetic consistent. §0 five-rows/seven-calls
reconciliation checks out. Cross-references survived the renumber.

---

# FOLD DECISIONS (Fable, 2026-08-16)

1. **B-r4-1 — adopt.** The B1 pin asserts the positive verdict: diverged tree
   under a conflict-named ancestor → mismatch/local-edits (root-scoping makes
   the repo addressable; correction 3's availability framing is the red state:
   without §2.3 it is permanently indeterminate).
2. **B-r4-2 — adopt BOTH belts.** Fixture carries one surviving non-conflict
   comparable pair AND asserts the specific why ("unsupported entry type in
   repo subtree"), so neither the guard nor a silent skip can satisfy it.
3. **B-r4-3 — adopt exactly.** The guard is a downgrade rule on a FINAL match
   verdict, specified at both records.set return sites (proveFresh and
   scanAndCompareProjected), never at intermediate alignments. Name both sites
   by line.
4. **B-r4-4 — top-level.** conflictCopies rides the same top-level carriers as
   the 224 precedent (status-contract top-level field, status-render :150/:318
   surfaces); drop "joins StatusLocalCountsBase". The 224 comment's reason
   applies verbatim.
5. **B-r4-5 — verify in code, then pick the population BOTH branches can
   genuinely produce.** Preference order: (a) scope-projected on both if the
   daemon branch can apply the binding projection to its manifest cheaply;
   (b) workspace-wide on both if the computed branch can reach the unprojected
   manifest; (c) if neither, copy the `deleted` precedent's documented
   divergence verbatim (daemon reports the workspace count; scoped bindings
   get the same explicit carve-out :306-309 uses) and state the field impact
   (FM's binding is whole-workspace, so the divergence is unexercised on the
   headline host — verify that claim against the fleet config before writing
   it). Whichever branch of (a)/(b)/(c) the code supports, cite the anchors.
6. **Corrections 1-5 — adopt all** as written (projection-scoping dependency
   recorded like normalizeRel; snippet fixed to include the dir arm or scoped
   to :718-722; §2.3 reframed as availability; both cost bounds stated).
7. **Nits — adopt all three.**
