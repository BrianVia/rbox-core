# 124 — Git deferral drilldown + copyable fix brief

Status: DRAFT (review findings resolved)
Owner: founder request 2026-07-15 ("what do we do here?" on a `2 repos
deferred · 1h` RboxBar row with no way to see which repos or what to do)

## Problem

RboxBar shows only a deferred-repo count and coarse age. Finding the repo,
current reason, and safe next action requires `rbox status` plus knowledge of
resolver internals. Add two surfaces: a maximum-five-repo drilldown, and a
one-click brief containing truthful diagnosis and exact commands where a
command can act.

## Non-goals

- No new durable deferral bookkeeping or automatic resolution. Resolve remains
  an explicit CLI operation.
- No telemetry change. Details remain local; repo paths still never enter
  metrics.
- No repo/branch aliasing or redaction mode in v1. The brief intentionally keeps
  the absolute workspace root, relative repo paths, and branch labels so its
  commands are actionable; it omits hostname, account IDs, remote URLs, and
  commit OIDs.
- No change to resolver semantics, including the unsupported `keep-mine` verb.

## Design

### 1. One repo projection and presentation vocabulary

`projectGitDeferralRepos` in `status-view.ts` is the sole projection used by
the human CLI list, brief, and ambient writer. It produces one summary per repo,
not one row per lane. Extend that projection with the selected reason's
`reasonSince`, a deterministic compact sentence naming every additional
lane/reason on the same repo, and an actionability/remediation class derived
from the complete `RepoRecord`. The existing reason precedence selects the
primary reason; oldest valid `deferredSince` selects episode age; sorting is
oldest valid episode first, then precedence, then repo. Invalid/future times
sort last and render `unknown` rather than zero/fresh.

The exhaustive presentation vocabulary—short label, explanatory sentence, and
remediation class for every known reason—lives in `status-view.ts` or a
dependency-leaf module imported by it. It does not live in `git-cmd.ts` and is
not duplicated in Swift. Unknown reasons use opaque generic copy (`Git sync is
deferred for an unrecognized reason`) and never become a resolve recommendation.

The human list, brief, and ambient UI render one repo summary. If multiple lanes
stand, the brief appends the projection's deterministic `Also deferred: ...`
sentence; it does not create lane rows. The raw lane-level array exists only in
`--json` (§2).

Actionability is computed from the record, not inferred from display reason:

- **Apply + incoming/resolvable state:** only a record for which resolver
  `incomingFor` succeeds (`pending`, `resolutionKey`, or an apply deferral with
  `base`) gets resolve steps. Render the real two-step flow: first
  `rbox git resolve <repo>`; then run
  `rbox git resolve <repo> take-theirs --confirm <token>` with the fresh token
  printed by show-me. State that `keep-mine` is unavailable. State that
  take-theirs quarantines and reflog-pins local Git state and does not rewrite
  working files.
- **Transient local state:** `local-edits`, `local-operation`, `local-commits`,
  `local-index`, and `local-stash` usually clear when the repo goes quiet.
  Recommend stopping Git/file mutation and letting normal sync retry; escalate
  with `rbox status`/daemon logs only if both episode and reason ages keep
  growing. If such a reason is also in the resolvable apply class, show both
  this safer wait guidance and the explicit two-step override.
- **Capture lane:** normal push capture already retries and carries the previous
  safe section. Make the repo quiet/readable and let sync recapture; persistent
  artifact/unreadable/unsupported failures direct the user to `rbox status`,
  daemon logs, and Git/version/repository-shape repair. Never print resolve.
- **Config lane:** normal sync carries the previous safe config. Correct the
  local common Git config so it is readable, within wire bounds, supported, and
  workspace-owned, then let sync retry; use daemon logs to distinguish a
  transient read failure from publication-disabled config. Never print resolve.
- **Apply with no incoming state, or any other non-resolvable apply condition:**
  state that the resolver has no deferred incoming state; let sync fetch/rebuild
  it and inspect `rbox status`/daemon logs if it persists. Never print a resolve
  command. Conflict, artifact, containment, ownership, ignored-target,
  unsupported, busy, and unreadable copy uses the vocabulary's specific repair
  sentence, but cannot override this capability gate.

### 2. CLI: `rbox git deferrals [--brief | --json]`

Root selection is the same upward workspace discovery used by `rbox status`,
starting at the current directory; there is no repo positional argument.
Default human output is the repo projection, one line per repo, or
`no deferred repos`. `--brief` emits all repo summaries without the ambient cap.
`--brief --json`, positional arguments, and flags not registered for this leaf
are usage errors.

`--json` is the exception to the repo projection: a shared serializer makes
each lane entry byte-for-byte/field consistent with `status --json`'s
`git.deferrals` entry for the same injected clock, including checkout
omission/union behavior:

```json
{"schemaVersion":1,"deferrals":[{"repo":"Personal/rbox-core","lane":"apply","reason":"local-edits","deferredSince":"2026-07-11T12:00:00.000Z","reasonSince":"2026-07-15T10:00:00.000Z","ageSeconds":345600,"bytesChanged":true,"checkout":{"kind":"branch","label":"main"}}]}
```

