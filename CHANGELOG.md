# Changelog

All notable changes to rbox are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions map to the
`v*` git tags that trigger the CLI release build.

## [Unreleased]

### Added
- `rbox status` now counts the conflict copies rbox saved for you and still
  sitting in the workspace, so they are visible without hunting for
  `*.conflict*` files by hand. The count is also in `rbox status --json` as
  `conflictCopies`. A moved-aside folder counts as one thing to deal with,
  however many files it holds.
- New "conflict copies" hold reason for folders whose sync is paused. When the
  only thing left to compare in a folder is copies rbox saved during an earlier
  conflict, sync says so in plain language — "only conflict-copies remain here,
  so the comparison was skipped" — instead of an unexplained pause.

### Fixed
- Conflict copies rbox saved no longer make a folder look permanently
  out-of-sync. Previously a saved copy could keep a folder's comparison from
  ever settling, so it stayed stuck even after everything else had synced.
- Deleting the last conflict copy in a folder now clears the hold on the same
  sync cycle. Previously that pull could pause for a cycle and tell you to
  delete files it had just removed.
- An ignore rule that happens to match conflict-copy names (e.g. `*.conflict*`)
  no longer pauses every folder it applies to.
- Upgrading from a 1.x install no longer leaves background sync switched off. A
  1.x machine has folders but no folder configuration file, which the new
  binary refused to start without; rbox now writes that file from the folders
  it can already see. Autostart at login was stuck the same way and is fixed by
  the same change.
- If rbox genuinely cannot work out your folder configuration during an upgrade,
  it now leaves the running sync alone instead of stopping it, and prints the
  command that actually fixes it (`rbox config regenerate`) rather than
  `rbox stop && rbox start`, which failed the same way.
- Upgrades now decide each workspace's folder admission on its own, so one
  folder rbox will not run (say, one it can no longer find) leaves that
  workspace's sync running and untouched while every other workspace upgrades.
  Rebuilding a missing folder configuration is still a whole-machine step: if
  anything on the machine cannot be reproduced, no workspace is restarted until
  you fix it.

## [2.0.0-beta.4] - 2026-08-16

### Fixed
- RboxBar builds again on the release toolchain (Swift 5.10 concurrency
  compatibility); a path-filtered PR-time RboxBar build lane now guards it.

_(v2.0.0-beta.3 was tagged but never published: its release run failed in
the RboxBar build, fail-closed, before any channel mutation.)_


### Performance
- Zero-change sync cycles no longer rewrite the whole state: a provably
  no-op save composes a minimal packet (desktop zero-change pull
  13.3s -> 3.6s; state-save 9.8s -> 0.8s). Kill switch RBOX_SAVE_NOOP_ELIDE.
- Content-carrying saves are delta-staged: only changed entries are
  written and verified (one-changed save ~2.8s -> ~60ms; Mac 1-blob
  receive 20.4s -> 9.0s). Complete saves remain the genesis/repair
  fallback. Kill switch RBOX_SAVE_DELTA.
- Git state-CAS lock acquisition amortized (append-structured journal,
  batched directory fsyncs, single-use release handle): large-pull
  acquire 50.3s -> 16.4s at 2,292 locks, with per-span lock counts now
  reported.
- Held git repos with composer artifact holds join the held-skip fast
  path (~3.5s -> ~53ms per repo per cycle). Kill switch
  RBOX_GIT_HELD_SKIP_COMPOSER.

### Fixed
- Sync status spans now attribute lock counts (locks<N> blocked<M>) so
  O(N) durability work is distinguishable from real contention.
- Held-skip could survive a manual git resolution's artifact changes; the
  artifact plane is now digested into skip eligibility.


### Changed
- macOS filesystem scans now use the native bulk directory walk by default
  when supported; no environment opt-in is required. Runtime capability,
  directory-probe, and per-directory fallback guards remain in place.

### Fixed
- Leftover `AUTO_MERGE`, `MERGE_MSG`, and `REBASE_HEAD` files from concluded
  Git operations no longer strand followers; real in-progress markers still
  defer, and linked-worktree diagnostics name the responsible worktree.
- Watcher overflow protection now counts first-drop-anchored 5-second episodes,
  rather than counting every callback in an operating-system overflow burst;
  `RBOX_WATCHER_RETRUST_M` therefore measures episodes, not callbacks.

## [2.0.0-beta.2] - 2026-08-12

### Fixed
- Background sync no longer re-rings its own doorbell: the Linux git watcher
  ignores rbox's own bookkeeping clicks, ending a no-op push loop (~3s cycle).
- A folder with unfinished git work (e.g. a paused merge on another machine)
  now costs milliseconds per sync instead of ~9 seconds — rbox remembers the
  stuck state instead of re-checking it from scratch every time.
- Unchanged git repos skip the per-repo work queues on both push and pull.

### Added
- Propagation measurement rig: per-hop timing with exact sequence
  correlation; `rbox status` now names a degraded file-watcher outright.

## [2.0.0-beta.1] - 2026-08-11

### Changed
- **Setup is folder-first (design 230):** the guided flow speaks "synced
  folder" and offers three plain choices (sync `~/rbox`, sync another folder
  here, sync a folder from another machine); workspace vocabulary remains in
  internal records, flags, and JSON unchanged.
- The 2.0 runtime line (U3 primitives, #623) ships from `main`; no wire or
  storage format changed relative to v1.11.4.
- **Breaking: `~/.rbox/config.json` is now the authority for which local folders
  rbox may sync and for their safe sync options.** Existing local bindings are
  preserved, but a machine that has bindings and no catalog must explicitly run
  `rbox config regenerate`; rbox will not guess after a missing or damaged
  catalog. Use `rbox config` to inspect the result, `rbox config add <path>` to
  admit a detached binding, and `rbox config repair <path>` after a proven local
  folder move.

## [1.11.4] - 2026-07-31

### Fixed
- **A leftover file from a finished merge no longer blocks
  `rbox git resolve`.** When Git finishes a merge it can leave a draft
  commit-message file behind in the repository. rbox mistook that leftover for
  a merge still in progress, so `rbox git resolve <repo> keep-mine` refused
  with "a Git operation is in progress; finish or abort it, then run keep-mine
  again" — on a repository where Git itself reported nothing in progress and
  nothing to finish or abort. There was no way out, and one repository stayed
  stuck for a week. rbox now uses Git's own definition of an operation in
  progress, so these leftovers are ignored. A genuinely paused merge, rebase,
  cherry-pick, or revert still stops resolution, exactly as before, and the
  leftover files keep syncing between your computers.

## [1.11.3] - 2026-07-30

### Fixed
- **Resolving a paused Git repository now says which computer keeps what.**
  The `keep-mine` / `take-theirs` explanations used to talk about "yours" and
  "theirs" — confusing when every machine involved is yours. Every sentence now
  names the machines: "keep this computer's version (Your-Hostname) and publish
  it to your other computers" versus "use the version from your other computer
  and set aside this computer's Git changes." The command names are unchanged.
  Your hostname stays out of `--json` output and shareable reports.

## [1.11.2] - 2026-07-30

### Fixed
- **A brand-new git repository no longer drags its dependencies into sync.**
  If you ran `git init` in a folder and had not committed anything yet, rbox
  could not read that repository's index, assumed every file in it might be
  tracked, and synced the whole folder — `node_modules`, `venv`,
  `__pycache__`, even `.env` files that rbox normally never uploads. Your
  ignore rules were correct; rbox was overriding them. It now recognises a
  repository with no commits as having nothing tracked, and your ignore rules
  apply normally.
- **A paused repository no longer wastes upload bandwidth.** When rbox pauses
  a repository's git bookkeeping (`rbox status --git` shows these), it was
  still packaging up that repository's history and uploading it on every sync
  cycle, then discarding it moments later — and the sync log said `captured 0`,
  so nothing showed it was happening. On one machine that was roughly three
  uploads every four seconds for two days. rbox now uploads only after it has
  decided the work will actually be published.
- **A symlinked build folder is ignored like a real one.** A symlink named
  `node_modules`, `dist`, `cdk.out`, `target` or similar was synced even
  though a real folder of that name would have been skipped.
- **`rbox status` now tells you how much you are storing that your own ignore
  rules exclude**, with the command to clean it up. Adding an ignore rule has
  always been forward-only — it stops future syncing but keeps what was
  already uploaded — and until now there was no way to see how much that was.

## [1.11.1] - 2026-07-28

### Fixed
- **Syncing a workspace with many Git repositories is dramatically faster,
  especially on macOS.** rbox was launching one small `git` helper for every
  branch and tag while proving a repository's history was safe to accept —
  thousands of launches per sync on a busy repository, which macOS makes
  slow. It now asks the same questions in three launches. Syncs that took
  90+ seconds on a Mac now complete in a few seconds.

### Added
- **Opt in to preview CLI releases without moving the stable fleet.**
  Install the preview channel with
  `curl -fsSL https://rbox.to/next/install.sh | sh`, or switch an existing
  installation with `rbox upgrade --channel next`. The choice persists beside
  that installed binary; `rbox upgrade --channel latest` switches back once
  stable has caught up, and the normal stable installer clears the preview
  choice.

## [1.11.0] - 2026-07-28

### Added
- **`rbox include` — sync only the folders you include on this machine.**
  A laptop that only needs one project no longer has to hold the whole
  workspace: `rbox include add Personal/repo-A` keeps just that folder synced,
  and `rbox track --workspace <id> --include Personal/repo-A` joins a
  workspace already scoped that way (repeat `--include` for more folders). A
  machine that syncs only some folders receives changes but never sends them,
  so a partial view can never overwrite the rest of the fleet — push code out
  of it with git. Folders are workspace-relative, and a folder cannot cut a
  git repository in half. `rbox include remove` moves that folder's files to
  the local trash, and `rbox trash restore` undoes it.
- **rbox now protects your folder's sync records from a future upgrade.** A
  later version of rbox will store those records differently. From this release
  on, rbox recognizes the newer format and stops rather than writing the older
  format over it — so an older copy of rbox running somewhere on your machine
  can no longer quietly undo an upgrade. If that ever happens, `rbox doctor`
  says so in plain English and points at `rbox upgrade`; it never tells you to
  delete anything. rbox also reserves a small amount of space inside the folder
  so a future upgrade cannot fail partway through for want of disk, and it
  refuses to touch that reserved space if anything it did not create is
  occupying it.
- **`rbox git republish <repo>`** — an operator lever for a Git pack chain that
  new machines cannot replay. When every fresh machine defers a repository with
  a "bundle verify failed for git pack link N" error, run this on the machine
  that publishes it: the next publish sends one self-contained bundle instead of
  another increment on the broken chain, and stranded machines recover on their
  next pull. Records an intent only — nothing is captured or uploaded until that
  publish — and is fully non-interactive (`--json`, exit 0/1).

## [1.10.2] - 2026-07-27

### Fixed
- **The sync scheduler can no longer spin.** If the daemon's recovery probe
  ever outlives the condition it was armed for, the scheduler now retires it
  and parks the queue instead of re-selecting it in a tight loop. No released
  build exhibited the bug — it was found while investigating a runaway in
  unreleased development code — but the guard makes the daemon structurally
  immune to that whole class of hot loop.

## [1.10.1] - 2026-07-27

### Changed
- **A calmer help screen.** `rbox --help` now shows just the six commands of
  the everyday loop — `status`, `sync`, `start`, `stop`, `doctor`, and bare
  `rbox` — with everything else one step away in `rbox help --all`. The full
  reference itself is easier to scan: one row per command (subcommands like
  `key …` and `trash …` fold into their parent), and flags now live only in
  each command's own `--help`. No command was removed or renamed.

## [1.10.0] - 2026-07-27

### Added
- **`rbox doctor` now explains problems in plain English.** Every finding says
  what is wrong, whether your data is safe, and the exact command to run —
  ordered by what to fix first. Outside a synced folder, `rbox doctor` and
  `rbox status` now show a summary of every workspace on the machine instead
  of an error, and new `rbox status --all` / `rbox doctor --all` flags give the
  machine-wide view from anywhere, backed by a durable local workspace
  registry. `rbox doctor <path>` now works positionally (`--path` remains).
- **Small files upload in packs.** Many small files are now coalesced into
  bandwidth-sized objects before upload: ~6x fewer requests and up to 1.5x
  faster on fast connections, with identical content and history.
  `RBOX_BLOB_PACK=0` restores the previous per-file uploads.

### Changed
- **Encryption is dramatically faster.** The fused in-memory encrypt path is
  now the default (no more per-file temp files — up to 5x faster, biggest on
  macOS), and the worker pool defaults to 4 workers after a cross-machine
  sweep showed more workers actively slow encryption down. `RBOX_CRYPTO_FUSE=0`
  restores the previous path.
- **Adopting a large existing folder no longer takes forever.** The adoption
  journal now batches its safety writes (same crash guarantees, ~1000x less
  disk writing) — a 300k-file adoption drops from days to minutes.

### Fixed
- `RBOX_HOME` now isolates credentials as documented; previously a scratch
  environment silently used the real account credential.

### Fixed
- Manifest delta commits now keep advisory file mtimes stable across machines,
  preventing a daemon restart or full rescan from publishing a workspace-sized
  delta when only a small number of files actually changed. Set
  `RBOX_MTIME_NORMALIZE=0` to restore the previous behavior.
- `rbox start` now recognizes and identifies an already-running background sync,
  including its version and witnessed mode, and calls out version mismatches.
  Dev-build versions with `+` metadata now parse correctly, restoring daemon
  witness reporting and graceful shutdown safety.
- Removing a repository on another machine now prunes empty directory
  skeletons without touching local Git or recovery data. `rbox doctor` reports
  any retained repository residue and known quarantine directories; pass
  `--residue-bytes` to measure their size on disk.

### Changed
- **`rbox --help` now shows the real command signatures.** The default screen
  listed bare words (`start`, `stop`, `sync`), hiding the `[PATH]` argument that
  every one of those commands already accepts and making `start` read like a
  machine-wide switch. It now shows `rbox sync [PATH]`, `rbox start [PATH]`,
  `rbox stop [PATH]`, `rbox logs [PATH]`, `rbox status [PATH]`, and
  `rbox doctor [PATH]`, and is pared to the common loop. `rbox help --all`
  still prints the full reference.
- **`rbox start` no longer opens guided setup.** Run outside a synced folder on
  a terminal, it used to launch the interactive front door — one command with
  two meanings. It now starts background sync for the workspace at `[PATH]` or
  the current directory, and otherwise fails with "Not inside a synced folder.
  Run `rbox` to get started, or pass the folder: rbox start <path>". Bare
  `rbox` remains the setup front door.
- Manifest publications now report whether they emitted a delta or snapshot,
  including encoded size (and delta operation count), in daemon logs and
  interactive push, pull, and sync diagnostics.
- **Pulls stay fast after you clone or delete a repository inside your
  workspace.** Cloning, publishing or removing a repo used to permanently drop
  every later pull back onto a full workspace scan (~5s each on a large
  workspace) until the daemon was restarted; rbox now re-aligns its ignore
  matcher when the workspace's repository set moves and returns to instant
  pulls on the very next sync.
- Live file watching now follows ignore-rule changes instead of continuing to
  filter events through the rules it started with. When such a change alters
  what the operating-system watcher itself can see, rbox says so in the log and
  falls back to scanning pulls until the next restart, rather than trusting a
  watcher that has gone partly blind.
- Every scan-path pull now records WHY it scanned (`pull local=scan skip=…`),
  so a slow steady state can be attributed from the daemon log alone.

## [1.9.1] — 2026-07-25 — "worktrees come and go, sync keeps up"

### Fixed
- **Deleting a git branch now syncs like any other change.** When you delete a
  branch (or an agent tears down its worktree and branch), rbox first proves
  the deletion is real — the branch is verifiably absent under a lock, on a
  healthy ref database, with a receipt that this machine held exactly that
  branch — and only then publishes it. Your other machines prune the branch
  automatically. Previously this exact workflow could wedge a repository's git
  sync permanently. Set `RBOX_GIT_ABSENCE_CAPTURE=0` to restore the old
  behavior.
- **A linked worktree no longer stalls the whole repository.** A branch checked
  out in a worktree is held individually; every other branch and commit keeps
  syncing past it, and the repeated re-checking that cost ~9s per cycle on
  held repositories is gone. (`RBOX_GIT_OWNERSHIP_HELD_SKIP=0` /
  `RBOX_GIT_OWNERSHIP_NO_ESCALATE=0` restore the old behavior.)
- **Squash-merged branches are recognized.** A branch whose changes already
  landed on another branch via squash-merge no longer forces holds onto
  unrelated branches. (`RBOX_GIT_CONTENT_EQUIV=0` restores ancestry-only.)
- `rbox doctor` now lists leftover linked worktrees — branch, full path,
  whether git considers them prunable, and whether they hold a synced branch.
  (Absolute paths stay on your machine; uploaded diagnostics carry a redacted
  summary.)
- On macOS 26, stale-lock cleanup works again: Apple removed the system call
  rbox used to read process start times, which made lock owners unreadable
  and could park a repository behind locks nobody held.
- A crash at exactly the wrong moment after saving sync state can no longer
  lose both the newest save and its fallback (the save's directory entry is
  now flushed before the fallback marker is removed).
- Clearer statuses: a deleted branch mid-publish shows "finishing a branch
  deletion" (instead of "local commits changed here"), and an unreadable ref
  database is reported as exactly that instead of being treated as "no
  branches" — a failed read can never turn into a published deletion.
- On macOS, the daemon now recovers automatically after a clean full-tree scan
  when a dropped-events watcher error would previously have degraded it to
  periodic scans for the rest of the process. Set `RBOX_WATCHER_RETRUST=0` to
  restore the previous behavior.

### Known
- A branch that was already deleted while a repository was wedged on an older
  version carries a stale possession receipt and won't publish its deletion by
  itself. One-time fix: re-create the branch at its last-known commit, let one
  sync complete, then delete it again. `rbox status --git` names the affected
  branch.

## [1.9.0] — 2026-07-23 — "add a machine from the web"

### Added
- **Add a second machine from your dashboard — no pairing token, no recovery
  phrase.** Run `rbox login` on the new machine, approve it in the web
  dashboard, and it automatically receives your encryption keys from a machine
  that's already connected and online. If no machine is available to hand off
  the keys, it falls back to the pairing token / recovery phrase as before.

### Fixed
- A newly-approved machine no longer gets stuck: the delivered key's lifetime is
  now aligned to the login window, so enrollment completes instead of being
  rejected as being outside the device-code window.
- Approving your *first* machine from the web now signs it in cleanly (and then
  guides you to set up encryption), instead of erroring that encryption isn't
  set up for the account yet.

## [1.8.0] — 2026-07-23 — "setup feels brand new"

### Changed
- **The interactive CLI has been rebuilt from the ground up.** Every menu,
  question, and text prompt now runs on one owned component system: arrow-key
  menus with clear checkmarks, a live preview under the directory picker that
  always shows exactly which folder you're about to sync (with Tab
  completion), completed steps collapsing into tidy one-line receipts, and
  consistent key hints throughout.
