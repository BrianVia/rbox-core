import type { Env } from "./env.js";
import { blobKey, errClass, json, logErr, manifestKey } from "./util.js";
import { dbFor } from "./db.js";
import { batchedInLookup } from "./d1-batch.js";
import { startOp } from "./metrics.js";
import { loadSidecarRefs } from "./sidecar.js";

// §32 FLAG: global GC (mark/purge) enumerates `workspaces`/`blobs`/`blob_refs`/
// `gc_candidates` across ALL accounts and keys the per-blob deletes by `sha256` — an
// account-data-plane CROSS-SHARD fan-out (design 32 §6b, deferred to §33). None of these
// sites has an account id in scope, so they call `dbFor(env, "")`: account-less, the one
// shard at N=1, and exactly the sites a real shard cutover must turn into a per-shard
// fan-out. Phase 2 deliberately never touches per-account usage (I4).

/**
 * Build the reachable set from AUTHORITATIVE DO roots for a set of workspaces. Asks each
 * per-(workspace, project) WorkspaceSync DO for its retained roots and unions every
 * `encManifestSha` + referenced `encSha`. Under full E2EE the DO parses each retained
 * commit body and hands back the content addresses directly, so GC needs NO R2 manifest
 * fetch and stays zero-knowledge.
 *
 * FAIL CLOSED: a single unreadable DO or exhausted bound throws, so GC never treats a
 * partial snapshot as "unreachable" and wrongly reclaims live content. Workspaces are
 * deliberately sequential so peak memory is the merged set plus one bounded local set.
 */
export const MAX_DROPPED_PAGES = 16;
export const MAX_SEQROOTS_PAGES = 4;
export const MAX_SNAPSHOT_RETRIES = 2;
export const MAX_UNIQUE_ROOTS = 750_000;
export const PER_WORKSPACE_ROOTS_COST = 90;
const ROOTS_PAGE_LIMIT = 20_000;

export class GcRootsCapExceeded extends Error {
  constructor() {
    super(`GC abort (fail-closed): reachable roots exceed ${MAX_UNIQUE_ROOTS}`);
    this.name = "GcRootsCapExceeded";
  }
}

interface RootsPage {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  gap: Array<{
    manifestSha: string;
    carrierSha?: string;
    inlineRefs?: string[];
    chainRefs?: string[];
    sidecar?: { sha: string; count: number; size: number };
  }>;
  droppedPage: string[];
  nextSha?: string;
  seqRootsPage: Array<{ manifestSha: string; carrierSha?: string }>;
  nextSeq?: number;
}

function addRoot(env: Env, global: Set<string>, local: Set<string>, sha: string): void {
  if (!sha || local.has(sha) || global.has(sha)) return;
  if (global.size + local.size >= MAX_UNIQUE_ROOTS) {
    metric(env, "gc.roots.cardinality_exceeded", global.size + local.size + 1, 0, "fail_closed");
    throw new GcRootsCapExceeded();
  }
  local.add(sha);
}

