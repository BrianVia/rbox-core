# rbox — usage guide

This guide covers command behavior, files written by the CLI, and config-file
semantics. It documents **current, shipped** behavior; proposed behavior is
called out with its design doc.

## 1. Getting started

```bash
rbox                 # no args: guided menu (sync now / start background syncing / add another synced folder / pair another device / view usage / view logs)
rbox setup           # guided setup for a synced folder, named directly
```

Scriptable/CI equivalents (never prompt, never need a TTY):

```bash
rbox init --new --bootstrap <secret>          # first device on a new account
rbox init --workspace <id> --no-interactive   # join an existing workspace
```

`rbox init` is the scripting form of `setup` — same underlying plan resolver
(`resolveInitPlan`, `src/cli/init-plan.ts`), flag-driven instead of
prompted. Every interactive prompt has a corresponding flag; `--no-interactive`
fails fast (with a hint) instead of hanging on a missing prompt when there's no
TTY.

`NO_COLOR=1` / `FORCE_COLOR=1` are honored everywhere.

Exit codes are intentionally small and stable: `0` means ok, `1` means error,
and `130` means user cancel (Ctrl-C).

## 2. What `rbox init` does

1. **Auth.** Bootstrap-login (`--bootstrap <secret>`, headless-safe) or
   device-code login (interactive-only; never started in CI).
2. **Workspace.** Creates a new remote workspace, or adopts an existing
   workspace id you're joining (access is validated on first sync).
3. **Local binding.** Writes `.rbox/workspace.json` — see §3. It also records
   the folder in `~/.rbox/config.json`, the machine-wide authority for which
   folders rbox may sync and with what options (design 231); a binding rbox
   cannot find there is not admitted. See §3.
4. **Rebind guard.** If this directory was already bound to a *different*
   workspace, the local sync baseline is reset (files on disk are untouched)
   rather than silently reconciling against a stream it doesn't belong to —
   the guard exists because skipping it caused a real mass-delete incident
   (design 44).
5. **First sync.** Either an initial push (new workspace) or a full sync
   (joining an existing one).

Nothing about `rbox init` currently writes `.rboxignore` or any `rbox.yml` —
see §5 and §6.

## 3. Config files — what owns what

Two files matter, and they own different things (design 231).

### 3a. `~/.rbox/config.json` — the folder authority, per machine

`~/.rbox/config.json` (`src/cli/folder-config-codec.ts`) is the **sole
authority** for which folders this machine intends to sync and what options
apply to them. It is meant to be read, and hand-edited, by you. It is never
synced.

```jsonc
{
  "schemaVersion": 1,
  "globalOptions": { "syncGit": true, "trash": { "days": 30 } },
  "folders": [
    { "name": "code", "path": "/Users/me/code" },
    { "name": "notes", "path": "/Users/me/notes", "options": { "syncGit": false } }
  ]
}
```

Options resolve **field by field**: a folder's own value wins, then
`globalOptions`, then the built-in default (`resolveFolderPolicy`,
`src/cli/folder-config-codec.ts:282`). `false` and `0` are real values, never
"inherit". The options it owns are `syncGit`, `git.incremental`,
`respectGitignore`, `ignorePaths`, `noDrift`, and `trash.days` / `trash.maxBytes`; built-in
defaults are `syncGit: true`, `git.incremental: true`,
`respectGitignore: false`, `ignorePaths: []`, `noDrift: false`, `trash: 30 days / 2 GiB`
(`DEFAULT_FOLDER_POLICY`).

The file is in exactly one of three states:

| State | What it means | What rbox does |
|---|---|---|
| **authoritative** | present and valid | normal operation |
| **absent** | not there at all | a fresh machine generates one; a machine that already has bindings refuses and tells you to run `rbox config regenerate` |
| **damaged** | present but unreadable/invalid | refuses everything and tells you to copy the file somewhere safe, then run `rbox config regenerate` |

rbox never guesses its way past a missing or damaged catalog, and there is no
migration command — `rbox config regenerate` is explicit and destructive: it
rebuilds the list from discovered bindings and daemon state, replacing whatever
was there.

```bash
rbox config                  # show the resolved folder list and options
rbox config --json           # same, machine-readable (closed schema v1)
rbox config add <path>       # admit a folder that is bound but not listed
rbox config regenerate [--yes]  # DESTRUCTIVE: rebuild the file from discovered state
rbox config repair <path>    # re-point a listed folder after a proven local move
```

`rbox init` and `rbox track` record the folder for you; `rbox untrack` removes
it (`src/cli/track-cmd.ts:211`, `src/cli/untrack-cmd.ts:126`).

### 3b. `.rbox/workspace.json` — the binding, per tracked root

