import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { blobKey } from "../src/util.js";
import { serializeRefset } from "../../../src/engine/refset.js";
import type { Env } from "../src/env.js";

const hash = (x: Uint8Array | string): string => createHash("sha256").update(x).digest("hex");

beforeAll(async () => applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS));

function fakeCtx(parent?: object, headSequence = 1): DurableObjectState {
  const kv = new Map<string, unknown>([["head", { sequence: headSequence, commitHash: headSequence === 0 ? "0".repeat(64) : hash("parent") }], ["headWatermark", headSequence]]);
  if (parent !== undefined) kv.set("seq:1", JSON.stringify(parent));
  return {
    storage: {
      kv: { get: (k: string) => kv.get(k), put: (k: string, v: unknown) => kv.set(k, v), delete: (k: string) => kv.delete(k), list: () => new Map() },
      sql: { exec: () => ({ toArray: () => [] }) }, transactionSync: (fn: () => void) => fn(), getAlarm: async () => null, setAlarm: async () => {},
    },
    getWebSockets: () => [], setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
}

async function fixture(name: string) {
  const boot = await SELF.fetch("https://example.test/v1/auth/device/bootstrap", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }) });
  const { accountId } = await boot.json() as { accountId: string };
  const refSha = hash(`${name}-ref`);
  const manifestSha = hash(`${name}-manifest`);
  const sidecar = serializeRefset([{ encSha: refSha, size: 7 }]);
  const sidecarSha = hash(sidecar);
  await env.rbox_dev_blobs.put(blobKey(sidecarSha), sidecar);
  for (const [sha, size] of [[refSha, 7], [manifestSha, 11], [sidecarSha, sidecar.length]] as const) {
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blobs(sha256,size_bytes,present) VALUES (?,?,1)").bind(sha, size).run();
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blob_refs(account_id,sha256,granted_at) VALUES (?,?,?)").bind(accountId, sha, Date.now()).run();
  }
  const body = (seq: number) => ({ type: "rbox/commit/v1", seq, parentSeq: seq - 1, accountEpoch: 0, encManifestSha: manifestSha, deviceId: "dev", blobRefset: { sidecarSha, count: 1, totalBytes: 7 }, parentCommitHash: "0".repeat(64), rosterVersion: 0, keyEpoch: 0, workspaceId: "ws" });
  const parent = { body: JSON.stringify(body(1)), commitHash: hash("parent"), sig: "sig" };
  const request = () => new Request("https://api.test/v1/ws/ws/proj/root/manifests", { method: "POST", headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1", "x-rbox-account": accountId, "x-rbox-account-epoch": "0" }, body: JSON.stringify({ parentSequence: 1, commit: { body: JSON.stringify(body(2)), commitHash: hash(`${name}-child`), sig: "sig" }, receipts: {} }) });
  return { accountId, refSha, manifestSha, sidecarSha, parent, body, request };
}

function testEnv(mode: "off" | "shadow", points: Array<{ blobs?: string[]; doubles?: number[] }>): Env {
  return { ...env, RBOX_COMMIT_DELTA_ADMISSION: mode, rbox_metrics: { writeDataPoint: (p: { blobs?: string[]; doubles?: number[] }) => points.push(p) } as AnalyticsEngineDataset };
}

async function responseBody(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: "off" | "shadow",
  points: Array<{ blobs?: string[]; doubles?: number[] }> = [],
  overrides: { ctx?: DurableObjectState; request?: Request } = {},
) {
  const response = await new WorkspaceSync(overrides.ctx ?? fakeCtx(f.parent), testEnv(mode, points)).fetch(overrides.request ?? f.request());
  const body = await response.json() as Record<string, unknown>;
  delete body.serverTimings;
  return { status: response.status, body };
}

const hasDeltaPoint = (points: Array<{ blobs?: string[]; doubles?: number[] }>, outcome: string, reason?: string): boolean =>
  points.some((p) => p.blobs?.[0] === "commit.delta" && p.blobs?.[1] === outcome && (reason === undefined || p.blobs?.[2] === reason));

function requestFor(f: Awaited<ReturnType<typeof fixture>>, seq: number, parentSequence: number): Request {
  return new Request("https://api.test/v1/ws/ws/proj/root/manifests", {
    method: "POST",
    headers: { "content-type": "application/json", "x-rbox-protocol": "upload-receipts-v1", "x-rbox-account": f.accountId, "x-rbox-account-epoch": "0" },
    body: JSON.stringify({ parentSequence, commit: { body: JSON.stringify(f.body(seq)), commitHash: hash(`child-${seq}-${f.accountId}`), sig: "sig" }, receipts: {} }),
  });
}

describe("design 102 shadow admission with real D1/R2", () => {
  test("shadow response is authoritative-full equivalent to off", async () => {
    const f = await fixture(`delta-eq-${crypto.randomUUID()}`);
    const off = await responseBody(f, "off");
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const shadow = await responseBody(f, "shadow", points);
    expect(shadow).toEqual(off);
    expect(points.some((p) => p.blobs?.[0] === "commit.delta" && p.blobs?.[1] === "sizes")).toBe(true);
  });

  test("harmful carried divergence emits and still returns full-path 422", async () => {
    const f = await fixture(`delta-harm-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare("UPDATE blobs SET present=0 WHERE sha256=?").bind(f.refSha).run();
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const result = await responseBody(f, "shadow", points);
    expect(result.status).toBe(422);
    expect(points.some((p) => p.blobs?.[0] === "commit.delta" && p.blobs?.[1] === "divergence")).toBe(true);
  });

  test("marker-only carried divergence is benign and response remains full-path 422", async () => {
    const f = await fixture(`delta-benign-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)").bind(f.accountId, f.refSha, Date.now()).run();
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const result = await responseBody(f, "shadow", points);
    expect(result.status).toBe(422);
    expect(points.some((p) => p.blobs?.[0] === "commit.delta" && p.blobs?.[1] === "benign_marker_divergence")).toBe(true);
    expect(points.some((p) => p.blobs?.[0] === "commit.delta" && p.blobs?.[1] === "fence_violation")).toBe(false);
  });

  test("active-intent carried ref pages fence_violation and falls back to full", async () => {
    const f = await fixture(`delta-fence-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare("INSERT INTO gc_candidates(sha256,kind,marked_at,deleting_at) VALUES (?, 'blob', ?, ?)").bind(f.refSha, Date.now(), Date.now()).run();
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const result = await responseBody(f, "shadow", points);
    expect(result.status).toBe(422); // authoritative full validation excludes active intents from have
    expect(hasDeltaPoint(points, "fence_violation")).toBe(true);
    expect(hasDeltaPoint(points, "fallback", "fence_violation")).toBe(true);
  });

  test("marker on carried ref routes to carried_fenced, not fence_violation", async () => {
    const f = await fixture(`delta-carried-marker-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)").bind(f.accountId, f.refSha, Date.now()).run();
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const result = await responseBody(f, "shadow", points);
    expect(result.status).toBe(422); // full path is authoritative; no receipt was supplied
    const carried = points.find((p) => p.blobs?.[0] === "commit.delta" && p.blobs?.[1] === "carried_fenced");
    expect(carried?.doubles?.[1]).toBeGreaterThanOrEqual(1);
    expect(hasDeltaPoint(points, "fence_violation")).toBe(false);
  });

  test("parent inline commit falls back parent_not_sidecar", async () => {
    const f = await fixture(`delta-inline-parent-${crypto.randomUUID()}`);
    const parentBody = { ...f.body(1), blobRefset: undefined, blobRefs: [{ encSha: f.refSha, size: 7 }] };
    const parent = { ...f.parent, body: JSON.stringify(parentBody) };
    const off = await responseBody(f, "off", [], { ctx: fakeCtx(parent) });
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const shadow = await responseBody(f, "shadow", points, { ctx: fakeCtx(parent) });
    expect(shadow).toEqual(off);
    expect(hasDeltaPoint(points, "fallback", "parent_not_sidecar")).toBe(true);
  });

  test("account deletion in progress falls back account_deleting", async () => {
    const f = await fixture(`delta-account-deleting-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare("INSERT INTO account_deletions(account_id,requested_at,purge_after,status,confirmed_with) VALUES (?,?,?,'pending',?)")
      .bind(f.accountId, Date.now(), Date.now() + 60_000, "account_id").run();
    const off = await responseBody(f, "off");
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const shadow = await responseBody(f, "shadow", points);
    expect(shadow).toEqual(off);
    expect(hasDeltaPoint(points, "fallback", "account_deleting")).toBe(true);
  });

  test("unreadable parent pages parent_unreadable and falls back", async () => {
    const f = await fixture(`delta-parent-unreadable-${crypto.randomUUID()}`);
    const off = await responseBody(f, "off", [], { ctx: fakeCtx(undefined) });
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const shadow = await responseBody(f, "shadow", points, { ctx: fakeCtx(undefined) });
    expect(shadow).toEqual(off);
    expect(hasDeltaPoint(points, "fallback", "parent_unreadable")).toBe(true);
    expect(hasDeltaPoint(points, "parent_unreadable")).toBe(true);
  });

});
