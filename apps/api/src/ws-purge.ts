import type { Env } from "./env.js";
import { chunked, purgeWorkspaceDO } from "./account-delete.js";
import { dbFor } from "./db.js";
import { json, logErr } from "./util.js";

export const WS_PURGE_ROW_CAP = 2000;
export const WS_PURGE_PAIR_BATCH = 100;
const IN_CHUNK = 80; // SQLite bound-variable safety for `... IN (?,?,…)` (same bound as account-delete.ts)

export interface WsPurgeCounts {
  commits: number;
  manifests: number;
  device_sync_state: number;
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

const zeroCounts = (): WsPurgeCounts => ({ commits: 0, manifests: 0, device_sync_state: 0, workspace_keys: 0, workspaces: 0 });
const allZero = (counts: WsPurgeCounts): boolean => Object.values(counts).every((n) => n === 0);

/** The five per-table counts, plus (optionally, in the SAME one-subrequest batch) the
 *  ORDER BY'd page of distinct (workspace, project) pairs the real purge processes. */
async function readWorkspaceState(db: D1Database, workspaceId: string, withPairs: boolean): Promise<{ counts: WsPurgeCounts; pairs: PairRow[] }> {
  const statements = [
    db.prepare("SELECT COUNT(*) AS n FROM commits WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM manifests WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM device_sync_state WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM workspace_keys WHERE workspace_id = ?").bind(workspaceId),
    db.prepare("SELECT COUNT(*) AS n FROM workspaces WHERE workspace_id = ?").bind(workspaceId),
  ];
  if (withPairs) {
    statements.push(
      db
        .prepare(`SELECT workspace_id, project_id FROM workspaces WHERE workspace_id = ?
          UNION SELECT workspace_id, project_id FROM commits WHERE workspace_id = ?
          UNION SELECT workspace_id, project_id FROM manifests WHERE workspace_id = ?
          UNION SELECT workspace_id, project_id FROM device_sync_state WHERE workspace_id = ?
          ORDER BY workspace_id, project_id
          LIMIT ?`)
        .bind(workspaceId, workspaceId, workspaceId, workspaceId, WS_PURGE_PAIR_BATCH),
    );
  }
  const results = await db.batch(statements);
  const count = (index: number): number => Number((results[index]?.results?.[0] as CountRow | undefined)?.n ?? 0);
  return {
    counts: { commits: count(0), manifests: count(1), device_sync_state: count(2), workspace_keys: count(3), workspaces: count(4) },
    pairs: withPairs ? ((results[5]?.results ?? []) as PairRow[]) : [],
  };
}

/**
 * Platform-only purge of one workspace's D1 mirrors and authoritative WorkspaceSync DOs.
 * R2 is deliberately untouched: every R2 object is a shared, content-addressed blob, with
 * no workspace prefix. Removing the workspace registry makes Phase-1 reachability stop
 * seeing its DO roots; the existing GC pipeline then reclaims refs and condemns truly
 * orphaned blobs for Phase 2 without risking another account's shared content.
 *
 * Each pass is page-scoped: a pair's D1 rows are deleted only after that exact pair's DO
 * purge succeeded in the same pass. Registry rows drop per pair, in the same transaction,
 * only when in-transaction NOT EXISTS checks prove its commits and manifests are gone.
 *
 * PRECONDITION: the target workspace is assumed QUIESCED (an operator purge of junk
 * workspaces). A concurrently-writing client can re-create rows/DO state mid-purge; the
 * drain loop deletes stragglers on later passes, but a write landing after the final recount
 * survives — rerun the drain. A write-fencing tombstone would need a migration plus every
 * workspace write path and is deliberately out of scope.
 *
 * §32: orphan mirror rows whose registry row is gone route via `dbFor(env, "")`
 * (plane-correct, account absent) — a no-op at N=1, and one of the documented sites a real
 * sharding cutover must revisit (see db.ts NOTE).
 */
export async function adminPurgeWorkspace(env: Env, workspaceId: string, opts: WsPurgeOpts = {}): Promise<Response> {
  // §32: discover the owning account before a shard is in scope, then route every
  // account-data-plane operation (all four workspace tables) to that account's shard.
  const owner = await dbFor(env, "")
    .prepare("SELECT account_id FROM workspaces WHERE workspace_id = ? LIMIT 1")
    .bind(workspaceId)
    .first<OwnerRow>();
  const db = dbFor(env, owner?.account_id ?? "");
  const { counts, pairs: page } = await readWorkspaceState(db, workspaceId, !opts.dryRun);
  if (allZero(counts)) return json({ error: "not_found" }, 404);
  if (opts.dryRun) return json({ ok: true, workspaceId, dryRun: true, counts, done: false });

  // Fan the (idempotent) DO purges out in parallel — they hit distinct DOs, so there is
  // no ordering to preserve; an exception is fail-closed like a false return (logged,
  // no row deleted this pass; the drain retries).
  const purgeWorkspace = opts.purgeWorkspace ?? purgeWorkspaceDO;
  const purgeResults = await Promise.all(
    page.map((pair) =>
      purgeWorkspace(env, pair.workspace_id, pair.project_id).catch((e: unknown) => (logErr("ws_purge_do_failed", e), false)),
    ),
  );
  if (!purgeResults.every((purged) => purged)) {
    return json({ ok: true, workspaceId, dryRun: false, deleted: zeroCounts(), remaining: counts, done: false });
  }

  const rowCap = Math.max(1, Math.floor(Number.isFinite(opts.rowCap ?? NaN) ? opts.rowCap! : WS_PURGE_ROW_CAP));
  const pairChunks = chunked(page, IN_CHUNK).map((ck) => {
    const projects = ck.map((pair) => pair.project_id);
    return { projects, ph: projects.map(() => "?").join(",") };
  });
  const statements: D1PreparedStatement[] = [];
  const kinds: (keyof WsPurgeCounts)[] = [];
  for (const { projects, ph } of pairChunks) {
    statements.push(
      db.prepare(`DELETE FROM commits WHERE rowid IN (SELECT rowid FROM commits WHERE workspace_id = ? AND project_id IN (${ph}) LIMIT ?)`).bind(workspaceId, ...projects, rowCap),
      db.prepare(`DELETE FROM manifests WHERE rowid IN (SELECT rowid FROM manifests WHERE workspace_id = ? AND project_id IN (${ph}) LIMIT ?)`).bind(workspaceId, ...projects, rowCap),
    );
    kinds.push("commits", "manifests");
  }
  for (const pair of page) {
    statements.push(db.prepare("DELETE FROM device_sync_state WHERE workspace_id = ? AND project_id = ?").bind(pair.workspace_id, pair.project_id));
    kinds.push("device_sync_state");
  }
  statements.push(db.prepare("DELETE FROM workspace_keys WHERE rowid IN (SELECT rowid FROM workspace_keys WHERE workspace_id = ? LIMIT ?)").bind(workspaceId, rowCap));
  kinds.push("workspace_keys");
  for (const { projects, ph } of pairChunks) {
    statements.push(db.prepare(`DELETE FROM workspaces WHERE workspace_id = ? AND project_id IN (${ph})
      AND NOT EXISTS (SELECT 1 FROM commits c WHERE c.workspace_id = workspaces.workspace_id AND c.project_id = workspaces.project_id)
      AND NOT EXISTS (SELECT 1 FROM manifests m WHERE m.workspace_id = workspaces.workspace_id AND m.project_id = workspaces.project_id)`).bind(workspaceId, ...projects));
    kinds.push("workspaces");
  }
  const deleted = zeroCounts();
  const deletedRows = await db.batch(statements);
  for (let i = 0; i < deletedRows.length; i++) deleted[kinds[i]!] += deletedRows[i]?.meta.changes ?? 0;

  const { counts: remaining } = await readWorkspaceState(db, workspaceId, false);
  return json({ ok: true, workspaceId, dryRun: false, deleted, remaining, done: allZero(remaining) });
}
