import type { Env } from "./env.js";
import { json } from "./util.js";
import { planFor } from "./plans.js";
import { dbFor } from "./db.js";

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
export async function retentionPrune(env: Env, nowMs: number = Date.now()): Promise<Response> {
  // §32 FLAG: retention enumerates `workspaces × accounts` across ALL accounts — an
  // account-data-plane CROSS-SHARD fan-out (design 32 §6c, daily cron fans out over
  // liveShards). Account-less at N=1 (the one shard); the per-workspace floor query below
  // routes by the row's owning account.
  const rows = await dbFor(env, "")
    .prepare(
      "SELECT w.workspace_id AS ws, w.project_id AS proj, w.account_id AS acct, a.plan AS plan, a.grace_until AS grace_until " +
        "FROM workspaces w JOIN accounts a ON a.id = w.account_id"
    )
    .all<{ ws: string; proj: string; acct: string; plan: string | null; grace_until: number | null }>();

  let pruned = 0;
  let inGrace = 0;
  const perWorkspace: Array<{ ws: string; proj: string; floor: number; pruned: number }> = [];
  for (const r of rows.results ?? []) {
    // Downgrade grace (design 13): while grace_until is in the future, retain ALL
    // history — skip pruning entirely. Only consulted when free; paid plans keep
    // their own retentionDays regardless.
    if (r.grace_until != null && nowMs < r.grace_until) {
      inGrace++;
      continue;
    }
    const plan = await resolveAccountPlan(env, r.acct, r.plan);
    const days = planFor(plan).retentionDays;
    // The highest sequence whose commit is OLDER than the retention window is the
    // prune floor (everything ≤ floor is past retention). days=0 → cutoff = now →
    // every version committed before this instant is prunable; the DO caps the
    // floor at head-1, so the current state is never dropped. Source = `commits`
    // (E2EE writes there; created_at is epoch ms) — the legacy `manifests` table is
    // empty for E2EE workspaces (design 13 G2).
    const floorRow = await dbFor(env, r.acct)
      .prepare("SELECT MAX(sequence) AS floor FROM commits WHERE workspace_id = ? AND project_id = ? AND created_at < ?")
      .bind(r.ws, r.proj, nowMs - days * 86_400_000)
      .first<{ floor: number | null }>();
    const floor = floorRow?.floor ?? 0;
    if (floor <= 0) continue; // nothing old enough to prune

    const id = env.WORKSPACE_SYNC.idFromName(`${r.ws}/${r.proj}`);
    // Slash-safe addressing (design 37 §4f follow-up): like the GC roots scan, a positional
    // `…/proj/:proj/prune` mis-parses a project_id containing "/". Use the DO's FIXED `/prune`
    // path with ws/proj in the query (floor stays in the body), so retention can't wedge either.
    const q = `?ws=${encodeURIComponent(r.ws)}&proj=${encodeURIComponent(r.proj)}`;
    const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/prune${q}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ floor }),
    });
    if (!res.ok) throw new Error(`retention prune failed for ${r.ws}/${r.proj}: ${res.status}`);
    const out = (await res.json()) as { pruned: number; pruneFloor: number };
    pruned += out.pruned;
    if (out.pruned > 0) perWorkspace.push({ ws: r.ws, proj: r.proj, floor: out.pruneFloor, pruned: out.pruned });
  }
  return json({ ok: true, workspaces: rows.results?.length ?? 0, inGrace, pruned, perWorkspace });
}
