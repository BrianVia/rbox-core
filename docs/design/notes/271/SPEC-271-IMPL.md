# Implementation spec — design 271 r5 (first BASE landing + typed refusals + resolve legibility)

Authority: docs/design/271-p-settlement-base.md (r5 ALIGNED, 947d429ff) —
the contract; §6 records six review-refuted shapes never to reintroduce
(P-minted BASE families, same-pull settlement, reasonCode field, moved-
union base-absent, reset-clause change, SyncState plumbing). §7 carries
the ALIGNED-round folds. Work order only.

## Deliverables (design section owns each)
1. §2.1: base-absent typed hold code on ExactPSettlementResult; entry
   test before p-settlement.ts:74; in-transaction :101 throw untouched.
2. §2.2: StandingBranchProofResult landing member; apply treats landing
   like settled + arms the observation; P left standing (next-pull
   settlement; preserve-third fallback).
3. §2.3: followBaseProof mints observed-landing when prior.base
   undefined AND observation present; FollowTransitionIdentity
   lockedProof via the single constructor's new optional identity param
   (journal caller passes today's literal); observation =
   readAllRefsStrict after followDivergedRepo, before :1056/:1067;
   checkoutComplete:false on the deferred path named load-bearing.
4. §2.4: the ref-plane-publication.ts:160-161 scope fix (no-BASE +
   oldOid===newOid is the landing shape, not local divergence) — with
   the :106/:107/:128 exhaustion argument as the comment-worthy
   constraint; appliedRefs alternative stays rejected.
5. §2.5: observed-landing branch in revalidateCommittedBranchProofs
   (re-read; WITHDRAW via carryUnreadableRefDatabase parameterized by
   reason: ref-read-unreadable | git-busy); refused repo's held-attempt
   SKIPPED from attemptsToRebind; state threading per the :386 pattern.
6. §2.6/§2.7: base-composer safe-ref ordering fix (:551-556 arm moved
   after the :557 scope gate); resolve: two typed error classes (the
   makeIntended :931/:1001 sites) + three emit-and-return sites
   (:1074/:1076/:1078 — :1078's curated text REPLACES pSettled.error);
   :1082 catch-all keeps the sanitized default (security tests
   git-cmd.test.ts:1279-1308 are a PROTECTED CONTRACT); GitDeferral
   gains optional detail (author = the deferral-writing site; three
   projection surfaces per §2.7: sync-git/status.ts:39-45 declared,
   status-projection.ts:332-338 narrowed, status-view.ts:414-428
   rendered; coverage entry state-plane/codecs/coverage.ts).
7. Stderr step progress for take-theirs/keep-mine via the shipped emit
   seam; --json stdout unchanged (NO new fields — the reasonCode idea is
   refuted; code already exists).

## Tests — every §4/§5 bullet
Rig: flip git-rebuild-settlement's [BUG #752-B] assertions per FIX_FLIPS
(landing pull: BASE covers every incoming ref; surviving-deferral
assertion phrased against record.pending.refs + for-each-ref, dir/all
scope; second pull: P retired, no deferral; take-theirs settles);
oldOid===newOid regression fixture (real local commit variant + the
landing-shape variant); base-absent per-caller fixtures incl. reset's
named message and p-repair's unchanged 2-valued port; §2.5 withdraw
fixtures (unreadable + moved-observation); journal two-cycle heal;
pointer/scoped scope-refused → no first BASE pin; resolve typed-site
fixtures + sanitization tests UNCHANGED; deferral detail round-trip
(codec + coverage + all three projections + renderer).

## Process
Preflight test-runnability; bun run test:affected per iteration; ONE
bun run test:parallel final gate (cas-operations heap guard = #757
baseline-red on this host: verify vs clean main if it fires); typecheck
with cleared cache; lint:affected zero new warnings (documented
persisted-name exceptions only); named exported types; comments ≤1 line;
≤500 lines/file (decompose, never shave); artifacts in
docs/design/notes/271/ never repo root. Logical commits on
p-settlement-fix; do NOT push.

## Do NOT touch
composeRepoBase's family selection or GIT_SECTION_FIELD_COVERAGE; the
promoteFilesIntoPlane/state-plane territory; 270's held-skip surfaces
beyond reading; pending-supersession (#702's territory); the resolve
mutex structure; conflict-copy/oracle code (272's in-flight branch —
expect sequenced merges, 272 first).

## Review-round dispositions

Two parallel reviews of the six implementation commits produced ten folds
(F1-F10). What was knowingly NOT closed, and why:

- **§4's two-cycle bullet (deviation 6) is deferred.** `base-absent` is
  asserted per-caller and the landing is asserted at the composition and
  `applyGitSections` levels, but "reachable for at most the one pull before the
  landing composition runs" is proven only by composition-level tests plus the
  rig's two post-rebuild cycles — not by a single automated two-cycle fixture.
- **The standing-P rig assertion follows §4's RESIDUAL clause, not its
  headline.** §4 says the second pull retires the P; §6/m8 says nothing
  schedules a follow for a quiescent repository. The scenario asserts the
  weaker form (the P may stand; it costs one redone follow when it retires),
  resolving the design's self-contradiction toward §2.2.
- **Resolve preflight raw-reason emissions are pre-existing and in contract.**
  `resolve-command.ts:675` emits `preflight.reason` under `code: "artifact"`.
  §2.1's table leaves that caller unchanged, and §2.7 curates only the five
  mutex-body sites. Queued as a follow-up, not fixed here.
- **P3: the `makeIntended` → `:1139` rethrow path is traced-correct but pinned
  only by build-seam fixtures.** The two error classes are asserted by throwing
  them from `deps.build`, which exercises the SAME outer catch and
  classification; no fixture drives them out of `makeIntended` itself.
- **`forceMutexBodyRefusal` is a test seam with a deletion condition.** The
  `incomplete-checkout` and `journal-recovery` sites are reachable in production
  only through a crash or concurrent-writer window inside the follow, which no
  available deps seam opens. It mirrors the shipped `forceProofIndeterminate`
  seam and is deleted the day either window becomes drivable from a fixture.
  The `artifact` site — the only one of the three with a raw reason to replace —
  is induced genuinely, by planting a foreign artifact inside the protocol
  namespace during the follow.
- **§2.3's read point is narrowed to the FOLLOWED transition.** The design
  places the observation "before the two `commitFollowTransition` calls"; it is
  now taken before the followed one only. The deferred call composes
  `checkoutComplete:false`, which `composeRepoBase:592` makes `pending`
  unconditionally, so that path provably cannot land a first BASE — and it no
  longer pays for `readAllRefsStrict`. Its proof authority returns to exactly
  what it was before this cycle.
