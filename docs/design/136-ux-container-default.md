# §136 — Container-default UX walkthrough harness

> **Status: ACCEPTED FOR IMPLEMENTATION.** Scripts-only harness change; no product
> or API code changes.

## Contract

The UX walkthrough harness runs in Docker by default. Each run owns one container
named `ux-<run-id>` and each machine HOME is a directory below
`/tmp/rbox-ux/<run-id>/<machine>` inside that container. UX container operations
go through `scripts/rig/lib/container.ts`: the harness selects its Docker backend
explicitly, uses its runtime readiness, `run`, `exec`, mount serialization, image
build, hash-record, and scoped dangling-image cleanup machinery, and never spawns
Docker directly. UX owns small pure argv builders because the rig lifecycle
builders deliberately hard-code `rig=1`/`rig.spec` and omit Docker's volume-removal
flag. UX-created containers instead carry `ux=1`, `ux.run=<run-id>`, a stable
checkout identity in `ux.repo`, and an exact `ux.spec` create-spec label. A
same-name container is reusable only when inspection proves
those labels and the expected image, network, DEV environment, and read-only
worktree source mounts; an unowned collision is never removed or entered.

The existing `rig-device` image is reused rather than deriving a second UX image.
`tmux` and a small `/usr/local/bin/rbox` launcher are added additively to
`scripts/rig/Dockerfile`. The launcher executes the rig's exact local-candidate
path, `bun /app/src/cli/index.ts`, so both harnesses exercise the mounted checkout.
This keeps one dependency image/tag, one staleness hash, and the rig's normal
scoped dangling-image reclamation. The shared image carries both `rig=1` and
`ux=1` when UX ensures it, while all UX-owned runtime artifacts carry `ux=1`.
The container uses Docker's bridge
network and inherits no host authority. Bridge networking supplies outbound HTTPS;
the existing exact DEV URL environment and argv guards enforce the DEV-only
application boundary (bridge is not represented as a destination firewall).

`fresh-machine create` defaults to container mode. It ensures the shared image is
current using the rig's package/lockfile/Dockerfile hash record, boots or safely
reuses the run container, creates the guest HOME, and optionally enrolls through
container exec. Every rbox invocation is cwd-pinned to that HOME and receives only
the sanitized DEV environment. Bootstrap material is passed through a temporary
exec environment variable, is redacted by the shared runner, and child output is
suppressed. Stdout identifies the guest HOME and prints a shell-safe prefix of the
form `docker exec --workdir ... ux-<run-id> env ... rbox`.

An existing same-checkout container whose image/create hash is stale is never
silently replaced: create fails closed and directs the caller to explicit destroy.
Destroy may enter a stale container only after its stable owner, DEV network/env,
and exact read-only mounts still validate, allowing best-effort daemon stop and
device revocation before removal.

`fresh-machine destroy --run-id X --name Y` best-effort stops/revokes that machine
and removes only its guest HOME, retaining the shared run container for siblings.
Without `--name`, it tears down every machine and then executes an explicit Docker
stop followed by `rm --force --volumes`; no named or anonymous UX volumes are
created, so the latter is defensive against future image/mount changes. `list`
shows live containers selected by both the `ux=1` label and `ux-` name prefix.

`tui` defaults to proxying every tmux operation through the shared container seam.
Container-mode commands require `--run-id` because session names are not trusted as
container identity. `start` still accepts only a direct logical `rbox` command,
pins the guest cwd and sanitized DEV environment, and tmux invokes the image's
launcher. `keys`, `screen`, `wait-idle`, and `stop` exec tmux in the same named
container. All proxy argv is assembled without a shell on the host.

Every command accepts `--host` as an explicit harness-development fallback. Host
mode preserves §135 unchanged: real canonical paths below the host UX root, the
ancestor-workspace guard, cwd-pinned installed-rbox spawns and printed prefix,
direct host tmux, and filesystem lifecycle/list behavior. Container mode never
mistakes a guest path for a host path.

## Verification

Pure tests pin container-default versus `--host` parsing, container names and
guest paths, the Docker create plan and `ux=1` labels, ownership/spec validation,
the cwd-pinned exec prefix, explicit stop plus `rm --force --volumes`, live-list
filter argv, machine-only versus run-wide teardown, logical-rbox translation, and
every TUI proxy plan. Existing host isolation, DEV-only, quoting, cwd, ancestor,
and tmux behavior tests remain green. Validation is `bun run typecheck` and
`bun test scripts/ux`; no live Docker command is run in the implementation
sandbox. The orchestrator owns the live container smoke and transcript.
