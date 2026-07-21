import type { Env } from "./env.js";
import type { Principal } from "./authz.js";
import { authorizeWorkspace } from "./authz.js";
import { readBodyCapped } from "./util.js";
import { dbFor } from "./db.js";
import { isRecord } from "./diagnostics.js";
import { rateLimited } from "./ratelimit.js";
import { json } from "./util.js";

const BODY_CAP_BYTES = 32 * 1024;
export const TELEMETRY_BATCH_CAP = 64;
const SYNC_STATE_BATCH_CAP = 32;

/** Low-cardinality drops enum: unknown_kind|unknown_field|bad_number|bad_enum|batch_cap|body_cap|bad_state|unauthorized. */
type DropReason = "unknown_kind" | "unknown_field" | "bad_number" | "bad_enum" | "batch_cap" | "body_cap" | "bad_state" | "unauthorized";
type JsonRecord = Record<string, unknown>;
interface NumericDomain { readonly min: number; readonly max: number; readonly integer: boolean }
interface NumberField extends NumericDomain { readonly field: string }
interface EnumField { readonly field: string; readonly values: readonly string[] }
interface NumericRecordField { readonly field: string; readonly keys: readonly string[]; readonly domain: NumericDomain }
interface SampleSchema {
  readonly numbers: readonly NumberField[];
  readonly enums: readonly EnumField[];
  readonly optionalNumbers?: readonly NumberField[];
  readonly numericRecords?: readonly NumericRecordField[];
}

const MS = { min: 0, max: 604_800_000, integer: true } as const;
const COUNT = { min: 0, max: 10_000_000, integer: true } as const;
const WS_HEALTH_COUNT = { min: 0, max: 1_000_000_000, integer: true } as const;
export const SERVER_SYNC_PHASE_NAMES = [
  "latest", "state-load", "scan", "git-plan", "address", "encrypt", "missing", "upload",
  "commit", "download", "decrypt", "apply", "git-apply", "cache-save", "state-save",
] as const;

/** Runtime duplicate of the client contract. A test imports both copies and prevents drift.
 * Field declaration order IS the positional AE doubles order and feeds normalizeSample
 * positional reads (wireNumbers[2], the upload_lane destructure) and cockpit dashboard
 * SQL. Append only; never reorder. */
export const SERVER_TELEMETRY_SAMPLE_SCHEMAS = {
  propagation: {
    numbers: [{ field: "deliveryToApplyMs", ...MS }],
    enums: [],
  },
  first_publish: {
    numbers: [
      { field: "timeToFilesSyncedMs", ...MS },
      { field: "pushWallMs", ...MS },
      { field: "fileCount", ...COUNT },
      { field: "uniqueBlobs", ...COUNT },
    ],
    enums: [],
  },
  upload_lane: {
    numbers: [
      { field: "bytes", min: 0, max: 10_000_000_000_000, integer: true },
      { field: "uploadMs", ...MS },
      { field: "opCount", ...COUNT },
    ],
    enums: [
      { field: "transport", values: ["batch", "pack", "single"] },
      { field: "fillVersion", values: ["v1", "v2"] },
    ],
  },
  capability: {
    numbers: [{ field: "workerExecutions", min: 0, max: 1_000_000_000, integer: true }],
    enums: [],
  },
  safety_event: {
    numbers: [{ field: "count", ...COUNT }],
    enums: [{ field: "eventType", values: ["mass_delete_breaker", "scan_fault"] }],
  },
  git_capture: {
    numbers: [
      { field: "signalPushes", ...WS_HEALTH_COUNT },
      { field: "candidatePushes", ...WS_HEALTH_COUNT },
      { field: "scanPushes", ...WS_HEALTH_COUNT },
    ],
    enums: [],
  },
  ws_health: {
    numbers: [
      { field: "windowMs", ...MS },
      { field: "wsConnectedMs", ...MS },
      { field: "wsReconnects", ...WS_HEALTH_COUNT },
      { field: "wsHalfOpenDetected", ...WS_HEALTH_COUNT },
      { field: "backstopAttempts", ...WS_HEALTH_COUNT },
      { field: "backstopAppliedPulls", ...WS_HEALTH_COUNT },
      { field: "cursorAppliedPulls", ...WS_HEALTH_COUNT },
      { field: "notifyAppliedPulls", ...WS_HEALTH_COUNT },
      { field: "notifyLatencyCount", ...WS_HEALTH_COUNT },
      { field: "notifyLatencySumMs", min: 0, max: 1_000_000_000_000, integer: true },
      { field: "notifyLatencyMaxMs", ...MS },
    ],
    enums: [],
  },
  sync_phase: {
    numbers: [{ field: "wallMs", ...MS }],
    optionalNumbers: [
      { field: "gitApplyMaxRepoMs", ...MS },
      { field: "gitApplySkippedHeld", ...COUNT },
    ],
    enums: [{ field: "op", values: ["pull", "push"] }],
    numericRecords: [{ field: "phases", keys: SERVER_SYNC_PHASE_NAMES, domain: MS }],
  },
} as const satisfies Record<string, SampleSchema>;

