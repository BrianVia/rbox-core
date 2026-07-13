# Design 72 — Nested .gitignore: discovery pruning always, file-sync honoring opt-in

**Status:** v3 — v1 review (7 findings) + confirm-round residuals folded; where
the doc names code that does not exist yet (`--purge`, the daemon re-stat, the
wizard select, per-base matchers, tracked-set cache), that is the DELIVERABLE
LIST, not a claim about current code
**Driver:** the ~/Development stress test (2026-07-06). rbox reads ONLY the
workspace-root `.gitignore` (`buildIgnoreMatcher`, ignore.ts:160). On a
multi-repo workspace — the flagship layout — every nested repo's own ignore
rules are invisible: SwiftPM's `.build/` synced as content even though the
repo gitignores it, and git-sync *discovered dependency clones inside it*
(captured `GRDB.swift/SQLiteCustom/src` as a user repo; deferred `GRDB.swift`
on `objects/info/alternates`). PR #111 extended the builtin list, but a
builtin list is whack-a-mole by construction.

## 1. The product tension (why this is not "just honor gitignore")

rbox's pitch is **sync what git loses**: uncommitted work, untracked files,
and local git state. A lot of *gitignored* content is gitignored precisely
because it is precious-but-local:

- scratch notes / TODO files kept out of the repo
- local config overrides (`config.local.*`)
- `terraform.tfstate` — gitignored in every template, and E2EE backup of
  state files is one of our sharpest differentiators
- data/fixture dirs accumulated locally

Blanket recursive honoring inverts the promise into "sync roughly what git
sees" and silently drops that value. It also, flipped on for an existing
workspace, turns every previously-synced gitignored path into a propagated
deletion. So: the junk-cutting is wanted, the semantics change must be a
visible choice.

## 2. Decision — three tiers

### 2.1 ALWAYS ON: gitignore-aware git-repo discovery pruning

The scan-walk `.git` collector stops descending into subtrees excluded by an
ancestor `.gitignore` **for NEW repo discovery only**. A `.git` directory
found under a gitignored path is a dependency checkout (SwiftPM `checkouts/`,
Terraform module cache, vendored clones) — capturing it is noise at best and
an alternates/shape defer at worst. File sync semantics are UNCHANGED by this
tier.

**Previously-captured sections are NOT dropped** (review BLOCKER 2): current
push planning deliberately base-carries a present-but-undiscovered repo and
prunes removal memories only when the local `.git` genuinely disappears
(sync-git.ts:179, :225) — dropping on discovery absence would propagate the
repo's history OFF the server for every other device. Pruned-but-based repos
MOVE to the skip path (today the undiscovered-but-based case base-carries via
`deferOne` and logs as deferred every cycle — the implementation reclassifies
it alongside the design-68 pointer-worktree skips: silent base-carry, designed
reason string, no per-cycle spam). They become inert manifest residents; an
explicit future cleanup command may remove them, but nothing implicit ever
does.

Escape hatch: a `.rboxignore` `!re-include` restores discovery — with git's
own documented caveat that every excluded ANCESTOR directory must be
re-included too (you cannot re-include below an excluded parent; see §3).

### 2.2 OPT-IN: `respectGitignore` workspace setting (full file-sync honoring)

When `respectGitignore: true` in `.rbox/workspace.json`:

- **Only files that are gitignored AND untracked are excluded** (review
  BLOCKER 1). This is git's own rule — gitignore never affects tracked
  files — and it is load-bearing here: the receiving side's working tree is
  populated by the FILE layer, not by git-apply (apply.ts imports bundle
  objects + refs + index; it never checks out files). Excluding a
  tracked-but-gitignored file would delete it from every other machine's
  checkout. Tracked-ness comes from `git ls-files -z --cached` per repo,
  persisted in a dedicated per-repo cache file under `.rbox/state/`
  (HashCache's shape can't carry it — confirm-round finding) keyed by the
  RESOLVED index path's (mtime, size); warm scans pay one stat per repo,
  which the design-69 fingerprint pass already performs. Paths outside any
  repo have no tracked-set and use the patterns alone.
