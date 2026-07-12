# 108 — Files-first first publish: commit files fast, attach git history after

Status: Design draft v5 (2026-07-12) — CORRECTNESS-ALIGNED at the round-5 cap
(codex adversarial loop; ledger in `REVIEW-108.md`). Round 5 confirmed the two
round-4 must-fixes and found no remaining delete-echo / partial-chain /
double-charge / GC / receiver-race / mutex / genesis-gating / semantic defect;
the sole residual (a `timeToFilesSyncedMs` start-timestamp definition) was
applied per the reviewer's exact prescription. Founder decisions in §8 remain
open by design. Round 1 (REVISE, 2 BLOCKER + 8 MAJOR)
collapsed the design to the **two-commit terminal baseline** (round-1 finding
12): git attaches through the EXISTING commit machinery on the next ordinary
push, which dissolved the per-repo cursor (BLOCKER 2), the wire count (BLOCKER
1), the long-lived orphan-chain GC window, and the mutex-hold question. Round 2
(REVISE, precision fixes on that baseline) added: the files-must-diff activation
guard (empty/git-only genesis can't defer forever), an explicit two-push init
driver for commit 2, genuine-first-init genesis gating (rebind excluded), a
loop-carried 409 abort latch, and per-commit metrics ownership. Ledger in
`REVIEW-108.md`. Client-only; NO server/wire-format change in v1.
Measurement-first, falsification-first (design-85 discipline). Flag-gated
(`RBOX_FILES_FIRST=1`); GENUINE first-publish path only (§3.4/§6). Round 3
(REVISE) confirmed init holds ONE mutex across both commits (no design-93
change), closed an all-files-deferred git-starvation hole, and fixed
per-commit metrics finalization. Round 4 (REVISE) wired the starvation fallback
as a nonterminal `RecoveryAction`, closed a module-global timing-state leak, and
made the second init push conditional. Round 4's NIT confirmed the mutex,
genesis-predicate, and schema-transition fixes hold.

Framing: onboarding is THE conversion moment (design 98/100 framing). A new
user's first timed experience of rbox is the initial publish. It must reach
"files synced ✓" in ~1–2 minutes and let git history stream afterward,
invisibly and resumably.

## 1. Problem and evidence

**Measured (2026-07-12 greenfield benchmark, real corpus, full modern stack —
designs 99/107 encryption fixes in, design-98 Tier-1 file pipeline available).**
A fresh-workspace publish of **~88k files / 114,787 blobs took 578s wall**. The
upload moved **2.5 GiB**, of which **2.1 GiB (84%) was git history** — 114
repos' pack chains, four packs 118–640 MB. The user-facing FILE bytes are only
**~0.4 GiB** (≈60–90s at a residential ~50 Mbps uplink). Encryption is no
longer the pole (designs 99/107 retired it); **at residential uplink the BYTES
are the wall.**

**The ordering is backwards, measured in code.** Today git capture rides the
push BEFORE files: `planGitSections` (the `git-plan` phase, `src/cli/sync.ts:748`)
runs `captureGitState` per repo, and each capture uploads its encrypted bundle +
pack-chain artifact blobs during capture (`src/engine/git/capture.ts:176`,
blobs put via the store). The greenfield spinner shows "capturing git state
N/114" (the 2.1 GiB) while the 0.4 GiB of user files wait BEHIND it. Only after
every artifact is captured does `encryptAndUpload` (`sync-recovery.ts:125`)
push file blobs, and only then does `api.commit` publish ONE manifest whose
`gitRepos` already references every uploaded chain (`e2ee-remote.ts`).

**Consequence.** Time-to-files-synced ≈ total wall ≈ 578s. The 84% that is git
history — which no user is waiting to see materialize — sits IN FRONT OF the
thing they are waiting for. **The fix is to move the first git commit from
commit 1 to commit 2**, so files commit first and git attaches on the next
push.

**Second gap (folded in here): the greenfield publish emits no
FirstPublishStats.** `init-cmd.ts:222` calls `push(plan.root, authed, deps)`
with `deps.report` unset, so `report = PhaseReport.disabled("push")`
(`sync.ts:716`), `firstPublishTiming.enabled` is false
(`sync-recovery.ts:140`), and the design-98 `FirstPublishStats`
(`upload-lane-timing.ts:6`) never renders on the ONE run it was built to
measure. §3.6 fixes this.

## 2. Root cause and the falsifications that shape the design

The naive hope — "upload git chains lazily and commit files once with the
chains marked pending" — is falsified by two invariants:

1. **A committed manifest may not reference an absent/unentitled blob (design 84
   I3 / design 98 invariant).** Git artifact blobs live in `manifest.gitRepos`,
   and `blobRefsForManifest` (`e2ee-remote.ts:79`) folds every `bundleEncSha` /
   `packChain[].encSha` / `indexEncSha` / `opState[].encSha` into the commit's
   accounted `shas`; commit admission requires each present + ENTITLED at commit
   time (uploading a blob mints only an ephemeral receipt — only redemption at
   commit grants the `blob_ref`, design 98 §2.3/§6.1). A commit referencing a
   not-yet-committed chain 422s (`res.unsatisfiedBlobs`, `sync.ts:903`). **A
   one-commit-with-pending-chains design cannot exist** without weakening commit
   admission or committing a manifest whose chains are absent.
2. **A receiver must never materialize a repo from a partial/broken chain
   (design 93 atomicity).** A repo's section is only ever committed with its
   whole chain present; the receiver either imports a COMPLETE chain or sees no
   `gitRepos` entry at all (design 100 base-exclusion — "no repo yet," a clean
   absence). Design 108 does not change how a git section is committed or
   applied — only WHEN the first git commit happens.

**The governing move (round-1 finding 12): make the first commit files-only and
let git attach through the ORDINARY next push — no new commit-admission, GC,
CAS, or receiver machinery.** Because git still arrives via a normal commit,
every existing invariant (redeem-then-admit, 422 recapture, per-repo
defer/pending, receiver apply) holds unchanged; the only new behavior is a
one-commit git deferral on genesis.

## 3. Design

### Invariant (stated first, design-85 style — honestly bounded)

> **On a genesis first publish, commit 1 publishes FILES ONLY under the
> UNCHANGED commit-admission invariant; git history attaches on the NEXT
> ordinary push (commit 2), which captures, uploads, redeems, and commits git
> exactly as a steady push does today — so every committed manifest references
> only present+entitled blobs, a receiver materializes only COMPLETE chains
> (design 100 base-exclusion otherwise), and resume/GC/422 behavior is the
> existing machinery verbatim. The ONLY new behavior is: the genesis commit
> attempt defers git capture; the owed set is not stored but DERIVED each push
> as "discovered repos absent from `base.gitRepos`" (re-computed from disk truth
> like today's git-plan), so a crash after commit 1 forgets nothing.**
>
> **Accepted exposures (stated honestly):** (a) total upload BYTES are unchanged
> — at residential uplink the wall is the bytes; total wall is RE-ORDERED, not
> reduced; time-to-files-synced is the win. (b) History is visible on a second
> device LATER than files (that is the point) — until commit 2 lands, a joiner
> has the files and no repos, a clean base-exclusion state. (c) **Publisher-loss
> semantics change (round-1 finding 4):** if the ONLY device is permanently lost
> AFTER commit 1 but BEFORE commit 2, its git history — which lives in that
> device's local `.git` and was never uploaded — is not recoverable by other
> devices, whereas today's atomic single commit would have committed nothing.
> Files are safe (committed at seq 1). The resume guarantee is bounded to the
> same surviving publisher; §8 asks the founder to confirm this trade.

The correctness floor is the current code's: content-addressed idempotent PUT,
redeem-then-admit commit accounting, per-repo capture/defer/carry
(`planGitSections`), `gitPendingRemote`/`gitReposRemoved`/`gitNeedsResolution`,
`gitForceForMissingBlobs` 422 recovery, the design-93 CAS `RepoRecord` unit, and
design-98 resume. Design 108 REORDERS when the first git commit runs; it weakens
none of them and adds no new commit-admission/GC/receiver surface.

### 3.1 Commit semantics — DECISION: two-commit terminal (files, then attach)

**Commit 1 — files only.** On a genuine first publish (`RBOX_FILES_FIRST=1` ∧
genuine-first-init genesis ∧ **the file plane has a real diff vs base**, §3.4),
the push defers git capture and commits a files-only manifest (empty/absent git
section). The design-98 file pipeline runs with full uplink; commit 1 ACK is the
"files synced ✓" milestone.

**The files-must-diff guard (round-2 BLOCKER 1).** Files-first activates ONLY
when the scanned file plane differs from the applied base. A workspace with no
syncable files (empty repo, git-only, only-ignored files) would otherwise make
commit 1 a no-op (`filesUnchanged && gitUnchanged`, `sync.ts:767`), leaving the
sequence at 0 so genesis re-fires every push and git is NEVER captured. When
files do not diff, files-first is bypassed and the attempt runs ORDINARY git
planning (the normal single git-first commit) — correct, because a workspace
with no files to prioritize gains nothing from reordering.

**Commit 2 — attach all currently-capturable git (an ORDINARY push).** After
commit 1, a SECOND `push` attaches git: it is a NON-genesis steady push whose
`planGitSections` runs against a base with an empty/absent git section, so every
discovered repo reads as "needs capture" (`keys = discovered ∪ base ∪ pending`,
`sync-git.ts:518`; base/pending empty on a fresh genesis state), captures +
uploads + redeems + commits through the existing path. This is the current
steady-push git flow, unchanged, now running AFTER files are durable. No new
lane, no per-repo cursor, no special commit type. **"All git" means all
currently-capturable/admitted repos (round-3 finding 5):** `planGitSections` may
still DEFER a repo (capture failure, a busy/locked repo, a config fault, the
new-repo admission cap) exactly as today; deferred repos stay owed (re-derived
from the still-empty base by the next push) with no delete-echo, and the command
reports "git history still uploading" while any remain. Commit 2 is terminal for
the repos it can capture, not a guarantee that every repo attaches in exactly one
commit.

**Who drives commit 2 (round-2 BLOCKER 2).** The successful init `push` branch
(`init-cmd.ts:218-222`) is made to perform TWO `push` calls under the SAME
already-held first-sync mutex. Init acquires the workspace sync mutex ONCE
(`init-cmd.ts:169`) and passes it via `deps.syncMutex` so inner pushes run WITHIN
it without re-acquiring — design 93's "init/setup first-sync owns the whole
first-sync decision→mutation→state-save interval." So: commit 1 (files, git
deferred) → render "files synced ✓" → commit 2 (an ordinary git-attach push,
same held mutex, still `deps.syncMutex`) → release. **The second push is
CONDITIONAL (round-4 finding 4):** it is issued only when commit 1's `PushResult`
signals a files-only sequence-advancing commit with git still owed (a new
`PushResult` signal — e.g. `gitDeferred: true` — set exactly when
`filesFirstDefer` produced the commit). If commit 1 BYPASSED files-first (no file
diff, §3.1) or FELL BACK to git-inclusive planning (§3.2 fallback), it already
captured git and no second push is scheduled. This keeps the "commit 1 report /
commit 2 report" labels honest. The mutex is NOT released
between the two commits, so no other process can interleave during init (this
matches today: init already holds the mutex across the full first publish; 108
only reorders the work under it). **This needs NO design-93 change (round-3
BLOCKER 1):** the init-owned first-sync interval simply now contains two `push`
calls instead of one; the decision→mutation→state-save invariant holds for each
and the interval still ends with exactly one release — no release/reacquire, no
handle replacement. Commit 2 has its OWN success/failure UX: commit
1's "files synced ✓" stays true regardless; if commit 2 fails or the whole init
is interrupted (mutex released on process exit), the command reports "git
history still uploading — will resume" and the DAEMON (or the next manual push)
finishes it by re-deriving the owed git from the empty base. The daemon is the
crash BACKSTOP, not a concurrent competitor during a live init.

**Why not per-repo incremental attach (round-1 finding 12).** v1 proposed
attaching each repo as its own delta commit, ordered biggest-pack-last, for
incremental history visibility. That added a durable CAS cursor, a
transactional wire count, a long-lived orphan-chain GC window, and a
mutex-granularity question — for UNPROVEN incremental value. The two-commit
terminal baseline delivers the measured win (files in ~90s) with essentially
zero new correctness surface. Incremental size-ordered attach is split to a
phase-0-gated OPTIONAL (§3.7), built only if P0 shows the incremental visibility
matters.

**Deferral mechanism (crash-safe by construction, round-1 finding 2, narrowed
round-2 finding 3).** The owed set is NOT persisted. The crash-safe property is
stated precisely: **after an acknowledged, sequence-advancing files-only commit
1 from a genuinely-fresh genesis state**, the base carries an empty/absent git
section and all git sidecars (`gitPendingRemote` / `gitReposRemoved` /
`gitNeedsResolution`) are empty; the next push re-derives "repos needing
capture" purely from disk truth vs base — exactly today's `planGitSections`
logic (`sync-git.ts:518`). A crash after commit 1 ACK loses nothing: restart
re-scans, sees files at seq 1 (no re-upload) and no git in base (all git
re-derived as owed). Because commit 1 only fires when files diff (§3.1) and
genesis state is fresh (§3.4), commit 1 always advances the sequence and never
inherits stale sidecars — the deferral path is asserted to leave every git
sidecar empty (a test pins this). The genesis defer applies to the
`parentSequence === 0` attempt only; once the applied sequence is ≥ 1 the push
is steady and captures git normally.

**No delete echo (design 44 / design 100 base-exclusion).** The empty/absent git
section on commit 1 is NOT a removal: on genesis there is no base git section to
delete, and `planGitSections` records removal memory (`gitReposRemoved`) only
when a `.git` genuinely disappears (`sync-git.ts:509-516`), never for a
never-published repo. A never-published deferred repo is simply OMITTED —
identical to today's "never-synced deferred file is simply omitted"
(`sync.ts:834`).

### 3.2 Where the deferral is wired (single decision point + abort latch)

`planGitSections` gains one genesis-defer input: when files-first genesis mode is
active for THIS commit attempt, it returns an empty/absent git section /
`changed = false` for the git layer WITHOUT capturing (skipping the per-repo
`captureGitState` uploads), leaving every local-only sidecar untouched. The rest
of `runPushAttempt` is unchanged — files encrypt/upload and commit exactly as
today. This is the ONLY code decision unique to 108; commit 2 reuses
`runPushAttempt` verbatim.

**Exact call-site predicate + persistent abort (round-2 finding 5).** The defer
decision is computed INSIDE `runPushAttempt`, AFTER `loadState` (`sync.ts:717`),
from the current attempt's state — never once outside the retry loop:

```
filesFirstDefer =
     filesFirstFlag                       // RBOX_FILES_FIRST=1
  && !filesFirstAborted                   // loop-carried latch (below)
  && parentSequence === 0                 // == appliedSequence; genesis attempt
  && !stateWasStreamMismatch(state)       // genuine first-init, NOT a rebind (§3.4)
  && fileDiffNonEmpty(appliedBase, local) // the files-must-diff guard (§3.1)
```

`filesFirstAborted` is a loop-carried latch in the `pushManifest` retry loop,
set on TWO triggers:
- **409 / epoch-stale** — any attempt taking the `pull-first` or `epoch-stale`
  branch (`sync.ts:897,894`). Two independent conditions then disable the defer
  (refreshed `parentSequence` ≥ 1 AND the latch), so the retry after a 409 always
  captures git.
- **No-advance commit 1 (round-3 MAJOR 2 / round-4 finding 1 — the
  anti-starvation trigger, wired as a RecoveryAction).** A files-first attempt
  can commit NOTHING if `encryptAndUpload` defers every changed file:
  `deferManifest` reduces the committed file plane to the base and the post-defer
  short-circuit returns `committed:false` at sequence 0 (`sync.ts:845-851`).
  Left alone, genesis re-fires every push and git STARVES. This is NOT wireable
  as a latch-only "same-run retry" (round-4 BLOCKER): an `AttemptOutcome` of
  `{done:true, committed:false}` is TERMINAL — `pushManifest` returns it
  immediately; only `{done:false, action}` iterates (`sync.ts:557,634,849`). The
  precise wiring:
  - a NEW nonterminal `RecoveryAction {kind:"files-first-fallback"}`;
  - `filesFirstAborted` is a field on `PushAttemptState` (the loop-carried
    struct), not an ad-hoc local;
  - when `runPushAttempt` ran with `filesFirstDefer` active AND would otherwise
    return the `committed:false` no-advance result (`sync.ts:849`), it instead
    returns `{done:false, action:{kind:"files-first-fallback"}}`;
  - the loop's arm for that action sets `state.filesFirstAborted = true` and
    re-runs the attempt with ordinary git-inclusive planning — it does NOT pull,
    NOT refresh the epoch, NOT enter the `reupload` recovery path, and does NOT
    consume the `MAX_ATTEMPTS` 409 budget (a mode switch, not a conflict); an
    independent fallback cap of 1 prevents any loop. `state.local` is rebuilt by
    the re-run's normal scan/plan, so no attempt state carries over.
  Files-first is thus best-effort and never blocks git. Test: sole-file workspace
  whose only file is permanently unstable/churning → the fallback action fires
  exactly once, the re-run captures git and advances the sequence.

A test also pins: retry-after-409 invokes real git capture.

The mutex/daemon story: init holds ONE first-sync mutex across BOTH commit 1 and
commit 2 (§3.1) — no mid-init release; the daemon interleaves only after
init-death (§4.6).

### 3.3 Entitlement, GC, and 422 — the existing machinery (round-1 findings 5/6)

**Entitlement (correcting v1's error).** Uploading a git artifact mints only an
ephemeral receipt; the `blob_ref` entitlement is granted at COMMIT time when the
commit redeems its receipts and admits (design 98 §6.1). There is NO separate
"wait until missingBlobs is empty" pre-gate. Commit 2 captures + uploads +
commits in one push, so the artifact blobs are redeemed+entitled by commit 2's
own admission — exactly like files today.

**GC / orphan window.** Because commit 2 uploads-then-commits within a single
push (like today), there is NO long-lived uploaded-but-uncommitted chain across
commits. The only orphan-entitlement exposure is the ordinary design-98
within-push window (redeemed-then-commit-fails → GC-reclaimed, re-run
re-commits, §6.3 of design 98). Design 108 adds no new GC surface and no
pinning.

**422 self-heal (existing loop, trace).** If commit 2's admission finds a chain
blob missing/unsatisfied → `res.unsatisfiedBlobs` (`sync.ts:903`) →
`gitForceForMissingBlobs(committed.gitRepos, missing)` (`sync-git.ts` /
`sync.ts:574`) forces recapture of exactly the repos whose sections reference
the missing encShas → `reuploadOutcome` retries the SAME manifest (recapture +
re-upload, no pull, no re-scan). Loop terminates because each recapture
re-mints present blobs; a repo that cannot be captured defers via the existing
per-repo catch (`gitNeedsResolution`/deferred) and the rest commit. This is the
current code path verbatim — 108 introduces no new recovery state.

**Resume of the git tail = current floor.** Interrupting commit 2 mid-capture
resumes by re-running `planGitSections` (re-derives owed from the empty/absent base git section),
re-capturing (git bundles are re-produced) and re-uploading with idempotent PUT
+ `missingBlobs` skip. This is exactly today's first-publish git-resume behavior;
108 does not regress it. The IMPROVEMENT is the FILE plane: files at seq 1 are
never re-uploaded (design 98 §6.1 / design 44 base semantics).

### 3.4 Genesis predicate and scope fence (round-1 finding 9)

Files-first mode must trigger ONLY on a GENUINE first-init, never on a rebind /
state-loss / stale local client that could false-genesis over a live remote
(design 44 poisoned base):

- **The stream-mismatch reality (round-2 finding 4).** `loadState` maps ANY
  stream-mismatched state — even one with a persisted NONZERO sequence — to a
  fresh object with `lastSyncedSequence === 0` and an empty base (design 44).
  So `seq === 0` ALONE does NOT distinguish a genuine first-init from a rebind.
- **Decision: exclude rebind.** Files-first activates only when
  `state.lastSyncedSequence === 0 ∧ !stateWasStreamMismatch(state)` (the latter
  is the flag `loadState` sets when it discarded a mismatched state,
  `sync.ts:800`). A genuine first-init has no prior state file → no mismatch →
  files-first. A REBIND (mismatch flag set) takes the ORDINARY push path:
  design-44-safe (it pushes the full file tree, never deletes) and captures git
  INLINE in one commit — exactly today's rebind behavior. This also avoids a
  wasted file upload before an inevitable 409 on a rebind over a live remote.
- **Remote-head abort (belt-and-suspenders).** Even for a genuine first-init,
  the genesis commit posts `parentSequence = 0`; if the remote unexpectedly has
  commits, the commit 409s → pull-first → `filesFirstAborted` latch set +
  applied sequence ≥ 1 (§3.2) → files-first OFF for the run → git captured on
  retry. A single 409 exits it.
- **Design-44 safety:** committing files-only on a genuine first-init is design
  44's "fresh binding pushes its full tree" — safe; deferring git merely means
  git attaches on the next push. No new poisoned-base exposure; the mass-delete
  guard (`sync.ts:858`) is unaffected (no deletes on genesis).

Steady state (non-genesis) and rebind are untouched: git capture stays
synchronous in `git-plan` (§4.4).

### 3.5 Receiver behavior — existing machinery, no wire signal in v1 (round-1 findings 1/7)

**No new manifest/wire field (BLOCKER 1 fix).** v1's `gitAttachRemaining` scalar
was incompatible with design-84's fold / `FileOnlyManifest` / `manifestFromMeta`.
It is DROPPED. Since git sections arrive only via ordinary commits, the receiver
needs nothing new:

- **Commit 1 (no git):** a joiner materializes files immediately; repos are
  absent = design 100 base-exclusion "no repo yet," a clean state, never a
  deferred-error-per-pull. A joiner that then goes offline is valid (files
  synced, no repos) and converges on its next pull.
- **Commit 2 (git attaches):** every repo's section arrives with its complete
  chain; `importGitPackChain` runs on a complete chain; if the joiner defers a
  repo it uses the EXISTING `gitPendingRemote` machinery; a later remote delete
  uses the EXISTING `gitReposRemoved` / `gitBaseAfterCommit` machinery. §4.3
  enumerates the traces; none is new to 108.

**Design-84 schema transition (round-3 NIT 6, precise).** Commit 1 is stamped
with the file-only schema (`stampManifestSchemaForCommit` yields no `gitRepos`
requirement — schema may be absent/0); commit 2's ordinary
`stampManifestSchemaForCommit` promotes the manifest to ≥ 2 when `gitRepos`
appears, and the accepted ACK atomically persists `manifestMeta.gitRepos`
(design 84 §3.4). `emptyToUndef` means commit 1 has an ABSENT git section, not
`{}`. No new fold operation and no new wire field are introduced — this is an
ordinary schema-0/file-only → schema-2/git-bearing transition, delta- or
snapshot-encodable exactly as design 84 already specifies. A focused test
substantiates the "orthogonal to design 84" claim.

**Joiner-side "history pending" indicator is a founder question (§8), not v1.**
A joiner cannot locally distinguish "no git here" from "git still uploading"
without a signal, but that is a UX nicety, not correctness (design 100's own
base-exclusion state has the same property). The PUBLISHER's local `rbox status`
DOES know its owed set (discovered repos absent from base) and can show
"attaching git history: N repos" locally, names allowed locally, NEVER in
emitted metrics (design 97).

### 3.6 Progress and metrics (Q5) — per-commit ownership (round-2 finding 6)

Metrics do NOT span the two pushes; each push owns a SEPARATE report instance
(round-3 MAJOR 3):

- **Fresh report per push, exactly one render each.** `deps.report` is a single
  mutable field, so reusing it across two `push` calls would produce one
  combined/double-rendered summary. Init instead creates a FRESH
  `beginReport("push")` for commit 1 and another for commit 2, assigns each to
  `deps.report`, and calls `logSummaryTo` exactly once per push, clearing between.
  (`beginReport` already gates on `metricsEnabled()` — do NOT pass
  `metricsEnabled()` into a `PhaseReport` constructor.)
- **Finalize on SUCCESS only (round-3 MAJOR 3).** Today `finishFirstPublishStats`
  runs right after `api.commit`, BEFORE the `epochStale` / 409 / `unsatisfiedBlobs`
  checks (`sync.ts:891-910`), so a FAILED attempt would append a success KPI and
  disable timing, and a retry would append a second. The design REQUIRES moving
  finalization to AFTER a successful admission + state save. The ACK TIMESTAMP for
  `timeToFilesSyncedMs` is captured at the ACCEPTED commit response (after
  rejecting epoch/409/422), but the stats are FINALIZED/RENDERED only after the
  state save succeeds — so the KPI reflects a real ACK yet only renders on a
  fully-persisted commit. 409/epoch/422 attempts render no FirstPublishStats.
- **Close the module-global timing on EVERY non-success path (round-4 MAJOR 2).**
  `firstPublishTiming` is a module singleton begun in `encryptAndUpload`; it stays
  ENABLED after a terminal `committed:false`, a thrown commit/state-save error, or
  a `finishFirstPublishStats` that returns no stats (`!firstUploadAt`), and would
  then absorb timing events from LATER unrelated work. The design REQUIRES: every
  attempt that does not transfer ownership to finalized stats resets/disables
  `firstPublishTiming` in a `finally`, and finalization disables timing even when
  it returns no stats (ideally the accumulator is scoped to the push/report rather
  than a module global — fresh `PhaseReport` instances do NOT isolate the
  singleton). Tests: a 409-then-success and a multi-page-422 commit 1 emit exactly
  ONE FirstPublishStats on the successful attempt; a failed/no-upload push
  followed by an UNRELATED push shows no leaked timing.
- **`timeToFilesSyncedMs` — exact definition (round-5 MAJOR).** It is a NEW
  field on `FirstPublishStats` (+ its formatter), and its START is the
  COMMAND-LEVEL milestone — captured when init BEGINS the first push/report,
  BEFORE scan and git planning — NOT `firstPublishTiming.startedAt` (which begins
  inside `encryptAndUpload`, after scan+git-plan, and would wrongly exclude the
  scan wall the §5/§7 "command milestone" gate requires). That start timestamp is
  carried into the attempt timing context; the END is captured immediately after
  an ACCEPTED (non-409/non-422/non-epoch-stale) commit response; the value is
  finalized/rendered only after a successful state save. A test with an injected
  scan delay proves the delay is INCLUDED. Commit 1's report renders it (git
  excluded — the headline greenfield KPI).
- **Commit 2's report renders** `gitAttachWallMs`, `gitAttachReposTotal`,
  `gitAttachBytesTotal` (numbers only) from its own `git-plan` phase. All
  counts/bytes/durations only (design 97); a test asserts no path-shaped (`/`) or
  64-hex string appears. The populate-status writer keeps driving the live
  spinner; the report is the metrics sink.

### 3.7 OPTIONAL, phase-0-gated: incremental size-ordered attach (NOT v1)

If P0 (§5) shows that incremental history visibility on a second device is worth
its cost, a FOLLOW-UP design may attach repos in multiple commits ordered by
pack size ascending (biggest last), so most repos are visible sooner. That mode
re-introduces the round-1 attack surface it must then close: a durable owed
cursor tied atomically to the ACK packet (finding 2), a transactionally-exact
receiver signal or none (findings 1/10), a bounded orphan-chain GC window
(finding 5), a hard commit-count cap `K` with a defined noise protocol (finding
11), and a mutex-granularity + daemon-race spec (finding 8). It is DELIBERATELY
OUT of v1; the two-commit baseline ships first and proves the files-synced win.

## 4. Correctness requirements

### 4.1 No partial-chain materialization (design 93 atomicity)
Git sections are committed only via ordinary commits with the whole chain
present+entitled (§3.1/§3.3). Receiver imports a complete chain or sees no entry
(base-exclusion). Test: joiner pulls commit 1 → 0 repos, files applied; pulls
commit 2 → `importGitPackChain` on complete chains; never a per-pull
deferred-error for an absent link.

### 4.2 Interrupted-resume (Q3) — file plane improved, git plane at floor
SIGINT/SIGKILL after commit 1 and during commit 2: re-uploads 0 committed file
blobs (files at seq 1; reconcile emits no action), re-derives all git as owed
(empty/absent base git section), and the git tail re-captures/re-uploads at the current floor
(idempotent PUT + `missingBlobs` skip) with no double-charge (receipts
idempotent, design 98 §6.2; commit admission grants once). Exact counts for the
file plane; git plane asserted equal to today's first-publish resume.

### 4.3 Receiver traces (round-1 finding 7) — all existing machinery
Enumerate and test, each reducing to current behavior because git arrives via a
normal commit: (a) commit 1 → commit 2 attach applies; (b) commit 2 attach
defers on the joiner → `gitPendingRemote` → later pull succeeds; (c) attach
defers → remote deletes the repo → `gitReposRemoved`/`gitBaseAfterCommit` clear
correctly, no delete-echo; (d) joiner offline across commit 2 and a later delete
→ converges on next pull. The JOINER-side receiver machinery is genuinely
unchanged (git arrives via a normal commit); the only NEW race is on the
PUBLISHER side (init vs its own daemon competing to author commit 2) — that is
§4.6, not a receiver concern.

### 4.4 Steady pushes unchanged (Q6 scope fence, round-1 finding 13)
A non-genesis push captures + commits git inline in one commit, SEMANTICALLY
equivalent to today: identical git planning/capture disposition, equivalent
referenced-blob set, no files-first deferral, no attach-lane invocation. (Not
"byte-identical" — `generatedAt`/nonces/signatures differ every run.) Test: after
the first publish, a steady git change captures+commits inline; files-first mode
is inactive.

### 4.5 Genesis gating + design-44 safety (round-1 finding 9, round-2 finding 4)
Files-first defers git only when `parentSequence === 0 ∧
!stateWasStreamMismatch(state) ∧ fileDiffNonEmpty` (§3.2); a 409/remote-head
discovery latches it off for the run (§3.4). Tests: (a) genuine first-init →
files-first fires; (b) REBIND / stream-mismatch state (even with a stale nonzero
persisted seq) → files-first does NOT fire, ordinary push pushes files (never
deletes) and captures git inline; (c) empty / git-only / only-ignored workspace
(no file diff) → files-first does NOT fire, ordinary git-first single commit,
sequence advances (round-2 BLOCKER-1 regression); (c2) sole-file workspace whose
only file is permanently unstable/churning so files-first commits NOTHING →
`filesFirstAborted` latch fires on the no-advance attempt, the same run retries
ordinary git-inclusive planning and captures git — git is NOT starved (round-3
MAJOR-2 regression); (d) remote-head 409 on a genuine first-init → latch off,
git captured on retry; (e) A→B→A nonce; local state deletion; concurrent
first-publisher (one 409s, exits files-first, converges).

### 4.6 Publisher-side commit-2 driver + init/daemon race (round-2 findings 2/8)
During a LIVE init there is NO race: init holds the first-sync mutex across both
commit 1 and commit 2 (§3.1), so the daemon cannot interleave — it blocks on the
mutex (CLI-contender behavior, design 93) until init releases. The race exists
ONLY on init-death: init dies after commit 1 (mutex released on process exit),
leaving an empty base git section; a later daemon tick (or manual push)
re-derives the owed git and authors commit 2. If, in that post-crash window, TWO
processes attempt commit 2, the design-93 mutex serializes them — exactly one
authors it; the loser acquires the mutex ONLY AFTER the winner's commit + state
save, so its `runPushAttempt` `loadState` reads the fresh state (sequence 2, git
attached in base) and it normally NO-OPS at `filesUnchanged && gitUnchanged`
(`sync.ts:767`). It does NOT submit a stale parent and 409 off the winner — the
mutex guarantees it never runs concurrently. A 409 arises only if an INDEPENDENT
external author advances the head after the loser's fresh load (ordinary
steady-state contention, unchanged). No duplicate accounting (content-addressed
blobs + idempotent commit admission), no double-charge, commit 1's "files synced
✓" intact. If every
process dies before commit 2, the next daemon start or manual push attaches
(bounded to the surviving publisher, §invariant exposure (c)). Tests: live
init + daemon → daemon blocks on the mutex, init authors both commits; kill init
after commit 1 → daemon authors commit 2; two post-crash contenders → exactly one
commit-2, the other no-ops/reconciles.

