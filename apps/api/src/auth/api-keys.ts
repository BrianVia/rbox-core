import type { Env } from "../env.js";
import { audit, sanitizeWorkspaceName, type Principal } from "../authz.js";
import { dirDb } from "../db.js";
import { isUniqueViolation } from "./shared.js";
import { json, SHA256_HEX_RE } from "../util.js";
import { revokeDevice } from "./devices.js";
import { readPlan } from "./mint.js";
import { isPaidPlan } from "../plans.js";
import { PAT_MAX_TTL_MS } from "../../../../src/engine/pat-token.js";

const API_KEY_CAP = 5;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,96}$/;
const DISPLAY_PREFIX_MAX = 80;
const LABEL_MAX = 200;

function subscribeRequired(): Response {
  return json({ error: "subscription_required", message: "agent keys require an active plan — run `rbox subscribe`" }, 403);
}

/**
 * POST /v1/keys/api — create a PAT auth row + descriptive sidecar.
 * The client generated the secret and sends only sha256(full PAT), never the PAT.
 */
export async function createApiKey(env: Env, p: Principal, body: unknown, now = Date.now()): Promise<Response> {
  if (p.kind !== "device") return json({ error: "forbidden" }, 403);
  if (!p.userId) return json({ error: "forbidden", message: "key creation requires a user membership" }, 403);

  // authenticate() already rejects tombstoned accounts before this route reads plan state.
  const plan = await readPlan(env, p.accountId);
  if (!isPaidPlan(plan)) return subscribeRequired();

  const b = (body ?? {}) as Record<string, unknown>;
  const tokenHash = typeof b.tokenHash === "string" && SHA256_HEX_RE.test(b.tokenHash) ? b.tokenHash : null;
  const deviceId = typeof b.deviceId === "string" && DEVICE_ID_RE.test(b.deviceId) ? b.deviceId : null;
  const expiresAt = typeof b.expiresAt === "number" && Number.isInteger(b.expiresAt) ? b.expiresAt : null;
  const displayPrefix = sanitizeWorkspaceName(typeof b.displayPrefix === "string" ? b.displayPrefix : null, DISPLAY_PREFIX_MAX);
  const label = sanitizeWorkspaceName(typeof b.label === "string" ? b.label : null, LABEL_MAX);
  if (!tokenHash || !deviceId || !displayPrefix || expiresAt === null) return json({ error: "bad_request", message: "tokenHash, deviceId, displayPrefix, and expiresAt are required" }, 400);
  if (expiresAt <= now || expiresAt > now + PAT_MAX_TTL_MS) return json({ error: "bad_request", message: "expiresAt must be in the future and no more than 1 year out" }, 400);

  try {
    const results = await dirDb(env).batch([
      dirDb(env)
        .prepare(
          `INSERT INTO devices (token_hash, device_id, label, account_id, user_id, created_at, expires_at, kind)
           SELECT ?, ?, ?, ?, ?, ?, ?, 'api_key'
           WHERE (SELECT COUNT(*) FROM devices WHERE account_id = ? AND kind = 'api_key' AND revoked = 0 AND expires_at > ?) < ?
             AND EXISTS (SELECT 1 FROM accounts WHERE id = ? AND deleted_at IS NULL)`
        )
        .bind(tokenHash, deviceId, label, p.accountId, p.userId, now, expiresAt, p.accountId, now, API_KEY_CAP, p.accountId),
      dirDb(env)
        .prepare(
          `INSERT INTO api_keys (token_hash, account_id, created_by, display_prefix, enrolled, created_at)
           SELECT ?, ?, ?, ?, ?, ?
           WHERE EXISTS (SELECT 1 FROM devices WHERE token_hash = ? AND account_id = ? AND kind = 'api_key')`
        )
        .bind(tokenHash, p.accountId, p.userId, displayPrefix, b.enrolled === false ? 0 : 1, now, tokenHash, p.accountId),
    ]);
    if ((results[0]?.meta.changes ?? 0) === 0) return json({ error: "too_many_api_keys", cap: API_KEY_CAP }, 429);
    await audit(env, p, "api_key.create", deviceId);
    return json({ ok: true, deviceId, expiresAt });
  } catch (e) {
    if (isUniqueViolation(e)) return json({ error: "conflict", message: "tokenHash or deviceId already exists" }, 409);
    throw e;
  }
}

export async function listApiKeys(env: Env, p: Principal): Promise<Response> {
  if (p.kind === "api_key") return json({ error: "forbidden_for_api_key" }, 403);
  const rows = await dirDb(env)
    .prepare(
      `SELECT d.device_id, d.label, d.created_at, d.last_seen_at, d.expires_at, d.revoked, k.display_prefix
       FROM api_keys k JOIN devices d ON d.token_hash = k.token_hash
       WHERE k.account_id = ? AND d.account_id = ?
       ORDER BY d.created_at ASC`
    )
    .bind(p.accountId, p.accountId)
    .all<{ device_id: string; label: string | null; display_prefix: string; created_at: number; last_seen_at: number | null; expires_at: number; revoked: number }>();
  return json({
    keys: (rows.results ?? []).map((r) => ({
      deviceId: r.device_id,
      label: r.label,
      displayPrefix: r.display_prefix,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      revoked: r.revoked === 1,
    })),
  });
}

export async function revokeApiKey(env: Env, p: Principal, deviceId: string): Promise<Response> {
  if (p.kind === "api_key") return json({ error: "forbidden_for_api_key" }, 403);
  const row = await dirDb(env)
    .prepare(
      `SELECT d.device_id FROM api_keys k JOIN devices d ON d.token_hash = k.token_hash
       WHERE d.account_id = ? AND d.device_id = ? AND d.kind = 'api_key'`
    )
    .bind(p.accountId, deviceId)
    .first<{ device_id: string }>();
  if (!row) return json({ error: "not_found" }, 404);
  return revokeDevice(env, p, deviceId);
}

export { API_KEY_CAP };
