import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { FENCE_SET_MAX } from "../src/commit-delta.js";
import { blobKey } from "../src/util.js";
import { serializeRefset } from "../../../src/engine/refset.js";
import type { Env } from "../src/env.js";

const hash = (x: Uint8Array | string): string => createHash("sha256").update(x).digest("hex");

beforeAll(async () => applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS));

interface StoredCommitFixture {
  body: string;
  commitHash: string;
  sig: string;
}

interface FakeKvStorage {
  get(key: string): unknown;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list(): Iterable<[string, unknown]>;
}

interface FakeDurableObjectState {
  storage: {
    kv: FakeKvStorage;
    sql: { exec(): { toArray(): never[] } };
    transactionSync(fn: () => void): void;
    getAlarm(): Promise<number | null>;
    setAlarm(): Promise<void>;
  };
  getWebSockets(): WebSocket[];
  setWebSocketAutoResponse(): void;
}

function fakeCtx(parent?: StoredCommitFixture, headSequence = 1): DurableObjectState {
  const kv = new Map<string, unknown>([["head", { sequence: headSequence, commitHash: headSequence === 0 ? "0".repeat(64) : hash("parent") }], ["headWatermark", headSequence]]);
  if (parent !== undefined) kv.set("seq:1", JSON.stringify(parent));
  const state: FakeDurableObjectState = {
    storage: {
      kv: { get: (k: string) => kv.get(k), put: (k, v) => kv.set(k, v), delete: (k: string) => kv.delete(k), list: () => new Map() },
      sql: { exec: () => ({ toArray: () => [] }) }, transactionSync: (fn: () => void) => fn(), getAlarm: async () => null, setAlarm: async () => {},
    },
    getWebSockets: () => [], setWebSocketAutoResponse: () => {},
  };
  return state as DurableObjectState;
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

type DeltaAdmissionMode = "off" | "shadow" | "enforce";
interface CommitResponseFixture {
  serverTimings?: object;
  error?: string;
  missing?: string[];
  missingTotal?: number;
  sequence?: number;
  commitHash?: string;
}

function testEnv(mode: DeltaAdmissionMode, points: Array<{ blobs?: string[]; doubles?: number[] }>): Env {
  return { ...env, RBOX_COMMIT_DELTA_ADMISSION: mode, rbox_metrics: { writeDataPoint: (p: { blobs?: string[]; doubles?: number[] }) => points.push(p) } as AnalyticsEngineDataset };
}

async function responseBody(
  f: Awaited<ReturnType<typeof fixture>>,
  mode: DeltaAdmissionMode,
  points: Array<{ blobs?: string[]; doubles?: number[] }> = [],
  overrides: { ctx?: DurableObjectState; request?: Request } = {},
) {
  const response = await new WorkspaceSync(overrides.ctx ?? fakeCtx(f.parent), testEnv(mode, points)).fetch(overrides.request ?? f.request());
  const body = await response.json() as CommitResponseFixture;
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

type DeltaFixture = Awaited<ReturnType<typeof fixture>>;
type CommitBodyFixture = ReturnType<DeltaFixture["body"]> & {
  manifestChain?: string[];
  blobRefs?: Array<{ encSha: string; size: number }>;
  blobRefset?: { sidecarSha: string; count: number; totalBytes: number };
};

function requestWithBody(f: DeltaFixture, commitBody: CommitBodyFixture, receipts = true): Request {
  const headers = new Headers({
    "content-type": "application/json", "x-rbox-account": f.accountId, "x-rbox-account-epoch": "0",
  });
  if (receipts) headers.set("x-rbox-protocol", "upload-receipts-v1");
  return new Request("https://api.test/v1/ws/ws/proj/root/manifests", {
    method: "POST",
    headers,
    body: JSON.stringify({ parentSequence: commitBody.parentSeq, commit: { body: JSON.stringify(commitBody), commitHash: hash(`custom-${crypto.randomUUID()}`), sig: "sig" }, receipts: {} }),
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

describe("design 102 enforce admission with real D1/R2", () => {
  test("prune-marked carried ref is admitted, reports missing, and does not move head", async () => {
    const f = await fixture(`delta-enforce-carried-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)")
      .bind(f.accountId, f.refSha, Date.now()).run();
    await env.rbox_dev_db.prepare("UPDATE blobs SET present=0 WHERE sha256=?").bind(f.refSha).run();
    const ctx = fakeCtx(f.parent);
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];

    const result = await responseBody(f, "enforce", points, { ctx });

    expect(result.status).toBe(422);
    expect(result.body).toMatchObject({
      error: "unsatisfied_blobs",
      missing: [f.refSha],
      missingTotal: 1,
    });
    expect(await ctx.storage.kv.get("head")).toEqual({ sequence: 1, commitHash: hash("parent") });
    expect(points.find((point) => point.blobs?.[0] === "commit.delta" && point.blobs?.[1] === "carried_fenced")?.doubles?.[1])
      .toBeGreaterThanOrEqual(1);
    expect(points.some((point) => point.blobs?.[0] === "commit.delta" && point.blobs?.[1] === "fallback")).toBe(false);
    expect(hasDeltaPoint(points, "childParseMs")).toBe(false);
  });

  test("marked-probe over cap admits only carriers, chain, and added refs", async () => {
    const f = await fixture(`delta-enforce-over-cap-${crypto.randomUUID()}`);
    await env.rbox_dev_db.prepare(`
      WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9))
      INSERT INTO blob_ref_candidates(account_id, sha256, marked_at)
      SELECT ?, printf('%064x', a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n), ?
      FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
      WHERE a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n <= ?
    `).bind(f.accountId, Date.now(), FENCE_SET_MAX).run();
    await env.rbox_dev_db.prepare("UPDATE blobs SET present=0 WHERE sha256=?").bind(f.refSha).run();
    const addedSha = hash(`${f.accountId}-added`);
    const chainSha = hash(`${f.accountId}-chain`);
    const childSidecar = serializeRefset([{ encSha: f.refSha, size: 7 }, { encSha: addedSha, size: 13 }]);
    const childSidecarSha = hash(childSidecar);
    await env.rbox_dev_blobs.put(blobKey(childSidecarSha), childSidecar);
    for (const [sha, size] of [[addedSha, 13], [chainSha, 17], [childSidecarSha, childSidecar.length]] as const) {
      await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blobs(sha256,size_bytes,present) VALUES (?,?,1)").bind(sha, size).run();
      await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blob_refs(account_id,sha256,granted_at) VALUES (?,?,?)").bind(f.accountId, sha, Date.now()).run();
    }
    const points: Array<{ blobs?: string[]; doubles?: number[] }> = [];
    const body = { ...f.body(2), manifestChain: [chainSha], blobRefset: { sidecarSha: childSidecarSha, count: 2, totalBytes: 20 } };

    const result = await responseBody(f, "enforce", points, { request: requestWithBody(f, body) });

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ sequence: 2 });
    const commit = points.find((point) => point.blobs?.[0] === "commit" && point.blobs?.[2] === "ok");
    expect(commit?.doubles?.[5]).toBe(4); // manifest + sidecar + chain + delta.added; carried ref omitted
    expect(hasDeltaPoint(points, "marks_over_cap")).toBe(true);
    expect(points.find((point) => point.blobs?.[0] === "commit.delta" && point.blobs?.[1] === "marks")?.doubles?.[1])
      .toBe(FENCE_SET_MAX + 1);
    expect(hasDeltaPoint(points, "fallback")).toBe(false);
    expect(hasDeltaPoint(points, "childParseMs")).toBe(false);
  });
});

describe("design 84 server manifestChain admission", () => {
  test.each([
    ["over cap", Array.from({ length: 17 }, (_, i) => i.toString(16).padStart(64, "0"))],
    ["non-hex", ["not-a-sha"]],
    ["duplicate", ["a".repeat(64), "a".repeat(64)]],
  ])("rejects %s chains at the shape gate", async (_label, manifestChain) => {
    const f = await fixture(`chain-shape-${crypto.randomUUID()}`);
    const result = await responseBody(f, "off", [], { request: requestWithBody(f, { ...f.body(2), manifestChain }) });
    expect(result).toEqual({ status: 400, body: { error: "bad_request", message: "bad manifestChain" } });
  });

  test("rejects a chain containing its own manifest", async () => {
    const f = await fixture(`chain-self-${crypto.randomUUID()}`);
    const result = await responseBody(f, "off", [], { request: requestWithBody(f, { ...f.body(2), manifestChain: [f.manifestSha] }) });
    expect(result).toEqual({ status: 400, body: { error: "bad_request", message: "bad manifestChain" } });
  });

  test("missing chain sha is reported on receipts and legacy paths", async () => {
    const f = await fixture(`chain-missing-${crypto.randomUUID()}`);
    const chainSha = hash("missing-chain-link");
    const receiptResult = await responseBody(f, "off", [], { request: requestWithBody(f, { ...f.body(2), manifestChain: [chainSha] }) });
    expect(receiptResult.status).toBe(422);
    expect(receiptResult.body).toMatchObject({ error: "unsatisfied_blobs", missing: [chainSha], missingTotal: 1 });

    const inline = { ...f.body(2), blobRefset: undefined, blobRefs: [{ encSha: f.refSha, size: 7 }], manifestChain: [chainSha] };
    const legacyResult = await responseBody(f, "off", [], { request: requestWithBody(f, inline, false) });
    expect(legacyResult.status).toBe(422);
    expect(legacyResult.body).toMatchObject({ error: "unsatisfied_blobs", missing: [chainSha], missingTotal: 1 });
  });

  test("marked chain link is unsatisfied while an honest entitled link is free", async () => {
    const f = await fixture(`chain-entitled-${crypto.randomUUID()}`);
    const chainSha = hash("prior-manifest-link");
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blobs(sha256,size_bytes,present) VALUES (?,13,1)").bind(chainSha).run();
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blob_refs(account_id,sha256,granted_at) VALUES (?,?,?)").bind(f.accountId, chainSha, Date.now()).run();
    const before = Number((await env.rbox_dev_db.prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(f.accountId).first())!.used_bytes);
    const ok = await responseBody(f, "off", [], { request: requestWithBody(f, { ...f.body(2), manifestChain: [chainSha] }) });
    expect(ok.status).toBe(200);
    const after = Number((await env.rbox_dev_db.prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(f.accountId).first())!.used_bytes);
    expect(after).toBe(before);

    await env.rbox_dev_db.prepare("INSERT INTO blob_ref_candidates(account_id,sha256,marked_at) VALUES (?,?,?)").bind(f.accountId, chainSha, Date.now()).run();
    const marked = await responseBody(f, "off", [], { request: requestWithBody(f, { ...f.body(2), manifestChain: [chainSha] }) });
    expect(marked.status).toBe(422);
    expect(marked.body).toMatchObject({ missing: [chainSha] });
  });

  test("chain link behind a DELETING gc fence 422s chain-first with full missingTotal on receipts and legacy paths", async () => {
    // §3.5.2/§3.5.4: a fenced (gc_candidates.deleting_at NOT NULL) chain link is
    // excluded from the have-set even though entitled+present, and every
    // commit-path 422 places chain shas before data refs.
    const f = await fixture(`chain-fenced-${crypto.randomUUID()}`);
    const chainSha = hash("fenced-chain-link");
    const missingData = hash("missing-data-ref");
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blobs(sha256,size_bytes,present) VALUES (?,13,1)").bind(chainSha).run();
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO blob_refs(account_id,sha256,granted_at) VALUES (?,?,?)").bind(f.accountId, chainSha, Date.now()).run();
    await env.rbox_dev_db.prepare("INSERT OR REPLACE INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(chainSha).run();

    // zz-prefixed sha would sort after; use an inline body listing the missing
    // data ref FIRST so only the partition (not input order) can front the chain.
    const inline = { ...f.body(2), blobRefset: undefined, blobRefs: [{ encSha: missingData, size: 7 }, { encSha: f.refSha, size: 7 }], manifestChain: [chainSha] };
    const legacyResult = await responseBody(f, "off", [], { request: requestWithBody(f, inline, false) });
    expect(legacyResult.status).toBe(422);
    expect(legacyResult.body).toMatchObject({ error: "unsatisfied_blobs", missing: [chainSha, missingData], missingTotal: 2 });

    const receiptsResult = await responseBody(f, "off", [], { request: requestWithBody(f, inline, true) });
    expect(receiptsResult.status).toBe(422);
    expect(receiptsResult.body).toMatchObject({ error: "unsatisfied_blobs", missing: [chainSha, missingData], missingTotal: 2 });
  });
});
