import type { Env } from "./env.js";
import { exactObject, json, utf8Bytes } from "./util.js";
import type { Principal } from "./authz.js";
import { dbFor } from "./db.js";
import {
  GENESIS_CAPABILITY_VALUE,
  GENESIS_TOMBSTONE_SENTINEL,
  REPAIR_ID_RE,
  deletionLedgerBlocks,
  isExactTombstone,
  isTombstoneFamily,
  presenceOf,
  readGenesisObservation,
  reconcileGenesisRepairAudits,
  tombstoneFenceResponse,
} from "./genesis-repair.js";

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
export const KEY_BOOTSTRAP_MAX_BYTES = 4 * 1024 * 1024;
export const KEY_DEVICE_MAX_BYTES = 2 * 1024 * 1024;
export const KEY_ROSTER_MAX_BYTES = 512 * 1024;
export const KEY_ADMIT_MAX_BYTES = 2 * 1024 * 1024;
export const KEY_STATE_MAX_BYTES = 512 * 1024;
export const KEY_WORKSPACE_MAX_BYTES = 1024 * 1024;

/** A bounded opaque string field, or null if missing/oversized/non-string. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 && utf8Bytes(v) <= MAX_FIELD ? v : null;
}
/** A non-negative safe integer, or null. */
function nat(v: unknown): number | null {
  return typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= Number.MAX_SAFE_INTEGER ? v : null;
}

export function validateKeyBootstrapBody(value: unknown): Record<string, unknown> | null {
  if (!exactObject(value, ["recoveryWrap", "recoveryWrapId", "genesisRoster", "genesisKeyState", "device"])
    && !exactObject(value, ["recoveryWrap", "recoveryWrapId", "genesisRoster", "genesisKeyState", "device", "repairId"])) return null;
  if (Object.hasOwn(value, "repairId") && (typeof value.repairId !== "string" || !REPAIR_ID_RE.test(value.repairId))) return null;
  if (!str(value.recoveryWrap) || !str(value.recoveryWrapId) || !str(value.genesisRoster) || !str(value.genesisKeyState)) return null;
  if (!exactObject(value.device, ["deviceId", "sigPubKey", "encPubKey", "mkWrap"])) return null;
  return str(value.device.deviceId) && str(value.device.sigPubKey) && str(value.device.encPubKey) && str(value.device.mkWrap) ? value : null;
}

export function validateKeyDeviceBody(value: unknown): Record<string, unknown> | null {
  if (!exactObject(value, ["deviceId", "sigPubKey", "encPubKey", "mkWrap"])) return null;
  return str(value.deviceId) && str(value.sigPubKey) && str(value.encPubKey) && str(value.mkWrap) ? value : null;
}

export function validateKeyRosterBody(value: unknown): Record<string, unknown> | null {
  return exactObject(value, ["version", "signed"]) && nat(value.version) !== null && !!str(value.signed) ? value : null;
}

export function validateKeyAdmitBody(value: unknown): Record<string, unknown> | null {
  if (!exactObject(value, ["device", "roster"])) return null;
  if (!exactObject(value.device, ["deviceId", "sigPubKey", "encPubKey", "mkWrap"])) return null;
  if (!exactObject(value.roster, ["version", "signed"])) return null;
  return str(value.device.deviceId)
    && str(value.device.sigPubKey)
    && str(value.device.encPubKey)
    && str(value.device.mkWrap)
    && nat(value.roster.version) !== null
    && str(value.roster.signed)
    ? value
    : null;
}

export function validateKeyStateBody(value: unknown): Record<string, unknown> | null {
  return exactObject(value, ["accountEpoch", "signed"]) && nat(value.accountEpoch) !== null && !!str(value.signed) ? value : null;
}

export function validateWorkspaceKeyBody(value: unknown): Record<string, unknown> | null {
  return exactObject(value, ["workspaceId", "keyEpoch", "kekWrap"])
    && !!str(value.workspaceId)
    && nat(value.keyEpoch) !== null
    && !!str(value.kekWrap)
    ? value
    : null;
}

