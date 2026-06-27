import type { Env } from "./env.js";
import { json } from "./util.js";
import { PLANS, planFor } from "./plans.js";
import { audit, type Principal } from "./authz.js";

async function account(env: Env, accountId: string): Promise<{ plan: string; extra: number; used: number }> {
  const r = await env.rbox_dev_db.prepare("SELECT plan, extra_storage_bytes, used_bytes FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string; extra_storage_bytes: number; used_bytes: number }>();
  return { plan: r?.plan ?? "free", extra: Number(r?.extra_storage_bytes ?? 0), used: Number(r?.used_bytes ?? 0) };
}

export async function storageCap(env: Env, accountId: string): Promise<number> {
  const a = await account(env, accountId);
  return planFor(a.plan).storageBytes + a.extra; // Infinity for unlimited plans
}

/**
 * Atomically grant blob entitlement under quota (M7b). `INSERT OR IGNORE blob_refs`
 * dedups concurrent grants of the same (account,sha) — only a NEW entitlement is
 * charged. The charge is a conditional `used_bytes += size WHERE used+size <= cap`
 * which D1 serializes per row, so concurrent uploads can't jointly exceed the cap.
 * Over quota → roll back the entitlement, return granted:false (caller 402s; the
 * canonical R2 blob is left as a GC-reclaimable orphan, never deleted).
 */
export async function grantEntitlementWithQuota(env: Env, accountId: string, sha: string, size: number): Promise<{ granted: boolean; used: number; cap: number }> {
  const cap = await storageCap(env, accountId);
  const ins = await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(accountId, sha).run();
  if ((ins.meta.changes ?? 0) === 0) {
    const a = await account(env, accountId); // already entitled → no charge (dedup)
    return { granted: true, used: a.used, cap };
  }
  if (cap === Infinity) {
    await env.rbox_dev_db.prepare("UPDATE accounts SET used_bytes = used_bytes + ? WHERE id = ?").bind(size, accountId).run();
    const a = await account(env, accountId);
    return { granted: true, used: a.used, cap };
  }
  const upd = await env.rbox_dev_db.prepare("UPDATE accounts SET used_bytes = used_bytes + ? WHERE id = ? AND used_bytes + ? <= ?").bind(size, accountId, size, cap).run();
  if ((upd.meta.changes ?? 0) === 1) {
    const a = await account(env, accountId);
    return { granted: true, used: a.used, cap };
  }
  await env.rbox_dev_db.prepare("DELETE FROM blob_refs WHERE account_id = ? AND sha256 = ?").bind(accountId, sha).run(); // roll back
  const a = await account(env, accountId);
  return { granted: false, used: a.used, cap };
}

/** Decrement an account's usage counter (called by GC purge per dropped entitlement). */
export async function releaseUsage(env: Env, accountId: string, size: number): Promise<void> {
  await env.rbox_dev_db.prepare("UPDATE accounts SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?").bind(size, accountId).run();
}

export async function countWorkspaces(env: Env, accountId: string): Promise<number> {
  const r = await env.rbox_dev_db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE account_id = ?").bind(accountId).first<{ n: number }>();
  return Number(r?.n ?? 0);
}

export async function planLimitsFor(env: Env, accountId: string) {
  return planFor((await account(env, accountId)).plan);
}

// GET /v1/account/usage
export async function usage(env: Env, p: Principal): Promise<Response> {
  const a = await account(env, p.accountId);
  const limits = planFor(a.plan);
  const cap = limits.storageBytes + a.extra;
  return json({
    plan: a.plan,
    usedBytes: a.used,
    storageCap: cap === Infinity ? null : cap,
    workspaces: await countWorkspaces(env, p.accountId),
    workspaceCap: limits.workspaces === Infinity ? null : limits.workspaces,
    retentionDays: limits.retentionDays,
  });
}

// POST /v1/admin/account/:id/plan?plan=pro&extraGB=N  (PLATFORM secret — until Stripe).
export async function adminSetPlan(env: Env, accountId: string, plan: string, extraGB: number): Promise<Response> {
  if (!PLANS[plan]) return json({ error: "bad_plan", valid: Object.keys(PLANS) }, 400);
  const extra = Number.isFinite(extraGB) && extraGB >= 0 ? Math.floor(extraGB) * 1024 * 1024 * 1024 : 0;
  const r = await env.rbox_dev_db.prepare("UPDATE accounts SET plan = ?, extra_storage_bytes = ? WHERE id = ?").bind(plan, extra, accountId).run();
  await audit(env, null, "account.set_plan", `${accountId}:${plan}`);
  return json({ ok: true, accountId, plan, changed: r.meta.changes });
}

/* Stripe (DEFERRED — needs STRIPE_SECRET + product/price IDs): checkout/portal/
 * webhook flip accounts.plan + extra_storage_bytes. Endpoints 501 until provisioned;
 * adminSetPlan is the interim control. */
