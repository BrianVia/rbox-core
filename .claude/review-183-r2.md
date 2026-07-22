# Design 182 review round 2

Verdict: **CHANGES REQUIRED** (mechanics aligned; registry proof/census needed
one more fold)

## Findings and rulings

1. **BLOCKER — credential recurrence called confirmed without its rerun.**
   Accepted. July 20 is the confirmed historical incident; July 22 remains a
   suspected recurrence with same-SHA rerun pending.
2. **BLOCKER — §11 called confirmed without an explicit three-witness set.**
   Accepted conservatively. It remains SUSPECTED/FIX PENDING in the initial
   registry; current post-fix proof cannot retroactively replace a missing
   historical witness.
3. **HIGH — July 20 websocket run was an original failure, not a recurrence.**
   Accepted. The registry uses “first failure,” links both original design-170
   CI jobs, and says cluster-wide historical proof remains incomplete where an
   exact same-SHA rerun URL was not recovered.
4. **HIGH — refwatch history described only three of four retained incidents.**
   Accepted. The row records two main-CI legs, one July 21 release smoke, and
   the v1.7.16 train; unrecovered run URLs are explicit rather than invented.
5. **MAJOR — exact sleep/setTimeout census had eight unnamed files.** Accepted.
   All 34 matching test files now have an actionable or note-only exact-path
   disposition, including daemon git capture/ref integration, layer-A,
   uploader fill, resilient retry, apply concurrency, keep-pins, git-sync, and
   the manifest-delta performance gate.
6. **MEDIUM — git-sync's four 1 s races were not one class.** Accepted. Only
   the independent-repo positive event receives a 10 s failure ceiling. The
   three held-operation negative non-overlap windows stay note-only concurrency
   contracts.
7. **MEDIUM — follow registry still offered a timestamp/clock fork.** Accepted.
   It now matches the design's exact `heldNow` seam.
8. **LOW — #331 watcher identity was too broad.** Accepted. The registry names
   the SCALE test and its `<10s`, `<300MB`, and 500 ms assertions alongside the
   native negative windows.
9. **OPERATIONAL — rig lifecycle omitted `up`/`down`.** Accepted. The design
   pins doctor → up → two scenarios → preserve evidence → scoped down.

Round 3 is required to certify the proof labels and census closure.
