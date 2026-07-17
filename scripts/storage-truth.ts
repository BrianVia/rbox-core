#!/usr/bin/env bun

/**
 * Design 142 Phase-0 storage truth measurement.
 *
 * This is deliberately an operator process, not a Worker route. Authoritative
 * readers are injected so tests can reject every mutation and the live operator
 * adapter can use bounded Cloudflare reads without putting credentials here.
 */
import { Database } from "bun:sqlite";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const REPORT_VERSION = 1;
const SPOOL_SCHEMA_VERSION = 3;
export const GRACE_1_MS = 24 * 60 * 60 * 1000;
export const BLOB_REF_PAGE_LIMIT = 2_000;
export const ROOTS_PAGE_LIMIT = 20_000;
export const PHASE1_DROPPED_PAGE_CAP = 16;
export const PHASE1_SEQ_ROOT_PAGE_CAP = 4;
export const PHASE1_UNIQUE_ROOT_CAP = 750_000;
export const SNAPSHOT_RETRIES = 3;
export const HEAD_DRIFT_THRESHOLD = 100;

export interface SnapshotTriple { head: number; pruneFloor: number; indexGeneration: number }
export interface WorkspaceKey { workspaceId: string; projectId: string }
export interface CurrentHeadResult { outcome: "ok" | "uninspectable"; head?: number; reason?: string }
export class WorkspaceInspectionFailure extends Error {
  constructor(
    readonly status: "stale-pin" | "uninspectable",
    readonly workspace: WorkspaceKey,
    readonly reason: string,
  ) {
    super(reason);
    this.name = "WorkspaceInspectionFailure";
  }
}
export interface RootEntry {
  sha: string;
  head: boolean;
  sequence?: number;
  /** Epoch milliseconds for the retained version that contributed this root. */
  committedAt: number | null;
}
export interface RootsPage {
  outcome: "ok" | "snapshot_changed" | "uninspectable";
  reason?: string;
  triple?: SnapshotTriple;
  entries?: RootEntry[];
  nextCursor?: string | null;
  /** Raw stream cardinalities used to reproduce Phase-1's page caps. */
  droppedRows?: number;
  seqRootRows?: number;
}
export interface EntitlementRow {
  accountId: string;
  sha: string;
  grantedAt: number;
  markedAt?: number | null;
  sizeBytes?: number | null;
  location?: { packId: string; length: number; packInventoryPresent: boolean } | null;
}
export type Lifecycle = "staging" | "ready" | "condemned";
export interface InventoryEntry {
  key: string;
  sizeBytes: number;
  lifecycle: Lifecycle;
  rawState: string;
  expectedPresence: boolean;
  changedAt?: number;
  members?: Array<{ sha: string; active?: boolean; retained?: boolean }>;
}
export interface ObservedObject { key: string; sizeBytes: number; uploadedAt: number }
export interface CatalogRow { sha: string; sizeBytes: number }
export interface FleetReachabilityRow { sha: string; active: boolean; retained: boolean }
export interface Page<T> { rows: T[]; nextCursor: string | null }

export interface StorageTruthSource {
  now(): number;
  account(accountId: string): Promise<{ usedBytes: number; retentionDays: number }>;
  workspaces(accountId: string, cursor: string | null, limit: number): Promise<Page<WorkspaceKey>>;
  roots(workspace: WorkspaceKey, cursor: string | null, pin: SnapshotTriple | null, limit: number): Promise<RootsPage>;
  currentHead(workspace: WorkspaceKey): Promise<CurrentHeadResult>;
  catalog(cursor: string | null, limit: number): Promise<Page<CatalogRow>>;
  /** Union rows from every account's independently triple-pinned roots scan. */
  fleetReachability(cursor: string | null, limit: number): Promise<Page<FleetReachabilityRow>>;
  entitlements(accountId: string, cursor: { accountId: string; sha: string } | null, limit: number): Promise<Page<EntitlementRow>>;
  inventory(prefix: "canonical" | "pack", cursor: string | null, limit: number): Promise<Page<InventoryEntry>>;
  r2(prefix: "canonical" | "pack", cursor: string | null, limit: number): Promise<Page<ObservedObject>>;
  catalogGrantedBytes(startedAt: number, endedAt: number): Promise<number>;
  inventoryChangedBytes(startedAt: number, endedAt: number): Promise<number>;
  /** Release local binding proxies or temporary adapter state after a CLI run. */
  close?(): Promise<void> | void;
}

export type BaseLabel = "active-head" | "retained-history" | "fresh" | "aged-unmarked" | "marked-young" | "purge-eligible";
export interface ClassifiedEntitlement {
  label: BaseLabel;
  missingCatalog: boolean;
  inconsistent: boolean;
}

export function classifyEntitlement(row: EntitlementRow, inHead: boolean, inRetained: boolean, nowMs: number, graceMs = GRACE_1_MS): ClassifiedEntitlement {
  let label: BaseLabel;
  if (inHead) label = "active-head";
  else if (inRetained) label = "retained-history";
  else if (nowMs - row.grantedAt < graceMs) label = "fresh";
  else if (row.markedAt == null) label = "aged-unmarked";
  else if (nowMs - row.markedAt < graceMs) label = "marked-young";
  else label = "purge-eligible";
  const missingCatalog = row.sizeBytes == null;
  const inconsistent = !!row.location && (!row.location.packInventoryPresent || (row.sizeBytes != null && row.location.length !== row.sizeBytes));
  return { label, missingCatalog, inconsistent };
}

export interface Measure { count: number; knownBytes: number; unknownByteRows: number }
const emptyMeasure = (): Measure => ({ count: 0, knownBytes: 0, unknownByteRows: 0 });
const addMeasure = (m: Measure, size: number | null | undefined): void => {
  m.count++;
  if (size == null) m.unknownByteRows++;
  else m.knownBytes += size;
};

export interface CapProximity {
  observed: number;
  cap: number;
  delta: number;
  percent: number;
  wouldFail: boolean;
}
export function capProximity(observed: number, cap: number): CapProximity {
  return { observed, cap, delta: cap - observed, percent: cap === 0 ? 0 : observed / cap * 100, wouldFail: observed > cap };
}
export const phase1PageCount = (rows: number): number => Math.max(1, Math.ceil(rows / ROOTS_PAGE_LIMIT));

