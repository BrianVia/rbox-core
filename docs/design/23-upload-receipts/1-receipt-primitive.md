# §23.1 — Upload-receipt primitive (mint / verify)

> Chunk of [§23 upload-receipts](../23-upload-receipts.md). Independently shippable:
> a pure crypto/util module + tests, no protocol change yet. **Do this first.**

## Problem
We need a stateless, unforgeable proof that "account A uploaded `size` bytes for content
address `encSha`, recently." Stateless = no D1 row (the whole point is to keep D1 off the
PUT path). Must be cheap to mint and verify in a Worker.

## Design
HMAC-SHA256 over a canonical payload, with a rotatable key id:

```
receipt  = `${kid}.${b64url(payload)}.${b64url(mac)}`
payload  = canonical-JSON { a: accountId, s: encSha, n: sizeBytes, t: uploadedMs, e: expMs }
mac      = HMAC_SHA256(K[kid], `${kid}.${b64url(payload)}`)
```
- `K[kid]`: Worker secret(s) `RBOX_RECEIPT_KEY` (+ `RBOX_RECEIPT_KEY_PREV` for rotation),
  set via `wrangler secret`. Never leaves the Worker. Distinct from device/bootstrap secrets.
- `e = t + RECEIPT_TTL`. **RECEIPT_TTL MUST be < the GC grace window** (see §23.5) so a
  stale receipt can never resurrect an already-GC-eligible orphan.
- Verify: split, look up `K[kid]`, constant-time HMAC compare, then check `e > now`,
  `a == caller`, `s`/`n` match the ref being claimed.

## Interface
```ts
// apps/api/src/receipts.ts
mintReceipt(env, { accountId, encSha, size, nowMs }): string
verifyReceipt(env, receipt, { accountId, encSha, size, nowMs }):
  { ok: true } | { ok: false, reason: "malformed"|"bad_kid"|"bad_mac"|"expired"|"mismatch" }
```

## Correctness
- Constant-time MAC compare (no timing oracle) — reuse the worker's existing helper.
- Rotation: accept `kid` ∈ {current, prev}; mint only with current. Rotating invalidates
  in-flight receipts older than one window — acceptable (client re-uploads → new receipt).
- Replay across accounts blocked by `a`; across content by `s`; after expiry by `e`.
- A receipt is a capability, not a secret to persist — it's fine for the client to hold it
  in memory for the push; it grants nothing but "reference this already-uploaded blob."

## Tests (unit)
- mint→verify round-trip ok; tampered payload/mac → `bad_mac`; expired → `expired`;
  wrong account/sha/size → `mismatch`; unknown kid → `bad_kid`; malformed → `malformed`;
  prev-key receipt verifies, current-key mint only.

## Depends on / Status
Depends on: nothing. Status: **design**. Unblocks §23.2–17.4.
