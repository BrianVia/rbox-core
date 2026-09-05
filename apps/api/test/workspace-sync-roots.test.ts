import { describe, expect, test, vi } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { fakeDoSql } from "./helpers/fake-do-sql.js";

interface RootsInspectPageFixture {
  head: number;
  pruneFloor: number;
  indexGeneration: number;
  indexSyncedSeq: number;
  droppedPage: Array<{ sha: string; lastSeq: number }>;
  seqRootsPage: Array<{ seq: number; manifestSha: string; carrierSha?: string }>;
  gapPage: Array<{ seq: number; manifestSha: string; inlineRefs?: string[]; carrierSha?: string }>;
  nextSha?: string;
  nextSeq?: number;
  nextGapSeq?: number;
}

const sha = (ch: string) => ch.repeat(64);

if (!("WebSocketRequestResponsePair" in globalThis)) {
  Object.assign(globalThis, {
    WebSocketRequestResponsePair: class {
      constructor(public readonly request: string, public readonly response: string) {}
    },
  });
}

interface StorageWrites { kv: number; transactions: number; alarms: number }

/** The members WorkspaceSync touches, each widened so the real Cloudflare type
 *  stays assignable to the double — hence the single downcast at the end. */
interface FakeSqlStorage {
  exec(query: string, ...bindings: unknown[]): { toArray(): Array<Record<string, SqlStorageValue>> };
}

interface FakeKvStorage {
  get(key: string): unknown;
  put<T>(key: string, value: T): void;
  delete(key: string): boolean;
  list(): Iterable<[string, unknown]>;
}

interface FakeStorage {
  sql: FakeSqlStorage;
  kv: FakeKvStorage;
  transactionSync(fn: () => void): void;
  getAlarm(): Promise<number | null>;
  setAlarm(at: number): void;
}

interface FakeDurableObjectState {
  storage: FakeStorage;
  getWebSockets(): WebSocket[];
  setWebSocketAutoResponse(): void;
}