export type JoinOutcome = "matched" | "size-mismatch" | "r2-only" | "inventory-only";
export interface ReconciliationCell { count: number; observedBytes: number; inventoryBytes: number; missingAnomaly: number }
const emptyCell = (): ReconciliationCell => ({ count: 0, observedBytes: 0, inventoryBytes: 0, missingAnomaly: 0 });
export interface PrefixReconciliation {
  byLifecycle: Record<string, Record<JoinOutcome, ReconciliationCell>>;
  observedBytes: number;
  observedIdentityBytes: number;
  inventoryBytes: number;
  inventoryIdentityBytes: number;
  identityHolds: boolean;
  sideDifferenceBytes: number;
  withinSkewBound: boolean;
  packClasses?: Record<"active-only" | "history-only" | "mixed" | "orphan", Measure>;
  packStrandedMembers?: number;
}

export function reconcilePrefix(observed: ObservedObject[], inventory: InventoryEntry[], listingStartedAt: number, classifyPacks = false, skewBoundBytes = 0): PrefixReconciliation {
  const eligible = observed.filter((o) => o.uploadedAt <= listingStartedAt);
  const observedByKey = new Map(eligible.map((o) => [o.key, o]));
  const inventoryByKey = new Map(inventory.map((i) => [i.key, i]));
  const byLifecycle: PrefixReconciliation["byLifecycle"] = {};
  const cell = (lifecycle: string, outcome: JoinOutcome): ReconciliationCell =>
    (byLifecycle[lifecycle] ??= { matched: emptyCell(), "size-mismatch": emptyCell(), "r2-only": emptyCell(), "inventory-only": emptyCell() })[outcome];
  for (const object of eligible) {
    const expected = inventoryByKey.get(object.key);
    const outcome: JoinOutcome = !expected ? "r2-only" : expected.sizeBytes === object.sizeBytes ? "matched" : "size-mismatch";
    const c = cell(expected?.lifecycle ?? "unattributed", outcome);
    c.count++; c.observedBytes += object.sizeBytes; c.inventoryBytes += expected?.sizeBytes ?? 0;
  }
  for (const expected of inventory) {
    if (observedByKey.has(expected.key)) continue;
    const c = cell(expected.lifecycle, "inventory-only");
    c.count++; c.inventoryBytes += expected.sizeBytes;
    // Lifecycle, not a generic aggregate delta, determines whether absence is
    // anomalous: ready promises an object; staging/condemned do not.
    if (expected.lifecycle === "ready") c.missingAnomaly++;
  }
  const observedBytes = eligible.reduce((n, o) => n + o.sizeBytes, 0);
  const inventoryBytes = inventory.reduce((n, i) => n + i.sizeBytes, 0);
  let observedIdentityBytes = 0;
  let inventoryIdentityBytes = 0;
  for (const outcomes of Object.values(byLifecycle)) for (const [name, c] of Object.entries(outcomes)) {
    if (name !== "inventory-only") observedIdentityBytes += c.observedBytes;
    if (name !== "r2-only") inventoryIdentityBytes += c.inventoryBytes;
  }
  const result: PrefixReconciliation = {
    byLifecycle, observedBytes, observedIdentityBytes, inventoryBytes, inventoryIdentityBytes,
    identityHolds: observedBytes === observedIdentityBytes && inventoryBytes === inventoryIdentityBytes,
    sideDifferenceBytes: observedBytes - inventoryBytes,
    withinSkewBound: Math.abs(observedBytes - inventoryBytes) <= skewBoundBytes,
  };
  if (classifyPacks) {
    const classes = { "active-only": emptyMeasure(), "history-only": emptyMeasure(), mixed: emptyMeasure(), orphan: emptyMeasure() };
    let stranded = 0;
    for (const pack of inventory.filter((i) => i.lifecycle === "ready")) {
      const members = pack.members ?? [];
      const hasActive = members.some((m) => m.active);
      const hasHistory = members.some((m) => !m.active && m.retained);
      const label = hasActive ? (hasHistory ? "mixed" : "active-only") : (hasHistory ? "history-only" : "orphan");
      addMeasure(classes[label], pack.sizeBytes);
      stranded += members.filter((m) => !m.active && !m.retained).length;
    }
    result.packClasses = classes;
    result.packStrandedMembers = stranded;
  }
  return result;
}

export interface StorageTruthReport {
  schemaVersion: 1;
  status: "complete" | "stale-pin" | "uninspectable";
  accountId: string;
  startedAt: number;
  endedAt: number;
  failure?: { workspace?: WorkspaceKey; reason: string };
  sectionA: {
    kind: "entitlement-partition";
    buckets: Record<BaseLabel, Measure>;
    anomalies: { missingCatalog: number; inconsistent: number; both: number };
    totalEntitlements: number;
    partitionCount: number;
    partitionHolds: boolean;
  };
  sectionB: {
    kind: "overlapping-diagnostics";
    arithmeticDrift: { usedBytes: number; entitlementCatalogBytes: number; signedBytes: number; unknownCatalogRows: number };
    reachableUnentitled: Measure;
    windowExpiredRetained: Measure;
    timestampGapRoots: number;
    phase1: {
      outcome: "would-complete" | "would-fail-closed";
      uniqueRoots: CapProximity;
      droppedPages: CapProximity;
      seqRootPages: CapProximity;
    };
    workspaces: Array<{ workspace: WorkspaceKey; pin: SnapshotTriple; retries: number; droppedPages: number; seqRootPages: number; endingHead: number; headAdvance: number }>;
    rescanOffered: boolean;
    physical: {
      listingStartedAt: number;
      listingEndedAt: number;
      catalogGrantedBytesDuringWindow: number;
      inventoryChangedBytesDuringWindow: number;
      skewBoundBytes: number;
      canonical: PrefixReconciliation;
      pack: PrefixReconciliation;
    };
  };
}

