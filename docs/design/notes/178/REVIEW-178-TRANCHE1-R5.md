# Design 178 tranche 1 — field-failure review R5

Verdict: **BLOCKING**

The slow-first-heartbeat correction fixes the literal CLI-process lifetime
failure, but the first revised contract leaves five semantic holes:

1. Boot resume and managed restart can choose accepted read-write while a
   durable pull-only intent is pending. Every preserve/resume path must give
   pending mode precedence and promotion must remain available after restart.
2. A confirmed live daemon with a differing or unknown mode still proves
   desired liveness. Admission errors must happen only after `state: running`
   is persisted without changing accepted/pending mode.
3. Plain truncate writes and unconditional late promotion permit lost intent,
   torn records, and resurrection after a concurrent stop. Desired mutations
   need cross-process serialization, atomic publication, and conditional
   promotion; stop must win over stale witness completion.
4. Repeated explicit flags need a complete matrix: same-as-pending reconciles;
   conflicting explicit intent cannot displace pending without a witnessed
   match; mismatch and unknown retain pending.
5. The awaited post-pidfile hook must run before polling, propagate failure,
   and repair/terminate its spawned child rather than leave an unrecorded
   daemon. The 15s production timeout and poll/timeout test seams must be
   threaded through the desired-state wrapper.

The design was revised to include these requirements and re-dispatched.
