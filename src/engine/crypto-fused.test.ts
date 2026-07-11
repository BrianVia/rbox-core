import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { encryptBytesInMemory, encryptFileToTempInline, generateKek } from "./crypto.js";
import { hashBytes } from "./hash.js";
import { __cryptoPoolTestHooks, withCryptoPool } from "./crypto-pool.js";
import { __syncRecoveryTestHooks } from "../cli/sync-recovery.js";

function seeded(size: number, compressible: boolean): Buffer {
  const out = Buffer.alloc(size);
  let x = (size + 1) >>> 0;
  for (let i = 0; i < size; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = compressible ? 97 + (i % 4) : x & 255;
  }
  return out;
}

async function compressionRatio(src: Buffer): Promise<number> {
  const chunks: Buffer[] = [];
  const create = (zlib as typeof zlib & { createZstdCompress(o: { level: number }): NodeJS.ReadWriteStream }).createZstdCompress;
  await pipeline(Readable.from([src]), create({ level: 3 }), new Writable({ write(chunk, _encoding, cb) { chunks.push(chunk); cb(); } }));
  return Buffer.concat(chunks).length / src.length;
}

async function ratioEdges(): Promise<Buffer[]> {
  let below: Buffer | undefined;
  let above: Buffer | undefined;
  for (let k = 100; k >= 2 && (!below || !above); k--) {
    const src = Buffer.alloc(8192); let x = 424242;
    for (let i = 0; i < src.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; src[i] = i % k === 0 ? 97 : x & 255; }
    const ratio = await compressionRatio(src);
    if (!below && ratio < 0.95 && ratio > 0.9) below = src;
    if (!above && ratio >= 0.95 && ratio < 0.999) above = src;
  }
  return [below, above].filter((x): x is Buffer => x !== undefined);
}

