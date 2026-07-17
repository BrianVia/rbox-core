import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeRefset } from "../src/engine/refset.js";
import {
  BindingStorageTruthSource,
  createSource,
  createStorageTruthSource,
  decodeRootsCursor,
  resolveStorageTruthResources,
  RestD1,
  RestR2,
  StorageTruthConnectionError,
  type ReadOnlyD1,
  type ReadOnlyR2,
} from "./storage-truth-live.js";
import { normalizeRunnerFailure, renderRunnerFailure } from "./storage-truth.js";

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
  test("statically resolves storage resources from checked-in environments", () => {
    expect(resolveStorageTruthResources("production")).toEqual({
      environment: "production",
      databaseId: "c6b3e6ab-4130-4c9b-8f77-cdae47745c5c",
      bucketName: "rbox-prod-blobs",
    });
    expect(resolveStorageTruthResources("dev")).toEqual({
      environment: "dev",
      databaseId: "91ae0add-f766-4dd5-8de3-96b8ce1f4e04",
      bucketName: "rbox-dev-blobs",
    });
  });

  test("D1 REST permits one lexical SELECT and rejects statements or write metadata", async () => {
    const requests: Array<{ url: string; body: unknown }> = [];
    let changed = false;
    const db = new RestD1("db-id", {
      accountId: "account", apiToken: "token", apiBase: "https://cf.test/client/v4",
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        return response({ success: true, result: [{ success: true, results: [{ value: 1 }], meta: {
          changed_db: changed, changes: 0, rows_written: 0,
        } }] });
      }) as typeof fetch,
    });
    await expect(db.prepare("/* ; */ SELECT ';' AS value; -- trailing ;").bind().first()).resolves.toEqual({ value: 1 });
    expect(requests[0]).toEqual({
      url: "https://cf.test/client/v4/accounts/account/d1/database/db-id/query",
      body: { sql: "/* ; */ SELECT ';' AS value; -- trailing ;", params: [] },
    });
    expect(() => db.prepare("SELECT 1; DELETE FROM blobs")).toThrow("exactly one SELECT");
    expect(() => db.prepare("UPDATE accounts SET used_bytes=0")).toThrow("exactly one SELECT");
    expect(requests).toHaveLength(1);
    changed = true;
    await expect(db.prepare("SELECT 1").bind().all()).rejects.toThrow("reported a write");
  });

  test("R2 REST pagination forwards and maps opaque cursors with injected fetch", async () => {
    const urls: URL[] = [];
    let page = 0;
    const bucket = new RestR2("bucket name", {
      accountId: "account", apiToken: "token", apiBase: "https://cf.test/client/v4",
      fetch: (async (input: string | URL | Request) => {
        urls.push(new URL(String(input)));
        page++;
        return response(page === 1 ? {
          success: true,
          result: [{ key: "blobs/sha256/a", size: 12, last_modified: "2026-07-17T12:00:00Z" }],
          result_info: { is_truncated: true, cursor: "opaque+/=" },
        } : {
          success: true,
          result: [{ key: "blobs/sha256/b", size: 34, last_modified: "2026-07-17T12:01:00Z" }],
          result_info: { is_truncated: false },
        });
      }) as typeof fetch,
    });
    const first = await bucket.list({ prefix: "blobs/sha256/", limit: 1 });
    expect(first).toEqual({
      objects: [{ key: "blobs/sha256/a", size: 12, uploaded: "2026-07-17T12:00:00Z" }],
      truncated: true,
      cursor: "opaque+/=",
    });
    const second = await bucket.list({ prefix: "blobs/sha256/", limit: 1, cursor: first.cursor });
    expect(second.truncated).toBe(false);
    expect(Object.fromEntries(urls[0]!.searchParams)).toEqual({ prefix: "blobs/sha256/", per_page: "1" });
    expect(Object.fromEntries(urls[1]!.searchParams)).toEqual({ prefix: "blobs/sha256/", per_page: "1", cursor: "opaque+/=" });
    expect(urls[0]!.pathname).toBe("/client/v4/accounts/account/r2/buckets/bucket%20name/objects");
  });

  test("R2 REST get keeps key slashes literal and maps raw object metadata", async () => {
    let requested = "";
    const bytes = new Uint8Array([1, 2, 3]);
    const bucket = new RestR2("bucket", {
      accountId: "account", apiToken: "token", apiBase: "https://cf.test/client/v4",
      fetch: (async (input: string | URL | Request) => {
        requested = String(input);
        return new Response(bytes, { headers: {
          "content-length": "3",
          "last-modified": "Fri, 17 Jul 2026 12:00:00 GMT",
        } });
      }) as typeof fetch,
    });
    const object = await bucket.get("blobs/sha256/a+b?");
    expect(new URL(requested).pathname).toBe("/client/v4/accounts/account/r2/buckets/bucket/objects/blobs/sha256/a%2Bb%3F");
    expect(object).toMatchObject({ key: "blobs/sha256/a+b?", size: 3, uploaded: "Fri, 17 Jul 2026 12:00:00 GMT" });
    expect(new Uint8Array(await object!.arrayBuffer())).toEqual(bytes);
    await expect(bucket.get("blobs/../secret")).rejects.toThrow("unsafe dot path segment");
  });

  test("establishment times out with a named structured error even when fetch ignores abort", async () => {
    const never = new Promise<Response>(() => {});
    const source = createSource({
      environment: "production",
      accountId: "account",
      apiToken: "token",
      platformSecret: "platform",
      establishmentTimeoutMs: 10,
      fetch: (async (input: string | URL | Request) => String(input).includes("/d1/")
        ? never
        : response({ success: true, result: [], result_info: { is_truncated: false } })) as typeof fetch,
    });
    let thrown: unknown;
    try { await source; } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(StorageTruthConnectionError);
    expect(thrown).toMatchObject({
      name: "StorageTruthConnectionError",
      component: "d1-rest",
      environment: "production",
      requiredEnvironment: ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"],
      reason: "connection timed out",
      timeoutMs: 10,
    });
    const failure = normalizeRunnerFailure(thrown);
    expect(failure.failure).toMatchObject({
      name: "StorageTruthConnectionError", component: "d1-rest", environment: "production", timeoutMs: 10,
    });
    expect(renderRunnerFailure(failure)).toContain('"kind": "runner-failure"');
  });

  test("runner writes and renders a structured factory failure with exit code 2", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-truth-runner-failure-"));
    const json = path.join(directory, "failure.json");
    try {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, "scripts/storage-truth.ts", "--account", "acct", "--adapter", "scripts/storage-truth-live.ts", "--spool", directory, "--json", json],
        cwd: path.resolve(import.meta.dir, ".."),
        env: { ...process.env, RBOX_STORAGE_TRUTH_ENV: "invalid-test-environment" },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stderr).text(),
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain("Storage truth runner failure");
      expect(stderr).toContain('"name": "StorageTruthConnectionError"');
      expect(JSON.parse(await readFile(json, "utf8"))).toMatchObject({
        schemaVersion: 1,
        kind: "runner-failure",
        status: "failed",
        failure: {
          name: "StorageTruthConnectionError",
          component: "config",
          environment: "invalid-test-environment",
          requiredEnvironment: ["RBOX_STORAGE_TRUTH_ENV"],
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
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

  test("passes null timestamps through for sequences missing from the best-effort commits mirror", async () => {
    const source = createStorageTruthSource({
      db: unusedDb,
      bucket: r2(),
      apiBase: "https://api.test/",
      platformSecret: "secret",
      fetch: (async () => response({
        ...pin, indexSyncedSeq: 3,
        droppedPage: [{ sha: sha("a"), lastSeq: 1 }],
        seqRootsPage: [{ seq: 2, manifestSha: sha("b") }],
        gapPage: [{ seq: 3, manifestSha: sha("c") }],
        createdAtBySequence: { "1": 1_000, "2": null },
      })) as typeof fetch,
    });

    const page = await source.roots(workspace, null, null, 20_000);
    expect(page).toMatchObject({ outcome: "ok", triple: pin });
    expect(page.entries).toEqual([
      { sha: sha("a"), head: false, sequence: 1, committedAt: 1_000 },
      { sha: sha("b"), head: false, sequence: 2, committedAt: null },
      { sha: sha("c"), head: true, sequence: 3, committedAt: null },
    ]);
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
