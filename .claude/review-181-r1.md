# Review 181 — Upgrade stale-daemon swap

## Round 1

Verdict: not aligned.

- The draft placed ambient-version filtering before desired-binding validity.
  That could let a status file at an untrusted/mismatched desired root hide the
  existing live-runtime binding error, violating the requirement that binding
  validation remain unchanged.
- The review confirmed the existing ambient reader is the correct parser, exact
  version equality (not semver ordering or heartbeat freshness) is the current
  criterion, output must be buffered to put the stale summary before daemon
  lines, `--check` needs an explicit first-gate bypass, and the successful swap
  must pass no filtering options.

The design was revised to validate binding before reading ambient status and to
avoid printing either success summary when discovery/binding fails without a
known stale restart candidate.

## Round 2

Verdict: not aligned.

- The implementation mechanics and failure contract were aligned, but the test
  plan left actual `upgradeCmd` route coverage conditional and tested the
  successful full pass only by calling the restart function directly.

The design now requires command-level tests of both anti-rollback returns, the
first return's `--check` bypass, and the successful temp-file replacement path.
A two-function dependency seam avoids global module mocks while production
continues to use the real standalone and signed-manifest checks.

## Round 3

Verdict: aligned.

Both reviewers agree on binding-before-status ordering, exact-version filtering,
buffered prefix/error behavior, the `--check` bypass, unfiltered successful-swap
behavior, and mandatory command-level coverage of both early gates plus the real
temporary-executable replacement path. No installer, daemon, version, locking,
or forward-only behavior changes are permitted.
