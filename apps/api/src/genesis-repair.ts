import type { Env } from "./env.js";
import { dbFor, dirDb } from "./db.js";
import { exactObject, json, objectWithKeys, sha256Hex, utf8Bytes } from "./util.js";
import type { JsonValue } from "../../../src/json.js";

export const GENESIS_TOMBSTONE_SENTINEL = "rbox:genesis-repair-tombstone:v1";
export const GENESIS_CAPABILITY_HEADER = "x-rbox-genesis-capability";
export const GENESIS_CAPABILITY_VALUE = "1";
export const GENESIS_REPAIR_MAX_BYTES = 2048;
export const ACCOUNT_ID_RE = /^acct_[0-9a-f]{16}$/;
export const REPAIR_ID_RE = /^gra_[0-9a-f]{32}$/;

export interface GenesisPresence {
  rosters: number;
  keyStates: number;
  devices: number;
  workspaces: number;
  workspaceKeys: number;
  e2eePairingTokens: number;
}

export interface GenesisObservationRow extends GenesisPresence {
  recoveryWrap: unknown;
  recoveryWrapId: unknown;
  claimCreatedAt: unknown;
  genesisDeviceId: unknown;
  repairId: unknown;
  repairedAt: unknown;
  claimPresent: number;
}

export interface GenesisObservationSqlRow {
  claimPresent: unknown;
  recoveryWrap: unknown;
  recoveryWrapId: unknown;
  claimCreatedAt: unknown;
  genesisDeviceId: unknown;
  repairId: unknown;
  repairedAt: unknown;
  rosters: unknown;
  keyStates: unknown;
  devices: unknown;
  workspaces: unknown;
  workspaceKeys: unknown;
  e2eePairingTokens: unknown;
}

export interface GenesisRepairRequest {
  accountId: string;
  operator: string;
  reason: string;
  dryRun: boolean;
}

export interface RepairProof {
  eligible: boolean;
  claimState: "absent" | "malformed" | "old_endpoint_exact" | "repair_tombstone_v1";
  dependents: GenesisPresence;
  ownsWorkspace: boolean;
}

export type RepairClassification = "exact_legacy_orphan" | "not_found" | "malformed_claim" | "dependent_rows" | "workspace_history" | "already_tombstoned";

/** The single verdict `classifyRepairObservation` owns: what the row is, and the proof for it. */
export interface RepairObservation {
  classification: RepairClassification;
  proof: RepairProof;
}

const count = (value: JsonValue | undefined): number => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= 0 ? n : 0;
};

/** N=1 is a binding invariant until a reviewed cross-plane fence replaces it. */
export function assertGenesisSingleDatabase(env: Env, accountId: string): void {
  if (dbFor(env, accountId) !== dirDb(env)) throw new Error("atomic genesis N=1 sharding blocker: dbFor(env, accountId) must equal dirDb(env)");
}

export const GENESIS_OBSERVATION_SQL = `SELECT
       EXISTS(SELECT 1 FROM account_keys WHERE account_id = ?1) AS claimPresent,
       (SELECT recovery_wrap FROM account_keys WHERE account_id = ?1) AS recoveryWrap,
       (SELECT recovery_wrap_id FROM account_keys WHERE account_id = ?1) AS recoveryWrapId,
       (SELECT created_at FROM account_keys WHERE account_id = ?1) AS claimCreatedAt,
       (SELECT genesis_device_id FROM account_keys WHERE account_id = ?1) AS genesisDeviceId,
       (SELECT repair_id FROM account_keys WHERE account_id = ?1) AS repairId,
       (SELECT repaired_at FROM account_keys WHERE account_id = ?1) AS repairedAt,
       (SELECT COUNT(*) FROM rosters WHERE account_id = ?1) AS rosters,
       (SELECT COUNT(*) FROM account_key_states WHERE account_id = ?1) AS keyStates,
       (SELECT COUNT(*) FROM device_keys WHERE account_id = ?1) AS devices,
       (SELECT COUNT(*) FROM workspaces WHERE account_id = ?1) AS workspaces,
       (SELECT COUNT(*) FROM workspace_keys WHERE account_id = ?1) AS workspaceKeys,
       (SELECT COUNT(*) FROM pairing_tokens WHERE account_id = ?1 AND (mk_wrap IS NOT NULL OR admission_grant IS NOT NULL)) AS e2eePairingTokens`;

