import { PACK_ORPHAN_GRACE_MS, packKey } from "./blob-pack.js";
import { dbFor } from "./db.js";
import type { Env } from "./env.js";
import { emit, startOp, type OpSpan } from "./metrics.js";
import { CLOCK_SKEW_MS, RECEIPT_TTL_MS } from "./receipts.js";
import { json } from "./util.js";
import {
  acquireLease,
  leaseGuard,
  releaseLeaseWithRetry,
  renewLease,
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

async function readCursor<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT v FROM gc_state WHERE k=?").bind(key).first<{ v: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}

async function writeCursor(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO gc_state(k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v")
    .bind(key, JSON.stringify(value))
    .run();
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
  const prior = await readCursor<MarkCursor>(db, MARK_CURSOR_KEY);
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
  if (last) await writeCursor(db, MARK_CURSOR_KEY, { createdAt: Number(last.created_at), packId: last.pack_id } satisfies MarkCursor);
  return marked;
}

async function openIntentPage(
  db: D1Database,
  lease: PurgeLease,
  nowMs: number,
  clock: () => number,
): Promise<number> {
  const prior = await readCursor<IntentCursor>(db, INTENT_CURSOR_KEY);
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
  if (last) await writeCursor(db, INTENT_CURSOR_KEY, { markedAt: Number(last.marked_at), packId: last.pack_id } satisfies IntentCursor);
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
  const prior = await readCursor<ExecuteCursor>(db, EXECUTE_CURSOR_KEY);
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
        .prepare(
          `SELECT 1 FROM gc_state
           WHERE k='${PACK_PURGE_LEASE_KEY}' AND json_extract(v,'$.owner')=?
             AND CAST(json_extract(v,'$.expires') AS INTEGER)>=?`,
        )
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
    await writeCursor(db, EXECUTE_CURSOR_KEY, {
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
  const db = dbFor(op.env, "");
  const clock = options.clock ?? Date.now;
  const nowMs = options.nowMs ?? Date.now();
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
    if (clock() < deadlineAt) counts.opened = await openIntentPage(db, lease, nowMs, clock);
    if (clock() < deadlineAt) counts.deleted = await executePage(op.env, op.span, db, lease, deadlineAt, clock);

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