## 5. Phase 0 (measure before building)

Behavior-neutral instrumentation first (design 85 §5). P0 records, on the
benchmark corpus at ~50 Mbps: current `timeToFilesSyncedMs` (≈ total wall today,
git front-loaded), the file-only critical path (≈0.4 GiB), and the git-chain
bytes + per-repo capture/upload split (feeds §3.7's incremental-value decision).

**P0 kill gate:** if the file-only critical path is NOT materially below total
wall (git is not the majority of bytes on real corpora), the reorder buys little
— STOP. The 84% measurement says it is; the gate re-measures on current `main`.
A SECOND P0 question (gates §3.7 only): does history-visibility latency on a
second device matter enough to justify incremental attach, or is terminal attach
sufficient?

## 6. Scope fence (Q6)

- **Genesis first-publish only** (§3.4). Non-genesis pushes untouched (§4.4).
- **Flag-gated** (`RBOX_FILES_FIRST=1`). Default OFF until gates 1–6 hold on both
  fleet filesystems; the flag stays as an escape hatch for one release
  (design 98/100 rollout precedent).
- **v1 excludes** incremental/size-ordered attach (§3.7) and any wire signal
  (§3.5).

## 7. Gates (falsifiable, benchmark corpus at ~50 Mbps, A/B vs current release)

Statistical protocol (design 98 §7): ≥5 valid runs/side, alternating
control/candidate; `noise(X) = max(p95_ctrl − p50_ctrl, 0.05·p50_ctrl)`; "within
noise" = p50 and p95 each ≤ control + noise.

1. **Files-synced gate (headline).** `timeToFilesSyncedMs ≤ 120s` on the
   benchmark corpus at ~50 Mbps (the ~0.4 GiB of files + commit 1), measured as
   command milestone. Control = current release (git-first), whose files-synced
   ≈ total wall.
2. **Total-wall no-regression (EMPIRICAL, round-2 finding 7).** Total publish
   wall (commit 1 + commit 2) within noise of the current release. This is an
   empirical gate, not a byte-conservation claim: commit 2 adds one full ~47 MB
   manifest re-ship (≈7.5s ideal wire at 50 Mbps, plus encrypt+commit latency)
   that is kept explicitly in the candidate budget. `RBOX_MDE_DELTA` is FROZEN
   identically on both arms (delta would make commit 2 O(git change), but the
   gate must not silently depend on it); the gate passes on the measured wall,
   not on the assumption.
3. **Interrupted-resume gate (§4.2).** Exact file-plane counts: 0 file
   re-uploads; git plane equals today's first-publish resume; no double-charge.
   SIGINT and SIGKILL, after commit 1 and during commit 2.
4. **Receiver-atomicity gate (§4.1/§4.3).** Full-corpus receiver diff clean after
   commit 2; a mid-stream joiner never runs `importGitPackChain` on a partial
   chain and never shows a broken repo; the §4.3 defer/delete traces pass.
5. **Genesis-gating gate (§4.5).** Rebind/stream-mismatch, remote-head 409, and
   concurrent-first-publisher cases exit files-first correctly (design-44 safe,
   no false-genesis over a live remote, no poisoned-base delete).
6. **Scope-fence + privacy gate.** A non-genesis push is semantically equivalent
   to today (§4.4). `FirstPublishStats` and persisted telemetry contain no
   path-shaped or 64-hex string; init renders FirstPublishStats (§3.6).

## 8. Open questions for the founder

1. **Files-synced target.** Is `≤ 120s` at ~50 Mbps the right "it just synced"
   bar, or a specific second-count tied to the onboarding story? (mirrors design
   100 Q1).
2. **Publisher-loss git semantics (round-1 finding 4).** Files-first accepts
   that a permanently-lost publisher between commit 1 and commit 2 leaves its git
   history unrecovered by other devices (files are safe). Confirm this trade is
   acceptable for the onboarding win; if not, git must stay in commit 1 (no
   files-first) or a remotely-durable attach plan is required (a substantial
   wire/privacy design).
3. **Joiner "history pending" indicator (§3.5).** Ship v1 with no joiner-side
   signal (a joiner sees files, then repos as they arrive), accepting that
   "pending" is indistinguishable from "no git" locally? Or is the joiner-side
   count worth a future design-84-integrated wire field?
4. **Incremental attach (§3.7).** Is per-repo size-ordered incremental history
   visibility worth a follow-up design, or is the two-commit terminal baseline
   the end state? P0's second question informs this.
5. **Kill-switch default.** Soak `RBOX_FILES_FIRST` off-by-default for a release
   (design 85 P-2 precedent) before flipping on after fleet validation?

## 9. Out of scope

1. **The design-98 file pipeline internals** — 108 reorders the first git commit
   relative to it; it does not change encrypt/upload/redeem machinery.
2. **Steady-state git capture** (§4.4) — synchronous, unchanged.
3. **Incremental/size-ordered multi-commit attach** (§3.7) — a phase-0-gated
   follow-up, not v1.
4. **Any server/wire/GC/receipt/quota/accounting/auth change** — none; git
   attaches through the existing commit path.
5. **Reducing total upload BYTES** — 108 reorders bytes; shrinking the 2.1 GiB
   of git history (shallower chains, better pack dedup) is a separate design.
6. **Manifest delta encoding** (design 84) — orthogonal; it makes commit 2's
   manifest re-ship O(git change) but 108 is correct and gate-passing without it.
