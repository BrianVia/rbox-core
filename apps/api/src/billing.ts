import type { Env } from "./env.js";
import { json } from "./util.js";
import { PLANS, planFor } from "./plans.js";
import { audit, entitledSubset, isEntitled, type Principal } from "./authz.js";
import { isOverCapAbort } from "./auth.js";
import { dbFor } from "./db.js";

/** Downgrade grace window (design 13): paid→locked preserves all version history
 *  for this long before locked-state retention resumes. */
export const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

async function account(env: Env, accountId: string): Promise<{ plan: string; extra: number; used: number; graceUntil: number | null }> {
  const r = await dbFor(env, accountId).prepare("SELECT plan, extra_storage_bytes, used_bytes, grace_until FROM accounts WHERE id = ?").bind(accountId).first<{ plan: string; extra_storage_bytes: number; used_bytes: number; grace_until: number | null }>();
  return { plan: r?.plan ?? "none", extra: Number(r?.extra_storage_bytes ?? 0), used: Number(r?.used_bytes ?? 0), graceUntil: r?.grace_until ?? null };
}

/** Fast-fail over-cap check BEFORE writing bytes to R2 (design 13 G4): true when
 *  accepting `incomingSize` more bytes would exceed the cap. Advisory — the
 *  authoritative, race-safe charge is still grantEntitlementWithQuota at finalize;
 *  this just stops a downgraded/over-cap account from staging orphan R2 cost and
 *  gives the client an immediate "you're over your plan" 402.
 *
 *  §33: entitlement-aware. A ref this account is ALREADY entitled to charges 0 at the grant
 *  (NOT-EXISTS), so it can never push the account over cap — including the candidate-aware
 *  "missing" re-upload of a prune-marked but still-owned ref by an at/over-cap account. We
 *  return `over:false` for it directly, so callers need no fake-sentinel bypass. */
export async function wouldExceedCap(env: Env, accountId: string, sha: string, incomingSize: number): Promise<{ over: boolean; used: number; cap: number; reason?: "no_plan" }> {
  const a = await account(env, accountId);
  const cap = planFor(a.plan).storageBytes + a.extra;
  if (a.plan === "none") return { over: true, used: a.used, cap, reason: "no_plan" };
  if (await isEntitled(env, accountId, sha)) return { over: false, used: a.used, cap };
  const over = cap !== Infinity && a.used + incomingSize > cap;
  return { over, used: a.used, cap, ...(over && a.plan === "none" ? { reason: "no_plan" as const } : {}) };
}

/** Design 114 pack-PUT fail-fast quota check. Already-entitled logical blobs
 * cost zero; redemption's atomic cap guard remains the publication authority. */
export async function wouldExceedCapAggregate(
  env: Env,
  accountId: string,
  members: Array<{ sha: string; size: number }>,
): Promise<{ over: boolean; used: number; cap: number; reason?: "no_plan" }> {
  const [a, entitled] = await Promise.all([
    account(env, accountId),
    entitledSubset(env, accountId, members.map((member) => member.sha)),
  ]);
  const cap = planFor(a.plan).storageBytes + a.extra;
  if (a.plan === "none") return { over: true, used: a.used, cap, reason: "no_plan" };
  let incomingSize = 0;
  for (const member of members) if (!entitled.has(member.sha)) incomingSize += member.size;
  // Match wouldExceedCap's existing behavior: a wholly entitled retry costs
  // exactly zero and remains admissible even when the account is already at/over cap.
  return { over: incomingSize > 0 && cap !== Infinity && a.used + incomingSize > cap, used: a.used, cap };
}

/**
 * Atomically grant blob entitlement under quota (M7b). `INSERT OR IGNORE blob_refs`
 * dedups concurrent grants of the same (account,sha) — only a NEW entitlement is
 * charged. The charge is a conditional `used_bytes += size WHERE used+size <= cap`
 * which D1 serializes per row, so concurrent uploads can't jointly exceed the cap.
 * Over quota → roll back the entitlement, return granted:false (caller 402s; the
 * canonical R2 blob is left as a GC-reclaimable orphan, never deleted).
 */
