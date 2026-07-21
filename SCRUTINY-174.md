# SCRUTINY-174 — post-implementation drift detection

Scope: drift of the design-174 implementation from
`docs/design/174-apply-side-perf-and-held-repo-livelock.md` (ALIGNED v4) and the
5 INVIOLABLES in `SPEC-174-IMPL.md`. Read-only pass; diff = `git diff HEAD`.

Verdict: **CLEAN** (1 MINOR cosmetic note; no fix round required).
Typecheck green; `held-skip`/`pending-supersession`/`publisher-tombstones`/
`held-attempt-state` (40 pass) and `follow`+`git-sync` (201 pass, 2 skip) green.

Counts: CRITICAL 0 · MAJOR 0 · MINOR 1

---

## Inviolable verification (all PASS)

### I1 — P + sidecars byte-intact through every pre-ACK failure; clear only at accepted ACK — PASS
- The only clearing site is the accepted-commit ACK transition in
  `src/cli/sync/push.ts:686-754`, keyed off `gitPlan.supersededPending`:
  `pendingAfterAck` deletes the rel (`:687-688`), `ackPartial=null` (`:693`),
  `ackAttempt=null` (`:694`), `ackDeferrals={apply:null}` bound to the predecessor
  via `orderedDeferralUpdates` (`:696-699`). Reached only after `epochStale`,
  `conflict`, and `unsatisfiedBlobs` are ruled out (`:656-672`).
- Pre-ACK failure paths carry P byte-for-byte:
  - capture-fail → `plan.ts:858-859` → `deferOne` (`:453-461`) sets `out[rel]=pending[rel]`;
    candidate not in `captured`, so the proof loop (`plan.ts:881`) discards C and
    `finalizedOutgoing[rel]=p` (`:887`).
  - 422 / `needsUpload` → `reuploadOutcome` returns before the ACK block (`push.ts:603-604,665-672`).
  - commit-error / thrown → propagates out of the `try` (`:582/:773`); no clear ran.
  - 409 → `pull-first`/`repair-conflict` return (`:659-664`).
- The pre-ACK sidecar-visibility state-save (`push.ts:482-498`) writes only
  `bases/pending(verbatim)/removed/resolutions/deferrals`; every pending rel is in
  `protectedPending` (`plan.ts:227` = all pending keys) so the capture-observed
  deferral loop (`push.ts:427`) and `writeBytesChanged` (`:449`) both `continue` past
  it. `partial`/`attempt` are never in this packet.
- `settleCommittedBranchArtifacts` post-settlement attempt rebind
  (`apply.ts:1755-1793`) copies pending/partial/deferrals/BASE byte-for-byte and
  mutates only the local `attempt` sidecar (design-sanctioned).
- Evidence: test 7 (`git-sync.test.ts:104`) asserts `JSON.stringify({pending,partial,
  attempt,deferrals})` byte-equality across upload-fail, commit-error, and 409;
  the rewritten 422 test (`:275`) asserts full-record byte-equality.

### I2 — proof subject is the FINAL normalized candidate; GIT_NO_REPLACE_OBJECTS on every proof subprocess; all 8 lanes; fail-closed — PASS
- Subject is `finalizedOutgoing[rel]` (post-normalization) in
  `plan.ts:874-882`; `provePendingSupersession` gets `candidate` = that object and
  requires `captured.includes(rel)` (fresh capture, not carry).
- `GIT_NO_REPLACE_OBJECTS:"1"` (with `GIT_NO_LAZY_FETCH`) in `literalGraphEnv`
  (`pending-supersession.ts:125-128`) is passed to the only ancestry/peel
  subprocesses — `rev-parse --verify ^{commit}` and `merge-base --is-ancestor`
  in `equalOrFastForward` (`:130-143`). `reachability.ts:32` graphEnv was updated
  to add the same flag. `indexIdentityV2` uses `ls-files` (reads the index directly,
  no object-DB ancestry) so it has no replace surface, and projects pending/candidate
  identically. Validated by `pending-supersession.test.ts` "local replace refs cannot
  launder ancestry" (proves ancestry true WITHOUT the flag, proof still returns false).
