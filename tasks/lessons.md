# Lessons

## 2026-07-02 — the setup-rebind mass-delete incident (design 44)

- **Any cached diff baseline must be stamped with the FULL identity of the stream it
  was built from** — and every loader must treat a mismatch as "no baseline", not
  trust the file's presence. Presence ≠ validity. The stamp must include *every*
  coordinate that selects a distinct history (here: remote URL + workspace + project —
  the first two attempts each missed one and codex constructed data-loss repros).
- **A sync engine needs a mass-delete circuit breaker regardless of root cause.**
  Whatever bug produces a "delete most of the tree" plan next time, the guard is the
  layer that saves the user. Fail closed before touching disk; require explicit human
  consent; never let the daemon self-consent.
- **Never print success for work that didn't happen.** "published → sequence 75" for a
  zero-byte no-op actively hid the bug; the user noticed the missing progress spinner
  before we noticed anything. Success messages should be derived from what the
  operation *did* (a `committed` flag), not from reaching the end of a function.
- **Recovery leaned entirely on two design invariants**: rbox only deletes files it
  tracks (so the server-side manifest is the exact inverse of the damage), and `.git`
  is never synced/touched. Invariants like these are what make incidents survivable —
  protect them in review.
- **Adversarial codex rounds on data-safety code are worth every token.** 4 rounds
  found 3 real BLOCKERs (track path missed, project-id hole, effective-remote hole)
  after I believed the fix complete — each round with a concrete repro scenario.
