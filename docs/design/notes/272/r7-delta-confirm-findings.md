# 272 — r7 delta-confirm findings (folded as r8)

Round: adversarial delta-confirm over DRAFT r7 of
`docs/design/272-conflict-copy-oracle.md`. Scope was the r7 delta only (the
B-r6-1 strictly-below correction, C-r6-1/2/3, and r7's four nits), plus a
doc-wide consistency sweep. Small round: one blocker, one correction, five nits.

## B-r7-1 (blocker) — the `why` string carries the reason token

**Finding.** r7 specced `CONFLICT_COPY_POPULATION_WHY` as
`"repo population emptied by conflict-copy exclusion"` (singular) while §2.7's
doctor fix assumed a detail containing `"conflict-copies"` would reach
`gitReasonOf`. Those two cannot both be true, and the singular loses.

**Trace, verified in shipped code:**

1. `src/cli/sync-git/follow-classify.ts:139` —
   `else if (oracle.kind === "indeterminate") { reasons.add("unreadable"); details.push(oracle.why); }`
   — pushes `oracle.why` VERBATIM. The reason id is a separate channel and never
   enters the deferral log line.
2. `gitReasonOf`'s callers parse that log line and hand it the captured detail
   fragment (= the `why`): `src/cli/doctor-cmd.ts:246` (`git deferred <age>: …`),
   `:249` (`git-sync deferred <repo>: …`), `:255` (`git-sync WARNING <repo>: …`).
3. `src/cli/doctor-cmd.ts:214` normalizes with
   `detail.toLowerCase().replace(/[ _]+/g, "-")` — folds spaces and underscores
   to hyphens, leaves existing hyphens alone.

So `conflict-copy` never contains `conflict-copies`; the detail falls through to
the `"conflict"` member and the doctor support-bundle bucket is wrong REGARDLESS
of declaration order. The declaration-order fix and the plural wording are both
required; neither rescues the other.

**Ratified.** Constant becomes
`CONFLICT_COPY_POPULATION_WHY = "repo population emptied by conflict-copies exclusion"`,
stated in §0's export row and in §2.4's verdict table. §7's `gitReasonOf` test is
restated as an assertion over the exported constant —
`expect(gitReasonOf(CONFLICT_COPY_POPULATION_WHY)).toBe("conflict-copies")` —
never a hand-authored literal, because a literal stays green on a build whose
constant drifted back to the singular. Both the singular wording and the
literal-detail test form are recorded as r8 rejections in §6.

**Also ratified (narrowing of C-r6-2's pricing clause).** r7 priced the residual
as "the deferral surfaces … DO carry the new reason's copy", which overstated
what the `why` string is responsible for. `rbox status` and the deferral listing
read `deferral.reason` from state and render §2.7's copy directly — they need
nothing from the `why`. The `rbox doctor` log-derived SUPPORT-BUNDLE bucket is
the only surface that re-infers the reason from detail text, and it is exactly
what the ordering fix plus the plural constant correct. §2.7 now says that.

## C-r7-1 — the superstring-order invariant is neither new nor luck

**Finding.** r7's §2.7 said the vocabulary "satisfies the rule by luck rather
than by construction" and §7 called `("conflict-copies", "conflict")` "the only
such pair". Both are wrong. `GIT_DEFERRAL_REASONS`
(`src/cli/sync-state-model.ts:130-134`) already contains
`"ref-read-unreadable"` at index **11** and `"unreadable"` at index **12** —
superstring first. That ordering is load-bearing in shipped code today: swap the
two and every "refs could not be read" detail buckets as plain `unreadable`.
The `local-*` family shares only a PREFIX, so it is not an instance of the rule
either way.

**Ratified.** §2.7 and §7 item 3 now state that `conflict-copies` adds the
SECOND pair to a rule the code has been keeping by hand since
`ref-read-unreadable` landed, and that the invariant test therefore goes green
on today's `main` — it pins shipped behavior, not only the new member.

## Nits (all adopted)

- `project()` is `apply-receipt.ts:460-479`, not `:460-483`; the returned
  `Projected` object literal is `:473-478`, not `:473-482`. Both corrected.
- §2.3 retitled "Ancestor matching…" → "**Addressing-scoped matching**, SCOPED
  to the projection root" — under the r7 predicate the root component is
  addressing too, so "ancestor" no longer names the rule.
- `matchesConflictGrammarBelow(rel, root)` added to §0's module-private
  mechanism table (the table now lists three, and the
  `isRboxConflictArtifact` spend list names it as the oracle-side consumer).
- §2.5's `comparable(childRel, "leaf", root, eq)` kept as written but labelled
  the **rejected unbound form**, with the adopted two-argument bound closure
  named alongside it.
- **Optional item adopted:** a one-line comment specced above
  `GIT_DEFERRAL_REASONS` (`sync-state-model.ts:130`) stating the
  superstring-ordering constraint. This is the inexpressible-constraint case —
  the type system cannot express it and the array looks freely sortable. §7
  item 4 pairs it with the invariant test (test says WHAT, comment says why it
  cannot live anywhere else).

## Verified clean (no change required)

- **The B-r6-1 inversion traced correct on all four sub-claims.** (i) the
  strictly-below predicate does make the scope leaf un-droppable on both walks,
  so §2.3's r7 note is accurate; (ii) `proveRepo(rel)` genuinely addresses the
  repo by that path, so the root component is the caller's addressing; (iii)
  both B1 pin arms correctly assert `mismatch` positively, and the stated red
  state (a regression to "at or below" leaves the ancestor arm green and fails
  only the root arm) is right; (iv) the availability argument in §2.3 — dropping
  §2.3 with §2.4 shipping makes such repos permanently `indeterminate` — holds.
- **Doc-wide consistency clean.** No stale "at or below" phrasing survived r7;
  §0's counts (five expressions → seven bound calls, five rows), §2.5's m3
  arithmetic, §2.6's routing-not-text claim, and §6's demotion entry all agree
  with the r7 predicate.
- **All §2.7 anchors exact**, re-verified against `main` on 2026-08-16:
  `sync-state-model.ts:130-134` (declaration), `:138-148` (the ranking comment),
  `:145-147` ("an enumeration, not a ranking"), `:149-153` (precedence),
  `:156-158` (`UnrankedGitDeferralReason`), `:165-167` (the load-time size
  check); `doctor-cmd.ts:43` (`GIT_DEFERRAL_REASON_SET`), `:213-217`
  (`gitReasonOf`); `follow-classify.ts:139`.

## Disposition

Folded into r8. r7's substance is otherwise unchanged: B-r6-1's strictly-below
predicate, C-r6-1's STATUS-path narrowing, C-r6-3's declaration-order invariant,
and every earlier round's decisions all hold.
