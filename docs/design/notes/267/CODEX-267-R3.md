# Design 267 r3 confirmation review

**Verdict: CHANGES-REQUIRED**

R3 closes the provenance and manifest-hash residuals, and the proposed `{nonce, stateRevision}` predicate is the correct primitive. However, §3.2b is not wired to a working recovery contract: today a state-revision rejection is translated into terminal `nonce`, and a retried composition would continue carrying the original stale receipt. The resulting failure is either immediate abort or three deterministic rejections.

## Findings

### CRITICAL — Receipt rejection does not use today’s retry path

The claim that receipt mismatch follows the existing reload/recompute path is false as currently specified ([design §3.2b](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/docs/design/267-delta-scoped-state-save.md:148>)).

At the raw store level, `"state-revision"` is an existing rejection reason. But the compatibility adapter translates it to `"nonce"` ([whole-state-compat.ts:392](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:392>)). `saveStateSource` treats nonce rejection as an incarnation change and throws rather than retrying ([sync-state.ts:362](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync-state.ts:362>), especially lines 392–395).

The reload machinery itself is genuine: for retryable reasons, the adapter reloads the durable state under the still-held lock ([whole-state-compat.ts:398](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:398>)), and `saveStateSource` recomposes against `result.state`. But receipt revision drift cannot currently reach that path.

Even if the reason mapping is fixed, the receipt remains bound to the original snapshot. `saveStateSource` retries with the same `StateSource`, so unless explicitly consumed or rebound, it sends the original revision again.

Concrete permanent-loop case:

1. Pull A loads revision 10 and constructs receipt revision 10.
2. Writer B accepts a minimal or repo-only no-op packet, advancing revision to 11 without changing A’s elision predicates.
3. A rejects on receipt revision 10.
4. A reloads revision 11; all elision predicates remain true.
5. A recomposes with the same receipt revision 10 and rejects twice more.

Required revision:

- Define the exact public retryable reason for receipt drift. Do not rely on raw `"state-revision"` reaching `saveStateSource` through today’s translation.
- Make the receipt single-attempt: after any receipt-driven rejection, discard it and retry through the standing full-save path. Reissuing a newly bound receipt would require re-establishing its proof and is unnecessary complexity.
- Add an interleaving fixture where B performs an accepted minimal/no-op CAS. The current global+repo-change fixture may accidentally force a full packet and miss stale-receipt reuse.

### MAJOR — Snapshot binding is not specified for the legacy-JSON backend

Elision happens in `composeStateSavePacket` before backend dispatch, so a receipt-bearing minimal packet can reach either backend.

SQLite already has a natural place for the new predicate. Legacy JSON currently checks stream, nonce, global sequence, and touched repo generations, but never `stateRevision` ([legacy-json-store.ts:101](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/legacy-json-store.ts:101>)). An ordinary intervening JSON save preserves nonce, so the new race remains open there.

R3’s JSON/SQLite differential gate implies elision is supported on both. It must explicitly require either:

- a common optional elision expectation on `StateSavePacket`, checked against normalized live nonce/revision by both backends; or
- structurally absent receipts/full packets on legacy JSON.

The first is consistent with the stated equivalence goal.

### MAJOR — Pre-first-save nonce/revision comparison is undefined

`SyncState.stateNonce` and `stateRevision` are optional, while existing CAS semantics normalize them to `"legacy"` and `0`. R3 instead describes strict equality against raw receipt values.

This matters because `ensureCapableStateLineage` deliberately returns an existing legacy-JSON state without minting a nonce ([whole-state-compat.ts:165](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/adapters/whole-state-compat.ts:165>)). A receipt can therefore encounter absent identity unless construction is restricted.

Specify one of:

- Recommended: construct a receipt only from the post-`ensureCapableStateLineage` snapshot when it has a valid nonce and safe revision; otherwise perform the full save.
- Alternatively, define receipt identity using `expectedStateNonce(snapshot)` plus normalized revision semantics on both backends.

Add first-save and legacy nonce-less fixtures.

## Telemetry-binding interaction

The telemetry singleton is safe and should not cause rejection loops.

It holds the same canonical state lock, changes only `telemetryBindingId`, and deliberately preserves `stateRevision` ([write-packet.ts:307](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:307>)). A mint between the pull’s load and save should therefore pass the receipt predicate. The fresh accepted CAS token contains the binding, and M2 explicitly overlays `telemetryBindingId`, so `returnedState === durableReload` can still hold.

Add an explicit absent-binding → interleaved mint → accepted elided save equality fixture.

## R2 residual disposition

| Residual | Disposition |
|---|---|
| Pull-owned optional provenance | **Closed.** No receipt structurally means no M1 elision; unfiltered `all` and scoped-base identity are now first-class. |
| Snapshot-bound CAS | **Not closed.** The predicate is sound, but its public rejection mapping and receipt lifecycle make recovery fail. |
| `manifestFromMeta` hash operand | **Closed.** It now matches the shipped push integrity precedent ([push.ts:754](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/sync/push.ts:754>)). |

## Confirmed invariants

- Every accepted SQLite CAS reaches the unconditional revision update after optional global application and transition application ([write-packet.ts:257](</home/via/Development/Personal/rbox-core/.claude/worktrees/delta-scoped-save/src/cli/state-plane/store/write-packet.ts:257>)). This includes full, repo-only, and minimal packets.
- Telemetry minting is the intentional non-CAS exception.
- SP-2 locking/fencing, legacy housekeeping, empty-packet initialization/reset behavior, and the #747 deletion hash remain protected.
- The O(N) canonical hash is honestly disclosed.
- No artifact-lifecycle or state-plane compatibility deletion is approved.

M1/M2 implementation—and particularly accepted read-back removal—should not proceed until the rejection mapping, single-use receipt behavior, backend parity, and absent-nonce semantics are explicit.