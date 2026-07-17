import type { Env } from "./env.js";
import type { Principal } from "./authz.js";
import { ctEqual, json } from "./util.js";
import { PLAN_LOOKUP_KEYS, PURCHASABLE_PLANS, planForLookupKey, type BillingCadence } from "./plans.js";
import { GRACE_PERIOD_MS } from "./billing.js";
import { dbFor, dirDb } from "./db.js";
import { pingChurn, pingNewSubscription, pingPaymentFailed } from "./slackpipes.js";
import { fairUseQueueStatement } from "./fairuse.js";

/**
 * Stripe billing (M10) — Checkout + Customer Portal + signature-verified webhook,
 * over raw fetch (no SDK). All routes are feature-gated on STRIPE_SECRET, so the
 * worker runs fine before billing is provisioned. Prices are resolved by
 * lookup_key (stable across test/live), never hardcoded ids. The webhook is the
 * source of truth that keeps accounts.plan / stripe_customer_id authoritative.
 */
const API = "https://api.stripe.com/v1";
const WEBHOOK_TOLERANCE_S = 300; // reject signatures older than 5 min (replay window)

/** Form-encode params with Stripe's bracket notation (nested objects/arrays). */
function encode(params: Record<string, unknown>, prefix = ""): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (typeof v === "object") parts.push(encode(v as Record<string, unknown>, key));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  }
  return parts.filter(Boolean).join("&");
}

async function stripeApi(env: Env, method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, unknown>): Promise<any> {
  const secret = env.STRIPE_SECRET!;
  const sendsBody = method === "POST"; // GET puts params in the query; DELETE carries none
  const body = params ? encode(params) : "";
  const url = !sendsBody && body ? `${API}${path}?${body}` : `${API}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${secret}`,
      ...(sendsBody ? { "content-type": "application/x-www-form-urlencoded" } : {}),
    },
    body: sendsBody ? body || undefined : undefined,
  });
  const data = (await res.json()) as any;
  if (!res.ok) throw new Error(`stripe ${path} ${res.status}: ${data?.error?.message ?? "error"}`);
  return data;
}

/** Resolve a plan's active price id from its lookup_key (test/live agnostic). */
async function priceIdForPlan(env: Env, plan: string, cadence: BillingCadence): Promise<string | null> {
  const lookupKey = PLAN_LOOKUP_KEYS[plan]?.[cadence];
  if (!lookupKey) return null;
  const list = await stripeApi(env, "GET", "/prices", { "lookup_keys[0]": lookupKey, active: "true", limit: 1 });
  return list.data?.[0]?.id ?? null;
}

// ---- routes (all gated on STRIPE_SECRET) ----

