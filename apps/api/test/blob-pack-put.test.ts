import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  PACK_CONTENT_TYPE,
  PACK_HEADER_BYTES,
  PACK_MAX_BODY_BYTES,
  encodePackDirectory,
  encodePackFooter,
  encodePackHeader,
  parsePack,
  type PackDirEntry,
} from "../../../src/engine/blob-pack.js";
import { blobPackPut, packKey, PACK_ORPHAN_GRACE_MS, sweepUploadingPacks } from "../src/blob-pack.js";
import { blobKey } from "../src/util.js";
import { mintUploadGrant } from "../src/grants.js";
import { verifyReceipt } from "../src/receipts.js";
import type { Env } from "../src/env.js";

const BASE = "https://example.com";
let sequence = 0;
const db = () => env.rbox_dev_db;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hashBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const nextId = (): string => createHash("md5").update(`pack-test-${sequence++}`).digest("hex");

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<{ token: string; accountId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string; accountId: string }>;
}

interface BuiltPack {
  id: string;
  body: Uint8Array;
  sha: string;
  entries: PackDirEntry[];
  payloads: Uint8Array[];
}

function buildPack(payloads: Uint8Array[], id = nextId()): BuiltPack {
  const entries: PackDirEntry[] = [];
  let offset = PACK_HEADER_BYTES;
  for (const payload of payloads) {
    entries.push({ sha256: hash(payload), offset, length: payload.byteLength });
    offset += payload.byteLength;
  }
  const directory = encodePackDirectory(entries);
  const footer = encodePackFooter({
    count: entries.length,
    directoryOffset: offset,
    directoryBytes: directory.byteLength,
    directorySha256: hashBytes(directory),
  });
  const body = new Uint8Array(offset + directory.byteLength + footer.byteLength);
  body.set(encodePackHeader(), 0);
  for (let i = 0; i < payloads.length; i++) body.set(payloads[i]!, entries[i]!.offset);
  body.set(directory, offset);
  body.set(footer, offset + directory.byteLength);
  return { id, body, sha: hash(body), entries, payloads };
}

function smallPack(id = nextId(), label = id): BuiltPack {
  return buildPack(Array.from({ length: 3 }, (_, i) => new TextEncoder().encode(`${label}-member-${i}`)), id);
}

function headers(pack: BuiltPack, token?: string): Record<string, string> {
  return {
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    "content-type": PACK_CONTENT_TYPE,
    "x-rbox-protocol": "upload-receipts-v1",
    "x-rbox-pack-id": pack.id,
    "x-rbox-pack-sha256": pack.sha,
  };
}

function request(pack: BuiltPack, token?: string, extra: Record<string, string> = {}): Request {
  return new Request(`${BASE}/v1/blob-pack/put`, { method: "POST", headers: { ...headers(pack, token), ...extra }, body: pack.body });
}

async function direct(pack: BuiltPack, handlerEnv: Env, accountId: string): Promise<Response> {
  return blobPackPut(request(pack), handlerEnv, accountId);
}

interface R2Call { op: "put" | "delete" | "head"; key: string }

