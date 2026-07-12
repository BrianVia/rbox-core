import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

const MiB = 1024 * 1024;
// Local copy of the server's part sizing (apps/api/src/blobs.ts partSizeFor /
// MIN_PART / MAX_PARTS) — the tsconfig graphs don't allow importing across the
// src/ ↔ apps/api boundary. Keep manually in sync with blobs.ts if it changes.
const MIN_PART = 8 * MiB;
const MAX_PARTS = 9000;

function partSizeFor(size: number): number {
  let partSize = MIN_PART;
  if (Math.ceil(size / partSize) > MAX_PARTS) partSize = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  return partSize;
}

export interface FakeMultipartServerOptions {
  partSize?: number;
  partLatencyMs?: number;
  /** Close this part's connection once, producing a retryable transport failure. */
  failPartOnce?: number;
  includeServerTimings?: boolean;
}

export interface FakeMultipartServerStats {
  initRequests: number;
  statusRequests: number;
  partRequests: number;
  completeRequests: number;
  completedParts: number;
  bytesReceived: number;
  transientFailures: number;
}

export interface FakeMultipartServer {
  baseUrl: string;
  close: () => Promise<void>;
  stats: FakeMultipartServerStats;
}

interface Upload {
  sha: string;
  size: number;
  partSize: number;
  totalParts: number;
  parts: Map<number, Buffer>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  // connection: close — every request rides a FRESH connection. Bun/undici transparently
  // re-drive a request whose REUSED keep-alive socket dies (invisible to retryTransient's
  // retry counter), so keep-alive here would make injected transient failures unobservable.
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), connection: "close" });
  res.end(encoded);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

/** A local-only multipart implementation used by instrumentation tests and synthetic rigs. */
export async function startFakeMultipartServer(opts: FakeMultipartServerOptions = {}): Promise<FakeMultipartServer> {
  const uploads = new Map<string, Upload>();
  const blobs = new Set<string>();
  const failedParts = new Set<number>();
  let nextUpload = 1;
  const stats: FakeMultipartServerStats = {
    initRequests: 0,
    statusRequests: 0,
    partRequests: 0,
    completeRequests: 0,
    completedParts: 0,
    bytesReceived: 0,
    transientFailures: 0,
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const init = url.pathname.match(/^\/v1\/blobs\/([0-9a-f]{64})\/multipart$/);
      const status = url.pathname.match(/^\/v1\/blobs\/([0-9a-f]{64})\/multipart\/([^/]+)$/);
      const part = url.pathname.match(/^\/v1\/blobs\/([0-9a-f]{64})\/multipart\/([^/]+)\/part\/(\d+)$/);
      const complete = url.pathname.match(/^\/v1\/blobs\/([0-9a-f]{64})\/multipart\/([^/]+)\/complete$/);

      if (req.method === "POST" && init) {
        stats.initRequests++;
        const parsed = JSON.parse((await readBody(req)).toString("utf8")) as { size?: unknown };
        const size = typeof parsed.size === "number" && Number.isFinite(parsed.size) && parsed.size >= 0 ? parsed.size : -1;
        if (size < 0) return json(res, 400, { error: "invalid_size" });
        const selectedPartSize = opts.partSize ?? partSizeFor(size);
        if (!Number.isInteger(selectedPartSize) || selectedPartSize <= 0) return json(res, 500, { error: "invalid_part_size" });
        const uploadId = `local-${nextUpload++}`;
        const totalParts = Math.ceil(size / selectedPartSize);
        uploads.set(uploadId, { sha: init[1]!, size, partSize: selectedPartSize, totalParts, parts: new Map() });
        return json(res, 200, { uploadId, partSize: selectedPartSize, totalParts });
      }

      if (req.method === "GET" && status) {
        stats.statusRequests++;
        const upload = uploads.get(status[2]!);
        if (!upload || upload.sha !== status[1]) return json(res, 404, { error: "unknown_upload" });
        return json(res, 200, { partSize: upload.partSize, completedParts: [...upload.parts.keys()].sort((a, b) => a - b) });
      }

      if (req.method === "PUT" && part) {
        stats.partRequests++;
        const n = Number(part[3]);
        const upload = uploads.get(part[2]!);
        if (!upload || upload.sha !== part[1]) return json(res, 404, { error: "unknown_upload" });
        if (!Number.isInteger(n) || n < 1 || n > upload.totalParts) return json(res, 400, { error: "invalid_part" });
        if (opts.failPartOnce === n && !failedParts.has(n)) {
          failedParts.add(n);
          stats.transientFailures++;
          req.socket.destroy();
          return;
        }
        const body = await readBody(req);
        const expected = n < upload.totalParts ? upload.partSize : upload.size - (upload.totalParts - 1) * upload.partSize;
        if (body.byteLength !== expected) return json(res, 400, { error: "invalid_part_size" });
        if (opts.partLatencyMs && opts.partLatencyMs > 0) await new Promise((resolve) => setTimeout(resolve, opts.partLatencyMs));
        const previous = upload.parts.get(n);
        upload.parts.set(n, body);
        stats.bytesReceived += body.byteLength - (previous?.byteLength ?? 0);
        return json(res, 200, { ok: true, partNumber: n });
      }

      if (req.method === "POST" && complete) {
        stats.completeRequests++;
        const t0 = Date.now();
        const upload = uploads.get(complete[2]!);
        if (!upload || upload.sha !== complete[1]) return json(res, 404, { error: "unknown_upload" });
        if (upload.parts.size !== upload.totalParts) return json(res, 409, { error: "missing_parts" });
        // Stream each part into the digest in order (no Buffer.concat) so peak
        // memory stays ~1x the artifact — a --gib run already holds all parts.
        const assembleStart = Date.now();
        const hash = createHash("sha256");
        let assembledBytes = 0;
        for (let i = 1; i <= upload.totalParts; i++) {
          const partBody = upload.parts.get(i)!;
          hash.update(partBody);
          assembledBytes += partBody.byteLength;
        }
        const assembleMs = Date.now() - assembleStart;
        const actual = hash.digest("hex");
        if (actual !== upload.sha || assembledBytes !== upload.size) return json(res, 422, { error: "sha_mismatch" });
        uploads.delete(complete[2]!);
        blobs.add(actual);
        stats.completedParts += upload.totalParts;
        const body: Record<string, unknown> = { ok: true, sha256: actual, sizeBytes: assembledBytes };
        if (opts.includeServerTimings !== false) {
          body.serverTimings = { totalMs: Date.now() - t0, assembleMs, rereadPutMs: 0, accountingMs: 0 };
        }
        return json(res, 200, body);
      }

      if (req.method === "POST" && url.pathname === "/v1/blobs/check") {
        const parsed = JSON.parse((await readBody(req)).toString("utf8")) as { shas?: unknown };
        const shas = Array.isArray(parsed.shas) ? parsed.shas.filter((sha): sha is string => typeof sha === "string") : [];
        return json(res, 200, { missing: shas.filter((sha) => !blobs.has(sha)) });
      }

      json(res, 404, { error: "not_found" });
    } catch {
      if (!res.headersSent) json(res, 500, { error: "fake_server_error" });
      else res.destroy();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake multipart server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    stats,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
