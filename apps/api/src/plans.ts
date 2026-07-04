/** Plan limits (M7b), from docs/pricing.md. `Infinity` = unlimited. */

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

export interface PlanLimits {
  storageBytes: number; // base cap (extra_storage_bytes add-on is added on top)
  workspaces: number;
  projects: number;
  /** Days of version history retained. 0 = current state only (no history) — free
   *  tier. NOTE: not yet ENFORCED — surfaced via /v1/account/usage but no
   *  plan-driven prune runs it yet (see docs/design/06-versions-gc.md). */
  retentionDays: number;
  manifestBytes: number;
  /** Max DURABLE (non-expiring) device credentials per account (design 64 §3.2). Ephemeral
   *  web-session tokens (`expires_at` set) are NOT counted. Enforced only when RBOX_ENV=prod;
   *  dev/rig treat it as unbounded (see `deviceCapFor`). */
  devices: number;
}

export const PLANS: Record<string, PlanLimits> = {
  free: { storageBytes: 2 * GiB, workspaces: 1, projects: 5, retentionDays: 0, manifestBytes: 16 * MiB, devices: 5 },
  solo: { storageBytes: 50 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 30, manifestBytes: 32 * MiB, devices: 10 },
  pro: { storageBytes: 250 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 90, manifestBytes: 64 * MiB, devices: 25 },
  team: { storageBytes: 150 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 90, manifestBytes: 64 * MiB, devices: 100 },
};

export function planFor(plan: string | null | undefined): PlanLimits {
  return PLANS[plan ?? "free"] ?? PLANS.free!;
}

/** §23: the materialized hard-cap (accounts.cap_bytes), = plan base + purchasable
 *  extra. Kept in sync with the plan wherever the plan/extra changes (account
 *  creation + the Stripe webhook). Infinity-storage plans → a large sentinel (the
 *  cap-guard trigger only blocks INCREASES past it, so a sentinel never wedges). */
export function capBytesFor(plan: string | null | undefined, extraStorageBytes = 0): number {
  const base = planFor(plan).storageBytes;
  return (Number.isFinite(base) ? base : 1e15) + extraStorageBytes;
}

/**
 * Approximate list price per paid plan, in USD cents/month (from docs/pricing.md).
 * Used ONLY for the admin cockpit's D1-derived MRR ESTIMATE (subscription counts ×
 * list price). It is intentionally a rough number — the authoritative figure is the
 * Stripe-reconciled MRR fetched live alongside it (real amounts, discounts, proration).
 * `team` is per-seat ($12–15); we use a conservative midpoint and treat one
 * subscription as one seat (the cockpit labels MRR an estimate).
 */
export const PLAN_MONTHLY_CENTS: Record<string, number> = {
  solo: 800,
  pro: 2000,
  team: 1200,
};

/**
 * Stripe price lookup_keys per paid plan (M10/billing). We map by lookup_key —
 * stable across test/live — never by raw price id, so the same code works once
 * live prices are created with the same keys. `free` has no Stripe price.
 */
export const PLAN_LOOKUP_KEYS: Record<string, string> = {
  solo: "rbox_solo_monthly",
  pro: "rbox_pro_monthly",
  team: "rbox_team_seat_monthly",
};
export const EXTRA_STORAGE_LOOKUP_KEY = "rbox_extra_100gb_monthly";

/**
 * Plans a checkout may actually be opened for (design 63 §C). Separate from
 * PLAN_LOOKUP_KEYS on purpose: `team` keeps its lookup_key (so limits, the admin MRR
 * estimate, and the webhook→plan mapping keep working) but is NOT purchasable yet —
 * it's presented everywhere as "coming soon." billingCheckout gates on THIS set, so
 * the server rejects Team checkout intent before any Stripe call, regardless of which
 * client (or non-client) calls it — even after a `rbox_team_seat_monthly` price
 * exists. Launching Team is then a one-line add here.
 */
export const PURCHASABLE_PLANS = new Set<string>(["solo", "pro"]);

/** Reverse map: a subscription's price lookup_key → our plan name. */
export function planForLookupKey(lookupKey: string | null | undefined): string | null {
  if (!lookupKey) return null;
  for (const [plan, key] of Object.entries(PLAN_LOOKUP_KEYS)) if (key === lookupKey) return plan;
  return null;
}