/** POST /v1/billing/checkout?plan=solo&cadence=monthly|annual — authed. Returns a Stripe Checkout URL. */
export async function billingCheckout(req: Request, env: Env, p: Principal): Promise<Response> {
  if (!env.STRIPE_SECRET) return json({ error: "billing_not_configured" }, 501);
  const url = new URL(req.url);
  const plan = url.searchParams.get("plan") ?? "";
  const rawCadence = url.searchParams.get("cadence") ?? "monthly";
  if (rawCadence !== "monthly" && rawCadence !== "annual") return json({ error: "bad_request", message: "cadence must be monthly or annual" }, 400);
  const cadence = rawCadence as BillingCadence;
  // Gate on the PURCHASABLE allowlist, not PLAN_LOOKUP_KEYS membership (design 63 §C):
  // `team` has a lookup_key but isn't purchasable yet, so this rejects Team checkout
  // intent deliberately — before any Stripe call — even once its price exists.
  if (!PURCHASABLE_PLANS.has(plan)) return json({ error: "bad_request", message: "unknown or non-purchasable plan" }, 400);

  // Reuse the account's existing customer if it has one (avoids duplicates).
  const acct = await dbFor(env, p.accountId)
    .prepare("SELECT stripe_customer_id, stripe_subscription_id, plan FROM accounts WHERE id = ?")
    .bind(p.accountId)
    .first<{ stripe_customer_id: string | null; stripe_subscription_id: string | null; plan: string }>();
  // Double-charge guard (design 21 §3.4.1): a second checkout on an account that
  // already has a LIVE subscription would mint a SECOND subscription on the same
  // customer (Stripe doesn't dedupe) → a double charge. Key on stripe_subscription_id
  // (set at checkout/subscription.created, cleared on subscription.deleted) — NOT on
  // grace_until, so a canceled-but-in-grace account (sub NULL) can still re-subscribe.
  // The web button hides this client-side; this is the server backstop for both
  // clients. Run BEFORE any Stripe call so an already-subscribed account makes none.
  if (acct?.stripe_subscription_id) {
    return json({ error: "already_subscribed", plan: acct.plan, message: "this account already has an active subscription — manage it from the billing portal" }, 409);
  }

  const priceId = await priceIdForPlan(env, plan, cadence);
  if (!priceId) return json({ error: "price_unavailable", message: `no active ${cadence} price for ${plan}` }, 500);

  const appUrl = env.RBOX_APP_URL ?? "https://rbox.to";
  const session = await stripeApi(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": 1,
    success_url: `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${appUrl}/billing`,
    allow_promotion_codes: true, // let a coupon/promo code be entered (launch + 100%-off test flow)
    client_reference_id: p.accountId,
    "metadata[account_id]": p.accountId,
    // Bind the subscription to the account so webhooks can map it back.
    "subscription_data[metadata][account_id]": p.accountId,
    ...(acct?.stripe_customer_id ? {} : { "subscription_data[trial_period_days]": 14 }),
    // Reuse the account's customer if it has one; in subscription mode Stripe
    // auto-creates a customer otherwise (customer_creation is payment-mode only).
    ...(acct?.stripe_customer_id ? { customer: acct.stripe_customer_id } : {}),
  });
  return json({ url: session.url });
}

/** POST /v1/billing/portal — authed. Returns a Customer Portal URL for self-serve
 *  plan changes / cancellation. Requires the account to have a Stripe customer. */
export async function billingPortal(req: Request, env: Env, p: Principal): Promise<Response> {
  if (!env.STRIPE_SECRET) return json({ error: "billing_not_configured" }, 501);
  const acct = await dbFor(env, p.accountId).prepare("SELECT stripe_customer_id FROM accounts WHERE id = ?").bind(p.accountId).first<{ stripe_customer_id: string | null }>();
  if (!acct?.stripe_customer_id) return json({ error: "no_subscription", message: "no billing customer yet — subscribe first" }, 409);
  const appUrl = env.RBOX_APP_URL ?? "https://rbox.to";
  const session = await stripeApi(env, "POST", "/billing_portal/sessions", { customer: acct.stripe_customer_id, return_url: `${appUrl}/billing` });
  return json({ url: session.url });
}

// ---- webhook ----

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Verify a Stripe-Signature header against the raw body (HMAC-SHA256 over
 *  `${t}.${body}`), within the replay tolerance. Returns true iff a v1 sig matches. */
export async function verifyStripeSignature(rawBody: string, sigHeader: string, secret: string, nowS: number): Promise<boolean> {
  // Header: "t=...,v1=...,v1=...,v0=...". Preserve the RAW timestamp string (it's
  // signed verbatim) and collect ALL v1 signatures — Stripe sends one per active
  // secret during rotation, and any match is valid.
  let t = "";
  const v1s: string[] = [];
  for (const part of sigHeader.split(",")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i);
    const val = part.slice(i + 1);
    if (k === "t") t = val;
    else if (k === "v1") v1s.push(val);
  }
  if (!t || v1s.length === 0) return false;
  const tn = Number(t);
  if (!Number.isFinite(tn) || Math.abs(nowS - tn) > WEBHOOK_TOLERANCE_S) return false; // stale → reject (replay guard)
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const expected = toHex(mac);
  return v1s.some((v) => ctEqual(expected, v)); // accept if ANY signature matches (constant-time)
}

