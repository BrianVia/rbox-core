import { env, applyD1Migrations } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Env } from "../src/env.js";
import { evaluateFleetAlerts, renderFleetBinding, renderFleetDeviceLabel } from "../src/fleet-alerts.js";
import worker, { GC_MARK_UTC_HOUR, GC_PURGE_UTC_HOUR } from "../src/worker.js";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 6, 16, 10, 0, 0);
const realFetch = globalThis.fetch;

interface AlertState {
  condition: string;
  incident_started_at: number;
  last_notified_at: number;
  resolved_at: number | null;
  resolve_notified_at: number | null;
}

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await env.rbox_dev_db.batch([
    env.rbox_dev_db.prepare("DELETE FROM alert_state"),
    env.rbox_dev_db.prepare("DELETE FROM device_sync_state"),
  ]);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function alertEnv(extra: Partial<Env> = {}): Env {
  return { ...env, SLACKPIPES_WEBHOOK_URL: undefined, SLACKPIPES_ALERTS_WEBHOOK_URL: "https://hook.test/alerts", ...extra } as Env;
}

function capture(status = 200): string[] {
  const messages: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    messages.push((JSON.parse(String(init?.body)) as { text: string }).text);
    return new Response("ok", { status });
  }) as typeof fetch;
  return messages;
}

async function sync(o: {
  device?: string;
  workspace?: string;
  project?: string;
  binding?: string;
  total?: number;
  deferred?: number;
  age?: number | null;
  reasons?: string;
  reported?: number;
} = {}): Promise<void> {
  await env.rbox_dev_db.prepare(`INSERT INTO device_sync_state
    (device_id, workspace_id, project_id, binding_id, file_seq, repos_total, repos_deferred, oldest_deferral_age_ms, deferral_reasons, reported_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`)
    .bind(
      o.device ?? "dev_fleet_test_0001",
      o.workspace ?? "ws_1234567890abcdef",
      o.project ?? "root",
      o.binding ?? "aaaaaaaaaaaaaaaa",
      o.total ?? 101,
      o.deferred ?? 2,
      o.age === undefined ? 25 * HOUR : o.age,
      o.reasons ?? "conflict,local-edits",
      o.reported ?? NOW,
    ).run();
}

async function state(condition: string, device = "dev_fleet_test_0001", workspace = "", project = "", binding = ""): Promise<AlertState | null> {
  return env.rbox_dev_db.prepare(`SELECT condition, incident_started_at, last_notified_at, resolved_at, resolve_notified_at
    FROM alert_state WHERE condition = ? AND device_id = ? AND workspace_id = ? AND project_id = ? AND binding_id = ?`)
    .bind(condition, device, workspace, project, binding).first<AlertState>();
}

