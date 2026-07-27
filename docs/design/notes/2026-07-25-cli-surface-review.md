# rbox CLI surface — ruthless decision memo

Date: 2026-07-27

Reviewed against: `3b685d5d0`

## Decision

For Max's `start`/`stop` confusion, the main defect is the default help screen,
not the command model.

Keep one workspace-local contract with an optional path, plus an explicit
aggregate status:

```text
rbox status [PATH]   show one workspace (default: cwd; outside one: all)
rbox status --all    show every locally known workspace
rbox sync [PATH]     sync that entire workspace once
rbox start [PATH]    start background sync for that workspace
rbox stop [PATH]     stop background sync for that workspace
rbox logs [PATH]     show background-sync logs for that workspace
```

`PATH` is a **workspace locator**, not a subdirectory scope. For example,
`rbox sync ./src` syncs the entire workspace containing `./src`.

Today `start` has one exception: with no path, outside a workspace, on a TTY,
it opens the adaptive front door. Remove that overload. `start` should either
resolve one workspace or fail with guidance to run bare `rbox`.

Put these signatures on the default `rbox --help` screen. They already exist in
the command-specific help; the default screen drops the arguments and creates
the ambiguity Max hit.

## What to change

### 1. Fix the first help screen before renaming anything

Today the default screen shows bare words:

```text
start  begin background sync for this workspace
stop   stop background sync
sync   sync once, right now
```

Show the actual shape and make the scope symmetric:

```text
status [PATH]  show one workspace; outside a workspace, show all
sync [PATH]    sync the entire workspace containing PATH once
start [PATH]   start background sync for the workspace containing PATH
stop [PATH]    stop background sync for the workspace containing PATH
logs [PATH]    show logs for the workspace containing PATH
```

This is the smallest change that directly fixes the reported confusion.

### 2. Do not require `PATH`

Reject the proposal to require a path for every `sync`.

- The current directory is a normal, useful CLI default, as it is for Git.
- Scripts can already pass an explicit path when they should not depend on cwd.
- Requiring `PATH` adds typing without changing the operation: it still selects
  the enclosing workspace, not a narrower sync scope.

The contract should be: optional for humans, explicit in automation.

### 3. Add a system-level status

`rbox status` must also be useful from a home directory, filesystem root, or
any other location outside a workspace:

```text
rbox status [PATH]  one workspace when PATH or cwd resolves; otherwise all
rbox status --all   every locally known workspace, from anywhere
```

For the human-friendly no-argument form:

- inside a workspace, show that workspace;
- outside a workspace, show all locally known workspaces.

Automation that needs stable aggregate semantics should use `--all` explicitly.
`--all` and `PATH` are mutually exclusive.

The aggregate view should include each workspace's name, local root, binding
health, daemon running/stopped state and mode, last successful sync, pending
work, and highest-priority problem. It needs both a concise table and a
structured `--json` form.

This is a real feature, not help copy. Arbitrary workspace roots cannot be
enumerated reliably by scanning the filesystem, and the daemon/autostart
records do not cover every stopped binding. rbox therefore needs a durable
local binding registry maintained by every create/join/track/init/setup and
untrack path. Aggregate status must tolerate stale or missing roots and report
them rather than silently dropping them.

### 4. Remove `setup` from the primary vocabulary

Max is right about `setup`: the name says nothing, and the implementation is
two interfaces sharing one token:

- a TTY-only guided account/workspace/billing/start flow;
- a keyed, headless workspace materialization flow selected by
  `--workspace` plus key input.

The adaptive product front door is already available: bare `rbox`. In a tracked
directory it offers workspace actions; in an enrolled but untracked directory
it offers create/join actions; otherwise it enters onboarding.

Recommended direction:

- document bare `rbox` as the adaptive product front door;
- keep `rbox init` as the scriptable/CI form;
- hide `rbox setup` from primary help and retain it temporarily as a
  compatibility alias;
- design the keyed materialization flow separately instead of pretending it is
  a vocabulary-only move into `init`.

Keyed setup currently materializes an agent key bundle, resolves a workspace by
name or id, chooses or creates a target directory, forces the first operation to
pull-only, and may start a daemon. Current `init` has different credential,
target-directory, and first-sync semantics. Unifying them requires an explicit
security and behavior design.

Do not rename the wizard to another vague verb. The user does not need to type a
verb for the product’s front door.

### 5. Do not add `auth` without testing it

