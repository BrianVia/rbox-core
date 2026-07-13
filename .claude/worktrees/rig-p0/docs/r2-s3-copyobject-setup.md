# §23.4 — enable the R2 S3 CopyObject promote (one-time, dev)

The promote needs R2 S3 credentials (the Workers R2 binding has no server-side copy).
The deploy token can't mint API tokens, so create the R2 token once:

## 1. Create an R2 API token (dashboard, ~30s)
Cloudflare dash → **R2 object storage** → **Manage** (next to API Tokens) →
**Create Account API token** → Permission: **Object Read & Write** → scope to bucket
`rbox-dev-blobs` (and `rbox-prod-blobs` later) → Create. Copy the **Access Key ID** and
**Secret Access Key** (shown once).

## 2. Set the four Worker secrets (dev)
```bash
cd apps/api
echo "<ACCESS_KEY_ID>"     | bunx wrangler secret put R2_S3_ACCESS_KEY_ID
echo "<SECRET_ACCESS_KEY>" | bunx wrangler secret put R2_S3_SECRET_KEY
echo "$CLOUDFLARE_ACCOUNT_ID" | bunx wrangler secret put R2_S3_ACCOUNT_ID   # d1d5680013391ca21665add23eee6426
echo "rbox-dev-blobs"      | bunx wrangler secret put R2_S3_BUCKET
bunx wrangler deploy
```
`s3Enabled(env)` flips on once all four are present; absent → the get→put fallback (so
nothing breaks if you skip this). For prod later, repeat with `--env production` + bucket
`rbox-prod-blobs`.

## 3. Verify
Re-run a cold push and check the commit `storeMs` drops (expect the promote to go from
~4–5s to <1s for ~100 blobs → §23 net-faster than the 6.46s legacy baseline). The SigV4
signer is validated against AWS's published test vector (apps/api/test/r2-s3.test.ts).
