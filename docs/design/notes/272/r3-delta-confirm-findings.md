# 272 r3 delta-confirm findings (verdict: CHANGES-REQUIRED)

Reviewer basis: design a0703593b, code b9bb83d5d. Full findings verbatim below;
the fold decisions follow at the end.

## D1 (BLOCKING) — R1's keep-out is not achievable at :720 as specified

The two walks do not have the same shape.

`inventory` (apply-receipt.ts:614-625) — the "other" arm is a SIBLING of the
leaf arm:

    :616  if (hardExcluded(childRel, eq)) continue;
    :617  if (child.type === "dir")      { …prunes/ignores… }
    :621  else if (child.type === "other") { if (!ignores(childRel)) throw "unsupported-entry"; }
    :623  else if (!this.matcher.ignores(childRel)) entries.push(…)

Swapping :619/:623 for comparable() leaves :622 untouched. Design correct here.

`scopedScan` (:711-722) — the "other" arm is NESTED INSIDE the leaf guard:

    :713  if (hardExcluded(childRel, eq)) continue;
    :714  if (child.isDirectory())      { …prunes/ignores… }
    :718  else if (!this.matcher.ignores(childRel)) {      ← the "leaf" call site
    :719     const type = symlink | file | other;
    :720     if (type === "other") throw "unsupported-entry";   ← INSIDE :718
    :721     await scanLeaf(childRel, type);
          }

Replace :718 with comparable(childRel, "leaf", root, eq) and a conflict-grammar
FIFO FAILS the guard and is silently skipped — :720 never reached. Fail-closed
→ fail-open flip, delivered by §2.4's own prescription. §2.5's ":622/:720
deliberately do NOT call it" is true of :720 textually, false behaviorally: the
routing decision for :720 is made one level up at :718.

Consequences:
1. Oracle asymmetry inside one prove: pull-kind proves reach inventory (:500)
   AND can fall through to scopedScan via :530. A grammar-matching FIFO yields
   indeterminate on one path, silent skip on the other — breaks §3's first
   protected contract in behavior while satisfying it in form.
2. Proposed pin doesn't cover the broken side: apply-receipt.test.ts:393-400
   asserts through pullOracle(root, fixture).proveRepo("repo") — the inventory
   path only.
3. m3's count survives (still seven call sites) once the restructure is named.

Required: §2.4 must specify hoisting the type computation above the guard in
scopedScan so its child loop takes inventory's shape
(`else if (type === "other") { if (!ignores) throw } else if (comparable(…)) scanLeaf(…)`);
§7's FIFO sibling must assert against BOTH pullOracle and the state oracle.

Verified separately: :393-400 pins only the matcher-ignored case and stays
green under comparable() on both walks because the "other" arms keep their own
!ignores test.

## D2 (BLOCKING) — §2.3 over-claims; root-scoping kills one instance, not the shape

"…making the vacuous-match shape unreachable" — it makes the ANCESTOR instance
unreachable. A repo whose entire comparable population sits under a single
conflict-named directory AT OR BELOW its own root still lands on the same
chain: manifest side filtered to [] by :469, walk side pruned at :619/:716,
alignPaths → zero pairs → MATCH singleton. Reachable by the same apply.ts:307
whole-directory eviction the design cites as B1's motivation, applied to a
repo's one content directory.

The deeper primitive: a prove that compared zero entries against a non-empty
working tree is indeterminate, not match. That kills the whole class (ancestor,
self, at-or-below); root-scoping degrades from safety property to addressing
nicety. Needs one discrimination — a genuinely empty repo (git init, no files)
must still settle match — so the guard is "the conflict grammar was the reason
the population is empty", not "the population is empty".

## Correction 3 — §3.4 skew chain anchored to the wrong lines

resolve-command.ts:1046-1051 is an IN-PROCESS boundary re-prove (identity from
:226, confirmedIdentity JSON at :1019, same binary) — cannot exhibit client
version skew. The actual cross-version gate: snapshotId(identity) at :293 →
snapshot.public.snapshot, printed (:352, keepMineConfirmCommand); a later
--confirm <snapshot> recomputes and compares at :761, :797, :896 →
snapshot-mismatch. oracleReceipt is a field of identity, so a receipt
population change across an upgrade changes the id and the confirm refuses.
Property holds; wrong citation. Also: "durable oracleReceipt hash … stores it
into the resolution binding (sync-state-model.ts:270)" — :270 is a type
declaration; zero persistence sites; the binding escapes the process only as
the opaque snapshotId. Drop "durable".