`.rbox/workspace.json` (`src/cli/workspace-config.ts`) holds the **binding**:
which remote stream this root belongs to and as which device. It is
**machine-local by design** — never part of the synced manifest, and several
of its fields (`rootPath`, `deviceId`, and the runtime-only `token`/`kek`)
would be actively wrong if copied to another machine. It is *not* where your
sync options live any more; §3a is.

Fields worth knowing about as a user (not an exhaustive schema dump):

| Field | What it's for |
|---|---|
| `remoteWorkspaceId` | which workspace this root syncs against |
| `name` | optional, human-readable label, cached locally so `rbox status` doesn't need a server round-trip |
| `projectId` | which project within the workspace (`"root"` today — single-project) |
| `encrypted` | always on — full E2EE (design 12) is the only supported mode |

**On `syncGit`.** It is on by default (design 28 — the git-native sync this
product is built around), and `--git false` at `init`/`track` opts this machine
out by writing the override into `~/.rbox/config.json`. **Shape caveat:** a
repo is *ineligible* for git-state capture if it is bare, shallow/partial, uses
`reftable` ref storage, uses `objects/info/alternates`, is a submodule
*superproject* (`.git/modules/`), or rewrites its graph locally
(`info/grafts`) — its section is not published, and the reason is reported
per-repo in `rbox logs`. A *primary* clone containing linked worktrees
(`git worktree`) **is** eligible (design 68) — it is captured with
`bundle --single-worktree --all`, and a branch currently checked out by a
sibling worktree is held rather than moved underneath it. Worktree *checkouts*
themselves (gitfile-pointer repos) are captured on their own **unless** their
main clone is also tracked inside the same rbox root, in which case they are
deliberately skipped and base-carried — their history already travels with the
main clone's bundle (design 68 §3.3). Regular file sync is unaffected.

Options are decided **per machine**, not project-wide — one machine opting out
of git-state sync doesn't force that on every other machine bound to the same
workspace, and vice versa. Every option is re-resolved from the catalog on each
run, so "unset" is the normal state; editing `~/.rbox/config.json` takes effect
without re-running `init` or `track`.

## 4. Tracking, syncing, status

```bash
rbox track ~/code/myapp                        # bind a directory (no first sync)
rbox track ~/code/myapp --workspace ws_ab12cd34 # join an existing workspace instead
rbox untrack [path] [--force]                  # stop syncing (local unbind; remote untouched)

rbox config                                    # which folders this machine syncs, and how (§3a)

rbox start [path]     # start background sync (daemon)
rbox stop [path]
rbox logs [path] [--follow] [--limit N]  # --lines is still accepted as an alias

rbox autostart enable   # resume background sync after login/reboot
rbox autostart disable
rbox autostart status

rbox sync [path] [--allow-mass-delete]   # pull, then push, once
rbox push [path]
rbox pull [path] [--allow-mass-delete]

rbox status [path] [--json]  # workspace state + conflict metrics
```

`--allow-mass-delete` is a consent gate: a pull that would delete half or more
of the tracked files stops and asks for it explicitly, rather than quietly
applying what could be a corrupted or mistaken remote state.

**Autostart.** `rbox start` runs for the current login session.
`rbox autostart enable` registers a per-user login agent (launchd on macOS,
systemd user unit on Linux) that restarts background sync after login.
`rbox autostart status` shows whether it is registered; `rbox autostart disable`
removes it. It never runs as root and never supervises crashes.

**Export.**

```bash
rbox export                                # every workspace → ~/Downloads
rbox export --workspace ws_ab12cd34        # one workspace
rbox export --out ~/backup.tar.gz          # write a single .tar.gz instead of a directory
```

`rbox export` decrypts locally and writes files to `~/Downloads` by default.
`--out` targets a directory or, when the path ends in `.tar.gz`, a single
archive. It is read-only: it never binds a workspace, starts a daemon, or changes
sync state. For single-file rollback, use `rbox restore <path>@<seq>`.

> **Note on deprecated names:** `link` and `daemon <start|stop|logs>` still work
> but are deprecated aliases (they forward to `track` and `start`/`stop`/`logs`
> respectively) and print a warning on every use (design 29). They remain
> supported, but new scripts should use the names above. `doctor` is now the
> top-level support command;
> `hydrate`/`detect` remain disabled deps aliases while the whole `deps` group is
> commented out of the CLI (design 51, §7 below).

## 5. `.rboxignore` — shared, cross-machine ignore rules

**Status: shipped (designs 03b and 72).** The builtin ignore layer is enabled in
every mode and applies before the later override layers described below. When you
create a workspace through the interactive `rbox setup` or `rbox init --new` wizard,
rbox also respects `.gitignore` by default, skipping gitignored untracked files.
Scripted init keeps its compatibility default unless you pass the valueless
`--respect-gitignore` flag; existing workspaces keep their configured mode. To
change it later, use `rbox ignore --respect-gitignore <on|off>` (that one *does*
take a value) or edit `respectGitignore` in `~/.rbox/config.json`.

