import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EncryptAddressCache, EncryptAddressCacheWriter, ENCRYPT_ADDRESS_CACHE_REL, type EncryptAddressCacheContext } from "./encrypt-address-cache.js";

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

function stored(overrides: Partial<EncryptAddressCacheContext> = {}, entries: Record<string, unknown> = {}) {
  return { version: 1, ...ctx, ...overrides, entries };
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
  ]) {
    await writeCache(stored({}, { [hex("a")]: badEntry }));
    expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toBeUndefined();
  }
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

test("EncryptAddressCacheWriter final flush persists pending scheduled entries", async () => {
  const cache = new EncryptAddressCache(ctx);
  const writer = new EncryptAddressCacheWriter(root, cache, 60_000);
  cache.record(hex("a"), { encSha: hex("b"), cipherSize: 10, path: "a.txt" });
  writer.schedule();

  await writer.flush();

  expect((await EncryptAddressCache.load(root, ctx)).lookup(hex("a"))).toEqual({ encSha: hex("b"), cipherSize: 10 });
});