export type ClientTelemetryKind = keyof typeof SERVER_TELEMETRY_SAMPLE_SCHEMAS;

export const SERVER_CORPUS_BUCKETS = [
  { bucket: "xs", maxFileCount: 100 },
  { bucket: "s", maxFileCount: 1_000 },
  { bucket: "m", maxFileCount: 10_000 },
  { bucket: "l", maxFileCount: 100_000 },
  { bucket: "xl", maxFileCount: null },
] as const;

export const SERVER_GIT_DEFERRAL_REASONS = [
  "local-edits", "local-index", "local-operation", "local-commits", "local-stash",
  "conflict", "git-busy", "worktree-ownership", "ignored-target", "unreadable",
  "artifact", "config", "containment", "unsupported", "other",
] as const;

export const SERVER_SYNC_STATE_NUMERIC_DOMAINS = {
  fileSeq: { min: 0, max: 2 ** 48, integer: true },
  reposTotal: { min: 0, max: 10_000, integer: true },
  reposDeferred: { min: 0, max: 10_000, integer: true },
  oldestDeferralAgeMs: { min: 0, max: 7_776_000_000, integer: true },
} as const satisfies Record<string, NumericDomain>;

const ALLOWED_SAMPLE_KEYS = new Map<ClientTelemetryKind, ReadonlySet<string>>(
  (Object.entries(SERVER_TELEMETRY_SAMPLE_SCHEMAS) as [ClientTelemetryKind, SampleSchema][]).map(([kind, schema]) => [
    kind,
    new Set([
      "kind",
      ...schema.numbers.map((field) => field.field),
      ...schema.enums.map((field) => field.field),
      ...(schema.optionalNumbers ?? []).map((field) => field.field),
      ...(schema.numericRecords ?? []).map((field) => field.field),
    ]),
  ]),
);

export interface NormalizedClientMetric {
  readonly index: `client.${ClientTelemetryKind}` | "client.telemetry.drops";
  readonly blobs: readonly string[];
  readonly doubles: readonly number[];
}

/** The sole Analytics Engine write path for data accepted by the client ingest surface. */
function emitClientMetric(env: Env, metric: NormalizedClientMetric): void {
  try {
    env.rbox_metrics?.writeDataPoint({
      indexes: [metric.index],
      blobs: [metric.index, ...metric.blobs],
      doubles: [...metric.doubles],
    });
  } catch {
    // Best-effort telemetry must never affect sync.
  }
}

function hasOnlyKeys(value: JsonRecord, allowed: ReadonlySet<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function validNumber(value: unknown, domain: NumericDomain): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= domain.min && value <= domain.max && (!domain.integer || Number.isInteger(value));
}

function corpusBucket(fileCount: number): (typeof SERVER_CORPUS_BUCKETS)[number]["bucket"] {
  return SERVER_CORPUS_BUCKETS.find((entry) => entry.maxFileCount === null || fileCount <= entry.maxFileCount)!.bucket;
}

