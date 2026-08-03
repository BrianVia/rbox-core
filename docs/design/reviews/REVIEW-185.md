# Review log — Design 185

Design: `185-tui-component-framework.md`

Fable is explicitly prohibited for this work. Review rounds use GPT agents and
repository/runtime evidence only.

## Round 1 — GPT adversarial review

**Verdict:** NOT PASS

1. **BLOCKER — Native compiled evidence was not executable pre-merge.**
2. **HIGH — Ink terminal ownership and Ctrl-C were underspecified.**
3. **HIGH — TTY eligibility was ambiguous.**
4. **HIGH — Prompt parity omitted checkbox validation and async settlement.**
5. **HIGH — Secret completion contradicted the answer transcript.**
6. **HIGH — Yoga/asset verification could false-pass beside the checkout.**
7. **HIGH — Startup acceptance had no quantitative budget.**

### Disposition

Accepted all seven in v3:

- added a PR-gated three-target native PTY matrix, isolated
  `__tui-selftest`, UX/rig binary overrides, and release smoke;
- pinned Ink render options and one settle-once lifecycle with exact cleanup;
- added the stdin/stderr/`--no-interactive`/color truth table;
- completed owned prompt contracts and async validation/search rules;
- defined a fixed redacted secret transcript and whole-artifact sentinel tests;
- required copied-isolated binary execution, asset checks, hashes, sizes, and
  exact dependency/toolchain pins;
- added fixed p50/p95/RSS/binary-size budgets and an import sentinel.

## Round 2 — GPT adversarial re-review

**Verdict:** NOT PASS

Round 1 was substantively resolved. Two new issues remained:

1. **BLOCKER — Ink auto-disables interaction in CI or when stderr is not a
   TTY.** The design omitted `interactive`, so its CI PTY smoke and stdin-only
   eligibility contradicted Ink 7.1.1 behavior.
2. **HIGH — `--no-interactive` was not structurally visible to the facade.**

### Disposition

Accepted both in v4:

- intentionally tightened `isInteractive()` to require stdin and stderr TTYs;
- pinned `interactive:true` after that gate and required all three streams on
  the CI PTY;
- added an `AsyncLocalStorage<InteractionPolicy>` dispatch context so
  `--no-interactive` fails before runtime import with concurrent-test isolation.

## Round 3 — GPT adversarial re-review

**Verdict:** PASS

No blocker or high-severity finding remains. The two-TTY gate is coherent with
stderr rendering, `interactive:true` is reached only after that gate and defeats
Ink's CI auto-disable, the native selftest attaches all three streams to one
PTY, and the scoped interaction policy structurally blocks
`--no-interactive` before Ink evaluation.

## Implementation evidence corrections

Runtime reconnaissance found that cursor visibility cannot be snapshotted
portably. The contract now restores raw mode and explicitly leaves the cursor
visible. Prompt styling is also precomputed through rbox's stderr color policy
instead of relying on Ink's stdout-oriented color detection.

## Round 4 — GPT implementation review

**Verdict:** NOT PASS

The prompt implementation was sound after fixing default replacement, Ctrl-C
during validation, synchronous-failure cleanup, and exact-artifact reuse. The
review still found three acceptance-gate gaps: the performance budget was not
blocking CI, compiled UX/rig checks could skip or report-only, and secret
failure-path coverage was incomplete.

### Disposition

- added a blocking base-SHA versus exact-candidate startup/RSS/size job using
  identical Bun 1.3.14 compile flags and copied-isolated binaries;
- made compiled UX regressions and the Docker two-machine onboarding rig
  blocking and fail-closed when the dev bootstrap secret is absent;
- added native compiled validation-retry, abort, render-error, and secret-prompt
  Ctrl-C cases on all three targets, with complete tmux and saved-artifact
  sentinel checks.

## Round 5 — GPT implementation re-review

**Verdict:** PASS

No blocker or high-severity finding remains. The reviewer independently ran the
15-test real-Ink prompt suite, root/API and rig typechecks, and whitespace
validation, and verified the exact-artifact, performance, compiled UX/rig, and
secret-failure gates.

## Round 6 — post-implementation two-reviewer wave (Fable + opus, independent)

**Verdict:** NOT-MERGEABLE as submitted — PR CI was red; two blockers plus
infra defects the GPT rounds and local runs missed.

