import type { Env } from "./env.js";
import { logErr } from "./util.js";

/**
 * TIER 1 — Slackpipes business + error pings (design §32 / observability).
 *
 * A best-effort POST `{text}` to a Slackpipes incoming webhook. TWO channels,
 * referenced by SECRET NAME only (never a hardcoded URL):
 *   - "business" → SLACKPIPES_WEBHOOK_URL        (#rbox)
 *   - "alerts"   → SLACKPIPES_ALERTS_WEBHOOK_URL override, otherwise derived
 *                  from the business URL's final channel segment (#rbox-alerts)
 *
 * Hard contract: a ping NEVER throws and NEVER blocks/500s the caller. Event helpers
 * register the send with `ctx.waitUntil`; no request handler awaits Slackpipes work.
 * The sender bounds each attempt, retries one timeout/5xx once, then swallows + logs
 * the terminal failure. A Slackpipes outage must not affect authoritative state.
 * No source configuration ⇒ no-op (self-gating).
 *
 * Keep `text` low-PII: account ids / plan names are fine (this is the founder's own
 * Slack). The one deliberate exception is the new-account ping for WEB signups, which
 * carries the signup email + sign-in method (founder request — ops needs to know who
 * actually signed up). Never tokens, paths, or blob/commit hashes.
 */

export type SlackChannel = "business" | "alerts";
export type SlackpipesEvent = "signup" | "subscription" | "payment_failed" | "churn" | "fleet_alert";

export const PING_TIMEOUT_MS = 5_000;
export const PING_RETRY_DELAY_MS = 1_000;

type WaitUntilContext = Pick<ExecutionContext, "waitUntil">;

export interface PingDependencies {
  fetch?: typeof fetch;
  delay?: (ms: number) => Promise<void>;
  timeoutSignal?: (ms: number) => AbortSignal;
}

function webhookFor(env: Env, channel: SlackChannel): string | undefined {
  if (channel === "business") return env.SLACKPIPES_WEBHOOK_URL;
  if (env.SLACKPIPES_ALERTS_WEBHOOK_URL) return env.SLACKPIPES_ALERTS_WEBHOOK_URL;
  const business = env.SLACKPIPES_WEBHOOK_URL;
  if (!business) return undefined;

  const derived = new URL(business);
  if (derived.pathname === "/" || derived.pathname.endsWith("/")) throw new TypeError("invalid Slackpipes channel URL");
  const finalSlash = derived.pathname.lastIndexOf("/");
  derived.pathname = `${derived.pathname.slice(0, finalSlash + 1)}rbox-alerts`;
  return derived.toString();
}

function channelFor(event: SlackpipesEvent): SlackChannel {
  return event === "payment_failed" || event === "fleet_alert" ? "alerts" : "business";
}

type SendOutcome = { configured: false } | { configured: true; ok: true } | { configured: true; ok: false; error: unknown };

/**
 * Fire a Slackpipes ping. Resolves either way — a failure is logged (privacy-safe,
 * via logErr) and dropped, never rethrown. Returns whether a send was attempted
 * (false ⇒ event channel has no source configuration), purely so tests can assert wiring.
 */
export async function pingSlackpipes(env: Env, event: SlackpipesEvent, text: string, dependencies: PingDependencies = {}): Promise<boolean> {
  try {
    const channel = channelFor(event);
    const outcome = await sendWithRetry(env, channel, text, dependencies);
    if (!outcome.configured) return false;
    if (outcome.ok) return true;
    safeLogFailure(outcome.error);

    if (channel === "business") {
      const alert = await sendWithRetry(env, "alerts", `slackpipes ping failed: ${event}`, dependencies);
      if (alert.configured && !alert.ok) safeLogFailure(alert.error);
    }
    return true;
  } catch (error) {
    // Keep even dependency initialization/property access inside the never-throws edge.
    safeLogFailure(error);
    return true;
  }
}

function safeLogFailure(error: unknown): void {
  try {
    logErr("slackpipes_ping_failed", error);
  } catch {}
}

