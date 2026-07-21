# 177 — keep-mine executes at confirm time (kill the intent gap)

Status: IMPLEMENTED — v7 ALIGNED (7 review rounds), shipped in PR #390 (merged 2026-07-21); on main awaiting the v1.7.20 train. History: r1/r2 hardened the
deferred-intent model; r3's nine deepening findings triggered the founder
"growing complexity = wrong layer" rule; v4 deleted the intent gap
(synchronous confirm). r4 (gpt-5.6-sol, high) verdict CHANGES-REQUIRED but
affirmed "the synchronous pivot is viable" — all eight findings are missing
CONTRACTS, not architecture, and all are accepted and folded in v5:
409-aborts-with-fresh-preview (r4-1), explicit rider/result contract (r4-2),
durable publication receipt for uncertain ACK (r4-3), lock gate + acquisition
deadline (r4-4), explicit intent-stripping normalizer (r4-5), scratch-ref
bundle pinning + staged-snapshot endpoint (r4-6), honest UX-regression notes
(r4-7), CODEMAP ownership updates in the same PR (r4-8). r5 verdict CHANGES-REQUIRED but "the synchronous architecture remains
viable"; 1c/1d certified faithful (r5-8), 1a/1b tightened per r5-6/7, and the
three substantive holes folded in v6: receipt persists the attempted
gitIncomingKey and reconciles BEFORE any 409 classification with the
exact-key/mismatch policy (r5-1/2/3, receipt scope narrowed to push/pull);
stability identities carry presence bits for every op-state root (r5-4);
pseudo-ref/AUTO_MERGE pin roots derive from the staged copies, never live
rereads (r5-5); test list extended per r5-9. r6 certified §1a/§1b/§1e and the
r5-5 folding; its two remaining capture holes folded in v7: staged in-progress
root presence VETOES publication independently of endpoint equality (r6-1),
and the staged index tree's object closure is pinned into the bundle — stash
WIP derives from the live index and cannot be the only carrier of staged-index
objects (r6-2); receipt removal made atomic-with-or-after the accepted clears
(r6 §1e note). r7 verdict ALIGNED (both foldings certified faithful, no new
substantive hole).

## Problem (field evidence, 2026-07-21, founder's Mac)

176's keep-mine records a resolution intent at confirm time and executes it
on "the next ordinary push". Everything that went wrong in the field lives in
that gap:

- Ambient churn (IDE fetches, linked-worktree agents, routine commits, daemon
  pulls) voided the intent three consecutive times across ~2h — the full
  snapshot binding cannot survive on a live work repo.
- The gap must be defended against remote truth moving (pull preserving
  previewed pending vs newer sections), producing the r1-CRITICAL lineage
  fence, the r2 ingress-path audit, and the r3 composition/representability
  findings — an ever-widening TOCTOU surface across capture, apply, state
  composition, and push.
- Every successful heal tonight had the same shape: quiesce sync, resolve
  atomically, resume — performed by hand with daemon stop/start choreography.

The fix is to make that shape the product: there is no intent gap because
there is no intent.

## Mechanism

### 1. Synchronous confirm

`rbox git resolve <repo> keep-mine --confirm <token> [--force-discard-incoming]`:

1. **Acquire the workspace sync lock, waiting** (bounded, default 60s, with a
   progress line "waiting for the current sync cycle to finish…"). Today's
   instant "daemon/CLI is syncing; retry" refusal becomes wait-then-proceed —
   also fixing tonight's operator papercut.
2. **Re-derive the preview against live state** under the lock: same
   preliminary-report machinery as the preview command. If the re-derived
   report's discard set differs from what the confirm token binds (token
   semantics unchanged: it binds the preview content the user saw), refuse
   with a fresh token and today's "review and confirm again" copy. This is
   the ONLY confirm-vs-live consistency check — and the window it guards is
   milliseconds under an exclusive lock, not minutes of ambient life.
3. **Run the ordinary push pipeline in-process** with the resolution rider:
   capture, final report, `reportAuthorized` (v1.7.18 semantics), preservation
   pins, publish, accepted-ACK pending clear. All 176 safety gates run
   unchanged — they simply run NOW, inside the same lock scope as the
   re-derived preview, instead of on a future push against a drifted world.
