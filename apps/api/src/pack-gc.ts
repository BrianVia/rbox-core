import { PACK_ORPHAN_GRACE_MS, packGcMode, type PackGcMode } from "./blob-pack.js";
import { packKey } from "./util.js";
import { dbFor } from "./db.js";
import type { Env } from "./env.js";
import { emit, startOp, type OpSpan } from "./metrics.js";
import { CLOCK_SKEW_MS, RECEIPT_TTL_MS } from "./receipts.js";
import { json } from "./util.js";
import {
  acquireLease,
  leaseGuard,
  readState,
  releaseLeaseWithRetry,
  renewLease,
  writeState,
  type PurgeLease,
} from "./versions.js";

export const PACK_INTENT_QUIESCENCE_MS = 24 * 3600_000;
export const PACK_GC_CLOCK_STALENESS_MS = 3600_000;
export const PACK_GC_PAGE_SIZE = 50;
export const PACK_PURGE_LEASE_KEY = "pack_purge_lease";

if (PACK_INTENT_QUIESCENCE_MS < RECEIPT_TTL_MS + CLOCK_SKEW_MS) {
  throw new Error("pack intent quiescence must cover receipt lifetime and clock skew");
}

const DEFAULT_DEADLINE_MS = 15 * 60_000;
const MARK_CURSOR_KEY = "pack_mark_cursor";
const INTENT_CURSOR_KEY = "pack_intent_cursor";
const EXECUTE_CURSOR_KEY = "pack_execute_cursor";

interface MarkCursor {
  createdAt: number;
  packId: string;
}

interface IntentCursor {
  markedAt: number;
  packId: string;
}

interface ExecuteCursor {
  deletingAt: number;
  packId: string;
}

interface Candidate {
  pack_id: string;
  epoch: string;
  marked_at: number;
  deleting_at: number | null;
}

export interface PackGcOptions {
  nowMs?: number;
  clock?: () => number;
  owner?: string;
  deadlineMs?: number;
}

interface PackGcCounts {
  marked: number;
  opened: number;
  deleted: number;
  unwound: number;
}

interface ShadowPackGcCounts {
  wouldResurrect: number;
  wouldMark: number;
  wouldOpen: number;
  wouldDelete: number;
}

interface ShadowCandidate extends Candidate {
  located: number;
}

