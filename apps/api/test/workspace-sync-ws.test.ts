import { describe, expect, test } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { broadcast } from "../src/ws-fanout.js";
import { CARRIER_REFS, MAX_REFS_PER_COMMIT } from "../src/commit-accounting.js";

const sha = (ch: string) => ch.repeat(64);

if (!("WebSocketRequestResponsePair" in globalThis)) {
  Object.assign(globalThis, {
    WebSocketRequestResponsePair: class {
      constructor(public readonly request: string, public readonly response: string) {}
    },
  });
}

/** The one cursor member the DO touches; widened so `SqlStorageCursor` satisfies it. */
interface FakeSqlCursor {
  toArray(): unknown[];
}

/** A prepared-statement double that also exposes the SQL and bound args the assertions read. */
interface FakeStatement extends D1PreparedStatement {
  sql: string;
  args: unknown[];
  bind(...values: unknown[]): FakeStatement;
}

/** The gate a blocked D1 mirror write parks on until the test releases it. */
interface MirrorGate {
  release?: () => void;
}

function fakeCtx(sockets: WebSocket[], kv = new Map<string, unknown>()): DurableObjectState & { __kv: Map<string, unknown> } {
  return {
    __kv: kv,
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: <Value>(key: string, value: Value): void => void kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix, limit }: { prefix?: string; limit?: number } = {}): Iterable<[string, unknown]> => {
          const out = new Map<string, unknown>();
          for (const [key, value] of kv) {
            if (prefix && !key.startsWith(prefix)) continue;
            out.set(key, value);
            if (limit && out.size >= limit) break;
          }
          return out;
        },
      },
      sql: { exec: (_query: string, ..._bindings: unknown[]): FakeSqlCursor => ({ toArray: () => [] }) },
      transactionSync: (fn: () => void) => fn(),
      getAlarm: async (): Promise<number | null> => null,
      setAlarm: async (_scheduledTime: number | Date): Promise<void> => {},
    },
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: () => {},
  } as DurableObjectState & { __kv: Map<string, unknown> };
}

function fakeDb(
  order: string[],
  mirror: MirrorGate,
  rows: {
    body?: { sequence: number; commit_hash: string; body: string; sig: string };
    failBodyRead?: boolean;
    blockMirror?: boolean;
    missingBlobRefs?: boolean;
    missingBlobSha?: string;
    entitledBlobRefs?: boolean;
    onFirstBatch?: () => void;
  } = {},
): D1Database {
  const makeStmt = (sql: string): FakeStatement => {
    const stmt = {
      sql,
      args: [] as unknown[],
      bind: (...args: unknown[]) => {
        stmt.args = args;
        return stmt;
      },
      first: async (): Promise<unknown> => {
        if (sql.includes("FROM commits")) {
          if (rows.failBodyRead) throw new Error("body read failed");
          return rows.body ?? null;
        }
        if (rows.entitledBlobRefs && sql.includes("FROM blob_refs")) return { 1: 1 };
        return null;
      },
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO commits")) {
          if (rows.blockMirror) {
            await new Promise<void>((resolve) => {
              mirror.release = () => {
                order.push("mirror");
                resolve();
              };
            });
          } else {
            order.push("mirror");
          }
        }
        return { success: true };
      },
    };
    return stmt as FakeStatement;
  };

  return {
    prepare: makeStmt,
    batch: async (stmts: FakeStatement[]): Promise<unknown[]> => {
      const onFirstBatch = rows.onFirstBatch;
      rows.onFirstBatch = undefined;
      onFirstBatch?.();
      return stmts.map((stmt) => {
        if (stmt.sql.includes("FROM blob_refs")) {
          return {
            results: rows.missingBlobRefs
              ? []
              : stmt.args.slice(1).filter((sha256) => sha256 !== rows.missingBlobSha).map((sha256) => ({ sha256 })),
          };
        }
        return { results: [] };
      });
    },
  } as D1Database & { prepare(query: string): FakeStatement };
}

