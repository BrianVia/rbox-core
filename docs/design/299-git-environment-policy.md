# Design 299: explicit Git environment policy

## Decision

`src/engine/git-spawn.ts:cleanGitEnv` remains the single owner of the environment for every rbox Git child. It starts with the ambient environment, removes the explicit repository-routing and process-control variables below, then applies caller `extra` last. There are no new modes, parameters, or spawn paths.

## Inventory

### PRESERVE

- `GIT_AUTHOR_*` — preserve caller commit/reflog identity; the existing name/email fallbacks still fill absent identity.
- `GIT_COMMITTER_*` — preserve caller commit/reflog identity; the existing name/email fallbacks still fill absent identity.
- `GIT_SSH` — preserve the user's SSH transport program.
- `GIT_SSH_COMMAND` — preserve the user's SSH transport command.
- `GIT_SSL_*` — preserve TLS transport configuration.
- `GIT_ASKPASS` — preserve credential prompting integration.
- `GIT_TERMINAL_PROMPT` — preserve the caller's prompt policy.
- `GIT_EXEC_PATH` — preserve the selected Git helper installation.
- `GIT_TEMPLATE_DIR` — preserve the user's Git initialization templates.
- `GIT_TRACE*` — preserve Git diagnostics.
- `GIT_CURL_VERBOSE` — preserve HTTP diagnostics.
- `GIT_HTTP_*` — preserve HTTP transport configuration.
- `GIT_PROXY_COMMAND` — preserve proxy transport integration.
- `GIT_LFS_*` — preserve Git LFS transport and diagnostics.
- `GIT_CONFIG_NOSYSTEM` — preserve the caller's established choice to skip system config; SPEC limits config-source stripping to `GIT_CONFIG_GLOBAL` and `GIT_CONFIG_SYSTEM`.
- Other unlisted `GIT_*` variables — preserve by default; this policy allowlists routing overrides to strip rather than blanket-dropping Git integration.

### STRIP by default

- `GIT_OBJECT_DIRECTORY` — must not redirect the repository's primary object store.
- `GIT_ALTERNATE_OBJECT_DIRECTORIES` — must not add foreign object stores.
- `GIT_COMMON_DIR` — must not redirect common repository metadata.
- `GIT_WORK_TREE` — must not redirect the selected work tree.
- `GIT_NAMESPACE` — must not replace the visible ref namespace.
- `GIT_SHALLOW_FILE` — must not replace the repository's shallow boundary.
- `GIT_GRAFT_FILE` — must not replace the observed commit graph.
- `GIT_REPLACE_REF_BASE` — must not replace the ref hierarchy used for object substitution.
- `GIT_CEILING_DIRECTORIES` — must not alter repository discovery boundaries.
- `GIT_DISCOVERY_ACROSS_FILESYSTEM` — must not alter repository discovery across mount points.
- `GIT_IMPLICIT_WORK_TREE` — must not alter bare/work-tree interpretation.
- `GIT_CONFIG_PARAMETERS` — must not inject command configuration.
- `GIT_CONFIG_COUNT` — must not inject counted command configuration.
- `GIT_CONFIG_KEY_*` — must not inject counted configuration keys.
- `GIT_CONFIG_VALUE_*` — must not inject counted configuration values.
- `GIT_CONFIG_GLOBAL` — must not replace the user's normal global config source.
- `GIT_CONFIG_SYSTEM` — must not replace the normal system config source.
- `GIT_EXTERNAL_DIFF` — must not replace Git's diff implementation.
- `GIT_EDITOR` — must not launch or replace an editor in rbox operations.
- `GIT_SEQUENCE_EDITOR` — must not launch or replace a sequence editor in rbox operations.
- `GIT_PAGER` — must not launch or replace a pager in rbox operations.

### OWNED

- `GIT_DIR` — absent by default and set only when an rbox caller explicitly supplies it through `extra`.
- `GIT_INDEX_FILE` — absent by default and set only when an rbox caller explicitly supplies a private index through `extra`.
- `GIT_NO_LAZY_FETCH` — absent when ambient and set through `extra` by graph/object proofs that must not hydrate missing objects.
- `GIT_NO_REPLACE_OBJECTS` — absent when ambient and set through `extra` by proofs that require the literal object graph.

## Protected functionality and ownership

| Protected contract | Owner / evidence |
|---|---|
| Buffered, stdin, streamed-output, structured-status, and private-index Git lanes receive one base environment policy | `src/engine/git-spawn.ts`; every lane calls `cleanGitEnv` |
| Ambient identity remains intact and absent author/committer name/email receive the existing rbox fallback | `cleanGitEnv` and its existing identity test |
| Credential, transport, helper-selection, and diagnostic variables continue to reach Git | PRESERVE inventory and child-environment test |
| Explicit rbox-owned variables override the default removal | `extra` remains the final spread; child-environment test |
| stdout bytes, trimming, max-buffer handling, observer calls, exits, causes, and stdin cleanup do not change | Existing `git-state.test.ts` runner coverage |

No migration, compatibility path, fast path, command, protocol, or degraded mode changes. `cleanGitEnv` owns policy only; it must never own Git command orchestration or infer policy from command arguments.

## Implementation and validation

Use one explicit constant list for exact-name removal and one prefix check for `GIT_CONFIG_KEY_*` / `GIT_CONFIG_VALUE_*`. Apply `extra` after removal so existing owned overrides remain authoritative. No new abstraction is justified.

Validation is one child-environment test covering every exact STRIP entry, both config prefixes, all PRESERVE entries/families, and owned overrides; one real-repository test proves a foreign alternate object is invisible to the rbox runner while raw Git sees it and an inherited namespace cannot hide the repository's real refs. Ambient-variable tests snapshot and poison `process.env` and restore it in `finally`; STRIP variables are not passed as `extra`, because `extra` is intentionally authoritative. Then run the focused acceptance suite, typecheck, and affected lint.

Deletion candidates: none. Challenged requirements: none; the explicit inventory and two real-Git adversaries are acceptance requirements, and collapsing them would weaken reviewability or proof. Differential gates are the fake-child environment comparison and existing runner tests; crash, compatibility, and performance gates are unchanged because environment construction adds only a bounded key scan before spawn and introduces no durable effect.
