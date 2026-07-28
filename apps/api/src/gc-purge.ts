import type { Env } from "./env.js";
import { blobKey, errClass, json, manifestKey } from "./util.js";
import { dbFor } from "./db.js";
import { startOp } from "./metrics.js";
import { GcRootsCapExceeded, MAX_UNIQUE_ROOTS, reachableFromWorkspaces, workspaceSnapshot, exactWorkspaceCount } from "./gc-roots.js";
import { GC_BUDGET_SAFE, GC_FIXED_COST, GC_PER_EXECUTE, GC_P1_COST, GC_P1_MAX_ROWS, INTENT_QUIESCENCE_MS, PER_WORKSPACE_ROOTS_COST, gcExecuteLimit } from "./gc-policy.js";
import { acquireLease, leaseGuard, readState, releaseLeaseWithRetry, renewLease, writeState, type PurgeLease } from "./gc-state.js";
import { metric, terminalObservation, writeGcObservation, type GcObservationStage, type GcObservationV1, type GcRootsSampleV1 } from "./gc-observability.js";

export const STALE_INTENT_MS = 72 * 60 * 60 * 1000;
export const ADMIN_PURGE_DEADLINE_MS = 60 * 1000;

interface GcCursor {
  markedAt: number;
  sha256: string;
}
interface ExecuteCursor {
  deletingAt: number;
  sha256: string;
}
interface Candidate {
  sha256: string;
  kind: "blob" | "manifest";
  marked_at: number;
  deleting_at: number | null;
}

/** Remove candidacy only while this executor still owns the lease. */
async function unwindCandidate(db: D1Database, sha: string, owner: string, nowMs: number): Promise<boolean> {
  const r = await db.prepare(`DELETE FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL AND ${leaseGuard()}`).bind(sha, owner, nowMs).run();
  return (r.meta.changes ?? 0) === 1;
}

async function cleanupCandidate(db: D1Database, sha: string, owner: string, nowMs: number, packedIn?: string): Promise<boolean> {
  const zeroRefs = "NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256=?)";
  const openIntent = "EXISTS (SELECT 1 FROM gc_candidates c WHERE c.sha256=? AND c.deleting_at IS NOT NULL)";
  const logicalCleanup = [
    db.prepare(`DELETE FROM blobs WHERE sha256=? AND ${zeroRefs} AND ${openIntent} AND ${leaseGuard()}`).bind(sha, sha, sha, owner, nowMs),
    db.prepare(`DELETE FROM blob_refs WHERE sha256=? AND ${zeroRefs} AND ${openIntent} AND ${leaseGuard()}`).bind(sha, sha, sha, owner, nowMs),
    db.prepare(`DELETE FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL AND ${zeroRefs} AND ${leaseGuard()}`).bind(sha, sha, owner, nowMs),
  ];
  if (packedIn === undefined) {
    const res = await db.batch(logicalCleanup);
    return (res[2]?.meta.changes ?? 0) === 1;
  }
  const res = await db.batch([
    db
      .prepare(`DELETE FROM blob_locations WHERE sha256=? AND pack_id=? AND ${zeroRefs} AND ${openIntent} AND ${leaseGuard()}`)
      .bind(sha, packedIn, sha, sha, owner, nowMs),
    ...logicalCleanup,
  ]);
  return (res[3]?.meta.changes ?? 0) === 1;
}