- All 8 lanes present and exact per §4.2: HEAD + refScope (`:156`), config (`:157`),
  op-state map (`:158`), branches FF-or-equal (`:163-164`), tags exact (`:165-166`),
  stash exact (`:165-166` + belt `:171`), semantic index via `indexIdentityV2` (`:172-176`).
- Fail-closed everywhere: `validateGitSection` (`:154`), shallow lstat (`:155`),
  unknown ref namespace → `return false` (`:167-169`), missing object / any throw →
  outer `catch { return false }` (`:177-179`); `equalOrFastForward` non-1 exit rethrows
  into that catch (`:139-142`).

### I3 — normalizer takes P tombstones+generation as retention; high-water max(advertised,P,candidate); authoring-predecessor advertised-based — PASS
- `normalizeOutgoingGitSections` passes `pendingSection` as the retention arg and
  installs P by identity only on `gitIncomingKey` equality (`publisher-tombstones.ts:184-188`).
- `normalizePublishedGitSection(advertised, candidate, now, pendingRetention)`:
  `generation = max(sources)` over advertised/pending/candidate (`:72-73`); chains
  merged from all three sources (`:78-88`); P validated via `acceptedFields`
  (`:36-48`). Authoring-predecessor block gated on `advertised?.refScope==="all" &&
  candidate.refScope==="all"` and iterates `advertised.refs` (`:108-122`) — stays
  advertised-based.
- Evidence: test 6 (`publisher-tombstones.test.ts`) — P-only gen 41 chain retained,
  high-water becomes 42 after the advertised→candidate main supersession.

### I4 — MERGED typed blocker union; non-empty + all-allowlisted; placement after recovery/P-settlement/partial-revalidation; binds all §4.1 inputs; fail-open — PASS
- Merged set: classification blockers from `FollowResult.blockers`
  (`follow.ts` publishRefPlane builds ref-plane/indeterminate/checkout blockers),
  plus composer (`apply.ts:1298-1300`), plus checkout blocker (`:1271`), plus
  protocol hold (`:975-977`). `recordAttempt` stores the sorted merged set (`:1109-1128`).
- `heldBlockersAllowSkip` requires `length>0 && every(local-commits|local-stash)`
  (`held-skip.ts:32-35`); the skip predicate additionally requires `pend`,
  `priorAttempt`, `priorInputsMatch`, `!priorFloorElapsed`, `standingApply`
  (`apply.ts:1103-1104`).
- Placement: skip check at `apply.ts:1103` runs strictly after journal recovery
  (`:527-577`), busy check (`:583`), follower protocol prepare (`:963`), P-settlement
  loop (`:1014-1087`), and partial revalidation (`:816-830`); the `afterHeldSkipPrepass`
  seam (`:1088`) sits immediately before it.
- Attempt binds every §4.1 input (`GitHeldAttempt`, `config.ts`): `incomingKey`,
  `localFingerprint` (+`fingerprintVersion`), sorted `reflogs` path/digest,
  `repoIdentity`, `stateNonce`, `baseOriginsHash`, `partialDisposition`, `at`;
  `heldAttemptMatches` compares all of them and enforces the racy-clean margin
  (`held-skip.ts:113-124`).
- Fail-open: `observeHeldInputs` returns `undefined` on any read/instability
  (`:65-105`) → no attempt / no skip; reflog path traversal guard (`:73`).
- Evidence: test 3 (local-edits/index/operation never skip), test 10 adversaries
  (graft unsupported, indeterminate/worktree-ownership never skip, composer-only
  and empty sets never skip), test 15 (no BASE mutation on the final skip).

