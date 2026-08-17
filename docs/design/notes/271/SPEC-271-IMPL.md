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
