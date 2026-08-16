# Design 267 r4 final confirmation

**Verdict: ALIGNED**

No blocking findings within the requested scope. R4 correctly resolves all three R3 residuals without introducing a new defect.

## Delta verification

1. **Retryable `elision-drift` and single-attempt receipts — correct**

   - The design introduces a distinct public retryable rejection reason instead of relying on the existing raw `state-revision → nonce` translation ([design §3.2b](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:172>)).
   - This preserves ordinary stream/nonce incarnation failures as terminal while allowing receipt revision drift to reach `saveStateSource`’s recomputation path.
   - On `elision-drift`, the receipt is discarded before retry. Attempt two therefore composes the standing full-save packet against the adapter’s under-lock reload; it cannot resend or rebind the stale proof.
   - The dedicated accepted-no-op interleaving fixture correctly isolates the deterministic-loop case that the broader content-change fixture could conceal ([validation](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:308>)).

2. **Common optional packet expectation checked by both backends — correct**

   - `elisionExpectation` is owned by `StateSavePacket`, the common backend boundary, and carries the receipt’s `{nonce, stateRevision}` only when composition actually elides state ([design §3.2b](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:164>)).
   - Both SQLite and legacy JSON must compare it with live state while holding the canonical state lock. This closes the JSON race without creating backend-specific provenance or orchestration.
   - Because the field is optional and absent from all existing direct packet callers, lineage initialization, reset, push receipt arming, settlement, and other non-pull paths retain their current behavior.
   - The parity fixture covers both acceptance and revision-drift rejection on the legacy backend ([validation](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:314>)).

3. **Receipt identity precondition — correct**

   - Receipt construction is restricted to the post-`ensureCapableStateLineage` snapshot and requires a minted non-legacy nonce plus defined `stateRevision` ([design §3.0](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:73>)).
   - Missing identity produces no receipt and therefore the existing full-save path. No `"legacy"`/`0` sentinel comparison is admitted as elision evidence.
   - First-save and nonce-less legacy JSON fixtures explicitly pin this fail-closed behavior ([validation](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:316>)).

## No-new-defect check

The three additions preserve:

- terminal stream/nonce incarnation handling;
- under-lock rejection reload and full-save recomputation;
- JSON/SQLite behavioral parity;
- SP-2 lock, fence, authority, and ownership checks;
- unconditional `stateRevision` advancement for accepted saves;
- the telemetry-binding exception, which deliberately does not advance revision and is covered by accepted-state equality;
- all packet callers without elision provenance;
- the protected artifact deletion hash and other previously settled contracts.

The new expectation is a justified backend seam rather than duplicated policy: pull owns proof construction, packet composition owns elision, each backend owns its live predicate check, and `saveStateSource` owns receipt consumption and retry.

The listed stale-receipt, backend-parity, first-save, nonce-less, telemetry, interleaving, and durable-reload equality gates are sufficient for these deltas. No deletion or retirement beyond the already documented coherent-generation trade is approved.

**Final verdict: ALIGNED.**