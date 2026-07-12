import type { Env } from "./env.js";
import { dbFor } from "./db.js";
import { json } from "./util.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;
const LABELS = ["<1h", "1h-24h", "24h-7d", ">7d"] as const;

function bucketIndex(ageMs: number): number {
  if (ageMs < HOUR_MS) return 0;
  if (ageMs < DAY_MS) return 1;
  if (ageMs <= WEEK_MS) return 2;
  return 3;
}

/** Read-only, cross-account inventory of incomplete multipart state. */
export async function multipartInventory(env: Env, nowMs: number): Promise<Response> {
  const db = dbFor(env, "");
  // The two D1 reads are independent — issue them concurrently.
  const [uploads, parts] = await Promise.all([
    db.prepare("SELECT upload_id, size, created_at FROM uploads LIMIT 100000").all<{ upload_id: string; size: number; created_at: number }>(),
    db.prepare("SELECT upload_id, SUM(size) AS staged FROM upload_parts GROUP BY upload_id").all<{ upload_id: string; staged: number }>(),
  ]);
  const stagedByUpload = new Map((parts.results ?? []).map((row) => [row.upload_id, Number(row.staged) || 0]));
  const uploadBuckets = LABELS.map((label) => ({ label, count: 0, declaredBytes: 0, stagedBytes: 0 }));
  const incompleteTotal = { count: 0, declaredBytes: 0, stagedBytes: 0 };
  for (const upload of uploads.results ?? []) {
    const bucket = uploadBuckets[bucketIndex(nowMs - Number(upload.created_at))]!;
    const declared = Number(upload.size) || 0;
    const staged = stagedByUpload.get(upload.upload_id) ?? 0;
    bucket.count++;
    bucket.declaredBytes += declared;
    bucket.stagedBytes += staged;
    incompleteTotal.count++;
    incompleteTotal.declaredBytes += declared;
    incompleteTotal.stagedBytes += staged;
  }

  const objectBuckets = LABELS.map((label) => ({ label, count: 0, bytes: 0 }));
  const objectTotal = { count: 0, bytes: 0 };
  let cursor: string | undefined;
  let truncated = false;
  const maxPages = 50;
  for (let page = 0; page < maxPages; page++) {
    const listed = await env.rbox_dev_blobs.list({ prefix: "staging/", cursor, limit: 1000 });
    for (const object of listed.objects) {
      const bucket = objectBuckets[bucketIndex(nowMs - object.uploaded.getTime())]!;
      bucket.count++;
      bucket.bytes += object.size;
      objectTotal.count++;
      objectTotal.bytes += object.size;
    }
    if (!listed.truncated) {
      cursor = undefined;
      break;
    }
    cursor = listed.cursor;
    if (page === maxPages - 1) truncated = true;
  }

  return json({
    nowMs,
    incompleteUploads: { buckets: uploadBuckets, total: incompleteTotal },
    stagingObjects: { buckets: objectBuckets, total: objectTotal, truncated },
  });
}