**Precedence when `.gitignore` is enabled:** `BUILTIN_IGNORE` → `.gitignore` →
`.rboxignore` → machine-local folder-config `ignorePaths` (later rules win).
Each `ignorePaths` entry is a literal workspace-relative file or directory prefix;
globs, negations, absolute paths, and `..` are rejected. `.rboxignore` can re-include an individual file an earlier rule
excluded (`!important.log`), but **cannot** resurrect files inside a directory
an earlier rule pruned wholesale — `!dist/keep.txt` won't work if `dist/` was
already pruned as a directory; you'd have to re-include the directory itself.

**It is not created automatically.** `.rboxignore` doesn't exist until the
first time you run `rbox ignore <glob>` — `rbox init` never touches it. A `!`
rule can opt a specific file back in, including one excluded by the builtins:
`rbox ignore '!.env'` syncs `.env` with the same end-to-end encryption as every
other file (rbox can never read it).

The wizard's **sync Git-ignored files too** option turns `.gitignore` handling
off, which is useful for ignored notes and local state. It can also catch large
ignored builds or datasets. Builtin ignores still apply in that mode; use a
`.rboxignore` `!` rule for a builtin-ignored file such as `.env`. Change the mode
later with `rbox ignore --respect-gitignore <on|off>`.

```bash
rbox ignore "*.local.json"     # append a pattern (creates the file if absent, de-duped)
rbox ignore --list             # print the current mode and rules, labeled by source/activity
rbox ignore --respect-gitignore off
rbox ignore --path ~/code/myapp --list
```

**The sharp edge — ignoring an already-synced file.** By default, newly
ignoring a pattern that matches files already synced is **forward-only**: those
files stop syncing *future* changes but are **not deleted** from other
machines — their last-synced copies stay put, now untracked by rbox. This is
deliberately the non-destructive default.

`rbox ignore --purge` previews already-synced paths that now match the active
ignore rules, then asks for confirmation before deleting those copies from synced
state and other machines. The ignored files on this machine stay on disk. Pass
`--yes` to skip confirmation; it is required in a headless session. Without
`--purge`, ignore changes remain forward-only.

Since `.rboxignore` is a normal file (not in `BUILTIN_IGNORE`), it syncs like
any other tracked file — everyone bound to the workspace ends up with the same
effective ignore rules with no separate distribution mechanism.

**Planned, not yet shipped:** an interactive/flag-driven option to scaffold
`.rboxignore` at `rbox init` time instead of waiting for the first `rbox
ignore` call — see [design 51](./design/51-rbox-yml-config.md) §4.

## 6. `rbox.yml` — does not exist yet

