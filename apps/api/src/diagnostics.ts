import { readBodyCapped } from "./util.js";
import type { Env } from "./env.js";
import { emit, OpSpan } from "./metrics.js";
import { dbFor } from "./db.js";
import type { Principal } from "./authz.js";
import { json, logErr, sha256Hex } from "./util.js";

const BODY_CAP_BYTES = 600 * 1024;
const DAEMON_LOG_CAP_BYTES = 128 * 1024;
const SECTION_STRING_CAP_BYTES = 2 * 1024;
const RATE_WINDOW_MS = 24 * 60 * 60 * 1000;
const RATE_LIMIT = 5;
export const DIAGNOSTICS_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const PENDING_RETENTION_MS = 60 * 60 * 1000;
const SWEEP_LIMIT = 200;

const TOP_KEYS = ["version", "platform", "bunVersion", "checks", "daemonLogTail", "metrics", "activity", "workspaceShape"] as const;
const REQUIRED_CHECK_KEYS = ["credentials", "enrollment", "daemon", "remote", "version", "state"] as const;
const OPTIONAL_CHECK_KEYS = ["device", "crypto", "locking", "git", "chain"] as const;
const CHECK_KEYS = [...REQUIRED_CHECK_KEYS, ...OPTIONAL_CHECK_KEYS] as const;
const CHECK_RESULT_KEYS = ["ok", "label", "message", "hint", "latencyMs", "status", "current", "latest", "pid"] as const;
const PLATFORM_KEYS = ["os", "arch"] as const;
const METRICS_KEYS = ["syncs", "commitConflicts409", "fileConflicts", "lockStarved", "lastConflictAt", "excluded", "truncated", "originalBytes"] as const;
const ACTIVITY_KEYS = ["at", "lastPush", "lastPull", "active", "halt", "excluded", "truncated", "originalBytes"] as const;
const WORKSPACE_SHAPE_KEYS = ["fileCount", "totalBytes"] as const;

type JsonRecord = Record<string, unknown>;
type ValidationResult = { ok: true; value: JsonRecord } | { ok: false; message: string };

export interface DiagnosticsDeps {
  putReport: (env: Env, key: string, body: string) => Promise<void>;
  deleteReport: (env: Env, key: string) => Promise<void>;
}

export const REAL_DIAGNOSTICS_DEPS: DiagnosticsDeps = {
  putReport: (env, key, body) => env.rbox_dev_blobs.put(key, body, { httpMetadata: { contentType: "application/json" } }).then(() => undefined),
  deleteReport: (env, key) => env.rbox_dev_blobs.delete(key).then(() => undefined),
};

export function isRecord(v: unknown): v is JsonRecord {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function badShape(message: string): Response {
  return json({ error: "bad_shape", message }, 400);
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

function truncateUtf8(s: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(s);
  if (bytes.byteLength <= maxBytes) return s;
  return new TextDecoder().decode(bytes.slice(0, maxBytes));
}

function assertOnlyKeys(obj: JsonRecord, allowed: readonly string[], name: string): string | null {
  for (const k of Object.keys(obj)) {
    if (!allowed.includes(k)) return `${name} contains unknown key ${k}`;
  }
  return null;
}

function requireKeys(obj: JsonRecord, keys: readonly string[], name: string): string | null {
  for (const k of keys) {
    if (!(k in obj)) return `${name} missing ${k}`;
  }
  return null;
}

function boundedString(v: unknown, name: string, maxBytes = SECTION_STRING_CAP_BYTES): { ok: true; value: string } | { ok: false; message: string } {
  if (typeof v !== "string") return { ok: false, message: `${name} must be a string` };
  return { ok: true, value: truncateUtf8(v, maxBytes) };
}

function safeNumber(v: unknown, name: string): { ok: true; value: number } | { ok: false; message: string } {
  if (typeof v !== "number" || !Number.isFinite(v) || !Number.isSafeInteger(v) || v < 0) return { ok: false, message: `${name} must be a non-negative safe integer` };
  return { ok: true, value: v };
}

function validateExcluded(v: JsonRecord, name: string): JsonRecord | null {
  if (typeof v.excluded !== "string") return null;
  if (Object.keys(v).length !== 1) throw new Error(`${name} excluded section has extra keys`);
  return { excluded: truncateUtf8(v.excluded, SECTION_STRING_CAP_BYTES) };
}

function validatePlatform(v: unknown): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: "platform must be an object" };
  const unknown = assertOnlyKeys(v, PLATFORM_KEYS, "platform") ?? requireKeys(v, PLATFORM_KEYS, "platform");
  if (unknown) return { ok: false, message: unknown };
  const os = boundedString(v.os, "platform.os", 64);
  if (!os.ok) return os;
  const arch = boundedString(v.arch, "platform.arch", 64);
  if (!arch.ok) return arch;
  return { ok: true, value: { os: os.value, arch: arch.value } };
}