function fakeCtx(
  kv: Map<string, unknown>,
  sql = fakeDoSql(),
  failTransaction?: () => boolean,
  writes?: StorageWrites,
  failAlarm?: () => boolean,
): DurableObjectState {
  let alarm: number | null = null;
  const state: FakeDurableObjectState = {
    storage: {
      sql,
      kv: {
        get: (key: string) => kv.get(key),
        put: (key, value) => { if (writes) writes.kv++; kv.set(key, value); },
        delete: (key: string) => { if (writes) writes.kv++; return kv.delete(key); },
        list: () => new Map(),
      },
      transactionSync: (fn: () => void) => {
        if (writes) writes.transactions++;
        const kvBefore = new Map(kv);
        const droppedBefore = new Map(sql.__dropped);
        const rootsBefore = new Map(sql.__seqRoots);
        fn();
        if (failTransaction?.()) {
          kv.clear(); for (const entry of kvBefore) kv.set(...entry);
          sql.__dropped.clear(); for (const entry of droppedBefore) sql.__dropped.set(...entry);
          sql.__seqRoots.clear(); for (const entry of rootsBefore) sql.__seqRoots.set(...entry);
          throw new Error("injected transaction crash");
        }
      },
      getAlarm: async () => alarm,
      setAlarm: (at: number) => {
        if (writes) writes.alarms++;
        if (failAlarm?.()) throw new Error("injected alarm failure");
        alarm = at;
      },
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  };
  return state as DurableObjectState;
}

function signed(seq: number, refs: { inline: string[] } | { sidecarSha: string; count: number }, manifestChain?: string[]) {
  const carrier = "inline" in refs
    ? { blobRefs: refs.inline.map((encSha) => ({ encSha, size: 1 })) }
    : { blobRefset: { sidecarSha: refs.sidecarSha, count: refs.count, totalBytes: refs.count } };
  return JSON.stringify({
    body: JSON.stringify({
      type: "rbox/commit/v1",
      seq,
      encManifestSha: sha(String(seq)),
      ...(manifestChain ? { manifestChain } : {}),
      ...carrier,
    }),
    commitHash: sha("c"),
    sig: "sig",
  });
}

const rootsRequest = new Request("https://do/roots?ws=ws_1&proj=root");

function legacyDiffChunk(left: Set<string>, right: Set<string>, after: string): string[] {
  const chunk: string[] = [];
  for (const value of left) {
    if (value <= after || right.has(value)) continue;
    chunk.push(value);
    if (chunk.length === 5_000) break;
  }
  return chunk;
}

function legacyFold(previous: string[], current: string[]) {
  const before = new Set(previous.sort());
  const after = new Set(current.sort());
  const dropped = new Map(
    current.filter((value) => !before.has(value)).map((sha256) => [sha256, { sha256, last_seq: 99 }]),
  );
  for (const [left, right, remove] of [[before, after, false], [after, before, true]] as const) {
    let cursor = "";
    for (let chunk = legacyDiffChunk(left, right, cursor); chunk.length; chunk = legacyDiffChunk(left, right, cursor)) {
      for (const sha256 of chunk) {
        if (remove) dropped.delete(sha256);
        else dropped.set(sha256, { sha256, last_seq: 1 });
      }
      cursor = chunk[chunk.length - 1]!;
    }
  }
  return {
    dropped: [...dropped].sort(([a], [b]) => a.localeCompare(b)),
    seqRoots: [
      [1, { seq: 1, manifest_sha: sha("1"), carrier_sha: null }],
      [2, { seq: 2, manifest_sha: sha("2"), carrier_sha: null }],
    ],
  };
}

async function foldFixture(previous: string[], current: string[], failTransaction?: () => boolean) {
  const kv = new Map<string, unknown>([
    ["head", { sequence: 2, commitHash: sha("c") }], ["pruneFloor", 0],
    ["index_state", "building"], ["index_synced_seq", 0], ["index_generation", 0], ["backfill_cursor", 1],
    ["seq:1", signed(1, { inline: previous })], ["seq:2", signed(2, { inline: current })],
  ]);
  const before = new Set(previous);
  const sql = fakeDoSql({
    dropped: current.filter((value) => !before.has(value)).map((sha256) => ({ sha256, last_seq: 99 })),
  });
  await new WorkspaceSync(fakeCtx(kv, sql), {} as never).alarm();
  await new WorkspaceSync(fakeCtx(kv, sql, failTransaction), {} as never).alarm();
  return { kv, sql };
}
function commitRequest(): Request {
  return new Request("https://do/v1/ws/ws_1/proj/root/manifests", {
    method: "POST",
    headers: { "content-type": "application/json", "x-rbox-account": "acct_1", "x-rbox-account-epoch": "0" },
    body: JSON.stringify({
      parentSequence: 0,
      commit: {
        body: JSON.stringify({
          type: "rbox/commit/v1",
          seq: 1,
          parentSeq: 0,
          accountEpoch: 0,
          encManifestSha: sha("a"),
          deviceId: "dev-a",
          blobRefs: [],
        }),
        commitHash: sha("c"),
        sig: "sig",
      },
    }),
  });
}

function entitledDb() {
  const prepare = (sql: string) => {
    const statement = {
      args: [] as unknown[],
      bind(...args: unknown[]) { this.args = args; return this; },
      async run() { return { success: true }; },
    };
    return Object.assign(statement, { sql });
  };
  return {
    prepare,
    batch: async (statements: Array<{ sql: string; args: unknown[] }>) => statements.map((statement) => ({
      results: statement.sql.includes("FROM blob_refs")
        ? statement.args.slice(1).map((sha256) => ({ sha256 }))
        : [],
    })),
  };
}

describe("WorkspaceSync maintenance bootstrap recovery", () => {
  test("re-arms lagging maintenance on restart after commit alarm failure", async () => {
    const kv = new Map<string, unknown>();
    const failedWrites: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const failedCtx = fakeCtx(kv, fakeDoSql(), undefined, failedWrites, () => true);
    const failed = new WorkspaceSync(failedCtx, { rbox_dev_db: entitledDb() } as never);

    await expect(failed.fetch(commitRequest())).rejects.toThrow("injected alarm failure");
    expect(kv.get("head")).toMatchObject({ sequence: 1 });
    expect(kv.get("index_state")).toBe("lagging");
    expect(await failedCtx.storage.getAlarm()).toBeNull();

    const recoveredWrites: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const recoveredCtx = fakeCtx(kv, fakeDoSql(), undefined, recoveredWrites);
    const latest = await new WorkspaceSync(recoveredCtx, {} as never).fetch(
      new Request("https://do/v1/ws/ws_1/proj/root/latest"),
    );

    expect(latest.status).toBe(200);
    expect(recoveredWrites.alarms).toBe(1);
    expect(await recoveredCtx.storage.getAlarm()).not.toBeNull();
  });

  test("does not arm maintenance when the ready index is caught up", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("c") }],
      ["index_state", "ready"],
      ["index_synced_seq", 1],
      ["seq:1", signed(1, { inline: [] })],
    ]);
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };

    const latest = await new WorkspaceSync(fakeCtx(kv, fakeDoSql(), undefined, writes), {} as never).fetch(
      new Request("https://do/v1/ws/ws_1/proj/root/latest"),
    );

    expect(latest.status).toBe(200);
    expect(writes.alarms).toBe(0);
  });

  test("arms maintenance once when the index is building", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("c") }],
      ["index_state", "building"],
      ["index_synced_seq", 1],
      ["seq:1", signed(1, { inline: [] })],
    ]);
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };

    const latest = await new WorkspaceSync(fakeCtx(kv, fakeDoSql(), undefined, writes), {} as never).fetch(
      new Request("https://do/v1/ws/ws_1/proj/root/latest"),
    );

    expect(latest.status).toBe(200);
    expect(writes.alarms).toBe(1);
  });
});

