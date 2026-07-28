# SPEC: 163-U1b — the store write seam: transition stages, CAS packet, LOCAL plane

Final slice of U1. NORMATIVE: docs/design/163-state-plane-sqlite.md §"Narrow
store operations and CAS semantics" (line ~3785) through §"Digest scope"
(~3911), plus every constraint recorded in
docs/design/notes/163/U1B-FINDINGS.md (committed with U1a) — that file is the
distilled review history of the FIRST attempt at this seam, which was
withdrawn NOT-ALIGNED. Treat each finding as a hard requirement:
id-scoped locks, no-follow verification, private bounded cursors, coherent
snapshots, one-at-a-time stage access, the proofless-BASE counterexample
(a regression test for it is REQUIRED), and the O(N) lessons (iterators +
SQL anti-join, never materialized arrays/Sets).

Also enforce the two constraints U1a recorded as unenforced-until-U1b:
(chainBytes===0)===(chain.length===0) and manifest-chain self-exclusion
(design 163:3574-3576) — CHECK or codec per the design.

Home: src/cli/state-plane/store/ (write-packet.ts, generations.ts,
transition-stages.ts, operation-plans.ts, local-plane.ts — the names the
sweep-3 target layout reserved). Respect every U1a surface decision:
bun:sqlite stays out of the production-imported facade (write seam exports
join the same subpath the read substrate lives behind), entry identity per
the post-review scheme (entry_id independent of fingerprint; collisions
resolved by exact comparison), materializeManifest's purpose/projectionToken
signature.

NOTHING is wired into production flows. Authority remains the JSON file.
The only consumers are tests.

Tests: the design's operation table row by row (accepted/rejected(reason)/
busy/unsupported), stage exclusivity, snapshot-change retry, the
differential harness extended to write-then-read round-trips (write a
packet, read back through the U1a adapters, deep-equal vs the JSON path
applying the same logical delta). Fault injection at every stage boundary
the design names. Red→green proof for the proofless-BASE regression.

Acceptance: bun run typecheck; bun test src/cli/state-plane/; bun test
src/cli/. Stage by name, commit on the branch, no push. Files ≤500 lines.