4. Outcome is synchronous: success ("published; your repo is the synced truth
   now"), refusal (fresh token + reason), push failure before the commit send
   (network etc. — no resolution state persisted; preservation pins and caches
   written pre-ACK are intentionally durable and harmless), or the
   uncertain-ACK case (§1e).

#### 1a. Rider and result contract (r4-2)

- `PushManifestOptions` gains `resolution?: { repo: string; verb: "keep-mine";
  confirmedReport: ResolutionDiscardReport; authorizedLanes: string[];
  forceDiscardIncoming: boolean }` — the ephemeral, in-memory replacement for
  `record.resolutionIntent`. `GitPlanOptions` receives it verbatim; planner
  admission for keep-mine keys off the rider (plan.ts:724's
  record-intent read is deleted). The rider survives 422 recapture and epoch
  refresh untouched — it binds the CONFIRMED REPORT, not a snapshot; the
  final report + `reportAuthorized` re-run on every recapture.
- `PushResult` gains `resolution?: { outcome: "published" | "refused" |
  "aborted-remote-moved" | "ack-uncertain"; reason?: string; sequence?:
  number }`. The resolver never infers success from `committed` (unrelated
  file changes can commit while the keep-mine candidate was reverted). The
  planner exposes a typed resolution disposition alongside `resolvedPending`
  (today failures surface only as generic deferral reasons, plan.ts:1024)
  that maps 1:1 into `PushResult.resolution`; the rider is retained in
  `PushAttemptState` across resets and passed at the per-attempt planner
  call (push.ts:223/:399) (r5-6). `reportAuthorized` narrows its parameter
  from `GitResolutionIntent` to the `authorizedLanes` it actually uses.

#### 1b. 409 disposition (r4-1, CRITICAL; tightened r5-2/7)

Resolution mode never RETRIES THE RIDER after a 409 — precisely: on 409,
first run §1e receipt reconciliation (the 409 may be our own landed commit
echoed by the transport retry); if reconciliation does not resolve it as
ours, the push aborts the resolution (`aborted-remote-moved`), performs the
ordinary recovery pull WITHOUT the rider (which may legitimately replace or
clear the pending — resolution is already aborted, r5-7), and the CLI
reports: "another machine published while confirming — review the new state
and confirm again" with a fresh preview/token IF pending remains after the
pull, or the post-pull resolved/no-incoming state otherwise. No retry loops
hiding a moving fleet from the user.

#### 1c. Lock contract (r4-4)

- The existing degraded-lock refusal (git-cmd.ts:934: unsupported locking →
  keep-mine refuses) is retained and tested — a lockless handle excludes
  nothing and must not admit a resolution.
- Acquisition gets a wall-clock deadline parameter (default 60s) scoped to
  confirmed keep-mine (sync-mutex today exposes attempts+delay only). The
  deadline bounds ACQUISITION exclusively; once held, no timer ever releases
  mid-work (current wrapper semantics, sync-mutex.ts:313, preserved).

#### 1d. Migration normalizer (r4-5)

State loading spreads unknown record properties intact (config.ts:473/:517,
sync-state.ts:125), so deleting the TypeScript field does NOT shed persisted
intents. An explicit record normalizer strips `resolutionIntent` on load, with
a regression test proving an unrelated repo save also sheds it. Release note
covers the ≤1.7.18-process-still-running overlap.

#### 1e. Uncertain ACK (r4-3)

The server commit lands before local clears are saved (push.ts:651 vs :688+).
If the accepted response is lost (process death, network, state-save failure),
remote truth may exist while local pending survives. Before the commit send,
resolution mode writes a small durable publication receipt — local state, not
wire — `{repo, attemptedGitIncomingKey, attemptedSequence,
confirmedReportHash}`. `attemptedGitIncomingKey` = `gitIncomingKey(candidate)`
(shared.ts:83) of the exact section being published; the report hash alone is
NOT decidable — different local states can produce identical discard reports
(r5-1).

Reconciliation runs at the START of every push and pull while a receipt
exists (scope deliberately narrowed to push/pull — status has no
authenticated manifest path, r5-3), and specifically BEFORE any 409 is
classified: the commit transport's own lost-response retry returns 409 when
the first POST landed (resilient.ts:20, commits.ts:317), so an unreconciled
409 can be OUR OWN successful publish, and §1b must not report it as another
machine (r5-2). Policy (r5-3):

- Head's section for the repo has the EXACT `attemptedGitIncomingKey`:
  accepted-equivalent (even if another writer independently published
  identical state). Run the normal pull/state-proof ordering for the full
  head (unrelated changes apply as usual), then complete the accepted-ACK
  local clears for the repo and drop the receipt.
- Mismatch: a different writer won. Retain pending conservatively, apply the
  head through normal pull, drop the receipt, and surface the fresh-preview
  message only if pending remains after the pull.

Receipt removal is atomic with — or strictly after — the accepted clears
(never before), and an unreadable/unauthenticated head RETAINS the receipt
for the next attempt (r6 note). The user-facing contract for a crashed
confirm is "run rbox push or rbox pull; it reconciles" — never a silent
half-state.

### 2. What gets deleted

- The persisted `resolutionIntent` record field and its entire lifecycle:
  recording, post-capture binding identity comparison, the repoGen +1 fence,
  void-on-snapshot-change, pull-time preservation of previewed pending
  (apply.ts:601 reverts to uniform no-intent behavior), and take-theirs'
  accidental intent copy-forward (moot — nothing to copy).
- Old-CLI compat: daemons/CLIs never exchange intents (they are local state),
  so deletion is wire-invisible. A leftover on-disk intent from ≤1.7.18 is
  ignored and dropped on next state save (one release note line).

### 3. What stays (from 176 + this cycle's reviews)

- Preview/confirm token flow, refusal shapes, plain-English copy — the UX
  contract is untouched; only WHEN execution happens changes.
- Presence-aware op-state classification (r2-4): record/confirm-time refusal
  must count an empty in-progress root directory (bare `rebase-merge/`) as
  in-progress — reuse follow's lstat semantics (follow.ts:428/:550) via a
  shared classifier, replacing bare `readOpState` key enumeration at
  git-cmd.ts:819/:963.
- The record-time branch predicates (git-cmd.ts:887/:896) need no execution
  replay — confirm-time re-derivation (§1.2) IS their re-run.
- Daemon coexistence: the daemon's ordinary pushes never carry resolutions
  (nothing persisted to carry); a daemon push racing the lock simply serializes
  behind it.

### 4. Capture stability rider (r3 findings 1-2, survives the pivot)

Even a synchronous push races concurrent git mutation for the seconds capture
takes. Two hardenings, scoped to keep-mine's capture (ordinary pushes get the
first as a separate follow-up since it is a latent general defect):

