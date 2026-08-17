# 273 — Git-lane legibility: one evidence model, plain-English surfaces

Status: r3 (r1: two adversarial lanes, REVISE ×2, folded; r2: final serial
review, REVISE with a bounded delta, folded here). Scope cuts in r3: P4
(sender deviceId + label cache) split to its own follow-up design;
`rbox git restore-backup` split to its own small design, with 273's batch
take-theirs DEPENDING on it landing first.
Issues: closes #764; #762's dry-run backup pointer lands here, its restore
command lands in the split design. The resolve-command.ts AND
status-view.ts ratchet decompositions are a hard prerequisite PR. Feeds
#659 field close.
Origin: founder session 2026-08-17 (docs/papercuts.md git-lane entry) plus
Max's report that "keep-mine / take-theirs meant nothing".

## Product bar (verbatim requirement)

A user WITHOUT an LLM must be able to go from the status warning to a
confident resolve decision using only rbox's own output. Every surface
answers three questions: **what happened**, **what do I do**, **what could
I lose**. Copy is for a non-developer where possible; the noun for a device
is **"computer"** (matches shipped copy in resolve-presentation.ts:42-51 —
"this computer" / "your other computer"), never "machine". Banned words on
human surfaces: "index", "deferral", "held", "quarantine", "dry run" (as a
noun), "overlap" (unexplained), raw reason codes.

## Defects being fixed (founder-hit, 2026-08-17)

1. `rbox status --git` ellipsizes repo paths (DETAIL_MAX=40 tail-keeping,
   status-view.ts:520-533) — the one identifier the user needs.
2. Headline count (103) ≠ listing count (52). Two mechanisms, both fixed:
   (a) ownership-only holds actively CLEAR their deferral record
   (follow-repo-transition.ts:349-357) making 51 repos invisible to every
   surface; (b) the CLI listing applies a 10-minute transient quiet filter
   (status-projection.ts:60-70) while the ambient/daemon count and doctor
   do not (daemon/ambient-status.ts:271-274, workspace-observation.ts:85-94).
3. Reason labels are jargon; several user-work reasons render raw detail.
4. No dry-run, no batch resolve; a fleet-scale unwedge is N hand-typed
   two-step commands.
5. "keep-mine / take-theirs" names neither computer, and the mockup-level
   fix must match the REAL grammar (`rbox git resolve <repo> <verb>
   [--confirm <token>]`, main-dispatch.ts:706-709) or it recreates the
   defect.
6. No evidence shown: neither side's actual changes, though the facts are
   (or can be made) locally readable.
7. The take-theirs backup is a dead end: an opaque
   `.rbox/git-quarantine/<hash>/<epoch>.bundle` with NO restore command
   anywhere in the tree.

## Design decisions (r2 — each replaces an r1 mechanism)

### P1. Extend the existing evidence Module; do not add one

`projectGitDeferralRepos` / `GitDeferralRepoProjection`
(status-view.ts:343-441, design 116) is already "one authoritative display
row per repo, shared by every local visibility surface" and already carries
`displayReason`, `reasonLabel/Text`, `repairText`, `remediationClass`,
`canResolve`, `canKeepMine`, `checkout`, `oldestDeferredSince`. This design
EXTENDS that projection (stories, the restored ownership population,
evidence) and ABSORBS `GitResolveShow`/`printShow`
(resolve-presentation.ts) into the same renderer family, deleting the
parallel shapes. Net concept count must fall; a third evidence model is a
rejected alternative.

The Module exposes exactly two operations:
- **project(state)** — pure, git-free: population, stories, counts, ages,
  actionability. Used by the daemon/ambient path, the status headline,
  doctor, and `--json` counts. Validation: a `setGitSpawnObserver`-based
  test (engine/git-spawn.ts:12-16) asserts the daemon/ambient path spawns
  ZERO git processes.
- **evidence(state, repos)** — spawns git read-only for local numstat and
  pinned-incoming facts. Manual commands only (`status --git`, single-repo
  view, `--dry-run`). All git calls use `--no-optional-locks` (a plain
  `git diff` writes `.git/index` and would invalidate design-270 held-skip
  fingerprints for every paused repo); per-repo timeout with
  degrade-to-counts; a test asserts `status --git` performs no index
  write.

