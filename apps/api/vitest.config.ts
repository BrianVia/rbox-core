import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { readdirSync } from "node:fs";

// wrangler tracks applied migrations BY FILENAME in every environment's
// d1_migrations table, so filenames are append-only: renaming an applied file
// makes it look unapplied and re-runs it. These two number collisions came from
// parallel worktrees, are applied everywhere (prod + dev, in lexicographic
// order), and are frozen forever — do NOT rename them, do NOT extend this set.
const FROZEN_DUPLICATE_MIGRATIONS = new Set([
  "0014_account_linking.sql",
  "0014_upload_receipts.sql",
  "0016_cap_bytes_insert_materialize.sql",
  "0016_device_notifications.sql",
]);

/** Fail fast (before any test runs) on a NEW migration-number collision. */
function assertMigrationNumbering(dir: string): void {
  const byNumber = new Map<string, string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    const m = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(file);
    if (!m) throw new Error(`migration "${file}" must match NNNN_snake_case.sql`);
    const prior = byNumber.get(m[1]);
    if (prior && !(FROZEN_DUPLICATE_MIGRATIONS.has(prior) && FROZEN_DUPLICATE_MIGRATIONS.has(file))) {
      throw new Error(
        `duplicate migration number ${m[1]}: "${prior}" vs "${file}" — renumber the newer file to the next free number (rebase check: another worktree may have taken yours)`,
      );
    }
    byNumber.set(m[1], file);
  }
}

// Real DO + D1 + R2 bindings via workerd (Miniflare). D1 migrations are read at
// config time and applied per-test against the local D1 (see test/setup).
export default defineWorkersConfig(async () => {
  assertMigrationNumbering("./migrations");
  const migrations = await readD1Migrations("./migrations");
  return {
    cacheDir: "../../.cache/vitest/apps-api",
    test: {
      // Shared self-hosted CI runners contend heavily; vitest's 5s default flakes
      // healthy tests under that load. 15s still catches real hangs.
      testTimeout: 15_000,
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
              RBOX_ENV: "dev",
              RBOX_BOOTSTRAP_SECRET: "test-bootstrap-secret",
              RBOX_ALLOW_BOOTSTRAP_PLAN: "1",
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
              // Design 103: allow the full Workers suite to exercise early rejection.
              ...(process.env.RBOX_COMMIT_EARLY_REJECT ? { RBOX_COMMIT_EARLY_REJECT: process.env.RBOX_COMMIT_EARLY_REJECT } : {}),
              ...(process.env.RBOX_COMMIT_DELTA_ADMISSION ? { RBOX_COMMIT_DELTA_ADMISSION: process.env.RBOX_COMMIT_DELTA_ADMISSION } : {}),
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
