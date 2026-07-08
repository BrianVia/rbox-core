import type { Env } from "../env.js";
import { json } from "../util.js";
import type { Principal } from "../authz.js";
import { dbFor, dirDb } from "../db.js";
import { classifyKind } from "./authenticate.js";

// ── /devices dashboard surface (design 22 §2) ────────────────────────────────
// Account-scoped, web-facing, camelCase, secret-free projections of the devices &
// workspaces a Clerk web session owns. Deliberately SEPARATE from the snake_case
// CLI contract `GET /v1/auth/devices` (`rbox device list` parses that) so neither
// regresses. Responses NEVER include `token_hash`, `account_id`, `user_id`, raw
// `expires_at`, or any key/roster material — `kind` is the only `expires_at`
// projection, and the server makes no claim about E2EE roster status (design §2.1).

const ACCOUNT_LIST_LIMIT_DEFAULT = 50;
const ACCOUNT_LIST_LIMIT_MAX = 100;
const DEVICE_LABEL_MAX = 256; // projection cap; the renderer also sanitizes (XSS/escaping)

function parseLimit(url: URL): number {
  const raw = Number(url.searchParams.get("limit"));
  if (!Number.isFinite(raw) || raw <= 0) return ACCOUNT_LIST_LIMIT_DEFAULT;
  return Math.min(Math.floor(raw), ACCOUNT_LIST_LIMIT_MAX);
}

/** Opaque keyset cursor over `(created_at, rowid)`. It encodes ONLY public ordering
 *  position (never `token_hash` or any secret) and every query that consumes it is
 *  account-scoped server-side, so a tampered cursor can at most re-page the caller's
 *  OWN account from a different offset — never cross-tenant. The values are bound as
 *  parameters (never string-interpolated), and a malformed cursor is rejected (400). */
function encodeCursor(createdAt: number, rowid: number): string {
  return btoa(`${createdAt}.${rowid}`).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function decodeCursor(raw: string): { createdAt: number; rowid: number } | null {
  try {
    const b64 = raw.replace(/-/g, "+").replace(/_/g, "/");
    const decoded = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
    const m = /^(\d{1,15})\.(\d{1,15})$/.exec(decoded);
    if (!m) return null;
    return { createdAt: Number(m[1]), rowid: Number(m[2]) };
  } catch {
    return null;
  }
}

/** Slice a `limit+1`-fetched result set into a page plus the opaque cursor for the
 *  next page (null when there's none). The off-by-one sentinel logic is identical for
 *  every keyset list endpoint, so it lives in exactly one place. */
function keysetPage<T extends { created_at: number; rid: number }>(results: T[] | undefined, limit: number): { page: T[]; nextCursor: string | null } {
  const all = results ?? [];
  const page = all.slice(0, limit);
  const last = page[page.length - 1];
  return { page, nextCursor: all.length > limit && last ? encodeCursor(last.created_at, last.rid) : null };
}

interface DeviceRow {
  rid: number;
  device_id: string;
  label: string | null;
  created_at: number;
  last_seen_at: number | null;
  expires_at: number | null;
  kind: string | null;
}

/** GET /v1/account/devices?include=cli|all&limit&cursor — the caller's devices. */
export async function accountDevices(env: Env, p: Principal, url: URL): Promise<Response> {
  const includeAll = url.searchParams.get("include") === "all";
  const limit = parseLimit(url);
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return json({ error: "bad_request", message: "invalid cursor" }, 400);

  const binds: (string | number)[] = [p.accountId];
  // The OR parentheses are LOAD-BEARING (design §2.1): without them `AND` binds
  // tighter than `OR` and every account's live web sessions would leak cross-tenant.
  let where = "revoked = 0 AND account_id = ?";
  if (includeAll) {
    where += " AND (expires_at IS NULL OR expires_at > ?)"; // durable OR a LIVE (unexpired) web session
    binds.push(Date.now());
  } else {
    where += " AND expires_at IS NULL"; // default: durable CLI devices only, not browser tabs
  }
  if (cursor) {
    where += " AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    binds.push(cursor.createdAt, cursor.createdAt, cursor.rowid);
  }
  binds.push(limit + 1); // +1 sentinel → is there a next page?

  const rows = await dirDb(env)
    .prepare(`SELECT rowid AS rid, device_id, label, created_at, last_seen_at, expires_at, kind FROM devices WHERE ${where} ORDER BY created_at ASC, rowid ASC LIMIT ?`)
    .bind(...binds)
    .all<DeviceRow>();
  const { page, nextCursor } = keysetPage(rows.results, limit);

  return json({
    devices: page.map((r) => {
      const kind = classifyKind(r.kind, r.expires_at);
      return {
        deviceId: r.device_id,
        label: r.label === null ? null : r.label.slice(0, DEVICE_LABEL_MAX),
        kind: kind === "device" ? "cli" : kind,
        createdAt: r.created_at,
        lastSeenAt: r.last_seen_at,
        isCurrent: r.device_id === p.deviceId,
      };
    }),
    nextCursor,
  });
}

interface WorkspaceRow {
  rid: number;
  workspace_id: string;
  project_id: string;
  created_at: number;
  name: string | null;
  last_commit_at: number | null;
}

/** GET /v1/account/workspaces?limit&cursor — the caller's sync roots. Under E2EE the
 *  server holds NO folder name/path; `projectId` is a PK component returned verbatim.
 *  `name` is the OPT-IN, server-visible dashboard label (default-off): null unless the
 *  first host set one at create — the deliberate, consensual metadata carve-out.
 *  `lastCommitAt` is the ADDITIVE last-activity signal (epoch ms) — MAX(created_at)
 *  over the D1 commit mirror for this workspace, null when it has never synced. It
 *  disambiguates the picker's created-vs-active time. Derived as the created_at of
 *  the MAX-sequence commit — sequence is the PK suffix AND monotonic per workspace,
 *  so the subselect is a single backward index seek per row (codex: a MAX(created_at)
 *  aggregate would scan the workspace's whole commit history — created_at is not
 *  indexed). One query, no N+1, no migration. */
export async function accountWorkspaces(env: Env, p: Principal, url: URL): Promise<Response> {
  const limit = parseLimit(url);
  const cursorRaw = url.searchParams.get("cursor");
  const cursor = cursorRaw ? decodeCursor(cursorRaw) : null;
  if (cursorRaw && !cursor) return json({ error: "bad_request", message: "invalid cursor" }, 400);

  const binds: (string | number)[] = [p.accountId];
  let where = "account_id = ?";
  if (cursor) {
    where += " AND (created_at > ? OR (created_at = ? AND rowid > ?))";
    binds.push(cursor.createdAt, cursor.createdAt, cursor.rowid);
  }
  binds.push(limit + 1);

  const rows = await dbFor(env, p.accountId)
    .prepare(
      `SELECT w.rowid AS rid, w.workspace_id, w.project_id, w.created_at, w.name,
        (SELECT c.created_at FROM commits c WHERE c.workspace_id = w.workspace_id AND c.project_id = w.project_id
          ORDER BY c.sequence DESC LIMIT 1) AS last_commit_at
       FROM workspaces w WHERE ${where} ORDER BY w.created_at ASC, w.rowid ASC LIMIT ?`
    )
    .bind(...binds)
    .all<WorkspaceRow>();
  const { page, nextCursor } = keysetPage(rows.results, limit);

  return json({
    workspaces: page.map((r) => ({
      workspaceId: r.workspace_id,
      projectId: r.project_id,
      name: r.name ?? null,
      createdAt: r.created_at,
      lastCommitAt: r.last_commit_at ?? null,
    })),
    nextCursor,
  });
}
