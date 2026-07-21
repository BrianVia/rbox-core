# SCRUTINY-176 — post-implementation drift detection

Scope: uncommitted tree on `176-wedge-ux`. Method: traced every inviolable code
path (not just suites). `bun run typecheck` clean; ran the 176 suites + every
frozen-grammar consumer suite (git-cmd, resolution-intent, held-skip,
status-view, git-sync, follow, sync-cmd, doctor-cmd, daemon-deferral-visibility,
status-cmd, reset-consent, base-composer-structure, grammar-freeze) — all pass.

## Inviolable verdicts

### I1 — confirmation mutates only the sidecar; clears only at accepted ACK — HELD
- Confirmation's sole state write is `applyStateSavePacket` with
  `newRecord = { ...inputRecord(record), resolutionIntent: intent }`
  (git-cmd.ts:992-1002). `inputRecord` strips only `repoGen` (sync-state.ts:125-128),
  so BASE/pending/partial/attempt/deferrals are preserved verbatim; no ref/index/
  stash/pin mutation on the keep-mine confirm path (take-theirs' `pinDisplaced`/
  `quarantineLocal` at git-cmd.ts:1036-1042 are gated behind `verb!=="keep-mine"`).
- Token binds the full set: `GitResolutionBinding` carries stream, stateNonce,
  incomingKey(P), repoGen, refs, reflogs, head, index, opState, stash,
  oracleReceipt, config(ownership+read+hash+shape), effectiveRefScope,
  capturePolicy, repoKind, repositoryIdentity (config.ts + resolution-intent.ts:96-118);
  token = hash of that binding (git-cmd.ts:160-162).
- Recomputed immediately pre-write: `finalBinding` recomputed with `boundary:true`
  and byte-compared to the confirmed snapshot at git-cmd.ts:977-983, plus git-busy/
  op-state/worktree/indeterminate re-checks (945-968) after a fresh state reload.
- Clears exist ONLY in the accepted-ACK block (push.ts:703-777): pendingAfterAck,
  ackPartial, ackAttempt, ackDeferrals, ackResolutionIntent all in one post-accept
  `saveStateSource`. Intent clear is predecessor-bound (`clearIfSnapshot`,
  sync-state.ts:239-249) so a CAS recompute cannot consume a newer confirmation.
- Every pre-ACK failure path leaves intent+P intact: binding-mismatch at plan time
  carries pending + defers, clears nothing (plan.ts:758-766, 999-1042); the apply
  guard `records[rel]?.resolutionIntent && pend → unchanged` prevents pull from
  applying/clearing P (apply.ts:599-604); intent repos stay in `protectedPending`
  (Object.keys(pending)), so push.ts skips their deferral writes
  (push.ts:429, 452). 409/422/epoch/crash all route through the loop without a
  git-state save. Verified: no early clear on capture/upload/422/commit/409/crash.

### I2 — push executes the intent correctly — HELD
- Intent forces capture unconditionally via `processRepoSlowPath(..., forceCapture,
  resolutionIntent:true)` (plan.ts:754-758); busy/op-state/journal still refuse
  (git-cmd.ts:803-810 at confirm; plan.ts:324-335 journal guard at push).
- Directional report `finalResolutionReport` over the FINAL normalized candidate
  (`finalizedOutgoing[rel]`) with the closed lane list — branch equal-or-descendant,
  everything else exact-directional (resolution-intent.ts:201-329); `reportAuthorized`
  only exempts lanes the intent recorded (resolution-intent.ts:331-335).
- Tombstones excluded from the report (no tombstone lane in `reportCore`) AND
  carried by the normalizer: `normalizeOutgoingGitSections` passes the pending
  section as `pendingRetention`, and `normalizePublishedGitSection` merges P's
  tombstone chains+generation (publisher-tombstones.ts:58-166). Carry confirmed for
  the intent path (candidate has a fresh incomingKey ≠ P, so it takes the
  retention branch, not the verbatim-carry branch at line 184).
- Pins durable BEFORE commit: `pinDisplaced("keep-mine:rel", class:"human")` over
  every locally-reachable discarded oid runs inside `planGitSections`
  (plan.ts:1044-1057) — i.e. the `git-plan` phase, before encrypt/upload/commit;
  a pin throw aborts the attempt (fail-closed). `resolvedPending.add` only after pins.
