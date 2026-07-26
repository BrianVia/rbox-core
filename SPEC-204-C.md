# SPEC 204-C — lazy git-plan (reduced): C1-narrow + scoped memos + C5 buckets

Authoritative spec: docs/design/204-delta-scoped-publish.md §5 + §6 tests
12-17. Read it fully first. The deferred levers (§5.5) are OUT OF SCOPE —
do not implement delta discovery or cross-repo fingerprint policy changes.

## Changes
1. Kill switch RBOX_GIT_PLAN_LAZY !== "0", read once at planGitSections
   entry; lazy=0 restores today's exact sequence (203's pattern).
2. C1-narrow (§5.3): gate ONLY checkoutJournalBinding +
   recoverAndLandFollowJournal (src/cli/sync-git/plan.ts:419-420) behind
   `await checkoutJournalPresent(root, rel)`. publisherAckBindings
   (:404-417), the !ctx quarantine arm (:393-399), recoveryAllowsSupersession,
   captureObserved/stats stay EAGER and unconditional.
3. C2-narrow (§5.4): hoist the memo helper from
   src/cli/sync-git/apply.ts:408-419 into a shared module (both apply.ts
   and plan.ts import it — do not copy-paste); memo rel→repoCtxFromDisk for
   plan.ts:378,458 only, cleared before the capture pool starts; :502,
   :1271, :1281 stay fresh. realpath(workspaceRoot) resolved once per plan
   run (readStateLineageV1 currently re-resolves per repo — thread the
   resolved value, don't change the engine function's contract for other
   callers).
4. C5 (§5.2): gitPlanStats gains discoverMs, journalPreloopMs,
   fingerprintMs, hygieneMs, otherMs = totalMs − Σ(exclusive buckets);
   carried into recordDetails("git-plan") summary string.

## Tests (§6): 12 (no-journal fidelity: binding/recovery skipped AND
absence-proof, pending-supersession, publisher-ACK byte-identical to
lazy=0; journal present ⇒ identical recovery), 13 (probe-to-mutation race:
journal created after probe ⇒ next plan recovers; no stage-5 arm consumes
journal state), 14 (memo cleared at capture boundary; dir↔pointer flip
mid-plan gets fresh ctx post-capture), 15 (lazy=0 byte-faithful legacy
order), 16 (buckets finite, nonnegative, each ≤ total wall, otherMs
present, summary carries them — do NOT assert sum≈wall), 17 (existing
zero-spawn steady-state pin stays green under lazy=1).
Ambient hygiene: force-delete RBOX_GIT_PLAN_LAZY in beforeEach of every
touched suite.

## Constraints
- Plan output contract unchanged (§5.6): sections, base carry,
  captureObserved/configObserved totality, protectedPending,
  onGitReposDiscovered, the discovery walk itself, slow-path behavior,
  422 force recapture.
- No fingerprint API changes; policy stays "per-decision".

## Acceptance
- bun test src/cli/sync-git/ (git-sync.test.ts is the heavyweight — run it)
- bun run test:affected
- bun run typecheck
