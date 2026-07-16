# REVIEW-136 — Container-default UX walkthrough harness

## Round 1

**Codex: NEEDS WORK.** The initial dispatch leaves no routing identity for
non-start tmux commands; the rig lifecycle builders mislabel UX resources; blindly
reusing a process-global container name could enter another checkout; the rig image
has no `rbox` executable; machine-only destroy must not delete sibling machines;
and Docker bridge networking is not an egress allowlist.

**Resolution:** Every container-mode TUI command requires `--run-id`. Runtime work
uses the rig seam but UX-specific pure lifecycle argv carries `ux=1`. Reuse requires
an exact ownership/spec inspection. The shared rig image gains tmux plus a launcher
for its existing mounted-source CLI path. Named destroy retains the run container;
run-wide destroy uses stop plus forced volume-removing rm. The design explicitly
defines DEV-only as the exact application endpoint guard over bridge networking.

## Round 2

**Claude: PASS.** The revised contract closes routing, attribution, collision,
local-candidate, teardown-scope, and network-semantics gaps while preserving host
mode and the no-live-Docker acceptance boundary.

**Codex: PASS.** The design uses one runtime choke point without weakening the
rig's ownership model, gives every subcommand an unambiguous target, and provides
pure verification seams for all SPEC2 acceptance cases.

## Round 3

**Codex: NEEDS WORK.** Implementation review found that host teardown had briefly
lost symlink-parent checks, exec accepted stale/mismounted containers, same run ids
could collide across worktrees, extra mounts were not rejected, strict dangling
cleanup could fail while an old image remained in use, and automatic stale
replacement could discard enrolled machine HOMEs without revocation.

**Resolution:** Host guards were restored and regression-tested. Containers now
carry a stable checkout label; entry requires exact DEV env/network and exactly the
two read-only source mounts; unexpected authority or mounts fail closed. Scoped
dangling cleanup tolerates images still in use. Create refuses stale runs, while
explicit destroy starts and enters only safely owned stale containers long enough
to best-effort stop/revoke each machine before volume-removing deletion.

## Round 4

**Claude: PASS.** The implementation now preserves host safety, cross-worktree
ownership, enrolled-device teardown, stale-state integrity, and scoped cleanup.

**Codex: PASS.** Pure coverage and the no-live-Docker boundary match the final
design; no remaining SPEC2 correctness issue is known.
