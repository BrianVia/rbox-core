import { describe, expect, test, vi } from "vitest";
import { fetchDeltaSoak } from "../src/admin.js";
import { adminRoutes } from "../src/routes/admin.js";
import type { Env } from "../src/env.js";
import type { RouteCtx } from "../src/routes/shared.js";

const URL = "https://api.rbox.test/v1/admin/delta-soak";
const baseEnv = { RBOX_PLATFORM_SECRET: "platform" } as Env;

function ctx(url = URL, headers: Record<string, string> = {}, env: Env = baseEnv): RouteCtx {
  const parsed = new URLConstructor(url);
  return {
    req: new Request(parsed, { headers }),
    env,
    url: parsed,
    seg: parsed.pathname.split("/").filter(Boolean),
  } as RouteCtx;
}

const URLConstructor = globalThis.URL;

describe("GET /v1/admin/delta-soak", () => {
  test("hides the platform surface without the correct secret", async () => {
    expect((await adminRoutes(ctx()))?.status).toBe(404);
    expect((await adminRoutes(ctx(URL, { "x-rbox-platform": "wrong" })))?.status).toBe(404);
  });

  test("returns 503 when Analytics Engine credentials are unavailable", async () => {
    const res = await adminRoutes(ctx(URL, { "x-rbox-platform": "platform" }));
    expect(res?.status).toBe(503);
    expect(await res?.json()).toEqual({ error: "analytics_unavailable" });
  });

  test("maps the real AE columns to the numeric-only response", async () => {
    const query = vi.fn(async (_env: Env, _token: string, sql: string) => {
      if (sql.includes("divergence_events")) return [{
        divergence_events: "2", harmful_total: "7", benign_events: "3", benign_total: "4",
        sizes_count: "11",
      }];
      if (sql.includes("blob2 = 'admit_stmts'")) return [{ n: "9", p50: 3, p95: 8 }];
      if (sql.includes("blob2 = 'fallback'")) return [{ reason: "first_commit", n: "5" }, { reason: "epoch_rotation", n: 2 }];
      if (sql.includes("fence_violation")) return [{ outcome: "fence_violation", n: "1" }, { outcome: "delta_error", n: 4 }];
      return [{ total: "123" }];
    });
    const e = { CF_ANALYTICS_TOKEN: "ae-token", CF_ACCOUNT_ID: "account", RBOX_ENV: "dev" } as Env;

    await expect(fetchDeltaSoak(e, 72, query)).resolves.toEqual({
      sinceHours: 72,
      commitDelta: {
        divergence: { events: 2, harmfulTotal: 7 },
        benignMarkerDivergence: { events: 3, total: 4 },
        fallback: { byReason: { first_commit: 5, epoch_rotation: 2 }, total: 7 },
        highSeverity: { fence_violation: 1, parent_unreadable: 0, delta_error: 4 },
        admitStmts: { count: 9, p50: 3, p95: 8 },
        sizes: { count: 11 },
      },
      commits: { total: 123 },
    });

    const sql = query.mock.calls.map((call) => call[2]).join("\n");
    expect(sql).toContain("FROM rbox_dev_metrics");
    expect(sql).toContain("index1 = 'commit.delta'");
    expect(sql).toContain("double2 * _sample_interval");
    expect(sql).toContain("quantileExactWeighted(0.95)(double4, _sample_interval)");
    expect(sql).toContain("blob1 = 'commit' AND blob3 = 'ok'");
    expect(sql).not.toContain("blob4 AS");
  });
});
