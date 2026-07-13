# SPEC-116-impl — checkout follows sync (implementation decomposition)

Working spec for the design-116 implementation cycle. NOT shipped; deleted before PR.
Normative sources (read them, they win over this file on any conflict):

- `docs/design/116-checkout-follows-sync.md` (ALIGNED, 8 rounds)
- `docs/design/REVIEW-116.md` (34 adjudicated findings — implement FINAL forms)
- `docs/design/116-phase0-findings.md` (CONFIRMED root cause + required amendments)

## Cycle scope (what ships in this PR)

1. **D1 — Phase-0 amendments (per-ref worktree-ownership holds + OID-equality
   no-op rule)** in `src/engine/git/apply.ts`. Fixes the live incident class
   independent of the follow rule. Linked-worktree regression tests pin the
   exact shape that froze the Mac.
2. **D2 — durable per-lane deferral + partial-apply state** (`GitDeferrals`,
   `GitPartialApply` on `RepoRecord`), typed reasons, partial-aware divergence,
   capture-lane sidecar saves. Visibility state is UNCONDITIONAL (both flag arms).
3. **D3 — derived-receipt applied-manifest oracle** (pre-apply scan ⊕ applied
   actions, dircache-token verified; `indeterminate` fail-closed).
4. **D4 — the follow rule**: classification predicates (semantic index identity,
   op-state base-or-incoming, incoming-ownership closure walks, stash-reflog
   protection), two-phase durable checkout journal with rollback-only crash
   recovery, pinned `update-ref --stdin` lock protocol, recovery pins
   (`refs/rbox-local/keep/<oid>` + origin sidecar), `RBOX_GIT_FOLLOW` flag
   (default ON, `=0` kill switch kills only oracle-authorized auto-follow).
5. **D5 — visibility surfaces**: `rbox status` per-repo deferral lines +
   `--json git.deferrals[]`, daemon durable line (post-save, age-boundary
   dedup), `shell.deferrals` sidecar + plugin routing, menu-bar ambient count,
   diagnostics redaction.
6. **D6 — `rbox git resolve <repo> [show-me|take-theirs|keep-mine]`**:
   show-me + take-theirs required; keep-mine only if the preservation seam
   (quarantine of decrypt-verified incoming artifacts + closure verify +
   supplementary pack) lands cleanly.
7. **D7 — validation matrix + rig scenario + crash injection tests.**

## Explicitly OUT of this cycle (deviations to report)

