/** A queued new-device notification job. Carries only the credential identity — no
 *  PII on the wire; the consumer re-reads the authoritative `device_notifications`
 *  row (design 16 §2.4). */
export interface DeviceNotifyMessage {
  tokenHash: string;
}

/** A queued account-deletion continuation job (design 37 §7). Carries only the account
 *  id — the authoritative state is the `account_deletions` outbox row, which the drain
 *  re-reads. Used purely to promptly continue a large past-grace purge across
 *  invocations; the cron backstop re-drives any that stall. */
export interface AccountDeleteMessage {
  accountId: string;
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

/** A Cloudflare Workers rate-limiting binding. `.limit({ key })` returns
 *  `{ success }`; `false` means the key has spent its per-edge window. */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/** Loopback entrypoints exposed through ctx.exports. Keep in sync with worker.ts exports. */
export interface WorkerEntrypointExports {
  CachedReleases: {
    fetch(req: Request): Promise<Response>;
  };
}

export interface Env {
  rbox_dev_db: D1Database;
  /** Design 95 Phase-2 cron kill switch. Defaults to "1" in every deployed env;
   *  the platform-admin drain remains available while scheduled purge is disabled. */
  RBOX_GC_PURGE_DISABLED?: string;
  /** Design 103 Part A. When "1", the commit DO runs a cheap synchronous
   *  parent/epoch preflight (before sidecar/D1 I/O) and early-returns the same
   *  409 the final CAS would. Unset/"0" → today's behavior (no early return).
   *  Rollback = flip the flag; no schema, no migration. */
  RBOX_COMMIT_EARLY_REJECT?: string;
  /** Design 105 §3.4 socket-lifetime cap (ms). Unset/"0"/non-numeric ⇒ cap OFF
   *  (broadcast byte-identical to pre-105: send to every OPEN socket). A positive
   *  int caps delivery: broadcast closes any socket older than this (checked BEFORE
   *  each send, fail-closed on a missing/malformed connectedAt) instead of sending.
   *  Recommended production value 21600000 (6h). Rollback = unset. */
  RBOX_WS_MAX_SESSION_MS?: string;
  /** Design 112 blob-batch PUT record cap: default 32, candidate 64; set 32 to kill-switch. */
  RBOX_BLOB_BATCH_MAX_RECORDS?: string;
  /** Design 111 per-request receipt-redeem entry cap. Unset/invalid defaults to
   *  5,000; positive integers clamp to [1, 15,000]. The independent 8 MiB
   *  request-body cap is unchanged. Rollback = unset; clients clamp down after
   *  one machine-readable too_many_receipts response. */
  RBOX_RECEIPT_REDEEM_MAX?: string;
  /** Design 102. O(change) commit delta admission. Off/unset preserves full
   * validation; shadow compares read-only and returns the full result; enforce is
   * explicitly flag-gated and is not enabled by this change. */
  RBOX_COMMIT_DELTA_ADMISSION?: "off" | "shadow" | "enforce";
  /** Producer binding for the new-device email queue (design 16 §2.4). Optional: absent
   *  in local bun tests and until the queue is provisioned — enqueue then no-ops and the
   *  cron backstop drives delivery off the durable outbox instead. */
  DEVICE_NOTIFY_Q?: Queue<DeviceNotifyMessage>;
  /** Producer binding for the account-deletion continuation queue (design 37 §7). Optional:
   *  absent in tests and until provisioned — the cron backstop (`sweepAccountDeletions`)
   *  then drains every past-grace deletion off the durable `account_deletions` outbox. */
  ACCOUNT_DELETE_Q?: Queue<AccountDeleteMessage>;
  /** Cloudflare Email Service — Email Sending binding (`send_email` in wrangler, the new
   *  `send()` API). Optional: absent in tests / before the sending domain is onboarded,
   *  in which case a delivery becomes retryable `failed` (never silently dropped, §4.2). */
  EMAIL?: SendEmailBinding;
  /** `From:` for the new-device email (e.g. `security@mail.rbox.to`). */
  RBOX_NOTIFY_FROM?: string;
  /** Deploy environment discriminator (var, not a secret): `"dev"` on rbox-dev-api,
   *  `"prod"` on rbox-prod-api. Observability labels collapse absent/misconfigured values
   *  to `"dev"`, but security gates must only take the dev path on explicit `"dev"`. */
  RBOX_ENV?: "dev" | "prod";
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
  /** Dev-only gate for honoring the optional bootstrap `plan` body field. Prod leaves unset. */
  RBOX_ALLOW_BOOTSTRAP_PLAN?: string;
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
  /** §27 download-grant HMAC key (≥32 bytes). Wrangler secret. BEST-EFFORT (unlike the
   *  receipt key's fail-closed contract): when absent/short, `latest()` simply omits the
   *  grant and blob GETs fall back to the D1 `isEntitled` path — a misconfigured key
   *  degrades to "no speedup", never a broken pull. A forged grant is still rejected. */
  RBOX_GRANT_KEY?: string;
  /** Previous grant key during rotation — accepted on verify, never minted with. */
  RBOX_GRANT_KEY_PREV?: string;

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
  /** Analytics Engine SQL API token (Account Analytics:Read, AE-SQL-scoped). Wrangler secret;
   *  absent ⇒ the server-metrics figure (§25 read path) is reported as null (best-effort).
   *  Kept DISTINCT from `CF_ANALYTICS_TOKEN`: the GraphQL-Analytics token does not necessarily
   *  carry the AE SQL grant (they were minted separately), so conflating them would silently
   *  break one path when the other's scope narrows. NEVER in repo. */
  CF_AE_TOKEN?: string;
  /** Analytics Engine dataset the Worker writes to (and this route reads back). Var, not a
   *  secret. Must match the `rbox_metrics` binding's dataset in wrangler.jsonc — prod is
   *  `rbox_prod_metrics` (the default), dev overrides to `rbox_dev_metrics`. */
  CF_METRICS_DATASET?: string;
  /** Cloudflare account id (for the GraphQL Analytics query `accountTag` and the AE SQL
   *  endpoint path). Var, not a secret. */
  CF_ACCOUNT_ID?: string;
  /** This worker's script name (GraphQL `scriptName` filter for the 5xx query). Var. */
  CF_WORKER_NAME?: string;
  /** Browser origin of the admin SPA (e.g. `https://admin.rbox.to`) — CORS-allowed
   *  WITH credentials for the admin route only. Var; absent ⇒ no admin CORS. */
  ADMIN_ALLOWED_ORIGIN?: string;

  // ── design 64 §3.1: anonymous-edge rate limiters ─────────────────────────────
  /** Per-IP burst budget on `POST /v1/auth/device/start` (the D1-write amplifier). */
  RL_DEVICE_START: RateLimitBinding;
  /** Per-`deviceCode` budget on `POST /v1/auth/device/poll` (keyed by the high-entropy
   *  device code, not the IP, so simultaneous logins behind one NAT don't collide — §3.1). */
  RL_DEVICE_POLL: RateLimitBinding;
  /** Coarse per-IP budget on `POST /v1/auth/device/poll` after deviceCode grammar validation,
   *  bounding valid-shaped spray while preserving the per-code fairness bucket above. */
  RL_DEVICE_POLL_IP: RateLimitBinding;
  /** Shared per-IP budget across the public release GETs (install.sh/version/bin). */
  RL_RELEASE: RateLimitBinding;
  /** Shared per-IP budget across the credential-minting edges (pair/redeem + link/start). */
  RL_LINK_PAIR: RateLimitBinding;
}
