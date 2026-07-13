# Goal §43 — Nested-Repo Git Sync

**Mission:** rbox is "Dropbox for devs." A folder OF repos — the founder's real layout at
`~/conductor/workspaces` (multiple projects + Conductor git worktrees) — must transfer **git
state** across machines, not just untracked files. Today git-sync (design 02 + §28 E2EE) only
engages when the sync root IS the repo; nested repos and worktrees are preflight-rejected
(`git-sync: skipped — no .git`). Generalize it.

**Context to read first:** `docs/design/02-git-mirroring.md`, `docs/design/28-git-sync-e2ee.md`,
`src/engine/git-state.ts`, the git wiring in `src/cli/sync.ts`, `docs/learnings.md`,
`tasks/lessons.md`.

**Ground rules (apply to every step):**
- PRE-LAUNCH, SINGLE USER: backward compatibility does NOT matter. A **clean manifest-schema
  break** (bump the schema version; old clients hard-fail with a clear "upgrade rbox" error) is
  PREFERRED over dual-format complexity.
- After EACH step: run `/simplify` and `/antislop-codebase` on the diff, then a codex adversarial
  review — `codex exec --dangerously-bypass-approvals-and-sandbox "$(cat prompt.txt)" > out.txt
  2>&1 < /dev/null` (kill zombie codex procs after) — and fix findings to PASS before moving on.
- Use `isolation: worktree` for any parallel subagents (never two agents writing the same
  checkout).
- Branch `feat/nested-git-sync`. **PR-only** — no merge, no release, no tag.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`

## Step 1 — Design `docs/design/43-nested-git-sync.md`

Cover, with the same rigor as design 02 v3:

1. **Discovery** — walk the tree for dirs whose `.git` is a REAL directory (reuse the ignore
   pruning; `.git` itself stays hard-excluded from FILE sync — see `isHardExcluded`).
2. **Manifest schema** — replace the single root `git` section with a per-repo map
   (`gitRepos: Record<posixRelPath, GitSection>`; root repo keyed `"."`). Clean break: bump the
   schema version, no legacy carry, old clients fail loudly.
3. **Worktrees** — a worktree's `.git` is a pointer FILE into the main clone. Capture as
   **standalone** via `git bundle create --all` run inside the worktree (bundles are
   self-contained — objects come from the main store). Materialize a full independent repo on
   the target machine. Document that semantic honestly (target loses worktree-ness; that is the
   accepted, useful behavior).
4. **Churn safety** — Conductor archives/creates repos constantly. A repo that vanishes or
   errors mid-capture is **DEFERRED** (skipped this commit, re-captured by the daemon later),
   NEVER aborts the push — the same partial-progress philosophy as PR #38.
5. **Per-repo base-advance only on successful apply** (design 02 v3 discipline: never record an
   unapplied remote git as base).
6. **E2EE unchanged** — bundles/index/op-state convergent-encrypted under the workspace KEK,
   blobRef-rooted for GC; the server sees nothing new. (git-remote-gcrypt was the studied prior
   art — §28 notes.)

Codex design review → iterate to PASS before writing code.

## Step 2 — Engine

Generalize `git-state.ts` capture/apply to take a repo dir (preflight: `toplevel === repoDir`,
real `.git` dir; KEEP the bare/alternates refusals). New discovery module. Unit tests:
round-trip, preflight rejections, deferred-on-vanish.

## Step 3 — Sync + daemon wiring

- Capture nested repos on push: bounded concurrency, defer on churn.
- Apply on pull: NEVER silently overwrite a repo's uncommitted local changes (non-destructive
  fetch semantics like design 02; conflicts preserved).
- Forensic daemon logs per repo: `git-sync: captured/applied/deferred N repos` + paths.
- Two-machine e2e via the FakeRemote/e2ee harness: fixture folder with 2 nested repos + 1
  worktree → history/branches/HEAD materialize byte-identical on machine B; churn test (repo
  deleted mid-push → deferred, push still succeeds).

## Step 4 — LIVE VALIDATION (the verification step, per the founder)

1. `bun build --compile` standalone binaries: macOS-arm64 + linux-x64.
2. `rbox stop` on BOTH machines (Mac, and flat-meadow via `ssh via-server`).
3. Mac: dev-binary **push** of `~/conductor/workspaces` — capture is READ-ONLY on the Mac side;
   never modify user files there.
4. flat-meadow: dev-binary **pull** into `~/conductor/workspaces`.
5. Verify: ≥2 restored repos on flat-meadow pass `git fsck` + `git log` with HEAD/refs matching
   the Mac; a Conductor worktree materialized as a WORKING standalone repo; spot-check a stored
   R2 blob is ciphertext (zero plaintext).
6. Leave both daemons **STOPPED** afterward (the installed 0.5.7 binaries predate the schema
   break) and state that prominently in the report.

## Step 5 — Finalize

PR with a full summary (design decisions, codex rounds per step, live-validation evidence) + a
morning report at `tasks/goal-report-43.md`: what shipped, what's deferred, exact validation
output, daemon state on both machines. **Do NOT merge or release** — the founder merges in the
morning; that release brings the daemons back.

## Guardrails

- NEVER delete or modify files in `~/conductor/workspaces` (the flat-meadow side may only ADD
  git state).
- It is the founder's real data — when uncertain, STOP and report rather than force.
- If blocked on anything only the founder can decide, write it to the report and halt that step
  rather than guessing.