function validateCheckResult(v: unknown, name: string): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: `${name} must be an object` };
  const unknown = assertOnlyKeys(v, CHECK_RESULT_KEYS, name);
  if (unknown) return { ok: false, message: unknown };
  if (typeof v.ok !== "boolean") return { ok: false, message: `${name}.ok must be boolean` };
  const out: JsonRecord = { ok: v.ok };
  for (const key of ["label", "message", "hint", "status", "current", "latest"] as const) {
    if (v[key] === undefined) continue;
    const s = boundedString(v[key], `${name}.${key}`);
    if (!s.ok) return s;
    out[key] = s.value;
  }
  for (const key of ["latencyMs", "pid"] as const) {
    if (v[key] === undefined) continue;
    const n = safeNumber(v[key], `${name}.${key}`);
    if (!n.ok) return n;
    out[key] = n.value;
  }
  return { ok: true, value: out };
}

function validateChecks(v: unknown): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: "checks must be an object" };
  const unknown = assertOnlyKeys(v, CHECK_KEYS, "checks") ?? requireKeys(v, REQUIRED_CHECK_KEYS, "checks");
  if (unknown) return { ok: false, message: unknown };
  const out: JsonRecord = {};
  for (const key of CHECK_KEYS) {
    if (!(key in v)) continue;
    const r = validateCheckResult(v[key], `checks.${key}`);
    if (!r.ok) return r;
    out[key] = r.value;
  }
  return { ok: true, value: out };
}

function validateMetrics(v: unknown): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: "metrics must be an object" };
  try {
    const excluded = validateExcluded(v, "metrics");
    if (excluded) return { ok: true, value: excluded };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const unknown = assertOnlyKeys(v, METRICS_KEYS, "metrics");
  if (unknown) return { ok: false, message: unknown };
  const out: JsonRecord = {};
  for (const key of ["syncs", "commitConflicts409", "fileConflicts", "lockStarved", "originalBytes"] as const) {
    if (v[key] === undefined) continue;
    const n = safeNumber(v[key], `metrics.${key}`);
    if (!n.ok) return n;
    out[key] = n.value;
  }
  if (v.lastConflictAt !== undefined) {
    const s = boundedString(v.lastConflictAt, "metrics.lastConflictAt");
    if (!s.ok) return s;
    out.lastConflictAt = s.value;
  }
  if (v.truncated !== undefined) {
    if (typeof v.truncated !== "boolean") return { ok: false, message: "metrics.truncated must be boolean" };
    out.truncated = v.truncated;
  }
  return { ok: true, value: out };
}

function validateNestedObject(v: unknown, name: string, spec: Record<string, "string" | "number" | readonly string[]>): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: `${name} must be an object` };
  const allowed = Object.keys(spec);
  const unknown = assertOnlyKeys(v, allowed, name);
  if (unknown) return { ok: false, message: unknown };
  const out: JsonRecord = {};
  for (const [key, rule] of Object.entries(spec)) {
    if (v[key] === undefined) continue;
    if (rule === "string") {
      const s = boundedString(v[key], `${name}.${key}`);
      if (!s.ok) return s;
      out[key] = s.value;
    } else if (rule === "number") {
      const n = safeNumber(v[key], `${name}.${key}`);
      if (!n.ok) return n;
      out[key] = n.value;
    } else {
      if (typeof v[key] !== "string" || !rule.includes(v[key] as string)) return { ok: false, message: `${name}.${key} has invalid value` };
      out[key] = v[key];
    }
  }
  return { ok: true, value: out };
}

