# Claude Fable 5.1 handoff prompt

Use Claude Fable 5.1 at medium effort. The following is a copyable task prompt.

---

Take over the rbox sync/Git improvement program. Finish PR #882 first, then work
through all remaining work in the approved roadmap. I accepted the plan's
recommended choices. This request supersedes the previous instruction to stop
after the first four fixes. Preserve the roadmap's explicit design, experiment,
compatibility and rollout gates; recommended directions are not permission to
silently remove supported behavior or activate an unproven wire format.

## Start from actual state

Repository: `BrianVia/rbox-core`.
Existing PR: https://github.com/BrianVia/rbox-core/pull/882
Branch: `codex/astra-sync-git`.
Checkpoint: remote annotated `pre-astra-changes`, pointing to
`c4aa22bbb81c8754230735a73c5a58a28a64b4f7`.

Fetch the current remote branches and inspect PR status before changing anything.
If PR #882 remains open, create a worktree tracking its remote branch and resume
it; do not restart its implementation from main. If it has merged, begin from
latest `origin/main`. On the original host, the previous development directory
was `/Users/via/.codex/worktrees/a53f/rbox-core/.claude/worktrees/astra-sync-git`.
That path is context, not a path to assume exists on another host. Check for
uncommitted work before switching, resetting or creating overlapping checkouts.
Do not overwrite another session or force-push.

Read these from the PR branch where necessary (they may not yet be on main):

1. `AGENTS.md`, `CONTEXT.md`, and the required primitive-first skill.
2. `docs/STATUS.md` on latest main for the handoff state.
3. `plans/sync-git-improvements/plan.mdx`: canonical 25-package roadmap and
   accepted directions. The Markdown design287 and HTML reader are generated
   copies; keep them consistent when changing the canonical plan.
4. `docs/audits/2026-09-04-sync-git-performance-review.md` and
   `docs/design/notes/288/baseline-reconciliation.md`.
5. Designs289–292 and their review/validation notes, especially
   `docs/design/notes/287/integration-validation.md`, `CI-validation.md`,
   `docs/design/notes/289/broad-git-failure-comparison.md`, and
   `docs/design/notes/292/runtime-comparison.md`.

## Finish the existing PR

Four features are already implemented and separately committed:

- `2e1cb6e49`: batch consecutive confirmed-absent directory deletions.
- `1d47b6755`: include ordinary raw-index staged-object roots in capture bundles.
- `09fbf6590`: native portable private split indexes and matching identity.
- `3e7e6b169`: robust tracked-index cache freshness, with one complete
  trackedness/cache owner in `src/engine/tracked-repo.ts`.

These are pre-merge commit identities; rebase merge can change them. Preserve
their separation. The audit/roadmap is a separate commit, and the additional
Bun test compatibility repair is also separate. Do not squash all features.

Designs289/290/291 received GPT plus Claude Fable alignment (rounds2/2/3).
Final compiled Linux ARM64 DEV Git-entanglement passed111 assertions on two
devices; synthetic account deletion succeeded. Binary SHA-256:
`a69b95e751ec2e06934c39eb08c275a00059f2d0529b0f5daec7d5e2fef2e987`.
Source type-flip and mass-delete guards also passed. The 124k-file/1k-absent-event
benchmark improved42–52×, from about1.4s to27–33ms. This is not whole-sync speed.

Initial PR CI run33976813037 had three failed test shards; the other checks
passed. Most failures came from Bun1.4.2 isolating `beforeEach` async context
from test callbacks; the green main baseline used1.4.0. Design292 fixes only
the test fixtures by wrapping actual callbacks in the existing `PushSpans.run`.
Its nine-suite comparison passes on both1.4.0 and1.4.2:93pass, one existing skip,
15,307 assertions. Typecheck passes; no new lint findings. The separate large
P/K ref-cap test timed out in CI but its unchanged full file passed locally;
that is suspected environmental, not a certified flake or waived gate.

Review design292 and its actual code directly, run the relevant checks, and
complete the review record. GPT review aligned, but no Claude verdict exists:
automatic approval review rejected the prior Codex agent sending the new292
packet to external Claude. Do not treat those rejected calls as completed
reviews or try to bypass approval controls. You are now the receiving Claude
agent working directly in the project; inspect the files rather than requiring
the former agent to resend a packet. Follow the repository's independent-review
requirements and distinguish your direct review from any additional external
transfer that your environment separately gates.