async function executePage(
  env: Env,
  db: D1Database,
  reachable: Set<string>,
  lease: PurgeLease,
  nowMs: number,
  limit: number,
  deadlineAt: number,
  clock: () => number,
  setStage: (stage: GcObservationStage) => void = () => {},
): Promise<{ purged: number; unwound: number; packedRetired: number; bytes: number; touched: Set<string>; cursor: ExecuteCursor | null }> {
  setStage("state_read");
  const prior = await readState<ExecuteCursor>(db, "execute_cursor");
  setStage("execute");
  const cursorWhere = prior ? "AND (deleting_at > ? OR (deleting_at = ? AND sha256 > ?))" : "";
  const binds = prior ? [nowMs - INTENT_QUIESCENCE_MS, prior.deletingAt, prior.deletingAt, prior.sha256, limit] : [nowMs - INTENT_QUIESCENCE_MS, limit];
  let rows = await db
    .prepare(`SELECT sha256, kind, marked_at, deleting_at FROM gc_candidates WHERE deleting_at IS NOT NULL AND deleting_at < ? ${cursorWhere} ORDER BY deleting_at, sha256 LIMIT ?`)
    .bind(...binds)
    .all<Candidate>();
  if ((rows.results?.length ?? 0) === 0 && prior) {
    rows = await db
      .prepare("SELECT sha256, kind, marked_at, deleting_at FROM gc_candidates WHERE deleting_at IS NOT NULL AND deleting_at < ? ORDER BY deleting_at, sha256 LIMIT ?")
      .bind(nowMs - INTENT_QUIESCENCE_MS, limit)
      .all<Candidate>();
  }
  let purged = 0;
  let unwound = 0;
  let packedRetired = 0;
  let bytes = 0;
  const touched = new Set<string>();
  let cursor: ExecuteCursor | null = prior;
  for (const c of rows.results ?? []) {
    if (clock() >= deadlineAt) break; // bounded executor: dispatch no new R2 delete
    cursor = { deletingAt: Number(c.deleting_at), sha256: c.sha256 };
    touched.add(c.sha256);

    // Final D1 check: same unexpired lease, still-open intent, and zero refs.
    const ready = await db
      .prepare(
        `SELECT b.size_bytes, l.pack_id FROM gc_candidates c
         LEFT JOIN blobs b ON b.sha256=c.sha256
         LEFT JOIN blob_locations l ON l.sha256=c.sha256
         WHERE c.sha256=? AND c.deleting_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.sha256=c.sha256)
           AND EXISTS (SELECT 1 FROM gc_state s WHERE s.k='purge_lease'
             AND json_extract(s.v, '$.owner')=? AND CAST(json_extract(s.v, '$.expires') AS INTEGER)>=?)`,
      )
      .bind(c.sha256, lease.owner, clock())
      .first<{ size_bytes: number | null; pack_id: string | null }>();
    if (!ready) {
      // A failed readiness check may mean refs appeared, but it may instead mean
      // this holder expired/lost its lease or the intent disappeared. Only the
      // first is activity; never let lease expiry itself drop the fence.
      const liveLease = await db
        .prepare(
          "SELECT 1 FROM gc_state WHERE k='purge_lease' AND json_extract(v, '$.owner')=? AND CAST(json_extract(v, '$.expires') AS INTEGER)>=?",
        )
        .bind(lease.owner, clock())
        .first();
      if (!liveLease) break;
      const referenced = await db.prepare("SELECT 1 FROM blob_refs WHERE sha256=? LIMIT 1").bind(c.sha256).first();
      if (referenced && (await unwindCandidate(db, c.sha256, lease.owner, clock()))) unwound++;
      continue;
    }
    if (reachable.has(c.sha256)) {
      if (await unwindCandidate(db, c.sha256, lease.owner, clock())) unwound++;
      continue;
    }

    // No await between this last live-clock bound and dispatch: an admin handler
    // can never start a new delete after its 60s code deadline, and an expired
    // lease can never authorize one.
    if (clock() >= deadlineAt || clock() > lease.expires) break;

    if (ready.pack_id === null) {
      const key = c.kind === "manifest" ? manifestKey(c.sha256) : blobKey(c.sha256);
      await env.rbox_dev_blobs.delete(key);
      const present = await env.rbox_dev_blobs.head(key);
      if (present) {
        if (await unwindCandidate(db, c.sha256, lease.owner, clock())) unwound++;
        continue;
      }
    }
    if (await cleanupCandidate(db, c.sha256, lease.owner, clock(), ready.pack_id ?? undefined)) {
      purged++;
      if (ready.pack_id !== null) packedRetired++;
      bytes += Number(ready.size_bytes ?? 0);
    }
  }
  if (cursor) {
    setStage("state_write");
    await writeState(db, "execute_cursor", cursor);
  }
  return { purged, unwound, packedRetired, bytes, touched, cursor };
}