### P2. Ownership holds keep their deferral record (deletes `heldSince`)

The invisible-51 defect exists because "don't nag about ownership holds"
was implemented by DELETING the record. THREE sites participate, all must
change together (r2 review found the third, which runs every pull):
- follow-repo-transition.ts:349-357 — `deferral: {kind:"clear"}` on
  ownership-only holds → becomes `{kind:"set", reason:"worktree-ownership"}`;
- apply.ts:941-945 mirror (`delete effectiveDeferrals.apply`) → same;
- **held-decision.ts:157-167 `retain()`** — the steady-state held-skip
  path calls `env.deferrals.clearApply(relPath)` for ownership-only prior
  attempts ON EVERY SKIPPING PULL. It must `restandApply` instead, or the
  record restored at the follow site is re-deleted one pull later AND the
  clear/set cycle resets `deferredSince` (shared.ts:171), producing
  permanently-quiet repos under P5.
  (Correction from r1: clean-materialization.ts:255-268 SETS a
  worktree-ownership deferral — it is a hold site, not a clear site; no
  change there.)

Display policy where it belongs: add an `ownership-hold` remediation
class (`remediationClass` is the existing seam, status-view.ts:344).
Ordering rule for EVERY command-emitting or severity-assigning surface
(doctor, status, prompt sidecar, JSON): `remediationClass` is consulted
BEFORE `canResolve`/`canKeepMine` — ownership holds have
`record.pending`, so `canKeepMine` is true (status-view.ts:406) and
doctor-triage.ts:98-118 would otherwise print `keep-mine` for a repo
whose story says "no command needed", and its age-only severity rule
would mark ~51 multi-day holds `blocked`. `ownership-hold` emits NO
resolve command and NO attention/blocked severity anywhere.

Telemetry ledger line: sync-state telemetry (`deferralReasons`,
telemetry/sync-state.ts:12-20,77-81) will show a one-time step change
(~+51 `worktree-ownership` rows on the founder fleet). The class is
reported but excluded from any deferral-count alerting; the PR-B body
names the expected step so health checks don't read it as a regression.

Differential tests: `hasGitResolutionIncoming` (status-view.ts:370-372),
deferral hygiene, daemon `attentionReason` (ambient-status.ts:211-221 —
verified age/count-free), doctor-triage severity+command for the class,
AND a held-decision-plane test: a repo held on ownership across N
consecutive skipping pulls keeps ONE deferral with monotonically growing
age. The `RBOX_GIT_OWNERSHIP_NO_ESCALATE` flag's meaning shifts from
"clear the record" to "class the record"; owner/deletion condition
unchanged.

### P3. Pin incoming tips while paused (deletes `incomingSummary`)

While a repo is deferred/held with an incoming section, pin the incoming
tips under `refs/rbox-pending/<incomingKey>/…`. Placement: AFTER the held
classification edge, conditionally on the deferred/held branch only — the
imported objects survive `cleanupRefs` (follow.ts:66-69) until gc, so the
pin is written from the incoming section's oids next to the record write
it must stay consistent with. No unconditional per-follow pin (that would
cost two `update-ref` spawns per repo per pull against the ≤10s target).
Verified properties:
- invisible to ref sync (`isSyncableRef` admits only heads/tags/stash,
  engine/manifest-validate.ts:329-331);
- invisible to the design-270 held-skip fingerprint — BOTH loose-ref
  (fingerprint.ts:188-196) and packed-refs identity (fingerprint.ts:199-221)
  filter through `isSyncableRef`, so even `git pack-refs` of a pin stays
  invisible; also excluded from user quarantine bundles (refs.ts:22-25
  excludes `refs/rbox-*`).
- **Lifecycle owner: the record writer — NOT pins.ts' age pruner.**
  `pruneStaleScratchRefs` is a deliberate 1-hour age cutoff
  (pins.ts:23,81-97); applying it to `rbox-pending` would delete the
  evidence for every hold older than an hour (i.e. exactly the FM
  population). `rbox-pending` is LIFETIME-scoped: the authority is a
  per-pull reconciliation sweep — delete any `refs/rbox-pending/<key>`
  whose `<key>` is not the repo's current record `incomingKey`. That one
  sweep subsumes hold-clear/resolve/incomingKey-change event pruning and
  every crash/reset orphan path (crash between update-ref and record
  write, state reset, repo removal).
