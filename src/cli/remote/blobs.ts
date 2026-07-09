import fs from "node:fs";
import fsp from "node:fs/promises";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { finished } from "node:stream/promises";
import type { ByteProgressCallback } from "../../engine/blobstore.js";
import type { RemoteContext } from "./context.js";
import { BlobShaMismatchError, isShaMismatch, readQuotaExceeded, translateRemoteError } from "./errors.js";
import { fileStream } from "./stream.js";
import { putBlobMultipart } from "./multipart.js";
import { BUFFERED_GET_TIMEOUT_MS, DOWNLOAD_IDLE_MS, SMALL_CONTROL_TIMEOUT_MS, blobDownloadTimeoutMs, envInt, fetchBufferedGet, fetchWithDeadline, retryTransient, transferTimeoutMs } from "./resilient.js";

/** A content-addressed download that arrives with the WRONG hash is corruption we
 *  CAUGHT before writing — observed as a rare Bun `fetch` byte mis-reassembly on large
 *  blobs under sustained heavy concurrent load (verified: the blob is correct in R2 and
 *  `curl`/isolated fetches always get it right; only the full-pipeline load corrupts it).
 *  Because the hash proves when we finally have correct bytes, the safe response is to
 *  RE-FETCH, not fail the whole sync. This is the ceiling on such re-fetches. */
const BLOB_INTEGRITY_RETRIES = envInt("RBOX_NET_INTEGRITY_RETRIES", 4, 0, 20);
const INTEGRITY_MISMATCH_MARKER = "download integrity mismatch";

const MiB = 1024 * 1024;
const SINGLE_PUT_MAX = 90 * MiB; // must match the Worker's threshold

export async function putBlob(
  ctx: RemoteContext,
  sha256: string,
  bytes: Uint8Array,
  onBytes?: ByteProgressCallback
): Promise<void> {
  // Content-addressed and small-bodied on the E2EE push path (encManifest/refset sidecar):
  // idempotent retries plus a flat control deadline, not the large-transfer budget.
  const res = await ctx.fetch(`${ctx.baseUrl}/v1/blobs/${sha256}`, {
    method: "PUT",
    headers: ctx.protoAuth,
    body: bytes,
  }, { op: "uploading data", timeoutMs: SMALL_CONTROL_TIMEOUT_MS });
  if (!res.ok) {
    const { quota, text } = await readQuotaExceeded(res);
    if (quota) throw quota;
    throw new Error(translateRemoteError(res.status, "blob PUT failed", text, "workspace not found — check you're in the right directory"));
  }
  ctx.captureReceipt(sha256, (await res.json().catch(() => ({}))) as { receipt?: unknown });
  onBytes?.(bytes.byteLength);
}

export async function getBlob(ctx: RemoteContext, sha256: string): Promise<Buffer> {
  // Buffered GET (small blobs / manifests): a flat-generous deadline — the size is unknown up
  // front, so we can't scale it and can't watch progress the way the streaming path does. Safe
  // to retry (a GET is idempotent). Large blobs take the streaming getBlobToFile path instead.
  const got = await fetchBufferedGet(`${ctx.baseUrl}/v1/blobs/${sha256}`, { headers: ctx.authDownload }, {
    op: "downloading data",
    timeoutMs: BUFFERED_GET_TIMEOUT_MS,
  });
  if (!got.ok) throw new Error(translateRemoteError(got.response.status, "blob GET failed", undefined, "remote blob not found — run rbox sync again"));
  return Buffer.from(got.body);
}

/**
 * Upload a file by content address, streaming (never buffering the whole file).
 * ≤ SINGLE_PUT_MAX → one streamed PUT (R2 verifies the hash server-side); larger
 * → resumable multipart. `uploadsDir` (`.rbox/state/uploads/`) enables resume.
 */
