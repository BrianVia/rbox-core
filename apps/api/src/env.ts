/** A queued new-device notification job. Carries only the credential identity — no
 *  PII on the wire; the consumer re-reads the authoritative `device_notifications`
 *  row (design 16 §2.4). */
export interface DeviceNotifyMessage {
  tokenHash: string;
}

/** The Cloudflare Email Service — Email Sending `send()` payload (the NEW first-party
 *  product, not the legacy MIME `send_email` binding). Cloudflare signs DKIM with the
 *  CF-managed sending-subdomain key, so no API key / DKIM material is passed. */
export interface EmailSendMessage {
  to: string;
  from: string;
  subject: string;
  html?: string;
  text?: string;
  headers?: Record<string, string>;
}
export interface EmailSendResult {
  messageId: string;
}
export interface SendEmailBinding {
  send(message: EmailSendMessage): Promise<EmailSendResult>;
}

export interface Env {
  rbox_dev_db: D1Database;
  /** Producer binding for the new-device email queue (design 16 §2.4). Optional: absent
   *  in local bun tests and until the queue is provisioned — enqueue then no-ops and the
   *  cron backstop drives delivery off the durable outbox instead. */
  DEVICE_NOTIFY_Q?: Queue<DeviceNotifyMessage>;
  /** Cloudflare Email Service — Email Sending binding (`send_email` in wrangler, the new
   *  `send()` API). Optional: absent in tests / before the sending domain is onboarded,
   *  in which case a delivery becomes retryable `failed` (never silently dropped, §4.2). */
  EMAIL?: SendEmailBinding;
  /** `From:` for the new-device email (e.g. `security@mail.rbox.to`). */
  RBOX_NOTIFY_FROM?: string;
  /** HMAC pepper for the per-recipient delivery idempotency key (internal dedupe tag, §4.4). */
  NOTIFY_IDEMPOTENCY_PEPPER?: string;
  /** Explicit kill-switch (local/dev only). When "1", deliveries terminally `skipped` —
   *  the ONLY intentional-off path; a missing EMAIL binding is `failed`+retry, not this. */
  DEVICE_NOTIFICATIONS_DISABLED?: string;
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

  // ── §32 observability ───────────────────────────────────────────────────────
  /** Slackpipes BUSINESS webhook (#rbox) — new account / subscription / churn pings.
   *  Wrangler secret; absent ⇒ business pings no-op (self-gating). NEVER in repo. */
  SLACKPIPES_WEBHOOK_URL?: string;
  /** Slackpipes ALERTS webhook (#rbox-alerts) — error/payment-failed pings, and the
   *  Tail Worker's rare-important alerts. Wrangler secret; absent ⇒ no-op. NEVER in repo. */
  SLACKPIPES_ALERTS_WEBHOOK_URL?: string;

  // ── §32 Tier 3a: platform-admin cockpit (GET /v1/admin/overview) ─────────────
  /** Cloudflare Access team domain, e.g. `https://rbox.cloudflareaccess.com`. The
   *  admin route verifies the `Cf-Access-Jwt-Assertion` against `${domain}/cdn-cgi/access/certs`.
   *  Absent ⇒ the admin route fail-closes (401) — it never serves without Access. */
  CF_ACCESS_TEAM_DOMAIN?: string;
  /** The Access application AUD tag the admin JWT must carry (audience pinning). */
  CF_ACCESS_AUD?: string;
  /** Optional raw JWKS JSON override (`{"keys":[...]}`). When set, used instead of
   *  fetching the certs endpoint — lets the verifier run hermetically (tests / pinned
   *  keys). Absent in prod ⇒ live fetch. */
  CF_ACCESS_JWKS?: string;
  /** Cloudflare GraphQL Analytics API token (Account Analytics:Read). Wrangler secret;
   *  absent ⇒ the 5xx-rate figure is reported as null (best-effort). NEVER in repo. */
  CF_ANALYTICS_TOKEN?: string;
  /** Cloudflare account id (for the GraphQL Analytics query `accountTag`). Var, not a secret. */
  CF_ACCOUNT_ID?: string;
  /** This worker's script name (GraphQL `scriptName` filter for the 5xx query). Var. */
  CF_WORKER_NAME?: string;
  /** Browser origin of the admin SPA (e.g. `https://admin.rbox.to`) — CORS-allowed
   *  WITH credentials for the admin route only. Var; absent ⇒ no admin CORS. */
  ADMIN_ALLOWED_ORIGIN?: string;
}