/** POST /v1/stripe/webhook — PUBLIC, signature-verified. Keeps accounts.plan
 *  authoritative on subscription lifecycle. Idempotent via the stripe_events table. */
export async function stripeWebhook(req: Request, env: Env, nowMs: number, ctx: Pick<ExecutionContext, "waitUntil">): Promise<Response> {
  if (!env.STRIPE_WEBHOOK_SECRET) return json({ error: "billing_not_configured" }, 501);
  const sig = req.headers.get("stripe-signature") ?? "";
  const raw = await req.text(); // RAW body — signature is over exact bytes
  if (!(await verifyStripeSignature(raw, sig, env.STRIPE_WEBHOOK_SECRET, Math.floor(nowMs / 1000)))) {
    return json({ error: "bad_signature" }, 400);
  }
  const event = JSON.parse(raw) as { id: string; type: string; data: { object: any } };

  // Success-based idempotency: skip if already PROCESSED, else apply then record.
  // applyStripeEvent is idempotent, so a concurrent double-delivery is harmless;
  // recording only AFTER a successful apply means a failed apply (which throws →
  // 500) is retried by Stripe rather than silently swallowed (at-least-once).
  const seen = await dirDb(env).prepare("SELECT 1 FROM stripe_events WHERE id = ?").bind(event.id).first();
  if (seen) return json({ received: true, duplicate: true });
  await applyStripeEvent(env, event, nowMs, ctx);
  await dirDb(env).prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").bind(event.id, event.type, nowMs).run();
  return json({ received: true });
}

// Grace stamp on a paid→locked transition (design 13 G1/G6): only when the
// PRE-update plan was paid AND no unexpired grace already exists (so an
// at-least-once `deleted` / a subscribe-cancel loop inside the window can't extend
// it). Reads pre-update `plan`/`grace_until` in the CASE, so a replay after
// "UPDATE ok, event-insert failed" no-ops (plan is already 'none').
function graceCase(): string {
  return "CASE WHEN plan <> 'none' AND (grace_until IS NULL OR grace_until < ?) THEN ? ELSE grace_until END";
}