async function seedState(o: {
  condition: "drift" | "reporting_stopped";
  started: number;
  notified?: number;
  resolved?: number | null;
  resolveNotified?: number | null;
  device?: string;
  workspace?: string;
  project?: string;
  binding?: string;
}): Promise<void> {
  await env.rbox_dev_db.prepare(`INSERT INTO alert_state
    (condition, device_id, workspace_id, project_id, binding_id, incident_started_at, last_notified_at, resolved_at, resolve_notified_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(o.condition, o.device ?? "dev_fleet_test_0001", o.workspace ?? "", o.project ?? "", o.binding ?? "", o.started,
      o.notified ?? o.started, o.resolved ?? null, o.resolveNotified ?? null).run();
}

describe("evaluateFleetAlerts state machine", () => {
  test("fires only for fresh drift strictly over 24h", async () => {
    const messages = capture();
    await sync({ age: 24 * HOUR + 1 });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/^⚠️ drift: dev_fleet_te… · ws_1234…\/root · 2\/101 repos deferred 24h \(conflict, local-edits\)$/);
    expect((await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa"))?.resolved_at).toBeNull();
  });

  test("does not fire drift at exactly 24h", async () => {
    const messages = capture();
    await sync({ age: 24 * HOUR });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([]);
    expect(await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa")).toBeNull();
  });

  test("the exact 2.5h boundary is fresh; one millisecond older is stopped", async () => {
    const messages = capture();
    await sync({ reported: NOW - 2.5 * HOUR, deferred: 0, age: null, reasons: "" });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([]);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET reported_at = ?").bind(NOW - 2.5 * HOUR - 1).run();
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([expect.stringMatching(/^⚠️ reporting stopped:/)]);
  });

  test("a stale drift row neither fires nor resolves an open incident", async () => {
    const messages = capture();
    await sync({ reported: NOW - 3 * HOUR });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([expect.stringContaining("reporting stopped")]);
    expect(await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa")).toBeNull();

    await seedState({ condition: "drift", started: NOW - HOUR, workspace: "ws_1234567890abcdef", project: "root", binding: "aaaaaaaaaaaaaaaa" });
    messages.length = 0;
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([]);
    expect((await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa"))?.resolved_at).toBeNull();
  });

  test("fresh positive evidence resolves drift", async () => {
    const messages = capture();
    await sync();
    await evaluateFleetAlerts(alertEnv(), NOW);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 0, oldest_deferral_age_ms = NULL, reported_at = ?").bind(NOW + HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    expect(messages.filter((m) => m.startsWith("✅ resolved:"))).toHaveLength(1);
    expect((await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa"))?.resolved_at).toBe(NOW + HOUR);
  });

  test("reporting stopped is one device-level latch for N bindings and resolves only after a fresh report", async () => {
    const messages = capture();
    await sync({ reported: NOW - 4 * HOUR, binding: "aaaaaaaaaaaaaaaa" });
    await sync({ reported: NOW - 5 * HOUR, workspace: "ws_other", binding: "bbbbbbbbbbbbbbbb" });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages.filter((m) => m.startsWith("⚠️ reporting stopped:"))).toHaveLength(1);
    expect(messages[0]).toContain("2 bindings");
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    expect(messages).toHaveLength(1);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET reported_at = ? WHERE binding_id = 'bbbbbbbbbbbbbbbb'").bind(NOW + HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    expect(messages.filter((m) => m.includes("reporting resumed"))).toHaveLength(1);
  });

  test("resolve then re-fire inside 2h continues silently as one incident", async () => {
    const messages = capture();
    await sync();
    await evaluateFleetAlerts(alertEnv(), NOW);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 0, reported_at = ?").bind(NOW + HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 2, oldest_deferral_age_ms = ?, reported_at = ?").bind(26 * HOUR, NOW + HOUR + 1).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR + 1);
    expect(messages.filter((m) => m.startsWith("⚠️"))).toHaveLength(1);
    expect((await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa"))?.incident_started_at).toBe(NOW);
  });

  test("fire-resolve-continuation-resolve emits exactly one resolve", async () => {
    const messages = capture();
    await sync();
    await evaluateFleetAlerts(alertEnv(), NOW);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 0, reported_at = ?").bind(NOW + HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 2, oldest_deferral_age_ms = ?, reported_at = ?").bind(26 * HOUR, NOW + HOUR + 1).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR + 1);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 0, reported_at = ?").bind(NOW + HOUR + 2).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR + 2);
    expect(messages.filter((m) => m.startsWith("✅ resolved:"))).toHaveLength(1);
    expect((await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa"))?.resolved_at).toBe(NOW + HOUR + 2);
  });

  test("renotifies inclusively at 24h", async () => {
    const messages = capture();
    await sync();
    await evaluateFleetAlerts(alertEnv(), NOW);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET reported_at = ?, oldest_deferral_age_ms = ?").bind(NOW + DAY, 25 * HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + DAY);
    expect(messages.filter((m) => m.startsWith("still: drift:"))).toHaveLength(1);
  });

  test("renotifies at the exact 7d boundary, then stays open and silent but resolvable", async () => {
    const messages = capture();
    await sync();
    await seedState({ condition: "drift", started: NOW - 7 * DAY, notified: NOW - DAY, workspace: "ws_1234567890abcdef", project: "root", binding: "aaaaaaaaaaaaaaaa" });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([expect.stringMatching(/^still: drift:/)]);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET reported_at = ?, oldest_deferral_age_ms = ?").bind(NOW + DAY + 1, 25 * HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + DAY + 1);
    expect(messages).toHaveLength(1);
    expect((await state("drift", "dev_fleet_test_0001", "ws_1234567890abcdef", "root", "aaaaaaaaaaaaaaaa"))?.resolved_at).toBeNull();
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET repos_deferred = 0, reported_at = ?").bind(NOW + DAY + 2).run();
    await evaluateFleetAlerts(alertEnv(), NOW + DAY + 2);
    expect(messages.at(-1)).toMatch(/^✅ resolved:/);
  });

  test("stopped coverage suppresses stale drift, and pinned stopped-first evaluation lets it resume on recovery", async () => {
    const messages = capture();
    await sync({ reported: NOW - 4 * HOUR, binding: "aaaaaaaaaaaaaaaa" });
    await sync({ reported: NOW - 4 * HOUR, workspace: "ws_other", binding: "bbbbbbbbbbbbbbbb", deferred: 0, age: null });
    await seedState({ condition: "drift", started: NOW - 2 * DAY, notified: NOW - DAY, workspace: "ws_1234567890abcdef", project: "root", binding: "aaaaaaaaaaaaaaaa" });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([expect.stringMatching(/^⚠️ reporting stopped:/)]);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET reported_at = ? WHERE binding_id = 'bbbbbbbbbbbbbbbb'").bind(NOW + HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    expect(messages).toContainEqual(expect.stringContaining("reporting resumed"));
    expect(messages).toContainEqual(expect.stringMatching(/^still: drift:.*binding stale since/));
  });

  test("stale drift resumes when an older stopped incident crosses its 7d silence boundary", async () => {
    const messages = capture();
    await sync({ reported: NOW - 4 * HOUR });
    await seedState({ condition: "reporting_stopped", started: NOW - 7 * DAY - 1, notified: NOW - DAY });
    await seedState({ condition: "drift", started: NOW - 2 * DAY, notified: NOW - DAY, workspace: "ws_1234567890abcdef", project: "root", binding: "aaaaaaaaaaaaaaaa" });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([expect.stringMatching(/^still: drift:.*binding stale since/)]);
  });

  test("stopped coverage remains active at its exact 7d boundary and exits immediately after", async () => {
    const messages = capture();
    await sync({ reported: NOW - 4 * HOUR });
    await seedState({ condition: "reporting_stopped", started: NOW - 7 * DAY, notified: NOW - DAY });
    await seedState({ condition: "drift", started: NOW - 2 * DAY, notified: NOW - DAY, workspace: "ws_1234567890abcdef", project: "root", binding: "aaaaaaaaaaaaaaaa" });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([expect.stringMatching(/^still: reporting stopped:/)]);
    await evaluateFleetAlerts(alertEnv(), NOW + 1);
    expect(messages).toContainEqual(expect.stringMatching(/^still: drift:.*binding stale since/));
  });

  test("concurrent evaluators spend one conditional claim and send once", async () => {
    const messages = capture();
    await sync();
    await Promise.all([evaluateFleetAlerts(alertEnv(), NOW), evaluateFleetAlerts(alertEnv(), NOW)]);
    expect(messages.filter((m) => m.startsWith("⚠️ drift:"))).toHaveLength(1);
  });

  test("a failed send spends its claim and does not retry before renotify", async () => {
    const messages = capture(400);
    await sync();
    await evaluateFleetAlerts(alertEnv(), NOW);
    await evaluateFleetAlerts(alertEnv(), NOW + HOUR);
    expect(messages).toHaveLength(1);
    await env.rbox_dev_db.prepare("UPDATE device_sync_state SET reported_at = ?, oldest_deferral_age_ms = ?").bind(NOW + DAY, 25 * HOUR).run();
    await evaluateFleetAlerts(alertEnv(), NOW + DAY);
    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatch(/^still: drift:/);
  });

  test("zero sync rows delete an open stopped incident without a message", async () => {
    const messages = capture();
    await seedState({ condition: "reporting_stopped", started: NOW - DAY });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(messages).toEqual([]);
    expect(await state("reporting_stopped")).toBeNull();
  });

  test("both absent webhook variables produce zero network", async () => {
    let calls = 0;
    globalThis.fetch = (async () => (calls++, new Response("ok"))) as typeof fetch;
    await sync();
    await evaluateFleetAlerts(alertEnv({ SLACKPIPES_WEBHOOK_URL: undefined, SLACKPIPES_ALERTS_WEBHOOK_URL: undefined }), NOW);
    expect(calls).toBe(0);
  });

  test("prunes old resolved rows but retains the 30d boundary", async () => {
    capture();
    await seedState({ condition: "reporting_stopped", started: NOW - 40 * DAY, resolved: NOW - 30 * DAY - 1 });
    await seedState({ condition: "reporting_stopped", device: "dev_boundary", started: NOW - 40 * DAY, resolved: NOW - 30 * DAY });
    await evaluateFleetAlerts(alertEnv(), NOW);
    expect(await state("reporting_stopped")).toBeNull();
    expect(await state("reporting_stopped", "dev_boundary")).not.toBeNull();
  });
});

describe("fleet alert privacy rendering", () => {
  test("a missing label falls back to the truncated device id", () => {
    expect(renderFleetDeviceLabel(null, "dev_0123456789abcdef")).toBe("dev_01234567…");
  });

  test.each(["/home/user/project", "C:\\Users\\x", "a@b.com", "https://host/path"])("suspicious label %s falls back to device id", (label) => {
    expect(renderFleetDeviceLabel(label, "dev_0123456789abcdef")).toBe("dev_01234567…");
  });

  test("Slack markup is neutralized, controls collapse, and overlength Unicode clamps", () => {
    expect(renderFleetDeviceLabel("<!channel>", "dev_x")).toBe("&lt;!channel&gt;");
    expect(renderFleetDeviceLabel("<@U123>", "dev_0123456789abcdef")).toBe("dev_01234567…");
    expect(renderFleetDeviceLabel("good\u0000\r\n host", "dev_x")).toBe("good host");
    expect(Array.from(renderFleetDeviceLabel("😀".repeat(100), "dev_x")).length).toBeLessThanOrEqual(80);
  });

  test.each(["/home/user/project", "C:\\Users\\x", "a@b.com", "<!channel>", "<@U123>"])("suspicious project %s renders workspace only", (project) => {
    expect(renderFleetBinding("ws_1234567890", project)).toBe("ws_1234…");
  });

  test("project controls collapse, project Unicode clamps, and workspace markup escapes", () => {
    expect(renderFleetBinding("ws_safe", "good\u0000\r\n project")).toBe("ws_safe/good project");
    expect(Array.from(renderFleetBinding("ws_safe", "😀".repeat(100)).split("/")[1]!).length).toBeLessThanOrEqual(80);
    expect(renderFleetBinding("ws_<&>", "root")).toBe("ws_&lt;&amp;&gt;/root");
  });
});

describe("scheduled wiring", () => {
  test("GC-reserved hours skip alerts and a regular tick evaluates them", async () => {
    const messages = capture();
    await sync({ age: 25 * HOUR });
    const scheduled = (hour: number): ScheduledController => ({ scheduledTime: Date.UTC(2026, 6, 16, hour), cron: "23 * * * *", noRetry: () => {} });
    await worker.scheduled(scheduled(GC_MARK_UTC_HOUR), alertEnv({ RBOX_GC_PURGE_DISABLED: "1" }));
    await worker.scheduled(scheduled(GC_PURGE_UTC_HOUR), alertEnv({ RBOX_GC_PURGE_DISABLED: "1" }));
    expect(messages).toEqual([]);
    await worker.scheduled(scheduled(10), alertEnv({ RBOX_GC_PURGE_DISABLED: "1", DEVICE_NOTIFICATIONS_DISABLED: "1" }));
    expect(messages).toContainEqual(expect.stringMatching(/^⚠️ drift:/));
  });
});
