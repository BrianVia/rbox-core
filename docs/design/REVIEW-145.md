# Review 145 — Git-shapes first-live-run fixes

Review rounds for `docs/design/145-git-shapes-first-live-fixes.md`.

## Round 1 — CHANGES REQUIRED

1. S1(a)'s proposed relaxed child proof would hide the live held-ref/apply
   deferral. Remove the redundant child roundtrip and leave pointer
   bidirectionality to S1(b), or ratify the complete held-ref contract.
2. A help/no-args exit test already passes before the fix. Test a synthetic
   main returning 1 in a subprocess and pin FAIL → 1 directly.
3. Update the annex's invalid LFS flag and prove configured/unconfigured
   effective filter state before pull.
4. Bound settlement, require zero exits, retain a sequence trace, and test the
   observed `5/6 → 6/6` progression plus a stable verification round.
5. Assert both merge conflicts/MERGE_HEAD states so reset-based cleanup cannot
   become vacuous.
6. Retain immutable A/B init results and name B init as the apply-line boundary.

## Round 1 disposition

All six findings accepted in design 145 and the design-141 annex. S1(a)'s
redundant roundtrip is removed rather than weakened. Exit handling uses
top-level await plus `process.exitCode`, LFS arms gain executable/effective
config probes, convergence gains a modeled trace test, and merge entry/deletion
states become explicit assertions.

## Round 2 — ALIGNED

The reviewer confirmed all Round-1 findings are closed. The bisect sequence
interpretation remains legitimate and the design pins fixed-point behavior
without inventing a fixed sequence delta.

## Post-implementation evidence correction

The first-live stderr locates S3's duplicate-path refusal on B, after A's init
had accepted the colliding manifest. The implementation pass corrected the
design/annex and scenario: enroll empty A/B first, accept A's later publish,
then assert identical receiver refusal on two B pulls, no B sequence
consumption, and no B worktree mutation. This correction is re-dispatched for
alignment before completion.

## Round 3 — ALIGNED

The final implementation review closed two evidence-boundary gaps: S1(b) now
pins the exact B-init apply line, and S4 inspects retained A-init output for its
conditional forensic line. The reviewer also confirmed that S3's corrected
receiver-side lifecycle matches the live topology and remains fail-closed: A's
publish must be accepted, both B pulls must reject identically, B must not
consume the sequence, and B's worktree must remain unchanged. No concrete
issues remain.
