import type { RouteCtx } from "./shared.js";
import type { Env } from "../env.js";
import { json } from "../util.js";
import { dbFor } from "../db.js";
import { authorizeWorkspace, type Principal } from "../authz.js";
import { versionsList } from "../version-history.js";
import { mintGrant } from "../grants.js";
import { tombstoneFenceResponse } from "../genesis-repair.js";

/**
 * /v1/ws/:ws/proj/:proj/... — the workspace-sync surface. authorize (cross-account
 * → 404) before any access, then forward manifests/latest/connect/commits to the
 * WorkspaceSync Durable Object (versions is served from D1).
 */
export async function syncRoutes({ req, env, url, seg }: RouteCtx, p: Principal): Promise<Response | null> {
  if (seg[0] === "v1" && seg[1] === "ws" && seg[3] === "proj" && seg.length >= 6) {
    const ws = seg[2]!;
    const proj = seg[4]!;
    const action = seg[5]!;
    const write =
      (action === "manifests" && req.method === "POST") ||
      (action === "receipts" && seg[6] === "redeem" && req.method === "POST");
    const az = await authorizeWorkspace(env, p, ws, proj, write);
    if (!az.ok) return json({ error: az.status === 403 ? "forbidden" : "not_found" }, az.status);

    if (seg.length === 6 && action === "versions" && req.method === "GET") {
      return versionsList(env, p.accountId, ws, proj, Number(url.searchParams.get("limit") ?? "50"));
    }
    if (action === "manifests" || action === "latest" || action === "connect" || action === "commits" || action === "receipts") {
      const stub = env.WORKSPACE_SYNC.get(env.WORKSPACE_SYNC.idFromName(`${ws}/${proj}`));
      if (write) {
        // Commit: forward with the authenticated account (DO does account-scoped
        // blob-existence). Clean header set by the Worker (overrides any client value).
        const headers = new Headers(req.headers);
        headers.set("x-rbox-account", p.accountId);
        if (action === "receipts") {const fence=await tombstoneFenceResponse(env,p.accountId);if(fence)return fence;return stub.fetch(new Request(req, { headers }));}
        // C4: also forward the account's CURRENT key epoch (MAX(account_epoch), 0 if
        // none); the DO asserts the commit's accountEpoch == this inside the txn.
        const epochRow = await dbFor(env, p.accountId)
          .prepare("SELECT MAX(account_epoch) AS epoch FROM account_key_states WHERE account_id = ?")
          .bind(p.accountId)
          .first<{ epoch: number | null }>();
        headers.set("x-rbox-account-epoch", String(epochRow?.epoch ?? 0));
        const fence = await tombstoneFenceResponse(env, p.accountId);
        if (fence) return fence;
        return stub.fetch(new Request(req, { headers }));
      }
      const res = await stub.fetch(req);
      // §27 — piggyback a download grant on the pull handshake (the ONE place the caller
      // is already authorized to the workspace, so it costs no extra D1). Minted
      // WORKER-SIDE so the HMAC key never enters the DO. Best-effort: on any hiccup the
      // DO response passes through and the client uses the D1 entitlement path.
      if (action === "latest") return withDownloadGrant(env, res, p.accountId, ws);
      return res;
    }
  }
  return null;
}

/** §27 — splice a best-effort download grant into a successful `latest()` response,
 *  WORKER-SIDE (the `RBOX_GRANT_KEY` HMAC key never enters the WorkspaceSync DO). Mint is
 *  best-effort: no key / non-2xx / non-object body ⇒ the DO response passes through
 *  untouched and the client falls back to the D1 entitlement path. On success the client's
 *  subsequent blob GETs present the grant and skip the per-blob D1 read (§27). */
async function withDownloadGrant(env: Env, res: Response, accountId: string, workspaceId: string): Promise<Response> {
  if (!res.ok) return res;
  let body: unknown;
  try {
    body = await res.clone().json();
  } catch {
    return res; // not JSON — leave the DO response untouched
  }
  if (typeof body !== "object" || body === null) return res;
  const grant = await mintGrant(env, { accountId, workspaceId, nowMs: Date.now() });
  if (!grant) return res; // no grant key configured — best-effort no-op
  const headers = new Headers(res.headers);
  headers.delete("content-length"); // body length changed
  return new Response(JSON.stringify({ ...(body as Record<string, unknown>), grant }), { status: res.status, headers });
}
