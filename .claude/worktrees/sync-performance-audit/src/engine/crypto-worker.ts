import {
  decryptFileToPathInline,
  encryptFileToTempInline,
} from "./crypto.js";
import type { CryptoWorkerJobMessage, CryptoWorkerMessage, SerializedError } from "./crypto-worker-protocol.js";

declare const self: {
  onmessage: ((event: { data: CryptoWorkerMessage }) => void | Promise<void>) | null;
  postMessage(message: unknown): void;
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
    } else {
      await decryptFileToPathInline(job.ctPath, kek, job.plaintextSha, job.destPath, job.opts ?? {});
      self.postMessage({ id: job.id, ok: true });
    }
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: serializeError(err) });
  }
};
