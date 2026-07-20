# Design 166 v4 fold notes

Source of truth: `SYNTHESIS-166-FINAL.md`, with full finding detail from
`REVIEW-166-FINAL.md`.

Design status: `v4 — pending delta verification`.

| Ruling | Folded section(s) | Result |
| --- | --- | --- |
| F1 — selective fast-forward fetch | Layer invariant; phases 1 and 3; recovery/status; safety properties; binding matrix | Deletes the in-repository adoption namespace and import-everything fetch. Only individually proven-fast-forwardable branches receive an explicit source-only refspec with `--no-tags --no-recurse-submodules --no-write-fetch-head`; the retained stash repository is the sole parking/reporting surface for every other Git value. |
| F2 — ref scope, ownership, and pause | Phase 0 inventory; phase 3 ownership/CAS protocol; journal; recovery; binding matrix | Distinguishes directory and pointer scopes, limits a pointer repository to its scoped branch, applies design-165 linked-worktree ownership checks, journals every before/after fast-forward, and makes CAS/ABA/ownership mismatch a persistent classifier pause with no stale-proof retry. |
| F3 — checked-out index inverse | Phase 3 checked-out-branch protocol; journal; abort; binding matrix | Durably retains the exact pre-operation A index/absence before ref CAS, runs lock-protected `git read-tree` against post-fast-forward HEAD without touching the worktree, and restores the saved index after inverse ref CAS on abort. Non-checked-out branches never mutate an index. |
| F4 — Git-plane containment | Phase 0 inventory; phase 3 mutation guard; binding matrix | Requires a no-follow component walk, realpath-inside-workspace/source-stash proof, and incarnation revalidation before each fetch/ref/index mutation. Refusal leaves the complete B repository in the retained stash. |
| F5 — full identity and no-clobber moves | Phase 4 implementation rule; exact-identity journal; recovery; safety properties; binding matrix | Streams a content hash for every displaced/overlaid regular leaf at any size, additionally records `(ino, size, mtimeNs, birthtime)`, pauses on any mismatch, and uses identity-gated dirfd/`O_NOFOLLOW` no-replace renames. |
| F6 — shared fence choke point | Global adopt fence; safety properties; binding matrix | Moves incomplete-adopt discovery into the shared mutation-mutex acquisition path and binds daemon, one-shot, push, pull, export, restore, versions-restore, Git resolve, `ignore --purge`, chain repair, recover, and every manifest publisher/applier. |
| F7 — cache generations | Completion/abort boundary; resident-daemon rule; recovery; ignore independence; binding matrix | Invalidates hash leaves, directory/scan state, persistent Git trackedness, and matchers; performs an unpruned uncached full scan; bumps a durable workspace generation watched and acknowledged by resident daemons; and applies the same boundary to abort. |
| F8 — continuation authority | Phase 2; journal schema; shared-fence exception; resume; binding matrix | Uses a persisted, consumed-once nonce bound to journal id, phase, workspace/stream, and exact healthy mutex incarnation. Only the invocation-local nested phase-2 capability crosses the fence; only validated resume may invalidate and remint it. |

Already-FOLDED FINAL material was retained verbatim: the stash-driven leaf
overlay and its three matrix rows; the no-repository/directory-swap and
phase-2-incarnation passages; same-stream and unsupported-mode refusal; consent
routing; ordinary incremental finish-sync semantics; the Git-incarnation row;
and the existing 20+ finish-fanout row. Targeted v4 mechanics were added around
those passages.

Checks completed before this file was created:

- exact-substring checks passed for every retained FOLDED passage and row;
- no `refs/adopt/*`, `refs/rbox-adopt/*`, `+refs/*`, or equivalent destination
  parking namespace remains in the design;
- the status line exactly matches `Status: v4 — pending delta verification`;
- every substantive F1–F8 fold site cites its corresponding
  `REVIEW-166-FINAL.md` finding, with matrix `final-N` labels explicitly mapped;
- `git diff --check -- docs/design/166-forward-adopt.md` passed; and
- an independent read-only F1–F8 fold audit reported no blocker or high.

Findings 9–11 were not folded because `SYNTHESIS-166-FINAL.md` targets the
orchestrator's F1–F8 rulings. The design remains pending the formal delta
verification required by the synthesis before implementation.
