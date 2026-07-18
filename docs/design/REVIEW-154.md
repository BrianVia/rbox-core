# REVIEW-154 — review ledger

Design under review: `154-stdlib-cleanup.md`.

## Round 1

Verdict: **CHANGES REQUIRED**.

- BLOCKER: Bun 1.3.14 may hang instead of propagating a Web-stream
  `TimeoutError` through `Readable.fromWeb`. Accepted: pass the composite signal
  to pipeline, narrowly restore a `TimeoutError` reason from pipeline's
  `AbortError`, disarm idle before hash work, and add a settlement/classification
  regression test.
- HIGH: bare `PassThrough.write` after `end` does not preserve ignored post-close
  pushes. Accepted: retain the old closed/idempotence guard.
- MEDIUM: doctor boundary mapping and `loadRawState` falsy/marker semantics were
  underspecified. Accepted and made explicit in v2.
- MEDIUM: daemon field removal and overlapping waiter proof were underspecified.
  Accepted and made explicit in v2.
- Packer: no finding.

## Round 2

Verdict: **CHANGES REQUIRED**.

- HIGH: adapter verification must use an actual Bun fetch body. Accepted: v3
  prescribes the locally proven large-`blob:` fetch probe, which needs no socket.
- MEDIUM: malformed marker JSON conflicted with the stated mapping. Accepted:
  only parse errors naming `.rbox/state.json` receive the invalid-JSON copy; all
  marker errors receive the read-failure copy.

## Round 3

Verdict: **ALIGNED**.

## Implementation finding / Round 4

The full CLI suite invalidated the direct-adapter assumption: the existing
partial-body `ECONNRESET` test hung in Bun's `Readable.fromWeb`, leaked an
uncaught error, and contaminated later tests. v4 adds the minimal
`pipeTo(TransformStream)` compatibility bridge while preserving pipeline as the
sole Node writable pump. Pending adversarial review.
