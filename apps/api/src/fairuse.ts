import type { Env } from "./env.js";
import { dbFor } from "./db.js";
import { resolveAccountPlan } from "./retention.js";
import { planFor } from "./plans.js";
import { loadSidecarShaSet } from "./sidecar.js";
import { metric } from "./gc-observability.js";
import { MAX_MANIFEST_DELTA_CHAIN } from "../../../src/engine/manifest-chain.js";

export const FAIRUSE_MAX_WORKSPACES = 64;
export const FAIRUSE_ACCOUNTS_PER_TICK = 1;
export const FAIRUSE_PIN_PAGE = 8;
export const FAIRUSE_ENTITLEMENT_PAGE = 2_000;
/** Page SELECTs admitted per tick. Plus the one guarded write batch that advances the
 *  group's cursor + running total, that is 49 statements — inside design 149's 64/tick.
 *  Because it CHECKPOINTS, no statement budget scales with account blob_refs cardinality;
 *  an account of any size makes progress. There is deliberately no account-level ref cap. */
export const FAIRUSE_ENTITLEMENT_PAGES_PER_TICK = 48;
/** Bounds ONE in-memory ref set — the workspace-group's dedup Set (~33 MB at the cap)
 *  plus the ≤10.0 MB sidecar buffer, ≈43 MB against a 128 MiB isolate. Evaluated from
 *  the head envelopes ALONE, before any R2 GET, and fails CLOSED (never truncates).
 *  Numerically equal to MAX_REFS_PER_COMMIT by coincidence, not derivation. */
export const FAIRUSE_GROUP_REF_CAP = 250_000;
/** Total attempts to materialize a group's refs when a superseded sidecar was GC'd
 *  between the head read and the R2 GET. Mirrors gc-roots MAX_SNAPSHOT_RETRIES. */
export const FAIRUSE_SIDECAR_STALE_ATTEMPTS = 2;
export const FAIRUSE_LEASE_TTL_MS = 10 * 60_000;
export const FAIRUSE_LEASE_RENEW_MS = 5 * 60_000;
export const FAIRUSE_LEASE_QUIESCENCE_MS = 30 * 60_000;
export const FAIRUSE_OBSERVATION_INTERVAL_MS = 60 * 60_000;
export const FAIRUSE_ROOTS_FORMAT_GENERATION = 1;

/** Intersection paging geometry. Production always uses the defaults; it is a parameter
 *  only so a test can exercise the cross-tick resume without seeding 96,001 blob_refs. */
export interface FairUseTuning {
  entitlementPage: number;
  pagesPerTick: number;
}
export const FAIRUSE_DEFAULT_TUNING: FairUseTuning = {
  entitlementPage: FAIRUSE_ENTITLEMENT_PAGE,
  pagesPerTick: FAIRUSE_ENTITLEMENT_PAGES_PER_TICK,
};
const FAIRUSE_PHASE_TICKS_PER_INVOCATION = 8;
const FAIRUSE_INVOCATION_DEADLINE_MS = 20_000;
const SHA_RE = /^[0-9a-f]{64}$/;

export function fairUseQueueStatement(db: D1Database, accountId: string, nowMs: number, reason: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)
     ON CONFLICT(account_id) DO UPDATE SET next_run_at=MIN(fairuse_account_queue.next_run_at,excluded.next_run_at),
       reason=excluded.reason,updated_at=excluded.updated_at`,
  ).bind(accountId, nowMs, reason, nowMs);
}

export function fairUseQueueIfLiveStripeAccountStatement(
  db: D1Database,
  accountId: string,
  stripeCustomerId: string,
  nowMs: number,
  reason: string,
): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at)
     SELECT ?,?,?,? WHERE EXISTS(
       SELECT 1 FROM accounts
       WHERE id=? AND stripe_customer_id=? AND deleted_at IS NULL AND reclaimed_at IS NULL)
     ON CONFLICT(account_id) DO UPDATE SET next_run_at=MIN(fairuse_account_queue.next_run_at,excluded.next_run_at),
       reason=excluded.reason,updated_at=excluded.updated_at`,
  ).bind(accountId, nowMs, reason, nowMs, accountId, stripeCustomerId);
}

// 'classify_entitlements' is retired as a working phase but survives in the type and in
// the live-epoch predicates: an epoch allocated by the pre-deploy code can still be
// sitting in it, and it must be recognised so it can be aborted and drained.
type ScanStatus = "capture_pins" | "materialize_roots" | "classify_entitlements" | "complete" | "aborted_pins";

export interface FairUseLease {
  owner: string;
  epoch: number;
  acquired: number;
  expires: number;
}

interface WorkspaceSnapshot {
  createdAt: number;
  workspaceId: string;
  projectId: string;
}

interface ScanRow {
  account_id: string;
  epoch: number;
  status: ScanStatus;
  plan_snapshot: string;
  workspace_set_snapshot: string;
  workspace_cursor_created_at: number | null;
  workspace_cursor_id: string | null;
  workspace_cursor_project: string | null;
}

/** Only the columns this path reads; the phase queries are `SELECT *`. */
interface StreamRow {
  workspace_id: string;
  project_id: string;
  pin_head: number;
}

interface ProgressRow {
  workspace_id: string;
  cursor_sha: string;
  partial_bytes: number;
  found_refs: number;
}

/** §24 ref carrier as the head-envelope endpoint reports it. Sizes are deliberately
 *  absent: `blobs.size_bytes` is the sole size authority (§2.4). */
export type HeadRefMode =
  | { kind: "inline"; refShas: string[] }
  | { kind: "sidecar"; sidecarSha: string; count: number };

export interface HeadEnvelope {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  empty: boolean;
  encManifestSha: string | null;
  refMode: HeadRefMode | null;
  chainRefs: string[];
}

const canonicalLease = (lease: FairUseLease): string => JSON.stringify({
  owner: lease.owner,
  epoch: lease.epoch,
  acquired: lease.acquired,
  expires: lease.expires,
});

