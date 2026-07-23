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

  test("unexpanded `discounts` id (the real webhook shape) resolves via one follow-up fetch", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      expect(url.pathname).toBe("/v1/subscriptions/sub_jethro");
      expect(url.searchParams.get("expand[0]")).toBe("discounts.promotion_code");
      return Response.json({
        discounts: [{ coupon: { id: "hJCPKYml" }, promotion_code: { code: "FRIENDS5YEARSFREE" } }],
      });
    });
    const coupon = await extractCoupon(handlerEnv(), { id: "sub_jethro", discounts: ["di_1Tw6tTAPKpwtC3xY9Q9avkDu"] });
    expect(coupon).toBe("FRIENDS5YEARSFREE");
  });

  test("resolved discount with no promotion code falls back to the coupon id", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ discounts: [{ coupon: { id: "hJCPKYml" } }] }));
    const coupon = await extractCoupon(handlerEnv(), { id: "sub_no_promo", discounts: ["di_no_promo"] });
    expect(coupon).toBe("hJCPKYml");
  });

  test("Stripe follow-up failure degrades to null instead of throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { message: "rate limited" } }, { status: 429 }));
    await expect(extractCoupon(handlerEnv(), { id: "sub_fail", discounts: ["di_x"] })).resolves.toBeNull();
  });

  test("legacy inline `discount` object (pre-deprecation shape) needs no follow-up call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const coupon = await extractCoupon(handlerEnv(), { id: "sub_legacy", discount: { coupon: { name: "LEGACY10" } } });
    expect(coupon).toBe("LEGACY10");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