- **First run has a new face.** rbox greets you with its wordmark, and
  encryption setup is now one clear task — "Protect your files", two short
  sentences, then pick where to save your recovery phrase: 1Password (via
  its `op` CLI, with the save verified), the macOS Keychain, a plain-text
  file, your clipboard — any combination (arrived in 1.7.26, now with the
  streamlined flow). The workspace step spells out its choices: create a
  new rbox workspace from a folder on this machine, or sync a workspace
  already in your rbox account.
- Secret entry (your recovery phrase, pairing tokens) never echoes — not even
  as dots — and the receipt line says only "received".

### Fixed
- Pressing Ctrl-C at any prompt now always exits cleanly (code 130) and
  restores your terminal — even if you catch a prompt the instant it appears.
- Fast typing, pasted keys, or a laggy SSH connection can no longer swallow
  keystrokes: keys that arrive bunched together are now handled one at a
  time, in order.
- Answering a yes/no question requires Enter again, so a stray keypress can
  no longer accept the next screen by accident.

Every release build now drives these prompts on real terminals across all
three platforms — including secret-entry failure cases — before it can ship.

## [1.7.26] — 2026-07-23 — "name clashes can't stop sync, your phrase saves anywhere"

### Added
- **Save your recovery phrase where you actually keep secrets.** First-run
  setup now shows checkboxes instead of a single yes/no: save to 1Password
  (when its CLI is installed, rbox creates the item in a vault you pick and
  verifies it landed correctly), the macOS Keychain, a plaintext file, your
  clipboard — any combination. If some saves fail, rbox lists exactly what
  succeeded and only continues with fewer copies after you explicitly agree.
  Interrupted setups resume without losing progress or creating duplicate
  1Password items.
- Setup now explains the security model in plain words before asking: your
  files stay normal and usable on this computer; rbox encrypts the uploaded
  copy with this phrase so it stays private in the cloud — even from us;
  GitHub and other source control keep working; uncommitted work is
  protected too.
