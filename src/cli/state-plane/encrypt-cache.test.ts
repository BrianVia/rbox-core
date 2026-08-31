import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  ENCRYPT_ADDRESS_CACHE_DB_REL,
  ENCRYPT_ADDRESS_CACHE_MIGRATED_REL,
  ENCRYPT_ADDRESS_CACHE_REL,
  EncryptAddressCache,
  EncryptAddressCacheWriter,
  type EncryptAddressCacheApi,
  type EncryptAddressCacheContext,
} from "../../engine/encrypt-address-cache.js";
import { loadEncryptAddressCache } from "../sync-recovery.js";
import { openEncryptAddressCacheStore } from "./encrypt-cache.js";

const hex = (c: string) => c.repeat(64);
const shaOf = (i: number) => i.toString(16).padStart(64, "0");
const ctx: EncryptAddressCacheContext = { accountId: "acct_cache", workspaceId: "ws_cache", accountEpoch: 2, keyEpoch: 7 };

let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-encrypt-cache-sqlite-"));
});

afterEach(async () => {
  delete process.env.RBOX_ENCRYPT_CACHE_SQLITE;
  await fs.rm(root, { recursive: true, force: true });
});

interface LegacyEntry {
  encSha: string;
  cipherSize: number;
  comp?: string;
  payloadSha?: string;
  paths: string[];
}

async function writeLegacyText(raw: string): Promise<void> {
  const file = path.join(root, ENCRYPT_ADDRESS_CACHE_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, raw);
}

const writeLegacy = (entries: Record<string, LegacyEntry>): Promise<void> =>
  writeLegacyText(JSON.stringify({ version: 1, ...ctx, entries }));

async function bytesOnDisk(...relPaths: string[]): Promise<number> {
  let total = 0;
  for (const rel of relPaths) {
    const stat = await fs.stat(path.join(root, rel)).catch(() => undefined);
    if (stat) total += stat.size;
  }
  return total;
}

async function withStore(use: (cache: EncryptAddressCacheApi) => Promise<void> | void): Promise<void> {
  const cache = await openEncryptAddressCacheStore(root, ctx);
  try {
    await use(cache);
  } finally {
    cache.close();
  }
}

test("SQLite encrypt cache records, looks up and persists across opens", async () => {
  await withStore((cache) => {
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
    cache.record(hex("c"), { encSha: hex("d"), cipherSize: 12, comp: "zstd", payloadSha: hex("e"), path: "c.txt" });
    // Every record is already committed, so the JSON writer's flush has nothing to do.
    expect(cache.needsSave).toBe(false);
  });

  await withStore((cache) => {
    expect(cache.lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
    expect(cache.lookup(hex("c"))).toEqual({ encSha: hex("d"), cipherSize: 12, comp: "zstd", payloadSha: hex("e") });
    expect(cache.lookup(hex("f"))).toBeUndefined();
  });
});

test("SQLite encrypt cache refuses malformed addresses exactly as the JSON cache does", async () => {
  await withStore((cache) => {
    expect(() => cache.record("nope", { encSha: hex("b"), cipherSize: 10, path: "a.txt" })).toThrow(/invalid plaintext sha/);
    expect(() => cache.record(hex("a"), { encSha: "nope", cipherSize: 10, path: "a.txt" })).toThrow(/invalid ciphertext sha/);
    expect(() => cache.record(hex("a"), { encSha: hex("b"), cipherSize: -1, path: "a.txt" })).toThrow(/invalid ciphertext size/);
    expect(() => cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, comp: "zstd", path: "a.txt" })).toThrow(/compression descriptor/);
    expect(() => cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "../a.txt" })).toThrow(/invalid path/);
    expect(() => cache.migratePath(hex("a"), "../a.txt")).toThrow(/invalid path/);
  });
});

