import type { Env } from "./env.js";

/**
 * Blob endpoints (M3): streaming single-PUT with R2-native integrity, and
 * resumable R2 multipart for files past Cloudflare's request-body cap.
 *
 * Multipart assembles into a per-upload STAGING key and is published to the
 * canonical blob key only via `put(..., { sha256 })`, so R2 verifies the hash on
 * publish and the canonical object is NEVER written with unverified bytes nor
 * deleted by a losing/bad upload (codex review fixes).
 */

const MiB = 1024 * 1024;
const SINGLE_PUT_MAX = 90 * MiB; // margin under CF's ~100MB request-body cap → multipart above
const MIN_PART = 8 * MiB; // ≥ R2's 5 MiB minimum non-final part
const MAX_PARTS = 9000; // margin under R2's 10,000 hard cap
const UPLOAD_EXPIRY_MS = 6 * 24 * 60 * 60 * 1000; // expire our state before R2's 7-day MPU TTL

function blobKey(sha: string): string {
  return `blobs/sha256/${sha.slice(0, 2)}/${sha}`;
}
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function partSizeFor(size: number): number {
  let p = MIN_PART;
  if (Math.ceil(size / p) > MAX_PARTS) p = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  return p;
}

// POST /v1/blobs/check
export async function blobsCheck(req: Request, env: Env, shaRe: RegExp): Promise<Response> {
  const body = (await req.json()) as { shas?: unknown };
  const shas = Array.isArray(body.shas) ? body.shas.filter((s): s is string => typeof s === "string" && shaRe.test(s)) : [];
  const present = new Set<string>();
  for (let i = 0; i < shas.length; i += 80) {
    const chunk = shas.slice(i, i + 80);
    if (chunk.length === 0) break;
    const rows = await env.rbox_dev_db
      .prepare(`SELECT sha256 FROM blobs WHERE sha256 IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .all<{ sha256: string }>();
    for (const r of rows.results ?? []) present.add(r.sha256);
  }
  return json({ missing: [...new Set(shas)].filter((s) => !present.has(s)) });
}

// PUT /v1/blobs/:sha — single streaming PUT, R2 verifies the content hash.
export async function blobPut(req: Request, env: Env, sha: string): Promise<Response> {
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > SINGLE_PUT_MAX) return json({ error: "too_large", message: "use multipart", maxSingle: SINGLE_PUT_MAX }, 413);
  if (!req.body) return json({ error: "bad_request", message: "missing body" }, 400);
  let obj: R2Object;
  try {
    obj = await env.rbox_dev_blobs.put(blobKey(sha), req.body, { sha256: sha });
  } catch (e) {
    return json({ error: "sha_mismatch", message: String((e as Error)?.message ?? e) }, 400);
  }
  await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes) VALUES (?, ?)").bind(sha, obj.size).run();
  return json({ ok: true, sha256: sha, sizeBytes: obj.size });
}

// GET /v1/blobs/:sha — streamed body.
export async function blobGet(env: Env, sha: string): Promise<Response> {
  const obj = await env.rbox_dev_blobs.get(blobKey(sha));
  if (!obj) return json({ error: "not_found" }, 404);
  return new Response(obj.body, { headers: { "content-type": "application/octet-stream" } });
}

// POST /v1/blobs/:sha/multipart  { size } -> { uploadId, partSize, totalParts }
export async function multipartInit(req: Request, env: Env, sha: string): Promise<Response> {
  const body = (await req.json()) as { size?: number };
  const size = Number(body.size ?? 0);
  if (!Number.isInteger(size) || size <= 0) return json({ error: "bad_request", message: "missing size" }, 400);

  // Best-effort GC of our own expired upload state.
  await env.rbox_dev_db.prepare("DELETE FROM uploads WHERE created_at < ?").bind(Date.now() - UPLOAD_EXPIRY_MS).run().catch(() => {});

  const partSize = partSizeFor(size);
  const totalParts = Math.ceil(size / partSize);
  const stagingKey = `staging/${sha}/${crypto.randomUUID()}`;
  const mpu = await env.rbox_dev_blobs.createMultipartUpload(stagingKey);
  await env.rbox_dev_db
    .prepare("INSERT INTO uploads (upload_id, sha256, staging_key, part_size, total_parts, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(mpu.uploadId, sha, stagingKey, partSize, totalParts, size, Date.now())
    .run();
  return json({ uploadId: mpu.uploadId, partSize, totalParts });
}

interface UploadRow {
  staging_key: string;
  part_size: number;
  total_parts: number;
  size: number;
  created_at: number;
}
function loadUpload(env: Env, sha: string, uploadId: string): Promise<UploadRow | null> {
  return env.rbox_dev_db
    .prepare("SELECT staging_key, part_size, total_parts, size, created_at FROM uploads WHERE upload_id = ? AND sha256 = ?")
    .bind(uploadId, sha)
    .first<UploadRow>();
}
const expired = (row: UploadRow) => Date.now() - row.created_at > UPLOAD_EXPIRY_MS;

// GET /v1/blobs/:sha/multipart/:uploadId -> resumable state
export async function multipartStatus(env: Env, sha: string, uploadId: string): Promise<Response> {
  const up = await loadUpload(env, sha, uploadId);
  if (!up) return json({ error: "unknown_upload" }, 404);
  if (expired(up)) {
    await cleanupUpload(env, uploadId);
    return json({ error: "upload_expired" }, 410);
  }
  const rows = await env.rbox_dev_db
    .prepare("SELECT part_number FROM upload_parts WHERE upload_id = ? ORDER BY part_number")
    .bind(uploadId)
    .all<{ part_number: number }>();
  return json({ uploadId, partSize: up.part_size, totalParts: up.total_parts, completedParts: (rows.results ?? []).map((r) => r.part_number) });
}

// PUT /v1/blobs/:sha/multipart/:uploadId/part/:n
export async function multipartPart(req: Request, env: Env, sha: string, uploadId: string, n: number): Promise<Response> {
  if (!req.body) return json({ error: "bad_request", message: "missing body" }, 400);
  if (!Number.isInteger(n) || n < 1) return json({ error: "bad_request", message: "bad part number" }, 400);
  const up = await loadUpload(env, sha, uploadId);
  if (!up) return json({ error: "unknown_upload" }, 404);
  if (expired(up)) {
    await cleanupUpload(env, uploadId);
    return json({ error: "upload_expired" }, 410);
  }
  let part: R2UploadedPart;
  try {
    const mpu = env.rbox_dev_blobs.resumeMultipartUpload(up.staging_key, uploadId);
    part = await mpu.uploadPart(n, req.body);
  } catch (e) {
    // R2 MPU gone (expired/aborted) — tell the client to re-init.
    await cleanupUpload(env, uploadId);
    return json({ error: "upload_expired", message: String((e as Error)?.message ?? e) }, 410);
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  await env.rbox_dev_db
    .prepare("INSERT OR REPLACE INTO upload_parts (upload_id, part_number, etag, size) VALUES (?, ?, ?, ?)")
    .bind(uploadId, n, part.etag, len)
    .run();
  return json({ partNumber: part.partNumber, etag: part.etag });
}

// POST /v1/blobs/:sha/multipart/:uploadId/complete
export async function multipartComplete(env: Env, sha: string, uploadId: string): Promise<Response> {
  const up = await loadUpload(env, sha, uploadId);
  if (!up) return json({ error: "unknown_upload" }, 404);

  const rows = await env.rbox_dev_db
    .prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ? ORDER BY part_number")
    .bind(uploadId)
    .all<{ part_number: number; etag: string }>();
  const parts = (rows.results ?? []).map((r) => ({ partNumber: r.part_number, etag: r.etag }));
  if (parts.length !== up.total_parts) return json({ error: "missing_parts", have: parts.length, want: up.total_parts }, 422);

  // From here the MPU is consumed: assemble staging, publish→canonical with R2
  // verify, and ALWAYS clean up (a completed MPU can't be retried).
  try {
    const mpu = env.rbox_dev_blobs.resumeMultipartUpload(up.staging_key, uploadId);
    await mpu.complete(parts); // composite etag is NOT the content hash — only for assembly
    const staged = await env.rbox_dev_blobs.get(up.staging_key);
    if (!staged || !staged.body) return json({ error: "staged_missing" }, 500);
    try {
      // Publish to canonical; R2 verifies the whole-object sha server-side.
      await env.rbox_dev_blobs.put(blobKey(sha), staged.body, { sha256: sha });
    } catch (e) {
      return json({ error: "sha_mismatch", message: String((e as Error)?.message ?? e) }, 412);
    }
    await env.rbox_dev_db.prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes) VALUES (?, ?)").bind(sha, up.size).run();
    return json({ ok: true, sha256: sha, sizeBytes: up.size });
  } finally {
    await env.rbox_dev_blobs.delete(up.staging_key).catch(() => {});
    await cleanupUpload(env, uploadId);
  }
}

async function cleanupUpload(env: Env, uploadId: string): Promise<void> {
  await env.rbox_dev_db.prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(uploadId).run();
  await env.rbox_dev_db.prepare("DELETE FROM uploads WHERE upload_id = ?").bind(uploadId).run();
}
