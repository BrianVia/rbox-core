# Lessons

## 2026-07-02 — design 49 (daemon IO priority / concurrent releases)

- **Check origin tags before picking a release number.** Another agent shipped
  v0.6.5 while this branch was in review; `git tag v0.6.5` failed only LOCALLY
  after the version-bump commit was already made. `git ls-remote origin
  'refs/tags/v*'` first, then bump — and never reuse a failed tag's number.
- **Linux io priority is per-TASK.** `ioprio_set(WHO_PROCESS, 0, …)` sets only
  the calling thread; Bun's IO worker threads (the ones doing the disk work)
  already exist by daemon start. Iterate /proc/self/task — and make the verify
  getter walk every tid too, or the test proves nothing.
- **A backoff that trusts a signal must react to that signal's DEATH — and to
  its own armed timer.** Two codex MAJORs were the same shape: churn/error set
  a flag the next tick would read, while the already-armed 5m timer kept
  ticking. State changes that shorten a delay must re-arm the timer NOW
  (pinSafetyFloor), not at the next natural wakeup.
- **Put per-platform FFI behind the release smoke gate.** PR CI runs one
  platform; symbols/syscall numbers differ per target. __watcher-selftest
  already runs natively on all 3 release targets — one IOPRIO_SELFTEST line +
  a distinct exit code closed the gap for free.

## 2026-07-02 — design 46 (zsh shell integration)

- **Never `print -P` (or otherwise prompt-expand) tainted data.** Under
  PROMPT_SUBST — which WE enable, and every prompt framework enables — prompt
  expansion performs command substitution: a workspace name with backticks
  EXECUTED. Style and data must ride separate channels: raw `print -r` +
  literal ANSI for anything containing external strings; prompt escapes only in
  strings whose every character is plugin-authored or regex-pinned.
- **Emitted shell code needs `emulate -L zsh` in every function** — user options
  (SH_WORD_SPLIT, GLOB_SUBST) silently change expansion semantics, and `=~`
  clobbers MATCH/match globals unless localized. Test emitted scripts by
  DRIVING them in `zsh -f` with hostile inputs and hostile setopts, not just
  `zsh -n`.
- **A pipe to `tail` eats exit codes.** `bun run test | tail` reported green
  while a test failed (exit 1 visible only in the captured text). Gate on the
  test command itself, or grep for the fail count — never trust a piped tail
  as a success signal.
- **Steady-state loops need a settle write.** Every pump tick queued a
  follow-up push before writing (settled=false) and the no-op push never wrote
  — so the idle glyph would read `pending` forever. When a loop's last
  observable write happens mid-cycle, add an exit-of-loop state-compared
  reconciliation.

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