1. **BLOCKER — stdin-mutex collision crashed browser-login genesis (opus).**
   The fire-and-forget "press [c] to copy" keypress waiter held the new
   exclusive per-stdin prompt lock for the whole approval poll loop; the
   enrollment prompts that mount right after approval threw "another
   interactive prompt is already active on this terminal" — exactly the
   phone/other-browser approval path design 47 targets. Fixed: the copy-key
   handle is now `close(): Promise<void>` (abort + await full stdin release),
   awaited before post-approval enrollment; regression tests cover the aborted
   waiter → next prompt sequence and the fail-fast collision.
2. **BLOCKER — two 38-char pinned action SHAs (both reviewers).** ci.yml's
   compiled-TUI matrix checkout and release.yml's new smoke checkout pinned a
   truncated `actions/checkout` SHA; the compiled acceptance suite never ran
   and, post-merge, no release could publish (`publish` needs `smoke`).
   Fixed to the 40-char pin.
3. **Gate wiring (Fable, from the red run):** the onboarding-rig job exported
   `RBOX_DEV_BOOTSTRAP` but the rig requires `RBOX_DEV_PLATFORM_SECRET`
   (now passed; repo secret added); the perf-budget baseline hand-rolled
   `bun build` without the crypto-worker generation preamble (now builds via
   `scripts/release.ts --dev` in the baseline checkout).
4. **Behavior parity, caught by the flow specs (Fable):** the directory prompt
   rendered typed input on its own line — flows assert inline echo on the
   question line (fixed via the Frame `inline` slot); confirm submitted on a
   bare `y`/`n` keystroke, leaking the flow's trailing Enter into the next
   prompt (typo-no-phantom's phantom-accept) — restored Inquirer parity:
   typed answer + Enter, with tests and smoke updated.
5. **Determinism + hygiene:** checkbox validation test raced React render
   batching (now waits for the error frame); bun.lock referenced an untracked
   `file:vendor/react-devtools-core` (removed; frozen install verified); the
   promised raw-key guard now exists (`emitKeypressEvents` banned in src/) and
   the ink import guard covers subpath/`require` forms.

All 11 UX regress flows pass against a freshly compiled linux-x64 binary with
these fixes. Lesson recorded: compiled-gate workflows are code — they need the
same review scrutiny as src/, and a gate that has never run green proves
nothing.

### Round 6 addendum — pty keystroke coalescing (found by the compiled gate's
first Linux executions)

The compiled-TUI gate's first real runs exposed a genuine input-layer defect:
a slow pty coalesces independent keystrokes into one chunk, and Ink delivers
consecutive plain bytes as ONE input token — a trailing Enter (\r) or Ctrl-C
(\x03) vanishes inside a text run, hanging the prompt (arm64) or dying by
signal disposition reported as status 0 (x64 --cancel). Naively re-dispatching
split tokens inside useInput breaks React state closures (two synchronous
events read the same stale state), so the fix wraps the stdin Ink reads:
`splitKeystrokeChunk` re-chunks input at key boundaries (escape sequences kept
whole, bracketed-paste bodies passed through unsplit) and re-emits each key on
its own tick so React commits between keystrokes. SIGINT during a mounted
prompt now restores the terminal and exits 130 synchronously — an async cancel
path loses the race against ink's signal-exit re-raise. Covered by: coalesced
checkbox/input unit tests, a child-process SIGINT exit-130 test, six compiled
smoke scenarios, and 11/11 regress flows on a fresh linux-x64 binary.

### Round 6 addendum 2 — linux-arm64 cancel probe is environment-untestable

After the liveness probe (Down → highlighted row confirmed on screen before
Ctrl-C), the ubuntu-24.04-arm runner STILL reports the pane dying with status
0 — while linux-x64, macos-14, every local run, and a real `kill -INT` all
give the contracted 130. Founder call: accept that this specific assertion is
not reliably CI-testable on that runner class. It is now advisory on
linux-arm64 only (ci.yml `cancel-advisory`, release.yml warning path) and
blocking everywhere else; the pre-attach window remains covered by the
runtime's synchronous SIGINT handler. If the TUI test surface grows, evaluate
a real terminal-emulator harness (tui-test / pexpect-class) as a follow-up
design.