function normalizeSample(value: unknown): { ok: true; metric: NormalizedClientMetric } | { ok: false; reason: DropReason } {
  if (!isRecord(value) || typeof value.kind !== "string" || !Object.prototype.hasOwnProperty.call(SERVER_TELEMETRY_SAMPLE_SCHEMAS, value.kind)) {
    return { ok: false, reason: "unknown_kind" };
  }
  const kind = value.kind as ClientTelemetryKind;
  const schema: SampleSchema = SERVER_TELEMETRY_SAMPLE_SCHEMAS[kind];
  if (!hasOnlyKeys(value, ALLOWED_SAMPLE_KEYS.get(kind)!)) return { ok: false, reason: "unknown_field" };

  const wireNumbers: number[] = [];
  for (const field of schema.numbers) {
    const raw = value[field.field];
    if (!validNumber(raw, field)) return { ok: false, reason: "bad_number" };
    wireNumbers.push(raw);
  }
  const canonicalEnums: string[] = [];
  for (const field of schema.enums) {
    const raw = value[field.field];
    const canonical = typeof raw === "string" ? field.values.find((candidate) => candidate === raw) : undefined;
    if (canonical === undefined) return { ok: false, reason: "bad_enum" };
    canonicalEnums.push(canonical);
  }
  const recordNumbers: number[] = [];
  for (const field of schema.numericRecords ?? []) {
    const raw = value[field.field];
    if (!isRecord(raw)) return { ok: false, reason: "bad_number" };
    const allowed = new Set(field.keys);
    if (!hasOnlyKeys(raw, allowed)) return { ok: false, reason: "unknown_field" };
    for (const key of field.keys) {
      const item = raw[key];
      if (item === undefined) recordNumbers.push(0);
      else if (!validNumber(item, field.domain)) return { ok: false, reason: "bad_number" };
      else recordNumbers.push(item);
    }
  }
  const optionalNumbers: number[] = [];
  for (const field of schema.optionalNumbers ?? []) {
    const raw = value[field.field];
    if (raw === undefined) optionalNumbers.push(0);
    else if (!validNumber(raw, field)) return { ok: false, reason: "bad_number" };
    else optionalNumbers.push(raw);
  }

  if (kind === "first_publish") {
    return { ok: true, metric: { index: "client.first_publish", blobs: [corpusBucket(wireNumbers[2]!)], doubles: wireNumbers } };
  }
  if (kind === "upload_lane") {
    const [bytes, uploadMs, opCount] = wireNumbers as [number, number, number];
    if (bytes > 0 && uploadMs === 0) return { ok: false, reason: "bad_number" };
    const mbps = uploadMs === 0 ? 0 : 8 * bytes / (uploadMs / 1000) / 1_000_000;
    if (!Number.isFinite(mbps) || mbps > 100_000) return { ok: false, reason: "bad_number" };
    return { ok: true, metric: { index: "client.upload_lane", blobs: canonicalEnums, doubles: [mbps, bytes, uploadMs, opCount] } };
  }
  if (kind === "ws_health" && wireNumbers[1]! > wireNumbers[0]!) {
    return { ok: false, reason: "bad_number" };
  }
  if (kind === "sync_phase") {
    return { ok: true, metric: {
      index: "client.sync_phase",
      blobs: canonicalEnums,
      doubles: [...wireNumbers, ...recordNumbers, ...optionalNumbers],
    } };
  }
  return { ok: true, metric: { index: `client.${kind}`, blobs: canonicalEnums, doubles: wireNumbers } };
}

function emitDrop(env: Env, reason: DropReason, count: number): void {
  if (count > 0) emitClientMetric(env, { index: "client.telemetry.drops", blobs: [reason], doubles: [count] });
}

async function parsedEnvelope(req: Request, env: Env): Promise<{ value: unknown } | { response: Response }> {
  const raw = await readBodyCapped(req, BODY_CAP_BYTES);
  if (raw === null) {
    emitDrop(env, "body_cap", 1);
    return { response: json({ error: "body_too_large" }, 413) };
  }
  try {
    return { value: JSON.parse(raw) as unknown };
  } catch {
    return { response: json({ error: "bad_request" }, 400) };
  }
}

const TELEMETRY_ENVELOPE_KEYS = new Set(["v", "samples"]);
const SYNC_STATE_ENVELOPE_KEYS = new Set(["v", "states"]);

/** Shared front half of both ingest handlers: device-only gate, per-device rate
 *  limit, capped body parse, and the `{v:1, <arrayKey>:[...]}` envelope shape. */
async function openIngest(
  req: Request, env: Env, p: Principal, arrayKey: "samples" | "states", envelopeKeys: ReadonlySet<string>,
): Promise<{ items: unknown[] } | { response: Response }> {
  if (p.kind !== "device") return { response: json({ error: "forbidden" }, 403) };
  const limited = await rateLimited(env.RL_TELEMETRY, p.deviceId);
  if (limited) return { response: limited };
  const parsed = await parsedEnvelope(req, env);
  if ("response" in parsed) return parsed;
  if (!isRecord(parsed.value) || !hasOnlyKeys(parsed.value, envelopeKeys) || parsed.value.v !== 1 || !Array.isArray(parsed.value[arrayKey])) {
    return { response: json({ error: "bad_request" }, 400) };
  }
  return { items: parsed.value[arrayKey] };
}

export async function ingestTelemetry(req: Request, env: Env, p: Principal): Promise<Response> {
  const opened = await openIngest(req, env, p, "samples", TELEMETRY_ENVELOPE_KEYS);
  if ("response" in opened) return opened.response;

  const samples = opened.items;
  let accepted = 0;
  let dropped = Math.max(0, samples.length - TELEMETRY_BATCH_CAP);
  emitDrop(env, "batch_cap", dropped);
  const reasons = new Map<DropReason, number>();
  for (const sample of samples.slice(0, TELEMETRY_BATCH_CAP)) {
    const normalized = normalizeSample(sample);
    if (!normalized.ok) {
      dropped++;
      reasons.set(normalized.reason, (reasons.get(normalized.reason) ?? 0) + 1);
      continue;
    }
    emitClientMetric(env, normalized.metric);
    accepted++;
  }
  for (const [reason, count] of reasons) emitDrop(env, reason, count);
  return json({ accepted, dropped }, 202);
}

