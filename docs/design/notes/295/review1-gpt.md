# Design 295 review — round 1

Verdict: **ALIGNED**

Reviewed `SPEC.md`, design 295, the current parser and all direct list callers.
Git 2.54 byte-level output confirms `--porcelain -z` emits NUL-terminated
fields followed by an empty NUL record terminator. The design preserves
canonical self exclusion, detached/locked handling, prunable-as-absent,
fail-closed strict callers, lossy compatibility, and the current UTF-8 boundary.
It adds no abstraction or deletion beyond replacing the newline decoder.

Executed baseline:

```text
bun test src/cli/sync-git/git-state.test.ts src/cli/sync-git/git-state-apply.test.ts
30 pass, 0 fail
```

Implementation check: catch parse failures inside `listWorktreesStrict`; inject
successful truncated stdout and failed subprocess partial stdout; assert `-z`.
