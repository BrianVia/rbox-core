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