If you're looking for a project-level YAML config (the way some tools have a
`.projectrc` or similar): **rbox has no such file today.** It was proposed
once, early, as a combined ignore-rules + hydration-recipe file, and both
halves were explicitly declined when their respective features actually
shipped — ignore rules live in `.rboxignore` (§5) instead, and hydration
(`rbox deps install`) deliberately runs only a fixed, inferred allowlist, never
project-defined shell commands (design 08 — untrusted recipe commands are a
`rm -rf ~` risk sitting in a synced file everyone's daemon reads).

A scoped revival is proposed in [design 51](./design/51-rbox-yml-config.md),
not yet implemented: a synced `name:` (fixes headless joins not picking up a
workspace's display name) plus `syncGit`/`notifyOfDepsChange` as project-level
*defaults* that an individual device can still override locally. It still
does **not** bring back an `ignore:` key (stays in `.rboxignore`) or arbitrary
shell recipes (`rbox deps install` stays inferred-allowlist-only, permanently
— see design 08's trust-boundary argument — and is itself commented out of the
CLI entirely for now, see §7).

## 7. Dependencies (hydration) — temporarily disabled

**The whole `deps` command group is commented out of the CLI right now**
(`src/cli/main-dispatch.ts`, `help-registry.ts`) — `rbox deps ...`
and its old aliases `hydrate`/`detect` are unknown commands until this is
revisited. The underlying implementation (`hydrate-cmd.ts`,
`deps-drift.ts`, `deps-notify.ts`) is untouched, just disconnected from the
dispatcher, so re-enabling is a small, mechanical change when it's wanted
again — not a rewrite.

When it *is* wired up, the surface is:

```bash
rbox deps list [path]                          # which lockfiles/ecosystems were found
rbox deps check [path]                         # is this host ready to rebuild them?
rbox deps install [path] [--allow-build] [--only <id>] [--manager <m>]
rbox deps drift [path] [--quiet]               # did the lockfile change since rbox last saw it?
```

`deps install` reconstructs dependencies from synced lockfiles (`npm ci`,
`pnpm install`, `cargo fetch`, …) rather than syncing `node_modules` itself —
no OS-specific binaries over the wire, no cross-machine `node_modules`
conflicts. `--allow-build` is required for steps that would run
project-defined build/lifecycle scripts; the default is the inferred-only path
described in §6.

**`rbox deps notify <install|uninstall|status|on|off>`** — the old imperative
shell-hook toggle command — is *not* coming back in that form. Its job (turn
the post-sync drift nudge on/off) is being replaced by a declarative config
field instead: `notifyOfDepsChange` in [design 51](./design/51-rbox-yml-config.md)
§3, synced via `rbox.yml` once that exists, same idea as `syncGit` there. The
automatic post-sync nudge itself (the one-line notice printed after a
`push`/`pull`/`sync` that wrote a changed lockfile) is unaffected by any of
this — it's not a `deps` command, it's `postSyncNudge` built into `index.ts`
(called after `push`/`pull`/`sync`), and still runs
today gated by the existing per-device `noDrift` field in `workspace.json`.

## 8. Devices & account

Use a pairing token to authorize another machine and carry its encryption key, a
device confirmation code to authorize a login without carrying encryption, or a
dashboard account-link code to connect your web login for management and billing.

```bash
rbox pair                      # mint a connect command; press c to copy it
rbox connect <pairing-token>   # authorize + encryption-enroll the new machine
rbox connect                   # lower-exposure alternative: masked prompt / stdin
rbox recover                   # re-enroll this machine from your recovery phrase

rbox device approve <user-code>
rbox device list [--json]
rbox device revoke <device-id>

rbox account link <code>       # link this CLI to your web login
rbox account status [--json]
rbox account unlink

rbox key status [--json]       # encryption status (+ recovery-kit record)
rbox key save                  # validate and save the recovery phrase
rbox key backup                # re-show recovery phrase
rbox key genesis --yes         # mint this account's first encryption keys
```

**`rbox key genesis`.** Web signup and device-code `rbox login` authorize a
machine but do **not** create encryption keys. `rbox key genesis --yes` mints the
account's first keys and 24-word recovery phrase on a cold account. `rbox setup`
runs it inline when it detects an authorized-but-unenrolled machine; `--yes` is
required because this defines the key world every device inherits.

### Recovery kit (`--kit` / `--kit-path`)

On macOS, the default recovery-kit action stores the validated 24-word phrase
in the login Keychain. The item is searchable as “rbox recovery phrase” in
Keychain Access. It is not iCloud Keychain-synchronized, so keep an off-machine
copy too. On other platforms, the default remains a plaintext recovery-kit
file. `--kit-path` always requests a plaintext file on every platform.

```bash
rbox key save                              # Keychain on macOS; default file elsewhere
rbox key backup --kit                      # save while re-showing a cached phrase
rbox key save --kit-path ~/vault/rbox.txt  # explicit plaintext file
```

- **Explicit files.** The resolved absolute path is persisted. Default file
  output uses `~/Downloads` when it exists, otherwise `$HOME`, named
  `rbox-recovery-kit-<16-hex-account-suffix>-<YYYYMMDD>.txt`.
- **How files are written.** Mode `0600`, exclusive sibling temp, fsync, atomic
  rename, exact read-back, published-file fsync, and containing-directory fsync.
  Symlink targets are refused.
- **Tracking it.** `rbox key status` reports every recorded Keychain and file
  artifact with a live `present`, `missing`, `unrecognized`, or `unavailable`
  state. JSON status is read-only and never emits a save nudge.

An explicit file kit is plaintext: anyone who holds it can decrypt your rbox data,
and rbox has no escrow and can never reset the phrase for you. Treat it like the
phrase itself — store it somewhere you'd store a password backup, not next to
the machine it unlocks.

## 9. Billing & maintenance

```bash
rbox usage [--json]            # plan limits + current account usage
rbox subscribe <solo|pro>
rbox billing                   # open the billing portal
rbox upgrade [--check]
rbox uninstall [--yes]         # no --yes prints the removal steps only
rbox version
rbox shell-init zsh            # prompt integration + completions: eval "$(rbox shell-init zsh)"
rbox completions zsh
```

**`rbox usage`** prints plan limits and current usage: storage used vs cap,
workspace and device counts, and downgrade-grace read-only time. It matches the
server-side `402 quota_exceeded` decision. `--json` emits account usage for
scripts. `rbox subscribe <solo|pro>` opens checkout to lift the cap; Team is
listed but not purchasable.

## 10. Full command reference

For the authoritative, always-in-sync list, run `rbox help` (grouped) or
`rbox <command> --help` (per-command flags/examples) — both are generated from
the same registry (`src/cli/help-registry.ts`) the dispatcher uses, with a
parity test keeping the two from drifting apart. This doc is the narrative
version; that's the source of truth for exact flags.
