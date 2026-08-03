# Review 143 — storage-truth REST adapter

## Round 1 — changes required

1. The connection-error component schema omitted config and roots-inspect.
2. R2 GET/list mapping and error semantics were underspecified.
3. Deadline timers and sibling preflight cancellation lacked a cleanup invariant.
4. The SELECT-only rule needed lexical handling of quotes/comments and explicit
   rejection of Cloudflare write metadata.

All four findings are adopted in design 143's adapter contract, establishment
protocol, error schema, and acceptance tests.

## Round 2 — changes required

1. `requiredEnvironment` was described once as universal and once as
   component-specific. Design 143 now defines exact arrays for config, D1/R2,
   and roots-inspect failures.

## Round 3 — aligned

No remaining findings. The design is implementation-ready.

## Implementation scrutiny — changes required

1. R2 GET needed an explicit unsafe-dot-segment policy because WHATWG URL
   parsing normalizes `.` and `..`; the adapter now rejects those segments and
   tests slash plus reserved-character handling.
2. `source.close()` errors were outside the structured runner boundary; they
   are now normalized/rendered without overwriting a primary failure.
3. Helper-level failure assertions did not prove runner behavior; a subprocess
   test now verifies stderr, JSON output, and exit code 2.

## Implementation re-review — aligned

No remaining correctness, zero-write, timeout/cleanup, REST
envelope/pagination/key, structured-runner, redaction, or adapter-contract
findings.