- `rbox status` and `rbox key status` show 1Password backups you've saved
  (reported as recorded — rbox doesn't reopen your vault to check them).

### Fixed
- **One ambiguously-named file can no longer stop sync.** Two paths that
  differ only by letter case (`README.md` vs `readme.md`) used to block the
  entire sync cycle. rbox now keeps syncing everything else, holds back just
  the ambiguous names so one variant can never overwrite the other on a Mac,
  shows a plain warning in `rbox status` (your workspace stays healthy), and
  syncs the surviving file automatically once you rename or remove a
  variant — no manual re-sync needed.

## [1.7.25] — 2026-07-23 — "stops are safe, pairing is one command"

- **Interrupted syncs can no longer strand your git repos.** Every lock rbox
  takes is now journaled with proof of ownership before it exists, and
  recovery after a crash or kill cleans up exactly rbox's own locks — never
  a lock another tool created. Repos blocked by unknown locks surface an
  actionable notice instead of silently deferring.
- **`rbox stop` is now graceful.** A stop waits for in-flight critical work
  to finish instead of force-killing it mid-operation (a second Ctrl-C or
  signal still escalates promptly), and stopping older daemons keeps the
  previous bounded behavior — upgrades never hang.
- **Pairing a second machine is one command.** `rbox pair` now prints the
  complete `rbox connect <pairing-token>` command to run on the new machine
  (press `c` to copy it); the token stays single-use and expires in ten
  minutes. The masked-prompt flow remains for those who prefer it.
- **`rbox key status` no longer claims your macOS Keychain backup is
  missing.** The status probe misread a successful save; it now reports
  the saved recovery kit correctly.
- Deleted worktree "ghost" deferrals now clear on their own, including on
  pull-only machines.

## [1.7.24] — 2026-07-22 — "the keychain save actually saves"

### Fixed
- `rbox key save` now works on real Macs: the tool rbox uses to find your
  login Keychain was being called in a way modern macOS rejects, so every
  save failed with "Keychain resolution failed". Found live by the founder;
  fixed and verified against real `security` output.
- The recovery-phrase prompt now shows what you type (typing 24 words blind
  caused typos and silently truncated pastes) and tells you when a paste
  came through partial ("expected 24 words but got 10").
- `rbox key save < phrase-file` no longer reads empty input.

## [1.7.23] — 2026-07-22 — "your recovery key gets a home"

### Added
- Your recovery key can now live in the macOS Keychain: after signing in,
  rbox offers once to save it (no typing if this machine still has its
  cached key; otherwise you type your phrase once and rbox checks it against
  your account before saving). `rbox key recover` can restore your account
  directly from the Keychain on a fresh machine login. You can also export a
  recovery kit file with `rbox key save`. Uninstalling warns before removing
  the last copy of your key, wherever it lives.

### Fixed
- Account setup can no longer lose your recovery phrase or half-create your
  account if anything crashes at the wrong moment: the phrase is safely
  staged on disk before rbox talks to the server, the server creates your
  account in one all-or-nothing step, and an interrupted setup resumes
  exactly where it left off the next time you run rbox. Wedged half-created
  accounts (from the old flow) now have a supported repair path.

### Added
- macOS recovery-kit saves now use an explicit login Keychain item by default,
  with validated `rbox key save`, Keychain-first recovery, strict live status,
  and `--kit-path` retained for deliberate plaintext export (design 179).

## [1.7.22] — 2026-07-22 — "upgrade finishes the job"

### Fixed
- `rbox upgrade` now finishes the job even when the binary is already
  current: if a running daemon is still on an older version (for example
  after the install script swapped the binary), upgrade restarts exactly
  those daemons — preserving pull-only — instead of saying "already up to
  date" and leaving them stale. Daemons already on the current version are
  left untouched, and `rbox upgrade --check` still never restarts anything.

## [1.7.21] — 2026-07-22 — "transient hiccups heal themselves"

### Changed
- Stale "git busy" warnings clean themselves up: rbox now re-checks every
  recorded git-lock deferral before showing status and on a daemon cadence
  (including pull-only daemons), and clears the exact stale entry the moment
  the locks are gone — even for repos that have since disappeared from the
  workspace. Locks that sit unchanged for 30+ seconds with no known owner are
  labeled "stable Git locks without a known live owner" with a live lock
  count and age, instead of an eternal generic "git busy".
- A failed sync no longer waits for luck to retry: every halt now owns its
  own recovery schedule (exponential backoff, 2-minute cap) that pulls,
  re-checks, and clears itself the moment the cause is gone — an idle machine
  can't stay "halted" just because a push lost a race two hours ago. While a
  retry is scheduled, status says "retrying after conflict; next probe in Ns";
  "halted" is reserved for real safety refusals, which still clear only when
  their own condition stops reproducing.
- Pull-only machines keep a standing push problem dormant instead of losing
  it, and wake it up only if you switch the daemon back to read-write.

## [1.7.20] — 2026-07-22 — "resolutions land when you confirm them"

### Changed
- Confirmed `keep-mine` now waits for the current sync cycle and publishes in
  the foreground under the same workspace lock — no more waiting for a future
  sync to act on your decision, and no more "snapshot changed, confirm again"
  loops from ordinary repo activity while you waited. A crashed confirm
  reconciles safely on the next push or pull. Local intents written by
  rbox <=1.7.18 are ignored and dropped on the next state save; restart any
  still-running older daemon before confirming with the new CLI.
- Replica machines no longer re-publish unchanged synced state in a loop: a
  carried remote section now compares as unchanged. (This loop could flood
  the workspace with sequences and starve the machine you were actually
  working on.)

### Added
- Daemon modes are durable: `rbox start` resumes the mode the daemon last
  ran in (pull-only stays pull-only across restarts and upgrades), an
  explicit `--read-write` flag is the inverse of `--pull-only`, and a mode
  change against a running daemon asks for a restart instead of silently
  recording a lie.

## [1.7.19] — 2026-07-21 — "status tells you what's actually wrong"

### Added
- `rbox status` shows the running daemon's version next to the daemon line,
  and warns plainly when it differs from the CLI: "daemon is running v1.7.18
  but this CLI is v1.7.19 — restart to finish the upgrade". A binary swap
  without a restart is no longer invisible.

### Changed
- Brief sync holds no longer cry wolf: transient deferrals younger than
  10 minutes (peer echoes that resolve themselves on the next push) are
  hidden from human status output. `--json` still reports everything.
- The conflict-snapshots line appears only when snapshots are actually
  prunable — a fully time-locked count you can't act on is noise.

### Fixed
- The Bun ref-watch release/CI probe no longer fails when a starved CI
  runner can't generate watcher load: an unprovable test premise now retries
  with escalating pressure and reports "inconclusive" instead of masquerading
  as a real failure. Genuine watcher regressions under real load still fail
  hard. (This one flake cost three pipeline legs in a single day.)

## [1.7.18] — 2026-07-21 — "keep-mine works even when history is gone"

### Fixed
- `keep-mine` no longer gets permanently stuck when the old synced snapshot
  references commits that no longer exist anywhere (for example a squash-merged
  PR whose branch and worktree were deleted). If you explicitly confirmed
  discarding that branch in the preview, the unprovable lane is now accepted
  and its objects are still preserved. Staging-area and operation-state lanes
  keep the strict behavior — their contents can't be safely enumerated when
  unprovable.

## [1.7.17] — 2026-07-21 — "leftovers don't block you"

### Fixed
- `keep-mine` no longer refuses because of harmless leftover files from
  finished git operations (a stale `ORIG_HEAD` or `REBASE_HEAD`). Only a
  genuinely in-progress merge/rebase/cherry-pick blocks it — found live
  during the first real-world unwedge, which succeeded.

## [1.7.16] — 2026-07-21 — "your repo explains itself"

### Added
- `rbox git resolve <repo> keep-mine` — when rbox is holding an old synced
  snapshot your repo has moved past, keep-mine publishes YOUR local git state
  as the truth. It previews exactly what the old snapshot has that your repo
  doesn't (in plain English), asks for confirmation, and applies safely on the
  next sync — your files, branches, and history are never touched.
- Held repositories now explain themselves: `rbox status` says why a repo is
  paused, reassures you the repo itself is healthy, and names the exact
  command to fix it.

### Fixed
- Repositories held for sync-bookkeeping reasons no longer re-process at full
  cost on every sync — the skip that shipped in 1.7.15 now actually engages
  for the common held shapes (it never could before).

## [1.7.15] — 2026-07-21 — "stuck repos heal themselves"

### Fixed
- A repository whose local git history moved ahead of its last-published state
  could livelock: every pull re-processed it at full cost (30s+ on large
  repos), forever, while its fresh state was never republished. rbox now
  proves when your local history fully contains the stale unapplied state and
  publishes yours — the repo heals itself in one sync cycle. Repos held for
  other reasons skip the expensive re-processing entirely between changes.

### Added
- Conflict snapshot retention: old conflict-preservation refs are pruned once
  their work is back in a branch (or after 90 days); `rbox status` now shows
  `conflict snapshots: N (M prunable)`.
- Fleet phase telemetry (`sync_phase`): pull/push phase timings now reach the
  dashboard, so a slow phase can never hide in local logs again.
- Deeper timing detail in daemon logs: per-step git-apply attribution and
  push missing/commit chunk timings.

## [1.7.14] — 2026-07-21 — new repos sync fast too

### Fixed
- Repositories created, cloned, or moved into the workspace *while rbox is
  running* now get the same seconds-fast commit sync as everything else
  (previously their commit-only changes waited for the periodic safety scan,
  up to a minute). rbox watches each repository's branch/tag surface directly
  on Linux; macOS already behaved this way.
- Repositories using git's experimental `reftable` format are now refused for
  git history sync with a clear message (previously their commits could
  silently stop syncing while files continued). Standard-format repositories
  are unaffected.

### Added
- Sync-trigger telemetry so the fleet dashboard can chart how commits get
  detected (instant signal vs periodic scan). Opt out with `RBOX_TELEMETRY=0`.

## [1.7.13] — 2026-07-21 — commits sync in seconds

### Changed
- Git commits now sync to your other machines in a few seconds instead of up
  to a minute. rbox watches each repository's ref surface (branch tips, tags,
  HEAD) directly, so a commit, amend, branch switch, or tag — even one that
  changes no working-tree files — triggers an immediate sync instead of
  waiting for the periodic safety scan. Repository contents under `.git` are
  still never synced as files.

### Known limitation
- A repository created or cloned into the workspace *after* the daemon
  started falls back to the (now always ≤60s) safety scan for commit-only
  changes until the daemon restarts. A dedicated fix is in design (172B).

## [1.7.12] — 2026-07-20 — faster sync recovery

### Fixed
- When a live change notification is missed, sync now catches up within seconds
  instead of waiting up to ~5 minutes for the periodic safety poll. During quiet
  periods rbox briefly asks the server whether it's behind and pulls immediately
  if so — so a small commit lands on your other machines promptly even if the
  real-time nudge didn't arrive.

### Added
- Fleet sync-health telemetry so we can spot propagation slowdowns across the
  fleet without asking for logs. Opt out with `RBOX_TELEMETRY=0`.

## [1.7.11] — 2026-07-20 — locking survives a broken host-identity cache

