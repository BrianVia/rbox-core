# §29 — CLI command redesign (`rbox start` / `setup`, `track`/`untrack`, per-command `--help`)

> **Status: 🟡 DESIGN — awaiting founder review (codex review pending, NOT yet run).**
>
> Pure UX/surface redesign of the `rbox` CLI. No protocol, crypto, or transport changes — every
> command keeps calling the same already-shipped primitives (`runInit`, `login`, `startDaemon`,
> `hydrateCmd`, …). This doc proposes **what we call things and how they're grouped**, plus two new
> behaviors (`untrack`, per-command help). Basis: `src/cli/index.ts` (dispatcher), `init-cmd.ts`,
> `menu-cmd.ts`, `auth-cmd.ts`, design 07c (onboarding TUI), design 10 (pairing), design 21 (account
> linking), design 08 (hydration).

## Problem

The founder finds several commands jargon-y or clunky, and the surface has grown organically into an
inconsistent mix of verbs and noun-groups:

1. **`daemon` leaks internal jargon.** Starting passive background sync is `rbox daemon start`. Users
   don't think "daemon"; they think "start syncing." (`index.ts:236`, `daemon-control.ts:44`.)
2. **No single, named front door.** Onboarding is split three ways: `rbox init` (flag-driven shell,
   `init-cmd.ts`), the bare-`rbox` interactive menu (`menu-cmd.ts` `runMenu`), and raw `login`. New
   users have to know which one to type. The founder wants one guided `rbox setup`.
3. **`link` collides.** `rbox link <path>` binds a directory to a workspace (`index.ts:74`), but
   `rbox account link <code>` links the CLI to a web login (`index.ts:142`, design 21). Two unrelated
   "links."
4. **No clean way to stop syncing a directory.** You can `track`/`link` but never cleanly un-bind.
5. **Help only shows on misuse.** `--help` on a specific command does nothing; help appears only via
   bare `rbox help` or an invalid invocation (`index.ts:295`).
6. **"hydrate" is opaque.** `rbox hydrate` reconstructs dependency trees from synced lockfiles
   (design 08). The founder (and most users) don't read "hydrate" as "install my deps."

## Goals / non-goals

- **Goal:** a verb-first, jargon-free surface a first-time user can guess; one guided `setup`; clean
  `track`/`untrack`; per-command `--help`; no behavior regressions for existing flows.
- **Goal:** ship behind hidden back-compat aliases so no existing script breaks on day one.
- **Non-goal:** any change to the sync engine, E2EE, transport, billing, or the `init` *planner*
  (`init-plan.ts` stays the pure core; `setup` is a new presentation layer over it).
- **Non-goal:** the deferred OpenTUI/arrow-key polish (design 07c). Numbered prompts stay zero-dep.

---

## Proposed command surface (before → after)

Grouping is for the help screen and mental model only; the dispatcher stays a flat `switch`.

### Before → after table (every current command)

