import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";
import { encryptBytesInMemory, encryptFileToTempInline, generateKek } from "../crypto.js";
import { hashBytes } from "../hash.js";
import { __cryptoPoolTestHooks, CryptoPool, withCryptoPool } from "./pool.js";
import { PhaseReport, type Manifest } from "../index.js";
import { encryptAndUpload, setDefaultEncryptObserverForTest } from "../../cli/sync-recovery.js";
import type { SyncRemote } from "../../cli/remote.js";
import type { WorkspaceConfig } from "../../cli/config.js";

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
    const cryptoUrl = new URL("../crypto.ts", import.meta.url).href;
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
    const cryptoUrl = new URL("../crypto.ts", import.meta.url).href;
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

  test("cancel during requeue stat dispatches no retry child", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-cancel-requeue-"));
    const workerPath = path.join(root, "requeue-worker.js");
    const dispatchesPath = path.join(root, "dispatches.log");
    await fs.writeFile(workerPath, [
      `import fs from "node:fs/promises";`,
      "self.onmessage=async({data:m})=>{",
      "if(m.kek)return; if(m.kind==='health'){self.postMessage({id:m.id,ok:true,result:'ok'});return}",
      `if(m.kind==='encryptBatch'){await fs.appendFile(${JSON.stringify(dispatchesPath)}, "x");self.postMessage({id:m.id,ok:true,result:{results:m.jobs.map(j=>({index:j.index,ok:false,requeue:true}))}})}};`,
    ].join("\n"));
    __cryptoPoolTestHooks.setWorkerPath(workerPath);
    let statStarted!: () => void;
    const started = new Promise<void>((resolve) => { statStarted = resolve; });
    let resumeStat!: () => void;
    const resume = new Promise<void>((resolve) => { resumeStat = resolve; });
    __cryptoPoolTestHooks.setRequeueStat(async (pathname) => {
      statStarted();
      await resume;
      return fs.stat(pathname);
    });
    const bytes = Buffer.from("cancel while requeue stat is pending");
    const srcPath = path.join(root, "source");
    await fs.writeFile(srcPath, bytes);
    try {
      await withCryptoPool(generateKek(), 1, 1, async (pool) => {
        const stream = pool!.encryptStream([{ ref: "source", srcPath, size: bytes.length, tmpDir: root,
          opts: { compress: true, expected: { sha256: hashBytes(bytes), size: bytes.length } } }],
        { onReady: () => { throw new Error("canceled stream delivered a result"); } });
        await started;
        stream.cancel();
        resumeStat();
        await __cryptoPoolTestHooks.waitForStats((stats) => stats.inFlight === 0 && stats.queue === 0);
        while (pool!.fusedStatsForTest().used !== 0) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(await fs.readFile(dispatchesPath, "utf8")).toBe("x");
        expect(pool!.fusedStatsForTest().used).toBe(0);
      });
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  }, 10_000);

  test("encryptAndUpload flag routing invokes only the selected pool or oracle path", async () => {
    const run = async (fused: boolean) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-routing-"));
      const bytes = Buffer.from("production routing");
      const srcPath = path.join(root, "file.txt");
      await fs.writeFile(srcPath, bytes);
      const stat = await fs.stat(srcPath);
      const local: Manifest = { generatedAt: "", files: [{ path: "file.txt", type: "file", sha256: hashBytes(bytes), size: bytes.length, mode: 0o644, mtimeMs: stat.mtimeMs }] };
      const base: Manifest = { generatedAt: "", files: [] };
      const kek = generateKek();
      const cfg: WorkspaceConfig = { remoteWorkspaceId: "ws", projectId: "root", deviceId: "dev", rootPath: root, remoteUrl: "memory://", token: "", kek, accountId: "acct", accountEpoch: 1, keyEpoch: 1 };
      const remote: SyncRemote = {
        latest: async () => { throw new Error("unexpected latest"); },
        missingBlobs: async () => [],
        putBlobFile: async () => { throw new Error("unexpected upload"); },
        commit: async () => { throw new Error("unexpected commit"); },
        blobStore: () => { throw new Error("unexpected blob store"); },
      };
      let coalescedCalls = 0;
      let oracleCalls = 0;
      const originalEncryptCoalesced = CryptoPool.prototype.encryptCoalesced;
      CryptoPool.prototype.encryptCoalesced = function (...args) {
        coalescedCalls++;
        return originalEncryptCoalesced.apply(this, args);
      };
      setDefaultEncryptObserverForTest(() => { oracleCalls++; });
      // Fuse is default-on; the file-backed arm needs the explicit kill switch.
      process.env.RBOX_CRYPTO_FUSE = fused ? "1" : "0";
      try {
        await encryptAndUpload(remote, root, cfg, local, base, PhaseReport.disabled(), undefined, async () => {});
        return { coalescedCalls, oracleCalls };
      } finally {
        CryptoPool.prototype.encryptCoalesced = originalEncryptCoalesced;
        setDefaultEncryptObserverForTest(undefined);
        await fs.rm(root, { recursive: true, force: true });
      }
    };

    expect(await run(false)).toEqual({ coalescedCalls: 0, oracleCalls: 1 });
    expect(await run(true)).toEqual({ coalescedCalls: 1, oracleCalls: 0 });
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
      const oracle = new Map<number, Buffer>();
      for (let index = 0; index < 18; index++) {
        const bytes = seeded(256 * 1024, false);
        bytes.writeUInt32LE(index, 0);
        const srcPath = path.join(root, `stream-${index}`);
        await fs.writeFile(srcPath, bytes);
        items.push({ ref: index, srcPath, size: bytes.length, tmpDir: root, opts: { compress: true, expected: { sha256: hashBytes(bytes), size: bytes.length } } });
        oracle.set(index, Buffer.from((await encryptBytesInMemory(bytes, kek, { compress: true, expected: { sha256: hashBytes(bytes), size: bytes.length } })).ciphertext));
      }
      await withCryptoPool(kek, 1, items.length, async (pool) => {
        let ready = 0;
        let fileDeliveries = 0;
        const deliveries = new Map<number, number>();
        const done = new Promise<void>((resolve) => {
          pool!.encryptStream(items, { onReady: async (ref, blob) => {
            deliveries.set(ref, (deliveries.get(ref) ?? 0) + 1);
            if (ref === 0) await gate;
            const ciphertext = blob.lease.location.kind === "file"
              ? await fs.readFile(blob.lease.location.path)
              : Buffer.from(blob.lease.location.bytes);
            expect(ciphertext).toEqual(oracle.get(ref)!);
            if (blob.lease.location.kind === "file") {
              fileDeliveries++;
              expect(hashBytes(ciphertext)).toBe(blob.encSha);
            }
            blob.lease.release();
            if (++ready === items.length) resolve();
          } });
        });
        const started = Date.now();
        while (pool!.fusedStatsForTest().spilledFiles === 0 && Date.now() - started < 5_000) await new Promise((resolve) => setTimeout(resolve, 10));
        expect(pool!.fusedStatsForTest().spilledFiles).toBeGreaterThan(0);
        const spillDir = pool!.spillDirForTest();
        expect(spillDir).toBeDefined();
        unblock();
        await done;
        expect([...deliveries.values()]).toEqual(Array(items.length).fill(1));
        expect(fileDeliveries).toBe(pool!.fusedStatsForTest().spilledFiles);
        expect(pool!.fusedStatsForTest().used).toBe(0);
        await pool!.close();
        await expect(fs.stat(spillDir!)).rejects.toMatchObject({ code: "ENOENT" });
      });
    } finally {
      delete process.env.RBOX_CRYPTO_FUSE_BUDGET_BYTES;
      delete process.env.RBOX_CRYPTO_FUSE_DISPATCH;
      await fs.rm(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("close waits for an in-flight spill and prevents post-close delivery", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-fused-spill-close-"));
    process.env.RBOX_CRYPTO_FUSE_BUDGET_BYTES = String(4 * 1024 * 1024 + 512 * 16 + 64 * 1024 + 300 * 1024);
    process.env.RBOX_CRYPTO_FUSE_DISPATCH = "2";
    let resumeDelivery!: () => void;
    const deliveryGate = new Promise<void>((resolve) => { resumeDelivery = resolve; });
    let spillStarted!: (pathname: string) => void;
    const spillPath = new Promise<string>((resolve) => { spillStarted = resolve; });
    let resumeSpill!: () => void;
    const spillGate = new Promise<void>((resolve) => { resumeSpill = resolve; });
    __cryptoPoolTestHooks.setSpillWrite(async (pathname, bytes) => {
      spillStarted(pathname);
      await spillGate;
      await fs.writeFile(pathname, bytes, { mode: 0o600 });
    });
    try {
      const items = [];
      for (let index = 0; index < 18; index++) {
        const bytes = seeded(256 * 1024, false);
        bytes.writeUInt32LE(index, 0);
        const srcPath = path.join(root, `stream-${index}`);
        await fs.writeFile(srcPath, bytes);
        items.push({ ref: index, srcPath, size: bytes.length, tmpDir: root,
          opts: { compress: true, expected: { sha256: hashBytes(bytes), size: bytes.length } } });
      }
      await withCryptoPool(generateKek(), 1, items.length, async (pool) => {
        let deliveries = 0;
        pool!.encryptStream(items, { onReady: async (_ref, blob) => {
          deliveries++;
          blob.lease.release();
          await deliveryGate;
        } });
        const pathname = await spillPath;
        const deliveriesAtClose = deliveries;
        const closing = pool!.close();
        expect(pool!.close()).toBe(closing);
        let closed = false;
        void closing.then(() => { closed = true; });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(closed).toBe(false);
        resumeSpill();
        resumeDelivery();
        await closing;
        expect(deliveries).toBe(deliveriesAtClose);
        expect(pool!.fusedStatsForTest().used).toBe(0);
        await expect(fs.stat(path.dirname(pathname))).rejects.toMatchObject({ code: "ENOENT" });
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
