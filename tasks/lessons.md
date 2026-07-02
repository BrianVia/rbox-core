# Lessons

## 2026-07-02 — design 45 (status health / activity sidecar) review arc

- **"Cosmetic" visibility features deserve data-safety-grade review.** 6 codex
  rounds on a status/observability PR found a real BLOCKER (any pump success
  cleared the mass-delete-guard halt — the indicator light we built the feature
  for would flap off within seconds) plus 8 more findings. If a surface is how
  users learn the truth, a bug in it is a truth bug, not a cosmetic one.
- **Every per-binding cache must join the rebind reset.** activity.json repeated
  state.json's design-44 lesson within a day of being invented: any new sidecar
  keyed to a workspace binding must be cleared in `resetSyncState` (and its
  consumers must suppress stale-bound daemons). When adding a sidecar, grep for
  `resetSyncState` and ask "does mine belong here?" — the answer is yes.
- **A derived-status walk must mirror the planner's ORDER, not just its rules.**
  gitDivergenceCount had all of planGitSections' suppression rules but ran
  preflight before needsResolution — same predicates, different order, different
  verdict. When mirroring a decision procedure read-only, copy the sequence.
- **The effective-remote rule (`creds.remoteUrl ?? cfg.remoteUrl`) has now bitten
  three times** (design 44 R3, track, status R1). Any NEW code that touches
  syncStreamId/loadState must resolve the effective remote first — grep
  buildAuthedRemote for the canonical rule.

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
