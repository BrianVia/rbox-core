import { describe, expect, test, vi } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { acceptConnection, broadcast } from "../src/ws-fanout.js";

const sha = (ch: string) => ch.repeat(64);
const now = Date.parse("2026-07-12T12:00:00Z");
const sixHours = 6 * 60 * 60_000;

function socket(connectedAt?: unknown) {
  return {
    readyState: WebSocket.OPEN,
    deserializeAttachment: () => connectedAt === undefined ? {} : { deviceId: "dev-a", connectedAt },
    send: vi.fn(),
    close: vi.fn(),
  };
}

function fakeCtx(sockets: ReturnType<typeof socket>[]): DurableObjectState {
  const kv = new Map<string, unknown>();
  return {
    storage: {
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: () => new Map(),
      },
      sql: { exec: () => ({ toArray: () => [] }) },
      transactionSync: (fn: () => void) => fn(),
      getAlarm: async () => null,
      setAlarm: async () => {},
    },
    getWebSockets: () => sockets as unknown as WebSocket[],
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
}

function fakeDb(): D1Database {
  const statement = (sql: string) => {
    const stmt = {
      sql,
      args: [] as unknown[],
      bind: (...args: unknown[]) => {
        stmt.args = args;
        return stmt;
      },
      first: async () => null,
      run: async () => ({ success: true }),
    };
    return stmt as unknown as D1PreparedStatement;
  };
  return {
    prepare: statement,
    batch: async (stmts: D1PreparedStatement[]) => stmts.map((raw) => {
      const s = raw as unknown as { sql: string; args: unknown[] };
      return s.sql.includes("FROM blob_refs")
        ? { results: s.args.slice(1).map((sha256) => ({ sha256 })) }
        : { results: [] };
    }),
  } as unknown as D1Database;
}

function signed() {
  return {
    body: JSON.stringify({
      type: "rbox/commit/v1", seq: 1, parentSeq: 0, accountEpoch: 0,
      encManifestSha: sha("a"), deviceId: "dev-a", blobRefs: [], parentCommitHash: "0".repeat(64),
      rosterVersion: 0, keyEpoch: 0, workspaceId: "ws_1",
    }),
    commitHash: sha("b"), sig: "sig",
  };
}

function commitRequest() {
  return new Request("https://api.test/v1/ws/ws_1/proj/root/manifests", {
    method: "POST",
    headers: { "x-rbox-account": "acct_1", "x-rbox-account-epoch": "0" },
    body: JSON.stringify({ parentSequence: 0, commit: signed() }),
  });
}

describe("websocket session cap", () => {
  test("accepted sockets carry a numeric connectedAt attachment", () => {
    let accepted: WebSocket | undefined;
    const ctx = {
      acceptWebSocket: (ws: WebSocket) => { accepted = ws; },
    } as unknown as DurableObjectState;
    const response = acceptConnection(ctx, new URL("https://api.test/connect?device=dev-a"));
    expect(response.status).toBe(101);
    expect(accepted).toBeDefined();
    expect(accepted?.deserializeAttachment()).toMatchObject({ deviceId: "dev-a", connectedAt: expect.any(Number) });
  });

  test("sends to under-age sockets and closes over-age sockets before delivery", () => {
    const fresh = socket(now);
    const stale = socket(now - sevenHours());
    broadcast(fakeCtx([fresh, stale]), "committed", { maxSessionMs: sixHours, now });
    expect(fresh.send).toHaveBeenCalledWith("committed");
    expect(fresh.close).not.toHaveBeenCalled();
    expect(stale.send).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledWith(1000, "session-max");
  });

  test("fails closed for missing, malformed, and future connectedAt", () => {
    const sockets = [socket(), socket("old"), socket(now + 60 * 60_000)];
    broadcast(fakeCtx(sockets), "committed", { maxSessionMs: sixHours, now });
    for (const ws of sockets) {
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(1000, "session-max");
    }
  });

  test("cap off sends without consulting attachment age", () => {
    const ws = socket(now - sevenHours());
    broadcast(fakeCtx([ws]), "committed", { maxSessionMs: 0, now });
    expect(ws.send).toHaveBeenCalledWith("committed");
    expect(ws.close).not.toHaveBeenCalled();
  });

  test("commit broadcast honors configured cap and defaults off when unset", async () => {
    const stale = socket(Date.now() - 1000);
    const capped = new WorkspaceSync(fakeCtx([stale]), { rbox_dev_db: fakeDb(), RBOX_WS_MAX_SESSION_MS: "1" } as never);
    expect((await capped.fetch(commitRequest())).status).toBe(200);
    expect(stale.send).not.toHaveBeenCalled();
    expect(stale.close).toHaveBeenCalledWith(1000, "session-max");

    const legacy = socket();
    const uncapped = new WorkspaceSync(fakeCtx([legacy]), { rbox_dev_db: fakeDb() } as never);
    expect((await uncapped.fetch(commitRequest())).status).toBe(200);
    expect(legacy.send).toHaveBeenCalledOnce();
    expect(legacy.close).not.toHaveBeenCalled();
  });
});

function sevenHours(): number {
  return 7 * 60 * 60_000;
}
