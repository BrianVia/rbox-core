import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

// Real DO + D1 + R2 bindings via workerd (Miniflare). D1 migrations are read at
// config time and applied per-test against the local D1 (see test/setup).
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    test: {
      poolOptions: {
        workers: {
          // Tests bootstrap unique accounts, so per-test storage isolation isn't
          // needed — and disabling it avoids the stacked-storage teardown assert
          // that D1+DO trip. One worker keeps the shared D1/R2 deterministic.
          isolatedStorage: false,
          singleWorker: true,
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              RBOX_BOOTSTRAP_SECRET: "test-bootstrap-secret",
              RBOX_PLATFORM_SECRET: "test-platform-secret",
              // Webhook secret set (so we can test signed delivery) but STRIPE_SECRET
              // deliberately ABSENT (so checkout/portal exercise the 501 gate).
              STRIPE_WEBHOOK_SECRET: "whsec_test_secret",
              CLERK_ISSUER: "https://clerk.test",
              CLERK_JWKS_URL: "https://clerk.test/.well-known/jwks.json",
              CLERK_ALLOWED_ORIGINS: "https://app.test",
              CLERK_SECRET_KEY: "sk_test_clerk_dummy",
              RBOX_RECEIPT_KEY: "test-receipt-key-at-least-32-bytes-long-xx",
              RBOX_GRANT_KEY: "test-grant-key-at-least-32-bytes-long-xxxxx",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
