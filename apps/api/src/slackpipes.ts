import type { Env } from "./env.js";
import { logErr } from "./util.js";

/**
 * TIER 1 — Slackpipes business + error pings (design §32 / observability).
 *
 * A single best-effort POST `{text}` to a Slackpipes incoming webhook. TWO
 * channels, referenced by SECRET NAME only (never a hardcoded URL):
 *   - "business" → SLACKPIPES_WEBHOOK_URL        (#rbox)
 *   - "alerts"   → SLACKPIPES_ALERTS_WEBHOOK_URL (#rbox-alerts)
 *
 * Hard contract: a ping NEVER throws and NEVER blocks/500s the caller. The Worker
 * has no `ctx.waitUntil`, so we DO await — but bounded by a SUB-SECOND AbortSignal
 * timeout (a hung Slackpipes can add at most ~0.7s to bootstrap / first-login / the
 * Stripe webhook response) and wrapped so any failure (Slackpipes down, DNS, timeout)
 * is swallowed + logged. This is the best-effort/latency tradeoff the doc accepts in
 * lieu of routing pings through the durable outbox→queue path (deferred). A Slackpipes
 * outage must not affect authoritative state. Absent secret ⇒ no-op (self-gating).
 *
 * Keep `text` low-PII: account ids / plan names are fine (this is the founder's own
 * Slack), but never user emails, tokens, paths, or blob/commit hashes.
 */

export type SlackChannel = "business" | "alerts";

/** Sub-second bound so a hung Slackpipes adds < 1s to any hot caller path
 *  (bootstrap / web first-login / the Stripe webhook response). */
const PING_TIMEOUT_MS = 700;

function webhookFor(env: Env, channel: SlackChannel): string | undefined {
  return channel === "alerts" ? env.SLACKPIPES_ALERTS_WEBHOOK_URL : env.SLACKPIPES_WEBHOOK_URL;
}

/**
 * Fire a Slackpipes ping. Resolves either way — a failure is logged (privacy-safe,
 * via logErr) and dropped, never rethrown. Returns whether a send was attempted
 * (false ⇒ channel not configured), purely so tests can assert wiring.
 */
export async function pingSlackpipes(env: Env, channel: SlackChannel, text: string): Promise<boolean> {
  const url = webhookFor(env, channel);
  if (!url) return false; // unconfigured → no-op (additive + self-gating)
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    });
    // A non-2xx Slackpipes response is logged but never surfaced to the caller.
    if (!res.ok) logErr("slackpipes_ping_non_2xx", new Error(`status ${res.status}`));
  } catch (e) {
    logErr("slackpipes_ping_failed", e);
  }
  return true;
}

// ── business events (#rbox) — all fire INLINE, best-effort ────────────────────

/** A new tenant was created (CLI bootstrap OR web first-login provisioning). */
export async function pingNewAccount(env: Env, o: { accountId: string; origin: string }): Promise<void> {
  await pingSlackpipes(env, "business", `:seedling: New rbox account onboarded — \`${o.accountId}\` (${o.origin})`);
}

/** An account started a paid subscription (Stripe `subscription.created`, paying). */
export async function pingNewSubscription(env: Env, o: { accountId: string | null; plan: string }): Promise<void> {
  await pingSlackpipes(env, "business", `:moneybag: New subscription — *${o.plan}* on account \`${o.accountId ?? "unknown"}\``);
}

/** A subscription payment failed (Stripe `invoice.payment_failed`). */
export async function pingPaymentFailed(env: Env, o: { accountId: string | null; amountCents: number | null }): Promise<void> {
  const amt = typeof o.amountCents === "number" ? ` ($${(o.amountCents / 100).toFixed(2)})` : "";
  await pingSlackpipes(env, "alerts", `:warning: Payment failed${amt} on account \`${o.accountId ?? "unknown"}\` — Stripe will retry`);
}

/** A subscription was canceled / churned (Stripe `subscription.deleted`). */
export async function pingChurn(env: Env, o: { accountId: string | null }): Promise<void> {
  await pingSlackpipes(env, "business", `:wave: Subscription canceled — account \`${o.accountId ?? "unknown"}\` downgraded to free (grace started)`);
}