Exit 0 includes the empty form
`{"schemaVersion":1,"deferrals":[]}`; usage, root/load, and rendering failures
exit nonzero and write no success JSON. Dispatch in `main-dispatch.ts`, leaf
help in `help-registry.ts`, the central flag registry/parser, generated zsh
completion, and their contract tests are all in scope; dispatch currently
recognizes only `git resolve`.

The brief begins exactly with:

`contains local repo paths and branch names — share accordingly`

It then includes workspace root, injected rbox version and render timestamp
(no hostname/account IDs), full count, and one section per repo. Age wording is
`deferred for X · current reason Y since Z`, using `deferredSince` and
`reasonSince`; malformed or future timestamps render `unknown`. Branch checkout
is optional; detached and unavailable checkouts are explicit.

All executable lines are generated from argv with one shared POSIX single-quote
encoder, never interpolation, and are location-independent:

```text
cd <quoted-workspace-root> && rbox git resolve <quoted-repo>
cd <quoted-workspace-root> && rbox git resolve <quoted-repo> take-theirs --confirm <quoted-token-printed-by-show-me>
```

The second line is a template instruction until show-me prints the actual
snapshot; the brief never fabricates a token. Display fields are separately
control-character-sanitized and Markdown-escaped. Fixtures cover spaces,
quotes, leading dashes, backticks, `$()`, newlines, Markdown delimiters,
Unicode, usernames, email-like names, customer repos, and ticket/user branches,
including paste from outside the workspace.

### 3. Ambient repo details and reconciliation

`AmbientDaemonStatusV1` keeps schema version 1 and gains optional `deferrals`.
It contains at most five oldest repo projections, never lane entries:

```json
{"repo":"Personal/rbox-core","reason":"local-operation","reasonLabel":"local Git operation","reasonText":"A Git operation is active or changed here.","remediationClass":"transient","deferredSince":"2026-07-11T12:00:00.000Z","reasonSince":"2026-07-15T10:00:00.000Z","checkout":{"kind":"branch","label":"main"}}
```

The nested schema is exact:

- array maximum 5; extra producer rows are not written and extra consumer rows
  are ignored;
- `repo` is required, nonempty after sanitization, and at most 1,024 Unicode
  scalar values; `reason`, `reasonLabel`, and `remediationClass` are required
  strings capped at 128, 160, and 64 scalars; `reasonText` is required and
  capped at 512; branch `label`, when present, is capped at 512;
- producer and consumer replace CR/LF and Unicode control characters with a
  single space, collapse runs, trim, then cap; a sanitized-empty repo is
  malformed;
- `deferredSince` and `reasonSince` are required ISO-8601 strings that parse to
  finite instants; checkout is optional and, when present, is
  `{kind:"detached"}` or `{kind:"branch",label?:string}`—neither branch nor
  label is otherwise required;
- unknown item keys are tolerated. Unknown reason strings retain their bounded
  opaque value but render the generic unknown-reason label/sentence and
  non-resolvable remediation. Wrong types, invalid times/checkouts, or missing
  required fields drop that item only; they never invalidate core daemon
  status or other valid items.

`deferredRepos` remains the authoritative validated full repo count. Consumers
render `min(5, deferredRepos)` valid rows, never rows beyond the count, and
compute `+N` as `max(0, deferredRepos - renderedValidRepoRows)`. If count is
positive but no valid details exist, show one generic `details unavailable`
row while retaining the full omitted count. Basename collisions are allowed;
each row is one-line middle-truncated, has the full sanitized relative path in
help/tooltip and accessibility text, and never relies on basename as identity.

Ambient rows carry timestamps, not frozen ages; every consumer derives age
during render. Live rows use render time. Paused rows use the pause status's
`heartbeatAt` as their reference instant and are labeled `as of pause` (they do
not grow as if still observed). Populate may borrow details only from a fresh
status record for the same daemon/workspace identity. Dead rows use the last
heartbeat reference, are labeled stale/display-only, and are never supplied to
the copy fallback as current.

Old reader/new writer, new reader/old writer, unknown-key/reason, oversized,
malformed, mixed-validity, count mismatch, colliding basename, and timestamp
skew cases are tested in both TypeScript and Swift readers.

### 4. RboxBar drilldown and copy state machine

Below the Git row, render the reconciled rows as
`repo-basename — reason · deferred X · reason Y`, plus freshness labels and the
clamped omitted row. Swift validates and renders the opaque TypeScript-owned
labels/sentences; it owns no reason vocabulary or resolution semantics.

`RboxActions` adds a dedicated capture-with-timeout subprocess API. Existing
`run()` is not reusable: it merges/throws away output, blocks on
`readDataToEndOfFile`, and has no deadline. The new API resolves the binary and
runs argv without a shell; drains stdout and stderr separately and concurrently;
caps each stream (the brief stdout cap is 1 MiB and stderr cap 64 KiB); rejects
invalid UTF-8; has an injected deadline (10 seconds in production); on expiry
sends terminate, waits an injected 1-second grace, then kills and reaps; and
invokes completion exactly once on the action queue. Nonzero exit returns
bounded stderr separately. Tests cover nonzero, hang, ignored terminate,
oversized streams, invalid UTF-8, separation, reaping, and exactly-once delivery.

