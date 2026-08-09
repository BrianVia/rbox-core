import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { createWebSession } from "../src/auth.js";
import { createDiagnosticsReport, DIAGNOSTICS_RETENTION_MS, sweepDiagnostics, type DiagnosticsBundle, type DiagnosticsCheckResult, type DiagnosticsChecks } from "../src/diagnostics.js";
import type { Principal } from "../src/authz.js";

const BASE = "https://example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const db = () => env.rbox_dev_db;
const authed = (token: string, extra: Record<string, string> = {}) => ({ authorization: `Bearer ${token}`, ...extra });

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<{ token: string; accountId: string; deviceId: string; ownerUserId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  const b = (await res.json()) as { token: string; accountId: string; deviceId: string };
  const owner = await db().prepare("SELECT user_id FROM memberships WHERE account_id = ? AND role = 'owner'").bind(b.accountId).first<{ user_id: string }>();
  return { ...b, ownerUserId: owner!.user_id };
}

type DiagnosticsFixture = Omit<DiagnosticsBundle, "checks"> & {
  checks: DiagnosticsChecks & { remote: DiagnosticsCheckResult & { rawUrl?: string } };
  surprise?: boolean;
};

function bundle(over: Partial<DiagnosticsFixture> = {}): DiagnosticsFixture {
  return {
    version: "0.6.8",
    platform: { os: "darwin", arch: "arm64" },
    bunVersion: "1.2.0",
    checks: {
      credentials: { ok: true, label: "credentials", message: "authenticated", latencyMs: 12 },
      enrollment: { ok: true, label: "encryption", message: "present" },
      device: { ok: true, label: "device", message: "present" },
      daemon: { ok: true, label: "background sync", message: "running", status: "running", pid: 123 },
      remote: { ok: true, label: "remote", message: "reachable", latencyMs: 8 },
      version: { ok: true, label: "version", message: "up to date", current: "0.6.8", latest: "0.6.8" },
      state: { ok: true, label: "state", message: "ok" },
      crypto: { ok: true, label: "crypto", message: "idle", status: "idle" },
      locking: { ok: true, label: "locking", message: "ok (.rbox/state/sync.lock)", status: "ok" },
      git: { ok: true, label: "git", message: "supported", status: "supported", current: "git version 2.46.0" },
      chain: { ok: true, label: "manifest chain", message: "ok" },
    },
    daemonLogTail: "2026-07-03T00:00:00Z push: published sequence 1 (1 files)\n",
    metrics: { syncs: 1, commitConflicts409: 0, fileConflicts: 0, lockStarved: 2 },
    activity: { at: "2026-07-03T00:00:00.000Z", lastPush: { at: "2026-07-03T00:00:00.000Z", files: 1, sequence: 1 } },
    workspaceShape: { fileCount: 1, totalBytes: 42 },
    ...over,
  };
}

