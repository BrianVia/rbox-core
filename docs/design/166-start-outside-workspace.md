# 166 — `rbox start` outside a workspace: resume the known fleet

Status: DRAFT (design only — not implemented). Origin: `rbox start` is the
muscle-memory command for "make my stuff sync", but it only works when the
shell happens to be inside a workspace root (or a descendant — `findRoot`
walks up). From anywhere else it either drops into the guided setup flow
(TTY) or errors (non-TTY), even when the machine has a registry full of
known workspaces whose daemons are simply not running (fresh boot without
autostart, post-crash, post-`rbox stop`, SSH session landing in `$HOME`).

## Problem

`main-dispatch.ts` `case "start"` today:

1. `rbox start <path>` → start that root's daemon. Fine.
2. `rbox start` inside a workspace → start this root's daemon. Fine.
3. `rbox start` outside any workspace:
   - TTY → `runGuidedFrontDoor()`: a **cwd-centric** menu (status of this
     untracked directory, "Track this directory", setup, pair…). The user
     asked to start sync; they get onboarding for a directory they may have
     no intention of tracking.
   - non-TTY → `workspaceRequiredError()` ("Not inside an rbox workspace…").

Meanwhile the machine already knows every workspace it has ever
started/stopped: the desired-state registry
`~/.rbox/daemons/<workspaceKey>/desired.json`
(`{rootPath, state: running|stopped, accountId, workspaceId, at, pullOnly?}`,
written by `startDaemonAndRecordDesired`/`stopDaemonAndRecordDesired`), and
three consumers already interpret it:

- `bootResume` (`rbox __boot-resume`, the launchd/systemd autostart entry):
  starts every row that is desired-**running** for the logged-in account.
- `autostartWorkspaceStatuses`: classifies rows as
  `running | stopped | stale (root/config missing) | mismatch (workspace
  rebound or account differs)`.
- `rbox upgrade`: restarts live daemons only when safely bound, respecting
  desired-stopped.

The gap is purely a front-door one: none of that machinery is reachable from
the command users actually type. Case 3 should become "resume the fleet".

## Proposal

Extend `rbox start` (no path argument) with a third resolution step. The
ladder becomes:

1. **Explicit path** — unchanged.
2. **`findRoot(cwd)` hit** — unchanged (single-workspace start, desired →
   running).
3. **No root found** → read the desired-state registry:
   - **Registry has ≥1 row** → **fleet resume** (new; same on TTY and
     non-TTY — deterministic for humans and scripts alike).
   - **Registry empty** → today's behavior exactly (TTY guided front door /
     non-TTY `workspaceRequiredError`). The new-user path is untouched.

### Fleet resume semantics

`rbox start` outside a workspace means **"bring my background sync back
up"**, not "force every workspace to sync". Concretely, for each registry
row (classified via the existing `autostartWorkspaceStatuses(accountId)`):

| Row status | Action | Reported as |
|---|---|---|
| desired **running**, daemon down | start it | `started` |
| desired **running**, daemon already up | nothing (idempotent) | `running` |
| desired **stopped** | **left paused** — an explicit `rbox stop` is user intent this bulk command must not override | `paused — resume with: rbox start <path>` |
| `stale` (root or `.rbox/workspace.json` gone) | skip | `skipped: root missing` etc. |
| `mismatch` (workspace rebound / other account) | skip | `skipped: <reason>` |

This is deliberately the **same policy as `bootResume` and `rbox upgrade`**:
desired-stopped is never flipped by anything except a targeted start. A user
who paused `~/scratch` because it held junk must not have it silently
re-enabled by a habitual `rbox start` typed in some other terminal. The
output makes the paused rows and their one-line resume command visible, so
"I wanted that one too" costs one copy-paste.

No special case for "exactly one known workspace": a single desired-stopped
row still stays paused. Special-casing would make the command's meaning
change as the fleet grows — the worst kind of nondeterminism for muscle
memory.

### Output sketch

```
$ rbox start
resuming background sync (3 workspaces known to this machine):
  started  ~/code/rbox-core
  running  ~/notes (already running, process 4821)
  paused   ~/scratch — resume with: rbox start ~/scratch
```

All-quiet variant (everything already running): still print the per-row
table — this doubles as the "is my fleet up?" glance, mirroring
`rbox autostart status`.

### Flags

- `--pull-only` is **rejected in fleet mode** (`error: --pull-only needs a
  single workspace — pass a path`). Each row already carries its own
  recorded `pullOnly`, and resume honors it per row (as `bootResume` does).
  Applying a global flag to N workspaces would silently rewrite N desired
  records.
- No `--all` / `--force` flag in v1. If real demand appears for "unpause
  everything", it can be added later as an explicit opt-in; shipping it now
  invites the stopped-override footgun this design just closed.

