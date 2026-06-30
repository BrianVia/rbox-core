export interface Env {
  rbox_dev_db: D1Database;
  rbox_dev_blobs: R2Bucket;
  /** Release artifacts (CLI binaries, install.sh, signed version manifest) — a
   *  SEPARATE bucket from user data (design 14 U6), so the release-write CI token
   *  can never touch encrypted user blobs. */
  rbox_releases: R2Bucket;
  /** Bootstrap trust anchor for the first device (Wrangler secret, never in git). */
  RBOX_BOOTSTRAP_SECRET: string;
  /** Platform-admin secret for internal ops (GC). Distinct from tenant device tokens. */
  RBOX_PLATFORM_SECRET: string;
  /** WorkspaceSync DO namespace — the per-(workspace,project) commit sequencer + WS fanout. */
  WORKSPACE_SYNC: DurableObjectNamespace;
  /** Server observability sink (Workers Analytics Engine). Optional: absent in
   *  local bun tests / before the dataset is provisioned, where emit() no-ops.
   *  Only low-cardinality op/route/outcome dimensions + numeric metrics are
   *  written — never user identifiers (see metrics.ts). */
  rbox_metrics?: AnalyticsEngineDataset;
  /** Stripe secret key (sk_test_/sk_live_). Wrangler secret — absent until billing
   *  is provisioned; the billing routes 501 when missing (feature-gated). */
  STRIPE_SECRET?: string;
  /** Stripe webhook signing secret (whsec_…). Wrangler secret; webhook 400s without it. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Base URL for checkout success/cancel redirects (e.g. https://rbox.to). */
  RBOX_APP_URL?: string;
  /** Clerk web auth (M11). Issuer = https://<frontend-api>; /v1/web/session 501s
   *  when CLERK_ISSUER is unset (feature-gated). */
  CLERK_ISSUER?: string;
  /** JWKS URL; defaults to `${CLERK_ISSUER}/.well-known/jwks.json` when unset. */
  CLERK_JWKS_URL?: string;
  /** Clerk Backend API secret (optional — only for fetching the user's email). */
  CLERK_SECRET_KEY?: string;
  /** CSV allowlist of acceptable `azp` (origins) on the Clerk session JWT. */
  CLERK_ALLOWED_ORIGINS?: string;
  /** §23 upload-receipt HMAC key (≥32 bytes). Wrangler secret. FAIL CLOSED: the
   *  receipt path throws when absent/short, so a misconfigured deploy can never
   *  mint or accept forgeable receipts. */
  RBOX_RECEIPT_KEY?: string;
  /** Previous receipt key during rotation — accepted on verify, never minted with. */
  RBOX_RECEIPT_KEY_PREV?: string;
}
