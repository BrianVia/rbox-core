import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import {
  PACK_CONTENT_TYPE,
  PACK_HEADER_BYTES,
  encodePackDirectory,
  encodePackFooter,
  encodePackHeader,
  type PackDirEntry,
} from "../../../src/engine/blob-pack.js";
import { ACCOUNTING_INSERT_CHUNK, commitAccounting, isDeleteFenceAbort, validateCommitRefs } from "../src/commit-accounting.js";
import { blobGet } from "../src/blobs.js";
import { WorkspaceSync } from "../src/workspace-sync.js";

const BASE = "https://example.com";
const RCPT = { "x-rbox-protocol": "upload-receipts-v1" };
let sequence = 0;
const hash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
const hashBytes = (bytes: Uint8Array): Uint8Array => new Uint8Array(createHash("sha256").update(bytes).digest());
const nextId = (): string => createHash("md5").update(`pack-redeem-${sequence++}`).digest("hex");
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

async function publish(a: { token: string; accountId: string }, pack: BuiltPack): Promise<Record<string, string>> {
  const res = await SELF.fetch(`${BASE}/v1/blob-pack/put`, {
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
  expect(res.status).toBe(200);
  const body = await res.json() as { results: Array<{ sha256: string; receipt: string }> };
  return Object.fromEntries(body.results.map((row) => [row.sha256, row.receipt]));
}

async function canonicalReceipt(a: { token: string }, bytes: Uint8Array): Promise<{ sha: string; receipt: string }> {
  const sha = hash(bytes);
  const res = await SELF.fetch(`${BASE}/v1/blobs/${sha}`, {
    method: "PUT",
    headers: { authorization: `Bearer ${a.token}`, "content-length": String(bytes.byteLength), ...RCPT },
    body: bytes,
  });
  expect(res.status).toBe(200);
  const body = await res.json() as { receipt: string };
  return { sha, receipt: body.receipt };
}

async function location(sha: string) {
  return db().prepare("SELECT pack_id,offset,length,pack_sha256 FROM blob_locations WHERE sha256=?").bind(sha).first<{
    pack_id: string; offset: number; length: number; pack_sha256: string;
  }>();
}

interface InventoryMember {
  sha256: string;
  offset: number;
  length: number;
}

async function seedReadyPack(packId: string, packSha256: string, members: InventoryMember[]): Promise<void> {
  const nowMs = Date.now();
  const sizeBytes = members.reduce((max, member) => Math.max(max, member.offset + member.length), 0);
  await db().batch([
    db()
      .prepare("INSERT INTO packs(pack_id,pack_sha256,size_bytes,member_count,state,created_at,touched_at) VALUES(?,?,?,?,'ready',?,?)")
      .bind(packId, packSha256, sizeBytes, members.length, nowMs, nowMs),
    db()
      .prepare(
        `INSERT INTO pack_members(pack_id,sha256,offset,length)
         SELECT ?, j.value->>'$.sha256',
                CAST(j.value->>'$.offset' AS INTEGER), CAST(j.value->>'$.length' AS INTEGER)
         FROM json_each(?) AS j`,
      )
      .bind(packId, JSON.stringify(members)),
  ]);
}

function countPlacementStatements(realDb: D1Database): { db: D1Database; count: () => number } {
  let placementStatements = 0;
  return {
    db: new Proxy(realDb, {
      get(target, prop) {
        if (prop === "prepare") {
          return (sql: string) => {
            if (sql.includes("INSERT INTO blob_locations")) placementStatements++;
            return target.prepare(sql);
          };
        }
        const value = target[prop as keyof D1Database];
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    count: () => placementStatements,
  };
}

describe("design 114 receipt placement accounting", () => {
  test("pack PUT -> dedicated redeem installs inventory-derived placement, serves GET, and re-redeem is a no-op", async () => {
    const a = await bootstrap("pack-redeem-full");
    const pack = buildPack([new TextEncoder().encode("redeem-a"), new TextEncoder().encode("redeem-b")]);
    const receipts = await publish(a, pack);
    const first = await redeem(a.accountId, receipts);
    expect(await first.json()).toEqual({ granted: 2, alreadyEntitled: 0, rejected: 0 });
    for (const entry of pack.entries) {
      expect(await location(entry.sha256)).toEqual({ pack_id: pack.id, offset: entry.offset, length: entry.length, pack_sha256: pack.sha });
      expect(new Uint8Array(await (await blobGet(env, entry.sha256, a.accountId)).arrayBuffer())).toEqual(pack.payloads[pack.entries.indexOf(entry)]);
    }
    const usedBefore = Number((await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(a.accountId).first())!.used_bytes);
    expect(await (await redeem(a.accountId, receipts)).json()).toEqual({ granted: 0, alreadyEntitled: 2, rejected: 0 });
    expect(Number((await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(a.accountId).first())!.used_bytes)).toBe(usedBefore);
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_locations WHERE pack_id=?").bind(pack.id).first())!.n)).toBe(2);
  });

  test("commit fallback resolves v2 placement before accounting", async () => {
    const a = await bootstrap("pack-redeem-commit");
    const pack = buildPack([new TextEncoder().encode("commit-fallback")]);
    const receipts = await publish(a, pack);
    const validated = await validateCommitRefs(env, db(), a.accountId, [pack.entries[0]!.sha256], receipts, Date.now());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.newRefs[0]!.pack).toMatchObject({ packId: pack.id, offset: pack.entries[0]!.offset });
    expect(await commitAccounting(db(), a.accountId, validated.newRefs, Date.now())).toEqual({ ok: true });
    expect((await location(pack.entries[0]!.sha256))!.pack_id).toBe(pack.id);
  });

  test("skip-if-entitled never installs placement", async () => {
    const a = await bootstrap("pack-redeem-skip");
    const bytes = new TextEncoder().encode("already-canonical");
    const canonical = await canonicalReceipt(a, bytes);
    expect((await redeem(a.accountId, { [canonical.sha]: canonical.receipt })).status).toBe(200);
    const pack = buildPack([bytes]);
    const receipts = await publish(a, pack);
    expect(await (await redeem(a.accountId, receipts)).json()).toEqual({ granted: 0, alreadyEntitled: 1, rejected: 0 });
    expect(await location(canonical.sha)).toBeNull();
  });

  test("v1 displacement and v2 A-to-B relocation are atomic and mark the former pack", async () => {
    const a = await bootstrap("pack-redeem-relocate");
    const bytes = new TextEncoder().encode("relocate-same-sha");
    const packA = buildPack([bytes]);
    const packB = buildPack([bytes]);
    const receiptA = await publish(a, packA);
    const receiptB = await publish(a, packB);
    expect((await redeem(a.accountId, receiptA)).status).toBe(200);

    // The adjudicated skip-if-entitled rule requires an unsatisfied marker
    // before a placement-changing receipt is considered.
    await db().prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)").bind(a.accountId, packA.entries[0]!.sha256, Date.now()).run();
    expect((await redeem(a.accountId, receiptB)).status).toBe(200);
    expect((await location(packA.entries[0]!.sha256))!.pack_id).toBe(packB.id);
    expect(await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(packA.id).first()).toEqual({ deleting_at: null });

    const canonical = await canonicalReceipt(a, bytes);
    await db().prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)").bind(a.accountId, canonical.sha, Date.now()).run();
    expect((await redeem(a.accountId, { [canonical.sha]: canonical.receipt })).status).toBe(200);
    expect(await location(canonical.sha)).toBeNull();
    expect(await db().prepare("SELECT deleting_at FROM pack_gc_candidates WHERE pack_id=?").bind(packB.id).first()).toEqual({ deleting_at: null });
  });

  test("real accounting relocation preserves an existing unopened candidate for the former pack", async () => {
    const a = await bootstrap("pack-redeem-existing-candidate");
    const bytes = new TextEncoder().encode("relocate-with-existing-candidate");
    const packA = buildPack([bytes]);
    const packB = buildPack([bytes]);
    const receiptA = await publish(a, packA);
    await publish(a, packB);
    expect((await redeem(a.accountId, receiptA)).status).toBe(200);

    const epoch = nextId();
    const markedAt = 1_234_567_890;
    await db()
      .prepare("INSERT INTO pack_gc_candidates(pack_id,epoch,marked_at,deleting_at) VALUES (?,?,?,NULL)")
      .bind(packA.id, epoch, markedAt)
      .run();
    const entry = packB.entries[0]!;
    expect(await commitAccounting(db(), a.accountId, [{
      sha: entry.sha256,
      size: entry.length,
      pack: { packId: packB.id, offset: entry.offset, length: entry.length, packSha256: packB.sha },
    }], Date.now())).toEqual({ ok: true });

    expect((await location(entry.sha256))?.pack_id).toBe(packB.id);
    expect(await db()
      .prepare("SELECT epoch,marked_at,deleting_at FROM pack_gc_candidates WHERE pack_id=?")
      .bind(packA.id)
      .first()).toEqual({ epoch, marked_at: markedAt, deleting_at: null });
  });

  test("an open pack fence aborts the whole mixed v1/v2 super-batch", async () => {
    expect(isDeleteFenceAbort(new Error("D1: rbox_delete_fence_pack"))).toBe(true);
    const a = await bootstrap("pack-redeem-fence");
    const pack = buildPack([new TextEncoder().encode("fenced-pack")]);
    const packed = await publish(a, pack);
    const canonical = await canonicalReceipt(a, new TextEncoder().encode("same-superbatch-v1"));
    await db().prepare("INSERT INTO pack_gc_candidates(pack_id,epoch,marked_at,deleting_at) VALUES (?,?,?,?)").bind(pack.id, nextId(), Date.now(), Date.now()).run();
    const response = await redeem(a.accountId, { ...packed, [canonical.sha]: canonical.receipt });
    expect(response.status).toBe(422);
    const shas = [pack.entries[0]!.sha256, canonical.sha];
    expect((await db().prepare(`SELECT sha256 FROM blob_refs WHERE account_id=? AND sha256 IN (?,?)`).bind(a.accountId, ...shas).all()).results).toEqual([]);
    expect(await location(pack.entries[0]!.sha256)).toBeNull();
  });

  test("unresolved swept placement is rejected by redeem and needsUpload at commit", async () => {
    const a = await bootstrap("pack-redeem-swept");
    const pack = buildPack([new TextEncoder().encode("swept-before-redeem")]);
    const receipts = await publish(a, pack);
    await db().prepare("UPDATE packs SET state='swept' WHERE pack_id=?").bind(pack.id).run();
    expect(await (await redeem(a.accountId, receipts)).json()).toEqual({ granted: 0, alreadyEntitled: 0, rejected: 1 });
    const validation = await validateCommitRefs(env, db(), a.accountId, [pack.entries[0]!.sha256], receipts, Date.now());
    expect(validation).toEqual({ ok: false, needsUpload: [pack.entries[0]!.sha256] });
    expect(await location(pack.entries[0]!.sha256)).toBeNull();
  });

  test("dedicated redemption accepts a full 2048-entry v2 pack batch", async () => {
    const a = await bootstrap("pack-redeem-2048");
    const payloads = Array.from({ length: 2048 }, (_, i) => new TextEncoder().encode(`m-${i.toString().padStart(4, "0")}`));
    const pack = buildPack(payloads);
    const receipts = await publish(a, pack);
    expect(Object.keys(receipts)).toHaveLength(2048);
    const response = await redeem(a.accountId, receipts);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ granted: 2048, alreadyEntitled: 0, rejected: 0 });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_locations WHERE pack_id=?").bind(pack.id).first())!.n)).toBe(2048);
  });

  test("accounting installs and updates 2050 packed placements in two JSON batches", async () => {
    const a = await bootstrap("pack-accounting-json-2050");
    const refs = Array.from({ length: 2050 }, (_, i) => ({
      sha: hash(`json-placement-${i}`),
      size: 17 + (i % 29),
    }));
    const firstPacks = [
      { id: nextId(), sha: hash("json-placement-pack-a") },
      { id: nextId(), sha: hash("json-placement-pack-b") },
    ];
    const secondPacks = [
      { id: nextId(), sha: hash("json-placement-pack-c") },
      { id: nextId(), sha: hash("json-placement-pack-d") },
    ];
    const placement = (
      ref: (typeof refs)[number],
      index: number,
      packs: typeof firstPacks,
      generation: number,
    ) => {
      const pack = packs[index < 2048 ? 0 : 1]!;
      return {
        sha: ref.sha,
        size: ref.size,
        pack: {
          packId: pack.id,
          offset: generation * 1_000_000 + index * 53 + 64,
          length: ref.size,
          packSha256: pack.sha,
        },
      };
    };
    const firstRefs = refs.map((ref, i) => placement(ref, i, firstPacks, 1));
    const secondRefs = refs.map((ref, i) => placement(ref, i, secondPacks, 2));
    for (const [packIndex, pack] of firstPacks.entries()) {
      const packRefs = firstRefs.slice(packIndex === 0 ? 0 : 2048, packIndex === 0 ? 2048 : undefined);
      await seedReadyPack(pack.id, pack.sha, packRefs.map((ref) => ({
        sha256: ref.sha,
        offset: ref.pack.offset,
        length: ref.pack.length,
      })));
    }
    for (const [packIndex, pack] of secondPacks.entries()) {
      const packRefs = secondRefs.slice(packIndex === 0 ? 0 : 2048, packIndex === 0 ? 2048 : undefined);
      await seedReadyPack(pack.id, pack.sha, packRefs.map((ref) => ({
        sha256: ref.sha,
        offset: ref.pack.offset,
        length: ref.pack.length,
      })));
    }

    const firstNow = 1_000_000_000;
    const firstCounted = countPlacementStatements(db());
    expect(await commitAccounting(firstCounted.db, a.accountId, firstRefs, firstNow)).toEqual({ ok: true });
    expect(firstCounted.count()).toBe(2);
    const targetShas = JSON.stringify(refs.map((ref) => ref.sha));
    expect(Number((await db()
      .prepare("SELECT COUNT(*) n FROM blob_locations WHERE sha256 IN (SELECT value FROM json_each(?))")
      .bind(targetShas)
      .first())!.n)).toBe(2050);

    const assertPlacements = async (
      expectedRefs: typeof firstRefs,
      installedAt: number,
    ) => {
      // 1999/2000 straddle the PACKED_PLACEMENT_CHUNK JSON seam; 2048/2049 straddle
      // the pack boundary this test introduces. Both pairs must agree.
      for (const index of [0, 1025, 1999, 2000, 2048, 2049]) {
        const expected = expectedRefs[index]!;
        expect(await db()
          .prepare("SELECT storage,pack_id,offset,length,pack_sha256,installed_at FROM blob_locations WHERE sha256=?")
          .bind(expected.sha)
          .first()).toEqual({
          storage: "pack",
          pack_id: expected.pack.packId,
          offset: expected.pack.offset,
          length: expected.pack.length,
          pack_sha256: expected.pack.packSha256,
          installed_at: installedAt,
        });
      }
    };
    await assertPlacements(firstRefs, firstNow);

    const secondNow = firstNow + 1;
    const secondCounted = countPlacementStatements(db());
    expect(await commitAccounting(secondCounted.db, a.accountId, secondRefs, secondNow)).toEqual({ ok: true });
    expect(secondCounted.count()).toBe(2);
    expect(Number((await db()
      .prepare("SELECT COUNT(*) n FROM blob_locations WHERE sha256 IN (SELECT value FROM json_each(?))")
      .bind(targetShas)
      .first())!.n)).toBe(2050);
    expect(Number((await db()
      .prepare("SELECT COUNT(*) n FROM blob_locations WHERE pack_id IN (?,?)")
      .bind(firstPacks[0]!.id, firstPacks[1]!.id)
      .first())!.n)).toBe(0);
    await assertPlacements(secondRefs, secondNow);
  });

  test("mixed packed and canonical accounting deletes the canonical placement", async () => {
    const a = await bootstrap("pack-accounting-json-mixed");
    const packedSha = hash("json-mixed-packed");
    const canonicalSha = hash("json-mixed-canonical");
    const destinationPack = { id: nextId(), sha: hash("json-mixed-destination-pack") };
    const sourcePack = { id: nextId(), sha: hash("json-mixed-source-pack") };
    const destinationMembers = [
      { sha256: packedSha, offset: 64, length: 21 },
      { sha256: canonicalSha, offset: 85, length: 24 },
    ];
    const sourceMember = { sha256: packedSha, offset: 512, length: 21 };
    await seedReadyPack(destinationPack.id, destinationPack.sha, destinationMembers);
    await seedReadyPack(sourcePack.id, sourcePack.sha, [sourceMember]);
    expect(await commitAccounting(db(), a.accountId, [
      {
        sha: packedSha,
        size: sourceMember.length,
        pack: {
          packId: sourcePack.id,
          offset: sourceMember.offset,
          length: sourceMember.length,
          packSha256: sourcePack.sha,
        },
      },
      {
        sha: canonicalSha,
        size: destinationMembers[1]!.length,
        pack: {
          packId: destinationPack.id,
          offset: destinationMembers[1]!.offset,
          length: destinationMembers[1]!.length,
          packSha256: destinationPack.sha,
        },
      },
    ], 2_000_000_000)).toEqual({ ok: true });

    expect(await commitAccounting(db(), a.accountId, [
      {
        sha: packedSha,
        size: destinationMembers[0]!.length,
        pack: {
          packId: destinationPack.id,
          offset: destinationMembers[0]!.offset,
          length: destinationMembers[0]!.length,
          packSha256: destinationPack.sha,
        },
      },
      { sha: canonicalSha, size: destinationMembers[1]!.length },
    ], 2_000_000_001)).toEqual({ ok: true });

    expect(await location(packedSha)).toEqual({
      pack_id: destinationPack.id,
      offset: destinationMembers[0]!.offset,
      length: destinationMembers[0]!.length,
      pack_sha256: destinationPack.sha,
    });
    expect(await location(canonicalSha)).toBeNull();
    expect(await db()
      .prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?")
      .bind(destinationPack.id)
      .first()).toBeNull();
  });

  // Regression: the canonical DELETE and the packed INSERT for the SAME pack must
  // not be reordered across ACCOUNTING_INSERT_CHUNK boundaries. Before design 210
  // the placement inserts were emitted per 33-ref chunk, so a chunk-0 canonical
  // delete that emptied pack A ran BEFORE the chunk-1 insert that refilled it —
  // firing blob_locations_delete_pack_candidate and leaving a spurious
  // pack_gc_candidates row. That row transiently fences every read/PUT of a live
  // pack (blob-pack.ts fenceRead) until pack GC unmarks it. Grouping all placement
  // inserts ahead of all canonical deletes removes the window.
  test("canonical delete and packed insert for one pack in different chunks leave no GC candidate", async () => {
    const a = await bootstrap("pack-accounting-cross-chunk-order");
    const pack = { id: nextId(), sha: hash("cross-chunk-order-pack") };
    const leaving = hash("cross-chunk-leaving");
    const arriving = hash("cross-chunk-arriving");
    const members = [
      { sha256: leaving, offset: 64, length: 10 },
      { sha256: arriving, offset: 74, length: 12 },
    ];
    await seedReadyPack(pack.id, pack.sha, members);

    // `leaving` starts as the pack's only placement, so removing it empties pack A.
    expect(await commitAccounting(db(), a.accountId, [
      { sha: leaving, size: 10, pack: { packId: pack.id, offset: 64, length: 10, packSha256: pack.sha } },
    ], 3_000_000_000)).toEqual({ ok: true });
    expect((await location(leaving))?.pack_id).toBe(pack.id);

    // ACCOUNTING_INSERT_CHUNK is 33: `leaving` plus 32 fillers fill chunk 0, so the
    // canonical delete lands a whole chunk before `arriving`'s placement insert.
    const refs = [
      { sha: leaving, size: 10 },
      ...Array.from({ length: ACCOUNTING_INSERT_CHUNK - 1 }, (_, i) => ({ sha: hash(`cross-chunk-filler-${i}`), size: 5 })),
      { sha: arriving, size: 12, pack: { packId: pack.id, offset: 74, length: 12, packSha256: pack.sha } },
    ];
    expect(refs.length).toBe(ACCOUNTING_INSERT_CHUNK + 1);
    expect(await commitAccounting(db(), a.accountId, refs, 3_000_000_001)).toEqual({ ok: true });

    expect(await location(leaving)).toBeNull();
    expect(await location(arriving)).toEqual({
      pack_id: pack.id,
      offset: 74,
      length: 12,
      pack_sha256: pack.sha,
    });
    expect(await db()
      .prepare("SELECT 1 FROM pack_gc_candidates WHERE pack_id=?")
      .bind(pack.id)
      .first()).toBeNull();
  });
});
