import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  PACK_CONTENT_TYPE,
  PACK_HEADER_BYTES,
  encodePackDirectory,
  encodePackFooter,
  encodePackHeader,
  type PackDirEntry,
} from "../../../src/engine/blob-pack.js";
import type { Env, WorkerEntrypointExports } from "../src/env.js";
import { blobPackPut, packGcMode, PACK_ORPHAN_GRACE_MS, resweepPackTombstones, sweepUploadingPacks } from "../src/blob-pack.js";
import { packKey } from "../src/util.js";
import {
  PACK_GC_CLOCK_STALENESS_MS,
  PACK_INTENT_QUIESCENCE_MS,
  runPackGc,
} from "../src/pack-gc.js";
import { CLOCK_SKEW_MS, RECEIPT_TTL_MS } from "../src/receipts.js";
import { gcPurge, INTENT_QUIESCENCE_MS, PURGE_LEASE_TTL_MS } from "../src/versions.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { blobGet, blobPut, blobsCheck } from "../src/blobs.js";
import { phase1Purge } from "../src/gc-phase1.js";
import { adminRoutes } from "../src/routes/admin.js";
import worker, { GC_PURGE_UTC_HOUR } from "../src/worker.js";

const BASE = "https://example.com";
const NOW = 1_900_000_000_000;
const DAY = 24 * 3600_000;
const LOGICAL_GRACE_MS = 7 * DAY;
const db = () => env.rbox_dev_db;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hashBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
let sequence = 0;
const nextId = (label = "pack-gc"): string => createHash("md5").update(`${label}-${sequence++}`).digest("hex");

interface BuiltPack {
  id: string;
  body: Uint8Array;
  sha: string;
  entries: PackDirEntry[];
  payloads: Uint8Array[];
}

interface PackGcBody {
  marked?: number;
  opened?: number;
  deleted?: number;
  unwound?: number;
  error?: string;
}

beforeAll(async () => applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS));

beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM blob_locations"),
    db().prepare("DELETE FROM pack_gc_candidates"),
    db().prepare("DELETE FROM pack_members"),
    db().prepare("DELETE FROM packs"),
    db().prepare("DELETE FROM blob_ref_candidates"),
    db().prepare("DELETE FROM blob_refs"),
    db().prepare("DELETE FROM gc_candidates"),
    db().prepare("DELETE FROM blobs"),
    db().prepare("DELETE FROM workspaces"),
    db().prepare("DELETE FROM gc_state"),
  ]);
  for (const prefix of ["packs/v1/", "blobs/sha256/", "manifests/sha256/"]) {
    let cursor: string | undefined;
    do {
      const page = await env.rbox_dev_blobs.list({ prefix, cursor });
      await Promise.all(page.objects.map((object) => env.rbox_dev_blobs.delete(object.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
});

function buildPack(payloads: Uint8Array[], id = nextId()): BuiltPack {
  let offset = PACK_HEADER_BYTES;
  const entries = payloads.map((payload) => {
    const entry = { sha256: hash(payload), offset, length: payload.byteLength };
    offset += payload.byteLength;
    return entry;
  });
  const directory = encodePackDirectory(entries);
  const footer = encodePackFooter({
    count: entries.length,
    directoryOffset: offset,
    directoryBytes: directory.byteLength,
    directorySha256: hashBytes(directory),
  });
  const body = new Uint8Array(offset + directory.byteLength + footer.byteLength);
  body.set(encodePackHeader());
  payloads.forEach((payload, index) => body.set(payload, entries[index]!.offset));
  body.set(directory, offset);
  body.set(footer, offset + directory.byteLength);
  return { id, body, sha: hash(body), entries, payloads };
}

function onePack(label: string): BuiltPack {
  return buildPack([new TextEncoder().encode(label)]);
}

async function account(label: string): Promise<string> {
  const accountId = `pack-gc-${label}-${sequence++}`;
  await db()
    .prepare("INSERT INTO accounts(id,plan,created_at,used_bytes,extra_storage_bytes,cap_bytes) VALUES (?,'pro',?,0,0,1000000000)")
    .bind(accountId, Date.now())
    .run();
  return accountId;
}

async function seedPack(
  pack: BuiltPack,
  options: { state?: "uploading" | "ready" | "swept"; createdAt?: number; object?: boolean } = {},
): Promise<void> {
  const state = options.state ?? "ready";
  const createdAt = options.createdAt ?? NOW - PACK_ORPHAN_GRACE_MS - 1;
  await db().batch([
    db()
      .prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,?,?,?,?)")
      .bind(pack.id, pack.sha, pack.body.byteLength, pack.entries.length, state, createdAt, createdAt),
    ...pack.entries.map((entry) =>
      db()
        .prepare("INSERT INTO pack_members(pack_id,sha256,offset,length) VALUES(?,?,?,?)")
        .bind(pack.id, entry.sha256, entry.offset, entry.length),
    ),
  ]);
  if (options.object !== false) await env.rbox_dev_blobs.put(packKey(pack.id), pack.body);
}

async function installLocation(pack: BuiltPack, index = 0): Promise<void> {
  const entry = pack.entries[index]!;
  await db().batch([
    db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(entry.sha256, entry.length),
    db()
      .prepare("INSERT INTO blob_locations(sha256,storage,pack_id,offset,length,pack_sha256,installed_at) VALUES(?,'pack',?,?,?,?,?)")
      .bind(entry.sha256, pack.id, entry.offset, entry.length, pack.sha, NOW),
  ]);
}

async function physicalCandidate(pack: BuiltPack, epoch: string, markedAt: number, deletingAt: number | null = null): Promise<void> {
  await db()
    .prepare("INSERT INTO pack_gc_candidates(pack_id,epoch,marked_at,deleting_at) VALUES(?,?,?,?)")
    .bind(pack.id, epoch, markedAt, deletingAt)
    .run();
}

function packRequest(pack: BuiltPack): Request {
  return new Request(`${BASE}/v1/blob-pack/put`, {
    method: "POST",
    headers: {
      "content-type": PACK_CONTENT_TYPE,
      "x-rbox-protocol": "upload-receipts-v1",
      "x-rbox-pack-id": pack.id,
      "x-rbox-pack-sha256": pack.sha,
    },
    body: pack.body,
  });
}

async function retryPack(pack: BuiltPack, accountId: string, handlerEnv: Env = env): Promise<Response> {
  return blobPackPut(packRequest(pack), handlerEnv, accountId);
}

const fakeState = () => ({
  setWebSocketAutoResponse() {},
  storage: {
    kv: { get() {}, put() {}, delete() {} },
    sql: { exec: () => ({ toArray: () => [] }) },
    transactionSync(fn: () => void) { fn(); },
    async getAlarm() { return null; },
    async setAlarm() {},
  },
}) as unknown as DurableObjectState;

async function redeem(accountId: string, receipts: Record<string, string>, handlerEnv: Env = env): Promise<Response> {
  const sync = new WorkspaceSync(fakeState(), handlerEnv);
  return (sync as unknown as { redeemReceipts(req: Request): Promise<Response> }).redeemReceipts(
    new Request(`${BASE}/v1/ws/ws/proj/root/receipts/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rbox-account": accountId },
      body: JSON.stringify({ receipts }),
    }),
  );
}

type PackBoundary = "pack_fence_read" | "mark_insert" | "open_update" | "r2_delete" | "r2_head" | "terminal_batch" | "sweeper_batch";

interface BoundaryStats {
  fenceReads: number;
  fenceBlocked: boolean | null;
  marks: number;
  markChanges: number;
  markLandedAt: number | null;
  opens: number;
  openChanges: number;
  r2Deletes: number;
  deleteSawLocation: boolean;
  r2Heads: number;
  headAbsent: boolean | null;
  terminals: number;
  sweeps: number;
  sweepChanges: number;
}

function hookedBoundaryEnv(boundary: PackBoundary, packId: string, mode: "mark" | "execute") {
  const realDb = env.rbox_dev_db;
  let fenceBatchPrepared = false;
  let terminalBatchPrepared = false;
  let sweeperBatchPrepared = false;
  const stats: BoundaryStats = {
    fenceReads: 0,
    fenceBlocked: null,
    marks: 0,
    markChanges: 0,
    markLandedAt: null,
    opens: 0,
    openChanges: 0,
    r2Deletes: 0,
    deleteSawLocation: false,
    r2Heads: 0,
    headAbsent: null,
    terminals: 0,
    sweeps: 0,
    sweepChanges: 0,
  };
  let signalReached!: () => void;
  let signalRelease!: () => void;
  const reached = new Promise<void>((resolve) => { signalReached = resolve; });
  const released = new Promise<void>((resolve) => { signalRelease = resolve; });
  let paused = false;
  const pause = async (at: PackBoundary): Promise<void> => {
    if (at !== boundary || paused) return;
    paused = true;
    signalReached();
    await released;
  };
  const wrapRun = (statement: D1PreparedStatement, sql: string): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      if (property !== "run") return Reflect.get(target, property, receiver);
      return async () => {
        const result = await target.run();
        if (sql.includes("INSERT OR IGNORE INTO pack_gc_candidates(pack_id,epoch,marked_at)")) {
          stats.marks++;
          stats.markChanges += Number(result.meta.changes ?? 0);
          stats.markLandedAt = Date.now();
          await pause("mark_insert");
        } else if (sql.includes("UPDATE pack_gc_candidates SET deleting_at")) {
          stats.opens++;
          stats.openChanges += Number(result.meta.changes ?? 0);
          await pause("open_update");
        }
        return result;
      };
    },
  });
  const proxiedDb = new Proxy(realDb, {
    get(target, property, receiver) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        if (sql.includes("pack_gc_candidates WHERE pack_id = ? UNION ALL")) fenceBatchPrepared = true;
        if (sql.includes("DELETE FROM pack_gc_candidates")) terminalBatchPrepared = true;
        if (sql.includes("p.state = 'uploading'")) sweeperBatchPrepared = true;
        return new Proxy(statement, {
          get(stmt, stmtProperty, stmtReceiver) {
            if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
            return (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return sql.includes("INSERT OR IGNORE INTO pack_gc_candidates(pack_id,epoch,marked_at)")
                || sql.includes("UPDATE pack_gc_candidates SET deleting_at")
                ? wrapRun(bound, sql)
                : bound;
            };
          },
        });
      };
      if (property === "batch") return async (statements: D1PreparedStatement[]) => {
        const result = await target.batch(statements);
        if (fenceBatchPrepared) {
          fenceBatchPrepared = false;
          stats.fenceReads++;
          stats.fenceBlocked = (result[1]?.results?.length ?? 0) > 0;
          await pause("pack_fence_read");
        } else if (terminalBatchPrepared && statements.length === 3) {
          terminalBatchPrepared = false;
          stats.terminals++;
          await pause("terminal_batch");
        } else if (sweeperBatchPrepared && statements.length === 2) {
          sweeperBatchPrepared = false;
          stats.sweeps++;
          stats.sweepChanges += Number(result[1]?.meta.changes ?? 0);
          await pause("sweeper_batch");
        }
        return result;
      };
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  const bucket = new Proxy(env.rbox_dev_blobs, {
    get(target, property) {
      if (property === "delete") return async (key: string) => {
        if (key === packKey(packId)) {
          stats.r2Deletes++;
          stats.deleteSawLocation ||= await realDb.prepare("SELECT 1 FROM blob_locations WHERE pack_id=?").bind(packId).first() !== null;
        }
        const result = await target.delete(key);
        if (key === packKey(packId)) await pause("r2_delete");
        return result;
      };
      if (property === "head") return async (key: string) => {
        const result = await target.head(key);
        if (key === packKey(packId)) {
          stats.r2Heads++;
          stats.headAbsent = result === null;
          await pause("r2_head");
        }
        return result;
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    handlerEnv: { ...env, RBOX_BLOB_PACK_GC: mode, rbox_dev_db: proxiedDb, rbox_dev_blobs: bucket } as Env,
    reached,
    release: signalRelease,
    stats,
  };
}

async function receiptsFrom(response: Response): Promise<Record<string, string>> {
  const body = await response.json() as { results: Array<{ sha256: string; receipt: string }> };
  return Object.fromEntries(body.results.map((row) => [row.sha256, row.receipt]));
}

function receiptIssuedAt(receipt: string): number {
  const encoded = receipt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
  const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
  return Number((JSON.parse(atob(padded)) as { t: number }).t);
}

function fenceBarrierEnv(order: "before" | "after"): { handlerEnv: Env; reached: Promise<void>; release: () => void } {
  const real = env.rbox_dev_db;
  let fencePrepared = false;
  let signalReached!: () => void;
  let signalRelease!: () => void;
  const reached = new Promise<void>((resolve) => { signalReached = resolve; });
  const released = new Promise<void>((resolve) => { signalRelease = resolve; });
  let fired = false;
  const proxied = new Proxy(real, {
    get(target, property, receiver) {
      if (property === "prepare") {
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("pack_gc_candidates WHERE pack_id")) return statement;
          fencePrepared = true;
          return statement;
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (fired || !fencePrepared) return target.batch(statements);
          fired = true;
          if (order === "before") {
            signalReached();
            await released;
            return target.batch(statements);
          }
          const result = await target.batch(statements);
          signalReached();
          await released;
          return result;
        };
      }
      return Reflect.get(target, property, receiver);
    },
  }) as D1Database;
  return { handlerEnv: { ...env, rbox_dev_db: proxied } as Env, reached, release: signalRelease };
}

async function runAt(
  nowMs: number,
  options: Omit<NonNullable<Parameters<typeof runPackGc>[1]>, "nowMs" | "clock"> = {},
  handlerEnv: Env = env,
): Promise<PackGcBody> {
  const response = await runPackGc(handlerEnv, { ...options, nowMs, clock: () => nowMs, owner: options.owner ?? nextId("owner") });
  return response.json() as Promise<PackGcBody>;
}

function envBeforeRun(match: (sql: string) => boolean, before: () => Promise<void>): Env {
  const real = env.rbox_dev_db;
  let fired = false;
  const proxied = new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => {
        const statement = target.prepare(sql);
        if (!match(sql)) return statement;
        return new Proxy(statement, {
          get(stmt, stmtProperty, stmtReceiver) {
            if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
            return (...args: unknown[]) => {
              const bound = stmt.bind(...args);
              return new Proxy(bound, {
                get(boundStmt, boundProperty, boundReceiver) {
                  if (boundProperty !== "run") return Reflect.get(boundStmt, boundProperty, boundReceiver);
                  return async () => {
                    if (!fired) {
                      fired = true;
                      await before();
                    }
                    return boundStmt.run();
                  };
                },
              });
            };
          },
        });
      };
    },
  }) as D1Database;
  return { ...env, rbox_dev_db: proxied } as Env;
}

async function packRow(packId: string): Promise<{ state: string } | null> {
  return db().prepare("SELECT state FROM packs WHERE pack_id=?").bind(packId).first<{ state: string }>();
}

async function gcTableSnapshot(): Promise<Record<string, number>> {
  const tables = ["packs", "pack_members", "blob_locations", "pack_gc_candidates", "gc_state"];
  return Object.fromEntries(await Promise.all(tables.map(async (table) => {
    const row = await db().prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>();
    return [table, Number(row?.n ?? 0)] as const;
  })));
}

async function clearBoundaryFixtures(): Promise<void> {
  await db().batch([
    db().prepare("DELETE FROM blob_locations"),
    db().prepare("DELETE FROM pack_gc_candidates"),
    db().prepare("DELETE FROM pack_members"),
    db().prepare("DELETE FROM packs"),
    db().prepare("DELETE FROM blob_ref_candidates"),
    db().prepare("DELETE FROM blob_refs"),
    db().prepare("DELETE FROM gc_candidates"),
    db().prepare("DELETE FROM blobs"),
    db().prepare("DELETE FROM gc_state"),
  ]);
}

async function assertEntitledPackedRead(accountId: string, pack: BuiltPack): Promise<void> {
  const sha = pack.entries[0]!.sha256;
  const check = await blobsCheck(new Request(`${BASE}/v1/blobs/check`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1" },
    body: JSON.stringify({ shas: [sha] }),
  }), env, accountId);
  expect(check.status).toBe(200);
  expect(await check.json()).toMatchObject({ missing: [] });
  const get = await blobGet(env, sha, accountId);
  expect(get.status).toBe(200);
  expect(new Uint8Array(await get.arrayBuffer())).toEqual(pack.payloads[0]);
}

async function assertPackGateInvariants(): Promise<void> {
  const invalid = await db().prepare(
    `SELECT COUNT(*) AS n FROM blob_locations l
     LEFT JOIN pack_members m ON m.pack_id=l.pack_id AND m.sha256=l.sha256
       AND m.offset=l.offset AND m.length=l.length
     LEFT JOIN packs p ON p.pack_id=l.pack_id
     WHERE m.sha256 IS NULL OR p.state!='ready' OR p.pack_sha256!=l.pack_sha256`,
  ).first<{ n: number }>();
  expect(Number(invalid?.n ?? 0)).toBe(0);
  expect(await db().prepare(
    "SELECT 1 FROM blob_locations l JOIN packs p ON p.pack_id=l.pack_id WHERE p.state='swept' LIMIT 1",
  ).first()).toBeNull();
  const located = await db().prepare("SELECT DISTINCT pack_id FROM blob_locations").all<{ pack_id: string }>();
  for (const row of located.results) expect(await env.rbox_dev_blobs.head(packKey(row.pack_id))).not.toBeNull();
}

describe("design 114 staged pack-GC modes", () => {
  test("mode parser maps only the documented values", () => {
    expect(packGcMode({ ...env, RBOX_BLOB_PACK_GC: undefined } as Env)).toBe("off");
    expect(packGcMode({ ...env, RBOX_BLOB_PACK_GC: "0" } as Env)).toBe("off");
    expect(packGcMode({ ...env, RBOX_BLOB_PACK_GC: "shadow" } as Env)).toBe("shadow");
    expect(packGcMode({ ...env, RBOX_BLOB_PACK_GC: "mark" } as Env)).toBe("mark");
    expect(packGcMode({ ...env, RBOX_BLOB_PACK_GC: "1" } as Env)).toBe("execute");
    expect(packGcMode({ ...env, RBOX_BLOB_PACK_GC: "execute" } as Env)).toBe("execute");
  });

  test("shadow returns projected phase counts with no durable or R2 changes", async () => {
    const resurrect = onePack("shadow-resurrect");
    await seedPack(resurrect);
    await installLocation(resurrect);
    await physicalCandidate(resurrect, nextId("shadow-resurrect-epoch"), NOW - DAY);

    const mark = onePack("shadow-mark");
    await seedPack(mark);
    const open = onePack("shadow-open");
    await seedPack(open);
    await physicalCandidate(open, nextId("shadow-open-epoch"), NOW - DAY);
    const execute = onePack("shadow-execute");
    await seedPack(execute);
    await physicalCandidate(execute, nextId("shadow-execute-epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);

    const before = await gcTableSnapshot();
    const rejectMutation = (sql: string): void => {
      if (/\b(?:INSERT|UPDATE|DELETE)\b/i.test(sql)) throw new Error(`shadow attempted D1 mutation: ${sql}`);
    };
    const readOnlyDb = new Proxy(env.rbox_dev_db, {
      get(target, property) {
        if (property === "prepare") return (sql: string) => {
          rejectMutation(sql);
          return target.prepare(sql);
        };
        if (property === "exec") return (sql: string) => {
          rejectMutation(sql);
          return target.exec(sql);
        };
        if (property === "batch") return () => { throw new Error("shadow attempted D1 batch"); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as D1Database;
    const r2Calls: string[] = [];
    const noR2 = new Proxy(env.rbox_dev_blobs, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value === "function") {
          return async () => { r2Calls.push(String(property)); throw new Error("shadow touched R2"); };
        }
        return value;
      },
    });
    const response = await runPackGc(
      { ...env, RBOX_BLOB_PACK_GC: "shadow", rbox_dev_db: readOnlyDb, rbox_dev_blobs: noR2 } as Env,
      { nowMs: NOW, clock: () => NOW, owner: nextId("shadow-owner") },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wouldResurrect: 1, wouldMark: 1, wouldOpen: 1, wouldDelete: 1 });
    expect(r2Calls).toEqual([]);
    expect(await gcTableSnapshot()).toEqual(before);
  });

  test("shadow projects OPEN after the preceding resurrect page", async () => {
    for (let index = 0; index < 50; index++) {
      const pinned = onePack(`shadow-resurrect-page-${index}`);
      await seedPack(pinned, { object: false });
      await installLocation(pinned);
      await physicalCandidate(pinned, nextId("shadow-resurrect-page-epoch"), NOW - 2 * DAY);
    }
    const open = onePack("shadow-open-after-resurrect-page");
    await seedPack(open, { object: false });
    await physicalCandidate(open, nextId("shadow-open-after-resurrect-epoch"), NOW - DAY);
    const response = await runPackGc(
      { ...env, RBOX_BLOB_PACK_GC: "shadow" } as Env,
      { nowMs: NOW, clock: () => NOW, owner: nextId("shadow-page-owner") },
    );
    expect(await response.json()).toMatchObject({ wouldResurrect: 50, wouldOpen: 1 });
  });

  test("mark mode resurrects and marks but never opens, executes, or sweeps uploads", async () => {
    const resurrect = onePack("mark-resurrect");
    await seedPack(resurrect);
    await installLocation(resurrect);
    await physicalCandidate(resurrect, nextId("mark-resurrect-epoch"), NOW - DAY);
    const marked = onePack("mark-new");
    await seedPack(marked);
    const mature = onePack("mark-mature");
    await seedPack(mature);
    await physicalCandidate(mature, nextId("mark-mature-epoch"), NOW - DAY);
    const uploading = onePack("mark-uploading");
    await seedPack(uploading, { state: "uploading", createdAt: NOW - PACK_ORPHAN_GRACE_MS - 1 });

    const markEnv = { ...env, RBOX_BLOB_PACK_GC: "mark" } as Env;
    const result = await runPackGc(markEnv, { nowMs: NOW, clock: () => NOW, owner: nextId("mark-owner") });
    expect(await result.json()).toMatchObject({ unwound: 1, marked: 1, opened: 0, deleted: 0 });
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(resurrect.id).first()).toBeNull();
    expect(await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(marked.id).first()).toEqual({ deleting_at: null });
    expect(await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(mature.id).first()).toEqual({ deleting_at: null });
    expect(await env.rbox_dev_blobs.head(packKey(mature.id))).not.toBeNull();
    await sweepUploadingPacks(markEnv, NOW);
    expect(await packRow(uploading.id)).toEqual({ state: "uploading" });
    expect(await env.rbox_dev_blobs.head(packKey(uploading.id))).not.toBeNull();
  });
});

describe("design 114 §7.3 fence release gates", () => {
  // Gate P1: any candidacy state blocks same-id mint; resurrection restates the invariant per epoch.
  test.each(["mark", "execute"] as const)("P1 mint-fence-any-candidacy: %s mode resurrects before retry", async (mode) => {
    const accountId = await account(`p1-fence-${mode}`);
    const pack = onePack(`p1-fence-${mode}`);
    await seedPack(pack);
    await physicalCandidate(pack, nextId("epoch"), NOW - 10);
    expect((await retryPack(pack, accountId)).status).toBe(503);

    await installLocation(pack);
    const response = await runPackGc(
      { ...env, RBOX_BLOB_PACK_GC: mode } as Env,
      { nowMs: NOW, clock: () => NOW, owner: nextId(`p1-${mode}`) },
    );
    expect(await response.json()).toMatchObject({ unwound: 1 });
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).toBeNull();
    expect((await retryPack(pack, accountId)).status).toBe(200);
  });

  // Gate P1: signed issuance is captured before the fence read; T_mark is the
  // wall time bracketing the INSERT landing, never the row's marked_at value.
  test("P1 issuedAt anchoring: every signed t precedes the later mark INSERT landing", async () => {
    const accountId = await account("p1-time");
    const pack = buildPack([new TextEncoder().encode("p1-a"), new TextEncoder().encode("p1-b")]);
    await seedPack(pack);
    const receipts = await receiptsFrom(await retryPack(pack, accountId));
    const issued = Object.values(receipts).map(receiptIssuedAt);
    while (Date.now() <= Math.max(...issued)) await new Promise((resolve) => setTimeout(resolve, 1));
    const tBefore = Date.now();
    await physicalCandidate(pack, nextId("p1-time-epoch"), NOW - DAY);
    expect(issued.every((value) => value < tBefore)).toBe(true);
  });

  test("P1 statement ordering: candidacy landing before fence read completion returns 503 without receipts", async () => {
    const accountId = await account("p1-mark-first");
    const pack = onePack("p1-mark-first");
    await seedPack(pack);
    const barrier = fenceBarrierEnv("before");
    const pending = retryPack(pack, accountId, barrier.handlerEnv);
    await barrier.reached;
    await physicalCandidate(pack, nextId("p1-mark-first-epoch"), Date.now());
    barrier.release();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "retry_later" });
  });

  test("P1 statement ordering: completed fence read may mint, anchored before the later mark", async () => {
    const accountId = await account("p1-read-first");
    const pack = onePack("p1-read-first");
    await seedPack(pack);
    const barrier = fenceBarrierEnv("after");
    const startedAt = Date.now();
    const pending = retryPack(pack, accountId, barrier.handlerEnv);
    await barrier.reached;
    const readCompletedAt = Math.max(startedAt, Date.now());
    while (Date.now() <= readCompletedAt) await new Promise((resolve) => setTimeout(resolve, 1));
    const tBefore = Date.now();
    await physicalCandidate(pack, nextId("p1-read-first-epoch"), NOW - DAY);
    barrier.release();
    const response = await pending;
    expect(response.status).toBe(200);
    const receipts = await receiptsFrom(response);
    expect(Object.values(receipts).map(receiptIssuedAt).every((issuedAt) => issuedAt < tBefore)).toBe(true);
  });

  // Gate P2 / gate 5: open intent blocks install; an install serialized first makes OPEN a no-op.
  test("P2/gate-5 install fence: redeem aborts 422 and pre-intent install wins serialization", async () => {
    const accountId = await account("p2");
    const fenced = onePack("p2-fenced");
    await seedPack(fenced);
    const receipts = await receiptsFrom(await retryPack(fenced, accountId));
    await physicalCandidate(fenced, nextId("epoch"), NOW - 10, NOW - 5);
    const denied = await redeem(accountId, receipts);
    expect(denied.status).toBe(422);
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE pack_id=?").bind(fenced.id).first()).toBeNull();

    const raced = onePack("p2-race");
    await seedPack(raced);
    await physicalCandidate(raced, nextId("epoch"), NOW - 10);
    const racedEnv = envBeforeRun(
      (sql) => sql.includes("UPDATE pack_gc_candidates SET deleting_at"),
      () => installLocation(raced),
    );
    expect(await runAt(NOW, {}, racedEnv)).toMatchObject({ opened: 0 });
    expect((await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(raced.id).first<{ deleting_at: number | null }>())?.deleting_at).toBeNull();
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE pack_id=?").bind(raced.id).first()).not.toBeNull();
  });

  test("Gate 4 logical intent vs v2 redemption never partially publishes", async () => {
    const accountId = await account("logical-redemption-race");
    const pack = onePack("logical-redemption-race");
    await seedPack(pack);
    const receipts = await receiptsFrom(await retryPack(pack, accountId));
    const sha = pack.entries[0]!.sha256;
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, NOW - DAY, NOW - 1).run();
    const before = await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(accountId).first<{ used_bytes: number }>();
    const response = await redeem(accountId, receipts);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "unsatisfied_blobs", missing: [sha], missingTotal: 1 });
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(sha).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(accountId, sha).first()).toBeNull();
    expect(await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(accountId).first()).toEqual(before);
    expect(await db().prepare("SELECT 1 FROM blobs WHERE sha256=? AND present=1").bind(sha).first()).toBeNull();
  });

  // Round-5 BLOCKER: stale e1 opening and terminal statements cannot mutate replacement e2.
  test("Epoch guard: stale OPEN and stale terminal batch are changes=0 against replacement candidacy", async () => {
    const staleOpen = onePack("epoch-open");
    await seedPack(staleOpen);
    const e1 = nextId("e1");
    const e2 = nextId("e2");
    await physicalCandidate(staleOpen, e1, NOW - 10);
    const replacedEnv = envBeforeRun(
      (sql) => sql.includes("UPDATE pack_gc_candidates SET deleting_at"),
      async () => {
        await db().prepare("UPDATE pack_gc_candidates SET epoch=?,marked_at=? WHERE pack_id=?").bind(e2, NOW - 1, staleOpen.id).run();
      },
    );
    expect(await runAt(NOW, {}, replacedEnv)).toMatchObject({ opened: 0 });
    expect(await db().prepare("SELECT epoch,deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(staleOpen.id).first()).toEqual({ epoch: e2, deleting_at: null });

    const staleTerminal = onePack("epoch-terminal");
    await seedPack(staleTerminal);
    const terminalE1 = nextId("terminal-e1");
    const terminalE2 = nextId("terminal-e2");
    await physicalCandidate(staleTerminal, terminalE1, NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    const real = env.rbox_dev_blobs;
    const racedBucket = {
      delete: (key: string) => real.delete(key),
      head: async (key: string) => {
        const head = await real.head(key);
        await db()
          .prepare("UPDATE pack_gc_candidates SET epoch=?,marked_at=?,deleting_at=NULL WHERE pack_id=?")
          .bind(terminalE2, NOW, staleTerminal.id)
          .run();
        return head;
      },
    } as unknown as R2Bucket;
    expect(await runAt(NOW, {}, { ...env, rbox_dev_blobs: racedBucket } as Env)).toMatchObject({ deleted: 0 });
    expect(await packRow(staleTerminal.id)).toEqual({ state: "ready" });
    expect(await db().prepare("SELECT epoch,deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(staleTerminal.id).first()).toEqual({ epoch: terminalE2, deleting_at: null });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM pack_members WHERE pack_id=?").bind(staleTerminal.id).first())!.n)).toBe(1);
  });

  // Gate P3: quiescence covers receipt authority and the proof clock is read after observation.
  test("P3 quiescence and post-read stamp: young intents skip and live clock stamps after mark", async () => {
    expect(PACK_INTENT_QUIESCENCE_MS).toBeGreaterThanOrEqual(RECEIPT_TTL_MS + CLOCK_SKEW_MS);
    const young = onePack("p3-young");
    await seedPack(young);
    await physicalCandidate(young, nextId("epoch"), NOW - 10, NOW - 1);
    expect(await runAt(NOW)).toMatchObject({ deleted: 0 });
    expect(await env.rbox_dev_blobs.head(packKey(young.id))).not.toBeNull();

    const stamped = onePack("p3-stamp");
    await seedPack(stamped);
    await physicalCandidate(stamped, nextId("epoch"), NOW - 10);
    const liveStamp = NOW + 100;
    let observed = false;
    const realDb = env.rbox_dev_db;
    const observationDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("WHERE c.deleting_at IS NULL AND c.marked_at < ?")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return new Proxy(bound, {
                  get(boundStmt, boundProperty, boundReceiver) {
                    if (boundProperty !== "all") return Reflect.get(boundStmt, boundProperty, boundReceiver);
                    return async () => {
                      const rows = await boundStmt.all();
                      observed = true;
                      return rows;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;
    const result = await runPackGc(
      { ...env, rbox_dev_db: observationDb } as Env,
      { nowMs: NOW, clock: () => observed ? liveStamp : NOW, owner: nextId("clock") },
    );
    expect(result.status).toBe(200);
    const stamp = await db().prepare("SELECT marked_at,deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(stamped.id).first<{ marked_at: number; deleting_at: number }>();
    expect(observed).toBe(true);
    expect(stamp!.deleting_at).toBe(liveStamp);

    const stale = onePack("p3-stale");
    await seedPack(stale);
    await physicalCandidate(stale, nextId("epoch"), NOW - 9);
    await runPackGc(env, { nowMs: NOW, clock: () => NOW + PACK_GC_CLOCK_STALENESS_MS + 1, owner: nextId("stale") });
    expect((await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(stale.id).first<{ deleting_at: number | null }>())?.deleting_at).toBeNull();
  });

  // Gate 5b: resurrection creates a fresh world; displacement re-marks with a new epoch and restarts quiescence.
  test("Gate 5b resurrect history: retry-mint resumes, then new epoch waits a fresh quiescence", async () => {
    const accountId = await account("gate5b");
    const pack = onePack("gate5b");
    await seedPack(pack);
    const firstEpoch = nextId("epoch");
    await physicalCandidate(pack, firstEpoch, NOW - 10);
    await installLocation(pack);
    expect(await runAt(NOW)).toMatchObject({ unwound: 1 });
    expect((await retryPack(pack, accountId)).status).toBe(200);

    await db().prepare("DELETE FROM blob_locations WHERE pack_id=?").bind(pack.id).run();
    const replacement = await db().prepare("SELECT epoch FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first<{ epoch: string }>();
    expect(replacement?.epoch).not.toBe(firstEpoch);
    expect(await runAt(NOW)).toMatchObject({ opened: 1, deleted: 0 });
    expect(await runAt(NOW + PACK_INTENT_QUIESCENCE_MS)).toMatchObject({ deleted: 0 });
    expect(await runAt(NOW + PACK_INTENT_QUIESCENCE_MS + 1)).toMatchObject({ deleted: 1 });
  });

  // Gate 7: a live placement pins physical bytes; retirement makes the pack collectible.
  test("Gate 7 pinning: mark is a no-op until the final location retires", async () => {
    const pack = onePack("pinning");
    await seedPack(pack);
    await installLocation(pack);
    expect(await runAt(NOW)).toMatchObject({ marked: 0 });
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).toBeNull();
    const sha = pack.entries[0]!.sha256;
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, NOW - 2 * DAY, NOW - INTENT_QUIESCENCE_MS - 1).run();
    expect(await (await gcPurge(env, LOGICAL_GRACE_MS, { nowMs: NOW, clock: () => NOW, owner: nextId("pin-logical") })).json()).toMatchObject({ purged: 1 });
    expect(await runAt(NOW + 1)).toMatchObject({ opened: 1, deleted: 0 });
    expect(await runAt(NOW + 1 + PACK_INTENT_QUIESCENCE_MS + 1)).toMatchObject({ deleted: 1 });
  });

  // §7.2: logical Phase 2 retires only placement/catalog and lets the displacement trigger mark the pack.
  test("§7.2 logical Phase 2: packed cleanup is one guarded no-R2 batch and creates candidacy", async () => {
    const pack = onePack("logical-packed");
    await seedPack(pack);
    await installLocation(pack);
    const sha = pack.entries[0]!.sha256;
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, NOW - 2 * DAY, NOW - INTENT_QUIESCENCE_MS - 1).run();
    let bucketCalls = 0;
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    const noR2 = {
      ...env,
      rbox_metrics: { writeDataPoint: (point: { blobs: string[]; doubles: number[] }) => points.push(point) } as AnalyticsEngineDataset,
      rbox_dev_blobs: {
        delete: async () => { bucketCalls++; throw new Error("packed logical GC touched R2"); },
        head: async () => { bucketCalls++; throw new Error("packed logical GC touched R2"); },
      } as unknown as R2Bucket,
    } as Env;
    const response = await gcPurge(noR2, LOGICAL_GRACE_MS, { nowMs: NOW, clock: () => NOW, owner: nextId("logical") });
    expect(await response.json()).toMatchObject({ purged: 1 });
    expect(bucketCalls).toBe(0);
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(sha).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM blobs WHERE sha256=?").bind(sha).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM gc_candidates WHERE sha256=?").bind(sha).first()).toBeNull();
    expect(await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).toEqual({ deleting_at: null });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM pack_members WHERE pack_id=?").bind(pack.id).first())!.n)).toBe(1);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).not.toBeNull();
    expect(points.find((point) => point.blobs[0] === "gc.pack.locations_retired")?.doubles[5]).toBe(1);
  });

  // §7.2 failure unit: losing the logical purge lease before the one cleanup batch makes every destructive statement a no-op.
  test("§7.2 guarded batch: lease loss preserves location, catalog, intent, inventory, and object", async () => {
    const pack = onePack("logical-guarded");
    await seedPack(pack);
    await installLocation(pack);
    const sha = pack.entries[0]!.sha256;
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, NOW - 2 * DAY, NOW - INTENT_QUIESCENCE_MS - 1).run();
    const realDb = env.rbox_dev_db;
    let intercepted = false;
    const guardedDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          if (!intercepted && statements.length === 4) {
            intercepted = true;
            const successor = { owner: "successor", acquired: NOW, expires: NOW + PURGE_LEASE_TTL_MS };
            await target.prepare("UPDATE gc_state SET v=? WHERE k='purge_lease'").bind(JSON.stringify(successor)).run();
          }
          return target.batch(statements);
        };
      },
    }) as D1Database;
    const response = await gcPurge(
      { ...env, rbox_dev_db: guardedDb } as Env,
      LOGICAL_GRACE_MS,
      { nowMs: NOW, clock: () => NOW, owner: "stale-holder" },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ purged: 0 });
    expect(intercepted).toBe(true);
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(sha).first()).not.toBeNull();
    expect(await db().prepare("SELECT 1 FROM blobs WHERE sha256=?").bind(sha).first()).not.toBeNull();
    expect(await db().prepare("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL").bind(sha).first()).not.toBeNull();
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM pack_members WHERE pack_id=?").bind(pack.id).first())!.n)).toBe(1);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).not.toBeNull();
  });

  // §7.2 resurrection arm: regained refs unwind logical intent without moving placement.
  test("§7.2 resurrected logical candidate leaves packed location and object intact", async () => {
    const pack = onePack("logical-resurrect");
    await seedPack(pack);
    await installLocation(pack);
    const sha = pack.entries[0]!.sha256;
    const accountId = await account("logical-resurrect");
    await db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)").bind(accountId, sha, NOW).run();
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, NOW - 2 * DAY, NOW - INTENT_QUIESCENCE_MS - 1).run();
    const response = await gcPurge(env, LOGICAL_GRACE_MS, { nowMs: NOW, clock: () => NOW, owner: nextId("logical-resurrect") });
    expect(await response.json()).toMatchObject({ purged: 0, unwound: 1 });
    expect(await db().prepare("SELECT 1 FROM gc_candidates WHERE sha256=?").bind(sha).first()).toBeNull();
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(sha).first()).not.toBeNull();
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).not.toBeNull();
  });

  test("Gate 3 packed Phase-1 stale snapshot cannot retire a head-reachable member", async () => {
    const pack = onePack("phase1-stale-packed");
    await seedPack(pack);
    await installLocation(pack);
    const sha = pack.entries[0]!.sha256;
    const accountId = await account("phase1-stale-packed");
    await db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)").bind(accountId, sha, NOW - DAY).run();
    await db().prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES(?,?,?)").bind(accountId, sha, NOW - DAY).run();
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, NOW - 2 * DAY, NOW - INTENT_QUIESCENCE_MS - 1).run();
    const purge = await gcPurge(env, LOGICAL_GRACE_MS, { nowMs: NOW, clock: () => NOW, owner: nextId("phase1-stale") });
    expect(await purge.json()).toMatchObject({ purged: 0 });
    expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(sha).first()).not.toBeNull();
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).not.toBeNull();

    expect(await phase1Purge(db(), accountId, new Set([sha]), 0, NOW)).toMatchObject({ purged: 0, resurrected: 1 });
    const check = await blobsCheck(new Request(`${BASE}/v1/blobs/check`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1" },
      body: JSON.stringify({ shas: [sha] }),
    }), env, accountId);
    // The receipts branch may also mint an uploadGrant (§109) — only the
    // missing set is under test here.
    expect(await check.json()).toMatchObject({ missing: [] });
    const get = await blobGet(env, sha, accountId);
    expect(get.status).toBe(200);
    expect(new Uint8Array(await get.arrayBuffer())).toEqual(pack.payloads[0]);
  });

  // Gate 8: an expired/lost holder cannot dispatch or clear the durable fence.
  test("Gate 8 lease/kill safety: expiry after readiness dispatches no delete and preserves intent", async () => {
    const pack = onePack("lease-expiry");
    await seedPack(pack);
    await physicalCandidate(pack, nextId("epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    let live = NOW;
    const realDb = env.rbox_dev_db;
    const proxiedDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SELECT 1 FROM pack_gc_candidates c")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return new Proxy(bound, {
                  get(boundStmt, boundProperty, boundReceiver) {
                    if (boundProperty !== "first") return Reflect.get(boundStmt, boundProperty, boundReceiver);
                    return async () => {
                      const row = await boundStmt.first();
                      live = NOW + PURGE_LEASE_TTL_MS + 1;
                      return row;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;
    let deletes = 0;
    const guarded = {
      ...env,
      rbox_dev_db: proxiedDb,
      rbox_dev_blobs: {
        delete: async () => { deletes++; },
        head: (key: string) => env.rbox_dev_blobs.head(key),
      } as unknown as R2Bucket,
    } as Env;
    const response = await runPackGc(guarded, { nowMs: NOW, clock: () => live, owner: nextId("expiring") });
    expect(response.status).toBe(200);
    expect(deletes).toBe(0);
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=? AND deleting_at IS NOT NULL").bind(pack.id).first()).not.toBeNull();
  });

  // Gate 8: R2 uncertainty never guesses success; retry converges and does not double-count.
  test("Gate 8 delete/HEAD retry: failures retain intent, rerun converges once", async () => {
    const deleteFailure = onePack("delete-failure");
    const headPresent = onePack("head-present");
    for (const pack of [deleteFailure, headPresent]) {
      await seedPack(pack);
      await physicalCandidate(pack, nextId("epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    }
    const real = env.rbox_dev_blobs;
    const uncertain = {
      ...env,
      rbox_dev_blobs: {
        delete: async (key: string) => {
          if (key === packKey(deleteFailure.id)) throw new Error("delete failed");
          if (key === packKey(headPresent.id)) return;
          await real.delete(key);
        },
        head: (key: string) => real.head(key),
      } as unknown as R2Bucket,
    } as Env;
    expect(await runAt(NOW, {}, uncertain)).toMatchObject({ deleted: 0 });
    for (const pack of [deleteFailure, headPresent]) {
      expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).not.toBeNull();
    }
    expect(await runAt(NOW + 1)).toMatchObject({ deleted: 2 });
    expect(await runAt(NOW + 2)).toMatchObject({ deleted: 0 });
  });

  // Round-4 scope: ready-only executor ignores uploading/swept; swept is re-HEAD-owned elsewhere.
  test("Scope: uploading is never marked/opened/executed and swept is tombstone-resweep only", async () => {
    const uploading = onePack("scope-uploading");
    const swept = onePack("scope-swept");
    await seedPack(uploading, { state: "uploading" });
    await seedPack(swept, { state: "swept" });
    await physicalCandidate(uploading, nextId("epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    await physicalCandidate(swept, nextId("epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    expect(await runAt(NOW)).toMatchObject({ marked: 0, opened: 0, deleted: 0, unwound: 0 });
    expect(await env.rbox_dev_blobs.head(packKey(uploading.id))).not.toBeNull();
    expect(await env.rbox_dev_blobs.head(packKey(swept.id))).not.toBeNull();
    await resweepPackTombstones(env);
    expect(await env.rbox_dev_blobs.head(packKey(uploading.id))).not.toBeNull();
    expect(await env.rbox_dev_blobs.head(packKey(swept.id))).toBeNull();
    expect(await packRow(swept.id)).toEqual({ state: "swept" });
  });

  test("Keyset cursors resume a 51-pack mark/open backlog without hiding the tail", async () => {
    const packs = Array.from({ length: 51 }, (_, index) => onePack(`cursor-${index}`));
    await db().batch(
      packs.flatMap((pack) => [
        db()
          .prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,1,'ready',?,?)")
          .bind(pack.id, pack.sha, pack.body.byteLength, NOW - PACK_ORPHAN_GRACE_MS - 1, NOW - PACK_ORPHAN_GRACE_MS - 1),
        db()
          .prepare("INSERT INTO pack_members(pack_id,sha256,offset,length) VALUES(?,?,?,?)")
          .bind(pack.id, pack.entries[0]!.sha256, pack.entries[0]!.offset, pack.entries[0]!.length),
      ]),
    );
    expect(await runAt(NOW)).toMatchObject({ marked: 50, opened: 0 });
    expect(await runAt(NOW + 1)).toMatchObject({ marked: 1, opened: 50 });
    expect(await runAt(NOW + 2)).toMatchObject({ marked: 0, opened: 1 });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM pack_gc_candidates WHERE deleting_at IS NOT NULL").first())!.n)).toBe(51);
  });

  // Round-5 terminal invariant: the sole successful terminal world is a durable swept tombstone.
  test("Terminal atomicity: successful execute ends swept with no members or candidacy", async () => {
    const pack = onePack("terminal-success");
    await seedPack(pack);
    await physicalCandidate(pack, nextId("epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    expect(await runAt(NOW)).toMatchObject({ deleted: 1 });
    expect(await packRow(pack.id)).toEqual({ state: "swept" });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM pack_members WHERE pack_id=?").bind(pack.id).first())!.n)).toBe(0);
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).toBeNull();
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
  });

  // Round-5 crash point: object absence before terminal batch still retains candidate/fence and ready inventory.
  test("Terminal atomicity: crash before batch leaves fence intact and retry tombstones", async () => {
    const pack = onePack("terminal-crash");
    await seedPack(pack);
    await physicalCandidate(pack, nextId("epoch"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
    const realDb = env.rbox_dev_db;
    let terminalAttempts = 0;
    const crashingDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length === 3 && terminalAttempts++ === 0) throw new Error("crash before terminal batch");
          return target.batch(statements);
        };
      },
    }) as D1Database;
    const failed = await runPackGc({ ...env, rbox_dev_db: crashingDb } as Env, { nowMs: NOW, clock: () => NOW, owner: nextId("crash") });
    expect(failed.status).toBe(500);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
    expect(await packRow(pack.id)).toEqual({ state: "ready" });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM pack_members WHERE pack_id=?").bind(pack.id).first())!.n)).toBe(1);
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=? AND deleting_at IS NOT NULL").bind(pack.id).first()).not.toBeNull();
    expect(await db().prepare("SELECT 1 FROM gc_state WHERE k='pack_execute_cursor'").first()).toBeNull();
    expect(await runAt(NOW + 1)).toMatchObject({ deleted: 1 });
    expect(await packRow(pack.id)).toEqual({ state: "swept" });
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).toBeNull();
    expect(await runAt(NOW + 2)).toMatchObject({ deleted: 0 });
  });

  test.each(["mark", "execute"] as const)("hooked boundary histories preserve every pack gate in %s mode", async (mode) => {
    const boundaries: PackBoundary[] = [
      "pack_fence_read",
      "mark_insert",
      "open_update",
      "r2_delete",
      "r2_head",
      "terminal_batch",
      "sweeper_batch",
    ];
    const seeds = [0x114, 0x214, 0x314];
    for (const seed of seeds) {
      for (const boundary of boundaries) {
        await clearBoundaryFixtures();
        const accountId = await account(`boundary-${mode}-${boundary}-${seed}`);
        const target = onePack(`boundary-target-${mode}-${boundary}-${seed}`);
        const sentinel = onePack(`boundary-sentinel-${mode}-${boundary}-${seed}`);
        await seedPack(target);
        await seedPack(sentinel, { createdAt: NOW });
        await installLocation(sentinel);
        await db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)")
          .bind(accountId, sentinel.entries[0]!.sha256, NOW).run();

        const targetReceipt = await receiptsFrom(await retryPack(target, accountId));
        if (boundary === "open_update") {
          await physicalCandidate(target, nextId("boundary-open"), NOW - DAY);
        } else if (["r2_delete", "r2_head", "terminal_batch"].includes(boundary)) {
          await physicalCandidate(target, nextId("boundary-execute"), NOW - 2 * DAY, NOW - PACK_INTENT_QUIESCENCE_MS - 1);
        } else if (boundary === "sweeper_batch") {
          const old = NOW - PACK_ORPHAN_GRACE_MS - 1;
          await db().prepare("UPDATE packs SET state='uploading',created_at=?,touched_at=? WHERE pack_id=?")
            .bind(old, old, target.id).run();
        }

        const hook = hookedBoundaryEnv(boundary, target.id, mode);
        const isMarkReachable = boundary === "pack_fence_read" || boundary === "mark_insert";
        if (mode === "mark" && !isMarkReachable) {
          // Some boundaries SEED an already-open intent; mark mode must leave
          // deleting_at exactly as seeded (never stamp, never retire).
          const seededDeletingAt = (await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(target.id).first<{ deleting_at: number | null }>())?.deleting_at ?? null;
          if (boundary === "sweeper_batch") await sweepUploadingPacks(hook.handlerEnv, NOW);
          else await runPackGc(hook.handlerEnv, { nowMs: NOW, clock: () => NOW, owner: nextId("boundary-mark-forbidden") });
          expect(hook.stats.opens).toBe(0);
          expect(hook.stats.r2Deletes).toBe(0);
          expect(hook.stats.r2Heads).toBe(0);
          expect(hook.stats.terminals).toBe(0);
          expect(hook.stats.sweeps).toBe(0);
          expect((await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(target.id).first<{ deleting_at: number | null }>())?.deleting_at ?? null).toBe(seededDeletingAt);
          expect(await env.rbox_dev_blobs.head(packKey(target.id))).not.toBeNull();
          await assertEntitledPackedRead(accountId, sentinel);
          await assertPackGateInvariants();
          continue;
        }

        let pending: Promise<Response> | Promise<void>;
        let mint: Response;
        if (boundary === "pack_fence_read") {
          const mintPending = retryPack(target, accountId, hook.handlerEnv);
          await hook.reached;
          let markLandingWall = 0;
          try {
            expect(hook.stats.fenceBlocked).toBe(false);
            const issuedBeforeFence = Date.now();
            while (Date.now() <= issuedBeforeFence) await new Promise((resolve) => setTimeout(resolve, 1));
            markLandingWall = Date.now();
            const gc = await runPackGc(
              { ...env, RBOX_BLOB_PACK_GC: mode } as Env,
              { nowMs: NOW, clock: () => NOW, owner: nextId("boundary-fence-mark") },
            );
            expect(gc.status).toBe(200);
            expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(target.id).first()).not.toBeNull();
            const redeemed = await redeem(accountId, targetReceipt, hook.handlerEnv);
            expect(redeemed.status).toBe(200);
            expect(await redeemed.json()).toEqual({ granted: 1, alreadyEntitled: 0, rejected: 0 });
            expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=? AND pack_id=?").bind(target.entries[0]!.sha256, target.id).first()).not.toBeNull();
            await assertEntitledPackedRead(accountId, target);
            await assertEntitledPackedRead(accountId, sentinel);
          } finally {
            hook.release();
            mint = await mintPending;
          }
          expect(mint.status).toBe(200);
          const minted = await receiptsFrom(mint);
          expect(Object.values(minted).every((receipt) => receiptIssuedAt(receipt) < markLandingWall)).toBe(true);
        } else {
          pending = boundary === "sweeper_batch"
            ? sweepUploadingPacks(hook.handlerEnv, NOW)
            : runPackGc(hook.handlerEnv, { nowMs: NOW, clock: () => NOW, owner: nextId("boundary-run") });
          await hook.reached;
          try {
            const candidateAtPause = await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?")
              .bind(target.id).first() !== null;
            const sweptAtPause = (await packRow(target.id))?.state === "swept";
            if (boundary === "mark_insert") {
              expect(hook.stats.markChanges).toBe(1);
              expect(candidateAtPause).toBe(true);
            } else if (boundary === "open_update") {
              expect(hook.stats.openChanges).toBe(1);
              expect((await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(target.id).first<{ deleting_at: number | null }>())?.deleting_at).not.toBeNull();
            } else if (boundary === "r2_delete") {
              expect(await env.rbox_dev_blobs.head(packKey(target.id))).toBeNull();
              expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=? AND deleting_at IS NOT NULL").bind(target.id).first()).not.toBeNull();
              expect(await db().prepare("SELECT 1 FROM blob_locations WHERE pack_id=?").bind(target.id).first()).toBeNull();
            } else if (boundary === "r2_head") {
              expect(hook.stats.headAbsent).toBe(true);
            } else if (boundary === "terminal_batch") {
              expect(await packRow(target.id)).toEqual({ state: "swept" });
              expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(target.id).first()).toBeNull();
              expect(await db().prepare("SELECT 1 FROM pack_members WHERE pack_id=?").bind(target.id).first()).toBeNull();
            } else if (boundary === "sweeper_batch") {
              expect(hook.stats.sweepChanges).toBe(1);
              expect(await packRow(target.id)).toEqual({ state: "swept" });
              expect(await db().prepare("SELECT 1 FROM pack_members WHERE pack_id=?").bind(target.id).first()).toBeNull();
            }
            mint = await retryPack(target, accountId, hook.handlerEnv);
            const redeemed = await redeem(accountId, targetReceipt, hook.handlerEnv);
            if (boundary === "mark_insert") {
              expect(redeemed.status).toBe(200);
              expect(await redeemed.json()).toEqual({ granted: 1, alreadyEntitled: 0, rejected: 0 });
              expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=? AND pack_id=?").bind(target.entries[0]!.sha256, target.id).first()).not.toBeNull();
              await assertEntitledPackedRead(accountId, target);
            } else if (["open_update", "r2_delete", "r2_head"].includes(boundary)) {
              expect(redeemed.status).toBe(422);
              expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(target.entries[0]!.sha256).first()).toBeNull();
            } else {
              expect(redeemed.status).toBe(200);
              expect(await redeemed.json()).toEqual({ granted: 0, alreadyEntitled: 0, rejected: 1 });
              expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(target.entries[0]!.sha256).first()).toBeNull();
            }
            await assertEntitledPackedRead(accountId, sentinel);
            if (hook.stats.fenceBlocked === true) expect(mint.status).toBe(503);
            if (candidateAtPause || sweptAtPause) expect(mint.status).toBe(503);
          } finally {
            hook.release();
            await pending;
          }
        }

        const location = await db().prepare("SELECT 1 FROM blob_locations WHERE pack_id=?").bind(target.id).first();
        if (location) {
          await runPackGc(
            { ...env, RBOX_BLOB_PACK_GC: mode } as Env,
            { nowMs: NOW + 1, clock: () => NOW + 1, owner: nextId("boundary-unwind") },
          );
        } else if (mode === "execute" && (await packRow(target.id))?.state === "ready") {
          let candidate = await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?")
            .bind(target.id).first<{ deleting_at: number | null }>();
          if (candidate?.deleting_at == null) {
            await runAt(NOW + 1);
            candidate = await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?")
              .bind(target.id).first<{ deleting_at: number | null }>();
          }
          if (candidate?.deleting_at != null) await runAt(Number(candidate.deleting_at) + PACK_INTENT_QUIESCENCE_MS + 1);
        }

        expect(hook.stats.deleteSawLocation).toBe(false);
        const row = await packRow(target.id);
        if (row?.state === "swept") {
          expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(target.id).first()).toBeNull();
          expect(await db().prepare("SELECT 1 FROM pack_members WHERE pack_id=?").bind(target.id).first()).toBeNull();
          expect(await env.rbox_dev_blobs.head(packKey(target.id))).toBeNull();
        } else {
          expect(row).toEqual({ state: "ready" });
          expect(await env.rbox_dev_blobs.head(packKey(target.id))).not.toBeNull();
        }
        if (mode === "mark") {
          expect(hook.stats.opens).toBe(0);
          expect(hook.stats.r2Deletes).toBe(0);
          expect(hook.stats.terminals).toBe(0);
        }
        await assertPackGateInvariants();
      }
    }
  }, 30_000);

  test("over-deadline open await uses its post-observation live clock", async () => {
    const pack = onePack("over-deadline-open");
    await seedPack(pack);
    await physicalCandidate(pack, nextId("over-deadline-epoch"), Date.now() - 1);
    const markLandingWall = Date.now();
    const start = markLandingWall + 10;
    let signalObserved!: () => void;
    let signalRelease!: () => void;
    const observed = new Promise<void>((resolve) => { signalObserved = resolve; });
    const released = new Promise<void>((resolve) => { signalRelease = resolve; });
    const realDb = env.rbox_dev_db;
    let paused = false;
    const observationDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("WHERE c.deleting_at IS NULL AND c.marked_at < ?")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return new Proxy(bound, {
                  get(boundStmt, boundProperty, boundReceiver) {
                    if (boundProperty !== "all") return Reflect.get(boundStmt, boundProperty, boundReceiver);
                    return async () => {
                      const rows = await boundStmt.all();
                      if (!paused) {
                        paused = true;
                        signalObserved();
                        await released;
                      }
                      return rows;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;
    let live = start;
    const pending = runPackGc(
      { ...env, rbox_dev_db: observationDb } as Env,
      { nowMs: start, clock: () => live, deadlineMs: 10, owner: nextId("over-deadline-owner") },
    );
    await observed;
    live = start + 11;
    signalRelease();
    expect((await pending).status).toBe(200);
    const candidate = await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?")
      .bind(pack.id).first<{ deleting_at: number }>();
    expect(candidate?.deleting_at).toBe(live);
    expect(Number(candidate?.deleting_at)).toBeGreaterThan(markLandingWall);
  });

  // Gates 1/6: randomized publish/redeem/retire/re-add history preserves every entitled placement.
  test("Gates 1/6 flow: randomized histories always resolve live blobs and never delete a located pack", async () => {
    const accountId = await account("history");
    const payloadBySha = new Map<string, Uint8Array>();
    const active = new Map<string, BuiltPack>();

    const publish = async (payload: Uint8Array, label: string) => {
      const pack = buildPack([payload], nextId(label));
      const put = await retryPack(pack, accountId);
      expect(put.status).toBe(200);
      const receipts = await receiptsFrom(put);
      expect((await redeem(accountId, receipts)).status).toBe(200);
      payloadBySha.set(pack.entries[0]!.sha256, payload);
      active.set(pack.entries[0]!.sha256, pack);
    };
    const assertLive = async () => {
      const rows = await db()
        .prepare("SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256=r.sha256 AND b.present=1 WHERE r.account_id=? ORDER BY r.sha256")
        .bind(accountId)
        .all<{ sha256: string }>();
      const shas = rows.results.map((row) => row.sha256);
      const check = await blobsCheck(
        new Request(`${BASE}/v1/blobs/check`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1" },
          body: JSON.stringify({ shas }),
        }),
        env,
        accountId,
      );
      expect(check.status).toBe(200);
      expect(await check.json()).toMatchObject({ missing: [] });
      for (const row of rows.results) {
        const response = await blobGet(env, row.sha256, accountId);
        expect(response.status).toBe(200);
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(payloadBySha.get(row.sha256));
      }
      const located = await db().prepare("SELECT DISTINCT pack_id FROM blob_locations").all<{ pack_id: string }>();
      for (const row of located.results) expect(await env.rbox_dev_blobs.head(packKey(row.pack_id))).not.toBeNull();
      const usage = await db().prepare(
        "SELECT a.used_bytes actual, COALESCE(SUM(b.size_bytes),0) expected FROM accounts a LEFT JOIN blob_refs r ON r.account_id=a.id LEFT JOIN blobs b ON b.sha256=r.sha256 WHERE a.id=? GROUP BY a.id",
      ).bind(accountId).first<{ actual: number; expected: number }>();
      expect(Number(usage?.actual ?? 0)).toBe(Number(usage?.expected ?? 0));
    };

    const payloads = ["history-a", "history-b", "history-c"].map((value) => new TextEncoder().encode(value));
    for (let index = 0; index < payloads.length; index++) await publish(payloads[index]!, `initial-${index}`);
    const uploadingOrphan = onePack("history-uploading-orphan");
    await seedPack(uploadingOrphan, { state: "uploading", createdAt: NOW - PACK_ORPHAN_GRACE_MS - 1 });
    await assertLive(); // disabled world: callers simply do not invoke physical GC.

    const seed = 0x114;
    let random = seed;
    const nextRandom = () => {
      random = (random * 1664525 + 1013904223) >>> 0;
      return random;
    };
    type HistoryAction = "pack_publish" | "redeem" | "v1_displacement" | "logical_retire" | "gc_mark" | "gc_open" | "gc_execute" | "sweeper" | "re_add";
    const remaining: HistoryAction[] = ["pack_publish", "redeem", "v1_displacement", "logical_retire", "gc_mark", "gc_open", "gc_execute", "sweeper", "re_add"];
    const cyclePayload = payloads[0]!;
    const cycleSha = hash(cyclePayload);
    const former = active.get(cycleSha)!;
    const pendingPayload = new TextEncoder().encode("history-pending-publication");
    let pending: { pack: BuiltPack; receipts: Record<string, string> } | null = null;
    let pendingRedeemed = false;
    let displaced = false;
    let retired = false;
    let marked = false;
    let opened = false;
    let deleted = false;
    const tick = NOW;
    try {
      while (remaining.length) {
        const valid = remaining.filter((action) => {
          if (action === "redeem") return pending !== null;
          if (action === "logical_retire") return displaced;
          if (action === "gc_mark") return retired && pendingRedeemed;
          if (action === "gc_open") return marked;
          if (action === "gc_execute") return opened;
          if (action === "re_add") return deleted;
          return true;
        });
        const action = valid[nextRandom() % valid.length]!;
        remaining.splice(remaining.indexOf(action), 1);

        if (action === "pack_publish") {
          const pack = buildPack([pendingPayload], nextId("history-publish-only"));
          const response = await retryPack(pack, accountId);
          expect(response.status).toBe(200);
          pending = { pack, receipts: await receiptsFrom(response) };
        } else if (action === "redeem") {
          expect((await redeem(accountId, pending!.receipts)).status).toBe(200);
          payloadBySha.set(pending!.pack.entries[0]!.sha256, pendingPayload);
          active.set(pending!.pack.entries[0]!.sha256, pending!.pack);
          pending = null;
          pendingRedeemed = true;
        } else if (action === "v1_displacement") {
          const canonical = await blobPut(new Request(`${BASE}/v1/blobs/${cycleSha}`, {
            method: "PUT",
            headers: { "content-length": String(cyclePayload.byteLength), "x-rbox-protocol": "upload-receipts-v1" },
            body: cyclePayload,
          }), env, cycleSha, accountId);
          expect(canonical.status).toBe(200);
          const v1 = await canonical.json() as { receipt: string };
          await db().prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES(?,?,?)").bind(accountId, cycleSha, tick).run();
          expect((await redeem(accountId, { [cycleSha]: v1.receipt })).status).toBe(200);
          expect(await db().prepare("SELECT 1 FROM blob_locations WHERE sha256=?").bind(cycleSha).first()).toBeNull();
          displaced = true;
        } else if (action === "logical_retire") {
          await db().batch([
            db().prepare("UPDATE accounts SET used_bytes=MAX(0,used_bytes-?) WHERE id=?").bind(cyclePayload.byteLength, accountId),
            db().prepare("DELETE FROM blob_refs WHERE account_id=? AND sha256=?").bind(accountId, cycleSha),
          ]);
          await db().prepare("INSERT OR REPLACE INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(cycleSha, tick - 2 * DAY, tick - INTENT_QUIESCENCE_MS - 1).run();
          expect(await (await gcPurge(env, LOGICAL_GRACE_MS, { nowMs: tick, clock: () => tick, owner: nextId("history-logical") })).json()).toMatchObject({ purged: 1 });
          active.delete(cycleSha);
          retired = true;
        } else if (action === "gc_mark") {
          const markOnly = await runPackGc({ ...env, RBOX_BLOB_PACK_GC: "mark" } as Env, { nowMs: tick + 1, clock: () => tick + 1, owner: nextId("history-mark") });
          expect(markOnly.status).toBe(200);
          marked = true;
        } else if (action === "gc_open") {
          expect(await runAt(tick + 2)).toMatchObject({ deleted: 0 });
          opened = true;
        } else if (action === "gc_execute") {
          expect(await runAt(tick + 2 + PACK_INTENT_QUIESCENCE_MS + 1)).toMatchObject({ deleted: 1 });
          expect(await env.rbox_dev_blobs.head(packKey(former.id))).toBeNull();
          deleted = true;
        } else if (action === "sweeper") {
          await sweepUploadingPacks(env, tick + 3 + PACK_INTENT_QUIESCENCE_MS);
          expect(await packRow(uploadingOrphan.id)).toEqual({ state: "swept" });
          expect(await env.rbox_dev_blobs.head(packKey(uploadingOrphan.id))).toBeNull();
        } else if (action === "re_add") {
          await publish(cyclePayload, "history-readd");
        }
        await assertLive();
      }
    } catch (error) {
      throw new Error(`pack GC randomized history failed (seed=${seed})`, { cause: error });
    }
  });
});

describe("design 114 pack-GC admin surfaces", () => {
  const platform = { "x-rbox-platform": "test-platform-secret" };

  function routeContext(urlText: string, method: string, handlerEnv: Env, headers: Record<string, string> = platform) {
    const url = new URL(urlText);
    return {
      req: new Request(url, { method, headers }),
      env: handlerEnv,
      exports: {} as WorkerEntrypointExports,
      url,
      seg: url.pathname.split("/").filter(Boolean),
    };
  }

  test("phase=packs honors every mode while destructive resweep remains execute-only", async () => {
    const disabled = { ...env, RBOX_BLOB_PACK_GC: "0" } as Env;
    const phase = await adminRoutes(routeContext(`${BASE}/v1/admin/gc?phase=packs`, "POST", disabled));
    expect(phase?.status).toBe(409);
    expect(await phase?.json()).toEqual({ error: "pack_gc_disabled" });
    const resweep = await adminRoutes(routeContext(`${BASE}/v1/admin/gc/pack-tombstones/resweep`, "POST", disabled));
    expect(resweep?.status).toBe(409);
    for (const mode of ["shadow", "mark", "execute"] as const) {
      const modeEnv = { ...env, RBOX_BLOB_PACK_GC: mode } as Env;
      expect((await adminRoutes(routeContext(`${BASE}/v1/admin/gc?phase=packs`, "POST", modeEnv)))?.status).toBe(200);
      const modeResweep = await adminRoutes(routeContext(`${BASE}/v1/admin/gc/pack-tombstones/resweep`, "POST", modeEnv));
      expect(modeResweep?.status).toBe(mode === "execute" ? 200 : 409);
    }
    const audit = await adminRoutes(routeContext(`${BASE}/v1/admin/gc/pack-tombstones`, "GET", disabled));
    expect(audit?.status).toBe(200);
  });

  test("platform-only audit lists permanent tombstones and resweep deletes reappeared bytes", async () => {
    const pack = onePack("admin-tombstone");
    await seedPack(pack, { state: "swept" });
    expect((await SELF.fetch(`${BASE}/v1/admin/gc/pack-tombstones`)).status).toBe(404);
    const audit = await SELF.fetch(`${BASE}/v1/admin/gc/pack-tombstones`, { headers: platform });
    expect(audit.status).toBe(200);
    expect(await audit.json()).toMatchObject({ tombstones: [{ packId: pack.id }], count: 1 });
    const resweep = await SELF.fetch(`${BASE}/v1/admin/gc/pack-tombstones/resweep`, { method: "POST", headers: platform });
    expect(resweep.status).toBe(200);
    expect(await resweep.json()).toMatchObject({ observed: 1, reDeleted: 1 });
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
    expect(await packRow(pack.id)).toEqual({ state: "swept" });
    expect((await SELF.fetch(`${BASE}/v1/admin/gc?phase=packs`, { method: "POST", headers: platform })).status).toBe(200);
  });

  test("purge-hour scheduling uses the independent pack kill switch", async () => {
    const pack = onePack("scheduled-independent");
    await seedPack(pack);
    const now = Date.now();
    await physicalCandidate(pack, nextId("epoch"), now - 2 * DAY, now - PACK_INTENT_QUIESCENCE_MS - 1);
    await worker.scheduled(
      { scheduledTime: Date.UTC(2027, 0, 1, GC_PURGE_UTC_HOUR) } as ScheduledController,
      { ...env, RBOX_GC_PURGE_DISABLED: "1", RBOX_BLOB_PACK_GC: "1" } as Env,
    );
    expect(await packRow(pack.id)).toEqual({ state: "swept" });
  });
});
