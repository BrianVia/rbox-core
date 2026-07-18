/**
 * Shared transport core for the rbox control-plane client: the base URL + auth
 * material, the header builders, and the two low-level HTTP primitives that more
 * than one domain module needs (`postJson`, `missingBlobs`). The per-connection
 * receipt/grant state lives here too so every domain module (blobs, multipart,
 * commits, keys) reads and mutates ONE instance held by `RboxApi`.
 */
import { translateRemoteError } from "./errors.js";
import { fetchResilient, type ResilientOpts } from "./resilient.js";
import { RBOX_VERSION } from "../version.js";
import { debugEnabled } from "../debug.js";

const authGrantEnabled = (): boolean => process.env.RBOX_AUTH_GRANT !== "0";
export const UPLOAD_GRANT_ATTACH_WINDOW_MS = 270_000;
export const UPLOAD_GRANT_REFRESH_AFTER_MS = 240_000;
export const UPLOAD_GRANT_RETRY_INTERVAL_MS = 15_000;

export class RemoteContext {
  constructor(
    readonly baseUrl: string,
    readonly token: string,
    readonly workspaceId: string,
    readonly projectId: string,
    readonly warningSink: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
    readonly instrumentationSink: (line: string) => void = (line) => {
      if (debugEnabled()) warningSink(line);
    },
  ) {}

  // §23 upload-receipts: single-PUT/check/commit speak the receipts protocol. PUT
  // returns a receipt (proof-of-staged-upload); we accumulate {encSha → receipt} and
  // hand the map to commit, which does the batched accounting + staging→canonical
  // promote. Cleared on a successful commit (so a daemon's RboxApi doesn't accrete).
  readonly receipts = new Map<string, string>();
  receiptSendCap: number | undefined;
  receiptSendCapShrinkCount = 0;
  private static readonly PROTO = "upload-receipts-v1";

  // §27 — short-lived download grant handed back on the pull handshake (`latest()` /
  // `latestCommit()`). Presented on each blob GET so the server skips the per-blob D1
  // entitlement read. Refreshed every handshake; harmless when stale (an expired grant
  // makes the server fall back to the D1 path, still serving an entitled account).
  private downloadGrant?: string;
  private downloadGrantCapturedAtMs = 0;
  private downloadGrantRefresh?: Promise<void>;

  // §109 — upload grants are shared by every batch-upload lane. Refresh is a
  // context-owned control call, deliberately outside the uploader's in-flight work.
  private uploadGrant?: string;
  private uploadGrantCapturedAtMs = 0;
  private uploadGrantGeneration = 0;
  private uploadGrantRefresh?: Promise<void>;
  private uploadGrantRetryBlockedUntilMs = 0;

  get auth(): Record<string, string> {
    return { authorization: `Bearer ${this.token}`, "x-rbox-version": RBOX_VERSION };
  }
  /** `auth` plus the §27 download grant when held (so blob GETs skip the D1 read). */
  get authDownload(): Record<string, string> {
    return this.downloadGrant ? { ...this.auth, "x-rbox-download-grant": this.downloadGrant } : this.auth;
  }
  /** Capture a §27 grant from a `/latest` response body (no-op when absent — old server). */
  captureGrant(body: { grant?: unknown }): void {
    if (typeof body.grant === "string") {
      this.downloadGrant = body.grant;
      this.downloadGrantCapturedAtMs = Date.now();
    }
  }
  get protoAuth(): Record<string, string> {
    return { ...this.auth, "x-rbox-protocol": RemoteContext.PROTO };
  }
  /** Bearer is always present; the grant is only a server verification fast path. */
  get batchPutAuth(): Record<string, string> {
    // A grant expiring mid-flight is correctness-harmless because the server falls
    // back to this bearer; the conservative attach margin only keeps that rare.
    if (
      authGrantEnabled()
      && this.uploadGrant
      && Date.now() - this.uploadGrantCapturedAtMs < UPLOAD_GRANT_ATTACH_WINDOW_MS
    ) {
      return { ...this.protoAuth, "x-rbox-upload-grant": this.uploadGrant };
    }
    return this.protoAuth;
  }

  captureUploadGrant(body: { uploadGrant?: unknown }): void {
    if (authGrantEnabled() && typeof body.uploadGrant === "string") {
      this.uploadGrant = body.uploadGrant;
      this.uploadGrantCapturedAtMs = Date.now();
      this.uploadGrantGeneration++;
    }
  }

  private clearUploadGrant(): void {
    this.uploadGrant = undefined;
    this.uploadGrantCapturedAtMs = 0;
    this.uploadGrantGeneration++;
  }

