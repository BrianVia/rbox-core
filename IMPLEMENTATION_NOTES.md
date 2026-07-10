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

## Step 3 — reusable lockfile primitive and config transaction

- Added isolated `lockfile.ts` and `config-txn.ts` modules without wiring them into sync/apply/state code. The existing `gitBusy` lock probes now use `lstat` so busy detection also follows the §7 no-follow rule.
- The production marker identity uses the exact v7 sources: macOS `kern.uuid`, `kern.bootsessionuuid`, and binary `kern.proc.pid.<pid>` (`kinfo_proc.kp_proc.p_starttime`); Linux `/etc/machine-id`, `/proc/sys/kernel/random/boot_id`, and `/proc/<pid>/stat` field 22. Probe failures remain non-reapable/foreign.
- Atomic lock creation stages a same-directory 0600 `O_EXCL` marker, fsyncs it, hard-links it into place, and removes the staging name. Recovery uses a separately owned `<lock>.reap` fence and exact no-follow marker rechecks; only provably dead same-host+boot incarnations are removed. A failed post-commit release is tracked as stale-ours in-process so the next acquisition can recover that exact marker without treating arbitrary live same-process locks as stale.
- The config transaction performs bounded stat-bracketed 1 MiB+1 reads, parses only same-directory snapshot files, builds incarnation-named candidates unlocked, reopens/fsyncs the final candidate path, performs a locked literal B2/B1 CAS and owner recheck, and treats rename as the commit point. Parent-fsync/release/read failures after rename are returned as warnings, not failed applies.
- Orphan sweeping removes parseable candidates only for dead same-host process incarnations and removes unparseable `*.rbox93[.lock]` names only after 24 hours. The fresh-target helper deliberately uses ordinary `git config --local --add` and removes the caller-specified fresh target on any failure.
- **DECISION NOT EXPLICIT IN THE DESIGN:** the persisted config stat token is `{dev, ino, size, mtimeNs, ctimeNs}` as lossless decimal strings. Including ctime detects same-size edits even if mtime is restored; step 4 can store this object verbatim.
- **DECISION NOT EXPLICIT IN THE DESIGN:** a stable Git parse failure is permanent/disabled, while candidate-construction failures are transient/deferred unless their filesystem errno is one of the §4 permanent classes. Canonicalization results are returned explicitly (including over-wire-bounds failures) rather than silently converting an unrepresentable local config to `{}`.
- The §11 live-file assertion uses an injected Git runner that verifies Git receives the bounded snapshot path and matching snapshot bytes, so no strace/dtruss test was skipped.
- Test evidence: `bun test src/engine/git/lockfile.test.ts src/engine/git/config-txn.test.ts` — 27 pass, 0 fail, 84 assertions; `bun test ./src/` — 1,063 pass, 11 skip, 0 fail, 4,269 assertions across 96 files (180.56s); `bun run typecheck` — green (root and Worker).
