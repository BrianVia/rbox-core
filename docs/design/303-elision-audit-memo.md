# 303 — Memoize the elision audit's manifest hash per files array

Status: implemented. Follows 302.

## Measured

With 302 on via-desktop, every remaining `state-save slow:` line reads
`compose≈950–1040ms apply≈150–180ms repos=1 global=elided`: the design-269 drift audit
(`globalElisionAudit`) hashes all 198K entries (`canonicalManifestHashStreaming`) on every
elided save, i.e. every pull that changed nothing, to confirm the receipt's `manifestHash`.

## Owner and rule

`src/cli/sync-state-elision.ts: auditHash` memoizes that hash in a `WeakMap` keyed by the
manifest's **files array**, with everything else the hash consumes (`generatedAt`,
`manifestSchema`, the persisted meta) in the inner key.

Why array identity is content identity here: loaded states are never mutated in place
(design 277's precondition, verified by the `RBOX_STATE_FREEZE=1` sweep), and design 302
now hands the retained array back **by identity** (not a copy) while the store's base
generation is unchanged. A new base generation, or the raw load path, produces a fresh
array and therefore always hashes. The first audit of any array still hashes the real rows,
so drift detection is unchanged; only repeats of an already-audited, unchanged manifest are
skipped.

## Validation

`sync-state-elision-memo.test.ts`: same array → one hash; new wrapper object, same array →
still one; different meta → hashes again; fresh array → hashes again; different
`generatedAt` → hashes again. Adapter/sync-state suites green. Rollback: revert; no durable
change. Deletion condition: same as 277/302.
