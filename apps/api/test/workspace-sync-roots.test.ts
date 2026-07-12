import { describe, expect, test } from "vitest";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { fakeDoSql } from "./helpers/fake-do-sql.js";

const sha = (ch: string) => ch.repeat(64);

if (!("WebSocketRequestResponsePair" in globalThis)) {
  Object.assign(globalThis, {
    WebSocketRequestResponsePair: class {
      constructor(public readonly request: string, public readonly response: string) {}
    },
  });
}

function fakeCtx(kv: Map<string, unknown>, sql = fakeDoSql(), failTransaction?: () => boolean): DurableObjectState {
  let alarm: number | null = null;
  return {
    storage: {
      sql,
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: () => new Map(),
      },
      transactionSync: (fn: () => void) => {
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
      getAlarm: () => alarm,
      setAlarm: (at: number) => { alarm = at; },
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
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

describe("WorkspaceSync retained-roots index", () => {
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
