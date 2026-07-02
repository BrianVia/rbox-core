/**
 * Shared transport core for the rbox control-plane client: the base URL + auth
 * material, the header builders, and the two low-level HTTP primitives that more
 * than one domain module needs (`postJson`, `missingBlobs`). The per-connection
 * receipt/grant state lives here too so every domain module (blobs, multipart,
 * commits, keys) reads and mutates ONE instance held by `RboxApi`.
 */
export class RemoteContext {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly workspaceId: string,
    readonly projectId: string
  ) {}

  // §23 upload-receipts: single-PUT/check/commit speak the receipts protocol. PUT
  // returns a receipt (proof-of-staged-upload); we accumulate {encSha → receipt} and
  // hand the map to commit, which does the batched accounting + staging→canonical
  // promote. Cleared on a successful commit (so a daemon's RboxApi doesn't accrete).
  readonly receipts = new Map<string, string>();
  private static readonly PROTO = "upload-receipts-v1";

  // §27 — short-lived download grant handed back on the pull handshake (`latest()` /
  // `latestCommit()`). Presented on each blob GET so the server skips the per-blob D1
  // entitlement read. Refreshed every handshake; harmless when stale (an expired grant
  // makes the server fall back to the D1 path, still serving an entitled account).
  private downloadGrant?: string;

  get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}` };
  }
  /** `auth` plus the §27 download grant when held (so blob GETs skip the D1 read). */
  get authDownload(): Record<string, string> {
    return this.downloadGrant ? { ...this.auth, "x-rbox-download-grant": this.downloadGrant } : this.auth;
  }
  /** Capture a §27 grant from a `/latest` response body (no-op when absent — old server). */
  captureGrant(body: { grant?: unknown }): void {
    if (typeof body.grant === "string") this.downloadGrant = body.grant;
  }
  get protoAuth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "x-rbox-protocol": RemoteContext.PROTO };
  }

  /** Record the receipt a §23 staging PUT returned (no-op for legacy responses). */
  captureReceipt(sha256: string, body: { receipt?: unknown }): void {
    if (typeof body.receipt === "string") this.receipts.set(sha256, body.receipt);
  }

  async postJson(path: string, body: unknown): Promise<Response> {
    return fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { ...this.auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  }

  async missingBlobs(shas: string[]): Promise<string[]> {
    if (shas.length === 0) return [];
    const res = await fetch(`${this.baseUrl}/v1/blobs/check`, {
      method: "POST",
      headers: { ...this.protoAuth, "content-type": "application/json" },
      body: JSON.stringify({ shas }),
    });
    if (!res.ok) throw new Error(`blobs/check failed: ${res.status} ${await res.text()}`);
    return ((await res.json()) as { missing: string[] }).missing;
  }
}
