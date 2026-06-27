import type { Env } from "./env.js";
import { json } from "./util.js";
import { planFor } from "./plans.js";

/**
 * Resolve the EFFECTIVE plan for an account — the single seam where tier is
 * decided for entitlement (retention, quotas, features).
 *
 * PLACEHOLDER (Stripe): today the `accounts.plan` column is the source of truth
 * (set via the platform admin set-plan route). Once paid subscriptions are
 * linked, THIS is where we reconcile the stored plan against the LIVE Stripe
 * subscription — so a stale column can't grant a tier the user no longer pays
 * for. Intended shape:
 *
 *   const sub = await stripeSubscriptionStatus(env, accountId);
 *   if (!sub || sub.status !== "active") return "free";   // canceled/past_due → downgrade
 *   return sub.plan;                                       // authoritative tier
 *
 * Kept async now so adding the Stripe call later is non-breaking.
 */
export async function resolveAccountPlan(_env: Env, _accountId: string, storedPlan: string | null): Promise<string> {
  // TODO(stripe): verify against live subscription status once billing is linked.
  return storedPlan ?? "free";
}

/**
 * Plan-driven retention prune (M6 prune + M7b plans). For each workspace, set its
 * DO prune floor so versions OLDER than the owning account's `retentionDays` are
 * dropped — free (retentionDays 0) keeps only the current state. This sets floors
 * only; the existing GC mark/purge reclaims the now-unreachable blobs, so the
 * operational order is: retention → mark → purge. The DO never prunes the head,
 * so the current version always survives regardless of the window.
 */
export async function retentionPrune(env: Env): Promise<Response> {
  const rows = await env.rbox_dev_db
    .prepare(
      "SELECT w.workspace_id AS ws, w.project_id AS proj, w.account_id AS acct, a.plan AS plan " +
        "FROM workspaces w JOIN accounts a ON a.id = w.account_id"
    )
    .all<{ ws: string; proj: string; acct: string; plan: string | null }>();

  let pruned = 0;
  const perWorkspace: Array<{ ws: string; proj: string; floor: number; pruned: number }> = [];
  for (const r of rows.results ?? []) {
    const plan = await resolveAccountPlan(env, r.acct, r.plan);
    const days = planFor(plan).retentionDays;
    // The highest sequence whose version is OLDER than the retention window is the
    // prune floor (everything ≤ floor is past retention). days=0 → cutoff = now →
    // every version committed before this instant is prunable; the DO caps the
    // floor at head-1, so the current state is never dropped.
    const floorRow = await env.rbox_dev_db
      .prepare("SELECT MAX(sequence) AS floor FROM manifests WHERE workspace_id = ? AND project_id = ? AND created_at < datetime('now', ?)")
      .bind(r.ws, r.proj, `-${days} days`)
      .first<{ floor: number | null }>();
    const floor = floorRow?.floor ?? 0;
    if (floor <= 0) continue; // nothing old enough to prune

    const id = env.WORKSPACE_SYNC.idFromName(`${r.ws}/${r.proj}`);
    const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/v1/ws/${r.ws}/proj/${r.proj}/prune`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ floor }),
    });
    if (!res.ok) throw new Error(`retention prune failed for ${r.ws}/${r.proj}: ${res.status}`);
    const out = (await res.json()) as { pruned: number; pruneFloor: number };
    pruned += out.pruned;
    if (out.pruned > 0) perWorkspace.push({ ws: r.ws, proj: r.proj, floor: out.pruneFloor, pruned: out.pruned });
  }
  return json({ ok: true, workspaces: rows.results?.length ?? 0, pruned, perWorkspace });
}
