import { describe, expect, test, vi } from "vitest";
import { adminRoutes } from "../src/routes/admin.js";
import type { Env } from "../src/env.js";
import type { RouteCtx } from "../src/routes/shared.js";

const BASE = "https://api.rbox.test/v1/admin/roots-inspect";
const PLATFORM = { "x-rbox-platform": "platform" };

interface FakeEnvResult {
  env: Env;
  idFromName: ReturnType<typeof vi.fn>;
  doFetch: ReturnType<typeof vi.fn>;
  prepare: ReturnType<typeof vi.fn>;
}

function fakeEnv(doBody: Record<string, unknown>, timestamps: Array<{ sequence: number; created_at: number }> = []): FakeEnvResult {
  const doFetch = vi.fn(async () => new Response(JSON.stringify(doBody), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  const idFromName = vi.fn(() => ({ fake: "id" }));
  const prepare = vi.fn((sql: string) => ({
    bind: (..._bindings: unknown[]) => ({
      first: async () => sql.includes("FROM workspaces") ? { account_id: "acct" } : null,
      all: async () => sql.includes("FROM commits") ? { results: timestamps } : { results: [] },
    }),
  }));
  const env = {
    RBOX_PLATFORM_SECRET: "platform",
    WORKSPACE_SYNC: {
      idFromName,
      get: () => ({ fetch: doFetch }),
    },
    rbox_dev_db: { prepare },
  } as unknown as Env;
  return { env, idFromName, doFetch, prepare };
}

function ctx(urlText: string, env: Env, headers: Record<string, string> = {}): RouteCtx {
  const url = new URL(urlText);
  return {
    req: new Request(url, { method: "GET", headers }),
    env,
    url,
    seg: url.pathname.split("/").filter(Boolean),
  } as RouteCtx;
}

describe("GET /v1/admin/roots-inspect", () => {
  test("cloaks the operator surface without the platform secret", async () => {
    const f = fakeEnv({ droppedPage: [], seqRootsPage: [], gapPage: [] });
    expect((await adminRoutes(ctx(`${BASE}?ws=ws&proj=root`, f.env)))?.status).toBe(404);
    expect((await adminRoutes(ctx(`${BASE}?ws=ws&proj=root`, f.env, { "x-rbox-platform": "wrong" })))?.status).toBe(404);
    expect(f.doFetch).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  test("forwards only read-only cursor parameters and returns every root sequence timestamp", async () => {
    const f = fakeEnv({
      head: 4, pruneFloor: 0, indexGeneration: 9, indexSyncedSeq: 4,
      droppedPage: [{ sha: "a".repeat(64), lastSeq: 2 }], nextSha: "a".repeat(64),
      seqRootsPage: [{ seq: 3, manifestSha: "b".repeat(64) }], nextSeq: 3,
      gapPage: [{ seq: 4, manifestSha: "c".repeat(64), inlineRefs: ["d".repeat(64)] }],
    }, [
      { sequence: 2, created_at: 2_000 },
      { sequence: 3, created_at: 3_000 },
      { sequence: 4, created_at: 4_000 },
    ]);
    const request = `${BASE}?ws=ws_1&proj=dir%2Froot&fromSha=abc&fromSeq=2&fromGapSeq=3&pinHead=4&pinFloor=0&pinGen=9&limit=10&rebuild=1&ignored=x`;
    const res = await adminRoutes(ctx(request, f.env, PLATFORM));

    expect(res?.status).toBe(200);
    expect(f.idFromName).toHaveBeenCalledWith("ws_1/dir/root");
    expect(f.doFetch).toHaveBeenCalledTimes(1);
    const [forwarded, init] = f.doFetch.mock.calls[0]!;
    const forwardedUrl = new URL(String(forwarded));
    expect(forwardedUrl.pathname).toBe("/roots-inspect");
    expect(Object.fromEntries(forwardedUrl.searchParams)).toEqual({
      fromSha: "abc", fromSeq: "2", fromGapSeq: "3", pinHead: "4", pinFloor: "0", pinGen: "9", limit: "10",
    });
    expect(init).toEqual({ method: "GET" });
    expect(await res?.json()).toMatchObject({
      droppedPage: [{ sha: "a".repeat(64), lastSeq: 2 }],
      seqRootsPage: [{ seq: 3, manifestSha: "b".repeat(64) }],
      gapPage: [{ seq: 4, manifestSha: "c".repeat(64) }],
      createdAtBySequence: { "2": 2_000, "3": 3_000, "4": 4_000 },
    });
    expect(f.prepare.mock.calls.map((call) => String(call[0]))).toEqual([
      expect.stringContaining("FROM workspaces"),
      expect.stringContaining("FROM commits"),
    ]);
  });

  test("returns null timestamps when the best-effort commits mirror has sequence gaps", async () => {
    const f = fakeEnv({
      droppedPage: [{ sha: "a".repeat(64), lastSeq: 2 }],
      seqRootsPage: [{ seq: 3, manifestSha: "b".repeat(64) }],
      gapPage: [],
    }, [{ sequence: 2, created_at: 2_000 }]);
    const res = await adminRoutes(ctx(`${BASE}?ws=ws&proj=root`, f.env, PLATFORM));
    expect(res?.status).toBe(200);
    expect(await res?.json()).toEqual({
      droppedPage: [{ sha: "a".repeat(64), lastSeq: 2 }],
      seqRootsPage: [{ seq: 3, manifestSha: "b".repeat(64) }],
      gapPage: [],
      createdAtBySequence: { "2": 2_000, "3": null },
    });
  });
});