### Fixed
- Workspace locking no longer breaks when the on-disk host-identity ledger
  (`~/.rbox/host-identity.json`) can't be read or written. That file is only a
  boot-history cache used to sharpen stale-lock cleanup across reboots; a read
  failure (e.g. a filesystem that reports slightly different timestamps for the
  same file depending on how it's queried) used to make every lock-dependent
  operation report "unsupported" — which on some macOS setups aborted `rbox
  setup`'s initial push with "capable state-lineage initialization failed
  (unsupported)". rbox now retries a transient read and, if the cache remains
  unreadable, proceeds using the machine's live identity with locking fully
  intact — only the cross-reboot stale-lock optimization is skipped.

## [1.7.10] — 2026-07-20 — setup works when locking is degraded, plus onboarding polish

### Fixed
- `rbox setup` no longer refuses when workspace locking can't be established
  (e.g. a hardened macOS where the identity probe can't run). It now warns and
  continues in the same legacy-unlocked mode every other command already uses,
  and the warning shows the *real* underlying error instead of a misleading
  "this filesystem does not support locking." The only thing given up is
  coordination against concurrent rbox processes on the same workspace.

### Changed
- The recovery-phrase prompt (`rbox key recover` and setup recovery) is now a
  visible input — a 24-word phrase is long and paste-error-prone, and hiding it
  made a bad paste impossible to spot. Pairing tokens and genesis secrets stay
  masked.
- Running bare `rbox` inside a workspace while signed out now leads the menu
  with "Log in", which routes into the normal `rbox login` flow.

## [1.7.9] — 2026-07-20 — recovery phrase & first-run encryption no longer crash

### Fixed
- Entering your recovery phrase (`rbox key recover` or the setup wizard) and
  first-run encryption setup ("set up encryption on this machine") no longer
  cause rbox to silently exit with no message. The BIP39 checksum used an
  asynchronous WebCrypto call that, run as the final step of a one-shot
  command, could let the process end before it completed; it now uses a
  synchronous hash. If you upgraded and hit this on 1.7.8, `rbox key recover`
  with your phrase now works.

## [1.7.8] — 2026-07-20 — join a folder that's already ahead

### Added
- Joining a workspace with a folder that already has content — repos that
  are ahead of the fleet, extra files — now converges forward instead of
  getting stuck. rbox retains your pre-join content, pulls the workspace
  baseline, then overlays your files and commits back on top: ahead repos
  fast-forward the whole fleet to your state, files you already had are
  preserved, and anything genuinely diverged is kept safely aside and
  reported (`rbox adopt status`) rather than published. Your pre-join copies
  are retained until you clear them, so the whole join is reversible.
- `rbox adopt status|resume|abort|clean` — inspect, resume, roll back, or
  clear an in-progress or completed adoption.

### Fixed
- A folder whose repos were ahead of the fleet previously parked on join
  with no automatic path forward (its newer commits never published and the
  working tree could show older content). It now converges forward.

## [1.7.7] — 2026-07-19 — branch switches follow both ways

### Fixed
- Switching a repo back to a branch whose tip is an ancestor of your current
  branch (for example `git switch main` after working on a feature branch) now
  follows on every paired machine within one sync cycle. Previously the
  follower machine could be permanently stranded on the old branch with a
  perpetually dirty `git status` and a stuck "receiver-only commits" deferral,
  even though every commit was fully synced. Machines with genuinely local
  commits still defer safely to `rbox git resolve`; `RBOX_GIT_FOLLOW=0`
  remains the containment switch and now has pinned semantics (it bypasses
  the follow pipeline entirely via the legacy apply path).

### Added
- A two-machine `git-ff` test-rig scenario now gates every release on the
  everyday git flows: commit fast-forward, branch creation with passive
  checkout-follow on the paired machine (in both author directions), and
  switch-back — 46 assertions of end-state including sync-record promotion.

## [1.7.6] — 2026-07-19 — faster scans, quieter cycles

### Changed
- Layer A's directory-listing cache is now enabled by default for foreground
  and daemon scans; `RBOX_SCAN_PRUNE=0` is the single kill switch (`=1` remains
  accepted). It elides reusable directory enumeration while per-file stat and
  matcher work remain. Daemon safety scans prune only with a live, trusted
  watcher; untrusted or absent watchers retain full-tree coverage for recovery.

### Fixed
- Successful macOS bulk directory listings now refresh Layer A cache entries,
  so bulk scanning and directory-listing reuse compose on subsequent scans.
- The daemon no longer rewrites its entire state file every cycle when nothing
  changed — a phantom-difference bug made steady-state syncing rewrite tens of
  megabytes every ~30 seconds on many-repo workspaces (and steadily grow the
  daemon's memory). True no-op cycles now write nothing.

## [1.7.5] — 2026-07-19 — a front door that knows you

### Fixed
- Crash recovery no longer refuses to read a normal-sized state file on
  machines with plenty of memory: the safety budget now scales with your
  machine's RAM (quarter of physical memory, between 4 and 32 GiB) and
  respects container memory limits. The refusal message now also explains
  the `RBOX_RESET_PARSE_BUDGET_BYTES` override.

### Added
- The "which directory should rbox sync?" prompt is now a real picker: type
  to fuzzy-filter the current directory's folders, press Tab to complete
  into a subdirectory like shell completion, and plain Enter still takes the
  current directory instantly. Typing any path by hand (including one that
  doesn't exist yet) works exactly as before.
- Running bare `rbox` in a workspace now offers everything you'd reach for:
  Sync now / Start background syncing (or Pause syncing while it's running),
  Set up a new workspace, Pair another device, View usage, View logs, Exit.

### Fixed
- The bare-`rbox` overview no longer shows "plan unavailable" on a freshly
  set-up machine — it now fetches your email and plan once (quickly, and
  only when interactive) instead of waiting for a cache another command
  would have filled.

## [1.7.4] — 2026-07-19 — a first sync you can watch

### Added
- Byte-based progress across the first sync: scanning shows the payload size
  as it grows, encrypting shows bytes done vs total, and uploading shows a
  live MB/s rate with an ETA once the rate settles. Progress percentages now
  track bytes, not file counts — 100k tiny files no longer skew the bar.
- After setup completes, rbox offers to set up another machine right away
  (generates a pairing token on the spot). Pair more devices any time with
  `rbox pair` on an already-paired machine.
- Long steps reassure you after ~10 seconds ("initial encryption of many
  small files can take time") instead of looking hung.

### Changed
- The "authorize this machine" menu leads with "Sign in via browser", and the
  duplicate "Approve a code" entry is gone (it was the same browser grant
  under a second name).
- Press `c` on the browser sign-in screen to copy the URL to your clipboard.
- The setup workspace step shows the same "what is a workspace" definition as
  `rbox init`.
- Git history still uploading after setup is announced calmly ("Git history
  will continue uploading in the background.") — it's expected, not an error.
- Start-sync choices now read "Start background sync now and on machine
  boot" — nothing implies you need to reboot.
- The final setup screen shows your workspace name and this machine's
  hostname instead of internal ids.
- The gitignore choice now tells the truth about what each option does and
  teaches the `!.env` trick: sync a secrets file between your machines,
  end-to-end encrypted, without ever committing it.

### Fixed
- Debug telemetry (multipart instrumentation and the push summary line) no
  longer prints mid-setup for release users; set `RBOX_DEBUG=1` to see it.

## [1.7.3] — 2026-07-18 — a friendlier first run

### Added
- Setup now explains what a workspace is right where you create or join one:
  a single repository, a folder of many repositories, or just a folder.

### Changed
- `rbox start` outside a workspace opens the guided setup on a terminal so you
  can create or join one on the spot, instead of erroring out. Scripts and
  service managers still get the explicit "not inside a workspace" error.
- Setup no longer asks for a "Project id" — one fewer confusing prompt when
  creating a workspace.
- Enabling autostart follows the rbox binary you actually run, so an install
  outside `~/.rbox/bin` (for example `~/.local/bin`) starts on login correctly.
- **Credential corruption is now preserved and reported instead of looking like
  a logout.** Credentials use a versioned, atomically written format; malformed
  or future files are quarantined without overwriting prior evidence. rbox also
  refuses symlinked, non-regular, or unsafe credential paths and gives recovery
  guidance, while status and doctor remain available in a credential-degraded
  state.

## [1.7.2] — 2026-07-17 — faster releases, same gates

### Internal
- Release builds now reuse the exact squash commit's successful main CI verdict
  instead of rerunning the same suite a third time. Immutable release uploads
  and verification run concurrently; signing, native smoke tests, rollback
  protection, and sequential channel activation remain unchanged.

## [1.7.1] — 2026-07-17 — your sync history stops eating your storage

### Changed
- **Every sync now stores a compressed snapshot of your workspace index
  instead of a full raw copy — about 24× smaller.** For active workspaces
  this was the dominant storage cost: each sync stored a complete
  multi-megabyte index even when almost nothing changed, and version
  history kept every copy. New syncs write the compact format; existing
  history is unaffected and remains fully readable. All supported rbox
  versions (v1.1.0+) read both formats. Set `RBOX_MDE_SNAPSHOT=0` to
  temporarily restore the old format if you run a pre-v1.1.0 device.

## [1.7.0] — 2026-07-17 — consent before reset, recovery at scale

### Changed
- **rbox never resets a workspace without showing you exactly what changes**
  (design 138). Rebinding to a different remote stream now walks through an
  explicit two-stage consent: you confirm the specific workspace you're
  leaving and the specific one you're joining — identified by their remote
  ids, not just names — and the confirmation you gave is cryptographically
  tied to that exact pair. A stale or replayed confirmation is refused.
- **`rbox track` and keyed setup refuse to silently adopt a mismatched
  stream.** Where an old version might have proceeded, the CLI now stops and
  explains which workspace the directory actually belongs to. (Breaking
  change for scripts that relied on the silent path.)

### Fixed
- **Crash-safe reset and recovery.** If the machine dies mid-reset, the next
  start picks up from a journal that records what was authorized and how far
  it got: quarantines resume instead of restarting, archives are copied (never
  moved) until the restore is fully published, and a damaged journal halts the
  daemon into a guided `rbox doctor reset-journal` flow instead of guessing.
- **Corrupt or oversized state can no longer wedge the daemon.** State reads
  are byte-bounded with a memory admission gate, and the daemon heals through
  an explicit halted → recovering → ready cycle with a three-way agreement
  check between boot, config, and state before serving.
- **RboxBar finds the rbox binary when launched from Raycast or the Dock.**
  GUI launches don't inherit your shell PATH; the menu bar app now probes the
  standard install location (`~/.rbox/bin/rbox`) first.

### Internal
- Git burn-in suite (design 141): fifteen live-rig cells covering submodules,
  LFS, Unicode/case-folding, shallow and partial clones, and in-progress
  merge/rebase/cherry-pick/bisect — 494 assertions, all green, with the two
  known engine gaps documented and pinned.
- Storage-truth measurement tooling (designs 142–144): read-only prod
  decomposition of account storage into active/history/reclaimable classes.

## [1.6.9] — 2026-07-17 — the wizard forgives your typos

### Fixed
- **`~/paths` work in the setup wizard** (design 137). Typing `~/proj` at the
  directory prompt now means your home directory instead of creating a literal
  folder named `~`. Unsupported forms like `~user/…` explain themselves and ask
  again.
- **A typo can no longer create a workspace you didn't want.** The wizard shows
  the resolved absolute path before anything happens, asks before creating a
  directory that doesn't exist, and doesn't touch the server until the local
  side is confirmed and locked. If something fails after a workspace was
  created, you get its id and the exact way to resume — never a mystery orphan.
- **Mistakes keep you in the wizard.** Bad paths and malformed pairing tokens
  re-prompt (tokens are checked locally before any network call); a mistyped
  24-word recovery phrase is caught offline; blank input navigates back;
  declining "create a new workspace anyway?" returns to the menu with your
  sign-in intact. A used-up token now says to mint a fresh one on your other
  machine.

### Changed
- Clearer first-run copy: joining a workspace nobody has pushed to says
  "nothing was available to pull" instead of "0 pulled, 0 conflict(s)"; the
  workspace-id prompt says where to find the id; the sign-up prompt no longer
  doubles as a mystery masked-secret field; the approve screen always shows
  the full URL; the authorize menu points lost-device users at recovery.
- Releases are now gated by a deterministic TUI regression suite that drives
  the real wizard in containers — the six defects above are permanently
  guarded by it.

## [1.6.8] — 2026-07-16 — zombie branches rest in peace

### Fixed
- **Followers now prune stale side branches** (design 130). When you squash-merge a PR
  and delete the branch, every follower deletes its copy too — safely. Deletion is
  gated by a publisher-authored tombstone chain plus a compare-and-swap provenance
  check, so a branch with unpushed local commits, an active checkout, or any doubt at
  all is left alone (with the reason logged). A deleted branch's proven tip stays
  recoverable for 90 days under `refs/rbox-recovery/`. This retires the "83 zombie
  branches" class of clutter without ever risking real work.

### Changed
- **Second-device setup answers its own questions** (design 134, from real user
  feedback). The setup wizard now says exactly where a pairing token comes from
  (`rbox pair` on an already-set-up machine — never the dashboard, because it carries
  your encryption key) and distinguishes it from the browser confirmation code (which
  authorizes but carries no encryption). Every successful login/pairing now points to
  the next step: `rbox setup` → "Sync an existing workspace". The dashboard's link and
  CLI-login pages explain code-vs-token, `/devices` gained an "Add another machine"
  card, and the dashboard links to the docs throughout.

## [1.6.7] — 2026-07-16 — a first sync you can predict

### Changed
- **Setup now respects `.gitignore` by default.** The wizard's default choice skips
  gitignored untracked files, so your first sync is your source — lean and fast. The
  previous behavior lives on as a clearly-worded option: gitignored files sync too,
  end-to-end encrypted (rbox can never read them) — ideal for `.env` files, notes, and
  local state — with `!` re-includes in `.rboxignore` and an ignore-mode toggle for
  changing your mind later. Existing workspaces and scripted setups are unchanged.
- `rbox ignore --list` now tells the truth: `.gitignore` rules are labeled active or
  present-but-not-applied based on the workspace's actual setting.
- Account creation leads with browser sign-up; docs corrected (`--purge` exists and is
  documented; the README's sync-scope claims now match reality); assorted first-run copy.

## [1.6.6] — 2026-07-16 — strands heal themselves, show-me shows up

### Fixed
- **ORIG_HEAD deferral self-heal** (design 126): a follower stranded by a stale `ORIG_HEAD`
  breadcrumb (the class that required manual replica surgery, twice) now adopts the incoming
  value automatically — but only when the repo is provably a pure replica (no local edits,
  index, commits, stash, or any in-progress git operation), and never without durably
  preserving the old value first (recovery refs under `refs/rbox-recovery/`, capped).
  `git-sync: adopted stale ORIG_HEAD breadcrumb` in the daemon log marks each heal.
- **`rbox git resolve show-me` is fast and talkative** (design 128): ownership proofs are
  batched (~5 subprocesses instead of thousands on reflog-heavy repos — 30 minutes → seconds),
  progress goes to stderr, and human output caps at 50 local-only commits. JSON output and
  resolve safety data remain exhaustive.
- Capture bundles no longer advertise internal `refs/rbox-*` refs.

### Server (already live)
- Fleet push alerts (design 127): drift >24h and reporting-stopped conditions page
  #rbox-alerts hourly, with incident dedup/resolve semantics.

## [1.6.5] — 2026-07-16 — the fleet phones home (design 120)

### Added
- **Product telemetry** (design 120): the daemon now ships privacy-safe product-health
  samples to your rbox server — propagation lag (delivery→apply), first-publish timings,
  upload-lane wire vitals, crypto-pool capability, and safety events (mass-delete breaker,
  scan faults). Counts, timings, and fixed enums only; never paths, hashes, or free-form
  strings — enforced server-side by a hard validator.
- **Fleet sync-state reporting**: each daemon upserts its current git-plane position
  (repos managed/deferred, oldest deferral age, reason classes) so a dashboard can catch a
  stranded repo without touching the machine. Uses the exact projection `rbox git deferrals`
  uses — the dashboard and the device can never disagree.
- `RBOX_TELEMETRY=0` disables all of it (checked at both enqueue and flush; telemetry goes
  to the operator's own worker, never a third party).

### Fixed
- An invalid `x-rbox-version` header can no longer blank a device's recorded binary version.

## [1.6.4] — 2026-07-15 — logs that rotate, deferrals you can see and fix

### Added
- **The menu bar now shows *which* repos are deferred and why (#285, design
  124).** Under the Git row: up to five repos with plain-language reasons and
  ages ("local commits · deferred 1h"), full paths on hover, "+N more" beyond
  five. A **Copy Git fix brief** button puts a self-contained, paste-anywhere
  brief on the clipboard — per-repo diagnosis, what clears on its own vs what
  needs a decision, and exact safe commands — readable by a human or an LLM.
  Unknown or forged deferral reasons can never be offered a resolve command.
- **`rbox git deferrals`** — the same drilldown in the terminal: human list,
  `--brief` (the clipboard document), or `--json` (typed lane array, identical
  to `status --json`).

### Changed
- **Daemon logs rotate daily (#286, design 125).** `daemon-YYYY-MM-DD.log`
  files with 14-day retention (`RBOX_LOG_RETENTION_DAYS` to override) replace
  the forever-growing `daemon.log` (44 MB after a week on the founder's Mac);
  `daemon.log` remains as a small crash sink with pointer records. `rbox logs`
  merges both streams chronologically and `--follow` survives midnight
  rollover and daemon restarts.
- **Sync perf lines went on a diet.** The per-repo `repoMs=` blob (one entry
  per repo, 101 on the founder's workspace) is capped at 8 worst-case
  exemplars plus p50/p95/max aggregates for queue, wall, and fresh-chain
  phases — the distribution signals perf work actually uses, at 3% of the
  bytes. Full detail returns under `RBOX_DEBUG=1`.

### Fixed
- **Test rig repaired (#286):** login rot from v1.6.1's flag rework, container
  git below the 2.46 symref floor, and zombie daemons under a `sleep` PID 1
  that wedged every subsequent sync (the image now runs `tini`).

## [1.6.3] — 2026-07-15 — locks that survive reboots, upgrades that finish the job

### Fixed
- **A Mac reboot can no longer freeze sync behind its own stale lock (#282,
  design 118).** macOS's per-boot `kern.uuid` made a rebooted machine read its
  own pre-reboot lock as another host's — unbreakable by design — starving the
  founder's Mac for 26 hours. Lock identity now prefers the stable hardware
  UUID with an 8-boot alias ledger, and on a proven-local disk (the kernel's
  own `local` mount flag, fail-closed) an unrecognized stale marker is probed
  and reaped like any dead local lock. Wire format unchanged — old and new
  binaries interoperate within a boot; downgrades stay safe.
- **`rbox git resolve` works and tells the truth (#282).** A failed resolve
  used to leak its own lock marker (bricking every later attempt) and swallow
  the real error into a generic message. The break path now cleans up only
  what it provably owns (`.reap` fence included), and errors are typed —
  `sync-busy` names the daemon holding the mutex.
- **Sync starvation is loud (#282).** Blocked >15 minutes by the same lock →
  one durable warning, an explanation in `rbox status` and `rbox doctor`, and
  a counts-only `lockStarved` metric. Retry spam is gone (250ms→30s abortable
  backoff; the incident wrote 341,824 identical log lines).
- **Old git is explained, not mysterious (#282).** Doctor probes the actual
  `update-ref` transaction capability: "checkout-follow needs git ≥ 2.46,
  found 2.43" instead of "unsupported git state".

### Added
- **`rbox upgrade` finishes the job (#282).** It now stops every running
  daemon and WAITS for exit (the old stop removed the pidfile without
  waiting — its own race), restarts them with settings preserved, and `rbox
  status` flags daemon/CLI version skew.
- **RboxBar notifies once per new version and updates in one click (#283,
  design 121).** macOS notification (persisted once-per-version, lazy
  permission ask) + "Update to <version>" menu action running the managed
  upgrade.
- **Per-device CLI version tracking (#279, design 119).** Every authed
  request carries `x-rbox-version`; `rbox device list` and the dashboard show
  each device's last-seen version — the compat dashboard for real customers.
- **Slack pings survive slow relays (#281, design 122).** Signup/subscription
  pings run post-response via `waitUntil` (5s budget + retry; the first
  customer's signup ping died at the old inline 700ms), and failures
  self-report to #rbox-alerts (URL derived from the business webhook).

## [1.6.2] — 2026-07-14 — rbox knows your name

### Added
- **Identity banners show who you are, not your account id (#278, design
  117).** The untracked-dir menu, the setup skip-notice, `rbox account
  status`, and `rbox status`'s ACCOUNT section render
  "Signed in as you@example.com (github)" once the local profile cache has
  seen an account fetch (any `rbox status` fills it). Falls back to the
  account id when uncached — or permanently for CLI-only accounts with no
  web login. The cache (`~/.rbox/account-profile.json`) is non-secret,
  0600, sanitized against terminal injection, keyed to the signed-in
  account, and cleared on logout.

### Fixed
- **New accounts get their email cached at first login (server).** The
  provisioning path now seeds the email from the Clerk fetch it already
  makes; previously the address stayed unknown until the second web login
  (affecting new-device alert recipient resolution too).

## [1.6.1] — 2026-07-14 — bare `rbox` meets you where you are

### Added
- **Enrolled machines get a menu, not a mid-wizard jump (#277).** Bare `rbox`
  in an untracked directory used to dump already-enrolled users into the setup
  wizard at "Step 2 of 3" (step 1 silently skipped). It now offers: Track this
  directory / Sync an existing workspace / Nothing. The choice preselects the
  wizard's create-vs-join prompt, so the total number of prompts is unchanged.
  First-time machines still land directly in the wizard.
- **The front-door menu is daemon-aware**: "Pause syncing" when the daemon is
  running, "Start syncing" when it isn't (previously always Pause).

### Fixed
- **Setup step numbers count only the steps that actually run**: an enrolled
  `rbox setup` shows "Step 1 of 2 · Workspace"; the authorized-but-unenrolled
  enrollment prompt gained its missing "Step 1 of 3 · Account" frame.
- **Copy**: the contradictory "Continuing to your workspace." line is gone;
  `rbox pair`'s finish message describes the real menu path on the new
  machine; the bootstrap-secret prompt says blank = browser device-code
  sign-up.

## [1.6.0] — 2026-07-14 — the checkout follows you: git state reconciles across machines

### Added
- **Checkout-follows-sync (design 116, #273/#274/#276).** Switch branches on
  one machine and machines with no local divergence follow automatically —
  branch, HEAD, index, stash — proven safe by a derived manifest-receipt
  oracle, a two-phase rollback-only checkout journal, and a pinned ref-update
  lock protocol. Kill switch: RBOX_GIT_FOLLOW=0.
- **Per-ref worktree holds replace whole-section deferral** (the bug that
  froze a Mac checkout for 3 days): a linked worktree holding a branch pins
  only that ref; identical-OID updates never defer at all.
- **Drift is visible everywhere**: per-repo git deferral age in rbox status
  (+ --json), the daemon line, the shell prompt, the macOS menu bar. "In
  sync" now means BOTH planes.
- **`rbox git resolve <repo>`**: show-me + take-theirs (keep-mine next cycle).
- Fresh-machine fix: git operations no longer fatal without a configured git
  identity (caught by CI's identity-less runners).

## [1.5.4] — 2026-07-13 — receipt draining actually engages: −19%% push wall

### Fixed
- **Upload-time receipt draining now runs in production (#275).** E2eeRemote —
  the wrapper every real publish uses — never forwarded the receiptPort
  capability, so design 111 shipped default-on but inert (redeemOverlap=0 in
  the field). Forwarded + compile-time parity guard so wrapper/transport
  capability drift fails typecheck. Field-validated: commit-enclosed drain
  8s→168ms, total push 39.2s→31.9s on an 8k-blob publish.

## [1.5.3] — 2026-07-13 — release unblocked: one release-env-only flaky grant test skipped (tracked)

## [1.5.2] — 2026-07-13 — the grant-suite fix actually ships this time (1.5.1 tagged without it — cwd slip)

## [1.5.1] — 2026-07-13 — release-gate test hygiene (v1.5.0 build never shipped)

### Fixed
- Bounded teardown in the upload-grant suite: an unresolved gated fetch could
  hang the afterEach hook 10s in the single-process release build, poisoning
  the next test and failing the v1.5.0 gate. Same #264 class; 2s close bound.

## [1.5.0] — 2026-07-13 — blob packing: small-file uploads scale with bandwidth

### Added
- **Blob packing (design 114, #268/#271).** Small ciphertext blobs pack into
  bandwidth-sized R2 objects instead of one-object-per-blob: the small-file
  lane stops being R2-operation-bound (~48.8 Mbps measured wall pre-packing)
  and scales toward line rate like the multipart lane. Reader path +
  server accounting ship ON (mixed packed/unpacked estates are permanent);
  the pack WRITER is behind `RBOX_BLOB_PACK` pending field validation gates.
  GC/fence correctness per the six-round adversarial review: epoch-bound
  candidacy, live-clock deletion stamps, durable swept tombstones, the
  `rbox_delete_fence_pack` trigger, rollback floor (pre-1.5 binaries cannot
  read packs — reader-first rollout).

## [1.4.2] — 2026-07-13 — the crypto pool actually ships: Bun compile bug fixed, init exits clean

### Fixed
- **Release binaries now really run the crypto worker pool (#270).** Bun 1.3.5
  (the old release pin) ignored the text import attribute under `--compile`:
  the embedded worker extracted as 0 bytes, silently disabling the pool
  (inline-crypto fallback) in EVERY release binary to date — and leaving a
  permanently ref'd handle that made one-shot commands (init, push) hang
  after finishing their work. Fixed via a loader-proof `.txt` bundle + a loud
  non-empty guard; release toolchain now pins Bun 1.3.14 (`engines ^1.3.14`).
  Expect faster fleet encryption — pooled crypto in a release build for the
  first time.
- Compiled-binary regression test: a release-style binary must exit within a
  deadline after real crypto work (negative-control verified against the bug).

## [1.4.1] — 2026-07-13 — sweep verdict applied: fill-v2 stays, default records back to 32

### Changed
- **Default batch records: 32** (fill-v2 dispatch policy stays the default). The
  flat-meadow matched-cell sweep passed fill-v2 at 32 records (−14.1% slot work)
  but 64-record batches FAILED the cap gate (−7% — larger per-batch settles beat
  the parallelism). `RBOX_BATCH_RECORDS=64` remains available; the server cap
  stays 64 for re-evaluation.
- Sweep harness: tolerate find SIGPIPE when the corpus exceeds the byte budget.

## [1.4.0] — 2026-07-13 — upload lane rebuilt: full batches, receipts drained in-flight; codebase modularized

### Improved (live by default; founder ship-live call)
- **Batches ship full (design 112).** Upload batching defaults to the fill-v2
  dispatch policy with 64-record batches (server cap raised in lockstep):
  dispatch-on-full with quiet/absolute deadlines replaces the fixed 10ms timer
  that shipped half-empty batches (measured 17.3/32 records, 148KB of an 8MiB
  cap, ~733ms server settle paid 2,360× on a greenfield publish). Kill switch:
  `RBOX_BATCH_FILL=v1`. Version-skew guard: machine-readable `too_many_records`
  400 + strictly-shrinking client latch.
- **Receipts drain during upload (design 111).** Redemption receipts are
  redeemed while blobs upload instead of accumulating into a post-upload tail
  (37.4s measured on 49k receipts), with count+byte-bounded batches and a
  session cap clamp. The commit-enclosed final drain remains the catch-all.
  Kill switch: `RBOX_REDEEM_DRAIN=off`.
- **First-publish observability**: dispatch-reason telemetry, receipt
  request/byte stats, commit-enclosed `finalDrain` timing, repaired
  redemption/upload overlap accounting (interval-union), server-side redeem
  phase splits.

### Changed
- **Codebase modularized (design 113).** Six 1,000–2,500-line engine files →
  ~24 owner-responsibility modules behind exact-surface barrels, with
  `docs/CODEMAP.md` as the navigation contract. Behavior-identical (proven per
  wave: rename/content-equivalence, single-instance state, cycle baseline,
  compiled crypto smoke, token-stream-identical comment sweep). Review
  archaeology moved from code comments to the design ledgers.
- **O(change) commit admission enforced (design 102).** Prod validated 259/259
  shadow agreements, then enforced: admission dropped 5,956ms → 213ms measured.
- Design 109 (auth-call storm) evaluated and parked on gate-0 evidence
  (~89ms/request pre-handler — batch fill was the real lever); design 110
  (commit tail) pending its Phase-0 verdict from the evaluation sweep.

## [1.3.0] — 2026-07-13 — files-first first publish ON by default; init fixed for scripting

### Added
- **Files-first first publish is the default (design 108, #244/#247, `f2403834`).**
  A greenfield `rbox init` now publishes in two commits: files land first (the
  workspace is usable the moment "published → sequence 1" prints), then git
  history attaches as an ordinary second push. Genesis-only — existing
  workspaces are untouched. Field-validated on flat-meadow: two-phase publish,
  409 abort latch, starvation fallback, and flag-off byte-identity all
  confirmed; `timeToFilesSynced` beat the full-publish wall by 107s even on a
  file-heavy corpus. Kill switch: `RBOX_FILES_FIRST=0`.
- **`FirstPublishStats` renders on init** — the `fp filesSynced… authn… commit…`
  line that exposed the next round of perf levers (designs 109–111).
- **Admin workspace purge (#248).** `DELETE /v1/admin/workspace/:id[?dryRun=1]`
  (platform-secret gated) + `scripts/ws-purge.ts` drain — junk/bench workspaces
  can finally be deleted server-side; blobs reclaim via the normal GC pipeline.
  Field-proven on three bench workspaces.
- **Upload/download concurrency knobs (#245).** `RBOX_UPLOAD_SLOTS` /
  `RBOX_DOWNLOAD_SLOTS` (legacy aliases honored), clamp [1,256], defaults
  byte-identical. The measured verdict: defaults stay 24/48 — the knee is at
  48 slots and ≥64 collapses throughput 3x via per-batch RTT inflation.

### Fixed
- **`rbox init --new` no longer clobbers the machine device identity (#246).**
  Device-id resolution now prefers the enrolled E2EE keystore identity
  (`--new-device` escape hatch added); `rbox doctor` gained an O(1) check for
  dangling/mismatched binding ids. Field-verified on flat-meadow.
- **`rbox init` exits cleanly in headless/scripted runs (#246).** Ref'd crypto
  worker threads kept the event loop alive after `main()` returned; one-shot
  commands now tear the pool down on exit (the daemon keeps its pool).

## [1.2.0] — 2026-07-12 — the Mac gets fast: bulk scans, working fold evidence, field-proven trust recovery

Same-day follow-through on v1.1.0: everything that shipped dark yesterday is
now field-verified and on, plus the macOS performance sprint.

### Improved (measured on the live fleet)
- **macOS scans: per-file stat eliminated (design 107, #241).**
  At that release, the Darwin opt-in preview walked directories with one
  `getattrlistbulk` syscall instead of ~118k `lstat`s — warm full scan
  **5.5s → 3.1s bench, 3.9s pull-scan / 2.0–3.2s safety-scan live**, with
  value-identical attributes (0 parity mismatches across the full corpus)
  and per-directory fallback on any FFI failure.
- **Manifest fold evidence works everywhere (design 84 r2+r3, #234/#238).**
  Same-head pulls fetch ZERO blobs; multi-link pulls fetch only the new
  suffix; chronic git-repo deferral (linked-worktree branches) no longer
  suppresses evidence — receiver manifest reads are **0.4–1.5s fleet-wide**
  (were 4.5s legacy / up to 21s broken-fold), and delta writes work on every
  host. Fold hot path: streaming canonical hash, each manifest verified
  exactly once per walk, memory bounded.
- **Watcher trust recovery field-confirmed (design 104).** The Mac's
  transient FSEvents drops now cycle suspect → re-trusted-behind-unpruned-
  scan instead of pinning full rescans at a 60s floor for the daemon's
  lifetime.
- **Pruned safety scans (design 85 Layer A, #236).** `RBOX_SCAN_PRUNE=1`
  reuses ctime-keyed directory listings (~24% scan cut; readdir share);
  deep scans stay unpruned as the drift backstop; pruned scans can never
  testify for watcher re-trust.

### Fixed
- **GC Phase-1 lifecycle (#235/#237/#239):** mark/purge are now cursored and
  fit D1's subrequest budget (previously: marks accumulated unboundedly —
  230k stale rows — and purge threw mid-page while misreporting success);
  the fence probe is robust to any mark-table size (enforce falls back to
  full validation whenever the probe is skipped — never silently unfenced);
  operator drain tooling gained grace parity with the cron and honest
  failure reporting. Backlog drained: 228,962 stale marks, 35.3GB of
  accounting released.

### Added
- **Machine-readable design-102 soak gate** (#232): `GET /v1/admin/delta-soak`
  (platform secret) exposes divergence/fallback/admission AE aggregates.
- **Cross-host propagation analyzer** (#240):
  `bun scripts/propagation-report.ts <originLog> <receiverLog>` — first fleet
  numbers: publish→apply p50 16.7s over 233 events, zero staleness
  incidents.

## [1.1.0] — 2026-07-12 — manifest deltas, watcher trust recovery, self-draining GC

The performance program's second checkpoint, hours after v1.0.1.

### Added (flag-gated, default off — staged per-host rollout with measurement)
- **Manifest delta encoding (design 84, #231).** The end of the constant
  39–41MB manifest transfer: zstd snapshot envelopes (`RBOX_MDE_SNAPSHOT`,
  measured **24×** smaller), O(change) delta commits (`RBOX_MDE_DELTA` — a
  one-file change ships ~KB), and head-blob-only fast pulls
  (`RBOX_MDE_FAST_PULL`). Chain-verified reads with exact-list matching, a
  pin-as-parent repair transaction (`rbox recover --repair-chain` + doctor
  check), fail-to-snapshot semantics on every delta trigger. Server chain
  acceptance is unconditional and additive — old clients are unaffected.
- **Watcher trust recovery (design 104, #229).** With `RBOX_WATCHER_RETRUST=1`,
  a transient macOS FSEvents overflow no longer permanently distrusts the
  watcher (which pinned full 116k-file rescans to a 60s floor — measured ~11%
  continuous I/O duty on the Mac). Transient drops now enter a suspect state
  that re-earns trust behind an unpruned safety scan, with a drop fuse
  preserving today's behavior under sustained failure.

### Changed
- **Scheduled GC purge enabled (#228).** The founder-supervised drain
  completed (5,410 blobs / 4.29GB reclaimed); the daily fenced cron now
  drains the remaining candidates as they age past the 7-day grace.

### Telemetry
- **Multipart transfer decomposition (design 101 Phase 0, #230)**: per-part
  walls/gaps/completion (client) + additive `serverTimings` with the
  whole-object verification reread isolated (server), plus a read-only
  multipart/staging orphan inventory for the platform operator.
- **First-publish stage decomposition (design 98 §5.1, #226)** emitted on
  both the serialized and pipeline paths with one schema.
- **Design 105 (merged design):** the existing WebSocket notify channel is
  formalized; its reliability fixes (pong deadline, jittered backstop pull,
  session cap) are specified and sequenced for implementation next.

## [1.0.1] — 2026-07-12 — performance program checkpoint: instant preflights, fused crypto, full sync telemetry

The first checkpoint of the sync-performance program (designs 97–103). Two
improvements are live by default or via fleet flags; the rest ship dark
(flag-gated, default off) pending their measurement gates.

### Improved
- **Change-only blob preflight (design 103 Part B, #218).** With
  `RBOX_PREFLIGHT_DELTA=1`, a push checks only the blobs it introduced (plus
  any 422-recovery residue) instead of the whole workspace — measured
  **2.8–4.0s → 0.1s** on a 114k-file workspace. Includes the fix that threads
  the server's unsatisfied-blob list through retry (previously dropped), a
  capped recovery accumulator with a chunked full-audit fallback, and
  `RBOX_PREFLIGHT_FULL=1` to force the full audit.
- **Instant rejection of stale commits (design 103 Part A, #218/#219).** The
  server now 409s an already-stale commit in ~0.1s instead of ~6s of admission
  work, cutting conflict-retry storms (previously 12–42s of added wall).
- **CLI usability fixes (#203).** `rbox restore` is now trash-tier-backed
  (undoable); uninstall warns about the keystore; assorted audit fixes.
- **Torn-scan hardening (#205).** Same-size edits with restored mtimes are
  re-hashed (ctime joins the fingerprint); mid-hash instability defers a file
  instead of publishing a torn read.

### Added (flag-gated, default off — awaiting measurement gates)
- **Fused crypto worker jobs (design 99, #224).** `RBOX_CRYPTO_FUSE=1` batches
  small-file encryption into byte-bounded in-memory jobs under a budget with a
  contention-bounding dispatch cap — **79.7% encrypt-wall reduction** on the
  production path in rig A/B (95% CI [77.2%, 86.5%]), byte-identical
  ciphertext. Fleet first-publish gates pending.
- **Overlapped first-publish pipeline (design 98 Tier 1, #225).**
  `RBOX_PUBLISH_PIPELINE=1` overlaps encrypt → upload → receipt redemption
  with reservation-based disk backpressure, an error-latched receipt drainer,
  and a two-barrier abort protocol. Serialized remains the default until the
  Workload-B gates hold.

### Telemetry (numbers-only; no file names or paths, ever)
- **Server commit decomposition rendered in push lines (#207/#213):**
  `srv/env/acct/ssc/cm/mir/rsp` tokens — this measurement attributed ~87% of
  commit-POST time to D1 ref admission and now feeds the design-102 shadow
  soak.
- **Join/apply decomposition (design 100 Phase 0, #223)** and **first-publish
  stage decomposition (design 98 §5.1, #226)** — gate evidence is emitted by
  the binary, not hand-timed.
- **Scan-site stats, per-dir probe, deep-scan drift audit (design 85 P0,
  #208)**, with `RBOX_METRICS` now **default-on** (opt out: `RBOX_METRICS=0`;
  measured worst-case scan overhead ≤3%).

## [1.0.0] — 2026-07-10 — the correctness milestone

rbox reaches 1.0. The three correctness pillars are now field-proven fleet-wide:
head authority (design 91) makes the commit chain un-forkable, manifest entry
integrity (design 92) makes a push poison-proof and pulls self-healing, and git
config sync (design 93) carries remotes and branch tracking with the repo. No
functional changes over 0.9.18 — this release is the version bump that marks the
milestone.

## [0.9.18] — 2026-07-10 — git config sync (design 93): remotes and tracking travel with the repo

### Added
- **Git config sync (design 93) (#192).** A repo's remotes and branch-tracking
  configuration now sync with its state — clone on a fresh machine and
  `git fetch`/`git push`/`git pull` work without re-adding remotes by hand.
  Config is embedded from a stability-bracketed snapshot at capture and applied
  through a locked, optimistic-CAS config transaction, so a concurrent editor or
  a mid-write power loss can never leave a partial config; the carry-base rule
  means a config that can't be represented is preserved byte-for-byte rather than
  stripped. Credential-bearing remote URLs are skipped (with a loud per-repo
  log). `rbox status` gains a `config:` line. Host-identity resolution degrades
  safely to the legacy path where it can't be established.

### Changed
- **Per-repo git-sync lines collapse into one progress counter (#191).** `rbox
  sync`/`rbox pull` used to print one stderr line per repo during apply — alarming
  at scale and easy to misread as failures. The default now shows a single
  "git sync ran for N/total" counter; real conflicts/warnings still print
  immediately. `--verbose` restores the per-repo dump. `rbox pair` also gains a
  single-keypress `[c]` token copy and corrected setup wording.
- **RboxBar shows total synced size instead of the sequence number (#190).** The
  dropdown's secondary status line now reads a human-readable size (e.g. "15 GB")
  computed from the daemon's in-memory manifest, falling back to "seq N" for
  older daemons in a mixed-version fleet.

### Fixed
- **Design-93 rollout hardening (#193, #194).** Config-sync wire bounds raised
  after field calibration (#193); the fingerprint cache is invalidated when those
  bounds change and invalid incoming config fields are ignored, and the config
  reader degrades rather than failing on unexpected input (#194).

## [0.9.17] — 2026-07-09 — download self-heal + CLI hygiene + calmer menu bar

### Fixed
- **A full join no longer hard-fails on a corrupted blob download (#187).** Under
  sustained high-concurrency load a large-body fetch could reassemble corrupt
  bytes; content-addressing already caught it, but rbox aborted the whole sync
  instead of re-fetching. `getBlobToFile` now bounded-retries on an integrity
  mismatch with backoff (the re-fetch lands as the pool drains into the reliable
  low-concurrency state), via a typed `BlobDownloadIntegrityError` that logs the
  recovery; persistent corruption still fails loudly with no partial file left
  behind.
- **`rbox track` reuses your logged-in identity and forwards the workspace name
  (#186).** Tracking a directory while logged in used to mint a fresh random
  device id (polluting local config and the server roster); resolution order is
  now `--device` > previous config > logged-in credential's device id > mint.

### Changed
- **RboxBar dropdown calmer and files-first (#185).** A degraded state (no user
  action needed) drops the card for a dim one-line status; critical states keep
  the card and carry a per-reason remedy. File count becomes the primary datum,
  the footer shows daemon version and hostname, and a six-hour update check
  renders a dim "Update available" row that copies the install command. Daemon
  status gains additive fields (fileCount, daemonVersion, workspaceRoot) so old
  and new bars interoperate.
- **`RBOX_API` endpoint overrides now warn loudly (#186)**, so a stray override
  can't silently point rbox at the wrong server.

## [0.9.16] — 2026-07-09 — manifest entry integrity (design 92): poison-proof push, self-healing size, fail-closed carry

### Fixed
- **Manifest entries can no longer be poisoned, and pulls self-heal (design 92)
  (#184).** Encrypt verify-defers an entry whose bytes changed mid-capture rather
  than recording a mismatched address; a diff heals a stale entry size instead of
  trusting it; carry is fail-closed (a base entry that can't be verified is
  carried, never silently dropped); and apply verifies a blob before it displaces
  a local file. Field-gated after real zstd-gated poison findings. The
  simplification pass also removed a ~500k-lstat ancestor walk from a 123k-file
  pull.
- **RboxBar finds its resource bundle when installed (#183)**, so the menu bar app
  renders correctly from an installed copy rather than only from the build tree.

## [0.9.15] — 2026-07-09 — self-clearing watcher-degraded status + native menu bar app

### Added
- **Native RboxBar menu bar app (design 88 UI) (#177).** A SwiftUI `MenuBarExtra`
  app (macOS 14+) replaces the SwiftBar shell plugin, reading the same atomic
  daemon status files with no daemon round-trips. It mirrors the prompt-status
  verdict rules exactly (15s staleness, absent/corrupt → dead, graceful paused
  stays paused), reproduces the synced/syncing/attention states theme-aware for
  light and dark, uses a custom R-monogram icon with a state badge, and is
  multi-workspace aware.

### Fixed
- **A transient FSEvents drop no longer pins the status on "attention" until a
  daemon restart (#182).** A dropped-events window is covered by a completed
  full/deep scan, which may now clear the watcher-degraded flag — guarded by an
  error-generation counter (no new watcher error since the scan began) and a live
  watcher (a periodic-scan fallback stays degraded). Found dogfooding RboxBar.

## [0.9.14] — 2026-07-09 — commit-fork recovery (`rbox recover`) + un-regressable head (design 91)

### Added
- **`rbox recover`** — a supported, one-command re-baseline when a workspace's
  local head pin has diverged from the server (reset the pin, re-verify the
  server chain, reconcile local files via keep-both, re-push local diffs).
  Replaces the need to hand-delete a keystore pin file. (The former phrase
  re-enrollment moved to `rbox key recover`.)

### Fixed
- **The commit sequencer can no longer fork under a Durable Object restart
  (design 91).** The workspace head is DO-authoritative and fail-closed: a
  missing head with evidence of prior life serves `repair_required` instead of
  reseeding from the best-effort D1 mirror (the reseed was what let a
  deploy-triggered DO restart re-issue an already-used sequence and fork the
  chain). Server-side same-sequence equivocation is now rejected. The server
  fix deployed with the prior `apps/api` push; this release ships the client
  `rbox recover` companion.

## [0.9.13] — 2026-07-08 — join/populate reliability (design-87 dogfood fixes)

### Fixed
- **Populate pulls can no longer hang silently on a lost blob completion.**
  Request-level settlement tracking in the batch downloader, size-aware total
  deadlines on every blob fetch, and a stream-progress-aware stall watchdog:
  90s of no progress logs the outstanding blobs and retries them (fail-silent
  duplicates — a failing retry never kills a request the primary may still
  deliver); persistent stalls fail loudly with a resume hint. Resume already
  re-fetched exactly the missing blobs.
- **Keyed setup persists credentials** (mode 600), so `--daemon` joins survive
  the invoking shell and reboots; `rbox key materialize` remains env-only.
- **`rbox status` and the prompt are honest during an initial populate**:
  a versioned populate marker renders "initial sync in progress — N/M files"
  instead of claiming 120k phantom local changes with sync not running.

New env knobs (documented in docs/development.md):
`RBOX_PULL_JOIN_WATCHDOG_MS`, `RBOX_PULL_JOIN_WATCHDOG_MAX_FIRINGS`,
`RBOX_NET_BLOB_MIN_TIMEOUT_MS`, `RBOX_NET_BLOB_MAX_TIMEOUT_MS`.

## [0.9.12] — 2026-07-08 — ambient sync status (design 88)

### Added
- **Ambient sync status (design 88).** The daemon maintains an atomic
  `daemon.status.json` beside its pidfile (5s heartbeat, ownership-gated,
  early-paused on graceful stop); `rbox prompt-status [--json]` reads it with
  staleness-as-death semantics (a killed daemon shows `! dead` within 15s);
  the zsh prompt's staleness window tightens 180s → 15s on the new heartbeat;
  `contrib/swiftbar/rbox.5s.sh` ships the macOS menu bar MVP with a
  Status / File / Progress dropdown, pause/resume, and log tail.

## [0.9.11] — 2026-07-08 — git-plan at O(change) (fingerprint cache) + phase-0 instrumentation

### Fixed
- **git-plan no longer spawns ~13 git subprocesses per unchanged repo
  (design 83).** `planGitSections` consumes the `git-divergence.json`
  stat-fingerprint cache via a shared publish-grade v4 fingerprint
  (content-hashed HEAD/refs/small-index, ctime, 2s racy-clean margin,
  per-decision memoization) with a base-carry-only fast path and a
  baseless-worktree-pointer pre-skip. Measured on the real workspace:
  git-plan 24–43s → 4.0s (Mac) / 0.9s (wired Linux); daemon no-op tick
  25–63s → 4.5–4.8s (Mac) / 1.5s (Linux); no-op CLI push 41s → 10.2s.
  Cache file v2 → v3 (old caches self-heal with one cold plan).
- **Git identity probes are side-effect-free.** `git write-tree` rewrites
  the index file on every invocation; probes now run it against a temp
  index copy (`GIT_INDEX_FILE`), so rbox's plan/status probes no longer
  churn index files in tracked repos.

### Added
- **Commit/latest/scan sub-step instrumentation (designs 84/85 phase-0).**
  `RBOX_METRICS=1` phase lines now decompose commit
  (refresh/sidecar/encode/encrypt/upload/post + encBytes), latest
  (download/decrypt/parse), scan (readdir/stat/matcher/hash/sort + walked/
  statted/hashed/cache-hit counts, cumulative across 409-retry rescans),
  and git-plan (fpHits/fpMisses/fpUntrusted/pointerPreSkips/spawnedRepos).

## [0.9.10] — 2026-07-08 — steady-state sync at O(change) (encrypt-cache reverse path index)

### Fixed
- **Steady-state pushes no longer pay an O(files × cache-entries) scan
  (design 82).** The encrypt-address cache migrated every unchanged file's
  path with a full-cache scan — ~5.5 billion entry visits per push on a
  116k-file workspace with a 47k-entry cache, 481s of a 700s push, invisible
  to phase timers. Path migration is now O(1) via a reverse path index (same
  on-disk format; legacy duplicate paths self-heal on load). Measured on the
  real workspace: Mac push with a 1-file change 204s → 54s, Linux 60s → 29s,
  no-op sync 43s, daemon publish cycle ~3.5 min → 25–63s.

### Added
- **Phase coverage for the formerly-invisible sync zone (design 82 §4).**
  New `state-load`, `git-plan`, `address` (with cache hit/miss detail), and
  `missing` phases in `RBOX_METRICS=1` reports — phase walls now account for
  96–98.7% of push wall (was ~10–14%), so a regression like this can't hide
  again. Disabled reports are now a shared allocation-free singleton, so the
  no-op daemon tick stays free.

## [0.9.9] — 2026-07-08 — worker-pool crypto (real cores for blob encrypt/decrypt)

### Added
- **Worker-pool crypto (design 81).** Blob encrypt and decrypt now run on a
  pool of Bun workers (default `min(cores−2, 16)`, memory- and fd-aware;
  `RBOX_CRYPTO_WORKERS` overrides, `0` disables). The pool is lazy — small
  syncs below 8 crypto jobs stay inline — keyed to the workspace key epoch,
  and idles out after 60s. Ciphertext output is byte-identical to the inline
  path. If workers can't start (e.g. a broken binary), rbox falls back to
  inline crypto and `rbox doctor`/`rbox status` surface the degradation.
  Measured on a 32-core Linux host (105k-file first publish): wall
  27.5 min → 10 min, encrypt phase 5.5x, join decrypt lane 10% → 1%,
  zero small-push regression, full-corpus byte diff clean.

## [0.9.8] — 2026-07-08 — batch slot defaults from the capstone curves

### Changed
- **Batch transport slot defaults raised: downloads 16→48, uploads 8→24.**
  Cloudflare Workers cap parallel subrequests per invocation (~6), so a
  32-record batch settles in ~1s regardless of size — concurrent batch
  requests are the linear throughput lever. Measured on the v0.9.7 capstone:
  publish 83s→39s (8→24 put slots, A/B corpus, WiFi); full-corpus wired join
  128s→84s (16→48 get slots; 64 is flat — the knee is 48). `RBOX_BATCH_SLOTS`
  / `RBOX_BATCH_PUT_SLOTS` still override.

### Fixed
- Push lane timing no longer double-counts batched blobs
  (`ownsUploadLaneTiming` is now forwarded through the E2EE remote wrapper,
  and ownership is exclusive).

## [0.9.7] — 2026-07-08 — compress-before-encrypt + batched uploads

### Added
- **Compress-before-encrypt (design 79), default ON.** Blob payloads are
  zstd-level-3 compressed before AES-GCM when it pays (≥128 bytes and >5%
  smaller; media/archives stay raw automatically) — measured 2.17x
  byte-weighted across a real 6 GiB workspace, 4.9x on source-heavy corpora.
  Key/nonce derive from the sha of the exact encrypted bytes (`payloadSha`),
  so raw blobs stay bit-identical to 0.9.6 and nonce reuse is impossible by
  construction. Compressed manifests stamp `manifestSchema: 4`; older clients
  refuse them with one loud "upgrade rbox" error (validation now runs at the
  manifest decode boundary, covering pull, versions, and restore alike).
  Decompression is capped at each entry's declared size. Opt-out:
  `RBOX_COMPRESS=0` (new encryptions only). **Upgrade all machines in a
  workspace (and restart daemons) before the first push from this version.**
- **Batched blob uploads (design 80).** Small ciphertexts ride
  `POST /v1/blob-batch/put` — up to 32 per request, receipts-only, parallel
  R2 server-side with per-record results, receipts preserved via
  `Promise.allSettled`. The client coalescer mirrors the download side
  (same-sha waiter coalescing, pull-first dispatch with a 10ms tail flush,
  single-PUT fallback on old servers / per-record failures); the upload pool
  scales to 512 when batching. Kills the measured ~125 blobs/s per-request
  upload floor. Kill switch: `RBOX_BATCH_BLOBS=0`.

### Performance
- The design-79 A/B that motivated both features (17.5k files / 570 MB,
  WiFi): compression cut wire bytes 79% while walls stayed flat — proving
  small-blob transfer is request-bound, not byte-bound. Batching removes the
  request floor; compression then cuts the remaining bytes. Combined
  measurements land in the design docs after the release capstone.

## [0.9.6] — 2026-07-07 — batched downloads + parallel git materialization

### Added
- **Batched blob downloads (design 77 P1).** Small encrypted blobs now ride
  `POST /v1/blob-batch/get` — up to 32 per request under the §27 download
  grant (one verification, zero D1 on the happy path), streamed back as
  binary frames in completion order. The client coalescer fills batches
  pull-based from a supply-scaled download pool; large blobs keep the
  streaming single GET. A fresh join now issues ~3k requests where it issued
  ~93k. Kill switch: `RBOX_BATCH_BLOBS=0`.
- **Parallel git materialization.** Pull-side git apply runs repos through a
  bounded pool (`RBOX_GIT_APPLY_CONCURRENCY`, default 6) over nesting-safe
  chains, with per-store locking for worktrees sharing a common git dir.
  Measured: the ~98-repo git phase of a fresh join dropped from ~85s serial
  to ~34s.
- **Push-side lane timing.** `RBOX_LANE_TIMING=1` now attributes push wall
  time to encrypt vs upload, mirroring the pull instrument.

### Performance
- Fresh join of a 96k-file / 4.9 GiB workspace, measured end to end on the
  same hardware: **118s**, vs ~200s before this release and ~30 minutes two
  days ago. Server-side (already live for all clients): grant-authenticated
  blob reads skip the per-request D1 queue entirely (§27 Amendment A).


## [0.9.5] — 2026-07-07 — index resolve-undo fix

### Fixed
- **Repos with old merge-conflict residue no longer defer forever on
  receivers.** An index resolve-undo extension pointing at unreachable
  conflict blobs failed every receiver's post-apply fsck. Snapshots now
  strip it at capture, and apply clears it before fsck (existing stuck
  sections heal without a re-capture).

## [0.9.4] — 2026-07-07 — the performance sprint

### Added
- **Incremental git sync (design 53).** Repos with a synced base ship
  history increments instead of full bundles — measured 0.024% of the
  full-bundle bytes per change. Default on; `git.incremental: false`
  opts a workspace out. The first chained capture moves the workspace to
  manifest schema 3 (older clients must upgrade — clean break).
- **Instant status (design 69 §3.4).** With a live, settled daemon,
  `rbox status` answers from the daemon's published counts in ~50ms
  (was ~8s on a 130k-file tree) — and falls back to the full scan on any
  trust-predicate miss, never to wrong output.
- **Live byte progress (design 73).** Transfers render dual fractions
  (`uploading 126,352/126,369 · 4.1/6.3 GiB`); git capture shows
  cumulative bytes sent. Multi-GB uploads no longer look like hangs.
- **Pull instrumentation + faster fresh joins (design 74 Phase 0).**
  The pull's git-apply tail is now measured per repo, and download
  concurrency defaults to 128 (recorded sweep: ~25% faster on big
  materializations).
- **First-publish encrypt cache (design 75).** Retrying a large first
  publish re-encrypts only what the server is actually missing, instead
  of the entire workspace.
- **No more silent network wedges.** Small control requests carry a 60s
  deadline with the established retry rules, and the daemon heartbeat
  advances on a timer, so a hung operation reads as visible staleness.

### Changed
- Hourly server maintenance moved off the top of the hour (was
  correlating with transient commit 500s).

## [0.9.3] — 2026-07-07 — daemon hotfix

### Fixed
- **v0.9.2 daemons stopped pushing minutes after start** ("E2EE required:
  refusing to sync without an encryption key"): the new workspace-config
  reload rebuilt the daemon's config from workspace.json, dropping the
  runtime-attached encryption key material and credential remote override.
  The reload now moves only the hot-reloadable setting. If you installed
  0.9.2, upgrade and restart the daemon (`rbox upgrade && rbox stop && rbox
  start`).

## [0.9.2] — 2026-07-06 — refs at scale: big workspaces can publish

### Added
- **Receipt redemption (design 71).** Upload receipts are redeemed in batches
  *before* the commit, so the commit request stays tiny regardless of
  workspace size. Previously a cold first publish of a very large workspace
  (~123k files) sent a ~45 MiB receipts map into an 8 MiB request cap and
  could never publish.
- **Per-commit ref cap raised 50k → 250k**, enforced against the full
  accounted set (data refs + carriers) and backed by budget tests derived
  from the platform math. A workspace over the cap now gets an actionable
  error and an honest red "sync blocked" status (no false "will be retried")
  instead of a silent retry loop.
- **Bare `rbox` inside a workspace** shows the status block plus a small
  action picker (Sync now / View logs / Pause) instead of the setup wizard;
  the status header now includes the installed version.
- **Local dev builds**: `bun run dev:install` compiles a `rbox-dev` binary
  (`<version>-dev+<sha>`) for release-free on-machine testing
  (docs/dev-loop.md).

### Fixed
- **0.9.1 shipped without its own headline status-honesty changes** — a
  stale-base squash silently reverted them post-merge. Restored: amber
  "will be retried" for transient failures, live first-publish progress in
  the git-sync line, fresh-active precedence in the prompt glyph.
- **A file vanishing mid-push no longer aborts the whole push** (constant on
  live trees with agents/builds churning); it defers like any churning file
  and the stable subset commits.
- **Git capture failures name their real reason** (repo-context / HEAD
  probes) instead of the generic "capture returned nothing".
- Recovery from very large missing-blob sets pages through honestly
  (bounded 422 responses carry the total; progress refunds the retry
  budget).

## [0.9.1] — 2026-07-06 — status honesty + capture fixes

### Changed
- **`rbox status` never lies about liveness.** A fresh active cycle leads with
  its live percentage; a standing failure renders in amber beneath it as
  "last attempt failed … — will be retried"; "sync halted" (red) is gone —
  a live daemon always retries. "git-sync: 0 repos synced" during a first
  publish now reports capture progress instead of implying idleness.

### Fixed
- **Case-drifted symbolic HEAD no longer permanently defers a repo's git
  capture** (macOS case-insensitive checkouts: HEAD casing vs packed-refs
  casing). Capture normalizes to the ref store's casing; self-validation
  failures now report the real reason instead of "capture returned nothing."


## [0.9.0] — 2026-07-06 — worktree git-sync, live progress, network resilience, fast status

Born from a founder stress test: a first push over a 140-repo, 131k-file
workspace, run as a real customer would.

### Added
- **Git-state sync for main clones with linked worktrees (design 68).**
  Primary repos using `git worktree` (agent workflows, Conductor) now capture
  index/HEAD/stash via `--single-worktree --all`; applies defer whole-section
  when a ref collides with a branch checked out in a sibling worktree; in-tree
  scratch worktrees no longer re-upload the shared history once per worktree.
- **Live progress for the long sync phases.** First pushes show
  `scanning… N files` and `capturing git state 3/140 — <repo>`; the daemon
  feeds the same progress to `rbox status` and the zsh prompt glyph.
- **Network resilience on the sync path.** Transient socket faults retry with
  bounded backoff (commit POSTs proven idempotent via the server's sequence
  CAS); stalled transfers time out (no-progress watchdog on downloads,
  size-scaled caps on uploads); network errors now say what dropped and that
  re-running is safe — raw runtime errors never reach the terminal.
- **Resumable, hardened git-capture uploads.** Capture stages under the
  workspace's `.rbox/` (immune to tmp reapers), sha-mismatch faults re-encrypt
  and retry like file blobs, GB-scale bundle uploads resume across attempts,
  and stale staging sweeps are pid-aware (a live capture is never swept).

### Changed
- **`rbox status` is ~11× faster on repo-heavy trees (design 69).** 90s → ~8s
  warm on the stress-test workspace: status finally uses the on-disk hash
  cache, discovers repos during the one scan walk, pools the git probes, and
  skips unchanged repos entirely via a stat-only gitdir fingerprint cache
  (zero git subprocesses for a quiet repo).
- **Onboarding prompts tightened.** Workspace naming is one prompt (ENTER
  accepts the suggestion, `-` skips); background-sync + autostart is one
  three-way select; first-push spinners explain the scan phase.

### Fixed
- A transient network fault no longer discards an entire initial push.
- The 6GB-bundle capture failure mode (ciphertext truncated in `os.tmpdir()`
  during long multipart uploads) is closed.

## [0.8.0] — 2026-07-04 — launch-readiness batch (designs 60-67)

### Added
- **Self-serve genesis (design 60).** Cold accounts created via web signup or
  device-code `rbox login` mint their first encryption keys with
  `rbox key genesis`; `rbox setup` runs it inline on the first machine.
- **Daemon autostart (design 61).** `rbox autostart enable|disable|status`
  registers a per-user login agent that restarts background sync after reboot or
  re-login.
- **`rbox usage` + quota UX (design 62).** A dedicated command for plan limits vs
  current usage; typed `402 quota_exceeded` errors name the cap and next step.
- **Data export (design 65).** `rbox export` decrypts every workspace under your
  keys and writes a directory or `.tar.gz`.

### Changed
- **Team checkout disabled (design 63).** Team is listed but not purchasable
  across the CLI, web, and pricing surfaces;
  the server rejects Team checkout intent before any Stripe call.

### Security
- **Abuse hardening (design 64).** Rate limits on the anonymous edge
  (device-code start/poll, release, link/pair) plus a per-account durable-device
  cap.

## [0.7.1] — status probe elision
- `rbox status` elides the remote-head probe when the local daemon is live and
  attributable to the current workspace (design 59); JSON status fetches account
  usage separately.

## [0.7.0] — doctor, diagnostics, recovery kit
- `rbox doctor` + opt-in plaintext support-report upload (design 56).
- Recovery kit: `--kit` / `--kit-path` write the 24-word phrase to a `0600` file,
  tracked by `rbox key status` (design 58).
- Setup picker UX polish; dev-gated bootstrap `--plan`.

## [0.6.8] — destructive-apply safety
- Local trash tier (`rbox trash list|restore|empty`), type-flip healing, and a
  push-side mass-delete guard (design 50).

## [0.6.7] — rbox.yml revival + usage guide
- Scoped `rbox.yml` design revival and the narrative usage guide; the `deps` CLI
  group disabled/commented out (design 51).

## [0.6.6] — daemon IO priority
- Daemon disk-IO priority + idle safety-scan backoff (design 49).

## [0.6.5] — browser-optional login
- Browser-optional device-code login (design 47).

## [0.6.4] — zsh integration
- zsh shell integration: ambient sync status in the prompt + completions
  (design 46).

## [0.6.3] — status health
- Status health verdict, daemon activity sidecar, and live transfer percentages
  (design 45).

## [0.6.2] — rebind safety
- Rebind safety: stream-ownership stamp + mass-delete guard, closing the
  design-44 mass-delete incident.

## [0.6.1] — maintainability pass
- Behavior-preserving module splits across the engine, CLI, and API (antislop
  refactor pass).

## [0.6.0] — 2026-07-01 — nested-repo git sync
- Nested-repo git sync: per-repo GitSections, worktree materialization, all E2EE
  (design 43).

## [0.5.7] — 2026-07-01 — daemon rebind self-heal + dashboard rebuild
- Stale-daemon rebind detection, forensic sync logs, and ignoring `.git` pointer
  files (#42); setup sends the prompted workspace name on the create path (#40).
- Batched the blob-check push preflight D1 reads (serial → `db.batch`) (#39);
  customer dashboard rebuilt on Tailwind v4 + shadcn-svelte (#41).

## [0.5.6] — 2026-07-01 — bulletproof live-folder sync
- Snapshot-first encryption, safe against concurrent writes (#37); churning files
  now defer instead of aborting the whole push (#38).

## [0.5.5] — 2026-07-01 — setup names + live-folder resilience
- `rbox setup` prompts for a workspace name (#35); push self-heals a live-folder
  TOCTOU (`sha_mismatch`) (#36).

## [0.5.4] — 2026-07-01 — interactive CLI revamp
- `@inquirer` interactive surfaces + pick-workspace-by-name (#34).

## [0.5.3] — 2026-07-01 — download grants (design 27 client)
- The client presents signed download grants on blob GET, taking D1 off the
  blob-GET hot path (#32).

## [0.5.2] — 2026-07-01 — workspace names + track picker
- Opt-in, server-visible workspace names in status, plus a pick-from-list for
  track-existing (#31, #33); admin cockpit gains the Analytics-Engine SQL read
  path (§25 Plane A) (#30).

## [0.5.1] — 2026-07-01 — verify every upload path
- Manifest signature is now verified on every upload path (#26).

## [0.5.0] — 2026-07-01 — watcher scale + global daemon logs
- `@parcel/watcher` backend: RSS 11 GB → 60 MB and no more dropped events
  (§41) (#24). Daemon logs/pid move under `~/.rbox` (#21), and `rbox status`
  shows account/plan/link status (#19). arm-Mac + Linux only.

## [0.4.3] — 2026-07-01 — installer PATH + phase metrics
- Installer persists PATH; the daemon no longer spawns from the compiled-binary
  help menu (#16). Coarse client phase metrics (§35) (#17).

## [0.4.2] — 2026-06-30 — native log tail + observability
- `rbox logs` becomes a real native daemon log tail (#14). Self-serve account +
  data deletion (GDPR/CCPA, design 37) (#12); §32 observability — Slackpipes
  pings, Tail Worker, admin cockpit (#13); §33 per-account entitlement GC.

## [0.4.1] — 2026-06-30 — multi-device fix + security email
- Fixed the §31 admission-grant `notAfter` that bricked multi-device accounts
  (P0). New-device security emails via Cloudflare Email Service (#10, #11); §30
  large-ref commit accounting lifts the 6002-ref cap.

## [0.4.0] — 2026-06-30 — version history + CLI redesign + device dashboard
- CLI redesign: `rbox start`/`setup`, `track`/`untrack`, a `deps` group, `--help`,
  and dependency-drift notifications (#9). Device-management dashboard (§22) (#5).

## [0.3.2] — 2026-06-30 — CLI redesign groundwork
- `rbox --help`/`-h` exit 0; the §29 CLI command redesign was finalized.

## [0.3.1] — 2026-06-30 — version history under E2EE
- Version history + restore under E2EE (design 12 §15); a device-management
  dashboard (devices route + revoke + unlink); the CLI defaults to the prod API
  (`api.rbox.to`); `rbox versions .` lists the whole workspace.

## [0.3.0] — 2026-06-30 — git-sync under E2EE
- §28 git-sync under E2EE — git artifacts encrypted, default on. §24 blobRef
  sidecar makes the signed commit body O(1); upload/download concurrency raised
  to 64.

## [0.2.0] — 2026-06-30 — upload receipts (~6× faster sync)
- §23 upload-receipts (direct-write) cut sync time ~6×. Account linking
  (design 21): `rbox account link/status/unlink` plus a dashboard "Link your CLI
  account" flow; §25 server observability streams per-op R2/D1/DO timing to
  Analytics Engine.

## [0.1.2] — 2026-06-29 — concurrency knee
- Default upload/download concurrency 16 → 32 (measured knee) + a bench harness.

## [0.1.1] — 2026-06-29 — sync perf + empty-file fix
- Concurrent blob upload/encrypt and download with push/pull progress; empty-file
  round-trip fixed; concurrent-push bugs found dogfooding a real repo. Dashboard
  redesign (#1).

## [0.1.0] — 2026-06-29 — first release: sync engine, control plane, CLI
- Initial rbox: a continuous daemon (watcher + live push), a streaming /
  multipart / resumable blob path, opt-in git-state sync, convergent E2EE blob
  encryption, version history + restore, reachability GC + retention, multi-tenant
  isolation, self-hosted device-token auth + machine pairing, plan/quota
  enforcement, Stripe billing (checkout/portal/webhook), and a Clerk-authenticated
  web dashboard.
