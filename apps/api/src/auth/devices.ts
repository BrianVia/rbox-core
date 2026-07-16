import type { Env } from "../env.js";
import { json } from "../util.js";
import { audit, type Principal } from "../authz.js";
import { dbFor, dirDb } from "../db.js";

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
 * most one row. A `changes==0` outcome is then disambiguated by a follow-up READ
 * (purely to pick the status code — it never gates the write): unknown-in-my-account
 * → 404 (uniform with cross-account, no enumeration leak), already-revoked →
 * idempotent 200, otherwise insufficient role → 403.
 */
export async function revokeDevice(env: Env, self: Principal, deviceId: string): Promise<Response> {
  const privileged = self.role === "owner" || self.role === "admin" ? 1 : 0;
  const res = await dirDb(env)
    .prepare("UPDATE devices SET revoked = 1 WHERE device_id = ? AND account_id = ? AND revoked = 0 AND (device_id = ? OR ? = 1)")
    .bind(deviceId, self.accountId, self.deviceId, privileged)
    .run();
  // The in-statement guard makes cleanup cross-account safe and retry-safe when
  // the device was already revoked by an earlier attempt.
  await dbFor(env, self.accountId)
    .prepare(`DELETE FROM device_sync_state WHERE device_id = ?1
      AND EXISTS (SELECT 1 FROM devices WHERE device_id = ?1 AND account_id = ?2 AND revoked = 1)`)
    .bind(deviceId, self.accountId)
    .run();
  if ((res.meta.changes ?? 0) === 1) {
    await audit(env, self, deviceId === self.deviceId ? "device.revoke.self" : "device.revoke", deviceId);
    return json({ ok: true, revoked: 1 });
  }
  // changes==0: choose the response without leaking cross-account existence.
  const row = await dirDb(env)
    .prepare("SELECT revoked FROM devices WHERE device_id = ? AND account_id = ?")
    .bind(deviceId, self.accountId)
    .first<{ revoked: number }>();
  if (!row) return json({ error: "not_found" }, 404); // no such device in MY account (== cross-account)
  if (row.revoked === 1) return json({ ok: true, revoked: 0 }); // already revoked → idempotent, no audit spam
  return json({ error: "forbidden", message: "insufficient role to revoke another device" }, 403);
}