function recordingEnv(calls: R2Call[], points?: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }>): Env {
  const bucket = new Proxy(env.rbox_dev_blobs, {
    get(target, property) {
      if (property === "put") return (key: string, value: Uint8Array, options?: R2PutOptions) => {
        calls.push({ op: "put", key });
        return target.put(key, value, options);
      };
      if (property === "delete") return (key: string) => {
        calls.push({ op: "delete", key });
        return target.delete(key);
      };
      if (property === "head") return (key: string) => {
        calls.push({ op: "head", key });
        return target.head(key);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    ...env,
    rbox_dev_blobs: bucket,
    ...(points ? { rbox_metrics: { writeDataPoint: (point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) => points.push(point) } as AnalyticsEngineDataset } : {}),
  } as Env;
}

async function packRow(id: string) {
  return db().prepare("SELECT * FROM packs WHERE pack_id = ?").bind(id).first<{
    pack_sha256: string;
    size_bytes: number;
    member_count: number;
    state: string;
    created_at: number;
    touched_at: number;
  }>();
}

async function memberRows(id: string) {
  return (await db().prepare("SELECT sha256, offset, length FROM pack_members WHERE pack_id = ? ORDER BY offset").bind(id).all<PackDirEntry>()).results;
}

describe("POST /v1/blob-pack/put auth and validation", () => {
  test("requires a bearer and rejects an upload-grant-only request", async () => {
    const a = await bootstrap("pack-auth");
    const pack = smallPack();
    expect((await SELF.fetch(request(pack))).status).toBe(401);
    const grant = await mintUploadGrant(env, { accountId: a.accountId, nowMs: Date.now() });
    expect((await SELF.fetch(request(pack, undefined, { "x-rbox-upload-grant": grant! }))).status).toBe(401);
  });

  test("acceptance flag is a machine-readable 404", async () => {
    const pack = smallPack();
    const res = await direct(pack, { ...env, RBOX_BLOB_PACK_ACCEPT: "0" } as Env, "unused");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "pack_disabled" });
  });

  test("rejects missing receipt protocol and malformed pack headers", async () => {
    const a = await bootstrap("pack-bad-headers");
    const pack = smallPack();
    const noProtocol = await SELF.fetch(request(pack, a.token, { "x-rbox-protocol": "" }));
    expect(noProtocol.status).toBe(400);
    expect(await noProtocol.json()).toEqual({ error: "receipts_required" });
    const badId = await SELF.fetch(request(pack, a.token, { "x-rbox-pack-id": "ABC" }));
    expect(badId.status).toBe(400);
  });

  test("rejects whole-pack, member, and structural corruption without durable garbage", async () => {
    const a = await bootstrap("pack-corrupt");
    const wrongWhole = smallPack();
    const wholeRes = await SELF.fetch(request(wrongWhole, a.token, { "x-rbox-pack-sha256": "0".repeat(64) }));
    expect(wholeRes.status).toBe(400);
    expect(await wholeRes.json()).toEqual({ error: "pack_sha_mismatch" });

    const memberBad = smallPack();
    memberBad.body[memberBad.entries[0]!.offset] ^= 0xff;
    memberBad.sha = hash(memberBad.body);
    const memberRes = await SELF.fetch(request(memberBad, a.token));
    expect(memberRes.status).toBe(400);
    expect(await memberRes.json()).toEqual({ error: "member_sha_mismatch" });
    expect(await packRow(memberBad.id)).toBeNull();
    expect(await memberRows(memberBad.id)).toEqual([]);
    expect(await env.rbox_dev_blobs.head(packKey(memberBad.id))).toBeNull();

    const structural = smallPack();
    structural.body[15] = 1;
    structural.sha = hash(structural.body);
    const structuralRes = await SELF.fetch(request(structural, a.token));
    expect(structuralRes.status).toBe(400);
    expect(await structuralRes.json()).toEqual({ error: "bad_pack", reason: "bad_flags" });

    const badMagic = smallPack();
    badMagic.body[0] ^= 0xff;
    badMagic.sha = hash(badMagic.body);
    const magicRes = await SELF.fetch(request(badMagic, a.token));
    expect(await magicRes.json()).toEqual({ error: "bad_pack", reason: "bad_magic" });

    const badDirectoryHash = smallPack();
    badDirectoryHash.body[badDirectoryHash.body.byteLength - 1] ^= 0xff;
    badDirectoryHash.sha = hash(badDirectoryHash.body);
    const directoryRes = await SELF.fetch(request(badDirectoryHash, a.token));
    expect(await directoryRes.json()).toEqual({ error: "bad_pack", reason: "directory_sha_mismatch" });
  });

  test("rejects bodies above 8 MiB", async () => {
    const a = await bootstrap("pack-over-cap");
    const pack = smallPack();
    pack.body = new Uint8Array(PACK_MAX_BODY_BYTES + 1);
    pack.sha = hash(pack.body);
    const res = await SELF.fetch(request(pack, a.token));
    expect(res.status).toBe(400);
  });
});

describe("pack publication and idempotency", () => {
  test("publishes one pack, preserves directory order, and mints v2 receipts", async () => {
    const a = await bootstrap("pack-happy");
    const pack = smallPack();
    const calls: R2Call[] = [];
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const parsed = parsePack(pack.body);
    expect(parsed).toMatchObject({ ok: true, entries: pack.entries });
    if (!parsed.ok) throw new Error("test pack did not parse");
    for (const entry of parsed.entries) expect(hash(pack.body.subarray(entry.offset, entry.offset + entry.length))).toBe(entry.sha256);

    const res = await direct(pack, recordingEnv(calls, points), a.accountId);
    expect(res.status).toBe(200);
    const body = await res.json() as { packId: string; packSha256: string; results: Array<{ sha256: string; sizeBytes: number; receipt: string }> };
    expect(body.packId).toBe(pack.id);
    expect(body.packSha256).toBe(pack.sha);
    expect(body.results.map((result) => result.sha256)).toEqual(pack.entries.map((entry) => entry.sha256));
    for (const result of body.results) {
      expect(await verifyReceipt(env, result.receipt, { accountId: a.accountId, encSha: result.sha256, size: result.sizeBytes, nowMs: Date.now() })).toEqual({ ok: true, size: result.sizeBytes, packId: pack.id });
      expect(await env.rbox_dev_blobs.head(blobKey(result.sha256))).toBeNull();
    }
    const object = await env.rbox_dev_blobs.get(packKey(pack.id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(pack.body);
    expect(await packRow(pack.id)).toMatchObject({ pack_sha256: pack.sha, size_bytes: pack.body.byteLength, member_count: pack.entries.length, state: "ready" });
    expect(await memberRows(pack.id)).toEqual(pack.entries);
    expect(calls.filter((call) => call.op === "put")).toEqual([{ op: "put", key: packKey(pack.id) }]);
    expect(calls.filter((call) => call.op === "put" && pack.entries.some((entry) => call.key === blobKey(entry.sha256)))).toEqual([]);

    const generic = points.find((point) => point.blobs?.[0] === "blob.packPut");
    expect(generic?.doubles?.[4]).toBe(pack.body.byteLength);
    expect(generic?.doubles?.[5]).toBe(pack.entries.length);
    const phasePoints = points.filter((point) => point.blobs?.[0] === "blob.packPut.phases");
    expect(phasePoints).toHaveLength(1);
    expect(phasePoints[0]?.blobs).toEqual(["blob.packPut.phases", "ok"]);
    expect(phasePoints[0]?.doubles).toHaveLength(6);
    expect(phasePoints[0]?.doubles?.every((value) => Number.isFinite(value) && value >= 0)).toBe(true);
    expect(phasePoints[0]?.doubles?.[5]).toBe(pack.entries.reduce((sum, entry) => sum + entry.length, 0));
    const serialized = JSON.stringify(points);
    for (const forbidden of [pack.id, pack.sha, a.accountId, ...pack.entries.map((entry) => entry.sha256)]) expect(serialized).not.toContain(forbidden);
  });

  test("accepts an exactly-8-MiB valid pack", async () => {
    const a = await bootstrap("pack-exact-cap");
    const count = 33;
    const overhead = PACK_HEADER_BYTES + count * 48 + 72;
    let remaining = PACK_MAX_BODY_BYTES - overhead;
    const payloads = Array.from({ length: count }, (_, i) => {
      const length = Math.min(256 * 1024, remaining - (count - i - 1));
      remaining -= length;
      const bytes = new Uint8Array(length);
      bytes.fill(i + 1);
      return bytes;
    });
    expect(remaining).toBe(0);
    const pack = buildPack(payloads);
    expect(pack.body.byteLength).toBe(PACK_MAX_BODY_BYTES);
    expect((await SELF.fetch(request(pack, a.token))).status).toBe(200);
  }, 30_000);

  test("repairs uploading inventory and ready-verifies subsequent retries", async () => {
    const a = await bootstrap("pack-retry");
    const pack = smallPack();
    const old = Date.now() - 1000;
    await db().batch([
      db().prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,?,'uploading',?,?)").bind(pack.id, pack.sha, pack.body.byteLength, pack.entries.length, old, old),
      ...pack.entries.map((entry) => db().prepare("INSERT INTO pack_members(pack_id,sha256,offset,length) VALUES(?,?,?,?)").bind(pack.id, entry.sha256, entry.offset, entry.length)),
    ]);
    const repaired = await SELF.fetch(request(pack, a.token));
    expect(repaired.status).toBe(200);
    expect(await packRow(pack.id)).toMatchObject({ state: "ready" });
    const readyRetry = await SELF.fetch(request(pack, a.token));
    expect(readyRetry.status).toBe(200);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).not.toBeNull();
    expect(await db().prepare("SELECT COUNT(*) n FROM packs WHERE pack_id=?").bind(pack.id).first<{ n: number }>()).toMatchObject({ n: 1 });
  });

  test("ready retry rejects equal-length object corruption and mints no receipts", async () => {
    const a = await bootstrap("pack-ready-corrupt");
    const pack = smallPack();
    expect((await SELF.fetch(request(pack, a.token))).status).toBe(200);
    const corrupt = pack.body.slice();
    corrupt[pack.entries[0]!.offset] ^= 0xff;
    expect(corrupt.byteLength).toBe(pack.body.byteLength);
    await env.rbox_dev_blobs.put(packKey(pack.id), corrupt);
    const retry = await SELF.fetch(request(pack, a.token));
    expect(retry.status).toBe(503);
    expect(await retry.json()).toEqual({ error: "retry_later" });
  });

  test("same id with a different checksum conflicts without mixing inventory", async () => {
    const a = await bootstrap("pack-conflict");
    const id = nextId();
    const winner = smallPack(id, "winner");
    const loser = smallPack(id, "loser");
    expect((await SELF.fetch(request(winner, a.token))).status).toBe(200);
    const before = await memberRows(id);
    const res = await SELF.fetch(request(loser, a.token));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "pack_conflict" });
    expect(await memberRows(id)).toEqual(before);
  });

  test("same-id concurrent PUT never deletes the winner's shared object", async () => {
    const a = await bootstrap("pack-concurrent");
    const pack = smallPack(nextId(), "concurrent-shared");
    const calls: R2Call[] = [];
    const barrier = () => {
      let signalReached!: () => void;
      let signalRelease!: () => void;
      const reached = new Promise<void>((resolve) => { signalReached = resolve; });
      const released = new Promise<void>((resolve) => { signalRelease = resolve; });
      const bucket = new Proxy(env.rbox_dev_blobs, {
        get(target, property) {
          if (property === "put") return async (key: string, value: Uint8Array, options?: R2PutOptions) => {
            calls.push({ op: "put", key });
            signalReached();
            await released;
            return target.put(key, value, options);
          };
          if (property === "delete") return (key: string) => {
            calls.push({ op: "delete", key });
            return target.delete(key);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return { handlerEnv: { ...env, rbox_dev_blobs: bucket } as Env, reached, release: signalRelease };
    };
    const leftBarrier = barrier();
    const rightBarrier = barrier();
    const leftPending = direct(pack, leftBarrier.handlerEnv, a.accountId);
    const rightPending = direct(pack, rightBarrier.handlerEnv, a.accountId);
    await Promise.all([leftBarrier.reached, rightBarrier.reached]);
    leftBarrier.release();
    let loser!: Response;
    try {
      const winner = await leftPending;
      expect(winner.status).toBe(200);
    } finally {
      rightBarrier.release();
      loser = await rightPending;
    }
    expect(loser.status).toBe(503);
    expect(await loser.json()).toEqual({ error: "retry_later" });
    expect(calls.filter((call) => call.op === "delete" && call.key === packKey(pack.id))).toEqual([]);
    const object = await env.rbox_dev_blobs.get(packKey(pack.id));
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(pack.body);
    expect(await packRow(pack.id)).toMatchObject({ state: "ready" });
    expect(await memberRows(pack.id)).toEqual(pack.entries);
    expect(await db().prepare("SELECT COUNT(*) n FROM packs WHERE pack_id=? AND state='ready'").bind(pack.id).first()).toEqual({ n: 1 });
  });

  test("R2 failure leaves an inventoried uploading orphan and no receipts", async () => {
    const a = await bootstrap("pack-r2-failure");
    const pack = smallPack();
    const failedBucket = new Proxy(env.rbox_dev_blobs, {
      get(target, property, receiver) {
        if (property === "put") return async () => { throw new Error("r2 unavailable"); };
        return Reflect.get(target, property, receiver);
      },
    });
    const res = await direct(pack, { ...env, rbox_dev_blobs: failedBucket } as Env, a.accountId);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "pack_r2_error" });
    expect(await packRow(pack.id)).toMatchObject({ state: "uploading" });
    expect(await memberRows(pack.id)).toEqual(pack.entries);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
  });
});

describe("quota and fences", () => {
  test("aggregate quota rejects non-entitled bytes while entitled members cost zero", async () => {
    const over = await bootstrap("pack-quota-over");
    await db().prepare("UPDATE accounts SET plan='none', cap_bytes=1 WHERE id=?").bind(over.accountId).run();
    const rejected = smallPack();
    const overRes = await SELF.fetch(request(rejected, over.token));
    expect(overRes.status).toBe(402);
    expect(await packRow(rejected.id)).toBeNull();

    const entitled = await bootstrap("pack-quota-entitled");
    const payloads = [new TextEncoder().encode("already one"), new TextEncoder().encode("already two")];
    for (const payload of payloads) {
      const res = await SELF.fetch(`${BASE}/v1/blobs/${hash(payload)}`, {
        method: "PUT",
        headers: { authorization: `Bearer ${entitled.token}`, "content-length": String(payload.byteLength) },
        body: payload,
      });
      expect(res.status).toBe(200);
    }
    await db().prepare("UPDATE accounts SET plan='tiny', extra_storage_bytes=0, cap_bytes=1 WHERE id=?").bind(entitled.accountId).run();
    const pack = buildPack(payloads);
    expect((await SELF.fetch(request(pack, entitled.token))).status).toBe(200);
  });

  test("logical and pack fences fail closed after the object write", async () => {
    const a = await bootstrap("pack-fences");
    const logical = smallPack();
    await db().prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES(?,'blob',?,?)").bind(logical.entries[0]!.sha256, Date.now(), Date.now()).run();
    const logicalRes = await SELF.fetch(request(logical, a.token));
    expect(logicalRes.status).toBe(503);
    expect(await packRow(logical.id)).toMatchObject({ state: "uploading" });
    expect(await env.rbox_dev_blobs.head(packKey(logical.id))).not.toBeNull();

    const physical = smallPack();
    await db().prepare("INSERT INTO pack_gc_candidates(pack_id,epoch,marked_at,deleting_at) VALUES(?,?,?,NULL)").bind(physical.id, nextId(), Date.now()).run();
    const physicalRes = await SELF.fetch(request(physical, a.token));
    expect(physicalRes.status).toBe(503);
    expect(await packRow(physical.id)).toMatchObject({ state: "uploading" });
  });

  test("a swept tombstone denies reuse without writing R2", async () => {
    const a = await bootstrap("pack-tombstone");
    const pack = smallPack();
    const now = Date.now();
    await db().prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,?,'swept',?,?)").bind(pack.id, pack.sha, pack.body.byteLength, pack.entries.length, now, now).run();
    const res = await SELF.fetch(request(pack, a.token));
    expect(res.status).toBe(503);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
  });

  test("a lost heartbeat race returns 503 before any R2 write", async () => {
    const a = await bootstrap("pack-heartbeat-race");
    const pack = smallPack();
    const now = Date.now();
    await db().batch([
      db().prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,?,'uploading',?,?)").bind(pack.id, pack.sha, pack.body.byteLength, pack.entries.length, now, now),
      ...pack.entries.map((entry) => db().prepare("INSERT INTO pack_members(pack_id,sha256,offset,length) VALUES(?,?,?,?)").bind(pack.id, entry.sha256, entry.offset, entry.length)),
    ]);
    const real = env.rbox_dev_db;
    const racedDb = new Proxy(real, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("UPDATE packs SET touched_at = ?")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return new Proxy(bound, {
                  get(value, boundProperty, boundReceiver) {
                    if (boundProperty === "run") return async () => ({ meta: { changes: 0 } });
                    return Reflect.get(value, boundProperty, boundReceiver);
                  },
                });
              };
            },
          });
        };
      },
    });
    const res = await direct(pack, { ...env, rbox_dev_db: racedDb } as Env, a.accountId);
    expect(res.status).toBe(503);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
  });
});

