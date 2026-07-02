# Design 49 — daemon IO priority + idle safety-scan backoff

Branch feat/daemon-io-priority-49 (worktree — other agents own the main checkout).
Spec: docs/design/49-daemon-io-priority.md. Origin: 2026-07-02 machine-contention
incident (Conductor 5s shell budget blown; profiling showed AV+Spotlight as the
hogs, rbox already CPU-niced — this ships the earmarked IO half + scan backoff).

## Plan

- [x] design doc 49
- [x] src/cli/io-priority.ts — darwin setiopolicy_np THROTTLE / linux ioprio_set BE-7
      via bun:ffi, best-effort, daemon-only (+ bun-ffi.d.ts minimal shim)
- [x] daemon: log io outcome at start; safety scan setInterval → self-rescheduling
      setTimeout, quiet doubles 60s→5m cap, churn/degraded pins 60s floor
      (pure nextSafetyDelay + wiring)
- [x] tests: nextSafetyDelay table, churn-flag wiring, spawned platform probes
      asserting the policy TOOK via OS getters (never in-process — would throttle
      the suite)
- [x] full suite green in worktree (459 pass; watcher.test.ts self-skipped: FSEvents
      probe fails under current machine load — env, runs on CI inotify)
- [x] self-found hole to fix: watcher error AFTER init leaves watcherLive true →
      backoff stretches the only healer to 5m; thread onError → pin 60s floor
- [x] codex adversarial rounds → PASS (3 rounds)
- [ ] PR → merge → v0.6.5 → upgrade both machines

## Review

3 codex rounds → PASS; 460 tests green; constants/arity verified against SDK
headers + kernel sources by codex R1. Findings fixed en route: R1 M1 churn
didn't re-arm an armed backed-off timer → noteChurn; R1 M2 post-init watcher
death trusted forever → WatchOptions.onError (parcel+chokidar) flips
watcherHealthy permanently; R1 M3 linux ioprio_set who=0 set only the calling
thread, missing Bun's pre-spawned IO workers → iterate /proc/self/task (+
verifyIoPriority reads back every tid); R1 MINOR darwin-arm64/linux-arm64 FFI
untested by any gate → IOPRIO_SELFTEST leg in __watcher-selftest (exit 4),
runs natively on all 3 release targets; R2 onError didn't pull the ARMED
timer forward → shared pinSafetyFloor() (no-op at floor, stop-guarded).

---

# Design 46 — shell integration (ambient prompt status)

Branch feat/shell-integration-46. Spec: docs/design/46-shell-integration.md.
Orchestration: efficient-frontier — slices farmed to opus subagents with
disjoint file ownership; integration/review/codex kept central.

## Plan

- [x] design doc 46 (architecture decision: daemon pre-renders `.rbox/state/shell.line`;
      zsh reads one line with builtins — no JSON parsing, no duplicated verdict rules)
- [x] **Slice A (agent)**: shell.line sidecar — renderShellLine (pure) + saveShellLine
      in activity.ts; daemon writeActivity chains it; resetSyncState removes it; tests
      (owns: activity.ts, daemon.ts, config.ts, activity.test.ts, daemon-activity.test.ts)
- [x] **Slice C (agent)**: `zshCompletions()` generator from COMMAND_HELP + tests
      (owns: completions.ts, completions.test.ts — NO index/help wiring)
- [x] **Slice B (agent, after A+C)**: `rbox shell-init zsh` emitting plugin
      (chpwd banner + precmd RPROMPT glyph, builtins-only, RBOX_NO_RPROMPT escape) +
      embedded completions; `rbox completions zsh` command; index.ts + help-registry
      wiring; docs snippet incl. starship module
- [x] integrate: full suite + tsc, live smoke (eval shell-init in a real zsh, cd into
      ~/conductor/workspaces, verify banner + glyph + shell.line freshness)
- [x] codex adversarial rounds → PASS (5 rounds)
- [x] PR #51 merged → v0.6.4 tagged → machine upgrade+validation delegated

## Review

5 codex rounds → PASS; 453 tests green; PR #51 squash-merged; v0.6.4 tagged.
Findings fixed en route: R1 BLOCKER print -P command-substitution (hostile
workspace name EXECUTED under PROMPT_SUBST; halt message's own backticks ran) →
raw print -r + literal ANSI; R1 field-recycling parse → whole-line regex gate;
R2 emulate -L zsh + quoting (SH_WORD_SPLIT/GLOB_SUBST glob-expanded a '*' name),
localized MATCH globals, digit-capped gate, flag-gated retroactive opt-out;
R3 compinit-order completion registration (self-removing precmd retry);
R4 stuck-pending settle at pump exit (idle glyph would lie yellow forever).
One unreproduced full-suite flake observed locally (exit 1 masked by a tail
pipe — caught on re-read); 6 repeat runs + PR CI all green. Orchestration:
3 parallel opus subagents with disjoint file ownership; PROMPT_SUBST gap and
all codex fixes handled centrally.

---

## Done earlier this session (design 45, v0.6.3 — shipped)

Status health verdict + activity sidecar + transfer percentages; PR #50 merged;
6 codex rounds → PASS; v0.6.3 released and live-validated on both machines
(canary round-trip ~5s; madison-v1 un-shallowed post-release → git-sync now 2
repos synced on both machines). Full review log in git history of this file.
