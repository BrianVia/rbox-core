import type { BlobStore, Manifest } from "../engine/index.js";

export interface CommitResult {
  sequence?: number;
  conflict?: boolean;
  head?: number;
}

/** Thin client for the rbox control plane. */
export class RboxApi {
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
    if (!res.ok) throw new Error(`commit failed: ${res.status} ${await res.text()}`);
    return { sequence: ((await res.json()) as { sequence: number }).sequence };
  }

  async latest(): Promise<{ sequence: number; manifest: Manifest }> {
    const res = await fetch(`${this.baseUrl}/v1/ws/${this.workspaceId}/proj/${this.projectId}/latest`, {
      headers: this.auth,
    });
    if (!res.ok) throw new Error(`latest failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as { sequence: number; manifest: Manifest };
  }
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
}
