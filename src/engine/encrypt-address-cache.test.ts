import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  ENCRYPT_ADDRESS_CACHE_REL,
  type EncryptAddressCacheContext,
  type StoredEncryptAddressCacheEntry,
} from "./encrypt-address-cache.js";

const hex = (c: string) => c.repeat(64);
const ctx: EncryptAddressCacheContext = { accountId: "acct_cache", workspaceId: "ws_cache", accountEpoch: 2, keyEpoch: 7 };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-encrypt-cache-"));
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

async function writeCache(body: unknown): Promise<void> {
  const file = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, typeof body === "string" ? body : JSON.stringify(body));
}

function stored(overrides: Partial<EncryptAddressCacheContext> = {}, entries: Partial<Record<string, Partial<StoredEncryptAddressCacheEntry>>> = {}) {
  return { version: 1, ...ctx, ...overrides, entries };
}

async function readCache(): Promise<{ entries: Record<string, StoredEncryptAddressCacheEntry> }> {
  return JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
}

function expectDisjointPaths(raw: { entries: Record<string, StoredEncryptAddressCacheEntry> }): void {
  const owners = new Map<string, string>();
  for (const [plaintextSha, entry] of Object.entries(raw.entries)) {
    for (const relPath of entry.paths) {
      expect(owners.get(relPath)).toBeUndefined();
      owners.set(relPath, plaintextSha);
    }
  }
}

async function saveAndReadDisjoint(cache: EncryptAddressCache): Promise<{ entries: Record<string, StoredEncryptAddressCacheEntry> }> {
  await cache.save(root);
  const raw = await readCache();
  expectDisjointPaths(raw);
  return raw;
}

test("EncryptAddressCache load discards corrupt and mismatched cache files", async () => {
  await writeCache("{not json");
  expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toBeUndefined();

  for (const mismatch of [
    { accountId: "acct_other" },
    { workspaceId: "ws_other" },
    { accountEpoch: ctx.accountEpoch + 1 },
    { keyEpoch: ctx.keyEpoch + 1 },
  ]) {
    await writeCache(stored(mismatch, { [hex("a")]: { encSha: hex("b"), cipherSize: 11, paths: ["a.txt"] } }));
    expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toBeUndefined();
  }
});

test("EncryptAddressCache load discards malformed entries", async () => {
  for (const badEntry of [
    { encSha: "bad", cipherSize: 11, paths: ["a.txt"] },
    { encSha: hex("b"), cipherSize: -1, paths: ["a.txt"] },
    { encSha: hex("b"), cipherSize: 11, paths: ["../a.txt"] },
    { encSha: hex("b"), cipherSize: 11, paths: [] },
    { encSha: hex("b"), cipherSize: 11, comp: "br", payloadSha: hex("c"), paths: ["a.txt"] },
    { encSha: hex("b"), cipherSize: 11, comp: "zstd", paths: ["a.txt"] },
    { encSha: hex("b"), cipherSize: 11, payloadSha: hex("c"), paths: ["a.txt"] },
  ]) {
    await writeCache(stored({}, { [hex("a")]: badEntry }));
    expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toBeUndefined();
  }
});

test("EncryptAddressCache preserves compressed descriptors", async () => {
  const cache = new EncryptAddressCache(ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, comp: "zstd", payloadSha: hex("c"), path: "a.txt" });
  await cache.save(root);

  const raw = JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
  expect(raw.entries[hex("a")]).toEqual({ encSha: hex("b"), cipherSize: 10, comp: "zstd", payloadSha: hex("c"), paths: ["a.txt"] });
  expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10, comp: "zstd", payloadSha: hex("c") });
});

test("EncryptAddressCache prune removes departed path refs and empty entries", async () => {
  const cache = new EncryptAddressCache(ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "stay.txt" });
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "gone.txt" });
  cache.record(hex("c"), { encSha: hex("d"), cipherSize: 12, path: "departed.txt" });

  cache.prune(new Set(["stay.txt"]));
  await cache.save(root);

  const raw = JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8"));
  expect(raw.entries[hex("a")]).toEqual({ encSha: hex("b"), cipherSize: 10, paths: ["stay.txt"] });
  expect(raw.entries[hex("c")]).toBeUndefined();
});