export async function reachableFromWorkspaces(env: Env, rows: Array<{ workspace_id: string; project_id: string }>): Promise<Set<string>> {
  const reachable = new Set<string>();
  for (const w of rows) {
    let complete: Set<string> | null = null;
    for (let attempt = 0; attempt <= MAX_SNAPSHOT_RETRIES && !complete; attempt++) {
      const local = new Set<string>();
      const id = env.WORKSPACE_SYNC.idFromName(`${w.workspace_id}/${w.project_id}`);
      // Slash-safe addressing (design 37 §4f follow-up): a positional `…/proj/:proj/roots` path
      // mis-parses a project_id containing "/" → 404 → the fail-closed sweep reclaims NOTHING
      // (indefinite leak of blobs the account-deletion path condemned). Use the DO's FIXED
      // `/roots` path with ws/proj in the query instead.
      let fromSha = "";
      let fromSeq = "";
      let droppedPages = 0;
      let seqRootsPages = 0;
      let gapRead = false;
      let pin: Pick<RootsPage, "head" | "pruneFloor" | "indexGeneration"> | null = null;
      try {
        while (fromSha !== "done" || fromSeq !== "done") {
          if (fromSha !== "done" && ++droppedPages > MAX_DROPPED_PAGES) throw new Error("dropped-page cap exceeded");
          if (fromSeq !== "done" && ++seqRootsPages > MAX_SEQROOTS_PAGES) throw new Error("seq-roots-page cap exceeded");
          const q = new URLSearchParams({ ws: w.workspace_id, proj: w.project_id, fromSha, fromSeq, limit: String(ROOTS_PAGE_LIMIT) });
          if (pin) {
            q.set("pinHead", String(pin.head));
            q.set("pinFloor", String(pin.pruneFloor));
            q.set("pinGen", String(pin.indexGeneration));
          }
          const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/roots?${q}`);
          if (res.status === 409) throw new DOMException("snapshot changed", "AbortError");
          if (!res.ok) throw new Error(`roots status ${res.status}`);
          const page = (await res.json()) as RootsPage;
          pin ??= page;
          for (const sha of page.droppedPage) addRoot(env, reachable, local, sha);
          for (const root of page.seqRootsPage) {
            addRoot(env, reachable, local, root.manifestSha);
            if (root.carrierSha) addRoot(env, reachable, local, root.carrierSha);
          }
          if (!gapRead) {
            for (const gap of page.gap) {
              addRoot(env, reachable, local, gap.manifestSha);
              if (gap.carrierSha) addRoot(env, reachable, local, gap.carrierSha);
              for (const sha of gap.inlineRefs ?? []) addRoot(env, reachable, local, sha);
              for (const sha of gap.chainRefs ?? []) addRoot(env, reachable, local, sha);
              if (gap.sidecar) {
                addRoot(env, reachable, local, gap.sidecar.sha);
                const loaded = await loadSidecarRefs(env, gap.sidecar.sha, gap.sidecar.count);
                if (!loaded.ok) throw new Error(`gap sidecar ${loaded.reason}`);
                let totalBytes = 0;
                for (const ref of loaded.refs) totalBytes += ref.size;
                if (totalBytes !== gap.sidecar.size) throw new Error("gap sidecar descriptor size mismatch");
                for (const ref of loaded.refs) addRoot(env, reachable, local, ref.encSha);
              }
            }
            gapRead = true;
          }
          fromSha = fromSha === "done" ? "done" : page.nextSha ?? "done";
          fromSeq = fromSeq === "done" ? "done" : page.nextSeq == null ? "done" : String(page.nextSeq);
        }
        complete = local;
      } catch (e) {
        local.clear(); // release the partial workspace accumulator before a retry
        if (e instanceof GcRootsCapExceeded) throw e;
        if (e instanceof DOMException && e.name === "AbortError" && attempt < MAX_SNAPSHOT_RETRIES) continue;
        throw new Error(`GC abort (fail-closed): cannot read roots for ${w.workspace_id}/${w.project_id}`, { cause: e });
      }
    }
    for (const sha of complete!) reachable.add(sha);
  }
  return reachable;
}

const shaOfKey = (key: string) => key.split("/").pop() ?? "";

export const GC_BUDGET_SAFE = 800;
export const GC_FIXED_COST = 10;
export const GC_PER_EXECUTE = 5;
export const GC_P1_COST = 3;
export const GC_P1_MAX_ROWS = 200;
export const GC_MAX_EXECUTE_ROWS = 200;
export const GC_INSERT_ROWS = 33;
export const INTENT_QUIESCENCE_MS = 24 * 60 * 60 * 1000;
export const PURGE_LEASE_TTL_MS = 20 * 60 * 1000;
export const TAKEOVER_QUIESCENCE_MS = 30 * 60 * 1000;
export const STALE_INTENT_MS = 72 * 60 * 60 * 1000;
export const ADMIN_PURGE_DEADLINE_MS = 60 * 1000;
export const GC_MAX_WORKSPACE_ROWS = 8;
export const GC_WARN_WORKSPACE_ROWS = 6;
export const GC_WARN_UNIQUE_ROOTS = 562_500;

export type GcObservationOutcome =
  | "success"
  | "roots_budget_exceeded"
  | "roots_cap_exceeded"
  | "zero_chunk"
  | "lease_busy"
  | "lease_lost"
  | "internal_500"
  | "thrown";

export type GcObservationStage =
  | "count"
  | "snapshot"
  | "reachability"
  | "state_read"
  | "list"
  | "candidate_write"
  | "state_write"
  | "lease"
  | "execute"
  | "intent"
  | "release";

export interface GcRootsSampleV1 {
  value: number;
  measuredAt: string;
  lowerBound?: true;
}

export interface GcObservationV1 {
  v: 1;
  at: string;
  outcome: GcObservationOutcome;
  stage?: GcObservationStage;
  status?: number;
  rows?: number;
  marked?: number;
  purged?: number;
  opened?: number;
  errorClass?: string;
  rootsSample: GcRootsSampleV1 | null;
}

export interface GcHealthV1 {
  ok: true;
  rows: number;
  maxRows: 8;
  uniqueRoots: (GcRootsSampleV1 & { stale: true }) | null;
  maxRoots: 750_000;
  mark: GcObservationV1 | null;
  purge: GcObservationV1 | null;
  warn: boolean;
}

const GC_OBSERVATION_KEYS = ["gc_obs_mark", "gc_obs_purge"] as const;
export type GcObservationKey = (typeof GC_OBSERVATION_KEYS)[number];
const GC_OUTCOMES = new Set<GcObservationOutcome>([
  "success", "roots_budget_exceeded", "roots_cap_exceeded", "zero_chunk",
  "lease_busy", "lease_lost", "internal_500", "thrown",
]);
const GC_STAGES = new Set<GcObservationStage>([
  "count", "snapshot", "reachability", "state_read", "list", "candidate_write",
  "state_write", "lease", "execute", "intent", "release",
]);

function isFixedIso(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function parseGcObservation(value: unknown): GcObservationV1 | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Record<string, unknown>;
  if (o.v !== 1 || !isFixedIso(o.at) || !GC_OUTCOMES.has(o.outcome as GcObservationOutcome)) return null;
  if (o.stage !== undefined && !GC_STAGES.has(o.stage as GcObservationStage)) return null;
  for (const field of ["status", "rows", "marked", "purged", "opened"] as const) {
    if (o[field] !== undefined && (!Number.isFinite(o[field]) || Number(o[field]) < 0)) return null;
  }
  if (o.errorClass !== undefined && typeof o.errorClass !== "string") return null;
  if (o.rootsSample !== null) {
    if (!o.rootsSample || typeof o.rootsSample !== "object") return null;
    const sample = o.rootsSample as Record<string, unknown>;
    if (!Number.isFinite(sample.value) || Number(sample.value) < 0 || !isFixedIso(sample.measuredAt)) return null;
    if (sample.lowerBound !== undefined && sample.lowerBound !== true) return null;
  }
  return value as GcObservationV1;
}

const GC_OBSERVATION_UPSERT = `
INSERT INTO gc_state (k, v)
VALUES (?1, json(?2))
ON CONFLICT(k) DO UPDATE SET v = json_set(
  CASE
    WHEN json_extract(excluded.v, '$.at') > json_extract(gc_state.v, '$.at')
      OR (
        json_extract(excluded.v, '$.at') = json_extract(gc_state.v, '$.at')
        AND json_extract(excluded.v, '$.outcome') = 'roots_cap_exceeded'
        AND json_extract(gc_state.v, '$.outcome') <> 'roots_cap_exceeded'
      )
    THEN excluded.v
    ELSE gc_state.v
  END,
  '$.rootsSample',
  json(CASE
    WHEN json_type(excluded.v, '$.rootsSample') = 'object'
      AND (
        json_type(gc_state.v, '$.rootsSample') <> 'object'
        OR json_extract(excluded.v, '$.rootsSample.measuredAt')
             > json_extract(gc_state.v, '$.rootsSample.measuredAt')
        OR (
          json_extract(excluded.v, '$.rootsSample.measuredAt')
            = json_extract(gc_state.v, '$.rootsSample.measuredAt')
          AND COALESCE(json_extract(excluded.v, '$.rootsSample.lowerBound'), 0) <> 1
          AND COALESCE(json_extract(gc_state.v, '$.rootsSample.lowerBound'), 0) = 1
        )
      )
    THEN json_extract(excluded.v, '$.rootsSample')
    ELSE json_extract(gc_state.v, '$.rootsSample')
  END)
)
WHERE
  json_extract(excluded.v, '$.at') > json_extract(gc_state.v, '$.at')
  OR (
    json_extract(excluded.v, '$.at') = json_extract(gc_state.v, '$.at')
    AND json_extract(excluded.v, '$.outcome') = 'roots_cap_exceeded'
    AND json_extract(gc_state.v, '$.outcome') <> 'roots_cap_exceeded'
  )
  OR (
    json_type(excluded.v, '$.rootsSample') = 'object'
    AND (
      json_type(gc_state.v, '$.rootsSample') <> 'object'
      OR json_extract(excluded.v, '$.rootsSample.measuredAt')
           > json_extract(gc_state.v, '$.rootsSample.measuredAt')
      OR (
        json_extract(excluded.v, '$.rootsSample.measuredAt')
          = json_extract(gc_state.v, '$.rootsSample.measuredAt')
        AND COALESCE(json_extract(excluded.v, '$.rootsSample.lowerBound'), 0) <> 1
        AND COALESCE(json_extract(gc_state.v, '$.rootsSample.lowerBound'), 0) = 1
      )
    )
  );`;

/** Best-effort, single-statement monotonic observation write. */
export async function writeGcObservation(db: D1Database, key: GcObservationKey, observation: GcObservationV1): Promise<void> {
  try {
    if (!GC_OBSERVATION_KEYS.includes(key) || !parseGcObservation(observation)) throw new TypeError("invalid GC observation");
    await db.prepare(GC_OBSERVATION_UPSERT).bind(key, JSON.stringify(observation)).run();
  } catch (e) {
    logErr("gc_observation_write_failed", e);
  }
}

function terminalObservation(
  outcome: GcObservationOutcome,
  rootsSample: GcRootsSampleV1 | null,
  fields: Omit<Partial<GcObservationV1>, "v" | "at" | "outcome" | "rootsSample"> = {},
): GcObservationV1 {
  return { v: 1, at: new Date().toISOString(), outcome, ...fields, rootsSample };
}

export function gcExecuteLimit(workspaceCount: number): number {
  return Math.max(
    0,
    Math.min(GC_MAX_EXECUTE_ROWS, Math.floor((GC_BUDGET_SAFE - 1 - workspaceCount * PER_WORKSPACE_ROOTS_COST - GC_FIXED_COST - GC_P1_COST) / GC_PER_EXECUTE)),
  );
}

interface GcCursor {
  markedAt: number;
  sha256: string;
}
interface ExecuteCursor {
  deletingAt: number;
  sha256: string;
}
interface MarkCursor {
  prefix: string;
  cursor?: string;
}
export interface PurgeLease {
  owner: string;
  acquired: number;
  expires: number;
}
interface Candidate {
  sha256: string;
  kind: "blob" | "manifest";
  marked_at: number;
  deleting_at: number | null;
}

function metric(env: Env, name: string, count = 0, bytes = 0, outcome = "ok"): void {
  const op = startOp(env, name);
  op.done(outcome, { count, bytes });
}

export async function readState<T>(db: D1Database, key: string): Promise<T | null> {
  const row = await db.prepare("SELECT v FROM gc_state WHERE k = ?").bind(key).first<{ v: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.v) as T;
  } catch {
    return null;
  }
}

export async function writeState(db: D1Database, key: string, value: unknown): Promise<void> {
  await db.prepare("INSERT INTO gc_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(key, JSON.stringify(value)).run();
}

async function workspaceSnapshot(env: Env, maxW: number): Promise<Array<{ workspace_id: string; project_id: string }> | null> {
  const rows = await dbFor(env, "")
    .prepare("SELECT workspace_id, project_id FROM workspaces LIMIT ?")
    .bind(maxW + 1)
    .all<{ workspace_id: string; project_id: string }>();
  const results = rows.results ?? [];
  if (results.length > maxW) {
    metric(env, "gc.budget_exceeded", results.length, 0, "workspaces");
    return null;
  }
  return results;
}

async function exactWorkspaceCount(env: Env): Promise<number> {
  const row = await dbFor(env, "").prepare("SELECT COUNT(*) AS n FROM workspaces").first<{ n: number }>();
  return Number(row?.n ?? 0);
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

/** Age floor before a handle-less `staging/` object may be reclaimed. `blobs.ts` expires an
 *  `uploads` row at 6 days (UPLOAD_EXPIRY_MS), deliberately INSIDE R2's 7-day multipart TTL,
 *  so every upload a client can still resume has BOTH a row younger than 6 days AND an MPU
 *  R2 has not yet abandoned. 7 days sits strictly outside that window. The age check and the
 *  row check are INDEPENDENT conditions, so neither clock skew nor a stale list page can
 *  reap a live upload on its own. */
export const STAGING_ORPHAN_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const STAGING_SWEEP_PAGE = 1000; // one bounded R2 list page per tick, as gcMark does
const STAGING_PREFIX = "staging/";
const STAGING_DELETE_CHUNK = 100; // R2 batch-delete cap is 1000; 100 keeps a full page ≤10 subrequests

interface StagingCursor {
  cursor?: string;
}

/**
 * Reclaimer for orphaned `staging/` objects — nothing else in the system reclaims that
 * prefix. R2's own 7-day TTL abandons INCOMPLETE multipart uploads, but once `mpu.complete()`
 * has run the staging key is an ordinary object with no TTL, and its only handle is the
 * `uploads.staging_key` row that `multipartComplete`'s terminal cleanup drops. A staging
 * object whose row is gone can never be resumed, completed, read, or deleted by any other
 * code path: `gcMark` rotates only `blobs/sha256/` + `manifests/sha256/`, and
 * `multipart-inventory.ts` lists this prefix READ-ONLY, for observability.
 *
 * Its OWN bounded sweep rather than a third `mark_cursor` prefix: gcMark's rotation feeds
 * `gc_candidates`, keyed by the sha parsed out of the object key and gated on DO
 * reachability. A staging key (`staging/<sha>/<uuid>`) parses to a uuid, is never part of
 * the reachable set, and is live purely by D1 row presence — folding it into that cursor
 * would put two unrelated liveness models behind one piece of state.
 *
 * FAIL CLOSED, mirroring `purgeUploadR2`'s ordering argument (account-delete.ts): a listable
 * staging object means its MPU is already consumed, so there is nothing to abort, and its
 * absent `uploads` row is precisely what makes it an orphan, so there is no D1 handle left to
 * drop after the delete. That leaves the liveness read as the only fence, and a throwing read
 * reclaims NOTHING — the throw leaves `staging_cursor` unmoved and the page is re-swept.
 */
export async function gcStagingSweep(env: Env, nowMs: number = Date.now()): Promise<Response> {
  const op = startOp(env, "gc.staging");
  const db = dbFor(op.env, "");
  const saved = await readState<StagingCursor>(db, "staging_cursor");
  const listed = await op.span.r2(() => env.rbox_dev_blobs.list({ prefix: STAGING_PREFIX, cursor: saved?.cursor, limit: STAGING_SWEEP_PAGE }));
  const aged = listed.objects.filter((o) => nowMs - o.uploaded.getTime() >= STAGING_ORPHAN_MIN_AGE_MS).map((o) => o.key);
  // `uploads` holds only in-flight uploads (bounded by the 6-day expiry), so this IN-list
  // scan stays cheap even though `staging_key` carries no index.
  const live = new Set<string>();
  await batchedInLookup<{ staging_key: string }>(
    db,
    aged,
    (chunk) => db.prepare(`SELECT staging_key FROM uploads WHERE staging_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk),
    (rows) => {
      for (const r of rows) live.add(r.staging_key);
    },
  );
  const orphans = aged.filter((key) => !live.has(key));
  let deleted = 0;
  for (let i = 0; i < orphans.length; i += STAGING_DELETE_CHUNK) {
    const chunk = orphans.slice(i, i + STAGING_DELETE_CHUNK);
    try {
      await op.span.r2(() => env.rbox_dev_blobs.delete(chunk));
      deleted += chunk.length;
    } catch (e) {
      logErr("gc_staging_delete_failed", e); // transient → the next full rotation re-lists it
    }
  }
  const next: StagingCursor = listed.truncated ? { cursor: listed.cursor } : {};
  await writeState(db, "staging_cursor", next);
  op.done("ok", { count: deleted });
  metric(env, "gc.staging.reclaimed", deleted);
  return json({ scanned: listed.objects.length, orphans: orphans.length, deleted, cursor: next.cursor ?? null });
}

export type LeaseAcquisition = { lease: PurgeLease; retryAfterMs: 0 } | { lease: null; retryAfterMs: number };

export async function acquireLease(
  db: D1Database,
  nowMs: number,
  owner = crypto.randomUUID(),
  stateKey = "purge_lease",
): Promise<LeaseAcquisition> {
  const lease: PurgeLease = { owner, acquired: nowMs, expires: nowMs + PURGE_LEASE_TTL_MS };
  const inserted = await db.prepare(`INSERT OR IGNORE INTO gc_state (k, v) VALUES ('${leaseStateKey(stateKey)}', ?)`).bind(JSON.stringify(lease)).run();
  if ((inserted.meta.changes ?? 0) === 1) return { lease, retryAfterMs: 0 };
  const prior = await db.prepare(`SELECT v FROM gc_state WHERE k='${leaseStateKey(stateKey)}'`).first<{ v: string }>();
  if (!prior) return { lease: null, retryAfterMs: PURGE_LEASE_TTL_MS + TAKEOVER_QUIESCENCE_MS };
  let parsed: PurgeLease;
  try {
    parsed = JSON.parse(prior.v) as PurgeLease;
  } catch {
    return { lease: null, retryAfterMs: PURGE_LEASE_TTL_MS + TAKEOVER_QUIESCENCE_MS }; // malformed durable state fails closed
  }
  const retryAfterMs = Math.max(1, Number(parsed.expires) + TAKEOVER_QUIESCENCE_MS - nowMs + 1);
  if (nowMs <= Number(parsed.expires) + TAKEOVER_QUIESCENCE_MS) return { lease: null, retryAfterMs };
  const taken = await db.prepare(`UPDATE gc_state SET v=? WHERE k='${leaseStateKey(stateKey)}' AND v=?`).bind(JSON.stringify(lease), prior.v).run();
  return (taken.meta.changes ?? 0) === 1
    ? { lease, retryAfterMs: 0 }
    : { lease: null, retryAfterMs: PURGE_LEASE_TTL_MS + TAKEOVER_QUIESCENCE_MS };
}

export async function renewLease(db: D1Database, lease: PurgeLease, nowMs: number, stateKey = "purge_lease"): Promise<boolean> {
  const renewed = { ...lease, expires: nowMs + PURGE_LEASE_TTL_MS };
  const r = await db
    .prepare(`UPDATE gc_state SET v=? WHERE k='${leaseStateKey(stateKey)}' AND json_extract(v, '$.owner')=?`)
    .bind(JSON.stringify(renewed), lease.owner)
    .run();
  if ((r.meta.changes ?? 0) === 1) {
    lease.expires = renewed.expires;
    return true;
  }
  return false;
}

export async function releaseLease(db: D1Database, owner: string, stateKey = "purge_lease"): Promise<void> {
  await db.prepare(`DELETE FROM gc_state WHERE k='${leaseStateKey(stateKey)}' AND json_extract(v, '$.owner')=?`).bind(owner).run();
}

export type LeaseReleaseResult = { ok: true } | { ok: false; errorClass: string };

export async function releaseLeaseWithRetry(db: D1Database, owner: string, stateKey = "purge_lease"): Promise<LeaseReleaseResult> {
  const backoffs = [250, 1000];
  let failureClass = "unknown";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await releaseLease(db, owner, stateKey);
      return { ok: true };
    } catch (e) {
      failureClass = errClass(e);
      if (attempt < backoffs.length) await new Promise((resolve) => setTimeout(resolve, backoffs[attempt]));
    }
  }
  return { ok: false, errorClass: failureClass };
}

