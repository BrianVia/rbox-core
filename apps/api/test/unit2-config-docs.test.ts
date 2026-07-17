import { describe, expect, test } from "vitest";
import envSource from "../src/env.ts?raw";
import wranglerSource from "../wrangler.jsonc?raw";
import deploymentsSource from "../../../docs/DEPLOYMENTS.md?raw";
import billingRoutesSource from "../src/routes/billing.ts?raw";

describe("Design 151 Unit 2 Stripe configuration and recovery documentation", () => {
  test("declares the validated cap and sets the explicit default in both Wrangler environments", () => {
    expect(envSource).toContain("RBOX_STRIPE_WEBHOOK_MAX_BYTES?: string");
    expect(wranglerSource.match(/RBOX_STRIPE_WEBHOOK_MAX_BYTES/g)).toHaveLength(2);
    expect(wranglerSource.match(/"RBOX_STRIPE_WEBHOOK_MAX_BYTES"\s*:\s*"1048576"/g)).toHaveLength(2);
  });

  test("documents corroborate, raise, deploy, then dashboard-resend within 15 days", () => {
    expect(deploymentsSource).toMatch(/Stripe-side corroboration/i);
    expect(deploymentsSource).toMatch(/raise[\s\S]*deploy[\s\S]*resend[\s\S]*Stripe dashboard/i);
    expect(deploymentsSource).toMatch(/15-day/i);
    expect(deploymentsSource).toMatch(/no local replay/i);
  });

  test("adds no Stripe replay, fetch-by-id, reconciliation, or admin route", () => {
    expect(billingRoutesSource).toContain('["v1", "stripe", "webhook"]');
    expect(billingRoutesSource).not.toMatch(/\["v1",\s*"stripe",\s*"(?:replay|events?|fetch|reconcile|admin)"\]/i);
  });
});