## Correction 4 — §4 producer chain missing; pull-only-host gap

Producer chain unlisted: local-file-projection.ts:39 (produced),
push.ts:642-647 (onStrandedIgnoredObserved), daemon.ts:370 (held),
daemon.ts:1864 (wired), daemon.ts:2272 (emitted); also status-contract.ts:222
and JSON surfaces status-render.ts:150 and :318.

Precedent caveat defeats the purpose: activity.ts:75-76 — field is optional
because an older daemon "or one that has not pushed since start" omits it; the
value rides the PUSH lane (push.ts:647). A pull-only host never pushes. Copy
the precedent verbatim and counts.conflictCopies is permanently undefined on
FM — the exact host whose 103-repo wedge this design fixes. Either source it
off the local projection independent of the push lane, or state plainly the
daemon-branch count is push-lane-only and pull-only hosts read it from the
computed branch.

## Correction 5 — §5 census composition

Total 14 and 6f/8l split confirmed by independent find. But: the 6 regular
files are three `.env` copies (Dfinitiv/savvy-core/studio/frontend,
Personal/mach-email, Personal/rbox-core) + three `163-…conflict.md` copies.
The doc's "two .env … one settings.local…conflict.json" double-books the
.rbox/trash 15th hit the same paragraph excludes. And "12 of them inside
git-repo subtrees": git rev-parse puts ALL 14 inside a repo (savvy-core ×1,
its three worktrees ×8, mach-email ×1, rbox-core ×1, its two worktrees ×3) —
fix 12→14 or state the derivation.

## Correction 6 — §0 ledger contradictions

§0 says "collapse to five comparable() calls"; §2.4/m3 says seven. Five are
table rows, seven are call sites — §0 must not restate the count. Also
`comparable` is listed as an exported symbol but all consumers are inside
apply-receipt.ts.

## Verified-clean in r3 (do not re-open)

B1 signature works at all seven sites with no threading (project() is the only
normalizeRel caller and always runs first, so walkers already hold the
normalized root — RECORD this dependency in the design). Blocking pin's red
state confirmed real. m1 regex: 17/17 fixtures re-executed, ~N range exact
(claimUnclobberedName starts i=2, unbounded, no pad), ext kept-wide is
required (extname("foo.ts~") === ".ts~"). scanDeferred :465 / touchedKeys :477
out-of-scope calls sound. Anchor drift: git-discover descent loop is :58-62
inside walkDir :46 (doc cites :28-60).

---

# FOLD DECISIONS (Fable, 2026-08-16)

1. **D1 — adopt in full.** §2.4 gains the scopedScan restructure: hoist the
   type computation above the guard so the child loop takes inventory's shape;
   "other" check precedes comparable(); state the oracle-asymmetry rationale.
   §7's FIFO sibling pins BOTH pullOracle and the state oracle. m3 stays seven.
2. **D2 — adopt the empty-population guard.** New mechanism (smallest form):
   during a walk, comparable() exclusions attributable to the conflict grammar
   set one boolean; a prove whose aligned population is zero pairs while that
   boolean is set returns indeterminate ("population emptied by conflict
   grammar"), never match. A genuinely empty repo (no exclusions observed)
   still settles match. §2.3's claim narrows accordingly: root-scoping is
   correct-addressing (prevents ancestor-name misclassification) and stays;
   the GUARD is the safety property. Add the fixture: repo whose only content
   dir is conflict-named → indeterminate; empty git-init repo → match.
3. **§3.4 — re-anchor** to snapshotId :293 / --confirm :761,:797,:896; keep
   :1046-1051 described as the in-process boundary check; drop "durable",
   say "escapes the process only as the confirmation snapshot id".
4. **§4 — add the full producer chain** (all sites above). Pull-only gap:
   prefer the reviewer's second option IF the computed branch already yields
   the count on a pull-only host — verify in code and document it plainly
   (daemon-branch count is push-lane-only; pull-only hosts read the computed
   branch). If the computed branch does NOT produce it on pull-only hosts,
   source the count off the local projection independent of the push lane —
   FM visibility is non-negotiable.
5. **§5 — fix the breakdown**: 3 .env + 3 163-….md; the settings.local hit is
   the excluded trash 15th; 12→14 (all in-repo) with the membership list.
6. **§0 — say seven call sites** (five rows), and `comparable` becomes
   module-private — remove it from the exported-symbol ledger; §7 pins it
   behaviorally through the oracles, not via direct export.
7. Record the B1 normalizeRel dependency note; fix the git-discover anchor to
   walkDir :46 / descent :58-62.