async function openIntents(
  db: D1Database,
  reachable: Set<string>,
  touched: Set<string>,
  graceMs: number,
  nowMs: number,
  setStage: (stage: GcObservationStage) => void = () => {},
): Promise<{ opened: number; resurrected: number; cursor: GcCursor | null }> {
  setStage("state_read");
  const prior = await readState<GcCursor>(db, "intent_cursor");
  setStage("intent");
  const cursorWhere = prior ? "AND (marked_at > ? OR (marked_at = ? AND sha256 > ?))" : "";
  const binds = prior ? [nowMs - graceMs, prior.markedAt, prior.markedAt, prior.sha256, GC_P1_MAX_ROWS] : [nowMs - graceMs, GC_P1_MAX_ROWS];
  let rows = await db
    .prepare(`SELECT sha256, kind, marked_at, deleting_at FROM gc_candidates WHERE deleting_at IS NULL AND marked_at < ? ${cursorWhere} ORDER BY marked_at, sha256 LIMIT ?`)
    .bind(...binds)
    .all<Candidate>();
  if ((rows.results?.length ?? 0) === 0 && prior) {
    rows = await db
      .prepare("SELECT sha256, kind, marked_at, deleting_at FROM gc_candidates WHERE deleting_at IS NULL AND marked_at < ? ORDER BY marked_at, sha256 LIMIT ?")
      .bind(nowMs - graceMs, GC_P1_MAX_ROWS)
      .all<Candidate>();
  }
  const scanned = rows.results ?? [];
  const actions = scanned
    .filter((c) => !touched.has(c.sha256))
    .map((c) =>
      reachable.has(c.sha256)
        ? { kind: "resurrect" as const, stmt: db.prepare("DELETE FROM gc_candidates WHERE sha256=? AND deleting_at IS NULL").bind(c.sha256) }
        : {
            kind: "open" as const,
            stmt: db
              .prepare("UPDATE gc_candidates SET deleting_at=? WHERE sha256=? AND deleting_at IS NULL AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE sha256=?)")
              .bind(nowMs, c.sha256, c.sha256),
          },
    );
  let opened = 0;
  let resurrected = 0;
  if (actions.length) {
    const results = await db.batch(actions.map((a) => a.stmt));
    for (let i = 0; i < actions.length; i++) {
      const changes = results[i]?.meta.changes ?? 0;
      if (actions[i]!.kind === "open") opened += changes;
      else resurrected += changes;
    }
  }
  const last = scanned.at(-1);
  const cursor = last ? { markedAt: Number(last.marked_at), sha256: last.sha256 } : prior;
  if (cursor) {
    setStage("state_write");
    await writeState(db, "intent_cursor", cursor);
  }
  return { opened, resurrected, cursor };
}

export interface GcPurgeOptions {
  nowMs?: number;
  deadlineMs?: number;
  owner?: string;
  /** Live wall clock for lease/deadline tests. Production always defaults to Date.now. */
  clock?: () => number;
}

