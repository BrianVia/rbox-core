import type { Env } from "./env.js";
import { json, logErr } from "./util.js";
import { dbFor } from "./db.js";
import { batchedInLookup } from "./d1-batch.js";
import { startOp } from "./metrics.js";
import { readState, writeState } from "./gc-state.js";
import { metric } from "./gc-observability.js";

/** Age floor before a handle-less `staging/` object may be reclaimed. `blobs.ts` expires an
 *  `uploads` row at 6 days (UPLOAD_EXPIRY_MS), deliberately INSIDE R2's 7-day multipart TTL,
 *  so every upload a client can still resume has BOTH a row younger than 6 days AND an MPU
 *  R2 has not yet abandoned. 7 days sits strictly outside that window. The age check and the
 *  row check are INDEPENDENT conditions, so neither clock skew nor a stale list page can
 *  reap a live upload on its own. */
export const STAGING_ORPHAN_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const STAGING_SWEEP_PAGE = 1000; // one bounded R2 list page per tick, as gcMark does
const STAGING_PREFIX = "staging/";
const STAGING_DELETE_CHUNK = 100; // R2 batch-delete cap is 1000; 100 keeps a full page ≤10 subrequests

interface StagingCursor {
  cursor?: string;
}
/**
 * Reclaimer for orphaned `staging/` objects — nothing else in the system reclaims that
 * prefix. R2's own 7-day TTL abandons INCOMPLETE multipart uploads, but once `mpu.complete()`
 * has run the staging key is an ordinary object with no TTL, and its only handle is the
 * `uploads.staging_key` row that `multipartComplete`'s terminal cleanup drops. A staging
 * object whose row is gone can never be resumed, completed, read, or deleted by any other
 * code path: `gcMark` rotates only `blobs/sha256/` + `manifests/sha256/`, and
 * `multipart-inventory.ts` lists this prefix READ-ONLY, for observability.
 *
 * Its OWN bounded sweep rather than a third `mark_cursor` prefix: gcMark's rotation feeds
 * `gc_candidates`, keyed by the sha parsed out of the object key and gated on DO
 * reachability. A staging key (`staging/<sha>/<uuid>`) parses to a uuid, is never part of
 * the reachable set, and is live purely by D1 row presence — folding it into that cursor
 * would put two unrelated liveness models behind one piece of state.
 *
 * FAIL CLOSED, mirroring `purgeUploadR2`'s ordering argument (account-delete.ts): a listable
 * staging object means its MPU is already consumed, so there is nothing to abort, and its
 * absent `uploads` row is precisely what makes it an orphan, so there is no D1 handle left to
 * drop after the delete. That leaves the liveness read as the only fence, and a throwing read
 * reclaims NOTHING — the throw leaves `staging_cursor` unmoved and the page is re-swept.
 */
export async function gcStagingSweep(env: Env, nowMs: number = Date.now()): Promise<Response> {
  const op = startOp(env, "gc.staging");
  const db = dbFor(op.env, "");
  const saved = await readState<StagingCursor>(db, "staging_cursor");
  const listed = await op.span.r2(() => env.rbox_dev_blobs.list({ prefix: STAGING_PREFIX, cursor: saved?.cursor, limit: STAGING_SWEEP_PAGE }));
  const aged = listed.objects.filter((o) => nowMs - o.uploaded.getTime() >= STAGING_ORPHAN_MIN_AGE_MS).map((o) => o.key);
  // `uploads` holds only in-flight uploads (bounded by the 6-day expiry), so this IN-list
  // scan stays cheap even though `staging_key` carries no index.
  const live = new Set<string>();
  await batchedInLookup<{ staging_key: string }>(
    db,
    aged,
    (chunk) => db.prepare(`SELECT staging_key FROM uploads WHERE staging_key IN (${chunk.map(() => "?").join(",")})`).bind(...chunk),
    (rows) => {
      for (const r of rows) live.add(r.staging_key);
    },
  );
  const orphans = aged.filter((key) => !live.has(key));
  let deleted = 0;
  for (let i = 0; i < orphans.length; i += STAGING_DELETE_CHUNK) {
    const chunk = orphans.slice(i, i + STAGING_DELETE_CHUNK);
    try {
      await op.span.r2(() => env.rbox_dev_blobs.delete(chunk));
      deleted += chunk.length;
    } catch (e) {
      logErr("gc_staging_delete_failed", e); // transient → the next full rotation re-lists it
    }
  }
  const next: StagingCursor = listed.truncated ? { cursor: listed.cursor } : {};
  await writeState(db, "staging_cursor", next);
  op.done("ok", { count: deleted });
  metric(env, "gc.staging.reclaimed", deleted);
  return json({ scanned: listed.objects.length, orphans: orphans.length, deleted, cursor: next.cursor ?? null });
}
