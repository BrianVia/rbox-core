# §133 — onboarding polish for v1.6.7

> **Status: IMPLEMENTED — 2026-07-16.** Founder-directed release bundle for the
> interactive first-run path. Scope is intentionally narrow: only the interactive
> wizard default and `rbox ignore --list` semantics change; all other edits are copy,
> documentation, or tests.

## Interactive `.gitignore` default

Both interactive create-workspace prompts (`rbox setup` and interactive `rbox init
--new`) put `Skip gitignored untracked files` first with value `"true"`, making bare
Enter respect `.gitignore`. Its description names both escape hatches: re-include a
specific file with a `.rboxignore` negation such as `!.env`, or switch the workspace
mode later with `rbox ignore --respect-gitignore off`.

The second choice remains an explicit encrypted-superpower opt-in: it syncs files
ignored only by Git too, including useful notes and local state, with end-to-end
encryption that prevents rbox from reading them; it also warns that large gitignored
builds and datasets will be included. Builtin ignores still apply in this mode, so a
builtin-ignored `.env` syncs only after the user adds `!.env` to `.rboxignore`.

This is prompt ordering only. `resolveInitPlan` continues to default
`respectGitignore` to `false` when the flag is absent, preserving scripted callers,
the rig, existing workspaces, and all non-interactive behavior. The setup-to-init
flag bridge still forwards `true` only for new workspaces.

## Honest ignore inspection

`listIgnoreRules` loads the actual workspace config and prints the current mode as
the exact command-level concept, `respectGitignore: on|off`. Builtin and
`.rboxignore` rules remain active in both modes. `.gitignore` rows are labeled
`ACTIVE` when the mode is on and `present but NOT applied (respectGitignore off)`
when it is off; their patterns remain visible so `--list` is diagnostic rather than
silently hiding present rules. The dispatcher awaits the now-asynchronous listing.

## Copy and documentation

- Account creation leads with `Press Enter to sign up in your browser`; the
  bootstrap secret is an advanced parenthetical, with no control-flow change.
- The setup completion summary points users to `rbox ignore` and `.rboxignore`;
  standalone init's summary is unchanged.
- The tracked-workspace front door asks `What would you like to do?`.
- Guided setup help marks `--dir`, `--daemon`, `--pull-only`, and `--force` as
  `(keyed setup only)`.
- README and usage docs state that builtin ignores always apply, interactive
  wizards respect `.gitignore` by default, `!` rules can selectively re-include
  files, and sync-everything is the E2EE opt-in with its large-artifact tradeoff.
- Usage docs describe implemented `rbox ignore --purge`: preview, confirmation
  unless `--yes` is supplied (`--yes` is required headlessly), deletion of the
  already-synced copies from synced/other-machine state while ignored local files
  remain on disk, and unchanged forward-only behavior without purge.

No audit items outside the founder's enumerated B1/R2/R3/R4/R5/R6/P7/P8 bundle are
included.

## Tests and acceptance

- Pin the ordered labels, values, and descriptions for both interactive
  `.gitignore` prompts; keep the `init-plan` absent-flag assertion at `false`.
- Pin that the setup bridge forwards the true choice for new workspaces, omits the
  flag for the false choice, and never forwards it for joins.
- Cover ignore listing with mode off and on, including collapsed and full builtin
  output and the `.gitignore` activity labels. Fixtures contain a real workspace
  config; an absent `respectGitignore` field is treated as off.
- Update the front-door prompt assertion and any affected copy/golden assertions.
- Run `bun run typecheck`.
- Run `bun test src/cli`; only the named pre-existing failures are acceptable:
  `json-output signed-in-account` and `same-SHA metadata heal`.
- Review the final diff for the scope boundary and perform focused simplification
  and antislop checks; this copy-and-local-CLI change does not require a fleet
  deployment or test-rig scenario beyond the requested CLI suite.
