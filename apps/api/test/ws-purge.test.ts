import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import type { Env } from "../src/env.js";
import { adminPurgeWorkspace, WS_PURGE_PAIR_BATCH, type WsPurgeCounts } from "../src/ws-purge.js";

const BASE = "https://example.com";
const db = () => env.rbox_dev_db;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const platform = { "x-rbox-platform": "test-platform-secret" };

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<{ accountId: string; deviceId: string }> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name }),
  });
  expect(res.status).toBe(200);
  return res.json() as Promise<{ accountId: string; deviceId: string }>;
}

async function seed(accountId: string, workspaceId: string, projectId: string, shas: string[]): Promise<void> {
  const now = Date.now();
  await db().prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES (?, ?, ?, ?)").bind(workspaceId, projectId, accountId, now).run();
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < shas.length; i++) {
    const sequence = i + 1;
    statements.push(
      db().prepare("INSERT INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig) VALUES (?, ?, ?, ?, ?, ?)").bind(workspaceId, projectId, sequence, `commit-${sequence}`, "opaque", "sig"),
      db().prepare("INSERT INTO manifests (workspace_id, project_id, sequence, manifest_blob_sha) VALUES (?, ?, ?, ?)").bind(workspaceId, projectId, sequence, shas[i]!),
      db().prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes) VALUES (?, ?)").bind(shas[i]!, 10),
      db().prepare("INSERT OR IGNORE INTO blob_refs (account_id, sha256) VALUES (?, ?)").bind(accountId, shas[i]!),
    );
  }
  statements.push(
    db().prepare("INSERT OR IGNORE INTO workspace_keys (workspace_id, account_id, key_epoch, created_at) VALUES (?, ?, 1, ?)").bind(workspaceId, accountId, now),
    db().prepare("INSERT OR IGNORE INTO workspace_keys (workspace_id, account_id, key_epoch, created_at) VALUES (?, ?, 2, ?)").bind(workspaceId, accountId, now),
  );
  await db().batch(statements);
}

async function counts(workspaceId: string): Promise<WsPurgeCounts> {
  const n = async (table: string) => Number((await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE workspace_id = ?`).bind(workspaceId).first<{ n: number }>())!.n);
  return { commits: await n("commits"), manifests: await n("manifests"), device_sync_state: await n("device_sync_state"), workspace_keys: await n("workspace_keys"), workspaces: await n("workspaces") };
}

async function body<T>(response: Response): Promise<T> {
  return response.json() as Promise<T>;
}

describe("DELETE /v1/admin/workspace/:id", () => {
  test("is secret- and method-gated without mutating rows", async () => {
    const account = await bootstrap("ws-purge-gate");
    const ws = "ws_purge_gate";
    await seed(account.accountId, ws, "root", [sha("gate")]);
    const before = await counts(ws);

    expect((await SELF.fetch(`${BASE}/v1/admin/workspace/${ws}`, { method: "DELETE" })).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/v1/admin/workspace/${ws}`, { method: "DELETE", headers: { "x-rbox-platform": "wrong" } })).status).toBe(404);
    // Method-gated: a GET never matches the admin route, so it falls through to
    // authenticate() and 401s on the missing bearer — it must not reach the purge.
    expect((await SELF.fetch(`${BASE}/v1/admin/workspace/${ws}`, { method: "GET", headers: platform })).status).toBe(401);
    expect(await counts(ws)).toEqual(before);
  });

  test("returns the obscured not-found shape for an unknown id", async () => {
    const res = await SELF.fetch(`${BASE}/v1/admin/workspace/ws_never_seen`, { method: "DELETE", headers: platform });
    expect(res.status).toBe(404);
    expect(await body(res)).toEqual({ error: "not_found" });
  });

  test("dry-run reports exact counts and performs no mutations", async () => {
    const account = await bootstrap("ws-purge-dry");
    const ws = "ws_purge_dry";
    await seed(account.accountId, ws, "root", [sha("dry-1"), sha("dry-2")]);
    const before = await counts(ws);
    const res = await SELF.fetch(`${BASE}/v1/admin/workspace/${ws}?dryRun=1`, { method: "DELETE", headers: platform });
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, workspaceId: ws, dryRun: true, counts: before, done: false });
    expect(await counts(ws)).toEqual(before);
  });
});