- Disk bound: measured on the real FM 103-repo state before PR-C merges;
  recorded as a named trade (retained pack objects for the hold's
  lifetime).

With the objects durably local, evidence() reads commit subjects,
ahead-count, and the incoming file list straight from git — always fresh,
no cache, no staleness, no schema change, no old-binary tier for NEW
pauses. Cost (named trade): retained pack objects for the hold's lifetime.

Degrade ladder (per repo, field-by-field, never blocking):
1. pin present → full two-sided evidence;
2. no pin (pre-273 pause, or pre-follow deferrals like `unsupported`/
   `unreadable`/`git-busy`/`containment`/`ignored-target`, and capture/
   config-lane pauses which have NO incoming at all) → branch, head oid,
   `generatedAt` date from `record.pending` (offline);
3. deep detail for tier-2 repos → `rbox git resolve <repo> show-me`, which
   already network-stages on demand (resolve-command.ts:694-699).

FM's current 103 are tier 2 until their next incoming update.

### P4. Sender naming — CUT from 273 (own follow-up design)

Final review: P4 is a wire field + an identity-exclusion analysis across
`gitIncomingKey`/carry fingerprints + a new local label cache + a
revocation degrade chain — its own design (claims number 274). In 273,
every surface says "another computer" (honest, and already the shipped
vocabulary, resolve-presentation.ts:42-51); the projection carries an
optional device-label slot so 274 plugs in without re-touching renderers.
PRODUCT NOTE for the founder: Max's "name the actual computer" ask
arrives one design later, not in 273's first ship.