async function applyStripeEvent(env: Env, event: { type: string; data: { object: any } }, nowMs: number, ctx: Pick<ExecutionContext, "waitUntil">): Promise<void> {
  const obj = event.data.object;
  switch (event.type) {
    case "checkout.session.completed": {
      // Bind the customer + subscription to the account; the subscription.* events
      // carry the price → plan, so we don't set the plan here (avoids a race).
      const accountId = obj.client_reference_id ?? obj.metadata?.account_id;
      if (accountId && obj.customer) {
        // `reclaimed_at IS NULL`: never (re)bind billing onto a tombstoned shell. A
        // late checkout.session.completed routes here by the ORIGINAL session's
        // account (the shell); after the re-point saga clears+tombstones that shell
        // (§3.4.2), this guard refuses the stale re-bind that would split-brain it.
        await dbFor(env, accountId)
          .prepare("UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ? AND reclaimed_at IS NULL AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)")
          .bind(obj.customer, obj.subscription ?? null, accountId, obj.customer)
          .run();
      }
      break;
    }
    case "customer.subscription.created":
    case "customer.subscription.updated": {
      const accountId = obj.metadata?.account_id;
      if (!accountId || !obj.customer) break;
      const item = obj.items?.data?.[0];
      const lookupKey = item?.price?.lookup_key as string | undefined;
      const paying = obj.status === "active" || obj.status === "trialing";
      // Ownership guard unchanged: only the account this customer is bound to (or an
      // as-yet UNBOUND account named by trusted-at-checkout metadata) can change.
      if (paying) {
        // active/trialing → the purchased plan. Leave grace_until untouched (it's
        // only read when locked; clearing it would let a cancel re-grant in-window — G6).
        const plan = planForLookupKey(lookupKey) ?? "none";
        const db = dbFor(env, accountId);
        const [upd] = await db.batch([
          db.prepare("UPDATE accounts SET plan = ?, stripe_customer_id = ?, stripe_subscription_id = ? WHERE id = ? AND reclaimed_at IS NULL AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)")
            .bind(plan, obj.customer, obj.id, accountId, obj.customer),
          fairUseQueueStatement(db, accountId, nowMs, "plan_changed"),
        ]);
        // §32 Tier 1 business ping (best-effort, never throws) — only on the INITIAL
        // subscription, not every renewal `subscription.updated`, AND only when the
        // write actually transitioned a row. A late webhook for a reclaimed/CAS-guarded
        // shell no-ops the UPDATE (changes == 0) → no FALSE "new subscription" alert.
        if (event.type === "customer.subscription.created" && (upd?.meta.changes ?? 0) > 0) pingNewSubscription(ctx, env, { accountId, plan });
      } else {
        // non-paying (past_due/unpaid/canceled-but-not-deleted) → locked + grace + clear extras.
        const db = dbFor(env, accountId);
        await db.batch([
          db.prepare(`UPDATE accounts SET plan = 'none', extra_storage_bytes = 0, stripe_customer_id = ?, stripe_subscription_id = ?, grace_until = ${graceCase()} WHERE id = ? AND reclaimed_at IS NULL AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)`)
            .bind(obj.customer, obj.id, nowMs, nowMs + GRACE_PERIOD_MS, accountId, obj.customer),
          fairUseQueueStatement(db, accountId, nowMs, "plan_changed"),
        ]);
      }
      break;
    }
    case "customer.subscription.deleted": {
      // Downgrade + grace, only for the account that owns this customer+subscription.
      if (obj.customer && obj.id) {
        // §32 FLAG: this resolves the account by stripe_customer_id (a shard column under the
        // placement-constraint model) with NO account id in scope. Account-less at N=1 (one
        // shard); a sharded world needs a (stripe_customer_id → shard) directory index.
        const del = await dbFor(env, "")
          .prepare(`UPDATE accounts SET plan = 'none', extra_storage_bytes = 0, stripe_subscription_id = NULL, grace_until = ${graceCase()} WHERE stripe_customer_id = ? AND stripe_subscription_id = ?`)
          .bind(nowMs, nowMs + GRACE_PERIOD_MS, obj.customer, obj.id)
          .run();
        if ((del.meta.changes ?? 0) > 0 && obj.metadata?.account_id) {
          await fairUseQueueStatement(dbFor(env, obj.metadata.account_id), obj.metadata.account_id, nowMs, "plan_changed").run();
        }
        // §32 Tier 1 churn ping (best-effort) — only when this delete actually
        // downgraded an account; a stale/duplicate delete that matches no live row
        // (changes == 0) must not emit a FALSE churn alert.
        if ((del.meta.changes ?? 0) > 0) pingChurn(ctx, env, { accountId: obj.metadata?.account_id ?? null });
      }
      break;
    }
    case "invoice.payment_failed": {
      // §32 Tier 1 — alert on a failed charge. NO authoritative state change here (a
      // dunning failure flips plan via the subscription.* events); we only ping.
      // §32 FLAG: account resolved by stripe_customer_id with no account id in scope —
      // account-less at N=1 (dbFor(env, "")), like the subscription.deleted path above.
      const acct = obj.customer
        ? await dbFor(env, "").prepare("SELECT id FROM accounts WHERE stripe_customer_id = ?").bind(obj.customer).first<{ id: string }>()
        : null;
      pingPaymentFailed(ctx, env, { accountId: acct?.id ?? null, amountCents: typeof obj.amount_due === "number" ? obj.amount_due : null });
      break;
    }
    default:
      break; // ignore unrelated events
  }
}

// ---- account deletion: cancel + erase the Stripe footprint (design 37 §4h) ----