export async function grantEntitlementWithQuota(env: Env, accountId: string, sha: string, size: number, nowMs: number = Date.now()): Promise<{ granted: boolean; used: number; cap: number; reason?: "no_plan" }> {
  const db = dbFor(env, accountId);
  const a = await account(env, accountId);
  const cap = planFor(a.plan).storageBytes + a.extra;
  if (a.plan === "none") return { granted: false, used: a.used, cap, reason: "no_plan" };
  // §33: the grant is ONE atomic db.batch (one D1 transaction), mirroring commitAccounting —
  // NOT a split insert-then-charge. Statement order is charge → grant → un-mark/un-condemn:
  //   1. CHARGE iff newly entitled (NOT-EXISTS, evaluated BEFORE the grant insert so it sees
  //      the pre-insert state). The accounts_cap_guard trigger RAISE(ABORT)s an over-cap
  //      INCREASE → the WHOLE batch rolls back → granted:false (no charge, no ref, no clear).
  //   2. GRANT / re-stamp `granted_at` (was SQLite default 0 — which made a fresh ref instantly
  //      satisfy any `granted_at < cutoff` grace; the marker, not granted_at, is the barrier).
  //   3. CLEAR this account's Phase-1 prune marker + un-condemn `gc_candidates`, atomically.
  // Atomicity closes two races §33 newly exposes (Phase 1 now deletes live blob_refs on cron):
  //   (a) a concurrent same-sha grant can't see an uncharged insert (charge+insert are one txn);
  //   (b) the grant is serialized WHOLE against phase1Purge's delete batch — purge either runs
  //       fully before (then this re-charges + re-creates the ref) or fully after (then its
  //       marker-existence guard sees the cleared marker → no-op). No "granted:true, ref gone".
  try {
    await db.batch([
      db
        .prepare(
          `UPDATE accounts SET used_bytes = used_bytes + (
             CASE WHEN NOT EXISTS (SELECT 1 FROM blob_refs WHERE account_id = ? AND sha256 = ?) THEN ? ELSE 0 END)
           WHERE id = ?`,
        )
        .bind(accountId, sha, size, accountId),
      db
        .prepare("INSERT INTO blob_refs (account_id, sha256, granted_at) VALUES (?, ?, ?) ON CONFLICT(account_id, sha256) DO UPDATE SET granted_at = excluded.granted_at")
        .bind(accountId, sha, nowMs),
      db.prepare("DELETE FROM blob_ref_candidates WHERE account_id = ? AND sha256 = ?").bind(accountId, sha),
      db.prepare("DELETE FROM gc_candidates WHERE sha256 = ? AND deleting_at IS NULL").bind(sha),
    ]);
  } catch (e) {
    // accounts_cap_guard RAISE(ABORT,'over_cap') rolled the whole batch back → nothing granted.
    if (isOverCapAbort(e)) {
      const latest = await account(env, accountId);
      return { granted: false, used: latest.used, cap: planFor(latest.plan).storageBytes + latest.extra, ...(latest.plan === "none" ? { reason: "no_plan" as const } : {}) };
    }
    throw e;
  }
  // ONE post-batch accounts read is the authoritative used/cap (the cap-guard trigger, not an
  // upfront cap fetch, is the gate) — `cap` is derived locally from the same row, no second read.
  const after = await account(env, accountId);
  return { granted: true, used: after.used, cap: planFor(after.plan).storageBytes + after.extra };
}

/** Decrement an account's usage counter (called by GC purge per dropped entitlement). */
export async function releaseUsage(env: Env, accountId: string, size: number): Promise<void> {
  await dbFor(env, accountId).prepare("UPDATE accounts SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ?").bind(size, accountId).run();
}

export async function countWorkspaces(env: Env, accountId: string): Promise<number> {
  const r = await dbFor(env, accountId).prepare("SELECT COUNT(*) AS n FROM workspaces WHERE account_id = ?").bind(accountId).first<{ n: number }>();
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
    // Downgrade grace (design 13): graceUntil set on a paid→locked transition; while
    // it's in the future, history is preserved. readOnly = already at/over cap, so
    // any new upload is blocked (used+size<=cap is the grant predicate).
    graceUntil: a.graceUntil,
    readOnly: cap !== Infinity && a.used >= cap,
  });
}

// POST /v1/admin/account/:id/plan?plan=pro&extraGB=N  (PLATFORM secret — until Stripe).
export async function adminSetPlan(env: Env, accountId: string, plan: string, extraGB: number, nowMs: number = Date.now()): Promise<Response> {
  if (!PLANS[plan]) return json({ error: "bad_plan", valid: Object.keys(PLANS) }, 400);
  const extra = Number.isFinite(extraGB) && extraGB >= 0 ? Math.floor(extraGB) * 1024 * 1024 * 1024 : 0;
  if (plan === "none") {
    // Paid→locked downgrade gets the same grace stamp as the webhook path (design 13
    // G7): same CASE predicate (only on a real paid→locked transition, never re-extend
    // an unexpired window) + clear extras. extraGB is ignored when downgrading.
    const r = await dbFor(env, accountId)
      .prepare("UPDATE accounts SET plan = 'none', extra_storage_bytes = 0, grace_until = CASE WHEN plan <> 'none' AND (grace_until IS NULL OR grace_until < ?) THEN ? ELSE grace_until END WHERE id = ?")
      .bind(nowMs, nowMs + GRACE_PERIOD_MS, accountId)
      .run();
    await audit(env, null, "account.set_plan", `${accountId}:none`, accountId);
    return json({ ok: true, accountId, plan: "none", changed: r.meta.changes });
  }
  const r = await dbFor(env, accountId).prepare("UPDATE accounts SET plan = ?, extra_storage_bytes = ? WHERE id = ?").bind(plan, extra, accountId).run();
  await audit(env, null, "account.set_plan", `${accountId}:${plan}`, accountId);
  return json({ ok: true, accountId, plan, changed: r.meta.changes });
}

/* Stripe (DEFERRED — needs STRIPE_SECRET + product/price IDs): checkout/portal/
 * webhook flip accounts.plan + extra_storage_bytes. Endpoints 501 until provisioned;
 * adminSetPlan is the interim control. */
