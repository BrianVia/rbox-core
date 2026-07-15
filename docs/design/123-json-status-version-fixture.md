# Design 123 — Hermetic JSON status version fixture

## Problem

`status --json emits JSON and uses shellStateOf health values` compares the
entire status DTO, including `daemon.cliVersion`. The expected DTO duplicates
the release version as the literal `1.6.2`, while `statusCmd` correctly reads
the canonical `RBOX_VERSION`, now `1.6.3`. The test therefore fails both in the
full single-process suite and in isolation on the current checkout. The
observed failure is not an environment, activity-sidecar, or module-cache leak:
the health value remains the expected `outofstorage`, and the sole diff is the
stale version literal.

The release workflow exposed this after its version bump because it runs the
full source suite. Earlier isolated/sharded evidence came from a checkout where
the duplicated literal still matched.

## Change

Import `RBOX_VERSION` from `src/cli/version.ts` in `json-output.test.ts` and use
it for the expected `daemon.cliVersion`. Keep the full-object equality and the
literal `health: "outofstorage"` assertion unchanged. Do not change production
code, skip the test, or loosen any assertion.

This makes the test own only the status projection contract. The dedicated
version tests and release consistency gate continue to own the concrete
checked-in version.

## Validation

1. `bun test ./src/cli/json-output.test.ts`
2. `bun run typecheck`
3. `bun test ./src/` twice consecutively; classify only the user-exempt
   same-SHA metadata-heal/benchmark flake separately.

