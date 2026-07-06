import fsp from "node:fs/promises";
import path from "node:path";
import type { RemoteContext } from "./context.js";
import { BlobShaMismatchError, QuotaExceededError, isShaMismatch, readQuotaExceeded, readShaMismatch, translateRemoteError } from "./errors.js";
import { fileStream, readJson } from "./stream.js";
import { fetchWithDeadline, retryTransient, transferTimeoutMs } from "./resilient.js";

export async function putBlobMultipart(ctx: RemoteContext, sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void> {
  try {
    await multipartAttempt(ctx, sha256, absPath, size, uploadsDir, true);
  } catch (e) {
    // A live-folder TOCTOU sha_mismatch is NOT a dead-upload — re-initing multipart
    // would re-read the same changed source and 400 again. Bubble it so the push
    // re-scans the settled tree and retries with the file's fresh encSha.
    if (e instanceof BlobShaMismatchError) throw e;
    if (e instanceof QuotaExceededError) throw e;
    // A resume against an expired/dead upload (or any mid-flight error) — clear
    // the token and retry once from a fresh init. If the second attempt fails,
    // surface it (the daemon's pump will retry later).
    if (uploadsDir) await fsp.rm(path.join(uploadsDir, `${sha256}.json`), { force: true }).catch(() => {});
    if ((await ctx.missingBlobs([sha256])).length === 0) return; // someone else finished it
    await multipartAttempt(ctx, sha256, absPath, size, uploadsDir, false);
  }
}

async function multipartAttempt(ctx: RemoteContext, sha256: string, absPath: string, size: number, uploadsDir: string | undefined, allowResume: boolean): Promise<void> {
  const tokenPath = uploadsDir ? path.join(uploadsDir, `${sha256}.json`) : undefined;

  // Try to resume from a persisted token (server is the source of truth).
  let uploadId: string | undefined;
  let partSize = 0;
  let completed = new Set<number>();
  if (allowResume && tokenPath) {
    const tok = await readJson<{ uploadId: string }>(tokenPath);
    if (tok?.uploadId) {
      const st = await ctx.fetch(`${ctx.baseUrl}/v1/blobs/${sha256}/multipart/${tok.uploadId}`, { headers: ctx.auth }, { op: "checking upload progress" });
      if (st.ok) {
        const body = (await st.json()) as { partSize: number; completedParts: number[] };
        uploadId = tok.uploadId;
        partSize = body.partSize;
        completed = new Set(body.completedParts);
      }
    }
  }

  if (!uploadId) {
    // Idempotent enough to retry: a re-init just mints a fresh MPU; an orphaned prior row
    // expires under the server's UPLOAD_EXPIRY sweep. The client only ever persists the latest.
    const res = await ctx.fetch(`${ctx.baseUrl}/v1/blobs/${sha256}/multipart`, {
      method: "POST",
      headers: { ...ctx.auth, "content-type": "application/json" },
      body: JSON.stringify({ size }),
    }, { op: "preparing upload" });
    if (!res.ok) {
      const { quota, text } = await readQuotaExceeded(res);
      if (quota) throw quota;
      throw new Error(translateRemoteError(res.status, "multipart init failed", text, "workspace not found — check you're in the right directory"));
    }
    const body = (await res.json()) as { uploadId: string; partSize: number };
    uploadId = body.uploadId;
    partSize = body.partSize;
    if (tokenPath) {
      await fsp.mkdir(path.dirname(tokenPath), { recursive: true });
      await fsp.writeFile(tokenPath, JSON.stringify({ sha256, uploadId, partSize }));
    }
  }

  const totalParts = Math.ceil(size / partSize);
  for (let n = 1; n <= totalParts; n++) {
    if (completed.has(n)) continue; // resume: skip already-uploaded parts
    const start = (n - 1) * partSize;
    const end = Math.min(start + partSize, size); // exclusive
    const len = end - start;
    // Content-addressed part → idempotent (server does INSERT OR REPLACE upload_parts). The body
    // is a single-use file stream, so retry lives here and re-creates it per attempt.
    const res = await retryTransient(
      () =>
        fetchWithDeadline(`${ctx.baseUrl}/v1/blobs/${sha256}/multipart/${uploadId}/part/${n}`, {
          method: "PUT",
          headers: { ...ctx.auth, "content-length": String(len) },
          body: fileStream(absPath, start, end - 1), // createReadStream end is inclusive
          duplex: "half",
        } as RequestInit, transferTimeoutMs(len)),
      { op: "uploading data" }
    );
    if (!res.ok) {
      const { mismatch, text } = await readShaMismatch(res);
      if (mismatch) throw new BlobShaMismatchError(sha256); // source changed mid-upload → push re-scans + retries
      throw new Error(translateRemoteError(res.status, `multipart part ${n} failed`, text, "workspace not found — check you're in the right directory"));
    }
  }

  // COMPLETE IS NOT AUTO-RETRIED (retries: 0) — the deliberate idempotency-safety call. The
  // server's complete handler ALWAYS deletes the upload row in its `finally`, so a blind retry
  // after a socket-close-post-success returns 404 unknown_upload, not a benign re-complete; and a
  // concurrent second complete against a still-running first can error R2's MPU assembly. We give
  // it only a timeout deadline and let the EXISTING recovery absorb a lost response: the
  // `missingBlobs` present-check just below (blob published despite the drop → success), and
  // failing that, putBlobMultipart's outer catch re-checks + re-inits from a fresh upload. Cheap,
  // because the parts (the bulk of the bytes) are already staged and resume skips them.
  const done = await ctx.fetch(`${ctx.baseUrl}/v1/blobs/${sha256}/multipart/${uploadId}/complete`, {
    method: "POST",
    headers: ctx.auth,
  }, { op: "finalizing upload", retries: 0 });
  if (!done.ok) {
    // A concurrent uploader of the same content-addressed sha may have clobbered
    // our server upload row (uploads PK = sha) and finished first. If the blob is
    // now present, the content is correct regardless of who completed it.
    if ((await ctx.missingBlobs([sha256])).length === 0) {
      if (tokenPath) await fsp.rm(tokenPath, { force: true });
      return;
    }
    const { quota, text } = await readQuotaExceeded(done);
    if (quota) throw quota;
    if (isShaMismatch(done.status, text)) throw new BlobShaMismatchError(sha256); // assembled object failed R2's sha256 guard → re-scan + retry
    throw new Error(translateRemoteError(done.status, "multipart complete failed", text, "workspace not found — check you're in the right directory"));
  }
  if (tokenPath) await fsp.rm(tokenPath, { force: true });
}
