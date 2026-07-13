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
  type PackDirEntry,
} from "../../../src/engine/blob-pack.js";
import { BATCH_FRAME_HEADER_BYTES, BATCH_STATUS_BIT, blobBatchGet, planPackReads } from "../src/blob-batch.js";
import { blobGet, blobGetWithVerifiedGrant } from "../src/blobs.js";
import { blobPackPut, packKey } from "../src/blob-pack.js";
import { blobKey } from "../src/util.js";
import { mintGrant } from "../src/grants.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import type { Env } from "../src/env.js";

const BASE = "https://example.com";
const RCPT = { "x-rbox-protocol": "upload-receipts-v1" };
let sequence = 0;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hashBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const nextId = (): string => createHash("md5").update(`pack-read-${sequence++}`).digest("hex");
const db = () => env.rbox_dev_db;

beforeAll(async () => applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS));

async function bootstrap(name: string): Promise<{ token: string; accountId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string; accountId: string }>;
}

interface BuiltPack { id: string; body: Uint8Array; sha: string; entries: PackDirEntry[]; payloads: Uint8Array[] }
function buildPack(payloads: Uint8Array[]): BuiltPack {
  const id = nextId();
  let offset = PACK_HEADER_BYTES;
  const entries = payloads.map((payload) => {
    const entry = { sha256: hash(payload), offset, length: payload.byteLength };
    offset += payload.byteLength;
    return entry;
  });
  const directory = encodePackDirectory(entries);
  const footer = encodePackFooter({ count: entries.length, directoryOffset: offset, directoryBytes: directory.byteLength, directorySha256: hashBytes(directory) });
  const body = new Uint8Array(offset + directory.byteLength + footer.byteLength);
  body.set(encodePackHeader());
  payloads.forEach((payload, i) => body.set(payload, entries[i]!.offset));
  body.set(directory, offset);
  body.set(footer, offset + directory.byteLength);
  return { id, body, sha: hash(body), entries, payloads };
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

async function publishAndRedeem(a: { token: string; accountId: string }, pack: BuiltPack): Promise<Record<string, string>> {
  const put = await SELF.fetch(`${BASE}/v1/blob-pack/put`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${a.token}`,
      "content-type": PACK_CONTENT_TYPE,
      ...RCPT,
      "x-rbox-pack-id": pack.id,
      "x-rbox-pack-sha256": pack.sha,
    },
    body: pack.body,
  });
  expect(put.status).toBe(200);
  const result = await put.json() as { results: Array<{ sha256: string; receipt: string }> };
  const receipts = Object.fromEntries(result.results.map((row) => [row.sha256, row.receipt]));
  const sync = new WorkspaceSync(fakeState(), env);
  const redeem = await (sync as unknown as { redeemReceipts(req: Request): Promise<Response> }).redeemReceipts(
    new Request(`${BASE}/v1/ws/ws/proj/root/receipts/redeem`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-rbox-account": a.accountId },
      body: JSON.stringify({ receipts }),
    }),
  );
  expect(redeem.status).toBe(200);
  return receipts;
}

interface Frame { sha: string; status: boolean; payload: Uint8Array }
async function decodeFrames(res: Response): Promise<Frame[]> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const frames: Frame[] = [];
  for (let off = 0; off < bytes.byteLength;) {
    const head = bytes.subarray(off, off + BATCH_FRAME_HEADER_BYTES);
    off += BATCH_FRAME_HEADER_BYTES;
    const sha = [...head.subarray(0, 32)].map((b) => b.toString(16).padStart(2, "0")).join("");
    const word = new DataView(head.buffer, head.byteOffset + 32, 4).getUint32(0, false);
    const len = word & 0x7fffffff;
    frames.push({ sha, status: (word & BATCH_STATUS_BIT) !== 0, payload: bytes.slice(off, off + len) });
    off += len;
  }
  return frames;
}

describe("design 114 packed reads", () => {
  test("serves first, last, and single-member extents on bearer and grant paths; canonical remains unchanged", async () => {
    const a = await bootstrap("pack-read-single");
    const pack = buildPack([new TextEncoder().encode("first"), new TextEncoder().encode("middle"), new TextEncoder().encode("last")]);
    await publishAndRedeem(a, pack);
    expect(pack.entries[0]!.offset).toBe(16);
    for (const index of [0, 2]) {
      const got = await blobGet(env, pack.entries[index]!.sha256, a.accountId);
      expect(new Uint8Array(await got.arrayBuffer())).toEqual(pack.payloads[index]);
    }
    const grant = await mintGrant(env, { accountId: a.accountId, workspaceId: "ws", nowMs: Date.now() });
    const granted = await blobGetWithVerifiedGrant(env, pack.entries[1]!.sha256, a.accountId);
    expect(grant).toBeTruthy();
    expect(new Uint8Array(await granted.arrayBuffer())).toEqual(pack.payloads[1]);

    const one = buildPack([new TextEncoder().encode("only")]);
    await publishAndRedeem(a, one);
    expect(new Uint8Array(await (await blobGet(env, one.entries[0]!.sha256, a.accountId, grant)).arrayBuffer())).toEqual(one.payloads[0]);

    const canonical = new TextEncoder().encode("canonical-still-canonical");
    const canonicalSha = hash(canonical);
    await db().prepare("INSERT OR IGNORE INTO blobs (sha256,size_bytes,present) VALUES (?,?,1)").bind(canonicalSha, canonical.byteLength).run();
    await db().prepare("INSERT OR IGNORE INTO blob_refs (account_id,sha256) VALUES (?,?)").bind(a.accountId, canonicalSha).run();
    await env.rbox_dev_blobs.put(blobKey(canonicalSha), canonical);
    expect(new Uint8Array(await (await blobGet(env, canonicalSha, a.accountId)).arrayBuffer())).toEqual(canonical);
  });

  test("mixed batch reads two packs plus canonical and missing without exposing an unentitled packed location", async () => {
    const a = await bootstrap("pack-read-batch");
    const p1 = buildPack([new TextEncoder().encode("p1-a"), new TextEncoder().encode("p1-b")]);
    const p2 = buildPack([new TextEncoder().encode("p2-a")]);
    await publishAndRedeem(a, p1);
    await publishAndRedeem(a, p2);
    const canonical = new TextEncoder().encode("batch-canonical");
    const canonicalSha = hash(canonical);
    await db().prepare("INSERT OR IGNORE INTO blobs (sha256,size_bytes,present) VALUES (?,?,1)").bind(canonicalSha, canonical.byteLength).run();
    await db().prepare("INSERT OR IGNORE INTO blob_refs (account_id,sha256) VALUES (?,?)").bind(a.accountId, canonicalSha).run();
    await env.rbox_dev_blobs.put(blobKey(canonicalSha), canonical);
    const missing = hash("not-present");
    const wanted = [p1.entries[1]!.sha256, p2.entries[0]!.sha256, canonicalSha, missing];
    const res = await SELF.fetch(`${BASE}/v1/blob-batch/get`, { method: "POST", headers: { authorization: `Bearer ${a.token}` }, body: JSON.stringify(wanted) });
    const frames = await decodeFrames(res);
    const bySha = new Map(frames.map((frame) => [frame.sha, frame]));
    expect(bySha.get(p1.entries[1]!.sha256)!.payload).toEqual(p1.payloads[1]);
    expect(bySha.get(p2.entries[0]!.sha256)!.payload).toEqual(p2.payloads[0]);
    expect(bySha.get(canonicalSha)!.payload).toEqual(canonical);
    expect(new TextDecoder().decode(bySha.get(missing)!.payload)).toBe('{"status":"missing"}');

    const outsider = await bootstrap("pack-read-outsider");
    let reads = 0;
    const spyEnv = { ...env, rbox_dev_blobs: new Proxy(env.rbox_dev_blobs, { get(target, prop, receiver) {
      if (prop === "get") return (...args: Parameters<R2Bucket["get"]>) => { reads++; return target.get(...args); };
      return Reflect.get(target, prop, receiver);
    } }) } as Env;
    const denied = await blobBatchGet(new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify([p1.entries[0]!.sha256]) }), spyEnv, { accountId: outsider.accountId });
    expect(new TextDecoder().decode((await decodeFrames(denied))[0]!.payload)).toBe('{"status":"missing"}');
    expect(reads).toBe(0);
  });

  test("read metrics distinguish placement and summarize covering-range bytes without identifiers", async () => {
    const a = await bootstrap("pack-read-metrics");
    const pack = buildPack([new TextEncoder().encode("metric-first"), new TextEncoder().encode("metric-gap"), new TextEncoder().encode("metric-last")]);
    await publishAndRedeem(a, pack);
    const canonical = new TextEncoder().encode("metric-canonical");
    const canonicalSha = hash(canonical);
    await db().batch([
      db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(canonicalSha, canonical.byteLength),
      db().prepare("INSERT OR IGNORE INTO blob_refs(account_id,sha256) VALUES(?,?)").bind(a.accountId, canonicalSha),
    ]);
    await env.rbox_dev_blobs.put(blobKey(canonicalSha), canonical);
    const points: Array<{ indexes?: string[]; blobs?: string[]; doubles?: number[] }> = [];
    const metricEnv = {
      ...env,
      rbox_metrics: { writeDataPoint: (point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }) => points.push(point) } as AnalyticsEngineDataset,
    } as Env;

    await (await blobGet(metricEnv, pack.entries[0]!.sha256, a.accountId)).arrayBuffer();
    await (await blobGet(metricEnv, canonicalSha, a.accountId)).arrayBuffer();
    const single = points.filter((point) => point.blobs?.[0] === "blob.get");
    expect(single.map((point) => point.blobs?.[2])).toEqual(["ok_packed", "ok_canonical"]);
    expect(single.map((point) => point.doubles?.[4])).toEqual([pack.entries[0]!.length, canonical.byteLength]);

    const wanted = [pack.entries[0]!.sha256, pack.entries[2]!.sha256, canonicalSha];
    const batch = await blobBatchGet(
      new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify(wanted) }),
      metricEnv,
      { accountId: a.accountId, grantPreauth: true },
    );
    expect(await decodeFrames(batch)).toHaveLength(3);
    const summaries = points.filter((point) => point.blobs?.[0] === "blob.batchGet.summary");
    expect(summaries).toHaveLength(1);
    const coveringBytes = pack.entries[2]!.offset + pack.entries[2]!.length - pack.entries[0]!.offset;
    expect(summaries[0]?.blobs).toEqual(["blob.batchGet.summary", "ok_grant_preauth"]);
    expect(summaries[0]?.doubles).toEqual([
      1,
      2,
      1,
      pack.entries[0]!.length + pack.entries[2]!.length + canonical.byteLength,
      coveringBytes + canonical.byteLength,
    ]);
    const serialized = JSON.stringify(points);
    for (const forbidden of [pack.id, pack.sha, canonicalSha, a.accountId, ...pack.entries.map((entry) => entry.sha256)]) expect(serialized).not.toContain(forbidden);

    const malformedPoints: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const malformed = await blobBatchGet(
      new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: "not-json" }),
      { ...env, rbox_metrics: { writeDataPoint: (point: { blobs?: string[]; doubles?: number[] }) => malformedPoints.push(point) } as AnalyticsEngineDataset } as Env,
      { accountId: a.accountId },
    );
    expect(malformed.status).toBe(400);
    expect(malformedPoints).toEqual([{ indexes: ["blob.batchGet.summary"], blobs: ["blob.batchGet.summary", "bad_request"], doubles: [0, 0, 0, 0, 0] }]);
  });

  test("same-isolate full-size pack PUTs overlap mixed 32-sha batch GETs", async () => {
    const a = await bootstrap("pack-resource-cell");
    const packedPayloads = Array.from({ length: 16 }, (_, index) => new TextEncoder().encode(`resource-packed-${index}`));
    const readablePack = buildPack(packedPayloads);
    await publishAndRedeem(a, readablePack);
    const canonicalPayloads = Array.from({ length: 16 }, (_, index) => new TextEncoder().encode(`resource-canonical-${index}`));
    const canonicalShas = canonicalPayloads.map(hash);
    await db().batch(canonicalPayloads.flatMap((payload, index) => [
      db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(canonicalShas[index]!, payload.byteLength),
      db().prepare("INSERT OR IGNORE INTO blob_refs(account_id,sha256) VALUES(?,?)").bind(a.accountId, canonicalShas[index]!),
    ]));
    await Promise.all(canonicalPayloads.map((payload, index) => env.rbox_dev_blobs.put(blobKey(canonicalShas[index]!), payload)));
    const wanted = [...readablePack.entries.map((entry) => entry.sha256), ...canonicalShas];
    expect(wanted).toHaveLength(32);

    const count = 33;
    const overhead = PACK_HEADER_BYTES + count * 48 + 72;
    let remaining = PACK_MAX_BODY_BYTES - overhead;
    const fullPayloads = Array.from({ length: count }, (_, index) => {
      const length = Math.min(256 * 1024, remaining - (count - index - 1));
      remaining -= length;
      const bytes = new Uint8Array(length);
      bytes.fill(index + 1);
      return bytes;
    });
    const full = buildPack(fullPayloads);
    fullPayloads.length = 0;
    full.payloads = [];
    expect(full.body.byteLength).toBe(PACK_MAX_BODY_BYTES);
    const putPromises = Array.from({ length: 6 }, () => {
      const pack = { ...full, id: nextId() };
      return blobPackPut(new Request(`${BASE}/v1/blob-pack/put`, {
        method: "POST",
        headers: {
          "content-type": PACK_CONTENT_TYPE,
          ...RCPT,
          "x-rbox-pack-id": pack.id,
          "x-rbox-pack-sha256": pack.sha,
        },
        body: pack.body.slice(),
      }), env, a.accountId);
    });
    const getPromises = Array.from({ length: 4 }, () => blobBatchGet(
      new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify(wanted) }),
      env,
      { accountId: a.accountId, grantPreauth: true },
    ));
    const [puts, gets] = await Promise.all([Promise.all(putPromises), Promise.all(getPromises)]);
    expect(puts.map((response) => response.status)).toEqual([200, 200, 200, 200, 200, 200]);
    const frames = await Promise.all(gets.map(decodeFrames));
    expect(frames.map((records) => records.length)).toEqual([32, 32, 32, 32]);
    expect(frames.every((records) => records.every((record) => !record.status))).toBe(true);
  }, 30_000);

  test("corrupt and torn placements fail closed without canonical fallback", async () => {
    const a = await bootstrap("pack-read-corrupt");
    const pack = buildPack([new TextEncoder().encode("same-1"), new TextEncoder().encode("same-2")]);
    await publishAndRedeem(a, pack);
    const victim = pack.entries[0]!;
    const wrong = pack.entries[1]!;
    await env.rbox_dev_blobs.put(blobKey(victim.sha256), new TextEncoder().encode("canonical fallback must not serve"));
    await db().prepare("UPDATE pack_members SET offset=? WHERE pack_id=? AND sha256=?").bind(wrong.offset, pack.id, victim.sha256).run();
    await db().prepare("UPDATE blob_locations SET offset=? WHERE sha256=?").bind(wrong.offset, victim.sha256).run();
    expect((await blobGet(env, victim.sha256, a.accountId)).status).toBe(404);
    const corruptBatch = await blobBatchGet(new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify([victim.sha256]) }), env, { accountId: a.accountId });
    expect(new TextDecoder().decode((await decodeFrames(corruptBatch))[0]!.payload)).toBe('{"status":"error","code":"pack"}');

    const torn = pack.entries[1]!;
    await env.rbox_dev_blobs.delete(packKey(pack.id));
    expect((await blobGet(env, torn.sha256, a.accountId)).status).toBe(404);
    const tornBatch = await blobBatchGet(new Request(`${BASE}/v1/blob-batch/get`, { method: "POST", body: JSON.stringify([torn.sha256]) }), env, { accountId: a.accountId });
    expect(new TextDecoder().decode((await decodeFrames(tornBatch))[0]!.payload)).toBe('{"status":"error","code":"pack"}');
  });

  test("blobs/check matches canonical and packed state, hides only an opened pack candidate", async () => {
    const a = await bootstrap("pack-read-check");
    const pack = buildPack([new TextEncoder().encode("check-packed")]);
    await publishAndRedeem(a, pack);
    const canonical = new TextEncoder().encode("check-canonical");
    const canonicalSha = hash(canonical);
    await db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES (?,?,1)").bind(canonicalSha, canonical.byteLength).run();
    await db().prepare("INSERT OR IGNORE INTO blob_refs(account_id,sha256) VALUES (?,?)").bind(a.accountId, canonicalSha).run();
    await env.rbox_dev_blobs.put(blobKey(canonicalSha), canonical);
    const check = (receipts: boolean) => SELF.fetch(`${BASE}/v1/blobs/check`, { method: "POST", headers: { authorization: `Bearer ${a.token}`, "content-type": "application/json", ...(receipts ? RCPT : {}) }, body: JSON.stringify({ shas: [pack.entries[0]!.sha256, canonicalSha] }) });
    for (const receipts of [false, true]) expect((await (await check(receipts)).json() as { missing: string[] }).missing).toEqual([]);
    await db().prepare("INSERT INTO pack_gc_candidates(pack_id,epoch,marked_at,deleting_at) VALUES (?,?,?,NULL)").bind(pack.id, nextId(), Date.now()).run();
    for (const receipts of [false, true]) expect((await (await check(receipts)).json() as { missing: string[] }).missing).toEqual([]);
    await db().prepare("UPDATE pack_gc_candidates SET deleting_at=? WHERE pack_id=?").bind(Date.now(), pack.id).run();
    for (const receipts of [false, true]) expect((await (await check(receipts)).json() as { missing: string[] }).missing).toEqual([pack.entries[0]!.sha256]);
  });
});

describe("planPackReads", () => {
  test("coalesces first/last extents when gap bytes fit and uses exact ranges when the global budget is exhausted", () => {
    const extents = [
      { sha: "b".repeat(64), pack_id: "p1", offset: 116, length: 10 },
      { sha: "a".repeat(64), pack_id: "p1", offset: 16, length: 10 },
      { sha: "c".repeat(64), pack_id: "p2", offset: 16, length: 10 },
      { sha: "d".repeat(64), pack_id: "p2", offset: 1016, length: 10 },
    ];
    const roomy = planPackReads(extents, { fetchBytes: 0, maxFetchBytes: 2_000 });
    expect(roomy).toMatchObject([
      { packId: "p1", offset: 16, length: 110, coalesced: true },
      { packId: "p2", offset: 16, length: 1010, coalesced: true },
    ]);
    const tight = planPackReads(extents, { fetchBytes: 940, maxFetchBytes: 1_080 });
    expect(tight.map((plan) => ({ packId: plan.packId, offset: plan.offset, length: plan.length, coalesced: plan.coalesced }))).toEqual([
      { packId: "p1", offset: 16, length: 110, coalesced: true },
      { packId: "p2", offset: 16, length: 10, coalesced: false },
      { packId: "p2", offset: 1016, length: 10, coalesced: false },
    ]);
  });
});
