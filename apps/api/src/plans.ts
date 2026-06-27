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
  advancedHydration: boolean;
}

export const PLANS: Record<string, PlanLimits> = {
  free: { storageBytes: 2 * GiB, workspaces: 1, projects: 5, retentionDays: 0, manifestBytes: 16 * MiB, advancedHydration: false },
  solo: { storageBytes: 50 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 30, manifestBytes: 32 * MiB, advancedHydration: false },
  pro: { storageBytes: 250 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 90, manifestBytes: 64 * MiB, advancedHydration: true },
  team: { storageBytes: 150 * GiB, workspaces: Infinity, projects: Infinity, retentionDays: 90, manifestBytes: 64 * MiB, advancedHydration: true },
};

export function planFor(plan: string | null | undefined): PlanLimits {
  return PLANS[plan ?? "free"] ?? PLANS.free!;
}

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

/** Reverse map: a subscription's price lookup_key → our plan name. */
export function planForLookupKey(lookupKey: string | null | undefined): string | null {
  if (!lookupKey) return null;
  for (const [plan, key] of Object.entries(PLAN_LOOKUP_KEYS)) if (key === lookupKey) return plan;
  return null;
}
