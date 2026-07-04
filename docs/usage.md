# rbox — usage guide

This guide covers command behavior, files written by the CLI, and config-file
semantics. It documents **current, shipped** behavior; proposed behavior is
called out with its design doc.

## 1. Getting started

```bash
rbox                 # no args: guided menu (new workspace / connect this machine / just log in)
rbox setup           # same guided flow, named directly
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
3. **Local binding.** Writes `.rbox/workspace.json` — see §3. This is the one
   file every tracked root has; nothing else is required for sync to work.
4. **Rebind guard.** If this directory was already bound to a *different*
   workspace, the local sync baseline is reset (files on disk are untouched)
   rather than silently reconciling against a stream it doesn't belong to —
   the guard exists because skipping it caused a real mass-delete incident
   (design 44).
5. **First sync.** Either an initial push (new workspace) or a full sync
   (joining an existing one).

Nothing about `rbox init` currently writes `.rboxignore` or any `rbox.yml` —
see §5 and §6.

## 3. `.rbox/workspace.json` — per-device, never synced

Every tracked root gets exactly one config file today:
`.rbox/workspace.json` (`src/cli/config.ts`). It is **machine-local by
design** — the file itself is never part of the synced manifest, and several
of its fields (`rootPath`, `deviceId`, and the runtime-only `token`/`kek`)
would be actively wrong if copied to another machine.

Fields worth knowing about as a user (not an exhaustive schema dump):

| Field | What it's for |
|---|---|
| `remoteWorkspaceId` | which workspace this root syncs against |
| `name` | optional, human-readable label, cached locally so `rbox status` doesn't need a server round-trip |
| `projectId` | which project within the workspace (`"root"` today — single-project) |
| `syncGit` | git-state sync (index/HEAD/stash), **on by default** (design 28 — the git-native sync this product is built around), `--git false` at `init`/`track` opts a device out |
| `noDrift` | opt-out of dependency-drift nudges, **per device**, unset (nudges on) unless something writes it |
| `encrypted` | always on — full E2EE (design 12) is the only supported mode |

Both are decided **per device**, not project-wide — one machine opting out of
git-state sync (`--git false`) doesn't force that on every other machine
bound to the same workspace, and vice versa. `syncGit` is resolved once, at
`init`/`track` time, and stored as a concrete value from then on — there's no
"unset" state for it in practice, unlike `noDrift`, which really is left
unset unless a device explicitly opts out.

## 4. Tracking, syncing, status

```bash
rbox track ~/code/myapp                        # bind a directory (no first sync)
rbox track ~/code/myapp --workspace ws_ab12cd34 # join an existing workspace instead
rbox untrack [path] [--force]                  # stop syncing (local unbind; remote untouched)

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

**Status: shipped (design 03b).** Combines with built-in defaults and
`.gitignore` to decide what does *not* sync.

**Precedence:** `BUILTIN_IGNORE` → `.gitignore` → `.rboxignore` (later rules
win). `.rboxignore` can re-include an individual file an earlier rule
excluded (`!important.log`), but **cannot** resurrect files inside a directory
an earlier rule pruned wholesale — `!dist/keep.txt` won't work if `dist/` was
already pruned as a directory; you'd have to re-include the directory itself.

**It is not created automatically.** `.rboxignore` doesn't exist until the
first time you run `rbox ignore <glob>` — `rbox init` never touches it. Until
then, ignore behavior is just `BUILTIN_IGNORE` + `.gitignore`.

```bash
rbox ignore "*.local.json"     # append a pattern (creates the file if absent, de-duped)
rbox ignore --list             # print the effective merged rule set, labeled by source
rbox ignore --path ~/code/myapp --list
```

**The sharp edge — ignoring an already-synced file.** By default, newly
ignoring a pattern that matches files already synced is **forward-only**: those
files stop syncing *future* changes but are **not deleted** from other
machines — their last-synced copies stay put, now untracked by rbox. This is
deliberately the non-destructive default. There is currently no CLI-level
`--purge` flag exposed for the destructive variant (propagating deletion); if
you need a file gone everywhere, delete it locally first, let that delete
sync, *then* add the ignore pattern.

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
(`src/cli/index.ts`, `help-registry.ts`, `deprecations.ts`) — `rbox deps ...`
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

```bash
rbox pair                      # mint a token to add another machine (~2 steps)
echo <token> | rbox connect    # redeem it on the new machine
rbox recover                   # re-enroll this machine from your recovery phrase

rbox device approve <user-code>
rbox device list [--json]
rbox device revoke <device-id>

rbox account link <code>       # link this CLI to your web login
rbox account status [--json]
rbox account unlink

rbox key status [--json]       # encryption status (+ recovery-kit record)
rbox key backup                # re-show recovery phrase
rbox key genesis --yes         # mint this account's first encryption keys
```

**`rbox key genesis`.** Web signup and device-code `rbox login` authorize a
machine but do **not** create encryption keys. `rbox key genesis --yes` mints the
account's first keys and 24-word recovery phrase on a cold account. `rbox setup`
runs it inline when it detects an authorized-but-unenrolled machine; `--yes` is
required because this defines the key world every device inherits.

### Recovery kit (`--kit` / `--kit-path`)

The commands that surface your 24-word phrase can also write it to disk as a
**recovery kit** — a plaintext file with the phrase, your account id, this
device, step-by-step recovery instructions, and the no-escrow warning. It's
supported on `rbox login --bootstrap ... --kit`, `rbox init ... --kit`, `rbox key
backup --kit`, `rbox recover --kit`, and `rbox key genesis --kit`.

```bash
rbox key backup --kit                      # write to the default kit location
rbox key backup --kit-path ~/vault/rbox.txt  # write to a specific file
```

- **Where it lands.** `--kit` writes to `~/Downloads` when that directory
  exists, otherwise `$HOME`, named
  `rbox-recovery-kit-<8-hex-account-suffix>-<YYYYMMDD>.txt`. `--kit-path <path>`
  writes exactly where you point it.
- **How it's written.** Atomically (temp file + rename) at mode `0600`
  (owner-read/write only); it refuses to write through a symlink and re-reads the
  file to verify the written contents.
- **Tracking it.** After a successful write, rbox records the path and timestamp.
  `rbox key status` reports the last-written kit — its path and date, or that no
  kit is recorded, or that the recorded file has since gone missing.

The kit is plaintext by design: anyone who holds it can decrypt your rbox data,
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
