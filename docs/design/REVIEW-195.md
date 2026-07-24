# REVIEW-195 — auth command decomposition

## Round 1 — NOT ALIGNED

- `RemoteContext` could not preserve raw auth headers/retries.
- The initial graph hid a device-login/pairing cycle.
- `account-commands.ts` recreated a dumping ground.
- Genesis destination ownership and validation were ambiguous.

Revision: exact raw compatibility wire, presentation/session leaves, dedicated
pairing/device/recovery/key owners, named transaction islands, expanded gates.

## Round 2 — NOT ALIGNED

- Logout and destination progress still had overlapping owners.
- The remote leaf still owned retry/error policy.
- Duplicate pair-create transports were not acknowledged.
- Export/cycle/compiled checks were not concrete.

Revision: sole owners, raw-Response-only compatibility wire, explicit legacy
lane restriction, concrete surface/cycle/guard/build/crash-resume checks.

## Round 3 — PARTIAL ALIGNMENT

Architecture reviewer: ALIGN.

Behavior-safety reviewer: one blocker. A `.test.ts` fixture is excluded from
root semantic typechecking, so type-only export compatibility was not proved.

Revision: added non-test `auth-cmd-surface.typecheck.ts`, compiled by
`bun run typecheck`, with bidirectional barrel/owner type assertions. Runtime
values, explicit export lists, and cycle checks remain in the test fixture.

## Round 4 — ALIGNED

Architecture and behavior-safety concerns are incorporated. Implementation may
begin only under the migration and validation gates in design 195.
