# Design 93 implementation notes

## Step 1 — grammar and canonicalization

- Added a node-free shared module so the same allowlist, grammar, bounds, and canonical-wire checks can be imported by capture/apply code and by Worker-bundled manifest validation.
- Canonicalization removes repeated identical local values first-seen-first and reports rejected allowlisted values; credential-bearing HTTPS URLs are explicitly identified for the later once-per-repo loud log required by step 7.
- Decision not explicit in the design: wildcard fetch refspecs are accepted only when both source and destination use `*`. Git itself rejects one-sided wildcard refspecs, and admitting them would create wire values that cannot be applied.
- Decision not explicit in the design: SSH URL passwords are rejected while `ssh://user@host/` remains accepted. This keeps the documented SSH username form without creating a second credential-bearing URL path.
- Decision not explicit in the design: “scp-form” is treated as `[user@]host:path`, with non-empty host/path and no whitespace. `::` remains independently rejected as required.
- Decision not explicit in the design: “serialized total” is measured as the UTF-8 byte length of `JSON.stringify(config)`, matching the actual manifest wire representation.
- Decision not explicit in the design: a `branch.*.remote` target counts as present when any allowlisted `remote.<name>.*` key survives projection; the design does not require a URL specifically.
- Test evidence: `bun test src/engine/git/config-sync.test.ts` — 91 pass, 0 fail; `bunx tsc --noEmit --incremental false` — green.

## Step 2 — wire validation and raw Git reads

- Added the optional `GitSection.config` wire type without a schema bump. `validateGitSection` now delegates only that field to the shared canonical validator; unrelated unknown git-section fields remain accepted and untouched, pinned by regression test.
- Added a non-trimming `gitRaw` helper while preserving the existing trimming behavior of `git`. The `-z` local config reader explicitly disables includes, treats exit 1 as “no keys,” preserves successful empty values and embedded newlines, and rethrows real Git failures.
- Added the common-dir `config.lock` path to `gitBusy`; a pointer worktree-local path with that name does not create a false busy result.
- Test evidence: focused grammar/raw/manifest suites green; `bun run typecheck` green (root and Worker); `bun test ./src/` — 1,036 pass, 11 skip, 0 fail, 4,185 assertions across 94 files (173.23s).
