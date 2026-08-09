import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { adminRoutes } from "../apps/api/src/routes/admin.js";
import type { Env } from "../apps/api/src/env.js";
import type { RouteCtx } from "../apps/api/src/routes/shared.js";
import { WorkspaceSync } from "../apps/api/src/workspace-sync.js";
import { fakeDoSql } from "../apps/api/test/helpers/fake-do-sql.js";
import { serializeRefset } from "../src/engine/refset.js";
import { BindingStorageTruthSource, decodeRootsCursor, type ReadOnlyD1, type ReadOnlyR2 } from "./storage-truth-live.js";
import { measureStorageTruth, type RootsPage } from "./storage-truth.js";

if (!("WebSocketRequestResponsePair" in globalThis)) {
  Object.assign(globalThis, {
    WebSocketRequestResponsePair: class {
      constructor(public readonly request: string, public readonly response: string) {}
    },
  });
}

const NOW = 1_800_000_000_000;
const ACCOUNT = "acct";
const WORKSPACE = "ws_live";
const PROJECT = "dir/root";
const PLATFORM_SECRET = "platform-secret";
const HEAD = 20_001;
const sha = (value: number): string => value.toString(16).padStart(64, "0");
const headManifest = "a".repeat(64);
const inlineRoot = "b".repeat(64);
const expandedRoot = "f".repeat(64);
const retainedRoot = sha(1);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function signed(sequence: number, manifestSha: string, refs: { inline: string[] } | { sidecarSha: string; count: number; totalBytes: number }): string {
  const carrier = "inline" in refs
    ? { blobRefs: refs.inline.map((encSha) => ({ encSha, size: 1 })) }
    : { blobRefset: refs };
  return JSON.stringify({
    body: JSON.stringify({ type: "rbox/commit/v1", seq: sequence, encManifestSha: manifestSha, ...carrier }),
    commitHash: "c".repeat(64),
    sig: "sig",
  });
}

interface Counters {
  d1Reads: number;
  d1Mutations: number;
  r2Gets: number;
  r2Lists: number;
  r2Mutations: number;
  kvWrites: number;
  sqlReads: number;
  sqlWrites: number;
  transactions: number;
  alarms: number;
}

type FixtureD1Row =
  | { workspace_id: string; project_id: string }
  | { sequence: number; created_at: number }
  | { sha256: string; size_bytes: number; present: number; marked_at: null; deleting_at: null; created_at_ms: number }
  | { account_id: string; sha256: string; granted_at: number; marked_at: null; size_bytes: number; pack_id: null; length: null; pack_inventory_present: null };
type FixtureD1FirstRow =
  | { used_bytes: number; plan: string }
  | { account_id: string }
  | { bytes: number };

function fixtureD1(counters: Counters, sidecarSha: string): ReadOnlyD1 {
  const blobRows = [
    { sha256: retainedRoot, size_bytes: 20, present: 1, marked_at: null, deleting_at: null, created_at_ms: NOW - 10_000 },
    { sha256: headManifest, size_bytes: 10, present: 1, marked_at: null, deleting_at: null, created_at_ms: NOW - 10_000 },
    { sha256: sidecarSha, size_bytes: 58, present: 1, marked_at: null, deleting_at: null, created_at_ms: NOW - 10_000 },
    { sha256: expandedRoot, size_bytes: 7, present: 1, marked_at: null, deleting_at: null, created_at_ms: NOW - 10_000 },
  ].sort((a, b) => a.sha256.localeCompare(b.sha256));
  const entitlementRows = [
    { account_id: ACCOUNT, sha256: retainedRoot, granted_at: NOW - 10_000, marked_at: null, size_bytes: 20, pack_id: null, length: null, pack_inventory_present: null },
    { account_id: ACCOUNT, sha256: headManifest, granted_at: NOW - 10_000, marked_at: null, size_bytes: 10, pack_id: null, length: null, pack_inventory_present: null },
  ].sort((a, b) => a.sha256.localeCompare(b.sha256));

  const rowsFor = (sql: string, bindings: unknown[]): FixtureD1Row[] => {
    if (sql.includes("SELECT workspace_id,project_id FROM workspaces WHERE account_id")) {
      return [{ workspace_id: WORKSPACE, project_id: PROJECT }];
    }
    if (sql.includes("SELECT workspace_id,project_id FROM workspaces") && sql.includes("WHERE workspace_id>")) {
      return [{ workspace_id: WORKSPACE, project_id: PROJECT }];
    }
    if (sql.includes("SELECT sequence,created_at FROM commits")) {
      const sequences = JSON.parse(String(bindings[2])) as number[];
      return sequences.map((sequence) => ({ sequence, created_at: NOW - (HEAD - sequence + 1) * 1_000 }));
    }
    if (sql.includes("SELECT sha256,size_bytes FROM blobs WHERE sha256 >")) {
      const after = String(bindings[0]);
      const limit = Number(bindings[1]);
      return blobRows.filter((row) => row.sha256 > after).slice(0, limit);
    }
    if (sql.includes("FROM blob_refs r LEFT JOIN blob_ref_candidates")) {
      const after = String(bindings[1]);
      const limit = Number(bindings[2]);
      return entitlementRows.filter((row) => row.sha256 > after).slice(0, limit);
    }
    if (sql.includes("FROM blobs b") && sql.includes("LEFT JOIN gc_candidates")) {
      const after = String(bindings[0]);
      const limit = Number(bindings[1]);
      return blobRows.filter((row) => row.sha256 > after).slice(0, limit);
    }
    if (sql.includes("FROM packs p LEFT JOIN pack_gc_candidates")) return [];
    if (sql.includes("FROM pack_members")) return [];
    throw new Error(`unexpected D1 all(): ${sql}`);
  };

  const firstFor = (sql: string): FixtureD1FirstRow | null => {
    if (sql.includes("SELECT used_bytes,plan FROM accounts")) return { used_bytes: 30, plan: "pro" };
    if (sql.includes("SELECT account_id FROM workspaces")) return { account_id: ACCOUNT };
    if (sql.includes("SELECT COALESCE(SUM")) return { bytes: 0 };
    throw new Error(`unexpected D1 first(): ${sql}`);
  };

  return {
    prepare(sql: string) {
      if (!sql.trimStart().toLowerCase().startsWith("select ")) {
        counters.d1Mutations++;
        throw new Error(`D1 mutation attempted: ${sql}`);
      }
      counters.d1Reads++;
      return {
        bind(...bindings: unknown[]) {
          return {
            async first<T>() { return firstFor(sql) as T | null; },
            async all<T>() { return { results: rowsFor(sql, bindings) as T[] }; },
          };
        },
      };
    },
  };
}