describe("uploading orphan sweeper", () => {
  async function seed(pack: BuiltPack, createdAt: number, touchedAt: number, state: "uploading" | "swept" = "uploading") {
    await db().batch([
      db().prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,?,?,?,?)").bind(pack.id, pack.sha, pack.body.byteLength, pack.entries.length, state, createdAt, touchedAt),
      ...pack.entries.map((entry) => db().prepare("INSERT INTO pack_members(pack_id,sha256,offset,length) VALUES(?,?,?,?)").bind(pack.id, entry.sha256, entry.offset, entry.length)),
    ]);
    await env.rbox_dev_blobs.put(packKey(pack.id), pack.body);
  }

  test("requires both age bounds and preserves a fresh heartbeat", async () => {
    const now = Date.now();
    const old = now - PACK_ORPHAN_GRACE_MS - 1;
    const youngCreated = smallPack();
    const freshHeartbeat = smallPack();
    await seed(youngCreated, now, old);
    await seed(freshHeartbeat, old, now);
    await sweepUploadingPacks(env, now);
    expect(await packRow(youngCreated.id)).toMatchObject({ state: "uploading" });
    expect(await packRow(freshHeartbeat.id)).toMatchObject({ state: "uploading" });
    expect(await memberRows(youngCreated.id)).toHaveLength(youngCreated.entries.length);
    expect(await env.rbox_dev_blobs.head(packKey(freshHeartbeat.id))).not.toBeNull();
  });

  test("atomically tombstones old inventory, deletes members/object, and re-deletes late objects", async () => {
    const now = Date.now();
    const old = now - PACK_ORPHAN_GRACE_MS - 1;
    const pack = smallPack();
    await seed(pack, old, old);
    await sweepUploadingPacks(env, now);
    expect(await packRow(pack.id)).toMatchObject({ state: "swept" });
    expect(await memberRows(pack.id)).toEqual([]);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();

    await env.rbox_dev_blobs.put(packKey(pack.id), pack.body);
    await sweepUploadingPacks(env, now + 1);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
    expect(await packRow(pack.id)).toMatchObject({ state: "swept" });
  });

  test("repair racing a past-grace sweep converges through the swept tombstone", async () => {
    const a = await bootstrap("pack-repair-sweep-race");
    const pack = smallPack();
    let signalPut!: () => void;
    let releasePut!: () => void;
    const putEntered = new Promise<void>((resolve) => { signalPut = resolve; });
    const released = new Promise<void>((resolve) => { releasePut = resolve; });
    const pausedBucket = new Proxy(env.rbox_dev_blobs, {
      get(target, property) {
        if (property === "put") return async (key: string, value: Uint8Array, options?: R2PutOptions) => {
          if (key === packKey(pack.id)) {
            signalPut();
            await released;
          }
          return target.put(key, value, options);
        };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending = direct(pack, { ...env, rbox_dev_blobs: pausedBucket } as Env, a.accountId);
    await putEntered;
    const now = Date.now();
    const old = now - PACK_ORPHAN_GRACE_MS - 1;
    await db().prepare("UPDATE packs SET created_at=?,touched_at=? WHERE pack_id=? AND state='uploading'").bind(old, old, pack.id).run();
    await sweepUploadingPacks(env, now);
    expect(await packRow(pack.id)).toMatchObject({ state: "swept" });
    releasePut();
    const response = await pending;
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "retry_later" });
    expect(await memberRows(pack.id)).toEqual([]);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).not.toBeNull();
    await sweepUploadingPacks(env, now + 1);
    expect(await env.rbox_dev_blobs.head(packKey(pack.id))).toBeNull();
    expect(await packRow(pack.id)).toMatchObject({ state: "swept" });
  });
});