const SYNC_KEYS = new Set([
  "workspaceId", "projectId", "bindingId", "fileSeq", "reposTotal", "reposDeferred", "oldestDeferralAgeMs", "deferralReasons",
]);
export const SERVER_BINDING_ID_RE = /^[0-9a-f]{16}$/;

interface ValidSyncState {
  workspaceId: string;
  projectId: string;
  bindingId: string;
  fileSeq: number;
  reposTotal: number;
  reposDeferred: number;
  oldestDeferralAgeMs: number | null;
  deferralReasons: string[];
}

function validateSyncState(value: unknown): ValidSyncState | null {
  if (!isRecord(value) || !hasOnlyKeys(value, SYNC_KEYS)) return null;
  const { workspaceId, projectId, bindingId, fileSeq, reposTotal, reposDeferred, oldestDeferralAgeMs, deferralReasons } = value;
  if (typeof workspaceId !== "string" || workspaceId.length === 0 || typeof projectId !== "string" || projectId.length === 0) return null;
  if (typeof bindingId !== "string" || !SERVER_BINDING_ID_RE.test(bindingId)) return null;
  if (!validNumber(fileSeq, SERVER_SYNC_STATE_NUMERIC_DOMAINS.fileSeq)
    || !validNumber(reposTotal, SERVER_SYNC_STATE_NUMERIC_DOMAINS.reposTotal)
    || !validNumber(reposDeferred, SERVER_SYNC_STATE_NUMERIC_DOMAINS.reposDeferred)
    || reposDeferred > reposTotal) return null;
  if (!Array.isArray(deferralReasons) || deferralReasons.length > SERVER_GIT_DEFERRAL_REASONS.length) return null;
  const canonicalReasons: string[] = [];
  for (const reason of deferralReasons) {
    const canonical = typeof reason === "string" ? SERVER_GIT_DEFERRAL_REASONS.find((candidate) => candidate === reason) : undefined;
    if (canonical === undefined) return null;
    if (!canonicalReasons.includes(canonical)) canonicalReasons.push(canonical);
  }
  if (reposDeferred === 0) {
    if (oldestDeferralAgeMs !== null || canonicalReasons.length !== 0) return null;
  } else {
    if (!validNumber(oldestDeferralAgeMs, SERVER_SYNC_STATE_NUMERIC_DOMAINS.oldestDeferralAgeMs) || canonicalReasons.length === 0) return null;
  }
  return { workspaceId, projectId, bindingId, fileSeq, reposTotal, reposDeferred, oldestDeferralAgeMs: oldestDeferralAgeMs as number | null, deferralReasons: canonicalReasons };
}

export async function ingestSyncState(req: Request, env: Env, p: Principal): Promise<Response> {
  const opened = await openIngest(req, env, p, "states", SYNC_STATE_ENVELOPE_KEYS);
  if ("response" in opened) return opened.response;

  let accepted = 0;
  let dropped = Math.max(0, opened.items.length - SYNC_STATE_BATCH_CAP);
  emitDrop(env, "batch_cap", dropped);
  const reportedAt = Date.now();
  const db = dbFor(env, p.accountId);
  const reasons = new Map<DropReason, number>();
  for (const raw of opened.items.slice(0, SYNC_STATE_BATCH_CAP)) {
    const state = validateSyncState(raw);
    if (!state) {
      dropped++;
      reasons.set("bad_state", (reasons.get("bad_state") ?? 0) + 1);
      continue;
    }
    const authorized = await authorizeWorkspace(env, p, state.workspaceId, state.projectId, false);
    if (!authorized.ok) {
      dropped++;
      reasons.set("unauthorized", (reasons.get("unauthorized") ?? 0) + 1);
      continue;
    }
    await db.prepare(
      `INSERT INTO device_sync_state
       (device_id, workspace_id, project_id, binding_id, file_seq, repos_total, repos_deferred, oldest_deferral_age_ms, deferral_reasons, reported_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(device_id, workspace_id, project_id, binding_id) DO UPDATE SET
         file_seq = excluded.file_seq,
         repos_total = excluded.repos_total,
         repos_deferred = excluded.repos_deferred,
         oldest_deferral_age_ms = excluded.oldest_deferral_age_ms,
         deferral_reasons = excluded.deferral_reasons,
         reported_at = excluded.reported_at`,
    ).bind(
      p.deviceId, state.workspaceId, state.projectId, state.bindingId, state.fileSeq,
      state.reposTotal, state.reposDeferred, state.oldestDeferralAgeMs, state.deferralReasons.join(","), reportedAt,
    ).run();
    accepted++;
  }
  for (const [reason, count] of reasons) emitDrop(env, reason, count);
  return json({ accepted, dropped }, 202);
}
