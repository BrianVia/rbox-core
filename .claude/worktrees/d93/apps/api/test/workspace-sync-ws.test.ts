import { describe, expect, test } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { broadcast } from "../src/ws-fanout.js";

const sha = (ch: string) => ch.repeat(64);

if (!("WebSocketRequestResponsePair" in globalThis)) {
  Object.assign(globalThis, {
    WebSocketRequestResponsePair: class {
      constructor(public readonly request: string, public readonly response: string) {}
    },
  });
}

function fakeCtx(sockets: WebSocket[], kv = new Map<string, unknown>()): DurableObjectState & { __kv: Map<string, unknown> } {
  return {
    __kv: kv,
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: ({ prefix, limit }: { prefix?: string; limit?: number } = {}) => {
          const out = new Map<string, unknown>();
          for (const [key, value] of kv) {
            if (prefix && !key.startsWith(prefix)) continue;
            out.set(key, value);
            if (limit && out.size >= limit) break;
          }
          return out;
        },
      },
      transactionSync: (fn: () => void) => fn(),
    },
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState & { __kv: Map<string, unknown> };
}

function fakeDb(
  order: string[],
  mirror: { release?: () => void },
  rows: {
    body?: { sequence: number; commit_hash: string; body: string; sig: string };
    failBodyRead?: boolean;
    blockMirror?: boolean;
  } = {},
): D1Database {
  const makeStmt = (sql: string) => {
    const stmt = {
      sql,
      args: [] as unknown[],
      bind: (...args: unknown[]) => {
        stmt.args = args;
        return stmt;
      },
      first: async () => {
        if (sql.includes("FROM commits")) {
          if (rows.failBodyRead) throw new Error("body read failed");
          return rows.body ?? null;
        }
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
    return stmt as unknown as D1PreparedStatement;
  };

  return {
    prepare: makeStmt,
    batch: async (stmts: D1PreparedStatement[]) =>
      stmts.map((stmt) => {
        const s = stmt as unknown as { sql: string; args: unknown[] };
        if (s.sql.includes("FROM blob_refs")) return { results: s.args.slice(1).map((sha256) => ({ sha256 })) };
        return { results: [] };
      }),
  } as unknown as D1Database;
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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

function metricsEnv(rows: Parameters<typeof fakeDb>[2] = {}) {
  const metrics: string[] = [];
  return {
    rbox_dev_db: fakeDb([], {}, rows),
    rbox_metrics: {
      writeDataPoint: (point: { blobs?: string[] }) => metrics.push(point.blobs?.[2] ?? ""),
    },
    __metrics: metrics,
  };
}

describe("workspace sync websocket fanout", () => {
  test("broadcast echoes committed frames to the originating device too", () => {
    const sent: string[] = [];
    const sockets = [
      {
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => ({ deviceId: "dev-a" }),
        send: (message: string) => sent.push(`a:${message}`),
      },
      {
        readyState: WebSocket.OPEN,
        deserializeAttachment: () => ({ deviceId: "dev-b" }),
        send: (message: string) => sent.push(`b:${message}`),
      },
    ] as unknown as WebSocket[];

    broadcast({ getWebSockets: () => sockets } as unknown as DurableObjectState, "committed");

    expect(sent).toEqual(["a:committed", "b:committed"]);
  });

  test("commit fanout runs before the awaited D1 mirror settles", async () => {
    const order: string[] = [];
    const mirror: { release?: () => void } = {};
    const sockets = [
      {
        readyState: WebSocket.OPEN,
        send: () => order.push("broadcast"),
      },
    ] as unknown as WebSocket[];
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

    for (let i = 0; i < 10 && !order.includes("broadcast"); i++) await tick();
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

    const retry = await sync.fetch(commitReq(475, "a"));
    expect(retry.status).toBe(409);
    expect(await retry.json()).toEqual({ error: "conflict", head: 475 });
    expect(env.__metrics).not.toContain("same_sequence_different_hash");

    const fork = await sync.fetch(commitReq(475, "b"));
    expect(fork.status).toBe(409);
    expect(await fork.json()).toEqual({ error: "conflict", head: 475 });
    expect(env.__metrics).toContain("same_sequence_different_hash");
  });
});
