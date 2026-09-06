# 315 — The #816 base-hash attestation binds to the files array, not the state object

Status: proposed (2026-09-06). Owner: `src/cli/sync/base-hash-attestation.ts`.
Parents: #816 (attestation), design 277 (loaded states are never mutated; freeze-swept),
design 303 (audit-hash memo keyed per files array — the same identity discipline).

## Problem, measured

Every changed push on the desktop logs `delta_base=1.3–1.5s` (`push.ts` `delta_base_ms`):
`validateManifest(reconstructedBase)` (~0.5s) plus `canonicalManifestHashStreaming` (~0.85s)
over 198K entries. #816 was meant to skip both when the same process just committed that
base, and it does — for exactly one push. `attestSavedBase` records the proof in a
`WeakMap<SyncState, …>` keyed by the accepted state OBJECT. The very next pull's elided save
returns `projectAcceptedSavePacket(snapshot, token)` = `{ ...snapshot, <token fields> }`, a
NEW object with the SAME `lastSyncedManifest` (same files array), and the memo retains that
new object. The following push therefore misses the attestation and pays the full 1.4s again.
Today's desktop log: eight changed pushes, every one `delta_base≈1.3–1.5s`.

## Rule

Key the attestation by `saved.lastSyncedManifest.files` (a `WeakMap<readonly FileEntry[], …>`)
and record, next to the two hashes, the other inputs the hash consumed: `generatedAt` and
`manifestSchema`. `baseHashIsAttested(state, meta)` looks up `state.lastSyncedManifest.files`
and requires the recorded `encManifestSha`, `manifestHash`, `generatedAt` and `manifestSchema`
to equal the state's and the meta's. Nothing else in #816's admission changes: the refusals
(meta not persisted, sequence not reached, non-reconstructible shape, gitRepos presence
mismatch, entry count) stay exactly as they are.

Why identity = content: design 277's precondition (loaded/retained states are never mutated
in place, freeze-swept under `RBOX_STATE_FREEZE=1`) is what design 303 already relies on for
the audit-hash memo. An array that came from the store (or, after design 313, from the memo's
own derivation) is never edited; a different content is always a different array. The
reconstruction the hash covers is `{generatedAt, files, manifestSchema?, gitRepos(meta)}` —
every input is either the array itself, recorded in the attestation, or the meta being checked.

## Non-goals

- Making the drift audit trust the attestation (design 314, withdrawn: the attestation is
  a count proof, not a content proof). This design only widens WHERE #816's existing trust
  applies (the same content under a new object), not WHAT it trusts.

## Tests (`base-hash-attestation.test.ts`)

- replace the "binds to the retained state OBJECT" pin: a state projected from the attested
  one (`{ ...saved, stateRevision: saved.stateRevision + 1 }`, same manifest) IS attested;
  a state whose manifest carries a DIFFERENT files array with equal content is NOT (fresh
  read-back still misses — that is the process-boundary property #816 wants).
- same array, different `generatedAt` or `manifestSchema` → not attested.
- a different meta (encManifestSha or manifestHash) → not attested (existing).

## Expected result

Desktop: `delta_base` ≈ 0 on every changed push after the first in a process (~1.4s saved
per push, every device that pushes).