function commitBody(seq: number, hashSeed = "b") {
  return {
    type: "rbox/commit/v1",
    seq,
    parentSeq: seq - 1,
    accountEpoch: 0,
    encManifestSha: sha("a"),
    deviceId: "dev-a",
    blobRefs: [],
    parentCommitHash: "0".repeat(64),
    rosterVersion: 0,
    keyEpoch: 0,
    workspaceId: "ws_1",
  };
}

function signed(seq: number, hashSeed = "b") {
  return { body: JSON.stringify(commitBody(seq, hashSeed)), commitHash: sha(hashSeed), sig: "sig" };
}

function commitReq(seq: number, hashSeed = "b") {
  return new Request("https://api.test/v1/ws/ws_1/proj/root/manifests", {
    method: "POST",
    headers: { "x-rbox-account": "acct_1", "x-rbox-account-epoch": "0", "content-type": "application/json" },
    body: JSON.stringify({ parentSequence: seq - 1, commit: signed(seq, hashSeed) }),
  });
}

function customCommitReq(options: {
  seq: number;
  parent?: number;
  epoch?: number;
  currentEpoch?: number;
  hashSeed?: string;
  refs?: string[];
  sidecarCount?: number;
  receipts?: boolean;
}) {
  const parent = options.parent ?? options.seq - 1;
  const cb = {
    ...commitBody(options.seq),
    parentSeq: parent,
    accountEpoch: options.epoch ?? 0,
    ...(options.sidecarCount === undefined
      ? { blobRefs: (options.refs ?? []).map((encSha) => ({ encSha, size: 1 })) }
      : { blobRefs: undefined, blobRefset: { sidecarSha: sha("e"), count: options.sidecarCount, totalBytes: 0 } }),
  };
  return new Request("https://api.test/v1/ws/ws_1/proj/root/manifests", {
    method: "POST",
    headers: {
      "x-rbox-account": "acct_1",
      "x-rbox-account-epoch": String(options.currentEpoch ?? 0),
      "content-type": "application/json",
      ...(options.receipts ? { "x-rbox-protocol": "upload-receipts-v1" } : {}),
    },
    body: JSON.stringify({
      parentSequence: parent,
      commit: { body: JSON.stringify(cb), commitHash: sha(options.hashSeed ?? "b"), sig: "sig" },
      receipts: {},
    }),
  });
}

function metricsEnv(rows: Parameters<typeof fakeDb>[2] = {}) {
  const metrics: string[] = [];
  const metricPoints: Array<{ blobs?: string[]; doubles?: number[] }> = [];
  return {
    rbox_dev_db: fakeDb([], {}, rows),
    rbox_metrics: {
      writeDataPoint: (point: { blobs?: string[]; doubles?: number[] }) => {
        metrics.push(point.blobs?.[2] ?? "");
        metricPoints.push(point);
      },
    },
    __metrics: metrics,
    __metricPoints: metricPoints,
  };
}

const SERVER_TIMING_KEYS = [
  "totalMs", "envelopeMs", "accountingMs", "sidecarMs", "commitMs", "mirrorMs", "responseMs",
];

interface ServerTimingsFixture {
  totalMs: number;
  envelopeMs: number;
  accountingMs: number;
  sidecarMs: number;
  commitMs: number;
  mirrorMs: number;
  responseMs: number;
}

interface SyncResponseFixture {
  error?: string;
  head?: number;
  currentEpoch?: number;
  sequence?: number;
  commitHash?: string;
  serverTimings: ServerTimingsFixture;
}

function expectServerTimings(body: SyncResponseFixture) {
  // Pinned drift detector for the client parser in src/cli/remote/commits.ts (SERVER_TIMING_KEYS).
  const timings = body.serverTimings;
  expect(Object.keys(timings)).toEqual(SERVER_TIMING_KEYS);
  expect(Object.values(timings).every(
    (value) => typeof value === "number" && Number.isFinite(value) && value >= 0,
  )).toBe(true);
}