/** Does this workspace belong to the caller's account? (account-scoped authz.) */
async function ownsWorkspace(env: Env, accountId: string, workspaceId: string): Promise<boolean> {
  const row = await dbFor(env, accountId)
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
export async function bootstrapAccountKeys(env: Env, p: Principal, body: unknown, genesisCapability?: string | null, auditRetry = 0): Promise<Response> {
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
  const repairId = typeof b.repairId === "string" && REPAIR_ID_RE.test(b.repairId) ? b.repairId : null;
  if (!recoveryWrap || !recoveryWrapId || !genesisRoster || !genesisKeyState || !deviceId || !sigPubKey || !encPubKey || !mkWrap) {
    return json({ error: "bad_request", message: "missing or oversized field" }, 400);
  }
  // The bootstrapping device must be the authenticated caller's own device.
  if (deviceId !== p.deviceId) return json({ error: "forbidden", message: "device mismatch" }, 403);

  await reconcileGenesisRepairAudits(env, p.accountId);
  const before = await readGenesisObservation(env, p.accountId);
  if (isTombstoneFamily(before)) {
    if (!repairId || !isExactTombstone(before) || before.repairId !== repairId) return json({ error: "repair_in_progress" }, 423);
    if (genesisCapability !== GENESIS_CAPABILITY_VALUE) {
      return json({ error: "genesis_capability_required", requiredHeader: "x-rbox-genesis-capability", requiredValue: "1" }, 428);
    }
  }

  const db = dbFor(env, p.accountId);
  const now = Date.now();
  const noAudit = "NOT EXISTS (SELECT 1 FROM genesis_repair_audit WHERE account_id = ?1 AND outcome = 'attempted')";
  const noErase = "NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ?1 AND status IN ('purging','done'))";
  let results: D1Result<unknown>[];
  if (!repairId) {
    const noClaim = "NOT EXISTS (SELECT 1 FROM account_keys WHERE account_id = ?1)";
    const noChildren = `NOT EXISTS (SELECT 1 FROM rosters WHERE account_id = ?1) AND NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id = ?1)
      AND NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id = ?1) AND NOT EXISTS (SELECT 1 FROM workspace_keys WHERE account_id = ?1)
      AND NOT EXISTS (SELECT 1 FROM workspaces WHERE account_id = ?1)
      AND NOT EXISTS (SELECT 1 FROM pairing_tokens WHERE account_id = ?1 AND (mk_wrap IS NOT NULL OR admission_grant IS NOT NULL))`;
    const claim = "EXISTS (SELECT 1 FROM account_keys WHERE account_id = ?1 AND recovery_wrap = ?2 AND recovery_wrap_id = ?3 AND created_at = ?4 AND genesis_device_id = ?5 AND repair_id IS NULL AND repaired_at IS NULL)";
    results = await db.batch([
      db.prepare(`INSERT INTO account_keys (account_id,recovery_wrap,recovery_wrap_id,created_at,genesis_device_id)
        SELECT ?1,?2,?3,?4,?5 WHERE ${noClaim} AND ${noChildren} AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId, recoveryWrap, recoveryWrapId, now, deviceId),
      db.prepare(`INSERT INTO rosters (account_id,version,signed,created_at) SELECT ?1,0,?6,?4
        WHERE ${claim} AND ${noChildren} AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId, recoveryWrap, recoveryWrapId, now, deviceId, genesisRoster),
      db.prepare(`INSERT INTO account_key_states (account_id,account_epoch,signed,created_at) SELECT ?1,0,?7,?4
        WHERE ${claim} AND EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND version=0 AND signed=?6 AND created_at=?4)
        AND NOT EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND NOT(version=0 AND signed=?6 AND created_at=?4))
        AND NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id=?1)
        AND NOT EXISTS (SELECT 1 FROM workspace_keys WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM workspaces WHERE account_id=?1)
        AND NOT EXISTS (SELECT 1 FROM pairing_tokens WHERE account_id=?1 AND (mk_wrap IS NOT NULL OR admission_grant IS NOT NULL)) AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId, recoveryWrap, recoveryWrapId, now, deviceId, genesisRoster, genesisKeyState),
      db.prepare(`INSERT INTO device_keys (device_id,account_id,sig_pubkey,enc_pubkey,mk_wrap,created_at) SELECT ?5,?1,?8,?9,?10,?4
        WHERE ${claim} AND EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND version=0 AND signed=?6 AND created_at=?4)
        AND EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1 AND account_epoch=0 AND signed=?7 AND created_at=?4)
        AND NOT EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND NOT(version=0 AND signed=?6 AND created_at=?4))
        AND NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1 AND NOT(account_epoch=0 AND signed=?7 AND created_at=?4))
        AND NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM workspace_keys WHERE account_id=?1)
        AND NOT EXISTS (SELECT 1 FROM workspaces WHERE account_id=?1)
        AND NOT EXISTS (SELECT 1 FROM pairing_tokens WHERE account_id=?1 AND (mk_wrap IS NOT NULL OR admission_grant IS NOT NULL)) AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId, recoveryWrap, recoveryWrapId, now, deviceId, genesisRoster, genesisKeyState, sigPubKey, encPubKey, mkWrap),
    ]);
  } else {
    const tomb = `EXISTS (SELECT 1 FROM account_keys WHERE account_id=?1 AND recovery_wrap=?11 AND recovery_wrap_id=?11
      AND genesis_device_id IS NULL AND repair_id=?12 AND repaired_at IS NOT NULL)`;
    const noWs = `NOT EXISTS (SELECT 1 FROM workspace_keys WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM workspaces WHERE account_id=?1)
      AND NOT EXISTS (SELECT 1 FROM pairing_tokens WHERE account_id=?1 AND (mk_wrap IS NOT NULL OR admission_grant IS NOT NULL))`;
    results = await db.batch([
      db.prepare(`INSERT INTO rosters (account_id,version,signed,created_at) SELECT ?1,0,?6,?4 WHERE ${tomb}
        AND NOT EXISTS (SELECT 1 FROM rosters WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1)
        AND NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id=?1) AND ${noWs} AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId,recoveryWrap,recoveryWrapId,now,deviceId,genesisRoster,genesisKeyState,sigPubKey,encPubKey,mkWrap,GENESIS_TOMBSTONE_SENTINEL,repairId),
      db.prepare(`INSERT INTO account_key_states (account_id,account_epoch,signed,created_at) SELECT ?1,0,?7,?4 WHERE ${tomb}
        AND EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND version=0 AND signed=?6 AND created_at=?4)
        AND NOT EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND NOT(version=0 AND signed=?6 AND created_at=?4))
        AND NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1) AND NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id=?1)
        AND ${noWs} AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId,recoveryWrap,recoveryWrapId,now,deviceId,genesisRoster,genesisKeyState,sigPubKey,encPubKey,mkWrap,GENESIS_TOMBSTONE_SENTINEL,repairId),
      db.prepare(`INSERT INTO device_keys (device_id,account_id,sig_pubkey,enc_pubkey,mk_wrap,created_at) SELECT ?5,?1,?8,?9,?10,?4 WHERE ${tomb}
        AND EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND version=0 AND signed=?6 AND created_at=?4)
        AND EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1 AND account_epoch=0 AND signed=?7 AND created_at=?4)
        AND NOT EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND NOT(version=0 AND signed=?6 AND created_at=?4))
        AND NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1 AND NOT(account_epoch=0 AND signed=?7 AND created_at=?4))
        AND NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id=?1) AND ${noWs} AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId,recoveryWrap,recoveryWrapId,now,deviceId,genesisRoster,genesisKeyState,sigPubKey,encPubKey,mkWrap,GENESIS_TOMBSTONE_SENTINEL,repairId),
      db.prepare(`UPDATE account_keys SET recovery_wrap=?2,recovery_wrap_id=?3,genesis_device_id=?5,repair_id=NULL,repaired_at=NULL WHERE account_id=?1
        AND recovery_wrap=?11 AND recovery_wrap_id=?11 AND genesis_device_id IS NULL AND repair_id=?12 AND repaired_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM rosters WHERE account_id=?1 AND version=0 AND signed=?6 AND created_at=?4)
        AND EXISTS (SELECT 1 FROM account_key_states WHERE account_id=?1 AND account_epoch=0 AND signed=?7 AND created_at=?4)
        AND EXISTS (SELECT 1 FROM device_keys WHERE account_id=?1 AND device_id=?5 AND sig_pubkey=?8 AND enc_pubkey=?9 AND mk_wrap=?10 AND created_at=?4)
        AND (SELECT COUNT(*) FROM rosters WHERE account_id=?1)=1 AND (SELECT COUNT(*) FROM account_key_states WHERE account_id=?1)=1
        AND (SELECT COUNT(*) FROM device_keys WHERE account_id=?1)=1 AND ${noWs} AND ${noAudit} AND ${noErase}`)
        .bind(p.accountId,recoveryWrap,recoveryWrapId,now,deviceId,genesisRoster,genesisKeyState,sigPubKey,encPubKey,mkWrap,GENESIS_TOMBSTONE_SENTINEL,repairId),
    ]);
  }
  const vector = results.map((r) => r.meta.changes ?? 0).join("/");
  if (vector === "1/1/1/1") return json({ ok: true });
  if (await deletionLedgerBlocks(env, p.accountId)) return json({ error: "account_erased" }, 410);
  const attempted = await db.prepare(
    "SELECT 1 FROM genesis_repair_audit WHERE account_id = ? AND outcome = 'attempted' LIMIT 1"
  ).bind(p.accountId).first();
  if (attempted) {
    await reconcileGenesisRepairAudits(env, p.accountId);
    if (auditRetry >= 8) return json({ error: "genesis_audit_busy" }, 503);
    return bootstrapAccountKeys(env, p, body, genesisCapability, auditRetry + 1);
  }
  await reconcileGenesisRepairAudits(env, p.accountId);
  const current = await readGenesisObservation(env, p.accountId);
  if (isTombstoneFamily(current)) return json({ error: "repair_in_progress" }, 423);

  const exact = await db.prepare(
    `SELECT 1 FROM account_keys a JOIN rosters r ON r.account_id=a.account_id AND r.version=0
      JOIN account_key_states k ON k.account_id=a.account_id AND k.account_epoch=0
      JOIN device_keys d ON d.account_id=a.account_id AND d.device_id=?2
     WHERE a.account_id=?1 AND a.repair_id IS NULL AND a.repaired_at IS NULL
       AND a.recovery_wrap=?3 AND a.recovery_wrap_id=?4 AND r.signed=?5 AND k.signed=?6
       AND d.sig_pubkey=?7 AND d.enc_pubkey=?8 AND d.mk_wrap=?9
       AND (a.genesis_device_id=?2 OR (a.genesis_device_id IS NULL AND a.created_at=r.created_at AND a.created_at=k.created_at
         AND a.created_at=d.created_at AND (SELECT COUNT(*) FROM device_keys x WHERE x.account_id=?1 AND x.created_at=a.created_at)=1))`
  ).bind(p.accountId,deviceId,recoveryWrap,recoveryWrapId,genesisRoster,genesisKeyState,sigPubKey,encPubKey,mkWrap).first();
  return exact ? json({ ok: true, idempotent: true }) : json({ error: "already_bootstrapped" }, 409);
}

/**
 * GET /v1/keys/account — everything a device needs to reconstruct + verify the
 * account's key world: recovery wrap, full roster history, full key-state chain,
 * and every device's public keys + MK wrap. All account-scoped, all opaque.
 */
export async function getAccountKeys(env: Env, p: Principal): Promise<Response> {
  await reconcileGenesisRepairAudits(env, p.accountId);
  const observed = await readGenesisObservation(env, p.accountId);
  const present = presenceOf(observed);
  if (observed.claimPresent === 0) return json({ error: "not_found", genesisPresenceVersion: 1, present }, 404);

  const rosters = await dbFor(env, p.accountId).prepare("SELECT signed FROM rosters WHERE account_id = ? ORDER BY version").bind(p.accountId).all<{ signed: string }>();
  const keyStates = await dbFor(env, p.accountId).prepare("SELECT signed FROM account_key_states WHERE account_id = ? ORDER BY account_epoch").bind(p.accountId).all<{ signed: string }>();
  const devices = await dbFor(env, p.accountId)
    .prepare("SELECT device_id, sig_pubkey, enc_pubkey, mk_wrap FROM device_keys WHERE account_id = ? ORDER BY created_at")
    .bind(p.accountId)
    .all<{ device_id: string; sig_pubkey: string | null; enc_pubkey: string | null; mk_wrap: string | null }>();

  return json({
    genesisPresenceVersion: 1,
    recoveryWrap: observed.recoveryWrap,
    recoveryWrapId: observed.recoveryWrapId,
    claimCreatedAt: observed.claimCreatedAt,
    genesisDeviceId: observed.genesisDeviceId,
    rosters: (rosters.results ?? []).map((r) => r.signed),
    keyStates: (keyStates.results ?? []).map((r) => r.signed),
    devices: (devices.results ?? []).map((d) => ({ deviceId: d.device_id, sigPubkey: d.sig_pubkey, encPubkey: d.enc_pubkey, mkWrap: d.mk_wrap })),
    present,
    repairTombstone: isExactTombstone(observed) ? { version: 1, repairId: observed.repairId, repairedAt: observed.repairedAt } : null,
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
  const preflight = await tombstoneFenceResponse(env, p.accountId);
  if (preflight) return preflight;
  const res = await dbFor(env, p.accountId)
    .prepare(`INSERT OR IGNORE INTO device_keys (device_id,account_id,sig_pubkey,enc_pubkey,mk_wrap,created_at)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL)
      AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=? AND status IN ('purging','done'))`)
    .bind(deviceId,p.accountId,sigPubKey,encPubKey,mkWrap,Date.now(),p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL,p.accountId).run();
  if ((res.meta.changes ?? 0) === 0) {
    const fence = await tombstoneFenceResponse(env, p.accountId);
    if (fence) return fence;
    const real=await dbFor(env,p.accountId).prepare(`SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL`).bind(p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL).first();
    if(!real)return json({error:"account_keys_missing"},409);
    const existing=await dbFor(env,p.accountId).prepare("SELECT 1 FROM device_keys WHERE device_id=? AND account_id=?").bind(deviceId,p.accountId).first();
    if(!existing)return json({error:"device_write_conflict"},409);
  }
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
  const res = await dbFor(env, p.accountId)
    .prepare(
      `INSERT INTO rosters (account_id, version, signed, created_at)
       SELECT ?, ?, ?, ?
       WHERE (SELECT COALESCE(MAX(version), -1) + 1 FROM rosters WHERE account_id = ?) = ?
       AND EXISTS (SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=? AND status IN ('purging','done'))`
    )
    .bind(p.accountId,version,signed,Date.now(),p.accountId,version,p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL,p.accountId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return (await tombstoneFenceResponse(env,p.accountId)) ?? json({ error: "conflict", message: "roster version not next" }, 409);
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
  const res = await dbFor(env, p.accountId)
    .prepare(
      `INSERT INTO account_key_states (account_id, account_epoch, signed, created_at)
       SELECT ?, ?, ?, ?
       WHERE (SELECT COALESCE(MAX(account_epoch), -1) + 1 FROM account_key_states WHERE account_id = ?) = ?
       AND EXISTS (SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL)
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=? AND status IN ('purging','done'))`
    )
    .bind(p.accountId,accountEpoch,signed,Date.now(),p.accountId,accountEpoch,p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL,p.accountId)
    .run();
  if ((res.meta.changes ?? 0) === 0) return (await tombstoneFenceResponse(env,p.accountId)) ?? json({ error: "conflict", message: "epoch not next" }, 409);
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
  const preflight = await tombstoneFenceResponse(env,p.accountId);
  if (preflight) return preflight;
  if (!(await ownsWorkspace(env, p.accountId, workspaceId))) return json({ error: "not_found" }, 404);
  const inserted = await dbFor(env,p.accountId).prepare(`INSERT OR IGNORE INTO workspace_keys (workspace_id,account_id,key_epoch,kek_wrap,created_at)
    SELECT ?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=? AND status IN ('purging','done'))`)
    .bind(workspaceId,p.accountId,keyEpoch,kekWrap,Date.now(),p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL,p.accountId).run();
  if ((inserted.meta.changes ?? 0) === 0) {
    const fence = await tombstoneFenceResponse(env,p.accountId);
    if (fence) return fence;
    const real=await dbFor(env,p.accountId).prepare(`SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL`).bind(p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL).first();
    if(!real)return json({error:"account_keys_missing"},409);
  }
  // Read back the winning wrap (D1 serializes writes, so this is the value that
  // survived the CAS — ours iff we were first-writer, else the pre-existing one).
  const row = await dbFor(env, p.accountId)
    .prepare("SELECT kek_wrap FROM workspace_keys WHERE workspace_id = ? AND key_epoch = ?")
    .bind(workspaceId, keyEpoch)
    .first<{ kek_wrap: string }>();
  return row?json({keyEpoch,kekWrap:row.kek_wrap}):json({error:"account_keys_missing"},409);
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
  const mutationGuard = `EXISTS (SELECT 1 FROM account_keys WHERE account_id=? AND recovery_wrap<>? AND recovery_wrap_id<>? AND repair_id IS NULL AND repaired_at IS NULL)
    AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=? AND status IN ('purging','done'))`;
  const results = await dbFor(env, p.accountId).batch([
    // Device first — its guard sees MAX(version) before the roster append below.
    dbFor(env, p.accountId)
      .prepare(`INSERT INTO device_keys (device_id, account_id, sig_pubkey, enc_pubkey, mk_wrap, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE ${guard} AND ${mutationGuard}`)
      .bind(deviceId,p.accountId,sigPubKey,encPubKey,mkWrap,now,p.accountId,version,p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL,p.accountId),
    dbFor(env, p.accountId)
      .prepare(`INSERT INTO rosters (account_id, version, signed, created_at) SELECT ?, ?, ?, ? WHERE ${guard} AND ${mutationGuard}`)
      .bind(p.accountId,version,signed,now,p.accountId,version,p.accountId,GENESIS_TOMBSTONE_SENTINEL,GENESIS_TOMBSTONE_SENTINEL,p.accountId),
  ]);
  // Roster guard matched zero rows → version wasn't next → nothing applied. Client
  // refetches, rebuilds the roster parent/version (reusing its keypair), retries.
  if ((results[1]?.meta.changes ?? 0) === 0) return (await tombstoneFenceResponse(env,p.accountId)) ?? json({ error: "conflict", message: "roster version not next" }, 409);
  return json({ ok: true, version });
}

/**
 * GET /v1/keys/workspace/:workspaceId — the KEK wraps for a workspace, ordered by
 * epoch. Account-scoped (404 if not the caller's workspace).
 */
export async function getWorkspaceKeys(env: Env, p: Principal, workspaceId: string): Promise<Response> {
  if (!(await ownsWorkspace(env, p.accountId, workspaceId))) return json({ error: "not_found" }, 404);
  const rows = await dbFor(env, p.accountId)
    .prepare("SELECT key_epoch, kek_wrap FROM workspace_keys WHERE workspace_id = ? ORDER BY key_epoch")
    .bind(workspaceId)
    .all<{ key_epoch: number; kek_wrap: string }>();
  return json({ keys: (rows.results ?? []).map((r) => ({ keyEpoch: r.key_epoch, kekWrap: r.kek_wrap })) });
}
