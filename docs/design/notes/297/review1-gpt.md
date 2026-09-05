# Design 297 — adversarial review round 1

Verdict: NOT ALIGNED.

Required changes, incorporated before implementation:

- Specify repeated `iterator.next()` consumption; breaking a `for...of` closes
  a generator.
- Use a test-local legacy `diffChunk` oracle for exact five-case comparison.
- Retain the repository-required `bun run rig` integration gate.
- Exercise every removed and added data-transaction crash with a fresh
  `WorkspaceSync` on resume and compare against uninterrupted final rows.

## Round 2

Verdict: NOT ALIGNED.

The focused suite passed 28/28 and typecheck passed. Generator lifetime,
cursor replay, six crash points, and the five legacy differentials were
correct. The visit-count test still called `diff` directly, so it would not
detect `foldSequence` recreating that iterator per chunk. Route the assertion
through `foldSequence` with counting Sets and keep `diff` private.

## Round 2 correction

Verdict: ALIGNED.

The test now stubs `refSetAt`, drives two real alarms through `foldSequence`,
asserts the seed plus eight data-chunk, phase-transition, and final
transactions, and observes at most 40,000 visits. `diff` is private again.
Focused suite: 28/28 passed. Typecheck passed. The reviewer found the generator
lifetime, atomic cursor replay, six crash points, five-case legacy differential,
and acceptance gates aligned with the spec and repository rules.
