import { eq, type RouteCtx } from "./shared.js";
import { cappedJson, json, logErr } from "../util.js";
import { isPlatform } from "../authz.js";
import { retentionPrune } from "../retention.js";
import { phase1Audit, runPhase1 } from "../gc-phase1.js";
import { gcAudit } from "../gc-audit.js";
import { gcHealth } from "../gc-health.js";
import { gcMark } from "../gc-mark.js";
import { ADMIN_PURGE_DEADLINE_MS, gcPurge } from "../gc-purge.js";
import { gcStagingSweep } from "../staging-gc.js";
import { adminOverview, fetchDeltaSoak } from "../admin.js";
import { adminSetPlan } from "../billing.js";
import { multipartInventory } from "../multipart-inventory.js";
import { adminPurgeWorkspace } from "../ws-purge.js";
import { packGcMode, packTombstones, resweepPackTombstones } from "../blob-pack.js";
import { runPackGc } from "../pack-gc.js";
import { dbFor } from "../db.js";
import type { Env } from "../env.js";
import { genesisRepair, GENESIS_REPAIR_MAX_BYTES, validateGenesisRepairRequest } from "../genesis-repair.js";

interface InspectDroppedRow { sha: string; lastSeq: number }
interface InspectSeqRootRow { seq: number; manifestSha: string; carrierSha?: string }
interface InspectGapRow {
  seq: number;
  manifestSha: string;
  carrierSha?: string;
  inlineRefs?: string[];
  chainRefs?: string[];
  sidecar?: { sha: string; count: number; size: number };
}
interface InspectPage {
  droppedPage: InspectDroppedRow[];
  seqRootsPage: InspectSeqRootRow[];
  gapPage: InspectGapRow[];
  [key: string]: unknown;
}

const ROOTS_INSPECT_FORWARD_PARAMS = [
  "fromSha", "fromSeq", "fromGapSeq", "pinHead", "pinFloor", "pinGen", "limit",
] as const;

/**
 * Platform-only forwarding surface for the strictly read-only DO inspection path.
 * Workspace/project stay in QUERY parameters so a project id containing "/" cannot
 * be mistaken for route structure. Only the inspection cursor/pin vocabulary crosses
 * the Worker→DO boundary; in particular, the mutating `/roots?rebuild=1` control does not.
 *
 * Retention currently derives its cutoff from the best-effort D1 `commits.created_at`
 * mirror (`retention.ts`). Return the same timestamps as a sequence-keyed map alongside
 * the unchanged DO page. A missing mirror row is explicit unavailability, never silently
 * "not expired".
 */
export async function adminRootsInspect(env: Env, url: URL): Promise<Response> {
  const ws = url.searchParams.get("ws") ?? "";
  const proj = url.searchParams.get("proj") ?? "";
  if (!ws || !proj) return json({ error: "bad_request", message: "ws and proj are required" }, 400);

  const q = new URLSearchParams();
  for (const name of ROOTS_INSPECT_FORWARD_PARAMS) {
    const value = url.searchParams.get(name);
    if (value !== null) q.set(name, value);
  }
  const id = env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`);
  const inspectUrl = `https://do/roots-inspect${q.size ? `?${q}` : ""}`;
  const inspected = await env.WORKSPACE_SYNC.get(id).fetch(inspectUrl, { method: "GET" });
  if (!inspected.ok) return inspected;

  let page: InspectPage;
  try {
    page = await inspected.json() as InspectPage;
  } catch (e) {
    logErr("roots_inspect_response_failed", e);
    return json({ error: "index_unavailable", reason: "invalid_response" }, 503);
  }
  if (!Array.isArray(page.droppedPage) || !Array.isArray(page.seqRootsPage) || !Array.isArray(page.gapPage)) {
    return json({ error: "index_unavailable", reason: "invalid_response" }, 503);
  }

  const sequences = [...new Set([
    ...page.droppedPage.map((row) => Number(row.lastSeq)),
    ...page.seqRootsPage.map((row) => Number(row.seq)),
    ...page.gapPage.map((row) => Number(row.seq)),
  ])];
  if (sequences.some((seq) => !Number.isInteger(seq) || seq < 1)) {
    return json({ error: "index_unavailable", reason: "invalid_response" }, 503);
  }
  if (sequences.length === 0) return json({ ...page, createdAtBySequence: {} });

  try {
    // Account-data lookup by secondary key is an explicit N=1 fan-out seam, matching
    // the existing retention/global-GC callers until account sharding is introduced.
    const owner = await dbFor(env, "")
      .prepare("SELECT account_id FROM workspaces WHERE workspace_id = ? AND project_id = ?")
      .bind(ws, proj)
      .first<{ account_id: string }>();
    if (!owner?.account_id) {
      return json({
        ...page,
        createdAtBySequence: Object.fromEntries(sequences.map((sequence) => [String(sequence), null])),
      });
    }

    const times = new Map<number, number>();
    const rows = await dbFor(env, owner.account_id)
      .prepare(
        "SELECT sequence,created_at FROM commits WHERE workspace_id = ? AND project_id = ? " +
        "AND sequence IN (SELECT CAST(value AS INTEGER) FROM json_each(?))"
      )
      .bind(ws, proj, JSON.stringify(sequences))
      .all<{ sequence: number; created_at: number }>();
    for (const row of rows.results ?? []) {
      const sequence = Number(row.sequence);
      const createdAt = row.created_at == null ? Number.NaN : Number(row.created_at);
      if (Number.isInteger(sequence) && Number.isFinite(createdAt) && createdAt > 0) times.set(sequence, createdAt);
    }
    return json({
      ...page,
      createdAtBySequence: Object.fromEntries(sequences.map((sequence) => [String(sequence), times.get(sequence) ?? null])),
    });
  } catch (e) {
    logErr("roots_inspect_timestamp_failed", e);
    return json({
      ...page,
      createdAtBySequence: Object.fromEntries(sequences.map((sequence) => [String(sequence), null])),
    });
  }
}

