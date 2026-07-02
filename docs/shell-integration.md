# Shell integration — ambient sync status in your prompt

rbox's pitch is "background sync you never think about." The shell integration is
the continuous, zero-effort proof that the machinery is working: a status glyph in
your prompt, and a one-line banner when you `cd` into a workspace. It's the same
idea git brought to the prompt — you see the state *before* you need it, not only
when you run a command (which is exactly when it's already too late).

## How it works

The daemon pre-renders a tiny sidecar, `.rbox/state/shell.line`, every time it
updates its activity record. The shell side is deliberately dumb: it does one
`read`, compares a heartbeat timestamp, and maps a state to a glyph. All the
judgment (state precedence, staleness, "last push 2m ago") lives in TypeScript
next to the code that owns the data — so the prompt can't drift from the real
verdict rules.

The per-prompt path is **pure zsh builtins** — no `jq`, no `awk`, no subprocess of
any kind (one binary spawn at shell startup, zero afterwards).

## Install (zsh)

Add one line to your `~/.zshrc`:

```zsh
eval "$(rbox shell-init zsh)"
```

That wires both the prompt integration **and** tab completions in a single eval —
no `compinit` file to manage. Open a new terminal (or `source ~/.zshrc`) and `cd`
into any tracked workspace.

To preview what gets evaluated:

```zsh
rbox shell-init zsh        # prompt plugin + completions
rbox completions zsh       # just the completion script
```

## What the glyphs mean

| Glyph  | State     | Meaning                                                         |
| ------ | --------- | -------------------------------------------------------------- |
| `✓`    | ok        | Daemon settled — last pump ended with nothing queued            |
| `↑`    | pending   | Watcher events / wants are queued; a sync is coming             |
| `↻ N%` | active    | A transfer is in flight (N% complete)                           |
| `⚠`    | halt      | Sync is halted (e.g. the mass-delete guard) — run `rbox status` |
| `○`    | not running | No fresh heartbeat — background sync isn't running; `rbox start` |

`ok` means **"the daemon has settled"** — the honest ambient claim. It is *not* the
full verdict: `rbox status` still computes the complete picture (local diff vs the
last synced baseline, remote head, git divergence). The prompt is the smoke alarm;
`rbox status` is the inspection.

The `cd`-into-a-workspace banner spells the state out in words, e.g.:

```
rbox: My Workspace ✓ in sync (seq 80) · last push 2m ago
rbox: My Workspace ⚠ sync halted — run `rbox status`
rbox: My Workspace ○ background sync not running — rbox start
```

## Custom prompts / Powerlevel10k

By default the glyph is appended to your `RPROMPT` (the right-hand prompt). If you
manage your prompt yourself — a custom theme, Powerlevel10k, etc. — set
`RBOX_NO_RPROMPT=1` **before** the eval and place the glyph wherever you want:

```zsh
export RBOX_NO_RPROMPT=1
eval "$(rbox shell-init zsh)"

# then reference $RBOX_PROMPT in your own prompt / p10k segment:
RPROMPT='%~ $RBOX_PROMPT'
```

`$RBOX_PROMPT` holds the colored glyph (or empty string outside a workspace) and is
refreshed on every prompt. In a p10k `prompt_*` function, just echo `$RBOX_PROMPT`.

## Starship (bash / fish / zsh)

Starship users get the same glyph for the cost of a `custom` module. It reads the
nearest `shell.line` by walking up like the plugin does (Starship modules may spawn
processes, so this is fine). Add to `~/.config/starship.toml`:

```toml
[custom.rbox]
description = "rbox background-sync status"
shell = ["/bin/sh"]
format = "[$output ]($style)"
style = "dimmed"
command = '''
d="$PWD"
while [ -n "$d" ]; do
  f="$d/.rbox/state/shell.line"
  if [ -r "$f" ]; then
    read -r ver ep st pct _rest < "$f" || exit 1
    [ "$ver" = v1 ] || exit 1
    now=$(date +%s)
    [ $((now - ep)) -gt 180 ] && { echo "○"; exit 0; }
    case "$st" in
      ok)      echo "✓";;
      pending) echo "↑";;
      active)  echo "↻ ${pct}%";;
      halt)    echo "⚠";;
      *) exit 1;;
    esac
    exit 0
  fi
  [ "$d" = / ] && break
  d=$(dirname "$d")
done
exit 1
'''
```

The module hides itself (non-zero exit) outside a workspace, so it only shows up
where it's relevant.

## Notes

- rbox never edits your rc files. `rbox setup` may *print* the eval line; it never
  writes it.
- The shell layer is display-only. It never triggers a sync, auto-starts a daemon,
  or mutates anything — it just reads the sidecar.
- A pre-0.6.4 daemon (or one that's stopped) writes no fresh `shell.line`, so you'll
  see `○ background sync not running` — start it with `rbox start`.
