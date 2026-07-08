import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  decryptFileToPath,
  decryptFileToPathInline,
  encryptFileToTemp,
  encryptFileToTempInline,
  generateKek,
  type EncryptedBlob,
  type EncryptFileOptions,
} from "./crypto.js";
import { __cryptoPoolTestHooks, cryptoPoolStatus, withCryptoPool } from "./crypto-pool.js";

const ENV_KEYS = ["RBOX_CRYPTO_WORKERS", "RBOX_CRYPTO_POOL_MIN_JOBS", "RBOX_CRYPTO_WORKER_TEST_DELAY_MS"] as const;
let savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string>>;

beforeEach(async () => {
  savedEnv = {};
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env.RBOX_CRYPTO_WORKERS = "2";
  process.env.RBOX_CRYPTO_POOL_MIN_JOBS = "1";
  delete process.env.RBOX_CRYPTO_WORKER_TEST_DELAY_MS;
  await __cryptoPoolTestHooks.reset();
});

afterEach(async () => {
  await __cryptoPoolTestHooks.reset();
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function compareInlineAndWorker(content: Buffer, opts: EncryptFileOptions): Promise<EncryptedBlob> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-det-"));
  const inlineTmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-inline-"));
  const workerTmp = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-worker-"));
  try {
    const src = path.join(root, "blob.bin");
    await fs.writeFile(src, content);
    const kek = generateKek();
    const inline = await encryptFileToTempInline(src, kek, inlineTmp, opts);
    let worker!: EncryptedBlob;
    await withCryptoPool(kek, 7, 1, async () => {
      worker = await encryptFileToTemp(src, kek, workerTmp, opts);
    });
    expect(worker.plaintextSha).toBe(inline.plaintextSha);
    expect(worker.encSha).toBe(inline.encSha);
    expect(worker.comp).toBe(inline.comp);
    expect(worker.payloadSha).toBe(inline.payloadSha);
    expect(fsSync.readFileSync(worker.ciphertextPath).equals(fsSync.readFileSync(inline.ciphertextPath))).toBe(true);
    return worker;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(inlineTmp, { recursive: true, force: true });
    await fs.rm(workerTmp, { recursive: true, force: true });
  }
}

describe("crypto worker pool", () => {
  test("worker encryption is byte-identical to inline for raw, buffered compressed, and streaming compressed blobs", async () => {
    await compareInlineAndWorker(randomBytes(16 * 1024), { compress: false });
    await compareInlineAndWorker(Buffer.from("buffered compression\n".repeat(20_000)), { compress: true });
    await compareInlineAndWorker(Buffer.alloc(4 * 1024 * 1024 + 1024, 0x61), { compress: true });
    expect(cryptoPoolStatus().workerExecutions).toBeGreaterThanOrEqual(3);
  });

  test("worker ENOENT rehydrates code so vanished-file defer callers can recognize it", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-enoent-"));
    try {
      const kek = generateKek();
      const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-enoent-ct-"));
      try {
        let caught: NodeJS.ErrnoException | undefined;
        await withCryptoPool(kek, 1, 1, async () => {
          try {
            await encryptFileToTemp(path.join(root, "missing.txt"), kek, tmpDir);
          } catch (err) {
            caught = err as NodeJS.ErrnoException;
          }
        });
        expect(caught?.code).toBe("ENOENT");
        expect(caught?.message).toContain("missing.txt");
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("decrypt integrity messages survive the worker boundary verbatim enough for callers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-integrity-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-integrity-ct-"));
    try {
      const kek = generateKek();
      const src = path.join(root, "story.txt");
      const content = Buffer.from("integrity check\n".repeat(40_000));
      await fs.writeFile(src, content);
      const blob = await encryptFileToTempInline(src, kek, tmpDir, { compress: true });

      const tampered = path.join(root, "tampered.ct");
      const bytes = await fs.readFile(blob.ciphertextPath);
      bytes[0] = bytes[0]! ^ 0xff;
      await fs.writeFile(tampered, bytes);

      let authErr: Error | undefined;
      await withCryptoPool(kek, 1, 1, async () => {
        try {
          await decryptFileToPath(tampered, kek, blob.plaintextSha, path.join(root, "tampered.out"), { comp: blob.comp, payloadSha: blob.payloadSha });
        } catch (err) {
          authErr = err as Error;
        }
      });
      expect(authErr?.message).toContain("unable to authenticate data");

      let capErr: Error | undefined;
      await withCryptoPool(kek, 1, 1, async () => {
        try {
          await decryptFileToPath(blob.ciphertextPath, kek, blob.plaintextSha, path.join(root, "cap.out"), {
            comp: blob.comp,
            payloadSha: blob.payloadSha,
            maxPlaintextBytes: content.length - 1,
          });
        } catch (err) {
          capErr = err as Error;
        }
      });
      expect(capErr?.message).toContain("decompressed plaintext exceeds declared size");
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("worker crash retries both in-flight jobs once on a replacement worker", async () => {
    process.env.RBOX_CRYPTO_WORKERS = "1";
    process.env.RBOX_CRYPTO_WORKER_TEST_DELAY_MS = "200";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-crash-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-crash-ct-"));
    try {
      const kek = generateKek();
      const files = [path.join(root, "a.txt"), path.join(root, "b.txt")];
      await Promise.all(files.map((file, i) => fs.writeFile(file, Buffer.from(`crash retry ${i}\n`.repeat(20_000)))));
      await withCryptoPool(kek, 1, 2, async () => {
        const pending = files.map((file) => encryptFileToTemp(file, kek, tmpDir, { compress: true }));
        await __cryptoPoolTestHooks.waitForStats((stats) => stats.inFlight === 2, 1_000);
        expect(__cryptoPoolTestHooks.terminateBusiestWorker()).toBe(true);
        const blobs = await Promise.all(pending);
        expect(blobs).toHaveLength(2);
      });
      expect(cryptoPoolStatus().workerExecutions).toBe(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("health-check failure persistently disables worker selection and falls back inline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-health-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-health-ct-"));
    try {
      const src = path.join(root, "file.txt");
      await fs.writeFile(src, "health fallback");
      const kek = generateKek();
      __cryptoPoolTestHooks.setWorkerPath(path.join(root, "missing-worker.ts"));
      await withCryptoPool(kek, 1, 1, async () => {
        const blob = await encryptFileToTemp(src, kek, tmpDir);
        const out = path.join(root, "out.txt");
        await decryptFileToPathInline(blob.ciphertextPath, kek, blob.plaintextSha, out);
        expect(await fs.readFile(out, "utf8")).toBe("health fallback");
      });
      const status = cryptoPoolStatus();
      expect(status.state).toBe("disabled");
      expect(status.workerExecutions).toBe(0);

      const before = status.workerExecutions;
      await withCryptoPool(kek, 1, 1, async () => {
        await encryptFileToTemp(src, kek, tmpDir);
      });
      expect(cryptoPoolStatus().workerExecutions).toBe(before);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("RBOX_CRYPTO_WORKERS=0 and job-count floor both keep operations inline", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-floor-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-floor-ct-"));
    try {
      const src = path.join(root, "file.txt");
      await fs.writeFile(src, "small operation");
      const kek = generateKek();

      process.env.RBOX_CRYPTO_WORKERS = "0";
      await withCryptoPool(kek, 1, 1, async () => {
        await encryptFileToTemp(src, kek, tmpDir);
      });
      expect(cryptoPoolStatus().state).toBe("off");
      expect(cryptoPoolStatus().workerExecutions).toBe(0);

      await __cryptoPoolTestHooks.reset();
      process.env.RBOX_CRYPTO_WORKERS = "2";
      process.env.RBOX_CRYPTO_POOL_MIN_JOBS = "8";
      await withCryptoPool(kek, 1, 1, async () => {
        await encryptFileToTemp(src, kek, tmpDir);
      });
      expect(cryptoPoolStatus().workerExecutions).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("bounded queue applies backpressure beyond worker slots plus queue capacity", async () => {
    process.env.RBOX_CRYPTO_WORKERS = "1";
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-queue-"));
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-pool-queue-ct-"));
    try {
      const hangingWorker = path.join(root, "hanging-worker.js");
      await fs.writeFile(
        hangingWorker,
        [
          "let ready = false;",
          "self.onmessage = (event) => {",
          "  const msg = event.data;",
          "  if (msg.kek) { ready = true; return; }",
          "  if (msg.kind === 'health') self.postMessage({ id: msg.id, ok: ready, result: 'ok' });",
          "};",
        ].join("\n")
      );
      __cryptoPoolTestHooks.setWorkerPath(hangingWorker);
      const kek = generateKek();
      const files: string[] = [];
      for (let i = 0; i < 7; i++) {
        const file = path.join(root, `${i}.txt`);
        await fs.writeFile(file, Buffer.from(`queue ${i}\n`.repeat(5000)));
        files.push(file);
      }
      await withCryptoPool(kek, 1, files.length, async () => {
        const firstSix = files.slice(0, 6).map((file) => encryptFileToTemp(file, kek, tmpDir));
        await __cryptoPoolTestHooks.waitForStats((stats) => stats.inFlight === 2 && stats.queue === 4, 1_000);
        let seventhSettled = false;
        const seventh = encryptFileToTemp(files[6]!, kek, tmpDir).then(() => {
          seventhSettled = true;
        });
        await sleep(50);
        expect(__cryptoPoolTestHooks.stats().queue).toBe(4);
        expect(seventhSettled).toBe(false);
        await __cryptoPoolTestHooks.reset();
        await Promise.allSettled([...firstSix, seventh]);
      });
      expect(cryptoPoolStatus().workerExecutions).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
