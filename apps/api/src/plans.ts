/** Plan limits (M7b), from docs/pricing.md. `Infinity` = unlimited. */

const GiB = 1024 * 1024 * 1024;
const MiB = 1024 * 1024;

export interface PlanLimits {
  storageBytes: number; // base cap (extra_storage_bytes add-on is added on top)
  workspaces: number;
  projects: number;
  /** Days of version history retained. 0 = current state only (no history) — locked
   *  accounts. Enforced by the scheduled authoritative-DO retention pass (design 66). */
  retentionDays: number;
  manifestBytes: number;
  /** Max durable (non-expiring) device credentials per account (design 64 §3.2). Ephemeral
   *  web-session tokens (`expires_at` set) are not counted. Only explicit RBOX_ENV=dev
   *  disables enforcement for dev/rig; absent or mistyped envs enforce. */
  devices: number;
}

const PAID_PLAN_NAMES = ["solo", "pro", "team"] as const;
const PAID_PLAN_SET = new Set<string>(PAID_PLAN_NAMES);

export const PLANS: Record<string, PlanLimits> = {
  none: { storageBytes: 1, workspaces: 1, projects: 1, retentionDays: 0, manifestBytes: 16 * MiB, devices: 2 },
  solo: { storageBytes: 50 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 30, manifestBytes: 32 * MiB, devices: 10 },
  pro: { storageBytes: 250 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 365, manifestBytes: 64 * MiB, devices: 25 },
  team: { storageBytes: 150 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 90, manifestBytes: 64 * MiB, devices: 100 },
};

export function isPaidPlan(plan: string | null | undefined): boolean {
  return PAID_PLAN_SET.has(plan ?? "");
}

export function planFor(plan: string | null | undefined): PlanLimits {
  return PLANS[plan ?? "none"] ?? PLANS.none!;
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
 * §228: THE number rbox bills, shows and compares against the plan cap.
 *
 * `accounts.used_bytes` is the live entitlement ledger — every ref the account has
 * uploaded and not had pruned, including superseded history. The founder ruling is
 * that history is stored but never billed, so the billable number subtracts the
 * measured history overhang written by the fair-use scan's completion
 * (`fairuse.ts` completeScan, the single writer of `history_overhang_bytes`):
 *
 *   billable = active_bytes(last completed scan) + net ledger delta since that scan
 *
 * Overhang 0 (the column default, i.e. no scan has ever completed) makes this the
 * identity — the fallback is exactly today's behaviour, labelled as unmeasured by
 * `usage()`'s `measuredAt: null`. Clamped at 0 because GC can prune the ledger
 * below a standing overhang between hourly scans; a negative allowance is never
 * meaningful. Kept in lockstep with BILLABLE_BYTES_SQL, which the D1 cap-guard
 * trigger (migration 0036) evaluates on the same two columns.
 */
export function billableBytes(usedBytes: number | null | undefined, historyOverhangBytes: number | null | undefined): number {
  return Math.max(0, Number(usedBytes ?? 0) - Number(historyOverhangBytes ?? 0));
}

/** SQL form of `billableBytes` over an `accounts` row. */
export const BILLABLE_BYTES_SQL = "MAX(0, used_bytes - history_overhang_bytes)";

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
 * live prices are created with the same keys. `none` has no Stripe price.
 */
export type BillingCadence = "monthly" | "annual";

export const PLAN_LOOKUP_KEYS: Record<string, Partial<Record<BillingCadence, string>>> = {
  solo: { monthly: "rbox_solo_monthly", annual: "rbox_solo_annual" },
  pro: { monthly: "rbox_pro_monthly", annual: "rbox_pro_annual" },
  team: { monthly: "rbox_team_seat_monthly" },
};
export const EXTRA_STORAGE_LOOKUP_KEYS: Record<BillingCadence, string> = {
  monthly: "rbox_extra_100gb_monthly",
  annual: "rbox_extra_100gb_annual",
};

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
  for (const [plan, keys] of Object.entries(PLAN_LOOKUP_KEYS)) {
    if (Object.values(keys).includes(lookupKey)) return plan;
  }
  return null;
}