function parseLease(value: string): FairUseLease | null {
  try {
    const parsed = JSON.parse(value) as Partial<FairUseLease>;
    if (Object.keys(parsed).join(",") !== "owner,epoch,acquired,expires" || typeof parsed.owner !== "string" || !parsed.owner
      || !Number.isSafeInteger(parsed.epoch) || Number(parsed.epoch) <= 0
      || !Number.isSafeInteger(parsed.acquired) || Number(parsed.acquired) < 0
      || !Number.isSafeInteger(parsed.expires) || Number(parsed.expires) <= Number(parsed.acquired)) return null;
    return parsed as FairUseLease;
  } catch {
    return null;
  }
}

/** Exact-value lease acquisition. A malformed incumbent fails closed. */
export async function acquireFairUseLease(
  db: D1Database,
  accountId: string,
  epoch: number,
  nowMs: number,
  owner = crypto.randomUUID(),
): Promise<{ lease: FairUseLease; value: string } | null> {
  const lease: FairUseLease = { owner, epoch, acquired: nowMs, expires: nowMs + FAIRUSE_LEASE_TTL_MS };
  const value = canonicalLease(lease);
  await db.prepare("INSERT OR IGNORE INTO fairuse_leases(account_id,value) VALUES(?,?)").bind(accountId, value).run();
  const held = await db.prepare("SELECT value FROM fairuse_leases WHERE account_id=?").bind(accountId).first<{ value: string }>();
  if (!held) return null;
  if (held.value === value) return { lease, value };
  const prior = parseLease(held.value);
  if (!prior || nowMs <= prior.expires + FAIRUSE_LEASE_QUIESCENCE_MS) return null;
  const taken = await db.prepare("UPDATE fairuse_leases SET value=? WHERE account_id=? AND value=?").bind(value, accountId, held.value).run();
  return Number(taken.meta.changes ?? 0) === 1 ? { lease, value } : null;
}

export async function renewFairUseLease(
  db: D1Database,
  accountId: string,
  held: { lease: FairUseLease; value: string },
  nowMs: number,
): Promise<{ lease: FairUseLease; value: string } | null> {
  if (held.lease.expires <= nowMs) return null;
  if (held.lease.expires - nowMs > FAIRUSE_LEASE_RENEW_MS) return held;
  const lease: FairUseLease = { ...held.lease, expires: nowMs + FAIRUSE_LEASE_TTL_MS };
  const value = canonicalLease(lease);
  const renewed = await db.prepare("UPDATE fairuse_leases SET value=? WHERE account_id=? AND value=?").bind(value, accountId, held.value).run();
  return Number(renewed.meta.changes ?? 0) === 1 ? { lease, value } : null;
}

export async function releaseFairUseLease(db: D1Database, accountId: string, value: string): Promise<boolean> {
  const released = await db.prepare("DELETE FROM fairuse_leases WHERE account_id=? AND value=?").bind(accountId, value).run();
  return Number(released.meta.changes ?? 0) === 1;
}

function validNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error("invalid root sha");
  return value;
}

function parseWorkspaceSnapshot(raw: string): WorkspaceSnapshot[] {
  const value = JSON.parse(raw) as unknown;
  if (!Array.isArray(value) || value.length > FAIRUSE_MAX_WORKSPACES) throw new Error("invalid workspace snapshot");
  return value.map((row) => {
    if (!row || typeof row !== "object") throw new Error("invalid workspace snapshot");
    const r = row as Partial<WorkspaceSnapshot>;
    if (!validNonNegativeInt(r.createdAt) || typeof r.workspaceId !== "string" || !r.workspaceId
      || typeof r.projectId !== "string" || !r.projectId) throw new Error("invalid workspace snapshot");
    return r as WorkspaceSnapshot;
  });
}

export function guardSql(alias = "fairuse_scans"): string {
  return `${alias}.account_id=? AND ${alias}.epoch=? AND ${alias}.status=? AND ${alias}.plan_snapshot=? `
    + `AND ${leaseLiveExists(`${alias}.account_id`, "l")}`;
}

function leaseLiveExists(accountIdSql = "?", alias?: string): string {
  const tableAlias = alias ? ` ${alias}` : "";
  const columnPrefix = alias ? `${alias}.` : "";
  return `EXISTS(SELECT 1 FROM fairuse_leases${tableAlias} WHERE ${columnPrefix}account_id=${accountIdSql} `
    + `AND ${columnPrefix}value=? AND CAST(json_extract(${columnPrefix}value,'$.expires') AS INTEGER)`
    + `>CAST((julianday('now')-2440587.5)*86400000 AS INTEGER))`;
}

async function ownsLease(db: D1Database, accountId: string, value: string, nowMs: number): Promise<boolean> {
  const row = await db.prepare("SELECT value FROM fairuse_leases WHERE account_id=? AND value=?").bind(accountId, value).first<{ value: string }>();
  const lease = row ? parseLease(row.value) : null;
  return !!lease && lease.expires > nowMs;
}

async function authoritativeWorkspaces(db: D1Database, accountId: string): Promise<WorkspaceSnapshot[] | null> {
  const rows = await db.prepare(
    "SELECT workspace_id,project_id,created_at FROM workspaces INDEXED BY idx_workspaces_account_scan "
      + "WHERE account_id=? ORDER BY created_at,workspace_id,project_id LIMIT 65",
  ).bind(accountId).all<{ workspace_id: string; project_id: string; created_at: number }>();
  const values = (rows.results ?? []).map((row) => ({
    createdAt: Number(row.created_at), workspaceId: row.workspace_id, projectId: row.project_id,
  }));
  return values.length > FAIRUSE_MAX_WORKSPACES ? null : values;
}