`AppModel` owns copy-in-progress, error, and confirmation state. Invocation
captures selected workspace identity and root. It calls
`rbox git deferrals --brief` at that root through the new API. On completion it
reconciles identity: a changed selection cancels presentation and writes
nothing. Pasteboard mutation occurs on the main actor, clears and writes a
string, checks the Boolean result, and flashes `Copied ✓` only on success.
Failure shows an honest error and never flashes success. Confirmation clears
after two seconds, on another copy/action, on selection change, or on failure.

Version-skew/failure state machine:

1. Known root + successful current CLI brief: copy the complete current brief.
2. CLI missing/old, nonzero, timeout, or malformed output + validated live
   ambient rows: offer a separate `Copy partial last-known details` action. Its
   first lines say `PARTIAL AND STALE`, include
   `omitted N repo(s)`, and contain only validated opaque diagnosis—no generic
   resolve command or claim of completeness.
3. Paused, dead, unattributed/stale populate, no details (new Bar/old daemon),
   clipboard refusal, or no root: do not copy fallback; show the precise
   update/run-status/clipboard error. Display may still show explicitly stale
   rows.

Thus both daemon-old/Bar-new and daemon-new/Bar-old remain safe: optional fields
are ignored by the old reader, and the new reader degrades to count-only UI and
an honest CLI/update error.

## Files

- `src/cli/status-view.ts` (or new dependency-leaf presentation module) — repo
  DTO, vocabulary, remediation/actionability, age rendering; tests.
- `src/cli/git-cmd.ts` — `deferrals` renderer and POSIX command construction;
  `src/cli/git-cmd.test.ts` deterministic/hostile-name goldens.
- `src/cli/status-cmd.ts` — shared lane JSON projection and invalid-time
  semantics; tests.
- `src/cli/ambient-status.ts` — bounded ambient projection/parser, paused carry,
  sanitization; tests.
- `src/cli/main-dispatch.ts`, central CLI flag registry/parser,
  `src/cli/help-registry.ts`, `src/cli/completions.ts` — dispatch/help/flags and
  generated completion contracts; tests.
- `macos/RboxBar/Sources/RboxBar/Models.swift`, `StatusReader.swift`,
  `MenuContentView.swift`, `RboxActions.swift`, and `AppModel.swift` — schema,
  provenance/reconciliation UI, bounded subprocess, clipboard/action state;
  corresponding Swift tests and snapshots.

## Acceptance

- `bun test` and `swift test` pass. CLI goldens dependency-inject clock,
  hostname, and version; parser/UI goldens inject clock. Hostname is absent by
  contract, and the injected-host fixture proves it cannot appear.
- Cross-surface matrix covers: each remediation class and lane combination;
  multiple lanes/reason transition; malformed/future times; hostile names;
  count/detail mismatch; old/new daemon-Bar skew in both directions; fresh,
  paused, dead, and populate provenance; old/missing/failing CLI; complete and
  partial fallback; subprocess failure/timeout/kill/output/UTF-8; selection
  change; and clipboard refusal.
- Run `bun run rig` and ship a dev RboxBar build to the local Mac fleet. Field
  validation must exercise one apply deferral with real incoming/resolvable
  state through show-me and the confirmed take-theirs command, and one
  non-resolvable capture or config deferral that prints its real remediation and
  no resolve command. Paste every emitted command from an unrelated directory.

## Review resolutions

- F1: Capability comes from the record; only resolvable apply state gets the
  real show-me → confirmed take-theirs flow.
- F2: One `projectGitDeferralRepos` repo DTO drives human/brief/ambient; lane
  entries are JSON-only and omitted counts are clamped.
- F3: Ambient carries both timestamps with live/paused/populate/dead provenance;
  dead details never masquerade as current fallback.
- F4: The bounded nested schema, item-local dropping, unknown handling, and
  old/new reader-writer matrix are explicit.
- F5: The brief deliberately keeps actionable paths/branches, omits host/account
  data, and carries a mandatory sharing warning without redaction claims.
- F6: Commands use shared POSIX argv quoting, workspace anchoring, and hostile
  path fixtures.
- F7: Presentation vocabulary belongs to `status-view`/a leaf; Swift consumes
  opaque strings and its fallback is partial/stale.
- F8: A bounded capture-with-timeout API replaces any proposed reuse of
  `RboxActions.run()`.
- F9: Version skew and failure select complete CLI output, labeled partial/stale
  fallback, or honest error UI.
- F10: `AppModel.swift` owns selection-safe action/clipboard/confirmation state
  and tests.
- F11: JSON wire shape, root/mode/exit contracts, dispatch, flags, help, and
  completion scope are pinned.
- F12: Episode and current-reason ages use both timestamps; invalid/future values
  are unknown.
- F13: Full count is authoritative; rows/caps/sanitization/undisclosed details
  and full-path help are reconciled.
- F14: Acceptance is a deterministic cross-surface failure matrix plus both
  resolvable and non-resolvable field cases.
