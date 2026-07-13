import type { SerializedError } from "../crypto-worker-protocol.js";

export function rehydrateError(error: SerializedError): Error {
  const out = new Error(error.message);
  out.name = error.name || "Error";
  for (const key of ["code", "errno", "syscall", "path", "dest"] as const) {
    if (error[key] !== undefined) (out as unknown as Record<string, unknown>)[key] = error[key];
  }
  if (error.cause) (out as unknown as { cause?: Error }).cause = rehydrateError(error.cause);
  if (error.stack) {
    out.stack = out.stack ? `${out.stack}\n--- worker stack ---\n${error.stack}` : error.stack;
  }
  return out;
}

export function workerCrashError(reason: string): Error {
  const err = new Error(`crypto worker crashed: ${reason}`);
  err.name = "CryptoWorkerCrashError";
  (err as NodeJS.ErrnoException).code = "RBOX_CRYPTO_WORKER_CRASH";
  return err;
}

export function closeError(): Error {
  const err = new Error("crypto worker pool closed");
  err.name = "CryptoWorkerPoolClosedError";
  (err as NodeJS.ErrnoException).code = "RBOX_CRYPTO_POOL_CLOSED";
  return err;
}

export function streamCancelledError(): Error {
  return Object.assign(new Error("crypto stream cancelled"), { code: "RBOX_CRYPTO_STREAM_CANCELLED" });
}