- **Bundle roots are pinned to the captured OIDs via scratch refs** (r4-6:
  raw `<oid> refname` pairs are not a valid `git bundle create` input form).
  Extend the existing capture-unique scratch-ref machinery (pins.ts:26): root
  every recorded ref OID through a synthetic ref, bundle exactly those
  synthetic roots — a ref moving mid-capture can no longer produce a bundle
  whose contents disagree with the advertised section refs
  (capture.ts:224 vs :242).
- **Stability endpoint against the STAGED snapshot** (r4-6): before
  pins/publish, compare against a coherent snapshot derived from the staged
  artifacts — the staged index bytes' identity (NOT the live index that
  capture.ts:274 currently reads for `indexTree`, which can describe a
  different state than the uploaded artifact), staged op-state, and the
  recorded refs/HEAD. Both the staged and live identities include a
  PRESENCE BIT for every op-state root (r5-4): `readOpState` enumerates
  files only (refs.ts:31) and cannot see a bare `rebase-merge/` created
  mid-capture, so presence is observed via follow's lstat semantics
  (follow.ts:428) on both sides of the comparison. Live re-reads must equal
  the staged snapshot; mismatch → refuse with "your repository changed while
  publishing — run the command again"; nothing published. `indexTree`
  computation moves to the staged bytes as part of this (fixing the existing
  incoherence). The retry loop is the user pressing enter, on a seconds-wide
  window, not intent surgery.
- **Pin roots derive from staged copies** (r5-5): `collectPinShas` currently
  rereads live pseudo-ref files (MERGE_HEAD, AUTO_MERGE…) during pin
  collection (pins.ts:86, capture.ts:232) — an A→B→A flip there can pin B
  while the uploaded staged artifact references A and the endpoint still
  passes. Pseudo-ref and AUTO_MERGE roots are extracted from the STAGED
  op-state copies, and those oids join the scratch-ref bundle roots.
