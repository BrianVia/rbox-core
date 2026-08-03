# REVIEW-135 — TUI UX walkthrough harness

## Round 1

**Codex: NEEDS WORK.** HOME-only isolation missed `RBOX_HOME`, config, and
credential overrides; arbitrary tmux commands could bypass DEV; captured bootstrap
output could leak a recovery phrase; daemon teardown lacked workspace roots; tmux
needed real shell quoting; canonical path and walkthrough/test contracts were thin.

**Resolution:** The design added complete environment sanitization, direct-command
guards, total child-output suppression, desired-state root discovery, POSIX token
quoting, canonical/symlink containment, and explicit documentation/test coverage.

## Round 2

**Codex: NEEDS WORK.** Shell/interpreter trampolines remained possible, tmux cannot
unset environment values with `-e`, and the shared resolver did not directly accept
the spec's `RBOX_DEV_BOOTSTRAP_SECRET` environment alias.

**Resolution:** Start became direct-rbox-only; dangerous tmux variables are forced
empty with `-E`; the harness normalizes the alias only in dependencies passed to
the reused resolver.

## Round 3

**Codex: NEEDS WORK.** Basename matching still allowed a caller-selected
`/tmp/evil/rbox` trampoline.

**Resolution:** The executable token must equal `rbox` exactly.

## Round 4

**Codex: PASS.** The design is aligned with the spec and actual CLI/tmux contracts;
all isolation, DEV-only, secret, teardown, quoting, path, resolver, walkthrough,
and networkless acceptance boundaries are closed.

## Fix round 1

**Live feedback: CRITICAL.** HOME isolation did not isolate workspace discovery,
which is rooted at the child process cwd. A copied prefix run inside a production
workspace allowed a DEV-targeted CLI to mutate that workspace.

**Resolution:** Every fresh-machine rbox spawn now pins cwd to machine HOME; the
printed prefix begins with a shell-quoted `cd` to that HOME; and a shared pre-spawn
guard rejects a machine HOME below any canonical ancestor containing
`.rbox/workspace.json`. Regression tests pin the spawn options, prefix form, guard
behavior, and existing tmux `-c <home>` contract.
