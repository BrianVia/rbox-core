import { eq, type RouteCtx } from "./shared.js";
import { billingCheckout, billingPortal, stripeWebhook } from "../stripe.js";
import type { Principal } from "../authz.js";

/** Stripe webhook is PUBLIC but signature-verified (exact route), so it sits
 *  BEFORE authenticate(). */
export async function billingWebhookRoutes({ req, env, executionCtx, seg }: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "stripe", "webhook"])) return stripeWebhook(req, env, Date.now(), executionCtx);
  return null;
}

/** Authed billing ops (checkout/portal), account-scoped via Principal. */
export async function billingRoutes({ req, env, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (req.method === "POST" && eq(seg, ["v1", "billing", "checkout"])) return billingCheckout(req, env, p);
  if (req.method === "POST" && eq(seg, ["v1", "billing", "portal"])) return billingPortal(req, env, p);
  return null;
}