- **Staged in-progress presence VETOES, independent of equality** (r6-1): an
  in-progress root (even a bare directory) present in the STAGED snapshot
  refuses publication outright — equality with a live snapshot that has the
  same root present proves stability, not safety. This mirrors follow's
  root-presence veto (follow.ts:550) on the publish side.
- **Staged index closure is pinned** (r6-2): the stash WIP commit derives
  from the LIVE index (capture.ts:229), so it cannot be the carrier of
  staged-index objects — an index A→B→A around stash creation yields WIP(B)
  while the uploaded artifact and `indexTree` describe A, leaving A-only
  blobs out of the bundle. The staged index tree (and, for the raw/unmerged
  fallback of identity.ts:38, every object the staged index references) is
  pinned as a bundle root alongside the scratch refs.

## Acknowledged UX regression (r4-7)

The deferred model gave one thing synchronous confirm loses: daemon-side
retry after a network failure post-confirmation. Now the foreground process
must survive capture/upload/commit, and a network failure means the user
re-runs the command (fresh preview if anything moved). This is the right
trade — the "retry" the old model provided was the same mechanism that voided
on every ambient change, so in practice it retried into refusals. Confirm
shows push-style progress; Ctrl-C before the commit send is safe (receipt not
yet written or reconciled-away); Ctrl-C after is the §1e uncertain-ACK case.
Offline confirm was never supported (resolver setup requires the
authenticated remote, git-cmd.ts:605).

## Non-goals

- No change to take-theirs semantics (its stale-intent copy-forward dies with
  the intent field itself).
- No retroactive handling of intents recorded by ≤1.7.18 beyond the §1d
  normalizer.
- The general ordinary-push bundle-pinning fix is filed as its own follow-up,
  not implemented in this cycle's diff (keep-mine's capture gets it now).
- CODEMAP ownership lines for push/plan/resolution-intent/apply are updated
  in the implementation PR (r4-8), not tracked here.

## Tests the implementation MUST write

1. Confirm executes synchronously: quiescent workspace, `--confirm` →
   published sequence, pending cleared, exit 0, no daemon involvement.
2. Ambient churn immunity: start confirm while a background loop commits and
   rewrites the index in the repo → either a clean publish (stability
   endpoint held) or the "changed while publishing" refusal; NEVER a stale
   discard; a bounded number of retries succeeds.
3. Lock wait: confirm issued while a push holds the sync lock → waits, then
   proceeds; bounded-wait expiry produces a plain-English timeout message.
4. Preview-drift refusal: mutate the repo between preview and confirm so the
   discard set changes → refusal with fresh token, old token dead.
5. Presence-aware op-state: bare empty `rebase-merge/` at confirm →
   in-progress refusal (both preview and confirm doors).
6. Bundle pinning: move a branch mid-capture (test hook between ref record
   and bundle) → for an UNRESTORED move, BOTH hold (r5-9): the bundle
   contains the captured OID (scratch-ref roots) AND the stability endpoint
   refuses; the published section's refs always correspond to bundle
   contents.
7. Leftover ≤1.7.18 intent on disk: stripped by the §1d normalizer, dropped
   on an UNRELATED repo's save too, no behavior change.
8. take-theirs unaffected: full suite regression.
9. Receipt reconciliation (r5-9): lost-ACK then transport-retry-409 →
   reconciled as ours, clears complete, no "another machine" message;
   same-report/different-section → receipt key mismatch handled as
   different-writer; later head with unrelated changes → normal pull
   ordering applies them before clears; exact-key match from an independent
   identical writer → accepted-equivalent; mismatching writer → pending
   retained, fresh preview only if pending remains.
10. Capture coherence (r5-9, extended r6): deterministic index replacement
    mid-capture → endpoint refuses; op-state add/change/delete and
    BARE-DIRECTORY creation mid-capture → endpoint refuses (presence bits);
    bare root created BEFORE staged sampling and stable through the endpoint
    → staged-presence veto refuses (r6-1); staged pseudo-ref ABA (MERGE_HEAD
    A→B→A during pin collection) → pins derive from staged A, bundle
    coherent, publish proceeds; index A→B→A around stash creation → staged
    index closure pinned, bundle contains every staged-index object (r6-2);
    HEAD drift → refuses; scratch refs cleaned up on every path.
11. Receipt retention: an unreadable or unauthenticated head during
    reconciliation retains the receipt; receipt removal happens atomically
    with or strictly after the accepted clears.