### I5 — no new BASE authority arm / no direct BASE writes; branch mutations via typed planner; B journal gate exhaustive `never` — PASS
- B re-establishes truth through the existing capture→normalize→publisher-ACK path;
  BASE advances only through `composeRepoBase` (`apply.ts`, `push.ts` ACK proofs).
  Clean-apply branch mutations route through `planBranchTransition` /
  `commitPlannedBranchTransition` (`apply.ts:1364-1406`).
- `journalAllowsPendingSupersession` switches over `JournalRecoveryResult["status"]`
  with a `const exhaustive: never = status` default (`pending-supersession.ts:21-37`);
  `defer`/`human-intervened`/`fresh-quarantined` return false. Evidence: test 11
  "journal gate is exhaustive over every recovery disposition".

---

## Auxiliary checks (all PASS)
- Kill switches default ON and actually gate: `gitHeldSkipEnabled` (`held-skip.ts:14-15`)
  gates `apply.ts:1103`; `gitPendingSupersedeEnabled` (`pending-supersession.ts:18-19`)
  gates `plan.ts:664`. Exact-zero only (verified by tests).
- 1h floor constant `HELD_SKIP_SAFETY_FLOOR_MS = 60*60*1000` (`held-skip.ts:12`);
  fingerprint-miss WARNING `git-sync WARNING <rel>: held-skip fingerprint miss`
  (`apply.ts:1125-1126`), same-outcome refreshes `attempt.at` via `createHeldAttempt`
  default (`:1128`).
- lastSeen ordered refresh on skip: `setDeferral` → `nextDeferral` preserves
  `deferredSince`/`reasonSince`, refreshes `lastSeen` bound to the predecessor
  (`shared.ts:120-131`); skip returns `"skipped"` (`apply.ts:1106-1107`).
- `skippedHeld` counter reaches the pull summary: `metrics.skippedHeld =
  metrics.results.skipped` (`apply.ts:1581`; `"skipped"` returned only at `:1107`)
  → `formatGitApplyMetrics` (`:244`) → `pull.ts:270` `recordDetails("git-apply", …)`.
- Test 1 fixture uses a REAL pull transition (receiver `index.lock` quiescence
  creates P; off-branch stash; omitted prior branch), not the retracted seq-83
  narrative; asserts the four ACK clears exactly, retained prior branch + origin in
  BASE, and follower-C convergence (`git-sync.test.ts:146-233`).
- Spot-checked tests 1/6/7/10/11 assert byte-equality / identity / exact mappings,
  not "a call happened" (e.g. test 8 `plan.gitRepos?.[rel]).toBe(pending)` identity;
  test 7 JSON byte-equality; test 11 exact status→bool table).

---

## Findings

### MINOR-1 — indeterminate ownership proofs co-emit a `local-commits`/`local-stash` blocker alongside the `indeterminate` blocker (design §4.1 says "never")
`src/cli/sync-git/follow.ts:691-696` and `:751-759`: on an `indeterminate`
ownership / no-drop proof the classifier pushes the required non-allowlisted
`indeterminate` blocker AND sets a hold (`local-commits`/`local-stash`) that later
becomes a ref-plane blocker (`:949-954`). Design §4.1 states indeterminate proofs
should "produce an `indeterminate` blocker outside the allowlist, never a
`local-commits` or `local-stash` blocker."

Impact: none in practice. `heldBlockersAllowSkip` uses `every(allowlisted)`, and
`sortedTypedBlockers` dedups by canonical value (the two blockers are distinct
objects), so the non-allowlisted `indeterminate` blocker always survives into
`attempt.blockers` and vetoes any skip. Verified by test 10
(`local-commits + indeterminate/unreadable` never skips). This is a literal
wording drift, behaviorally safe.

Minimal fix (optional, cosmetic): when the marker is indeterminate, either omit the
`local-commits`/`local-stash` co-emission from the typed set (keep only the
`indeterminate` blocker) or leave as-is and adjust the design wording to "co-emits";
no behavior change either way.
