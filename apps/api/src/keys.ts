import type { Env } from "./env.js";
import { json } from "./util.js";
import type { Principal } from "./authz.js";

/**
 * E2EE key storage/serving (design 12, v4) — a DUMB ZERO-KNOWLEDGE STORE.
 *
 * Every value here is an OPAQUE client-produced blob: a signed roster/key-state
 * envelope, or a wrap of MK/KEK. The server NEVER parses or verifies the crypto —
 * clients verify the whole chain from genesis. We only: (a) bound field sizes so a
 * tenant can't store arbitrarily large payloads, (b) account-scope every read/write
 * via the Principal, and (c) enforce monotone append (version/epoch) so an attacker
 * can't fork the history server-side. Nothing else is interpreted.
 */

const MAX_FIELD = 64 * 1024; // 64KB per opaque TEXT field — generous for wraps/envelopes

/** A bounded opaque string field, or null if missing/oversized/non-string. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= MAX_FIELD ? v : null;
}
/** A non-negative safe integer, or null. */
function nat(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null;
}

/** Does this workspace belong to the caller's account? (account-scoped authz.) */
async function ownsWorkspace(env: Env, accountId: string, workspaceId: string): Promise<boolean> {
  const row = await env.rbox_dev_db
    .prepare("SELECT 1 FROM workspaces WHERE workspace_id = ? AND account_id = ? LIMIT 1")
    .bind(workspaceId, accountId)
    .first();
  return !!row;
}

/**
 * POST /v1/keys/bootstrap — seed an account's genesis key material exactly once.
 * Stores the recovery wrap, the genesis roster (v0), the genesis key-state (epoch
 * 0), and the bootstrapping device's keys. The device MUST be the caller's own
 * device (anti-spoof). 409 if already bootstrapped (idempotency, not overwrite).
 */