export async function putBlobFile(
  ctx: RemoteContext,
  sha256: string,
  absPath: string,
  size: number,
  uploadsDir?: string,
  onBytes?: ByteProgressCallback
): Promise<void> {
  if (size <= SINGLE_PUT_MAX) {
    // Content-addressed → idempotent: a retried streamed PUT re-sends the same file bytes.
    // A socket close during the upload body surfaces as a thrown fetch fault (not a Response),
    // so the retry re-drives the whole PUT. NB: the body is a fresh fileStream PER attempt —
    // retryTransient re-invokes this thunk, so a consumed/again-un-consumable stream can't leak.
    const res = await retryTransient(
      () =>
        fetchWithDeadline(`${ctx.baseUrl}/v1/blobs/${sha256}`, {
          method: "PUT",
          headers: { ...ctx.protoAuth, "content-length": String(size) },
          body: fileStream(absPath),
          duplex: "half",
        } as RequestInit, transferTimeoutMs(size)),
      { op: "uploading data" }
    );
    if (res.status !== 413) {
      if (!res.ok) {
        const { quota, text } = await readQuotaExceeded(res);
        if (quota) throw quota;
        if (isShaMismatch(res.status, text)) throw new BlobShaMismatchError(sha256); // live-folder TOCTOU → let push re-scan + retry
        throw new Error(translateRemoteError(res.status, "blob PUT failed", text, "workspace not found — check you're in the right directory"));
      }
      ctx.captureReceipt(sha256, (await res.json().catch(() => ({}))) as { receipt?: unknown });
      onBytes?.(size);
      return;
    }
    // 413: server says too big for single PUT → fall through to multipart (legacy
    // canonical+grant+present=1 path; large files aren't on the receipts hot path).
  }
  await putBlobMultipart(ctx, sha256, absPath, size, uploadsDir, onBytes);
}

/** Stream a blob to `destPath`, hashing as it lands; verify before returning.
 *  Any failure (network, write, or hash mismatch) removes the partial file.
 *
 *  Deadline design (design 45, extended): a flat cap would kill a legitimately slow multi-GB
 *  download, so instead of one deadline we use a NO-PROGRESS watchdog — an AbortController that
 *  fires only if no bytes arrive for {@link DOWNLOAD_IDLE_MS}, reset on every chunk. This is the
 *  fix for the 110-minute black-holed fetch (a stuck socket at 0 CPU): a stalled stream trips the
 *  watchdog, which the retry loop treats as transient and re-drives (a GET is idempotent). A hash
 *  mismatch is NOT transient and propagates on the first attempt. */
export async function getBlobToFile(ctx: RemoteContext, sha256: string, destPath: string, expectedSize?: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await retryTransient(() => downloadToFileOnce(ctx, sha256, destPath, expectedSize), {
        op: `downloading blob ${sha256}`,
        rerunHint: "safe to re-run `rbox pull`: already-downloaded blobs are skipped",
      });
      return;
    } catch (e) {
      // A hash mismatch means the bytes arrived corrupt (and were discarded, not written).
      // Re-fetch: a later attempt lands as the concurrent pool drains — the low-concurrency
      // condition that reliably delivers correct bytes. Bounded so a genuinely-unfetchable
      // blob still fails loudly with the resume hint rather than looping forever.
      if (attempt < BLOB_INTEGRITY_RETRIES && e instanceof Error && e.message.includes(INTEGRITY_MISMATCH_MARKER)) {
        await new Promise((r) => setTimeout(r, Math.min(2000, 250 * 2 ** attempt) * (0.5 + Math.random())));
        continue;
      }
      throw e;
    }
  }
}

async function downloadToFileOnce(ctx: RemoteContext, sha256: string, destPath: string, expectedSize?: number): Promise<void> {
  const ctrl = new AbortController();
  const signal = AbortSignal.any([ctrl.signal, AbortSignal.timeout(blobDownloadTimeoutMs(expectedSize))]);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    // A stalled stream is transient — tag the abort as a TimeoutError so the predicate retries it.
    idle = setTimeout(() => ctrl.abort(new DOMException("download stalled", "TimeoutError")), DOWNLOAD_IDLE_MS);
  };
  armIdle();
  try {
    const res = await fetch(`${ctx.baseUrl}/v1/blobs/${sha256}`, { headers: ctx.authDownload, signal });
    if (!res.ok || !res.body) throw new Error(translateRemoteError(res.status, "blob GET failed", undefined, "remote blob not found — run rbox sync again"));
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const hash = createHash("sha256");
    const out = fs.createWriteStream(destPath, { flags: "w" }); // every retry starts from byte 0
    const written = finished(out);
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(); // progress → reset the no-progress watchdog
        if (value?.byteLength) {
          hash.update(value);
          if (!out.write(value)) await once(out, "drain");
        }
      }
      out.end();
      await written;
      const actual = hash.digest("hex");
      if (actual !== sha256) throw new Error(`download integrity mismatch: wanted ${sha256}, got ${actual}`);
    } catch (e) {
      await reader.cancel().catch(() => {});
      if (!out.destroyed) out.destroy();
      await written.catch(() => {});
      await fsp.rm(destPath, { force: true }).catch(() => {});
      throw e;
    } finally {
      try {
        reader.releaseLock();
      } catch {
        // Best-effort cleanup only; preserve the original network/write/hash failure.
      }
    }
  } finally {
    if (idle) clearTimeout(idle);
  }
}