function validateActivity(v: unknown): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: "activity must be an object" };
  try {
    const excluded = validateExcluded(v, "activity");
    if (excluded) return { ok: true, value: excluded };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const unknown = assertOnlyKeys(v, ACTIVITY_KEYS, "activity");
  if (unknown) return { ok: false, message: unknown };
  const out: JsonRecord = {};
  if (v.at !== undefined) {
    const s = boundedString(v.at, "activity.at");
    if (!s.ok) return s;
    out.at = s.value;
  }
  if (v.lastPush !== undefined) {
    const r = validateNestedObject(v.lastPush, "activity.lastPush", { at: "string", files: "number", sequence: "number" });
    if (!r.ok) return r;
    out.lastPush = r.value;
  }
  if (v.lastPull !== undefined) {
    const r = validateNestedObject(v.lastPull, "activity.lastPull", { at: "string", writes: "number", deletes: "number", conflicts: "number" });
    if (!r.ok) return r;
    out.lastPull = r.value;
  }
  if (v.active !== undefined) {
    const r = validateNestedObject(v.active, "activity.active", { at: "string", phase: ["encrypt", "upload", "download"], done: "number", total: "number" });
    if (!r.ok) return r;
    out.active = r.value;
  }
  if (v.halt !== undefined) {
    const r = validateNestedObject(v.halt, "activity.halt", { at: "string", reason: "string", count: "number", op: ["pull", "push", "fullScan", "deepScan"] });
    if (!r.ok) return r;
    out.halt = r.value;
  }
  if (v.truncated !== undefined) {
    if (typeof v.truncated !== "boolean") return { ok: false, message: "activity.truncated must be boolean" };
    out.truncated = v.truncated;
  }
  if (v.originalBytes !== undefined) {
    const n = safeNumber(v.originalBytes, "activity.originalBytes");
    if (!n.ok) return n;
    out.originalBytes = n.value;
  }
  return { ok: true, value: out };
}

function validateDaemonLogTail(v: unknown): { ok: true; value: string | JsonRecord } | { ok: false; message: string } {
  if (typeof v === "string") return { ok: true, value: truncateUtf8(v, DAEMON_LOG_CAP_BYTES) };
  if (isRecord(v)) {
    try {
      const excluded = validateExcluded(v, "daemonLogTail");
      if (excluded) return { ok: true, value: excluded };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    }
  }
  return { ok: false, message: "daemonLogTail must be a string or excluded object" };
}

function validateWorkspaceShape(v: unknown): ValidationResult {
  if (!isRecord(v)) return { ok: false, message: "workspaceShape must be an object" };
  const unknown = assertOnlyKeys(v, WORKSPACE_SHAPE_KEYS, "workspaceShape") ?? requireKeys(v, WORKSPACE_SHAPE_KEYS, "workspaceShape");
  if (unknown) return { ok: false, message: unknown };
  const fileCount = safeNumber(v.fileCount, "workspaceShape.fileCount");
  if (!fileCount.ok) return fileCount;
  const totalBytes = safeNumber(v.totalBytes, "workspaceShape.totalBytes");
  if (!totalBytes.ok) return totalBytes;
  return { ok: true, value: { fileCount: fileCount.value, totalBytes: totalBytes.value } };
}

export function validateDiagnosticsBundle(parsed: unknown): ValidationResult {
  if (!isRecord(parsed)) return { ok: false, message: "body must be a JSON object" };
  const top = assertOnlyKeys(parsed, TOP_KEYS, "body") ?? requireKeys(parsed, TOP_KEYS, "body");
  if (top) return { ok: false, message: top };

  const version = boundedString(parsed.version, "version", 128);
  if (!version.ok) return version;
  const bunVersion = boundedString(parsed.bunVersion, "bunVersion", 128);
  if (!bunVersion.ok) return bunVersion;
  const platform = validatePlatform(parsed.platform);
  if (!platform.ok) return platform;
  const checks = validateChecks(parsed.checks);
  if (!checks.ok) return checks;
  const daemonLogTail = validateDaemonLogTail(parsed.daemonLogTail);
  if (!daemonLogTail.ok) return daemonLogTail;
  const metrics = validateMetrics(parsed.metrics);
  if (!metrics.ok) return metrics;
  const activity = validateActivity(parsed.activity);
  if (!activity.ok) return activity;
  const workspaceShape = validateWorkspaceShape(parsed.workspaceShape);
  if (!workspaceShape.ok) return workspaceShape;

  return {
    ok: true,
    value: {
      version: version.value,
      platform: platform.value,
      bunVersion: bunVersion.value,
      checks: checks.value,
      daemonLogTail: daemonLogTail.value,
      metrics: metrics.value,
      activity: activity.value,
      workspaceShape: workspaceShape.value,
    },
  };
}

