# §135 — TUI UX walkthrough harness

> **Status: PROPOSED.** Scripts-only test infrastructure; no product or API changes.

## Contract

`scripts/ux/fresh-machine.ts` owns isolated machine lifecycle below
`/tmp/rbox-ux/<run-id>/<name>`. It accepts only safe single path-component ids,
constructs labels as `ux-<run-id>-<name>`, and always launches `rbox` with a
sanitized environment: `HOME` and `RBOX_HOME` point at the machine, `RBOX_API` is
the exact DEV URL, and inherited config, credential, device, account, pairing,
and bootstrap overrides are removed. `create --enrolled` resolves the
bootstrap secret through `scripts/rig/lib/account.ts`, captures all child output,
performs bootstrap login and the spec-required confirmed key genesis, and never
replays captured output because login can print a recovery phrase. Errors name
the failed stage and exit code without child output. Every child spawn pins `cwd`
to the machine HOME after a guard proves that neither the canonical HOME nor an
ancestor contains `.rbox/workspace.json`. It prints only the machine HOME plus a
reusable sanitized `cd '<home>' && env -u ...` prefix. A virgin create makes no rbox
invocation and therefore no credentials. Existing paths, symlink components, and
ids outside the conservative single-component grammar are rejected.

The shared resolver currently treats `RBOX_DEV_BOOTSTRAP_SECRET` as a file key but
not an environment key. The harness normalizes that environment alias into
`RBOX_DEV_BOOTSTRAP` only in the dependency object passed to
`resolveBootstrapSecret`, preserving the spec's first-key precedence while leaving
secret-file parsing and worktree-to-primary-root probing entirely in the reused
module. Tests pin both environment keys and precedence.

The DEV URL is a named constant. A pure assertion rejects every other URL,
including production, before process launch. `tui start` accepts only a direct
executable token exactly equal to `rbox`; explicit paths, shells, `env`,
interpreters, and arbitrary
trampolines are rejected. Its remaining argv rejects `--remote` values other than
DEV, `--remote=<value>`, environment assignment tokens, and any embedded API URL.
Generated shell prefixes quote values as data and contain no bootstrap material.

`destroy` reads safe `rootPath` strings from `HOME/.rbox/daemons/*/desired.json`
and best-effort runs `rbox stop <root>` for each. It then discovers the machine's
device id and credential remote through its isolated credentials, requires that
remote to equal DEV, and uses the non-interactive
`rbox device revoke <device-id>` supported by `src/cli/auth-cmd.ts`, and finally
removes the machine HOME. Failures are redacted warnings and do not prevent later
cleanup. (The spec's cited `devices-cmd.ts` is stale; dispatch lives in
`main-dispatch.ts` and `auth-cmd.ts`.) `list` derives labels from validated real
directories and never reads or prints credentials. Canonical containment checks
ensure create, start, list, and destroy never traverse a symlink outside the UX
root.

`scripts/ux/tui.ts` validates canonical HOME containment below `/tmp/rbox-ux`,
applies the same ancestor-workspace guard, creates a detached session rooted at
that HOME and at the requested size, and
injects the same sanitized environment through tmux's environment flags. Every
dangerous inherited variable is explicitly overwritten with an empty value because
tmux `-e` cannot unset variables; HOME/RBOX_HOME/RBOX_API receive forced safe
values, and `new-session -E` prevents update-environment from restoring client
values. Because
tmux accepts a shell-command rather than an argv array, a pure POSIX single-quote
renderer quotes every token (including empty strings, quotes, shell metacharacters,
Unicode, and leading dashes) and prefixes `exec`; tmux option parsing is ended with
`--`. `keys` sends its allowlisted named keys directly and every other token with
tmux literal mode; slow literal text is sent one character per call with a 50 ms
delay. `screen`, `wait-idle`, and `stop` capture, poll, and terminate the named
session. The stable-screen criterion is two consecutive equal captures at 500 ms
intervals; timeout still prints the final capture and returns failure.

`WALKTHROUGH.md` gives the exact mint/start/keys/wait/screen/stop/destroy mechanics,
requires appending `screen` output to a transcript after every interaction, states
the DEV-only and secret-handling rules, provides a teardown checklist, and limits
browser evaluation to the handoff copy because device-code approval and dashboard
clicks are not automated. It forbids entering bootstrap, recovery, or pairing
secrets into commands or transcripts.

## Verification

Pure exports and dependency seams cover missing/duplicate/unknown parser cases,
safe ids and labels, canonical/symlink path containment, sanitized env/prefix
construction, pinned spawn cwd, ancestor-workspace rejection, exact DEV refusal
and command override bypasses, non-leaking child
failure reporting, shell token rendering, named versus literal keys, trailing-blank
stripping, and wait-idle stability/timeout behavior under `bun test scripts/ux`.
`bun run typecheck` remains green. The local live DEV API
smoke is intentionally not run in the networkless implementation sandbox; the
orchestrator owns that acceptance step and transcript.
