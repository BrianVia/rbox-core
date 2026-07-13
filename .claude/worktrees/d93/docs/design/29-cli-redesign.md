# §29 — CLI command redesign (`rbox start` / `setup`, `track`/`untrack`, per-command `--help`)

> **Status: 🟢 DESIGN — founder-approved + codex-reviewed → PASS (rounds 1–3; NEEDS-WORK → all
> findings resolved, see "Codex review resolutions"). Ready for implementation.**
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
| `link <path> [--workspace <id>]` | **`track <path> [--workspace <id>]`** | renamed | **exact `link` behavior** — bind-only (create/join workspace + write config; **no** first sync). First sync happens via `setup`, `sync`, or `start`. Kills the `account link` collision |
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
  track <path> [--workspace <id>]   bind a directory to a workspace (create/join; no first sync)
  untrack [path] [--force]    stop syncing a directory
  ignore <glob> | --list      manage .rboxignore

DEPENDENCIES
  deps install [path] [--allow-build] [--only <id>] [--manager <m>]   rebuild deps from synced lockfiles
  deps list [path] [--manager <m>]      list rebuildable projects (lockfiles found)
  deps check [path]           check this host is ready to rebuild deps
  deps drift [path]           did this folder's lockfile change since rbox last saw it?
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
       ✓ This machine is authorized — but NOT yet enrolled for encryption.
       ⚠  Device-code login can't carry your key. Setup STOPS here (it does not write a
          workspace binding it can't sync). Next:
            on a signed-in machine:  rbox pair        # prints a token
            here:                    rbox connect     # paste it  (or: rbox recover)
            then:                    rbox setup       # re-run — Step 2 continues
