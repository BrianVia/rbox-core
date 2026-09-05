# Sync/Git execution worktree

Current implementation: four independent fixes in designs289/290/291 are locally
validated and reviewed. Final compiled DEV integration passed111 assertions;
see `docs/design/notes/287/integration-validation.md` for evidence and limitations.
The user requested landing these four after green CI and a `docs/STATUS.md` handoff;
remaining roadmap packages are deferred to the next agent/host. The paragraphs below
retain the earlier planning/regression history.

Canonical source: `plan.mdx`. Generated review copy: `docs/design/287-change-proportional-sync-and-worktree-state.md`. The original design281 was renumbered because newer main documents occupied that number.

Execution branch: `codex/astra-sync-git`, based on freshly fetched main `c4aa22bbb81c8754230735a73c5a58a28a64b4f7`. Remote checkpoint: `pre-astra-changes` (annotated).

The accepted user choices remain recorded in the plan. Design288 scopes the first regression-only deliverable. Current-main reconciliation and test results live in `docs/design/notes/288/`.

The original audit evidence and roadmap reviews retain their historical baseline. They do not establish compatibility against this newer main or substitute for focused implementation review. Design288 review completed through Claude Fable5.1 at medium effort after reauthentication. Round2 is ALIGNED for the regression-only slice; subsequent product design remains separate.

`reader.html` is generated from the canonical source. The companion renderer recipe is saved as `render-local.mjs.txt`; its session-local dependency imports must be adjusted on another machine. No preview note is sent to an agent automatically.
