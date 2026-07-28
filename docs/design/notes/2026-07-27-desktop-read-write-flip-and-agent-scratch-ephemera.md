# Desktop read-write flip with agent worktrees in the tree — decision memo

Date: 2026-07-27

Reviewed against: `d2823414`

## Framing

This note started as "should `.claude/worktrees/` be a built-in default
ignore?" That question is closed and the answer is no. Design 68
(`docs/design/68-worktree-git-sync.md` §1) names agent-workflow developers with
`.claude/worktrees/` as rbox's stated target buyer, design 200 ships worktree
lifecycle resilience, and CHANGELOG 1.9.1 is literally titled "worktrees come
and go, sync keeps up". Worktrees sync. Not re-litigated here.

What is still open is the decision in `docs/STATUS.md:110` — *"Daemon pull-only;
read-write flip pending founder + .rboxignore for agent scratch."* That rule was
written when the concern was litter and gigabytes. This memo replaces the guess
with measurements and asks: **what does the flip actually risk today, and is
there any residual machine-local ephemera worth a built-in default?**

## The measurements

Taken from the founder's live desktop workspace (`~/Development`) and this
checkout, 2026-07-27.

| Fact | Value | Source |
|---|---|---|
| Synced manifest size | 109,049 files | `~/Development/.rbox/state.json` |
| Captured git repos | **100** of a 256 hard cap | same; `src/engine/manifest-validate.ts:22` |
| Live worktrees in `rbox-core` | 7 | `.claude/worktrees/` |
| Their file count | 11,442 (excl. `node_modules`/`.git`/build dirs) | walk |
| Their naive byte size | 168.1 MB | walk |
| Their **content-deduplicated** size | **24.8 MB — a 6.78× collapse** | sha256 walk |
| Worktree files already synced today | 77 (`Personal/rbox-home-page/.claude/worktrees/changelog-page/`) | manifest |
| Worktree entries in `gitRepos` | **0** | manifest |
| Stale `.DS_Store` entries still carried in the manifest | 15 | manifest |
| Desktop `respectGitignore` | **`false`** | `~/Development/.rbox/workspace.json` |

The 6.78× number is the headline. rbox blobs are content-addressed and deduped
per account (`blob_refs(account_id, sha256)`,
`apps/api/migrations/0017_blob_ref_candidates.sql`), so seven checkouts of one
repo cost roughly *one* repo's worth of bytes plus the per-branch diffs. The
"gigabytes" premise behind the standing rule does not survive contact with the
data.

## Risk-by-risk under the flip

### 1. Publish bandwidth — bounded, already paid for

6.78× dedup on the file plane (above), and design 68 §3.3 removed the git-plane
version of the same waste: an in-tree pointer worktree whose main clone is
captured this cycle is **skipped**, reason `linked worktree of in-tree repo
<parent> — history travels with the main clone`
(`src/cli/sync-git/plan.ts:996-1042`). Before that fix, "a repo with 8 agent
worktrees uploads its full history 8 times" (design 68 §1). The skip is a
**base-carry, never a drop**, so the remote observes no absence and no removal
memory is stamped (`plan.ts:1016-1017`). Verified end-to-end at
`src/cli/sync-git/git-sync.test.ts:1045-1070`.

Empirically confirmed on the real workspace: zero worktree entries in
`gitRepos`, despite worktree *files* being synced.

**Not a reason to hold the flip.**

### 2. Git repo-slot inflation — real but not binding

Discovery treats a linked worktree as a first-class repo, `kind: "pointer"`
(`src/engine/git-discover.ts:8-12,50-56`), and `MAX_GIT_REPOS = 256` is a loud
manifest error at the boundary, not a silent drop
(`src/engine/manifest-validate.ts:145`). At 100/256 there is headroom for
~156 more repos; 15 parked desktop worktrees plus the Mac's would not approach
it. But note that in-tree pointers get skipped from *capture* while still being
*discovered*, so slot pressure comes from genuine nested repos, not worktrees.

**Not a reason to hold the flip. Worth a watch item at ~200.**

### 3. Same-branch collisions across machines — shipped mitigation, and the
   scary version doesn't exist

