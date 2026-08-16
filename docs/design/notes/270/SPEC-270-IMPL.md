# Implementation spec — design 270 r4 (held-followed skip)

Authority: docs/design/270-held-followed-skip.md (r4 ALIGNED, f815a5b04)
— the contract, §7 carries the final rulings. Work order only.

## Deliverables
1. §2.1+§7: allowlist disjunct — provenance==="composer" && (code===
   "missing-branch-proof" || code==="missing-safe-ref-proof"), gated by
   NEW flag RBOX_GIT_HELD_SKIP_COMPOSER (default ON, defaults-ledger
   registered). All existing heldBlockersAllowSkip pins stay green
   UNMODIFIED (the doc lists why per pin). CORRECTION (implementation):
   there are **21** such pins, not 20 — 19 in held-skip.test.ts
   (:81-88, 106, 117, 155, 166, 180, 199, 225, 236, 257, 268, 284) and 2
   in follow.test.ts (:2264, 2302). All 21 verified green unmodified; the
   only diff in held-skip.test.ts is its import statement, which the
   held-blockers.ts extraction forced. The 6d41d990 and 577e233b commit
   messages still say "20" — recorded here, not rewritten.
2. §2.3+§7: artifact-plane digest (for-each-ref over the four rbox
   base/recovery namespaces, refname+oid hashed) into BOTH
   earlyHeldAttemptDecision and observeHeldInputs — SAME flag gates it
   (off = neither observed nor stored). Early gate gains repoDir from
   before.diskCtx (fail-open new reason when absent); digest read inside
   the existing two-fingerprint bracket.
3. §2.4+§7: partial identity (partialDisposition's EXACT
   canonicalization incl. pRepaired) compared at the early gate;
   UNFLAGGED (closes a live #641 hole). earlySkip input widens by
   records[rel].partial (in hand at apply.ts:1224).
4. §1.2: trace diagnostic fix — emitTrace names the blocker on the
   applied/held path too (drop the result==="deferred" condition at
   held-decision.ts:291 per the doc). Observation-only.
5. Writer-ordering enumeration (§7): list every artifact-plane writer
   and prove each lands pre-classification or inside
   rebindHeldAttemptsAfterSettlement's reach; record in a short note in
   docs/design/notes/270/.

## Tests — every §5 bullet incl. §7 additions
Red-first composer fixpoint → skip; hourly floor; artifact-plane
invalidation (ref write between cycles → full path next cycle; pRepaired
write likewise); semantic/subjectKey-drift; vacuous-mint + provenance
scoping + checkout-incomplete + mismatched/scope-refused stay ineligible
(pins unmodified); BOTH-codes fixture (branch, safe-ref, mixed);
control-group regression (local-* repo still skips N cycles with digest
live); flag-off = pre-change behavior byte-identical; durable-record
differential after N cycles + journal no-op pair (NOT per-cycle
identity).

## Process
Preflight test-runnability; bun run test:affected per iteration; ONE
bun run test:parallel final gate; typecheck (clear tsbuildinfo after
scripted edits); lint:affected zero new warnings (5 documented
shape-name warnings excepted — 3 in sync-state-model.ts plus their 2
`satisfies Record<keyof ...>` mirrors in state-plane/codecs/coverage.ts:79
and :111. Those two keys are FORCED by the durable field names, so they
cannot be renamed without the state migration and client-skew story that
docs/wire-rename-candidates.md already specifies; that ledger names both
coverage.ts anchors explicitly in the `cfgShape` and
`ConfigStoreIdentity.shape` blast radii. PLUS the 4 no-runtime-typeof
warnings at held-skip.ts:201/209/268/271 — the legacy-attempt compatibility path
(`worktreeRegistryDigest`/`classifierInputKey` presence on attempts
written before designs 200/176), kept deliberately and pinned by
held-skip.test.ts:302/308. Restructuring them into a boundary parse is a
real change to the durable-attempt read path with its own compatibility
story — a separate PR, not this one); no suppressions; named exported types;
comments ≤1 line; ≤500 lines/file (decompose, never shave); artifacts in
docs/design/notes/270/ NEVER repo root. Logical commits on
held-followed-skip; do NOT push.

## Do NOT touch
gitFingerprint/isSyncableRef; the shredder (apply.ts:833-836) VERBATIM;
composeFollowRepoTransition semantics; retain()'s re-standing arms;
HELD_SKIP_SAFETY_FLOOR_MS; blockersAfterComposer output shape; state-
plane (269's territory — separate in-flight branch; expect rebase);
design 251 buckets; push lane.