describe("workspace sync websocket fanout", () => {
  test("hibernation cursor handler returns the KV head and ignores every other frame", () => {
    const sent: string[] = [];
    const socket = { send: (message: string): void => void sent.push(message) } as WebSocket;
    const sync = new WorkspaceSync(fakeCtx([], new Map([["head", { sequence: 7, commitHash: sha("a") }]])), metricsEnv() as never);

    sync.webSocketMessage(socket, "ping");
    sync.webSocketMessage(socket, "unknown");
    sync.webSocketMessage(socket, new TextEncoder().encode("cursor").buffer);
    sync.webSocketMessage(socket, "cursor");

    expect(sent).toEqual([JSON.stringify({ head: 7 })]);
    const deadSocket = { send: (_message: string): void => { throw new Error("dead"); } } as WebSocket;
    expect(() => sync.webSocketMessage(deadSocket, "cursor")).not.toThrow();
  });

  test("a receiver whose committed fanout is dropped can still query the DO cursor handler", () => {
    const receivedA: string[] = [];
    const receivedB: string[] = [];
    const socketA = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ deviceId: "dev-a" }),
      send: (message: string): void => void receivedA.push(message),
    } as WebSocket;
    const socketB = {
      readyState: WebSocket.OPEN,
      deserializeAttachment: () => ({ deviceId: "dev-b" }),
      send: (message: string): void => { if (message !== "committed") receivedB.push(message); },
    } as WebSocket;
    const ctx = fakeCtx([socketA, socketB], new Map([["head", { sequence: 9, commitHash: sha("a") }]]));
    const sync = new WorkspaceSync(ctx, metricsEnv() as never);

    broadcast(ctx, "committed");
    sync.webSocketMessage(socketB, "cursor");

    expect(receivedA).toEqual(["committed"]);
    expect(receivedB).toEqual([JSON.stringify({ head: 9 })]);
  });

  test("full admission rejects a lost carried ref even when another ref is introduced", async () => {
    const introduced = sha("c");
    const carriedNowAbsent = sha("d");
    // carried = present in the parent (seq 1) refset; a design-102 narrowed admission that
    // skips parent-carried refs would advance the head here and fail this pin loudly.
    const e = metricsEnv({ missingBlobSha: carriedNowAbsent });
    const parent = {
      ...signed(1, "a"),
      body: JSON.stringify({
        ...commitBody(1, "a"),
        blobRefs: [{ encSha: carriedNowAbsent, size: 1 }],
      }),
    };
    const ctx = fakeCtx([], new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("a") }],
      ["headWatermark", 1],
      ["seq:1", JSON.stringify(parent)],
    ]));

    const res = await new WorkspaceSync(ctx, e as never).fetch(customCommitReq({
      seq: 2,
      parent: 1,
      refs: [introduced, carriedNowAbsent],
      receipts: true,
    }));

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: "unsatisfied_blobs",
      missing: [carriedNowAbsent],
      missingTotal: 1,
    });
    expect(ctx.__kv.get("head")).toMatchObject({ sequence: 1 });
  });

  test("broadcast echoes committed frames to the originating device too", () => {
    const sent: string[] = [];
    const sockets = [
      {
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => ({ deviceId: "dev-a" }),
        send: (message: string): void => void sent.push(`a:${message}`),
      },
      {
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => ({ deviceId: "dev-b" }),
        send: (message: string): void => void sent.push(`b:${message}`),
      },
    ] as WebSocket[];

    broadcast({ getWebSockets: () => sockets } as DurableObjectState, "committed");

    expect(sent).toEqual(["a:committed", "b:committed"]);
  });

  test("commit fanout runs before the awaited D1 mirror settles", async () => {
    const order: string[] = [];
    const mirror: MirrorGate = {};
    let broadcastReached!: () => void;
    const broadcast = new Promise<void>((resolve) => { broadcastReached = resolve; });
    const sockets = [
      {
        readyState: WebSocket.OPEN,
        send: (_message: string): void => {
          order.push("broadcast");
          broadcastReached();
        },
      },
    ] as WebSocket[];
    const sync = new WorkspaceSync(fakeCtx(sockets), { rbox_dev_db: fakeDb(order, mirror, { blockMirror: true }) } as never);
    const done = sync.fetch(
      new Request("https://api.test/v1/ws/ws_1/proj/root/manifests", {
        method: "POST",
        headers: { "x-rbox-account": "acct_1", "x-rbox-account-epoch": "0" },
        body: JSON.stringify({
          parentSequence: 0,
          commit: signed(1),
        }),
      })
    );

    await broadcast;
    expect(order).toEqual(["broadcast"]);

    mirror.release?.();
    const res = await done;
    expect(res.status).toBe(200);
    expect(order).toEqual(["broadcast", "mirror"]);
  });

  test("incident regression: missing DO head plus watermark evidence serves repair_required and refuses duplicate sequence", async () => {
    const body = signed(474, "c");
    const kv = new Map<string, unknown>([["headWatermark", 474]]);
    const sync = new WorkspaceSync(fakeCtx([], kv), {
      rbox_dev_db: fakeDb([], {}, { body: { sequence: 474, commit_hash: body.commitHash, body: body.body, sig: body.sig } }),
    } as never);

    const latest = await sync.fetch(new Request("https://api.test/v1/ws/ws_1/proj/root/latest"));
    expect(latest.status).toBe(409);
    expect(await latest.json()).toEqual({ error: "repair_required" });

    const dup = await sync.fetch(commitReq(475, "d"));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "repair_required" });
  });

  test("numeric head migrates to {sequence, commitHash} and seeds watermark", async () => {
    const kv = new Map<string, unknown>();
    kv.set("head", 1);
    kv.set("seq:1", JSON.stringify(signed(1, "n")));
    const ctx = fakeCtx([], kv);
    const sync = new WorkspaceSync(ctx, { rbox_dev_db: fakeDb([], {}) } as never);

    const latest = await sync.fetch(new Request("https://api.test/v1/ws/ws_1/proj/root/latest"));
    expect(latest.status).toBe(200);
    expect(ctx.__kv.get("head")).toEqual({ sequence: 1, commitHash: sha("n") });
    expect(ctx.__kv.get("headWatermark")).toBe(1);
  });

  test("missing DO head with retained seq evidence serves repair_required instead of genesis", async () => {
    const kv = new Map<string, unknown>([["seq:474", JSON.stringify(signed(474, "s"))]]);
    const ctx = fakeCtx([], kv);
    const sync = new WorkspaceSync(ctx, { rbox_dev_db: fakeDb([], {}) } as never);

    const latest = await sync.fetch(new Request("https://api.test/v1/ws/ws_1/proj/root/latest"));
    expect(latest.status).toBe(409);
    expect(await latest.json()).toEqual({ error: "repair_required" });
    expect(ctx.__kv.get("head")).toBeUndefined();
  });

  test("head and watermark wiped with retained seq evidence serves repair_required without D1", async () => {
    const kv = new Map<string, unknown>([["seq:474", JSON.stringify(signed(474, "s"))]]);
    const ctx = fakeCtx([], kv);
    const sync = new WorkspaceSync(ctx, { rbox_dev_db: fakeDb([], {}, { failBodyRead: true }) } as never);

    const latest = await sync.fetch(new Request("https://api.test/v1/ws/ws_1/proj/root/latest"));
    expect(latest.status).toBe(409);
    expect(await latest.json()).toEqual({ error: "repair_required" });
    expect(ctx.__kv.get("head")).toBeUndefined();
  });

  test("numeric head migration refuses when the retained seq hash is unresolvable", async () => {
    const kv = new Map<string, unknown>([["head", 7]]);
    const ctx = fakeCtx([], kv);
    const sync = new WorkspaceSync(ctx, { rbox_dev_db: fakeDb([], {}) } as never);

    const latest = await sync.fetch(new Request("https://api.test/v1/ws/ws_1/proj/root/latest"));
    expect(latest.status).toBe(409);
    expect(await latest.json()).toEqual({ error: "repair_required" });
    expect(ctx.__kv.get("head")).toBe(7);
  });

  test("repair refuses when watermark hash is unresolvable and succeeds at the watermark when resolvable", async () => {
    const kv = new Map<string, unknown>([["headWatermark", 5]]);
    const ctx = fakeCtx([], kv);
    const sync = new WorkspaceSync(ctx, { RBOX_PLATFORM_SECRET: "plat", rbox_dev_db: fakeDb([], {}) } as never);

    const refused = await sync.fetch(new Request("https://api.test/repair?ws=ws_1&proj=root", { method: "POST", headers: { "x-rbox-platform": "plat" } }));
    expect(refused.status).toBe(409);
    expect((await refused.json()) as { error: string }).toMatchObject({ error: "repair_unresolvable" });

    kv.set("seq:5", JSON.stringify(signed(5, "r")));
    const repaired = await sync.fetch(new Request("https://api.test/repair?ws=ws_1&proj=root", { method: "POST", headers: { "x-rbox-platform": "plat" } }));
    expect(repaired.status).toBe(200);
    expect(ctx.__kv.get("head")).toEqual({ sequence: 5, commitHash: sha("r") });
    expect(ctx.__kv.get("headWatermark")).toBe(5);
  });

  test("same-sequence different hash conflicts and emits equivocation metric while same-hash retry does not", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 474, commitHash: sha("p") }],
      ["headWatermark", 474],
      ["seq:474", JSON.stringify(signed(474, "p"))],
    ]);
    const env = metricsEnv();
    const sync = new WorkspaceSync(fakeCtx([], kv), env as never);

    const first = await sync.fetch(commitReq(475, "a"));
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as SyncResponseFixture & { sequence: number; commitHash: string };
    expect(firstBody).toMatchObject({ sequence: 475, commitHash: sha("a") });
    expect(Object.keys(firstBody.serverTimings).sort()).toEqual([
      "accountingMs", "commitMs", "envelopeMs", "mirrorMs", "responseMs", "sidecarMs", "totalMs",
    ]);
    expect(Object.values(firstBody.serverTimings).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)).toBe(true);
    const successMetric = env.__metricPoints.find((point) => point.blobs?.[2] === "ok");
    expect(successMetric?.doubles?.slice(8, 15)).toEqual([
      firstBody.serverTimings.totalMs,
      firstBody.serverTimings.envelopeMs,
      firstBody.serverTimings.accountingMs,
      firstBody.serverTimings.sidecarMs,
      firstBody.serverTimings.commitMs,
      firstBody.serverTimings.mirrorMs,
      firstBody.serverTimings.responseMs,
    ]);

    const retry = await sync.fetch(commitReq(475, "a"));
    expect(retry.status).toBe(409);
    const retryBody = (await retry.json()) as SyncResponseFixture & { error: string; head: number };
    expect(retryBody).toMatchObject({ error: "conflict", head: 475 });
    expect(Object.keys(retryBody.serverTimings).sort()).toEqual([
      "accountingMs", "commitMs", "envelopeMs", "mirrorMs", "responseMs", "sidecarMs", "totalMs",
    ]);
    expect(Object.values(retryBody.serverTimings).every((value) => typeof value === "number" && Number.isFinite(value) && value >= 0)).toBe(true);
    expect(env.__metrics).not.toContain("same_sequence_different_hash");

    const fork = await sync.fetch(commitReq(475, "b"));
    expect(fork.status).toBe(409);
    expect(await fork.json()).toMatchObject({ error: "conflict", head: 475, serverTimings: expect.any(Object) });
    expect(env.__metrics).toContain("same_sequence_different_hash");
  });

  test("design 103 early stale-parent rejection is flag-gated and identified only on the fast path", async () => {
    const make = (enabled: boolean) => {
      const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1], ["seq:1", JSON.stringify(signed(1, "a"))]]);
      const e = { ...metricsEnv(), ...(enabled ? { RBOX_COMMIT_EARLY_REJECT: "1" } : {}) };
      return { sync: new WorkspaceSync(fakeCtx([], kv), e as never), e };
    };
    const on = make(true);
    const off = make(false);
    const [early, authoritative] = await Promise.all([
      on.sync.fetch(customCommitReq({ seq: 1, parent: 0, hashSeed: "a" })),
      off.sync.fetch(customCommitReq({ seq: 1, parent: 0, hashSeed: "a" })),
    ]);
    expect(early.status).toBe(409);
    expect(authoritative.status).toBe(409);
    const earlyBody = await early.json() as SyncResponseFixture;
    const authoritativeBody = await authoritative.json() as SyncResponseFixture;
    expect(earlyBody).toMatchObject({ error: "conflict", head: 1, serverTimings: expect.any(Object) });
    expect(Object.keys(earlyBody)).toEqual(Object.keys(authoritativeBody));
    expect(Object.keys(earlyBody)).toEqual(["error", "head", "serverTimings"]);
    expectServerTimings(earlyBody);
    expectServerTimings(authoritativeBody);
    expect(on.e.__metricPoints.find((p) => p.blobs?.[2] === "conflict")?.doubles?.[15]).toBe(1);
    expect(off.e.__metricPoints.find((p) => p.blobs?.[2] === "conflict")?.doubles?.[15]).toBe(0);
  });

  test("design 103 epoch rejection preserves parent-first precedence and the forwarded epoch snapshot", async () => {
    // There is no non-invasive mid-route pause seam. These direct requests pin that both
    // paths decide from the same already-forwarded x-rbox-account-epoch snapshot.
    const bodies: SyncResponseFixture[] = [];
    for (const enabled of [false, true]) {
      const e = { ...metricsEnv(), ...(enabled ? { RBOX_COMMIT_EARLY_REJECT: "1" } : {}) };
      const fresh = new WorkspaceSync(fakeCtx([], new Map()), e as never);
      const epoch = await fresh.fetch(customCommitReq({ seq: 1, epoch: 0, currentEpoch: 1 }));
      expect(epoch.status).toBe(409);
      const epochBody = await epoch.json() as SyncResponseFixture;
      expect(epochBody).toMatchObject({ error: "epoch_stale", currentEpoch: 1, serverTimings: expect.any(Object) });
      expect(Object.keys(epochBody)).toEqual(["error", "currentEpoch", "serverTimings"]);
      expectServerTimings(epochBody);
      bodies.push(epochBody);
      expect(e.__metricPoints.find((p) => p.blobs?.[2] === "epoch_stale")?.doubles?.[15]).toBe(enabled ? 1 : 0);

      const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1]]);
      const both = await new WorkspaceSync(fakeCtx([], kv), e as never).fetch(
        customCommitReq({ seq: 1, parent: 0, epoch: 0, currentEpoch: 1 }),
      );
      expect(await both.json()).toMatchObject({ error: "conflict", head: 1 });
    }
    expect(Object.keys(bodies[0]!)).toEqual(Object.keys(bodies[1]!));
  });

  test("design 103 authoritative CAS catches a mid-flight head advance", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1]]);
    const e = metricsEnv({
      onFirstBatch: () => {
        kv.set("head", { sequence: 2, commitHash: sha("b") });
        kv.set("headWatermark", 2);
      },
    });
    const env = { ...e, RBOX_COMMIT_EARLY_REJECT: "1" };
    const res = await new WorkspaceSync(fakeCtx([], kv), env as never).fetch(
      customCommitReq({ seq: 2, parent: 1, receipts: true }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", head: 2 });
    expect(env.__metricPoints.find((p) => p.blobs?.[2] === "conflict")?.doubles?.[15]).toBe(0);
  });

  test("design 103 watermark gaps remain transaction-only conflicts", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 5]]);
    const env = { ...metricsEnv(), RBOX_COMMIT_EARLY_REJECT: "1" };
    const res = await new WorkspaceSync(fakeCtx([], kv), env as never).fetch(
      customCommitReq({ seq: 2, parent: 1, receipts: true }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "conflict", head: 1 });
    expect(env.__metricPoints.find((p) => p.blobs?.[2] === "conflict")?.doubles?.[15]).toBe(0);
  });

  test("design 103 keeps structural 413 ahead of stale rejection", async () => {
    for (const enabled of [false, true]) {
      const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1]]);
      const e = { ...metricsEnv(), ...(enabled ? { RBOX_COMMIT_EARLY_REJECT: "1" } : {}) };
      const res = await new WorkspaceSync(fakeCtx([], kv), e as never).fetch(customCommitReq({
        seq: 1,
        parent: 0,
        sidecarCount: MAX_REFS_PER_COMMIT - CARRIER_REFS + 1,
        receipts: true,
      }));
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "too_many_refs", count: MAX_REFS_PER_COMMIT + 1, max: MAX_REFS_PER_COMMIT });
    }
  });

  test("design 103 reports stale before unsatisfied I/O, then reaches 422 with a fresh parent", async () => {
    const e = { ...metricsEnv({ missingBlobRefs: true }), RBOX_COMMIT_EARLY_REJECT: "1" };
    const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1]]);
    const sync = new WorkspaceSync(fakeCtx([], kv), e as never);
    const stale = await sync.fetch(customCommitReq({ seq: 1, parent: 0, refs: [sha("f")] }));
    expect(await stale.json()).toMatchObject({ error: "conflict", head: 1 });
    const fresh = await sync.fetch(customCommitReq({ seq: 2, parent: 1, refs: [sha("f")] }));
    expect(fresh.status).toBe(422);
    expect(await fresh.json()).toMatchObject({ error: "unsatisfied_blobs" });
  });

  test("design 103 rejects a stale sidecar commit before R2 admission only when enabled", async () => {
    const request = { seq: 1, parent: 0, sidecarCount: 3, receipts: true };
    const kv = () => new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1]]);
    const untouchedR2 = new Proxy({}, { get() { throw new Error("R2 touched"); } });
    const earlyEnv = { ...metricsEnv({ missingBlobRefs: true }), rbox_dev_blobs: untouchedR2, RBOX_COMMIT_EARLY_REJECT: "1" };
    const early = await new WorkspaceSync(fakeCtx([], kv()), earlyEnv as never).fetch(customCommitReq(request));

    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ error: "conflict", head: 1 });
    expect(earlyEnv.__metricPoints.find((p) => p.blobs?.[2] === "conflict")?.doubles?.[15]).toBe(1);

    const admittedEnv = metricsEnv({ missingBlobRefs: true });
    const admitted = await new WorkspaceSync(fakeCtx([], kv()), admittedEnv as never).fetch(customCommitReq(request));
    expect(admitted.status).toBe(422);
  });

  test("design 103 stale bad sidecar reports conflict before bad_sidecar", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1]]);
    const garbage = new Uint8Array(18 + 40 * 3);
    const env = {
      ...metricsEnv({ entitledBlobRefs: true }),
      RBOX_COMMIT_EARLY_REJECT: "1",
      rbox_dev_blobs: { get: async () => ({ size: garbage.byteLength, arrayBuffer: async () => garbage.buffer }) },
    };
    const sync = new WorkspaceSync(fakeCtx([], kv), env as never);

    const stale = await sync.fetch(customCommitReq({ seq: 1, parent: 0, sidecarCount: 3, receipts: true }));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: "conflict", head: 1 });

    const fresh = await sync.fetch(customCommitReq({ seq: 2, parent: 1, sidecarCount: 3, receipts: true }));
    expect(fresh.status).toBe(400);
    expect(await fresh.json()).toMatchObject({ error: "bad_sidecar" });
  });

  test("design 103 early equivocation preserves the existing signal", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha("a") }], ["headWatermark", 1], ["seq:1", JSON.stringify(signed(1, "a"))]]);
    const e = { ...metricsEnv(), RBOX_COMMIT_EARLY_REJECT: "1" };
    const res = await new WorkspaceSync(fakeCtx([], kv), e as never).fetch(customCommitReq({ seq: 1, parent: 0, hashSeed: "b" }));
    expect(res.status).toBe(409);
    expect(e.__metrics).toContain("same_sequence_different_hash");
    expect(e.__metricPoints.find((p) => p.blobs?.[2] === "conflict")?.doubles?.[15]).toBe(1);
  });
});
