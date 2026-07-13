# Design 93 field-gate runbooks (from rig recon, 2026-07-10)

## Lane 1 — rig two-VM convergence loop (dev API, this Mac)

- Rig = two Apple-`container` micro-VMs (rig-dev-a/b) on this Mac; DEV api
  enforced in code (`assertNotProd` refuses prod hostnames); bootstrap via
  `RBOX_DEV_BOOTSTRAP` or `dev-keys.local.secret`. SOURCE mode only: the repo
  worktree is bind-mounted read-only and the CLI runs via bun inside the
  guest — so the d93 worktree code is directly testable, no binary build.
- Preflight: `bun run rig doctor`; up: `bun run rig up`; teardown:
  `bun run rig down` (`--all` sweeps image+volumes); account teardown is
  default-on per run.
- The design-93 scenario (`scenarios/git-config-sync.ts`, registered in
  `scenarios/index.ts`) is CODE — part of the implementation spec (SPEC.md
  step 8b), cloned from `git-entanglement.ts` scaffolding (`provisionPair`,
  `buildGitRepos`-style helper, `teardownAccount`): repo with remote on A →
  converge → assert B's `.git/config` has remote+tracking; delete remote
  block on B (`git config --local --unset-all ...` via ctx.b.exec) → heals;
  edit URL on A with no other change → propagates; two idle cycles → zero
  new sequences.

## Lane 2 — read-only scratch-join of the REAL workspace (via-desktop-ubuntu)

Structural zero-push guarantee: keyed setup (`src/cli/setup-keyed.ts:90`)
hardcodes `"pull-only": "true"` on init; if a daemon is wanted, `--daemon
--pull-only` is additionally enforced in the daemon loop (daemon.ts:358,364).
The design-87 dogfood join is NOT a safe template (it had neither flag).

```bash
# Mac (real account):
rbox key create-ci --expires 4h --label "d93-scratch-gate" --accept-root-key
# → RBOX_KEY bundle. ROOT-EQUIVALENT: no shell history, key-file only, chmod 600, revoke after.

ssh via-desktop-ubuntu 'mkdir -p ~/rbox-scratch-d93'
# transfer the key via stdin, not argv/history:
ssh via-desktop-ubuntu 'cat > ~/rbox-scratch-d93/key.txt && chmod 600 ~/rbox-scratch-d93/key.txt' <<< "$RBOX_KEY"

# ubuntu (needs a binary carrying d93 — cross-compile from the worktree:
#   bun build --compile --target=bun-linux-x64 src/cli/index.ts --outfile /tmp/rbox-d93):
rbox-d93 setup --workspace ws_2b6e15da5fb7471ca2ff6be082f4831f \
  --dir ~/rbox-scratch-d93/ws --key-file ~/rbox-scratch-d93/key.txt \
  --pull-only --force

# Gate assertion: sampled repos (Dfinitiv/savvy-core, Personal/rbox-core, one Personal/*)
#   git remote -v shows origin; git config --local --get-regexp '^(remote|branch)\.' populated;
#   git status -sb shows tracking. ZERO manual steps.
# NOTE: this gate needs the MAC (a d93-capable writer) to have re-published sections
#   carrying config first — the presence-rule capture nudge must have run on the Mac
#   against the real workspace... which requires the Mac daemon on a d93 build. That
#   makes Lane 2 a POST-MERGE/pre-release gate (run with the release candidate on the
#   Mac), not a pre-merge one. Pre-merge, Lane 1 covers the full behavior matrix.

# Teardown: rbox key list → rbox key revoke <deviceId> (on Mac);
#   ssh via-desktop-ubuntu 'rm -rf ~/rbox-scratch-d93'
```

## Ordering

Pre-merge: unit + transaction + E2E suites, then Lane 1 (rig scenario).
Post-merge, pre-release: Lane 2 with the release-candidate binary on the Mac
+ Ubuntu scratch join. Fleet upgrade only after Lane 2 passes.

## Lane 2b — real-GitHub probe repo (Brian-authorized 2026-07-10)

Brian: "You can even make a sample simple repo to test with in BrianVia org…
with like one commit and setup a remote to test with."

At field-gate time: `gh repo create BrianVia/d93-config-probe --private` with
one commit; clone into the workspace under test (scratch workspace pre-merge;
`~/Development/Personal/` on the Mac for the post-merge Lane 2). The
deal-breaker proof then becomes literal: on the freshly-joined host,
`cd <ws>/…/d93-config-probe && git pull` succeeds against REAL GitHub with
zero manual steps (ssh remote `git@github.com:BrianVia/d93-config-probe.git`).
Clean up the GitHub repo after the gate (or keep as a standing probe — ask).