function sameWorkspaceSet(a: WorkspaceSnapshot[], b: WorkspaceSnapshot[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---- head envelope (design 225 §2.6) ----

/**
 * ONE atomic, read-only DO read of what HEAD references. Never the best-effort D1
 * `commits` mirror (bytes from a stale mirror would not match the recorded pin) and
 * never the positional, bootstrap-gated `/latest`.
 */
export async function readHeadEnvelope(
  env: Env,
  workspace: { workspaceId: string; projectId: string },
): Promise<HeadEnvelope> {
  const q = new URLSearchParams({ head: "1", ws: workspace.workspaceId, proj: workspace.projectId });
  const id = env.WORKSPACE_SYNC.idFromName(`${workspace.workspaceId}/${workspace.projectId}`);
  const response = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/roots-inspect?${q}`, { method: "GET" });
  if (!response.ok) throw new Error(`roots_inspect_head_${response.status}`);
  return parseHeadEnvelope(await response.json());
}

export function parseHeadEnvelope(raw: unknown): HeadEnvelope {
  const body = (raw ?? {}) as Partial<HeadEnvelope>;
  if (!validNonNegativeInt(body.head) || !validNonNegativeInt(body.pruneFloor) || body.pruneFloor > body.head
    || !validNonNegativeInt(body.indexGeneration) || typeof body.empty !== "boolean"
    || !Array.isArray(body.chainRefs) || body.chainRefs.length > MAX_MANIFEST_DELTA_CHAIN) {
    throw new Error("invalid head envelope");
  }
  const base = { head: body.head, pruneFloor: body.pruneFloor, indexGeneration: body.indexGeneration };
  if (body.empty) {
    if (body.refMode != null || body.encManifestSha != null || body.chainRefs.length !== 0) throw new Error("invalid head envelope");
    return { ...base, empty: true, encManifestSha: null, refMode: null, chainRefs: [] };
  }
  const chainRefs = body.chainRefs.map(requireSha);
  const encManifestSha = requireSha(body.encManifestSha);
  const mode = body.refMode;
  if (!mode || typeof mode !== "object") throw new Error("invalid head envelope");
  if (mode.kind === "inline") {
    if (!Array.isArray(mode.refShas)) throw new Error("invalid head envelope");
    return { ...base, empty: false, encManifestSha, refMode: { kind: "inline", refShas: mode.refShas.map(requireSha) }, chainRefs };
  }
  if (mode.kind === "sidecar" && validNonNegativeInt(mode.count)) {
    return { ...base, empty: false, encManifestSha, refMode: { kind: "sidecar", sidecarSha: requireSha(mode.sidecarSha), count: mode.count }, chainRefs };
  }
  throw new Error("invalid head envelope");
}

/**
 * `refs(head)` for one project — parity with the DO's own `refSetAt`, NOT with the
 * sidecar refset. Below SIDECAR_THRESHOLD there is no sidecar at all (a sidecar-only
 * algorithm returns ZERO for every small workspace), and the chain refs, the
 * encManifestSha and the sidecar carrier all sit outside `blobRefset`.
 */
export async function headRefSet(
  env: Env,
  envelope: HeadEnvelope,
  into: Set<string> = new Set(),
): Promise<{ ok: true; refs: Set<string> } | { ok: false; stale: true } | { ok: false; corrupt: string }> {
  if (envelope.empty || !envelope.refMode || envelope.encManifestSha === null) return { ok: true, refs: into };
  into.add(envelope.encManifestSha);
  for (const sha of envelope.chainRefs) into.add(sha);
  if (envelope.refMode.kind === "inline") {
    for (const sha of envelope.refMode.refShas) into.add(sha);
    return { ok: true, refs: into };
  }
  into.add(envelope.refMode.sidecarSha);
  // One whole-object, hash-VERIFIED read (never ranged records, never an incremental
  // digest): for a billing input, undetectable end-to-end corruption is disqualifying.
  const loaded = await loadSidecarShaSet(env, envelope.refMode.sidecarSha, envelope.refMode.count);
  if (!loaded.ok) return loaded.reason === "missing" ? { ok: false, stale: true } : { ok: false, corrupt: loaded.reason };
  for (const sha of loaded.refs) into.add(sha);
  return { ok: true, refs: into };
}

/** Declared cardinality from the ENVELOPES alone, so an over-cap group costs K cheap DO
 *  reads and zero R2 bytes. Both approximations here (pre-dedup sum; 2 carriers in
 *  sidecar mode, 1 inline) can only reject a group that would in fact have fit. */
export function declaredRefCount(envelopes: Iterable<HeadEnvelope>): number {
  let total = 0;
  for (const envelope of envelopes) {
    if (envelope.empty || !envelope.refMode) continue;
    total += envelope.chainRefs.length + 1; // encManifestSha is always a carrier
    total += envelope.refMode.kind === "inline" ? envelope.refMode.refShas.length : envelope.refMode.count + 1;
  }
  return total;
}

// ---- scan allocation ----

async function planSnapshot(env: Env, accountId: string): Promise<{ snapshot: string; graceUntil: number | null }> {
  const row = await dbFor(env, accountId).prepare(
    "SELECT plan,grace_until,extra_storage_bytes FROM accounts WHERE id=?",
  ).bind(accountId).first<{ plan: string | null; grace_until: number | null; extra_storage_bytes: number }>();
  if (!row) throw new Error("account_missing");
  const resolvedPlan = await resolveAccountPlan(env, accountId, row.plan);
  const plan = planFor(resolvedPlan);
  return {
    snapshot: JSON.stringify({
      resolvedPlan,
      graceUntil: row.grace_until ?? null,
      retentionDays: plan.retentionDays,
      storageBytes: Number.isFinite(plan.storageBytes) ? plan.storageBytes : null,
      extraStorageBytes: Number(row.extra_storage_bytes ?? 0),
    }),
    graceUntil: row.grace_until ?? null,
  };
}

async function nextEpoch(db: D1Database, accountId: string): Promise<number> {
  const live = await db.prepare(
    "SELECT epoch FROM fairuse_scans WHERE account_id=? AND status IN ('capture_pins','materialize_roots','classify_entitlements') ORDER BY epoch DESC LIMIT 1",
  ).bind(accountId).first<{ epoch: number }>();
  if (live) return Number(live.epoch);
  const row = await db.prepare("SELECT COALESCE(MAX(epoch),0)+1 AS epoch FROM fairuse_scans WHERE account_id=?").bind(accountId).first<{ epoch: number }>();
  return Number(row?.epoch ?? 1);
}

async function allocateScan(
  env: Env,
  accountId: string,
  epoch: number,
  leaseValue: string,
  nowMs: number,
): Promise<{ scan: ScanRow; allocated: boolean } | { requeueReason: "fairuse_workspace_limit" | "fairuse_lease_lost" }> {
  const db = dbFor(env, accountId);
  const existing = await db.prepare(
    "SELECT * FROM fairuse_scans WHERE account_id=? AND epoch=? AND status IN ('capture_pins','materialize_roots','classify_entitlements')",
  ).bind(accountId, epoch).first<ScanRow>();
  if (existing) return { scan: existing, allocated: false };
  const workspaces = await authoritativeWorkspaces(db, accountId);
  if (!workspaces) return { requeueReason: "fairuse_workspace_limit" };
  const plan = await planSnapshot(env, accountId);
  const snapshot = JSON.stringify(workspaces);
  await db.prepare(
    `INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,grace_until_snapshot,roots_format_generation,
       workspace_set_snapshot,started_at,updated_at)
     SELECT ?,?,'capture_pins',?,?,?, ?,?,?
     WHERE ${leaseLiveExists()}`,
  ).bind(accountId, epoch, plan.snapshot, plan.graceUntil, FAIRUSE_ROOTS_FORMAT_GENERATION, snapshot, nowMs, nowMs, accountId, leaseValue).run();
  const scan = await db.prepare("SELECT * FROM fairuse_scans WHERE account_id=? AND epoch=?").bind(accountId, epoch).first<ScanRow>();
  return scan ? { scan, allocated: true } : { requeueReason: "fairuse_lease_lost" };
}

function workspaceAfterCursor(workspaces: WorkspaceSnapshot[], scan: ScanRow): WorkspaceSnapshot[] {
  return workspaces.filter((workspace) => {
    if (scan.workspace_cursor_created_at == null) return true;
    if (workspace.createdAt !== scan.workspace_cursor_created_at) return workspace.createdAt > scan.workspace_cursor_created_at;
    if (workspace.workspaceId !== scan.workspace_cursor_id) return workspace.workspaceId > String(scan.workspace_cursor_id);
    return workspace.projectId > String(scan.workspace_cursor_project);
  });
}

async function capturePins(env: Env, scan: ScanRow, leaseValue: string, nowMs: number): Promise<"incomplete" | "advanced"> {
  const db = dbFor(env, scan.account_id);
  const workspaces = parseWorkspaceSnapshot(scan.workspace_set_snapshot);
  const page = workspaceAfterCursor(workspaces, scan).slice(0, FAIRUSE_PIN_PAGE);
  const pins: Array<{ workspace: WorkspaceSnapshot; envelope: HeadEnvelope }> = [];
  for (const workspace of page) pins.push({ workspace, envelope: await readHeadEnvelope(env, workspace) });
  if (!(await ownsLease(db, scan.account_id, leaseValue, nowMs))) return "incomplete";

  const statements = pins.map(({ workspace, envelope }) => db.prepare(
    `INSERT INTO fairuse_workspace_streams(account_id,epoch,workspace_id,project_id,pin_head,pin_floor,pin_generation,
       pin_roots_format_generation,updated_at)
     SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
       SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
  ).bind(
    scan.account_id, scan.epoch, workspace.workspaceId, workspace.projectId,
    envelope.head, envelope.pruneFloor, envelope.indexGeneration, FAIRUSE_ROOTS_FORMAT_GENERATION, nowMs,
    scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
  ));
  const last = page.at(-1);
  const done = page.length < FAIRUSE_PIN_PAGE && workspaceAfterCursor(workspaces, scan).length === page.length;
  statements.push(db.prepare(
    `UPDATE fairuse_scans SET workspace_cursor_created_at=?,workspace_cursor_id=?,workspace_cursor_project=?,
       status=?,updated_at=? WHERE ${guardSql()}`,
  ).bind(
    last?.createdAt ?? scan.workspace_cursor_created_at,
    last?.workspaceId ?? scan.workspace_cursor_id,
    last?.projectId ?? scan.workspace_cursor_project,
    done ? "materialize_roots" : "capture_pins", nowMs,
    scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
  ));
  await db.batch(statements);
  return done ? "advanced" : "incomplete";
}

