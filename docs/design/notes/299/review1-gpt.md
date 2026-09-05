# Design 299 review record

## Round 1

NOT ALIGNED.

- An isolated `bun test src/cli/sync-git/capture.test.ts` probe fails because that path is absent. The exact multi-filter acceptance command still succeeds by running its matching files, so no placeholder or design exception is needed.
- `GIT_CONFIG_NOSYSTEM` classification was implicit. Design revised to state that it is preserved because SPEC's explicit config-source strip list names only `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`.
- Inherited-variable tests must poison and restore `process.env`; passing STRIP names in `extra` would instead exercise the deliberately authoritative override. Design revised with the isolation rule.

## Round 2

NOT ALIGNED.

- New focused tests passed, affected lint and diff checks passed, but typecheck found that the copied environment needed an explicit `NodeJS.ProcessEnv` annotation for indexed deletion. Fixed without an assertion.
- The first reviewed test revision overrode OWNED variables in its only child observation, so it did not independently prove their ambient values absent. Fixed by observing one child with ambient values only, then a second child with owned `extra` overrides.

## Round 3

ALIGNED.

- New policy tests: 2 pass, 0 fail, 51 assertions.
- Typecheck, affected lint, and diff check pass.
- Supplemental spawn/state/capture suites: 59 pass, 2 skip, 0 fail, 525 assertions.
- Reviewer confirmed every named STRIP and OWNED ambient variable, both counted-config prefixes, PRESERVE families, owned overrides, real-repository adversaries, environment restoration, and all traced spawn lanes.
- The exact prescribed multi-filter acceptance command passes; the earlier concern came from probing its absent capture filter in isolation.
