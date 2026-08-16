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

## RboxBar popover shows no real transfer progress (2026-07-26)
During a push, the menu-bar popover shows `Status: working / File: – / Progress: working…` — three placeholder rows. Founder ask: show actual push/pull progress — direction, file name(s), quantity (e.g. "pushing 48 files · 12/48 · 205 KB"), and a real progress bar. The daemon already has per-phase counts (upload lane knows files/bytes/inflight); the popover just doesn't consume them.

## `rbox start` over a running daemon reports ambiguous half-success (2026-07-26)
With a (dev-build) daemon already running, `rbox start` spawns a new process that loses the single-instance lock and dies — but the CLI prints "background sync (process N) started, but its mode is not witnessed yet — re-run `rbox start` in a moment". Two fixes: (1) detect the existing daemon and say "already running (pid …, version …)" — including a mismatch note when the running binary differs (rbox vs rbox-dev); (2) the witness confirmation should be the CLI's job — poll briefly and report the witnessed mode instead of asking the user to re-run (founder rule: minimize user typing). Hit 3× today (both hosts' restarts + founder's manual start on FM).

Resolved: dev versions with build metadata now parse correctly, process ownership reads the full command line, and `rbox start` identifies the live daemon by process, version, and witnessed mode. It polls the witness itself and reports a terminal next step for slow, exited, or concurrently superseded starts; no start outcome asks the operator to re-run the command.

## Dev-build fleet sees "update available → 1.9.1" downgrade hint (2026-07-26)

With the fleet on dev builds (1.9.1-dev+<sha>), `rbox status` now prints
`update available: 1.9.1-dev+b374f1e → 1.9.1` — semver-correct (release >
prerelease) but backwards for the founder's dev-tracking fleet; following it
would DOWNGRADE to the release binary and re-break the symlink setup. Wants a
dev-channel awareness check (suppress the hint when running a `-dev+` build,
or compare against the dev channel instead).

## Large clone/rm bursts always trip FSEvents overflow → 2-scan re-trust lag (2026-07-26)

Every ~5k-file burst (repo clone, rm -rf) drops the Mac watcher to suspect
("transient overflow"), costing two clean 60s safety scans before trusted
pulls resume (~4-6 min of scan-path pulls). Post-206 this heals unattended
and is named in the log, but the cadence is the remaining latency; a
burst-aware fast re-trust (immediate pinned rescan instead of waiting for the
safety tick) would shrink it.

## Rig runs print no tree provenance — stale-checkout runs read as regressions (2026-07-26)

The rig mounts src/ and scripts/ from whichever checkout launches it, but the
run header never says WHICH tree that was. Tonight a rig launch from the
primary checkout (whose local main was 6 commits behind origin) produced 7
"failures" that were really pre-#466 scenario expectations vs the newer
product — a full regression hunt for what a `HEAD: <sha> (behind origin/main
by N)` line in the report header would have made a 10-second read. Fix: rig
run header logs the launching checkout's HEAD, dirty state, and
behind-origin count; loudly warn when behind.
- **`npm run digest -- --json` is unpipeable** (rbox-admin): npm prints its
  own `> rbox-admin@…` banner to stdout ahead of the JSON, so `| python3 -m
  json.tool` chokes. Use `npx tsx scripts/digest.ts` directly for machine
  consumption, or teach the docs/skill that.
- **Fleet-versions panel counts 14-day ghosts as hosts** (rbox-admin): a host
  seen once since the window start stays a "host" on its old version after
  upgrading, so 1.9.1 adoption read 20% when live devices were ~all current.
  Dedupe by host on latest-seen version.
- **`client.telemetry.drops` records only the reason enum, never the kind**
  (by design, low-cardinality): a sustained `unknown_kind` CRITICAL is
  unattributable from AE — can't tell which client/build sends the unknown
  kind without tailing the worker live.