export async function createDiagnosticsReport(
  env: Env,
  p: Principal,
  req: Request,
  nowMs: number = Date.now(),
  deps: DiagnosticsDeps = REAL_DIAGNOSTICS_DEPS
): Promise<Response> {
  if (p.kind === "web") return json({ error: "forbidden", message: "diagnostics require a durable device token" }, 403);

  const raw = await readBodyCapped(req, BODY_CAP_BYTES);
  if (raw === null) return json({ error: "too_large", message: "request body too large" }, 413);
  let parsed: unknown;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    return badShape("body must be valid JSON");
  }
  const validated = validateDiagnosticsBundle(parsed);
  if (!validated.ok) return badShape(validated.message);

  const reportId = `diag_${crypto.randomUUID().replace(/-/g, "")}`;
  const r2Key = `diagnostics/${p.accountId}/${reportId}.json`;
  const expiresAtMs = nowMs + DIAGNOSTICS_RETENTION_MS;
  const stored = JSON.stringify(validated.value, null, 2);
  const bytes = byteLen(stored);
  const sha256 = await sha256Hex(stored);
  const db = dbFor(env, p.accountId);

  const inserted = await db
    .prepare(
      `INSERT INTO diagnostics_reports (id, account_id, device_id, created_at, expires_at, r2_key, status)
       SELECT ?, ?, ?, ?, ?, ?, 'pending'
       WHERE (SELECT COUNT(*) FROM diagnostics_reports WHERE account_id = ? AND created_at > ?) < ?`,
    )
    .bind(reportId, p.accountId, p.deviceId, nowMs, expiresAtMs, r2Key, p.accountId, nowMs - RATE_WINDOW_MS, RATE_LIMIT)
    .run();
  if ((inserted.meta.changes ?? 0) === 0) return json({ error: "rate_limited", limit: RATE_LIMIT, windowSeconds: RATE_WINDOW_MS / 1000 }, 429);

  try {
    await deps.putReport(env, r2Key, stored);
  } catch (e) {
    logErr("diagnostics_r2_put_failed", e);
    await db.prepare("DELETE FROM diagnostics_reports WHERE id = ? AND account_id = ? AND status = 'pending'").bind(reportId, p.accountId).run().catch(() => {});
    return json({ error: "storage_failed" }, 500);
  }

  const updated = await db
    .prepare("UPDATE diagnostics_reports SET status = 'stored', bytes = ?, sha256 = ? WHERE id = ? AND account_id = ? AND status = 'pending'")
    .bind(bytes, sha256, reportId, p.accountId)
    .run();
  if ((updated.meta.changes ?? 0) === 0) return json({ error: "storage_failed" }, 500);

  return json({ id: reportId, expiresAt: new Date(expiresAtMs).toISOString() });
}

export async function sweepDiagnostics(
  env: Env,
  nowMs: number = Date.now(),
  deps: DiagnosticsDeps = REAL_DIAGNOSTICS_DEPS
): Promise<{ deleted: number; remainingExpired: number }> {
  const span = new OpSpan();
  const timedEnv: Env = { ...env, rbox_dev_db: span.db(env.rbox_dev_db) };
  const db = dbFor(timedEnv, "");
  const storedCutoff = nowMs - DIAGNOSTICS_RETENTION_MS;
  const pendingCutoff = nowMs - PENDING_RETENTION_MS;
  const rows = await db
    .prepare(
      `SELECT id, account_id, r2_key FROM diagnostics_reports
       WHERE (status = 'stored' AND created_at < ?) OR (status = 'pending' AND created_at < ?)
       ORDER BY created_at LIMIT ?`,
    )
    .bind(storedCutoff, pendingCutoff, SWEEP_LIMIT)
    .all<{ id: string; account_id: string; r2_key: string }>();
  let deleted = 0;
  for (const r of rows.results ?? []) {
    try {
      await span.r2(() => deps.deleteReport(timedEnv, r.r2_key));
      await db.prepare("DELETE FROM diagnostics_reports WHERE id = ? AND account_id = ?").bind(r.id, r.account_id).run();
      deleted++;
    } catch (e) {
      logErr("diagnostics_sweep_item_failed", e);
    }
  }
  const remaining =
    (await db
      .prepare(
        `SELECT COUNT(*) AS n FROM diagnostics_reports
         WHERE (status = 'stored' AND created_at < ?) OR (status = 'pending' AND created_at < ?)`,
      )
      .bind(storedCutoff, pendingCutoff)
      .first<{ n: number }>())?.n ?? 0;
  emit(env, { op: "diagnostics.sweep", outcome: "ok", ms: span.ms, ...span.fields(), count: remaining, bytes: deleted });
  return { deleted, remainingExpired: remaining };
}

export async function purgeDiagnosticR2(env: Env, key: string): Promise<boolean> {
  try {
    await REAL_DIAGNOSTICS_DEPS.deleteReport(env, key);
    return true;
  } catch (e) {
    logErr("account_delete_diagnostics_r2_failed", e);
    return false;
  }
}
