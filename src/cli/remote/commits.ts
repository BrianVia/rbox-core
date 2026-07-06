import type { Manifest } from "../../engine/index.js";
import type { SignedCommit } from "../../engine/e2ee/index.js";
import type { CommitChainResult } from "../e2ee-remote.js";
import type { RemoteContext } from "./context.js";
import { NeedsRebaselineError, readQuotaExceeded, translateRemoteError } from "./errors.js";

export interface CommitResult {
  sequence?: number;
  /** Parent-sequence conflict (HTTP 409): client must pull+reconcile, then retry. */
  conflict?: boolean;
  head?: number;
  /** Manifest referenced blobs the server doesn't have (HTTP 422): upload these, then retry.
   *  Distinct from a parent conflict — a different recovery (upload, not pull). */
  unsatisfiedBlobs?: string[];
}

export async function commit(ctx: RemoteContext, parentSequence: number, deviceId: string, manifest: Manifest): Promise<CommitResult> {
  // SAFE TO RETRY (the judgment call): the server sequences commits with a strict
  // `parentSequence === head` compare-and-swap (apps/api/src/workspace-sync.ts). If a socket
  // closes AFTER the server applied this commit, a retry re-POSTs the now-stale parent → the CAS
  // fails → HTTP 409 conflict (an already-applied duplicate can NEVER double-apply). That 409 is a
  // Response, so it returns below as `{ conflict }` and the push loop absorbs it (pull → reconcile
  // → no-op). Accounting is idempotent too (charges 0 for already-entitled refs; INSERT OR IGNORE
  // on the D1 mirror). A blind retry is therefore benign, not a double-submit.
  const res = await ctx.fetch(
    `${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/manifests`,
    {
      method: "POST",
      headers: { ...ctx.auth, "content-type": "application/json" },
      body: JSON.stringify({ parentSequence, deviceId, manifest }),
    },
    { op: "publishing your changes" }
  );
  if (res.status === 409) {
    const body = (await res.json()) as { head: number };
    return { conflict: true, head: body.head };
  }
  if (res.status === 422) {
    const body = (await res.json()) as { missing?: string[] };
    return { unsatisfiedBlobs: body.missing ?? [] };
  }
  if (!res.ok) {
    const { quota, text } = await readQuotaExceeded(res);
    if (quota) throw quota;
    throw new Error(translateRemoteError(res.status, "commit failed", text, "workspace not found — check you're in the right directory"));
  }
  return { sequence: ((await res.json()) as { sequence: number }).sequence };
}

export async function latestCommit(ctx: RemoteContext): Promise<{ sequence: number; commit: SignedCommit | null }> {
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/latest`, { headers: ctx.auth }, { op: "checking for remote changes" });
  if (!r.ok) throw new Error(translateRemoteError(r.status, "latest failed", undefined, "workspace not found — check you're in the right directory"));
  const body = (await r.json()) as { sequence: number; commit: SignedCommit | null; grant?: unknown };
  ctx.captureGrant(body); // §27 — the pull handshake hands back a download grant
  return { sequence: body.sequence, commit: body.commit };
}

export async function commitsSince(ctx: RemoteContext, since: number): Promise<Array<SignedCommit>> {
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/commits?since=${since}`, { headers: ctx.auth }, { op: "fetching remote changes" });
  if (r.status === 409) throw new NeedsRebaselineError(((await r.json().catch(() => ({}))) as { head?: number }).head);
  if (!r.ok) throw new Error(translateRemoteError(r.status, "commits?since failed", undefined, "workspace not found — check you're in the right directory"));
  return ((await r.json()) as { commits: Array<SignedCommit> }).commits;
}

/** Post a signed commit envelope. Maps the server's 409 variants: a parent
 *  conflict (pull+retry) vs `epoch_stale` (a rotation landed under us). */
export async function commitSigned(ctx: RemoteContext, parentSeq: number, commit: SignedCommit): Promise<CommitChainResult> {
  // §23.4: hand the accumulated upload receipts to commit (it does the batched
  // catalog+charge+grant+promote). Sending all still-valid receipts each attempt is
  // safe — the server charges 0 for already-entitled refs.
  // SAFE TO RETRY — same `parentSequence === head` CAS as commit() above; a duplicate after a
  // socket close 409s benignly (see the note there). Sending all still-valid receipts each attempt
  // is already idempotent (the server charges 0 for already-entitled refs).
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/manifests`, {
    method: "POST",
    headers: { ...ctx.protoAuth, "content-type": "application/json" },
    body: JSON.stringify({ parentSequence: parentSeq, commit, receipts: Object.fromEntries(ctx.receipts) }),
  }, { op: "publishing your changes" });
  if (r.status === 409) {
    const b = (await r.json()) as { error?: string; head?: number; currentEpoch?: number };
    if (b.error === "epoch_stale") return { epochStale: b.currentEpoch ?? 0 };
    return { conflict: true, head: b.head };
  }
  if (r.status === 422) return { unsatisfiedBlobs: ((await r.json()) as { missing?: string[] }).missing ?? [] };
  if (!r.ok) {
    const { quota, text } = await readQuotaExceeded(r);
    if (quota) throw quota;
    throw new Error(translateRemoteError(r.status, "commit failed", text, "workspace not found — check you're in the right directory"));
  }
  const seq = ((await r.json()) as { sequence: number }).sequence;
  ctx.receipts.clear(); // published → receipts consumed
  return { sequence: seq };
}

export async function latest(ctx: RemoteContext): Promise<{ sequence: number; manifest: Manifest }> {
  const res = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/latest`, {
    headers: ctx.auth,
  }, { op: "checking for remote changes" });
  if (!res.ok) throw new Error(translateRemoteError(res.status, "latest failed", await res.text(), "workspace not found — check you're in the right directory"));
  const body = (await res.json()) as { sequence: number; manifest: Manifest; grant?: unknown };
  ctx.captureGrant(body); // §27 — capture the download grant on the legacy manifest path too
  return { sequence: body.sequence, manifest: body.manifest };
}

/** Best-effort D1 commit mirror — ADVISORY display timestamps for `rbox versions`
 *  only (the server-observed `created_at`; commit cadence is a documented residual).
 *  Authenticity comes from the signed commit chain (`commitsSince`), NEVER this.
 *  Returns seq → epoch-ms; a missing/lagging row just means no time for that seq. */
export async function commitTimes(ctx: RemoteContext, limit = 50): Promise<Map<number, number>> {
  const res = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/versions?limit=${limit}`, { headers: ctx.auth }, { op: "fetching version history" });
  if (!res.ok) throw new Error(translateRemoteError(res.status, "versions failed", undefined, "workspace not found — check you're in the right directory"));
  const rows = ((await res.json()) as { versions: Array<{ sequence: number; created_at: number }> }).versions;
  return new Map(rows.map((r) => [r.sequence, r.created_at]));
}
