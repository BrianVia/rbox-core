import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";

const BASE = "https://example.com";
const HOUR = 60 * 60 * 1000;
const PLATFORM = { "x-rbox-platform": "test-platform-secret" };

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

describe("read-only multipart orphan inventory", () => {
  test("is platform-gated and returns only bucketed numeric state", async () => {
    expect((await SELF.fetch(`${BASE}/v1/admin/multipart-inventory`)).status).toBe(404);

    const bootstrap = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: "multipart-inventory", plan: "pro" }),
    });
    expect(bootstrap.status).toBe(200);
    const { token } = (await bootstrap.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    const now = Date.now();
    const specs = [
      ["inventory-young", 111, now - 30 * 60 * 1000],
      ["inventory-old", 222, now - 2 * 24 * HOUR],
    ] as const;
    const rows: Array<{ uploadId: string; size: number; createdAt: number; sha: string }> = [];
    for (const [name, size, createdAt] of specs) {
      const sha = createHash("sha256").update(name).digest("hex");
      const init = await SELF.fetch(`${BASE}/v1/blobs/${sha}/multipart`, {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify({ size }),
      });
      expect(init.status).toBe(200);
      const { uploadId } = (await init.json()) as { uploadId: string };
      await env.rbox_dev_db
        .prepare("UPDATE uploads SET created_at = ? WHERE upload_id = ?")
        .bind(createdAt, uploadId)
        .run();
      rows.push({ uploadId, size, createdAt, sha });
    }
    const part = new Uint8Array(111);
    const partResponse = await SELF.fetch(`${BASE}/v1/blobs/${rows[0]!.sha}/multipart/${rows[0]!.uploadId}/part/1`, {
      method: "PUT",
      headers: { ...auth, "content-length": String(part.byteLength) },
      body: part,
    });
    expect(partResponse.status).toBe(200);
    await env.rbox_dev_blobs.put("staging/private-object-key", new Uint8Array(17));

    const response = await SELF.fetch(`${BASE}/v1/admin/multipart-inventory`, { headers: PLATFORM });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toMatch(/[a-f0-9]{40,}/i);
    expect(text).not.toContain("staging/");
    expect(text).not.toContain(rows[0]!.uploadId);
    const body = JSON.parse(text) as {
      incompleteUploads: { buckets: Array<{ label: string; count: number; declaredBytes: number; stagedBytes: number }>; total: { count: number; declaredBytes: number; stagedBytes: number } };
      stagingObjects: { total: { count: number; bytes: number }; truncated: boolean };
    };
    expect(body.incompleteUploads.buckets.find((b) => b.label === "<1h")).toMatchObject({ count: 1, declaredBytes: 111, stagedBytes: 111 });
    expect(body.incompleteUploads.buckets.find((b) => b.label === "24h-7d")).toMatchObject({ count: 1, declaredBytes: 222, stagedBytes: 0 });
    expect(body.incompleteUploads.total).toEqual({ count: 2, declaredBytes: 333, stagedBytes: 111 });
    expect(typeof body.stagingObjects.total.count).toBe("number");
    expect(typeof body.stagingObjects.total.bytes).toBe("number");
    expect(body.stagingObjects.total.count).toBeGreaterThanOrEqual(1);
    expect(body.stagingObjects.total.bytes).toBeGreaterThanOrEqual(17);
    expect(body.stagingObjects.truncated).toBe(false);
  });
});
