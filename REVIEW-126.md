# Design 126 adversarial review

## Scrutiny fix round

The locked design semantics were retained while implementation review found three safety
gaps: sidecar write/clear crash orderings could strand recovery, a breadcrumb mismatch
first appearing at the boundary proof could be adopted without preservation, and raw-byte
preservation failures deferred without a truthful forensic diagnostic.

Independent safety and cleanup reviews aligned on these corrections:

- Parseable journal JSON remains the arbitration authority when its ownership sidecar is
  absent or invalid; sidecar-only JSON absence is a pre-lock write crash and returns none
  after exact lock recovery. Only two valid, different ownership ids defer.
- Boundary proof rejects every newly appeared breadcrumb mismatch when the first proof did
  not construct preservation and an ORIG_HEAD lock plan.
- Preservation failures log one control-sanitized, 512-scalar message before returning the
  unchanged local-operation deferral.
- Shared no-follow reads and directory durability primitives were extracted, breadcrumb
  classification was consolidated without changing manual-resolution ordering or the
  in-progress presence gate, the boundary reason became an exact shared constant, capture's
  internal-ref exclusion was deduplicated, and ORIG_HEAD preservation moved to its owned
  module with CODEMAP updates.

Crash-order, boundary-race, fail-closed logging, and existing design-126 behavior tests pin
the result. Final acceptance is the requested sync-git/engine/git/git-cmd suites plus
typecheck; API tests remain intentionally excluded by the sandbox constraint.

## Final implementation re-review

The broad suite caught one interaction during the scrutiny round: the automatic
no-preservation boundary veto initially also rejected confirmed `take-theirs`. The veto is
now explicitly automatic-only, preserving the locked quarantine-backed manual override.
Review also extended the mandatory one-line preservation diagnostic to sanitize and bound
the repository display as well as the error across Unicode control characters.

Both independent reviewers align with no remaining safety, cleanup, ownership-map, import
cycle, or locked-semantics issue. Acceptance completed with 587 passed / 7 skipped tests and
green typecheck; `test:api` was not attempted as directed.
