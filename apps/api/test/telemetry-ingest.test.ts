import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import type { Env } from "../src/env.js";
import type { Principal } from "../src/authz.js";
import {
  ingestSyncState,
  ingestTelemetry,
  SERVER_BINDING_ID_RE,
  SERVER_CORPUS_BUCKETS,
  SERVER_GIT_DEFERRAL_REASONS,
  SERVER_SYNC_STATE_NUMERIC_DOMAINS,
  SERVER_TELEMETRY_SAMPLE_SCHEMAS,
  TELEMETRY_BATCH_CAP as SERVER_TELEMETRY_BATCH_CAP,
} from "../src/telemetry-ingest.js";
import {
  CORPUS_BUCKETS,
  BINDING_ID_RE,
  GIT_DEFERRAL_REASONS,
  SYNC_STATE_NUMERIC_DOMAINS,
  TELEMETRY_BATCH_CAP,
  TELEMETRY_SAMPLE_SCHEMAS,
} from "../../../src/cli/telemetry/contract.js";

const BASE = "https://example.com";
let sequence = 0;

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(prefix: string): Promise<{ token: string; accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: `${prefix}-${++sequence}` }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ token: string; accountId: string; deviceId: string }>;
}

const devicePrincipal = (a: { accountId: string; deviceId: string }): Principal => ({
  accountId: a.accountId,
  deviceId: a.deviceId,
  userId: null,
  role: "owner",
  kind: "device",
});

function testEnv(points: AnalyticsEngineDataPoint[] = [], limiter: RateLimitBinding = { limit: async () => ({ success: true }) }): Env {
  return {
    ...env,
    RL_TELEMETRY: limiter,
    rbox_metrics: { writeDataPoint: (point) => points.push(point) } as AnalyticsEngineDataset,
  } as Env;
}

