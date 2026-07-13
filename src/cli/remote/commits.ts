import type { Manifest } from "../../engine/index.js";
import type { SignedCommit } from "../../engine/e2ee/index.js";
import type { CommitChainResult } from "../e2ee-remote.js";
import type { GlobalManifestMeta } from "../config.js";
import type { RemoteContext } from "./context.js";
import { firstPublishMeasurementLive, firstPublishMeasurementToken, firstPublishTiming, uploadActiveOverlapMs } from "../upload-lane-timing.js";
import { NeedsRebaselineError, readQuotaExceeded, translateRemoteError } from "./errors.js";
import { readNumericFields } from "./timings.js";

export const RECEIPT_REDEEM_BATCH_MAX = 5_000;
export const RECEIPT_REDEEM_REQUEST_BYTES_MAX = 7 * 1024 * 1024;
const RECEIPT_REDEEM_BODY_PREFIX_BYTES = Buffer.byteLength('{"receipts":{');
const RECEIPT_REDEEM_BODY_SUFFIX_BYTES = Buffer.byteLength("}}");

export function initialReceiptSendCap(): number {
  const raw = process.env.RBOX_RECEIPT_SEND_CAP?.trim();
  if (!raw || !/^\d+$/.test(raw)) return RECEIPT_REDEEM_BATCH_MAX;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return RECEIPT_REDEEM_BATCH_MAX;
  return Math.min(15_000, parsed);
}

function sliceReceiptBatch(
  receipts: ReadonlyMap<string, string>,
  sendCap: number,
): { batch: Array<[string, string]>; maxEntryBytes: number } {
  const batch: Array<[string, string]> = [];
  let requestBytes = RECEIPT_REDEEM_BODY_PREFIX_BYTES + RECEIPT_REDEEM_BODY_SUFFIX_BYTES;
  let maxEntryBytes = 0;
  for (const [sha, receipt] of receipts) {
    const entryBytes = Buffer.byteLength(JSON.stringify(sha)) + 1 + Buffer.byteLength(JSON.stringify(receipt));
    const nextBytes = requestBytes + entryBytes + (batch.length > 0 ? 1 : 0);
    if (batch.length > 0 && nextBytes > RECEIPT_REDEEM_REQUEST_BYTES_MAX) break;
    batch.push([sha, receipt]);
    requestBytes = nextBytes;
    maxEntryBytes = Math.max(maxEntryBytes, entryBytes);
    if (batch.length >= sendCap) break;
  }
  return { batch, maxEntryBytes };
}

export type CommitRejectReason = "too_many_refs" | "body_too_large";

export class CommitRejectedError extends Error {
  constructor(
    public readonly reason: CommitRejectReason,
    public readonly count?: number,
    public readonly max?: number,
    public fingerprint?: string,
    public readonly stillBlocked = false
  ) {
    super(commitRejectedMessage(reason, count, max));
    this.name = "CommitRejectedError";
  }
}

export interface CommitOptions {
  blockedFingerprint?: string;
  onCommitTimings?: (timings: CommitTimings) => void;
  /** Applied manifest + its verified wire identity; only sync.ts may select this base. */
  deltaBase?: { manifest: Manifest; meta: GlobalManifestMeta };
  /** Design 84 repair: encode a chain-free snapshot regardless of rollout flags. */
  forceSnapshot?: boolean;
}

export interface CommitTimings {
  refreshMs: number;
  sidecarMs: number;
  encodeMs: number;
  encryptMs: number;
  uploadMs: number;
  postMs: number;
  encBytes: number;
  serverTimings?: ServerTimings;
}

export interface ServerTimings {
  totalMs: number;
  envelopeMs: number;
  accountingMs: number;
  sidecarMs: number;
  commitMs: number;
  mirrorMs: number;
  responseMs: number;
}

const SERVER_TIMING_KEYS = ["totalMs", "envelopeMs", "accountingMs", "sidecarMs", "commitMs", "mirrorMs", "responseMs"] as const;

function readServerTimings(value: unknown): ServerTimings | undefined {
  return readNumericFields(value, SERVER_TIMING_KEYS);
}

export interface LatestTimings {
  downloadMs: number;
  decryptMs: number;
  parseMs: number;
  encBytes: number;
  fold?: "evidence" | "coldwalk" | "snapshot" | "raw";
  /** Number of foldDelta calls executed while decoding this manifest. */
  foldLinks?: number;
}

export interface LatestOptions {
  onLatestTimings?: (timings: LatestTimings) => void;
  /** Applied manifest plus persisted, verified wire evidence for the Phase-D head fold shortcut. */
  fastFoldBase?: { manifest: Manifest; meta: GlobalManifestMeta };
  /** Collect verified fold evidence even when no prior fast-fold base exists. */
  recordEvidence?: boolean;
}