async function markAbortedEpoch(db: D1Database, scan: ScanRow, leaseValue: string, nowMs: number): Promise<void> {
  await db.prepare(`UPDATE fairuse_scans SET status='aborted_pins',completed_at=NULL,pruning_active=0,updated_at=? WHERE ${guardSql()}`)
    .bind(nowMs, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue).run();
}

// ---- the group pass (design 225 §2.3–§2.5) ----

/** Drain order. ONE list: the same names decide whether an aborted epoch still has
 *  residue and which relation `cleanupAbortedPage` pages out next, so a table can never
 *  be detected as residue that nothing drains (which would spin the account forever). */
const ABORT_RESIDUE_TABLES = [
  "fairuse_materialize_refs", "fairuse_root_membership", "fairuse_sha_last",
  "fairuse_group_progress", "fairuse_workspace_group_totals", "fairuse_workspace_streams",
] as const;
type AbortResidueTable = typeof ABORT_RESIDUE_TABLES[number];

/**
 * ONE workspace-group per pass: union its K projects' `refs(head)` into ONE in-memory
 * set, intersect that set ONCE against `blob_refs`, write ONE totals row. Per-workspace
 * ref sets are disjoint by construction (the KEK is per workspace, so the DEK, the
 * ciphertext and therefore the encSha differ), so the account total is a plain SUM and
 * dedup applies only INSIDE a group.
 *
 * The captured head envelope IS the accepted snapshot: no post-computation head
 * re-check, no retry on head move. The only retry is the stale-sidecar case.
 */
