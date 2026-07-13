import type { Env } from "./env.js";
import { blobKey, json } from "./util.js";
import { entitledSubset, isEntitled } from "./authz.js";
import { grantEntitlementWithQuota, wouldExceedCap } from "./billing.js";
import { emitCompletePhases, startOp } from "./metrics.js";
import { mintReceipt } from "./receipts.js";
import { mintUploadGrant, verifyGrant } from "./grants.js";
import { dbFor } from "./db.js";
import { batchedInLookup } from "./d1-batch.js";
import { isDeleteFenceAbort } from "./commit-accounting.js";
import { packedLocation, readPackedExtent } from "./blob-pack.js";
import { usesReceipts } from "./blob-protocol.js";

export { UPLOAD_RECEIPTS_V1, usesReceipts } from "./blob-protocol.js";

/** §23.2 — clients on the receipts protocol send this header; PUT then becomes
 *  ~R2-only (staging write + receipt, ZERO D1). Absent → legacy per-PUT grant path
 *  (kept during the §23 rollout; removed before the atomic merge once the CLI moves). */
type DirectWriteBody = Parameters<Env["rbox_dev_blobs"]["put"]>[1];
type R2Span = <T>(fn: () => Promise<T>) => Promise<T>;

export class DirectWriteR2Error extends Error {
  constructor() {
    super("direct blob write failed");
    this.name = "DirectWriteR2Error";
  }
}

export class ReceiptFenceError extends Error {
  constructor() {
    super("receipt mint blocked by GC delete fence");
    this.name = "ReceiptFenceError";
  }
}

export async function directWriteVerified(
  env: Env,
  sha: string,
  body: DirectWriteBody,
  r2Span: R2Span,
): Promise<number> {
  try {
    const obj = await r2Span(() => env.rbox_dev_blobs.put(blobKey(sha), body, { sha256: sha }));
    return obj.size;
  } catch {
    throw new DirectWriteR2Error();
  }
}

/** One fail-closed D1 fence read for all successfully-written objects, followed
 * by receipt minting anchored to the time captured before that read. */
export async function mintFenceCheckedReceipts(
  env: Env,
  accountId: string,
  written: Array<{ sha: string; size: number }>,
): Promise<Map<string, { sizeBytes: number; receipt: string }>> {
  if (written.length === 0) return new Map();
  const checkTime = Date.now();
  const shas = [...new Set(written.map((r) => r.sha))];
  let fenced: { sha256: string } | null;
  try {
    fenced = await dbFor(env, accountId)
      .prepare("SELECT sha256 FROM gc_candidates WHERE deleting_at IS NOT NULL AND sha256 IN (SELECT value FROM json_each(?)) LIMIT 1")
      .bind(JSON.stringify(shas))
      .first<{ sha256: string }>();
  } catch {
    // Publication authority is fail-closed. The canonical bytes may remain as an
    // unpublished orphan and are safe for P2 to reap.
    throw new ReceiptFenceError();
  }
  if (fenced) throw new ReceiptFenceError();

  const out = new Map<string, { sizeBytes: number; receipt: string }>();
  await Promise.all(
    written.map(async ({ sha, size }) => {
      const receipt = await mintReceipt(env, { accountId, encSha: sha, size, nowMs: checkTime });
      out.set(sha, { sizeBytes: size, receipt });
    }),
  );
  return out;
}

export async function directWriteWithReceipt(
  env: Env,
  accountId: string,
  sha: string,
  body: DirectWriteBody,
  r2Span: R2Span,
): Promise<{ sizeBytes: number; receipt: string }> {
  const size = await directWriteVerified(env, sha, body, r2Span);
  return (await mintFenceCheckedReceipts(env, accountId, [{ sha, size }])).get(sha)!;
}

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

export function partSizeFor(size: number): number {
  let p = MIN_PART;
  if (Math.ceil(size / p) > MAX_PARTS) p = Math.ceil(size / MAX_PARTS / MiB) * MiB;
  return p;
}

