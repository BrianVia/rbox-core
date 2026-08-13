# 236 — Concluded-op litter must not defer: corroborated in-progress + named refusals

Status: DRAFT r6-slim (task #20; fossil-disposal product decision in §3.3
still needs the founder's explicit yes before merge). r1-r5 were a codex
adversarial loop reaching ALIGNED on a wider design; the founder then
invoked step-out-a-layer and rounds 3-5's entire subject — durable
persistence of a "which file wedged you" sample — was CUT: it instrumented
the permanent-wedge state this design eliminates. Also cut: boundary
fossil value/set comparison (the waiver never reads fossil values; real
ops announce themselves via in-progress markers). What remains: the table
change, the waiver widening at three sites, the epoch bump, a
worktree-qualified token in the existing log detail, and the field-wedge
fixtures.

## 1. Problem

Three independent wedges on one night, all the same class: a file that git
left behind after a **finished** operation made the deferral classifier treat
the repo as mid-operation forever.

Field evidence (docs/papercuts.md, STATUS.md 2026-08-13 section, issue #647):

- Mac savvy-core: stale `AUTO_MERGE` with **no** `MERGE_HEAD` → permanent
  `local-operation` deferral.
- savvy-core-pr7 linked worktree: stale `REBASE_HEAD` with **no**
  `rebase-merge/` or `rebase-apply/` → its repo lane wedged; the operator
  could not tell WHICH of 17 worktrees was the cause because the deferral
  detail names only the file rel, never the worktree.
- The wedge cost hours because `rbox status` says only "A Git operation is
  active or changed here" — no file, no worktree, no path.

Design 126 §"REBASE_HEAD" explicitly deferred reclassifying `REBASE_HEAD`
until "actual field data" arrived (docs/design/126-opstate-breadcrumb-waiver.md:48-53,
restated in src/engine/manifest-validate.ts:289-293: "git unlinks it on both
finish and abort"). The field has now falsified that assumption. This doc is
that promised re-review, plus the naming requirement.

## 2. Root cause, stated once

The op-state predicate is a **pure table lookup**
(`OP_STATE_CLASSIFICATION[root]`, src/engine/manifest-validate.ts:294-308).
No consumer ever corroborates a marker file against git's own definition of
"operation in progress" (git's `wt_status_get_state`): `MERGE_HEAD` present,
`CHERRY_PICK_HEAD`/`REVERT_HEAD` present (sequencer), or a
`rebase-merge/`/`rebase-apply/` directory present. Everything else is a
fossil no `git <op> --continue/--abort` ever consumes.

`REBASE_HEAD` is the one row where the table and git disagree: git treats the
rebase **directories** as the in-progress state; `REBASE_HEAD` is a
breadcrumb git *usually* unlinks — but demonstrably not always (interrupted
rebase in a linked worktree). Codex verified against git's sequencer source
and git-rebase docs: no supported flow exists where `REBASE_HEAD` is present,
both rebase dirs are absent, and `--continue`/`--abort` remains possible.

## 3. Change

### 3.1 Reclassify `REBASE_HEAD` as a breadcrumb (one-line table change)

`src/engine/manifest-validate.ts:295`: `REBASE_HEAD: "in-progress"` →
`"breadcrumb"`. The in-progress set becomes exactly git's own
`wt_status_get_state` inputs: `MERGE_HEAD`, `CHERRY_PICK_HEAD`,
`REVERT_HEAD`, and the three dirs (`rebase-merge/`, `rebase-apply/`,
`sequencer/`). A live rebase is still in-progress — via its directory, which
is the marker git itself checks (design 177's bare-empty-root rule stays).
This automatically heals all consumers of the shared predicate
(follow-classify `liveInProgress`, resolve-command both doors, capture,
adopt-git's gate) — same shape as #620's MERGE_MSG/AUTO_MERGE move.

### 3.2 Widen the breadcrumb waiver — classifier AND executor AND boundary

The Mac wedge (stale `AUTO_MERGE`) was NOT fixed by #620 because
classification ≠ waivability. Three sites enforce ORIG_HEAD-only today and
all three change together (r1 CRITICAL: the doc originally missed the last
two):

a) **Classifier** (`src/cli/sync-git/follow-classify.ts:157-176`): the
   mismatch loop routes a mismatch at ANY breadcrumb-classified root into
   `breadcrumbMismatches` instead of `reasons.add("local-operation")`. All
   veto gates (`follow-classify.ts:196-216`) stay exactly as-is — if ANY
   in-progress marker is present, nothing is waived (design 126's core rule).

b) **Waiver executor** (`src/cli/sync-git/follow.ts:743-754`): today it
   throws unless mismatches ≡ exactly one ORIG_HEAD. New shape: at most one
   ORIG_HEAD mismatch → `preserveOrigHead` exactly as today (its act, lock,
   crash recovery, and forensic log at orig-head.ts stay ORIG_HEAD-owned and
   unchanged); any other breadcrumb mismatches require **no execution-time
   action** — §3.3 explains why. Zero-or-many non-ORIG_HEAD mismatches are
   legal; the "unexpected breadcrumb waiver shape" guard becomes "ORIG_HEAD
   appears in mismatches ⇔ preservation ran".

c) **Locked-boundary proof** (`src/cli/sync-git/follow.ts:992-999`): today
   it hard-codes the same one-ORIG_HEAD shape. New rule, **automatic follows
   only** — the existing `!opts.manualResolution` scoping stays exactly as
   it is, because the classifier deliberately never sets `breadcrumbWaived`
   under manual resolution (follow-classify.ts:207) and confirmed take-theirs
   instead clears `local-operation` via its own snapshot-bound second proof
   (follow-classify.ts:217); a literal unconditional rule would refuse every
   confirmed take-theirs with a fossil present, regressing 126. For
   automatic follows: the boundary re-classification must be waived AND
   ORIG_HEAD ∈ its mismatches ⇔ `origHeadPreservation` exists. No fossil
   value/set comparison between initial and boundary classification
   (r5 step-out cut): the waiver decision never reads fossil VALUES — only
   whether corroborated in-progress markers exist. A real git operation
   starting mid-flight creates an in-progress marker, which (a) vetoes
   `breadcrumbWaived` at the boundary whenever any breadcrumb activity is
   in play, and (b) otherwise defers through the mismatch loop exactly as
   on the initial classification. ORIG_HEAD alone needs value stability,
   and its preservation lock already provides it.
   **Scope note (impl review, codex):** an in-progress marker whose value
   EQUALS base's or incoming's op-state entry produces no mismatch and
   commits — on the boundary AND on the initial classification, today on
   main, unchanged by this design. That is the op-state plane's deliberate
   base/incoming diff semantics (the follow conforms op-state to incoming
   anyway); whether presence-regardless-of-value should defer is a
   pre-existing question, tracked with the git-resolve rig-suite design
   candidate, NOT silently changed here.
   The boundary failure detail names the actual rels instead of the
   current hard-coded "differs at ORIG_HEAD" (:993 lies today whenever the
   mismatch was MERGE_MSG — small truthfulness fix riding along).

Net predicate, one sentence: **a repo defers for `local-operation` iff a
marker git itself would treat as in-progress is present; fossils alone never
defer, with or without mismatches.**

### 3.3 Fossil disposal policy — an explicit product decision (r1 findings 2+3)

The r1 draft claimed "no litter deletion"; that was false. Op-state
conformance — deleting live entries absent from the staged incoming state —
already happens on every successful apply, and a waived receiver-only fossil
**is deleted by the existing owners** when checkout completes. Those owners,
named precisely (r2 finding: the successful-follow path does NOT call
`restoreOpState`):

- `commitCheckout` via `restoreOpStateWithCrash`
  (src/engine/git/checkout-txn.ts:581, :959) — the successful-follow
  physical-effect owner;
- `restoreOpState` (src/engine/git/refs.ts:104-110) — the legacy engine
  apply path (src/engine/git/apply.ts:728);
- journal recovery / rollback / quarantine conform or remove op-state as
  part of their existing crash contracts.

That the conformance primitive exists twice (`restoreOpState` vs
`restoreOpStateWithCrash`) is a pre-existing duplication; consolidating it
is out of scope here and goes on the thermo-sweep roadmap (task #15), not
into this change. This design makes the conformance behavior the explicit,
intended self-heal:

- **Decision proposed:** concluded-op fossils (`AUTO_MERGE`, `MERGE_MSG`,
  `REBASE_HEAD` after §3.1) are disposable. Rationale: no git command
  consumes them (`--continue`/`--abort` read the in-progress markers, all of
  which are absent by definition of waived), and their referents are not the
  last handle to work — `REBASE_HEAD`'s commit is in the reflog; `MERGE_MSG`
  is a draft message; `AUTO_MERGE`'s tree was only meaningful while the merge
  it belonged to was live. This is exactly why ORIG_HEAD is different and
  keeps design 126's preservation machinery: it CAN be the last durable
  handle to receiver-only work (126:106-113). Classification now cleaves
  into: ORIG_HEAD = preserved breadcrumb; all other breadcrumbs = disposable
  fossils; in-progress = never touched while present.
- No new deletion authority: the owners above remain the only code that
  removes op-state entries, in the same transactions they always ran in.
- Until the founder ratifies this decision the design does not ship —
  deleting anything under `.git`, even fossils via an existing owner, is a
  behavior call, not an implementation detail.

### 3.4 Refusals and deferrals must name the litter — privacy-bounded

- The classifier detail (`follow-classify.ts:173`) becomes a **gitdir-internal
  token**, never a filesystem path: for a linked worktree,
  `worktrees/<name>/<rel>` where `<name>` is the basename of the worktree's
  gitdir under `commonDir/worktrees/`; for the primary, `<rel>` alone. Built
  by segment concatenation — never `path.relative` over resolved absolute
  dirs, which can contain `..`/external components (r1 finding: gitdir
  containment is not proven anywhere, shared.ts:395-401). A gitdir-internal
  token is workspace-safe by construction.
- Carriers are the EXISTING prose ones only: the classifier detail string
  (flowing to the daemon log line, apply.ts:1335, and the held-attempt
  `TypedBlocker.detail`) and the boundary failure detail. The
  resolve-command privacy rule (resolve-command.ts:1077-1083, pinned by
  git-cmd.test.ts:804) is untouched — non-artifact details stay suppressed
  there.
- **Cut by the r5 step-out** (was: durable `GitDeferral.opStateSample` +
  codec coverage + differential/compat fixtures + a 4-hop plumbing seam +
  re-stamp preservation + status projection change — three review rounds of
  persistence machinery): that whole apparatus served the state this design
  ELIMINATES. After §3.1-3.3, fossils never defer, so `local-operation` only
  ever shows real operations, which finish and self-clear; the permanent
  unnamed wedge cannot recur. The daemon log's worktree-qualified token
  covers the residual diagnostic need. Deletion condition met before birth.
  If field evidence ever shows real operations wedging operators for hours,
  add durable naming THEN, with that evidence as the spec.

### 3.5 Held-skip convergence (the #620 leftover)

#620's commit body records that held-skip re-stamps the same deferral
(`retainHeldRepo`, src/cli/sync-git/apply.ts:456-468); a reclassification
alone changes no bytes on disk, so the disk fingerprint still matches and
already-wedged repos would stay skipped forever.

Change: bump `GIT_FINGERPRINT_SCHEMA_VERSION` (fingerprint.ts:8, 7→8) with a
comment stating classifier semantics are part of the schema. The schema
version is hashed into `GIT_FINGERPRINT_VERSION` (fingerprint.ts:19-28), and
held-skip's early gate rejects mismatched `fingerprintVersion` outright
(held-skip.ts:277, :318 → "fingerprint-version") — codex confirmed both the
early gate and the late matcher honor it. No new field, no schema/coverage
contract change (sync-state-model.ts:230-253 untouched). Considered and
rejected: deriving the salt from a digest of `OP_STATE_CLASSIFICATION`
(auto-bump) — a second computed authority for what a reviewed one-line bump
does; revisit only if we forget the bump twice.

## 4. What this deliberately does NOT do

- **No proactive litter deletion.** rbox never unlinks fossils outside the
  existing `restoreOpState` conformance transaction (§3.3). No background
  sweeper, no hygiene loop addition. (`pruneEmptyOpStateDirs`,
  refs.ts:121-134, keeps its existing narrow mandate — unchanged.)
- **No sibling-worktree scan.** Op-state remains per-worktree
  (refs.ts:60-61); each worktree is its own synced repo lane and heals in
  its own lane. The lock plane (`gitBusy` + deferral-hygiene.ts) is
  untouched.
- **No runtime corroboration predicate.** After §3.1 every in-progress row
  is a marker git's own state machine consumes — the table is corroborated
  by construction; a runtime `hasCorroboratedInProgress` would be a second
  authority over the same question.
- **No new flags, no config.** Ships on (default-on rule); the deferral
  itself remains the safety net for real in-progress operations.

## 5. Protected behavior (must keep passing)

- Real `MERGE_HEAD` / sequencer / rebase-dir presence defers and refuses
  keep-mine at both doors (git-cmd.test.ts:928-944, 966-989, 1024-1046 —
  all exercise the shared in-progress predicate and stay green unmodified).
- Design 177: bare empty `rebase-merge/` is in-progress (both doors).
- Design 126 veto gates: any in-progress marker vetoes all waivers; the
  ORIG_HEAD preservation act/lock/crash-recovery/forensic-log machinery is
  byte-for-byte unchanged.
- Exhaustiveness `satisfies` proof over `OpStateRoot` stays.
- Capture stability pinning (capture-stability.test.ts:110,157,211).
- **Intentionally replaced, not preserved** (r1 finding 6):
  follow.test.ts:668-679 pins "MERGE_MSG mismatch defers; waiver is
  ORIG_HEAD-only" — that pin IS the bug this design removes; it is rewritten
  to pin the new rule, with a changelog note.
- Resolve refusal privacy pin (git-cmd.test.ts:804) stays green because the
  non-artifact suppression lane is untouched.

## 6. Validation

- Table pin update: follow.test.ts:656-665 — in-progress files become
  exactly `["MERGE_HEAD","CHERRY_PICK_HEAD","REVERT_HEAD"]`; breadcrumbs
  gain `REBASE_HEAD`.
- Red→green (the three field wedges as fixtures):
  1. stale `AUTO_MERGE`, no `MERGE_HEAD`, mismatched vs base → follows;
     fossil gone after checkout (restoreOpState conformance asserted);
  2. stale `REBASE_HEAD` in a linked worktree, no rebase dirs → follows;
  3. either fossil PLUS a real `MERGE_HEAD` → defers; detail names both
     rels with the worktree-qualified token.
- Real-git fixture matrix for §3.1 (r1 finding 7): REBASE_HEAD lifecycle
  under conflict-stop, interactive `edit`, `--quit`, finish, abort — assert
  the classifier tracks git's own resumability at every stage.
- Boundary rule: a real op starting mid-flight (MERGE_HEAD appears before
  boundary) → defers (breadcrumbWaived fails); fossils still alone at
  boundary → follows. ORIG_HEAD ⇔ preservation cross-check both directions.
  Manual-resolution-plus-fossil: confirmed take-theirs with a stale
  AUTO_MERGE present still applies (the manual lane keeps its own proof; no
  regression from the new boundary rule).
- Held-skip epoch: unit test that an attempt carrying the previous
  `GIT_FINGERPRINT_VERSION` misses with reason "fingerprint-version".
- Rig: extend scripts/rig/scenarios/git-stale-opstate.ts (fossil replant at
  :175-193) with the REBASE_HEAD-in-worktree case and the upgrade-convergence
  case (wedge on old table → new binary → converges without touching disk).
- Detail naming: assert the worktree-qualified token appears in the daemon
  log line, and that no absolute path can appear in the token
  (construction-level unit test).

## 7. Ownership

`OP_STATE_CLASSIFICATION` stays the single authority on marker meaning
(manifest-validate.ts); `GIT_FINGERPRINT_SCHEMA_VERSION` carries its epoch.
`follow-classify.ts` owns waivability; `follow.ts` owns waiver execution and
the boundary proof; `commitCheckout`/`restoreOpStateWithCrash` own fossil
disposal on the follow path (legacy engine apply keeps `restoreOpState`);
`orig-head.ts` owns ORIG_HEAD preservation. The deferral evidence stays in
the existing prose detail carriers — no new field, no new channel, no new
authority.