async function groupPass(env: Env, scan: ScanRow, leaseValue: string, nowMs: number, tuning: FairUseTuning): Promise<"incomplete" | "advanced"> {
  const db = dbFor(env, scan.account_id);
  const saved = parseWorkspaceSnapshot(scan.workspace_set_snapshot);
  const reads = await db.batch([
    db.prepare(
      "SELECT workspace_id,project_id,created_at FROM workspaces INDEXED BY idx_workspaces_account_scan "
        + "WHERE account_id=? ORDER BY created_at,workspace_id,project_id LIMIT 65",
    ).bind(scan.account_id),
    db.prepare("SELECT * FROM fairuse_workspace_streams WHERE account_id=? AND epoch=? ORDER BY workspace_id,project_id")
      .bind(scan.account_id, scan.epoch),
    db.prepare("SELECT workspace_id FROM fairuse_workspace_group_totals WHERE account_id=? AND epoch=?")
      .bind(scan.account_id, scan.epoch),
    db.prepare("SELECT workspace_id,cursor_sha,partial_bytes,found_refs FROM fairuse_group_progress WHERE account_id=? AND epoch=?")
      .bind(scan.account_id, scan.epoch),
  ]);
  const currentRows = (reads[0]?.results ?? []) as Array<{ workspace_id: string; project_id: string; created_at: number }>;
  const streams = (reads[1]?.results ?? []) as unknown as StreamRow[];
  const totalled = new Set(((reads[2]?.results ?? []) as Array<{ workspace_id: string }>).map((row) => row.workspace_id));
  const progressRows = (reads[3]?.results ?? []) as unknown as ProgressRow[];

  // The workspace-SET aborts are preserved verbatim: they concern a wrong root SET,
  // not a stale one, and head movement no longer aborts anything.
  const current = currentRows.length > FAIRUSE_MAX_WORKSPACES ? null : currentRows.map((row) => ({
    createdAt: Number(row.created_at), workspaceId: row.workspace_id, projectId: row.project_id,
  }));
  const savedKeys = new Set(saved.map((workspace) => `${workspace.workspaceId}\n${workspace.projectId}`));
  if (!current || !sameWorkspaceSet(saved, current) || streams.length !== saved.length
    || streams.some((stream) => !savedKeys.has(`${stream.workspace_id}\n${stream.project_id}`))) {
    await markAbortedEpoch(db, scan, leaseValue, nowMs);
    return "advanced";
  }

  // Selection is by ABSENCE of a totals row, never by roots_done: a stream marked done
  // by the pre-deploy walk wrote membership rows, not a totals row, and skipping it
  // would silently undercount its whole group.
  const groups = [...new Set(streams.map((stream) => stream.workspace_id))].sort();
  const target = groups.find((workspaceId) => !totalled.has(workspaceId));
  if (target === undefined) return completeScan(db, scan, leaseValue, nowMs);
  const group = streams.filter((stream) => stream.workspace_id === target);
  let progress = progressRows.find((row) => row.workspace_id === target) ?? null;

  let envelopes = await readGroupEnvelopes(env, group);
  let refs: Set<string> | null = null;
  for (let attempt = 1; attempt <= FAIRUSE_SIDECAR_STALE_ATTEMPTS; attempt++) {
    const declared = declaredRefCount(envelopes.values());
    if (declared > FAIRUSE_GROUP_REF_CAP) {
      metric(env, "fairuse.active.group_cap_exceeded", declared, 0, "abort");
      await markAbortedEpoch(db, scan, leaseValue, nowMs);
      return "advanced";
    }
    if (declared * 2 >= FAIRUSE_GROUP_REF_CAP) metric(env, "fairuse.active.group_cap_warning", declared);
    const built = await materializeGroupRefs(env, envelopes);
    if (built.ok) {
      refs = built.refs;
      break;
    }
    if ("corrupt" in built) {
      // A sha/size/parse disagreement cannot be explained by a head advance.
      metric(env, "fairuse.active.sidecar_corrupt", 0, 0, "abort");
      await markAbortedEpoch(db, scan, leaseValue, nowMs);
      return "advanced";
    }
    metric(env, "fairuse.active.sidecar_stale_retry", attempt);
    if (attempt === FAIRUSE_SIDECAR_STALE_ATTEMPTS) {
      await markAbortedEpoch(db, scan, leaseValue, nowMs);
      return "advanced";
    }
    // Retention unrooted a superseded sidecar between the head read and the R2 GET.
    // Re-read the head; the NEW response becomes the accepted snapshot.
    envelopes = await readGroupEnvelopes(env, group);
    progress = null;
  }
  if (!refs) return "incomplete";

  // Resume validity (NOT a head-stability retry): if head moved under a partially
  // paged group, restart it from cursor 0 against the new snapshot. A group's bytes
  // always describe ONE consistent snapshot; a partial sum is discarded, never merged.
  const moved = group.some((stream) => envelopes.get(stream.project_id)!.head !== stream.pin_head);
  // An empty group intersects nothing, so its total is a computed 0 — reached without
  // paging the whole account's blob_refs to rediscover that, and without any partial.
  if (moved || refs.size === 0) progress = null;
  const restarted = progress === null;

  let cursor = progress?.cursor_sha ?? "";
  let partial = Number(progress?.partial_bytes ?? 0);
  let found = Number(progress?.found_refs ?? 0);
  let paged = refs.size === 0;
  for (let page = 0; !paged && page < tuning.pagesPerTick; page++) {
    const rows = await db.prepare(
      `SELECT r.sha256,b.size_bytes
         FROM blob_refs r INDEXED BY sqlite_autoindex_blob_refs_1
         LEFT JOIN blobs b INDEXED BY sqlite_autoindex_blobs_1 ON b.sha256=r.sha256
        WHERE r.account_id=? AND r.sha256>? ORDER BY r.sha256 LIMIT ?`,
    ).bind(scan.account_id, cursor, tuning.entitlementPage + 1).all<{ sha256: string; size_bytes: number | null }>();
    const results = rows.results ?? [];
    const window = results.slice(0, tuning.entitlementPage);
    for (const row of window) {
      if (!refs.has(row.sha256)) continue;
      // `blobs.size_bytes` is the SOLE size authority; an entitled head ref with no
      // catalog row would silently contribute 0, so it fails closed instead.
      if (row.size_bytes == null) throw new Error("fairuse_catalog_missing");
      partial += Number(row.size_bytes);
      found++;
    }
    if (results.length <= tuning.entitlementPage) {
      paged = true;
      break;
    }
    cursor = window.at(-1)!.sha256;
  }

  const guard = [scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue] as const;
  const statements: D1PreparedStatement[] = [];
  if (restarted) {
    for (const stream of group) {
      const envelope = envelopes.get(stream.project_id)!;
      statements.push(db.prepare(
        `UPDATE fairuse_workspace_streams SET pin_head=?,pin_floor=?,pin_generation=?,updated_at=?
           WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
           AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
      ).bind(
        envelope.head, envelope.pruneFloor, envelope.indexGeneration, nowMs,
        scan.account_id, scan.epoch, stream.workspace_id, stream.project_id, ...guard,
      ));
    }
  }
  if (paged) {
    const missing = refs.size - found;
    if (missing > 0) {
      metric(env, "fairuse.active.entitlement_missing", missing, 0, "anomaly");
      statements.push(db.prepare(
        `UPDATE fairuse_scans SET entitlement_missing_count=entitlement_missing_count+?,updated_at=? WHERE ${guardSql()}`,
      ).bind(missing, nowMs, ...guard));
    }
    statements.push(db.prepare(
      `INSERT INTO fairuse_workspace_group_totals(account_id,epoch,workspace_id,active_bytes,updated_at)
       SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
    ).bind(scan.account_id, scan.epoch, target, partial, nowMs, ...guard));
    statements.push(db.prepare(
      `DELETE FROM fairuse_group_progress WHERE account_id=? AND epoch=? AND workspace_id=?
         AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
    ).bind(scan.account_id, scan.epoch, target, ...guard));
    for (const stream of group) {
      statements.push(db.prepare(
        `UPDATE fairuse_workspace_streams SET roots_done=1,pins_verified=1,updated_at=?
           WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
           AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
      ).bind(nowMs, scan.account_id, scan.epoch, stream.workspace_id, stream.project_id, ...guard));
    }
  } else {
    statements.push(db.prepare(
      `INSERT INTO fairuse_group_progress(account_id,epoch,workspace_id,cursor_sha,partial_bytes,found_refs,updated_at)
       SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})
       ON CONFLICT(account_id,epoch,workspace_id) DO UPDATE SET cursor_sha=excluded.cursor_sha,
         partial_bytes=excluded.partial_bytes,found_refs=excluded.found_refs,updated_at=excluded.updated_at`,
    ).bind(scan.account_id, scan.epoch, target, cursor, partial, found, nowMs, ...guard));
  }
  await db.batch(statements);
  return "incomplete";
}