function fixtureR2(counters: Counters, sidecarSha: string, sidecarBytes: Uint8Array): ReadOnlyR2 {
  const objects = [
    { key: `blobs/sha256/${retainedRoot.slice(0, 2)}/${retainedRoot}`, size: 20, uploaded: new Date(NOW - 10_000) },
    { key: `blobs/sha256/${headManifest.slice(0, 2)}/${headManifest}`, size: 10, uploaded: new Date(NOW - 10_000) },
    { key: `blobs/sha256/${sidecarSha.slice(0, 2)}/${sidecarSha}`, size: sidecarBytes.byteLength, uploaded: new Date(NOW - 10_000) },
    { key: `blobs/sha256/${expandedRoot.slice(0, 2)}/${expandedRoot}`, size: 7, uploaded: new Date(NOW - 10_000) },
  ];
  return {
    async get(key: string) {
      counters.r2Gets++;
      const expected = `blobs/sha256/${sidecarSha.slice(0, 2)}/${sidecarSha}`;
      if (key !== expected) return null;
      return {
        key, size: sidecarBytes.byteLength, uploaded: new Date(NOW - 10_000),
        async arrayBuffer() {
          return sidecarBytes.buffer.slice(sidecarBytes.byteOffset, sidecarBytes.byteOffset + sidecarBytes.byteLength) as ArrayBuffer;
        },
      };
    },
    async list(options) {
      counters.r2Lists++;
      if (options.cursor) throw new Error("fixture has one R2 page");
      return { objects: options.prefix === "blobs/sha256/" ? objects : [], truncated: false };
    },
    put() { counters.r2Mutations++; throw new Error("R2 put attempted"); },
    delete() { counters.r2Mutations++; throw new Error("R2 delete attempted"); },
  } as unknown as ReadOnlyR2;
}

function routeContext(request: Request, env: Env): RouteCtx {
  const url = new URL(request.url);
  return {
    req: request,
    env,
    url,
    seg: url.pathname.split("/").filter(Boolean),
    exports: {},
    executionCtx: { waitUntil() {} },
  } as unknown as RouteCtx;
}