`rbox auth login` is tidy in isolation, but an `auth` namespace does not simplify
the wider identity model (`pair`, `connect`, recovery, keys, devices, and account
linking). It adds hierarchy and keystrokes without yet proving that it removes
confusion.

Keep top-level `login` and `logout` for now. Test the namespace as a
discoverability hypothesis rather than treating it as an obvious cleanup.

### 6. Do not rename `untrack` to `unsync` yet

`stop` and `untrack` are intentionally different:

- `stop` pauses the workspace daemon but keeps the binding;
- `untrack` stops the daemon and removes the local binding while leaving local
  files and the remote workspace intact.

`unsync` sounds like either operation and may also sound like remote deletion.
`remove` is worse.

Keep `untrack` as a secondary command for now and make its help explicit:

```text
rbox untrack [PATH]  forget this workspace on this machine;
                     local files and the remote workspace stay
```

If user testing still rejects the term, choose a replacement only after testing
the full confirmation copy—not the verb alone.

### 7. Keep `doctor` as the diagnostic layer

`status`, `doctor`, and repair commands answer different questions:

```text
rbox status [PATH] [--all]  Is everything okay?
rbox doctor [PATH] [--all]  What is wrong, why, and what should I run next?
domain repair command       Perform one explicit, named recovery action
```

`rbox doctor` is valuable and should remain. It already checks credentials,
encryption enrollment and device identity, daemon state, remote reachability,
version compatibility, sync-state sanity, crypto workers, workspace locking,
Git transaction capability, and manifest-chain health. Failed checks carry
fix-it hints and produce a failing exit code.

The boundaries should be:

- `status` is fast, concise, read-only, and suitable for habitual use;
- `doctor` performs deeper live probes and prints exact remediation commands;
- `doctor --all` runs bounded diagnostics across the local binding registry;
- mutation remains in explicit recovery commands such as `git resolve`,
  `recover`, or the narrowly named reset-journal recovery;
- there is no blanket `doctor --fix`: divergence can require a human choice,
  and no single default is safe.

Doctor should reuse status projections and recorded Git deferrals instead of
inventing a second definition of divergence. Its job is to expand the evidence
and route the user to the correct safe action.

For consistency with the workspace-local verbs, normalize doctor's current
`--path <dir>` input to optional positional `[PATH]`, retaining `--path` as a
compatibility alias.

## Ruthless primary surface

The default screen should optimize for the common loop, not expose the whole
implementation:

```text
GET STARTED
  rbox                 open the adaptive product front door
  rbox status [PATH]   show one workspace, or all when outside one
  rbox status --all    show all locally known workspaces

SYNC
  rbox sync [PATH]     sync once
  rbox start [PATH]    start background sync
  rbox stop [PATH]     stop background sync
  rbox logs [PATH]     show background-sync logs

ADD A MACHINE
  rbox pair
  rbox connect TOKEN

FIX
  rbox doctor [PATH]   explain what's wrong and what to run next
  rbox doctor --all    deeply check every locally known workspace

MORE
  rbox <command> --help
  rbox help --all
```

`login`, `logout`, `init`, `untrack`, billing, support-report upload, history,
trash, Git repair, shell integration, and key administration still exist. They
do not all belong on the first screen; `doctor` does because it is the universal
route from a visible problem to the correct specialist command.

## What was cut

The previous 168 KB document mixed three jobs:

1. an exhaustive 51-command implementation inventory;
2. a bug backlog;
3. a response to one user’s command-design feedback.

Only the third job belongs here. The per-command tables, unrelated flag bugs,
key-storage audit, destructive-command survey, deprecated-code archaeology, and
repeated Max-to-code mappings were removed. They obscured the decision and
created false urgency around unrelated commands.

The useful findings retained here are:

- at most one live daemon exists per local workspace root;
- the default help hides the already-implemented `[path]` signatures;
- paths locate workspaces rather than narrowing sync scope;
- no all-workspaces status or complete local binding registry exists yet;
- `setup` conflates guided and keyed/headless flows;
- `stop` and `untrack` are materially different operations.

## Implementation order

1. Update the essential help output and its snapshot tests.
2. Remove the implicit `start` → front-door overload so the signatures share
   one contract.
3. Validate the result with a new user before changing command names.
4. Remove `setup` from primary help; document bare `rbox` and `init`.
5. Design keyed materialization separately; do not fold it into `init` by
   renaming alone.
6. Add the local binding registry and implement `status --all`, including JSON
   and stale-root handling.
7. Add `doctor --all` on the same registry while keeping doctor read-only by
   default and repair actions explicit.
