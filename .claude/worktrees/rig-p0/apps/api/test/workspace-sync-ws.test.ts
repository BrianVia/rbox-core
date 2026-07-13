import { describe, expect, test } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { broadcast } from "../src/ws-fanout.js";

const sha = (ch: string) => ch.repeat(64);

function fakeCtx(sockets: WebSocket[]): DurableObjectState {
  const kv = new Map<string, unknown>();
  return {
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
        delete: (key: string) => kv.delete(key),
      },
      transactionSync: (fn: () => void) => fn(),
    },
    getWebSockets: () => sockets,
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
}

function fakeDb(order: string[], mirror: { release?: () => void }): D1Database {
  const makeStmt = (sql: string) => {
    const stmt = {
      sql,
      args: [] as unknown[],
      bind: (...args: unknown[]) => {
        stmt.args = args;
        return stmt;
      },
      first: async () => null,
      run: async () => {
        if (sql.includes("INSERT OR IGNORE INTO commits")) {
          await new Promise<void>((resolve) => {
            mirror.release = () => {
              order.push("mirror");
              resolve();
            };
          });
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
    const sync = new WorkspaceSync(fakeCtx(sockets), { rbox_dev_db: fakeDb(order, mirror) } as never);
    const commitBody = {
      type: "rbox/commit/v1",
      seq: 1,
      parentSeq: 0,
      accountEpoch: 0,
      encManifestSha: sha("a"),
      deviceId: "dev-a",
      blobRefs: [],
    };
    const done = sync.fetch(
      new Request("https://api.test/v1/ws/ws_1/proj/root/manifests", {
        method: "POST",
        headers: { "x-rbox-account": "acct_1", "x-rbox-account-epoch": "0" },
        body: JSON.stringify({
          parentSequence: 0,
          commit: { body: JSON.stringify(commitBody), commitHash: sha("b"), sig: "sig" },
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
});
