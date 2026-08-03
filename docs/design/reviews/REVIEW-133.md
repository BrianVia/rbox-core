# REVIEW-133 — onboarding polish for v1.6.7

Review rounds for §133. The acceptance bar is exact compliance with the founder's
enumerated bundle and no behavior change beyond the interactive default flip and
config-aware `rbox ignore --list` presentation.

## Round 1

**Codex: NEEDS WORK.** The draft incorrectly implied sync-everything bypasses the
builtin `.env` ignore; expanded P7 from setup's summary to standalone init; described
`--yes` too narrowly; and did not explicitly pin the setup bridge's false/absent flag
or a real config fixture for list-mode tests.

**Resolution:** §133 now distinguishes Git-only ignores from always-active builtins
and connects `.env` to `!.env`; limits P7 to setup's unified summary; precisely states
purge confirmation, headless, remote-copy, and local-disk semantics; and adds the
missing bridge/config-fixture assertions.

## Round 2

**Codex: PASS.** The revised design is accurate about builtin versus Git-only
ignores, preserves the scripted/default compatibility boundary, limits P7 to the
requested setup summary, specifies honest mode-aware listing, and pins the relevant
prompt and config cases. Both reviewers are aligned; implementation may proceed.

## Implementation review

**Codex: PASS after one revision.** The first pass found contradictory builtin
wording and duplicate prompt-choice arrays. The final implementation describes the
builtin layer as always enabled but overridable by later `.rboxignore` negations,
and both wizard entry points consume one canonical ordered choice constant. The
review found no remaining scope, correctness, honesty, async, test, simplification,
or antislop issue.

Validation: `bun run typecheck` passed; 48 focused CLI tests passed. The full
`bun test src/cli` run reached 1,362 pass / 7 skip / 6 fail: the known same-SHA
metadata-heal failure plus five unchanged local-server tests unable to bind
`127.0.0.1:0` in the sandbox (`EADDRINUSE`), reproduced in isolation. No changed-path
test failed.
