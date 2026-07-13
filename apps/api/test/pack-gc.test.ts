import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
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
import { blobPackPut, packKey, PACK_ORPHAN_GRACE_MS, resweepPackTombstones } from "../src/blob-pack.js";
import {
  PACK_GC_CLOCK_STALENESS_MS,
  PACK_INTENT_QUIESCENCE_MS,
  runPackGc,
} from "../src/pack-gc.js";
import { CLOCK_SKEW_MS, RECEIPT_TTL_MS } from "../src/receipts.js";
import { gcPurge, INTENT_QUIESCENCE_MS, PURGE_LEASE_TTL_MS } from "../src/versions.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { blobGet, blobsCheck } from "../src/blobs.js";
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

async function redeem(accountId: string, receipts: Record<string, string>): Promise<Response> {
  const sync = new WorkspaceSync(fakeState(), env);
  return (sync as unknown as { redeemReceipts(req: Request): Promise<Response> }).redeemReceipts(
    new Request(`${BASE}/v1/ws/ws/proj/root/receipts/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rbox-account": accountId },
      body: JSON.stringify({ receipts }),
    }),
  );
}

async function receiptsFrom(response: Response): Promise<Record<string, string>> {
  const body = await response.json() as { results: Array<{ sha256: string; receipt: string }> };
  return Object.fromEntries(body.results.map((row) => [row.sha256, row.receipt]));
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

describe("design 114 §7.3 fence release gates", () => {
  // Gate P1: any candidacy state blocks same-id mint; resurrection restates the invariant per epoch.
  test("P1 mint-fence-any-candidacy: marked-only blocks retry until RESURRECT", async () => {
    const accountId = await account("p1-fence");
    const pack = onePack("p1-fence");
    await seedPack(pack);
    await physicalCandidate(pack, nextId("epoch"), NOW - 10);
    expect((await retryPack(pack, accountId)).status).toBe(503);

    await installLocation(pack);
    expect(await runAt(NOW)).toMatchObject({ unwound: 1 });
    expect(await db().prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first()).toBeNull();
    expect((await retryPack(pack, accountId)).status).toBe(200);
  });

  // Gate P1: signed issuance is captured before the fence read; this sequential cell records T_mark explicitly.
  test("P1 issuedAt anchoring: every signed t precedes the later mark landing", async () => {
    const accountId = await account("p1-time");
    const pack = buildPack([new TextEncoder().encode("p1-a"), new TextEncoder().encode("p1-b")]);
    await seedPack(pack);
    const beforeFence = 10_000;
    const afterFence = 20_000;
    let fencePrepared = false;
    const realDb = env.rbox_dev_db;
    const observedDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          if (sql.startsWith("SELECT sha256 FROM gc_candidates WHERE deleting_at IS NOT NULL")) fencePrepared = true;
          return target.prepare(sql);
        };
      },
    }) as D1Database;
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => fencePrepared ? afterFence : beforeFence);
    let receipts: Record<string, string>;
    try {
      receipts = await receiptsFrom(await retryPack(pack, accountId, { ...env, rbox_dev_db: observedDb } as Env));
    } finally {
      dateNow.mockRestore();
    }
    const issued = Object.values(receipts).map((receipt) => {
      const encoded = receipt.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/");
      const padded = encoded.padEnd(Math.ceil(encoded.length / 4) * 4, "=");
      return Number((JSON.parse(atob(padded)) as { t: number }).t);
    });
    expect(fencePrepared).toBe(true);
    expect(issued).toEqual([beforeFence, beforeFence]);
    expect(await runAt(NOW)).toMatchObject({ marked: 1 });
    const mark = await db().prepare("SELECT marked_at FROM pack_gc_candidates WHERE pack_id=?").bind(pack.id).first<{ marked_at: number }>();
    expect(issued.every((value) => value < mark!.marked_at)).toBe(true);
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
    const crashingDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "batch") return Reflect.get(target, property, receiver);
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length === 3) throw new Error("crash before terminal batch");
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
    expect(await runAt(NOW + 1)).toMatchObject({ deleted: 1 });
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
        /^[0-9a-f]{64}$/,
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
    };

    const payloads = ["history-a", "history-b", "history-c"].map((value) => new TextEncoder().encode(value));
    for (let index = 0; index < payloads.length; index++) await publish(payloads[index]!, `initial-${index}`);
    await assertLive(); // disabled world: callers simply do not invoke physical GC.

    let random = 0x114;
    const pick = () => {
      random = (random * 1664525 + 1013904223) >>> 0;
      return random % payloads.length;
    };
    let tick = NOW;
    for (let step = 0; step < 2; step++) {
      const index = pick();
      const payload = payloads[index]!;
      const sha = hash(payload);
      const former = active.get(sha)!;
      await db().prepare("DELETE FROM blob_refs WHERE account_id=? AND sha256=?").bind(accountId, sha).run();
      await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(sha, tick - 2 * DAY, tick - INTENT_QUIESCENCE_MS - 1).run();
      expect(await (await gcPurge(env, LOGICAL_GRACE_MS, { nowMs: tick, clock: () => tick, owner: nextId("history-logical") })).json()).toMatchObject({ purged: 1 });
      active.delete(sha);
      await assertLive();

      expect(await runAt(tick + 1)).toMatchObject({ deleted: 0 });
      await assertLive();
      expect(await runAt(tick + 1 + PACK_INTENT_QUIESCENCE_MS + 1)).toMatchObject({ deleted: 1 });
      expect(await env.rbox_dev_blobs.head(packKey(former.id))).toBeNull();
      await assertLive();

      await publish(payload, `readd-${step}`);
      await assertLive();
      tick += PACK_INTENT_QUIESCENCE_MS + DAY;
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

  test("phase=packs and forced resweep require the pack-GC flag; audit remains available", async () => {
    const disabled = { ...env, RBOX_BLOB_PACK_GC: "0" } as Env;
    const phase = await adminRoutes(routeContext(`${BASE}/v1/admin/gc?phase=packs`, "POST", disabled));
    expect(phase?.status).toBe(409);
    expect(await phase?.json()).toEqual({ error: "pack_gc_disabled" });
    const resweep = await adminRoutes(routeContext(`${BASE}/v1/admin/gc/pack-tombstones/resweep`, "POST", disabled));
    expect(resweep?.status).toBe(409);
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