// POST /v1/blobs/check — "have it" = physically present AND this account is
// entitled (M7) AND not a GC candidate (M6). An unentitled caller is always told
// "missing" → it must upload (which grants entitlement); it never learns whether
// the platform already has another account's content.
export async function blobsCheck(req: Request, env: Env, shaRe: RegExp, accountId: string): Promise<Response> {
  const op = startOp(env, "blob.check");
  const db = dbFor(op.env, accountId);
  const body = (await req.json()) as { shas?: unknown };
  const shas = Array.isArray(body.shas) ? body.shas.filter((s): s is string => typeof s === "string" && shaRe.test(s)) : [];
  const uniq = [...new Set(shas)];

  // §23.3 — receipts clients: "have it" = entitled AND canonical-present (blobs.present=1).
  // No global-existence probe, no gc_candidates (M6 resurrection is gone in §23). A ref
  // entitled-but-present=0 (an in-flight/crashed prior promote) is reported missing → the
  // client re-stages it. blob_refs is queried FIRST → no existence oracle.
  if (usesReceipts(req)) {
    const uploadGrantMint = mintUploadGrant(op.env, { accountId, nowMs: Date.now() });
    const have = new Set<string>();
    // §30: batched dispatch — the per-80-sha IN-list SELECTs run grouped in db.batch()
    // calls (one D1 subrequest per group) instead of one serial round-trip per chunk, so
    // a 4k-sha push preflight no longer costs ~50 sequential D1 hops before uploads start.
    // §33 candidate-aware check, FOLDED into the have-set query: a Phase-1 prune-marked ref
    // (`blob_ref_candidates`) is excluded from "have" by the NOT EXISTS, so it reads as missing
    // → the client re-stages it → the re-stage's commit re-grants + clears the marker. Folding
    // it in (vs a second pass) makes the barrier one query and impossible to forget.
    await batchedInLookup<{ sha256: string }>(
      db,
      uniq,
      (chunk) =>
        db
          .prepare(
            `SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
             WHERE r.account_id = ? AND b.present = 1 AND r.sha256 IN (${chunk.map(() => "?").join(",")})
               AND NOT EXISTS (SELECT 1 FROM blob_ref_candidates c WHERE c.account_id = r.account_id AND c.sha256 = r.sha256)
               AND NOT EXISTS (SELECT 1 FROM gc_candidates g WHERE g.sha256 = r.sha256 AND g.deleting_at IS NOT NULL)
               AND NOT EXISTS (
                 SELECT 1 FROM blob_locations l JOIN pack_gc_candidates pg ON pg.pack_id = l.pack_id AND pg.deleting_at IS NOT NULL
                 WHERE l.sha256 = r.sha256
               )`,
          )
          .bind(accountId, ...chunk),
      (rows) => {
        for (const row of rows) have.add(row.sha256);
      },
    );
    const missing = uniq.filter((s) => !have.has(s));
    // Empty-shas requests intentionally take this branch: §109 uses them as the
    // authenticated, dedicated upload-grant refresh transport. The mint depends
    // only on accountId, so it overlapped the D1 lookup above.
    const uploadGrant = await uploadGrantMint;
    op.done("ok", { count: uniq.length, ratio: uniq.length ? missing.length / uniq.length : 0 });
    return json(uploadGrant ? { missing, uploadGrant } : { missing });
  }

  const present = new Set<string>();
  const condemned = new Set<string>();
  // §30: batched dispatch (see the receipts branch). The two IN-list SELECTs the legacy path
  // needs (present-with-candidate-barrier, and gc_candidates) each run as their own grouped
  // db.batch() pass over `shas` — bounded memory, one D1 subrequest per group, results merged
  // by set membership exactly as the serial loop did.
  // §33 candidate-aware check (legacy path), FOLDED into the present query: a Phase-1
  // prune-marked ref (`blob_ref_candidates`) is excluded from `present` by the NOT EXISTS, so
  // it reads as missing (one query, no separate pass — the barrier can't be forgotten).
  await batchedInLookup<{ sha256: string }>(
    db,
    shas,
    (chunk) =>
      db
        .prepare(`SELECT sha256 FROM blobs WHERE sha256 IN (${chunk.map(() => "?").join(",")})
          AND NOT EXISTS (SELECT 1 FROM blob_ref_candidates c WHERE c.account_id = ? AND c.sha256 = blobs.sha256)
          AND NOT EXISTS (
            SELECT 1 FROM blob_locations l JOIN pack_gc_candidates pg ON pg.pack_id = l.pack_id AND pg.deleting_at IS NOT NULL
            WHERE l.sha256 = blobs.sha256
          )`)
        .bind(...chunk, accountId),
    (rows) => {
      for (const r of rows) present.add(r.sha256);
    },
  );
  await batchedInLookup<{ sha256: string }>(
    db,
    shas,
    (chunk) => db.prepare(`SELECT sha256 FROM gc_candidates WHERE sha256 IN (${chunk.map(() => "?").join(",")})`).bind(...chunk),
    (rows) => {
      for (const r of rows) condemned.add(r.sha256);
    },
  );
  const entitled = await entitledSubset(op.env, accountId, uniq);
  const missing = uniq.filter((s) => !present.has(s) || !entitled.has(s) || condemned.has(s));
  // `missingBlobs` is the client preflight: count + missing ratio, never raw SHAs.
  op.done("ok", { count: uniq.length, ratio: uniq.length ? missing.length / uniq.length : 0 });
  return json({ missing });
}

