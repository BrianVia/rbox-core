import type { Env } from "../env.js";
import { json } from "../util.js";
import { audit, type Principal } from "../authz.js";
import { dbFor, dirDb } from "../db.js";

/** Correlated SQL guard shared by every key-delivery transition. */
export function activeDeviceExistsSql(deliveryAlias = "key_delivery"): string {
  return `EXISTS (
    SELECT 1 FROM devices key_delivery_target
    WHERE key_delivery_target.device_id=${deliveryAlias}.target_device_id
      AND key_delivery_target.account_id=${deliveryAlias}.account_id
      AND key_delivery_target.revoked=0
  )`;
}

// GET /v1/auth/devices  (authed) -> device list, SCOPED to the caller's account.
export async function listDevices(env: Env, self: Principal): Promise<Response> {
  const rows = await dirDb(env)
    .prepare("SELECT device_id, label, created_at, last_seen_at, last_seen_version FROM devices WHERE revoked = 0 AND account_id = ? ORDER BY created_at")
    .bind(self.accountId)
    .all<{ device_id: string; label: string | null; created_at: number; last_seen_at: number | null; last_seen_version: string | null }>();
  return json({ devices: (rows.results ?? []).map((r) => ({ ...r, isSelf: r.device_id === self.deviceId })) });
}

/**
 * POST /v1/auth/devices/:deviceId/revoke (authed, design 19a / design 22 §4.1).
 *
 * ACCESS revocation only — it flips `devices.revoked` so the token 401s on its next
 * call, but it does NOT cryptographically evict the device's cached MK/KEKs (E2EE
 * epoch rotation is unbuilt, design 22 §1.3/§4.2). Callers surface that ceiling in
 * the UI; the server makes no claim beyond "the token is dead."
 *
 * Authorization is an ATOMIC guarded UPDATE (no SELECT-then-write race): any role
 * may revoke ITS OWN device; only owner/admin may revoke ANOTHER device in the
 * account. `device_id` is globally unique (migration 0013), so the WHERE matches at
 * most one row. A follow-up directory-plane READ authorizes retry-safe data-plane
 * cleanup and, when `changes==0`, chooses the response: unknown-in-my-account → 404
 * (uniform with cross-account, no enumeration leak), already-revoked → idempotent
 * 200, otherwise insufficient role → 403.
 */
export async function revokeDevice(env: Env, self: Principal, deviceId: string): Promise<Response> {
  const privileged = self.role === "owner" || self.role === "admin" ? 1 : 0;
  const db = dirDb(env);
  const [res] = await db.batch([
    db.prepare("UPDATE devices SET revoked = 1 WHERE device_id = ? AND account_id = ? AND revoked = 0 AND (device_id = ? OR ? = 1)")
      .bind(deviceId, self.accountId, self.deviceId, privileged),
    db.prepare(
      `UPDATE key_delivery
       SET state='expired',wrap_blob=NULL,published_roster_version=NULL
       WHERE target_device_id=? AND account_id=? AND state IN ('queued','fulfilled')
         AND EXISTS (
           SELECT 1 FROM devices d
           WHERE d.device_id=? AND d.account_id=?
             AND (d.device_id=? OR ?=1)
         )`,
    ).bind(deviceId, self.accountId, deviceId, self.accountId, self.deviceId, privileged),
    db.prepare(
      `DELETE FROM device_token_escrow
       WHERE request_id IN (
         SELECT request_id FROM key_delivery
         WHERE target_device_id=? AND account_id=? AND state='expired'
       )`,
    ).bind(deviceId, self.accountId),
  ]);
  // Read authorization state from the directory plane, then clean up on the
  // account's data plane. An already-revoked authorized retry still cleans up.
  const row = await dirDb(env)
    .prepare("SELECT revoked FROM devices WHERE device_id = ? AND account_id = ?")
    .bind(deviceId, self.accountId)
    .first<{ revoked: number }>();
  if (row?.revoked === 1) {
    const data = dbFor(env, self.accountId);
    await data.batch([
      data.prepare("DELETE FROM device_sync_state WHERE device_id = ?").bind(deviceId),
      data.prepare("DELETE FROM alert_state WHERE device_id = ?").bind(deviceId),
    ]);
  }
  if ((res?.meta.changes ?? 0) === 1) {
    await audit(env, self, deviceId === self.deviceId ? "device.revoke.self" : "device.revoke", deviceId);
    return json({ ok: true, revoked: 1 });
  }
  // changes==0: choose the response without leaking cross-account existence.
  if (!row) return json({ error: "not_found" }, 404); // no such device in MY account (== cross-account)
  if (row.revoked === 1) return json({ ok: true, revoked: 0 }); // already revoked → idempotent, no audit spam
  return json({ error: "forbidden", message: "insufficient role to revoke another device" }, 403);
}