test("SQLite encrypt cache keeps one owner per path, and prune drops departed paths", async () => {
  await withStore((cache) => {
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "stay.txt" });
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "gone.txt" });
    cache.record(hex("c"), { encSha: hex("d"), cipherSize: 12, path: "departed.txt" });

    // Re-recording a path under a new sha moves ownership rather than duplicating it.
    cache.record(hex("e"), { encSha: hex("f"), cipherSize: 14, path: "gone.txt" });
    expect(cache.lookup(hex("e"))).toEqual({ encSha: hex("f"), cipherSize: 14 });

    cache.prune(new Set(["stay.txt"]));
    expect(cache.lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
    expect(cache.lookup(hex("c"))).toBeUndefined();
    expect(cache.lookup(hex("e"))).toBeUndefined();
    // Pruned paths keep no reverse mapping to evict.
    expect(cache.migratePath(hex("0"), "gone.txt")).toBe(false);
    expect(cache.migratePath(hex("0"), "departed.txt")).toBe(false);
  });
});

test("SQLite encrypt cache migratePath evicts another owner without adopting the path", async () => {
  await withStore((cache) => {
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "carried.txt" });
    expect(cache.migratePath(hex("a"), "carried.txt")).toBe(false);
    expect(cache.migratePath(hex("c"), "carried.txt")).toBe(true);
    expect(cache.lookup(hex("a"))).toBeUndefined();
    expect(cache.lookup(hex("c"))).toBeUndefined();
    expect(cache.migratePath(hex("c"), "missing.txt")).toBe(false);
  });
});

test("SQLite encrypt cache drops every address when the account or key context changes", async () => {
  await withStore((cache) => {
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
  });

  const rotated = await openEncryptAddressCacheStore(root, { ...ctx, keyEpoch: ctx.keyEpoch + 1 });
  expect(rotated.lookup(hex("a"))).toBeUndefined();
  rotated.record(hex("c"), { encSha: hex("d"), cipherSize: 12, path: "c.txt" });
  rotated.close();

  const reopened = await openEncryptAddressCacheStore(root, { ...ctx, keyEpoch: ctx.keyEpoch + 1 });
  expect(reopened.lookup(hex("c"))).toEqual({ encSha: hex("d"), cipherSize: 12 });
  reopened.close();
});

test("a one-address change writes kilobytes, not the whole cache", async () => {
  const SEEDED = 5_000;
  await withStore((cache) => {
    for (let i = 0; i < SEEDED; i++) cache.record(shaOf(i), { encSha: shaOf(i + 1), cipherSize: 4096, path: `dir${i % 50}/f${i}.bin` });
  });

  // The same population through the JSON backing, to size what a flush used to cost.
  const json = new EncryptAddressCache(ctx);
  for (let i = 0; i < SEEDED; i++) json.record(shaOf(i), { encSha: shaOf(i + 1), cipherSize: 4096, path: `dir${i % 50}/f${i}.bin` });
  await json.save(root);
  const jsonBytes = await bytesOnDisk(ENCRYPT_ADDRESS_CACHE_REL);
  expect(jsonBytes).toBeGreaterThan(900_000);

  const before = await bytesOnDisk(ENCRYPT_ADDRESS_CACHE_DB_REL, `${ENCRYPT_ADDRESS_CACHE_DB_REL}-wal`);
  const cache = await openEncryptAddressCacheStore(root, ctx);
  cache.record(shaOf(SEEDED), { encSha: shaOf(SEEDED + 1), cipherSize: 4096, path: "one/more.bin" });
  const written = await bytesOnDisk(ENCRYPT_ADDRESS_CACHE_DB_REL, `${ENCRYPT_ADDRESS_CACHE_DB_REL}-wal`) - before;
  cache.close();

  // A handful of 4 KiB pages, versus a megabyte-plus rewrite of every entry.
  expect(written).toBeLessThan(64 * 1024);
  expect(written * 10).toBeLessThan(jsonBytes);
});

test("re-recording an unchanged address writes nothing", async () => {
  await withStore((cache) => {
    for (let i = 0; i < 200; i++) cache.record(shaOf(i), { encSha: shaOf(i + 1), cipherSize: 4096, path: `f${i}.bin` });
  });

  const before = await bytesOnDisk(ENCRYPT_ADDRESS_CACHE_DB_REL, `${ENCRYPT_ADDRESS_CACHE_DB_REL}-wal`);
  await withStore((cache) => {
    for (let i = 0; i < 200; i++) cache.record(shaOf(i), { encSha: shaOf(i + 1), cipherSize: 4096, path: `f${i}.bin` });
  });
  expect(await bytesOnDisk(ENCRYPT_ADDRESS_CACHE_DB_REL, `${ENCRYPT_ADDRESS_CACHE_DB_REL}-wal`)).toBe(before);
});