// PUT /v1/blobs/:sha — single streaming PUT, R2 verifies the content hash.
// Possessing+uploading the bytes is what grants this account read access (M7).
export async function blobPut(req: Request, env: Env, sha: string, accountId: string): Promise<Response> {
  const op = startOp(env, "blob.put");
  const len = Number(req.headers.get("content-length") ?? "0");
  if (len > SINGLE_PUT_MAX) return json({ error: "too_large", message: "use multipart", maxSingle: SINGLE_PUT_MAX }, 413);
  if (!req.body) return json({ error: "bad_request", message: "missing body" }, 400);

  // Fail-fast over-cap (design 13 G4): refuse BEFORE writing R2 so a downgraded /
  // over-cap account can't stage orphan bytes. The finalize grant stays authoritative.
  // §33: wouldExceedCap is entitlement-aware — a re-upload forced by the candidate-aware
  // "missing" (a prune-marked but still-owned ref) charges 0 at grant, so it returns over:false
  // for an already-entitled sha, letting an at/over-cap account re-establish + un-mark a ref it
  // already paid for. The grant's cap-guard trigger is the authoritative gate.
  const pre = await wouldExceedCap(op.env, accountId, sha, len);
  if (pre.over) {
    op.done("quota_exceeded", { bytes: len });
    return json({ error: "quota_exceeded", used: pre.used, cap: pre.cap, ...(pre.reason ? { reason: pre.reason } : {}) }, 402);
  }

  // §23.2 (v2, direct-write) — receipts protocol: R2-dominant. Write the CANONICAL blob key
  // directly (R2 verifies the sha) + return a receipt minted only after R2 accepts. After
  // the quota precheck above, this does no blobs/blob_refs/used_bytes/gc_candidates writes.
  // Accounting (charge + grant + present=1) moves to commit (§23.4) as a pure D1 batch — NO staging→canonical
  // promote. Dropping the promote removes the serial O(N) commit phase that made §23 regress
  // at scale (measured: 2000-file promote = 19s). Single-user reality makes the canonical-
  // orphan concern moot; fenced canonical GC cannot race a direct PUT (codex scaling
  // review). This removes the §25-measured 7-D1-call PUT plateau.
  if (usesReceipts(req)) {
    let written: { sizeBytes: number; receipt: string };
    try {
      written = await directWriteWithReceipt(op.env, accountId, sha, req.body!, op.span.r2.bind(op.span));
    } catch (e) {
      if (e instanceof ReceiptFenceError) {
        op.done("retry_later", { bytes: len });
        return json({ error: "retry_later" }, 503);
      }
      if (!(e instanceof DirectWriteR2Error)) throw e;
      op.done("sha_mismatch", { bytes: len });
      return json({ error: "sha_mismatch" }, 400);
    }
    op.done("ok", { bytes: written.sizeBytes });
    return json({ ok: true, sha256: sha, ...written });
  }

  let obj: R2Object;
  try {
    obj = await op.span.r2(() => env.rbox_dev_blobs.put(blobKey(sha), req.body!, { sha256: sha }));
  } catch {
    op.done("sha_mismatch", { bytes: len });
    return json({ error: "sha_mismatch" }, 400); // no raw R2 message (privacy)
  }
  try {
    await dbFor(op.env, accountId).prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes, present) VALUES (?, ?, 1)").bind(sha, obj.size).run();
  } catch (e) {
    if (isDeleteFenceAbort(e)) {
      op.done("retry_later", { bytes: obj.size });
      return json({ error: "retry_later" }, 503);
    }
    throw e;
  }
  let grant: Awaited<ReturnType<typeof grantEntitlementWithQuota>>;
  try {
    grant = await grantEntitlementWithQuota(op.env, accountId, sha, obj.size); // verified upload → quota-checked read access
  } catch (e) {
    if (isDeleteFenceAbort(e)) {
      op.done("retry_later", { bytes: obj.size });
      return json({ error: "retry_later" }, 503);
    }
    throw e;
  }
  if (!grant.granted) {
    op.done("quota_exceeded", { bytes: obj.size });
    return json({ error: "quota_exceeded", used: grant.used, cap: grant.cap, ...(grant.reason ? { reason: grant.reason } : {}) }, 402);
  }
  op.done("ok", { bytes: obj.size });
  return json({ ok: true, sha256: sha, sizeBytes: obj.size });
}

