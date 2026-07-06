# SPEC — implement design 69 parts 3.1–3.3 (status perf, daemon-down half)

The NORMATIVE spec is docs/design/69-status-perf.md (on main, codex-reviewed
v2 — the resolutions section explains every rule; do not weaken them).
Implement §3.1 (HashCache in status, pid-guarded write-back), §3.2
(divergence overhaul: poolMap concurrency 8, repoCtx threaded once,
fingerprint cache with the COMPLETE v2 input set + stable-pair rule,
`.rbox/state/git-divergence.json` atomic writes), §3.3 (scan-walk collector
firing PRE-prune for `.git` entries — dir AND gitfile pointer — feeding
gitDivergenceCount's new optional repo-list param; default behavior for all
other callers unchanged, preserving design-68 pointer-parent skip semantics).

§3.4 (daemon snapshot) is OUT of scope — separate PR.

Constraints:
- gitIdentity/capture-path semantics untouched for sync; only status's
  divergence path rides the fingerprint cache.
- The fingerprint MUST cover the full v2 input list (op-state set, preflight
  sentinels incl. config mtime + worktrees state, commonDir refs/packed-refs,
  .git shape/pointer target, resolved gitDir+commonDir paths).
- Start the human-mode fetchAccountSummary concurrent with local work
  (design 69 §4 v2 note) — do not change its output or error-swallowing.
- No new flags; no output changes except speed (and the --json local fields
  are §3.4's, NOT yours).

Acceptance criteria (all must go green from worktree root):
- `bun run typecheck`
- `bun run test` (known baseline failures NOT yours: 4 shell-init/completions,
  status --json environmental, occasional watcher-timeout flake)
- New tests covering: fingerprint invalidation per mutation class (commit,
  stage, stash, branch/checkout, rebase-step/op-state, packed-refs repack,
  shallow/alternates sentinel flips, pointer-worktree ref change via
  commonDir), zero-git-spawn on unchanged repo (spawn-count seam),
  stable-pair rule under mid-probe mutation, collector sees dir+pointer
  repos and misses nothing discoverGitRepos finds (equivalence test on a
  mixed fixture), pid-guarded hashcache write-back (daemon pidfile present
  → no write), corrupt caches → correct slow path + heal.
- A micro-benchmark test proving the divergence path issues 0 git spawns on
  a warm unchanged multi-repo fixture.
