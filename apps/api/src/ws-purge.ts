import type { Env } from "./env.js";
import { purgeWorkspaceDO } from "./account-delete.js";
import { dbFor } from "./db.js";
import { json } from "./util.js";

export const WS_PURGE_ROW_CAP = 2000;
export const WS_PURGE_PAIR_BATCH = 100;

export interface WsPurgeCounts {
  commits: number;
  manifests: number;
  workspace_keys: number;
  workspaces: number;
}

export interface WsPurgeOpts {
  dryRun?: boolean;
  /** Injected for tests because the DO's storage is not drivable in every test runtime;
   * defaults to purgeWorkspaceDO from account-delete.ts. */
  purgeWorkspace?: (env: Env, ws: string, proj: string) => Promise<boolean>;
  /** Test override of WS_PURGE_ROW_CAP. */
  rowCap?: number;
}

interface OwnerRow { account_id: string | null }
interface PairRow { workspace_id: string; project_id: string }
interface CountRow { n: number }

const zeroCounts = (): WsPurgeCounts => ({ commits: 0, manifests: 0, workspace_keys: 0, workspaces: 0 });
const allZero = (counts: WsPurgeCounts): boolean => Object.values(counts).every((n) => n === 0);

async function countWorkspaceRows(db: D1Database, workspaceId: string): Promise<WsPurgeCounts> {
  const results = await db.batch([
    db.prepare("SELECT COUNT(*) AS n FROM commits WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM manifests WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM workspace_keys WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE workspace_id = ?").bind(workspaceId),
  ]);
  const count = (index: number): number => Number((results[index]?.results?.[0] as CountRow | undefined)?.n ?? 0);
  return { commits: count(0), manifests: count(1), workspace_keys: count(2), workspaces: count(3) };
}

/**
 * Platform-only purge of one workspace's D1 mirrors and authoritative WorkspaceSync DOs.
 * R2 is deliberately untouched: every R2 object is a shared, content-addressed blob, with
 * no workspace prefix. Removing the workspace registry makes Phase-1 reachability stop
 * seeing its DO roots; the existing GC pipeline then reclaims refs and condemns truly
 * orphaned blobs for Phase 2 without risking another account's shared content.
 */
export async function adminPurgeWorkspace(env: Env, workspaceId: string, opts: WsPurgeOpts = {}): Promise<Response> {
  // §32: discover the owning account before a shard is in scope, then route every
  // account-data-plane operation (all four workspace tables) to that account's shard.
  const owner = await dbFor(env, "")
    .prepare("SELECT account_id FROM workspaces WHERE workspace_id = ? LIMIT 1")
    .bind(workspaceId)
    .first<OwnerRow>();
  const db = dbFor(env, owner?.account_id ?? "");
  const counts = await countWorkspaceRows(db, workspaceId);
  if (allZero(counts)) return json({ error: "not_found" }, 404);
  if (opts.dryRun) return json({ ok: true, workspaceId, dryRun: true, counts, done: false });

  const pairs = await db
    .prepare(`SELECT workspace_id, project_id FROM workspaces WHERE workspace_id = ?
      UNION SELECT workspace_id, project_id FROM commits WHERE workspace_id = ?
      UNION SELECT workspace_id, project_id FROM manifests WHERE workspace_id = ?
      LIMIT ?`)
    .bind(workspaceId, workspaceId, workspaceId, WS_PURGE_PAIR_BATCH)
    .all<PairRow>();
  const purgeWorkspace = opts.purgeWorkspace ?? purgeWorkspaceDO;
  for (const pair of pairs.results ?? []) {
    if (!(await purgeWorkspace(env, pair.workspace_id, pair.project_id))) {
      return json({ ok: true, workspaceId, dryRun: false, deleted: zeroCounts(), remaining: counts, done: false });
    }
  }

  const rowCap = opts.rowCap ?? WS_PURGE_ROW_CAP;
  // gc-phase1's 33-row batches exist because multi-row INSERTs carry <=100 bound params.
  // Each bounded DELETE below uses only two binds, so one statement/table is optimal for
  // the subrequest budget. D1's ~1k subrequest cap (which bit us in design 102) stays far
  // away: this handler uses <= ~10 D1 subrequests plus <=100 DO fetches per call. The
  // delete is its own cursor; no durable cursor row is needed because the drain calls again.
  const deletedRows = await db.batch([
    db.prepare("DELETE FROM commits WHERE rowid IN (SELECT rowid FROM commits WHERE workspace_id = ? LIMIT ?)").bind(workspaceId, rowCap),
    db.prepare("DELETE FROM manifests WHERE rowid IN (SELECT rowid FROM manifests WHERE workspace_id = ? LIMIT ?)").bind(workspaceId, rowCap),
    db.prepare("DELETE FROM workspace_keys WHERE rowid IN (SELECT rowid FROM workspace_keys WHERE workspace_id = ? LIMIT ?)").bind(workspaceId, rowCap),
  ]);
  const deleted: WsPurgeCounts = {
    commits: deletedRows[0]?.meta.changes ?? 0,
    manifests: deletedRows[1]?.meta.changes ?? 0,
    workspace_keys: deletedRows[2]?.meta.changes ?? 0,
    workspaces: 0,
  };

  // Registry rows go last so account routing and DO enumeration remain available throughout
  // a multi-pass purge. A short delete proves each preceding table is fully drained.
  if (deleted.commits < rowCap && deleted.manifests < rowCap && deleted.workspace_keys < rowCap) {
    const registry = await db.prepare("DELETE FROM workspaces WHERE workspace_id = ?").bind(workspaceId).run();
    deleted.workspaces = registry.meta.changes ?? 0;
  }

  const remaining = await countWorkspaceRows(db, workspaceId);
  return json({ ok: true, workspaceId, dryRun: false, deleted, remaining, done: allZero(remaining) });
}
