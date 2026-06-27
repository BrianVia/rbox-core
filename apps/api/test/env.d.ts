import type { Env } from "../src/env.js";
import type { D1Migration } from "@cloudflare/vitest-pool-workers/config";

// Make the provided test env carry our bindings + the migrations array injected
// by vitest.config.ts, so `env.rbox_dev_db` / `env.TEST_MIGRATIONS` are typed.
declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
