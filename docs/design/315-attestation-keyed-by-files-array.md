# 315 — The #816 base-hash attestation binds to the manifest and meta objects, not the state wrapper

Status: v2 after review round 1 (`notes/315/review1-gpt.md`, blocker accepted), 2026-09-06. Owner: `src/cli/sync/base-hash-attestation.ts`.
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

## Rule (v2)

Key the attestation by the `lastSyncedManifest` OBJECT (`WeakMap<Manifest, …>`) and record the
`manifestMeta` OBJECT it was minted against next to the two hashes. `baseHashIsAttested(state,
meta)` looks up `state.lastSyncedManifest` and requires `attested.meta === state.manifestMeta`
and the recorded `encManifestSha`/`manifestHash` to equal `meta`'s. The elided projection
(`projectAcceptedSavePacket` = `{ ...snapshot, <token fields> }`) preserves BOTH object
references, so the next push hits; any state whose manifest or meta was rebuilt (fresh
read-back, design 313's derived state, a reset) misses exactly as today. Every input of the
hashed reconstruction — `generatedAt`, `files`, `manifestSchema` (the manifest object) and
`gitRepos` (the meta object) — is therefore covered by identity. This changes WHERE #816's
trust applies (the same two objects under a new wrapper), never WHAT it trusts. Nothing else
in #816's admission changes.

## Non-goals

- Making the drift audit trust the attestation (design 314, withdrawn: the attestation is
  a count proof, not a content proof). This design only widens WHERE #816's existing trust
  applies (the same content under a new object), not WHAT it trusts.

## Tests (`base-hash-attestation.test.ts`)

- replace the "binds to the retained state OBJECT" pin: a state projected from the attested
  one (`{ ...saved, stateRevision: saved.stateRevision + 1 }`, same manifest and meta objects)
  IS attested; a wrapper with the same manifest object but a different `manifestMeta` object
  (equal hashes, different `gitRepos`) is NOT; a manifest rebuilt with equal content is NOT
  (fresh read-back still misses — the process-boundary property #816 wants).
- a different meta (encManifestSha or manifestHash) → not attested (existing).

## Expected result

Desktop: `delta_base` ≈ 0 on every changed push after the first in a process (~1.4s saved
per push, every device that pushes).

## v3 (315b, field-driven): key = files array + hashed inputs by value

Desktop `attest=miss/attested` on every push after #909 (the `attest=` field from 313b):
an elided save's projection rebuilds BOTH the manifest wrapper and the meta object
(`identity-probe`: after `saveStateSource` with a receipt, `manifest same obj: false`,
`meta same: false`, `files same: true`). So v2's key (manifest + meta object identity)
misses after every pull. v3 keys by the files ARRAY (preserved by every projection, and
across zero-op global saves after 313b) and records every other hashed input by value:
`generatedAt`, `manifestSchema`, the two hashes, and `canonicalJson(meta.gitRepos)` —
the round-1 blocker's alternative fix, so WHAT is trusted is unchanged.