/** P2/P3 execute first, then P1 intent stamping, under one bounded workspace snapshot. */
export async function gcPurge(env: Env, graceMs: number, options: GcPurgeOptions = {}): Promise<Response> {
  const op = startOp(env, "gc.purge");
  const db = dbFor(op.env, "");
  const nowMs = options.nowMs ?? Date.now();
  const clock = options.clock ?? Date.now;
  const startedAt = clock();
  const deadlineAt = startedAt + (options.deadlineMs ?? 15 * 60 * 1000);
  const maxW = Math.floor((GC_BUDGET_SAFE - GC_FIXED_COST - GC_PER_EXECUTE - GC_P1_COST - 1) / PER_WORKSPACE_ROOTS_COST);
  let stage: GcObservationStage = "snapshot";
  let rows: number | undefined;
  let rootsSample: GcRootsSampleV1 | null = null;
  let observation: GcObservationV1 | null = null;
  const cleanup: { lease: PurgeLease | null } = { lease: null };
  let response: Response | undefined;
  let executed: Awaited<ReturnType<typeof executePage>> = { purged: 0, unwound: 0, packedRetired: 0, bytes: 0, touched: new Set(), cursor: null };
  let intents = { opened: 0, resurrected: 0, cursor: null as GcCursor | null };

  async function runPurgeOp(): Promise<{ observation: GcObservationV1; response: Response }> {
    const workspaces = await workspaceSnapshot(op.env, maxW);
    if (!workspaces) {
      stage = "count";
      rows = await exactWorkspaceCount(op.env);
      op.done("budget_exceeded");
      return {
        observation: terminalObservation("roots_budget_exceeded", null, { status: 200, rows, purged: 0, opened: 0 }),
        response: json({
          purged: 0,
          opened: 0,
          budgetExceeded: true,
          ok: false,
          reason: "roots_budget_exceeded",
          rows,
          maxRows: maxW,
          uniqueRoots: null,
          maxRoots: MAX_UNIQUE_ROOTS,
        }),
      };
    }

    rows = workspaces.length;
    stage = "reachability";
    const reachable = await reachableFromWorkspaces(op.env, workspaces); // I1
    rootsSample = { value: reachable.size, measuredAt: new Date().toISOString() };
    const executeLimit = gcExecuteLimit(workspaces.length);
    if (executeLimit === 0) {
      op.done("zero_chunk");
      metric(env, "gc.purge.cursor", 0, 0, "zero_chunk");
      return {
        observation: terminalObservation("zero_chunk", rootsSample, { status: 200, rows, purged: 0, opened: 0 }),
        response: json({ purged: 0, opened: 0, executeLimit: 0 }),
      };
    }

    stage = "lease";
    const acquired = await acquireLease(db, startedAt, options.owner);
    const lease = acquired.lease;
    cleanup.lease = lease;
    if (!lease) {
      op.done("lease_busy");
      return {
        observation: terminalObservation("lease_busy", rootsSample, { status: 409, rows, purged: 0, opened: 0 }),
        response: json({ purged: 0, opened: 0, leaseBusy: true, retryAfterMs: acquired.retryAfterMs }, 409),
      };
    }

    try {
      stage = "lease";
      if (!(await renewLease(db, lease, clock()))) {
        op.done("lease_lost");
        return {
          observation: terminalObservation("lease_lost", rootsSample, { status: 409, rows, purged: 0, opened: 0 }),
          response: json({ purged: 0, opened: 0, leaseLost: true }, 409),
        };
      }
      stage = "execute";
      executed = await executePage(op.env, db, reachable, lease, nowMs, executeLimit, deadlineAt, clock, (next) => { stage = next; });
      stage = "intent";
      intents = await openIntents(db, reachable, executed.touched, graceMs, nowMs, (next) => { stage = next; });
      stage = "state_read";
      const stale = await db
        .prepare("SELECT COUNT(*) AS n FROM gc_candidates WHERE deleting_at IS NOT NULL AND deleting_at < ?")
        .bind(nowMs - STALE_INTENT_MS)
        .first<{ n: number }>();
      metric(env, "gc.intents.opened", intents.opened);
      metric(env, "gc.intents.unwound", executed.unwound);
      metric(env, "gc.objects.purged", executed.purged, executed.bytes);
      metric(env, "gc.pack.locations_retired", executed.packedRetired);
      metric(env, "gc.intents.stale", Number(stale?.n ?? 0));
      metric(env, "gc.purge.cursor", 1);
      op.done("ok", { count: executed.purged, bytes: executed.bytes });
      return {
        observation: terminalObservation("success", rootsSample, {
          status: 200,
          rows,
          purged: executed.purged,
          opened: intents.opened,
        }),
        response: json({
          purged: executed.purged,
          unwound: executed.unwound,
          resurrected: intents.resurrected,
          opened: intents.opened,
          bytes: executed.bytes,
          executeLimit,
        }),
      };
    } catch (e) {
      op.done("error", { count: executed.purged, bytes: executed.bytes });
      return {
        observation: terminalObservation("internal_500", rootsSample, {
          stage,
          status: 500,
          rows,
          purged: executed.purged,
          opened: intents.opened,
          errorClass: errClass(e),
        }),
        response: json({ error: "gc_purge_failed" }, 500),
      };
    }
  }

  try {
    ({ observation, response } = await runPurgeOp());
    return response;
  } catch (e) {
    if (e instanceof GcRootsCapExceeded) {
      const at = new Date().toISOString();
      observation = {
        v: 1,
        at,
        outcome: "roots_cap_exceeded",
        stage: "reachability",
        errorClass: errClass(e),
        rootsSample: { value: MAX_UNIQUE_ROOTS, measuredAt: at, lowerBound: true },
      };
    } else {
      observation = terminalObservation("thrown", rootsSample, { stage, rows, errorClass: errClass(e) });
    }
    throw e;
  } finally {
    if (cleanup.lease) {
      const released = await releaseLeaseWithRetry(db, cleanup.lease.owner);
      if (!released.ok) {
        observation = terminalObservation("thrown", rootsSample, {
          stage: "release",
          status: response?.status,
          rows,
          purged: executed.purged,
          opened: intents.opened,
          errorClass: released.errorClass,
        });
      }
    }
    if (observation) {
      if (observation.outcome !== "thrown" || observation.stage !== "release") {
        const at = new Date().toISOString();
        observation = observation.outcome === "roots_cap_exceeded"
          ? { ...observation, at, rootsSample: { value: MAX_UNIQUE_ROOTS, measuredAt: at, lowerBound: true } }
          : { ...observation, at };
      }
      await writeGcObservation(db, "gc_obs_purge", observation);
    }
  }
}
