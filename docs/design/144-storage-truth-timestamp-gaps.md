# Storage-truth timestamp gaps

## Problem

The D1 `commits` table is a best-effort mirror and can legitimately omit old
sequences that remain readable in a workspace's authoritative roots index. The
live measurement currently turns any absent mirrored `created_at` into
`status: uninspectable`, even though timestamps do not participate in the
Section-A entitlement partition. Only the retained-but-window-expired Section-B
diagnostic needs them.

## Contract

The platform-admin roots route remains fatal when the Durable Object roots read
fails or returns malformed root pages. Timestamp enrichment is non-authoritative:
for every root sequence the route returns the mirrored epoch timestamp or
`null`. Missing workspace ownership, missing commit rows, and timestamp-query
failures produce nulls and retain the successful roots page.

The live adapter accepts absent or null map entries and emits `committedAt:
null`. Non-null values must still be finite positive epoch milliseconds.

The runner stores nullable timestamps without changing the Section-A root
membership predicates. A non-head root SHA with any timestamp-less retained
reference is excluded from the window-expired result because that unknown
reference could be recent. It is counted once in `sectionB.timestampGapRoots`.
The human report renders exactly:

`timestamp-gaps: N roots (window-expiry unknown for these)`

Head SHAs are not timestamp-gap diagnostics because their head membership
already excludes them from window expiry. The spool schema version increments
because `roots.committed_at` becomes nullable.

## Verification

Fixtures cover a route response with a missing mirrored sequence, adapter
pass-through of null and omitted timestamps, and a complete runner report whose
partition still holds while the gap root is excluded from window expiry.

Required gates are `bun run typecheck` and `bun run test:storage-truth`.
