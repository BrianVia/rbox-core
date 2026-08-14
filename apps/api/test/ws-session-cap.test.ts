import { describe, expect, test, vi } from "vitest";
import type { JsonValue } from "../../../src/json.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { acceptConnection, broadcast, broadcastKeyDelivery } from "../src/ws-fanout.js";

const sha = (ch: string) => ch.repeat(64);
const now = Date.parse("2026-07-12T12:00:00Z");
const sixHours = 6 * 60 * 60_000;

/** The four socket members fan-out touches; widened so a real `WebSocket` satisfies it.
 *  `send`/`close` stay plain function types — `vi.fn()`'s `Mock` shape is a narrowing
 *  the real `WebSocket` could never satisfy, and `expect(...)` does not need it. */
interface FakeWebSocket {
  readyState: number;
  deserializeAttachment(): JsonValue;
  send(message: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
}

/** A hibernation attachment is whatever the DO serialized — the fan-out cap deliberately
 *  accepts any JSON value for `connectedAt` and fails closed on anything non-numeric. */
function socket(connectedAt?: JsonValue): FakeWebSocket {
  return {
    readyState: WebSocket.OPEN,
    deserializeAttachment: (): JsonValue => connectedAt === undefined ? {} : { deviceId: "dev-a", connectedAt },
    send: vi.fn(),
    close: vi.fn(),
  };
}

/** The one cursor member the DO touches; widened so `SqlStorageCursor` satisfies it. */
interface FakeSqlCursor {
  toArray(): unknown[];
}

function fakeCtx(sockets: ReturnType<typeof socket>[]): DurableObjectState {
  const kv = new Map<string, unknown>();
  return {
    storage: {
      kv: {
        get: (key: string): unknown => kv.get(key),
        put: <Value>(key: string, value: Value): void => { kv.set(key, value); },
        delete: (key: string): boolean => kv.delete(key),
        list: (): Iterable<[string, unknown]> => new Map<string, unknown>(),
      },
      sql: { exec: (_query: string, ..._bindings: unknown[]): FakeSqlCursor => ({ toArray: () => [] }) },
      transactionSync: <T>(fn: () => T): T => fn(),
      getAlarm: async (): Promise<number | null> => null,
      setAlarm: async (_scheduledTime: number | Date): Promise<void> => {},
    },
    getWebSockets: (): WebSocket[] => sockets as WebSocket[],
    setWebSocketAutoResponse: (): void => {},
  } as DurableObjectState;
}

/** The statement double: the three members the commit path calls, plus the sql + binds
 *  it records so `batch` can answer per query. These MUST be own properties — `startOp`
 *  Proxy-wraps every prepared statement, and the proxy forwards property reads but not
 *  object identity, so the recording cannot live in a side table keyed on the object. */
interface RecordedQuery {
  sql: string;
  args: unknown[];
  bind(...args: unknown[]): RecordedQuery;
  first(): Promise<unknown>;
  run(): Promise<{ success: boolean }>;
}

/** What this double hands back from `prepare`: a stand-in D1 statement that also records.
 *  The intersection is what keeps `RecordingStatement[]` assignable to
 *  `D1PreparedStatement[]`, so `D1Database` stays assignable to `FakeD1` below. */
type RecordingStatement = D1PreparedStatement & RecordedQuery;

/** The two database members the commit path touches; widened so `D1Database` satisfies it. */
interface FakeD1 {
  prepare(sql: string): D1PreparedStatement;
  batch(statements: RecordingStatement[]): Promise<{ results: unknown[] }[]>;
}

function fakeDb(): D1Database {
  const statement = (sql: string, args: unknown[]): RecordingStatement => {
    const recorded: RecordedQuery = {
      sql,
      args,
      bind: (...next: unknown[]) => statement(sql, next),
      first: async () => null,
      run: async () => ({ success: true }),
    };
    return recorded as RecordingStatement;
  };
  const db: FakeD1 = {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => statements.map((stmt) => (
      stmt.sql.includes("FROM blob_refs")
        ? { results: stmt.args.slice(1).map((sha256) => ({ sha256 })) }
        : { results: [] }
    )),
  };
  return db as D1Database;
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
      acceptWebSocket: (ws: WebSocket): void => { accepted = ws; },
    } as DurableObjectState;
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
    const sockets = [socket(), socket("old"), socket(now + 60 * 60_000), socket(NaN), socket(Infinity)];
    broadcast(fakeCtx(sockets), "committed", { maxSessionMs: sixHours, now });
    for (const ws of sockets) {
      expect(ws.send).not.toHaveBeenCalled();
      expect(ws.close).toHaveBeenCalledWith(1000, "session-max");
    }
  });

  test("fails closed when attachment deserialization throws", () => {
    const ws = socket(now);
    ws.deserializeAttachment = () => { throw new Error("poison"); };
    broadcast(fakeCtx([ws]), "committed", { maxSessionMs: sixHours, now });
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(1000, "session-max");
  });

  test("cap off sends without consulting attachment age", () => {
    const ws = socket(now - sevenHours());
    ws.deserializeAttachment = () => { throw new Error("must not be called"); };
    broadcast(fakeCtx([ws]), "committed", { maxSessionMs: 0, now });
    expect(ws.send).toHaveBeenCalledWith("committed");
    expect(ws.close).not.toHaveBeenCalled();
  });

  test("key-delivery nudge emits only the fixed opaque request frame", async () => {
    const ws = socket(now);
    const requestId = sha("d");
    expect(broadcastKeyDelivery(fakeCtx([ws]), requestId, { now })).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "key-delivery", requestId }));
    expect(broadcastKeyDelivery(fakeCtx([ws]), "not-an-id", { now })).toBe(false);

    const throughDo = socket(now);
    const durable = new WorkspaceSync(fakeCtx([throughDo]), { RBOX_WS_MAX_SESSION_MS: "0" } as never);
    const response = await durable.fetch(new Request("https://do/key-delivery-nudge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId }),
    }));
    expect(response.status).toBe(200);
    expect(throughDo.send).toHaveBeenCalledWith(JSON.stringify({ type: "key-delivery", requestId }));
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
