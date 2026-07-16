import type { Env } from "./env.js";
import { dbFor, dirDb } from "./db.js";
import { chunked } from "./util.js";
import { sanitizeLabel } from "./notify.js";
import { pingSlackpipes } from "./slackpipes.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const STALE_MS = 2.5 * HOUR_MS;
const DRIFT_MS = DAY_MS;
const CONTINUATION_MS = 2 * HOUR_MS;
const RENOTIFY_END_MS = 7 * DAY_MS;
const PRUNE_AGE_MS = 30 * DAY_MS;
const PRUNE_LIMIT = 200;
const ID_CHUNK = 80;

type Condition = "drift" | "reporting_stopped";

interface SyncRow {
  device_id: string;
  workspace_id: string;
  project_id: string;
  binding_id: string;
  repos_total: number;
  repos_deferred: number;
  oldest_deferral_age_ms: number | null;
  deferral_reasons: string;
  reported_at: number;
}

interface AlertRow {
  condition: Condition;
  device_id: string;
  workspace_id: string;
  project_id: string;
  binding_id: string;
  incident_started_at: number;
  last_notified_at: number;
  resolved_at: number | null;
  resolve_notified_at: number | null;
}

interface AlertKey {
  condition: Condition;
  deviceId: string;
  workspaceId: string;
  projectId: string;
  bindingId: string;
}

interface DeviceSummary {
  rows: SyncRow[];
  latestReportedAt: number;
  reposDeferred: number;
}

/** Re-asserts the SOURCE condition inside each claim's WHERE clause: an evaluator acting
 *  on a stale snapshot cannot claim a send that fresher `device_sync_state` contradicts. */
interface SourceGuard {
  sql: string;
  params: unknown[];
}

