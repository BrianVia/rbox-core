import type { Env } from "./env.js";
import { dbFor } from "./db.js";
import { resolveAccountPlan } from "./retention.js";
import { planFor } from "./plans.js";
import { bytes32ToHex, REFSET_HEADER, REFSET_MAGIC, REFSET_REC, refsetByteLength } from "../../../src/engine/refset.js";
import { blobKey } from "./util.js";

export const FAIRUSE_MAX_WORKSPACES = 64;
export const FAIRUSE_ACCOUNTS_PER_TICK = 1;
export const FAIRUSE_PIN_PAGE = 8;
export const FAIRUSE_ROOT_STAGE_ROWS = 600;
export const FAIRUSE_ROOT_OUTPUT_ROWS = 200;
export const FAIRUSE_ENTITLEMENT_PAGE = 2_000;
export const FAIRUSE_LEASE_TTL_MS = 10 * 60_000;
export const FAIRUSE_LEASE_RENEW_MS = 5 * 60_000;
export const FAIRUSE_LEASE_QUIESCENCE_MS = 30 * 60_000;
export const FAIRUSE_OBSERVATION_INTERVAL_MS = 60 * 60_000;
export const FAIRUSE_ROOTS_FORMAT_GENERATION = 1;
const FAIRUSE_PHASE_TICKS_PER_INVOCATION = 8;
const FAIRUSE_INVOCATION_DEADLINE_MS = 20_000;
const FAIRUSE_BOUND_FLOOR = 1_073_741_824;
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

interface Pin {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  rootsFormatGeneration: number;
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
  entitlement_cursor_sha: string | null;
  verify_cursor_id: string | null;
  verify_cursor_project: string | null;
  active_bytes: number;
  history_bytes: number;
}

interface StreamRow {
  workspace_id: string;
  project_id: string;
  pin_head: number;
  pin_floor: number;
  pin_generation: number;
  pin_roots_format_generation: number;
  roots_cursor: string | null;
  materialize_cursor: string | null;
  roots_done: number;
}

interface RootsCursor {
  fromSha: string;
  fromSeq: string;
  fromGapSeq: string;
}

interface RootEntry {
  seq: number;
  head: boolean;
  committedAt: number | null;
  timestampGap: boolean;
  refs: Array<{ sha: string; size: number }>;
  sidecar?: { sha: string; count: number; totalBytes: number };
}

interface PendingPage {
  v: 1;
  phase: "stage" | "output";
  sourceCursor: RootsCursor;
  rootsNext: RootsCursor;
  rootsDone: boolean;
  entries: RootEntry[];
  entryIndex: number;
  offset: number;
  sidecarSum: number;
  sidecarPreviousSha: string;
}

interface MaterializeCursor {
  seq: number;
  carrierOrd: number;
  pageToken: string;
}

interface RootsBody {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  rootsFormatGeneration?: number;
  droppedPage?: Array<{ sha: string; lastSeq: number }>;
  seqRootsPage?: Array<{ seq: number; manifestSha: string; carrierSha?: string }>;
  gapPage?: Array<{
    seq: number;
    manifestSha: string;
    carrierSha?: string;
    inlineRefs?: string[];
    chainRefs?: string[];
    sidecar?: { sha: string; count: number; size: number };
  }>;
  nextSha?: string;
  nextSeq?: number;
  nextGapSeq?: number;
}

export interface ShaMembership {
  workspaceId: string;
  projectId: string;
  sequence: number;
  head: boolean;
  committedAt: number | null;
  timestampGap: boolean;
}