async function readGroupEnvelopes(env: Env, group: StreamRow[]): Promise<Map<string, HeadEnvelope>> {
  const envelopes = new Map<string, HeadEnvelope>();
  for (const stream of group) {
    envelopes.set(stream.project_id, await readHeadEnvelope(env, { workspaceId: stream.workspace_id, projectId: stream.project_id }));
  }
  return envelopes;
}

async function materializeGroupRefs(
  env: Env,
  envelopes: Map<string, HeadEnvelope>,
): Promise<{ ok: true; refs: Set<string> } | { ok: false; stale: true } | { ok: false; corrupt: string }> {
  const refs = new Set<string>();
  for (const envelope of envelopes.values()) {
    const built = await headRefSet(env, envelope, refs);
    if (!built.ok) return built;
  }
  return { ok: true, refs };
}

/**
 * The SINGLE site that writes `fairuse_scans.active_bytes` — billing reads that column,
 * so a SUM computed but never written reports 0. `bound_bytes` is a literal 0: this path
 * never computes history, and a bound derived from an uncomputed history is fabricated
 * (it would also read the PRE-update active_bytes, since every SET in one UPDATE
 * evaluates against the old row).
 */
async function completeScan(db: D1Database, scan: ScanRow, leaseValue: string, nowMs: number): Promise<"incomplete" | "advanced"> {
  const completed = await db.prepare(
    `UPDATE fairuse_scans SET status='complete',completed_at=?,updated_at=?,bound_bytes=0,pruning_active=0,
       history_computed=0,
       active_bytes=(SELECT COALESCE(SUM(t.active_bytes),0) FROM fairuse_workspace_group_totals t
         WHERE t.account_id=fairuse_scans.account_id AND t.epoch=fairuse_scans.epoch)
     WHERE ${guardSql()}
       AND (SELECT COUNT(*) FROM workspaces w WHERE w.account_id=fairuse_scans.account_id)<=64
       AND NOT EXISTS(
         SELECT 1 FROM workspaces w WHERE w.account_id=fairuse_scans.account_id AND NOT EXISTS(
           SELECT 1 FROM json_each(fairuse_scans.workspace_set_snapshot) j
           WHERE json_extract(j.value,'$.createdAt')=w.created_at
             AND json_extract(j.value,'$.workspaceId')=w.workspace_id
             AND json_extract(j.value,'$.projectId')=w.project_id))
       AND NOT EXISTS(
         SELECT 1 FROM json_each(fairuse_scans.workspace_set_snapshot) j WHERE NOT EXISTS(
           SELECT 1 FROM workspaces w WHERE w.account_id=fairuse_scans.account_id
             AND w.created_at=json_extract(j.value,'$.createdAt')
             AND w.workspace_id=json_extract(j.value,'$.workspaceId')
             AND w.project_id=json_extract(j.value,'$.projectId')))
       AND NOT EXISTS(
         SELECT 1 FROM fairuse_workspace_streams ws WHERE ws.account_id=fairuse_scans.account_id AND ws.epoch=fairuse_scans.epoch
           AND (ws.pins_verified<>1 OR NOT EXISTS(
             SELECT 1 FROM json_each(fairuse_scans.workspace_set_snapshot) j
             WHERE json_extract(j.value,'$.workspaceId')=ws.workspace_id
               AND json_extract(j.value,'$.projectId')=ws.project_id)))
       AND NOT EXISTS(
         SELECT 1 FROM json_each(fairuse_scans.workspace_set_snapshot) j WHERE NOT EXISTS(
           SELECT 1 FROM fairuse_workspace_streams ws WHERE ws.account_id=fairuse_scans.account_id
             AND ws.epoch=fairuse_scans.epoch
             AND ws.workspace_id=json_extract(j.value,'$.workspaceId')
             AND ws.project_id=json_extract(j.value,'$.projectId')))
       AND NOT EXISTS(
         SELECT 1 FROM fairuse_workspace_streams ws WHERE ws.account_id=fairuse_scans.account_id AND ws.epoch=fairuse_scans.epoch
           AND NOT EXISTS(
             SELECT 1 FROM fairuse_workspace_group_totals t WHERE t.account_id=ws.account_id
               AND t.epoch=ws.epoch AND t.workspace_id=ws.workspace_id))`,
  ).bind(nowMs, nowMs, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue).run();
  return Number(completed.meta.changes ?? 0) === 1 ? "advanced" : "incomplete";
}