export interface ReceiptRedeemResult {
  granted: number;
  alreadyEntitled: number;
  rejected: number;
  /** A fence aborted this whole redeem batch. These addresses need fresh staging. */
  needsUpload?: string[];
  /** Addresses whose current receipts were cleanly redeemed and removed. */
  settled?: string[];
}

function commitRejectedMessage(reason: CommitRejectReason, count?: number, max?: number): string {
  if (reason === "too_many_refs" && count !== undefined && max !== undefined) {
    return `workspace needs ${count.toLocaleString("en-US")} blob refs per commit; the server cap is ${max.toLocaleString("en-US")}. Exclude large directories with \`rbox ignore\` or split the workspace.`;
  }
  return "commit request is too large for the server. Exclude large directories with `rbox ignore` or split the workspace.";
}

export interface CommitResult {
  sequence?: number;
  /** Parent-sequence conflict (HTTP 409): client must pull+reconcile, then retry. */
  conflict?: boolean;
  head?: number;
  /** Manifest referenced blobs the server doesn't have (HTTP 422): upload these, then retry.
   *  Distinct from a parent conflict — a different recovery (upload, not pull). */
  unsatisfiedBlobs?: string[];
  unsatisfiedTotal?: number;
  /** Signed chain on the bounced attempt, used to partition data misses from chain misses. */
  attemptedManifestChain?: string[];
  /** The signed commit used a stale account epoch; refresh E2EE write context and retry. */
  epochStale?: number;
  serverTimings?: ServerTimings;
  manifestMeta?: GlobalManifestMeta;
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
    const body = (await res.json()) as { missing?: string[]; missingTotal?: number };
    return { unsatisfiedBlobs: body.missing ?? [], unsatisfiedTotal: body.missingTotal };
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

export async function redeemReceipts(ctx: RemoteContext): Promise<ReceiptRedeemResult[]> {
  ctx.receiptSendCap ??= initialReceiptSendCap();
  const timingToken = firstPublishMeasurementToken();
  const timingT0 = timingToken ? performance.now() : 0;
  const results: ReceiptRedeemResult[] = [];
  try { while (ctx.receipts.size > 0) {
    const { batch, maxEntryBytes } = sliceReceiptBatch(ctx.receipts, ctx.receiptSendCap);
    const requestBody = JSON.stringify({ receipts: Object.fromEntries(batch) });
    const countSubmitted = () => {
      if (firstPublishMeasurementLive(timingToken)) {
        firstPublishTiming.stats.redeemReceiptCount += batch.length;
      }
    };
    // SAFE TO RETRY — receipt redemption is idempotent: duplicate calls find refs already
    // entitled and grant 0, while a socket-close-before-response can be replayed safely.
    // A too_many_receipts bounce performed no server work, so re-slicing the untouched,
    // generation-safe receipt map is also safe.
    if (firstPublishMeasurementLive(timingToken)) {
      firstPublishTiming.stats.redeemRequestCount++;
      firstPublishTiming.stats.redeemMaxEntryBytes = Math.max(firstPublishTiming.stats.redeemMaxEntryBytes, maxEntryBytes);
      firstPublishTiming.stats.redeemMaxRequestBytes = Math.max(
        firstPublishTiming.stats.redeemMaxRequestBytes,
        Buffer.byteLength(requestBody),
      );
    }
    const r = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/receipts/redeem`, {
      method: "POST",
      headers: { ...ctx.protoAuth, "content-type": "application/json" },
      body: requestBody,
    }, { op: "redeeming upload receipts" });
    if (r.status === 400) {
      const text = await r.text();
      let body: { error?: unknown; max?: unknown } = {};
      try { body = JSON.parse(text) as typeof body; } catch { /* generic handling below */ }
      if (body.error === "too_many_receipts") {
        const max = body.max;
        if (typeof max !== "number" || !Number.isInteger(max) || max <= 0 || max >= batch.length) {
          throw new Error("receipt redeem failed: server returned an invalid non-shrinking too_many_receipts cap");
        }
        ctx.receiptSendCapShrinkCount++;
        if (ctx.receiptSendCapShrinkCount > 8) {
          throw new Error("receipt redeem failed: server changed its receipt cap more than 8 times in one session");
        }
        ctx.receiptSendCap = max as number;
        continue;
      }
      countSubmitted();
      const { quota } = await readQuotaExceeded(new Response(text, { status: r.status, headers: r.headers }));
      if (quota) throw quota;
      throw new Error(translateRemoteError(r.status, "receipt redeem failed", text, "workspace not found — check you're in the right directory"));
    }
    countSubmitted();
    if (r.status === 422) {
      const body = (await r.json()) as { missing?: string[] };
      // The server identifies the caught accounting super-batch as the safe failure
      // unit. Discard exactly those receipts: retaining them would make the next commit
      // try the same fenced authority again, while unaffected siblings can still redeem.
      const needsUpload = body.missing?.length ? body.missing : batch.map(([sha]) => sha);
      results.push({ granted: 0, alreadyEntitled: 0, rejected: 0, needsUpload });
      const failed = new Set(needsUpload);
      let deleted = false;
      for (const [sha, receipt] of batch) {
        if (failed.has(sha) && ctx.receipts.get(sha) === receipt) {
          ctx.receipts.delete(sha);
          deleted = true;
        }
      }
      if (!deleted) throw new Error("receipt redeem failed: malformed 422 missing detail did not match the submitted batch");
      continue;
    }
    if (!r.ok) {
      const { quota, text } = await readQuotaExceeded(r);
      if (quota) throw quota;
      throw new Error(translateRemoteError(r.status, "receipt redeem failed", text, "workspace not found — check you're in the right directory"));
    }
    const body = (await r.json()) as ReceiptRedeemResult;
    const settled: string[] = [];
    for (const [sha, receipt] of batch) {
      if (ctx.receipts.get(sha) === receipt) {
        ctx.receipts.delete(sha);
        settled.push(sha);
      }
    }
    results.push({ ...body, settled });
  } return results;
  } finally {
    // Settle only into the measurement that was armed when the drain STARTED — a drain
    // spanning a disarm/re-arm must not credit a later push (or a zero start timestamp).
    if (firstPublishMeasurementLive(timingToken)) {
      const end = performance.now();
      firstPublishTiming.stats.receiptRedemptionWallMs += Math.max(0, Math.round(end - timingT0));
      firstPublishTiming.stats.receiptRedemptionOverlapMs += Math.max(0, Math.round(uploadActiveOverlapMs(timingT0, end)));
    }
  }
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
  // Design 110 Phase 0: account only the commit-enclosed drain inside `p`.
  const drainToken = firstPublishMeasurementToken();
  const drainT0 = drainToken ? performance.now() : 0;
  let redeemed: ReceiptRedeemResult[];
  try {
    redeemed = await redeemReceipts(ctx);
  } finally {
    if (firstPublishMeasurementLive(drainToken)) firstPublishTiming.stats.finalDrainMs += Math.max(0, Math.round(performance.now() - drainT0));
  }
  const redeemNeedsUpload = [...new Set(redeemed.flatMap((r) => r.needsUpload ?? []))];
  if (redeemNeedsUpload.length > 0) {
    return { unsatisfiedBlobs: redeemNeedsUpload, unsatisfiedTotal: redeemNeedsUpload.length };
  }
  const r = await ctx.fetch(`${ctx.baseUrl}/v1/ws/${ctx.workspaceId}/proj/${ctx.projectId}/manifests`, {
    method: "POST",
    headers: { ...ctx.protoAuth, "content-type": "application/json" },
    body: JSON.stringify({ parentSequence: parentSeq, commit, receipts: {} }),
  }, { op: "publishing your changes" });
  if (r.status === 409) {
    const b = (await r.json()) as { error?: string; head?: number; currentEpoch?: number; serverTimings?: unknown };
    const serverTimings = readServerTimings(b.serverTimings);
    if (b.error === "epoch_stale") return { epochStale: b.currentEpoch ?? 0, ...(serverTimings ? { serverTimings } : {}) };
    return { conflict: true, head: b.head, ...(serverTimings ? { serverTimings } : {}) };
  }
  if (r.status === 422) {
    const b = (await r.json()) as { missing?: string[]; missingTotal?: number };
    return { unsatisfiedBlobs: b.missing ?? [], unsatisfiedTotal: b.missingTotal };
  }
  if (r.status === 413) {
    const b = (await r.clone().json().catch(() => ({}))) as { error?: string; count?: number; max?: number };
    if (b.error === "too_many_refs") throw new CommitRejectedError("too_many_refs", b.count, b.max);
    if (b.error === "body_too_large") throw new CommitRejectedError("body_too_large", b.count, b.max);
  }
  if (!r.ok) {
    const text = await r.text();
    try {
      const body = JSON.parse(text) as { error?: unknown; count?: unknown; max?: unknown };
      if (body.error === "body_too_large") {
        throw new CommitRejectedError(
          "body_too_large",
          typeof body.count === "number" ? body.count : undefined,
          typeof body.max === "number" ? body.max : undefined,
        );
      }
    } catch (e) {
      if (e instanceof CommitRejectedError) throw e;
    }
    const consumed = new Response(text, { status: r.status, headers: r.headers });
    const { quota } = await readQuotaExceeded(consumed);
    if (quota) throw quota;
    throw new Error(translateRemoteError(r.status, "commit failed", text, "workspace not found — check you're in the right directory"));
  }
  const body = (await r.json()) as { sequence: number; serverTimings?: unknown };
  const seq = body.sequence;
  const serverTimings = readServerTimings(body.serverTimings);
  ctx.receipts.clear(); // published → receipts consumed
  return { sequence: seq, ...(serverTimings ? { serverTimings } : {}) };
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