export interface ShaLastValue {
  lastWs: string;
  lastProj: string;
  lastSeq: number;
  inHead: boolean;
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

function compareLocation(a: ShaMembership, b: ShaMembership): number {
  if (a.timestampGap !== b.timestampGap) return a.timestampGap ? 1 : -1;
  if (!a.timestampGap && !b.timestampGap && a.committedAt !== b.committedAt) return Number(a.committedAt) - Number(b.committedAt);
  if (a.workspaceId !== b.workspaceId) return a.workspaceId < b.workspaceId ? -1 : 1;
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
  return a.sequence - b.sequence;
}

/** Exact compact last-location semantics used by materialization and synthetic tests. */
export function computeShaLast(memberships: ShaMembership[]): ShaLastValue {
  if (memberships.length === 0) throw new Error("sha_last requires membership");
  const nonHead = memberships.filter((membership) => !membership.head).sort(compareLocation);
  const inertHeads = memberships.filter((membership) => membership.head).sort(compareLocation);
  const last = nonHead.at(-1) ?? inertHeads.at(-1)!;
  return {
    lastWs: last.workspaceId,
    lastProj: last.projectId,
    lastSeq: last.sequence,
    inHead: inertHeads.length > 0,
  };
}

function validNonNegativeInt(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function parsePin(value: RootsBody): Pin | null {
  const rootsFormatGeneration = value.rootsFormatGeneration ?? FAIRUSE_ROOTS_FORMAT_GENERATION;
  if (!validNonNegativeInt(value.head) || !validNonNegativeInt(value.pruneFloor) || value.pruneFloor > value.head
    || !validNonNegativeInt(value.indexGeneration) || !validNonNegativeInt(rootsFormatGeneration) || rootsFormatGeneration < 1) return null;
  return { head: value.head, pruneFloor: value.pruneFloor, indexGeneration: value.indexGeneration, rootsFormatGeneration };
}

function samePin(stream: StreamRow, pin: Pin): boolean {
  return stream.pin_head === pin.head && stream.pin_floor === pin.pruneFloor && stream.pin_generation === pin.indexGeneration
    && stream.pin_roots_format_generation === pin.rootsFormatGeneration;
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

function rootsCursor(raw: string | null): RootsCursor {
  if (raw === null) return { fromSha: "", fromSeq: "", fromGapSeq: "" };
  const parsed = JSON.parse(raw) as Partial<RootsCursor>;
  if (Object.keys(parsed).sort().join(",") !== "fromGapSeq,fromSeq,fromSha"
    || typeof parsed.fromSha !== "string" || typeof parsed.fromSeq !== "string" || typeof parsed.fromGapSeq !== "string") {
    throw new Error("invalid roots cursor");
  }
  return parsed as RootsCursor;
}

function encodeRootsCursor(cursor: RootsCursor): string {
  return JSON.stringify({ fromSha: cursor.fromSha, fromSeq: cursor.fromSeq, fromGapSeq: cursor.fromGapSeq });
}

function decodeMaterializeCursor(raw: string): { cursor: MaterializeCursor; page: PendingPage } {
  const cursor = JSON.parse(raw) as Partial<MaterializeCursor>;
  if (Object.keys(cursor).sort().join(",") !== "carrierOrd,pageToken,seq" || !validNonNegativeInt(cursor.seq)
    || !validNonNegativeInt(cursor.carrierOrd) || typeof cursor.pageToken !== "string") throw new Error("invalid materialize cursor");
  const page = JSON.parse(cursor.pageToken) as PendingPage;
  if (page.v !== 1 || (page.phase !== "stage" && page.phase !== "output") || !Array.isArray(page.entries)
    || !validNonNegativeInt(page.entryIndex) || !validNonNegativeInt(page.offset) || !Number.isSafeInteger(page.sidecarSum)
    || page.sidecarSum < 0 || typeof page.sidecarPreviousSha !== "string") throw new Error("invalid materialize page token");
  rootsCursor(JSON.stringify(page.sourceCursor));
  rootsCursor(JSON.stringify(page.rootsNext));
  if (page.entries.length > 3 || page.entries.some((entry) => !entry || requireSequence(entry.seq) !== entry.seq
    || typeof entry.head !== "boolean" || !Array.isArray(entry.refs) || entry.refs.length !== 0)) {
    throw new Error("invalid materialize page token");
  }
  return { cursor: cursor as MaterializeCursor, page };
}

function encodeMaterializeCursor(page: PendingPage): string {
  const seq = page.entries[page.entryIndex]?.seq ?? 0;
  const checkpoint: PendingPage = { ...page, entries: page.entries.map((entry) => ({ ...entry, refs: [] })) };
  return JSON.stringify({ seq, carrierOrd: 0, pageToken: JSON.stringify(checkpoint) });
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

async function readRoots(env: Env, workspace: { workspaceId: string; projectId: string }, cursor: RootsCursor, pin?: Pin): Promise<RootsBody> {
  const q = new URLSearchParams({
    fromSha: cursor.fromSha,
    fromSeq: cursor.fromSeq,
    fromGapSeq: cursor.fromGapSeq,
    limit: "1",
  });
  if (pin) {
    q.set("pinHead", String(pin.head));
    q.set("pinFloor", String(pin.pruneFloor));
    q.set("pinGen", String(pin.indexGeneration));
  }
  const id = env.WORKSPACE_SYNC.idFromName(`${workspace.workspaceId}/${workspace.projectId}`);
  const response = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/roots-inspect?${q}`, { method: "GET" });
  if (!response.ok) throw new Error(response.status === 409 ? "snapshot_changed" : `roots_inspect_${response.status}`);
  const body = await response.json() as RootsBody;
  if (!parsePin(body) || !Array.isArray(body.droppedPage) || !Array.isArray(body.seqRootsPage) || !Array.isArray(body.gapPage)) {
    throw new Error("invalid roots response");
  }
  return body;
}

async function readPin(env: Env, workspace: { workspaceId: string; projectId: string }): Promise<Pin> {
  const body = await readRoots(env, workspace, { fromSha: "done", fromSeq: "done", fromGapSeq: "done" });
  return parsePin(body)!;
}

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
  const pins: Array<{ workspace: WorkspaceSnapshot; pin: Pin }> = [];
  for (const workspace of page) pins.push({ workspace, pin: await readPin(env, workspace) });
  if (!(await ownsLease(db, scan.account_id, leaseValue, nowMs))) return "incomplete";

  const statements = pins.map(({ workspace, pin }) => db.prepare(
    `INSERT INTO fairuse_workspace_streams(account_id,epoch,workspace_id,project_id,pin_head,pin_floor,pin_generation,
       pin_roots_format_generation,updated_at)
     SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(
       SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
  ).bind(
    scan.account_id, scan.epoch, workspace.workspaceId, workspace.projectId, pin.head, pin.pruneFloor, pin.indexGeneration,
    pin.rootsFormatGeneration, nowMs,
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

function requireSha(value: unknown): string {
  if (typeof value !== "string" || !SHA_RE.test(value)) throw new Error("invalid root sha");
  return value;
}

function requireSequence(value: unknown): number {
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence) || sequence < 1) throw new Error("invalid root sequence");
  return sequence;
}

function pendingPage(stream: StreamRow, body: RootsBody, cursor: RootsCursor): PendingPage {
  if (body.droppedPage!.length > 1 || body.seqRootsPage!.length > 1 || body.gapPage!.length > 1) {
    throw new Error("roots page exceeds requested limit");
  }
  const next: RootsCursor = {
    fromSha: cursor.fromSha === "done" ? "done" : body.nextSha === undefined ? "done" : requireSha(body.nextSha),
    fromSeq: cursor.fromSeq === "done" ? "done" : body.nextSeq === undefined ? "done" : String(requireSequence(body.nextSeq)),
    fromGapSeq: cursor.fromGapSeq === "done" ? "done" : body.nextGapSeq === undefined ? "done" : String(requireSequence(body.nextGapSeq)),
  };
  const requireAdvance = (prior: string, following: string, rows: number, numeric: boolean): void => {
    if (prior === "done") {
      if (rows !== 0 || following !== "done") throw new Error("roots cursor resumed after done");
      return;
    }
    if (rows === 0 && following !== "done") throw new Error("empty roots page did not finish");
    if (following !== "done" && (numeric ? Number(following) <= Number(prior || 0) : following <= prior)) {
      throw new Error("roots cursor did not advance");
    }
  };
  requireAdvance(cursor.fromSha, next.fromSha, body.droppedPage!.length, false);
  requireAdvance(cursor.fromSeq, next.fromSeq, body.seqRootsPage!.length, true);
  requireAdvance(cursor.fromGapSeq, next.fromGapSeq, body.gapPage!.length, true);
  const entries: RootEntry[] = [];
  const addEntry = (seq: number, refs: Array<{ sha: string; size: number }>, sidecar?: RootEntry["sidecar"]): void => {
    // The D1 commit timestamp is joined when this entry is emitted. Keeping it
    // out of the outer-page fetch preserves the two-D1-subrequest tick budget.
    entries.push({ seq, head: seq === stream.pin_head, committedAt: null, timestampGap: true, refs, ...(sidecar ? { sidecar } : {}) });
  };
  for (const row of body.droppedPage!) {
    const seq = requireSequence(row.lastSeq);
    addEntry(seq, [{ sha: requireSha(row.sha), size: 0 }]);
  }
  for (const row of body.seqRootsPage!) {
    const seq = requireSequence(row.seq);
    addEntry(seq, [requireSha(row.manifestSha), ...(row.carrierSha === undefined ? [] : [requireSha(row.carrierSha)])].map((sha) => ({ sha, size: 0 })));
  }
  for (const row of body.gapPage!) {
    const seq = requireSequence(row.seq);
    const refs = [requireSha(row.manifestSha), ...(row.carrierSha === undefined ? [] : [requireSha(row.carrierSha)]),
      ...(row.inlineRefs ?? []).map(requireSha), ...(row.chainRefs ?? []).map(requireSha)].map((sha) => ({ sha, size: 0 }));
    let sidecar: RootEntry["sidecar"];
    if (row.sidecar) {
      if (row.carrierSha !== row.sidecar.sha || !validNonNegativeInt(row.sidecar.count) || !Number.isSafeInteger(row.sidecar.size) || row.sidecar.size < 0) {
        throw new Error("invalid sidecar descriptor");
      }
      sidecar = { sha: requireSha(row.sidecar.sha), count: row.sidecar.count, totalBytes: row.sidecar.size };
    }
    addEntry(seq, refs, sidecar);
  }
  return {
    v: 1, phase: "stage", sourceCursor: cursor, rootsNext: next,
    rootsDone: next.fromSha === "done" && next.fromSeq === "done" && next.fromGapSeq === "done",
    entries, entryIndex: 0, offset: 0, sidecarSum: 0, sidecarPreviousSha: "",
  };
}

async function readSidecarRecords(
  env: Env,
  descriptor: NonNullable<RootEntry["sidecar"]>,
  offset: number,
  previousSha: string,
): Promise<{ refs: Array<{ sha: string; size: number }>; done: boolean; sum: number; previousSha: string }> {
  if (offset > descriptor.count) throw new Error("sidecar cursor past end");
  const count = Math.min(FAIRUSE_ROOT_STAGE_ROWS, descriptor.count - offset);
  if (count === 0) return { refs: [], done: true, sum: 0, previousSha };
  const byteOffset = offset === 0 ? 0 : REFSET_HEADER + offset * REFSET_REC;
  const length = count * REFSET_REC + (offset === 0 ? REFSET_HEADER : 0);
  const object = await env.rbox_dev_blobs.get(blobKey(descriptor.sha), { range: { offset: byteOffset, length } });
  if (!object) throw new Error("sidecar missing");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.length !== length) throw new Error("sidecar range length mismatch");
  let recordOffset = 0;
  if (offset === 0) {
    for (let i = 0; i < REFSET_MAGIC.length; i++) if (bytes[i] !== REFSET_MAGIC.charCodeAt(i)) throw new Error("sidecar bad magic");
    if (new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(14, false) !== descriptor.count) throw new Error("sidecar count mismatch");
    recordOffset = REFSET_HEADER;
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const refs: Array<{ sha: string; size: number }> = [];
  let sum = 0;
  let prior = previousSha;
  for (let i = 0; i < count; i++) {
    const at = recordOffset + i * REFSET_REC;
    const sha = bytes32ToHex(bytes, at);
    if (prior && sha <= prior) throw new Error("sidecar not strictly ascending");
    const sizeBig = view.getBigUint64(at + 32, false);
    if (sizeBig > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("sidecar size exceeds safe integer");
    const size = Number(sizeBig);
    refs.push({ sha, size });
    sum += size;
    prior = sha;
  }
  const done = offset + count === descriptor.count;
  if (done && object.size !== refsetByteLength(descriptor.count)) throw new Error("sidecar length mismatch");
  return { refs, done, sum, previousSha: prior };
}

function chunked<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < values.length; i += size) result.push(values.slice(i, i + size));
  return result;
}

async function stageEntry(env: Env, scan: ScanRow, stream: StreamRow, leaseValue: string, page: PendingPage, nowMs: number): Promise<void> {
  const db = dbFor(env, scan.account_id);
  const entry = page.entries[page.entryIndex]!;
  const directDone = page.offset >= entry.refs.length;
  let refs: Array<{ sha: string; size: number }>;
  let nextOffset: number;
  let stageDone: boolean;
  if (!directDone) {
    refs = entry.refs.slice(page.offset, page.offset + FAIRUSE_ROOT_STAGE_ROWS);
    nextOffset = page.offset + refs.length;
    stageDone = nextOffset >= entry.refs.length && !entry.sidecar;
  } else if (entry.sidecar) {
    const sidecarOffset = page.offset - entry.refs.length;
    const sidecar = await readSidecarRecords(env, entry.sidecar, sidecarOffset, page.sidecarPreviousSha);
    refs = sidecar.refs;
    nextOffset = page.offset + refs.length;
    page.sidecarSum += sidecar.sum;
    page.sidecarPreviousSha = sidecar.previousSha;
    stageDone = sidecar.done;
    if (stageDone && page.sidecarSum !== entry.sidecar.totalBytes) throw new Error("sidecar totalBytes mismatch");
  } else {
    refs = [];
    nextOffset = page.offset;
    stageDone = true;
  }
  page.offset = nextOffset;
  if (stageDone) page.phase = "output";
  const statements = chunked(refs, 13).map((part) => {
    const values = part.map(() => "(?,?,?,?,?,?,?)").join(",");
    return db.prepare(
      `INSERT OR IGNORE INTO fairuse_materialize_refs(account_id,epoch,workspace_id,project_id,sequence,sha256,size_bytes)
       SELECT v.* FROM (VALUES ${values}) AS v
       WHERE EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
    ).bind(
      ...part.flatMap((ref) => [scan.account_id, scan.epoch, stream.workspace_id, stream.project_id, entry.seq, ref.sha, ref.size]),
      scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
    );
  });
  statements.push(db.prepare(
    `UPDATE fairuse_workspace_streams SET materialize_cursor=?,updated_at=? WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
     AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
  ).bind(
    encodeMaterializeCursor(page), nowMs, scan.account_id, scan.epoch, stream.workspace_id, stream.project_id,
    scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
  ));
  await db.batch(statements);
}

interface MembershipRow {
  sha256: string | null;
  selected_sequence: number | null;
  selected_committed_at: number | null;
  last_ws: string | null;
  last_proj: string | null;
  last_seq: number | null;
  in_head: number | null;
  nonhead_committed_at: number | null;
  nonhead_timestamp_gap: number | null;
  head_committed_at: number | null;
  head_timestamp_gap: number | null;
}

type MaterializeWorkRow = StreamRow & MembershipRow;

async function loadMaterializeWork(db: D1Database, scan: ScanRow, leaseValue: string): Promise<MaterializeWorkRow[]> {
  const rows = await db.prepare(
    `WITH stream AS (
       SELECT * FROM fairuse_workspace_streams ws WHERE ws.account_id=? AND ws.epoch=? AND ws.roots_done=0
         AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})
       ORDER BY ws.workspace_id,ws.project_id LIMIT 1
     ), selected AS (
       SELECT m.sha256,m.sequence FROM fairuse_materialize_refs m JOIN stream
         ON stream.account_id=m.account_id AND stream.epoch=m.epoch AND stream.workspace_id=m.workspace_id AND stream.project_id=m.project_id
       WHERE stream.materialize_cursor IS NOT NULL
         AND m.sequence=CAST(json_extract(stream.materialize_cursor,'$.seq') AS INTEGER)
       ORDER BY m.sha256 LIMIT ?
     )
     SELECT stream.workspace_id,stream.project_id,stream.pin_head,stream.pin_floor,stream.pin_generation,
       stream.pin_roots_format_generation,stream.roots_cursor,stream.materialize_cursor,stream.roots_done,
       selected.sha256,selected.sequence AS selected_sequence,c.created_at AS selected_committed_at,
       sl.last_ws,sl.last_proj,sl.last_seq,sl.in_head,
       mn.committed_at AS nonhead_committed_at,mn.timestamp_gap AS nonhead_timestamp_gap,
       mh.committed_at AS head_committed_at,mh.timestamp_gap AS head_timestamp_gap
     FROM stream LEFT JOIN selected ON 1
     LEFT JOIN commits c ON c.workspace_id=stream.workspace_id AND c.project_id=stream.project_id AND c.sequence=selected.sequence
     LEFT JOIN fairuse_sha_last sl ON sl.account_id=? AND sl.epoch=? AND sl.sha256=selected.sha256
     LEFT JOIN fairuse_root_membership mn INDEXED BY sqlite_autoindex_fairuse_root_membership_1
       ON mn.account_id=sl.account_id AND mn.epoch=sl.epoch AND mn.workspace_id=sl.last_ws AND mn.project_id=sl.last_proj
       AND mn.sha256=sl.sha256 AND mn.head=0 AND mn.sequence=sl.last_seq
     LEFT JOIN fairuse_root_membership mh INDEXED BY sqlite_autoindex_fairuse_root_membership_1
       ON mh.account_id=sl.account_id AND mh.epoch=sl.epoch AND mh.workspace_id=sl.last_ws AND mh.project_id=sl.last_proj
       AND mh.sha256=sl.sha256 AND mh.head=1 AND mh.sequence=sl.last_seq
     ORDER BY selected.sha256`,
  ).bind(
    scan.account_id, scan.epoch,
    scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
    FAIRUSE_ROOT_OUTPUT_ROWS + 1,
    scan.account_id, scan.epoch,
  ).all<MaterializeWorkRow>();
  return rows.results ?? [];
}

async function outputEntry(
  scan: ScanRow,
  stream: StreamRow,
  leaseValue: string,
  page: PendingPage,
  nowMs: number,
  db: D1Database,
  workRows: MaterializeWorkRow[],
): Promise<void> {
  const entry = page.entries[page.entryIndex]!;
  const selected = workRows.filter((row): row is MaterializeWorkRow & { sha256: string } => row.sha256 !== null)
    .slice(0, FAIRUSE_ROOT_OUTPUT_ROWS);
  if (selected.some((row) => Number(row.selected_sequence) !== entry.seq)) throw new Error("materialize sequence mismatch");
  const shas = selected.map((row) => row.sha256);
  if (shas.length === 0) {
    page.entryIndex++;
    page.offset = 0;
    page.sidecarSum = 0;
    page.sidecarPreviousSha = "";
    page.phase = "stage";
    const finished = page.entryIndex >= page.entries.length;
    const statements: D1PreparedStatement[] = [];
    if (finished) {
      statements.push(db.prepare(
        `UPDATE fairuse_workspace_streams SET roots_cursor=?,materialize_cursor=NULL,roots_done=?,root_rows=(
           SELECT COUNT(*) FROM fairuse_root_membership WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?),updated_at=?
         WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
           AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
      ).bind(
        encodeRootsCursor(page.rootsNext), page.rootsDone ? 1 : 0,
        scan.account_id, scan.epoch, stream.workspace_id, stream.project_id, nowMs,
        scan.account_id, scan.epoch, stream.workspace_id, stream.project_id,
        scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
      ));
    } else {
      statements.push(db.prepare(
        `UPDATE fairuse_workspace_streams SET materialize_cursor=?,updated_at=? WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
         AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
      ).bind(
        encodeMaterializeCursor(page), nowMs, scan.account_id, scan.epoch, stream.workspace_id, stream.project_id,
        scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
      ));
    }
    await db.batch(statements);
    return;
  }

  const compact = selected.map((row) => {
    const committedAt = row.selected_committed_at == null ? null : Number(row.selected_committed_at);
    const incoming: ShaMembership = { workspaceId: stream.workspace_id, projectId: stream.project_id, sequence: entry.seq,
      head: entry.head, committedAt, timestampGap: committedAt === null };
    const memberships: ShaMembership[] = [incoming];
    if (row.last_ws !== null && row.last_proj !== null && row.last_seq !== null) {
      if (row.nonhead_timestamp_gap !== null) {
        memberships.push({ workspaceId: row.last_ws, projectId: row.last_proj, sequence: Number(row.last_seq), head: false,
          committedAt: row.nonhead_committed_at == null ? null : Number(row.nonhead_committed_at), timestampGap: Number(row.nonhead_timestamp_gap) === 1 });
        if (Number(row.in_head) === 1) memberships.push({ ...memberships.at(-1)!, head: true });
      } else if (row.head_timestamp_gap !== null) {
        memberships.push({ workspaceId: row.last_ws, projectId: row.last_proj, sequence: Number(row.last_seq), head: true,
          committedAt: row.head_committed_at == null ? null : Number(row.head_committed_at), timestampGap: Number(row.head_timestamp_gap) === 1 });
      } else {
        throw new Error("sha_last evidence missing");
      }
    }
    return { sha: row.sha256, value: computeShaLast(memberships) };
  });
  const statements: D1PreparedStatement[] = [];
  for (const part of chunked(shas, 10)) {
    const values = part.map(() => "(?,?,?,?,?,?,?,?,?)").join(",");
    statements.push(db.prepare(
      `INSERT INTO fairuse_root_membership(account_id,epoch,workspace_id,project_id,sha256,head,sequence,committed_at,timestamp_gap)
       SELECT v.* FROM (VALUES ${values}) AS v WHERE EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})
       ON CONFLICT(account_id,epoch,workspace_id,project_id,sha256,head,sequence) DO UPDATE SET
         committed_at=CASE WHEN fairuse_root_membership.committed_at IS NULL THEN excluded.committed_at
           WHEN excluded.committed_at IS NULL THEN fairuse_root_membership.committed_at
           ELSE MAX(fairuse_root_membership.committed_at,excluded.committed_at) END,
         timestamp_gap=MAX(fairuse_root_membership.timestamp_gap,excluded.timestamp_gap)`,
    ).bind(
      ...part.flatMap((sha) => {
        const row = selected.find((candidate) => candidate.sha256 === sha)!;
        const committedAt = row.selected_committed_at == null ? null : Number(row.selected_committed_at);
        return [scan.account_id, scan.epoch, stream.workspace_id, stream.project_id, sha, entry.head ? 1 : 0,
          entry.seq, committedAt, committedAt === null ? 1 : 0];
      }),
      scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
    ));
  }
  for (const part of chunked(compact, 11)) {
    const values = part.map(() => "(?,?,?,?,?,?,?)").join(",");
    statements.push(db.prepare(
      `INSERT INTO fairuse_sha_last(account_id,epoch,sha256,last_ws,last_proj,last_seq,in_head)
       SELECT v.* FROM (VALUES ${values}) AS v WHERE EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})
       ON CONFLICT(account_id,epoch,sha256) DO UPDATE SET last_ws=excluded.last_ws,last_proj=excluded.last_proj,
         last_seq=excluded.last_seq,in_head=excluded.in_head`,
    ).bind(
      ...part.flatMap(({ sha, value }) => [scan.account_id, scan.epoch, sha, value.lastWs, value.lastProj, value.lastSeq, value.inHead ? 1 : 0]),
      scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
    ));
  }
  statements.push(db.prepare(
    `DELETE FROM fairuse_materialize_refs WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=? AND sequence=?
       AND sha256 IN (SELECT value FROM json_each(?))
       AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
  ).bind(
    scan.account_id, scan.epoch, stream.workspace_id, stream.project_id, entry.seq, JSON.stringify(shas),
    scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
  ));
  statements.push(db.prepare(
    `UPDATE fairuse_workspace_streams SET materialize_cursor=?,updated_at=? WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
     AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
  ).bind(
    encodeMaterializeCursor(page), nowMs, scan.account_id, scan.epoch, stream.workspace_id, stream.project_id,
    scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
  ));
  await db.batch(statements);
}

async function materializeRoots(env: Env, scan: ScanRow, leaseValue: string, nowMs: number): Promise<"incomplete" | "advanced"> {
  const db = dbFor(env, scan.account_id);
  const workRows = await loadMaterializeWork(db, scan, leaseValue);
  const stream = workRows[0] ?? null;
  if (!stream) {
    await db.prepare(`UPDATE fairuse_scans SET status='classify_entitlements',updated_at=? WHERE ${guardSql()}`)
      .bind(nowMs, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue).run();
    return "advanced";
  }
  if (stream.materialize_cursor) {
    const { cursor: savedCursor, page: checkpoint } = decodeMaterializeCursor(stream.materialize_cursor);
    const pin: Pin = { head: stream.pin_head, pruneFloor: stream.pin_floor, indexGeneration: stream.pin_generation,
      rootsFormatGeneration: stream.pin_roots_format_generation };
    const body = await readRoots(env, { workspaceId: stream.workspace_id, projectId: stream.project_id }, checkpoint.sourceCursor, pin);
    if (!samePin(stream, parsePin(body)!)) throw new Error("snapshot_changed");
    const page = pendingPage(stream, body, checkpoint.sourceCursor);
    const shape = (candidate: PendingPage) => JSON.stringify({
      rootsNext: candidate.rootsNext,
      entries: candidate.entries.map(({ seq, head, sidecar }) => ({ seq, head, sidecar: sidecar ?? null })),
    });
    if (shape(page) !== shape(checkpoint) || savedCursor.seq !== page.entries[checkpoint.entryIndex]?.seq) {
      throw new Error("materialize replay mismatch");
    }
    page.phase = checkpoint.phase;
    page.entryIndex = checkpoint.entryIndex;
    page.offset = checkpoint.offset;
    page.sidecarSum = checkpoint.sidecarSum;
    page.sidecarPreviousSha = checkpoint.sidecarPreviousSha;
    if (!page.entries[page.entryIndex]) throw new Error("materialize entry missing");
    if (page.phase === "stage") await stageEntry(env, scan, stream, leaseValue, page, nowMs);
    else await outputEntry(scan, stream, leaseValue, page, nowMs, db, workRows);
    return "incomplete";
  }

  const cursor = rootsCursor(stream.roots_cursor);
  const pin: Pin = { head: stream.pin_head, pruneFloor: stream.pin_floor, indexGeneration: stream.pin_generation,
    rootsFormatGeneration: stream.pin_roots_format_generation };
  const body = await readRoots(env, { workspaceId: stream.workspace_id, projectId: stream.project_id }, cursor, pin);
  const observed = parsePin(body)!;
  if (!samePin(stream, observed)) throw new Error("snapshot_changed");
  const pending = pendingPage(stream, body, cursor);
  if (pending.entries.length === 0) {
    await db.prepare(
      `UPDATE fairuse_workspace_streams SET roots_cursor=?,roots_done=?,updated_at=? WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
       AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
    ).bind(
      encodeRootsCursor(pending.rootsNext), pending.rootsDone ? 1 : 0, nowMs,
      scan.account_id, scan.epoch, stream.workspace_id, stream.project_id,
      scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue,
    ).run();
  } else {
    await stageEntry(env, scan, stream, leaseValue, pending, nowMs);
  }
  return "incomplete";
}

async function classifyEntitlements(scan: ScanRow, leaseValue: string, nowMs: number, db: D1Database): Promise<"incomplete" | "advanced"> {
  if (scan.entitlement_cursor_sha === "done") return "advanced";
  const after = scan.entitlement_cursor_sha ?? "";
  const rows = await db.prepare(
    `WITH page AS (
       SELECT r.sha256,b.size_bytes
       FROM blob_refs r INDEXED BY sqlite_autoindex_blob_refs_1
       LEFT JOIN blobs b INDEXED BY sqlite_autoindex_blobs_1 ON b.sha256=r.sha256
       WHERE r.account_id=? AND r.sha256>? ORDER BY r.sha256 LIMIT ?
     )
     SELECT page.sha256,page.size_bytes,
       EXISTS(SELECT 1 FROM fairuse_root_membership m INDEXED BY idx_fairuse_roots_membership
         WHERE m.account_id=? AND m.epoch=? AND m.sha256=page.sha256 AND m.head=1) AS has_head,
       EXISTS(SELECT 1 FROM fairuse_root_membership m INDEXED BY idx_fairuse_roots_membership
         WHERE m.account_id=? AND m.epoch=? AND m.sha256=page.sha256) AS has_membership
     FROM page ORDER BY page.sha256`,
  ).bind(
    scan.account_id, after, FAIRUSE_ENTITLEMENT_PAGE + 1,
    scan.account_id, scan.epoch, scan.account_id, scan.epoch,
  ).all<{ sha256: string; size_bytes: number | null; has_head: number; has_membership: number }>();
  const page = (rows.results ?? []).slice(0, FAIRUSE_ENTITLEMENT_PAGE);
  let active = 0;
  let history = 0;
  for (const row of page) {
    if (row.size_bytes == null) throw new Error("fairuse_catalog_missing");
    if (Number(row.has_head) === 1) active += Number(row.size_bytes);
    else if (Number(row.has_membership) > 0) history += Number(row.size_bytes);
  }
  const done = (rows.results?.length ?? 0) <= FAIRUSE_ENTITLEMENT_PAGE;
  const cursor = done ? "done" : page.at(-1)!.sha256;
  await db.prepare(
    `UPDATE fairuse_scans SET active_bytes=active_bytes+?,history_bytes=history_bytes+?,entitlement_cursor_sha=?,updated_at=?
     WHERE ${guardSql()}`,
  ).bind(active, history, cursor, nowMs, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue).run();
  return done ? "advanced" : "incomplete";
}

async function markAbortedEpoch(db: D1Database, scan: ScanRow, leaseValue: string, nowMs: number): Promise<void> {
  await db.prepare(`UPDATE fairuse_scans SET status='aborted_pins',completed_at=NULL,pruning_active=0,updated_at=? WHERE ${guardSql()}`)
    .bind(nowMs, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue).run();
}

/** Delete at most one 600-row relation page. The aborted scan row remains as audit evidence. */
async function cleanupAbortedPage(db: D1Database, scan: ScanRow, leaseValue: string): Promise<boolean> {
  const relation = await db.prepare(
    `SELECT CASE
       WHEN EXISTS(SELECT 1 FROM fairuse_materialize_refs WHERE account_id=? AND epoch=?) THEN 'materialize'
       WHEN EXISTS(SELECT 1 FROM fairuse_root_membership WHERE account_id=? AND epoch=?) THEN 'membership'
       WHEN EXISTS(SELECT 1 FROM fairuse_sha_last WHERE account_id=? AND epoch=?) THEN 'sha_last'
       WHEN EXISTS(SELECT 1 FROM fairuse_workspace_streams WHERE account_id=? AND epoch=?) THEN 'streams'
       ELSE 'done' END AS relation`,
  ).bind(
    scan.account_id, scan.epoch, scan.account_id, scan.epoch,
    scan.account_id, scan.epoch, scan.account_id, scan.epoch,
  ).first<{ relation: "materialize" | "membership" | "sha_last" | "streams" | "done" }>();
  if (!relation || relation.relation === "done") return true;
  const guard = [scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue] as const;
  if (relation.relation === "materialize") {
    await db.prepare(`DELETE FROM fairuse_materialize_refs WHERE (account_id,epoch,workspace_id,project_id,sequence,sha256) IN (
      SELECT account_id,epoch,workspace_id,project_id,sequence,sha256 FROM fairuse_materialize_refs
      WHERE account_id=? AND epoch=? ORDER BY workspace_id,project_id,sequence,sha256 LIMIT 600)
      AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  } else if (relation.relation === "membership") {
    await db.prepare(`DELETE FROM fairuse_root_membership WHERE rowid IN (
      SELECT rowid FROM fairuse_root_membership WHERE account_id=? AND epoch=? ORDER BY rowid LIMIT 600)
      AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  } else if (relation.relation === "sha_last") {
    await db.prepare(`DELETE FROM fairuse_sha_last WHERE (account_id,epoch,sha256) IN (
      SELECT account_id,epoch,sha256 FROM fairuse_sha_last WHERE account_id=? AND epoch=? ORDER BY sha256 LIMIT 600)
      AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  } else {
    await db.prepare(`DELETE FROM fairuse_workspace_streams WHERE rowid IN (
      SELECT rowid FROM fairuse_workspace_streams WHERE account_id=? AND epoch=? ORDER BY workspace_id,project_id LIMIT 600)
      AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`)
      .bind(scan.account_id, scan.epoch, ...guard).run();
  }
  return false;
}

async function verifyPinsWithEnv(env: Env, scan: ScanRow, leaseValue: string, nowMs: number, db: D1Database): Promise<"incomplete" | "advanced"> {
  const saved = parseWorkspaceSnapshot(scan.workspace_set_snapshot);
  const verificationReads = await db.batch([
    db.prepare(
      "SELECT workspace_id,project_id,created_at FROM workspaces INDEXED BY idx_workspaces_account_scan "
        + "WHERE account_id=? ORDER BY created_at,workspace_id,project_id LIMIT 65",
    ).bind(scan.account_id),
    db.prepare("SELECT * FROM fairuse_workspace_streams WHERE account_id=? AND epoch=? ORDER BY workspace_id,project_id")
      .bind(scan.account_id, scan.epoch),
  ]);
  const currentResult = verificationReads[0];
  const streamResult = verificationReads[1];
  if (!currentResult || !streamResult) throw new Error("fairuse verification read failed");
  const currentRows = (currentResult.results ?? []) as Array<{ workspace_id: string; project_id: string; created_at: number }>;
  const current = currentRows.length > FAIRUSE_MAX_WORKSPACES ? null : currentRows.map((row) => ({
    createdAt: Number(row.created_at), workspaceId: row.workspace_id, projectId: row.project_id,
  }));
  if (!current || !sameWorkspaceSet(saved, current)) {
    await markAbortedEpoch(db, scan, leaseValue, nowMs);
    return "advanced";
  }
  const allStreams = (streamResult.results ?? []) as unknown as StreamRow[];
  const savedKeys = new Set(saved.map((workspace) => `${workspace.workspaceId}\n${workspace.projectId}`));
  if (allStreams.length !== saved.length || allStreams.some((stream) => !savedKeys.has(`${stream.workspace_id}\n${stream.project_id}`))) {
    await markAbortedEpoch(db, scan, leaseValue, nowMs);
    return "advanced";
  }
  const pending = allStreams.filter((stream) => {
    if (scan.verify_cursor_id == null) return true;
    return stream.workspace_id > scan.verify_cursor_id || (stream.workspace_id === scan.verify_cursor_id && stream.project_id > String(scan.verify_cursor_project));
  }).slice(0, FAIRUSE_PIN_PAGE);
  for (const stream of pending) {
    const pin = await readPin(env, { workspaceId: stream.workspace_id, projectId: stream.project_id });
    if (!samePin(stream, pin)) {
      await markAbortedEpoch(db, scan, leaseValue, nowMs);
      return "advanced";
    }
  }
  const last = pending.at(-1);
  const statements = pending.map((stream) => db.prepare(
      `UPDATE fairuse_workspace_streams SET pins_verified=1,updated_at=? WHERE account_id=? AND epoch=? AND workspace_id=? AND project_id=?
       AND EXISTS(SELECT 1 FROM fairuse_scans s WHERE ${guardSql("s")})`,
    ).bind(nowMs, scan.account_id, scan.epoch, stream.workspace_id, stream.project_id,
      scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue));
  if (last) {
    statements.push(db.prepare(`UPDATE fairuse_scans SET verify_cursor_id=?,verify_cursor_project=?,updated_at=? WHERE ${guardSql()}`)
      .bind(last!.workspace_id, last!.project_id, nowMs, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue));
  }
  if (pending.length < FAIRUSE_PIN_PAGE) {
    statements.push(db.prepare(
      `UPDATE fairuse_scans SET status='complete',completed_at=?,updated_at=?,bound_bytes=5*MAX(active_bytes,?),pruning_active=0
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
               AND ws.project_id=json_extract(j.value,'$.projectId')))`,
    ).bind(nowMs, nowMs, FAIRUSE_BOUND_FLOOR, scan.account_id, scan.epoch, scan.status, scan.plan_snapshot, leaseValue));
  }
  const results = await db.batch(statements);
  if (pending.length === FAIRUSE_PIN_PAGE) return "incomplete";
  const completed = results.at(-1);
  return Number(completed?.meta.changes ?? 0) === 1 ? "advanced" : "incomplete";
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
export async function runFairUseObservation(env: Env, nowMs: number = Date.now()): Promise<void> {
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
    `SELECT * FROM fairuse_scans s WHERE s.account_id=? AND s.status='aborted_pins' AND (
       EXISTS(SELECT 1 FROM fairuse_materialize_refs m WHERE m.account_id=s.account_id AND m.epoch=s.epoch)
       OR EXISTS(SELECT 1 FROM fairuse_root_membership m WHERE m.account_id=s.account_id AND m.epoch=s.epoch)
       OR EXISTS(SELECT 1 FROM fairuse_sha_last l WHERE l.account_id=s.account_id AND l.epoch=s.epoch)
       OR EXISTS(SELECT 1 FROM fairuse_workspace_streams w WHERE w.account_id=s.account_id AND w.epoch=s.epoch))
     ORDER BY s.epoch LIMIT 1`,
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
      else if (scan.status === "materialize_roots") {
        try {
          await materializeRoots(env, scan, held.value, nowMs);
        } catch (error) {
          if (error instanceof Error && error.message === "snapshot_changed") {
            await markAbortedEpoch(db, scan, held.value, nowMs);
          } else throw error;
        }
      } else if (scan.status === "classify_entitlements") {
        if (scan.entitlement_cursor_sha === "done") await verifyPinsWithEnv(env, scan, held.value, nowMs, db);
        else await classifyEntitlements(scan, held.value, nowMs, db);
      }
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
