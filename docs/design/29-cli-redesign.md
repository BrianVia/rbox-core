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
  deps drift [path]           is this folder's install stale vs. its lockfile?
  deps notify <install|uninstall|status|on|off>   shell-hook drift notifications

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
rbox untrack [path] [--force] [--purge-remote]
```

Resolves the workspace root (like every path command), then **locally unbinds** it:
1. If a background-sync daemon is running for this root → `stopDaemon(root)` first.
2. Remove the `.rbox/` directory (config + state) for that root.
3. Print what happened and that **local files are untouched** and the **remote workspace still
   exists** (other machines keep syncing; manage/delete it from the dashboard).

Interactive runs confirm first (`Stop syncing ~/code/myapp? Local files stay. [y/N]`); `--force` skips
the prompt for scripts. `untrack` is deliberately **local-only by default** — it never deletes remote
data or revokes the device.

**`--purge-remote` (explicit opt-in — founder-approved):** additionally deletes the *remote* workspace
for the whole account. This is destructive across **every** machine tracking that workspace, so it
double-confirms even under `--force` (printing the workspace id + a "this removes it everywhere, on
all machines" warning) and requires the operator to type the workspace id to proceed. Omitting the
flag always leaves the remote intact — the safe default.

---

## Dependency-drift notifications (new feature)

The natural complement to "we sync the **lockfile**, not `node_modules`": when a manifest/lockfile
changes (you pulled a teammate's `pnpm-lock.yaml`, or switched branches), your installed dependencies
are now stale and you don't find out until something breaks at runtime. rbox should **notice and
nudge** — never silently install.

### Two tiers (founder's words)

- **(a) Full** — detect the package manager and suggest the *exact* command:
  `> dependencies changed in ./api — run \`pnpm install --frozen-lockfile\` to update.`
- **(b) Simple fallback** — manager unknown/ambiguous, a one-liner:
  `> \`Cargo.lock\` changed — re-install to get the latest dependencies.`

**Hard rule (MF5 / surprise-avoidance): rbox NEVER runs an install.** It prints a copy-pasteable
command; the human runs it. The drift check is pure `stat`/hash over local files — it never executes
anything derived from synced (untrusted) content, consistent with the `deps install` hardening
(`hydrate-cmd.ts` header).

### Detection signal — staleness without an install hook

We don't try to intercept every `npm install`. The robust, self-correcting signal is **lockfile
content vs. the manager's install-output marker**:

> A folder is **drifted** if its manifest+lockfile content-hash differs from what the install marker
> reflects — concretely, the lockfile is newer than (or hashes differently from) the marker the
> manager writes when it installs.

Once the user runs the suggested command, the marker updates and the warning stops on its own — no
state to manually clear. A small **global** dedupe store (`~/.config/rbox/deps-state.json`, see open
Q 3) records, per absolute folder, the last lock-hash we *notified* for plus a `lastCheckedMtime`, so
we nag **at most once per (folder, lock-hash)** and can skip the check entirely when nothing changed.

### Manager-detection matrix

Checked in this order; first manifest present wins for the "full" tier (multiple distinct ecosystems
in one folder are all reported — see monorepos):

| Ecosystem | Manifest + lock watched | Install marker (freshness anchor) | Full-tier command |
|---|---|---|---|
| pnpm | `package.json` + `pnpm-lock.yaml` | `node_modules/.modules.yaml` | `pnpm install --frozen-lockfile` |
| yarn (berry) | `package.json` + `yarn.lock` + `.yarnrc.yml` | `node_modules/.yarn-state.yml` | `yarn install --immutable` |
| yarn (classic) | `package.json` + `yarn.lock` | `node_modules/.yarn-integrity` | `yarn install --frozen-lockfile` |
| npm | `package.json` + `package-lock.json` | `node_modules/.package-lock.json` | `npm ci` (lock present) else `npm install` |
| bun | `package.json` + `bun.lockb` | `node_modules/.bun-tag` | `bun install` |
| Cargo | `Cargo.toml` + `Cargo.lock` | `target/` mtime (or `~/.cargo` fetch) | `cargo fetch` (or `cargo build`) |
| Go | `go.mod` + `go.sum` | `go.sum` vs. module cache touch | `go mod download` |
| uv | `pyproject.toml` + `uv.lock` | `.venv/` | `uv sync` |
| Poetry | `pyproject.toml` + `poetry.lock` | `.venv/` / poetry env | `poetry install` |
| Pipenv | `Pipfile` + `Pipfile.lock` | `.venv/` | `pipenv sync` |
| pip | `requirements*.txt` | `.venv/` (best-effort) | `pip install -r <file>` |
| Bundler | `Gemfile` + `Gemfile.lock` | `vendor/bundle` / `.bundle` | `bundle install` |
| Composer | `composer.json` + `composer.lock` | `vendor/` | `composer install` |

Package-manager selection reuses the existing detection engine (`detectProjects` / `hydrateArgv`,
design 08) — the same matrix that powers `deps install`, so drift and `deps install` never disagree on
which manager owns a folder. Where the marker can't be located reliably (notably bare `pip`), we fall
to **tier (b)**.

### Surfaces (all opt-in)

1. **`setup` prompt** — after Step 3, ask once: `Be notified when dependencies change? [Y/n]`. Yes →
   installs the shell hook for the detected shell (consent captured in the flow).