The original P4 mechanism (kept as 274's starting point):

The locally reachable device id names the last *pusher* of the manifest
head — on a multi-host fleet that can be a computer that never touched the
repo. Naming the wrong computer is Max's complaint inverted, so r2:
- add optional `deviceId` to `GitSection`, stamped by the CAPTURING device
  (wire-additive: `validateGitSection` at manifest-validate.ts:395-430
  tolerates unknown keys; sourceVersion stays 1). REQUIRED ANALYSIS before
  implementation: the field must be excluded from section
  equality/`gitIncomingKey`/carry fingerprints or it churns held-skip and
  carry logic — the spec pins the exact identity functions and excludes it
  there, with a differential test.
- device labels: local cache of the `rbox device list` wire response
  (`GET /v1/auth/devices`), refreshed opportunistically, each entry with
  `lastSeen`; degrade label → id → "another computer"; a revoked device
  renders "a computer no longer on your account". The cache is a plain
  local file (not sync state).
- Until a section carries `deviceId`, ALL copy says "another computer" —
  never a guessed name.

### P5. One population, one rule, a per-row `quiet` flag

ONE population (all deferrals, ownership class included — after P2 there
is no second "held" population) with the transient quiet rule
(TRANSIENT_DEFERRAL_QUIET_MS = 10 min, status-projection.ts:41-70)
computed ONCE as a per-row `quiet: boolean` on the projection.
- Headline, listing, ambient/daemon count, and the prompt sidecar OMIT
  quiet rows — one count everywhere users glance.
- `rbox doctor` and `rbox git deferrals --json` render the FULL
  population and LABEL quiet rows ("recently paused, usually
  self-heals") — a repo whose deferral flaps (clear/set resetting
  `deferredSince`) stays visible to the support flow. Validation row: a
  deferral re-set every 60s for an hour is visible in doctor.
- Enumerated surface list bound by this rule: headline, `status --git`,
  doctor, ambient JSON, status `--json`, deferrals `--json`, AND the zsh
  prompt sidecar `renderShellDeferrals` (activity.ts:417-460 — today
  unfiltered, 50 rows + a `.`-rooted overflow row that would put a
  git warning in EVERY directory after P2). Prompt policy:
  `ownership-hold` rows are excluded from the sidecar entirely — the
  prompt carries only actionable rows.

## Story vocabulary (exhaustive, type-gated)

A closed map `satisfies Record<GitDeferralReason, Story | ((detail?:
string) => Story)>` (same discipline as DEFERRAL_REASON_PRESENTATION,
status-view.ts:288-308) — the compiler forces every future reason to pick
a story. (No `HeldRefReason` type exists or is invented: the held-ref
values are already collapsed into `GitDeferralReason` by
`followHeldDeferralReason`, follow-repo-transition.ts:195-208.) The
`artifact` entry is the one function-valued row, and it is FAIL-CLOSED:
default `sync-download-failed`; upgrade to `settle-failed` only on a
typed detail that positively proves a post-apply settle. A fixture
asserts the "was saved first" sentence never renders without a quarantine
path on disk. Story codes are code symbols + optional `--json` fields;
`reason` remains the machine contract; NO wire/persisted renames.

| story | maps from | human copy (group header) |
|---|---|---|
| `local-edits` | local-edits | "you changed files here that were never synced" |
| `local-staged` | local-index | "you have work staged for a commit here" |
| `local-commits` | local-commits (+ held local-commits) | "this computer has commits your other computers never got" |
| `local-stash` | local-stash (+ held local-stash) | "you have stashed work here (git stash)" |
| `unfinished-git-operation` | local-operation | "a git operation (like a rebase or merge) was left half-finished here" |
| `branch-in-use-elsewhere` | worktree-ownership, held ownership | "another copy of this repo (a git worktree) is using the branch rbox needs to update, so rbox left it alone" — action: "switch that other worktree to a different branch and rbox finishes on its own; no command needed" |
| `both-changed` | conflict | "this repo changed on two computers at once" |
| `conflict-copies` | conflict-copies | "the only files left here are the backup copies rbox made when two computers changed the same file — there is nothing left to compare" — action: "open or delete those conflict files, then rbox retries by itself" |
| `sync-interrupted` | deletion-pending, journal/checkout recovery detail families | "a sync stopped partway through — rbox retries this on its own" |
| `sync-download-failed` | artifact (fetch/verify failure — nothing applied, NO backup exists) | "rbox couldn't finish downloading the other computer's version — nothing here changed" |
| `settle-failed` | artifact (post-apply settle failure) | "the last sync got most of the way and then stopped — your earlier state was saved first" |
| `repo-unreadable` | unreadable, ref-read-unreadable, config, containment, ignored-target, unsupported | "rbox can't read or manage this repo right now" + repairText |
| `busy` | git-busy, stale-unattributed | "git was busy here — rbox retries on its own" |
| `other` | (compiler-forced explicit choice for future reasons) | bounded curated detail passthrough |

The two `artifact` stories are distinguished by the typed refusal/detail
already written at the deferral site (271's `detail` discipline); the
"backup exists" claim is only ever printed on the settle branch. Capture-
and config-lane pauses map through the same table with lane-appropriate
copy and NEVER print resolve commands (their remediation is capture/config,
per remediationClass).

## Surfaces

### S1. Headline (status + ambient; singular/plural handled)

```
⚠ 98 repos are waiting on you — rbox paused git sync there so nothing you
  did gets overwritten. 5 more are sorting themselves out.
  See them:  rbox status --git
```

Two numbers, split by actionability (needs-you vs self-healing), both from
project(). Never claims "changes you made" for the self-healing family.

### S2. `rbox status --git` — summary-first grouped listing

Groups by (story, actionability). Per repo ONE line by default; 5 repos
shown per group, sorted by overlap-count desc then age; full paths always
(sanitized via sanitizeTerminalText, never length-truncated). File-level
evidence appears ONLY in the single-repo view and `--dry-run`.

```
rbox paused git sync in 103 repos. Your files are safe — rbox stops
syncing a repo rather than overwrite work you did on this computer.

98 repos — you changed files here that were never synced
   conductor-workspaces/acme/checkout-flow   12 files changed here, 3 also changed on another computer ⚠   paused 3 days
   conductor-workspaces/acme/admin-ui         2 files changed here, none changed elsewhere                  paused 3 days
   … 93 more not shown
   the full list:        rbox status --git --all
   one repo in detail:   rbox status --git <repo>

   To fix one, first see what's waiting:      rbox git resolve <repo> show-me
   then keep this computer's work:            rbox git resolve <repo> keep-mine --confirm <token from show-me>
   or take the other computer's version:      rbox git resolve <repo> take-theirs --confirm <token from show-me>
   Several at once: add --under <folder> and --dry-run (see rbox git resolve --help).

5 repos — rbox is handling these on its own — nothing to do
   scratch/demo-app                           a sync stopped partway through          paused 2 hours
   If any are still here tomorrow: rbox doctor
```

- `--all` prints the one-line form for every repo — no invocation emits
  the expanded form at fleet scale; machines use `--json`.
- Group action lines print only commands EVERY repo in the group supports
  (`canResolve`/`canKeepMine`/remediationClass are already per-repo typed,
  status-view.ts:404-414); mixed groups split.
- Missing ages render `paused (since unknown)` and sort last.

Single-repo view `rbox status --git <repo>`:

```
conductor-workspaces/acme/checkout-flow — paused 3 days
  Your work here (this computer, branch main):
    - src/routes/pay.ts            edited Aug 14  (123 lines added, 24 removed)
    - src/lib/stripe-session.ts    edited Aug 14  (8 lines added)
    … and 9 more files
  Waiting from another computer (branch main, 4 commits newer than yours):
    most recent: "fix stripe webhook retry"  (Aug 16)
    changes 12 files — 3 of them are files you also changed here ⚠
```

("another computer" becomes the device label when P4 data exists. Commit
subjects/labels/paths from the other side pass through
sanitizeTerminalText with declared bounds — untrusted peer text never
reaches the terminal raw.)

### S3. Doctor

Summary altitude over the same project() output; doctor's user-facing git
findings are already typed (doctor-triage.ts:98-118) and move onto
stories. `classifyGitLogMessage`/`gitReasonOf` (doctor-cmd.ts:237-276) is
NOT deleted — it parses historical daemon log text for redaction and is
byte-frozen against `renderGitDeferralLine`'s emitted grammar
(status-view.ts:455-462); it is renamed to say it is a log-redaction
classifier. Rule: that emitted log grammar stays byte-stable, or the
classifier is updated in the same PR — never silent drift (fail-closed:
unrecognized lines are omitted from diagnostics).

```
git · 103 repos paused
  98 waiting on you — you changed files that were never synced (and 3 more stories)
   5 sorting themselves out
  oldest paused: 3 days · full detail: rbox status --git
```

### S4. Resolve: honest preview, batch, restore

- All prose names computers per P4 (label → "another computer"). Verbs
  and the `--confirm <token>` snapshot mechanism are UNCHANGED for
  single-repo resolves (protected safety property).
- `--dry-run` (composable with any verb): stages/reads evidence, prints
  what would happen, performs ZERO writes (fs-snapshot-asserted):

```
This is a preview — nothing on this computer changed.
Taking the other computer's version would:
  - switch this repo to their version (4 commits newer)
  - first save a copy of your committed and work-in-progress changes to
    files git tracks (12 files, 4 commits) here:
      .rbox/git-quarantine/1f3a9c2e8b7d4a01/  (rbox calls this the git quarantine)
  - NOT copy: 2 brand-new files you never added to git, and ignored
    files — those stay where they are on disk, untouched
To actually do it, run the same command without --dry-run.
Undo later with: rbox git restore-backup conductor-workspaces/acme/checkout-flow
```

  (Real path, real contents: quarantineLocal bundles syncable refs + a
  `git stash create` of tracked modified/staged content + index/op-state
  copies — quarantine.ts:18-45. Copy never promises more.)
- **`rbox git restore-backup` — SPLIT to its own design (#762's
  completion).** The final review moved it out (review clustering +
  its own safety surface): restore must materialize into an ISOLATED
  `git worktree add .rbox/git-restored/<ts>` — never the current
  checkout, whose contents take-theirs just replaced; applying the saved
  stash onto the live tree would be a three-way merge against the wrong
  base. 273's dry-run prints the backup path today; the restore command
  ships in its design. **273's batch take-theirs DEPENDS on that design
  landing first** — batch without an undo is a one-way door.
- **Batch grammar (literal — the repo positional becomes optional):**
  `rbox git resolve --under <folder> take-theirs --dry-run`
  `rbox git resolve --under <folder> take-theirs --yes --expect-repos 98`
  Dispatch rule: when `--under` is present the verb is `positional[1]`
  and a repo positional is a usage error (today
  `rbox git resolve --under X take-theirs` silently parses
  `take-theirs` as the REPO, main-dispatch.ts:706-709 — the naive
  spelling misparses, so the dispatch change is load-bearing).
  `restore-backup` is a new `sub`, not a resolve verb. `--group <story>`
  exists only as an ADDITIONAL filter to `--under`; workspace-wide is
  spelled `--under .`.
- **Batch freeze/reverify:** preview computed once, repo list FROZEN;
  execution re-verifies each repo at the mutation boundary by calling the
  IDENTICAL `snapshotId` function the single-repo token flow uses
  (resolve-command.ts:176-178, recomputed under the lock at :823-840) and
  non-fatally skips any repo whose state changed, reporting skips at the
  end. Honesty note (not "token equivalence"): this preserves the token's
  state-change-detection property exactly; it does NOT bind consent to a
  per-repo reviewed preview — `--expect-repos <n>` binds consent to a
  count. That is the named, accepted trade for batch.
  Confirmation scales with blast radius: interactive batch take-theirs
  requires typing the repo COUNT; scriptable twin is
  `--yes --expect-repos <n>` (a script written against 3 repos cannot
  silently act on 98). Batch keep-mine NEVER accepts a blanket
  `--force-discard-incoming`: repos needing force are listed and require
  separate, explicitly-scoped invocations, with forewarning copy in the
  group header ("in some repos the other computer's newer work can't be
  kept alongside yours — rbox lists them and asks separately; the other
  computer keeps its own copy either way").
  Preview table columns: repo · switches to · backup saved (files,
  commits) · NOT backed up (untracked count). Bottom line:

```
Total: 98 repos · 412 files you changed here get saved to backups
       11 repos changed on BOTH computers ⚠ · 6 new files are not covered by backups
```

### S5. JSON

`--json` carries the full projection for every repo in the population
(fixes defect 2 for machines): story (render-side, additive), reason
(unchanged machine contract — stated explicitly to prevent consumer
drift), ages, actionability, evidence when computed. Ambient JSON gains
the split counts. `rbox git deferrals --json` schema stays; additive only.

## Requirement ledger (new mechanisms, each with owner + deletion condition)

| Mechanism | Owner | Deletion condition |
|---|---|---|
| `refs/rbox-pending/*` pins | record writer at the held classification edge; per-pull incomingKey reconciliation sweep is the prune authority | a future design making incoming durable elsewhere |
| `ownership-hold` remediation class (replaces record-clearing at all THREE sites incl. held-decision retain()) | the hold/skip sites | 2.0 unified pause record |
| per-row `quiet` flag (single computation of the transient rule) | the projection | 2.0 unified pause record |
| `--dry-run`, `--under`, `--expect-repos` | resolve surface | none — they ARE the product fix |

(Moved out: `GitSection.deviceId` + device-label cache → design 274;
`restore-backup` → its own design; both referenced above.)

Zero new RepoRecord members; zero SQLite schema changes. Compat context
(founder ruling, 2026-08-17): 2.0 runs only on the founder fleet —
breaking state/wire changes are ALLOWED in this window. r2 still chooses
zero schema changes because the pin/record-restore primitives are simpler
than new persisted fields on the merits, not because a change is
forbidden. Consequence for P4: `GitSection.deviceId` may ship as a plain
first-class field now (still excluded from section identity by design
choice, with the differential test) rather than as a compat-shaped
optional.

## Protected functionality

- Resolve sanitization contract (git-cmd.test.ts:1279-1308 redaction
  block): no raw Error.message; all new copy through curated paths; every
  new remote-authored string (subjects, labels, paths) declares its
  sanitizer and bound.
- Existing resolve verbs, flags, exit codes, snapshot token (single-repo),
  typed refusal codes and 271 copy; `show-me`'s existing "What happened /
  What is safe / What to do" copy contract (git-cmd.test.ts:279-284)
  evolves, not breaks.
- Wire shapes: optional additions only; sourceVersion 1;
  SERVER_GIT_DEFERRAL_REASONS untouched (stories are render-side).
- Daemon log line grammar for the redaction classifier (S3 rule).
  Scoping: S2's "full paths, never truncated" applies to the STATUS
  renderer only; the emitted LOG line keeps `truncateDetail`
  (status-view.ts:520-533) so the redaction regex and its privacy bound
  hold. Renaming `gitReasonOf` updates the reason-declaration-order
  comment at sync-state-model.ts:129-131 (anchor there already stale).
- New surface registration: `--dry-run`/`--under`/`--expect-repos` get
  help-registry entries (help-registry.test.ts), zsh completions
  (completions.test.ts), and JSON dispatch rows (dispatch-json.test.ts);
  confirm `--dry-run` is not a reserved global flag.
- Design-270 held-skip fast path: `--no-optional-locks` on all evidence
  git calls; pin namespace excluded from fingerprints (verified above).
- Steady-state sync loop: project() is git-free; daemon spawns zero git
  processes for status (test-gated).
- Telemetry ingest parsing of status/doctor sections.

## Sequencing (three PRs)

1. **PR-A (prereq — honest label: ratchet-driven decomposition,
   mechanical, no semantics):** decompose BOTH files at their ceilings —
   `resolve-command.ts` (1118 nonblank / 59,105 B vs 59,115 B ceiling: 10
   bytes headroom) AND `status-view.ts` (914 nonblank / 49,990 B vs
   51,804 B ceiling: ~48 lines — the story table alone would blow it).
   `status-projection.ts` (22 lines headroom) is the third pressure
   point. Target modules, each <400 nonblank / 25 KiB, NO `ALLOWED`
   additions in any PR (list is closed, file-size.test.ts:45-47): e.g.
   `status-view/story-map.ts`, `status-view/git-projection.ts`,
   `status-view/git-render.ts`, plus the resolve split. Both existing
   pins re-recorded DOWNWARD in the same PR. The `GitResolveShow`
   absorption claim belongs to the PR where it lands (B/C), not A.
2. **PR-B:** P2 ownership-record restore (all three sites) + P5
   population/quiet rule + stories + S1/S2/S3 rendering + JSON +
   telemetry ledger note.
3. **PR-C:** P3 pins + evidence() + single-repo view + S4 dry-run +
   batch keep-mine/`--under` scaffolding. Batch take-theirs gates on the
   restore-backup design landing.

## Non-goals

- No sweep/auto-resolve policy change; resolve remains explicit.
- No wire/persisted renames (candidates → docs/wire-rename-candidates.md).
- No per-commit device attribution inside git history.
- No change to the quarantine path/format (restore reads it as-is;
  designs 126/208 share that tree).

## Validation

- Population invariant: headline needs-you+self-healing == group sums ==
  `--json` record count, on a state with ownership holds, capture-lane and
  config-lane deferrals, and quiet-window transients (the latter excluded
  everywhere).
- Story map: compiler-gated exhaustive; a fixture per reason asserts no
  banned word appears on the human surface.
- P2 differential: pre/post behavior of hasGitResolutionIncoming,
  deferral hygiene, daemon attentionReason, doctor-triage severity and
  command emission — ownership holds visible, never escalated, never
  handed a resolve command; held-decision-plane test: one deferral with
  monotonically growing age across N skipping pulls.
- P3: pin invisible to ref sync + held-skip fingerprint (extend
  fingerprint tests); reconciliation sweep collects orphans from crash
  between pin and record write, state reset, and repo removal; evidence
  correct after daemon restart (durability); measured disk bound on FM.
- P5: a deferral re-set every 60s for an hour stays visible in doctor
  and deferrals --json (quiet-labeled), absent from headline/prompt.
- Batch boundary check calls the identical snapshotId
  (resolve-command.ts:176-178); --expect-repos mismatch refuses.
- P4: identity functions exclude deviceId (differential incomingKey/carry
  test); revoked/missing label degrade chain.
- Evidence safety: zero git spawns on daemon path
  (setGitSpawnObserver); no `.git/index` mtime/content change after
  `status --git` on a dirty repo; per-repo timeout degrade.
- Dry-run: fs-snapshot zero-write assertion.
- Batch: frozen-list = executed-list (or reported skip); `--expect-repos`
  mismatch refuses; keep-mine force split; count-typed confirm.
- restore-backup: round-trip test — take-theirs then restore-backup
  yields the pre-resolve refs/worktree content (tracked scope) under the
  restored branch; never moves existing branches.
- Terminal-injection fixture: ANSI-bearing commit subject + device label
  render sanitized.
- Rig/field: replay the FM decision on the real 103-repo state as the
  acceptance test — the founder must be able to decide from the new
  output alone; old-pause tier-2 degrade verified there.
