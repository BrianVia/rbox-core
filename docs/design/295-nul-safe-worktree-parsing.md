# 295 — NUL-safe worktree ownership parsing

## Owner and boundary

`src/cli/sync-git/git-state.ts` owns the single decoder through
`parseWorktrees`, `listWorktreesStrict`, and lossy `listWorktrees`. Existing
callers keep their current Interfaces and policy ownership: canonical self-path
comparison remains in `git-state-apply.ts`, and capture/apply/held-state callers
continue deciding how to use the decoded entries.

Git output is already decoded to a UTF-8 JavaScript string by `gitStatus`.
Supporting arbitrary non-UTF-8 filesystem names end to end remains an open
product question; this change does not claim that support.

## Protected behavior

- The current checkout is excluded by canonical `realpath` comparison, including
  path aliases; every other live sibling branch remains ownership evidence.
- Detached entries have no branch. Locked entries remain live. Per design 68,
  prunable entries are absent for collisions and live-worktree bookkeeping.
- Unknown additive porcelain fields do not change recognized path, branch, or
  prunable metadata.
- Strict, authorizing callers fail closed when Git or parsing is unreadable and
  never receive a partial list. The lossy diagnostic/non-authorizing API keeps
  returning `[]` on unreadable input.
- Commands, return shapes, capture behavior, wire formats, journals, migrations,
  and performance shape otherwise remain unchanged.

## Algorithm

Run `git worktree list --porcelain -z` and split its stdout on NUL. A
`worktree <path>` field starts a record; an empty field ends it. Within a
record, retain `branch <ref>` and any field beginning with `prunable`; ignore
the other fields. Reject a branch/prunable field before a worktree, a second
worktree before the current record terminates, or a non-empty trailing partial
record. Parsing completes before returning entries, so malformed suffixes
cannot authorize a partial prefix. Both public list functions use this decoder;
the newline decoder is deleted.

This adds no new Module, mode, fallback, or durable authority. There is no safe
deletion beyond replacing the old decoder, and no incidental requirement is
challenged: odd-path safety and fail-closed authorization are product
requirements.

## Validation

Real temporary repositories cover newline, tab, quote, backslash, space, and
Unicode worktree paths from every checkout, including canonical self exclusion.
They also cover detached HEAD, prunable, and locked entries. Injected truncated
stdout and subprocess failure prove strict unreadable/no-partial behavior and
lossy `[]` behavior. Existing apply, held-skip, and capture tests provide the
compatibility gate; typecheck and affected lint cover the unchanged Interfaces.
There is no durable effect or new hot path, so crash and performance gates are
not applicable; the repository rig remains the integration gate.

## Rollback

Revert this change as one commit. It changes no wire record, journal, migration,
or stored state. Any rollback must retain a fail-closed solution for unusual
paths rather than restoring newline parsing on authorizing paths.