describe("fused crypto", () => {
  beforeEach(async () => {
    await __cryptoPoolTestHooks.reset();
    process.env.RBOX_CRYPTO_WORKERS = "1";
    process.env.RBOX_CRYPTO_POOL_MIN_JOBS = "1";
    process.env.RBOX_CRYPTO_FUSE = "1";
  });
  afterEach(async () => {
    await __cryptoPoolTestHooks.reset();
    delete process.env.RBOX_CRYPTO_WORKERS;
    delete process.env.RBOX_CRYPTO_POOL_MIN_JOBS;
    delete process.env.RBOX_CRYPTO_FUSE;
  });

  test("memory helper and pool are byte-identical to the oracle at every boundary", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-det-"));
    const sizes = [0, 127, 128, 129, 255, 512, 2048, 8192, 65535, 65536, 65537, 131072, 200001, 262143, 262144, 262145];
    const cases = sizes.flatMap((size) => size === 0 ? [seeded(0, true)] : [seeded(size, true), seeded(size, false)]);
    const edges = await ratioEdges();
    expect(edges.length).toBe(2);
    cases.push(...edges);
    const kek = generateKek();
    try {
      await withCryptoPool(kek, 1, cases.length, async (pool) => {
        expect(pool).toBeDefined();
        for (let index = 0; index < cases.length; index++) {
          const src = cases[index]!;
          const srcPath = path.join(root, `fixture-${index}`);
          await fs.writeFile(srcPath, src);
          const expected = { sha256: hashBytes(src), size: src.length };
          const oracle = await encryptFileToTempInline(srcPath, kek, root, { compress: true, expected });
          const oracleBytes = await fs.readFile(oracle.ciphertextPath);
          const memory = await encryptBytesInMemory(src, kek, { compress: true, expected });
          const coalesced = await pool!.encryptCoalesced(srcPath, src.length, root, { compress: true, expected });
          const poolBytes = coalesced.lease.location.kind === "memory"
            ? Buffer.from(coalesced.lease.location.bytes)
            : await fs.readFile(coalesced.lease.location.path);
          expect({ plaintextSha: memory.plaintextSha, payloadSha: memory.payloadSha, encSha: memory.encSha, cipherSize: memory.cipherSize, comp: memory.comp })
            .toEqual({ plaintextSha: oracle.plaintextSha, payloadSha: oracle.payloadSha, encSha: oracle.encSha, cipherSize: oracle.cipherSize, comp: oracle.comp });
          expect(Buffer.from(memory.ciphertext)).toEqual(oracleBytes);
          expect({ plaintextSha: coalesced.plaintextSha, payloadSha: coalesced.payloadSha, encSha: coalesced.encSha, cipherSize: coalesced.cipherSize, comp: coalesced.comp })
            .toEqual({ plaintextSha: oracle.plaintextSha, payloadSha: oracle.payloadSha, encSha: oracle.encSha, cipherSize: oracle.cipherSize, comp: oracle.comp });
          expect(poolBytes).toEqual(oracleBytes);
          coalesced.lease.release();
          expect(() => coalesced.lease.release()).toThrow("released twice");
          await fs.rm(oracle.ciphertextPath, { force: true });
        }
        expect(pool!.fusedStatsForTest().used).toBe(0);
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 30_000);

  test("crash-class poison is attempted exactly K=3 times and isolated in a larger tree", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-split-"));
    const workerPath = path.join(root, "poison-worker.js");
    const attemptsPath = path.join(root, "attempts.log");
    const cryptoUrl = new URL("./crypto.ts", import.meta.url).href;
    await fs.writeFile(workerPath, [
      `import fs from "node:fs/promises"; import { encryptBytesInMemory } from ${JSON.stringify(cryptoUrl)};`,
      "let kek; self.onmessage = async ({data:m}) => {",
      "if (m.kek) { kek=Buffer.from(m.kek); return; }",
      "if (m.kind==='health') { self.postMessage({id:m.id,ok:true,result:'ok'}); return; }",
      "if (m.kind==='encryptBatch') { const results=[]; const tx=[]; for (const j of m.jobs) {",
      `if (j.srcPath.includes('poison')) { await fs.appendFile(${JSON.stringify(attemptsPath)}, "x"); self.postMessage({id:m.id,ok:false,error:{message:'deterministic poison'}}); return; }`,
      "const src=await fs.readFile(j.srcPath); const blob=await encryptBytesInMemory(src,kek,{...j.opts,expected:j.expected}); results.push({index:j.index,ok:true,blob}); tx.push(blob.ciphertext); }",
      "self.postMessage({id:m.id,ok:true,result:{results}},tx); } };",
    ].join("\n"));
    __cryptoPoolTestHooks.setWorkerPath(workerPath);
    const kek = generateKek();
    try {
      const names = Array.from({ length: 12 }, (_, index) => index === 7 ? "poison" : `sibling-${index}`);
      const files = await Promise.all(names.map(async (name) => {
        const bytes = Buffer.from(name.repeat(100)); const srcPath = path.join(root, name);
        await fs.writeFile(srcPath, bytes); return { srcPath, bytes, expected: { sha256: hashBytes(bytes), size: bytes.length } };
      }));
      await withCryptoPool(kek, 1, files.length, async (pool) => {
        const settled = await Promise.allSettled(files.map((file) => pool!.encryptCoalesced(file.srcPath, file.bytes.length, root, { compress: true, expected: file.expected })));
        expect(settled[7]!.status).toBe("rejected");
        expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(files.length - 1);
        expect((await fs.readFile(attemptsPath, "utf8")).length).toBe(3);
        const sampleIndex = 3;
        const sample = settled[sampleIndex]!;
        if (sample.status !== "fulfilled") throw sample.reason;
        const oracle = await encryptFileToTempInline(files[sampleIndex]!.srcPath, kek, root, { compress: true, expected: files[sampleIndex]!.expected });
        const actual = sample.value.lease.location.kind === "memory" ? Buffer.from(sample.value.lease.location.bytes) : await fs.readFile(sample.value.lease.location.path);
        expect(actual).toEqual(await fs.readFile(oracle.ciphertextPath));
        await fs.rm(oracle.ciphertextPath, { force: true });
        for (const result of settled) if (result.status === "fulfilled") result.value.lease.release();
        expect(pool!.fusedStatsForTest().used).toBe(0);
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  test("aggregate-overflow requeues resolve byte-identically without leaking charges", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-requeue-"));
    const workerPath = path.join(root, "requeue-worker.js");
    const cryptoUrl = new URL("./crypto.ts", import.meta.url).href;
    await fs.writeFile(workerPath, [
      `import fs from "node:fs/promises"; import { encryptBytesInMemory } from ${JSON.stringify(cryptoUrl)};`,
      "let kek; let first=true; self.onmessage=async({data:m})=>{",
      "if(m.kek){kek=Buffer.from(m.kek);return} if(m.kind==='health'){self.postMessage({id:m.id,ok:true,result:'ok'});return}",
      "if(m.kind==='encryptBatch'){const results=[];const tx=[];const requeue=first;first=false;for(const j of m.jobs){",
      "if(requeue && j.index%2===0){results.push({index:j.index,ok:false,requeue:true});continue}",
      "const src=await fs.readFile(j.srcPath);const blob=await encryptBytesInMemory(src,kek,{...j.opts,expected:j.expected});results.push({index:j.index,ok:true,blob});tx.push(blob.ciphertext)}",
      "self.postMessage({id:m.id,ok:true,result:{results}},tx)}};",
    ].join("\n"));
    __cryptoPoolTestHooks.setWorkerPath(workerPath);
    const kek = generateKek();
    try {
      const files = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
        const bytes = seeded(1024 + index, index % 2 === 0);
        const srcPath = path.join(root, `file-${index}`);
        await fs.writeFile(srcPath, bytes);
        return { srcPath, bytes, expected: { sha256: hashBytes(bytes), size: bytes.length } };
      }));
      await withCryptoPool(kek, 1, files.length, async (pool) => {
        const blobs = await Promise.all(files.map((file) => pool!.encryptCoalesced(file.srcPath, file.bytes.length, root, { compress: true, expected: file.expected })));
        for (let index = 0; index < files.length; index++) {
          const oracle = await encryptFileToTempInline(files[index]!.srcPath, kek, root, { compress: true, expected: files[index]!.expected });
          const actual = blobs[index]!.lease.location.kind === "memory" ? Buffer.from(blobs[index]!.lease.location.bytes) : await fs.readFile(blobs[index]!.lease.location.path);
          expect(actual).toEqual(await fs.readFile(oracle.ciphertextPath));
          blobs[index]!.lease.release();
          await fs.rm(oracle.ciphertextPath, { force: true });
        }
        expect(pool!.fusedStatsForTest().used).toBe(0);
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  test("production flag-off routing invokes the oracle and never the coalescer", async () => {
    delete process.env.RBOX_CRYPTO_FUSE;
    const fuse = __syncRecoveryTestHooks.useFusedCrypto(true, false);
    let coalescedCalls = 0;
    let oracleCalls = 0;
    const selected = await __syncRecoveryTestHooks.encryptViaSelectedPath(
      fuse,
      async () => { coalescedCalls++; return "coalesced"; },
      async () => { oracleCalls++; return "oracle"; },
    );
    expect(selected).toBe("oracle");
    expect(oracleCalls).toBe(1);
    expect(coalescedCalls).toBe(0);
  });

  test("paused stream spills only queued producer results and leaves no budget charge", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-spill-"));
    process.env.RBOX_CRYPTO_FUSE_BUDGET_BYTES = String(4 * 1024 * 1024 + 512 * 16 + 64 * 1024 + 300 * 1024);
    process.env.RBOX_CRYPTO_FUSE_DISPATCH = "2";
    const kek = generateKek();
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    try {
      const items = [];
      for (let index = 0; index < 18; index++) {
        const bytes = seeded(256 * 1024, false);
        const srcPath = path.join(root, `stream-${index}`);
        await fs.writeFile(srcPath, bytes);
        items.push({ ref: index, srcPath, size: bytes.length, tmpDir: root, opts: { compress: true, expected: { sha256: hashBytes(bytes), size: bytes.length } } });
      }
      await withCryptoPool(kek, 1, items.length, async (pool) => {
        let ready = 0;
        const done = new Promise<void>((resolve) => {
          pool!.encryptStream(items, { onReady: async (ref, blob) => {
            if (ref === 0) await gate;
            if (blob.lease.location.kind === "file") {
              const bytes = await fs.readFile(blob.lease.location.path);
              expect(hashBytes(bytes)).toBe(blob.encSha);
            }
            blob.lease.release();
            if (++ready === items.length) resolve();
          } });
        });
        const started = Date.now();
        while (pool!.fusedStatsForTest().spilledFiles === 0 && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(pool!.fusedStatsForTest().spilledFiles).toBeGreaterThan(0);
        unblock();
        await done;
        expect(pool!.fusedStatsForTest().used).toBe(0);
      });
    } finally {
      delete process.env.RBOX_CRYPTO_FUSE_BUDGET_BYTES;
      delete process.env.RBOX_CRYPTO_FUSE_DISPATCH;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("close retains then releases a posted job reserve after termination", async () => {
    process.env.RBOX_CRYPTO_WORKER_TEST_DELAY_MS = "200";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-close-"));
    const bytes = Buffer.from("posted close accounting".repeat(100));
    const srcPath = path.join(root, "source");
    await fs.writeFile(srcPath, bytes);
    const kek = generateKek();
    try {
      await withCryptoPool(kek, 1, 1, async (pool) => {
        const pending = pool!.encryptCoalesced(srcPath, bytes.length, root, { compress: true, expected: { sha256: hashBytes(bytes), size: bytes.length } });
        await __cryptoPoolTestHooks.waitForStats((stats) => stats.inFlight > 0);
        expect(pool!.fusedStatsForTest().used).toBeGreaterThan(0);
        await pool!.close();
        await expect(pending).rejects.toMatchObject({ code: "RBOX_CRYPTO_POOL_CLOSED" });
        expect(pool!.fusedStatsForTest().used).toBe(0);
      });
    } finally {
      delete process.env.RBOX_CRYPTO_WORKER_TEST_DELAY_MS;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 10_000);
});
