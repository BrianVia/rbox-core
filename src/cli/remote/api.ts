import type { BlobStore, Manifest } from "../../engine/index.js";
import type { SignedCommit } from "../../engine/e2ee/index.js";
import type { AccountKeysDTO, CommitChainResult } from "../e2ee-remote.js";
import { RemoteContext } from "./context.js";
import { getBlob, getBlobToFile, putBlob, putBlobFile } from "./blobs.js";
import { commit, commitSigned, commitsSince, commitTimes, latest, latestCommit, type CommitResult } from "./commits.js";
import { readQuotaExceeded } from "./errors.js";
import {
  admitDevice,
  appendRoster,
  bootstrapKeys,
  getAccountKeys,
  getWorkspaceKeys,
  pairCreate,
  putDeviceKeys,
  putWorkspaceKey,
} from "./keys.js";

/**
 * The narrow remote surface `sync.ts` depends on — the seam that lets the
 * conflict-retry control flow be unit-tested against an in-memory `FakeRemote`
 * (design 09 §1). `RboxApi` implements it for production; tests inject a stateful
 * simulator. Keep it minimal: only what pull/push actually call.
 */
export interface SyncRemote {
  latest(): Promise<{ sequence: number; manifest: Manifest }>;
  missingBlobs(shas: string[]): Promise<string[]>;
  putBlobFile(sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void>;
  commit(parentSequence: number, deviceId: string, manifest: Manifest): Promise<CommitResult>;
  /** BlobStore view for applyActions / git capture+apply on the pull path. */
  blobStore(): BlobStore;
}

/** Thin client for the rbox control plane. */
export class RboxApi implements SyncRemote {
  private readonly ctx: RemoteContext;

  constructor(baseUrl: string, token: string, workspaceId: string, projectId: string) {
    this.ctx = new RemoteContext(baseUrl, token, workspaceId, projectId);
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

  putBlobFile(sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void> {
    return putBlobFile(this.ctx, sha256, absPath, size, uploadsDir);
  }

  getBlobToFile(sha256: string, destPath: string): Promise<void> {
    return getBlobToFile(this.ctx, sha256, destPath);
  }

  commit(parentSequence: number, deviceId: string, manifest: Manifest): Promise<CommitResult> {
    return commit(this.ctx, parentSequence, deviceId, manifest);
  }

  /** Upload opaque bytes by content address (the encrypted-manifest blob). */
  putBlobBytes(sha256: string, bytes: Uint8Array): Promise<void> {
    return putBlob(this.ctx, sha256, bytes);
  }

  bootstrapKeys(body: unknown): Promise<void> {
    return bootstrapKeys(this.ctx, body);
  }

  getAccountKeys(): Promise<AccountKeysDTO | null> {
    return getAccountKeys(this.ctx);
  }

  putDeviceKeys(body: unknown): Promise<void> {
    return putDeviceKeys(this.ctx, body);
  }

  /** Atomic device-keys + roster admission (C5). 409 → caller refetches + retries. */
  admitDevice(body: unknown): Promise<{ ok: boolean; conflict?: boolean }> {
    return admitDevice(this.ctx, body);
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

  commitSigned(parentSeq: number, commit: SignedCommit): Promise<CommitChainResult> {
    return commitSigned(this.ctx, parentSeq, commit);
  }

  pairCreate(body: { tokenId: string; mkWrap: string; admissionGrant: string }): Promise<{ token: string }> {
    return pairCreate(this.ctx, body);
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

  latest(): Promise<{ sequence: number; manifest: Manifest }> {
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
  const res = await fetch(`${baseUrl}/v1/workspaces?project=${encodeURIComponent(project)}${nameQs}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const { quota, text } = await readQuotaExceeded(res);
    if (quota) throw quota;
    throw new Error(`workspace create failed: ${res.status} ${text}`);
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
  async getToFile(sha256: string, destPath: string): Promise<void> {
    await this.api.getBlobToFile(sha256, destPath);
  }
  /** Streaming upload from a file by content address (e.g. a git bundle). */
  async putFile(sha256: string, srcPath: string, size: number): Promise<void> {
    await this.api.putBlobFile(sha256, srcPath, size);
  }
}