async function shadowCounts(db: D1Database, nowMs: number): Promise<ShadowPackGcCounts> {
  const orphanCutoff = nowMs - PACK_ORPHAN_GRACE_MS;
  const executeCutoff = nowMs - PACK_INTENT_QUIESCENCE_MS;
  const [markCursor, intentCursor, executeCursor] = await Promise.all([
    readState<MarkCursor>(db, MARK_CURSOR_KEY),
    readState<IntentCursor>(db, INTENT_CURSOR_KEY),
    readState<ExecuteCursor>(db, EXECUTE_CURSOR_KEY),
  ]);
  const pageWithFallback = async <T>(cursor: unknown, query: (withCursor: boolean) => Promise<D1Result<T>>): Promise<D1Result<T>> => {
    let page = await query(cursor !== null);
    if (!page.results.length && cursor !== null) page = await query(false);
    return page;
  };
  const resurrect = await db.prepare(
      `SELECT c.pack_id FROM pack_gc_candidates c
       JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
       WHERE c.deleting_at IS NULL
         AND EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=c.pack_id)
       ORDER BY c.pack_id LIMIT ?`,
    ).bind(PACK_GC_PAGE_SIZE).all<{ pack_id: string }>();
  const resurrectedIds = resurrect.results.map((row) => row.pack_id);
  const markPage = await pageWithFallback<{ pack_id: string; located: number; candidate: number }>(markCursor, async (withCursor) => {
    const cursorSql = withCursor ? "AND (p.created_at > ? OR (p.created_at = ? AND p.pack_id > ?))" : "";
    const binds = withCursor
      ? [orphanCutoff, markCursor!.createdAt, markCursor!.createdAt, markCursor!.packId, PACK_GC_PAGE_SIZE]
      : [orphanCutoff, PACK_GC_PAGE_SIZE];
    return db.prepare(
      `SELECT p.pack_id,
              EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=p.pack_id) AS located,
              EXISTS (SELECT 1 FROM pack_gc_candidates c WHERE c.pack_id=p.pack_id) AS candidate
       FROM packs p WHERE p.state='ready' AND p.created_at < ? ${cursorSql}
       ORDER BY p.created_at,p.pack_id LIMIT ?`,
    ).bind(...binds).all<{ pack_id: string; located: number; candidate: number }>();
  });
  const openPage = await pageWithFallback<ShadowCandidate>(intentCursor, async (withCursor) => {
    const cursorSql = withCursor ? "AND (c.marked_at > ? OR (c.marked_at = ? AND c.pack_id > ?))" : "";
    const resurrectSql = resurrectedIds.length ? "AND c.pack_id NOT IN (SELECT value FROM json_each(?))" : "";
    const binds = withCursor
      ? [nowMs, intentCursor!.markedAt, intentCursor!.markedAt, intentCursor!.packId, ...(resurrectedIds.length ? [JSON.stringify(resurrectedIds)] : []), PACK_GC_PAGE_SIZE]
      : [nowMs, ...(resurrectedIds.length ? [JSON.stringify(resurrectedIds)] : []), PACK_GC_PAGE_SIZE];
    return db.prepare(
      `SELECT c.pack_id,c.epoch,c.marked_at,c.deleting_at,
              EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=c.pack_id) AS located
       FROM pack_gc_candidates c
       JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
       WHERE c.deleting_at IS NULL AND c.marked_at < ?
         ${cursorSql}
         ${resurrectSql}
       ORDER BY c.marked_at,c.pack_id LIMIT ?`,
    ).bind(...binds).all<ShadowCandidate>();
  });
  const executePage = await pageWithFallback<ShadowCandidate>(executeCursor, async (withCursor) => {
    const cursorSql = withCursor ? "AND (c.deleting_at > ? OR (c.deleting_at = ? AND c.pack_id > ?))" : "";
    const binds = withCursor
      ? [executeCutoff, executeCursor!.deletingAt, executeCursor!.deletingAt, executeCursor!.packId, PACK_GC_PAGE_SIZE]
      : [executeCutoff, PACK_GC_PAGE_SIZE];
    return db.prepare(
      `SELECT c.pack_id,c.epoch,c.marked_at,c.deleting_at,
              EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=c.pack_id) AS located
       FROM pack_gc_candidates c
       JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
       WHERE c.deleting_at IS NOT NULL AND c.deleting_at < ?
         ${cursorSql}
       ORDER BY c.deleting_at,c.pack_id LIMIT ?`,
    ).bind(...binds).all<ShadowCandidate>();
  });
  return {
    wouldResurrect: resurrect.results.length,
    wouldMark: markPage.results.filter((row) => Number(row.located) === 0 && Number(row.candidate) === 0).length,
    wouldOpen: openPage.results.filter((row) => Number(row.located) === 0).length,
    wouldDelete: executePage.results.filter((row) => Number(row.located) === 0).length,
  };
}