const sameTriple = (a: SnapshotTriple, b: SnapshotTriple): boolean => a.head === b.head && a.pruneFloor === b.pruneFloor && a.indexGeneration === b.indexGeneration;
const workspaceKey = (w: WorkspaceKey): string => `${w.workspaceId}\n${w.projectId}`;
const LABELS: BaseLabel[] = ["active-head", "retained-history", "fresh", "aged-unmarked", "marked-young", "purge-eligible"];
const DAY_MS = 86_400_000;

function initializeSpool(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS stream_state(stream TEXT PRIMARY KEY,cursor TEXT,done INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS workspaces(workspace TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspace_scans(workspace TEXT PRIMARY KEY,pin_head INTEGER,pin_floor INTEGER,pin_generation INTEGER,retries INTEGER NOT NULL DEFAULT 0,dropped_rows INTEGER NOT NULL DEFAULT 0,seq_rows INTEGER NOT NULL DEFAULT 0,done INTEGER NOT NULL DEFAULT 0,ending_head INTEGER);
    CREATE TABLE IF NOT EXISTS roots(workspace TEXT NOT NULL,sha TEXT NOT NULL,head INTEGER NOT NULL,committed_at INTEGER,timestamp_gap INTEGER NOT NULL,PRIMARY KEY(workspace,sha,head));
    CREATE INDEX IF NOT EXISTS roots_sha ON roots(sha);
    CREATE TABLE IF NOT EXISTS catalog(sha TEXT PRIMARY KEY,size INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS fleet(sha TEXT PRIMARY KEY,active INTEGER NOT NULL,retained INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS entitlements(sha TEXT PRIMARY KEY,size INTEGER,label TEXT NOT NULL,missing_catalog INTEGER NOT NULL,inconsistent INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS inventory(prefix TEXT NOT NULL,key TEXT NOT NULL,size INTEGER NOT NULL,lifecycle TEXT NOT NULL,raw_state TEXT NOT NULL,expected_presence INTEGER NOT NULL,changed_at INTEGER,PRIMARY KEY(prefix,key));
    CREATE TABLE IF NOT EXISTS inventory_members(prefix TEXT NOT NULL,key TEXT NOT NULL,sha TEXT NOT NULL,PRIMARY KEY(prefix,key,sha));
    CREATE TABLE IF NOT EXISTS observed(prefix TEXT NOT NULL,key TEXT NOT NULL,size INTEGER NOT NULL,uploaded_at INTEGER NOT NULL,PRIMARY KEY(prefix,key));`);
}

function metaGet(db: Database, key: string): string | null {
  return (db.query("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | null)?.value ?? null;
}
function metaSet(db: Database, key: string, value: string | number): void {
  db.prepare("INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}
function streamState(db: Database, stream: string): { cursor: string | null; done: boolean } {
  const row = db.query("SELECT cursor,done FROM stream_state WHERE stream=?").get(stream) as { cursor: string | null; done: number } | null;
  return row ? { cursor: row.cursor, done: Number(row.done) === 1 } : { cursor: null, done: false };
}

async function spoolPages<T>(
  db: Database,
  stream: string,
  read: (cursor: string | null) => Promise<Page<T>>,
  writeRows: (rows: T[]) => void,
): Promise<void> {
  let state = streamState(db, stream);
  while (!state.done) {
    const page = await read(state.cursor);
    if (page.nextCursor !== null && page.nextCursor === state.cursor) throw new Error(`${stream}: non-advancing cursor`);
    db.transaction(() => {
      writeRows(page.rows);
      db.prepare("INSERT INTO stream_state VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET cursor=excluded.cursor,done=excluded.done")
        .run(stream, page.nextCursor, page.nextCursor === null ? 1 : 0);
    })();
    state = { cursor: page.nextCursor, done: page.nextCursor === null };
  }
}

function reconcilePrefixFromDb(db: Database, prefix: "canonical" | "pack", listingStartedAt: number, skewBoundBytes: number): PrefixReconciliation {
  const byLifecycle: PrefixReconciliation["byLifecycle"] = {};
  const rows = db.query(`WITH keys AS (
      SELECT key FROM inventory WHERE prefix=? UNION SELECT key FROM observed WHERE prefix=? AND uploaded_at<=?
    ), joined AS (
      SELECT k.key,i.size inventory_size,i.lifecycle,o.size observed_size,o.key observed_key,i.key inventory_key
      FROM keys k LEFT JOIN inventory i ON i.prefix=? AND i.key=k.key
      LEFT JOIN observed o ON o.prefix=? AND o.key=k.key AND o.uploaded_at<=?
    )
    SELECT COALESCE(lifecycle,'unattributed') lifecycle,
      CASE WHEN inventory_key IS NULL THEN 'r2-only' WHEN observed_key IS NULL THEN 'inventory-only'
           WHEN inventory_size=observed_size THEN 'matched' ELSE 'size-mismatch' END outcome,
      COUNT(*) count,COALESCE(SUM(COALESCE(observed_size,0)),0) observed_bytes,
      COALESCE(SUM(COALESCE(inventory_size,0)),0) inventory_bytes,
      SUM(CASE WHEN observed_key IS NULL AND lifecycle='ready' THEN 1 ELSE 0 END) missing
    FROM joined GROUP BY lifecycle,outcome`).all(prefix, prefix, listingStartedAt, prefix, prefix, listingStartedAt) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const lifecycle = String(row.lifecycle);
    const outcome = String(row.outcome) as JoinOutcome;
    const outcomes = byLifecycle[lifecycle] ??= { matched: emptyCell(), "size-mismatch": emptyCell(), "r2-only": emptyCell(), "inventory-only": emptyCell() };
    outcomes[outcome] = { count: Number(row.count), observedBytes: Number(row.observed_bytes), inventoryBytes: Number(row.inventory_bytes), missingAnomaly: Number(row.missing) };
  }
  const observedBytes = Number((db.query("SELECT COALESCE(SUM(size),0) n FROM observed WHERE prefix=? AND uploaded_at<=?").get(prefix, listingStartedAt) as { n: number }).n);
  const inventoryBytes = Number((db.query("SELECT COALESCE(SUM(size),0) n FROM inventory WHERE prefix=?").get(prefix) as { n: number }).n);
  let observedIdentityBytes = 0;
  let inventoryIdentityBytes = 0;
  for (const outcomes of Object.values(byLifecycle)) for (const [outcome, cell] of Object.entries(outcomes)) {
    if (outcome !== "inventory-only") observedIdentityBytes += cell.observedBytes;
    if (outcome !== "r2-only") inventoryIdentityBytes += cell.inventoryBytes;
  }
  const result: PrefixReconciliation = {
    byLifecycle, observedBytes, observedIdentityBytes, inventoryBytes, inventoryIdentityBytes,
    identityHolds: observedBytes === observedIdentityBytes && inventoryBytes === inventoryIdentityBytes,
    sideDifferenceBytes: observedBytes - inventoryBytes,
    withinSkewBound: Math.abs(observedBytes - inventoryBytes) <= skewBoundBytes,
  };
  if (prefix === "pack") {
    const classes = { "active-only": emptyMeasure(), "history-only": emptyMeasure(), mixed: emptyMeasure(), orphan: emptyMeasure() };
    const packs = db.query(`SELECT i.size,
        MAX(CASE WHEN COALESCE(f.active,0)=1 THEN 1 ELSE 0 END) has_active,
        MAX(CASE WHEN COALESCE(f.active,0)=0 AND COALESCE(f.retained,0)=1 THEN 1 ELSE 0 END) has_history
      FROM inventory i LEFT JOIN inventory_members m ON m.prefix=i.prefix AND m.key=i.key
      LEFT JOIN fleet f ON f.sha=m.sha WHERE i.prefix='pack' AND i.lifecycle='ready' GROUP BY i.key,i.size`).all() as Array<Record<string, unknown>>;
    for (const pack of packs) {
      const active = Number(pack.has_active) === 1;
      const history = Number(pack.has_history) === 1;
      const label = active ? (history ? "mixed" : "active-only") : (history ? "history-only" : "orphan");
      addMeasure(classes[label], Number(pack.size));
    }
    result.packClasses = classes;
    result.packStrandedMembers = Number((db.query(`SELECT COUNT(*) n FROM inventory_members m
      JOIN inventory i ON i.prefix=m.prefix AND i.key=m.key LEFT JOIN fleet f ON f.sha=m.sha
      WHERE m.prefix='pack' AND i.lifecycle='ready' AND COALESCE(f.active,0)=0 AND COALESCE(f.retained,0)=0`).get() as { n: number }).n);
  }
  return result;
}

export async function measureStorageTruth(source: StorageTruthSource, accountId: string, spoolDir: string): Promise<StorageTruthReport> {
  await mkdir(spoolDir, { recursive: true });
  const db = new Database(path.join(spoolDir, "storage-truth.sqlite"));
  try {
    initializeSpool(db);
    const existingSchema = metaGet(db, "schema_version");
    if (existingSchema !== null && existingSchema !== String(SPOOL_SCHEMA_VERSION)) {
      throw new Error(`spool schema ${existingSchema} is incompatible with ${SPOOL_SCHEMA_VERSION}`);
    }
    metaSet(db, "schema_version", SPOOL_SCHEMA_VERSION);
    const existingAccount = metaGet(db, "account_id");
    if (existingAccount !== null && existingAccount !== accountId) throw new Error(`spool belongs to account ${existingAccount}`);
    metaSet(db, "account_id", accountId);
    const startedAt = Number(metaGet(db, "started_at") ?? source.now());
    if (metaGet(db, "started_at") === null) metaSet(db, "started_at", startedAt);

    let account: { usedBytes: number; retentionDays: number };
    const savedAccount = metaGet(db, "account");
    if (savedAccount === null) {
      account = await source.account(accountId);
      metaSet(db, "account", JSON.stringify(account));
    } else account = JSON.parse(savedAccount) as typeof account;

    const insertWorkspace = db.prepare("INSERT OR IGNORE INTO workspaces VALUES(?,?,?)");
    await spoolPages(db, "workspaces", (cursor) => source.workspaces(accountId, cursor, 500), (rows) => {
      for (const workspace of rows) insertWorkspace.run(workspaceKey(workspace), workspace.workspaceId, workspace.projectId);
    });
    const workspaces = (db.query("SELECT workspace_id,project_id FROM workspaces ORDER BY workspace").all() as Array<{ workspace_id: string; project_id: string }>)
      .map((row) => ({ workspaceId: row.workspace_id, projectId: row.project_id }));
    const insertRoot = db.prepare(`INSERT INTO roots VALUES(?,?,?,?,?) ON CONFLICT(workspace,sha,head)
      DO UPDATE SET committed_at=CASE
        WHEN roots.committed_at IS NULL THEN excluded.committed_at
        WHEN excluded.committed_at IS NULL THEN roots.committed_at
        ELSE MAX(roots.committed_at,excluded.committed_at)
      END,timestamp_gap=MAX(roots.timestamp_gap,excluded.timestamp_gap)`);

    for (const workspace of workspaces) {
      const key = workspaceKey(workspace);
      db.prepare("INSERT OR IGNORE INTO workspace_scans(workspace) VALUES(?)").run(key);
      while (true) {
        const scan = db.query(`SELECT pin_head,pin_floor,pin_generation,retries,done FROM workspace_scans WHERE workspace=?`).get(key) as {
          pin_head: number | null; pin_floor: number | null; pin_generation: number | null; retries: number; done: number;
        };
        if (Number(scan.done) === 1) break;
        const pin = scan.pin_head == null ? null : { head: Number(scan.pin_head), pruneFloor: Number(scan.pin_floor), indexGeneration: Number(scan.pin_generation) };
        const rootStream = `roots:${key}`;
        const state = streamState(db, rootStream);
        const page = await source.roots(workspace, state.cursor, pin, ROOTS_PAGE_LIMIT);
        const stale = page.outcome === "snapshot_changed" || (page.outcome === "ok" && !!pin && !!page.triple && !sameTriple(pin, page.triple));
        if (stale) {
          if (Number(scan.retries) >= SNAPSHOT_RETRIES) {
            // Reset the scan row + stream cursor alongside the roots so a re-run
            // against the SAME spool (the documented resume path) gets fresh
            // retry budget instead of deterministically re-aborting on the
            // stale pin it left behind.
            db.transaction(() => {
              db.prepare("DELETE FROM roots WHERE workspace=?").run(key);
              db.prepare("DELETE FROM stream_state WHERE stream=?").run(rootStream);
              db.prepare("UPDATE workspace_scans SET pin_head=NULL,pin_floor=NULL,pin_generation=NULL,retries=0,dropped_rows=0,seq_rows=0,done=0 WHERE workspace=?").run(key);
            })();
            return incompleteReport("stale-pin", accountId, startedAt, source.now(), { workspace, reason: "snapshot changed after three retries" });
          }
          db.transaction(() => {
            db.prepare("DELETE FROM roots WHERE workspace=?").run(key);
            db.prepare("DELETE FROM stream_state WHERE stream=?").run(rootStream);
            db.prepare("UPDATE workspace_scans SET pin_head=NULL,pin_floor=NULL,pin_generation=NULL,retries=retries+1,dropped_rows=0,seq_rows=0,done=0 WHERE workspace=?").run(key);
          })();
          continue;
        }
        if (page.outcome !== "ok" || !page.triple) {
          return incompleteReport("uninspectable", accountId, startedAt, source.now(), { workspace, reason: page.reason ?? "missing snapshot identity" });
        }
        for (const entry of page.entries ?? []) {
          if (entry.committedAt !== null && (!Number.isFinite(entry.committedAt) || entry.committedAt <= 0)) {
            return incompleteReport("uninspectable", accountId, startedAt, source.now(), { workspace, reason: `invalid root timestamp for ${entry.sha}` });
          }
        }
        if (page.nextCursor !== null && page.nextCursor !== undefined && page.nextCursor === state.cursor) throw new Error(`${rootStream}: non-advancing cursor`);
        const nextCursor = page.nextCursor ?? null;
        db.transaction(() => {
          for (const entry of page.entries ?? []) insertRoot.run(key, entry.sha, entry.head ? 1 : 0, entry.committedAt, entry.committedAt === null ? 1 : 0);
          db.prepare(`UPDATE workspace_scans SET pin_head=COALESCE(pin_head,?),pin_floor=COALESCE(pin_floor,?),pin_generation=COALESCE(pin_generation,?),
            dropped_rows=dropped_rows+?,seq_rows=seq_rows+?,done=? WHERE workspace=?`)
            .run(page.triple!.head, page.triple!.pruneFloor, page.triple!.indexGeneration, page.droppedRows ?? 0, page.seqRootRows ?? 0, nextCursor === null ? 1 : 0, key);
          db.prepare("INSERT INTO stream_state VALUES(?,?,?) ON CONFLICT(stream) DO UPDATE SET cursor=excluded.cursor,done=excluded.done")
            .run(rootStream, nextCursor, nextCursor === null ? 1 : 0);
        })();
      }
    }

    const insertCatalog = db.prepare("INSERT OR REPLACE INTO catalog VALUES(?,?)");
    await spoolPages(db, "catalog", (cursor) => source.catalog(cursor, BLOB_REF_PAGE_LIMIT), (rows) => {
      for (const row of rows) insertCatalog.run(row.sha, row.sizeBytes);
    });

    const insertEntitlement = db.prepare("INSERT OR REPLACE INTO entitlements VALUES(?,?,?,?,?)");
    await spoolPages(db, "entitlements", async (cursor) => {
      let parsed: { accountId: string; sha: string } | null = null;
      if (cursor !== null) {
        const split = cursor.indexOf("\n");
        if (split < 0) throw new Error("invalid blob_refs cursor");
        parsed = { accountId: cursor.slice(0, split), sha: cursor.slice(split + 1) };
      }
      const page = await source.entitlements(accountId, parsed, BLOB_REF_PAGE_LIMIT);
      if (page.rows.length > BLOB_REF_PAGE_LIMIT) throw new Error("blob_refs page exceeded 2000 rows");
      return page;
    }, (rows) => {
      let previous = streamState(db, "entitlements").cursor ?? "";
      for (const row of rows) {
        const tuple = `${row.accountId}\n${row.sha}`;
        if (row.accountId !== accountId || tuple <= previous) throw new Error("blob_refs page is not strict (account_id,sha) keyset order");
        previous = tuple;
        const inHead = db.query("SELECT 1 FROM roots WHERE sha=? AND head=1 LIMIT 1").get(row.sha) != null;
        const inRetained = inHead || db.query("SELECT 1 FROM roots WHERE sha=? LIMIT 1").get(row.sha) != null;
        const classified = classifyEntitlement(row, inHead, inRetained, startedAt);
        insertEntitlement.run(row.sha, row.sizeBytes ?? null, classified.label, classified.missingCatalog ? 1 : 0, classified.inconsistent ? 1 : 0);
      }
    });

    // Drift is deliberately sampled only after the entitlement scan reaches its terminal cursor.
    const workspaceReports: StorageTruthReport["sectionB"]["workspaces"] = [];
    for (const workspace of workspaces) {
      const key = workspaceKey(workspace);
      const scan = db.query(`SELECT pin_head,pin_floor,pin_generation,retries,dropped_rows,seq_rows FROM workspace_scans WHERE workspace=?`).get(key) as Record<string, number>;
      const headRead = await source.currentHead(workspace);
      if (headRead.outcome !== "ok" || !Number.isInteger(headRead.head) || headRead.head! < 0) {
        return incompleteReport("uninspectable", accountId, startedAt, source.now(), {
          workspace,
          reason: headRead.reason ?? "current head unavailable",
        });
      }
      const endingHead = headRead.head!;
      db.prepare("UPDATE workspace_scans SET ending_head=? WHERE workspace=?").run(endingHead, key);
      const pinned: SnapshotTriple = { head: Number(scan.pin_head), pruneFloor: Number(scan.pin_floor), indexGeneration: Number(scan.pin_generation) };
      workspaceReports.push({ workspace, pin: pinned, retries: Number(scan.retries), droppedPages: phase1PageCount(Number(scan.dropped_rows)), seqRootPages: phase1PageCount(Number(scan.seq_rows)), endingHead, headAdvance: endingHead - pinned.head });
    }

    const upsertFleet = db.prepare("INSERT INTO fleet VALUES(?,?,?) ON CONFLICT(sha) DO UPDATE SET active=MAX(active,excluded.active),retained=MAX(retained,excluded.retained)");
    try {
      await spoolPages(db, "fleet", (cursor) => source.fleetReachability(cursor, BLOB_REF_PAGE_LIMIT), (rows) => {
        for (const row of rows) upsertFleet.run(row.sha, row.active ? 1 : 0, row.retained ? 1 : 0);
      });
    } catch (error) {
      if (error instanceof WorkspaceInspectionFailure) {
        return incompleteReport(error.status, accountId, startedAt, source.now(), {
          workspace: error.workspace,
          reason: error.reason,
        });
      }
      throw error;
    }

    let listingStartedAt = Number(metaGet(db, "listing_started_at"));
    if (!Number.isFinite(listingStartedAt) || listingStartedAt === 0) {
      listingStartedAt = source.now();
      metaSet(db, "listing_started_at", listingStartedAt);
    }
    const insertInventory = db.prepare("INSERT OR REPLACE INTO inventory VALUES(?,?,?,?,?,?,?)");
    const insertMember = db.prepare("INSERT OR IGNORE INTO inventory_members VALUES(?,?,?)");
    for (const prefix of ["canonical", "pack"] as const) {
      await spoolPages(db, `inventory:${prefix}`, (cursor) => source.inventory(prefix, cursor, 2_000), (rows) => {
        for (const row of rows) {
          insertInventory.run(prefix, row.key, row.sizeBytes, row.lifecycle, row.rawState, row.expectedPresence ? 1 : 0, row.changedAt ?? null);
          db.prepare("DELETE FROM inventory_members WHERE prefix=? AND key=?").run(prefix, row.key);
          for (const member of row.members ?? []) insertMember.run(prefix, row.key, member.sha);
        }
      });
    }
    const insertObserved = db.prepare("INSERT OR REPLACE INTO observed VALUES(?,?,?,?)");
    for (const prefix of ["canonical", "pack"] as const) {
      await spoolPages(db, `r2:${prefix}`, (cursor) => source.r2(prefix, cursor, 1_000), (rows) => {
        for (const row of rows) insertObserved.run(prefix, row.key, row.sizeBytes, row.uploadedAt);
      });
    }
    let listingEndedAt = Number(metaGet(db, "listing_ended_at"));
    if (!Number.isFinite(listingEndedAt) || listingEndedAt === 0) {
      listingEndedAt = source.now();
      metaSet(db, "listing_ended_at", listingEndedAt);
    }
    const savedCatalogWindow = metaGet(db, "catalog_granted_window");
    let catalogGrantedBytesDuringWindow = Number(savedCatalogWindow);
    if (savedCatalogWindow === null) {
      catalogGrantedBytesDuringWindow = await source.catalogGrantedBytes(listingStartedAt, listingEndedAt);
      metaSet(db, "catalog_granted_window", catalogGrantedBytesDuringWindow);
    }
    const savedInventoryWindow = metaGet(db, "inventory_changed_window");
    let inventoryChangedBytesDuringWindow = Number(savedInventoryWindow);
    if (savedInventoryWindow === null) {
      inventoryChangedBytesDuringWindow = await source.inventoryChangedBytes(listingStartedAt, listingEndedAt);
      metaSet(db, "inventory_changed_window", inventoryChangedBytesDuringWindow);
    }

    const buckets = Object.fromEntries(LABELS.map((label) => [label, emptyMeasure()])) as Record<BaseLabel, Measure>;
    for (const row of db.query("SELECT label,COUNT(*) count,COALESCE(SUM(COALESCE(size,0)),0) bytes,SUM(CASE WHEN size IS NULL THEN 1 ELSE 0 END) unknown FROM entitlements GROUP BY label").all() as Array<Record<string, unknown>>) {
      buckets[String(row.label) as BaseLabel] = { count: Number(row.count), knownBytes: Number(row.bytes), unknownByteRows: Number(row.unknown) };
    }
    const anomalyRow = db.query(`SELECT COUNT(*) total,COALESCE(SUM(missing_catalog),0) missing,COALESCE(SUM(inconsistent),0) inconsistent,
      COALESCE(SUM(CASE WHEN missing_catalog=1 AND inconsistent=1 THEN 1 ELSE 0 END),0) both,
      COALESCE(SUM(COALESCE(size,0)),0) bytes,COALESCE(SUM(CASE WHEN size IS NULL THEN 1 ELSE 0 END),0) unknown FROM entitlements`).get() as Record<string, number>;
    const anomalies = { missingCatalog: Number(anomalyRow.missing), inconsistent: Number(anomalyRow.inconsistent), both: Number(anomalyRow.both) };
    const totalEntitlements = Number(anomalyRow.total);
    const entitlementCatalogBytes = Number(anomalyRow.bytes);
    const unknownCatalogRows = Number(anomalyRow.unknown);
    const cutoff = startedAt - account.retentionDays * DAY_MS;
    const measureQuery = (where: string): Measure => {
      const row = db.query(`WITH grouped AS (
          SELECT sha,MAX(head) has_head,
            MAX(CASE WHEN head=0 AND committed_at IS NOT NULL THEN committed_at END) latest_history,
            MAX(CASE WHEN head=0 THEN timestamp_gap ELSE 0 END) timestamp_gap
          FROM roots GROUP BY sha
        ), r AS (SELECT sha,CASE WHEN has_head=0 AND timestamp_gap=0 AND latest_history IS NOT NULL AND latest_history<? THEN 1 ELSE 0 END expired FROM grouped)
        SELECT COUNT(*) count,COALESCE(SUM(COALESCE(c.size,0)),0) bytes,COALESCE(SUM(CASE WHEN c.sha IS NULL THEN 1 ELSE 0 END),0) unknown
        FROM r LEFT JOIN entitlements e ON e.sha=r.sha LEFT JOIN catalog c ON c.sha=r.sha WHERE ${where}`).get(cutoff) as Record<string, number>;
      return { count: Number(row.count), knownBytes: Number(row.bytes), unknownByteRows: Number(row.unknown) };
    };
    const reachableUnentitled = measureQuery("e.sha IS NULL");
    const windowExpiredRetained = measureQuery("r.expired=1");
    const timestampGapRoots = Number((db.query(`SELECT COUNT(*) n FROM (
      SELECT sha FROM roots GROUP BY sha
      HAVING MAX(head)=0 AND MAX(CASE WHEN head=0 THEN timestamp_gap ELSE 0 END)=1
    )`).get() as { n: number }).n);
    const uniqueRoots = Number((db.query("SELECT COUNT(DISTINCT sha) n FROM roots").get() as { n: number }).n);
    const droppedPages = Math.max(1, ...workspaceReports.map((row) => row.droppedPages));
    const seqRootPages = Math.max(1, ...workspaceReports.map((row) => row.seqRootPages));
    const proximity = { uniqueRoots: capProximity(uniqueRoots, PHASE1_UNIQUE_ROOT_CAP), droppedPages: capProximity(droppedPages, PHASE1_DROPPED_PAGE_CAP), seqRootPages: capProximity(seqRootPages, PHASE1_SEQ_ROOT_PAGE_CAP) };
    const partitionCount = LABELS.reduce((sum, label) => sum + buckets[label].count, 0);
    const skewBoundBytes = catalogGrantedBytesDuringWindow + inventoryChangedBytesDuringWindow;
    let endedAt = Number(metaGet(db, "ended_at"));
    if (!Number.isFinite(endedAt) || endedAt === 0) {
      endedAt = source.now();
      metaSet(db, "ended_at", endedAt);
    }
    return {
      schemaVersion: REPORT_VERSION, status: "complete", accountId, startedAt, endedAt,
      sectionA: { kind: "entitlement-partition", buckets, anomalies, totalEntitlements, partitionCount, partitionHolds: partitionCount === totalEntitlements },
      sectionB: {
        kind: "overlapping-diagnostics",
        arithmeticDrift: { usedBytes: account.usedBytes, entitlementCatalogBytes, signedBytes: account.usedBytes - entitlementCatalogBytes, unknownCatalogRows },
        reachableUnentitled, windowExpiredRetained, timestampGapRoots,
        phase1: { outcome: proximity.uniqueRoots.wouldFail || proximity.droppedPages.wouldFail || proximity.seqRootPages.wouldFail ? "would-fail-closed" : "would-complete", ...proximity },
        workspaces: workspaceReports,
        rescanOffered: workspaceReports.some((workspace) => workspace.headAdvance > HEAD_DRIFT_THRESHOLD),
        physical: {
          listingStartedAt, listingEndedAt, catalogGrantedBytesDuringWindow, inventoryChangedBytesDuringWindow, skewBoundBytes,
          canonical: reconcilePrefixFromDb(db, "canonical", listingStartedAt, skewBoundBytes),
          pack: reconcilePrefixFromDb(db, "pack", listingStartedAt, skewBoundBytes),
        },
      },
    };
  } finally {
    db.close();
  }
}

function incompleteReport(status: "stale-pin" | "uninspectable", accountId: string, startedAt: number, endedAt: number, failure: NonNullable<StorageTruthReport["failure"]>): StorageTruthReport {
  const labels: BaseLabel[] = ["active-head", "retained-history", "fresh", "aged-unmarked", "marked-young", "purge-eligible"];
  const buckets = Object.fromEntries(labels.map((l) => [l, emptyMeasure()])) as Record<BaseLabel, Measure>;
  const rec = reconcilePrefix([], [], endedAt);
  return { schemaVersion: 1, status, accountId, startedAt, endedAt, failure,
    sectionA: { kind: "entitlement-partition", buckets, anomalies: { missingCatalog: 0, inconsistent: 0, both: 0 }, totalEntitlements: 0, partitionCount: 0, partitionHolds: false },
    sectionB: { kind: "overlapping-diagnostics", arithmeticDrift: { usedBytes: 0, entitlementCatalogBytes: 0, signedBytes: 0, unknownCatalogRows: 0 }, reachableUnentitled: emptyMeasure(), windowExpiredRetained: emptyMeasure(), timestampGapRoots: 0, phase1: { outcome: "would-fail-closed", uniqueRoots: capProximity(0, PHASE1_UNIQUE_ROOT_CAP), droppedPages: capProximity(0, PHASE1_DROPPED_PAGE_CAP), seqRootPages: capProximity(0, PHASE1_SEQ_ROOT_PAGE_CAP) }, workspaces: [], rescanOffered: true, physical: { listingStartedAt: endedAt, listingEndedAt: endedAt, catalogGrantedBytesDuringWindow: 0, inventoryChangedBytesDuringWindow: 0, skewBoundBytes: 0, canonical: rec, pack: rec } } };
}

const bytes = (n: number): string => `${n.toLocaleString("en-US")} B`;
export function renderHuman(report: StorageTruthReport): string {
  const lines = [`Storage truth v${report.schemaVersion} — ${report.accountId}`, `status: ${report.status}`, "", "Section A — entitlement partition"];
  if (report.failure) lines.splice(2, 0, `failure: ${report.failure.reason}${report.failure.workspace ? ` (${report.failure.workspace.workspaceId}/${report.failure.workspace.projectId})` : ""}`);
  for (const [label, m] of Object.entries(report.sectionA.buckets)) lines.push(`  ${label}: ${m.count} rows, ${bytes(m.knownBytes)}, ${m.unknownByteRows} unknown-byte`);
  lines.push(`  partition: ${report.sectionA.partitionCount}/${report.sectionA.totalEntitlements} (${report.sectionA.partitionHolds ? "holds" : "FAILED"})`);
  lines.push(`  anomalies: missing-catalog=${report.sectionA.anomalies.missingCatalog} inconsistent=${report.sectionA.anomalies.inconsistent} both=${report.sectionA.anomalies.both}`);
  const b = report.sectionB;
  lines.push("", "Section B — diagnostics (overlapping)");
  lines.push(`  arithmetic drift: ${b.arithmeticDrift.signedBytes >= 0 ? "+" : ""}${bytes(b.arithmeticDrift.signedBytes)}`);
  lines.push(`  R−E: ${b.reachableUnentitled.count} roots, ${bytes(b.reachableUnentitled.knownBytes)}, ${b.reachableUnentitled.unknownByteRows} unknown-byte`);
  lines.push(`  retained but window-expired: ${b.windowExpiredRetained.count} roots, ${bytes(b.windowExpiredRetained.knownBytes)}`);
  lines.push(`  timestamp-gaps: ${b.timestampGapRoots} roots (window-expiry unknown for these)`);
  lines.push(`  Phase-1 probe: ${b.phase1.outcome}`);
  for (const [name, c] of [["roots", b.phase1.uniqueRoots], ["dropped-pages", b.phase1.droppedPages], ["seq-root-pages", b.phase1.seqRootPages]] as const) lines.push(`    ${name}: ${c.observed}/${c.cap}, delta=${c.delta}, ${c.percent.toFixed(2)}%, would-fail=${c.wouldFail}`);
  lines.push(`  head drift rescan offered: ${b.rescanOffered}`);
  for (const [prefix, r] of [["canonical", b.physical.canonical], ["pack", b.physical.pack]] as const) {
    lines.push(`  ${prefix} physical: observed=${bytes(r.observedBytes)} identity=${bytes(r.observedIdentityBytes)} inventory=${bytes(r.inventoryBytes)} identity=${bytes(r.inventoryIdentityBytes)} holds=${r.identityHolds} difference=${bytes(r.sideDifferenceBytes)} within-skew=${r.withinSkewBound}`);
    for (const [state, outcomes] of Object.entries(r.byLifecycle)) for (const [outcome, c] of Object.entries(outcomes)) if (c.count) lines.push(`    ${state}/${outcome}: count=${c.count} observed=${bytes(c.observedBytes)} inventory=${bytes(c.inventoryBytes)} missing-anomaly=${c.missingAnomaly}`);
    if (r.packClasses) for (const [label, m] of Object.entries(r.packClasses)) lines.push(`    pack-${label}: count=${m.count} bytes=${bytes(m.knownBytes)}`);
  }
  lines.push(`  listing skew bound: ${bytes(b.physical.skewBoundBytes)} (${b.physical.listingStartedAt}..${b.physical.listingEndedAt})`);
  return lines.join("\n");
}

export interface StorageTruthRunnerFailure {
  schemaVersion: 1;
  kind: "runner-failure";
  status: "failed";
  failure: {
    name: string;
    component: string;
    environment: string;
    requiredEnvironment: string[];
    reason: string;
    timeoutMs?: number;
  };
}

export function normalizeRunnerFailure(error: unknown): StorageTruthRunnerFailure {
  const value = error && typeof error === "object" ? error as Record<string, unknown> : {};
  const required = Array.isArray(value.requiredEnvironment)
    ? value.requiredEnvironment.filter((item): item is string => typeof item === "string")
    : [];
  return {
    schemaVersion: 1,
    kind: "runner-failure",
    status: "failed",
    failure: {
      name: typeof value.name === "string" ? value.name : "Error",
      component: typeof value.component === "string" ? value.component : "adapter",
      environment: typeof value.environment === "string" ? value.environment : (process.env.RBOX_STORAGE_TRUTH_ENV ?? "production"),
      requiredEnvironment: required,
      reason: typeof value.reason === "string" ? value.reason
        : error instanceof Error ? error.message : typeof error === "string" ? error : "unknown runner failure",
      ...(typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) ? { timeoutMs: value.timeoutMs } : {}),
    },
  };
}

export function renderRunnerFailure(failure: StorageTruthRunnerFailure): string {
  return `Storage truth runner failure\n${JSON.stringify(failure, null, 2)}`;
}

async function emitRunnerFailure(error: unknown, jsonOut: string, writeReport: boolean): Promise<void> {
  const failure = normalizeRunnerFailure(error);
  console.error(renderRunnerFailure(failure));
  if (!writeReport) return;
  try {
    await mkdir(path.dirname(jsonOut), { recursive: true });
    await writeFile(jsonOut, `${JSON.stringify(failure, null, 2)}\n`);
  } catch (writeError) {
    console.error(`runner failure report write failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`);
  }
}

export async function main(): Promise<void> {
  const args = new Map<string, string>();
  for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i]!, process.argv[i + 1]!);
  const accountId = args.get("--account");
  const adapter = args.get("--adapter") ?? process.env.RBOX_STORAGE_TRUTH_ADAPTER;
  const spool = args.get("--spool") ?? path.resolve(".storage-truth-spool");
  const jsonOut = args.get("--json") ?? path.join(spool, "report.json");
  let source: StorageTruthSource | undefined;
  let failed = false;
  try {
    if (!accountId || !adapter) throw new Error("usage: bun scripts/storage-truth.ts --account <id> --adapter <module> [--spool <dir>] [--json <file>]");
    const loaded = await import(pathToFileURL(path.resolve(adapter)).href) as { source?: StorageTruthSource; createSource?: () => Promise<StorageTruthSource> | StorageTruthSource };
    source = loaded.source ?? await loaded.createSource?.();
    if (!source) throw new Error("adapter must export source or createSource()");
    const report = await measureStorageTruth(source, accountId, spool);
    await mkdir(path.dirname(jsonOut), { recursive: true });
    await writeFile(jsonOut, `${JSON.stringify(report, null, 2)}\n`);
    console.log(renderHuman(report));
    if (report.status !== "complete" || !report.sectionA.partitionHolds) process.exitCode = 2;
  } catch (error) {
    failed = true;
    await emitRunnerFailure(error, jsonOut, true);
    process.exitCode = 2;
  } finally {
    try {
      await source?.close?.();
    } catch (error) {
      const cleanup = normalizeRunnerFailure(error);
      cleanup.failure.component = "cleanup";
      await emitRunnerFailure(cleanup.failure, jsonOut, !failed);
      process.exitCode = 2;
    }
  }
}

if (import.meta.main) await main();
