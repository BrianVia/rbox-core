import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import { createHash } from "node:crypto";

// Regression: `multipartComplete`'s cleanup used to run in a `finally` on EVERY exit path,
// including the `retry_later` 503s it tells the client to retry. That deleted the staging
// object plus the `uploads` / `upload_parts` rows, so the obedient retry hit `loadUpload` →
// null → `unknown_upload` 404 and the only recovery for a >90 MiB file was a full re-upload.

const BASE = "https://example.com";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const db = () => env.rbox_dev_db;

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

async function bootstrap(name: string): Promise<string> {
  const res = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** Declared-sha multipart upload with every part staged — one POST /complete away from done. */
async function stage(token: string, declaredSha: string, content: Uint8Array): Promise<{ uploadId: string; stagingKey: string }> {
  const headers = { authorization: `Bearer ${token}` };
  const init = await SELF.fetch(`${BASE}/v1/blobs/${declaredSha}/multipart`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ size: content.byteLength }),
  });
  expect(init.status).toBe(200);
  const { uploadId } = (await init.json()) as { uploadId: string };
  const part = await SELF.fetch(`${BASE}/v1/blobs/${declaredSha}/multipart/${uploadId}/part/1`, {
    method: "PUT",
    headers: { ...headers, "content-length": String(content.byteLength) },
    body: content,
  });
  expect(part.status).toBe(200);
  const row = await db().prepare("SELECT staging_key FROM uploads WHERE upload_id=?").bind(uploadId).first<{ staging_key: string }>();
  expect(row).not.toBeNull();
  return { uploadId, stagingKey: row!.staging_key };
}

const complete = (token: string, declaredSha: string, uploadId: string) =>
  SELF.fetch(`${BASE}/v1/blobs/${declaredSha}/multipart/${uploadId}/complete`, { method: "POST", headers: { authorization: `Bearer ${token}` } });

async function resumeState(uploadId: string, stagingKey: string) {
  return {
    upload: !!(await db().prepare("SELECT 1 FROM uploads WHERE upload_id=?").bind(uploadId).first()),
    parts: Number((await db().prepare("SELECT COUNT(*) AS n FROM upload_parts WHERE upload_id=?").bind(uploadId).first<{ n: number }>())!.n),
    staging: !!(await env.rbox_dev_blobs.head(stagingKey)),
  };
}

describe("multipart complete: cleanup is terminal-only", () => {
  test("a retry_later 503 preserves the staging object and BOTH D1 rows, and the retry succeeds", async () => {
    const token = await bootstrap("mp-resume-fence");
    const text = "multipart resume fence payload";
    const content = new TextEncoder().encode(text);
    const target = sha(text);
    const { uploadId, stagingKey } = await stage(token, target, content);

    // Open delete intent on the target sha → the `INSERT OR IGNORE INTO blobs` publication
    // aborts on the D1 fence → the transient 503 the client is told to retry.
    await db().prepare("INSERT INTO gc_candidates(sha256, kind, marked_at, deleting_at) VALUES (?, 'blob', 1, 2)").bind(target).run();
    const blocked = await complete(token, target, uploadId);
    expect(blocked.status).toBe(503);
    expect(await blocked.json()).toEqual({ error: "retry_later" });

    // The whole resume state survives — this is what the defect destroyed.
    expect(await resumeState(uploadId, stagingKey)).toEqual({ upload: true, parts: 1, staging: true });

    // …and the retry the 503 asked for actually completes, with no re-upload of any part.
    await db().prepare("DELETE FROM gc_candidates WHERE sha256=?").bind(target).run();
    const retried = await complete(token, target, uploadId);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({ ok: true, sha256: target, sizeBytes: content.byteLength });

    // The now-terminal outcome cleans all three up.
    expect(await resumeState(uploadId, stagingKey)).toEqual({ upload: false, parts: 0, staging: false });
  });

  test("a terminal sha_mismatch 412 still cleans up the staging object and both D1 rows", async () => {
    const token = await bootstrap("mp-resume-mismatch");
    const content = new TextEncoder().encode("multipart resume mismatch payload");
    const wrong = sha("a different payload entirely");
    const { uploadId, stagingKey } = await stage(token, wrong, content);

    const mismatch = await complete(token, wrong, uploadId);
    expect(mismatch.status).toBe(412);
    expect(await mismatch.json()).toEqual({ error: "sha_mismatch" });
    expect(await resumeState(uploadId, stagingKey)).toEqual({ upload: false, parts: 0, staging: false });
  });
});