async function resurrectPage(db: D1Database, lease: PurgeLease, clock: () => number): Promise<number> {
  const selected = await db
    .prepare(
      `SELECT c.pack_id, c.epoch, c.marked_at, c.deleting_at
       FROM pack_gc_candidates c
       JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
       WHERE c.deleting_at IS NULL
         AND EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=c.pack_id)
       ORDER BY c.pack_id LIMIT ?`,
    )
    .bind(PACK_GC_PAGE_SIZE)
    .all<Candidate>();
  if (!selected.results.length) return 0;
  const statements = selected.results.map((candidate) =>
    db
      .prepare(
        `DELETE FROM pack_gc_candidates
         WHERE pack_id=? AND epoch=? AND deleting_at IS NULL
           AND EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=pack_gc_candidates.pack_id)
           AND EXISTS (SELECT 1 FROM packs p WHERE p.pack_id=pack_gc_candidates.pack_id AND p.state='ready')
           AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
      )
      .bind(candidate.pack_id, candidate.epoch, lease.owner, clock()),
  );
  const results = await db.batch(statements);
  return results.reduce((count, result) => count + Number(result.meta.changes ?? 0), 0);
}

async function markPage(db: D1Database, lease: PurgeLease, nowMs: number, clock: () => number): Promise<number> {
  const cutoff = nowMs - PACK_ORPHAN_GRACE_MS;
  const prior = await readState<MarkCursor>(db, MARK_CURSOR_KEY);
  const page = async (cursor: MarkCursor | null) => {
    const cursorSql = cursor ? "AND (created_at > ? OR (created_at = ? AND pack_id > ?))" : "";
    const binds = cursor
      ? [cutoff, cursor.createdAt, cursor.createdAt, cursor.packId, PACK_GC_PAGE_SIZE]
      : [cutoff, PACK_GC_PAGE_SIZE];
    return db
      .prepare(
        `SELECT pack_id, created_at FROM packs
         WHERE state='ready' AND created_at < ? ${cursorSql}
         ORDER BY created_at, pack_id LIMIT ?`,
      )
      .bind(...binds)
      .all<{ pack_id: string; created_at: number }>();
  };
  let selected = await page(prior);
  if (!selected.results.length && prior) selected = await page(null);
  let marked = 0;
  for (const pack of selected.results) {
    const epoch = crypto.randomUUID().replace(/-/g, "");
    const result = await db
      .prepare(
        `INSERT OR IGNORE INTO pack_gc_candidates(pack_id,epoch,marked_at)
         SELECT ?,?,?
         WHERE NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=?)
           AND EXISTS (SELECT 1 FROM packs p WHERE p.pack_id=? AND p.state='ready')
           AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
      )
      .bind(pack.pack_id, epoch, nowMs, pack.pack_id, pack.pack_id, lease.owner, clock())
      .run();
    marked += Number(result.meta.changes ?? 0);
  }
  const last = selected.results.at(-1);
  if (last) await writeState(db, MARK_CURSOR_KEY, { createdAt: Number(last.created_at), packId: last.pack_id } satisfies MarkCursor);
  return marked;
}

