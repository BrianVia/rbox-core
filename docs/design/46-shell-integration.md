# 46 — Shell integration: ambient status in the prompt

## Motivation

Design 45 made `rbox status` honest; this makes it AMBIENT. The rebind incident's
root failure mode was trust-on-demand: sync state is only seen when someone runs a
command, which is exactly when it's already too late. The shell layer fixes that
the way git did — a glyph in the prompt and a one-line banner on `cd` into a
workspace. rbox's pitch is "background sync you never think about"; the prompt
segment is the continuous, zero-effort proof that the machinery is working.

## Architecture decision: the daemon pre-renders, the shell just reads

The naive design — zsh parsing `activity.json` and mirroring status-view's verdict
rules — fails two ways: JSON parsing in pure zsh is fragile (halt reasons contain
quotes), and the display rules (stream stamps, stale-active suppression, halt
op-keying) would be DUPLICATED in a language with no tests, drifting forever
(design 45 R4's exact lesson class). Instead:

**The daemon writes a shell-friendly sidecar, `.rbox/state/shell.line`,** rendered
by a pure, unit-tested TS function at the same moments (and with the same
best-effort, ordered, never-on-the-hot-path contract) as `activity.json`. The zsh
side is deliberately dumb: one `read` builtin, a staleness compare, a glyph map.
All judgment stays in TypeScript next to the code that owns the data.

### shell.line format (v1)

One line, single space separated, `name` LAST because it may contain spaces:

```
v1 <epochSeconds> <state> <pct> <sequence> <lastOpEpoch> <lastOpKind> <name…>
```

- `epochSeconds` — write-time heartbeat. The shell treats a line older than
  **180s as "daemon not running"** (state `off`) — the daemon heartbeats at
  least every ~60s (safety tick) while alive, so 3× that is decisively stale.
  This replaces any pidfile logic shell-side.
- `state` ∈ `ok` (settled — last pump ended with nothing queued), `pending`
  (watcher events / wants queued), `active` (transfer in flight), `halt`.
  Semantics derive from what the daemon KNOWS (its own queue + design 45's
  activity record) — never from a scan the shell can't do.
- `pct` — transfer percent for `active`, `-` otherwise.
- `sequence` — last synced sequence, `-` if none.
- `lastOpEpoch`/`lastOpKind` — most recent of lastPush/lastPull (`push`/`pull`,
  `-` when none); the banner renders "last push 2m ago" from these.
- `name…` — workspace display name (falls back to the short workspace id).

Halt REASONS deliberately do not ride this file (long, quote-laden); the shell
shows `⚠ sync halted — rbox status` and the command has the detail.

Lifecycle: written alongside every `activity.json` write (same throttle/chain);
**removed by `resetSyncState`** (design 45 R4: every per-binding sidecar joins
the rebind reset — this one ships already on the list).

## The zsh plugin — `eval "$(rbox shell-init zsh)"`

`rbox shell-init zsh` prints the plugin + completions to stdout; users add one
line to `.zshrc`. One binary spawn per shell startup (~40ms warm, measured) and
ZERO spawns afterwards — the per-prompt path is zsh builtins only (<2ms budget):

- **chpwd hook**: walk up from `$PWD` for `.rbox/workspace.json` (git-style),
  cache the root in `_RBOX_ROOT`. On ENTERING a workspace (root changed from
  unset/other), print the banner once:
  `rbox: <name> ✓ in sync (seq 80) · last push 2m ago`
  (colored; `⚠ sync halted — run \`rbox status\``, `○ background sync not
  running — rbox start`, `↻ uploading 41%`, `↑ syncing…` variants).
- **precmd hook**: when `_RBOX_ROOT` is set, read `shell.line`, set
  `RBOX_PROMPT` (e.g. `✓`, `↑`, `↻ 41%`, `⚠`, `○`) and append it to `RPROMPT`
  unless the user sets `RBOX_NO_RPROMPT=1` (then they place `$RBOX_PROMPT`
  themselves — this is also the theme/p10k escape hatch).
- Degrade to NOTHING on any error: missing files, unreadable JSON-era daemons
  (a pre-0.6.4 daemon writes no shell.line → state `off`), non-workspace dirs.
- Glyph/color mapping lives shell-side (the file stays ANSI-free).

## Completions — `rbox completions zsh`

Generated from `COMMAND_HELP` (help-registry.ts), the same single source of
truth the dispatcher and help screens already project from — so completions
can't drift from the real surface by construction. Covers top-level commands
(public only — no hidden/internal tokens), subcommands parsed from multi-word
names, and per-command flags parsed from the registry's flag metadata.
`shell-init` embeds the completion function in its output, so one eval wires
both (no second spawn, no compinit file management).

## Starship (docs only)

A README/docs snippet: a `custom.rbox` starship module whose `command` reads
`shell.line` and maps state→glyph (one `awk`). Same file, covers bash/fish/zsh
starship users for the cost of a paragraph. Not shipped as code.

## Non-goals

- Editing users' rc files (setup may PRINT the eval line; never writes it).
- Command wrappers, cd-into-workspace auto-start, or any shell-side mutation —
  the shell layer is display-only.
- bash/fish native plugins (starship snippet covers them; native ports later
  if asked).
- Showing local-diff verdicts the daemon can't know between scans — `ok` means
  "daemon settled", which is the honest ambient claim (the full verdict stays
  in `rbox status`).

## Regression coverage

- Pure renderer: shellLine() state precedence (halt > active > pending > ok),
  field escaping (spacey names), absent-slots handling.
- Daemon: shell.line written alongside activity.json; removed on resetSyncState.
- Completions: generated script contains every public command + a known flag;
  contains NO hidden/internal tokens; output is stable (snapshot).
- shell-init: output embeds both hooks + completions; `zsh -n` parses it clean.

## Code-comment provenance (113 wave 4)

Review citations relocated from code comments by design 113 wave 4 (comment
sweep). The invariant prose remains at each cited site; the review round that
produced it is recorded here.

- `src/cli/shell-init.test.ts` (round-1 regression section): was "codex R1 regressions" — rewritten as a neutral guard heading; test-name strings remain unchanged.
- `src/cli/shell-init.test.ts` (round-2 regression section): was "codex R2 regressions" — rewritten as a neutral guard heading; test-name strings remain unchanged.
- `src/cli/activity.ts` (sequence-zero prompt rendering): was "codex R1" — never-synced rendering invariant retained in code.