Rerun and monitor the exact PR head's full CI, address real findings, and merge
with rebase only when checks/review are clear. The user authorized that merge.
No production promotion or CLI release has occurred. Update `docs/STATUS.md`
truthfully after landing; I explicitly permit STATUS-only commits straight to
main. Code changes still use worktrees and reviewed PRs. Reconcile any newer
main changes before merging; never bypass branch protection.

## Complete the remaining roadmap

Reconcile every package against current source and merged PRs before writing
code. Existing implementations supersede historical proposals. In particular,
parts of F3 matcher-provider/dircache work, F4 encryption-address SQLite,
G5 ref-deletion batching and account-refresh prefetch already existed at the
execution baseline. Do not implement them again or mark an entire package done
because one subpart shipped. The four initial fixes also do not complete broad
cross-device worktree topology.

Use the roadmap's dependency graph and acceptance tests as the specification:

- **B0:** finish reusable characterization, frozen regressions and measured
  acceptance evidence.
- **G1–G5:** close residual snapshot/object-closure work, including previously
  published broken split-artifact repair; NUL-safe worktree parsing; object-format
  admission; explicit Git environment/cancellation; batched ancestry/no-drop
  proofs, index projections and scratch-pin work still absent from main.
- **F1–F6:** residual split-cache work with a proven dependency witness;
  remaining deletion/observation improvements; certified matcher/dircache reuse;
  remaining transactional caches; verified sibling-file/Git-object reuse;
  bounded transfer, streaming and preparation.
- **S1–S3:** postcommit alarm/notification/ACK recovery; reverse-reference/local
  GC work behind schema compatibility gates; linear roots folding and bounded
  verified history.
- **G6–G7:** shared repository stores with independent checkout state, followed
  by approved broader Git-shape experiments. Define topology, lifecycle,
  conflict, migration and recovery contracts before publishing new semantics.
- **S4–S5:** coalesced receipts/envelope publication, authenticated signed WS
  delivery, parent-bound refset deltas/checkpoints and retained-root safety.
- **F7, S6, X1–X4:** run the scoped chunking, history/sharding, manifest/metadata,
  peer-assisted ciphertext, object-knowledge/compaction and native-plumbing
  experiments only under their named prerequisites and success criteria.
  A measured no-go is a valid experiment result; do not ship speculative
  infrastructure merely to mark a box complete.

Default next bounded candidates after PR882: historical split-artifact repair,
G5 ancestry batching and independent S1 recovery. Adjust priority using current
measurements and prerequisites rather than blindly following a stale order.

For each slice: identify protected functionality and its one owner; write the
next available numbered design; use independent reviews capped at three rounds,
including at least one executed-code/test round; implement the smallest coherent
change; run differential, crash, compatibility and performance checks plus the
relevant compiled rig; simplify the diff; run `bun run lint:affected`, typecheck
and full applicable CI. Abide by oxlint: fix new patterns, do not silence warnings
with casts/suppressions or hide them using quiet lint. Keep known baseline
failures separate from regressions. Use native Git, SQLite, atomic rename and
existing owners before inventing queues, flags, modes or another state authority.

Use **one atomic commit per feature/fix/improvement**, with its tests and scoped
design. Keep unrelated documentation and compatibility repairs separate. Finish
and land bounded PRs with green checks before accumulating another giant batch.
Maintain a package ledger and `docs/STATUS.md` with completed work, evidence,
remaining work and the exact next action so another host can continue.

Continue autonomously through approved work. Ask only for an actual unresolved
product/compatibility decision, necessary access, an approval-system block or
an explicit rollout gate. Do not repeatedly ask to perform routine authorized
development/reviews/validation. If a gate needs input, present concrete options
and keep progressing on independent work. Read `docs/DEPLOYMENTS.md` before API
deployment; implementation authorization does not itself authorize production
promotion, destructive feature retirement or incompatible format activation.

Finish with a package-by-package disposition: merged implementation, already
shipped, measured experiment result, or a concrete remaining decision/blocker.
Do not declare all25 packages complete based on plans, passing unit tests alone,
or one fast microbenchmark.