async function sendWithRetry(env: Env, channel: SlackChannel, text: string, dependencies: PingDependencies): Promise<SendOutcome> {
  try {
    const url = webhookFor(env, channel);
    if (!url) return { configured: false }; // unconfigured → no-op (additive + self-gating)
    const fetchImpl = dependencies.fetch ?? globalThis.fetch;
    const delay = dependencies.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const timeoutSignal = dependencies.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

    const attempt = async (): Promise<{ ok: true } | { ok: false; error: unknown; retryable: boolean }> => {
      try {
        const res = await fetchImpl(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
          signal: timeoutSignal(PING_TIMEOUT_MS),
        });
        if (res.ok) return { ok: true };
        return { ok: false, error: new Error(`status ${res.status}`), retryable: res.status >= 500 && res.status <= 599 };
      } catch (error) {
        return { ok: false, error, retryable: error instanceof DOMException ? error.name === "TimeoutError" : (error as { name?: unknown })?.name === "TimeoutError" };
      }
    };

    const first = await attempt();
    if (first.ok) return { configured: true, ok: true };
    let failure = first.error;
    if (first.retryable) {
      await delay(PING_RETRY_DELAY_MS);
      const second = await attempt();
      if (second.ok) return { configured: true, ok: true };
      failure = second.error;
    }
    return { configured: true, ok: false, error: failure };
  } catch (error) {
    return { configured: true, ok: false, error };
  }
}

function schedulePing(ctx: WaitUntilContext, ping: Promise<boolean>): void {
  try {
    ctx.waitUntil(ping);
  } catch {
    // A malformed/expired context must not make an authoritative request fail. The
    // sender remains the sole owner of attempted-send failure logging, avoiding a
    // duplicate event if this already-started ping also fails.
    void ping.catch(() => {});
  }
}

// ── business events (#rbox) — waitUntil, best-effort ─────────────────────────

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
 *   web       → `… (web, prod) — jane@doe.com via github · plan none`
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

/** A new tenant was created (CLI bootstrap OR web first-login provisioning).
 *  DEV deployments never ping: dev-API signups are rig/CI/UX-walkthrough traffic,
 *  not customers — founder decision 2026-07-16. Only prod onboarding reaches the
 *  business channel (and the absent-RBOX_ENV degrade-to-dev rule keeps a
 *  misconfigured worker silent rather than noisy). */
export function pingNewAccount(
  ctx: WaitUntilContext,
  env: Env,
  o: { accountId: string; origin: string; email?: string | null; signInMethod?: string | null; plan?: string | null },
): void {
  if (envTag(env) === "dev") return;
  schedulePing(ctx, pingSlackpipes(env, "signup", formatNewAccount({ ...o, env: envTag(env) })));
}

/** An account started a paid subscription (Stripe `subscription.created`, paying). */
export function pingNewSubscription(ctx: WaitUntilContext, env: Env, o: { accountId: string | null; plan: string }): void {
  schedulePing(ctx, pingSlackpipes(env, "subscription", `:moneybag: New subscription — *${o.plan}* on account \`${o.accountId ?? "unknown"}\` (${envTag(env)})`));
}

/** A subscription payment failed (Stripe `invoice.payment_failed`). */
export function pingPaymentFailed(ctx: WaitUntilContext, env: Env, o: { accountId: string | null; amountCents: number | null }): void {
  const amt = typeof o.amountCents === "number" ? ` ($${(o.amountCents / 100).toFixed(2)})` : "";
  schedulePing(ctx, pingSlackpipes(env, "payment_failed", `:warning: Payment failed${amt} on account \`${o.accountId ?? "unknown"}\` (${envTag(env)}) — Stripe will retry`));
}

/** A subscription was canceled / churned (Stripe `subscription.deleted`). */
export function pingChurn(ctx: WaitUntilContext, env: Env, o: { accountId: string | null }): void {
  schedulePing(ctx, pingSlackpipes(env, "churn", `:wave: Subscription canceled — account \`${o.accountId ?? "unknown"}\` locked (grace started, ${envTag(env)})`));
}
