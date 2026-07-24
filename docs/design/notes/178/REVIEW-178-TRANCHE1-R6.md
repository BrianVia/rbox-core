# Design 178 tranche 1 — field-failure review R6

Verdict: **ALIGNED**

The revised E contract closes all R5 blockers: pending intent wins on CLI,
boot, and managed resume; confirmed liveness is recorded before mode admission;
desired mutations are serialized and atomically published with conditional
promotion; the repeated-flag matrix retains pending on UNKNOWN/MISMATCH; and
the post-pidfile hook plus exact 15s production wait have a fail-closed,
testable contract.

Implementation cautions: every mutation must re-read under the lock, the lock
must use the repository's crash-recoverable ownership machinery, and resume
paths must use shared reconciliation through promotion rather than merely
selecting pending mode for spawn.