- **`rbox pair` exits on copy-to-clipboard** (founder, 2026-07-26): hitting the
  copy key in the pair flow terminates the command instead of staying alive to
  watch for the peer's `connect` and confirming success. Copy should be
  non-terminal; the flow should keep waiting and print "paired ✓ <device>"
  (or time out with the token's expiry). Related backlog: onboarding pairing
  flow (#5 in the 2026-07-18 UX list).
- **`rbox init --workspace` only accepts the opaque `ws_…` id** (founder,
  2026-07-26, during FM re-bind): the founder had to SSH-grep the Mac's
  workspace.json for the id. It should also accept the server-visible
  workspace NAME (resolve via the same listing the setup picker uses; error
  on ambiguity, suggest candidates). Violates the minimize-typing law.
- **`rbox init --adopt` runs minutes of silent hashing with no progress**
  (founder, 2026-07-26, FM re-bind: 77k files, ~230% CPU, nothing on the
  tty): the adoption scan should emit a rolling one-line status —
  files hashed / total (percent), matched-vs-divergent counts as they
  accumulate, like the transfer progress lines the daemon already renders
  (design 45/88 machinery exists; wire it into the adopt scan path).
- **Ref watcher logs "config authority unavailable" once per minute per
  stuck repo** (FM, 2026-07-27): savvy-core's materialization-incomplete
  skeleton (empty .git, no config) makes the probe fail every cadence tick —
  793 identical lines in one day. A standing condition should log once per
  episode/day with a counter, like the watcher-error dedupe does. The repo
  itself is the known 20h "needs attention" deferral, surfaced correctly by
  `rbox status --git`.
- **`rbox status` outside a workspace is a dead end** (founder, 2026-07-27):
  it errors "Not inside an rbox workspace" instead of showing a cumulative
  all-workspaces summary from the machine's daemon records. Filed as #498.
  FIXED 2026-07-27 (`doctor-triage`): both `rbox doctor` and `rbox status`
  now fall back to the all-workspaces view (`src/cli/doctor-machine.ts`),
  and `rbox doctor` leads with a plain-English triage report
  (`src/cli/doctor-triage.ts`, `--json` for the non-interactive twin).
  Process note attached to the same ask: founder wants GitHub issues to
  become the public todo list for feature asks like this.

- **A shipped design still headed "DRAFT" produced a false strategic finding
  (2026-07-27):** design 204 shipped 7/26 evening (PR #458, field-validated,
  STATUS addendum written) but its doc header still said DRAFT r3 — a
  corpus-wide review the next morning reported the 40x publish win as
  "built but dark, nobody flipped it," and two redundant work streams
  (a re-implementation dispatch + a fleet env-flag rollout) launched off
  that misread before the merged code was checked. Rules: flip the doc's
  Status header in the SHIP commit itself; any "X never shipped" claim
  must be verified against git (`git log -S <flag>`) before acting on it.

- **`rbox logs` surfaces archival crash text without provenance (2026-07-27,
  cost ~20 min during release validation):** the legacy `daemon.log` index
  file retains un-timestamped crash dumps from old binaries (here: the
  7/26 refwatch TypeError that #457 already fixed), and `rbox logs` stitches
  its tail after current dated-log lines — a fossil crash reads as a live
  release blocker. Fix hint: label each merged source section
  ("--- from daemon.log (legacy, last written <date>)") or drop legacy-file
  tails once dated logs exist.

- **A shape the design never printed got read into existence, and it was
  circular (2026-07-29, U3 wave 3C, cost ~40 min):** 163:3086 says the M6
  ledger's consumed `promoted-halt` form "omits the M7 SHA-256" and prints no
  schema for it — only the one-way `preparing` ledger is printed. Wave 1A
  reasonably read the omission as *carries dev/ino/**bytes***, and that reading
  is unimplementable: the halted-M6 record would name the M7 record's byte
  length while the M7 record names the halt record's, so each record's canonical
  size depends on the decimal width of the other's. 163's own five-row ordering
  breaks before the fixpoint does — the halt bytes must be final before M7 can
  be derived from them, yet under that shape they cannot be — and the fixpoint
  has no specified convergence, so two conforming implementations could disagree
  on canonical bytes. Nobody noticed across five design rounds because the
  circularity lives in JSON *lengths*, not in named dependencies. Fixed by
  pinning the shape without the length (163:3092 already required the retry to
  recompute the M7 record, so it was a duplicate too).

  **Rule 1 — an omission list is not a schema.** When a design says which fields
  a record leaves out, it has not said which fields it leaves in, and the
  implementer who fills that gap is authoring schema under the impression they
  are transcribing it. Treat an omission sentence as an open decision: write the
  shape into the document and get it reviewed before building on it. This is not
  an anecdote about one field — it is the root cause of the cycle above, and any
  lane reading a "carries X but not Y" sentence is in the same position.

  **Rule 2 — never store a length or hash of a record that stores yours.** Check
  for the cycle before implementing, and prefer deriving over storing, which
  removes the question entirely. A stored copy of a derivable value can only
  ever disagree with the derivation.

- **The state-plane file-size law has no CI gate (2026-07-29):** 163:3994 states
  "400 lines / 25 KiB is the hard CI failure" for production files, and nothing
  in `src/`, `scripts/`, or `.github/` enforces it — the number is honoured only
  by whoever remembers to run `wc`. Wave 3C's first draft landed at 636 lines
  and would have merged clean. Fix hint: one test beside
  `duplicate-declarations.test.ts` over `src/cli/state-plane/**`, with the
  301-399 review-note band as a warning list rather than a failure.

- **A "one line per module in the same change" doc rule with no gate is a rule
  nobody keeps (2026-07-29, wave 5A):** 222 §7.9 required `docs/CODEMAP.md` to
  gain one ownership line per new module in the same change. Eleven merged lanes
  instead *proposed* their line in the PR body, because 5A was named the CODEMAP
  owner and nothing failed without it — leaving **29 production state-plane
  modules undocumented** by the time the integration lane opened. Worse, the
  obvious gate is vacuous: `codemap.includes("src/cli/state-plane/migration/")`
  passes for every module in a directory that documents exactly one of them, so
  the first version of the check reported zero missing. Fix hint: match at LINE
  START, and pin that no path appears twice — two lines for one path is two
  owners. Rule: a documentation obligation stated in a design doc is a decoration
  until a test reads the document.

- **"Import graph" and "imports" are not the same structural claim
  (2026-07-29, wave 5A):** 222 §M-9 required "no `node:fs`, `node:crypto`, or
  `bun:sqlite` in this module's **import graph**" for the migration driver, while
  §7.9 wrote the same gate as "`authority.ts` **imports** no …". The transitive
  reading is unimplementable for a module whose entire job is sequencing bodies
  that open databases and rename files — the same shape as 163 v13's finding that
  M4's specified verification could not be performed. Rule: when a structural gate
  is stated twice in one document, implement it once and say which reading
  survived; a gate nobody can satisfy gets quietly reinterpreted by whoever
  implements it.

- **Two phase bodies fell between two lanes' scopes and nobody noticed for four
  waves (2026-07-29, wave 5A):** 222 §8 assigned M2/M3/M4 to lane 3A and
  "admission, which publishes nothing" to 2B, and M0/M1 — mint the ids, publish
  the first control, claim the reserve, create the emergency candidate — belonged
  to neither. The tree therefore carried `publishMigrationControl`'s
  `FIRST_CONTROL_REVISION` branch and `migrationPaths.emergency` with **zero
  production callers** through eleven merged PRs, and every lane's tests
  hand-planted the control records M0 was supposed to produce. Fix hint: a wave
  plan derived from a module inventory should be cross-checked against the *phase*
  inventory — one row of §5.2 per named owner — before dispatch. Rule: when every
  lane's fixtures construct the same precondition by hand, that precondition has
  no owner.

- **A `verification` halt names no cause, and that cost wave 5A the M4 defect
  (2026-07-30, snapshot-replay):** `prove-staging.ts` raises five distinct
  `halt("verification", …)` refusals with a message each, but the message is
  dropped — the durable record and the returned outcome both carry
  `underlyingCode: null`. Wave 5A's own behavior test saw M4 refuse an empty
  corpus and attributed it to "3A/5C fixture territory"; replaying a real 81 MiB
  workspace showed every fidelity check passing and the refusal coming from M4's
  `JSON.stringify` tuple comparison. Fix hint: `halt`'s detail string already
  exists at every raise site — put it in `underlyingCode`, which the taxonomy
  already uses for exactly this in `authority.ts`'s `corruptionHalt`.

- **`os.tmpdir()` is a RAM-backed tmpfs on the Linux desktop (2026-07-30):** a
  harness that staged copies of an 81 MiB legacy state under `/tmp` spent ~1 GiB
  of MEMORY per run and pushed a 31 GiB tmpfs to 80% before commands started
  failing with bare exit-1 and no output. Cost ~20 minutes of misdiagnosis. Fix
  hint: anything staging workspace-sized data should default to `/var/tmp`
  (disk-backed) and never `os.tmpdir()` on this host.

- **A test that pins a defect as "fixture territory" makes it unfindable
  (2026-07-30, M4 tuple fix):** wave 5A's `authority-behavior.test.ts` header
  documented "this harness's empty legacy state halts `verification` at M4" and
  its driver test asserted `kind: "halted", durableHalt: true` as the expected
  outcome. No corpus could ever have passed — M4 compared a JCS-round-tripped
  tuple against a SELECT-order one with `JSON.stringify` — so the test was
  encoding a total failure of the machine as a property of the fixture. Fixing
  the defect turned 5 of that file's 18 tests red, which is the only reason the
  premise was ever re-examined. Fix hint: when a test's comment explains WHY the
  system refuses rather than asserting that it works, treat the explanation as an
  unverified claim. A "the fixture is too small" excuse for a fail-closed gate is
  cheap to falsify — build the fixture, or drive the real thing.

- **Every migration test built its control in memory, so no test ever saw the
  record's own bytes (2026-07-30):** `import-json.test.ts` says outright
  "Nothing here encodes unless the test is about the bytes", and every M4 fixture
  therefore handed `proveStaging` an object whose key order matched
  `readCompletionTuple`'s. The one thing that differs on a real resume — the
  control has been through `encodeMigrationControl`/`decodeMigrationControl` —
  was the thing no fixture exercised. Fix hint: for any phase body that reads a
  witness off a durable record, at least one test must feed it a control that
  round-tripped through the real codec. In-memory fixtures cannot see key order,
  number spelling, or anything else canonicalization normalizes.

- **A test that sets `process.env.RBOX_HOME` at module load poisons every other
  suite in the process (2026-07-30, u3/5b):** `state-plane-cmd.test.ts` copied a
  pattern from `migration/admission.test.ts` — a top-level
  `process.env.RBOX_HOME = await fs.mkdtemp(...)` to keep daemon pid records out
  of the real home — and turned **56 tests in `credentials.test.ts` and
  `auth-cmd.test.ts` red** in the full-suite run while both files passed in
  isolation. One of them is literally named "RBOX_HOME isolates the credential
  store while HOME stays untouched (#505)". Cost ~15 minutes and one false
  "56 pre-existing environmental failures" conclusion. Fix hints: (a) a suite
  whose failures vanish when the file is run alone is cross-test state, never
  environment — check env mutation before blaming the host; (b) don't override
  an env var for a code path that only READS the location; (c) the existing
  in-tree copies of this pattern are latent versions of the same bug.

- **The gate that pinned "exactly two entry sites" at zero could have been
  satisfied by one (2026-07-30, u3/5b):** `authority.test.ts` compared a list of
  admitted FILES, so adding a single call site and updating the list to one entry
  would have passed a gate whose stated claim is "exactly two". The wave's own
  brief had to warn "don't be that", which is the tell: a gate that needs a prose
  warning is under-specified. It now asserts three conjuncts — the file set, one
  call per file, and one construction site per `EntryPoint` literal. Fix hint: a
  structural gate over a numbered claim must assert the NUMBER, not a list whose
  length the next author edits in the same commit as the violation.

- **`git grep`-based structural gates silently pass for untracked new files
  (2026-07-30, u3/5b):** the §7.9 entry-site gate reported zero call sites for
  brand-new modules that plainly contained them, because `git grep` only searches
  the index. A gate whose whole job is to catch a NEW caller is blind to exactly
  the shape it exists to catch until someone runs `git add`. Fix hint: either
  `git add -A` before trusting a `git grep` gate locally, or have the gate walk
  the filesystem. CI never sees this because everything is committed there —
  which is worse, not better: the gate is weakest in the loop where it is used.

- 2026-07-30: interactive `rm -rf` cleanup (13 dirs, one at a time) aggregated into one 46k mass-delete halt; surfaced only in admin/CLI, founder discovered it an hour later. Friction: intentional local deletions need a visible propagate-or-not surface, not a silent halt.
- 2026-07-30: Max blocked for DAYS on `rbox git resolve keep-mine` → "daemon/CLI is syncing". The unconfirmed pass waits only ~0.8s for the sync mutex (16×50ms) while the confirmed pass gets 60s (resolve-command.ts acquisitionDeadlineMs); a busy daemon makes the 0.8s window unlandable. Fix hint: same 60s deadline + "waiting…" line on the unconfirmed pass.
- 2026-07-31: a repo can sit wedged on a deferral for 7 DAYS with no escalation beyond a status line the user must ask for. Friction: long-lived deferrals need louder surfacing (menu-bar/notification), not silent parking. (Related backlog: RboxBar git-resolve shortcut.)
- 2026-07-31: papercuts appended in the primary checkout were silently reverted (file-plane sync echo? #535-adjacent) before commit — append+commit papercuts in ONE step on synced checkouts.
- 2026-08-02: Max (paying) wanted to abandon a workspace and start over; there is NO self-serve remote workspace delete (no CLI command, no dashboard button — only adminPurgeWorkspace in the admin routes). Worse, `rbox untrack` prints "manage or delete the workspace from the dashboard", pointing users at a surface that doesn't exist for them. Known-deferred (`--purge-remote` comment in untrack-cmd.ts), but now field-hit: fix the untrack copy now, prioritize the workspace-delete backend design.
- 2026-08-02: Max expected a `.rbox.conf`-style config to inspect/edit what the daemon syncs; nothing user-visible answers "what workspaces does this machine have and how do I forget one" except `rbox status --all` + untrack. Workspace lifecycle management (list/delete/rename) is a product gap, in his words: "Dropbox just gave you a folder".

## 2026-08-11 — test files that set HOME without restoring it

`login-device-fsm.test.ts` leaked `process.env.HOME` into later files in its
shard process and broke `setup-cmd.test.ts`'s `~/rbox` collapse assertion when
PR 630's new test file reshuffled shard composition (fixed in that PR). Same
latent bug class in `credentials.test.ts`, `key-cmd.test.ts`,
`uninstall-cmd.test.ts`, `credential-policy.test.ts` — each sets
`process.env.HOME` with no restore. Sweep candidate: a shared test helper that
scopes HOME/RBOX_HOME mutation, or a global afterEach guard.

## 2026-08-11 — flat-meadow's bun is canary; its self-built daemon crashed

FM's local `bun` is 1.4.0-canary; a dev binary built there embedded it and the
daemon crashed (stack in daemon-2026-08-11 logs). Worked around by scp'ing the
desktop's stable-bun build. Follow-up: pin FM's bun to stable, or make
dev-install refuse/warn when the host bun is a canary.
- 2026-08-12: `rbox stop` hit the 60s no-witness SIGKILL path twice in one day (via-desktop during a routine restart, then dfinitiv-macbook-pro) — now a pattern, not a one-off. Capture the wedged daemon's stack/logs before the next kill.
- 2026-08-12: flat-meadow logs transient `ResetMemoryAdmissionError` (needs ~4.2GB parse headroom, has ~3.6GB) from `boundedJsonRead` in `loadRawState` via `daemonBindingMatches` — the binding check still parses the legacy JSON state doc under a RAM-proportional admission budget. Self-heals on retry; the SQLite authority migration should delete this parse-budget path (or the binding check should avoid a full parse).
- 2026-08-12: GitHub-hosted CI infra day — setup-bun download deaths (main went red on a docs-only commit), shard clusters flip-flopping with zero code change (shard 5 design-202 cluster: fail/fail/pass; shard 1 daemon-activity cluster: pass/fail/pass), ux docker + temporarily-unreadable repo secret. Rule: a job whose FIRST step fails is infra; check step conclusions before diffing tests. Forensic dump now in daemon-trusted-pull.test.ts (pullLine) for the next shard-5 recurrence.
- 2026-08-12: checking out a branch in a SYNCED repo checkout (FM rbox-core) propagates the branch to every host via git-state sync (correct product behavior) — and the settling echo clobbered uncommitted docs edits on the desktop (known class). Lesson: never flip branches in a fleet-synced checkout for a build experiment; build from a local worktree instead.
- 2026-08-12: FM services the Development workspace as MULTIPLE folder bindings, each paying the full pull machinery serially per cycle (12s each → 22s+ apply spans in round-6). The per-binding pull tables (design 235 Phase A) now expose this; binding serialization is a named Phase-B consideration.
- 2026-08-13: shard-5 flake CAUGHT by the forensic dump: `FORENSIC pull-line-missing lines=[]` — the harness daemon's pump is a silent NO-OP in the failing cluster (zero log lines, not a wrong branch). Co-failures are the design-206 watcher-FUSE tests, so the lead is a module-level/global latch (fuse/matcher-provenance/halt) leaking across tests under CI interleaving and making later pulls refuse silently. Local repros stay green (5x). Next: find the module-level state the 206 fuse tests mutate without restore.

## pull-attribution differential test: second flake dimension (2026-08-13)

`receiver attribution is observation-only through the live state load/save
path` failed on PR #651 shard 2 (actions/error/disk toEqual mismatch), passes
locally on the same commit. Same test family as the stateMtimeMs 1ms race
masked in #648 — the differential harness appears to have more than one
timing-sensitive field. If it flakes a third time, stop masking fields and
make the differential compare a canonicalized projection instead.

## 2026-08-13 — deferral log hides the mismatch sample (follow-classify.ts:138)
"working tree differs from applied manifest" is logged with zero paths while
the oracle verdict carries a `sample: string[]` of exactly which entries
differ. Diagnosing FM's savvy-core wedge required an out-of-band bun script
driving `oracleFromState`+`proveRepo` against live state. Append the (capped)
sample to the detail string. Evidence: issue #659 comment 5285598893.

## 2026-08-15 — fleet start-fresh op (state rebuild)

- rbox's own conflict artifact (`build.dev_*.conflict.log`) tripped the
  "working tree differs from applied manifest" gate every cycle — the tool's
  litter blocked the tool. Conflict artifacts should be ignored by the
  differs-gate or written outside the synced tree.
- `rbox stop` needed the 60s SIGKILL escalation twice tonight (desktop mid
  conflict-retry, Mac mid idle) — both daemons had no live critical-section
  witness; whatever they were blocked on wasn't the protected section.
- `rbox git resolve` confirm tokens are snapshot-bound; any concurrent
  publication (or a preceding resolve) invalidates the batch. Bulk resolve
  needs a daemon-stopped, one-repo-at-a-time loop — or a `--all` verb.
- A live daemon plus 100+ carried-pending git sections converged only after
  the competing publishers were removed; with all three devices active the
  fresh device's 942-change re-baseline starved indefinitely.
- Second sighting of "P settlement BASE disappeared" (Mac rebuild, rbox-core
  repo; first was desktop first-sync same night). Reproduces in the
  fresh-join re-baseline flow. Also: take-theirs batch on the Mac refused
  with "resolution could not complete safely; no confirmation can be
  reused" ×4 and "local commits changed while the checkout was being
  confirmed" ×1 — resolve UX cannot batch even with the daemon stopped.
  Both need a rig scenario (two-device rebuild) before the next fleet op.
- SECOND merged-while-red incident (PR #740, 2026-08-15): the merge command
  ran unconditionally in a chained pipeline instead of gating on the review
  verdict — same class as the #695 note. Residual was docs-only this time.
  Rule reinforced: NEVER chain `gh pr merge` after a review/CI read in one
  command; read the verdict, then merge as a separate decision.

- Stash-differential proved the wrong baseline (PR #743, 2026-08-15): a fold
  agent "proved" 3 failing tests pre-existing by rerunning with its changes
  stashed — but the branch's own feature commit was already committed, so the
  stash removed only the fold, not the feature. All 3 were real feature
  regressions; CI (green main) caught them. Rule: a pre-existing claim needs a
  differential against origin/main (worktree or `git stash` PLUS checkout of
  the merge base), never against "my changes stashed".

- Agents default to the full `bun test src/cli src/engine` (~9 min) when
  `bun run test:affected` already exists and selects by import graph. Cost this
  cycle: several full runs where a scoped one would have done. Rule: affected
  per fix iteration, full suite ONCE as the final gate. (Note: a diff touching a
  root like `src/json.ts` selects ~85% of the suite anyway — worth knowing before
  assuming "affected" is always cheap.)

## 2026-08-16 — fleet git-pull conflict-copy waves
Concurrent `git pull` on synced checkouts (desktop+Mac, then FM) turned the
267/268 merges into conflict-copy litter waves (38+7 files) and phantom
"local changes" that abort pulls — bit 3x in one day. Recipe: pull
desktop FIRST, let the publish settle, then Mac, then FM; a wedged replica
repairs with `git fetch && git reset --hard origin/main` (content is
already synced; only HEAD lags). Litter sweeps: `find -name '*.conflict.*'`.

## 2026-08-16 — full-suite gates ran serial all day
Agents and orchestrator used `bun test src/cli src/engine` (~550s) for
final gates when `bun run test:parallel` (6 shards, 145s) exists. Bake
test:parallel into agent briefs for the one full-suite gate.

## 2026-08-16 — test:parallel hid WHICH test failed
`scripts/test-parallel.ts` reported a red shard by printing the last 4 lines
matching `/(pass|fail|skip)/`. A test file that throws before any test runs —
269's case was a `.test.ts` importing a symbol that had moved modules, which
typecheck does not cover — prints `# Unhandled error between tests` and NO
`(fail)` line, so the harness printed ` 1 fail` with no name and no file.
Cost: ~25 minutes and three full 145s gate runs to identify a one-line import
fix, including a wrong "cross-shard contention flake" hypothesis (each shard
passed alone). Fixed here: a failing shard now keeps its raw last-40 lines;
green shards keep the terse counts.
