import type { RateLimitBinding } from "./env.js";
import { clientIp } from "./notify.js";
import { json, logErr } from "./util.js";

/**
 * The anonymous-edge rate-limit guard (design 64 §3.1). Each public route calls this
 * once, BEFORE its D1 work, so a limited request costs one binding lookup — not a write.
 *
 * FAIL-OPEN (§4): a thrown (or absent) `.limit()` is logged and treated as allowed, so a
 * binding hiccup can never take down login. The counters are per-edge-location and age out
 * on their 10/60s window — a deliberate cost/abuse FLOOR, not a precise global quota.
 */

/** Returns a 429 Response when `key` is over-budget on `binding`, else `null` (proceed). */
export async function rateLimited(binding: RateLimitBinding | undefined, key: string): Promise<Response | null> {
  try {
    if ((await binding!.limit({ key })).success) return null;
  } catch (e) {
    logErr("ratelimit_binding_error", e);
    return null; // fail open — never block on a binding error
  }
  return json({ error: "rate_limited", retryAfterSeconds: 60 }, 429, { "Retry-After": "60" });
}

/** The IP component of a rate-limit key. Reuses notify.ts's CF-Connecting-IP extraction;
 *  `noip` is a stable fallback so a header-less request still shares one bucket. */
export function ipKey(req: Request): string {
  return clientIp(req) ?? "noip";
}