describe("WorkspaceSync retained-roots index", () => {
  test("foldSequence visits 20k disjoint refs at most once per phase", async () => {
    class CountingSet extends Set<string> {
      visits = 0;
      override *values() {
        for (const value of super.values()) {
          this.visits++;
          yield value;
        }
      }
    }
    const count = 20_000;
    const previous = new CountingSet(Array.from({ length: count }, (_, i) => (i + 100_000).toString(16).padStart(64, "0")));
    const current = new CountingSet(Array.from({ length: count }, (_, i) => (i + 200_000).toString(16).padStart(64, "0")));
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }], ["pruneFloor", 0],
      ["index_state", "building"], ["index_synced_seq", 0], ["index_generation", 0], ["backfill_cursor", 1],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv, fakeDoSql(), undefined, writes), {} as never);
    sync["refSetAt"] = async (seq: number) => ({
      refs: seq === 1 ? previous : current,
      manifestSha: sha(String(seq)),
      carrierSha: null,
    });
    await sync.alarm();
    await sync.alarm();
    expect(writes.transactions).toBe(11); // seed + four chunks per phase + phase/final commits
    expect(previous.visits + current.visits).toBeLessThanOrEqual(2 * count);
  });

  test.each([
    ["disjoint", [sha("a"), sha("b")], [sha("c"), sha("d")]],
    ["sparse overlap", [sha("a"), sha("c"), sha("e")], [sha("a"), sha("b"), sha("e")]],
    ["equal", [sha("a"), sha("b")], [sha("a"), sha("b")]],
    ["empty previous", [], [sha("a"), sha("b")]],
    ["empty current", [sha("a"), sha("b")], []],
  ])("matches legacy fold results for %s sets", async (_name, previous, current) => {
    const { sql } = await foldFixture(previous, current);
    const expected = legacyFold(previous, current);
    expect([...sql.__dropped].sort(([a], [b]) => a.localeCompare(b))).toEqual(expected.dropped);
    expect([...sql.__seqRoots]).toEqual(expected.seqRoots);
  });

  test("every multi-chunk data transaction resumes without duplicate or missing rows", async () => {
    const count = 10_001;
    const previous = Array.from({ length: count }, (_, i) => (i + 100_000).toString(16).padStart(64, "0"));
    const current = Array.from({ length: count }, (_, i) => (i + 200_000).toString(16).padStart(64, "0"));
    const baseline = await foldFixture(previous, current);
    const expectedDropped = [...baseline.sql.__dropped];
    const expectedRoots = [...baseline.sql.__seqRoots];
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      for (const failedTransaction of [1, 2, 3, 5, 6, 7]) {
        let transaction = 0;
        const crashed = await foldFixture(previous, current, () => ++transaction === failedTransaction);
        expect(crashed.kv.get("index_synced_seq")).toBe(1);
        await new WorkspaceSync(fakeCtx(crashed.kv, crashed.sql), {} as never).alarm();
        expect([...crashed.sql.__dropped]).toEqual(expectedDropped);
        expect([...crashed.sql.__seqRoots]).toEqual(expectedRoots);
        expect(crashed.kv.has("fold_subcursor")).toBe(false);
      }
    } finally {
      consoleError.mockRestore();
    }
  });

  test("serves the inclusive-base gap and independently paginates both SQL streams", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }],
      ["pruneFloor", 0],
      ["index_state", "ready"],
      ["index_synced_seq", 1],
      ["index_generation", 7],
      ["seq:1", signed(1, { inline: [sha("a")] })],
      ["seq:2", signed(2, { inline: [sha("b"), sha("d")] }, [sha("7"), sha("8")])],
    ]);
    const sql = fakeDoSql({
      dropped: [{ sha256: sha("e"), last_seq: 1 }, { sha256: sha("f"), last_seq: 1 }],
      seqRoots: [
        { seq: 1, manifest_sha: sha("1"), carrier_sha: null },
        { seq: 2, manifest_sha: sha("2"), carrier_sha: sha("s") },
      ],
    });
    const sync = new WorkspaceSync(fakeCtx(kv, sql), {} as never);

    const res = await sync.fetch(new Request(`${rootsRequest.url}&limit=1`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      head: 2,
      pruneFloor: 0,
      indexGeneration: 7,
      indexSyncedSeq: 1,
      gap: [
        { seq: 1, manifestSha: sha("1"), inlineRefs: [sha("a")] },
        { seq: 2, manifestSha: sha("2"), inlineRefs: [sha("b"), sha("d")], chainRefs: [sha("7"), sha("8")] },
      ],
      droppedPage: [sha("e")],
      nextSha: sha("e"),
      seqRootsPage: [{ seq: 1, manifestSha: sha("1") }],
      nextSeq: 1,
    });

    const second = await sync.fetch(new Request(`${rootsRequest.url}&limit=1&fromSha=done&fromSeq=1&pinHead=2&pinFloor=0&pinGen=7`));
    const secondBody = await second.json();
    expect(secondBody).toMatchObject({
      droppedPage: [],
      seqRootsPage: [{ seq: 2, manifestSha: sha("2"), carrierSha: sha("s") }],
    });
    expect(secondBody).not.toHaveProperty("nextSha");
    expect(secondBody).not.toHaveProperty("nextSeq");
  });

  test("fails roots closed on a malformed manifest chain", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("c") }], ["pruneFloor", 0],
      ["index_state", "ready"], ["index_synced_seq", 1], ["index_generation", 1],
      ["seq:1", signed(1, { inline: [] }, [sha("1")])],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv), {} as never);
    const res = await sync.fetch(rootsRequest);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "roots_incomplete" });
  });

  test("returns fail-closed index lifecycle errors", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 9, commitHash: sha("c") }], ["index_state", "building"]]);
    const sync = new WorkspaceSync(fakeCtx(kv), {} as never);
    const building = await sync.fetch(rootsRequest);
    expect(building.status).toBe(503);
    expect(await building.json()).toEqual({ error: "index_building" });

    kv.set("index_state", "lagging");
    kv.set("index_synced_seq", 0);
    const lagging = await sync.fetch(rootsRequest);
    expect(lagging.status).toBe(503);
    expect(await lagging.json()).toEqual({ error: "index_lagging" });
  });

  test.each([
    ["head", "pinHead=1&pinFloor=0&pinGen=3"],
    ["floor", "pinHead=2&pinFloor=1&pinGen=3"],
    ["generation", "pinHead=2&pinFloor=0&pinGen=2"],
  ])("returns snapshot_changed after %s movement between pages", async (_kind, pins) => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }],
      ["index_state", "ready"],
      ["index_synced_seq", 2],
      ["index_generation", 3],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv), {} as never);

    const res = await sync.fetch(new Request(`${rootsRequest.url}&${pins}`));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "snapshot_changed" });
  });

  test("atomically seeds the first retained sequence and reaches ready at the head", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("c") }],
      ["index_state", "building"],
      ["index_synced_seq", 0],
      ["index_generation", 0],
      ["backfill_cursor", 1],
      ["seq:1", signed(1, { inline: [sha("a")] })],
    ]);
    const sql = fakeDoSql();
    const sync = new WorkspaceSync(fakeCtx(kv, sql), {} as never);

    await sync.alarm();

    expect(kv.get("index_synced_seq")).toBe(1);
    expect(kv.get("backfill_cursor")).toBe(1);
    expect(kv.get("index_generation")).toBe(1);
    expect(kv.get("index_state")).toBe("ready");
    expect(sql.__seqRoots.get(1)).toEqual({ seq: 1, manifest_sha: sha("1"), carrier_sha: null });
  });

  test("seed transaction is all-or-nothing and resumes after an injected crash", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("c") }], ["index_state", "building"],
      ["index_synced_seq", 0], ["index_generation", 0], ["backfill_cursor", 1],
      ["seq:1", signed(1, { inline: [sha("a")] })],
    ]);
    const sql = fakeDoSql();
    let fail = true;
    const sync = new WorkspaceSync(fakeCtx(kv, sql, () => fail && !(fail = false)), {} as never);

    await sync.alarm();
    expect(kv.get("index_synced_seq")).toBe(0);
    expect(kv.get("index_generation")).toBe(0);
    expect(sql.__seqRoots.size).toBe(0);

    await sync.alarm();
    expect(kv.get("index_synced_seq")).toBe(1);
    expect(kv.get("index_state")).toBe("ready");
    expect(sql.__seqRoots.has(1)).toBe(true);
  });

  test("defers prune before it can outrun the folded index", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 4, commitHash: sha("c") }],
      ["pruneFloor", 0],
      ["index_state", "building"],
      ["index_synced_seq", 2],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv), {} as never);
    const res = await sync.fetch(new Request("https://do/prune?ws=ws_1&proj=root", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ floor: 2 }),
    }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "prune_deferred", indexSyncedSeq: 2 });
    expect(kv.get("pruneFloor")).toBe(0);
  });

  test("alarm sweeper removes only bounded dead rows at or below the floor", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 0, commitHash: "0".repeat(64) }],
      ["pruneFloor", 0],
      ["index_state", "ready"],
      ["index_synced_seq", 0],
    ]);
    const sql = fakeDoSql({
      dropped: [{ sha256: sha("a"), last_seq: 0 }, { sha256: sha("b"), last_seq: 1 }],
      seqRoots: [{ seq: 0, manifest_sha: sha("0"), carrier_sha: null }, { seq: 1, manifest_sha: sha("1"), carrier_sha: null }],
    });
    const sync = new WorkspaceSync(fakeCtx(kv, sql), {} as never);

    await sync.alarm();

    expect([...sql.__dropped.keys()]).toEqual([sha("b")]);
    expect([...sql.__seqRoots.keys()]).toEqual([1]);
  });

  test("resumes a partially applied fold idempotently and completes backfill", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 3, commitHash: sha("c") }],
      ["pruneFloor", 0],
      ["index_state", "building"],
      ["index_synced_seq", 1],
      ["index_generation", 1],
      ["backfill_cursor", 1],
      ["fold_subcursor", { phase: "removed", lastSha: sha("a") }],
      ["seq:1", signed(1, { inline: [sha("a"), sha("b")] }, [sha("e")])], // chain ref must sort after the resume cursor sha("a") or the resumed removal diff correctly skips it
      ["seq:2", signed(2, { inline: [sha("b"), sha("d")] })],
      ["seq:3", signed(3, { inline: [sha("a"), sha("d")] })],
    ]);
    const sql = fakeDoSql({
      dropped: [{ sha256: sha("a"), last_seq: 1 }],
      seqRoots: [{ seq: 1, manifest_sha: sha("1"), carrier_sha: null }],
    });
    const sync = new WorkspaceSync(fakeCtx(kv, sql), {} as never);

    await sync.alarm(); // resumes seq 2 after the already-committed removal
    expect(kv.get("index_synced_seq")).toBe(2);
    expect(sql.__dropped.get(sha("a"))?.last_seq).toBe(1);
    expect(sql.__dropped.get(sha("e"))?.last_seq).toBe(1);
    expect(kv.has("fold_subcursor")).toBe(false);

    await sync.alarm(); // seq 3 re-adds a and drops b
    expect(kv.get("index_synced_seq")).toBe(3);
    expect(kv.get("index_state")).toBe("ready");
    expect(sql.__dropped.has(sha("a"))).toBe(false);
    expect(sql.__dropped.get(sha("b"))?.last_seq).toBe(2);
    expect(sql.__dropped.get(sha("e"))?.last_seq).toBe(1);
    expect([...sql.__seqRoots.keys()]).toEqual([1, 2, 3]);
  });

  test("snapshot reset retains dropped chain links until prune passes their last sequence", async () => {
    const chain = [sha("7"), sha("8")];
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }], ["pruneFloor", 0],
      ["index_state", "building"], ["index_synced_seq", 0], ["index_generation", 0], ["backfill_cursor", 1],
      ["seq:1", signed(1, { inline: [] }, chain)],
      ["seq:2", signed(2, { inline: [] })],
    ]);
    const sql = fakeDoSql();
    const sync = new WorkspaceSync(fakeCtx(kv, sql), {} as never);

    await sync.alarm(); // seed chain-bearing seq 1
    await sync.alarm(); // snapshot reset at seq 2 drops both links into retained index
    expect([...sql.__dropped.values()]).toEqual(chain.map((sha256) => ({ sha256, last_seq: 1 })));
    const retained = await sync.fetch(rootsRequest);
    expect(await retained.json()).toMatchObject({ droppedPage: chain });

    const pruned = await sync.fetch(new Request("https://do/prune?ws=ws_1&proj=root", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ floor: 1 }),
    }));
    expect(pruned.status).toBe(200);
    await sync.alarm();
    expect(sql.__dropped.size).toBe(0);
  });

  test("server clamps oversized page limits", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 0, commitHash: "0".repeat(64) }],
      ["index_state", "ready"],
      ["index_synced_seq", 0],
      ["index_generation", 1],
    ]);
    const dropped = Array.from({ length: 20_001 }, (_, i) => ({
      sha256: i.toString(16).padStart(64, "0"), last_seq: 1,
    }));
    const sync = new WorkspaceSync(fakeCtx(kv, fakeDoSql({ dropped })), {} as never);
    const res = await sync.fetch(new Request(`${rootsRequest.url}&limit=999999`));
    const body = await res.json() as { droppedPage: string[]; nextSha?: string };
    expect(body.droppedPage).toHaveLength(20_000);
    expect(body.nextSha).toBe(body.droppedPage.at(-1));
  });
});