| Current | New | Change | Notes |
|---|---|---|---|
| `rbox` (TTY → `runMenu`) | `rbox` (TTY → **`setup`**) | replaced | `menu-cmd.ts` absorbed into `setup` |
| `init [--new\|--workspace] [--no-interactive]` | `init …` (**kept, repositioned**) | repositioned | stays as the headless/CI entry; interactive use promoted to `setup` |
| — | **`setup`** | **new** | guided onboarding (the founder's flow, below) |
| `link <path> [--workspace <id>]` | **`track <path> [--workspace <id>]`** | renamed | kills the `account link` collision |
| — | **`untrack [path] [--force]`** | **new** | cleanly stop syncing a directory (local unbind) |
| `daemon start [path]` | **`start [path]`** | renamed | drops "daemon" |
| `daemon stop [path]` | **`stop [path]`** | renamed | drops "daemon" |
| `daemon status [path]` | folded into **`status`** | removed | `status` now reports background-sync state too |
| `daemon logs [path] [--follow]` | **`logs [path] [--follow]`** | renamed | drops "daemon" |
| `hydrate [path] [--allow-build] [--only] [--manager]` | **`deps install [path] …`** | renamed/grouped | "hydrate" dropped |
| `detect [path] [--manager]` | **`deps list [path]`** | renamed/grouped | "detect" dropped |
| `doctor [path]` | **`deps check [path]`** | renamed/grouped | "doctor" dropped |
| `status [path]` | `status [path]` | enhanced | adds a "background sync: running/stopped" line |
| `push [path]` | `push [path]` | unchanged | |
| `pull [path]` | `pull [path]` | unchanged | |
| `sync [path]` | `sync [path]` | unchanged | one-shot pull+push |
| `ignore <glob> \| --list` | `ignore <glob> \| --list` | unchanged | |
| `login [--bootstrap <secret>]` | `login [--bootstrap <secret>]` | unchanged | |
| `logout` | `logout` | unchanged | |
| `pair` | `pair` | unchanged | |
| `connect` (stdin token) | `connect` | unchanged | matches menu's "Connect this machine" |
| `recover` | `recover` | unchanged | |
| `device <approve\|list\|revoke>` | `device <approve\|list\|revoke>` | unchanged | |
| `account <link\|status\|unlink>` | `account <link\|status\|unlink>` | unchanged | collision now gone |
| `key <status\|backup>` | `key <status\|backup>` | unchanged | |
| `subscribe <solo\|pro>` | `subscribe <solo\|pro>` | unchanged | (see open Q on grouping) |
| `billing` | `billing` | unchanged | |
| `upgrade [--check]` | `upgrade [--check]` | unchanged | |
| `versions` / `restore` | `versions` / `restore` (disabled stub) | unchanged | still fail-closed under E2EE (design 12 D11) |
| `version` / `--version` / `-v` | unchanged | unchanged | |
| `help` | **`help [<command>]`** + per-command `--help` | enhanced | see "Per-command help" |
| `__daemon-run` (hidden) | `__daemon-run` (hidden) | unchanged | internal daemon loop |

### The new grouped help screen

```
rbox — dev-aware sync (end-to-end encrypted)

GETTING STARTED
  setup                       guided onboarding: account → workspace → start syncing
  login [--bootstrap <s>]     authorize this machine
  logout                      remove this machine's credential
  status [path]               workspace + background-sync state

SYNCING
  start [path]                start background sync for this workspace
  stop  [path]                stop background sync
  logs  [path] [--follow]     background-sync logs
  sync  [path]                sync once (pull, then push)
  push  [path]                upload local changes
  pull  [path]                apply remote changes
  track <path> [--workspace <id>]   sync a directory (create or join a workspace)
  untrack [path] [--force]    stop syncing a directory
  ignore <glob> | --list      manage .rboxignore

DEPENDENCIES
  deps install [path] [--allow-build]   rebuild deps from synced lockfiles
  deps list [path]            list rebuildable projects (lockfiles found)
  deps check [path]           check this host is ready to rebuild deps

DEVICES & ACCOUNT
  pair                        create a token to add another machine
  connect                     add this machine from a pasted token (stdin)
  recover                     re-enroll this machine from your recovery phrase
  device <approve|list|revoke>    manage devices
  account <link|status|unlink>    link this CLI to your web login
  key <status|backup>         encryption status / re-show recovery phrase

BILLING & MAINTENANCE
  subscribe <solo|pro>        open a checkout to subscribe this account
  billing                     open the billing portal
  upgrade [--check]           update the rbox binary
  version                     print the rbox version

Run `rbox <command> --help` for details on any command.
```

`init` is intentionally **not** in the default screen — it's the scripting/CI form of `setup`, shown
under `rbox help init` and in `--help`. (Open Q below on whether to hide it entirely.)

---

## `rbox setup` — the guided flow

`setup` is a thin presentation layer that reuses `runInit` (`init-cmd.ts`), `login`/`redeemPair`
(`auth-cmd.ts`), and `startDaemon` (`daemon-control.ts`) — exactly the primitives `runMenu` already
drives today, reorganized into the founder's three-step arc. It **replaces** `menu-cmd.ts`'s
`runMenu` and becomes what bare `rbox` runs in a TTY. Non-interactive (`!isTTY` or `--no-interactive`)
→ it prints guidance and points at `init` (never hangs waiting on stdin).

All prompts render on **stderr** (so `rbox setup > log` never pollutes stdout), matching the existing
convention in `init-cmd.ts` / `menu-cmd.ts`.

### Step-by-step interactive script

```
$ rbox setup

◆  Welcome to rbox — end-to-end encrypted sync for your dev workspaces.

── Step 1 of 3 · Account ───────────────────────────────────────────────
?  Are you new here, or do you already have an rbox account?
   › 1  Create a new account
     2  Log into an existing account
```

**Branch 1a — "Create a new account"** (genesis device; bootstrap path):
```
?  Account bootstrap secret: ********
   (No secret? Press enter to approve this machine from another signed-in one.)
   → runs login(remote, secret)  →  bootstrapNewAccount  →  shows 24-word recovery phrase
   ⚠  This recovery phrase is the ONLY way back in. There is NO escrow.
        <phrase>
   Type "yes" once you've saved it somewhere safe: yes
✓  Account created. This machine is your genesis device and is enrolled for encryption.
```

**Branch 1b — "Log into an existing account"**:
```
?  How do you want to authorize this machine?
   › p  Paste a pairing token   · from `rbox pair` on a signed-in machine — fewest steps, also enrolls encryption
     a  Approve a code          · this machine shows a code you approve elsewhere

   [p] Paste pairing token: ****************    → redeemPair()
       ✓ This machine is authorized and enrolled for encryption.
   [a] → login(remote)  (device-code flow; prints the approve code, polls)
       ✓ This machine is authorized.
       ⚠  Device-code login authorizes but does NOT enroll encryption. To read/sync
          encrypted data, run `rbox pair` on a signed-in machine and `connect` it, or `rbox recover`.
```

```
── Step 2 of 3 · Workspace ─────────────────────────────────────────────
```

**Branch 2a — no workspace tracked here yet (typical first run):**
```
Let's set up your first workspace.
?  Which directory should rbox sync?  [<cwd>]
   › ~/code/myapp
   → runInit({ new:true, root }) : createRemoteWorkspace + saveConfig + initial push
✓  Tracking ~/code/myapp  →  workspace ws_ab12cd34
```

**Branch 2b — account already has / knows workspaces** (founder: "if you already have one, choose to
sync it / add a new one"):
```
?  You're already set up elsewhere. What now?
   › 1  Track an existing workspace here   · paste its id from another machine
     2  Create a new workspace
   [1] Workspace id to join: ws_ab12cd34
       ?  Sync into which directory? [<cwd>]  → runInit({ workspace, root }) : join + initial sync
   [2] → same as Branch 2a
✓  Tracking ~/code/myapp  →  workspace ws_ab12cd34
```

> Note: the **initial** populate-sync (push for a new workspace, pull+push for a join) runs *inside*
> `runInit` here, exactly as `init` does today — so by the end of Step 2 the workspace already has
> data. Step 3 is purely about *continuous* sync.

```
── Step 3 of 3 · Start syncing ─────────────────────────────────────────
?  Keep this workspace syncing in the background?  [Y/n]  Y
   → startDaemon(root)
✓  Background sync started. Stop anytime with `rbox stop`.

──────────────────────────────────────────────────────────────────────────
✓  rbox is set up.
     workspace: ws_ab12cd34     device: dev_1a2b3c4d
     This workspace is end-to-end encrypted — the server never sees your file names or contents.

   Bring another machine online:
     rbox pair      (here — prints a token)
     rbox setup     (there — choose "Log in" → paste the token)
```

If the user answers `n` at Step 3, we skip `start` and print: `Run rbox start whenever you're ready.`

### End-state

- A `.rbox/` binding written for the chosen directory (via `saveConfig`, unchanged).
- This machine authorized + (on the pairing/bootstrap paths) E2EE-enrolled.
- An initial snapshot pushed/synced.
- Optionally, a background-sync daemon running.
- Clear next step for a second machine (`pair` here → `setup` there).

This is a strict superset of `runMenu`'s current three options ("set up / connect / just log in"), so
`menu-cmd.ts` is deleted and its test coverage (`menu-cmd.test.ts`) migrates to `setup`.

---

## Per-command `--help`

Today there's no per-command help; the dispatcher prints one big list on misuse (`index.ts:295`).
Proposal: a small static **help registry** — one entry per command, decoupled from the `switch`:

```ts
interface CommandHelp {
  name: string;          // "track"
  group: string;         // "SYNCING"
  summary: string;       // one line for the grouped screen
  usage: string;         // "rbox track <path> [--workspace <id>]"
  flags?: { flag: string; desc: string }[];
  examples?: string[];
  hidden?: boolean;      // __daemon-run, deprecated aliases
}
```

Dispatch order in `main()`:
1. If `args` contains `--help` or `-h` (for any `cmd`, including groups like `deps`/`device`) → print
   that command's help block and exit 0 **before** running it.
2. `rbox help [<command>]` → same block, or the grouped screen with no arg.
3. Bare `rbox` non-TTY, or an unknown command → grouped screen (exit 1 for unknown), as today.

The registry also feeds the grouped screen, so the help text has exactly one source of truth and can't
drift from the dispatcher. This is presentation-only; no command's behavior changes.

---

## `untrack` — new behavior

```
rbox untrack [path] [--force]
```

Resolves the workspace root (like every path command), then **locally unbinds** it:
1. If a background-sync daemon is running for this root → `stopDaemon(root)` first.
2. Remove the `.rbox/` directory (config + state) for that root.
3. Print what happened and that **local files are untouched** and the **remote workspace still
   exists** (other machines keep syncing; manage/delete it from the dashboard).

Interactive runs confirm first (`Stop syncing ~/code/myapp? Local files stay. [y/N]`); `--force` skips
the prompt for scripts. `untrack` is deliberately **local-only** — it never deletes remote data or
revokes the device. (Open Q: optional `--purge-remote`.)

---

## Back-compat & migration

**Keep every renamed command as a hidden alias for one deprecation window** (proposal: through the
next two minor releases / until `v0.3`). Aliases do the exact same work, then print a one-line
deprecation notice to **stderr** (never stdout, so piped output is unaffected):

| Old (hidden alias) | Forwards to | Stderr notice |
|---|---|---|
| `link <path>` | `track <path>` | `note: 'rbox link' is now 'rbox track'.` |
| `daemon start\|stop\|logs` | `start` / `stop` / `logs` | `note: 'rbox daemon …' is now 'rbox start/stop/logs'.` |
| `daemon status` | `status` | `note: daemon status is now part of 'rbox status'.` |
| `hydrate` | `deps install` | `note: 'rbox hydrate' is now 'rbox deps install'.` |
| `detect` | `deps list` | `note: 'rbox detect' is now 'rbox deps list'.` |
| `doctor` | `deps check` | `note: 'rbox doctor' is now 'rbox deps check'.` |

`init` is **not** deprecated — it's repositioned, not removed (CI and `setup`'s non-interactive
fallback both rely on it). It simply drops out of the default help screen.

**What breaks, and when:**
- **Day one:** nothing. Aliases cover every old name; existing shell history, READMEs, and CI keep
  working (with a stderr nudge).
- **After the window (aliases removed):** any script still calling `rbox link`, `rbox daemon start`,
  `rbox hydrate/detect/doctor` breaks. Mitigation: the deprecation notices, a CHANGELOG entry, and the
  marketing-copy switch (below) all land in the same release, giving users a full window to migrate.
- **Muscle memory:** `rbox daemon start` is the one most likely typed from memory — the alias + notice
  makes the transition obvious the first time.

---

## Marketing tie-in

Once this ships and is released, the public copy drops the jargon:

- **rbox.to hero / terminal animation:** `rbox daemon start` → **`rbox start`** (or lead with
  **`rbox setup`** to show the full guided arc). "daemon" disappears from all marketing.
- **Docs / quickstart:** the canonical first-run becomes `rbox setup`; "hydrate" becomes "rebuild your
  dependencies" / `rbox deps install`.
- **Gating:** the copy switch is tied to the release that ships the new surface (not before), so the
  site never shows a command the installed binary doesn't yet understand. The hidden aliases mean even
  users on a slightly older binary won't hit a wall if they copy `rbox start` early — wait, they
  would; so the copy flips **on release**, not at design time. (Tracked as a release checklist item.)

---

## Implementation sketch (for the post-review pass — not built here)

1. Add the help registry + `--help`/`-h` interception in `main()` (presentation only).
2. Rename dispatch cases: add `track`/`untrack`/`start`/`stop`/`logs`/`deps`; keep old names as
   hidden alias cases that forward + warn.
3. Write `setup-cmd.ts` over `runInit` + auth flows; route bare-TTY `rbox` to it; delete
   `menu-cmd.ts`; migrate `menu-cmd.test.ts` → `setup` tests (assert the branch/flag mapping, the pure
   part — not the prompt strings).
4. `untrack`: stop daemon + remove `.rbox/`, with confirm/`--force`.
5. Add a "background sync: running/stopped" line to `status` (reuse `isOurDaemon` from
   `daemon-control.ts`).
6. Update `README` design index + rbox.to copy as a release step.

---

## Open questions for the founder

1. **"start now?" semantics.** I read your "finish by prompting to start syncing → runs it" as
   **start background sync** (`rbox start`) — the initial one-shot populate-sync already happens inside
   Step 2. Is that right, or did you mean the final prompt should be the *one-shot* `sync` and
   background sync stays manual?
2. **`hydrate` replacement.** I'm proposing the `deps` group (`deps install` / `deps list` /
   `deps check`). Alternatives: keep flat verbs (`rbox install-deps`), or keep `hydrate` if it's grown
   on you. Does `deps install` read clearly, or does it falsely imply a plain `npm install`?
3. **`start` clarity.** `rbox start` is short but a touch vague ("start what?"). Acceptable, or do you
   prefer something self-describing like `rbox watch` / `rbox sync --background`? (You asked for
   `start`, so that's the default.)
4. **`init` visibility.** Keep `init` listed under `rbox help init` (current proposal), or fully hide
   it as an internal/CI-only command so `setup` is the only documented entry?
5. **`untrack` scope.** Local-only unbind (my default) — or should it offer `--purge-remote` to also
   delete the remote workspace? The latter is destructive across machines; I'd keep it dashboard-only.
6. **Deprecation window.** Two minor releases / through `v0.3` — long enough, or longer given how few
   external users there are today (we could just rename hard)?
7. **Billing grouping.** Leave `subscribe`/`billing` as top-level verbs, or group them
   (`rbox billing <subscribe|portal|status>`) for symmetry with `device`/`account`/`key`?
</content>
</invoke>
