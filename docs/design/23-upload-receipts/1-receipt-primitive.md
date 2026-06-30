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
payload  = canonical-JSON { v: 1, a: accountId, s: encSha, n: sizeBytes, t: uploadedMs, e: expMs }
mac      = HMAC_SHA256(K[kid], `${kid}.${b64url(payload)}`)
```
- `K[kid]`: Worker secret(s) `RBOX_RECEIPT_KEY` (+ `RBOX_RECEIPT_KEY_PREV` for rotation),
  set via `wrangler secret`. Never leaves the Worker. Distinct from device/bootstrap secrets.
- Scope is **account-level, not workspace-level**. `blob_refs` entitlements are account-scoped
  (§07), and the commit path separately authorizes the caller's workspace role before it can
  advance a head. A receipt replayed in another workspace of the same account is acceptable:
  it only proves the account recently uploaded those bytes.
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
- Replay across accounts blocked by `a`; across content by `s`; across size by `n`; after
  expiry by `e`. Replay across commits in the same account before expiry is allowed and
  idempotent because commit grants use `INSERT OR IGNORE` and charge only actual new refs
  (§23.4/§23.6).
- A receipt is **proof-of-upload/possession**, not a reservation, not a durable entitlement,
  and not a GC pin. It does not by itself create a `blobs` row, a `blob_refs` row, a quota
  charge, a workspace ref, or a right to read the blob. Those happen only if commit
  authorizes the workspace and successfully grants the ref.
- Expired or missing receipt: the client must re-run `missingBlobs`; if the ref is still
  unentitled, it must upload the bytes again and receive a fresh receipt.
- `gc_candidates` are not consulted during receipt verification. A receipt can be accepted
  only within the §23.5 safety window; commit clears candidate rows atomically for
  receipt-revived refs, while GC must not purge a current R2 object that could still have an
  unexpired receipt.

## Tests (unit)
- mint→verify round-trip ok; tampered payload/mac → `bad_mac`; expired → `expired`;
  wrong account/sha/size → `mismatch`; unknown kid → `bad_kid`; malformed → `malformed`;
  prev-key receipt verifies, current-key mint only.
- Same-account replay verifies before expiry; cross-account/workspace authorization remains
  outside the primitive; expired replay fails and requires re-upload/recheck.

## Depends on / Status
Depends on: nothing. Status: **design**. Unblocks §23.2–23.4.
