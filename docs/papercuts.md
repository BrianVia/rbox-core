# Papercuts

Running log of small things that broke, surprised, or slowed down agent
sessions. Founder-requested (2026-07-18): proactively appended by agents as
they work; signal for what to fix. Newest first. Keep entries to 2–4 lines:
what happened, what it cost, fix hint if obvious.

## 2026-07-18

- **`scripts/release.ts` has no dev-build path.** Compiling unreleased binaries
  for fleet validation required passing the LAST released version (changelog
  gate rejects anything else) and accepting a signing-key error after compile.
  Cost: two failed invocations + binaries whose `--version` lies (say 1.7.3,
  are main-tip). Hint: a `--dev` flag that skips the changelog gate + signing
  and stamps `<ver>+<sha>`.
- **apps/api tests fail confusingly under plain `bun test`.** They need the
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
- **regress.ts mutates `scripts/rig/runs/.image-hash` in the checkout it runs
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
- **No branch protection ⇒ no GitHub auto-merge.** Every merge-on-green needs
  a hand-rolled watcher loop. Hint: a minimal required-check ruleset on main
  would unlock native auto-merge.
- **`pgrep -f "codex exec"` matches the watcher's own command line** when the
  watcher polls for codex — self-keeping-alive loop. Use pid files or
  sentinel files instead of process-name grep.
