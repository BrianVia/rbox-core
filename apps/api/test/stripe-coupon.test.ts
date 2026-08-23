import { env } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { extractCoupon } from "../src/stripe.js";
import type { Env } from "../src/env.js";

const handlerEnv = (): Env => ({ ...env, STRIPE_SECRET: "sk_test_unit" } as Env);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("extractCoupon — resolves the promo code Slack pings show", () => {
  test("no discount on the subscription → null, no Stripe call made", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const coupon = await extractCoupon(handlerEnv(), { id: "sub_none", discounts: [] });
    expect(coupon).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });



  test("Stripe follow-up failure degrades to null instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "rate limited" } }, { status: 429 }));
    await expect(extractCoupon(handlerEnv(), { id: "sub_fail", discounts: ["di_x"] })).resolves.toBeNull();
  });

});
