# FOLD-163-V8 notes

Round-four targeted fold on `docs/design/163-state-plane-sqlite.md`. Input: the
codex serial review of the v7 tip (2026-07-28), seven residuals. Same discipline
as v7 — every closure lands in a normative section, and the review-log row cites
it rather than substituting for it.

## What changed

1. **B0 third case.** V7's "no third case" rested on a false premise:
   `writeWholeStateUnsafe` is reached by `unsupported` locking **or**
   `forceLegacy`, so an unlocked check→rename window can exist on a lockable
   filesystem — exactly the workspace M0 admits. Closed in two parts (unlocked
   path enterable only on `unsupported`; M0 gains a fifth condition, *no live
   legacy writer at all*, by paired bounded-interval witness sampling) plus one
   **named, accepted residual** for pre-`1.11.0` writers, with its four
   simultaneous preconditions and its after-the-fact detection. Fixtures rebuilt
   as `F1`–`F4` because v7's fixture required a full M0–M7 on a workspace M0
   refuses.
2. **Witness content binding.** Sidecar gains `stateBodySha256`,
   `stateSizeBytes`, `stateMtimeMs`; hash+size authoritative, identity triple
   corroborating, all five required, fail-closed both directions.
3. **M7 vs role 5.** Inert control temp is exact-terminal *by definition*,
   asserted over a closed revision-scoped path set. No classifier widened, no
   directory discovery introduced.
4. **Reserve provenance.** 64-byte ASCII header inside the same 1,048,576-byte
   file; adoption requires it; `reserve-foreign` is never adopted, claimed,
   truncated, or deleted; M6 re-verifies before unlinking.
5. **"Clean by construction" swept** at both surviving sites to the
   differential-gate framing.
6. **Stale heading** `U4 reset/quarantine` → `U2`.
7. **Open inputs = two**, not one; the top-of-document list is now the authority
   on the count and the kill-criterion protocol cross-references it.

## Standing observations

- Two of seven residuals were v7 *assertions* unsupported by its own normative
  text ("there is no third case", "exactly one input remains"). The v7 lesson —
  a log row records a closure, it never constitutes one — generalizes: a
  summary sentence does not constitute one either.
- Item 1 is the first residual in this document deliberately closed as
  **accepted and named** rather than eliminated. It has a fixture (`F3`)
  asserting the known-bad outcome, so it cannot drift into a different residual
  unnoticed.