- Refused shapes refuse with plain copy and clear nothing: BASE-present/pending-
  present/local-absent branch (git-cmd.ts:872-881); reserved-173 current-checkout
  divergent, refused regardless of force (882-893); no-P → typed `no-incoming`
  (789-798). All `emit(refused)` + `return 1`, no state write.

### I3 — held-skip neutralization — HELD
- `blockersAfterComposer` gates on `disposition==="pending"`, `heldBlockersAllowSkip`
  (all classification blockers local-commits/local-stash), AND `checkoutComplete`;
  maps each `composedFollow.holds[i]` ref-for-ref to a `provenance:"ref-plane"`
  classifier via code pairs (local-commits↔missing-branch-proof, local-stash↔
  missing-safe-ref-proof) — never a reason string (held-skip.ts:46-89). Unmatched
  holds persist as typed composer blockers; `mismatched-*` codes never map (stay
  blocking). Wired at apply.ts:1323-1328 with `settledProof.lockedProof.checkoutComplete`
  and `composedFollow.holds`. Vacuity guard keeps a bare pending disposition blocking.

### I4 — frozen grammars — HELD
- Shared `git deferred …` line (`renderGitDeferralLine`) byte-unchanged; the
  companion is a separate status-only function never written to logs/diagnostics
  (status-view.ts:443-463). JSON path unchanged (gitDeferralsCmd/serialize).
- Human-clause suffixes append only to prefix-matched lines (config skipped ×7,
  CONFLICT ×2, removed ×1, pending-carry ×1) + the new superseded clause ×1; the
  `applied`/`followed` exact-match lines are untouched. `design176-grammar-freeze.test.ts`
  pins all 12 consumers named in §3 and asserts the suffix counts (7/2/1/1/1 = 12).
- doctor redaction test updated to the new suffixes and still fail-closed
  (doctor-cmd.test.ts). Consumers keyed on `startsWith`/anchored prefixes stay valid.

### I5 — no forbidden authority — HELD
- keep-mine folds through the ordinary capture → publisher-ack arm (push.ts ACK
  builds `publisher-ack` proofs, not manual); no `manual`/`lockedProof` authority
  minted on the keep-mine path (that path in git-cmd.ts:1044-1136 is take-theirs
  only). No supersession-lane edits (intent repos `continue` before
  `pendingSupersessionCandidates`). No A/P artifact invention.

## Findings (all MINOR — no CRITICAL, no MAJOR)

1. MINOR (copy) — git-cmd.ts:878. Refusal `keep-mine cannot publish branch
   absence for <ref> while BASE still holds it; restore or resolve that branch
   first` leaks the plumbing token "BASE". Fix: `…while rbox still tracks it on the
   remote; restore or delete that branch, then retry.`

2. MINOR (copy) — git-cmd.ts:890. `resolve this reserved two-writer case with Git
   before retrying` uses internal jargon ("reserved two-writer case"). Fix: `local
   and incoming history have both moved on for <branch>; reconcile them in Git
   (merge/rebase), then retry.`

3. MINOR (copy) — git-cmd.ts:507 + resolution-intent lane details. The preview
   renders raw lane keys and `subsumed`/`not-subsumed` dispositions
   (`branch:refs/heads/x: not-subsumed — …`) to the user. Design permits the
   report as evidence, but the disposition words read as plumbing. Fix: map
   subsumed→"kept", not-subsumed→"would be replaced", indeterminate→"couldn't be
   compared", and drop the `branch:`/`ref:` key prefixes in the human render only.

4. MINOR (behavior/UX) — plan.ts:758-766. A binding that can never re-match (repo
   permanently changed after confirm) leaves the intent installed indefinitely,
   re-deferring each push with "keep-mine snapshot changed…" and never
   auto-clearing. Fail-closed and inert (not an I1 violation — intent never
   executes), but a dead-end until the user re-runs keep-mine or take-theirs.
   Optional fix: surface the stale intent in `status --git` companion copy so the
   user knows to re-confirm, or clear it on a proven bound-input divergence.

## Test-coverage note
Suites cover the intent lifecycle, the pre-ACK failure table, refused shapes, the
directional report + pins, per-consumer grammar freeze, and the held-skip provenance
gate incl. the non-opportunistic rig assertion (git-held-livelock rewritten to two
idle explicit pulls). Design §5.7 field validation on the live savvy-core wedge is
inherently manual and cannot be asserted here.

## Verdict: CLEAN