describe("design 142 read-only retained-roots inspection", () => {
  test("keyset-pages every roots stream under one triple and performs zero DO writes", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 3, commitHash: sha("c") }],
      ["pruneFloor", 0],
      ["index_state", "ready"],
      ["index_synced_seq", 1],
      ["index_generation", 9],
      ["seq:1", signed(1, { inline: [sha("a")] })],
      ["seq:2", signed(2, { inline: [sha("b")] })],
      ["seq:3", signed(3, { inline: [sha("d")] }, [sha("7")])],
    ]);
    const baseSql = fakeDoSql({
      dropped: [{ sha256: sha("e"), last_seq: 1 }, { sha256: sha("f"), last_seq: 2 }],
      seqRoots: [
        { seq: 1, manifest_sha: sha("1"), carrier_sha: null },
        { seq: 2, manifest_sha: sha("2"), carrier_sha: sha("8") },
      ],
    });
    let sqlWrites = 0;
    const sql = {
      ...baseSql,
      exec(query: string, ...bindings: unknown[]) {
        if (!query.trimStart().toLowerCase().startsWith("select ")) sqlWrites++;
        return baseSql.exec(query, ...bindings);
      },
    };
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const sync = new WorkspaceSync(fakeCtx(kv, sql, undefined, writes), {} as never);
    const beforeKv = structuredClone([...kv.entries()]);
    const beforeDropped = structuredClone([...sql.__dropped.entries()]);
    const beforeSeqRoots = structuredClone([...sql.__seqRoots.entries()]);

    const first = await sync.fetch(new Request("https://do/roots-inspect?ws=ws_1&proj=root&limit=1"));
    expect(first.status).toBe(200);
    const p1 = await first.json() as RootsInspectPageFixture;
    expect(p1).toMatchObject({
      head: 3, pruneFloor: 0, indexGeneration: 9, indexSyncedSeq: 1,
      droppedPage: [{ sha: sha("e"), lastSeq: 1 }], nextSha: sha("e"),
      seqRootsPage: [{ seq: 1, manifestSha: sha("1") }], nextSeq: 1,
      gapPage: [{ seq: 1, manifestSha: sha("1"), inlineRefs: [sha("a")] }], nextGapSeq: 1,
    });

    const second = await sync.fetch(new Request(`https://do/roots-inspect?ws=ws_1&proj=root&limit=1&fromSha=${sha("e")}&fromSeq=1&fromGapSeq=1&pinHead=3&pinFloor=0&pinGen=9`));
    expect(second.status).toBe(200);
    const p2 = await second.json() as RootsInspectPageFixture;
    expect(p2).toMatchObject({
      droppedPage: [{ sha: sha("f"), lastSeq: 2 }],
      seqRootsPage: [{ seq: 2, manifestSha: sha("2"), carrierSha: sha("8") }],
      gapPage: [{ seq: 2, manifestSha: sha("2"), inlineRefs: [sha("b")] }], nextGapSeq: 2,
    });
    expect(p2).not.toHaveProperty("nextSha");
    expect(p2).not.toHaveProperty("nextSeq");

    const third = await sync.fetch(new Request("https://do/roots-inspect?ws=ws_1&proj=root&limit=1&fromSha=done&fromSeq=done&fromGapSeq=2&pinHead=3&pinFloor=0&pinGen=9"));
    expect(third.status).toBe(200);
    expect(await third.json()).toMatchObject({
      droppedPage: [], seqRootsPage: [],
      gapPage: [{ seq: 3, manifestSha: sha("3"), inlineRefs: [sha("d")], chainRefs: [sha("7")] }],
    });

    expect(writes).toEqual({ kv: 0, transactions: 0, alarms: 0 });
    expect(sqlWrites).toBe(0);
    expect([...kv.entries()]).toEqual(beforeKv);
    expect([...sql.__dropped.entries()]).toEqual(beforeDropped);
    expect([...sql.__seqRoots.entries()]).toEqual(beforeSeqRoots);
  });

  test.each([
    ["head", "pinHead=2&pinFloor=0&pinGen=9"],
    ["floor", "pinHead=3&pinFloor=1&pinGen=9"],
    ["generation", "pinHead=3&pinFloor=0&pinGen=8"],
  ])("rejects a stale %s pin without a storage write", async (_dimension, pins) => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 3, commitHash: sha("c") }], ["pruneFloor", 0],
      ["index_state", "ready"], ["index_synced_seq", 3], ["index_generation", 9],
      ["seq:3", signed(3, { inline: [] })],
    ]);
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const sync = new WorkspaceSync(fakeCtx(kv, fakeDoSql(), undefined, writes), {} as never);
    const res = await sync.fetch(new Request(`https://do/roots-inspect?${pins}`));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "snapshot_changed" });
    expect(writes).toEqual({ kv: 0, transactions: 0, alarms: 0 });
  });

  test("reports a cold object unavailable without bootstrapping SQL, KV, or alarms", async () => {
    const kv = new Map<string, unknown>();
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    let sqlCalls = 0;
    const sql: ReturnType<typeof fakeDoSql> = {
      __dropped: new Map(), __seqRoots: new Map(),
      exec: () => { sqlCalls++; throw new Error("SQL must not be touched"); },
    };
    const sync = new WorkspaceSync(fakeCtx(kv, sql, undefined, writes), {} as never);
    const res = await sync.fetch(new Request("https://do/roots-inspect?ws=cold&proj=root"));
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "index_unavailable", reason: "uninitialized" });
    expect(sqlCalls).toBe(0);
    expect(writes).toEqual({ kv: 0, transactions: 0, alarms: 0 });
    expect(kv.size).toBe(0);
  });

  test("fails an incomplete raw-gap page closed without repairing or writing", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 2, commitHash: sha("c") }], ["pruneFloor", 0],
      ["index_state", "ready"], ["index_synced_seq", 1], ["index_generation", 4],
      // seq:1 deliberately absent
    ]);
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const sync = new WorkspaceSync(fakeCtx(kv, fakeDoSql(), undefined, writes), {} as never);
    const res = await sync.fetch(new Request("https://do/roots-inspect"));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: "roots_incomplete" });
    expect(writes).toEqual({ kv: 0, transactions: 0, alarms: 0 });
  });

  test("reports missing inspection tables without trying to create them", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 0, commitHash: "0".repeat(64) }], ["pruneFloor", 0],
      ["index_state", "ready"], ["index_synced_seq", 0], ["index_generation", 0],
    ]);
    const writes: StorageWrites = { kv: 0, transactions: 0, alarms: 0 };
    const queries: string[] = [];
    const sql: ReturnType<typeof fakeDoSql> = {
      __dropped: new Map(), __seqRoots: new Map(),
      exec(query: string) { queries.push(query); throw new Error("no such table: dropped_index"); },
    };
    const logged: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((line) => { logged.push(String(line)); });
    try {
      const sync = new WorkspaceSync(fakeCtx(kv, sql, undefined, writes), {} as never);
      const res = await sync.fetch(new Request("https://do/roots-inspect"));
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: "index_unavailable", reason: "storage_unreadable" });
      expect(queries).toHaveLength(1);
      expect(queries[0]!.trimStart().toLowerCase().startsWith("select ")).toBe(true);
      expect(writes).toEqual({ kv: 0, transactions: 0, alarms: 0 });
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0]!)).toEqual({ event: "roots_inspect_sql_failed", errorClass: "Error" });
      expect(logged[0]).not.toContain("no such table");
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe("design 84 — refSetAt ordering invariant", () => {
  test("sidecar refs merged with a lower-sorting chain sha iterate in ascending order (diffChunk cursor safety)", async () => {
    // diffChunk paginates fold diffs by iterating the Set in order with a
    // `> lastSha` cursor; a chain sha appended AFTER sorted sidecar refs would
    // be skipped on a chunk resume and its dropped_index entry silently lost.
    const { serializeRefset } = await import("../../../src/engine/refset.js");
    const { sha256Hex } = await import("../src/util.js").then(async (u) => {
      // util may not export sha256Hex; fall back to webcrypto
      return {
        sha256Hex: async (bytes: Uint8Array) => {
          const d = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
          return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
        },
      };
    });
    const chainSha = sha("a"); // sorts below the sidecar refs; != the commit's own encManifestSha (sha("1"))
    const sidecarRefs = [
      { encSha: sha("c"), size: 1 },
      { encSha: sha("e"), size: 2 },
    ];
    const bytes = serializeRefset(sidecarRefs);
    const sidecarSha = await sha256Hex(bytes);
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha("9") }],
      ["pruneFloor", 0],
      ["seq:1", signed(1, { sidecarSha, count: sidecarRefs.length }, [chainSha])],
    ]);
    const env = {
      rbox_dev_blobs: {
        get: async (key: string) =>
          key.endsWith(sidecarSha)
            ? { size: bytes.byteLength, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }
            : null,
      },
    } as never;
    const sync = new WorkspaceSync(fakeCtx(kv), env);
    const result = await sync["refSetAt"](1);
    expect(result).not.toBeNull();
    const iterated = [...result!.refs];
    expect(iterated).toEqual([...iterated].sort());
    expect(iterated).toContain(chainSha);
    expect(iterated[0]).toBe(chainSha);
  });
});