// GET /v1/blobs/:sha — streamed body. Entitlement checked BEFORE R2 (no timing/
// existence oracle); an unentitled account gets 404 even if the blob exists (M7).
//
// §27 v1 — on the authenticated fallback path, a valid download grant (HMAC,
// account-bound, unexpired) still authorizes the read WITHOUT the per-blob D1
// `isEntitled` read. Amendment A's worker-level pre-auth path handles the common
// valid-grant case before authenticate(); this function remains the legacy fallback for
// absent/invalid/expired grants and for direct callers. `blobGet` never 500s on a bad
// grant: an invalid grant is treated exactly like no grant.
export async function blobGet(env: Env, sha: string, accountId: string, grant?: string): Promise<Response> {
  const op = startOp(env, "blob.get");
  const notFound = (outcome = "not_found") => {
    op.done(outcome);
    return json({ error: "not_found" }, 404);
  };
  const granted = grant ? (await verifyGrant(op.env, grant, { accountId, nowMs: Date.now() })).ok : false;
  // No valid grant → the legacy D1 entitlement gate (BEFORE R2, no existence oracle).
  if (!granted && !(await isEntitled(op.env, accountId, sha))) return notFound();
  const loc = await packedLocation(dbFor(op.env, accountId), sha);
  if (loc) {
    const bytes = await readPackedExtent(op, op.env, sha, loc);
    if (!bytes) return notFound("pack_extent_error");
    op.done("ok", { bytes: bytes.byteLength });
    return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
  }
  const got = await op.span.r2(() => env.rbox_dev_blobs.get(blobKey(sha)));
  if (!got) return notFound();
  op.done("ok", { bytes: got.size });
  return new Response(got.body, { headers: { "content-type": "application/octet-stream" } });
}