/** Cancel the subscription and delete the customer for an account being erased. Idempotent
 *  and best-effort: a missing/already-canceled sub or customer (Stripe `resource_missing`
 *  → 404) is treated as success, so a retried purge never wedges. Returns true on a clean
 *  pass (nothing left at Stripe), false if a transient error should make the caller retry.
 *  No-op (true) when STRIPE_SECRET is unset (billing not provisioned). A late
 *  `customer.subscription.deleted` webhook then matches no live account row → no-op. */
export async function purgeStripeForAccount(env: Env, subscriptionId: string | null, customerId: string | null): Promise<boolean> {
  if (!env.STRIPE_SECRET) return true; // billing not provisioned → nothing to erase
  try {
    if (subscriptionId) await stripeApi(env, "DELETE", `/subscriptions/${subscriptionId}`).catch((e) => rethrowUnlessMissing(e));
    if (customerId) await stripeApi(env, "DELETE", `/customers/${customerId}`).catch((e) => rethrowUnlessMissing(e));
    return true;
  } catch {
    return false; // transient Stripe error → caller retries the whole drain
  }
}

/** Swallow a Stripe `resource_missing`/404 (already gone = success for an idempotent
 *  purge); re-throw anything else so the caller can mark the drain retryable. */
function rethrowUnlessMissing(e: unknown): void {
  if (/\b404\b|resource_missing|No such/i.test(String((e as Error)?.message ?? e))) return;
  throw e;
}

// ---- re-point saga (design 21 §3.4.2) ----

/** The outcome of an attempted shell→X billing re-point. The caller (confirmLink)
 *  maps each to a confirm result: `repointed` → proceed to reclaim;
 *  `destination_has_subscription` → 409 (never merge two subs); everything else →
 *  409 origin_account_has_state (block, the always-safe fallback). */
export type RepointResult = "repointed" | "destination_has_subscription" | "not_migratable" | "unavailable";

/**
 * Move a Stripe customer + subscription from a web `shell` onto the CLI account
 * `dest` (X), idempotently. THE DUAL-ROUTING-KEY FIX (§3.4.2): the webhook routes
 * `subscription.created/updated` by the subscription's `metadata.account_id` but
 * `subscription.deleted` + every ownership guard by `accounts.stripe_customer_id`.
 * Moving only the D1 columns would leave `metadata.account_id` = shell, so the next
 * renewal's `subscription.updated` (still naming the shell, whose customer column we
 * just cleared) would re-bind the customer onto the shell — split-brain. So we
 * **update the subscription's Stripe metadata to X first**, then move the D1 columns.
 *
 * Order is Stripe-first, D1-second and every D1 write is CAS/race-guarded:
 *  - claim onto X tolerates a webhook that already bound the same customer to X
 *    (`stripe_customer_id IS NULL OR = cust`), so a mid-saga `subscription.updated`
 *    can't wedge the move;
 *  - the shell-clear is unconditional-on-the-sub it still carries, so the shell is
 *    always emptied once Stripe says X owns the subscription.
 */