  /** Fire-and-forget: upload correctness never depends on grant refresh. */
  maybeRefreshUploadGrant(): void {
    if (!authGrantEnabled() || !this.uploadGrant) return;
    const now = Date.now();
    if (now - this.uploadGrantCapturedAtMs < UPLOAD_GRANT_REFRESH_AFTER_MS) return;
    if (this.uploadGrantRefresh || now < this.uploadGrantRetryBlockedUntilMs) return;
    this.uploadGrantRefresh = this.refreshUploadGrant().then(
      () => { this.uploadGrantRefresh = undefined; },
      () => {
        this.uploadGrantRefresh = undefined;
        this.uploadGrantRetryBlockedUntilMs = Date.now() + UPLOAD_GRANT_RETRY_INTERVAL_MS;
      },
    );
  }

  /** Record the receipt a §23 staging PUT returned (no-op for legacy responses). */
  captureReceipt(sha256: string, body: { receipt?: unknown }): void {
    if (typeof body.receipt === "string") this.receipts.set(sha256, body.receipt);
  }

  /**
   * The shared response-returning fetch seam for the control plane. Most domain modules
   * (blobs, multipart, commits, keys) issue requests through here so the abort deadline +
   * bounded transient retry live in a single place; buffered blob GET uses a GET-specific
   * helper because its OK body read must also sit inside the deadline. Defaults to the
   * small-control-call timeout and the default retry budget; transfers override `timeoutMs`
   * (size-aware) and non-idempotent minting calls override `retries: 0`. An HTTP Response of
   * any status is returned as-is — only a THROWN transport fault is retried/translated.
   */
  fetch(url: string, init: RequestInit | (() => RequestInit) = {}, opts: ResilientOpts = {}): Promise<Response> {
    return fetchResilient(url, init, opts);
  }

  async postJson(path: string, body: unknown, opts: ResilientOpts = {}): Promise<Response> {
    return this.fetch(`${this.baseUrl}${path}`, { method: "POST", headers: { ...this.auth, "content-type": "application/json" }, body: JSON.stringify(body) }, opts);
  }

  async missingBlobs(shas: string[]): Promise<string[]> {
    if (shas.length === 0) return [];
    const res = await this.fetch(`${this.baseUrl}/v1/blobs/check`, {
      method: "POST",
      headers: { ...this.protoAuth, "content-type": "application/json" },
      body: JSON.stringify({ shas }),
    }, { op: "checking which blobs to upload" });
    if (!res.ok) throw new Error(translateRemoteError(res.status, "blobs/check failed", await res.text(), "workspace not found — check you're in the right directory"));
    const body = (await res.json()) as { missing: string[]; uploadGrant?: unknown };
    this.captureUploadGrant(body);
    return body.missing;
  }

  async ensureFreshDownloadGrant(maxAgeMs: number): Promise<void> {
    if (!this.downloadGrant) return;
    if (Date.now() - this.downloadGrantCapturedAtMs <= maxAgeMs) return;
    if (!this.downloadGrantRefresh) {
      this.downloadGrantRefresh = this.refreshDownloadGrant().finally(() => {
        this.downloadGrantRefresh = undefined;
      });
    }
    await this.downloadGrantRefresh;
  }

  private async refreshDownloadGrant(): Promise<void> {
    const res = await this.fetch(`${this.baseUrl}/v1/ws/${this.workspaceId}/proj/${this.projectId}/latest`, { headers: this.auth }, { op: "checking for remote changes" });
    if (!res.ok) throw new Error(translateRemoteError(res.status, "latest failed", await res.text(), "workspace not found — check you're in the right directory"));
    const body = (await res.json().catch(() => ({}))) as { grant?: unknown };
    if (typeof body.grant === "string") this.captureGrant(body);
    else {
      this.downloadGrant = undefined;
      this.downloadGrantCapturedAtMs = 0;
    }
  }

  private async refreshUploadGrant(): Promise<void> {
    const generation = this.uploadGrantGeneration;
    const res = await this.fetch(`${this.baseUrl}/v1/blobs/check`, {
      method: "POST",
      headers: { ...this.protoAuth, "content-type": "application/json" },
      body: JSON.stringify({ shas: [] }),
    }, { op: "refreshing upload grant", retries: 0 });
    if (!res.ok) throw new Error(translateRemoteError(res.status, "blobs/check failed", await res.text(), "workspace not found — check you're in the right directory"));
    const body = (await res.json()) as { uploadGrant?: unknown };
    if (this.uploadGrantGeneration !== generation) return;
    if (typeof body.uploadGrant === "string") this.captureUploadGrant(body);
    else {
      // The server kill switch may have changed since the original check.
      this.clearUploadGrant();
    }
  }
}
