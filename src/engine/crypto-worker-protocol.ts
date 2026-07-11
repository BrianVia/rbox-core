import type { DecryptFileOptions, EncryptFileOptions } from "./crypto.js";

export const FUSE_MAX_FILE_BYTES = 256 * 1024;

export type SerializedError = {
  name?: string;
  message: string;
  code?: unknown;
  errno?: unknown;
  syscall?: unknown;
  path?: unknown;
  dest?: unknown;
  stack?: string;
  cause?: SerializedError;
};

export type CryptoWorkerInitMessage = { kek: Uint8Array };
export type CryptoWorkerHealthMessage = { id: number; kind: "health" };
export type CryptoWorkerEncryptMessage = { id: number; kind: "encrypt"; srcPath: string; tmpDir?: string; opts?: EncryptFileOptions };
export type InMemoryEncryptedBlob = {
  plaintextSha: string;
  encSha: string;
  cipherSize: number;
  comp?: "zstd";
  payloadSha?: string;
  ciphertext: ArrayBuffer;
};
export type FusedJobEntry = {
  index: number;
  srcPath: string;
  expected: { sha256: string; size: number };
  opts?: Omit<EncryptFileOptions, "expected">;
};
export type CryptoWorkerEncryptBatchMessage = {
  id: number;
  kind: "encryptBatch";
  jobs: FusedJobEntry[];
  jobPlaintextCap: number;
};
export type FusedResult =
  | { index: number; ok: true; blob: InMemoryEncryptedBlob }
  | { index: number; ok: false; error: SerializedError }
  | { index: number; ok: false; requeue: true };
export type CryptoWorkerEncryptBatchResult = { results: FusedResult[] };
export type CryptoWorkerDecryptMessage = {
  id: number;
  kind: "decrypt";
  ctPath: string;
  plaintextSha: string;
  destPath: string;
  opts?: DecryptFileOptions;
};

export type CryptoWorkerJobMessage = CryptoWorkerHealthMessage | CryptoWorkerEncryptMessage | CryptoWorkerEncryptBatchMessage | CryptoWorkerDecryptMessage;
export type CryptoWorkerMessage = CryptoWorkerInitMessage | CryptoWorkerJobMessage;

export type CryptoWorkerResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: SerializedError };