- **Known-repo trackedness survives walk pruning** (confirm-round finding —
  otherwise `--purge` could delete tracked files of a repo hidden under an
  ignored parent, misclassified as untracked because discovery never reached
  it): every repo present in the BASE manifest is consulted DIRECTLY (stat
  its `.git`, load its cached tracked-set) regardless of what the walk
  pruned. "Tracked files are never excluded" is thereby universal, and purge
  additionally refuses to touch any path under a base-carried git section it
  could not evaluate.
- The scan walk loads `.gitignore` files per directory and applies them to
  untracked-file inclusion with subtree scoping (§3).
- `.rboxignore` stays the TOP layer: its `!negations` re-include
  gitignored-but-precious paths (documented as THE pattern for tfstate,
  scratch notes, etc.). Because `.rboxignore` is a separate layer evaluated
  on the full workspace-relative path, its negations CAN rescue paths under
  a gitignore-excluded parent — but the walk may only hard-prune a directory
  no `.rboxignore` negation could re-include under. `nativePruneGlobs`'s rule
  reasons only over static builtin dir names and is NOT reusable here
  (confirm-round finding); the prune guard is NEW: compute the set of static
  path prefixes of `.rboxignore` negation patterns once per matcher build; a
  gitignore-pruned dir that is an ancestor of any protected prefix is walked
  anyway (matcher filters per-file). A slashless negation (`!keep.txt`) has
  no static prefix and disables gitignore-dir pruning entirely — correctness
  preserved, perf degraded, and `rbox ignore` prints a one-line warning when
  such a pattern is added. Builtins that are hard rules (`.rbox/`, `.git`)
  remain non-overridable as today.
- Default: **false** for existing workspaces, forever (no silent flips).

### 2.3 Setup wizard choice for NEW workspaces

One added select during `rbox setup`/`init` — **default = sync everything
(current behavior)** (review finding 7: for a brand-new workspace the
respect option silently excludes exactly the §1 precious class — tfstate,
scratch notes — with no base to fall back on; junk-free-by-default is
revisited only after the setting has real-world mileage). The second option:
`Skip gitignored untracked files (build output and caches stay local — so do
gitignored notes/state; re-include those in .rboxignore)`. The choice writes
the setting; headless `init` keeps today's behavior unless
`--respect-gitignore` is passed (scriptability unchanged).

## 3. Semantics (the part that must be exact)

- **Scoping — NO pattern translation** (review finding 3: base-prefixing is
  not semantics-preserving — bare `foo` must mean `base/**/foo` while `/foo`
  means only `base/foo`). Instead: one `ignore()` instance per directory
  that holds a `.gitignore`, evaluated against paths RELATIVE to that
  directory — the package's native repo-root-relative mode, exact by
  construction. The walk carries a stack of (base, matcher).
- **Precedence, shallow → deep:** builtin < workspace-root `.gitignore`
  (current behavior, kept) < nested `.gitignore`s consulted shallow-to-deep
  with the deepest DECISION winning < `.rboxignore` (workspace root, highest,
  negations included) < hard rules (`.rbox/`, `.git` — never re-includable).
  Within one file, last match wins (gitignore standard).
