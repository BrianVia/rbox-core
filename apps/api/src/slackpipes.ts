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
 * Slack). The one deliberate exception is the new-account ping for WEB signups, which
 * carries the signup email + sign-in method (founder request — ops needs to know who
 * actually signed up). Never tokens, paths, or blob/commit hashes.
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

/** The deploy-env tag for observability pings — dev vs prod (see env.RBOX_ENV).
 *  Absent/misconfigured degrades to "dev" so dev traffic is never mislabeled prod. */
function envTag(env: Env): "dev" | "prod" {
  return env.RBOX_ENV === "prod" ? "prod" : "dev";
}

/** Fields for the new-account ping. `origin`/`env` always present; the rich fields
 *  (email / signInMethod / plan) are best-effort — any that's missing is omitted from
 *  the message rather than breaking it (bootstrap accounts carry none of them). */
export interface NewAccountPing {
  accountId: string;
  origin: string; // "bootstrap" | "web"
  env: "dev" | "prod";
  email?: string | null;
  signInMethod?: string | null; // "github" | "google" | "email"
  plan?: string | null;
}

/**
 * PURE formatter for the new-account ping (unit-testable; the fetch/plumbing lives in
 * `pingNewAccount`). Shapes:
 *   bootstrap → `:seedling: New rbox account onboarded — \`acct_…\` (bootstrap, dev)`
 *   web       → `… (web, prod) — jane@doe.com via github · plan free`
 * Every rich segment degrades independently — a missing field drops just that segment.
 */
export function formatNewAccount(o: NewAccountPing): string {
  const base = `:seedling: New rbox account onboarded — \`${o.accountId}\` (${o.origin}, ${o.env})`;
  const bits: string[] = [];
  if (o.email && o.signInMethod) bits.push(`${o.email} via ${o.signInMethod}`);
  else if (o.email) bits.push(o.email);
  else if (o.signInMethod) bits.push(`via ${o.signInMethod}`);
  if (o.plan) bits.push(`plan ${o.plan}`);
  return bits.length ? `${base} — ${bits.join(" · ")}` : base;
}

/** A new tenant was created (CLI bootstrap OR web first-login provisioning). */
export async function pingNewAccount(
  env: Env,
  o: { accountId: string; origin: string; email?: string | null; signInMethod?: string | null; plan?: string | null },
): Promise<void> {
  await pingSlackpipes(env, "business", formatNewAccount({ ...o, env: envTag(env) }));
}

/** An account started a paid subscription (Stripe `subscription.created`, paying). */
export async function pingNewSubscription(env: Env, o: { accountId: string | null; plan: string }): Promise<void> {
  await pingSlackpipes(env, "business", `:moneybag: New subscription — *${o.plan}* on account \`${o.accountId ?? "unknown"}\` (${envTag(env)})`);
}

/** A subscription payment failed (Stripe `invoice.payment_failed`). */
export async function pingPaymentFailed(env: Env, o: { accountId: string | null; amountCents: number | null }): Promise<void> {
  const amt = typeof o.amountCents === "number" ? ` ($${(o.amountCents / 100).toFixed(2)})` : "";
  await pingSlackpipes(env, "alerts", `:warning: Payment failed${amt} on account \`${o.accountId ?? "unknown"}\` (${envTag(env)}) — Stripe will retry`);
}

/** A subscription was canceled / churned (Stripe `subscription.deleted`). */
export async function pingChurn(env: Env, o: { accountId: string | null }): Promise<void> {
  await pingSlackpipes(env, "business", `:wave: Subscription canceled — account \`${o.accountId ?? "unknown"}\` downgraded to free (grace started, ${envTag(env)})`);
}