function escapeSlack(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function truncate(value: string, max: number): string {
  const points = Array.from(value);
  return points.length > max ? `${points.slice(0, max).join("")}…` : value;
}

function deviceFallback(deviceId: string): string {
  return escapeSlack(truncate(deviceId, 12));
}

export function renderFleetDeviceLabel(label: string | null, deviceId: string): string {
  const clean = sanitizeLabel(label);
  if (clean === "Unknown device" || clean.includes("/") || clean.includes("\\") || clean.includes("@") || clean.includes("://")) return deviceFallback(deviceId);
  return escapeSlack(clean);
}

export function renderFleetBinding(workspaceId: string, projectId: string): string {
  // Eight displayed code points including the ellipsis, matching `ws_2b6e…`.
  const workspace = escapeSlack(truncate(sanitizeLabel(workspaceId), 7));
  const project = sanitizeLabel(projectId);
  if (project.includes("/") || project.includes("\\") || project.includes("@") || project.includes("://") || /[<>]/.test(project)) return workspace;
  return `${workspace}/${escapeSlack(truncate(project, 80))}`;
}

function hours(ms: number): string {
  return `${Math.max(0, Math.floor(ms / HOUR_MS))}h`;
}

function keyOf(key: AlertKey): string {
  return [key.condition, key.deviceId, key.workspaceId, key.projectId, key.bindingId].join("\u0000");
}

function rowKey(row: AlertRow): string {
  return [row.condition, row.device_id, row.workspace_id, row.project_id, row.binding_id].join("\u0000");
}

const KEY_WHERE = "condition = ? AND device_id = ? AND workspace_id = ? AND project_id = ? AND binding_id = ?";

function binds(key: AlertKey): [Condition, string, string, string, string] {
  return [key.condition, key.deviceId, key.workspaceId, key.projectId, key.bindingId];
}

async function labelsFor(env: Env, deviceIds: string[]): Promise<Map<string, string | null>> {
  const labels = new Map<string, string | null>();
  const ids = [...new Set(deviceIds)];
  if (!ids.length) return labels;
  const directory = dirDb(env);
  for (const page of chunked(ids, ID_CHUNK)) {
    const result = await directory
      .prepare(`SELECT device_id, label FROM devices WHERE device_id IN (${page.map(() => "?").join(",")})`)
      .bind(...page)
      .all<{ device_id: string; label: string | null }>();
    for (const row of result.results ?? []) labels.set(row.device_id, row.label);
  }
  return labels;
}

async function send(env: Env, text: string): Promise<void> {
  const label = env.RBOX_ENV_LABEL?.trim();
  await pingSlackpipes(env, "fleet_alert", label ? `[${label}] ${text}` : text);
}

async function conditionTrue(
  env: Env,
  db: D1Database,
  key: AlertKey,
  nowMs: number,
  fireMessage: string,
  stillMessage: string,
  guard: SourceGuard,
): Promise<void> {
  const values = binds(key);
  // fire: new incident
  const inserted = await db
    .prepare(`INSERT OR IGNORE INTO alert_state
      (condition, device_id, workspace_id, project_id, binding_id, incident_started_at, last_notified_at, resolved_at, resolve_notified_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, NULL, NULL WHERE ${guard.sql}`)
    .bind(...values, nowMs, nowMs, ...guard.params)
    .run();
  if ((inserted.meta.changes ?? 0) === 1) {
    await send(env, fireMessage);
    return;
  }

  // reopen: resolved ≥2h ago — a genuinely new incident
  const reopened = await db
    .prepare(`UPDATE alert_state SET incident_started_at = ?, last_notified_at = ?, resolved_at = NULL, resolve_notified_at = NULL
      WHERE ${KEY_WHERE}
        AND resolved_at IS NOT NULL AND resolved_at <= ? AND ${guard.sql}`)
    .bind(nowMs, nowMs, ...values, nowMs - CONTINUATION_MS, ...guard.params)
    .run();
  if ((reopened.meta.changes ?? 0) === 1) {
    await send(env, fireMessage);
    return;
  }

  // continuation: resolved <2h ago — same incident, no message, resolve marker preserved
  await db
    .prepare(`UPDATE alert_state SET resolved_at = NULL
      WHERE ${KEY_WHERE}
        AND resolved_at IS NOT NULL AND resolved_at > ? AND ${guard.sql}`)
    .bind(...values, nowMs - CONTINUATION_MS, ...guard.params)
    .run();

  await renotifyExisting(env, db, key, nowMs, stillMessage, guard);
}

async function renotifyExisting(env: Env, db: D1Database, key: AlertKey, nowMs: number, message: string, guard: SourceGuard): Promise<void> {
  const claim = await db
    .prepare(`UPDATE alert_state SET last_notified_at = ?
      WHERE ${KEY_WHERE}
        AND resolved_at IS NULL AND last_notified_at <= ? AND incident_started_at >= ? AND ${guard.sql}`)
    .bind(nowMs, ...binds(key), nowMs - DAY_MS, nowMs - RENOTIFY_END_MS, ...guard.params)
    .run();
  if ((claim.meta.changes ?? 0) === 1) await send(env, message);
}

async function conditionResolved(
  env: Env,
  db: D1Database,
  key: AlertKey,
  nowMs: number,
  message: (startedAt: number) => string,
  guard: SourceGuard,
): Promise<void> {
  const values = binds(key);
  const current = await db
    .prepare(`SELECT incident_started_at FROM alert_state
      WHERE ${KEY_WHERE} AND resolved_at IS NULL`)
    .bind(...values)
    .first<{ incident_started_at: number }>();
  if (!current) return;
  const claimed = await db
    .prepare(`UPDATE alert_state SET resolved_at = ?, resolve_notified_at = ?
      WHERE ${KEY_WHERE}
        AND resolved_at IS NULL AND resolve_notified_at IS NULL AND incident_started_at = ? AND ${guard.sql}`)
    .bind(nowMs, nowMs, ...values, current.incident_started_at, ...guard.params)
    .run();
  if ((claimed.meta.changes ?? 0) === 1) {
    await send(env, message(current.incident_started_at));
    return;
  }
  await db
    .prepare(`UPDATE alert_state SET resolved_at = ?
      WHERE ${KEY_WHERE}
        AND resolved_at IS NULL AND resolve_notified_at IS NOT NULL AND incident_started_at = ? AND ${guard.sql}`)
    .bind(nowMs, ...values, current.incident_started_at, ...guard.params)
    .run();
}

/** Evaluate design 127's D1-only fleet conditions. Every send is claimed by a
 * conditional state write first, so overlapping cron executions cannot duplicate it. */
export async function evaluateFleetAlerts(env: Env, nowMs: number): Promise<void> {
  const db = dbFor(env, "");
  await db
    .prepare("DELETE FROM alert_state WHERE rowid IN (SELECT rowid FROM alert_state WHERE resolved_at < ? LIMIT ?)")
    .bind(nowMs - PRUNE_AGE_MS, PRUNE_LIMIT)
    .run();

  const [syncResult, stateResult] = await Promise.all([
    db.prepare(`SELECT device_id, workspace_id, project_id, binding_id, repos_total, repos_deferred,
      oldest_deferral_age_ms, deferral_reasons, reported_at FROM device_sync_state`).all<SyncRow>(),
    db.prepare(`SELECT condition, device_id, workspace_id, project_id, binding_id,
      incident_started_at, last_notified_at, resolved_at, resolve_notified_at FROM alert_state`).all<AlertRow>(),
  ]);
  const rows = syncResult.results ?? [];
  const states = stateResult.results ?? [];
  const stateByKey = new Map(states.map((row) => [rowKey(row), row]));
  const labels = await labelsFor(env, rows.map((row) => row.device_id));
  const devices = new Map<string, DeviceSummary>();
  for (const row of rows) {
    const summary = devices.get(row.device_id) ?? { rows: [], latestReportedAt: -Infinity, reposDeferred: 0 };
    summary.rows.push(row);
    summary.latestReportedAt = Math.max(summary.latestReportedAt, row.reported_at);
    summary.reposDeferred += row.repos_deferred;
    devices.set(row.device_id, summary);
  }

  // Pinned ordering: stopped incidents are updated before stale-drift coverage decisions.
  // Administrative closure: a device with zero sync-state rows loses its stopped incident
  // outright (no message, no continuation window) — one correlated statement.
  await db
    .prepare(`DELETE FROM alert_state WHERE condition = 'reporting_stopped' AND resolved_at IS NULL
      AND workspace_id = '' AND project_id = '' AND binding_id = ''
      AND NOT EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = alert_state.device_id)`)
    .run();
  for (const [deviceId, summary] of devices) {
    const key: AlertKey = { condition: "reporting_stopped", deviceId, workspaceId: "", projectId: "", bindingId: "" };
    const label = renderFleetDeviceLabel(labels.get(deviceId) ?? null, deviceId);
    if (summary.latestReportedAt < nowMs - STALE_MS) {
      const detail = summary.reposDeferred ? ` (last known: ${summary.reposDeferred} repos deferred)` : "";
      const body = `${label} · ${summary.rows.length} bindings · last report ${hours(nowMs - summary.latestReportedAt)} ago${detail}`;
      const guard: SourceGuard = {
        sql: "EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = ?) AND NOT EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = ? AND reported_at >= ?)",
        params: [deviceId, deviceId, nowMs - STALE_MS],
      };
      await conditionTrue(env, db, key, nowMs, `⚠️ reporting stopped: ${body}`, `still: reporting stopped: ${body}`, guard);
    } else {
      const guard: SourceGuard = {
        sql: "EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = ? AND reported_at >= ?)",
        params: [deviceId, nowMs - STALE_MS],
      };
      await conditionResolved(env, db, key, nowMs, (started) => `✅ resolved: ${label} · reporting resumed after ${hours(nowMs - started)}`, guard);
    }
  }

  const stoppedStates = await db
    .prepare(`SELECT device_id, incident_started_at FROM alert_state WHERE condition = 'reporting_stopped' AND resolved_at IS NULL`)
    .all<{ device_id: string; incident_started_at: number }>();
  const covered = new Set((stoppedStates.results ?? []).filter((row) => nowMs <= row.incident_started_at + RENOTIFY_END_MS).map((row) => row.device_id));

  for (const row of rows) {
    const key: AlertKey = { condition: "drift", deviceId: row.device_id, workspaceId: row.workspace_id, projectId: row.project_id, bindingId: row.binding_id };
    const existing = stateByKey.get(keyOf(key));
    const label = renderFleetDeviceLabel(labels.get(row.device_id) ?? null, row.device_id);
    const binding = renderFleetBinding(row.workspace_id, row.project_id);
    const fresh = row.reported_at >= nowMs - STALE_MS;
    const age = (row.oldest_deferral_age_ms ?? 0) + (nowMs - row.reported_at);
    const active = fresh && row.repos_deferred > 0 && age > DRIFT_MS;
    const reasons = row.deferral_reasons ? ` (${row.deferral_reasons.split(",").map((reason) => escapeSlack(reason.trim())).filter(Boolean).join(", ")})` : "";
    const body = `${label} · ${binding} · ${row.repos_deferred}/${row.repos_total} repos deferred ${hours(age)}${reasons}`;
    if (active) {
      const guard: SourceGuard = {
        sql: `EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = ? AND workspace_id = ? AND project_id = ? AND binding_id = ?
          AND reported_at >= ? AND repos_deferred > 0 AND oldest_deferral_age_ms + (? - reported_at) > ?)`,
        params: [row.device_id, row.workspace_id, row.project_id, row.binding_id, nowMs - STALE_MS, nowMs, DRIFT_MS],
      };
      await conditionTrue(env, db, key, nowMs, `⚠️ drift: ${body}`, `still: drift: ${body}`, guard);
    } else if (fresh) {
      const guard: SourceGuard = {
        sql: `EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = ? AND workspace_id = ? AND project_id = ? AND binding_id = ?
          AND reported_at >= ? AND (repos_deferred = 0 OR oldest_deferral_age_ms + (? - reported_at) <= ?))`,
        params: [row.device_id, row.workspace_id, row.project_id, row.binding_id, nowMs - STALE_MS, nowMs, DRIFT_MS],
      };
      await conditionResolved(env, db, key, nowMs, (started) => `✅ resolved: ${label} · ${binding} · deferral cleared after ${hours(nowMs - started)}`, guard);
    } else if (existing?.resolved_at === null) {
      const staleBody = `${label} · ${binding} · binding stale since ${hours(nowMs - row.reported_at)}`;
      if (!covered.has(row.device_id)) {
        const guard: SourceGuard = {
          sql: `EXISTS (SELECT 1 FROM device_sync_state WHERE device_id = ? AND workspace_id = ? AND project_id = ? AND binding_id = ? AND reported_at < ?)`,
          params: [row.device_id, row.workspace_id, row.project_id, row.binding_id, nowMs - STALE_MS],
        };
        await renotifyExisting(env, db, key, nowMs, `still: drift: ${staleBody}`, guard);
      }
    }
  }
}
