# REVIEW-117 — design-116 Git identity hermeticity

Status: **ALIGNED** (2026-07-13).

## Round 1 — adversarial production and fixture audit

The reviewer confirmed that central fallback identity in `cleanGitEnv` covers
`git`, `gitRaw`, and `gitWithIndexFile`, while preserving process identity via
nullish fallback and allowing explicit helper environment overrides. It also
verified the two production children outside the exec helpers already receive
that environment: `keep-pins.ts`'s update-ref transaction spawn and
`checkout-txn.ts`'s FIFO transaction child.

The production reflog-writing paths are covered: stash publication in engine
apply, follow's stash committer-ident lookup and ref transaction, keep-pin
transactions, checkout ref/HEAD transactions, and ordinary update-ref sites.

The fixture audit expanded the initial file list to direct Git invocations in
shared/config transaction and config-sync tests, synchronous crash-window Git
calls, and the branch-diff `git-config-sync.e2e`, `git-nested`, and `git-state`
tests. Specialized date/index environments compose on top of the hermetic base.
No per-repository identity configuration was added for materialized receivers.