test("closing the SQLite cache leaves no WAL sidecars behind", async () => {
  await withStore((cache) => {
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
  });
  for (const suffix of ["-wal", "-shm"]) {
    await expect(fs.stat(path.join(root, `${ENCRYPT_ADDRESS_CACHE_DB_REL}${suffix}`))).rejects.toThrow();
  }
});

test("the legacy JSON cache is imported once and then moved aside", async () => {
  await writeLegacy({
    [hex("a")]: { encSha: hex("b"), cipherSize: 10, paths: ["a.txt", "also-a.txt"] },
    [hex("c")]: { encSha: hex("d"), cipherSize: 12, comp: "zstd", payloadSha: hex("e"), paths: ["c.txt"] },
  });

  await withStore((cache) => {
    expect(cache.lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
    expect(cache.lookup(hex("c"))).toEqual({ encSha: hex("d"), cipherSize: 12, comp: "zstd", payloadSha: hex("e") });
    expect(cache.migratePath(hex("0"), "also-a.txt")).toBe(true);
  });

  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_REL))).rejects.toThrow();
  expect(JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_MIGRATED_REL), "utf8")).entries[hex("a")].paths)
    .toEqual(["a.txt", "also-a.txt"]);

  // Second open re-imports nothing: the path evicted above stays evicted.
  await withStore((cache) => {
    expect(cache.migratePath(hex("0"), "also-a.txt")).toBe(false);
    expect(cache.lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
  });
});

test("legacy import resolves duplicate paths in the JSON backing's order", async () => {
  await writeLegacy({
    [hex("b")]: { encSha: hex("d"), cipherSize: 12, paths: ["b.txt", "dupe.txt"] },
    [hex("a")]: { encSha: hex("c"), cipherSize: 10, paths: ["a.txt", "dupe.txt"] },
  });

  await withStore((cache) => {
    // First owner in sorted-sha order keeps the duplicated path.
    expect(cache.migratePath(hex("a"), "dupe.txt")).toBe(false);
    expect(cache.migratePath(hex("b"), "dupe.txt")).toBe(true);
    expect(cache.lookup(hex("b"))).toEqual({ encSha: hex("d"), cipherSize: 12 });
  });
});

test("an unusable legacy JSON cache is moved aside without importing", async () => {
  const malformed = JSON.stringify({ version: 1, ...ctx, entries: { [hex("a")]: { encSha: "bad", cipherSize: 10, paths: ["a.txt"] } } });
  for (const body of ["{not json", malformed]) {
    await fs.rm(path.join(root, ".rbox"), { recursive: true, force: true });
    await writeLegacyText(body);
    await withStore((cache) => {
      expect(cache.lookup(hex("a"))).toBeUndefined();
    });
    await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_REL))).rejects.toThrow();
  }
});

test("a corrupt cache database is rebuilt instead of failing the push", async () => {
  const file = path.join(root, ENCRYPT_ADDRESS_CACHE_DB_REL);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, "this is not a database");

  await withStore((cache) => {
    cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
    expect(cache.lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
  });
});

test("RBOX_ENCRYPT_CACHE_SQLITE=0 keeps the whole-file JSON cache working", async () => {
  process.env.RBOX_ENCRYPT_CACHE_SQLITE = "0";
  const cache = await loadEncryptAddressCache(root, ctx);
  const writer = new EncryptAddressCacheWriter(root, cache, 60_000);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
  expect(cache.needsSave).toBe(true);
  writer.schedule();
  await writer.flush();
  cache.close();

  expect(JSON.parse(await fs.readFile(path.join(root, ENCRYPT_ADDRESS_CACHE_REL), "utf8")).entries[hex("a")])
    .toEqual({ encSha: hex("b"), cipherSize: 10, paths: ["a.txt"] });
  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_DB_REL))).rejects.toThrow();

  const reloaded = await loadEncryptAddressCache(root, ctx);
  expect(reloaded.lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
  reloaded.close();
});

test("the default backing is SQLite", async () => {
  const cache = await loadEncryptAddressCache(root, ctx);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
  cache.close();
  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_DB_REL))).resolves.toBeDefined();
  await expect(fs.stat(path.join(root, ENCRYPT_ADDRESS_CACHE_REL))).rejects.toThrow();
});