function post(body: unknown): Request {
  return new Request(`${BASE}/v1/telemetry`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

describe("telemetry contract drift guard", () => {
  test("server runtime constants equal the client wire contract", () => {
    const serverShape = Object.fromEntries(Object.entries(SERVER_TELEMETRY_SAMPLE_SCHEMAS).map(([kind, schema]) => [kind, {
      numbers: Object.fromEntries(schema.numbers.map(({ field, ...domain }) => [field, domain])),
      enums: Object.fromEntries(schema.enums.map(({ field, values }) => [field, values])),
    }]));
    expect(serverShape).toEqual(TELEMETRY_SAMPLE_SCHEMAS);
    expect(SERVER_CORPUS_BUCKETS).toEqual(CORPUS_BUCKETS);
    expect(SERVER_GIT_DEFERRAL_REASONS).toEqual(GIT_DEFERRAL_REASONS);
    expect(SERVER_SYNC_STATE_NUMERIC_DOMAINS).toEqual(SYNC_STATE_NUMERIC_DOMAINS);
    expect(SERVER_TELEMETRY_BATCH_CAP).toBe(TELEMETRY_BATCH_CAP);
    expect({ source: SERVER_BINDING_ID_RE.source, flags: SERVER_BINDING_ID_RE.flags }).toEqual({ source: BINDING_ID_RE.source, flags: BINDING_ID_RE.flags });
  });
});

describe("POST /v1/telemetry", () => {
  test("normalizes all families into the locked positional AE layout", async () => {
    const a = await bootstrap("telemetry-layout");
    const points: AnalyticsEngineDataPoint[] = [];
    const res = await ingestTelemetry(post({ v: 1, samples: [
      { kind: "propagation", deliveryToApplyMs: 7 },
      { kind: "first_publish", timeToFilesSyncedMs: 11, pushWallMs: 12, fileCount: 101, uniqueBlobs: 9 },
      { kind: "upload_lane", transport: "pack", bytes: 1_000_000, uploadMs: 1_000, opCount: 2, fillVersion: "v2" },
      { kind: "capability", workerExecutions: 4 },
      { kind: "safety_event", eventType: "scan_fault", count: 3 },
    ] }), testEnv(points), devicePrincipal(a));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 5, dropped: 0 });
    expect(points).toEqual([
      { indexes: ["client.propagation"], blobs: ["client.propagation"], doubles: [7] },
      { indexes: ["client.first_publish"], blobs: ["client.first_publish", "s"], doubles: [11, 12, 101, 9] },
      { indexes: ["client.upload_lane"], blobs: ["client.upload_lane", "pack", "v2"], doubles: [8, 1_000_000, 1_000, 2] },
      { indexes: ["client.capability"], blobs: ["client.capability"], doubles: [4] },
      { indexes: ["client.safety_event"], blobs: ["client.safety_event", "scan_fault"], doubles: [3] },
    ]);
  });

  test("derives corpus buckets at every locked boundary", async () => {
    const a = await bootstrap("telemetry-buckets");
    const points: AnalyticsEngineDataPoint[] = [];
    const counts = [100, 101, 1_000, 1_001, 10_000, 10_001, 100_000, 100_001];
    const samples = counts.map((fileCount) => ({ kind: "first_publish", timeToFilesSyncedMs: 0, pushWallMs: 0, fileCount, uniqueBlobs: 0 }));
    expect((await ingestTelemetry(post({ v: 1, samples }), testEnv(points), devicePrincipal(a))).status).toBe(202);
    expect(points.map((point) => point.blobs?.[1])).toEqual(["xs", "s", "s", "m", "m", "l", "l", "xl"]);
  });

  test("drops hostile strings, extra fields, unknown kinds, bad domains, and derived-mbps poison without forwarding payload values", async () => {
    const a = await bootstrap("telemetry-privacy");
    const points: AnalyticsEngineDataPoint[] = [];
    const hostile = "dev_0123456789abcdef/path/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await ingestTelemetry(post({ v: 1, samples: [
      { kind: "safety_event", eventType: hostile, count: 1 },
      { kind: "propagation", deliveryToApplyMs: 1, deviceId: hostile },
      { kind: hostile, count: 1 },
      { kind: "capability", workerExecutions: 1_000_000_001 },
      { kind: "propagation" },
      { kind: "propagation", deliveryToApplyMs: "7" },
      { kind: "propagation", deliveryToApplyMs: 1.5 },
      { kind: "propagation", deliveryToApplyMs: -1 },
      { kind: "upload_lane", transport: "single", bytes: 1, uploadMs: 0, opCount: 1, fillVersion: "v1" },
      { kind: "upload_lane", transport: "single", bytes: 10_000_000_000_000, uploadMs: 1, opCount: 1, fillVersion: "v1" },
    ] }), testEnv(points), devicePrincipal(a));
    expect(await res.json()).toEqual({ accepted: 0, dropped: 10 });
    expect(JSON.stringify(points)).not.toContain(hostile);
    expect(points.every((point) => point.indexes?.[0] === "client.telemetry.drops")).toBe(true);
    expect(points.map((point) => point.blobs?.[1])).toEqual(expect.arrayContaining(["bad_enum", "unknown_field", "unknown_kind", "bad_number"]));
  });

  test("distinguishes protocol errors, caps batches, emits cap counters, and rate-limits by device", async () => {
    const a = await bootstrap("telemetry-protocol");
    const points: AnalyticsEngineDataPoint[] = [];
    expect((await ingestTelemetry(post({ v: 2, samples: [] }), testEnv(points), devicePrincipal(a))).status).toBe(400);
    expect((await ingestTelemetry(new Request(`${BASE}/v1/telemetry`, { method: "POST", body: "{" }), testEnv(points), devicePrincipal(a))).status).toBe(400);
    expect((await ingestTelemetry(new Request(`${BASE}/v1/telemetry`, { method: "POST", body: "x".repeat(32 * 1024 + 1) }), testEnv(points), devicePrincipal(a))).status).toBe(413);

    const samples = Array.from({ length: 66 }, () => ({ kind: "capability", workerExecutions: 1 }));
    const capped = await ingestTelemetry(post({ v: 1, samples }), testEnv(points), devicePrincipal(a));
    expect(await capped.json()).toEqual({ accepted: 64, dropped: 2 });
    expect(points.some((point) => point.blobs?.[1] === "body_cap")).toBe(true);
    expect(points.some((point) => point.blobs?.[1] === "batch_cap" && point.doubles?.[0] === 2)).toBe(true);

    const keys: string[] = [];
    const denied = await ingestTelemetry(post({ v: 1, samples: [] }), testEnv([], { limit: async ({ key }) => (keys.push(key), { success: false }) }), devicePrincipal(a));
    expect(denied.status).toBe(429);
    expect(keys).toEqual([a.deviceId]);
  });
});

