# Design 166 v3 fold notes

Source of truth: `SYNTHESIS-166-R2.md`, with finding detail from
`REVIEW-166-R2A.md` and `REVIEW-166-R2B.md`.

| Ruling | Folded section(s) | Result |
| --- | --- | --- |
| D1 — fetch-union | `Phase 3 — Git fetch-union, never a repository swap`; `No Git replacement`; Git rows in `Binding test matrix` | Removes repository swaps. Fetches B refs/objects into the phase-2 incarnation, fast-forwards only ancestry-proved branches by CAS, and parks/reports every other Git value under `refs/adopt/incoming/*`. |
| D2 — per-file overlay | `Phase 4 — per-file overlay with retained collisions`; `No manufactured deletion`; file/type rows in `Binding test matrix` | Makes the overlay stash-driven and leaf-granular. A-only paths remain live, same-type collisions retain A in `displaced/`, and type/special collisions retain B in `unplaced/`. |
| D3 — exact-identity journal | `Exact-identity journal and crash protocol`; journal/power-loss/abort rows in `Binding test matrix` | Replaces phase-plus-presence recovery with exact identities, a closed classifier, ordered parent-directory fsyncs, power-loss coverage, and the honest full-B-plus-full-A headroom model. |
| D4 — global fence | `Global adopt fence and completion boundary`; fence/mutex/cache rows in `Binding test matrix` | Requires daemon, one-shot sync, push, and pull to refuse incomplete adoption under the mutex; refuses degraded mutexes; keeps recovery independent of the kill switch; invalidates scan state before fence lift. |
| D5 — scope and consent | `Scope and consent`; same-stream/unsupported-mode/consent rows in `Binding test matrix` | Limits adoption to fresh non-empty `init --workspace` joins with default `firstSync=sync`; refuses same-stream, pull-only, keyed/agent, and no-sync routes; uses wizard/direct typed consent and explicit headless `--adopt`. |
| D6 — finish-step honesty | `Finish sync semantics`; finish-fanout row in `Binding test matrix` | Defines local adoption completion before one ordinary, incremental sync; makes no atomicity or one-cycle-settlement promise and requires immediate post-init inspection with 20+ repos. |
| D7 — adopt command surface | `Recovery and retention commands`; direct-path/abort/retention rows in `Binding test matrix` | Adds direct-path `rbox adopt status`, `resume`, `abort`, and `clean`, phase-specific abort behavior, explicit retained-data reporting, and no automatic expiry. |
| D8 — ignore independence | `Ignore independence`; ignore and warm-cache rows in `Binding test matrix` | Restores every non-`.rbox` file-plane entry independently of ignore rules, overlays rule files normally, then rebuilds matchers from the final tree for the forced full finish scan. |

The original problem statement is retained verbatim. The layer rationale remains
join-time baseline establishment followed by ordinary post-BASE state, narrowed
to explicit fence/cache hooks rather than new merge, capture, or BASE authority.
The design header is `v3 — pending final serial review`, and the complete
round-2 binding test additions are consolidated in `Binding test matrix`.
