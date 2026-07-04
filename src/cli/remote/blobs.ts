import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import type { RemoteContext } from "./context.js";
import { BlobShaMismatchError, isShaMismatch, readQuotaExceeded, translateRemoteError } from "./errors.js";
import { fileStream } from "./stream.js";
import { putBlobMultipart } from "./multipart.js";

const MiB = 1024 * 1024;
const SINGLE_PUT_MAX = 90 * MiB; // must match the Worker's threshold

export async function putBlob(ctx: RemoteContext, sha256: string, bytes: Uint8Array): Promise<void> {
  const res = await fetch(`${ctx.baseUrl}/v1/blobs/${sha256}`, {
    method: "PUT",
    headers: ctx.protoAuth,
    body: bytes,
  });
  if (!res.ok) {
    const { quota, text } = await readQuotaExceeded(res);
    if (quota) throw quota;
    throw new Error(translateRemoteError(res.status, "blob PUT failed", text, "workspace not found — check you're in the right directory"));
  }
  ctx.captureReceipt(sha256, (await res.json().catch(() => ({}))) as { receipt?: unknown });
}

export async function getBlob(ctx: RemoteContext, sha256: string): Promise<Buffer> {
  const res = await fetch(`${ctx.baseUrl}/v1/blobs/${sha256}`, { headers: ctx.authDownload });
  if (!res.ok) throw new Error(translateRemoteError(res.status, "blob GET failed", undefined, "remote blob not found — run rbox sync again"));
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Upload a file by content address, streaming (never buffering the whole file).
 * ≤ SINGLE_PUT_MAX → one streamed PUT (R2 verifies the hash server-side); larger
 * → resumable multipart. `uploadsDir` (`.rbox/state/uploads/`) enables resume.
 */
export async function putBlobFile(ctx: RemoteContext, sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void> {
  if (size <= SINGLE_PUT_MAX) {
    const res = await fetch(`${ctx.baseUrl}/v1/blobs/${sha256}`, {
      method: "PUT",
      headers: { ...ctx.protoAuth, "content-length": String(size) },
      body: fileStream(absPath),
      duplex: "half",
    } as RequestInit);
    if (res.status !== 413) {
      if (!res.ok) {
        const { quota, text } = await readQuotaExceeded(res);
        if (quota) throw quota;
        if (isShaMismatch(res.status, text)) throw new BlobShaMismatchError(sha256); // live-folder TOCTOU → let push re-scan + retry
        throw new Error(translateRemoteError(res.status, "blob PUT failed", text, "workspace not found — check you're in the right directory"));
      }
      ctx.captureReceipt(sha256, (await res.json().catch(() => ({}))) as { receipt?: unknown });
      return;
    }
    // 413: server says too big for single PUT → fall through to multipart (legacy
    // canonical+grant+present=1 path; large files aren't on the receipts hot path).
  }
  await putBlobMultipart(ctx, sha256, absPath, size, uploadsDir);
}

/** Stream a blob to `destPath`, hashing as it lands; verify before returning.
 *  Any failure (network, write, or hash mismatch) removes the partial file. */
export async function getBlobToFile(ctx: RemoteContext, sha256: string, destPath: string): Promise<void> {
  const res = await fetch(`${ctx.baseUrl}/v1/blobs/${sha256}`, { headers: ctx.authDownload });
  if (!res.ok || !res.body) throw new Error(translateRemoteError(res.status, "blob GET failed", undefined, "remote blob not found — run rbox sync again"));
  const hash = createHash("sha256");
  const out = fs.createWriteStream(destPath);
  const reader = (res.body as ReadableStream<Uint8Array>).getReader();
  try {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          hash.update(value);
          if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        }
      }
    } finally {
      out.end();
    }
    await new Promise<void>((resolve, reject) => out.on("finish", () => resolve()).on("error", reject));
    const actual = hash.digest("hex");
    if (actual !== sha256) throw new Error(`download integrity mismatch: wanted ${sha256}, got ${actual}`);
  } catch (e) {
    await fsp.rm(destPath, { force: true }).catch(() => {});
    throw e;
  }
}
