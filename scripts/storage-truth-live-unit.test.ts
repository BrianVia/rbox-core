import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { serializeRefset } from "../src/engine/refset.js";
import {
  BindingStorageTruthSource,
  createRemoteBindingConfig,
  createStorageTruthSource,
  decodeRootsCursor,
  type ReadOnlyD1,
  type ReadOnlyR2,
} from "./storage-truth-live.js";

const sha = (ch: string): string => ch.repeat(64);
const workspace = { workspaceId: "ws_1", projectId: "dir/root" };
const pin = { head: 3, pruneFloor: 0, indexGeneration: 7 };
const unusedDb = { prepare: () => { throw new Error("D1 must not be touched"); } } as ReadOnlyD1;

function r2(objects: Map<string, Uint8Array> = new Map()): ReadOnlyR2 {
  return {
    async get(key) {
      const bytes = objects.get(key);
      return bytes ? {
        key, size: bytes.byteLength, uploaded: new Date(1),
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } : null;
    },
    async list() { return { objects: [], truncated: false }; },
  };
}

const response = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});

describe("storage-truth live adapter unit", () => {
  test("derives a remote-only binding config from the selected checked-in environment", async () => {
    const generated = await createRemoteBindingConfig("production");
    try {
      const config = JSON.parse(await readFile(generated.configPath, "utf8"));
      expect(config.d1_databases).toEqual([{
        binding: "rbox_dev_db",
        database_name: "rbox-prod-db",
        database_id: "c6b3e6ab-4130-4c9b-8f77-cdae47745c5c",
        remote: true,
      }]);
      expect(config.r2_buckets).toEqual([{
        binding: "rbox_dev_blobs",
        bucket_name: "rbox-prod-blobs",
        remote: true,
      }]);
      expect(config.main).toBeUndefined();
    } finally {
      await rm(generated.directory, { recursive: true, force: true });
    }
  });

  test("collapses all three DO cursors and maps counts plus committed timestamps", async () => {
    const requests: URL[] = [];
    let calls = 0;
    const source = createStorageTruthSource({
      db: unusedDb,
      bucket: r2(),
      apiBase: "https://api.test/",
      platformSecret: "secret",
      fetch: (async (input: string | URL | Request) => {
        requests.push(new URL(String(input)));
        if (++calls === 1) return response({
          ...pin, indexSyncedSeq: 3,
          droppedPage: [{ sha: sha("a"), lastSeq: 1 }], nextSha: sha("a"),
          seqRootsPage: [{ seq: 2, manifestSha: sha("b") }], nextSeq: 2,
          gapPage: [{ seq: 3, manifestSha: sha("c"), inlineRefs: [sha("d")] }], nextGapSeq: 3,
          createdAtBySequence: { "1": 1_000, "2": 2_000, "3": 3_000 },
        });
        return response({ ...pin, indexSyncedSeq: 3, droppedPage: [], seqRootsPage: [], gapPage: [], createdAtBySequence: {} });
      }) as typeof fetch,
    });

    const first = await source.roots(workspace, null, null, 20_000);
    expect(first).toMatchObject({ outcome: "ok", triple: pin, droppedRows: 1, seqRootRows: 1 });
    expect(first.entries).toEqual([
      { sha: sha("a"), head: false, sequence: 1, committedAt: 1_000 },
      { sha: sha("b"), head: false, sequence: 2, committedAt: 2_000 },
      { sha: sha("c"), head: true, sequence: 3, committedAt: 3_000 },
      { sha: sha("d"), head: true, sequence: 3, committedAt: 3_000 },
    ]);
    expect(decodeRootsCursor(first.nextCursor!)).toEqual({ v: 1, fromSha: sha("a"), fromSeq: "2", fromGapSeq: "3" });

    const second = await source.roots(workspace, first.nextCursor!, pin, 20_000);
    expect(second).toMatchObject({ outcome: "ok", entries: [], nextCursor: null, droppedRows: 0, seqRootRows: 0 });
    expect(Object.fromEntries(requests[1]!.searchParams)).toEqual({
      ws: "ws_1", proj: "dir/root", fromSha: sha("a"), fromSeq: "2", fromGapSeq: "3", limit: "20000",
      pinHead: "3", pinFloor: "0", pinGen: "7",
    });
  });

  test("strictly verifies and expands a sidecar from canonical R2", async () => {
    const refs = [{ encSha: sha("1"), size: 11 }, { encSha: sha("2"), size: 22 }];
    const bytes = serializeRefset(refs);
    const sidecarSha = createHash("sha256").update(bytes).digest("hex");
    const key = `blobs/sha256/${sidecarSha.slice(0, 2)}/${sidecarSha}`;
    const source = createStorageTruthSource({
      db: unusedDb,
      bucket: r2(new Map([[key, bytes]])),
      apiBase: "https://api.test",
      platformSecret: "secret",
      fetch: (async () => response({
        head: 1, pruneFloor: 0, indexGeneration: 1,
        droppedPage: [], seqRootsPage: [],
        gapPage: [{ seq: 1, manifestSha: sha("a"), carrierSha: sidecarSha, sidecar: { sha: sidecarSha, count: 2, size: 33 } }],
        createdAtBySequence: { "1": 1234 },
      })) as typeof fetch,
    });

    const page = await source.roots(workspace, null, null, 10);
    expect(page.outcome).toBe("ok");
    expect(page.entries?.map((entry) => entry.sha)).toEqual([sha("a"), sidecarSha, sha("1"), sha("2")]);
    expect(page.entries?.every((entry) => entry.head && entry.committedAt === 1234)).toBe(true);
  });

  test("separates stale snapshots from uninspectable HTTP, protocol, and sidecar failures", async () => {
    const sourceFor = (status: number, body: unknown, bucket = r2()) => createStorageTruthSource({
      db: unusedDb, bucket, apiBase: "https://api.test", platformSecret: "secret",
      fetch: (async () => response(body, status)) as typeof fetch,
    });
    await expect(sourceFor(409, { error: "snapshot_changed" }).roots(workspace, null, pin, 1))
      .resolves.toMatchObject({ outcome: "snapshot_changed" });
    await expect(sourceFor(409, { error: "roots_incomplete" }).roots(workspace, null, pin, 1))
      .resolves.toMatchObject({ outcome: "uninspectable", reason: "roots_incomplete" });
    await expect(sourceFor(503, { error: "timestamp_unavailable" }).roots(workspace, null, pin, 1))
      .resolves.toMatchObject({ outcome: "uninspectable", reason: "timestamp_unavailable" });
    await expect(sourceFor(200, { ...pin, droppedPage: "bad" }).roots(workspace, null, pin, 1))
      .resolves.toMatchObject({ outcome: "uninspectable", reason: "invalid roots response" });
    await expect(sourceFor(200, {
      head: 1, pruneFloor: 0, indexGeneration: 1, droppedPage: [], seqRootsPage: [],
      gapPage: [{ seq: 1, manifestSha: sha("a"), carrierSha: sha("f"), sidecar: { sha: sha("f"), count: 1, size: 1 } }],
      createdAtBySequence: { "1": 1 },
    }).roots(workspace, null, null, 1)).resolves.toMatchObject({ outcome: "uninspectable", reason: "sidecar missing" });
  });

  test("close removes fleet state and invokes binding cleanup once", async () => {
    let proxyCloses = 0;
    const emptyDb = {
      prepare: () => ({ bind: () => ({ first: async () => null, all: async () => ({ results: [] }) }) }),
    } as ReadOnlyD1;
    const source = new BindingStorageTruthSource({
      db: emptyDb, bucket: r2(), apiBase: "https://api.test", platformSecret: "secret", close: async () => { proxyCloses++; },
    });
    expect(await source.fleetReachability(null, 10)).toEqual({ rows: [], nextCursor: null });
    await source.close();
    await source.close();
    expect(proxyCloses).toBe(1);
    await expect(source.fleetReachability(null, 10)).rejects.toThrow("closed");
  });
});
