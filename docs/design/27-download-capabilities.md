# §27 — Short-lived download capabilities (P1)

> Status: **design (P1 — after §23)**. Decomposes into chunks when scheduled.
> The pull-side analogue of §23: stop doing a D1 entitlement read per blob GET.

## Problem
`blobGet` (`apps/api/src/blobs.ts:75`) checks entitlement in D1 **before every** blob GET
(the M7 "unentitled → 404, no existence oracle" guarantee). A fresh clone of N blobs = N D1
entitlement reads on the pull path — the download-side mirror of the upload D1 storm §23 fixes.

## Target
After the client verifies `latest()`/the commit (it already fetches + verifies the signed
commit + sidecar), the server issues **short-lived capability tokens** scoped to that
commit's blob set (or batches of it), so each subsequent blob GET is authorized by the
**capability** (HMAC verify, no D1) instead of a per-blob D1 entitlement read.

## Sketch (to be chunked at scheduling time)
- Reuse the §23.1 receipt/HMAC primitive: a **download capability** = HMAC over
  `{accountId, scope, exp}` where `scope` is the commit's sidecarSha (or a batch root), so it
  authorizes GET of any blob referenced by that commit the account is entitled to.
- `latest()`/a `GET /v1/caps?commit=…` returns the capability after confirming the account is
  entitled to that commit (one check, not per-blob).
- `blobGet` accepts `?cap=` → verify HMAC + scope membership (the sha is in the scoped set)
  + not expired → serve from R2. No D1.
- Membership check without D1: the cap is scoped to a sidecarSha the client already has; the
  server can verify "this sha ∈ that sidecar" cheaply if it caches/recomputes — OR scope the
  cap to the account+epoch and rely on the fact that a clone only requests blobs it learned
  from a verified manifest. Pick the model that keeps "unentitled → 404" intact (the key
  property to preserve — codex-review this).

## Risks / open
- **Must preserve the no-existence-oracle property** (M7): a cap must not let an account GET a
  blob it isn't entitled to, nor reveal existence. This is the load-bearing security concern.
- Revocation/expiry: caps are short-lived; a revoked device's caps expire fast. TTL vs UX.
- GC interaction: a cap referencing a blob GC condemned mid-pull → 404 (acceptable; client re-pulls).

## Chunks (when scheduled)
21.1 capability format + scope model · 21.2 issue endpoint (one entitlement check) ·
21.3 `blobGet` cap path (no D1) + the no-oracle proof. **Security-review heavy** — codex.
