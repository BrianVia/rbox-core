/**
 * rbox dev control plane.
 *
 *  - blobs: content-addressed in R2 (see blobs.ts). Single streaming PUT with
 *    R2-native sha verification up to ~90MiB; resumable R2 multipart above that
 *    (M3). No large object is buffered in the Worker.
 *  - manifests: commit/latest/connect delegated to the WorkspaceSync Durable
 *    Object (D2/M1) — authoritative sequencer + live notification fanout.
 *  - top-level error boundary turns thrown Responses into real responses.
 *
 * Dev-harness shortcut (documented): auth is a shared bearer token (M4 replaces).
 */
import type { Env } from "./env.js";
import { blobsCheck, blobGet, blobPut, multipartComplete, multipartInit, multipartPart, multipartStatus } from "./blobs.js";
import { approveDeviceAuth, authenticate, bootstrap, listDevices, pollDeviceAuth, revokeDevice, startDeviceAuth } from "./auth.js";
import { versionsList } from "./versions.js";
export { WorkspaceSync } from "./workspace-sync.js";

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

  // Public auth endpoints (EXACT routes only — start the device-authorization flow).
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "start"])) return startDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "poll"])) return pollDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "bootstrap"])) return bootstrap(req, env);

  // Everything else requires a valid (non-revoked) device token.
  const device = await authenticate(req, env);
  if (!device) throw jsonResponse({ error: "unauthorized" }, 401);

  // Authed auth endpoints.
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return approveDeviceAuth(req, env);
  if (req.method === "GET" && eq(seg, ["v1", "auth", "devices"])) return listDevices(env, device);
  if (req.method === "POST" && seg.length === 5 && seg[0] === "v1" && seg[1] === "auth" && seg[2] === "devices" && seg[4] === "revoke") {
    return revokeDevice(env, seg[3]!);
  }

  // POST /v1/blobs/check  { shas } -> { missing }
  if (req.method === "POST" && eq(seg, ["v1", "blobs", "check"])) return blobsCheck(req, env, SHA_RE);

  // /v1/blobs/:sha[...]
  if (seg[0] === "v1" && seg[1] === "blobs" && seg.length >= 3) {
    const sha = seg[2]!;
    if (!SHA_RE.test(sha)) throw badRequest("invalid sha256");

    if (seg.length === 3) {
      if (req.method === "PUT") return blobPut(req, env, sha);
      if (req.method === "GET") return blobGet(env, sha);
    }
    if (seg[3] === "multipart") {
      const uploadId = seg[4];
      if (seg.length === 4 && req.method === "POST") return multipartInit(req, env, sha);
      if (seg.length === 5 && uploadId && req.method === "GET") return multipartStatus(env, sha, uploadId);
      if (seg.length === 7 && uploadId && seg[5] === "part" && req.method === "PUT") {
        const n = Number(seg[6]);
        return multipartPart(req, env, sha, uploadId, n);
      }
      if (seg.length === 6 && uploadId && seg[5] === "complete" && req.method === "POST") return multipartComplete(env, sha, uploadId);
    }
  }

  // /v1/ws/:ws/proj/:proj/...
  if (seg[0] === "v1" && seg[1] === "ws" && seg[3] === "proj" && seg.length >= 6) {
    const ws = seg[2]!;
    const proj = seg[4]!;
    const action = seg[5]!;
    // versions list (D1) — served by the Worker.
    if (seg.length === 6 && action === "versions" && req.method === "GET") {
      return versionsList(env, ws, proj, Number(url.searchParams.get("limit") ?? "50"));
    }
    // commit/latest/connect and historical manifests/:seq -> the DO (authoritative).
    if (action === "manifests" || action === "latest" || action === "connect") {
      const id = env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`);
      return env.WORKSPACE_SYNC.get(id).fetch(req);
    }
  }

  return jsonResponse({ error: "not_found" }, 404);
}

// ---- helpers ------------------------------------------------------------

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}
function badRequest(message: string): Response {
  return jsonResponse({ error: "bad_request", message }, 400);
}
function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}
