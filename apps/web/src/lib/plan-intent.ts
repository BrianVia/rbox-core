// Carries a pricing-CTA plan intent (marketing links to app.rbox.to/?plan=solo|pro)
// through the Clerk sign-up/sign-in redirect dance so the dashboard can auto-start
// checkout once the buyer is authenticated. sessionStorage — deliberately NOT
// localStorage — so the intent lives only for this tab's session and a stale one can
// never fire days later on an unrelated visit.
const KEY = 'rbox_plan_intent';

// Same-tab staleness guard: long enough for sign-up + email verification, short
// enough that someone who abandoned sign-in and comes back hours later for something
// unrelated (e.g. cli-login) doesn't get a surprise Stripe redirect.
export const PLAN_INTENT_TTL_MS = 30 * 60 * 1000;

export type PlanIntent = 'solo' | 'pro';

// Only the two paid tiers a self-serve checkout exists for. 'free'/'team'/junk/empty
// are not stashable — team has no checkout, free has nothing to buy.
function isPlanIntent(v: unknown): v is PlanIntent {
	return v === 'solo' || v === 'pro';
}

/** Stash a plan intent from a raw `?plan=` query value; a no-op for anything that
 *  isn't exactly 'solo' or 'pro'. A throwing sessionStorage (Safari private mode)
 *  degrades to a no-op — a funnel nicety must never break the landing page.
 *  Returns whether an intent was actually stashed. `now` is injectable for tests. */
export function stashPlanIntent(raw: string | null, now = Date.now()): boolean {
	if (!isPlanIntent(raw)) return false;
	try {
		sessionStorage.setItem(KEY, JSON.stringify({ plan: raw, at: now }));
		return true;
	} catch {
		return false; // storage unavailable → skip the handoff, land on the dashboard
	}
}

/** Read-and-clear the stashed intent (one-shot): a checkout the buyer cancels comes
 *  back through /billing → /dashboard, and the intent must NOT re-fire. Returns null
 *  when absent, expired, or garbage (non-JSON / wrong shape) — whatever was read is
 *  cleared regardless, so a bad entry can't linger. */
export function consumePlanIntent(now = Date.now()): PlanIntent | null {
	let v: string | null;
	try {
		v = sessionStorage.getItem(KEY);
		sessionStorage.removeItem(KEY);
	} catch {
		return null;
	}
	if (!v) return null;
	try {
		const { plan, at } = JSON.parse(v) as { plan?: unknown; at?: unknown };
		if (typeof at !== 'number' || now - at > PLAN_INTENT_TTL_MS) return null;
		return isPlanIntent(plan) ? plan : null;
	} catch {
		return null; // legacy/garbage value — already cleared above
	}
}
