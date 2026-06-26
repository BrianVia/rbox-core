/**
 * rbox dev control plane.
 *
 *  - blobs: content-addressed in R2, pointer rows in D1 (Worker-mediated PUT with
 *    a dev size cap; production path is presigned direct-to-R2 + multipart, D3/M3)
 *  - manifests: commit/latest/connect are delegated to the WorkspaceSync Durable
 *    Object (D2/M1) — the authoritative per-(workspace,project) commit sequencer
 *    and live notification fanout. The DO fixes the old MAX(sequence)+1 race.
 *  - top-level error boundary turns thrown Responses into real responses.
 *
 * Dev-harness shortcut (documented): auth is a shared bearer token, not the
 * device-code flow (M4 replaces it).
 */
import type { Env } from "./env.js";
export { WorkspaceSync } from "./workspace-sync.js";

const MAX_BLOB_BYTES = 25 * 1024 * 1024; // dev cap; prod uses presigned multipart
const SHA_RE = /^[0-9a-f]{64}$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (e instanceof Response) return e; // thrown 4xx flows out as itself
      console.error("unhandled", e);
      return jsonResponse({ error: "internal", message: String((e as Error)?.message ?? e) }, 500);
    }
  },
};

async function route(req: Request, env: Env): Promise<Response> {
  const url = new URL(req.url);
  const seg = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/health") return jsonResponse({ ok: true, service: "rbox-dev-api" });

  requireAuth(req, env);

  // POST /v1/blobs/check  { shas: string[] } -> { missing: string[] }
  if (req.method === "POST" && eq(seg, ["v1", "blobs", "check"])) {
    return blobsCheck(req, env);
  }

  // PUT/GET /v1/blobs/:sha
  if (seg.length === 3 && seg[0] === "v1" && seg[1] === "blobs") {
    const sha = seg[2]!;
    if (!SHA_RE.test(sha)) throw badRequest("invalid sha256");
    if (req.method === "PUT") return blobPut(req, env, sha);
    if (req.method === "GET") return blobGet(env, sha);
  }

  // /v1/ws/:ws/proj/:proj/(manifests|latest|connect) -> delegate to the WorkspaceSync DO.
  if (seg.length === 6 && seg[0] === "v1" && seg[1] === "ws" && seg[3] === "proj") {
    const ws = seg[2]!;
    const proj = seg[4]!;
    const action = seg[5]!;
    if (action === "manifests" || action === "latest" || action === "connect") {
      const id = env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`);
      return env.WORKSPACE_SYNC.get(id).fetch(req);
    }
  }

  return jsonResponse({ error: "not_found" }, 404);
}

// ---- blobs --------------------------------------------------------------

async function blobsCheck(req: Request, env: Env): Promise<Response> {
  const body = (await req.json()) as { shas?: unknown };
  const shas = Array.isArray(body.shas) ? body.shas.filter((s): s is string => typeof s === "string" && SHA_RE.test(s)) : [];
  const present = new Set<string>();
  for (let i = 0; i < shas.length; i += 80) {
    const chunk = shas.slice(i, i + 80);
    if (chunk.length === 0) break;
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.rbox_dev_db
      .prepare(`SELECT sha256 FROM blobs WHERE sha256 IN (${placeholders})`)
      .bind(...chunk)
      .all<{ sha256: string }>();
    for (const r of rows.results ?? []) present.add(r.sha256);
  }
  const missing = [...new Set(shas)].filter((s) => !present.has(s));
  return jsonResponse({ missing });
}

async function blobPut(req: Request, env: Env, sha: string): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > MAX_BLOB_BYTES) throw badRequest(`blob exceeds dev cap of ${MAX_BLOB_BYTES} bytes`);

  const bytes = await req.arrayBuffer();
  if (bytes.byteLength > MAX_BLOB_BYTES) throw badRequest("blob exceeds dev cap");

  const actual = await sha256Hex(bytes);
  if (actual !== sha) throw badRequest(`sha256 mismatch: body hashes to ${actual}`);

  await env.rbox_dev_blobs.put(blobKey(sha), bytes);
  await env.rbox_dev_db
    .prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes) VALUES (?, ?)")
    .bind(sha, bytes.byteLength)
    .run();
  return jsonResponse({ ok: true, sha256: sha, sizeBytes: bytes.byteLength });
}

async function blobGet(env: Env, sha: string): Promise<Response> {
  const obj = await env.rbox_dev_blobs.get(blobKey(sha));
  if (!obj) return jsonResponse({ error: "not_found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
}

// ---- helpers ------------------------------------------------------------

function requireAuth(req: Request, env: Env): void {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || header.slice(7) !== env.RBOX_DEV_TOKEN) {
    throw jsonResponse({ error: "unauthorized" }, 401);
  }
}

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function blobKey(sha: string): string {
  return `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
}
function badRequest(message: string): Response {
  return jsonResponse({ error: "bad_request", message }, 400);
}
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
async function sha256Hex(buf: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
