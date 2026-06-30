import type { Env } from "./env.js";
import { ctEqual, json } from "./util.js";
import { dbFor } from "./db.js";

/** The authenticated caller: a device, its account, user, and role. */
export interface Principal {
  deviceId: string;
  accountId: string;
  userId: string | null;
  role: string; // owner | admin | editor | viewer (default 'owner' for the bootstrap account)
  /** Token kind, derived from the device row's expiry (design 21 §1.1): a durable
   *  CLI/device token (`expires_at IS NULL`) vs a short-lived browser web session
   *  (`expires_at` set). The E2EE ceiling is only ENFORCED once routes can tell the
   *  two apart — a `web` token is default-denied off every crypto/sync/credential-
   *  mint route (see worker.ts `webTokenAllowed`). */
  kind: "durable" | "web";
}

export type AuthzResult = { ok: true } | { ok: false; status: 404 | 403 };

/** The owning account of a workspace, or null if unknown/unowned (→ 404, fail-closed).
 *  §32: `workspaces` is account-data plane; a legitimate caller owns the workspace, so
 *  it lives on the caller's shard. We route by the CLAIMED `accountId` — a non-owner's
 *  query returns null on their shard → 404 (identical to today's cross-account 404). */
export async function workspaceOwner(env: Env, accountId: string, ws: string, proj: string): Promise<string | null> {
  const row = await dbFor(env, accountId)
    .prepare("SELECT account_id FROM workspaces WHERE workspace_id = ? AND project_id = ?")
    .bind(ws, proj)
    .first<{ account_id: string | null }>();
  return row?.account_id ?? null;
}

/**
 * Authorize a workspace operation. Cross-account (or unowned) → 404 (indistinguishable,
 * no enumeration leak). Same-account but insufficient role for a write → 403.
 */
export async function authorizeWorkspace(env: Env, p: Principal, ws: string, proj: string, write: boolean): Promise<AuthzResult> {
  const owner = await workspaceOwner(env, p.accountId, ws, proj);
  if (!owner || owner !== p.accountId) return { ok: false, status: 404 };
  if (write && p.role === "viewer") return { ok: false, status: 403 };
  return { ok: true };
}

// ---- blob entitlements (per-account read access; created only by verified upload) ----

export async function isEntitled(env: Env, accountId: string, sha: string): Promise<boolean> {
  const r = await dbFor(env, accountId).prepare("SELECT 1 FROM blob_refs WHERE account_id = ? AND sha256 = ?").bind(accountId, sha).first();
  return !!r;
}
export async function entitledSubset(env: Env, accountId: string, shas: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < shas.length; i += 80) {
    const chunk = shas.slice(i, i + 80);
    if (chunk.length === 0) break;
    const rows = await dbFor(env, accountId)
      .prepare(`SELECT sha256 FROM blob_refs WHERE account_id = ? AND sha256 IN (${chunk.map(() => "?").join(",")})`)
      .bind(accountId, ...chunk)
      .all<{ sha256: string }>();
    for (const r of rows.results ?? []) out.add(r.sha256);
  }
  return out;
}
export async function grantEntitlement(env: Env, accountId: string, sha: string): Promise<void> {
  await dbFor(env, accountId).prepare("INSERT OR IGNORE INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(accountId, sha).run();
}

/** Platform-admin auth for internal ops (GC). NOT a tenant device token. */
export function isPlatform(req: Request, env: Env): boolean {
  const h = req.headers.get("x-rbox-platform") ?? "";
  return !!env.RBOX_PLATFORM_SECRET && ctEqual(h, env.RBOX_PLATFORM_SECRET);
}

/** POST /v1/workspaces — create a workspace OWNED by the caller's account, with a
 *  high-entropy server-assigned id. Ownership is established here (not first-commit). */
export async function createWorkspace(env: Env, p: Principal, projectId: string): Promise<Response> {
  if (p.role === "viewer") return json({ error: "forbidden" }, 403);
  const ws = `ws_${crypto.randomUUID().replace(/-/g, "")}`; // high-entropy, unguessable
  await dbFor(env, p.accountId)
    .prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(ws, projectId, p.accountId, Date.now())
    .run();
  await audit(env, p, "workspace.create", ws);
  return json({ workspaceId: ws, projectId });
}

export async function audit(env: Env, p: Principal | null, action: string, target: string, routeAccountId?: string): Promise<void> {
  // audit_log is account-data → route to the audited account's shard. A platform action
  // (p === null) carries no Principal but still concerns a specific account, so the caller
  // passes `routeAccountId` (e.g. adminSetPlan's target). The STORED account_id is unchanged
  // (`p?.accountId ?? null`) — routeAccountId selects the shard, not the row's column value.
  // Falls back to "" only when neither is known (§32 account-less, the one shard at N=1).
  await dbFor(env, routeAccountId ?? p?.accountId ?? "")
    .prepare("INSERT INTO audit_log (account_id, actor_device, actor_user, action, target, at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(p?.accountId ?? null, p?.deviceId ?? null, p?.userId ?? null, action, target, Date.now())
    .run()
    .catch(() => {});
}
