Adversarial review of docs/design/204-delta-scoped-publish.md (draft r1).

You have full read access to this repo checkout. Verify EVERY claim in the
doc against the actual code — file:line anchors, flag semantics, freeze
conditions, test existence, mechanism soundness. Attack the mechanism:
- Part A: is the 422-recovery backstop actually sufficient? Is the REVIEW-103
  item-11 unfreeze condition really discharged (find the carried-ref
  regression test or prove its absence)? Any path where the delta arm
  under-checks AND the server admission would NOT catch it (GC races,
  pack loss, epoch rotation, receipts branch vs legacy branch)?
- Part B: is flipping RBOX_MDE_DELTA default-on safe for every reader in the
  wild and every client state (stale manifestMeta, epoch rotation mid-chain,
  interrupted push, repair)? Check the two-seam claim and the proposed
  mdeWriteCaps precedence. Check fastFoldBase (design 106) interaction.
  Check GC: are chain links really rooted for the full retention window?
- Part C: attack the trust predicate for delta discovery (C3) — enumerate
  ways a NEW repo appears that git-ref-watch would NOT surface as a
  candidate (nested repos, repos inside ignored dirs, clones via rename of
  a fully-formed dir, submodule init, worktree add, daemon restart windows,
  registry overCap). Attack the cross-repo common-dir memo soundness (C2).
  Attack the journal-probe gating (C1) — any state where the pre-loop's
  lineage work matters even with no journal file present?
Also: are the doc's cost attributions plausible? Are the required tests
sufficient and testable? Is anything in the doc already contradicted by
docs/design/84*, 102*, 103*, 106*, 108*, 149*, 202*, 203* or their REVIEWs?

Output: numbered findings, each with severity (BLOCKER/MAJOR/MINOR/EDITORIAL),
exact evidence (file:line), and a proposed disposition. End with verdict:
ALIGNED or CHANGES-REQUIRED.