describe("storage truth live read-only path", () => {
  test("measures through adapter -> admin route -> real roots-inspect with zero authoritative writes", async () => {
    const counters: Counters = { d1Reads: 0, d1Mutations: 0, r2Gets: 0, r2Lists: 0, r2Mutations: 0, kvWrites: 0, sqlReads: 0, sqlWrites: 0, transactions: 0, alarms: 0 };
    const sidecarBytes = serializeRefset([{ encSha: expandedRoot, size: 7 }]);
    const sidecarSha = createHash("sha256").update(sidecarBytes).digest("hex");
    const dropped = Array.from({ length: HEAD }, (_, index) => ({ sha256: sha(index + 1), last_seq: 1 }));
    const seqRoots = Array.from({ length: HEAD }, (_, index) => ({
      seq: index + 1,
      manifest_sha: index + 1 === HEAD ? headManifest : sha(HEAD + index + 1),
      carrier_sha: index + 1 === HEAD ? sidecarSha : null,
    }));
    const baseSql = fakeDoSql({ dropped, seqRoots });
    const sql = {
      ...baseSql,
      exec(query: string, ...bindings: unknown[]) {
        if (!query.trimStart().toLowerCase().startsWith("select ")) {
          counters.sqlWrites++;
          throw new Error(`DO SQL mutation attempted: ${query}`);
        }
        counters.sqlReads++;
        return baseSql.exec(query, ...bindings);
      },
    };
    const kv = new Map<string, unknown>([
      ["head", { sequence: HEAD, commitHash: "c".repeat(64) }],
      ["pruneFloor", 0],
      ["index_state", "ready"],
      ["index_synced_seq", HEAD - 1],
      ["index_generation", 9],
      [`seq:${HEAD - 1}`, signed(HEAD - 1, sha(4 * HEAD), { inline: [inlineRoot] })],
      [`seq:${HEAD}`, signed(HEAD, headManifest, { sidecarSha, count: 1, totalBytes: 7 })],
    ]);
    const ctx = {
      storage: {
        sql,
        kv: {
          get: (key: string) => kv.get(key),
          put: () => { counters.kvWrites++; throw new Error("DO KV write attempted"); },
          delete: () => { counters.kvWrites++; throw new Error("DO KV delete attempted"); },
          list: () => new Map(),
        },
        transactionSync: () => { counters.transactions++; throw new Error("DO transaction attempted"); },
        getAlarm: () => null,
        setAlarm: () => { counters.alarms++; throw new Error("DO alarm write attempted"); },
      },
      getWebSockets: () => [],
      setWebSocketAutoResponse: () => {},
    } as unknown as DurableObjectState;
    const d1 = fixtureD1(counters, sidecarSha);
    const bucket = fixtureR2(counters, sidecarSha, sidecarBytes);
    const sync = new WorkspaceSync(ctx, { rbox_dev_blobs: bucket } as unknown as Env);
    const forwardedDoUrls: URL[] = [];
    const env = {
      RBOX_PLATFORM_SECRET: PLATFORM_SECRET,
      rbox_dev_db: d1,
      WORKSPACE_SYNC: {
        idFromName(name: string) {
          expect(name).toBe(`${WORKSPACE}/${PROJECT}`);
          return { name };
        },
        get() {
          return {
            async fetch(input: RequestInfo | URL, init?: RequestInit) {
              const request = new Request(input, init);
              forwardedDoUrls.push(new URL(request.url));
              return sync.fetch(request);
            },
          };
        },
      },
    } as unknown as Env;
    const routeFetch: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      const response = await adminRoutes(routeContext(request, env));
      return response ?? new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    };
    const source = new BindingStorageTruthSource({ db: d1, bucket, apiBase: "https://api.rbox.test", platformSecret: PLATFORM_SECRET, fetch: routeFetch, clock: () => NOW });
    const observedRootPages: RootsPage[] = [];
    const realRoots = source.roots.bind(source);
    source.roots = async (...args) => {
      const page = await realRoots(...args);
      observedRootPages.push(page);
      return page;
    };
    const spool = await mkdtemp(path.join(os.tmpdir(), "rbox-storage-truth-live-e2e-"));
    temporaryDirectories.push(spool);

    try {
      const report = await measureStorageTruth(source, ACCOUNT, spool);

      expect(report.status).toBe("complete");
      expect(report.sectionA.partitionHolds).toBe(true);
      expect(report.sectionA.buckets["active-head"].count).toBe(1);
      expect(report.sectionA.buckets["retained-history"].count).toBe(1);
      expect(report.sectionB.phase1.droppedPages.observed).toBe(2);
      expect(report.sectionB.phase1.seqRootPages.observed).toBe(2);
      expect(report.sectionB.windowExpiredRetained.count).toBe(0);

      const continued = observedRootPages.find((page) => page.nextCursor !== null && page.nextCursor !== undefined);
      expect(continued?.droppedRows).toBe(20_000);
      expect(continued?.seqRootRows).toBe(20_000);
      expect(continued?.entries?.some((entry) => entry.sha === inlineRoot && entry.committedAt === NOW - 2_000)).toBe(true);
      expect(continued?.nextCursor).toBeString();
      expect(decodeRootsCursor(continued!.nextCursor!)).toEqual({ v: 1, fromSha: sha(20_000), fromSeq: "20000", fromGapSeq: "20000" });
      expect(observedRootPages.some((page) => page.entries?.some((entry) => entry.sha === expandedRoot && entry.committedAt === NOW - 1_000))).toBe(true);
      expect(forwardedDoUrls.some((url) => url.searchParams.get("fromSha") === sha(20_000)
        && url.searchParams.get("fromSeq") === "20000" && url.searchParams.get("fromGapSeq") === "20000")).toBe(true);

      expect(counters.r2Gets).toBeGreaterThanOrEqual(2); // account scan + independently pinned fleet scan
      expect(counters.r2Lists).toBe(2);
      expect(counters.d1Reads).toBeGreaterThan(0);
      expect(counters.sqlReads).toBeGreaterThan(0);
      expect({
        d1Mutations: counters.d1Mutations,
        r2Mutations: counters.r2Mutations,
        kvWrites: counters.kvWrites,
        sqlWrites: counters.sqlWrites,
        transactions: counters.transactions,
        alarms: counters.alarms,
      }).toEqual({ d1Mutations: 0, r2Mutations: 0, kvWrites: 0, sqlWrites: 0, transactions: 0, alarms: 0 });
    } finally {
      await source.close();
    }
  }, 60_000);
});