/**
 * Platform-admin surfaces. `gc`, `workspace/:id`, `account/:id/plan`, and the read-only
 * `multipart-inventory` / `roots-inspect` require the PLATFORM secret (isPlatform); `overview` is
 * gated by a Cloudflare Access JWT + email allow-list INSIDE adminOverview
 * (defense in depth; NOT the rbox bearer) — so these routes sit BEFORE authenticate().
 */
export async function adminRoutes({ req, env, url, seg }: RouteCtx): Promise<Response | null> {
  if (req.method === "POST" && seg.length === 5 && seg[0] === "v1" && seg[1] === "admin" && seg[2] === "account" && seg[4] === "genesis-repair") {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    const parsed = await cappedJson(req, { maxBytes: GENESIS_REPAIR_MAX_BYTES }, validateGenesisRepairRequest);
    if (!parsed.ok) return parsed.response;
    return genesisRepair(env, seg[3]!, parsed.value);
  }
  if (req.method === "GET" && eq(seg, ["v1", "admin", "gc"]) && url.searchParams.get("phase") === "health") {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    return gcHealth(env);
  }
  if (req.method === "GET" && eq(seg, ["v1", "admin", "roots-inspect"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    return adminRootsInspect(env, url);
  }
  if (req.method === "GET" && eq(seg, ["v1", "admin", "delta-soak"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    if (!env.CF_ANALYTICS_TOKEN || !env.CF_ACCOUNT_ID) return json({ error: "analytics_unavailable" }, 503);
    const raw = Number(url.searchParams.get("sinceHours") ?? "72");
    const sinceHours = Number.isFinite(raw) ? Math.min(168, Math.max(1, Math.trunc(raw))) : 72;
    try {
      return json(await fetchDeltaSoak(env, sinceHours));
    } catch {
      return json({ error: "analytics_unavailable" }, 503);
    }
  }
  if (req.method === "GET" && eq(seg, ["v1", "admin", "multipart-inventory"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    return multipartInventory(env, Date.now());
  }
  if (req.method === "GET" && eq(seg, ["v1", "admin", "gc", "pack-tombstones"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    return json(await packTombstones(env));
  }
  if (req.method === "POST" && eq(seg, ["v1", "admin", "gc", "pack-tombstones", "resweep"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    if (packGcMode(env) !== "execute") return json({ error: "pack_gc_disabled" }, 409);
    return json(await resweepPackTombstones(env));
  }
  // Platform-only internal op (M7): GC requires the PLATFORM secret, NOT a tenant
  // device token. roots/prune are not exposed by the public router (GC calls the DO directly).
  if (req.method === "POST" && eq(seg, ["v1", "admin", "gc"])) {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    const phase = url.searchParams.get("phase");
    // Plan-driven retention: set per-workspace prune floors from each account's
    // tier; mark/purge then reclaim. Operational order: retention → mark → purge.
    if (phase === "retention") return retentionPrune(env);
    if (phase === "staging") return gcStagingSweep(env);
    if (phase === "packs") {
      if (packGcMode(env) === "off") return json({ error: "pack_gc_disabled" }, 409);
      return runPackGc(env, { deadlineMs: ADMIN_PURGE_DEADLINE_MS });
    }
    const graceMs = Number(url.searchParams.get("graceMs") ?? String(7 * 24 * 60 * 60 * 1000));
    // §33 Phase 1 (per-account entitlement prune; D1-only, cron-safe). Same handler that
    // runs on cron, exposed for on-demand runs/tests. Phase 2's same executor is also
    // exposed below as the kill-switch-immune supervised escape hatch.
    if (phase === "phase1" && url.searchParams.get("dryRun") === "1") {
      return phase1Audit(env, graceMs, url.searchParams.get("cursor"), Number(url.searchParams.get("limit") ?? "100"));
    }
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

  // DELETE /v1/admin/workspace/:id[?dryRun=1] — platform secret. Purges ONE workspace's
  // D1 rows + its WorkspaceSync DO log; blobs/R2 stay GC-owned; NEVER cascades to the account.
  if (req.method === "DELETE" && seg.length === 4 && seg[0] === "v1" && seg[1] === "admin" && seg[2] === "workspace") {
    if (!isPlatform(req, env)) return json({ error: "not_found" }, 404);
    return adminPurgeWorkspace(env, seg[3]!, { dryRun: url.searchParams.get("dryRun") === "1" });
  }

  return null;
}
