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