export function genesisObservationFromRow<Row>(value: Row): GenesisObservationRow {
  const row = objectWithKeys(value, [
    "claimPresent", "recoveryWrap", "recoveryWrapId", "claimCreatedAt", "genesisDeviceId", "repairId", "repairedAt",
    "rosters", "keyStates", "devices", "workspaces", "workspaceKeys", "e2eePairingTokens",
  ] as const) ? value : undefined;
  return {
    claimPresent: count(row?.claimPresent), recoveryWrap: row?.recoveryWrap ?? null, recoveryWrapId: row?.recoveryWrapId ?? null,
    claimCreatedAt: row?.claimCreatedAt ?? null, genesisDeviceId: row?.genesisDeviceId ?? null, repairId: row?.repairId ?? null,
    repairedAt: row?.repairedAt ?? null, rosters: count(row?.rosters), keyStates: count(row?.keyStates), devices: count(row?.devices),
    workspaces: count(row?.workspaces), workspaceKeys: count(row?.workspaceKeys), e2eePairingTokens: count(row?.e2eePairingTokens),
  };
}

/** One account-row/count observation: a repair update cannot appear as claim absence. */
export async function readGenesisObservation(env: Env, accountId: string): Promise<GenesisObservationRow> {
  assertGenesisSingleDatabase(env, accountId);
  const row = await dbFor(env, accountId).prepare(GENESIS_OBSERVATION_SQL).bind(accountId).first<GenesisObservationSqlRow>();
  return genesisObservationFromRow(row ?? undefined);
}

export function presenceOf(row: GenesisObservationRow): GenesisPresence {
  return {
    rosters: row.rosters,
    keyStates: row.keyStates,
    devices: row.devices,
    workspaces: row.workspaces,
    workspaceKeys: row.workspaceKeys,
    e2eePairingTokens: row.e2eePairingTokens,
  };
}

export const allPresenceZero = (p: GenesisPresence): boolean => Object.values(p).every((n) => n === 0);

function boundedText<Value>(value: Value, max: number): value is Value & string {
  return typeof value === "string" && value.length > 0 && utf8Bytes(value) <= max;
}

export function isExactTombstone(row: GenesisObservationRow): boolean {
  return row.claimPresent === 1
    && row.recoveryWrap === GENESIS_TOMBSTONE_SENTINEL
    && row.recoveryWrapId === GENESIS_TOMBSTONE_SENTINEL
    && row.genesisDeviceId === null
    && typeof row.repairId === "string" && REPAIR_ID_RE.test(row.repairId)
    && typeof row.repairedAt === "number" && Number.isSafeInteger(row.repairedAt) && row.repairedAt > 0
    && typeof row.claimCreatedAt === "number" && Number.isSafeInteger(row.claimCreatedAt) && row.claimCreatedAt > 0;
}

export function isTombstoneFamily(row: GenesisObservationRow): boolean {
  return row.claimPresent === 1 && (
    row.recoveryWrap === GENESIS_TOMBSTONE_SENTINEL
    || row.recoveryWrapId === GENESIS_TOMBSTONE_SENTINEL
    || row.repairId !== null
    || row.repairedAt !== null
  );
}

export function classifyRepairObservation(row: GenesisObservationRow): RepairObservation {
  const dependents = presenceOf(row);
  const ownsWorkspace = row.workspaces > 0;
  let claimState: RepairProof["claimState"] = "malformed";
  if (row.claimPresent === 0) claimState = "absent";
  else if (isExactTombstone(row)) claimState = "repair_tombstone_v1";
  else if (
    boundedText(row.recoveryWrap, 65536)
    && boundedText(row.recoveryWrapId, 65536)
    && typeof row.claimCreatedAt === "number"
    && Number.isSafeInteger(row.claimCreatedAt)
    && row.claimCreatedAt > 0
    && row.genesisDeviceId === null
    && row.repairId === null
    && row.repairedAt === null
  ) claimState = "old_endpoint_exact";

  const eligible = claimState === "old_endpoint_exact" && allPresenceZero(dependents);
  const proof = { eligible, claimState, dependents, ownsWorkspace } satisfies RepairProof;
  if (eligible) return { classification: "exact_legacy_orphan", proof };
  if (claimState === "absent") return { classification: "not_found", proof };
  if (claimState === "repair_tombstone_v1") return { classification: "already_tombstoned", proof };
  if (ownsWorkspace) return { classification: "workspace_history", proof };
  if (!allPresenceZero(dependents)) return { classification: "dependent_rows", proof };
  return { classification: "malformed_claim", proof };
}