```

> Why the hard stop: `runInit` writes `.rbox` and then **aborts before first sync** if the device
> isn't enrolled (`init-cmd.ts:120`), and `login()` device-code authorizes without enrolling
> (`auth-cmd.ts:78`). So the device-code branch must NOT promise success through Steps 2–3 — it
> resolves enrollment first. The pairing-token path (`p`) enrolls inline, so it flows straight on.

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

`setup` folds `runMenu`'s "set up" and "connect" options into one guided arc, so `menu-cmd.ts` is
deleted and its coverage (`menu-cmd.test.ts`) migrates to `setup`. It is **not** a strict superset: the
menu's third option, "just authorize this machine and stop," is intentionally dropped — that intent is
served directly by `rbox login` (and bare `rbox` now runs `setup`, so the authorize-only path is one
explicit command, not a menu branch).

Two reused-primitive caveats the implementation must close before `setup` ships (both are existing
behavior, not new bugs — but `setup` leans on the prompts being clean):
- **stderr invariant:** `login()`'s device-code instructions currently print to **stdout**
  (`auth-cmd.ts:66`), contradicting the "all prompts on stderr" rule. `setup` must route auth output
  through an injectable stream (or the primitives move to stderr) before the invariant holds.
- **No-echo secrets:** the bootstrap/pairing-token prompts use plain `readline`, which **echoes**
  input (`menu-cmd.ts:79`). The masked `********` shown in the script above requires a no-echo input
  helper; it's a to-build, not a given.

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

The registry also feeds the grouped screen, so the help text has a single source of truth. It can
still drift from the actual `switch` (they're separate code), so a **dispatcher↔registry parity test**
asserts every dispatched command (and group subcommand) has a non-hidden registry entry and vice
versa. This is presentation-only; no command's behavior changes.

---

## `untrack` — new behavior

```
rbox untrack [path] [--force]
```

Resolves the workspace root (like every path command), then **locally unbinds** it. `untrack` is
**local-only** — it never touches remote data or the device.

1. If a background-sync daemon is running for this root → `stopDaemon(root)`, then **poll for the
   process to actually exit** (bounded, ~5s) before touching `.rbox/`. `stopDaemon` sends SIGTERM and
   removes the pidfile immediately (`daemon-control.ts:69`), so a naive `rm` would race a daemon
   mid-write. On timeout: abort with "daemon still running — stop it and retry" (or `--force` →
   escalate to SIGKILL after the timeout).
2. **Safely** remove the binding: `lstat` `.rbox` first, **refuse if it's a symlink**, and confirm the
   realpath resolves to exactly `<root>/.rbox`. **Only after those guards pass**, recursively remove
   the whole `.rbox/` tree. (The tree is nested and evolving — `workspace.json`, `state.json`,
   `state/metrics.json`, `daemon.pid`, `daemon.log` today — so enumerating "known files" is brittle and
   would leave the workspace still tracked if any file moved; a full remove **after** the symlink/
   realpath proof is both correct and safe. The danger codex flagged was a *blind* `rm` on an
   unverified path, which the guard eliminates.)
3. Print that **local files are untouched** and the **remote workspace still exists** (other machines
   keep syncing; manage/delete it from the dashboard).

Interactive runs confirm first (`Stop syncing ~/code/myapp? Local files stay. [y/N]`); `--force` skips
the prompt for scripts.

> **Deferred — `--purge-remote`.** The founder wants an opt-in that also deletes the *remote*
> workspace. That is **out of scope for this doc**: this redesign explicitly makes no protocol/backend
> changes (header), and remote deletion needs a new authenticated `DELETE /v1/workspaces/:id` API,
> authorization, an audit trail, and defined semantics for other machines still tracking it. Tracked
> as a **separate backend design**; until then `untrack` is local-only and the dashboard is the path
> to delete a workspace.

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

### Detection signal — honest staleness, no marker-format guessing

We do **not** try to intercept every `npm install`, and we do **not** claim to read each manager's
internal install marker (those markers don't generally encode the source-lock hash — npm's hidden
lockfile tracks the `node_modules` *tree*, cargo/go install into a *global* cache with no local
artifact at all). The primary signal is deliberately simpler and manager-agnostic:

> A folder is flagged when its **lockfile content-hash differs from the hash rbox last recorded for
> that folder**. In plain terms: *"this lockfile changed since you last saw it here."* That is the
> exact, provable claim — and it's the one we put in the notice.

- **State:** a small **global** store (`~/.config/rbox/deps-state.json`, see open Q 3) maps absolute
  folder → `{ lockHash, lastCheckedMtime, dismissedHash }`. We record the new hash **only after we
  notify**, so each lockfile change nudges **at most once** per folder; `lastCheckedMtime` lets the
  check early-exit (no hash) when the lockfile's mtime is unchanged.
- **Optional suppressor (false-positive guard), only where it's cheap and real:** for managers whose
  engine rule has a **local** `installDir` (`node_modules` / `.venv` / `vendor/bundle`), we *suppress*
  the notice if that dir's mtime is newer than the lockfile's — a "looks freshly installed" heuristic.
  Cargo and Go install into a **global cache** (`installDir: null` in the engine), so they have **no**
  local suppressor and rely on the lock-hash signal alone.
- **Honest wording:** the notice says "lockfile changed — re-install to update," never "your install
  is provably stale," because we can't prove the latter without running the manager. False negatives
  (you changed the lock but we miss it) are acceptable — this is a nudge, not a guarantee.

### Manager-detection matrix (generated from the engine, not hand-maintained)

Tier-(a) detection and the suggested command are **generated from the shipped engine rule table**
(`ECOSYSTEM_RULES` in `engine/detect.ts`, via `detectProjects`) — the same table that powers
`deps install` — so drift and `deps install` can never disagree on which manager owns a folder or what
command to run. The full-tier command is exactly the engine's `baseArgs`:

| Engine rule | Manifest + lockfile(s) | Local `installDir` (suppressor) | Full-tier command (`baseArgs`) |
|---|---|---|---|
| `node/pnpm` | `package.json` + `pnpm-lock.yaml` | `node_modules` | `pnpm install --frozen-lockfile` |
| `node/yarn` | `package.json` + `yarn.lock` | `node_modules`† | `yarn install --immutable` |
| `node/bun` | `package.json` + `bun.lock` / `bun.lockb` | `node_modules` | `bun install --frozen-lockfile` |
| `node/npm` | `package.json` + `package-lock.json` / `npm-shrinkwrap.json` | `node_modules` | `npm ci` |
| `rust/cargo` | `Cargo.toml` + `Cargo.lock` | — (global cache) | `cargo fetch --locked` |
| `go/modules` | `go.mod` + `go.sum` | — (global cache) | `go mod download` |
| `python/uv` | `pyproject.toml` + `uv.lock` | `.venv` | `uv sync --frozen` |
| `python/poetry` | `pyproject.toml` + `poetry.lock` | `.venv` | `poetry install` |
| `ruby/bundler` | `Gemfile` + `Gemfile.lock` | `vendor/bundle` | `bundle install` |

† Yarn Berry/PnP often has **no** `node_modules` (it writes `.pnp.cjs` + `.yarn/install-state.gz`);
when `node_modules` is absent the suppressor simply doesn't fire and we fall back to the lock-hash
signal — never a false "fresh."

**Tier (b)** is used for: ambiguous node dirs (multiple node lockfiles, which the engine already flags
`ambiguous` and refuses to auto-pick), and **anything outside the 9 engine ecosystems** (pip
`requirements*.txt`, Pipenv, Composer, Gradle/Maven). v1 deliberately does **not** invent a parallel
matrix for those — covering exactly the engine's ecosystems keeps drift and `deps install` in
lockstep. Tier (b) just says "`<lockfile>` changed — re-install to get the latest dependencies," with
no command. (Extending tier-(b) to a small extra watchlist is a later, additive change.)

### Surfaces (all opt-in)

1. **`setup` prompt** — after Step 3, ask once: `Be notified when dependencies change? [Y/n]`. Yes →
   installs the shell hook for the detected shell (consent captured in the flow).
2. **`install.sh`** — after install, detect the shell and **prompt** before appending the hook to the
   rc; in non-interactive installs it appends **only** with an explicit `--with-dep-notify` (or
   `RBOX_DEP_NOTIFY=1`). Never silent.
3. **Post-sync nudge** — when a `sync`/`pull` writes a changed manifest/lockfile into the current
   workspace, print the same one-line drift notice immediately (no hook needed; this is the cheap,
   always-available half).

### Surface priority — post-sync nudge is primary, the `cd` hook is secondary

A Node/Bun CLI **cold start on every relevant `cd` cannot be promised to be invisible**, so the
**post-sync nudge (surface 3) is the primary, always-available surface** — it's free (we already have
the process open and just wrote the changed lockfile) and needs no shell integration. The `cd` hook is
an *optional enhancement* for people who change deps outside rbox (branch switches, manual edits), and
it is built to **never add latency to the prompt** (below). If the perf budget can't be met in
benchmarking, the hook ships disabled-by-default and the post-sync nudge stands alone.

### The shell hook (cheap + safe)

The rc file gets a small fenced block (rbox-managed, so `rbox upgrade` can update it) that **verifies
the snippet before sourcing it** — the tamper check has to live in the rc itself, because the file
being sourced is exactly the thing an attacker could replace. The check (regular file, **not a
symlink**, owned by the current user, **not group/world-writable**) runs *before* `source`, so a
swapped/symlinked `hook.zsh` is ignored rather than executed:

```sh
# >>> rbox dep-drift >>>
__rbox_hook="$HOME/.config/rbox/hook.zsh"
if [ -f "$__rbox_hook" ] && [ ! -L "$__rbox_hook" ] && [ -O "$__rbox_hook" ]; then
  # reject group/world-writable: mask 022 must be clear (stat format differs per OS;
  # rbox writes the OS-correct stat invocation at install time)
  __rbox_perm=$(stat -f '%Lp' "$__rbox_hook" 2>/dev/null || stat -c '%a' "$__rbox_hook" 2>/dev/null)
  [ $(( 0${__rbox_perm:-777} & 022 )) -eq 0 ] && . "$__rbox_hook"
