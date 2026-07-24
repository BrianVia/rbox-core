# SPEC-176-IMPL — dispatch contract

Authoritative: docs/design/176-wedge-ux-keep-mine.md (ALIGNED v4). Where
silent, the doc wins; review ledger REVIEW-176-R1-{CODEX,OPUS} → FOLD-PLAN →
R2 → R3.

INVIOLABLES:
I1. Confirmation's ONLY mutation = the RESOLUTION-INTENT sidecar (token binds
    the FULL show-me set + stream/stateNonce/repoGen/gitIncomingKey(P);
    single-use; any bound-input change voids with plain copy). Clears happen
    ONLY in the accepted-ACK ordered transition (pending/partial/attempt/
    deferral/intent). Pre-ACK failures leave intent+P+all other sidecars
    byte-identical (sole exception: durable idempotent internal pin refs).
I2. The push executes the intent: capture unconditionally (busy/journal
    refusals per 174), directional discard report against the FINAL candidate
    (closed lane list §2.2), take-theirs-grade pins durable BEFORE commit,
    174-I3 tombstone carry. BASE via existing publisher-ack arm ONLY; refused
    shapes (§2.4: BASE-present/pending-present/local-absent branch;
    reserved-173 divergent; no-P `no-incoming`) refuse with plain copy.
I3. Held-skip fix per §4: neutralize ONLY the own composer-pending blocker
    via composedFollow.holds + checkoutComplete ref-for-ref mapping;
    unmatched holds persist as typed blockers. Never by reason string.
I4. Language: frozen grammars (§3 consumer list) — grammar-freeze tests for
    EVERY listed consumer; plain-English additions only in unparsed fields or
    new status-only lines; the shared `git deferred` line byte-unchanged.
I5. No changes to 174 supersession lanes, no manual/lockedProof authority, no
    A/P invention.

Units: U1 intent sidecar + CLI verb (+refusals+copy); U2 push execution arm
(report/pins/ACK clears); U3 held-skip fix; U4 language surfacing (status
companion line, show-me rewrite, 12-line log pass). Tests: design §5 all.
Acceptance: bun run typecheck; bun test src/cli src/engine; bun run test:api
(configLoader workaround ok). Report IMPL-176-REPORT.md, last line
IMPL-COMPLETE.
