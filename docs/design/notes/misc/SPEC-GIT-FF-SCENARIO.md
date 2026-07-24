# SPEC — git fast-forward propagation e2e (founder request 2026-07-19)

## Objective

Prove the full new-user git story end to end on the DEV API, using the real
CLI in containers (model on scripts/e2e/dev-backed-scenario.ts — reuse its
mint/burn, container, wizard-driving, and screen-wait machinery):

1. Machine A: fresh wizard setup (bootstrap secret path), workspace = a
   directory that CONTAINS a git repo (create the repo first: `git init`,
   one initial commit on `main`, a few files). Bind + start sync.
2. Machine B: pair via the real pairing flow (as dev-backed-scenario does),
   sync down, verify the repo arrived: `.git` present, `git -C <repo> log
   --oneline -1` matches A's HEAD SHA, `git status --porcelain` clean,
   branch is `main`.
3. On A: make a NEW commit to `main` in the repo (modify a file + add a new
   file, `git add -A && git commit`). Let the daemons sync.
4. On B: verify fast-forward: B's repo `main` now points at A's new HEAD SHA
   (same SHA, not a different commit — capture both and compare), working
   tree contains the modified + new file contents, `git status --porcelain`
   clean, and `git reflog` on B shows a fast-forward advance (not a fresh
   clone — the old SHA must appear in the reflog history).
5. Also assert the uncommitted-state story stays sane: after step 4, B has
   no uncommitted junk in the repo.
6. Branch + checkout-follow propagation (founder addition): on A,
   `git switch -c feature/prop-test`, make a commit onto it (new file), let
   daemons sync WITHOUT switching back. On B verify: B's checked-out branch
   is now `feature/prop-test` (HEAD follows — the checkout-txn plane applies
   A's branch switch), `git -C <repo> rev-parse HEAD` equals A's branch HEAD
   SHA, the new file is present in B's working tree, `main` still points at
   the step-4 SHA, and `git status --porcelain` is clean.
7. Switch-back: on A, `git switch main`, sync, and verify B follows back to
   `main` at the step-4 SHA with a clean tree (and `feature/prop-test`
   still present at its SHA on both machines).

## Deliverable

- `scripts/e2e/git-ff-scenario.ts`, runnable via
  `bun scripts/e2e/git-ff-scenario.ts`, same env contract as
  dev-backed-scenario (assertDevClerkSecret etc.), burn account in finally.
- `GIT-FF-REPORT.md` at the worktree root, written ONCE at the very end:
  each step's outcome, the two HEAD SHAs, timing from A-commit to
  B-fast-forward, and the final verdict PASS/FAIL with evidence.

## Hard constraints

- DEV API only. Do NOT modify anything under `src/`. No design docs.
- Never echo secrets; screens with pairing tokens are fine to keep only in
  the report if the account is burned.
- If a wizard screen-wait times out, retry the whole scenario once before
  reporting failure.

## Acceptance

`bun scripts/e2e/git-ff-scenario.ts` exits 0 with PASS in GIT-FF-REPORT.md.