2. **`install.sh`** — after install, detect the shell and **prompt** before appending the hook to the
   rc; in non-interactive installs it appends **only** with an explicit `--with-dep-notify` (or
   `RBOX_DEP_NOTIFY=1`). Never silent.
3. **Post-sync nudge** — when a `sync`/`pull` writes a changed manifest/lockfile into the current
   workspace, print the same one-line drift notice immediately (no hook needed; this is the cheap,
   always-available half).

### The shell hook (kept cheap)

The rc file gets **one stable line** inside fenced markers, sourcing a generated, rbox-managed
snippet so `rbox upgrade` can update the logic without re-editing the rc:

```sh
# >>> rbox dep-drift >>>
[ -f "$HOME/.config/rbox/hook.zsh" ] && source "$HOME/.config/rbox/hook.zsh"
# <<< rbox dep-drift <<<
```

The snippet's `chpwd`/`PWD`-change handler does a **pure-shell pre-filter first** — a handful of
`[[ -f package.json || -f Cargo.lock || -f go.mod || … ]]` tests (microseconds, no fork). Only when a
known manifest is present does it spawn `rbox deps drift --quiet`, which is a no-network, no-auth local
`stat`+hash that prints at most one line and self-debounces via `lastCheckedMtime` (skips the hash if
the lockfile mtime is unchanged since the last check). Target budget: **< ~15 ms** on a relevant `cd`,
**~0** (one shell test) on the overwhelming majority of `cd`s into manifest-free dirs.

Per-shell wiring (shell resolved from `$SHELL`, falling back to `ps -p $PPID -o comm=`):
- **zsh:** `autoload -Uz add-zsh-hook; add-zsh-hook chpwd __rbox_dep_drift`
- **bash:** no `chpwd` — a `PROMPT_COMMAND` guard that runs the check only when `$PWD` differs from a
  cached value (so it's not per-prompt).
- **fish:** `function __rbox_dep_drift --on-variable PWD; …; end` in `config.fish`.

### Disable / uninstall

- **Instant toggle (no rc edit):** `rbox deps notify off` flips a flag in the global state; the hook
  reads it and no-ops. `rbox deps notify on` re-enables.
- **Full removal:** `rbox deps notify uninstall` deletes the fenced marker block from the rc and the
  generated snippet. The markers make removal exact and idempotent.
- **Per-repo opt-out:** `RBOX_NO_DRIFT=1` in the environment, or a `noDrift` flag in the workspace's
  `.rbox` config, suppresses notifications for that tree.

### Multiple managers & monorepos

- **Multiple ecosystems in one folder** (e.g. `package.json` + `Cargo.toml` + `go.mod`): each is
  checked; drifted ones are listed, capped at the top 3 to avoid a wall of text — `… and N more`.
- **Monorepos:** the check walks **up** from `$PWD` to the nearest manifest and to the workspace/git
  root (a bounded walk — never a recursive descent into every package, which would blow the cd
  budget). A pnpm/cargo workspace's root lock is the freshness anchor; entering a sub-package reports
  the root drift once. (Open Q 2 covers whether per-sub-package granularity is worth the cost later.)

### Command surface additions (under the `deps` group)

| Command | Purpose |
|---|---|
| `rbox deps drift [path] [--quiet]` | run the drift check now; `--quiet` is the hook's one-line mode |
| `rbox deps notify <install\|uninstall\|status\|on\|off>` | manage the shell hook + the instant toggle |

Both join the DEPENDENCIES group in the help registry.

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
6. Dependency-drift: a pure drift-check fn (manager matrix + marker/hash compare) reusing
   `detectProjects`; `deps drift`/`deps notify` commands; the rc-snippet generator + shell detection;
   the `setup` prompt; the `install.sh` consent step; and the post-sync nudge in `sync.ts`.
7. Update `README` design index + rbox.to copy as a release step.

---

## Resolved (founder review — 2026-06-30)

- **`hydrate`/`detect`/`doctor` → `deps install` / `deps list` / `deps check`.** Approved; keep
  `install`.
- **Keep `start`** (not `watch` / `sync --background`).
- **`init` kept for CI but hidden from the main help** — documented only under `rbox help init`.
- **`untrack` is local-only by default; `--purge-remote` is the explicit, double-confirmed opt-in.**
- **Deprecation window: aliases warn until `v0.3`.**
- **Per-command `--help` via the static help registry** (as proposed above).
- **`setup` Step 3 = start *background* sync** (`rbox start`); the one-shot populate-sync runs inside
  Step 2. (Confirmed by approving the flow.)

## Open questions for the founder

1. **Billing grouping.** Leave `subscribe`/`billing` as top-level verbs, or group them
   (`rbox billing <subscribe|portal|status>`) for symmetry with `device`/`account`/`key`? (Low stakes;
   default = leave as-is.)
2. **Dep-drift hook scope (new — see §"Dependency-drift notifications").** Per-folder check on `cd`
   only, or also a one-shot nudge printed right after a `sync`/`pull` that changed a manifest? (Design
   below does both; the post-sync nudge is cheap, the `cd` hook is the always-on surface.)
3. **Dep-drift state store location.** Per-workspace `.rbox/deps-state.json` (travels with the repo,
   but only covers tracked folders) vs. a global `~/.config/rbox/deps-state.json` (covers *any* folder
   you `cd` into, even untracked ones). Design below recommends the **global** store so the hook works
   everywhere; confirm that's acceptable (it means a small global file outside any workspace).