async function openIntentPage(
  db: D1Database,
  lease: PurgeLease,
  nowMs: number,
  clock: () => number,
): Promise<number> {
  const prior = await readState<IntentCursor>(db, INTENT_CURSOR_KEY);
  const page = async (cursor: IntentCursor | null) => {
    const cursorSql = cursor ? "AND (c.marked_at > ? OR (c.marked_at = ? AND c.pack_id > ?))" : "";
    const binds = cursor
      ? [nowMs, cursor.markedAt, cursor.markedAt, cursor.packId, PACK_GC_PAGE_SIZE]
      : [nowMs, PACK_GC_PAGE_SIZE];
    return db
      .prepare(
        `SELECT c.pack_id, c.epoch, c.marked_at, c.deleting_at
         FROM pack_gc_candidates c
         JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
         WHERE c.deleting_at IS NULL AND c.marked_at < ? ${cursorSql}
         ORDER BY c.marked_at, c.pack_id LIMIT ?`,
      )
      .bind(...binds)
      .all<Candidate>();
  };
  let selected = await page(prior);
  if (!selected.results.length && prior) selected = await page(null);

  let opened = 0;
  let last: Candidate | undefined;
  for (const candidate of selected.results) {
    // This proof-bearing stamp is deliberately read after the SELECT observed the
    // candidacy epoch. Never replace it with runPackGc's invocation-start nowMs.
    const liveNow = clock();
    if (liveNow - nowMs > PACK_GC_CLOCK_STALENESS_MS) break;
    last = candidate;
    const result = await db
      .prepare(
        `UPDATE pack_gc_candidates SET deleting_at=?
         WHERE pack_id=? AND epoch=? AND deleting_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=pack_gc_candidates.pack_id)
           AND EXISTS (SELECT 1 FROM packs p WHERE p.pack_id=pack_gc_candidates.pack_id AND p.state='ready')
           AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
      )
      .bind(liveNow, candidate.pack_id, candidate.epoch, lease.owner, liveNow)
      .run();
    opened += Number(result.meta.changes ?? 0);
  }
  if (last) await writeState(db, INTENT_CURSOR_KEY, { markedAt: Number(last.marked_at), packId: last.pack_id } satisfies IntentCursor);
  return opened;
}

async function executePage(
  env: Env,
  span: OpSpan,
  db: D1Database,
  lease: PurgeLease,
  deadlineAt: number,
  clock: () => number,
): Promise<number> {
  const executeNow = clock();
  const cutoff = executeNow - PACK_INTENT_QUIESCENCE_MS;
  const prior = await readState<ExecuteCursor>(db, EXECUTE_CURSOR_KEY);
  const page = async (cursor: ExecuteCursor | null) => {
    const cursorSql = cursor ? "AND (c.deleting_at > ? OR (c.deleting_at = ? AND c.pack_id > ?))" : "";
    const binds = cursor
      ? [cutoff, cursor.deletingAt, cursor.deletingAt, cursor.packId, PACK_GC_PAGE_SIZE]
      : [cutoff, PACK_GC_PAGE_SIZE];
    return db
      .prepare(
        `SELECT c.pack_id, c.epoch, c.marked_at, c.deleting_at
         FROM pack_gc_candidates c
         JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
         WHERE c.deleting_at IS NOT NULL AND c.deleting_at < ? ${cursorSql}
         ORDER BY c.deleting_at, c.pack_id LIMIT ?`,
      )
      .bind(...binds)
      .all<Candidate>();
  };
  let selected = await page(prior);
  if (!selected.results.length && prior) selected = await page(null);

  let deleted = 0;
  let last: Candidate | undefined;
  for (const candidate of selected.results) {
    if (clock() >= deadlineAt) break;
    last = candidate;
    const ready = await db
      .prepare(
        `SELECT 1 FROM pack_gc_candidates c
         JOIN packs p ON p.pack_id=c.pack_id AND p.state='ready'
         WHERE c.pack_id=? AND c.epoch=? AND c.deleting_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=c.pack_id)
           AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
      )
      .bind(candidate.pack_id, candidate.epoch, lease.owner, clock())
      .first();
    if (!ready) {
      const liveLease = await db
        .prepare(`SELECT 1 WHERE ${leaseGuard(PACK_PURGE_LEASE_KEY)}`)
        .bind(lease.owner, clock())
        .first();
      if (!liveLease) break;
      continue;
    }

    // No await between this final live check and dispatch. Invocation deadlines
    // and lease expiry can only stop a delete; they never retire the fence.
    const dispatchNow = clock();
    if (dispatchNow >= deadlineAt || dispatchNow > lease.expires) break;
    try {
      await span.r2(() => env.rbox_dev_blobs.delete(packKey(candidate.pack_id)));
      if (await span.r2(() => env.rbox_dev_blobs.head(packKey(candidate.pack_id)))) continue;
    } catch {
      continue;
    }

    const terminalNow = clock();
    const terminal = await db.batch([
      db
        .prepare(
          `DELETE FROM pack_members
           WHERE pack_id=?
             AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=pack_members.pack_id)
             AND EXISTS (SELECT 1 FROM pack_gc_candidates c WHERE c.pack_id=? AND c.epoch=? AND c.deleting_at IS NOT NULL)
             AND EXISTS (SELECT 1 FROM packs p WHERE p.pack_id=pack_members.pack_id AND p.state='ready')
             AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
        )
        .bind(candidate.pack_id, candidate.pack_id, candidate.epoch, lease.owner, terminalNow),
      db
        .prepare(
          `UPDATE packs SET state='swept'
           WHERE pack_id=? AND state='ready'
             AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=packs.pack_id)
             AND EXISTS (SELECT 1 FROM pack_gc_candidates c WHERE c.pack_id=? AND c.epoch=? AND c.deleting_at IS NOT NULL)
             AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
        )
        .bind(candidate.pack_id, candidate.pack_id, candidate.epoch, lease.owner, terminalNow),
      db
        .prepare(
          `DELETE FROM pack_gc_candidates
           WHERE pack_id=? AND epoch=? AND deleting_at IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=?)
             AND EXISTS (SELECT 1 FROM packs p WHERE p.pack_id=pack_gc_candidates.pack_id AND p.state='swept')
             AND ${leaseGuard(PACK_PURGE_LEASE_KEY)}`,
        )
        .bind(candidate.pack_id, candidate.epoch, candidate.pack_id, lease.owner, terminalNow),
    ]);
    if (Number(terminal[1]?.meta.changes ?? 0) === 1) deleted++;
  }
  if (last) {
    await writeState(db, EXECUTE_CURSOR_KEY, {
      deletingAt: Number(last.deleting_at),
      packId: last.pack_id,
    } satisfies ExecuteCursor);
  }
  return deleted;
}

