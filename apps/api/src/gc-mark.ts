import type { Env } from "./env.js";
import { errClass, json } from "./util.js";
import { dbFor } from "./db.js";
import { startOp } from "./metrics.js";
import { GcRootsCapExceeded, MAX_UNIQUE_ROOTS, reachableFromWorkspaces, workspaceSnapshot, exactWorkspaceCount } from "./gc-roots.js";
import { readState, writeState } from "./gc-state.js";
import { metric, terminalObservation, writeGcObservation, type GcObservationStage, type GcObservationV1, type GcRootsSampleV1 } from "./gc-observability.js";
import { GC_BUDGET_SAFE, GC_FIXED_COST, PER_WORKSPACE_ROOTS_COST } from "./gc-policy.js";

const shaOfKey = (key: string) => key.split("/").pop() ?? "";
export const GC_INSERT_ROWS = 33;

interface MarkCursor {
  prefix: string;
  cursor?: string;
}
/** GC mark processes exactly one R2 list page and one bounded insert batch per tick. */
export async function gcMark(env: Env, graceMs: number, nowMs: number = Date.now()): Promise<Response> {
  const op = startOp(env, "gc.mark");
  const db = dbFor(op.env, "");
  const maxW = Math.floor((GC_BUDGET_SAFE - GC_FIXED_COST - 3) / PER_WORKSPACE_ROOTS_COST); // workspace query + list + insert batch
  let stage: GcObservationStage = "snapshot";
  let rootsSample: GcRootsSampleV1 | null = null;
  let observation: GcObservationV1 | null = null;
  try {
    const workspaces = await workspaceSnapshot(op.env, maxW);
    if (!workspaces) {
      stage = "count";
      const rows = await exactWorkspaceCount(op.env);
      op.done("budget_exceeded");
      observation = terminalObservation("roots_budget_exceeded", null, { status: 200, rows, marked: 0 });
      return json({
        marked: 0,
        budgetExceeded: true,
        ok: false,
        reason: "roots_budget_exceeded",
        rows,
        maxRows: maxW,
        uniqueRoots: null,
        maxRoots: MAX_UNIQUE_ROOTS,
      });
    }
    stage = "reachability";
    const reachable = await reachableFromWorkspaces(op.env, workspaces); // I1: throws on any DO error
    rootsSample = { value: reachable.size, measuredAt: new Date().toISOString() };
    stage = "state_read";
    const saved = (await readState<MarkCursor>(db, "mark_cursor")) ?? { prefix: "blobs/sha256/" };
    const prefix = saved.prefix === "manifests/sha256/" ? saved.prefix : "blobs/sha256/";
    const kind = prefix.startsWith("manifests/") ? "manifest" : "blob";
    stage = "list";
    const listed = await op.span.r2(() => env.rbox_dev_blobs.list({ prefix, cursor: saved.cursor, limit: 1000 }));
    const eligible = listed.objects
      .map((o) => ({ sha: shaOfKey(o.key), uploaded: o.uploaded.getTime() }))
      .filter((o) => o.sha && !reachable.has(o.sha) && nowMs - o.uploaded >= graceMs);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < eligible.length; i += GC_INSERT_ROWS) {
      const chunk = eligible.slice(i, i + GC_INSERT_ROWS);
      statements.push(
        db
          .prepare(`INSERT OR IGNORE INTO gc_candidates (sha256, kind, marked_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`)
          .bind(...chunk.flatMap((o) => [o.sha, kind, nowMs])),
      );
    }
    let marked = 0;
    if (statements.length) {
      stage = "candidate_write";
      const results = await db.batch(statements);
      marked = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    }
    const next: MarkCursor = listed.truncated
      ? { prefix, cursor: listed.cursor }
      : { prefix: prefix === "blobs/sha256/" ? "manifests/sha256/" : "blobs/sha256/" };
    stage = "state_write";
    await writeState(db, "mark_cursor", next);
    op.done("ok", { count: marked });
    metric(env, "gc.mark.cursor", 1);
    observation = terminalObservation("success", rootsSample, { status: 200, rows: workspaces.length, marked });
    return json({ marked, cursor: next });
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
      observation = terminalObservation("thrown", rootsSample, { stage, errorClass: errClass(e) });
    }
    throw e;
  } finally {
    if (observation) await writeGcObservation(db, "gc_obs_mark", observation);
  }
}
