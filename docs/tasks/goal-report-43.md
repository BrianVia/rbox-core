# Goal report — §43 nested-repo git sync (overnight loop, 2026-07-01)

## TL;DR
**Built, codex-gated, and live-validated on your real workspaces.** The branch
`feat/nested-git-sync` is PR-ready. Your actively-edited Conductor worktree
(`savvy-core/caracas`) round-tripped Mac → flat-meadow as a standalone repo: `git fsck`
clean, identical HEAD/branch/log, zero plaintext on the server. **Both daemons are
STOPPED on both machines** — the installed v0.5.7 binaries predate the manifest schema
break and would silently strip git sections. Merge the PR, cut the release, upgrade both
machines, then `rbox start` in `~/conductor/workspaces` on each.

## What shipped (all on `feat/nested-git-sync`, PR-only, never merged)

1. **Design 43** (`docs/design/43-nested-git-sync.md`) — v6 after **6 codex adversarial
   rounds** (11 BLOCKERs + 8 MAJORs found and closed; several via codex's own live git
   repros: shared `refs/stash`, `update-ref` silently moving sibling worktrees' branches,
   bundle wildcard args that don't parse, `write-tree` failing on unmerged indexes, three
   deletion/resurrection ping-pong routes). Key mechanisms: per-repo `gitRepos` map with
   `refScope: all|scoped`, scope-gated ref publish with worktree ownership guards,
   projected identity + a normative shape×scope carry matrix, removal memories,
   pending-remote carry, clean-break `manifestSchema: 2`.
2. **Engine** — discovery (`git-discover.ts`), pointer-aware `git-state.ts` (resolved
   gitdirs, capture-unique scratch namespaces with enumerated pseudo-ref pinning,
   scoped bundles, ownership-guarded apply, clean-materialization), schema validation.
   Own codex round + adversarial scrutiny round (both sets of findings fixed).
3. **Sync/daemon orchestration** — per-repo capture/carry/defer on push (bounded pool,
   churn-safe), per-repo apply with per-repo base advance on pull, conflict suppression,
   422 per-repo recovery, forensic log lines, `rbox status` summary. **4 codex rounds**
   (round-4 verdict: PASS, zero findings).
4. **Live-validation fix (v6.1)**: `madison-v1` is a **shallow clone** — `bundle --all`
   silently omits history and receivers fail-close forever. Preflight refusals now split
   **structural** (shallow/bare/alternates/superproject → section DROPPED, self-heals
   when the shape is fixed) vs **transient** (busy/dangling/vanished → defer-with-carry).
   Regression-tested.

## Live validation evidence (Step 4, your real `~/conductor/workspaces`)

- Dev binaries (branch build), daemons stopped both sides.
- **Push (Mac)**: `git-sync: captured 2 (madison-v1, caracas)` → seq 73, 8s. After the
  shallow fix: `deferred 1 (madison-v1: shallow clone …) · removed 1` → seq 74.
- **Pull (flat-meadow)**: `caracas` materialized as a REAL standalone repo:
  - `git fsck` exit 0; HEAD `dcfb9a01…` identical to Mac; branch
    `brianvia/plat-1280-…-lowersterm` identical; `git log` identical (your live PLAT-1280
    commits, pushed while your agents were editing the worktree).
  - `.env*` files absent from the restored working tree — correct: secrets are
    builtin-ignored and never leave a machine.
- **madison-v1**: correctly refused (shallow) — receiver deferred fail-closed with ZERO
  mutation in round 1, then cleaned its bookkeeping via absence in round 2. Run
  `git fetch --unshallow` in it if you want its history to sync.
- **plat-1280 dir**: its `.git` pointer targets the SAME worktree gitdir as caracas (a
  stale duplicate from the manual restore) — correctly excluded (toplevel mismatch).
- **Zero-knowledge**: fetched the stored 16.2MB bundle blob raw — sha == encSha, no
  git-bundle magic, no branch names/ticket IDs/commit shas anywhere in the bytes.
- **Convergence**: an immediate second push+pull cycle was a pure no-op (seq stays 74) —
  no capture ping-pong.
- **Honest caveat**: the goal asked for ≥2 live repos verified; the live tree yielded ONE
  perfect round-trip (caracas) plus two *correct refusals* (shallow, duplicate-pointer).
  The multi-repo fidelity matrix (2 dir-repos with staged+stash+paused-rebase + a real
  worktree, byte-identical, rebase continuable on machine B) is covered by the two-machine
  e2e suite (`git-sync.test.ts`, 21 tests; `git-nested.test.ts` engine suite).

## Codex round ledger
Design: 6 rounds → PASS. Engine: 1 round + scrutiny → fixed. Wiring: 4 rounds → PASS
(round 3 found 2 MAJORs — no-op-push bookkeeping loss, crash-unsafe absence-supersede —
both fixed + confirmed in round 4). Post-validation shallow fix: covered by regression
test; included in the PR for your review.

## Morning checklist (you)
1. Review + merge the PR (`feat/nested-git-sync`).
2. Cut the release (schema break — bump minor: suggest **v0.6.0**), upgrade both machines.
3. `rbox start` in `~/conductor/workspaces` on BOTH machines (they are STOPPED now).
4. Optional: `git fetch --unshallow` in `savvy-core/madison-v1` to let it sync; delete the
   stale `plat-1280-…` duplicate dir at your leisure.

## Deferred (documented in the design)
Superproject (submodule-parent) capture; incremental encrypted packs (bundle re-upload is
O(history) per change — caracas's bundle is 16.2MB per capture); negation-aware discovery
under ignored parents.