async function emitInventoryMetrics(env: Env, db: D1Database): Promise<void> {
  const [pinned, tombstones] = await db.batch([
    db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(p.size_bytes),0) AS bytes
       FROM packs p WHERE p.state='ready'
         AND EXISTS (SELECT 1 FROM blob_locations l WHERE l.pack_id=p.pack_id)`,
    ),
    db.prepare("SELECT COUNT(*) AS count FROM packs WHERE state='swept'"),
  ]);
  const pinnedRow = pinned?.results?.[0] as { count?: number; bytes?: number } | undefined;
  const tombstoneRow = tombstones?.results?.[0] as { count?: number } | undefined;
  emit(env, { op: "gc.pack.pinned", outcome: "ok", count: Number(pinnedRow?.count ?? 0), bytes: Number(pinnedRow?.bytes ?? 0) });
  emit(env, { op: "gc.pack.tombstones", outcome: "ok", count: Number(tombstoneRow?.count ?? 0) });
}

/** Ready-pack physical GC: resurrect, mark, open, then execute under its own lease. */
export async function runPackGc(env: Env, options: PackGcOptions = {}): Promise<Response> {
  const op = startOp(env, "gc.pack");
  const mode: PackGcMode = packGcMode(env);
  if (mode === "off") {
    op.done("disabled");
    return json({ error: "pack_gc_disabled" }, 409);
  }
  const db = dbFor(op.env, "");
  const nowMs = options.nowMs ?? Date.now();
  if (mode === "shadow") {
    try {
      const would = await shadowCounts(db, nowMs);
      op.done("shadow", { count: would.wouldDelete });
      return json(would);
    } catch {
      op.done("error");
      return json({ error: "pack_gc_failed" }, 500);
    }
  }

  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineAt = startedAt + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const acquired = await acquireLease(db, startedAt, options.owner, PACK_PURGE_LEASE_KEY);
  const lease = acquired.lease;
  if (!lease) {
    op.done("lease_busy");
    return json({ marked: 0, opened: 0, deleted: 0, unwound: 0, leaseBusy: true, retryAfterMs: acquired.retryAfterMs }, 409);
  }

  const counts: PackGcCounts = { marked: 0, opened: 0, deleted: 0, unwound: 0 };
  try {
    if (!(await renewLease(db, lease, clock(), PACK_PURGE_LEASE_KEY))) {
      op.done("lease_lost");
      return json({ ...counts, leaseLost: true }, 409);
    }
    counts.unwound = await resurrectPage(db, lease, clock);
    if (clock() < deadlineAt) counts.marked = await markPage(db, lease, nowMs, clock);
    if (mode === "execute" && clock() < deadlineAt) counts.opened = await openIntentPage(db, lease, nowMs, clock);
    if (mode === "execute" && clock() < deadlineAt) counts.deleted = await executePage(op.env, op.span, db, lease, deadlineAt, clock);

    emit(env, { op: "gc.pack.marked", outcome: "ok", count: counts.marked });
    emit(env, { op: "gc.pack.opened", outcome: "ok", count: counts.opened });
    emit(env, { op: "gc.pack.deleted", outcome: "ok", count: counts.deleted });
    emit(env, { op: "gc.pack.unwound", outcome: "ok", count: counts.unwound });
    await emitInventoryMetrics(env, db);
    op.done("ok", { count: counts.deleted });
    return json(counts);
  } catch {
    op.done("error", { count: counts.deleted });
    return json({ error: "pack_gc_failed" }, 500);
  } finally {
    await releaseLeaseWithRetry(db, lease.owner, PACK_PURGE_LEASE_KEY);
  }
}
