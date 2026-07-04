import { quotaUsage } from "../quota-format.js";

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

/** The one-shot account genesis claim lost a race to another device. The caller
 *  must discard locally pre-persisted genesis material before degrading to
 *  pair/recover. */
export class AccountAlreadyBootstrappedError extends Error {
  constructor() {
    super("account already bootstrapped");
    this.name = "AccountAlreadyBootstrappedError";
  }
}

export type QuotaKind = "storage" | "workspaces";

function quotaMessage(kind: QuotaKind, used?: number, cap?: number): string {
  if (kind === "workspaces") {
    const detail = cap !== undefined ? `plan allows ${cap.toLocaleString("en-US")}` : "plan limit reached";
    return `Workspace limit reached — ${detail}. Upgrade with \`rbox subscribe solo\` for unlimited workspaces.`;
  }
  const usage = quotaUsage(kind, used, cap);
  const detail = usage ? `${usage} used` : "storage cap reached";
  return `Out of storage — ${detail}. Upgrade with \`rbox subscribe solo\` (50 GiB), or free up space and run \`rbox sync\`.`;
}

export class QuotaExceededError extends Error {
  constructor(
    public readonly kind: QuotaKind,
    public readonly used?: number,
    public readonly cap?: number
  ) {
    super(quotaMessage(kind, used, cap));
    this.name = "QuotaExceededError";
  }
}

const finite = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function jsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const body = JSON.parse(text) as unknown;
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** 402 with `{"error":"quota_exceeded"}` → typed quota error. Anything else falls
 *  through with the consumed body text preserved for the caller's generic path. */
export async function readQuotaExceeded(res: Response): Promise<{ quota: QuotaExceededError | null; text: string }> {
  const text = await res.text();
  if (res.status !== 402) return { quota: null, text };
  const body = jsonObject(text);
  if (body?.error !== "quota_exceeded") return { quota: null, text };
  const kind: QuotaKind = body.limit === "workspaces" ? "workspaces" : "storage";
  return { quota: new QuotaExceededError(kind, finite(body.used), finite(body.cap)), text };
}

/** Distinguish R2's convergent-encryption hash guard (`{"error":"sha_mismatch"}`) from any
 *  other 4xx. The server signals this SAME semantic error with two statuses (apps/api/src/blobs.ts):
 *  400 on the single-PUT / direct-write path, 412 on the multipart-complete publish. Accept both,
 *  but still require the JSON discriminator so unrelated 4xx bodies fall through to the generic
 *  error path. Consumes the response body exactly once and returns it for that generic path so
 *  callers keep their existing `status body` diagnostics. */
export async function readShaMismatch(res: Response): Promise<{ mismatch: boolean; text: string }> {
  const text = await res.text();
  return { mismatch: isShaMismatch(res.status, text), text };
}

export function isShaMismatch(status: number, text: string): boolean {
  if (status !== 400 && status !== 412) return false;
  return jsonObject(text)?.error === "sha_mismatch";
}
