import {
  decryptFileToPathInline,
  encryptBytesInMemory,
  encryptFileToTempInline,
  isSourceChangedError,
} from "./crypto.js";
import fs from "node:fs/promises";
import { FUSE_MAX_FILE_BYTES, type CryptoWorkerEncryptBatchResult, type CryptoWorkerJobMessage, type CryptoWorkerMessage, type SerializedError } from "./crypto-worker-protocol.js";

declare const self: {
  onmessage: ((event: { data: CryptoWorkerMessage }) => void | Promise<void>) | null;
  postMessage(message: unknown, transfer?: ArrayBuffer[]): void;
};

let kek: Buffer | undefined;
const TEST_DELAY_MS = (() => {
  const raw = process.env.RBOX_CRYPTO_WORKER_TEST_DELAY_MS;
  if (raw === undefined) return 0;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 0;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
})();

function copyErrorField(out: SerializedError, key: keyof SerializedError, err: unknown): void {
  if (err && typeof err === "object" && key in err) {
    const value = (err as Record<string, unknown>)[key];
    if (value !== undefined) (out as Record<string, unknown>)[key] = value;
  }
}

function serializeError(err: unknown, depth = 0): SerializedError {
  const message = err instanceof Error ? err.message : String(err);
  const out: SerializedError = { message };
  if (err instanceof Error) {
    out.name = err.name;
    if (err.stack) out.stack = err.stack;
  }
  copyErrorField(out, "code", err);
  copyErrorField(out, "errno", err);
  copyErrorField(out, "syscall", err);
  copyErrorField(out, "path", err);
  copyErrorField(out, "dest", err);
  if (depth < 2 && err && typeof err === "object" && "cause" in err) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause !== undefined) out.cause = serializeError(cause, depth + 1);
  }
  return out;
}

function testDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, TEST_DELAY_MS));
}

// This allowlist isolates per-file failures so healthy siblings do not fail with
// the envelope. The caller's isDeferrableChurn still decides defer versus abort.
const ISOLATED_FILE_ERROR_CODES = new Set(["RBOX_SOURCE_CHANGED", "ENOENT", "ENOTDIR", "EACCES", "EPERM", "EISDIR", "ESTALE", "EBUSY"]);
function isAllowlistedFileError(err: unknown): boolean {
  if (isSourceChangedError(err)) return true;
  return typeof err === "object" && err !== null && "code" in err && ISOLATED_FILE_ERROR_CODES.has(String(err.code));
}

self.onmessage = async (event) => {
  const msg = event.data;
  if ("kek" in msg && !("kind" in msg)) {
    kek = Buffer.from(msg.kek);
    return;
  }

  if (!("kind" in msg) || !("id" in msg)) {
    self.postMessage({ id: (msg as { id?: number }).id ?? -1, ok: false, error: serializeError(new Error("crypto worker received malformed message")) });
    return;
  }

  const job = msg as CryptoWorkerJobMessage;
  if (job.kind === "health") {
    if (kek === undefined) {
      self.postMessage({ id: job.id, ok: false, error: serializeError(new Error("crypto worker not initialized")) });
    } else {
      self.postMessage({ id: job.id, ok: true, result: "ok" });
    }
    return;
  }

  try {
    if (!kek) throw new Error("crypto worker received job before KEK initialization");
    if (TEST_DELAY_MS > 0) await testDelay();
    if (job.kind === "encrypt") {
      const result = await encryptFileToTempInline(job.srcPath, kek, job.tmpDir, job.opts ?? {});
      self.postMessage({ id: job.id, ok: true, result });
    } else if (job.kind === "encryptBatch") {
      let usedPlaintext = 0;
      const result: CryptoWorkerEncryptBatchResult = { results: [] };
      const transfers: ArrayBuffer[] = [];
      for (const entry of job.jobs) {
        try {
          const src = await fs.readFile(entry.srcPath);
          if (src.length > FUSE_MAX_FILE_BYTES) {
            throw Object.assign(new Error("source changed beyond fused eligibility"), { code: "RBOX_SOURCE_CHANGED" });
          }
          if (usedPlaintext + src.length > job.jobPlaintextCap) {
            result.results.push({ index: entry.index, ok: false, requeue: true });
            continue;
          }
          usedPlaintext += src.length;
          const blob = await encryptBytesInMemory(src, kek, { ...entry.opts, expected: entry.expected });
          result.results.push({ index: entry.index, ok: true, blob });
          transfers.push(blob.ciphertext);
        } catch (err) {
          if (!isAllowlistedFileError(err)) throw err;
          result.results.push({ index: entry.index, ok: false, error: serializeError(err) });
        }
      }
      try {
        self.postMessage({ id: job.id, ok: true, result }, transfers);
      } catch {
        self.postMessage({ id: job.id, ok: false, error: serializeError(Object.assign(new Error("ciphertext transfer unsupported"), { code: "RBOX_CRYPTO_TRANSFER_UNSUPPORTED" })) });
      }
    } else {
      await decryptFileToPathInline(job.ctPath, kek, job.plaintextSha, job.destPath, job.opts ?? {});
      self.postMessage({ id: job.id, ok: true });
    }
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: serializeError(err) });
  }
};