### Exit code

- `0` — every actionable row started (or was already running), including
  the "nothing desired-running" case (paused/skipped rows are informational,
  not failures).
- non-zero — any attempted start failed or returned `retry-later`
  (`startDaemon`'s rebind-restart path where the old daemon hasn't exited);
  the row is reported with the retry hint and the command remains safe to
  re-run.

### Credentials

Fleet mode requires a valid login (rows are account-scoped). Not logged in →
the existing "not logged in — run `rbox login`…" error from
`desiredContext`, surfaced before touching any daemon. Credential-degraded →
same message `bootResume` logs, as an error here (interactive command, so
fail loudly rather than silently doing nothing).

## Mechanism (implementation sketch)

All pieces exist; this is composition, not new machinery.

- `autostart-cmd.ts`: new exported `resumeKnownWorkspaces(deps)`:
  1. `loadCredentials()` → account id (fail as above).
  2. `autostartWorkspaceStatuses(accountId)` → rows (empty → return a
     sentinel so the dispatcher can fall back to today's behavior; the
     registry read happens once, not twice).
  3. For each `status === "running"` row:
     `startDaemonAndRecordDesired(row.rootPath, { pullOnly: row.pullOnly })`
     — reuses the existing start path including the stale-binding restart
     logic, and refreshes the desired record's `at`. Sequential, like
     `bootResume` (spawns are detached and cheap; ordering keeps output
     readable).
  4. Collect per-row outcomes (`started | already-running | retry-later |
     failed(error)`) plus the paused/stale/mismatch rows, render the table,
     set the exit code.
- `main-dispatch.ts` `case "start"`: replace the `else if TTY … else throw`
  tail with: rows exist → `resumeKnownWorkspaces()`; rows absent → existing
  TTY front door / `workspaceRequiredError`. Reject `--pull-only` before
  entering fleet mode.
- `help-registry.ts` `start` entry: usage stays `rbox start [path]
  [--pull-only]`; replace the current note with two: outside a workspace
  with known workspaces → resumes background sync for all of them (paused
  ones stay paused); with none → guided setup (TTY).
- `bootResume` optionally becomes a thin wrapper over the same enumeration
  (silent, no exit-code semantics) — nice-to-have unification, not required.

### Tests

Extend `autostart-cmd.test.ts` (the `recordDesired` fixture helper already
exists):
- resumes desired-running rows only; stopped/stale/mismatch untouched and
  reported with reasons.
- idempotent second run → all `running`, exit 0.
- `retry-later` and thrown start errors → non-zero exit, other rows still
  attempted (one bad workspace must not strand the rest).
- empty registry → dispatcher falls through to legacy behavior (dispatch
  test with `frontDoorImport` seam).
- `--pull-only` rejected in fleet mode; still honored with a path / in-root.
- logged-out → error before any daemon is touched.

## Contracts

- Fleet resume never flips a desired-**stopped** record to running, and
  never writes desired records for rows it did not start.
- `rbox start` inside a workspace, and with an explicit path, behave exactly
  as today (byte-identical desired records).
- Registry-empty behavior is byte-identical to today (new-user onboarding
  path unchanged).
- A failure on one row never prevents attempting the remaining rows.

## Non-goals

- Symmetric `rbox stop` outside a workspace ("stop everything"). Plausible
  follow-up, but stop-all is a bigger hammer with different safety
  considerations (mass desired-record rewrite); out of scope here.
- Any change to autostart enablement, `bootResume` scheduling, or
  `rbox upgrade` restart policy.
- A picker UI. The interactive front door (bare `rbox`) remains the menu
  surface; `rbox start` stays imperative.

## Open decisions (resolve in review)

1. **TTY parity**: fleet resume on TTY replaces the guided front door
   whenever the registry is non-empty. Lean: yes — `rbox` (bare) keeps the
   menu, `rbox start` should act, and TTY/non-TTY divergence in what a
   command *does* (not just how it prompts) is a support-burden generator.
2. **All-paused fleets**: when every row is desired-stopped, `rbox start`
   starts nothing and says why. Accept, or treat "user typed start and
   nothing started" as grounds for a confirm prompt on TTY ("resume all 3
   paused workspaces? [y/N]")? Lean: accept v1 as-is; a prompt reintroduces
   TTY divergence and the table already shows the exact commands.
3. **Table verbosity**: always print all rows, or only actioned rows plus a
   one-line summary of skips? Lean: all rows while fleets are small (the
   registry is bounded by workspaces-per-machine); revisit if it scrolls.
4. **`--json`**: add machine-readable output for the fleet table now or when
   asked? Lean: later; keep v1 surface minimal.