describe("POST /v1/fleet/sync-state", () => {
  test("upserts an authorized valid state and server-stamps reported_at", async () => {
    const a = await bootstrap("sync-state-upsert");
    const wsA = `ws_state_${sequence}_a`;
    await env.rbox_dev_db.prepare("INSERT INTO workspaces(workspace_id, project_id, created_at, account_id) VALUES (?, 'root', ?, ?)").bind(wsA, Date.now(), a.accountId).run();
    const valid = { workspaceId: wsA, projectId: "root", bindingId: "0123456789abcdef", fileSeq: 12, reposTotal: 2, reposDeferred: 1, oldestDeferralAgeMs: 99, deferralReasons: ["local-edits"] };
    const req = new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [valid] }) });
    const before = Date.now();
    const res = await ingestSyncState(req, testEnv(), devicePrincipal(a));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, dropped: 0 });
    const row = await env.rbox_dev_db.prepare("SELECT * FROM device_sync_state WHERE device_id = ?").bind(a.deviceId).first<Record<string, unknown>>();
    expect(row).toMatchObject({ workspace_id: wsA, project_id: "root", binding_id: valid.bindingId, file_seq: 12, repos_total: 2, repos_deferred: 1, oldest_deferral_age_ms: 99, deferral_reasons: "local-edits" });
    expect(Number(row?.reported_at)).toBeGreaterThanOrEqual(before);
  });

  test("canonicalizes reasons and reports invalid and unauthorized state drops", async () => {
    const a = await bootstrap("sync-state-reasons-a");
    const b = await bootstrap("sync-state-reasons-b");
    const wsA = `ws_state_${sequence}_a`;
    const wsB = `ws_state_${sequence}_b`;
    await env.rbox_dev_db.batch([
      env.rbox_dev_db.prepare("INSERT INTO workspaces(workspace_id, project_id, created_at, account_id) VALUES (?, 'root', ?, ?)").bind(wsA, Date.now(), a.accountId),
      env.rbox_dev_db.prepare("INSERT INTO workspaces(workspace_id, project_id, created_at, account_id) VALUES (?, 'root', ?, ?)").bind(wsB, Date.now(), b.accountId),
    ]);
    const valid = { workspaceId: wsA, projectId: "root", bindingId: "0123456789abcdef", fileSeq: 12, reposTotal: 2, reposDeferred: 1, oldestDeferralAgeMs: 99, deferralReasons: ["local-edits"] };
    const unauthorized = { ...valid, workspaceId: wsB, bindingId: "1111111111111111" };
    const invalid = { ...valid, bindingId: "2222222222222222", reposDeferred: 0 };
    const points: AnalyticsEngineDataPoint[] = [];
    const mixed = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [unauthorized, invalid] }) }), testEnv(points), devicePrincipal(a));
    expect(await mixed.json()).toEqual({ accepted: 0, dropped: 2 });
    expect(points).toEqual(expect.arrayContaining([
      { indexes: ["client.telemetry.drops"], blobs: ["client.telemetry.drops", "bad_state"], doubles: [1] },
      { indexes: ["client.telemetry.drops"], blobs: ["client.telemetry.drops", "unauthorized"], doubles: [1] },
    ]));

    const duplicateReasons = { ...valid, fileSeq: 12, deferralReasons: ["local-edits", "local-edits"] };
    const viewerReport = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [duplicateReasons] }) }), testEnv(), { ...devicePrincipal(a), role: "viewer" });
    expect(await viewerReport.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(await env.rbox_dev_db.prepare("SELECT deferral_reasons FROM device_sync_state WHERE device_id = ?").bind(a.deviceId).first()).toMatchObject({ deferral_reasons: "local-edits" });
  });

  test("updates an existing state in place", async () => {
    const a = await bootstrap("sync-state-update");
    const wsA = `ws_state_${sequence}_a`;
    await env.rbox_dev_db.prepare("INSERT INTO workspaces(workspace_id, project_id, created_at, account_id) VALUES (?, 'root', ?, ?)").bind(wsA, Date.now(), a.accountId).run();
    const valid = { workspaceId: wsA, projectId: "root", bindingId: "0123456789abcdef", fileSeq: 12, reposTotal: 2, reposDeferred: 1, oldestDeferralAgeMs: 99, deferralReasons: ["local-edits"] };
    await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [valid] }) }), testEnv(), devicePrincipal(a));
    const update = { ...valid, fileSeq: 13, reposDeferred: 0, oldestDeferralAgeMs: null, deferralReasons: [] };
    const updated = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [update] }) }), testEnv(), devicePrincipal(a));
    expect(await updated.json()).toEqual({ accepted: 1, dropped: 0 });
    expect(await env.rbox_dev_db.prepare("SELECT file_seq, repos_deferred FROM device_sync_state WHERE device_id = ?").bind(a.deviceId).first()).toMatchObject({ file_seq: 13, repos_deferred: 0 });
    expect((await env.rbox_dev_db.prepare("SELECT COUNT(*) AS count FROM device_sync_state WHERE device_id = ?").bind(a.deviceId).first<{ count: number }>())?.count).toBe(1);
  });

  test("caps sync-state batches", async () => {
    const a = await bootstrap("sync-state-cap");
    const capPoints: AnalyticsEngineDataPoint[] = [];
    const capped = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: Array.from({ length: 34 }, () => ({})) }) }), testEnv(capPoints), devicePrincipal(a));
    expect(await capped.json()).toEqual({ accepted: 0, dropped: 34 });
    expect(capPoints).toContainEqual({ indexes: ["client.telemetry.drops"], blobs: ["client.telemetry.drops", "batch_cap"], doubles: [2] });
  });

  test("strictly validates every sync-state field and shares the device rate-limit/body cap", async () => {
    const a = await bootstrap("sync-state-validation");
    const ws = `ws_validation_${sequence}`;
    await env.rbox_dev_db.prepare("INSERT INTO workspaces(workspace_id, project_id, created_at, account_id) VALUES (?, 'root', ?, ?)").bind(ws, Date.now(), a.accountId).run();
    const base = { workspaceId: ws, projectId: "root", bindingId: "0123456789abcdef", fileSeq: 1, reposTotal: 1, reposDeferred: 1, oldestDeferralAgeMs: 1, deferralReasons: ["local-edits"] };
    const invalid = [
      { ...base, extra: "dev_identifier" },
      { ...base, bindingId: "0123456789abcdeF" },
      { ...base, fileSeq: 1.5 },
      { ...base, reposDeferred: 2 },
      { ...base, reposDeferred: 0, oldestDeferralAgeMs: 1, deferralReasons: [] },
      { ...base, oldestDeferralAgeMs: null },
      { ...base, deferralReasons: [] },
      { ...base, deferralReasons: ["not-a-reason"] },
      { ...base, deferralReasons: Array.from({ length: 16 }, () => "local-edits") },
    ];
    const response = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: invalid }) }), testEnv(), devicePrincipal(a));
    expect(await response.json()).toEqual({ accepted: 0, dropped: invalid.length });
    expect((await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [], extra: true }) }), testEnv(), devicePrincipal(a))).status).toBe(400);
    expect((await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: "x".repeat(32 * 1024 + 1) }), testEnv(), devicePrincipal(a))).status).toBe(413);
    const keys: string[] = [];
    const limited = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [] }) }), testEnv([], { limit: async ({ key }) => (keys.push(key), { success: false }) }), devicePrincipal(a));
    expect(limited.status).toBe(429);
    expect(keys).toEqual([a.deviceId]);
  });

  test("enforces device-only handlers and default-deny worker gates for web/API-key kinds", async () => {
    const a = await bootstrap("telemetry-kinds");
    for (const kind of ["web", "api_key"] as const) {
      await env.rbox_dev_db.prepare("UPDATE devices SET kind = ? WHERE device_id = ?").bind(kind, a.deviceId).run();
      const headers = { authorization: `Bearer ${a.token}` };
      const telemetry = await SELF.fetch(`${BASE}/v1/telemetry`, { method: "POST", headers, body: JSON.stringify({ v: 1, samples: [] }) });
      const syncState = await SELF.fetch(`${BASE}/v1/fleet/sync-state`, { method: "POST", headers, body: JSON.stringify({ v: 1, states: [] }) });
      expect(telemetry.status, kind).toBe(403);
      expect(syncState.status, kind).toBe(403);
    }
    const direct = await ingestSyncState(new Request(`${BASE}/v1/fleet/sync-state`, { method: "POST", body: JSON.stringify({ v: 1, states: [] }) }), testEnv(), { ...devicePrincipal(a), kind: "web" });
    expect(direct.status).toBe(403);
  });

});
