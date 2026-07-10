import { eq, type RouteCtx } from "./shared.js";
import { json } from "../util.js";
import { isPlatform } from "../authz.js";
import { retentionPrune } from "../retention.js";
import { runPhase1 } from "../gc-phase1.js";
import { ADMIN_PURGE_DEADLINE_MS, gcAudit, gcMark, gcPurge } from "../versions.js";
import { adminOverview } from "../admin.js";
import { adminSetPlan } from "../billing.js";

/**
 * Platform-admin surfaces. `gc` and `account/:id/plan` require the PLATFORM secret
 * (isPlatform); `overview` is gated by a Cloudflare Access JWT + email allow-list
 * INSIDE adminOverview (defense in depth; NOT the rbox bearer) — so all three sit
 * BEFORE authenticate().
 */
export async function adminRoutes({ req, env, url, seg }: RouteCtx): Promise<Response | null> {
  // Platform-only internal op (M7): GC requires the PLATFORM secret, NOT a tenant
  // device token. roots/prune are not exposed by the public router (GC calls the DO directly).
  if (req.method === "POST" && eq(seg, ["v1", "admin", "gc"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    const phase = url.searchParams.get("phase");
    // Plan-driven retention: set per-workspace prune floors from each account's
    // tier; mark/purge then reclaim. Operational order: retention → mark → purge.
    if (phase === "retention") return retentionPrune(env);
    const graceMs = Number(url.searchParams.get("graceMs") ?? String(7 * 24 * 60 * 60 * 1000));
    // §33 Phase 1 (per-account entitlement prune; D1-only, cron-safe). Same handler that
    // runs on cron, exposed for on-demand runs/tests. Phase 2's same executor is also
    // exposed below as the kill-switch-immune supervised escape hatch.
    if (phase === "phase1") return runPhase1(env, graceMs);
    if (phase === "purge" && url.searchParams.get("dryRun") === "1") {
      return gcAudit(env, graceMs, url.searchParams.get("cursor"), Number(url.searchParams.get("limit") ?? "100"));
    }
    // The manual escape hatch ignores the cron kill switch, but self-caps delete
    // dispatch at 60s so lease takeover's 30-minute quiescence remains decisive.
    return phase === "purge" ? gcPurge(env, graceMs, { deadlineMs: ADMIN_PURGE_DEADLINE_MS }) : gcMark(env, graceMs);
  }
  // GET /v1/admin/overview — platform-admin cockpit (§32 Tier 3a). Gated by a
  // Cloudflare Access JWT + an email allow-list INSIDE adminOverview (defense in
  // depth; NOT the rbox bearer), so it sits before authenticate(). This is the only
  // route with privileged cross-account read access.
  if (req.method === "GET" && eq(seg, ["v1", "admin", "overview"])) return adminOverview(req, env, Date.now());

  // POST /v1/admin/account/:id/plan?plan=pro&extraGB=N (platform secret; interim until Stripe).
  if (req.method === "POST" && seg.length === 5 && seg[0] === "v1" && seg[1] === "admin" && seg[2] === "account" && seg[4] === "plan") {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    return adminSetPlan(env, seg[3]!, url.searchParams.get("plan") ?? "none", Number(url.searchParams.get("extraGB") ?? "0"));
  }

  return null;
}
