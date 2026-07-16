# TUI UX walkthrough mechanics

This harness drives the locally checked-out `rbox` CLI as an isolated, first-time
user. Docker is the default: each run owns one `ux-<run-id>` container, and its
machine HOMEs, tmux server, CLI processes, and daemons all live inside that
container. The harness is locked to
`https://rbox-dev-api.brian-via.workers.dev`. Never weaken that guard or point a
walkthrough at `api.rbox.to`.

## Mint machines

Run from this repository worktree:

```sh
bun scripts/ux/fresh-machine.ts create --name a --run-id my-walk
bun scripts/ux/fresh-machine.ts create --name owner --run-id my-walk --enrolled
bun scripts/ux/fresh-machine.ts list
```

The first command makes a virgin machine with no credentials. The enrolled form
uses the shared rig secret resolver and labels the DEV device
`ux-my-walk-owner`. Its child output is deliberately suppressed because bootstrap
login can show a recovery phrase. Repeating `create` with the same run id safely
reuses its owned container; a same-name container without the expected UX labels
is refused.

The two stdout lines identify the guest HOME and give a reusable, shell-quoted
`docker exec --workdir ... env ... rbox` prefix. The image mounts this checkout's
`src/` and `scripts/` read-only, and its `rbox` launcher executes the same
`bun /app/src/cli/index.ts` candidate path used by the rig. The HOME path is
inside the container, not a directory to enter or inspect on the host. Always use
the printed prefix as a complete unit so both the container and cwd stay pinned.

Do not put bootstrap secrets, recovery phrases, pairing tokens, device tokens, or
other credentials in a command, prompt response, transcript, issue, or report.

## Drive the TUI

Every container-mode TUI command names the run explicitly. `start` accepts a
direct logical `rbox` command only and starts in the guest HOME.

```sh
bun scripts/ux/tui.ts start --run-id my-walk --session ux-walk-a --home /tmp/rbox-ux/my-walk/a --cols 100 --rows 30 -- rbox setup
bun scripts/ux/tui.ts wait-idle --run-id my-walk --session ux-walk-a
bun scripts/ux/tui.ts keys --run-id my-walk --session ux-walk-a Down Enter
bun scripts/ux/tui.ts keys --run-id my-walk --session ux-walk-a --slow "literal text"
bun scripts/ux/tui.ts screen --run-id my-walk --session ux-walk-a --strip
```

Named keys include `Enter`, arrows (`Up`, `Down`, `Left`, `Right`), `Tab`,
`Escape`, `Space`, `BSpace`, `C-c`, `C-d`, and `C-z`. Everything else is literal
text. `--slow` types literal text one character at a time. Use `wait-idle` after
each input before judging the UI.

## Capture a transcript

After the initial screen and after every interaction, append a fresh capture:

```sh
{
  printf '\n### chose existing workspace\n'
  bun scripts/ux/tui.ts screen --run-id my-walk --session ux-walk-a --strip
} >> /tmp/my-walk-transcript.txt
```

Give every entry a short action heading. Review the capture before appending it;
if a screen contains a credential or secret, do not save it. The acceptance smoke
uses `scripts/ux/.smoke-transcript.txt`, which is gitignored.

## Host fallback

`--host` preserves the older harness-development mode and must be supplied to
every fresh-machine and TUI invocation. Host mode needs installed `rbox` and
`tmux`, stores HOMEs below the host `/tmp/rbox-ux`, pins every rbox cwd to that
HOME, and retains the canonical-path and ancestor-workspace guards. It also runs
the daemon on the host, so do not use it for parallel walkthroughs.

```sh
bun scripts/ux/fresh-machine.ts create --host --name a --run-id host-debug
bun scripts/ux/tui.ts start --host --session ux-debug --home /tmp/rbox-ux/host-debug/a -- rbox setup
bun scripts/ux/tui.ts screen --host --session ux-debug --strip
bun scripts/ux/tui.ts stop --host --session ux-debug
bun scripts/ux/fresh-machine.ts destroy --host --run-id host-debug
```

An rbox command for a host-mode UX machine NEVER runs from another directory.
Use its printed `cd ... && env ... rbox` prefix as one complete command.

## Browser handoffs

Browser automation is out of scope. Device-code approval and dashboard flows
cannot be clicked by this harness. Walk up to the handoff, capture and evaluate
the terminal copy, then stop. `RBOX_APP` is blanked so a DEV login cannot direct
the agent into the production dashboard. Do not paste pairing or approval
material into the transcript to get past the boundary.

## Teardown checklist

Always tear down, even after a failed walkthrough:

1. Stop tmux: `bun scripts/ux/tui.ts stop --run-id my-walk --session ux-walk-a`.
2. Destroy one machine with `bun scripts/ux/fresh-machine.ts destroy --run-id my-walk --name a`. This retains the per-run container for sibling machines.
3. Destroy the entire run with `bun scripts/ux/fresh-machine.ts destroy --run-id my-walk`. This best-effort stops daemons, revokes DEV devices, then stops and removes the container and anonymous volumes.
4. Run `bun scripts/ux/fresh-machine.ts list` and confirm the run is gone.
5. Audit all UX-labelled artifacts:

   ```sh
   docker ps -a --filter label=ux=1
   docker volume ls --filter label=ux=1
   docker image ls --filter label=ux=1
   ```

The harness creates no named or anonymous volumes today; `docker rm --volumes`
is still part of run teardown as a future-proof guard. Never run a global Docker
prune on this shared machine. A credential whose stored remote is not the exact
DEV URL is never used for revocation; scoped HOME/container cleanup continues and
a warning is printed.
