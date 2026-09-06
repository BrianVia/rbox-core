# 314 — The elision audit accepts the push's standing base-hash attestation

Status: WITHDRAWN (2026-09-06, after review round 1 — `notes/314/review1-gpt.md`). Kept so the idea is not retried. Owner: `sync-state-elision.ts` (`globalElisionAudit`).
Parents: design 303 (audit-hash memo per files array), #816 (`base-hash-attestation.ts`),
design 313 (delta saves keep the memo's rows).

## Problem, measured

After every push that carries a real change, the NEXT pull's elided save logs
`state-save slow: compose≈930–1044 apply≈160 repos=1 global=elided` on the desktop. The
compose cost is `globalElisionAudit` → `auditHash` hashing the fresh 198K-entry array once
(design 303 memoizes per array; a delta save produces a new array). Copied-store profile:
first audit 836ms, memo hits 5ms.

The push that produced that array already holds the proof: `attestSavedBase(saved, …)`
(`push.ts`, #816) records on the exact accepted state object that
`manifestMeta.manifestHash` is the encoder's canonical hash of the manifest it committed —
the same predicate the audit recomputes (`canonicalManifestHashStreaming(manifestFromMeta(
state.lastSyncedManifest, meta)) === meta.manifestHash`). The design-277 memo hands that
same object to the next pull, so the audit is re-deriving a proof the process already holds.

## Why it is withdrawn

`attestSavedBase` proves identifiers, sequence, header shape, gitRepos presence and the
entry COUNT — never the entry values. It is sufficient for #816's purpose (skip re-deriving
the delta base's hash when the same process just committed it) but it is not a content
proof. `globalElisionAudit` is design 269's ONLY detector of durable base drift, and a
push-attested state would renew its attestation on every push, so a same-length corrupted
read-back (or a same-length divergent memo projection) would evade the detector
indefinitely. Seeding `auditHash`'s memo from the push instead (review finding 4) fails the
same way: the push hashed the composer's array, and design 313 (PR #907) returns a
different array object whose equality to the store is proven structurally, not by hash.
The 0.85s first audit per new array is the price of the one drift detector; the only
trust-neutral improvement is making `canonicalManifestHashStreaming` itself cheaper.

## Rule (as proposed; not implemented)

In `globalElisionAudit`, after the existing shape checks (receipt flags, sequence equality,
deep-equal metas) and BEFORE hashing:

```
if (baseHashIsAttested(snapshot, persisted)) return "unchanged";
```

Nothing else changes. `auditHash` and its memo stay as the fallback for every un-attested
state.

## Why this does not weaken the drift audit (269 §2.4)

- The attestation exists only on the state object the adapter returned for the accepted
  save of `write.globalManifest`, and only when that state's meta equals the meta the
  encoder hashed and its base is reconstructible with the committed entry count
  (`attestSavedBase`'s refusals). It is process-local and object-keyed (WeakMap): a state
  loaded from the store in a new process, or re-materialized after a foreign revision,
  is never attested and always hashes.
- With design 313, the returned state's rows are the memo's retained rows plus the sealed
  delta — proven equal to the store's rows under the base-generation and binding
  predicates — so "attested" still means "this object's rows are what the store holds".
  Before 313 they were the store's own read-back. Either way the attestation covers the
  rows the audit would hash.
- The audit's remaining job (a persisted content whose hash disagrees with its own meta)
  is exactly what #816 already trusts the attestation for on the push side, where a wrong
  answer publishes an irreproducible delta — a strictly worse consequence than eliding a
  save. Trusting it for the audit adds no new trust boundary.
- Pull-originated global saves (followers) are not attested and keep hashing.

## Tests (`sync-state-elision-memo.test.ts` or a new `sync-state-elision-attest.test.ts`)

- an attested state (attest via `attestSavedBase` with a matching meta) audits `unchanged`
  and `canonicalManifestHashStreaming` is never called (spy the hashing module).
- the same state un-attested, or attested for a DIFFERENT meta (encManifestSha or
  manifestHash differs), hashes; a content mismatch still reports `content-drift`.
- attestation on object A does not transfer to `{ ...A }` (object identity, as #816).

## Expected result

Desktop: the elided-save `compose≈1s` line after each real change disappears (< 10ms).
