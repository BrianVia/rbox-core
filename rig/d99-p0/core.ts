import { createCipheriv, createHash, hkdfSync } from "node:crypto";
import { Readable, Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import * as zlib from "node:zlib";

const AAD = Buffer.from("rbox/blob/v1");
const ZSTD_LEVEL = 3;
const COMPRESS_MIN_BYTES = 128;
const COMPRESS_RATIO = 0.95;

export type Expected = { sha256: string; size: number };
export type MemoryBlob = {
  plaintextSha: string; encSha: string; cipherSize: number; comp?: "zstd";
  payloadSha?: string; ct: ArrayBuffer;
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function compressStreaming(src: Buffer): Promise<Buffer> {
  const factory = (zlib as typeof zlib & { createZstdCompress?: (o?: { level?: number }) => Transform }).createZstdCompress;
  if (!factory) throw new Error("zstd compression is not available in this runtime");
  const chunks: Buffer[] = [];
  await pipeline(Readable.from([src]), factory({ level: ZSTD_LEVEL }), new Writable({
    write(chunk, _encoding, callback) { chunks.push(chunk); callback(); },
  }));
  return Buffer.concat(chunks);
}

export async function encryptBytesInMemory(srcBytes: Uint8Array, kekBytes: Uint8Array, expected: Expected, compress = true): Promise<MemoryBlob> {
  const src = Buffer.from(srcBytes.buffer, srcBytes.byteOffset, srcBytes.byteLength);
  const plaintextSha = sha256(src);
  if (plaintextSha !== expected.sha256 || src.length !== expected.size) {
    const error = Object.assign(new Error("source changed while encrypting"), { code: "RBOX_SOURCE_CHANGED" });
    throw error;
  }
  let payload = src;
  let payloadSha = plaintextSha;
  let comp: "zstd" | undefined;
  if (compress && src.length >= COMPRESS_MIN_BYTES) {
    const compressed = await compressStreaming(src);
    if (compressed.length < src.length * COMPRESS_RATIO) {
      payload = compressed; payloadSha = sha256(payload); comp = "zstd";
    }
  }
  const out = Buffer.from(hkdfSync("sha256", Buffer.from(kekBytes), AAD, Buffer.from(payloadSha, "hex"), 44));
  const cipher = createCipheriv("aes-256-gcm", out.subarray(0, 32), out.subarray(32, 44));
  cipher.setAAD(AAD);
  const body = cipher.update(payload);
  cipher.final();
  const ct = Buffer.concat([body, cipher.getAuthTag()]);
  const owned = ct.buffer.slice(ct.byteOffset, ct.byteOffset + ct.byteLength) as ArrayBuffer;
  const base = { plaintextSha, encSha: sha256(ct), cipherSize: ct.length, ct: owned };
  return comp ? { ...base, comp, payloadSha } : base;
}
