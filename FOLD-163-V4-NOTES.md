# Design 163 v4 fold notes

Source ruling: `SYNTHESIS-163-R3.md`. The fold is strictly additive precision;
the reset file-swap, byte-exact O/N, standing-journal no-open/W2-before-decode,
single-authority Q flip, and 2.0-only rollout constraints remain intact.

| Work item | Closed in `docs/design/163-state-plane-sqlite.md` |
|---|---|
| **C1 — durable retirement** | `Migration authority state machine` → `Authority predicate and old-reader barrier`; `Migration artifacts and completion witness`; `Durable source-change retirement subprotocol`; `Crash, disk-full, and resume table`; `512 MiB and typed non-looping halts`. These sections add the pre-arm changed-L row, monotone intent/prefix retirement, the explicit M5 counterexample walk, and M2–M5 crash/ENOSPC injection. |
| **C2 — M6/M7 cleanup correlation** | `Migration artifacts and completion witness`; `Durable phase publication and sole actor`; `Correlated M6 cleanup to M7`; `Ordered phases` M5–M7; `Crash, disk-full, and resume table`; migration halt/fault-injection text. These bind the Q sibling's path/identity/build states and old/new rename images, add per-resource cleanup intent/absence, and prebuild the final halted-M6/M7 publication runway. |
| **C3 — decoder contract freeze** | `One bounded exact reset-journal decoder`; J0 in `Decoder/WAL rows J0, W1, W2, and W3`. These freeze decoder-owned `readInto`, length authentication and 52× inputs, token/depth arithmetic, decoded-key comparison, Unicode/BOM/base64 domains, caps, and the result/error unions. |
| **C4 — journal-independent inventory** | `Journal-independent reset namespace inventory`; `Gates before the row table`; `Decoder/WAL rows J0, W1, W2, and W3`; `Unlisted signatures halt`; reset crash-rig paragraph. These define the bounded no-follow roots/entry behavior and deterministic malformed-journal/orphan-sidecar precedence. |
| **C5 — receipt/oracle port** | `Pull: authenticate, plan completely, then apply` step 6; `Apply receipt/oracle sub-contract`; the apply row in `Normative materialization budget and unavoidable wire allocations`; `Vertical/module ownership and antislop discipline`. These add keyed plan tables, bounded receiver-equivalence joins, filesystem tokens, streaming receipt hash, exact simultaneous windows, and post-Git indeterminate/retry semantics. |
| **C6 — construction peaks** | `Acceptance targets`; `Normative materialization budget and unavoidable wire allocations`, especially `ConstructionPeakV1` and the five-adapter phase table. These replace the flat workspace charge with construction/transient/backing-store/codec/runtime reservations and peak-live CI gates. |
| **C7 — U0 terminal semantics** | `Early U0 — immutable entry interning and structural sharing`. This adds the strong scoped owner control/current-token cell, no-token abort and owner-loss drain, `aborting` queue liveness, and worker pending-through-application/discard/resource-release semantics. |
| **C8 — keystone/quarantine contradiction** | `138 interplay (the sensitive part)` and the `Keystone` quarantine bullet, aligned with the unchanged `Required publication order and backup boundary`. Standing-journal quarantine is byte-exact/no-open; `VACUUM INTO` is only post-journal diagnostic/general backup/operator compaction. |
| **C9 — coherence minors** | Status header; problem/acceptance baseline-target wording; `Rollout`; seed paragraph in `Canonical artifacts and exact notation`; `Early U0`; final closure index. These mark v4 pending final serial review, distinguish 0.84 s baseline from the prospective <200 ms target, keep U0 testable but not independently shippable, make shared-2.0 synchronization merge-only, and require the empty-DB seed cap to be measured/coupled before implementation authority. |

Final cross-check: the R3A, R3B, and R3C review lenses reported alignment on
their assigned C1–C9 closures after the fold corrections.