fi
unset __rbox_hook __rbox_perm
# <<< rbox dep-drift <<<
```

**Performance — the prompt is never blocked.** The handler does a **pure-shell prefilter** first (a
handful of `[[ -f package.json || -f Cargo.lock || -f go.mod || … ]]` builtins — no fork, the ~0-cost
common case for manifest-free dirs). Only when a manifest is present does it spawn the check
**detached/async** (`&`, output buffered to print before the *next* prompt), so the CLI cold start is
off the critical path. It's **throttled** (skip if this folder was checked within N seconds, via
`lastCheckedMtime`) and the bounded monorepo up-walk happens **inside** the spawned process, not in the
shell. No hard millisecond promise; the contract is "the synchronous shell cost is the builtin
prefilter only."

**Security — no workspace PATH-hijack, no `eval`.** Hydration already rejects workspace-local
executables (`hydrate-cmd.ts:39`); the hook must hold the same line. So the generated snippet:
- invokes the **absolute installed binary path** (e.g. `$HOME/.rbox/bin/rbox`) baked in at install
  time — **never** a bare `rbox` resolved through `$PATH` (a repo could ship a `./rbox`);
- is **verified by the rc block before it is `source`d** (regular file, not a symlink, owned by the
  user, not group/world-writable — the guard shown above), so a swapped/symlinked `hook.zsh` is never
  executed. The check must be in the rc, not in `hook.zsh`, since `hook.zsh` is the file at risk;
- uses **no `eval`** and passes no repo-derived string to a shell; the check itself is no-network,
  no-auth, pure `stat`+hash over the lockfile.

Per-shell wiring (shell resolved from `$SHELL`, falling back to `ps -p $PPID -o comm=`):
- **zsh:** `autoload -Uz add-zsh-hook; add-zsh-hook chpwd __rbox_dep_drift`
- **bash:** no `chpwd` — a `PROMPT_COMMAND` guard that runs the check only when `$PWD` differs from a
  cached value (so it's not per-prompt), spawning detached as above.
- **fish:** `function __rbox_dep_drift --on-variable PWD; …; end` in `config.fish`.

### Disable / uninstall

- **Instant toggle (no rc edit):** `rbox deps notify off` flips a flag in the global state; the hook
  reads it and no-ops. `rbox deps notify on` re-enables.
- **Full removal:** `rbox deps notify uninstall` deletes the fenced marker block + generated snippet.
  Because a user may have installed the hook in several shells (or switched shells), `notify install`
  **records every rc file it touched** in the global state; `uninstall` enumerates and cleans **all**
  of them (and `notify status` lists where hooks are installed). The markers make each removal exact
  and idempotent.
- **Per-repo opt-out:** `RBOX_NO_DRIFT=1` in the environment, or a `noDrift` flag in the workspace's
  `.rbox` config, suppresses notifications for that tree.

The global state file (`~/.config/rbox/deps-state.json`) is written `0600`, created with the rbox
config dir, updated via **atomic write** (temp + rename) to survive concurrent shells, and stores only
absolute folder paths + lock-hashes locally — it is **never** synced or sent to the server (it lives
outside any workspace; see open Q 3 on the privacy trade-off of a global path list).

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
6. Dependency-drift: a pure drift-check fn (engine-`ECOSYSTEM_RULES` matrix; signal = lockfile-hash vs.
   the hash last recorded for the folder, with an optional local install-dir mtime suppressor) reusing
   `detectProjects`; `deps drift`/`deps notify` commands; the verified rc-snippet generator + shell
   detection; the `setup` prompt; the `install.sh` consent step; and the post-sync nudge in `sync.ts`.
7. Update `README` design index + rbox.to copy as a release step.

---

## Resolved (founder review — 2026-06-30)

- **`hydrate`/`detect`/`doctor` → `deps install` / `deps list` / `deps check`.** Approved; keep
  `install`.
- **Keep `start`** (not `watch` / `sync --background`).
- **`init` kept for CI but hidden from the main help** — documented only under `rbox help init`.
- **`untrack` is local-only.** The founder-approved `--purge-remote` is **deferred to a separate
  backend design** (remote workspace deletion needs a new API + authz + audit, out of scope here —
  codex BLOCKER 5). The intent is recorded; the safe local-only behavior ships now.
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
   you `cd` into, even untracked ones). Design recommends the **global** store so the hook works
   everywhere; confirm that's acceptable (it means a small global file outside any workspace).

---

## Codex review resolutions (round 1 → all resolved)

> Codex adversarial review, 2026-06-30 → **VERDICT: NEEDS-WORK** (5 BLOCKER, 8 MAJOR, 4 MINOR). Every
> finding was accepted and resolved in-doc — none were "won't fix." Summary + disposition below.

**BLOCKERS**
- **B1 — `track` ≠ a clean rename of `link`.** Today `link` is bind-only (no first sync); `runInit`
  does the syncing. Fixed: `track` is documented as the **exact, bind-only** `link` behavior; first
  sync happens via `setup`/`sync`/`start`. Help text and table corrected.
- **B2 — `setup` device-code path was broken.** Device-code login authorizes but doesn't enroll, and
  `runInit` aborts pre-sync if unenrolled (`init-cmd.ts:120`). Fixed: the "approve a code" branch now
  **hard-stops** with pair/connect/recover next steps before Step 2; only the (enrolling) pairing-token
  path flows straight through.
- **B3 — drift matrix didn't match the shipped engine.** Fixed: the matrix is now **generated from
  `ECOSYSTEM_RULES`** (9 ecosystems, exact lockfiles incl. `bun.lock`, exact `baseArgs` like
  `cargo fetch --locked` / `uv sync --frozen`); pip/Pipenv/Composer dropped to tier-(b)-only; Yarn
  Berry/PnP (no `node_modules`) handled.
- **B4 — staleness signal overclaimed.** Fixed: primary signal reframed to "**lockfile hash changed
  since rbox last saw it here**" (provable, manager-agnostic); install-dir mtime is only an optional
  *suppressor* where a local `installDir` exists; cargo/go (global cache) rely on the hash alone;
  wording says "lock changed," not "install stale."
- **B5 — `--purge-remote` out of scope.** Fixed: **deferred to a separate backend design** (needs a
  new authenticated workspace-delete API + authz + audit). `untrack` ships local-only.

**MAJORS**
- **M1 — hook PATH-hijack.** Fixed: snippet invokes the **absolute** installed binary, refuses
  tampered (symlink / non-owner / group-or-world-writable) hook files, no `eval`.
- **M2 — `<15 ms` budget not credible.** Fixed: **post-sync nudge is now the primary surface**; the
  `cd` hook runs **detached/async** (never blocks the prompt), throttled, with the up-walk inside the
  spawned process; hard-ms claim dropped; hook ships off-by-default if benchmarks fail.
- **M3 — `setup` "strict superset" false.** Fixed: claim dropped; the menu's "just log in" intent is
  served by `rbox login` directly.
- **M4 — stderr invariant vs. stdout device-code prints.** Fixed: documented as an implementation
  caveat — auth output must route through an injectable stream (or move to stderr) before the invariant
  holds.
- **M5 — secret prompts echo.** Fixed: documented that the masked prompts require a **no-echo input
  helper** (readline echoes by default) — a to-build, not a given.
- **M6 — `untrack` blind `rm -rf .rbox`.** Fixed: `lstat` + refuse symlink + realpath-confirm
  `<root>/.rbox`, **then** recursively remove the verified tree (the `.rbox` layout is nested/evolving
  — `workspace.json`, `state/metrics.json`, … — so a guarded full remove beats brittle enumeration;
  refined in round 2).
- **M7 — `untrack` races a live daemon.** Fixed: stop, then **poll for exit** (bounded) before
  removing `.rbox`; `--force` escalates to SIGKILL after timeout.

**MINORS** — all applied: (m1) help now shows `--only`/`--manager`; (m2) added a
**dispatcher↔registry parity test** and softened the "can't drift" claim; (m3) `notify install`
records every rc it touched so `uninstall`/`status` cover all shells; (m4) global state documented as
`0600`, atomic-write, never synced.

### Round 2 (3 residual MAJORs → resolved)

- **M1 (reopened) — rc sourced `hook.zsh` *before* the tamper check.** The verification lived inside
  the file being sourced. Fixed: the **rc block itself** now verifies (not-a-symlink, owner-only,
  `& 022 == 0`) *before* `. hook.zsh`; a swapped/symlinked snippet is never executed.
- **B4 (residual) — two leftover overclaims.** Fixed: the `deps drift` help line now reads "did this
  folder's lockfile change since rbox last saw it?" and the implementation sketch says "lockfile-hash
  vs. last-recorded hash (+ optional install-dir mtime suppressor)" — no more "stale install" /
  "marker/hash compare" wording.
- **M6 (residual) — wrong/incomplete delete list.** The known-file list named `config.json` (actual:
  `workspace.json`, `config.ts:43`) and missed nested `state/metrics.json` (`metrics.ts:25`). Fixed:
  guard first, then recursively remove the verified `.rbox/` tree.

> Round-2 also confirmed B1/B2/B3/B5/M2 substantively resolved and M3/M4/M5/M7 standing. The only
> remaining items are normal implementation-time concerns (daemon PID-capture API for M7's exit-poll),
> not design gaps.