export async function repointBillingToAccount(env: Env, shellId: string, destId: string, nowMs: number): Promise<RepointResult> {
  if (!env.STRIPE_SECRET) return "unavailable"; // can't run the Stripe step → caller blocks
  const [shell, dest] = await Promise.all([
    dbFor(env, shellId)
      .prepare("SELECT stripe_customer_id AS cust, stripe_subscription_id AS sub, plan, grace_until AS grace, extra_storage_bytes AS extra FROM accounts WHERE id = ?")
      .bind(shellId)
      .first<{ cust: string | null; sub: string | null; plan: string; grace: number | null; extra: number }>(),
    dbFor(env, destId).prepare("SELECT stripe_customer_id AS cust, stripe_subscription_id AS sub FROM accounts WHERE id = ?").bind(destId).first<{ cust: string | null; sub: string | null }>(),
  ]);
  // Re-point needs a FULL {customer, subscription} on the shell; a partial billing
  // state (e.g. a stray customer with no sub) isn't a migratable subscription.
  if (!shell?.cust || !shell?.sub) return "not_migratable";
  // Never auto-merge two subscriptions — block and route to guided resolution.
  if (dest?.cust || dest?.sub) return "destination_has_subscription";

  // Stripe step (idempotent PATCH): point BOTH the subscription and its customer at
  // X. Independent metadata writes (no read-after-write between them) → parallel.
  await Promise.all([
    stripeApi(env, "POST", `/subscriptions/${shell.sub}`, { "metadata[account_id]": destId }),
    stripeApi(env, "POST", `/customers/${shell.cust}`, { "metadata[account_id]": destId }),
  ]);

  // D1 move (one atomic batch; later statements see earlier ones' writes). Both
  // writes are guarded against concurrent webhooks racing the saga:
  //  1. claim onto X only if X is empty-or-already-ours AND the shell STILL holds
  //     this exact subscription — so a concurrent `subscription.deleted` that
  //     cleared the shell aborts the move instead of resurrecting a canceled sub.
  //  2. clear + TOMBSTONE the shell only if X now actually holds this sub — so a
  //     no-op claim (X raced to a DIFFERENT sub) leaves the shell intact, never
  //     merging. The `reclaimed_at` stamp closes the §3.4.2 webhook re-bind window:
  //     a late `checkout.session.completed` (routed to the shell by stale session
  //     metadata) is refused by the `reclaimed_at IS NULL` guard on the bind paths.
  // §32: this batch mutates BOTH the shell and dest `accounts` rows. The §6a placement
  // constraint forces a linkable target co-resident with its origin, so shell + dest share
  // one shard and the batch stays atomic on a single D1. Routed by destId (== shellId's shard).
  await dbFor(env, destId).batch([
    dbFor(env, destId)
      .prepare(
        `UPDATE accounts SET stripe_customer_id = ?, stripe_subscription_id = ?, plan = ?, grace_until = ?, extra_storage_bytes = ?
         WHERE id = ? AND (stripe_customer_id IS NULL OR stripe_customer_id = ?)
           AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND stripe_subscription_id = ?)`
      )
      .bind(shell.cust, shell.sub, shell.plan, shell.grace, shell.extra, destId, shell.cust, shellId, shell.sub),
    dbFor(env, destId)
      .prepare(
        `UPDATE accounts SET stripe_customer_id = NULL, stripe_subscription_id = NULL, plan = 'none', grace_until = NULL, extra_storage_bytes = 0, reclaimed_at = ?
         WHERE id = ? AND stripe_subscription_id = ?
           AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND stripe_subscription_id = ?)`
      )
      .bind(nowMs, shellId, shell.sub, destId, shell.sub),
    fairUseQueueStatement(dbFor(env, destId), destId, nowMs, "plan_changed"),
    fairUseQueueStatement(dbFor(env, shellId), shellId, nowMs, "plan_changed"),
  ]);

  // Post-batch verify: only report success if X holds EXACTLY our {customer, sub}
  // and the shell is cleared. Else block — a race left a partial/conflicting state,
  // and blocking (never merging) is the always-safe fallback.
  const [x2, s2] = await Promise.all([
    dbFor(env, destId).prepare("SELECT stripe_customer_id AS cust, stripe_subscription_id AS sub FROM accounts WHERE id = ?").bind(destId).first<{ cust: string | null; sub: string | null }>(),
    dbFor(env, shellId).prepare("SELECT stripe_customer_id AS cust FROM accounts WHERE id = ?").bind(shellId).first<{ cust: string | null }>(),
  ]);
  if (x2?.cust === shell.cust && x2?.sub === shell.sub && s2?.cust == null) return "repointed";
  if (x2?.cust && x2.cust !== shell.cust) return "destination_has_subscription"; // X raced to a different sub → never merge
  return "not_migratable"; // shell raced away (concurrent delete) → block, retryable
}