// §27 Amendment A — grant-only pre-auth blob GET. The worker calls this only after
// `verifyGrantCredential()` has authenticated the HMAC, TTL, and signed account id.
// The verified grant remains the narrow read credential and skips the entitlement
// query. Design 114 deliberately adds the post-authorization placement lookup.
export async function blobGetWithVerifiedGrant(env: Env, sha: string, accountId: string): Promise<Response> {
  const op = startOp(env, "blob.get");
  const notFound = (outcome = "not_found_grant_preauth") => {
    op.done(outcome);
    return json({ error: "not_found" }, 404);
  };
  const loc = await packedLocation(dbFor(op.env, accountId), sha);
  if (loc) {
    const bytes = await readPackedExtent(op, op.env, sha, loc);
    if (!bytes) return notFound("pack_extent_error");
    op.done("ok_grant_preauth", { bytes: bytes.byteLength });
    return new Response(bytes, { headers: { "content-type": "application/octet-stream" } });
  }
  const got = await op.span.r2(() => env.rbox_dev_blobs.get(blobKey(sha)));
  if (!got) return notFound();
  op.done("ok_grant_preauth", { bytes: got.size });
  return new Response(got.body, { headers: { "content-type": "application/octet-stream" } });
}

// POST /v1/blobs/:sha/multipart  { size } -> { uploadId, partSize, totalParts }
export async function multipartInit(req: Request, env: Env, sha: string, accountId: string): Promise<Response> {
  const op = startOp(env, "multipart.init");
  const db = dbFor(op.env, accountId);
  const body = (await req.json()) as { size?: number };
  const size = Number(body.size ?? 0);
  if (!Number.isInteger(size) || size <= 0) return json({ error: "bad_request", message: "missing size" }, 400);
  // Fail-fast over-cap before staging any multipart parts (design 13 G4). §33: wouldExceedCap
  // is entitlement-aware — a re-upload forced by the candidate-aware "missing" charges 0 at the
  // multipartComplete grant, so it returns over:false for an already-entitled sha, letting an
  // at/over-cap account re-establish + un-mark its own prune-marked ref.
  const pre = await wouldExceedCap(op.env, accountId, sha, size);
  if (pre.over) {
    op.done("quota_exceeded", { bytes: size });
    return json({ error: "quota_exceeded", used: pre.used, cap: pre.cap, ...(pre.reason ? { reason: pre.reason } : {}) }, 402);
  }

  // Best-effort GC of our own expired upload state.
  await db.prepare("DELETE FROM uploads WHERE created_at < ?").bind(Date.now() - UPLOAD_EXPIRY_MS).run().catch(() => {});

  const partSize = partSizeFor(size);
  const totalParts = Math.ceil(size / partSize);
  const stagingKey = `staging/${sha}/${crypto.randomUUID()}`;
  const mpu = await op.span.r2(() => env.rbox_dev_blobs.createMultipartUpload(stagingKey));
  await db
    .prepare("INSERT INTO uploads (upload_id, sha256, staging_key, part_size, total_parts, size, created_at, account_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(mpu.uploadId, sha, stagingKey, partSize, totalParts, size, Date.now(), accountId)
    .run();
  op.done("ok", { bytes: size });
  return json({ uploadId: mpu.uploadId, partSize, totalParts });
}

interface UploadRow {
  staging_key: string;
  part_size: number;
  total_parts: number;
  size: number;
  created_at: number;
  account_id: string | null;
}
/** Load an upload, scoped to the caller's account — a leaked uploadId from
 *  another account returns null (can't be completed cross-account). */
function loadUpload(env: Env, sha: string, uploadId: string, accountId: string): Promise<UploadRow | null> {
  return dbFor(env, accountId)
    .prepare("SELECT staging_key, part_size, total_parts, size, created_at, account_id FROM uploads WHERE upload_id = ? AND sha256 = ? AND account_id = ?")
    .bind(uploadId, sha, accountId)
    .first<UploadRow>();
}
const expired = (row: UploadRow) => Date.now() - row.created_at > UPLOAD_EXPIRY_MS;

// GET /v1/blobs/:sha/multipart/:uploadId -> resumable state
export async function multipartStatus(env: Env, sha: string, uploadId: string, accountId: string): Promise<Response> {
  const up = await loadUpload(env, sha, uploadId, accountId);
  if (!up) return json({ error: "unknown_upload" }, 404);
  if (expired(up)) {
    await cleanupUpload(env, accountId, uploadId);
    return json({ error: "upload_expired" }, 410);
  }
  const rows = await dbFor(env, accountId)
    .prepare("SELECT part_number FROM upload_parts WHERE upload_id = ? ORDER BY part_number")
    .bind(uploadId)
    .all<{ part_number: number }>();
  return json({ uploadId, partSize: up.part_size, totalParts: up.total_parts, completedParts: (rows.results ?? []).map((r) => r.part_number) });
}

// PUT /v1/blobs/:sha/multipart/:uploadId/part/:n
export async function multipartPart(req: Request, env: Env, sha: string, uploadId: string, n: number, accountId: string): Promise<Response> {
  if (!req.body) return json({ error: "bad_request", message: "missing body" }, 400);
  if (!Number.isInteger(n) || n < 1) return json({ error: "bad_request", message: "bad part number" }, 400);
  const op = startOp(env, "multipart.part");
  const up = await loadUpload(op.env, sha, uploadId, accountId);
  if (!up) return json({ error: "unknown_upload" }, 404);
  if (expired(up)) {
    await cleanupUpload(op.env, accountId, uploadId);
    return json({ error: "upload_expired" }, 410);
  }
  const len = Number(req.headers.get("content-length") ?? "0");
  let part: R2UploadedPart;
  try {
    const mpu = env.rbox_dev_blobs.resumeMultipartUpload(up.staging_key, uploadId);
    part = await op.span.r2(() => mpu.uploadPart(n, req.body!));
  } catch {
    // R2 MPU gone (expired/aborted) — tell the client to re-init. (No raw message:
    // privacy; the elapsed R2 time is still recorded via span.r2's try/finally.)
    await cleanupUpload(op.env, accountId, uploadId);
    op.done("upload_expired", { bytes: len });
    return json({ error: "upload_expired" }, 410);
  }
  await dbFor(op.env, accountId)
    .prepare("INSERT OR REPLACE INTO upload_parts (upload_id, part_number, etag, size) VALUES (?, ?, ?, ?)")
    .bind(uploadId, n, part.etag, len)
    .run();
  op.done("ok", { bytes: len });
  return json({ partNumber: part.partNumber, etag: part.etag });
}

// POST /v1/blobs/:sha/multipart/:uploadId/complete
export async function multipartComplete(env: Env, sha: string, uploadId: string, accountId: string): Promise<Response> {
  const t0 = Date.now();
  // One data point, emitted in `finally` so `ms` covers the WHOLE op including the
  // always-run R2 delete + D1 cleanup (which run before the response is returned).
  // dbMs/storeMs accumulate across each phase so the dashboard's R2-vs-D1 split is real.
  const op = startOp(env, "multipart.complete"); // span accumulates D1 (incl. helpers) + R2 across every phase, even on throw
  let outcome = "error"; // default ⇒ an UNEXPECTED throw is recorded as "error", not "ok"
  let bytes = 0;
  let count = 0;
  let totalMs = 0;
  let assembleMs = 0;
  let rereadPutMs = 0;
  let accountingMs = 0;
  let cleanupMs = 0;
  const up = await loadUpload(op.env, sha, uploadId, accountId);
  if (!up) return json({ error: "unknown_upload" }, 404); // pre-op: not worth a metric

  const sel = await dbFor(op.env, accountId)
    .prepare("SELECT part_number, etag FROM upload_parts WHERE upload_id = ? ORDER BY part_number")
    .bind(uploadId)
    .all<{ part_number: number; etag: string }>();
  const parts = (sel.results ?? []).map((r) => ({ partNumber: r.part_number, etag: r.etag }));
  count = parts.length;
  // Short upload: return BEFORE the consume-and-cleanup try so the MPU stays
  // resumable (the client can upload the rest and retry). No staging delete here.
  if (parts.length !== up.total_parts) {
    op.done("missing_parts", { count });
    return json({ error: "missing_parts", have: parts.length, want: up.total_parts }, 422);
  }

  try {
    // From here the MPU is consumed: assemble staging, publish→canonical with R2 verify.
    const mpu = env.rbox_dev_blobs.resumeMultipartUpload(up.staging_key, uploadId);
    const assembleStart = Date.now();
    await op.span.r2(() => mpu.complete(parts)); // composite etag is NOT the content hash — only for assembly
    assembleMs = Math.max(0, Math.round(Date.now() - assembleStart));
    const rereadPutStart = Date.now();
    const staged = await op.span.r2(() => env.rbox_dev_blobs.get(up.staging_key));
    if (!staged || !staged.body) {
      outcome = "staged_missing";
      return json({ error: "staged_missing" }, 500);
    }
    bytes = staged.size; // charge/record the ACTUAL bytes, not the declared size (M7b)
    try {
      // Publish to canonical; R2 verifies the whole-object sha server-side.
      await op.span.r2(() => env.rbox_dev_blobs.put(blobKey(sha), staged.body!, { sha256: sha }));
      rereadPutMs = Math.max(0, Math.round(Date.now() - rereadPutStart));
    } catch {
      outcome = "sha_mismatch";
      return json({ error: "sha_mismatch" }, 412); // no raw message (privacy)
    }
    const accountingStart = Date.now();
    try {
      await dbFor(op.env, accountId).prepare("INSERT OR IGNORE INTO blobs (sha256, size_bytes, present) VALUES (?, ?, 1)").bind(sha, bytes).run();
    } catch (e) {
      if (isDeleteFenceAbort(e)) {
        outcome = "retry_later";
        return json({ error: "retry_later" }, 503);
      }
      throw e;
    }
    let grant: Awaited<ReturnType<typeof grantEntitlementWithQuota>>;
    try {
      grant = await grantEntitlementWithQuota(op.env, accountId, sha, bytes);
    } catch (e) {
      if (isDeleteFenceAbort(e)) {
        outcome = "retry_later";
        return json({ error: "retry_later" }, 503);
      }
      throw e;
    }
    if (!grant.granted) {
      outcome = "quota_exceeded";
      return json({ error: "quota_exceeded", used: grant.used, cap: grant.cap, ...(grant.reason ? { reason: grant.reason } : {}) }, 402);
    }
    accountingMs = Math.max(0, Math.round(Date.now() - accountingStart));
    outcome = "ok";
    totalMs = Math.max(0, Math.round(Date.now() - t0));
    return json({ ok: true, sha256: sha, sizeBytes: bytes, serverTimings: { totalMs, assembleMs, rereadPutMs, accountingMs } });
  } finally {
    const cleanupStart = Date.now();
    await op.span.r2(() => env.rbox_dev_blobs.delete(up.staging_key).catch(() => {}));
    await cleanupUpload(op.env, accountId, uploadId);
    cleanupMs = Math.max(0, Math.round(Date.now() - cleanupStart));
    op.done(outcome, { bytes, count });
    emitCompletePhases(env, outcome, { totalMs, assembleMs, rereadPutMs, cleanupMs });
  }
}

async function cleanupUpload(env: Env, accountId: string, uploadId: string): Promise<void> {
  await dbFor(env, accountId).prepare("DELETE FROM upload_parts WHERE upload_id = ?").bind(uploadId).run();
  await dbFor(env, accountId).prepare("DELETE FROM uploads WHERE upload_id = ?").bind(uploadId).run();
}