- **You cannot re-include below an excluded parent** (review finding 4;
  git's own documented rule). The walk prunes an ignored directory without
  reading anything inside it — a `.gitignore` negation INSIDE a pruned
  subtree can never win, exactly as in git. The only cross-layer exception
  is `.rboxignore` (workspace-level, evaluated on full paths — see §2.2's
  prune guard). This keeps the §4 performance claim honest.
- **Repo boundaries do NOT reset rules.** Git scopes a `.gitignore` to its
  own work tree; rbox deliberately cascades a parent dir's rules into nested
  repos below it. Rationale: sync-exclusion intent ("this whole area is
  scratch") should not stop at a repo boundary, and the simpler rule is
  predictable. Documented as an intentional divergence from git.
- **Tracked files are never excluded** (§2.2, BLOCKER 1) — the
  tracked-but-gitignored case is thereby exact git parity: such files keep
  syncing in the file layer, and uncommitted edits to them keep propagating.
- **Not consulted:** `$GIT_DIR/info/exclude` and the user-global
  `core.excludesFile` — machine-local by definition; honoring them would make
  two machines disagree about the same workspace's contents.
- **Watcher:** the coarse native prune list stays BUILTIN-only (static,
  negation-safe — unchanged). Nested-rule filtering happens in the
  authoritative matcher on delivered events; ignored-subtree events are
  dropped there. The safety scan prunes the walk itself, so steady-state cost
  falls, not rises.

## 4. Performance

Reading one `.gitignore` per directory that has one is strictly cheaper than
walking the subtrees those files exclude (a typical node project's
`.gitignore` excludes >90% of its file count; builtins already catch the
biggest dirs). The per-scan rule cache is keyed by (path, mtime) alongside
the existing HashCache so unchanged ignore files parse once. Expected net:
scan time DROPS on every real multi-repo workspace when the setting is on;
discovery-only tier adds one gitignore evaluation per directory containing a
`.git` candidate — noise.

## 5. Migration & safety

- **Enabling deletes NOTHING by default** (review finding 5: the push
  already forward-carries base entries that became ignored — design 03b
  dropped purge deliberately, sync.ts:375 gates it on `purgeIgnored`, which
  no CLI exposes). Flipping the setting on means: newly-ignored untracked
  paths stop uploading/updating; their already-synced copies stay on the
  remote as stale carries. Zero deletion risk, zero guard interaction.
- **Purge is a separate, explicit act:** a NEW `rbox ignore --purge`
  subcommand (the `ignore` CLI today only lists/appends patterns) offered by
  the enable flow, wired through the EXISTING `purgeIgnored` engine flag
  (sync.ts:379 — engine support present, CLI-unexposed since design 03b
  dropped it). It never touches paths under a git section whose trackedness
  it could not evaluate (§2.2), and it always
  runs the dry-run first (count + top-level dirs), requires confirmation
  (TTY; headless `--yes`), rides the push-side mass-delete guard, and
  receivers trash-tier the deletions (design 50) — recoverable for 30 days.
  The dry-run is exact because it evaluates the same matcher against the
  same base manifest the push will use.
- Disabling is the reverse: previously-ignored paths (re)upload on the next
  push; no data risk.
- **Daemon picks the flip up without a restart** (review finding 6: the
  setting lives under hard-excluded `.rbox/`, so no watcher event fires, and
  the daemon today builds its matcher once at construction): NEW plumbing —
  the safety-scan tick re-stats `workspace.json` and, on (mtime, size)
  change, reloads config and rebuilds the matcher through the same rebuild
  path a `.gitignore` edit takes (daemon.ts:530), which the safety scan then
  uses.
- Tier 2.1 (discovery pruning) ships without a flag; see §2.1 for why
  previously-captured sections are base-carried, never dropped.

## 6. Explicitly deferred

- Default-ON for new workspaces without a prompt (revisit after the setting
  has real-world mileage).
- Materializing gitignore rules into `.rboxignore` (`--adopt-gitignore`
  one-shot import) — redundant once live honoring exists.
- Global/user-level git excludes (§3: machine-local, never).

## 7. Verification

- Unit: precedence matrix (builtin vs root vs nested vs .rboxignore vs hard
  rules), per-base evaluation exactness (bare `foo` vs anchored `/foo` vs
  `foo/` vs `**` at a nested base — the finding-3 cases), no-re-include-
  below-excluded-parent, `.rboxignore` negation rescuing across it,
  repo-boundary cascade, tracked-but-gitignored files ALWAYS included
  (BLOCKER-1 regression pin), tracked-set cache invalidation on index mtime.
- Discovery tier: fixture with a gitignored dependency clone → not
  discovered; previously-captured clone → base-carried as a design-68-style
  skip (no removal, no defer spam); `.rboxignore` re-include (incl. its
  ancestors) → discovered again.
- Migration: enable → push → NO deletions, junk stops updating; `--purge`
  dry-run count == actual purge deletions on a fixture; guard + trash
  interplay in the rig (flip+purge on device A → device B trash-tiers).
- Daemon flip: change setting while daemon runs → matcher rebuilt on next
  safety tick (no restart).
- Purge safety: a tracked file inside a repo under an ignored parent is
  NEVER purged (the confirm-round data-loss case, pinned as a regression
  test); slashless `.rboxignore` negation → pruning disabled but results
  identical (correctness-vs-perf split pinned).
- Live: enable on ~/Development after v0.9.2 settles; measure scan time and
  manifest size before/after; verify the tfstate `.rboxignore` re-include
  pattern works as documented.