- **Schema-5 `tracking` lane** (remote-tracking refs on the wire), the
  `GIT_TRACKING_AUTHORSHIP` interlock, split-index transport normalization, and
  the capture-side staged-index OID bundle-closure pinning (r7) — these are the
  reader-first tracking rollout with its own shipping gate (cross-shape
  convergence trace). `KNOWN_MANIFEST_SCHEMA` stays 4. Design remains normative
  for a follow-up cycle. Consequence: the ref plane this cycle covers local
  heads/tags/eligible stash only (today's `isSyncableRef` set); tracking refs
  remain config-plane only.
- Rig gate live-fleet measurement (publish→bytes-on-disk) — runs post-merge on
  the fleet, not in this PR (recorded as follow-up).

## Test battery (after every dispatch)

```
bun run typecheck        # or npx tsc -p . — check package.json
bun test ./src/
```

Tolerated pre-existing flakes (rerun locally before believing): same-SHA heal,
shellStateOf, ctime, 3-strike §11 concurrent-atomicity. Shard guard per repo
convention. `apps/api` vitest only if touched (it is NOT touched this cycle).

Test hygiene (from #264/#269): bounded teardowns, real-time deadlines, close/
await async work before tmpdir removal, NO module-state leaks between test
files (grant-suite lesson) — never mutate shared module singletons without
restoring them.

---

## D1 — Phase-0 amendments: per-ref worktree-ownership holds + OID-equality

**Files:** `src/engine/git/apply.ts` (primary), `src/cli/sync-git/apply.ts`
(result plumbing), tests in `src/engine/git/` and/or `src/cli/sync-git/git-sync.test.ts`.

**Supersedes design 68 §3.2's whole-section defer for DIR targets.** The
underlying hazard (`git update-ref` silently moving a branch a sibling
non-prunable linked worktree has checked out) stays fully guarded — per ref,
not per section.

### Rules (normative, from 116-phase0-findings.md §Design disposition)

1. **No-op OID-equality rule:** an incoming ref UPDATE whose OID equals the
   receiver's current value for that ref NEVER defers and is NEVER a
   collision/hold — nothing moves. This applies to the sibling-worktree check
   (the field incident: `refs/heads/d93-git-config-sync` incoming OID ==
   local OID while checked out in linked worktree `d93`) and to the pointer
   ownership filter in the same function (same predicate, same fix).
2. **Per-ref holds (dir targets):** when a section names a branch checked out
   in a sibling worktree at a DIFFERENT OID:
   - that ref is NOT published; it is recorded as held:
     `heldRefs: Record<string /*full refname*/, string /*worktree display name*/>`
     on `ApplyGitResult`;
   - every other ref, HEAD, index, op-state still applies (checkout follows).
3. **Held deletions:** with `deleteAbsent` (all-scope into dir repo), a local
   branch checked out in a sibling worktree that is ABSENT from the section is
   NOT deleted — held, recorded in `heldRefs`, other deletions proceed.
4. **HEAD collision still defers the whole apply:** if the section's HEAD
   branch (`headBranchOf(section.head)`) is checked out in a sibling worktree,
   the checkout cannot follow (double-checkout) — return
   `{applied:false, reason: "worktree-ownership: branch X checked out in linked worktree Y"}`.
   OID equality does NOT waive this one (moving HEAD onto a sibling-owned
   branch is illegal regardless of OID).
5. **Clean-materialization wipe unchanged:** when `beforeMutateWipesRefs`,
   ANY sibling-checked-out local branch still defers the whole section
   (the wipe deletes every syncable ref; per-ref holding a wipe is not
   defined this cycle). Keep the existing message shape with a
   `worktree-ownership` classification.
6. **Pointer targets:** keep existing filter semantics (refs/stash + tags
   filtered; sibling-owned branches filtered) but apply the OID-equality
   rule: a pointer publish of an identical OID to a sibling-owned branch is a
   no-op, not a filtered ref. HEAD-blocked defer unchanged.

### Mechanics

- `worktreeCollision()` is replaced by a per-ref classifier returning
  `{ heldRefs: Map<ref, worktreeName>, deferReason?: string }`; it reads
  current local ref values once (`readAllRefs`) to implement OID equality.
- Held refs are removed from `publishRefs` before the publish loop; held
  absent-deletions are skipped in the `deleteAbsent` loop.
- `ApplyGitResult` gains `heldRefs?: Record<string, string>`.
- `applied: true` with non-empty `heldRefs` means PARTIAL apply. Caller
  (`src/cli/sync-git/apply.ts`) treatment in D1 (refined in D2):
  - keep `pending[rel] = remoteSec` (pending carry — push carries newest truth,
    retry continues);
  - do NOT advance base to `remoteSec`;
  - log `git-sync applied ${rel} (held refs: ...)`;
  - metrics result: reuse `"deferred"`? NO — add nothing to the result union in
    D1; count it as `"applied"` but keep pending. (D2 introduces the partial
    record + typed deferral; keep D1's caller change minimal and tested.)
  - KNOWN D1 LIMITATION (do not "fix" it by advancing base): on the next pull
    the partially-applied local identity differs from base → would hit the
    conflict path. D1 must avoid that trap minimally: when the ONLY divergence
    between local and base is refs held by a live sibling worktree at their
    CURRENT local values, classify as not-diverged and re-defer (retry) instead
    of conflict. Implement as a narrow, well-commented predicate in
    `src/cli/sync-git/apply.ts` beside `localDivergedFromBase` — D2 replaces it
    with the real `GitPartialApply` record. Simplest correct form: compute
    divergence with held-ref names masked from both sides when a sibling
    worktree currently owns them; a masked comparison that is otherwise equal →
    take the retry path (pending stays, no conflict checkpoint).

### Tests (regression MUST pin the Mac incident shape)

In the engine git test home (see existing tests for fixture helpers):

1. dir repo + linked worktree (`git worktree add`) with branch `side` checked
   out; incoming section carries `side` at the IDENTICAL OID plus a moved
   `main`+HEAD → apply succeeds fully, no hold, no defer; HEAD/main follow.
   (This is reproduction step (a) — the exact freeze shape.)
2. same but incoming `side` at a DIVERGED OID → `side` held
   (`heldRefs`), `main`/HEAD/index still follow; local `side` untouched;
   sibling worktree unaffected.
3. all-scope section ABSENT `side` (deleteAbsent) with `side` checked out in a
   sibling → `side` survives (held), other absent refs deleted.
4. incoming HEAD names a branch checked out in a sibling worktree → whole
   apply defers, reason mentions the worktree name.
5. wipe path (`beforeMutateWipesRefs`) with sibling-owned branch → defers.
6. pointer target: identical-OID publish to sibling-owned branch → not
   filtered, applied as no-op.
7. cli-level (`git-sync.test.ts`): partial apply keeps pending + does NOT
   conflict on the next pull; retry after `git worktree remove` completes the
   held ref and clears pending.

### Acceptance

- `bun test ./src/engine/git/ ./src/cli/sync-git/` green (plus full battery).
- No change to pointer filter behavior other than OID no-op.
- Every new/changed behavior has a test naming design 116 / phase-0.

---

## D2 — durable per-lane deferral + partial-apply state

**Files:** `src/cli/config.ts`, `src/cli/sync-state.ts`, `src/cli/sync-git/apply.ts`,
`src/cli/sync-git/plan.ts`, `src/cli/sync/push.ts`, `src/cli/sync/pull.ts`,
tests in `src/cli/sync-state.test.ts` + `src/cli/sync-git/git-sync.test.ts`.

### Types (design §Partial-apply state, doc lines ~527-604; place in `src/cli/config.ts` next to RepoRecord)

```ts
export type GitDeferralReason =
  | "local-edits" | "local-index" | "local-operation" | "local-commits" | "local-stash"
  | "conflict" | "git-busy" | "worktree-ownership" | "ignored-target" | "unreadable"
  | "artifact" | "config" | "containment" | "unsupported" | "other";

export interface GitDeferral {
  lane: "apply" | "capture" | "config";
  deferredSince: string;   // continuous until the lane is fully clear
  reasonSince: string;     // resets when reason class changes
  lastSeen: string;        // advances on retry
  subjectKey?: string;     // incomingKey for apply; local probe key for capture
  reason: GitDeferralReason;
  checkout?: { kind: "branch" | "detached"; label?: string }; // label = short display, NEVER a SHA
  bytesChanged?: boolean;  // r4 F9/r5 F2 — sender-local, restart-surviving
}
export type GitDeferrals = Partial<Record<GitDeferral["lane"], GitDeferral>>;

export interface GitPartialApply {
  incomingKey: string;
  checkoutPending: boolean;
  appliedRefs: Record<string, { kind: "direct"; oid: string } | { kind: "symbolic"; target: string }>;
  heldRefs: Record<string, "local-commits" | "local-stash" | "ownership">;
  configApplied: boolean;
  configBase?: Record<string, string[]>;
}
```

- `RepoRecord` (config.ts:192-203) gains `deferrals?: GitDeferrals` and
  `partial?: GitPartialApply` after `cfgShape`. `RepoRecordInput` inherits via Omit.
- `incomingKey`: canonical sha256 over normalized mutation-relevant section
  fields — head, sorted refs, indexSha/indexTree, opState plaintext shas,
  config, refScope, bundleSha + packChain shas. Helper `gitIncomingKey(section)`
  in `src/cli/sync-git/shared.ts`. NOT `gitIdentityKey`.

### Threading (CRITICAL — sync-state.ts silently drops unenumerated fields)

- `RepoStateValues` (sync-state.ts:29-38) gains
  `deferrals?: Record<string, GitDeferrals | null>` and
  `partial?: Record<string, GitPartialApply | null>` (`null` = explicit clear;
  absent = preserve current — matching configLane's replace semantics but with
  per-lane merge, below).
- `sourceRecord` (sync-state.ts:86-100): deferral lanes MERGE PER LANE and are
  EXCLUDED from the whole-record `sourceSeq`-newer-wins comparison (r2 F6):
  even on the `current.sourceSeq > source.sourceGlobalSeq` retain branch, a
  supplied deferral lane transition still lands. Add `mergeDeferrals(current,
  incoming)` helper modeled on `configLaneState`: per lane, an incoming entry
  replaces that lane; an incoming explicit `null` for a lane clears it;
  `deferredSince` continuity is the WRITER's job (see below), the merge is
  mechanical.
- Lane-only saves NEVER stamp an unaccepted global sequence: they carry the
  loaded accepted sequence (`state.lastSyncedSequence`) as `sourceGlobalSeq`
  and no `globalManifest` (template: push.ts:410-432 no-op save).
- `observedRepoKeys` (:190) + `changedSidecarRepoKeys` (:205-210) include the
  new maps.
- `resetSyncState` (config.ts:520-581): dispose `.rbox/state/git-journal/`
  and `.rbox/state/shell.deferrals` in the sidecar-cleanup loop (:565-569)
  under the same lock (r3 F2 hook; journal itself lands in D4 but the reset
  disposal can land here with a mkdir-less rm).

### Writer semantics (the lane state machine — implement as one helper used by all writers)

`nextDeferral(current: GitDeferral | undefined, reason: GitDeferralReason, now: string, subjectKey?, checkout?): GitDeferral`:
- `deferredSince = current?.deferredSince ?? now` (survives newer incoming
  identities and reason changes — chronic age; a busy workspace cannot reset
  "14d" by publishing another blocked section);
- `reasonSince = current && current.reason === reason ? current.reasonSince : now`;
- `lastSeen = now`; preserve `bytesChanged` from current.
Clearing: success, convergence, or remote absence clears the apply lane.
A conflict checkpoint does NOT clear it (r5 F3): a new or re-proved-genuine
`gitNeedsResolution` checkpoint holds an apply-lane deferral with reason
`conflict` and continuous age until real resolution (local identity change,
resolve verb, or remote absence). The checkpoint early-return in
applyGitSections must therefore MAINTAIN (not skip) the deferral record.
Capture lane clears only when that planner row captures/carries successfully
or the repo is intentionally removed; config lane on completion or permanent
policy skip.

### Pull-side wiring (`src/cli/sync-git/apply.ts`)

- `GitPullOutcome` gains `deferrals?: Record<string, GitDeferrals | null>` and
  `partial?: Record<string, GitPartialApply | null>`; pull.ts threads both into
  `saveStateSource` values (mirror configLane at pull.ts:246/253).
- Every `defer(reason)` site maps its free-form reason onto the closed enum:
  - "receiver git busy" → `git-busy`; ignored-subtree → `ignored-target`;
    containment → `containment`; artifact fetch/decrypt → `artifact`;
    worktree-ownership holds/defers (D1) → `worktree-ownership`;
    unreadable pointer leftover → `unreadable`; config lane → `config`;
    catch-all → `other`. Keep the free-form string in the LOG line; the
    RECORD stores only the enum + times.
  - checkout kind/label: from the LOCAL repo's current HEAD (branch short name
    or `detached`, no OID).
- D1's held-ref partial outcome now writes the real `GitPartialApply`
  (incomingKey, appliedRefs = refs actually published with their exact values,
  heldRefs with reason `"ownership"`, checkoutPending=false when HEAD/index
  applied) and replaces D1's narrow masked-divergence predicate:
  divergence classification consults `record.partial` — under the common-dir
  lock, re-read every recorded appliedRef and compare with the exact recorded
  value; matching = rbox-authored, not human divergence; a mismatch invalidates
  the marker and that live tip goes through normal classification (never
  overwritten because state says rbox applied it). A newly arriving section
  (different incomingKey) replaces the partial plan. Remote absence clears
  pending + partial + deferral under [v6].
- No unchanged/"refs already match" shortcut may clear pending while a
  protected required ref or the checkout is still held.

### Push-side wiring (`plan.ts` + `push.ts`)

- `planGitSections` maps `deferred[]` reasons onto the enum (busy → `git-busy`,
  preflight/structural → `unreadable`/`containment` as apt, worktree pointer
  skip → `worktree-ownership`, capture failure → `artifact`, config →
  `config`, else `other`) and returns a typed
  `captureDeferrals: Record<string, GitDeferralReason>` alongside the
  existing plan (leave `deferred[]` for logs).
- push.ts: immediately after the git-plan phase (push.ts:383), BEFORE
  upload/commit/mass-delete/network, a sidecar-only `saveStateSource` persists
  capture-lane set/clear transitions via `changedSidecarRepoKeys` with no
  global claim. Clear transitions: repos that planned capture/carry cleanly
  and currently have a capture-lane record → explicit `null`.
- The later accepted-commit save (push.ts:570-588) merges lanes (r2 F6 —
  `sourceRecord` merge handles it; test it).

### Tests

- sync-state.test.ts patterns: lane merge across recompute (inject `apply`
  seam), lane-only save on older sourceSeq still lands, ABA/repoGen tests
  extended with deferral fields, `changedSidecarRepoKeys` diffs deferral-only
  changes, reset disposes journal dir.
- git-sync.test.ts: chronic `deferredSince` continuity across newer incoming
  sections + reason changes; `reasonSince` reset on class change; clear on
  success/absence; conflict checkpoint holds `conflict` deferral; capture
  defer → post-plan push failure → restart → newer remote truth → eventual
  clear (the design's forced validation trace); partial appliedRefs
  revalidation: human moves a partially applied non-current ref after partial
  publish / before state save / after crash before retry → held or recovered,
  never overwritten.

---

## D5 — visibility surfaces

**Files:** `src/cli/status-cmd.ts`, `src/cli/status-view.ts`,
`src/cli/sync-git/status.ts`, `src/cli/daemon/daemon.ts`, `src/cli/activity.ts`,
`src/cli/shell-init.ts`, `src/cli/ambient-status.ts`,
`macos/RboxBar/Sources/RboxBar/{StatusReader,Models,MenuContentView}.swift`,
`src/cli/doctor-cmd.ts`. Visibility is UNCONDITIONAL in both flag arms.

1. **`rbox status` human render** (status-cmd.ts:444-474): add `· N deferred`
   to the git-sync aggregate parts; after the aggregate line, one indented
   line per deferred repo, OLDEST FIRST:
   `  git deferred 14d: local edits on branch release/0.9 (repo)` —
   reason rendered as human text from the enum, age from `deferredSince`
   bucketed (new pure `ageBucket(iso, now)` in status-view.ts beside relTime:
   <1h → minutes, then 1h/1d/7d/14d/30d coarse buckets — display uses the
   bucket floor like "14d"), branch label via `truncateDetail` sanitization.
   Detached → `detached checkout`, never an OID. Repos with `bytesChanged`
   append ` (working files changed since)`. Source: `repoRecordsForState(state)`
   deferrals — all three lanes render; apply+capture+config episodes may
   coexist (render the highest-precedence per repo per lane on its own line).
   Reason display precedence: local-edits > local-index > local-operation >
   local-commits > local-stash > operational (display-only).
2. **Aggregate gate** (status-view.ts:258/279): `StatusSnapshot` gains
   `gitDeferrals?: number` and `gitBytesChangedDeferrals?: number`; the
   `✓ in sync` verdict must not render while either is nonzero — fold into
   the divergence branch with a wording like `⚠ 1 git repo deferred` (and
   healthDetailLines gains the oldest age + reason). "Both planes in sync"
   semantics: in-sync ⇔ file plane clean AND no deferral lanes AND no
   bytesChanged markers.
3. **`--json`** (status-cmd.ts after :397): `git: { deferrals: [{ repo,
   lane, reason, deferredSince, reasonSince, ageSeconds, bytesChanged,
   checkout: { kind, label? } }] }` — omits OIDs and raw errors; local
   output, not telemetry.
4. **Daemon durable line** (daemon.ts): after the state save that made an
   episode durable (post-pull and post-push saves), emit
   `log("git deferred <bucket>: <reason> on <label> (<rel>)")` once per
   (repo, lane) on: new episode, reason class transition, and coarse
   age-boundary crossings (1h, 1d, 7d, 14d, 30d) — dedup map as daemon
   instance state keyed `rel\0lane` → `{reason, bucket}` (pattern:
   this.lastShellState). No per-tick spam.
5. **shell.deferrals sidecar** (r4 F8/r5 F4/r6 minors): `shell.line` is NOT
   touched. New sibling `<root>/.rbox/state/shell.deferrals`, own `v1`:
   first line `v1`, then one line per deferred repo:
   `<percent-encoded relPath>\t<reason>\t<ageBucket>\t<0|1 bytesChanged>`.
   Row- and byte-bounded: max 50 rows, max 8 KiB total; over-bound → truncate
   rows (workspace aggregate still carries the count). Writer in activity.ts
   beside renderShellLine/saveShellLine; daemon wires it into
   writeHeartbeatSurfaces + enqueueActivityWrite next to saveShellLine calls,
   gated by canPersistTrustedSurface; DELETE the sidecar when no deferrals
   (absent file = fast no-op for the plugin). Plugin (shell-init.ts): new
   pure-zsh `_rbox_deferrals` — reads the file only when present, validates
   `v1` header, matches `$PWD` against DECODED rel-paths on path-component
   boundaries only, selecting the LONGEST enclosing repo (`repo` must not
   match `repository`; nested repos → deepest); renders a small prompt
   segment (e.g. `⚠git:14d`); malformed/oversized file → ignore entirely.
   No subprocess on the per-prompt path; keep design 88's ≤5 ms budget —
   add malformed/oversized fixtures to shell-init tests and keep `zsh -n`
   validation green.
6. **Menu bar**: `AmbientDaemonStatusV1` gains `deferredRepos?: number` and
   `oldestDeferralAgeSeconds?: number | null` (additive, schemaVersion stays 1
   — absent keys are legacy-safe in both readers); populate in
   projectAmbientDaemonStatus from the same repo-record projection; parseStatus
   validates. Swift: StatusReader parses the new optional keys into
   DaemonStatus/WorkspaceStatus; MenuContentView adds an info row
   ("1 repo deferred · 3d") near secondaryStatusText; deferredRepos > 0 maps
   to the `.degraded` severity tier dot. Count + age bucket ONLY on this
   surface — no repo/branch names.
7. **Diagnostics redaction** (doctor-cmd.ts:341-386): `redactGitLogLines(tail)`
   applied to daemonLogTail before bundling — every line whose message starts
   with `git-sync ` or `git deferred` (current AND legacy forms: deferred,
   CONFLICT, WARNING, config skipped, applied w/ filtered refs) is rewritten
   to `git-sync <class> reason=<enum-or-other> age=<bucket-or-->` with counts
   collapsed for repeats; if a line matches the family but cannot be
   structurally classified, DROP it (fail-closed omission). Adversarial tests
   inject paths, branch names with spaces/control chars, OIDs, raw git errors
   — none survive the bundle payload.
8. **sync-git/status.ts**: `GitDivergenceStatus` gains
   `deferrals: Array<{ relPath, lane, reason, deferredSince, bytesChanged? }>`
   read from repo records (read-only projection; pending no longer invisible).
   statusCmd uses it (via existing dep seam) for counts; the JSON/human render
   reads records directly.

Privacy boundary: local status/daemon may name repo + branch; metrics,
analytics, uploaded diagnostics carry only counts/enums/age buckets.

### Tests

status-view.test.ts (pure: ageBucket, verdict gating, deferral line render),
status-cmd.test.ts (deps-seam: human lines oldest-first, --json shape,
detached render, bytesChanged flag), activity/daemon tests (dedup on
transitions + age boundary only; durable post-save emission), shell-init.test.ts
(`zsh -n`, routing fixtures: boundary match, longest-match, malformed,
oversized), ambient-status tests (projection + parse round-trip), doctor
redaction adversarial tests.

---

## D4 — follow rule: classifier, two-phase journal, pinned lock protocol

New engine modules (keep each focused; owners in docs/CODEMAP.md):

- `src/engine/git/index-identity.ts` — semantic index projection (GitIndexIdentityV2)
- `src/engine/git/reachability.ts` — incoming-ownership + no-drop closure proofs
- `src/engine/git/journal.ts` — durable two-phase checkout journal
- `src/engine/git/checkout-txn.ts` — pinned lock-protocol checkout commit
- `src/engine/git/keep-pins.ts` — content-addressed recovery pins + origin sidecar
- `src/cli/sync-git/follow.ts` — follow decision orchestration (classifier inputs
  → plan: checkout subset / safe refs / held refs), flag parsing

### Flag

`RBOX_GIT_FOLLOW` (parse in `src/cli/sync-git/shared.ts`): unset/`1`/anything ≠
exact `"0"` → follow enabled; exact `"0"` → legacy pre-116 identity-divergence
disposition (the existing conflict path). Deferral VISIBILITY and D1/D2
behavior are unconditional in both arms. Degraded workspace mutex
(`workspaceSyncMutexDegraded`) → follow + independent ref-plane publication
DISABLED (legacy disposition; journal recovery still runs, rollback-only).
Unsupported git capability (below) → typed `unsupported` defer of the checkout
(legacy disposition).

### Semantic index identity (`index-identity.ts`)

`indexIdentityV2(repoDir, indexFilePath): Promise<string | undefined>` —
versioned canonical projection hash (`"v2:" + sha256`) computed LOCK-FREE from
a PRIVATE BYTE COPY of the index (copy first; never the live file):
- entries sorted by (path bytes, stage): path, stage, mode, OID,
  intent-to-add, skip-worktree, assume-unchanged, sparse-directory flags;
- semantic resolve-undo and sparse extension content;
- EXCLUDES stat-cache fields, fsmonitor/untracked/cache-tree/EOIE/IEOT,
  padding, version noise.
Implementation: `git ls-files --stage` + `git ls-files -v` (letter flags:
lowercase = assume-unchanged, `S` = skip-worktree) + `git ls-files --stage
--sparse` + `git ls-files --resolve-undo`, all with `GIT_INDEX_FILE=<copy>`
via the existing `gitWithIndexFile` helper. Intent-to-add: `git ls-files -v`
letter for ita entries. If any probe fails → undefined (callers treat as
`indeterminate` → defer; NEVER permission to overwrite).
Same function projects live, prior-base, and incoming indexes (base/incoming:
decrypt-verified artifact files fetched to tmp — already available inside
applyGitState's artifact staging). RepoRecord caches `idxProj?: string`
(last successfully applied projection) so the base side doesn't re-decrypt
per pull; a legacy base without the cache derives it once from the base index
artifact and persists it via the D2 packet.

### Reachability (`reachability.ts`) — r1 F5 discipline

All walks run with `GIT_NO_LAZY_FETCH=1` (and `-c fetch.negotiationAlgorithm`
untouched; no promisor traversal) and treat EVERY missing object, peel
failure, or walk error as `indeterminate` (a typed third value — never
"unreachable"). A shallow store (`<commonDir>/shallow` present) →
checkout-plane defer (`unsupported` bucket? NO — use `other`? design says
"defers the checkout plane, matching capture's structural refusal" → reason
`unreadable`? Use `unsupported`. Pick ONE and test it; recommended:
`unsupported` with log text "shallow store").
- `incomingOwnershipRoots(section, importedNs)`: incoming HEAD (detached OID
  or its branch tip), incoming heads/tags/eligible stash, commit-bearing
  incoming op-state roots (parse MERGE_HEAD/REBASE_HEAD/CHERRY_PICK_HEAD/
  REVERT_HEAD/rebase-merge/rebase-apply files for 40-hex OIDs whose objects
  are commits). Held/recovery/scratch refs are EXCLUDED.
- `tipOwnedByIncoming(repoDir, tip, roots)`: complete-closure proof —
  `git merge-base --is-ancestor <tip> <root>` any-of for commit tips, with
  explicit tag peel (`rev-parse <root>^{commit}` guarded); closure over roots
  verified once per apply via `git rev-list --objects <roots> --not
  --all`-style walk? NO — closure proof = `git rev-list <roots>
  --quiet` (errors on missing commits) plus the pre-commit
  `fsck --connectivity-only` over the planned durable graph. Any error →
  indeterminate.
- `noDropProof(repoDir, plannedRefs, heldRefs, recoveryPins, protectedTips)`:
  every protected receiver tip reachable from (planned durable graph ∪ held ∪
  recovery pins); scratch names excluded. Same error discipline.
- Stash: for dir repos enumerate EVERY `refs/stash` reflog OID (read
  `logs/refs/stash`), not only the tip.

### Recovery pins (`keep-pins.ts`) — r2 F8 / r3 F7 / r4 F3

`pinDisplaced(repoDir, oids, origin: {ref, episode, time, class: "human"|"tracking"})`:
- `refs/rbox-local/keep/<oid>` — one ref per OID, create-only
  (`update-ref --stdin` with `create` verb; an existing identical pin is an
  idempotent no-op), in the SAME ref transaction as the displacement.
- Sidecar `<commonDir>/rbox-keep-origins.json` (atomic write): oid → array of
  origin entries. Origin classes ordered human > tracking; promotion
  monotonic and durably persisted BEFORE the displacing ref transaction
  commits (r4 F3). This cycle every pin is human-origin (tracking lane is
  deferred), so the retention sweep is NOT implemented — document that the
  sweep lands with the tracking lane; human pins are never age-pruned.
- Before ANY ref-plane deletion or non-FF replacement: enumerate that ref's
  reflog OIDs (`logs/refs/...`), pin every entry not reachable from the
  planned durable graph, same transaction (r1 F6).
- Verify `isSyncableRef` already excludes `refs/rbox-local/*` (it must — the
  namespace is excluded from capture and ordinary identity like existing
  `refs/rbox-*`); add a test.

### Two-phase journal (`journal.ts`) — r2 F1/F2, r3 F1/F2/F3/F5, r4 F1/F2

Location: `<root>/.rbox/state/git-journal/<sha256(relPath)>/` (workspace-owned;
exists before any gitdir for fresh materializations; per-worktree-keyed).
Files: `journal.json` (atomic write) + byte-exact copies `old-index`,
`old-op/<rel>` (nested dirs ok).

`journal.json` fields:
```ts
interface CheckoutJournal {
  phase: "intent" | "published";       // flip via atomic marker write (rename)
  incomingKey: string;
  incomingSection: GitSection;          // verbatim (refs/head/descriptors — small)
  old: {
    currentRefName?: string; currentRefOid?: string; headContent: string;
    indexPresent: boolean;              // bytes in old-index
    opState: Record<string, true>;      // bytes in old-op/<rel>
    /** wipe variant only: complete pre-wipe syncable ref map (r3 F3) */
    preWipeRefs?: Record<string, string>;
  };
  expectedNew: {                        // r3 F5 — exact staged identities
    indexHash?: string;                 // sha256 of the TRANSFORMED candidate bytes (not wire indexSha)
    opState: Record<string, string | null>; // rel → new sha256, null = absent
    refs: Record<string, string>; head: string;
  };
  binding: {                            // r3 F2 — incarnation
    stream: string; stateNonce: string;
    gitDirReal: string; commonDirReal: string; worktreeId: string; // repoDir realpath
  };
  createdFresh: boolean;
  /** r4 F1 — published-phase recovery composes a FRESH CAS packet from these */
  intended: { record: RepoRecordInput; expectedRepoGen: number; relPath: string };
  /** D6: resolve episode attribution */
  episode?: { verb: "take-theirs"; snapshotId: string };
}
```

Lifecycle inside one apply:
1. write journal (phase `intent`, all old bytes copied) BEFORE the first
   checkout-plane mutation;
2. checkout publication completes → atomically flip to `published` BEFORE the
   state save;
3. state save accepted → delete journal dir.

`recoverJournal(root, relPath, binding)` — runs under the repo common-dir lock
+ workspace mutex, BEFORE any classification, at the start of pull-apply
processRepo, push planning for that repo, and resolve verbs:
- binding mismatch (stream/nonce/realpaths) → retire the journal dir to
  `<root>/.rbox/state/git-journal-quarantine/<ts>-<key>/` WITHOUT touching the
  repo; log loudly.
- `intent` → ROLLBACK ONLY: restore journaled old index/op-state bytes and
  (wipe variant) every journaled ref; move current ref/HEAD back with
  expected-current semantics — per field, if the live value matches neither
  journaled old nor expectedNew, a human intervened: leave that field
  untouched, retire journal to quarantine, repo takes the ordinary conflict
  path. created-fresh intent → NEVER delete: atomically RENAME the whole
  partial `.git` into `<root>/.rbox/git-quarantine/<ts>-<key>/` (r4 F2),
  surface the path. Unreadable/corrupt journaled bytes → defer with journal
  intact, loud log — never guess.
- `published` → keep the new checkout; semantic already-applied check (repo
  base advanced to this incomingKey → just clear journal); else compose a
  FRESH generation-CAS packet from current live records merged lane-wise with
  `intended` (never a stale replay; never double-advance repoGen).

### Pinned lock protocol (`checkout-txn.ts`) — r1 F3, r2 F4, r3 F6

`commitCheckout(ctx, plan, proofs, journal)` implements EXACTLY:
1. normalize/stage candidate index privately: copy incoming index artifact,
   run resolve-undo clear against the STAGED CANDIDATE via private
   `GIT_INDEX_FILE` (reuse/adapt `clearIndexResolveUndo` — it must NOT touch
   the live index), hash the transformed bytes → journal `expectedNew.indexHash`;
2. pre-commit connectivity/fsck proof over the planned durable graph
   (incoming objects already imported under scratch refs) —
   `git fsck --connectivity-only --no-dangling` scoped by the planned refs
   via rev-list closure of planned roots; failure → abort/defer (`artifact`);
3. open ONE `git update-ref --stdin` transaction: `start` … expected-old
   `update`/`create`/`delete` verbs for every checkout-plane ref, HEAD via
   `symref-update` with verified old symbolic target (or old OID for
   detached);
4. `prepare` (takes ref locks);
5. create `<gitDir>/index.lock` via O_CREAT|O_EXCL (this is the writer
   reservation);
6. SECOND PROOF, lock-free reads only (direct file reads + plumbing that
   takes no locks): re-derive oracle receipt tokens for the repo subtree
   (D3's boundary re-proof), re-snapshot HEAD/index/op-state/stash/current
   tip and re-run every base/incoming + graph predicate. An
   ownership-aware busy probe runs here: ignore exactly the lock tokens this
   sequence created (our index.lock + the transaction's ref locks), reject
   any OTHER git lock. (The ordinary `gitBusy` probe already ran BEFORE
   step 1 — see order below.)
7. proof failure → `abort`, remove OUR index.lock, remove journal, defer
   (explicit tested path);
8. success → `commit` the ref transaction FIRST, while index.lock is held;
9. write the candidate index bytes INTO the held index.lock fd and publish by
   Git's own convention: rename `index.lock` → `index`;
10. restore op-state (restoreOpState), flip journal to `published`, return
    for state save.
Any in-process failure after (8) repairs through the journal's
expected-current arbitration — NEVER through restoreLocal's unconditional
writes.

Capability probe: once per process per git version (`git version` string
key): in a scratch temp repo, exercise `update-ref --stdin` with
`start/prepare/symref-update/commit`; failure → checkout defers `unsupported`
(legacy disposition). Cache in a module map (module-level cache is
acceptable here — it is version-keyed and read-only; tests must not need to
reset it, use a fresh probe injection seam instead).

Ordering with the existing generic `gitBusy`: run it BEFORE creating our own
locks (existing call site in applyGitState); after we hold locks, only the
ownership-aware probe from step 6 runs.

Pinned-by-test transient: between (8) and (9) a concurrent `git status` may
see new refs + old index — transient display dirt, not loss (r3 F6).

### Follow decision (`src/cli/sync-git/follow.ts` + integration in `sync-git/apply.ts`)

Replaces the immediate conflict path when local diverged from base AND the
flag arm allows: classify —
```text
follow ⇔ treeMatchesAppliedManifest (D3 oracle: pass)
      AND indexIsBaseOrIncoming     (live idxProj ∈ {baseProj, incomingProj}, or live absent with no prior index, or live == incoming)
      AND opStateIsBaseOrIncoming   (field-by-field: live[rel] ∈ {base[rel], incoming[rel]} incl. absence)
      AND currentTipHasNoLocalOnlyCommits (attached branch tip or detached HEAD ∈ incoming-ownership closure)
      AND no design-43 ownership/busy/containment/artifact refusal
```
- Reason mapping on failure: oracle fail → `local-edits`; oracle
  indeterminate → `unreadable`; index → `local-index`; op-state →
  `local-operation`; tip → `local-commits`; receiver-only stash →
  `local-stash` (holds stash ref + defers checkout). All guards evaluated;
  precedence display-only.
- An already-converged incoming state remains a no-mutation success.
- A stale branch (name or OID differs) is safe when its tip is
  incoming-owned — the field-incident shape. Recovery/held refs can prove
  no-drop but NEVER authorize follow.
- Per non-current incoming ref (after design-43 scope/pointer filters):
  no-drop test → safe publish now (ref plane advances even when checkout
  defers); receiver-only commits → hold (`local-commits`); human-local
  stash → hold (`local-stash`); sibling-worktree-owned diverged → hold
  (`ownership`, from D1). NFF replacement/deletion of a publishable ref pins
  displaced unique tips + unreachable reflog OIDs first (keep-pins, same txn).
- Legacy conflict checkpoints re-proved ONCE per incomingKey (r2 F5): on
  first encounter with a persisted `gitNeedsResolution` under the new
  classifier — if frozen divergence proves sync-induced (oracle passes,
  index/op-state base-or-incoming, tip incoming-owned) → clear checkpoint,
  follow; genuine → keep checkpoint + today's suppression, record re-proof
  outcome per incomingKey in the partial/deferral record (`subjectKey`) so
  the check is idempotent. §13.5 remote-absence `localDivergedFromBase`
  usage stays UNTOUCHED.
- The checkout plane (current branch ref + HEAD + index + op-state) commits
  via checkout-txn with the journal; safe non-current refs publish
  atomically per-ref (expected-old transactions) BEFORE the checkout txn;
  config lane after safe refs, before checkout journal (per the design's
  pipeline diagram) and config failure defers only the config lane, never
  rolls back safe refs or a safe checkout.
- Pipeline per repo (design §State transitions):
  file apply → derive receipt → decrypt/verify/import artifacts → classify →
  publish safe refs/pins → config txn if due → write journal (intent) →
  pre-commit connectivity proof → prepare + index.lock → second proof →
  commit checkout → flip journal published → state save → clear journal.
- `=0`/degraded/unsupported arm: legacy disposition = today's code path
  (conflict checkpoint etc.) — but deferral records still written (D2) and
  journal RECOVERY still runs.
- KEEP applyGitState as-is for the clean local==base path this cycle (its
  in-process rollback remains; the journal covers the NEW follow path and
  resolve verbs). Rationale: containment of risk; the clean path's crash
  window is pre-existing and unchanged; note as residual in the PR body.

### Crash-injection tests (kill boundaries)

Inject via a test-only `crashAt(point)` seam threaded through follow/
checkout-txn (throws a sentinel; test then re-runs recovery + retry):
after safe refs; after journal write; after connectivity proof; after
prepare; after ref-commit; after index publication; mid op-state restore;
between published flip and state save; before journal clear; plus: human
edit + human ref move injected in the crash window (live value matches
neither journaled old nor expectedNew → field untouched, journal retired,
conflict path); reset/rebind with surviving journal → quarantined untouched;
crash mid clean-materialization wipe → rollback restores the journaled
pre-wipe ref map; created-fresh crash → `.git` renamed to quarantine, never
deleted.

---

## D3 — derived-receipt applied-manifest oracle

**Files:** new `src/engine/apply-receipt.ts` (+ export via engine index),
`src/cli/sync/pull.ts` (build + pass into git apply),
`src/cli/sync-git/apply.ts` (accept `oracle` in opts — interface only, used by D4),
tests `src/engine/apply-receipt.test.ts`.

### Ground truth

- During the current pull: the validated incoming `remote` manifest after all
  file actions + the post-rule `.rboxignore` matcher (`finalMatcher`) completed.
- On a later pending retry (no fresh pull-scan available): the persisted
  applied base `state.lastSyncedManifest.files`.

### Interface (D4 builds against this — freeze it)

```ts
export type OracleVerdict =
  | { kind: "match" }
  | { kind: "mismatch"; sample: string[] }   // few rel-paths, local log only
  | { kind: "indeterminate"; why: string };

export interface AppliedManifestOracle {
  /** Full proof for one repo subtree (rel or "." = workspace). */
  proveRepo(rel: string): Promise<OracleVerdict>;
  /** Boundary re-proof at the checkout commit (r2 F3): token-first
   *  (entry + directory inventory tokens recorded by proveRepo), widening to a
   *  real re-scan of ONLY that subtree when any token moved. Never a workspace walk. */
  reproveRepo(rel: string): Promise<OracleVerdict>;
  /** Hash of the receipt inputs for this repo (for resolve snapshot identity). */
  receiptHash(rel: string): string | undefined;
}
```

Two constructors:
- `oracleFromPull({ preScan: Manifest, actions: Action[], oracle: Manifest, matcher: IgnoreMatcher, dircache, root, scanDeferred: Set<string> })` — the
  derived-receipt form: expected disk = indexByPath(preScan.files) ⊕ actions
  (write → set entry; delete → remove; conflict → set remote entry at path AND
  the prior local entry at keepLocalAs).
- `oracleFromState({ base: Manifest, matcher, root })` — pending-retry form:
  bounded scoped scan of the repo subtree only, compared to the base
  projection. (scanManifest cannot scan a subtree today — implement a small
  bounded subtree walker inside apply-receipt.ts reusing the hash cache
  discipline, or scan with a subtree-restricting matcher wrapper; NEVER the
  whole workspace per repo.)

### Comparison semantics (per repo rel; projection = path === rel || path.startsWith(rel + "/"), rel "." = all)

- compare: path presence/absence (incl. unignored extras ON DISK — the
  verification step must detect a created path, see below), entry type,
  content sha256, symlinkTarget, executable bit (`mode & 0o111`). mtime and
  generatedAt NEVER participate.
- `.git/**`, `.rbox` internals, and paths excluded by finalMatcher are removed
  SYMMETRICALLY from both sides (matcher.ignores; hard-excludes are already
  absent from manifests).
- Parent repo projections INCLUDE ordinary file paths under nested repos
  (design: may conservatively block a parent when a child has human dirt).
- Verification (this is what makes it a receipt, not a guess):
  - entries touched by actions: trust applyActions success + re-stat the path
    (type/size/exec) — re-hash only if the stat token disagrees with the
    expected entry;
  - untouched entries: stat token vs the pre-scan entry (mtimeMs+size); token
    moved → re-hash; hash differs from expected → mismatch;
  - NEW/DELETED paths cannot be seen by per-entry tokens (design calls this
    out): verify directory inventory for the subtree — enumerate directories
    (bounded to the subtree) and compare the child inventory against the
    expected map (names + types); use dircache entries (mtime/ctime/children)
    as the fast path where fresh, fall back to readdir. Any inventory
    disagreement → real scoped re-scan of that repo subtree; still
    disagreeing → mismatch; unreadable → indeterminate.
  - scanDeferred paths intersecting the projection → indeterminate.
  - record per-repo tokens (entry stats + dir inventory tokens) so
    reproveRepo can do the token-first boundary check.
- Path equivalence model (r1 F2): byte-exact first; PROBE the receiver fs
  once per oracle (create `a.rbox-probe-A`/`a.rbox-probe-a` + NFC/NFD pair in
  `<root>/.rbox/state/tmp`): if aliasing detected, spellings differing only
  under the probed equivalence must be proved same-entry via fs identity
  (stat ino/dev); two oracle paths colliding under receiver equivalence →
  indeterminate.
- Any unreadable path, hashing failure, ambiguous type change, walk error →
  indeterminate (defer, human-local protection). Sample paths in verdicts are
  for LOCAL logs only.

### Wiring

pull.ts: after cache-save (:219), before git-apply (:225), construct
`oracleFromPull` (inputs `local`, `actions`, `remote`, `finalMatcher`,
dircache, scanDeferred) and pass as `opts.oracle` into `applyGitSections`.
NO oracle work happens unless a repo's follow decision needs it (lazy per-repo
proveRepo — file-plane critical path untouched). applyGitSections when invoked
without an oracle (pending retry ticks arriving via pull still have one;
non-pull callers, if any, get `oracleFromState`).

### Tests (false-PASS attack cases from the review ledger)

- sync-dirt tree (bytes == applied manifest, dirty vs old HEAD) → match.
- human edit to an untouched file with SAME size + mtime forged → the
  re-hash-on-token-equality limit: token equality means trust — attack via
  mtime restore is out of scope (same racy-clean discipline as scan); but
  mtime/size change → caught. Pin the racy-margin behavior.
- post-scan create / delete / rename inside subtree → mismatch or
  indeterminate, NEVER match (dir inventory catches).
- unignored extra file on disk → mismatch. Ignored human file → match and
  byte-untouched.
- symlink target flip, chmod +x, type flip file↔symlink → mismatch.
- unreadable file / scan-deferred path in subtree → indeterminate.
- conflict action in subtree → mismatch (keepLocalAs extra).
- nested repo: child human dirt blocks parent, not vice versa.
- reproveRepo: token-stable → match without re-scan (count spawns/hashes);
  token moved + real change → mismatch; token moved + benign restat → match
  via scoped re-scan.
- equivalence probe: on case-insensitive tmpfs (skip if unsupported) alias
  spelling resolves; collision → indeterminate.

---

## D6 — `rbox git resolve <repo> [show-me|take-theirs|keep-mine]`

**Files:** new `src/cli/git-cmd.ts`; `src/cli/main-dispatch.ts` (`case "git"`,
pattern: `case "key"` at :403); `src/cli/help-registry.ts` COMMAND_HELP entry
(name "git resolve"); command-catalog derives automatically. Flags: `--json`,
`--confirm <token>`; verb positional, default `show-me`.

- Journal recovery runs first (same as apply).
- **show-me** (default; "read-only" = rbox-status footprint — identity probes
  may write-tree unreferenced objects and import into scratch refs):
  loads state/records; imports pending/incoming section artifacts to scratch
  (when fetchable) for ownership inspection; prints: local-only commits (tips
  absent from incoming-ownership roots, with `git log --format=%s` subjects),
  incoming checkout target (branch label, never OID), oracle dirt
  classification (oracleFromState), index/op-state/stash divergence, deferral
  lane ages, and the snapshot identity token. Token = sha256 over
  (stream, stateNonce, incomingKey, repoGen, sorted live ref map + reflog
  tips, HEAD, index projection, op-state map, stash reflog OIDs, oracle
  receipt hash). `--json` variant mirrors it without OIDs except the token.
- **take-theirs**: requires `--confirm <token>`. Recompute snapshot; ANY
  mismatch (new dirt, new op-state, moved ref, replaced incoming section) →
  abort, re-show, exit 1 (fresh confirmation needed). Execution: quarantine
  first (quarantineLocal capture-grade + index/op-state copies), pin every
  local-only tip and stash reflog OID as HUMAN-ORIGIN recovery pins, then run
  the NORMAL follow pipeline — journal (with `episode`), locks, second proof —
  with human-divergence gates waived ONLY for divergences enumerated in the
  confirmed snapshot; snapshot revalidated at the second-proof boundary under
  the checkout locks. Works under `RBOX_GIT_FOLLOW=0` (manual authorization
  through the same journaled machinery). Pointer/ownership design-43-strict:
  stash pinning only on owning dir repos; sibling-worktree collision → typed
  refusal NAMING the sibling worktree (actionable, not a silent no-op).
  On success: clear deferral/checkpoint/pending via the normal state save.
- **keep-mine** (attempt; DROP from the PR if the seam does not land cleanly —
  the verb then prints "not yet supported in this build" with recovery
  instructions): protect-then-clear (r4 F6, r5 F1, r6 F1, r7):
  1. fetch + decrypt-verify the pending/incoming section's artifacts; refuse
     if unfetchable (only explicit `--force-discard-incoming` overrides,
     loudly logged);
  2. retain IN the workspace quarantine area
     (`<root>/.rbox/git-quarantine/keep-mine-<ts>/`) the decrypt-verified
     artifact FILES: full bundle chain + index + op-state bytes;
  3. verify closure: enumerate the retained index artifact's stage OIDs
     (git ls-files --stage with GIT_INDEX_FILE on the retained copy) against
     the retained chain (`git bundle list-heads` + rev-list in a scratch
     import); pack missing-but-locally-present objects into a supplementary
     quarantine pack (`git pack-objects`); closure impossible → REFUSE;
  4. import + pin incoming heads/tags/checkout tips/stash roots AND
     commit-bearing incoming op-state roots as human-origin (permanent) pins;
  5. only then clear: mark the repo force-capture and clear
     deferral/checkpoint/pending riding the SAME accepted-commit state
     transition as the forced push (run the push pipeline for the workspace;
     failure of import/capture/network/commit leaves the deferral intact);
     409 → re-fetch, re-show, fresh confirmation required.
  6. durable episode record (JSON beside the quarantine artifacts) naming
     them; survives the clear; show-me lists it until explicitly discarded.
  keep-mine weakens NOTHING on receivers (their own apply classifies).

### Tests

`src/cli/git-cmd.test.ts` (FakeRemote fixtures): show-me summary + token
stability; take-theirs happy path (local commit → quarantined+pinned+followed,
bytes untouched); take-theirs CAS abort on injected concurrent edit/ref move/
new incoming; take-theirs under `=0`; sibling-worktree named refusal;
keep-mine protect-then-clear ordering (fail the push → deferral intact,
artifacts retained), closure repair with supplementary pack, unfetchable
refusal, staged-resolution-blob survival byte-exact; pointer-repo stash rules.

---

## D7 — validation matrix + rig + hygiene sweep

**Files:** new `src/cli/sync-git/follow-matrix.test.ts`;
`scripts/rig/scenarios/git-entanglement.ts` extension.

- **Matrix**: for each incoming topology {same-branch FF, branch switch,
  detached HEAD} generate all 16 combos of
  {syncDirt, humanDirt, localCommits, localStash} (48 principal cases) with
  REAL git fixtures against applyGitSections + oracle. Assert per case:
  follows iff humanDirt=0 ∧ localCommits=0 ∧ localStash=0 (syncDirt never
  changes the answer); working bytes untouched by the Git phase; HEAD form
  exact; index identity/op-state/stash correct; safe non-current refs advance
  on deferred rows; protected refs + receiver-only commits reachable;
  base/pending/partial/deferral records exact; retry idempotent + preserves
  deferredSince; clearing the local blocker lets the pending checkout follow
  WITHOUT another remote commit.
  Keep the fixtures shared/fast (one base repo template cloned per case).
  Crossed dims indexDiverged/opStateDiverged: add targeted interaction cases
  (~12) rather than full pairwise (deviation noted in PR); incoming-stash row;
  receiver-alias rows conditional on fs probe; scan-deferred row.
- **Safety/compat cases** (mostly land inside D1–D6 dispatch tests; sweep for
  gaps): staged-only edit w/ oracle-equal bytes; mode-only index edit; local
  op-state; NFF current tip contained by incoming; attached↔detached; races
  around the linearization point (git add/commit/checkout/stash/op-state
  before → protected; after → post-follow work); busy/unreadable/artifact/
  config-after-safe-refs; §13.5 unchanged; flag arms incl. invalid values.
- **Rig**: extend `git-entanglement.ts` — new rounds: (1) modify a TRACKED
  file on A while A moves HEAD (FF, branch switch, detached), B lands files
  first then git follows; assert B HEAD/tip/index converge with
  pending/partial/deferral absent, two idle cycles publish zero sequences;
  (2) LINKED-WORKTREE regression: B adds `git worktree add` of a synced
  branch at identical OID → follow with no hold; diverged OID → held ref +
  checkout still follows (the phase-0 pinned shape); (3) B-local edit /
  local commit / staged change / stash rounds stay safe while unrelated refs
  advance and the aged reason is visible in `rbox status`.
- Hygiene sweep at the end: bounded teardowns, real-time deadlines, no
  module-state leaks (esp. the capability-probe cache and log-once sets —
  provide injection seams), async work awaited before tmpdir removal.

---

## Dispatch order

D1 → battery → D2 → battery → D3 ∥ D4a (engine modules only: journal,
checkout-txn, index-identity, reachability, keep-pins + unit tests; interfaces
frozen in this spec) → battery → D4b (follow.ts + sync-git/apply.ts
integration) → battery → D5 ∥ D6 → battery → D7 → battery → review round 1
(full diff) → fixes → review round 2 (oracle, journal/crash, per-ref holds) →
fixes → /simplify → /antislop-codebase → battery → PR.
docs/CODEMAP.md updated for every new/changed module. Delete SPEC-116-impl.md
before the PR? NO — keep it out of the commit (git exclude), it is a working
file.
