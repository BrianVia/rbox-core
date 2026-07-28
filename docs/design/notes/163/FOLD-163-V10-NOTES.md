# Design 163 — v10 fold notes (round six, single item)

Input: the codex serial review of the v9 tip. It verified both v9 closures
(M6 last-instant body-hash re-verification; 128-byte reserve header, byte math
independently recomputed) and then falsified v9's blast-radius bound by
EXECUTING `reconcile` on the ABA case: stale BASE `B0`, local `B0` (user's
intentional revert), remote `B1` → ordinary `write`, no conflict copy.

v10 changes, all in the F5/residue passage plus the fixture matrix:
- The false bound ("never a silent content overwrite") is withdrawn.
- The stronger consequence is named: silent overwrite of an intentional revert
  in the lost-save lineage.
- Fixture `F6` asserts the silent outcome (red-to-green if a future mechanism
  detects it).
- Status line → v10; review log gains the R4-v10 section.

Deliberately unchanged: the ratification argument (preconditions + hard U3
drain gate) — it never rested on the withdrawn bound. No normative machine
text (M0–M7, Q, fencing, B0) was touched.

Verification: every claim above is grep-provable at the committed blob; the
orchestrator verified before commit (round-three-onward discipline).
