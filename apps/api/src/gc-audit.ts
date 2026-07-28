import type { Env } from "./env.js";
import { json } from "./util.js";
import { dbFor } from "./db.js";
import { reachableFromWorkspaces, workspaceSnapshot } from "./gc-roots.js";
import { GC_BUDGET_SAFE, GC_FIXED_COST, GC_PER_EXECUTE, GC_P1_COST, INTENT_QUIESCENCE_MS, PER_WORKSPACE_ROOTS_COST, gcExecuteLimit } from "./gc-policy.js";

interface Candidate {
  sha256: string;
  kind: "blob" | "manifest";
  marked_at: number;
  deleting_at: number | null;
}

/** Read-only, paginated operator audit. It never acquires a lease or writes a cursor/intent. */
export async function gcAudit(env: Env, graceMs: number, cursor: string | null, requestedLimit: number, nowMs: number = Date.now()): Promise<Response> {
  const maxW = Math.floor((GC_BUDGET_SAFE - GC_FIXED_COST - GC_PER_EXECUTE - GC_P1_COST - 1) / PER_WORKSPACE_ROOTS_COST);
  const workspaces = await workspaceSnapshot(env, maxW);
  if (!workspaces) return json({ wouldIntent: 0, wouldDelete: 0, budgetExceeded: true, cursor: null });
  const pageMax = gcExecuteLimit(workspaces.length);
  if (pageMax === 0) return json({ wouldIntent: 0, wouldDelete: 0, examined: 0, cursor: null, limit: 0 });
  const limit = Math.max(1, Math.min(pageMax, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100));
  const reachable = await reachableFromWorkspaces(env, workspaces);
  const rows = await dbFor(env, "")
    .prepare("SELECT sha256, kind, marked_at, deleting_at FROM gc_candidates WHERE sha256 > ? ORDER BY sha256 LIMIT ?")
    .bind(cursor ?? "", limit + 1)
    .all<Candidate>();
  const page = (rows.results ?? []).slice(0, limit);
  const shas = page.map((c) => c.sha256);
  const refRows = shas.length
    ? await dbFor(env, "")
        .prepare("SELECT DISTINCT sha256 FROM blob_refs WHERE sha256 IN (SELECT value FROM json_each(?))")
        .bind(JSON.stringify(shas))
        .all<{ sha256: string }>()
    : { results: [] as Array<{ sha256: string }> };
  const referenced = new Set((refRows.results ?? []).map((r) => r.sha256));
  let wouldIntent = 0;
  let wouldDelete = 0;
  for (const c of page) {
    if (reachable.has(c.sha256)) continue;
    if (referenced.has(c.sha256)) continue;
    if (c.deleting_at == null && Number(c.marked_at) < nowMs - graceMs) wouldIntent++;
    if (c.deleting_at != null && Number(c.deleting_at) < nowMs - INTENT_QUIESCENCE_MS) wouldDelete++;
  }
  const hasMore = (rows.results?.length ?? 0) > limit;
  return json({ wouldIntent, wouldDelete, examined: page.length, cursor: hasMore ? page.at(-1)?.sha256 ?? null : null, limit });
}
