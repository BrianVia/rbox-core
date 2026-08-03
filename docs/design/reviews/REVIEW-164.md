# Review 164 — Suite-wide timeout and shard hardening

## Round 1

Verdict: not aligned.

- The first draft covered only the sharded `src` tree and omitted script, API,
  and web test files.
- It needed exact commands, all greater-than-two-second cases and ratios, a
  definition of the effective CI cap, corrected incident-scaled E2EE caps, and
  deterministic shard indices.

The design was revised to cover the source, script, and API test trees and to
record the complete timing/cap inventory and corrected 120/60/20-second changes.

## Round 2

Verdict: not aligned.

- The API count included three web tests that the API command had not run.

The web dependencies were installed from the lockfile, all three web test files
were measured separately, and the API/web counts were corrected.

## Round 3

Verdict: aligned.

Both reviewers agree on the timeout inventory, incident rationale, whole-file
E2EE anti-affinity placement, six-shard consistency, and validation plan. No
assertion weakening or product test-logic change is permitted.