test("EncryptAddressCache record keeps path ownership disjoint across path moves", async () => {
  const cache = new EncryptAddressCache(ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "move.txt" });
  let raw = await saveAndReadDisjoint(cache);
  expect(raw.entries[hex("a")]).toEqual({ encSha: hex("b"), cipherSize: 10, paths: ["move.txt"] });

  const loaded = await EncryptAddressCache.load(root, ctx);
  loaded.record(hex("c"), { encSha: hex("d"), cipherSize: 12, path: "move.txt" });
  raw = await saveAndReadDisjoint(loaded);
  expect(raw.entries[hex("a")]).toBeUndefined();
  expect(raw.entries[hex("c")]).toEqual({ encSha: hex("d"), cipherSize: 12, paths: ["move.txt"] });
  expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("c"))).toEqual({ encSha: hex("d"), cipherSize: 12 });
});

test("EncryptAddressCache migratePath evicts another owner without adopting the path", async () => {
  const cache = new EncryptAddressCache(ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "carried.txt" });
  await cache.save(root);

  const loaded = await EncryptAddressCache.load(root, ctx);
  expect(loaded.migratePath(hex("c"), "carried.txt")).toBe(true);
  const raw = await saveAndReadDisjoint(loaded);
  expect(raw.entries[hex("a")]).toBeUndefined();
  expect(raw.entries[hex("c")]).toBeUndefined();
});

test("EncryptAddressCache migratePath no-ops for unknown and self-owned paths", async () => {
  const empty = new EncryptAddressCache(ctx);
  expect(empty.migratePath(hex("a"), "missing.txt")).toBe(false);
  expect(empty.needsSave).toBe(false);
  await empty.save(root);
  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_REL))).rejects.toThrow();

  const cache = new EncryptAddressCache(ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "same.txt" });
  await cache.save(root);
  const loaded = await EncryptAddressCache.load(root, ctx);

  expect(loaded.migratePath(hex("a"), "same.txt")).toBe(false);
  expect(loaded.needsSave).toBe(false);
  const raw = await saveAndReadDisjoint(loaded);
  expect(raw.entries[hex("a")]).toEqual({ encSha: hex("b"), cipherSize: 10, paths: ["same.txt"] });
});

test("EncryptAddressCache load scrubs duplicate paths deterministically and self-heals on save", async () => {
  await writeCache(
    stored(
      {},
      {
        [hex("b")]: { encSha: hex("d"), cipherSize: 12, paths: ["b.txt", "dupe.txt"] },
        [hex("a")]: { encSha: hex("c"), cipherSize: 10, paths: ["a.txt", "dupe.txt"] },
      }
    )
  );

  const cache = await EncryptAddressCache.load(root, ctx);
  expect(cache.needsSave).toBe(true);
  let raw = await saveAndReadDisjoint(cache);
  expect(raw.entries[hex("a")]).toEqual({ encSha: hex("c"), cipherSize: 10, paths: ["a.txt", "dupe.txt"] });
  expect(raw.entries[hex("b")]).toEqual({ encSha: hex("d"), cipherSize: 12, paths: ["b.txt"] });

  const clean = await EncryptAddressCache.load(root, ctx);
  expect(clean.needsSave).toBe(false);
  raw = await saveAndReadDisjoint(clean);
  expectDisjointPaths(raw);
});

test("EncryptAddressCache clean cache load does not dirty the cache", async () => {
  await writeCache(
    stored(
      {},
      {
        [hex("a")]: { encSha: hex("b"), cipherSize: 10, paths: ["a.txt"] },
        [hex("c")]: { encSha: hex("d"), cipherSize: 12, paths: ["c.txt"] },
      }
    )
  );

  const cache = await EncryptAddressCache.load(root, ctx);
  expect(cache.needsSave).toBe(false);
  const before = await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8");
  await cache.save(root);
  expect(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8")).toBe(before);
});

test("EncryptAddressCache prune drops reverse mappings for partial and total prunes", async () => {
  const cache = new EncryptAddressCache(ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "stay.txt" });
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "gone.txt" });
  cache.record(hex("c"), { encSha: hex("d"), cipherSize: 12, path: "departed.txt" });
  await cache.save(root);

  const loaded = await EncryptAddressCache.load(root, ctx);
  loaded.prune(new Set(["stay.txt"]));
  expect(loaded.migratePath(hex("e"), "gone.txt")).toBe(false);
  expect(loaded.migratePath(hex("e"), "departed.txt")).toBe(false);

  const raw = await saveAndReadDisjoint(loaded);
  expect(raw.entries[hex("a")]).toEqual({ encSha: hex("b"), cipherSize: 10, paths: ["stay.txt"] });
  expect(raw.entries[hex("c")]).toBeUndefined();
});

test("EncryptAddressCacheWriter final flush persists pending scheduled entries", async () => {
  const cache = new EncryptAddressCache(ctx);
  const writer = new EncryptAddressCacheWriter(root, cache, 60_000);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
  writer.schedule();

  await writer.flush();

  expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
});
