# Design 178 tranche 1 — second field-trace review R9

Status: **ALIGNED**

The field trace showed that the R8-aligned model still treated
`pendingModeIntent` as transient reconciliation scratch: stop stripped it and
a later bare start manufactured a read-write pending from the default mode.
The corrected contract treats pending as durable explicit user intent:

1. stopped records retain it;
2. bare start resolves pending, then accepted, then the compatibility default,
   but never authors a pending value;
3. only explicit mode flags create or replace pending, including an opposite
   flag against a live unknown/mismatched daemon;
4. boot-bound matching witnesses may promote at start, stop, or status, but
   promotion is not needed for restart survival.

## Review pass 1 — CHANGES REQUIRED

The first pass found that opposite replacement was still callback-dependent:
a hookless `retry-later` or stop-before-`onLive` race could lose the newer user
intent. It required pre-daemon explicit parking, exact-generation fencing, and
direct bare-no-author/status-promotion coverage.

## Review pass 2 — ALIGNED

The implementation now parks explicit intent under the desired lock before
daemon work, fences later live/spawn/promotion callbacks to the claimed
generation, preserves current pending on every bare callback, folds only a
matching boot-bound witness into stop, and limits status promotion to a
running desired record for the current workspace. Additional local review
also pinned that a bare start cannot promote its older witnessed mode over a
newer concurrent explicit pending value.

Validation at alignment: `bun run typecheck && bun test
src/cli/daemon-control* src/cli/autostart*` — green.

Post-alignment hardening was re-reviewed ALIGNED: an older bare-start witness
cannot promote over a newer opposite pending intent. Final focused result: 58
passed, 0 failed.
