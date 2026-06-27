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
import { gcMark, gcPurge, versionsList } from "./versions.js";
import { json } from "./util.js";
import { authorizeWorkspace, createWorkspace, isPlatform } from "./authz.js";
import { adminSetPlan, countWorkspaces, planLimitsFor, usage } from "./billing.js";
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

  // Platform-only internal op (M7): GC requires the PLATFORM secret, NOT a tenant
  // device token. roots/prune are not exposed by the public router (GC calls the DO directly).
  if (req.method === "POST" && eq(seg, ["v1", "admin", "gc"])) {
    if (!isPlatform(req, env)) return jsonResponse({ error: "not_found" }, 404);
    const graceMs = Number(url.searchParams.get("graceMs") ?? String(60 * 60 * 1000));
    return url.searchParams.get("phase") === "purge" ? gcPurge(env, graceMs) : gcMark(env, graceMs);
  }
  // POST /v1/admin/account/:id/plan?plan=pro&extraGB=N (platform secret; interim until Stripe).
  if (req.method === "POST" && seg.length === 5 && seg[0] === "v1" && seg[1] === "admin" && seg[2] === "account" && seg[4] === "plan") {
    if (!isPlatform(req, env)) return jsonResponse({ error: "not_found" }, 404);
    return adminSetPlan(env, seg[3]!, url.searchParams.get("plan") ?? "free", Number(url.searchParams.get("extraGB") ?? "0"));
  }

  // Public auth endpoints (EXACT routes only — start the device-authorization flow).
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "start"])) return startDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "poll"])) return pollDeviceAuth(req, env);
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "bootstrap"])) return bootstrap(req, env);

  // Everything else requires a valid (non-revoked) device token → full Principal.
  const p = await authenticate(req, env);
  if (!p) throw jsonResponse({ error: "unauthorized" }, 401);

  // Account ops (scoped to the caller's account).
  if (req.method === "POST" && eq(seg, ["v1", "auth", "device", "approve"])) return approveDeviceAuth(req, env, p);
  if (req.method === "GET" && eq(seg, ["v1", "auth", "devices"])) return listDevices(env, p);
  if (req.method === "POST" && seg.length === 5 && seg[0] === "v1" && seg[1] === "auth" && seg[2] === "devices" && seg[4] === "revoke") {
    return revokeDevice(env, p, seg[3]!);
  }
  if (req.method === "GET" && eq(seg, ["v1", "account", "usage"])) return usage(env, p);
  if (req.method === "POST" && eq(seg, ["v1", "workspaces"])) {
    const limits = await planLimitsFor(env, p.accountId); // workspace-count quota (M7b)
    if ((await countWorkspaces(env, p.accountId)) >= limits.workspaces) {
      return jsonResponse({ error: "quota_exceeded", limit: "workspaces", cap: limits.workspaces }, 402);
    }
    return createWorkspace(env, p, url.searchParams.get("project") ?? "root");
  }

  // POST /v1/blobs/check — entitlement-scoped to the caller's account.
  if (req.method === "POST" && eq(seg, ["v1", "blobs", "check"])) return blobsCheck(req, env, SHA_RE, p.accountId);

  // /v1/blobs/:sha[...] — all entitlement-gated by p.accountId.
  if (seg[0] === "v1" && seg[1] === "blobs" && seg.length >= 3) {
    const sha = seg[2]!;
    if (!SHA_RE.test(sha)) throw badRequest("invalid sha256");
    if (seg.length === 3) {
      if (req.method === "PUT") return blobPut(req, env, sha, p.accountId);
      if (req.method === "GET") return blobGet(env, sha, p.accountId);
    }
    if (seg[3] === "multipart") {
      const uploadId = seg[4];
      if (seg.length === 4 && req.method === "POST") return multipartInit(req, env, sha, p.accountId);
      if (seg.length === 5 && uploadId && req.method === "GET") return multipartStatus(env, sha, uploadId, p.accountId);
      if (seg.length === 7 && uploadId && seg[5] === "part" && req.method === "PUT") return multipartPart(req, env, sha, uploadId, Number(seg[6]), p.accountId);
      if (seg.length === 6 && uploadId && seg[5] === "complete" && req.method === "POST") return multipartComplete(env, sha, uploadId, p.accountId);
    }
  }

  // /v1/ws/:ws/proj/:proj/... — authorize (cross-account → 404) before any access.
  if (seg[0] === "v1" && seg[1] === "ws" && seg[3] === "proj" && seg.length >= 6) {
    const ws = seg[2]!;
    const proj = seg[4]!;
    const action = seg[5]!;
    const write = action === "manifests" && req.method === "POST"; // commit
    const az = await authorizeWorkspace(env, p, ws, proj, write);
    if (!az.ok) return jsonResponse({ error: az.status === 403 ? "forbidden" : "not_found" }, az.status);

    if (seg.length === 6 && action === "versions" && req.method === "GET") {
      return versionsList(env, ws, proj, Number(url.searchParams.get("limit") ?? "50"));
    }
    if (action === "manifests" || action === "latest" || action === "connect") {
      const stub = env.WORKSPACE_SYNC.get(env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`));
      if (write) {
        // Commit: forward with the authenticated account (DO does account-scoped
        // blob-existence). Clean header set by the Worker (overrides any client value).
        const headers = new Headers(req.headers);
        headers.set("x-rbox-account", p.accountId);
        return stub.fetch(new Request(req, { headers }));
      }
      return stub.fetch(req);
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
const jsonResponse = json; // worker uses jsonResponse; shared impl is util.json