function cleanBounded(value: JsonValue | undefined, max: number): string | null {
  if (typeof value !== "string" || value !== value.trim() || !value || utf8Bytes(value) > max) return null;
  // eslint-disable-next-line no-control-regex -- privileged audit labels are one-line text.
  return /[\u0000-\u001f\u007f-\u009f]/.test(value) ? null : value;
}

export function validateGenesisRepairRequest(value: JsonValue): GenesisRepairRequest | null {
  if (!exactObject(value, ["accountId", "operator", "reason", "dryRun"])) return null;
  const accountId = typeof value.accountId === "string" && ACCOUNT_ID_RE.test(value.accountId) ? value.accountId : null;
  const operator = cleanBounded(value.operator, 128);
  const reason = cleanBounded(value.reason, 1024);
  return accountId && operator && reason && typeof value.dryRun === "boolean"
    ? { accountId, operator, reason, dryRun: value.dryRun }
    : null;
}

function auditId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `gra_${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

type AuditEvidenceValue = string | number | null | ArrayBuffer | ArrayBufferView;
interface GenesisRepairAuditEvidenceRow {
  account_id: AuditEvidenceValue;
  operator: AuditEvidenceValue;
  reason: AuditEvidenceValue;
  observed_classification: AuditEvidenceValue;
  proof_json: AuditEvidenceValue;
  completion_observation_json: AuditEvidenceValue;
  original_claim_present: AuditEvidenceValue;
  original_claim_snapshot: AuditEvidenceValue;
  original_recovery_wrap: AuditEvidenceValue;
  original_recovery_wrap_id: AuditEvidenceValue;
  original_created_at: AuditEvidenceValue;
  original_genesis_device_id: AuditEvidenceValue;
  original_repair_id: AuditEvidenceValue;
  original_repaired_at: AuditEvidenceValue;
}

interface GenesisRepairAuditRow extends GenesisRepairAuditEvidenceRow {
  outcome: string;
}

/** The post-attempt record persisted in `completion_observation_json` (and echoed to the caller). */
interface RepairAuditObservation {
  observational: true;
  eligible?: boolean;
  claimState: RepairProof["claimState"];
  dependents: GenesisPresence;
  ownsWorkspace: boolean;
}

function canonicalEvidence(row: GenesisRepairAuditEvidenceRow): string {
  const fields = ["account_id", "operator", "reason", "observed_classification", "proof_json", "completion_observation_json", "original_claim_present", "original_claim_snapshot", "original_recovery_wrap", "original_recovery_wrap_id", "original_created_at", "original_genesis_device_id", "original_repair_id", "original_repaired_at"] as const satisfies readonly (keyof GenesisRepairAuditEvidenceRow)[];
  return fields.map((key) => {
    const value = row[key];
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
    const encoded = value === null || value === undefined ? "null" : bytes ? `blob:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}` : typeof value === "string" ? value : JSON.stringify(value);
    return `${key.length}:${key}${encoded.length}:${encoded}`;
  }).join("");
}

async function completeAudit(env: Env, accountId: string, id: string, outcome: string, vector: string | null, observation: RepairAuditObservation | null): Promise<void> {
  const db = dbFor(env, accountId);
  const row = await db.prepare("SELECT * FROM genesis_repair_audit WHERE audit_id = ? AND account_id = ?").bind(id, accountId).first<GenesisRepairAuditRow>();
  if (!row || row.outcome !== "attempted") return;
  const digest = await sha256Hex(canonicalEvidence({ ...row, completion_observation_json: observation === null ? null : JSON.stringify(observation) }));
  await db.prepare(
    `UPDATE genesis_repair_audit SET outcome = ?, result_vector = ?, completion_observation_json = ?, completed_at = ?, scrubbed_evidence_sha256 = ?
     WHERE audit_id = ? AND account_id = ? AND outcome = 'attempted'`
  ).bind(outcome, vector, observation === null ? null : JSON.stringify(observation), Date.now(), digest, id, accountId).run();
}

/** Finish stranded rows before any claim/tombstone mutation destroys their evidence. */
export async function reconcileGenesisRepairAudits(env: Env, accountId: string): Promise<void> {
  const db = dbFor(env, accountId);
  const rows = await db.prepare(
    "SELECT audit_id,dry_run FROM genesis_repair_audit WHERE account_id = ? AND outcome = 'attempted' ORDER BY requested_at,audit_id"
  ).bind(accountId).all<{ audit_id: string; dry_run: number }>();
  for (const row of rows.results ?? []) {
    if (row.dry_run === 1) {
      await completeAudit(env, accountId, row.audit_id, "dry_run_incomplete", null, null);
      continue;
    }
    const current = await readGenesisObservation(env, accountId);
    if (isExactTombstone(current) && current.repairId === row.audit_id) {
      await completeAudit(env, accountId, row.audit_id, "tombstone_claim_installed", "audit=1,update=1", null);
    } else {
      const observed = classifyRepairObservation(current).proof;
      await completeAudit(env, accountId, row.audit_id, "refused", "audit=1,update=0", { observational: true, ...observed });
    }
  }
}

export async function deletionLedgerBlocks(env: Env, accountId: string): Promise<boolean> {
  return !!(await dbFor(env, accountId).prepare(
    "SELECT 1 FROM account_deletions WHERE account_id = ? AND status IN ('purging','done')"
  ).bind(accountId).first());
}

export async function tombstoneFenceResponse(env: Env, accountId: string): Promise<Response | null> {
  if (await deletionLedgerBlocks(env, accountId)) return json({ error: "account_erased" }, 410);
  const row = await dbFor(env, accountId).prepare(
    `SELECT 1 FROM account_keys WHERE account_id = ? AND
      (recovery_wrap = ? OR recovery_wrap_id = ? OR repair_id IS NOT NULL OR repaired_at IS NOT NULL)`
  ).bind(accountId, GENESIS_TOMBSTONE_SENTINEL, GENESIS_TOMBSTONE_SENTINEL).first();
  return row ? json({ error: "repair_in_progress" }, 423) : null;
}

const proofSql = `
  typeof(recovery_wrap) = 'text' AND length(CAST(recovery_wrap AS BLOB)) BETWEEN 1 AND 65536 AND
  typeof(recovery_wrap_id) = 'text' AND length(CAST(recovery_wrap_id AS BLOB)) BETWEEN 1 AND 65536 AND
  typeof(created_at) = 'integer' AND created_at > 0 AND genesis_device_id IS NULL AND repair_id IS NULL AND repaired_at IS NULL AND
  NOT EXISTS (SELECT 1 FROM rosters WHERE account_id = ?1) AND
  NOT EXISTS (SELECT 1 FROM account_key_states WHERE account_id = ?1) AND
  NOT EXISTS (SELECT 1 FROM device_keys WHERE account_id = ?1) AND
  NOT EXISTS (SELECT 1 FROM workspace_keys WHERE account_id = ?1) AND
  NOT EXISTS (SELECT 1 FROM pairing_tokens WHERE account_id = ?1 AND (mk_wrap IS NOT NULL OR admission_grant IS NOT NULL)) AND
  NOT EXISTS (SELECT 1 FROM workspaces WHERE account_id = ?1)`;

export interface GenesisRepairTestHooks{beforeExecuteBatch?:()=>Promise<void>;afterExecuteBatch?:()=>Promise<void>}
export async function genesisRepair(env: Env, pathAccountId: string, body: GenesisRepairRequest, auditRetry = 0, hooks?:GenesisRepairTestHooks): Promise<Response> {
  if (pathAccountId !== body.accountId) return json({ error: "bad_request_shape" }, 400);
  const accountId = body.accountId;
  assertGenesisSingleDatabase(env, accountId);
  await reconcileGenesisRepairAudits(env, accountId);
  const initial = await readGenesisObservation(env, accountId);
  const classified = classifyRepairObservation(initial);
  const id = auditId();
  const now = Date.now();
  const proofJson = JSON.stringify(classified.proof);
  const db = dbFor(env, accountId);
  const snapshotSql = `printf('%d:', EXISTS(SELECT 1 FROM account_keys WHERE account_id = ?1)) ||
    COALESCE(typeof((SELECT recovery_wrap FROM account_keys WHERE account_id = ?1)) || ':' || hex(CAST((SELECT recovery_wrap FROM account_keys WHERE account_id = ?1) AS BLOB)), 'null') || '|' ||
    COALESCE(typeof((SELECT recovery_wrap_id FROM account_keys WHERE account_id = ?1)) || ':' || hex(CAST((SELECT recovery_wrap_id FROM account_keys WHERE account_id = ?1) AS BLOB)), 'null') || '|' ||
    COALESCE(typeof((SELECT created_at FROM account_keys WHERE account_id = ?1)) || ':' || hex(CAST((SELECT created_at FROM account_keys WHERE account_id = ?1) AS BLOB)), 'null') || '|' ||
    COALESCE(typeof((SELECT genesis_device_id FROM account_keys WHERE account_id = ?1)) || ':' || hex(CAST((SELECT genesis_device_id FROM account_keys WHERE account_id = ?1) AS BLOB)), 'null') || '|' ||
    COALESCE(typeof((SELECT repair_id FROM account_keys WHERE account_id = ?1)) || ':' || hex(CAST((SELECT repair_id FROM account_keys WHERE account_id = ?1) AS BLOB)), 'null') || '|' ||
    COALESCE(typeof((SELECT repaired_at FROM account_keys WHERE account_id = ?1)) || ':' || hex(CAST((SELECT repaired_at FROM account_keys WHERE account_id = ?1) AS BLOB)), 'null')`;

  if (body.dryRun) {
    const inserted = await db.prepare(
      `INSERT INTO genesis_repair_audit
       (audit_id,account_id,operator,reason,requested_at,dry_run,observed_classification,proof_json,
        original_claim_present,original_claim_snapshot,original_recovery_wrap,original_recovery_wrap_id,
        original_created_at,original_genesis_device_id,original_repair_id,original_repaired_at,outcome)
       SELECT ?2,?1,?3,?4,?5,1,?6,?7,
        EXISTS(SELECT 1 FROM account_keys WHERE account_id=?1),${snapshotSql},
        CAST((SELECT recovery_wrap FROM account_keys WHERE account_id=?1) AS BLOB),
        CAST((SELECT recovery_wrap_id FROM account_keys WHERE account_id=?1) AS BLOB),
        (SELECT created_at FROM account_keys WHERE account_id=?1),(SELECT genesis_device_id FROM account_keys WHERE account_id=?1),
        (SELECT repair_id FROM account_keys WHERE account_id=?1),(SELECT repaired_at FROM account_keys WHERE account_id=?1),'attempted'
       WHERE NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id=?1 AND status IN ('purging','done'))`
    ).bind(accountId, id, body.operator, body.reason, now, classified.classification, proofJson).run();
    if ((inserted.meta.changes ?? 0) === 0) return json({ ok: false, dryRun: true, classification: "account_erased", result: "refused" }, 410);
    await completeAudit(env, accountId, id, classified.classification, null, null);
    if (classified.proof.eligible) return json({ ok: true, dryRun: true, auditId: id, classification: classified.classification, proof: classified.proof, result: "no_change" });
    return json({ ok: false, dryRun: true, auditId: id, classification: classified.classification, proof: classified.proof, result: "refused" }, 409);
  }

  if(auditRetry===0)await hooks?.beforeExecuteBatch?.();
  const results = await db.batch([
    db.prepare(
      `INSERT INTO genesis_repair_audit
       (audit_id,account_id,operator,reason,requested_at,dry_run,observed_classification,proof_json,
        original_claim_present,original_claim_snapshot,original_recovery_wrap,original_recovery_wrap_id,
        original_created_at,original_genesis_device_id,original_repair_id,original_repaired_at,outcome)
       SELECT ?2,?1,?3,?4,?5,0,?6,?7,
        EXISTS(SELECT 1 FROM account_keys WHERE account_id = ?1), ${snapshotSql},
        CAST((SELECT recovery_wrap FROM account_keys WHERE account_id = ?1) AS BLOB),
        CAST((SELECT recovery_wrap_id FROM account_keys WHERE account_id = ?1) AS BLOB),
        (SELECT created_at FROM account_keys WHERE account_id = ?1),
        (SELECT genesis_device_id FROM account_keys WHERE account_id = ?1),
        (SELECT repair_id FROM account_keys WHERE account_id = ?1),
        (SELECT repaired_at FROM account_keys WHERE account_id = ?1),'attempted'
       WHERE NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ?1 AND status IN ('purging','done'))`
    ).bind(accountId, id, body.operator, body.reason, now, classified.classification, proofJson),
    db.prepare(
      `UPDATE account_keys SET recovery_wrap = ?3, recovery_wrap_id = ?3, repair_id = ?2, repaired_at = ?4
       WHERE account_id = ?1 AND ${proofSql}
       AND EXISTS (SELECT 1 FROM genesis_repair_audit WHERE audit_id = ?2 AND account_id = ?1 AND outcome = 'attempted')
       AND CAST(recovery_wrap AS BLOB) = (SELECT original_recovery_wrap FROM genesis_repair_audit WHERE audit_id=?2)
       AND CAST(recovery_wrap_id AS BLOB) = (SELECT original_recovery_wrap_id FROM genesis_repair_audit WHERE audit_id=?2)
       AND created_at IS (SELECT original_created_at FROM genesis_repair_audit WHERE audit_id=?2)
       AND genesis_device_id IS (SELECT original_genesis_device_id FROM genesis_repair_audit WHERE audit_id=?2)
       AND repair_id IS (SELECT original_repair_id FROM genesis_repair_audit WHERE audit_id=?2)
       AND repaired_at IS (SELECT original_repaired_at FROM genesis_repair_audit WHERE audit_id=?2)
       AND NOT EXISTS (SELECT 1 FROM genesis_repair_audit WHERE account_id = ?1 AND outcome = 'attempted' AND audit_id <> ?2)
       AND NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ?1 AND status IN ('purging','done'))`
    ).bind(accountId, id, GENESIS_TOMBSTONE_SENTINEL, now),
  ]);
  if(auditRetry===0)await hooks?.afterExecuteBatch?.();
  const vector = `audit=${results[0]?.meta.changes ?? 0},update=${results[1]?.meta.changes ?? 0}`;
  if (vector === "audit=0,update=0") return json({ ok: false, dryRun: false, classification: "account_erased", result: "refused" }, 410);
  if (vector === "audit=1,update=1") {
    await completeAudit(env, accountId, id, "tombstone_claim_installed", vector, null);
    return json({ ok: true, dryRun: false, auditId: id, classification: "exact_legacy_orphan", proof: classified.proof, result: "tombstone_claim_installed", repairId: id, repairedAt: now });
  }
  const competingAttempt = await db.prepare(
    "SELECT 1 FROM genesis_repair_audit WHERE account_id = ? AND outcome = 'attempted' AND audit_id <> ? LIMIT 1"
  ).bind(accountId, id).first();
  const postRow=await readGenesisObservation(env,accountId),post = classifyRepairObservation(postRow).proof;
  const completedCompetitor=isExactTombstone(postRow)?await db.prepare("SELECT audit_id FROM genesis_repair_audit WHERE account_id=? AND audit_id=? AND audit_id<>? AND outcome='tombstone_claim_installed' AND completed_at IS NOT NULL LIMIT 1").bind(accountId,postRow.repairId,id).first<{audit_id:string}>():null;
  const observation: RepairAuditObservation = { observational: true, claimState: post.claimState, dependents: post.dependents, ownsWorkspace: post.ownsWorkspace };
  await completeAudit(env, accountId, id, "refused", vector, observation);
  if (competingAttempt || completedCompetitor || post.eligible) {
    await reconcileGenesisRepairAudits(env, accountId);
    if(auditRetry>0&&completedCompetitor)return json({ok:true,dryRun:false,auditId:completedCompetitor.audit_id,classification:"already_tombstoned",result:"tombstone_claim_installed",repairId:completedCompetitor.audit_id,repairedAt:postRow.repairedAt});
    if (auditRetry >= 8) return json({ ok: false, dryRun: false, classification: "repair_audit_busy", result: "refused" }, 503);
    return genesisRepair(env, pathAccountId, body, auditRetry + 1, hooks);
  }
  return json({ ok: false, dryRun: false, auditId: id, classification: "repair_refused_state_changed", observation, result: "refused" }, 409);
}

export const noAttemptedAuditSql = "NOT EXISTS (SELECT 1 FROM genesis_repair_audit WHERE account_id = ? AND outcome = 'attempted')";
export const noErasureSql = "NOT EXISTS (SELECT 1 FROM account_deletions WHERE account_id = ? AND status IN ('purging','done'))";
