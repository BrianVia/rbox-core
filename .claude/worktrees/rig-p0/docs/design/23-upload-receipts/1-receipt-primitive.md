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
mac      = HMAC_SHA256(K[kid], `rbox.receipt.v1|${kid}.${b64url(payload)}`)
```
- **Domain tag (M11):** the constant `rbox.receipt.v1|` prefix domain-separates this MAC from
  every other HMAC use of the same key class, so a receipt can never be confused with (or
  forged from) a device token, pairing code, or future receipt version.
- `K[kid]`: Worker secret(s) `RBOX_RECEIPT_KEY` (+ `RBOX_RECEIPT_KEY_PREV` for rotation),
  set via `wrangler secret`. Never leaves the Worker. Distinct from device/bootstrap secrets.
  **Fail closed (M11):** if `RBOX_RECEIPT_KEY` is absent or shorter than 32 bytes, mint/verify
  throw at startup — there is NO default/dev key, so a misconfigured deploy cannot mint
  forgeable receipts.
- Scope is **account-level, not workspace-level**. `blob_refs` entitlements are account-scoped
  (§07), and the commit path separately authorizes the caller's workspace role before it can
  advance a head. A receipt replayed in another workspace of the same account is acceptable:
  it only proves the account recently uploaded those bytes.
- `e = t + RECEIPT_TTL`. **RECEIPT_TTL MUST be < `STAGING_GC_GRACE`** (see §23.5) so a valid
  receipt guarantees its *staging* object still exists for commit to promote. Driven by R2's
  lifecycle floor: `STAGING_GC_GRACE ≈ 24h`, `RECEIPT_TTL = 12h`. The invariant
  `RECEIPT_TTL < STAGING_GC_GRACE` is asserted at startup and in a unit test — a violation
  fails the deploy (M11).
- Verify, in order: (1) split + require exactly 3 parts and `v === 1` (reject unknown
  versions); (2) look up `K[kid]`, constant-time HMAC compare over the domain-tagged input;
  (3) bound the timestamps — `0 < e - t <= RECEIPT_TTL` (no over-long TTL) AND `t <= now + SKEW`
  (reject future-dated `t`, `SKEW` ~60s) AND `e > now` (unexpired); (4) `a == caller`,
  `s`/`n` exact-match the ref being claimed. Any failure → typed reason, fail closed.

## Interface
```ts
// apps/api/src/receipts.ts
mintReceipt(env, { accountId, encSha, size, nowMs }): string
verifyReceipt(env, receipt, { accountId, encSha, size, nowMs }):
  { ok: true } | { ok: false, reason:
    "malformed"|"bad_version"|"bad_kid"|"bad_mac"|"expired"|"future"|"bad_ttl"|"mismatch" }
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
- There is no `gc_candidates`/resurrection interaction (v4). A receipt simply proves the
  account placed these bytes in its staging namespace within the last `RECEIPT_TTL`; commit
  promotes that staging object to canonical. Because `RECEIPT_TTL < STAGING_GC_GRACE`, the
  staging object is guaranteed to still exist when an unexpired receipt is presented.

## Tests (unit)
- mint→verify round-trip ok; tampered payload/mac → `bad_mac`; expired → `expired`;
  wrong account/sha/size → `mismatch`; unknown kid → `bad_kid`; malformed → `malformed`;
  prev-key receipt verifies, current-key mint only.
- Same-account replay verifies before expiry; cross-account/workspace authorization remains
  outside the primitive; expired replay fails and requires re-upload/recheck.

## Depends on / Status
Depends on: nothing. Status: **design**. Unblocks §23.2–23.4.
