import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";

const BASE = "https://example.com";
const content = new TextEncoder().encode("multipart completion timing payload");
const sha = createHash("sha256").update(content).digest("hex");

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(): Promise<string> {
  const response = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: "multipart-timings", plan: "pro" }),
  });
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

describe("multipart completion server timings", () => {
  test("success is an additive superset of the old response shape", async () => {
    const token = await bootstrap();
    const headers = { authorization: `Bearer ${token}` };
    const init = await SELF.fetch(`${BASE}/v1/blobs/${sha}/multipart`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ size: content.byteLength }),
    });
    expect(init.status).toBe(200);
    const { uploadId } = (await init.json()) as { uploadId: string };
    const part = await SELF.fetch(`${BASE}/v1/blobs/${sha}/multipart/${uploadId}/part/1`, {
      method: "PUT",
      headers: { ...headers, "content-length": String(content.byteLength) },
      body: content,
    });
    expect(part.status).toBe(200);
    const complete = await SELF.fetch(`${BASE}/v1/blobs/${sha}/multipart/${uploadId}/complete`, { method: "POST", headers });
    expect(complete.status).toBe(200);
    const body = (await complete.json()) as {
      ok: boolean; sha256: string; sizeBytes: number;
      serverTimings: { totalMs: number; accountingMs: number; assembleMs: number; rereadPutMs: number };
    };
    expect(body).toMatchObject({ ok: true, sha256: sha, sizeBytes: content.byteLength });
    expect(Object.keys(body.serverTimings as object).sort()).toEqual(["accountingMs", "assembleMs", "rereadPutMs", "totalMs"]);
    const timings = body.serverTimings;
    for (const value of Object.values(timings)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(timings.totalMs).toBeGreaterThanOrEqual(timings.assembleMs!);
  });
});