describe("adminPurgeWorkspace", () => {
  test("purges an alert-only orphan pair", async () => {
    const ws = "ws_purge_alert_orphan";
    await db().prepare("INSERT INTO alert_state(condition,device_id,workspace_id,project_id,binding_id,incident_started_at,last_notified_at) VALUES ('drift','dev_orphan',?,'root','cccccccccccccccc',1,1)").bind(ws).run();
    const purged: string[] = [];
    const res = await adminPurgeWorkspace(env as Env, ws, { purgeWorkspace: async (_env, w, p) => (purged.push(`${w}/${p}`), true) });
    expect(res.status).toBe(200);
    expect(await body<{ done: boolean }>(res)).toMatchObject({ done: true });
    expect(purged).toEqual([`${ws}/root`]);
    expect(await db().prepare("SELECT 1 FROM alert_state WHERE workspace_id = ?").bind(ws).first()).toBeNull();
  });

  test("fully purges every pair and becomes not found", async () => {
    const account = await bootstrap("ws-purge-full");
    const ws = "ws_purge_full";
    await seed(account.accountId, ws, "alpha", [sha("full-a")]);
    await seed(account.accountId, ws, "beta", [sha("full-b")]);
    await db().batch([
      db().prepare("INSERT INTO device_sync_state(device_id,workspace_id,project_id,binding_id,file_seq,repos_total,repos_deferred,oldest_deferral_age_ms,deferral_reasons,reported_at) VALUES ('dev_a',?,'alpha','0000000000000001',1,0,0,NULL,'',1)").bind(ws),
      db().prepare("INSERT INTO device_sync_state(device_id,workspace_id,project_id,binding_id,file_seq,repos_total,repos_deferred,oldest_deferral_age_ms,deferral_reasons,reported_at) VALUES ('dev_a',?,'beta','0000000000000002',1,0,0,NULL,'',1)").bind(ws),
      db().prepare("INSERT INTO alert_state(condition,device_id,workspace_id,project_id,binding_id,incident_started_at,last_notified_at) VALUES ('drift','dev_a',?,'alpha','0000000000000001',1,1)").bind(ws),
      db().prepare("INSERT INTO alert_state(condition,device_id,workspace_id,project_id,binding_id,incident_started_at,last_notified_at) VALUES ('drift','dev_a',?,'beta','0000000000000002',1,1)").bind(ws),
    ]);
    const purged: string[] = [];
    let result: { done: boolean };
    do {
      const res = await adminPurgeWorkspace(env as Env, ws, { purgeWorkspace: async (_env, w, p) => (purged.push(`${w}/${p}`), true) });
      expect(res.status).toBe(200);
      result = await body(res);
    } while (!result.done);
    expect(await counts(ws)).toEqual({ commits: 0, manifests: 0, device_sync_state: 0, workspace_keys: 0, workspaces: 0 });
    expect(await db().prepare("SELECT 1 FROM alert_state WHERE workspace_id = ?").bind(ws).first()).toBeNull();
    expect(new Set(purged)).toEqual(new Set([`${ws}/alpha`, `${ws}/beta`]));
    expect((await adminPurgeWorkspace(env as Env, ws, { purgeWorkspace: async () => true })).status).toBe(404);
  });

  test("pages DO purges beyond WS_PURGE_PAIR_BATCH without stranding pairs", async () => {
    const account = await bootstrap("ws-purge-pages");
    const ws = "ws_purge_pages";
    const projects = Array.from({ length: WS_PURGE_PAIR_BATCH + 1 }, (_, i) => `project-${String(i).padStart(3, "0")}`);
    const now = Date.now();
    const inserts = projects.flatMap((project, i) => [
      db().prepare("INSERT INTO workspaces (workspace_id, project_id, account_id, created_at) VALUES (?, ?, ?, ?)").bind(ws, project, account.accountId, now),
      db().prepare("INSERT INTO commits (workspace_id, project_id, sequence, commit_hash, body, sig) VALUES (?, ?, 1, ?, ?, ?)").bind(ws, project, `commit-${i}`, "opaque", "sig"),
    ]);
    for (let i = 0; i < inserts.length; i += 40) await db().batch(inserts.slice(i, i + 40));
    const purged: string[] = [];
    const dep = async (_env: Env, w: string, p: string) => (purged.push(`${w}/${p}`), true);

    const first = await body<{ done: boolean }>(await adminPurgeWorkspace(env as Env, ws, { purgeWorkspace: dep }));
    expect(first.done).toBe(false);
    expect(purged).toHaveLength(WS_PURGE_PAIR_BATCH);
    const last = projects.at(-1)!;
    expect(await db().prepare("SELECT 1 FROM commits WHERE workspace_id = ? AND project_id = ?").bind(ws, last).first()).not.toBeNull();
    expect(await db().prepare("SELECT 1 FROM workspaces WHERE workspace_id = ? AND project_id = ?").bind(ws, last).first()).not.toBeNull();

    let result = first;
    while (!result.done) result = await body(await adminPurgeWorkspace(env as Env, ws, { purgeWorkspace: dep }));
    expect(await counts(ws)).toEqual({ commits: 0, manifests: 0, device_sync_state: 0, workspace_keys: 0, workspaces: 0 });
    expect(new Set(purged)).toEqual(new Set(projects.map((project) => `${ws}/${project}`)));
  });

  test("a throwing purgeWorkspace dep fails closed", async () => {
    const account = await bootstrap("ws-purge-throw");
    const ws = "ws_purge_throw";
    await seed(account.accountId, ws, "root", [sha("throw")]);
    const before = await counts(ws);
    const res = await adminPurgeWorkspace(env as Env, ws, { purgeWorkspace: async () => { throw new Error("DO unavailable"); } });
    expect(res.status).toBe(200);
    const result = await body<{ deleted: WsPurgeCounts; done: boolean }>(res);
    expect(result.done).toBe(false);
    expect(result.deleted).toEqual({ commits: 0, manifests: 0, device_sync_state: 0, workspace_keys: 0, workspaces: 0 });
    expect(await counts(ws)).toEqual(before);
  });

  test("uses bounded deletes, retains registry until drained, and fails closed on DO failure", async () => {
    const account = await bootstrap("ws-purge-budget");
    const ws = "ws_purge_budget";
    await seed(account.accountId, ws, "root", Array.from({ length: 10 }, (_, i) => sha(`budget-${i}`)));
    const ok = async () => true;

    const failed = await body<{ deleted: WsPurgeCounts; done: boolean }>(await adminPurgeWorkspace(env as Env, ws, { rowCap: 4, purgeWorkspace: async () => false }));
    expect(failed.done).toBe(false);
    expect(failed.deleted).toEqual({ commits: 0, manifests: 0, device_sync_state: 0, workspace_keys: 0, workspaces: 0 });
    expect(await counts(ws)).toEqual({ commits: 10, manifests: 10, device_sync_state: 0, workspace_keys: 2, workspaces: 1 });

    const p1 = await body<{ deleted: WsPurgeCounts; done: boolean }>(await adminPurgeWorkspace(env as Env, ws, { rowCap: 4, purgeWorkspace: ok }));
    expect(p1.deleted.commits).toBe(4);
    expect(p1.done).toBe(false);
    expect((await counts(ws)).workspaces).toBe(1);
    const p2 = await body<{ deleted: WsPurgeCounts; done: boolean }>(await adminPurgeWorkspace(env as Env, ws, { rowCap: 4, purgeWorkspace: ok }));
    expect(p2.deleted.commits).toBe(4);
    expect(p2.done).toBe(false);
    expect((await counts(ws)).workspaces).toBe(1);
    const p3 = await body<{ deleted: WsPurgeCounts; done: boolean }>(await adminPurgeWorkspace(env as Env, ws, { rowCap: 4, purgeWorkspace: ok }));
    expect(p3.deleted.commits).toBe(2);
    expect(p3.deleted.workspaces).toBe(1);
    expect(p3.done).toBe(true);
  });

  test("isolates shared blobs, refs, accounts, devices, and another workspace", async () => {
    const a = await bootstrap("ws-purge-isolation-a");
    const b = await bootstrap("ws-purge-isolation-b");
    const wsA = "ws_purge_isolation_a";
    const wsB = "ws_purge_isolation_b";
    const shared = sha("ws-purge-shared");
    await seed(a.accountId, wsA, "root", [shared]);
    await seed(b.accountId, wsB, "root", [shared]);

    const res = await adminPurgeWorkspace(env as Env, wsA, { purgeWorkspace: async () => true });
    expect((await body<{ done: boolean }>(res)).done).toBe(true);
    expect(await counts(wsA)).toEqual({ commits: 0, manifests: 0, device_sync_state: 0, workspace_keys: 0, workspaces: 0 });
    expect(await counts(wsB)).toEqual({ commits: 1, manifests: 1, device_sync_state: 0, workspace_keys: 2, workspaces: 1 });
    expect(Number((await db().prepare("SELECT COUNT(*) AS n FROM blobs WHERE sha256 = ?").bind(shared).first<{ n: number }>())!.n)).toBe(1);
    expect(Number((await db().prepare("SELECT COUNT(*) AS n FROM blob_refs WHERE sha256 = ?").bind(shared).first<{ n: number }>())!.n)).toBe(2);
    expect(Number((await db().prepare("SELECT COUNT(*) AS n FROM accounts WHERE id IN (?, ?)").bind(a.accountId, b.accountId).first<{ n: number }>())!.n)).toBe(2);
    expect(Number((await db().prepare("SELECT COUNT(*) AS n FROM devices WHERE account_id = ?").bind(a.accountId).first<{ n: number }>())!.n)).toBeGreaterThan(0);
  });
});