Git refuses to check out one branch in two worktrees; rbox never trips that,
because rbox never runs `git worktree add` or `git checkout` on the receiver.
The genuine hazard is the reverse — `git update-ref` **silently moves** a branch
a sibling worktree has checked out, which design 68 §3.2 called out as a codex
BLOCKER. Shipped handling:

- Apply computes the destination's checked-out set from
  `git worktree list --porcelain` and **holds** any colliding ref
  (`src/engine/git/apply.ts:107-112,163,202-210`; reason string
  `worktree-ownership: branch <b> checked out in linked worktree <n>` at
  `apply.ts:493`).
- 1.9.0 replaced whole-section deferral with **per-ref holds** — "a linked
  worktree holding a branch pins only that ref" (CHANGELOG 1.9.0); everything
  else keeps flowing.
- 1.9.1 removed the ~9s/cycle re-checking cost on held repos
  (`RBOX_GIT_OWNERSHIP_HELD_SKIP` / `RBOX_GIT_OWNERSHIP_NO_ESCALATE` are the
  kill switches; `src/cli/sync-git/held-skip.ts:29-37`).
- An unreadable worktree registry is a per-repo refusal, never an empty
  ownership map (`git-sync.test.ts:2597`).

**Not a reason to hold the flip.**

### 4. Half-written files mid-edit — handled

`scanManifest` does stat → hash → stat-again and defers anything whose stats
shifted across the hash: *"A file that's mid-write … is left for the next round
rather than baked torn"* (`src/engine/manifest.ts:269-270,411`). A deferred path
carries its last-synced entry forward rather than publishing a torn blob
(`src/cli/sync/push.ts:667-676`). Agent sessions writing files continuously hit
this path constantly and by design.

**Not a reason to hold the flip.**

### 5. Churn volume and manifest scale — **this is the real risk**

Flipping read-write adds ~11,442 paths from `rbox-core` alone (+10.5% on a
109k-file manifest), each of them high-churn while an agent is running. The cost
that does *not* dedupe is per-event manifest/journal work, and that has a known
open defect: **#501, the O(n²) journal** — *"120MB journal fully rewritten per
file event, 55GB+ written in 18min, ~6-day projection"* (`docs/STATUS.md:102-105`).
STATUS records the real fix as belonging to the 163 SQLite state plane, with a
"20-line batching stopgap optional".

The secondary cost is git-plan. Design 83 §1 measures it as the largest phase of
a no-op tick — 24.2-25.5s on a 98-repo Mac workspace, with a **13-subprocess
floor per unchanged repo**, serial. The stat-fingerprint cache
(`src/cli/sync-git/fingerprint.ts`) plus the pointer fast path
(`plan.ts:965-990`) make warm steady state near-free, but every cold or
untrusted cycle pays it. Active agent worktrees invalidate fingerprints
constantly, so they are the worst case for that cache.

**This is the one axis where the flip is not already de-risked.** It is a
performance and write-amplification concern, not a data-safety one.

### 6. Orphan worktree directories on the receiver — unhandled, cosmetic-to-annoying

Precisely what arrives on machine B:

- The worktree's `.git` **pointer file never travels** — `isHardExcluded`
  covers `p.endsWith("/.git")` (`src/engine/ignore.ts:316-320`), and
  `BUILTIN_IGNORE`'s comment names this exact case: *"a worktree pointer file
  carries a machine-local absolute path"* (`ignore.ts:13-17`).
- The `.git/worktrees/<n>/` admin dir never travels either (same hard exclude),
  and capture never reads it — the bundle is `--single-worktree --all`
  (`src/engine/git/capture.ts:196-212`).
- No code anywhere writes a `gitdir:` pointer; the only parse site is read-only
  (`src/engine/git/shared.ts:379`).
- The **branch does arrive**, as an ordinary `refs/heads/*` in B's main clone
  (`git-sync.test.ts:1058-1060`).

So B gets a plain directory of files plus the branch in the parent repo, with no
linkage between them. Confirmed live: `~/Development/Personal/rbox-home-page/.claude/worktrees/changelog-page/`
exists on this desktop with no `.git`, and the parent has no `.git/worktrees/`
admin dir at all.