/** Delete at most one 600-row relation page. The aborted scan row remains as audit evidence.
 *  The three membership relations are no longer WRITTEN, but they stay here so an epoch
 *  aborted by the pre-deploy code path still drains after deploy. */
async function cleanupAbortedPage(db: D1Database, scan: ScanRow, leaseValue: string): Promise<boolean> {
  const relation = await db.prepare(
    `SELECT CASE ${ABORT_RESIDUE_TABLES.map((table) =>
      `WHEN EXISTS(SELECT 1 FROM ${table} WHERE account_id=? AND epoch=?) THEN '${table}'`).join(" ")
    } ELSE 'done' END AS relation`,
  ).bind(...ABORT_RESIDUE_TABLES.flatMap(() => [scan.account_id, scan.epoch]))
    .first<{ relation: AbortResidueTable | "done" }>();
  if (!relation || relation.relation === "done") return true;
  const guard = [scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue] as const;
  const exists = `EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`;
  if (relation.relation === "fairuse_materialize_refs") {
    await db.prepare(`DELETE FROM fairuse_materialize_refs WHERE (account_id,epoch,workspace_id,project_id,sequence,sha256) IN (
      SELECT account_id,epoch,workspace_id,project_id,sequence,sha256 FROM fairuse_materialize_refs
      WHERE account_id=? AND epoch=? ORDER BY workspace_id,project_id,sequence,sha256 LIMIT 600) AND ${exists}`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  } else if (relation.relation === "fairuse_root_membership") {
    await db.prepare(`DELETE FROM fairuse_root_membership WHERE rowid IN (
      SELECT rowid FROM fairuse_root_membership WHERE account_id=? AND epoch=? ORDER BY rowid LIMIT 600) AND ${exists}`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  } else if (relation.relation === "fairuse_sha_last") {
    await db.prepare(`DELETE FROM fairuse_sha_last WHERE (account_id,epoch,sha256) IN (
      SELECT account_id,epoch,sha256 FROM fairuse_sha_last WHERE account_id=? AND epoch=? ORDER BY sha256 LIMIT 600) AND ${exists}`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  } else if (relation.relation === "fairuse_group_progress") {
    await db.prepare(`DELETE FROM fairuse_group_progress WHERE (account_id,epoch,workspace_id) IN (
      SELECT account_id,epoch,workspace_id FROM fairuse_group_progress WHERE account_id=? AND epoch=? ORDER BY workspace_id LIMIT 600)
      AND ${exists}`).bind(scan.account_id, scan.epoch, ...guard).run();
  } else if (relation.relation === "fairuse_workspace_group_totals") {
    await db.prepare(`DELETE FROM fairuse_workspace_group_totals WHERE (account_id,epoch,workspace_id) IN (
      SELECT account_id,epoch,workspace_id FROM fairuse_workspace_group_totals WHERE account_id=? AND epoch=? ORDER BY workspace_id LIMIT 600)
      AND ${exists}`).bind(scan.account_id, scan.epoch, ...guard).run();
  } else {
    await db.prepare(`DELETE FROM fairuse_workspace_streams WHERE rowid IN (
      SELECT rowid FROM fairuse_workspace_streams WHERE account_id=? AND epoch=? ORDER BY workspace_id,project_id LIMIT 600) AND ${exists}`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  }
  return false;
}

async function discoverOneAccount(db: D1Database, nowMs: number): Promise<void> {
  const scheduler = await db.prepare("SELECT account_cursor FROM fairuse_scheduler WHERE singleton=1").first<{ account_cursor: string | null }>();
  const cursor = scheduler?.account_cursor ?? "";
  let account = await db.prepare("SELECT id FROM accounts WHERE id>? AND deleted_at IS NULL ORDER BY id LIMIT 1").bind(cursor).first<{ id: string }>();
  if (!account && cursor) account = await db.prepare("SELECT id FROM accounts WHERE deleted_at IS NULL ORDER BY id LIMIT 1").first<{ id: string }>();
  const statements: D1PreparedStatement[] = [];
  if (!scheduler) statements.push(db.prepare("INSERT OR IGNORE INTO fairuse_scheduler(singleton,account_cursor,updated_at) VALUES(1,NULL,?)").bind(nowMs));
  if (account) {
    statements.push(db.prepare("UPDATE fairuse_scheduler SET account_cursor=?,updated_at=? WHERE singleton=1").bind(account.id, nowMs));
    statements.push(db.prepare(
      "INSERT OR IGNORE INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)",
    ).bind(account.id, nowMs, "scheduler", nowMs));
  } else if (scheduler) {
    statements.push(db.prepare("UPDATE fairuse_scheduler SET account_cursor=NULL,updated_at=? WHERE singleton=1").bind(nowMs));
  }
  if (statements.length) await db.batch(statements);
}

/** One globally bounded scheduler turn and up to eight account phase ticks. */
export async function runFairUseObservation(env: Env, nowMs: number = Date.now(), tuning: FairUseTuning = FAIRUSE_DEFAULT_TUNING): Promise<void> {
  const deadline = Date.now() + FAIRUSE_INVOCATION_DEADLINE_MS;
  const globalDb = dbFor(env, "");
  await discoverOneAccount(globalDb, nowMs);
  const due = await globalDb.prepare(
    "SELECT account_id FROM fairuse_account_queue WHERE next_run_at<=? ORDER BY next_run_at,account_id LIMIT ?",
  ).bind(nowMs, FAIRUSE_ACCOUNTS_PER_TICK).first<{ account_id: string }>();
  if (!due) return;
  const accountId = due.account_id;
  const db = dbFor(env, accountId);
  const aborted = await db.prepare(
    `SELECT * FROM fairuse_scans s WHERE s.account_id=? AND s.status='aborted_pins' AND (${
      ABORT_RESIDUE_TABLES.map((table) => `EXISTS(SELECT 1 FROM ${table} r WHERE r.account_id=s.account_id AND r.epoch=s.epoch)`).join(" OR ")
    }) ORDER BY s.epoch LIMIT 1`,
  ).bind(accountId).first<ScanRow>();
  const leaseEpoch = aborted?.epoch ?? await nextEpoch(db, accountId);
  let held = await acquireFairUseLease(db, accountId, leaseEpoch, nowMs);
  if (!held) return;
  const epoch = aborted?.epoch ?? await nextEpoch(db, accountId);
  let terminal = false;
  try {
    if (aborted) {
      await cleanupAbortedPage(db, aborted, held.value);
      await db.prepare(
        `UPDATE fairuse_account_queue SET next_run_at=?,reason='abort_cleanup',updated_at=? WHERE account_id=?
         AND ${leaseLiveExists()}`,
      ).bind(nowMs, nowMs, accountId, accountId, held.value).run();
      return;
    }
    const allocated = await allocateScan(env, accountId, epoch, held.value, nowMs);
    if ("requeueReason" in allocated) {
      await db.prepare(`UPDATE fairuse_account_queue SET next_run_at=?,reason=?,updated_at=? WHERE account_id=?
        AND ${leaseLiveExists()}`)
        .bind(nowMs + FAIRUSE_OBSERVATION_INTERVAL_MS, allocated.requeueReason, nowMs, accountId, accountId, held.value).run();
      return;
    }
    if (allocated.allocated) {
      await db.prepare(
        `UPDATE fairuse_account_queue SET next_run_at=?,reason='scan_allocated',updated_at=? WHERE account_id=?
         AND ${leaseLiveExists()}`,
      ).bind(nowMs, nowMs, accountId, accountId, held.value).run();
    }
    for (let tick = 0; tick < FAIRUSE_PHASE_TICKS_PER_INVOCATION && Date.now() < deadline; tick++) {
      if (tick > 0) {
        const iterationNow = Date.now();
        held = await renewFairUseLease(db, accountId, held, iterationNow);
        if (!held || !(await ownsLease(db, accountId, held.value, iterationNow))) return;
      }
      const scan = await db.prepare("SELECT * FROM fairuse_scans WHERE account_id=? AND epoch=?").bind(accountId, epoch).first<ScanRow>();
      if (!scan || scan.status === "complete" || scan.status === "aborted_pins") {
        terminal = true;
        break;
      }
      if (scan.status === "capture_pins") await capturePins(env, scan, held.value, nowMs);
      else if (scan.status === "materialize_roots") await groupPass(env, scan, held.value, nowMs, tuning);
      // A pre-deploy epoch parked in the retired phase measured history against
      // membership tables this code no longer writes. Abort it so the residue drains
      // and the next hourly scan starts clean, rather than completing on stale rows.
      else if (scan.status === "classify_entitlements") await markAbortedEpoch(db, scan, held.value, nowMs);
      const state = await db.prepare("SELECT status FROM fairuse_scans WHERE account_id=? AND epoch=?").bind(accountId, epoch).first<{ status: string }>();
      if (state?.status === "complete" || state?.status === "aborted_pins") {
        terminal = true;
        break;
      }
    }
    const state = await db.prepare("SELECT status FROM fairuse_scans WHERE account_id=? AND epoch=?").bind(accountId, epoch).first<{ status: string }>();
    terminal = terminal || state?.status === "complete" || state?.status === "aborted_pins";
    // aborted_pins ends the phase loop but the account stays due NOW: the next
    // invocation's aborted branch pages the residue out. Only 'complete' rests.
    const rest = state?.status === "complete";
    await db.prepare(
      `UPDATE fairuse_account_queue SET next_run_at=?,reason=?,updated_at=? WHERE account_id=?
       AND ${leaseLiveExists()}`,
    ).bind(rest ? nowMs + FAIRUSE_OBSERVATION_INTERVAL_MS : nowMs,
      state?.status === "aborted_pins" ? "abort_cleanup" : terminal ? String(state?.status ?? "terminal") : "scan", nowMs,
      accountId, accountId, held.value).run();
  } catch (error) {
    if (held) {
      if (error instanceof Error && error.message === "account_missing") {
        await db.prepare(
          `DELETE FROM fairuse_account_queue WHERE account_id=? AND ${leaseLiveExists()}`,
        ).bind(accountId, accountId, held.value).run().catch(() => undefined);
      } else {
        await db.prepare(
          `UPDATE fairuse_account_queue SET next_run_at=?,reason='scan_error',updated_at=? WHERE account_id=?
           AND ${leaseLiveExists()}`,
        ).bind(nowMs + FAIRUSE_OBSERVATION_INTERVAL_MS, nowMs, accountId, accountId, held.value).run().catch(() => undefined);
      }
    }
    throw error;
  } finally {
    if (held) await releaseFairUseLease(db, accountId, held.value).catch(() => false);
  }
}
