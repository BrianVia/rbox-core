import type { BlobStore, Manifest } from "../../engine/index.js";
import type { ByteProgressCallback } from "../../engine/blobstore.js";
import type { SignedCommit } from "../../engine/e2ee/index.js";
import type { AccountKeysDTO, CommitChainResult } from "../e2ee-remote.js";
import type { GlobalManifestMeta } from "../config.js";
import { RemoteContext } from "./context.js";
import { getBlob, getBlobToFile, putBlob } from "./blobs.js";
import { BlobBatchDownloader, BlobBatchUploader } from "./blob-batch.js";
import { commit, commitSigned, commitsSince, commitTimes, latest, latestCommit, type CommitOptions, type CommitResult, type LatestOptions } from "./commits.js";
import { redeemReceipts } from "./commits.js";
import type { ReceiptPort } from "../publish-pipeline/receipt-drainer.js";
import { WORKSPACE_MINT_RERUN_HINT, readQuotaExceeded, translateRemoteError } from "./errors.js";
import { fetchResilient } from "./resilient.js";
import {
  admitDevice,
  appendRoster,
  bootstrapKeys,
  createApiKey,
  getAccountKeys,
  getGenesisObservation,
  getWorkspaceKeys,
  listApiKeys,
  pairCreate,
  putDeviceKeys,
  putWorkspaceKey,
  revokeApiKey,
  type ApiKeyRow,
  type CreateApiKeyBody,
} from "./keys.js";

/**
 * The narrow remote surface `sync.ts` depends on — the seam that lets the
 * conflict-retry control flow be unit-tested against an in-memory `FakeRemote`
 * (design 09 §1). `RboxApi` implements it for production; tests inject a stateful
 * simulator. Keep it minimal: only what pull/push actually call.
 */
