import type { Env } from "../env.js";
import { sha256Hex } from "../util.js";
import type { Principal } from "../authz.js";
import { dbFor, dirDb } from "../db.js";

const LAST_SEEN_THROTTLE_MS = 10 * 60 * 1000;

const TOKEN_RE = /^[0-9a-f]{64}$/; // 32 bytes hex

/** Validate a bearer token → the full Principal (device + account + user + role).
 *  Throttled last_seen update. Role comes from the membership; a device with no
 *  membership (legacy) gets least-privilege 'viewer'. */
export async function authenticate(req: Request, env: Env): Promise<Principal | null> {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return null;
  const token = header.slice(7);
  if (!TOKEN_RE.test(token)) return null; // reject malformed before hashing
  const hash = await sha256Hex(token);
  // expires_at is now SELECTed (not just used in the WHERE) so we can derive the
  // token KIND (design 21 §1.1): durable CLI token (expires_at IS NULL) vs a
  // short-lived browser web session. The worker default-denies `web` off every
  // crypto/sync/credential-mint route.
  const row = await dirDb(env)
    .prepare(
      `SELECT d.device_id, d.account_id, d.user_id, d.last_seen_at, d.expires_at, m.role AS role
       FROM devices d LEFT JOIN memberships m ON m.account_id = d.account_id AND m.user_id = d.user_id
       WHERE d.token_hash = ? AND d.revoked = 0 AND (d.expires_at IS NULL OR d.expires_at > ?)`
    )
    .bind(hash, Date.now())
    .first<{ device_id: string; account_id: string; user_id: string | null; last_seen_at: number | null; expires_at: number | null; role: string | null }>();
  if (!row) return null;
  // design 37: a token is valid ONLY if its account row EXISTS and is not tombstoned
  // (deleted_at IS NULL) — so a tombstoned account, OR an orphan device whose account row is
  // gone (a redeem that raced the purge), rejects EVERY token (fail-closed). Account state is the
  // ACCOUNT-DATA plane (dbFor), so this is a SEPARATE point read on the resolved account, never a
  // cross-plane JOIN with the directory-plane device lookup above. The legacy platform account
  // 'default' (which may have no `accounts` row) is the sole exception.
  if (row.account_id !== "default") {
    const acct = await dbFor(env, row.account_id).prepare("SELECT deleted_at FROM accounts WHERE id = ?").bind(row.account_id).first<{ deleted_at: number | null }>();
    if (!acct || acct.deleted_at !== null) return null;
  }
  const now = Date.now();
  if (!row.last_seen_at || now - row.last_seen_at > LAST_SEEN_THROTTLE_MS) {
    await dirDb(env).prepare("UPDATE devices SET last_seen_at = ? WHERE token_hash = ?").bind(now, hash).run().catch(() => {});
  }
  return { deviceId: row.device_id, accountId: row.account_id, userId: row.user_id, role: row.role ?? "viewer", kind: row.expires_at === null ? "durable" : "web" };
}
