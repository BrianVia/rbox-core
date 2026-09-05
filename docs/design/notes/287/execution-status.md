# Sync/Git execution status — 2026-09-05

## Final local candidate

Four fixes are implemented and committed independently: absent-directory batching,
ordinary staged-object closure, portable private indexes, and tracked-index cache
freshness. The audit/roadmap is a separate documentation commit. Designs 289/290/291
have final ALIGNED reviews. Final compiled DEV Git-entanglement passed 111 assertions;
see [integration validation](integration-validation.md) for exact binary identity,
focused checks and the broad local suite's unresolved/baseline distinctions.

The user now requests merging these four after green CI, then updating
`docs/STATUS.md` for a possible agent/host takeover. Stop before starting another
roadmap package. No production promotion or CLI release is authorized by this merge.
GitHub CI and merge are pending at this document's commit.

## Earlier execution record (historical)

Worktree: `.claude/worktrees/astra-sync-git`, branch `codex/astra-sync-git`, base `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`. Annotated `pre-astra-changes` tag was pushed at that base.

The user authorized local development, oxlint compliance, and scoped design/test-summary review by Claude Fable 5.1 at medium effort. Product implementation review is tracked per slice; historical roadmap or regression-only alignment does not imply final approval of the current candidate.

Design 288's regression specification aligned after two rounds. Its baseline reproduced three capture failures: split artifact portability, split fresh-receiver apply, and ordinary unmerged stage-object closure, alongside 24 passing existing capture tests. The tracked-cache replacement regression also reproduced on the base. These are historical red results; the current local implementation has passing focused regressions.

Implementation wave:289 new portable captures (historical artifact repair separately scoped),290 absent deletion batching,291 ordinary tracked-cache freshness with uncached native split enumeration. All three are implemented locally and validated in focused tests; the full roadmap remains287, and the remaining packages are not implemented.

Tooling: supported Bun 1.4.0 at `/private/tmp/rbox-bun140/node_modules/.bin/bun`; frozen dependencies installed in this worktree. Root/API/scripts typecheck passes for the local candidate. Local DEV rig image and two device containers are running; required doctor checks passed. Source-mode DEV `type-flip` passed all 9 assertions, and `mass-delete-guard` passed all 8, including refusal without consent, preservation of the 100-file receiver tree, consented convergence, and throwaway-account cleanup. These runs do not establish compiled-binary acceptance or cover every new Git/index path. Compiled checks and remaining focused implementation reviews are tracked by their owners and must be completed before claiming candidate readiness. No production deployment, merge or release has occurred.

Validation and implementation results are recorded in each design's notes and review files as work completes. Baseline-only results above are not candidate acceptance results.

Current integrated F2/ignore validation: 116 tests pass, 0 fail, on Bun 1.4.0; see `docs/design/notes/290/root-validation.md`. G5 ancestry work is paused and was not included in this first implementation wave. Draft-PR preparation does not mark the remaining roadmap complete.
