# Papercuts

Running log of small things that broke, surprised, or slowed down agent
sessions. Founder-requested (2026-07-18): proactively appended by agents as
they work; signal for what to fix. Newest first. Keep entries to 2–4 lines:
what happened, what it cost, fix hint if obvious.

## 2026-07-20

- **Shallow-clone peer state (`M a.txt`… files but no HEAD) reads as
  corruption — but it's an intended guard.** A `git clone --depth 1` in the
  workspace lands its files on the peer via the file plane while git-sync
  *deliberately* defers the section (`preflight.ts`, design 43 §14 v6.1): a
  shallow repo's `git bundle --all` silently omits history, so rbox
  fail-closes rather than shipping a corrupt bundle. Correct behavior, NOT a
  bug. Residual is UX only: the peer looks file-complete with no `git log`,
  which surprises a user. Small polish: a source-side "shallow clone won't
  sync history until `--unshallow`" notice. Surfaced by the design-172 rig
  burst round (which correctly re-inits non-shallow to exercise git-sync).

## 2026-07-19 (day/evening batch)

- **Mid-run review artifacts caused a false ALIGNED merge.** A long codex
  review wrote its verdict file mid-run (draft said ALIGNED), the completion
  sentinel fired on file-existence, and the design merged mislabeled — the
  process's FINAL output was CHANGES-REQUIRED. Cost: a correction PR + a
  wrong report to the founder. Rules now: sentinels require process-exit AND
  artifact; review prompts say "write the file ONCE, at the end"; verify the
  log tail against the artifact before acting on any long run.
- **Deleting a merged stacked-PR base branch CLOSES the child PR** instead
  of retargeting (GitHub). Cost: PR #355 recreated as #356. Merge or
  retarget children first.
- **Rebuilding a branch by file-copy dragged a stale package.json version**
  over main's, tripping the release-consistency test (caught by CI). File
  lists lie about content vintage; re-take contested files from main.