function leaseStateKey(stateKey: string): string {
  if (stateKey !== "purge_lease" && stateKey !== "pack_purge_lease") throw new Error("invalid purge lease state key");
  return stateKey;
}

export function leaseGuard(stateKey = "purge_lease"): string {
  return `EXISTS (SELECT 1 FROM gc_state WHERE k='${leaseStateKey(stateKey)}' AND json_extract(v, '$.owner')=? AND CAST(json_extract(v, '$.expires') AS INTEGER)>=?)`;
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

async function readGcObservation(db: D1Database, key: GcObservationKey): Promise<GcObservationV1 | null> {
  const raw = await readState<unknown>(db, key);
  return parseGcObservation(raw);
}

function newerRootsSample(a: GcRootsSampleV1 | null, b: GcRootsSampleV1 | null): GcRootsSampleV1 | null {
  if (!a) return b;
  if (!b) return a;
  if (b.measuredAt > a.measuredAt) return b;
  if (b.measuredAt < a.measuredAt) return a;
  return a.lowerBound === true && b.lowerBound !== true ? b : a;
}

export async function gcHealthData(env: Env): Promise<GcHealthV1> {
  const db = dbFor(env, "");
  const [rows, mark, purge] = await Promise.all([
    exactWorkspaceCount(env),
    readGcObservation(db, "gc_obs_mark"),
    readGcObservation(db, "gc_obs_purge"),
  ]);
  const selected = newerRootsSample(mark?.rootsSample ?? null, purge?.rootsSample ?? null);
  const uniqueRoots = selected ? { ...selected, stale: true as const } : null;
  const warn = rows >= GC_WARN_WORKSPACE_ROWS
    || (selected?.value ?? 0) >= GC_WARN_UNIQUE_ROOTS
    || mark?.outcome === "roots_cap_exceeded"
    || purge?.outcome === "roots_cap_exceeded";
  return {
    ok: true,
    rows,
    maxRows: GC_MAX_WORKSPACE_ROWS,
    uniqueRoots,
    maxRoots: MAX_UNIQUE_ROOTS,
    mark,
    purge,
    warn,
  };
}

export async function gcHealth(env: Env): Promise<Response> {
  return json(await gcHealthData(env));
}

/** Hourly level-triggered warning; health-read failures remain best-effort. */
export async function emitGcHealthWarning(env: Env): Promise<void> {
  try {
    const health = await gcHealthData(env);
    if (!health.warn) return;
    console.warn(JSON.stringify({
      event: "gc_health_warning",
      rows: health.rows,
      maxRows: health.maxRows,
      uniqueRoots: health.uniqueRoots?.value ?? null,
      rootsLowerBound: health.uniqueRoots?.lowerBound === true,
      maxRoots: health.maxRoots,
      markOutcome: health.mark?.outcome ?? null,
      purgeOutcome: health.purge?.outcome ?? null,
    }));
  } catch (e) {
    logErr("scheduled_gc_health_failed", e);
  }
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

/** GET /v1/ws/:ws/proj/:proj/versions?limit=N — commit history (newest first).
 *  Read from the D1 `commits` mirror (eventually consistent; fine for browsing). */
export async function versionsList(env: Env, accountId: string, ws: string, proj: string, limit: number): Promise<Response> {
  const n = Number.isInteger(limit) && limit > 0 && limit <= 500 ? limit : 50;
  // `commits` is account-data; the Worker authorizes the workspace (owner === accountId)
  // before calling, so route by the verified caller's account (§32 §2).
  const rows = await dbFor(env, accountId)
    .prepare("SELECT sequence, commit_hash, device_id, created_at FROM commits WHERE workspace_id = ? AND project_id = ? ORDER BY sequence DESC LIMIT ?")
    .bind(ws, proj, n)
    .all<{ sequence: number; commit_hash: string; device_id: string | null; created_at: number }>();
  return json({ versions: rows.results ?? [] });
}