Design 68 §3.1 and the 2026-07-24 reconciliation audit both call per-worktree
identity/lifecycle an **explicit tier-2 non-goal** — *"The identity cannot be
derived from absolute paths because paths and worktree sets differ across
machines."* That is a considered position, not an oversight.

The papercut: with `respectGitignore: false`, that orphan directory is untracked
content inside the parent repo's working tree — `git status` noise and a
`git add -A` foot-gun. Worth an issue; not worth blocking the flip.

## The tension nobody has named yet

`rbox-core`'s own `.gitignore:40` contains `.claude/worktrees/`. So does
`rbox-home-page`'s (`.gitignore:25`, via `.claude/`). Both were verified with
`git check-ignore`.

`respectGitignore: on` excludes gitignored-and-untracked paths, and
`prunesForGitDiscovery` is *always* gitignore-aware regardless of the setting
(`src/engine/ignore.ts:271-273,531-537`). Therefore:

> **On any machine with `respectGitignore: on`, `.claude/worktrees/` does not
> sync at all** — the near-universal convention of gitignoring agent scratch
> silently defeats the shipped "worktrees sync" direction.

The desktop is `respectGitignore: false` (hence its worktrees *would* sync on a
flip), but STATUS records a *"fleet-wide respect-gitignore flip"* on 2026-07-17
(`docs/STATUS.md:1092`). Critically, `workspace.json` is **per-device and never
synced** by design (`src/cli/workspace-config.ts:10-60`), so that July flip had
to be applied machine by machine and the desktop's rejoin legitimately started
from the default. Divergence here is structural, not a bug — but the
*consequence* is that worktrees may sync on one fleet host and not another,
which is a real inconsistency in the exact behavior designs 68/200 were built to
deliver. This deserves a verdict independent of the flip decision.

Note also that there is no propagating knob for it: `.rboxignore` syncs like any
other file (`docs/usage.md:176-178`), but `respectGitignore` and every `RBOX_*=0`
kill switch are per-machine only. There is no `rbox.yml` — design 51 is a draft
and explicitly declined an `ignore:` key in favor of `.rboxignore`.

## Is there any residual machine-local ephemera worth a built-in default?

Honest answer: **almost none. Do not ship a new built-in default set.**

Everything measurable is already covered. `BUILTIN_IGNORE`
(`src/engine/ignore.ts:12-93`) already holds `node_modules/`, `.cache/`,
`dist/`, `build/`, `coverage/`, `.turbo/`, `.DS_Store`, `.env*`, key material,
and rbox's own `.rbox-tmp-*` atomic-write temps. `.git` is hard-excluded
separately and unconditionally. A worktree checkout does not nest another
`.claude/worktrees/` inside itself, so there is no recursion to defend against.

Candidates examined and rejected:

- **`.claude/settings.local.json`** — 31 already synced. It is the one Claude
  Code file that is genuinely per-machine (local permission grants), but it is
  ~1 KB, changes rarely, and syncing it is arguably a feature on a fleet that
  wants uniform agent config. Weak case either way; the founder should rule, not
  a built-in default. Note it is already gitignored in these repos, so a
  `respectGitignore` verdict decides it implicitly.
- **`rbox-daemon-activity-*`** — real litter, but it lands in `~/.rbox/daemons`,
  *outside* any workspace (`docs/papercuts.md:168-178`). An ignore rule cannot
  reach it; the fix is the test that writes to the real `RBOX_HOME`.
- **`.DS_Store`** — already builtin. The 15 stale entries still in the manifest
  are carried-forward legacy from before the rule, which is a nice live
  demonstration of §"ignore mechanics" below rather than a gap.
- **Locks / task tmp inside agent scratch** — searched; nothing distinctive and
  high-volume that isn't already covered by `.cache/` or `.rbox-tmp-*`.

The proposal that started this note would have shipped a default that designs
68/200 spent months making unnecessary.

## Ignore mechanics, only as far as they matter here

Two facts change how reversible any of this is:

1. **Adding an ignore rule never deletes remote state.** The forward-only carry
   (`src/cli/local-file-projection.ts:19-27`) re-inserts the base entry for any
   path that is absent from the scan *and* matched by current rules, so the diff
   sees no change. Ignoring a path **freezes** its last synced copy; it does not
   orphan or prune it. Pull is symmetric — a remote entry that local rules ignore
   is neither written nor deleted and stays in the recorded base
   (`src/cli/sync/pull.ts:284-296`). Deletion is explicit and confirmed only via
   `rbox ignore --purge` (`src/cli/ignore-cmd.ts:72-150`), which is
   tracked-path-protected and mass-delete-guarded.

   **Consequence for the standing rule:** landing an agent-scratch `.rboxignore`
   was never a safety prerequisite for the flip. It is a reversible preference,
   and so is *not* landing it. The rule can be retired on its own terms.

2. **The escape hatch works, but only one spelling of it.** Verified empirically
   against the `ignore` package as wired in `buildIgnoreMatcher`:

   | rule after a `.claude/worktrees/` default | effect on children |
   |---|---|
   | `!.claude/worktrees/` | **re-includes** |
   | `!.claude/worktrees/**` | **still ignored** |

   The second is git's "cannot re-include below an excluded parent" rule and is
   the more intuitive spelling — a trap worth documenting if any directory
   default ever ships.

   Cost of a carry, stated plainly: a carried entry keeps its old
   `sha256`/`encSha` forever, so its blob stays reachable and never becomes a
   Phase-1 prune candidate (`apps/api/src/gc-phase1.ts:61-95`). Freezing pins
   storage silently.

## Verdict

**The flip is safe on every data-integrity axis and is bounded on cost.** Bytes
dedupe 6.78×, git history no longer multiplies per worktree, same-branch
collisions are held per-ref with kill switches, mid-write files defer rather
than tear, and any ignore decision taken later is forward-only and reversible.

**The one live objection is #501's O(n²) journal**, which turns +11k high-churn
paths into write amplification the founder has already measured at 55 GB in 18
minutes. That is a reason to sequence the flip behind the batching stopgap (or
behind 163), **not** a reason to ship a default ignore for agent scratch.

Recommended order: rule on `respectGitignore` fleet-wide (it silently decides
whether worktrees sync at all) → land the #501 batching stopgap → flip the
desktop read-write and watch the journal write volume for one working session →
file the orphan-worktree-directory papercut separately.

## Open questions for the founder

1. **`respectGitignore` fleet-wide: on or off?** It is `false` on the desktop
   after the rejoin, and STATUS says the fleet flipped it `on` in July. With it
   `on`, `.claude/worktrees/` does not sync at all — the shipped worktree
   direction is silently defeated by the repos' own `.gitignore`. This needs one
   answer for the whole fleet before the flip means anything.
2. **Should `respectGitignore` remain a per-machine-only setting?** It lives in
   the never-synced `workspace.json`, so a fleet-wide intent has to be re-applied
   by hand on every host and is silently lost on rejoin. Given how much it
   changes (whether worktrees sync at all), a propagating form — or at minimum a
   `rbox doctor` finding when fleet hosts disagree — looks warranted.
3. **Sequence the flip behind #501, or flip and watch?** The stopgap is
   described as ~20 lines. Flipping first is recoverable (stop the daemon), but
   the projection was 6 days of continuous writing.
4. **Retire the "`.rboxignore` for agent scratch" precondition in
   `docs/STATUS.md:110`?** This memo finds no safety basis for it. Confirm it can
   be struck rather than satisfied.
5. **`.claude/settings.local.json` — sync or not?** The only genuinely
   per-machine agent file found. Tiny either way; wants a ruling, not a default.
6. **Is the orphan worktree directory on the receiver acceptable indefinitely?**
   Design 68 parks per-worktree materialization as a tier-2 non-goal. If the
   founder's mental model is "my worktrees appear on the other machine as
   working worktrees", that model is wrong today and the gap is a designed one —
   worth confirming the expectation rather than discovering it later.
7. **Repo-slot budget:** 100/256 today. Is 256 a number to raise, or a signal
   to keep the workspace root narrower?