export async function bootstrapAccountKeys(env: Env, p: Principal, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const recoveryWrap = str(b.recoveryWrap);
  const recoveryWrapId = str(b.recoveryWrapId);
  const genesisRoster = str(b.genesisRoster);
  const genesisKeyState = str(b.genesisKeyState);
  const device = (b.device ?? {}) as Record<string, unknown>;
  const deviceId = str(device.deviceId);
  const sigPubKey = str(device.sigPubKey);
  const encPubKey = str(device.encPubKey);
  const mkWrap = str(device.mkWrap);
  if (!recoveryWrap || !recoveryWrapId || !genesisRoster || !genesisKeyState || !deviceId || !sigPubKey || !encPubKey || !mkWrap) {
    return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  }
  // The bootstrapping device must be the authenticated caller's own device.
  if (deviceId !== p.deviceId) return json({ error: "forbidden", message: "device mismatch" }, 403);

  const now = Date.now();
  // Claim the account_keys row first; changes===0 means already bootstrapped.
  const claim = await env.rbox_dev_db
    .prepare("INSERT OR IGNORE INTO account_keys (account_id, recovery_wrap, recovery_wrap_id, created_at) VALUES (?, ?, ?, ?)")
    .bind(p.accountId, recoveryWrap, recoveryWrapId, now)
    .run();
  if ((claim.meta.changes ?? 0) === 0) return json({ error: "already_bootstrapped" }, 409);

  // Genesis roster (v0) + genesis key-state (epoch 0) + the device's keys.
  await env.rbox_dev_db.batch([
    env.rbox_dev_db.prepare("INSERT OR IGNORE INTO rosters (account_id, version, signed, created_at) VALUES (?, 0, ?, ?)").bind(p.accountId, genesisRoster, now),
    env.rbox_dev_db.prepare("INSERT OR IGNORE INTO account_key_states (account_id, account_epoch, signed, created_at) VALUES (?, 0, ?, ?)").bind(p.accountId, genesisKeyState, now),
    env.rbox_dev_db
      .prepare("INSERT OR IGNORE INTO device_keys (device_id, account_id, sig_pubkey, enc_pubkey, mk_wrap, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(deviceId, p.accountId, sigPubKey, encPubKey, mkWrap, now),
  ]);
  return json({ ok: true });
}

/**
 * GET /v1/keys/account — everything a device needs to reconstruct + verify the
 * account's key world: recovery wrap, full roster history, full key-state chain,
 * and every device's public keys + MK wrap. All account-scoped, all opaque.
 */
export async function getAccountKeys(env: Env, p: Principal): Promise<Response> {
  const acct = await env.rbox_dev_db
    .prepare("SELECT recovery_wrap, recovery_wrap_id FROM account_keys WHERE account_id = ?")
    .bind(p.accountId)
    .first<{ recovery_wrap: string | null; recovery_wrap_id: string | null }>();
  if (!acct) return json({ error: "not_found" }, 404);

  const rosters = await env.rbox_dev_db.prepare("SELECT signed FROM rosters WHERE account_id = ? ORDER BY version").bind(p.accountId).all<{ signed: string }>();
  const keyStates = await env.rbox_dev_db.prepare("SELECT signed FROM account_key_states WHERE account_id = ? ORDER BY account_epoch").bind(p.accountId).all<{ signed: string }>();
  const devices = await env.rbox_dev_db
    .prepare("SELECT device_id, sig_pubkey, enc_pubkey, mk_wrap FROM device_keys WHERE account_id = ? ORDER BY created_at")
    .bind(p.accountId)
    .all<{ device_id: string; sig_pubkey: string | null; enc_pubkey: string | null; mk_wrap: string | null }>();

  return json({
    recoveryWrap: acct.recovery_wrap,
    recoveryWrapId: acct.recovery_wrap_id,
    rosters: (rosters.results ?? []).map((r) => r.signed),
    keyStates: (keyStates.results ?? []).map((r) => r.signed),
    devices: (devices.results ?? []).map((d) => ({ deviceId: d.device_id, sigPubkey: d.sig_pubkey, encPubkey: d.enc_pubkey, mkWrap: d.mk_wrap })),
  });
}

/**
 * POST /v1/keys/device — register a device's public keys + MK wrap (idempotent).
 * Account-scoped: the row is bound to the caller's account. INSERT OR IGNORE so a
 * repeated publish is a no-op (the keys are immutable once recorded).
 */
export async function putDeviceKeys(env: Env, p: Principal, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const deviceId = str(b.deviceId);
  const sigPubKey = str(b.sigPubKey);
  const encPubKey = str(b.encPubKey);
  const mkWrap = str(b.mkWrap);
  if (!deviceId || !sigPubKey || !encPubKey || !mkWrap) return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  await env.rbox_dev_db
    .prepare("INSERT OR IGNORE INTO device_keys (device_id, account_id, sig_pubkey, enc_pubkey, mk_wrap, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(deviceId, p.accountId, sigPubKey, encPubKey, mkWrap, Date.now())
    .run();
  return json({ ok: true });
}

/**
 * POST /v1/keys/roster — append the next signed roster. The new version MUST be
 * exactly (current max)+1; the conditional INSERT…SELECT makes the check+append
 * atomic (D1 serializes writes), so two concurrent appends can't both win the
 * same version. changes===0 → 409 (someone else advanced; client refetches).
 */
export async function appendRoster(env: Env, p: Principal, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const version = nat(b.version);
  const signed = str(b.signed);
  if (version === null || !signed) return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  const res = await env.rbox_dev_db
    .prepare(
      `INSERT INTO rosters (account_id, version, signed, created_at)
       SELECT ?, ?, ?, ?
       WHERE (SELECT COALESCE(MAX(version), -1) + 1 FROM rosters WHERE account_id = ?) = ?`
    )
    .bind(p.accountId, version, signed, Date.now(), p.accountId, version)
    .run();
  if ((res.meta.changes ?? 0) === 0) return json({ error: "conflict", message: "roster version not next" }, 409);
  return json({ ok: true, version });
}

/**
 * POST /v1/keys/keystate — append the next signed account-key-state. Same
 * monotone-append discipline as rosters, keyed by accountEpoch.
 */
export async function appendKeyState(env: Env, p: Principal, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const accountEpoch = nat(b.accountEpoch);
  const signed = str(b.signed);
  if (accountEpoch === null || !signed) return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  const res = await env.rbox_dev_db
    .prepare(
      `INSERT INTO account_key_states (account_id, account_epoch, signed, created_at)
       SELECT ?, ?, ?, ?
       WHERE (SELECT COALESCE(MAX(account_epoch), -1) + 1 FROM account_key_states WHERE account_id = ?) = ?`
    )
    .bind(p.accountId, accountEpoch, signed, Date.now(), p.accountId, accountEpoch)
    .run();
  if ((res.meta.changes ?? 0) === 0) return json({ error: "conflict", message: "epoch not next" }, 409);
  return json({ ok: true, accountEpoch });
}

/**
 * POST /v1/keys/workspace — store a per-(workspace, keyEpoch) KEK wrap as an
 * immutable CAS (design 12, C3). Account-scoped: refuses unless the workspace
 * belongs to the caller (404 to avoid an enumeration leak). INSERT OR IGNORE
 * keeps an already-published epoch wrap immutable; we then SELECT and return the
 * STORED winning wrap (the pre-existing one if this caller lost the race), so two
 * devices that independently generated a KEK for the same epoch converge on one —
 * the loser adopts the returned wrap and discards its own. Never an UPDATE.
 */
export async function putWorkspaceKey(env: Env, p: Principal, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const workspaceId = str(b.workspaceId);
  const keyEpoch = nat(b.keyEpoch);
  const kekWrap = str(b.kekWrap);
  if (!workspaceId || keyEpoch === null || !kekWrap) return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  if (!(await ownsWorkspace(env, p.accountId, workspaceId))) return json({ error: "not_found" }, 404);
  await env.rbox_dev_db
    .prepare("INSERT OR IGNORE INTO workspace_keys (workspace_id, account_id, key_epoch, kek_wrap, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(workspaceId, p.accountId, keyEpoch, kekWrap, Date.now())
    .run();
  // Read back the winning wrap (D1 serializes writes, so this is the value that
  // survived the CAS — ours iff we were first-writer, else the pre-existing one).
  const row = await env.rbox_dev_db
    .prepare("SELECT kek_wrap FROM workspace_keys WHERE workspace_id = ? AND key_epoch = ?")
    .bind(workspaceId, keyEpoch)
    .first<{ kek_wrap: string }>();
  return json({ keyEpoch, kekWrap: row?.kek_wrap ?? kekWrap });
}

/**
 * POST /v1/keys/admit (design 12, C5) — atomic device-admission: insert the new
 * device's keys AND append the roster that references them in ONE D1 batch (a
 * single transaction), so a crash can never leave a roster pointing at a device
 * wrap the server never stored. Body: { device:{...}, roster:{version,signed} }.
 *
 * Both statements carry the SAME monotone-version guard (version === current
 * max+1). The device insert is ordered FIRST so its guard reads MAX(version)
 * BEFORE the roster append advances it; if the version isn't next, BOTH guards
 * match zero rows → the batch commits nothing (no orphan device row) and we 409.
 */
export async function admitDevice(env: Env, p: Principal, body: unknown): Promise<Response> {
  const b = (body ?? {}) as Record<string, unknown>;
  const device = (b.device ?? {}) as Record<string, unknown>;
  const roster = (b.roster ?? {}) as Record<string, unknown>;
  const deviceId = str(device.deviceId);
  const sigPubKey = str(device.sigPubKey);
  const encPubKey = str(device.encPubKey);
  const mkWrap = str(device.mkWrap);
  const version = nat(roster.version);
  const signed = str(roster.signed);
  if (!deviceId || !sigPubKey || !encPubKey || !mkWrap || version === null || !signed) {
    return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  }
  const now = Date.now();
  const guard = `(SELECT COALESCE(MAX(version), -1) + 1 FROM rosters WHERE account_id = ?) = ?`;
  const results = await env.rbox_dev_db.batch([
    // Device first — its guard sees MAX(version) before the roster append below.
    env.rbox_dev_db
      .prepare(`INSERT INTO device_keys (device_id, account_id, sig_pubkey, enc_pubkey, mk_wrap, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard}`)
      .bind(deviceId, p.accountId, sigPubKey, encPubKey, mkWrap, now, p.accountId, version),
    env.rbox_dev_db
      .prepare(`INSERT INTO rosters (account_id, version, signed, created_at) SELECT ?, ?, ?, ? WHERE ${guard}`)
      .bind(p.accountId, version, signed, now, p.accountId, version),
  ]);
  // Roster guard matched zero rows → version wasn't next → nothing applied. Client
  // refetches, rebuilds the roster parent/version (reusing its keypair), retries.
  if ((results[1]?.meta.changes ?? 0) === 0) return json({ error: "conflict", message: "roster version not next" }, 409);
  return json({ ok: true, version });
}

/**
 * GET /v1/keys/workspace/:workspaceId — the KEK wraps for a workspace, ordered by
 * epoch. Account-scoped (404 if not the caller's workspace).
 */
export async function getWorkspaceKeys(env: Env, p: Principal, workspaceId: string): Promise<Response> {
  if (!(await ownsWorkspace(env, p.accountId, workspaceId))) return json({ error: "not_found" }, 404);
  const rows = await env.rbox_dev_db
    .prepare("SELECT key_epoch, kek_wrap FROM workspace_keys WHERE workspace_id = ? ORDER BY key_epoch")
    .bind(workspaceId)
    .all<{ key_epoch: number; kek_wrap: string }>();
  return json({ keys: (rows.results ?? []).map((r) => ({ keyEpoch: r.key_epoch, kekWrap: r.kek_wrap })) });
}
