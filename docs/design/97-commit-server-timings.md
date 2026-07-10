# 97 — Commit server timing decomposition

## Status

Implementation design for `SPEC.md`, following design 84 §6.1.

## Goal

Decompose the signed commit POST's server wall time without changing commit
semantics. Successful and cheap 409 responses expose a numbers-only timing
object, the commit metric records the same values, and an enabled client phase
report nests the object under its existing commit details.

## Server shape and boundaries

`ServerTimings` is a fixed object of non-negative integer wall milliseconds:

```ts
{
  totalMs,
  envelopeMs,
  accountingMs,
  sidecarMs,
  commitMs,
  mirrorMs,
  responseMs,
}
```

All measurements use `Date.now()` and add no awaits. `totalMs` begins at entry
to the Durable Object commit handler. `envelopeMs` covers capped body read,
JSON parsing, and envelope validation. `sidecarMs` covers the complete
`resolveSidecarBytes` call (zero for inline commits), including its
sidecar-specific lookup, receipt validation, R2 fetch, and parse. `accountingMs`
covers the non-sidecar remainder of receipt / entitlement validation and
accounting D1 work, or legacy missing-blob checks; the segments never overlap.
`commitMs` covers the synchronous Durable Object head CAS. `mirrorMs` covers
post-CAS alarm scheduling and D1 mirror writes. `responseMs` covers observable
one-pass response payload assembly before the final `json()` call. The final
serialization necessarily occurs after the returned timing snapshot and is not
included (the payload is tiny); no duplicate work is introduced.
Minor synchronous gaps such as mode setup, stored-envelope serialization, and
websocket fanout are included in `totalMs` but no narrower segment.

A small local timing accumulator owns segment closure, finalization, and the
numbers-only object. Success preserves `commitHash` and returns
`{ sequence, commitHash, serverTimings }`. Head and
epoch 409s return their existing fields plus `serverTimings`. Validation,
accounting, quota, and missing-blob failures keep their existing response shape;
instrumentation still records timings in the server metric where that metric is
already emitted.

The existing commit `OpSpan` metric gets each timing as a numeric detail on
every already-emitted commit outcome. `MetricEvent` gains seven numeric fields
(`serverTotalMs` for the response object's `totalMs`, then the six segment names);
Analytics Engine doubles 9–15 are, in order: `totalMs`, `envelopeMs`,
`accountingMs`, `sidecarMs`, `commitMs`, `mirrorMs`, and `responseMs`. The
positional schema documentation is updated; existing columns are untouched.

## Client propagation

The HTTP commit parser accepts an optional strict numbers-only `ServerTimings`
shape on success and 409 responses and returns it on `CommitChainResult`.
Compatibility with old servers is preserved: an absent object is accepted,
while a partial object or any non-finite or negative member is ignored as
malformed. The E2EE remote
adds it to the existing `CommitTimings` callback result. `sync.ts` already sends
that result to `PhaseReport.recordDetails("commit", ...)` only when the report is
enabled, so the emitted phase details become:

```ts
{ refreshMs, sidecarMs, encodeMs, encryptMs, uploadMs, postMs, encBytes,
  serverTimings: { ... } }
```

No identifiers, paths, or hashes enter either telemetry path.

## Tests

- API success and 409 tests assert the full key set and finite non-negative
  numeric values; the metric test asserts timing details are emitted.
- Remote/E2EE tests assert `serverTimings` survives response parsing and reaches
  the commit timing callback. A sync phase-report test asserts the callback's
  nested object is received by `PhaseReport.recordDetails("commit", ...)` and
  appears in emitted phase details.
- Run the acceptance commands from `SPEC.md` and `git diff --check`.
