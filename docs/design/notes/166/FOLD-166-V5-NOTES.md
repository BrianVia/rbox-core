# Design 166 v5 fold notes

Source of truth: `SYNTHESIS-166-V5.md`, with finding detail from
`REVIEW-166-V4-DELTA.md`.

Design status: `v5 — pending delta verification`.

| Ruling | Folded section(s) | Result |
| --- | --- | --- |
| G1 — exact journaled-OID fetch | Layer invariant; phase 3 proof/fetch boundary; safety properties; binding matrix | Fetch names the proved journaled 40-hex OID rather than a mutable branch. Source movement cannot import the moved-to tip; disappearance/GC PARKS before target ref/index mutation. |
| G2 — checked-out eligibility gate | Phase 3 gate/index path; journal; status/resume; binding matrix | A checked-out fast-forward is eligible only when `indexTree == HEAD tree` and no operation state exists at both the initial and prepared mutation-boundary gates. Otherwise it PARKS without CAS/read-tree; the eligible path retains the saved-index inverse and post-FF read-tree. |
| G3 — external pointer-source refusal | Phase 0 eligibility; phase 3 source scope/containment; safety properties; binding matrix | A linked-worktree/pointer source refuses the invocation before journal publication or movement, remains in place, and reports that its history travels with its main clone. A separate self-contained main-clone invocation adopts normally. |

`REVIEW-166-V4-DELTA.md` findings 1, 2, and 3 are cited at their
substantive fold sites. The binding matrix includes the exact synthesis rows
`source-moved-before-fetch`, `source-moved-after-proof`, `proved-object-GC'd`,
`conflicted-merge repo`, `clean repo`, and `linked-worktree source`.

All previously CLOSED/FOLDED material was preserved verbatim outside the narrow
G1–G3 intersections. In particular, the no-swap and phase-2-incarnation
passages, nested no-directory-rename rule, original D2 overlay, D5/D6 bodies,
F5–F8 mechanics, and their unaffected binding rows remain intact. No adoption
parking namespace was reintroduced.

Checks completed before this file was created:

- the status line exactly matches `Status: v5 — pending delta verification`;
- the exact fetch argv uses `<journaled-40-hex-oid>` and no branch-name fetch;
- each of the six required v5 matrix rows occurs exactly once and all table rows
  have the expected column shape;
- stale v4 pointer-source and dirty-index successful-path language is absent;
- `git diff --check -- docs/design/166-forward-adopt.md` passed; and
- three independent read-only audits reported no blocker or high finding.

The design remains pending the formal delta verification required by the
synthesis before implementation.
