# Review 230 · Round 2

**Reviewer:** adversarial code-review subagent
**Initial result:** not aligned
**Validation in round:** focused tests, typecheck, lint, and diff check

## Findings

1. A workspace-required JSON error string had been rebaselined along with human
   copy, contradicting the design's automation-compatibility boundary.
2. “Add another” compared normalized path strings but not physical directory
   identity, so a symlink alias could still reach the rebind prompt.

## Revision

- JSON error mode preserves the legacy serialized workspace-required messages;
  non-JSON human errors use the new synced-folder language.
- The excluded-root guard compares canonical physical paths after directory
  validation and fails closed on identity-read errors.
- A symlink-alias regression test proves the current physical folder is rejected
  before remote creation or rebind.

The focused changed-surface suite passes 183 tests after these revisions,
including a matrix that pins all reachable legacy JSON workspace-error strings.
Typecheck, lint, and `git diff --check` pass. The two-device `onboard-smoke` rig
also passes with byte-identical trees across 101 files, including empty-file and
symlink coverage.

**Final result:** aligned
