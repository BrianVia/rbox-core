# Design 287 architecture review — round 2

**Verdict: ACCEPT AS A STAGED ROADMAP.** No concrete architecture blocker remains from A1–A7 in the reviewed canonical `docs/plans/sync-git-improvements/plan.mdx`. This accepts the package boundaries, explicit proof obligations and sequencing. It does **not** declare the topology/chunk/tree/refset protocols implementation-ready or approve unresolved product, schema, crypto, support-window or deployment decisions.

## Disposition

- **A1 closed:** G6 propagates holds to shared ref/config effects that could invalidate a held checkout. Progress is restricted to proven-unaffected dependencies, with dirty-sibling/shared-branch tests. The QuestionForm now says “Only checkouts with unaffected shared-state dependencies continue,” consistent with the package.
- **A2 closed at roadmap level:** G6 distinguishes operation-local common-dir grouping from portable identity; requires birth/installation/move/tombstone/copy semantics and adversarial lifecycle fixtures. Per-stream authoritative admission or equivalent proof must exclude erasing old writers after activation. Exact identity and lifecycle rules remain a named focused-design gate.
- **A3 closed:** F7 adds aggregate reference/resource admission, existing-cap fallback/refusal, legitimate repeated chunk occurrences, exact size/overflow checks, and historical reconstruction/GC closure. No server limit increase or new crypto scheme is preapproved.
- **A4 closed:** X1 separates logical node identity and encrypted addresses, prohibits plaintext path exposure, requires explicit client-supplied retention closure, preserves current path byte identity, and bounds cumulative decode/traversal work. Current-format X1a/b remain independent of the conditional tree design.
- **A5 closed:** X3 requires retention roots through effect/recovery settlement with existing pins/journals; X4 treats batch answers as observations rather than durable possession, separates operation-scoped batching from conditional persistent reuse, and includes pack removal/config/alternates/negative-cache cases.
- **A6 closed:** X2 has explicit current-access freshness/audience/scope requirements and deny/fallback behavior without inventing a stronger existing product policy. Coordination with S4 identity/revocation is distinct from requiring receipt coalescing or rich WS deployment.
- **A7 closed:** The introduction defines hard dependencies, measurement inputs and rollout coordination. The map and package text agree: G6 observation can start independently; S4/S5 are separable; X1a/b do not wait for cache migration; standalone X3 does not wait for portable topology; X4 benchmarks operation-scoped batching before service/library choices.

The readiness paragraph also correctly separates bounded Fix candidates from focused design closure and conditional experiments. Detailed gates override wave priority, while no reader-first rollout is portrayed as permission to discard already-published history or accept incompatible writers.

## Acceptance boundary

Focused designs must still supply executable transition/admission tables, actual supported-binary compatibility evidence, selected conflict/retention policy and supported-runtime/rig validation before relevant implementation/activation. These are intentional remaining gates, not round-two deficiencies. Existing independent correctness and measured-performance fixes do not wait on speculative protocol decisions.

Review was limited to the requested written sections and their introduction/map/QuestionForm consistency. No repository edits, new broad audit, tests, live fleet actions or additional review rounds were performed. No cross-model alignment is claimed.