function req(body: unknown): Request {
  return new Request(`${BASE}/v1/diagnostics`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

describe("POST /v1/diagnostics", () => {
  test("accepts the legacy six checks while allowing the exact new optional vocabulary", async () => {
    const a = await bootstrap("diag-compatible-checks");
    const legacy = bundle();
    const checks: Partial<DiagnosticsChecks> = legacy.checks;
    for (const key of ["device", "crypto", "locking", "git", "chain"]) delete checks[key];
    const res = await SELF.fetch(`${BASE}/v1/diagnostics`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(legacy),
    });
    expect(res.status).toBe(200);
  });

  test("stores row-first, writes R2 outside blob accounting, and records bytes + sha", async () => {
    const a = await bootstrap("diag-upload");
    const res = await SELF.fetch(`${BASE}/v1/diagnostics`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(bundle()),
    });
    expect(res.status).toBe(200);
    const { id, expiresAt } = (await res.json()) as { id: string; expiresAt: string };
    expect(id.startsWith("diag_")).toBe(true);
    expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());

    const row = await db()
      .prepare("SELECT r2_key, status, bytes, sha256 FROM diagnostics_reports WHERE id = ? AND account_id = ?")
      .bind(id, a.accountId)
      .first<{ r2_key: string; status: string; bytes: number; sha256: string }>();
    expect(row).toBeTruthy();
    expect(row!.status).toBe("stored");
    expect(row!.r2_key).toBe(`diagnostics/${a.accountId}/${id}.json`);
    expect(row!.r2_key.startsWith("blobs/")).toBe(false);
    const obj = await env.rbox_dev_blobs.get(row!.r2_key);
    expect(obj).not.toBeNull();
    const stored = await obj!.text();
    const storedJson = JSON.parse(stored) as any;
    expect(storedJson.checks.locking).toMatchObject({ status: "ok" });
    expect(storedJson.checks.git).toMatchObject({ status: "supported" });
    expect(storedJson.metrics).toMatchObject({ lockStarved: 2 });
    expect(row!.bytes).toBe(Buffer.byteLength(stored, "utf8"));
    expect(row!.sha256).toBe(sha(stored));
  });

  test("rejects unknown top-level and nested keys as bad_shape", async () => {
    const a = await bootstrap("diag-shape");
    const top = await SELF.fetch(`${BASE}/v1/diagnostics`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(bundle({ surprise: true })),
    });
    expect(top.status).toBe(400);
    expect(((await top.json()) as { error: string }).error).toBe("bad_shape");

    const bad = bundle();
    bad.checks.remote.rawUrl = "https://secret.example";
    const nested = await SELF.fetch(`${BASE}/v1/diagnostics`, {
      method: "POST",
      headers: authed(a.token, { "content-type": "application/json" }),
      body: JSON.stringify(bad),
    });
    expect(nested.status).toBe(400);
    expect(((await nested.json()) as { error: string }).error).toBe("bad_shape");
  });

  test("web-session principals cannot upload diagnostics", async () => {
    const a = await bootstrap("diag-web");
    const web = await createWebSession(env, a.accountId, a.ownerUserId);
    const res = await SELF.fetch(`${BASE}/v1/diagnostics`, {
      method: "POST",
      headers: authed(web.token, { "content-type": "application/json" }),
      body: JSON.stringify(bundle()),
    });
    expect(res.status).toBe(403);
  });

  test("atomic per-account 24h quota admits at most one of two concurrent contenders at cap-1", async () => {
    const a = await bootstrap("diag-rate");
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      await db()
        .prepare("INSERT INTO diagnostics_reports (id, account_id, device_id, created_at, expires_at, r2_key, status, bytes, sha256) VALUES (?, ?, ?, ?, ?, ?, 'stored', 1, ?)")
        .bind(`diag_seed_${i}_${a.accountId}`, a.accountId, a.deviceId, now - i, now + DIAGNOSTICS_RETENTION_MS, `diagnostics/${a.accountId}/seed-${i}.json`, "0".repeat(64))
        .run();
    }
    const post = () =>
      SELF.fetch(`${BASE}/v1/diagnostics`, {
        method: "POST",
        headers: authed(a.token, { "content-type": "application/json" }),
        body: JSON.stringify(bundle()),
      });
    const statuses = (await Promise.all([post(), post()])).map((r: Response) => r.status).sort();
    expect(statuses).toEqual([200, 429]);
    const count = await db().prepare("SELECT COUNT(*) AS n FROM diagnostics_reports WHERE account_id = ? AND created_at > ?").bind(a.accountId, now - 24 * 60 * 60 * 1000).first<{ n: number }>();
    expect(count!.n).toBe(5);
  });

  test("failed R2 put best-effort deletes its pending row so quota is not consumed", async () => {
    const a = await bootstrap("diag-r2-fail");
    const principal: Principal = { accountId: a.accountId, deviceId: a.deviceId, userId: a.ownerUserId, role: "owner", kind: "device" };
    const res = await createDiagnosticsReport(env, principal, req(bundle()), Date.now(), {
      putReport: async () => {
        throw new Error("r2 down");
      },
      deleteReport: async () => {},
    });
    expect(res.status).toBe(500);
    const count = await db().prepare("SELECT COUNT(*) AS n FROM diagnostics_reports WHERE account_id = ?").bind(a.accountId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });
});

describe("diagnostics retention sweep", () => {
  test("deletes stored reports older than 30d and pending rows older than 1h", async () => {
    const a = await bootstrap("diag-sweep");
    const now = Date.now();
    const storedKey = `diagnostics/${a.accountId}/old-stored.json`;
    const pendingKey = `diagnostics/${a.accountId}/old-pending.json`;
    await env.rbox_dev_blobs.put(storedKey, "stored");
    await env.rbox_dev_blobs.put(pendingKey, "pending");
    await db().batch([
      db()
        .prepare("INSERT INTO diagnostics_reports (id, account_id, device_id, created_at, expires_at, r2_key, status, bytes, sha256) VALUES ('diag_old_stored', ?, ?, ?, ?, ?, 'stored', 6, ?)")
        .bind(a.accountId, a.deviceId, now - DIAGNOSTICS_RETENTION_MS - 1_000, now - 1_000, storedKey, sha("stored")),
      db()
        .prepare("INSERT INTO diagnostics_reports (id, account_id, device_id, created_at, expires_at, r2_key, status) VALUES ('diag_old_pending', ?, ?, ?, ?, ?, 'pending')")
        .bind(a.accountId, a.deviceId, now - 2 * 60 * 60 * 1000, now + DIAGNOSTICS_RETENTION_MS, pendingKey),
    ]);

    const swept = await sweepDiagnostics(env, now);
    expect(swept.deleted).toBeGreaterThanOrEqual(2);
    expect(await env.rbox_dev_blobs.get(storedKey)).toBeNull();
    expect(await env.rbox_dev_blobs.get(pendingKey)).toBeNull();
    expect(await db().prepare("SELECT COUNT(*) AS n FROM diagnostics_reports WHERE id IN ('diag_old_stored', 'diag_old_pending')").first<{ n: number }>()).toEqual({ n: 0 });
  });
});