- **When the same flake survives two structural CI fixes, stop tuning CI
  and hunt a deadlock** — the two-day "runner starvation" was a real FIFO
  deadlock (keep-pins, fixed #357) whose zombie handles starved subsequent
  tests because Bun never cancels timed-out async tests.
- **bun test with a nonexistent path filter exits 0 silently** (zero files
  matched) — combined with sandbox cwd resets, this manufactured a phantom
  hang investigation. Print pwd or use absolute paths in automated test
  invocations.
## 2026-07-19 (overnight)

- **RESOLVED same night (#pending): `scripts/ux/tui.test.ts` required an
  installed `rbox`** — its dead-pane test spawned the real binary, failing
  with status 127 on any host without one (bit codex's sandbox AND the
  fleet-wiped desktop in one evening). The child's identity was irrelevant;
  it now spawns a PATH-independent shell child printing the same output.
- **`scripts/guards.ts` hardcodes shard-count 6** while ci.yml's test matrix
  defines it — if the shard count ever changes, the local guard drifts from
  CI. Hint: single source (read the matrix value or a shared constant).
- **RESOLVED (#339): CI guard scripts have no local runner.** The "only prompt.ts imports
  @inquirer" guard (ci.yml checks job) caught PR #336 — correctly — but only
  AFTER push: the guards are inline workflow shell, so neither codex's
  conformance reviews nor local gates can run them. Cost: one red CI round.
  Hint: extract guards to `scripts/guards.ts` invoked by both CI and a local
  `bun run guards` (and mention it in AGENTS.md gates).

- **Silent no-op `str.replace` design-doc edits cost two review rounds.**
  Folding review findings via python `str.replace` with a slightly-off
  target string no-ops silently; the stale text then contradicts the new
  text and the next adversarial round attacks the ghost (design 159 r6+r7
  were both this). Fix pattern: whole-section replacement by heading
  boundaries + grep-verify the old phrasing is GONE before committing.
- **`gh pr merge` from inside a worktree can commit to the wrong context.**
  Committed a main-checkout design doc while cwd was still a worktree —
  the add/commit silently targeted the worktree branch ("nothing to
  commit"). Always `cd` to the primary checkout (or pass `git -C`) for
  main-branch doc commits.

## 2026-07-18

- **RESOLVED (#334): `scripts/release.ts` crash leaves `src/cli/version.ts` mangled.** The
  script rewrites version.ts during compile and restores it on success; the
  signing-key throw (no RBOX_RELEASE_PRIVATE_KEY) exits before restoration,
  leaving a truncated file silently dirty in the checkout. Found an hour later
  via git status. Hint: restore in a `finally`.
- **RESOLVED (#334): `scripts/release.ts` has no dev-build path.** Compiling unreleased binaries
  for fleet validation required passing the LAST released version (changelog
  gate rejects anything else) and accepting a signing-key error after compile.
  Cost: two failed invocations + binaries whose `--version` lies (say 1.7.3,
  are main-tip). Hint: a `--dev` flag that skips the changelog gate + signing
  and stamps `<ver>+<sha>`.
- **RESOLVED (#334): apps/api tests fail confusingly under plain `bun test`.** They need the
  vitest/miniflare harness (`bun run test:api`); under bun they part-run and
  produce real-looking assertion failures (serverTimings mismatch) plus
  `Cannot find package 'cloudflare:test'`. Cost: one false "3 fail" scare.
  Hint: a guard in those files that exits with "wrong harness — run
  bun run test:api".
- **Cloudflare Pages preview check goes red on stale-base PRs.** A branch cut
  before the npm-10 lockfile regen fails `npm ci` in the Pages preview build —
  a misleading red X on test-only API PRs (blocked one merge until the branch
  was updated). Hint: exclude preview builds for PRs not touching apps/web, or
  keep branches fresh before merge.
- **GitHub runner-queue starvation reads as a hung test.** A test shard showed
  `in_progress` for 40+ minutes; actual execution was 61s (startedAt vs
  completedAt). Cost: one unnecessary run-cancel + rerun hunt for a hang.
  Hint: always compare job startedAt/completedAt before diagnosing.
- **`gh run rerun --failed` refuses after a cancel/finish race** ("cannot be
  retried") when the run concluded success right as the cancel landed.
  Harmless but confusing; verify run conclusion before rerunning.
- **RESOLVED (#334): regress.ts mutates `scripts/rig/runs/.image-hash` in the checkout it runs
  from.** A later `git pull --ff-only` in the primary checkout failed on the
  dirty file. Hint: write it under scratch/gitignore it.
- **Session background tasks get externally killed mid-run** (four times today:
  gate runs, codex wrappers). Anything killed took its whole process tree —
  including live codex children — until dispatches moved to `setsid` +
  sentinel files + persistent Monitors. Cost: ~40 min of repeated codex work.
  Root cause unknown (harness-side); the detach pattern is the workaround.
- **codex sandbox cannot run the Docker regress gate** (`/var/run/docker.sock`
  denied), so every CLI-touching dispatch ends "gates not green" and the gate
  must be rerun locally via `sg docker`. Known, recurring; budget for it.
- **codex defaults into the repo's AGENTS.md dev-cycle for small fixes** —
  dispatched for a bounded test sweep, it started writing
  `docs/design/158-…` + review rounds instead of fixing tests. Hint: small-fix
  dispatch prompts need an explicit "no design docs; implement from SPEC.md".
- **RESOLVED 2026-07-19 (founder ruleset): No branch protection ⇒ no GitHub auto-merge.** Every merge-on-green needs
  a hand-rolled watcher loop. Hint: a minimal required-check ruleset on main
  would unlock native auto-merge.
- **`pgrep -f "codex exec"` matches the watcher's own command line** when the
  watcher polls for codex — self-keeping-alive loop. Use pid files or
  sentinel files instead of process-name grep.
- **rbox's own quarantine stash can wedge git-plane publish** (2026-07-21,
  savvy-core): a `git stash create` minted by rbox on 2026-07-16 later
  surfaced as "stash reflog contains receiver-only work; incoming checkout
  ref could not be published safely" — rbox refusing to publish because of an
  artifact rbox itself created. Design 174's supersession handles the
  follow-on livelock; the stash-authorship blind spot (own-stash vs
  user-stash) deserves its own look.
- **`refs/rbox-conflict/*` accumulates unbounded** — savvy-core reached 810
  conflict refs (July 6-13 episodes), inflating every ref transaction (~8.5s
  observed), fingerprint, and capture forever. Retention lands in design 174
  (supersession + 90d floor + status count).
- **A repo can burn 30s/pull for 10+ hours with ZERO remote telemetry
  signal** — the savvy-core held-repo loop (123 re-follows/day) was found
  only by SSH log forensics; no wire kind carries phase timings. Fixed by
  design 174 C2 (`sync_phase`), but the meta-lesson stands: any new
  retry/deferral loop needs a fleet-visible counter from day one.

## 2026-07-21 (night — keep-mine heal round 2)

- **`rbox push` while the daemon is mid-cycle hard-fails** ("daemon/CLI is
  syncing; retry, or run `rbox stop` first") instead of queueing or waiting
  briefly. Every scripted heal tonight had to wrap pushes in stop/start
  choreography; a plain `--wait` (or default short lock-wait) would have
  removed a whole class of operator error.
- **The keep-mine preview buries its confirm command.** ~19KB of per-tag
  "nothing would be lost — incoming value is retained" lines (one per
  pegasus deploy tag, hundreds) scroll between the summary and the final
  confirm line. Collapse subsumed lanes into one count line
  ("1,412 tags/branches retained — nothing lost") and show only the
  would-be-discarded and unprovable lanes in full.

- 2026-07-22 (v1.7.21 rollout): `rbox upgrade` after an installer binary swap
  says "already up to date (1.7.21)" and leaves the RUNNING daemon on the old
  version — the skew warning then tells the user to restart manually. If the
  binary is current but a live daemon reports an older daemonVersion, upgrade
  should offer/do the restart itself.
- 2026-07-22: a pull-only daemon's status says "1 change waiting to upload"
  with no hint that pull-only will never upload it. Copy should say
  "1 local change held (pull-only)".
- 2026-07-22 (t2 field check): a stale `git busy` lane on a repo whose
  DIRECTORY is gone (savvy-core-pr8, deleted worktree) is retained forever by
  the hygiene reconciler's fail-closed rule (context resolution fails →
  indeterminate). Correct per contract, but the pr8 ghost the incident exposed
  still can't die. Needs a ruled mechanism: e.g. absent-from-discovery + N
  consecutive gone-directory observations clears busy-class lanes (178 t3
  candidate).

- 2026-07-22 (v1.7.22 rollout): the desktop's real `~/.rbox/daemons` held 36
  dead `rbox-daemon-activity-*` dirs — test-suite litter (some daemon-activity
  test path runs against the real RBOX_HOME instead of a temp dir). One had an
  unreadable pid record, making `rbox upgrade` exit non-zero on an otherwise
  clean host. Two fixes wanted: find + fix the test writing to real RBOX_HOME;
  and the restart pass should treat a DEAD-pid daemon dir with an unreadable
  record as ignorable debris, not a restart failure.

- FIXED 2026-07-22 (PR #401, deployed to the founder's /Applications same day):
  deferrals no longer escalate the bar's headline tier — pill/badge track sync
  activity; "Degraded" reserved for watcher-degraded, red for critical.
  Original report follows; the 178-t3 ghost-row bonus below is still open.
- 2026-07-22 (founder, from Mac menu bar): the bar shows "Degraded" (orange)
  because 2 git repos are deferred even while sync is actively healthy —
  needless user concern. Proposed precedence for the bar's headline state:
  active transfers → "Syncing"; deferrals alone (esp. under the transient
  quiet window) → secondary line only; "Degraded" reserved for halt /
  out-of-storage / watcher-degraded. Fix spans the ambient projection's
  exported state (this repo) + the bar app's mapping (external). Bonus: both
  rows in the founder's screenshot were stale-or-ghost (pre-resolve
  savvy-core + the pr8 gone-directory ghost) — t3's ghost fix shrinks this
  panel too.

- 2026-07-23 (v1.7.26 fleet upgrade): the rbox-daemon-activity-* test-litter
  papercut has now spread to the MAC — 32 dead dirs in ~/.rbox/daemons made
  `rbox upgrade` exit non-zero despite a fully successful upgrade (0 live
  pids, verified). Third host bitten. Bump priority on the fix: tests must
  not write to the real RBOX_HOME, and dead-pid unreadable records should be
  treated as debris, not upgrade failures.

- 2026-07-23 (410 TUI gates): the ubuntu-24.04-arm GH runner reports the
  compiled binary's Ctrl-C death as pane status 0 even with a proven-live
  input pipeline; x64/darwin/local all give 130. Cancel smoke is advisory on
  that runner only (ci.yml cancel-advisory + release.yml warning). Root cause
  unidentified — candidate follow-up: real terminal-emulator harness.

- 2026-07-23 (189 field-test, founder-hit): first-machine enrollment trap.
  Running `rbox login` on a FRESH account authorizes the device (device-auth)
  but does NOT do genesis, leaving it "authorized but not enrolled." Re-running
  `rbox setup` in that state offers ONLY join options (paste pairing token /
  recover with phrase / do later) — NO "create encryption" (genesis) option,
  because the authorized-but-unenrolled resume path assumes some other machine
  already created the account encryption. On a truly fresh account (no genesis
  anywhere) that's a dead end: nothing to join, no way to create. Founder: "this
  is easy to mess up." Escape hatch is the non-obvious `rbox key genesis --yes`.
  FIX: the authorized-but-unenrolled setup menu must offer genesis when the
  account has NO encryption (server observation = no key state) — i.e. detect
  "first machine, account unencrypted" and present "Set up encryption on this
  machine" alongside the join options. Also consider: `rbox login` on a fresh
  account should either complete genesis inline or clearly tell the user to run
  `rbox key genesis`. This is design-180/187 enrollment territory, surfaced by
  the 189 two-machine test.

- 2026-07-23 (189 live two-machine test, founder-hit): the web `/cli-login`
  approve page offers "Approve and send this machine your encryption keys"
  whenever the URL carries a `#fp` fragment (`sendsKeys = binding.kind ===
  'present'`, +page.svelte:26) — WITHOUT checking the account actually has
  encryption + a live admin to fulfill. For a FIRST device (fresh account, no
  genesis) `rbox login` still emits a `#fp`, so the page shows the key-consent
  button, the user clicks it, and the server rejects with "Encryption isn't set
  up for this account yet" from `/v1/auth/device/approve`. Workaround during the
  test was to hand-strip `#fp` from the URL (→ "Approve sign-in", device-auth
  only). FIX: gate `sendsKeys` on the account actually having deliverable keys
  (server signals no key-state / no live admin) and fall back to "Approve
  sign-in" automatically. Pairs with the first-machine enrollment trap above.

- 2026-07-23 (189 live two-machine test, founder-hit): a newly-hosted dashboard
  origin is not in the API's CORS/`azp` allowlist, so its first `/v1/web/session`
  call is CORS-blocked and, even past CORS, the Clerk-token `azp` check rejects
  it — both read the SAME `CLERK_ALLOWED_ORIGINS` (worker.ts:537, clerk.ts:99).
  Hit when testing against the new deployed dev dashboard `main.rbox-app.pages.dev`
  (the automated e2e ran on the allowlisted `localhost:5173`, so it never saw
  this). Fixed live by adding the origin to the dev worker's
  `CLERK_ALLOWED_ORIGINS` secret. NOT a prod bug today (`app.rbox.to` is already
  allowlisted), but the standing lesson: ANY new hosted dashboard origin must be
  added to `CLERK_ALLOWED_ORIGINS` before it can talk to the API. Consider a
  clearer failure signal than a bare browser CORS error.

## 2026-07-25 — design 200 P1 live-validation session

- **Opaque witness refusal line.** Step D's seven-clause witness refusal
  collapsed to `branch deletion witness refused <ref>` with no clause name;
  diagnosing the founder's Mac required reading 60MB of state.json by hand.
  Fixed same-day (#453) — every fail-closed compound refusal should name its
  failing clause from day one.
- **`wrangler deployments list` shows stale data.** It reported a 7/23
  deployment as latest while the Cloudflare API showed current deploys from
  today. Burned ~20 minutes chasing a "broken" DEV pipeline that was fine.
  Verify against `GET /workers/scripts/<name>/deployments` before concluding
  anything from wrangler's list output.
- **macOS SIGKILLs a binary `cp`'d over an existing signed one.** Replacing
  `~/.rbox/bin/rbox` in place poisons the signature cache (exit 137 on exec).
  Dev deploys must `rm` + `cp` to a new name + `mv` (fresh inode). The
  installer already does an atomic swap; hand deploys must too.
- **ACK origins only re-stamp when a ref MOVES** (`requested !== before` in
  base-composer). A branch resurrected at the same OID can never refresh a
  stale-lineage receipt; recovery needs a no-op `commit-tree` advance first.
  Worth a doctor hint or an origin-refresh path if lineage-stale receipts
  recur (they exist only for branches deleted before the 1.9.1 upgrade).
- **Codex `--output-last-message` pointed at the review file clobbers it.**
  The last message overwrote the full review the prompt asked codex to write
  to the same path; findings had to be recovered from the 38MB session
  stream. Keep the two paths distinct.
