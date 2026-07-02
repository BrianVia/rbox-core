/** The server can't serve a contiguous commit span (the `since` is below the
 *  retention prune floor, so old `seq:<n>` pointers were dropped, OR the span
 *  exceeds `MAX_COMMIT_SPAN`). A typed signal so `versions`/`restore` can fail
 *  closed with a "aged out of your retention window" message (design 12 §15)
 *  instead of leaking a raw HTTP error. */
export class NeedsRebaselineError extends Error {
  constructor(public readonly head?: number) {
    super("needs_rebaseline: the requested commit span is below the retention window or too large");
    this.name = "NeedsRebaselineError";
  }
}

/** A blob PUT was rejected because the streamed ciphertext no longer hashes to the
 *  declared `encSha` (server: `R2.put(key, body, { sha256 })` → HTTP 400
 *  `{"error":"sha_mismatch"}`). Under convergent encryption the `encSha` is fixed at
 *  encrypt time; if the source file is edited before the streamed upload lands (rbox
 *  syncs live, actively-edited dev workspaces), the fresh ciphertext no longer matches.
 *  A TYPED signal so `pushManifest` can self-heal — re-scan the settled tree + retry —
 *  instead of aborting the whole push on a raw `blob PUT failed: 400`. */
export class BlobShaMismatchError extends Error {
  constructor(public readonly encSha: string) {
    super(`blob PUT rejected: ciphertext no longer hashes to declared encSha ${encSha} (source changed under sync)`);
    this.name = "BlobShaMismatchError";
  }
}

/** Distinguish R2's convergent-encryption hash guard (`{"error":"sha_mismatch"}`) from any
 *  other 4xx. The server signals this SAME semantic error with two statuses (apps/api/src/blobs.ts):
 *  400 on the single-PUT / direct-write path, 412 on the multipart-complete publish. Accept both,
 *  but still require the JSON discriminator so unrelated 4xx bodies fall through to the generic
 *  error path. Consumes the response body exactly once and returns it for that generic path so
 *  callers keep their existing `status body` diagnostics. */
export async function readShaMismatch(res: Response): Promise<{ mismatch: boolean; text: string }> {
  const text = await res.text();
  if (res.status !== 400 && res.status !== 412) return { mismatch: false, text };
  try {
    return { mismatch: (JSON.parse(text) as { error?: string }).error === "sha_mismatch", text };
  } catch {
    return { mismatch: false, text };
  }
}
