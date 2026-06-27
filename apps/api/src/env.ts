export interface Env {
  rbox_dev_db: D1Database;
  rbox_dev_blobs: R2Bucket;
  /** Bootstrap trust anchor for the first device (Wrangler secret, never in git). */
  RBOX_BOOTSTRAP_SECRET: string;
  /** Platform-admin secret for internal ops (GC). Distinct from tenant device tokens. */
  RBOX_PLATFORM_SECRET: string;
  /** WorkspaceSync DO namespace — the per-(workspace,project) commit sequencer + WS fanout. */
  WORKSPACE_SYNC: DurableObjectNamespace;
  /** Stripe secret key (sk_test_/sk_live_). Wrangler secret — absent until billing
   *  is provisioned; the billing routes 501 when missing (feature-gated). */
  STRIPE_SECRET?: string;
  /** Stripe webhook signing secret (whsec_…). Wrangler secret; webhook 400s without it. */
  STRIPE_WEBHOOK_SECRET?: string;
  /** Base URL for checkout success/cancel redirects (e.g. https://rbox.to). */
  RBOX_APP_URL?: string;
}