export interface SyncRemote {
  latest(options?: LatestOptions): Promise<{ sequence: number; manifest: Manifest; manifestMeta?: GlobalManifestMeta }>;
  missingBlobs(shas: string[]): Promise<string[]>;
  putBlobFile(
    sha256: string,
    absPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void>;
  ownsUploadLaneTiming?(size: number): boolean;
  closeUploader?(err: Error): Promise<void>;
  receiptPort?(): ReceiptPort | undefined;
  commit(parentSequence: number, deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult>;
  /** BlobStore view for applyActions / git capture+apply on the pull path. */
  blobStore(): BlobStore;
}

/** Thin client for the rbox control plane. */
export class RboxApi implements SyncRemote {
  private readonly ctx: RemoteContext;
  private readonly batchDownloader: BlobBatchDownloader;
  private readonly batchUploader: BlobBatchUploader;

  constructor(baseUrl: string, token: string, workspaceId: string, projectId: string, warningSink?: (line: string) => void) {
    this.ctx = warningSink
      ? new RemoteContext(baseUrl, token, workspaceId, projectId, warningSink, warningSink)
      : new RemoteContext(baseUrl, token, workspaceId, projectId);
    this.batchDownloader = new BlobBatchDownloader(this.ctx);
    this.batchUploader = new BlobBatchUploader(this.ctx);
  }

  missingBlobs(shas: string[]): Promise<string[]> {
    return this.ctx.missingBlobs(shas);
  }

  putBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    return putBlob(this.ctx, sha256, bytes);
  }

  getBlob(sha256: string): Promise<Buffer> {
    return getBlob(this.ctx, sha256);
  }

  putBlobFile(
    sha256: string,
    absPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void> {
    return this.batchUploader.putFile(sha256, absPath, size, uploadsDir, onBytes);
  }

  ownsUploadLaneTiming(size: number): boolean {
    return this.batchUploader.ownsLaneTiming(size);
  }

  closeUploader(err: Error): Promise<void> {
    return this.batchUploader.close(err);
  }

  receiptPort(): ReceiptPort {
    return {
      receiptCount: () => this.ctx.receipts.size,
      redeem: () => redeemReceipts(this.ctx),
    };
  }

  getBlobToFile(sha256: string, destPath: string, expectedSize?: number): Promise<void> {
    return this.batchDownloader.getToFile(sha256, expectedSize, destPath);
  }

  async commit(parentSequence: number, deviceId: string, manifest: Manifest, options?: CommitOptions): Promise<CommitResult> {
    await options?.beforeCommitSend?.();
    return commit(this.ctx, parentSequence, deviceId, manifest);
  }

  /** Upload opaque bytes by content address (the encrypted-manifest blob). */
  putBlobBytes(sha256: string, bytes: Uint8Array, onBytes?: ByteProgressCallback): Promise<void> {
    return putBlob(this.ctx, sha256, bytes, onBytes);
  }

  bootstrapKeys(body: unknown): Promise<void> {
    return bootstrapKeys(this.ctx, body);
  }

  getAccountKeys(signal?: AbortSignal): Promise<AccountKeysDTO | null> {
    return getAccountKeys(this.ctx, signal);
  }

  getGenesisObservation() {
    return getGenesisObservation(this.ctx);
  }

  putDeviceKeys(body: unknown): Promise<void> {
    return putDeviceKeys(this.ctx, body);
  }

  /** Atomic device-keys + roster admission (C5). 409 → caller refetches + retries. */
  admitDevice(body: unknown, signal?: AbortSignal): Promise<{ ok: boolean; conflict?: boolean }> {
    return admitDevice(this.ctx, body, signal);
  }

  appendRoster(body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
    return appendRoster(this.ctx, body);
  }

  getWorkspaceKeys(workspaceId: string): Promise<Array<{ keyEpoch: number; kekWrap: string }>> {
    return getWorkspaceKeys(this.ctx, workspaceId);
  }

  putWorkspaceKey(workspaceId: string, keyEpoch: number, kekWrap: string): Promise<{ keyEpoch: number; kekWrap: string }> {
    return putWorkspaceKey(this.ctx, workspaceId, keyEpoch, kekWrap);
  }

  latestCommit(): Promise<{ sequence: number; commit: SignedCommit | null }> {
    return latestCommit(this.ctx);
  }

  commitsSince(since: number): Promise<Array<SignedCommit>> {
    return commitsSince(this.ctx, since);
  }

  commitSigned(parentSeq: number, commit: SignedCommit, beforeManifestPost?: () => Promise<void>): Promise<CommitChainResult> {
    return commitSigned(this.ctx, parentSeq, commit, beforeManifestPost);
  }

  pairCreate(body: { tokenId: string; mkWrap: string; admissionGrant: string }): Promise<{ token: string }> {
    return pairCreate(this.ctx, body);
  }

  createApiKey(body: CreateApiKeyBody): Promise<{ deviceId: string; expiresAt: number }> {
    return createApiKey(this.ctx, body);
  }

  listApiKeys(): Promise<ApiKeyRow[]> {
    return listApiKeys(this.ctx);
  }

  revokeApiKey(deviceId: string): Promise<void> {
    return revokeApiKey(this.ctx, deviceId);
  }

  /** wss:// URL for the live notification channel. The daemon opens this with an
   *  `Authorization: Bearer` header (Bun WS supports custom headers); the DO reads
   *  the same bearer as HTTP. Notification-only — correctness never depends on it. */
  wsConnectUrl(): string {
    const ws = this.ctx.baseUrl.replace(/^http/, "ws");
    return `${ws}/v1/ws/${this.ctx.workspaceId}/proj/${this.ctx.projectId}/connect`;
  }

  get bearerToken(): string {
    return this.ctx.token;
  }

  /** JSON POST on the daemon's ONE RemoteContext (telemetry ingest, design 120) —
   *  structurally satisfies TelemetryTransport without a second context. */
  postJson(path: string, body: unknown, opts: { signal?: AbortSignal; retries?: number } = {}): Promise<Response> {
    return this.ctx.postJson(path, body, opts);
  }

  latest(_options?: LatestOptions): Promise<{ sequence: number; manifest: Manifest }> {
    return latest(this.ctx);
  }

  commitTimes(limit = 50): Promise<Map<number, number>> {
    return commitTimes(this.ctx, limit);
  }

  /** SyncRemote: a BlobStore backed by this client (pull / git apply path). */
  blobStore(): BlobStore {
    return new RemoteBlobStore(this);
  }
}

/** Create a server-owned workspace (M7) — ownership is established here, not at
 *  first commit. Returns the high-entropy server-assigned workspace id.
 *  `name` is the OPT-IN, server-visible dashboard label (default-off); when set it is
 *  sent as plaintext (the deliberate, consensual metadata trade) and stored once. */
export async function createRemoteWorkspace(baseUrl: string, token: string, project: string, name?: string): Promise<string> {
  const nameQs = name ? `&name=${encodeURIComponent(name)}` : "";
  // NOT auto-retried (retries: 0): mints a fresh server-owned workspace id; a retry after a
  // socket-close-post-success would orphan a second workspace. Gets the timeout deadline only.
  const res = await fetchResilient(`${baseUrl}/v1/workspaces?project=${encodeURIComponent(project)}${nameQs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  }, { retries: 0, op: "creating the workspace", rerunHint: WORKSPACE_MINT_RERUN_HINT });
  if (!res.ok) {
    const { quota, text } = await readQuotaExceeded(res);
    if (quota) throw quota;
    throw new Error(translateRemoteError(res.status, "workspace create failed", text, "workspace not found — check you're in the right directory"));
  }
  return ((await res.json()) as { workspaceId: string }).workspaceId;
}

/** Adapts the control plane to the engine's BlobStore interface. */
export class RemoteBlobStore implements BlobStore {
  constructor(private readonly api: RboxApi) {}
  async has(sha256: string): Promise<boolean> {
    return (await this.api.missingBlobs([sha256])).length === 0;
  }
  async put(sha256: string, bytes: Uint8Array): Promise<void> {
    await this.api.putBlob(sha256, bytes);
  }
  async get(sha256: string): Promise<Buffer> {
    return this.api.getBlob(sha256);
  }
  /** Streaming download into a destination file (used by apply for large blobs). */
  async getToFile(sha256: string, destPath: string, expectedSize?: number): Promise<void> {
    await this.api.getBlobToFile(sha256, destPath, expectedSize);
  }
  /** Streaming upload from a file by content address (e.g. a git bundle). */
  async putFile(
    sha256: string,
    srcPath: string,
    size: number,
    uploadsDir?: string,
    onBytes?: ByteProgressCallback
  ): Promise<void> {
    await this.api.putBlobFile(sha256, srcPath, size, uploadsDir, onBytes);
  }
}
