import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { createHash } from "node:crypto";
import type { BlobStore, Manifest } from "../engine/index.js";

const MiB = 1024 * 1024;
const SINGLE_PUT_MAX = 90 * MiB; // must match the Worker's threshold

export interface CommitResult {
  sequence?: number;
  /** Parent-sequence conflict (HTTP 409): client must pull+reconcile, then retry. */
  conflict?: boolean;
  head?: number;
  /** Manifest referenced blobs the server doesn't have (HTTP 422): upload these, then retry.
   *  Distinct from a parent conflict — a different recovery (upload, not pull). */
  unsatisfiedBlobs?: string[];
}

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
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly workspaceId: string,
    private readonly projectId: string
  ) {}

  private get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }

  async missingBlobs(shas: string[]): Promise<string[]> {
    if (shas.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/v1/blobs/check`, {
      method: "POST",
      headers: { ...this.auth, "content-type": "application/json" },
      body: JSON.stringify({ shas }),
    });
    if (!res.ok) throw new Error(`blobs/check failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { missing: string[] }).missing;
  }

  async putBlob(sha256: string, bytes: Uint8Array): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/blobs/${sha256}`, {
      method: "PUT",
      headers: this.auth,
      body: bytes,
    });
    if (!res.ok) throw new Error(`blob PUT failed: ${res.status} ${await res.text()}`);
  }

  async getBlob(sha256: string): Promise<Buffer> {
    const res = await fetch(`${this.baseUrl}/v1/blobs/${sha256}`, { headers: this.auth });
    if (!res.ok) throw new Error(`blob GET failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Upload a file by content address, streaming (never buffering the whole file).
   * ≤ SINGLE_PUT_MAX → one streamed PUT (R2 verifies the hash server-side); larger
   * → resumable multipart. `uploadsDir` (`.rbox/state/uploads/`) enables resume.
   */
  async putBlobFile(sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void> {
    if (size <= SINGLE_PUT_MAX) {
      const res = await fetch(`${this.baseUrl}/v1/blobs/${sha256}`, {
        method: "PUT",
        headers: { ...this.auth, "content-length": String(size) },
        body: fileStream(absPath),
        duplex: "half",
      } as RequestInit);
      if (res.status !== 413) {
        if (!res.ok) throw new Error(`blob PUT failed: ${res.status} ${await res.text()}`);
        return;
      }
      // 413: server says too big for single PUT → fall through to multipart.
    }
    await this.putBlobMultipart(sha256, absPath, size, uploadsDir);
  }

  private async putBlobMultipart(sha256: string, absPath: string, size: number, uploadsDir?: string): Promise<void> {
    try {
      await this.multipartAttempt(sha256, absPath, size, uploadsDir, true);
    } catch (e) {
      // A resume against an expired/dead upload (or any mid-flight error) — clear
      // the token and retry once from a fresh init. If the second attempt fails,
      // surface it (the daemon's pump will retry later).
      if (uploadsDir) await fsp.rm(path.join(uploadsDir, `${sha256}.json`), { force: true }).catch(() => {});
      if ((await this.missingBlobs([sha256])).length === 0) return; // someone else finished it
      await this.multipartAttempt(sha256, absPath, size, uploadsDir, false);
    }
  }

  private async multipartAttempt(sha256: string, absPath: string, size: number, uploadsDir: string | undefined, allowResume: boolean): Promise<void> {
    const tokenPath = uploadsDir ? path.join(uploadsDir, `${sha256}.json`) : undefined;

    // Try to resume from a persisted token (server is the source of truth).
    let uploadId: string | undefined;
    let partSize = 0;
    let completed = new Set<number>();
    if (allowResume && tokenPath) {
      const tok = await readJson<{ uploadId: string }>(tokenPath);
      if (tok?.uploadId) {
        const st = await fetch(`${this.baseUrl}/v1/blobs/${sha256}/multipart/${tok.uploadId}`, { headers: this.auth });
        if (st.ok) {
          const body = (await st.json()) as { partSize: number; completedParts: number[] };
          uploadId = tok.uploadId;
          partSize = body.partSize;
          completed = new Set(body.completedParts);
        }
      }
    }

    if (!uploadId) {
      const res = await fetch(`${this.baseUrl}/v1/blobs/${sha256}/multipart`, {
        method: "POST",
        headers: { ...this.auth, "content-type": "application/json" },
        body: JSON.stringify({ size }),
      });
      if (!res.ok) throw new Error(`multipart init failed: ${res.status} ${await res.text()}`);
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
      const res = await fetch(`${this.baseUrl}/v1/blobs/${sha256}/multipart/${uploadId}/part/${n}`, {
        method: "PUT",
        headers: { ...this.auth, "content-length": String(len) },
        body: fileStream(absPath, start, end - 1), // createReadStream end is inclusive
        duplex: "half",
      } as RequestInit);
      if (!res.ok) throw new Error(`multipart part ${n} failed: ${res.status} ${await res.text()}`);
    }

    const done = await fetch(`${this.baseUrl}/v1/blobs/${sha256}/multipart/${uploadId}/complete`, {
      method: "POST",
      headers: this.auth,
    });
    if (!done.ok) {
      // A concurrent uploader of the same content-addressed sha may have clobbered
      // our server upload row (uploads PK = sha) and finished first. If the blob is
      // now present, the content is correct regardless of who completed it.
      if ((await this.missingBlobs([sha256])).length === 0) {
        if (tokenPath) await fsp.rm(tokenPath, { force: true });
        return;
      }
      throw new Error(`multipart complete failed: ${done.status} ${await done.text()}`);
    }
    if (tokenPath) await fsp.rm(tokenPath, { force: true });
  }

  /** Stream a blob to `destPath`, hashing as it lands; verify before returning.
   *  Any failure (network, write, or hash mismatch) removes the partial file. */
  async getBlobToFile(sha256: string, destPath: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/blobs/${sha256}`, { headers: this.auth });
    if (!res.ok || !res.body) throw new Error(`blob GET failed: ${res.status}`);
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

  async commit(parentSequence: number, deviceId: string, manifest: Manifest): Promise<CommitResult> {
    const res = await fetch(
      `${this.baseUrl}/v1/ws/${this.workspaceId}/proj/${this.projectId}/manifests`,
      {
        method: "POST",
        headers: { ...this.auth, "content-type": "application/json" },
        body: JSON.stringify({ parentSequence, deviceId, manifest }),
      }
    );
    if (res.status === 409) {
      const body = (await res.json()) as { head: number };
      return { conflict: true, head: body.head };
    }
    if (res.status === 422) {
      const body = (await res.json()) as { missing?: string[] };
      return { unsatisfiedBlobs: body.missing ?? [] };
    }
    if (!res.ok) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
    return { sequence: ((await res.json()) as { sequence: number }).sequence };
  }

  /** wss:// URL for the live notification channel. The daemon opens this with an
   *  `Authorization: Bearer` header (Bun WS supports custom headers); the DO reads
   *  the same bearer as HTTP. Notification-only — correctness never depends on it. */
  wsConnectUrl(): string {
    const ws = this.baseUrl.replace(/^http/, "ws");
    return `${ws}/v1/ws/${this.workspaceId}/proj/${this.projectId}/connect`;
  }

  get bearerToken(): string {
    return this.token;
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    const res = await fetch(`${this.baseUrl}/v1/ws/${this.workspaceId}/proj/${this.projectId}/latest`, {
      headers: this.auth,
    });
    if (!res.ok) throw new Error(`latest failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { sequence: number; manifest: Manifest };
  }

  async versions(limit = 50): Promise<Array<{ sequence: number; manifest_blob_sha: string; device_id: string | null; created_at: string }>> {
    const res = await fetch(`${this.baseUrl}/v1/ws/${this.workspaceId}/proj/${this.projectId}/versions?limit=${limit}`, { headers: this.auth });
    if (!res.ok) throw new Error(`versions failed: ${res.status}`);
    return ((await res.json()) as { versions: [] }).versions;
  }

  async manifestAt(seq: number): Promise<Manifest> {
    const res = await fetch(`${this.baseUrl}/v1/ws/${this.workspaceId}/proj/${this.projectId}/manifests/${seq}`, { headers: this.auth });
    if (!res.ok) throw new Error(`manifest@${seq} failed: ${res.status}`);
    return ((await res.json()) as { manifest: Manifest }).manifest;
  }

  /** SyncRemote: a BlobStore backed by this client (pull / git apply path). */
  blobStore(): BlobStore {
    return new RemoteBlobStore(this);
  }
}

/** Create a server-owned workspace (M7) — ownership is established here, not at
 *  first commit. Returns the high-entropy server-assigned workspace id. */
export async function createRemoteWorkspace(baseUrl: string, token: string, project: string): Promise<string> {
  const res = await fetch(`${baseUrl}/v1/workspaces?project=${encodeURIComponent(project)}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`workspace create failed: ${res.status} ${await res.text()}`);
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

// ---- streaming helpers ----------------------------------------------------

/** A web ReadableStream over a file (optionally a byte range, end inclusive). */
function fileStream(absPath: string, start?: number, endInclusive?: number): ReadableStream {
  const opts = start !== undefined ? { start, end: endInclusive } : {};
  return Readable.toWeb(fs.createReadStream(absPath, opts)) as unknown as ReadableStream;
}

async function readJson<T>(p: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8")) as T;
  } catch {
    return undefined;
  }
}
