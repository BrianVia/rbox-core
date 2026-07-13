import type { Env } from "./env.js";
import {
  PACK_CONTENT_TYPE,
  PACK_ID_RE,
  PACK_MAX_BODY_BYTES,
  type PackDirEntry,
  parsePack,
} from "../../../src/engine/blob-pack.js";
import { readBytesCapped } from "./commit-envelope.js";
import { wouldExceedCapAggregate } from "./billing.js";
import { dbFor } from "./db.js";
import { batchedInLookup } from "./d1-batch.js";
import { emit, startOp, type Op } from "./metrics.js";
import { mintReceipt } from "./receipts.js";
import { usesReceipts } from "./blob-protocol.js";
import { json, logErr, SHA256_HEX_RE, sha256Hex, toHex } from "./util.js";

export const PACK_ORPHAN_GRACE_MS = 13 * 3600_000;
const INVENTORY_ROWS_PER_STATEMENT = 24; // 24*4 + 2 = 98 bound params, under D1's 100
const UPLOADING_SWEEP_PAGE = 50;
const TOMBSTONE_SWEEP_PAGE = 100;
const TOMBSTONE_CURSOR_KEY = "pack_tombstone_cursor";

/** Design 114 "version skew": the release that first ships this reader +
 * receipt-v2 verification is the PACK ROLLBACK FLOOR. Record the deployed
 * Workers version id here and in docs/STATUS.md after the first production
 * deploy; once pack acceptance has ever been enabled in an environment,
 * builds below the floor are not rollback targets (packed data unreadable,
 * v2 receipts unverifiable). The pinned rollback drill lives in the PR body
 * for this change and in the design doc's rollout section. */
export const PACK_ROLLBACK_FLOOR = "unset — record the first deployed Workers version id containing this reader";

export const packKey = (packId: string): string => `packs/v1/${packId}`;
export const packAcceptEnabled = (env: Env): boolean => env.RBOX_BLOB_PACK_ACCEPT === "1";
export const packGcEnabled = (env: Env): boolean => env.RBOX_BLOB_PACK_GC === "1";

export interface PackedLocation {
  pack_id: string;
  offset: number;
  length: number;
}

export interface PackPlacement {
  packId: string;
  offset: number;
  length: number;
  packSha256: string;
}

export async function packedLocation(db: D1Database, sha: string): Promise<PackedLocation | null> {
  return db
    .prepare("SELECT pack_id, offset, length FROM blob_locations WHERE sha256 = ?")
    .bind(sha)
    .first<PackedLocation>();
}

export async function packedLocations(db: D1Database, shas: string[]): Promise<Map<string, PackedLocation>> {
  const out = new Map<string, PackedLocation>();
  await batchedInLookup<PackedLocation & { sha256: string }>(
    db,
    shas,
    (chunk) =>
      db
        .prepare(`SELECT sha256, pack_id, offset, length FROM blob_locations WHERE sha256 IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk),
    (rows) => {
      for (const row of rows) out.set(row.sha256, { pack_id: row.pack_id, offset: Number(row.offset), length: Number(row.length) });
    },
  );
  return out;
}

/** Resolve authenticated pack intent through immutable, ready inventory. */
export async function resolvePackPlacements(
  db: D1Database,
  wanted: Array<{ sha: string; packId: string }>,
): Promise<Map<string, PackPlacement>> {
  const byPack = new Map<string, string[]>();
  for (const { sha, packId } of wanted) {
    const shas = byPack.get(packId);
    if (shas) shas.push(sha);
    else byPack.set(packId, [sha]);
  }
  const out = new Map<string, PackPlacement>();
  const statements: D1PreparedStatement[] = [];
  for (const [packId, shas] of byPack) {
    for (let i = 0; i < shas.length; i += 80) {
      const chunk = shas.slice(i, i + 80);
      statements.push(
        db
          .prepare(
            `SELECT m.sha256, m.offset, m.length, p.pack_sha256, m.pack_id
             FROM pack_members m JOIN packs p ON p.pack_id = m.pack_id
             WHERE m.pack_id = ? AND p.state = 'ready' AND m.sha256 IN (${chunk.map(() => "?").join(",")})`,
          )
          .bind(packId, ...chunk),
      );
    }
  }
  // Match d1-batch's bounded statement groups while allowing chunks for many
  // different packs to share one D1 subrequest.
  for (let i = 0; i < statements.length; i += 34) {
    const results = await db.batch<{ sha256: string; offset: number; length: number; pack_sha256: string; pack_id: string }>(statements.slice(i, i + 34));
    for (const result of results) {
      for (const row of result.results ?? []) {
          out.set(row.sha256, {
            packId: row.pack_id,
            offset: Number(row.offset),
            length: Number(row.length),
            packSha256: row.pack_sha256,
          });
      }
    }
  }
  return out;
}

export async function readPackedExtent(op: Op, env: Env, sha: string, loc: PackedLocation): Promise<Uint8Array | null> {
  try {
    const object = await op.span.r2(() =>
      env.rbox_dev_blobs.get(packKey(loc.pack_id), { range: { offset: loc.offset, length: loc.length } }),
    );
    if (!object) throw new Error("missing pack extent");
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (bytes.byteLength !== loc.length || (await sha256Hex(bytes)) !== sha) throw new Error("invalid pack extent");
    return bytes;
  } catch (e) {
    logErr("pack_extent_error", e);
    emit(env, { op: "blob.packExtent", outcome: "pack_extent_error" });
    return null;
  }
}

interface PackRow {
  pack_id: string;
  pack_sha256: string;
  size_bytes: number;
  member_count: number;
  state: "uploading" | "ready" | "swept";
}

function memberInsert(db: D1Database, packId: string, packSha: string, entries: PackDirEntry[]): D1PreparedStatement {
  // One SELECT over a VALUES table (not UNION ALL chains — D1 caps compound
  // SELECT terms well below our row chunk). The EXISTS guard keys every row to
  // this packId+checksum, so a same-id/different-hash race can never
  // interleave foreign member rows into the winner's inventory (spec §2a.9).
  const rows = entries.map(() => "(?, ?, ?, ?)").join(", ");
  return db
    .prepare(
      `INSERT OR IGNORE INTO pack_members (pack_id, sha256, offset, length)
       SELECT column1, column2, column3, column4 FROM (VALUES ${rows})
       WHERE EXISTS (SELECT 1 FROM packs WHERE pack_id = ? AND pack_sha256 = ?)`,
    )
    .bind(...entries.flatMap((entry) => [packId, entry.sha256, entry.offset, entry.length]), packId, packSha);
}

async function loadPack(db: D1Database, packId: string): Promise<PackRow | null> {
  return db
    .prepare("SELECT pack_id, pack_sha256, size_bytes, member_count, state FROM packs WHERE pack_id = ?")
    .bind(packId)
    .first<PackRow>();
}

async function inventoryMatches(db: D1Database, row: PackRow, bodyBytes: number, entries: PackDirEntry[]): Promise<boolean> {
  if (row.size_bytes !== bodyBytes || row.member_count !== entries.length) return false;
  const found = await db
    .prepare("SELECT sha256, offset, length FROM pack_members WHERE pack_id = ? ORDER BY offset")
    .bind(row.pack_id)
    .all<PackDirEntry>();
  if (found.results.length !== entries.length) return false;
  return entries.every((entry, i) => {
    const actual = found.results[i];
    return actual?.sha256 === entry.sha256 && Number(actual.offset) === entry.offset && Number(actual.length) === entry.length;
  });
}

async function createInventory(
  op: Op,
  accountId: string,
  packId: string,
  packSha: string,
  bodyBytes: number,
  entries: PackDirEntry[],
  nowMs: number,
): Promise<PackRow | null> {
  const db = dbFor(op.env, accountId);
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        "INSERT OR IGNORE INTO packs (pack_id, pack_sha256, size_bytes, member_count, state, created_at, touched_at) VALUES (?, ?, ?, ?, 'uploading', ?, ?)",
      )
      .bind(packId, packSha, bodyBytes, entries.length, nowMs, nowMs),
  ];
  for (let i = 0; i < entries.length; i += INVENTORY_ROWS_PER_STATEMENT) {
    statements.push(memberInsert(db, packId, packSha, entries.slice(i, i + INVENTORY_ROWS_PER_STATEMENT)));
  }
  await db.batch(statements);
  return loadPack(db, packId);
}

async function fenceRead(op: Op, accountId: string, packId: string, shas: string[]): Promise<boolean> {
  const db = dbFor(op.env, accountId);
  try {
    const [logical, physical] = await db.batch([
      db
        .prepare("SELECT sha256 FROM gc_candidates WHERE deleting_at IS NOT NULL AND sha256 IN (SELECT value FROM json_each(?)) LIMIT 1")
        .bind(JSON.stringify(shas)),
      db
        .prepare(
          "SELECT pack_id FROM pack_gc_candidates WHERE pack_id = ? UNION ALL SELECT pack_id FROM packs WHERE pack_id = ? AND state = 'swept' LIMIT 1",
        )
        .bind(packId, packId),
    ]);
    return logical?.results.length === 0 && physical?.results.length === 0;
  } catch {
    return false;
  }
}

async function mintPackResponse(
  env: Env,
  accountId: string,
  packId: string,
  packSha: string,
  entries: PackDirEntry[],
  checkTime: number,
): Promise<Response> {
  const results = await Promise.all(
    entries.map(async (entry) => ({
      sha256: entry.sha256,
      ok: true as const,
      sizeBytes: entry.length,
      receipt: await mintReceipt(env, { accountId, encSha: entry.sha256, size: entry.length, nowMs: checkTime, packId }),
    })),
  );
  return json({ packId, packSha256: packSha, results });
}

/** Design 114 pack publication. Validation and persistence order is safety-critical. */
export async function blobPackPut(req: Request, env: Env, accountId: string): Promise<Response> {
  const op = startOp(env, "blob.packPut");
  let memberCount = 0;
  let bodyBytes = 0;
  const done = (outcome: string, response: Response): Response => {
    op.done(outcome, { count: memberCount, bytes: bodyBytes });
    return response;
  };

  if (!packAcceptEnabled(env)) return done("disabled", json({ error: "pack_disabled" }, 404));
  if (!usesReceipts(req)) return done("bad_request", json({ error: "receipts_required" }, 400));

  const packId = req.headers.get("x-rbox-pack-id") ?? "";
  const packSha = req.headers.get("x-rbox-pack-sha256") ?? "";
  const contentType = req.headers.get("content-type");
  if (!PACK_ID_RE.test(packId) || !SHA256_HEX_RE.test(packSha) || contentType !== PACK_CONTENT_TYPE) {
    return done("bad_request", json({ error: "bad_request" }, 400));
  }

  try {
    const body = await readBytesCapped(req, PACK_MAX_BODY_BYTES);
    if (body === null) return done("too_large", json({ error: "bad_request" }, 400));
    bodyBytes = body.byteLength;
    if (await sha256Hex(body) !== packSha) return done("pack_sha_mismatch", json({ error: "pack_sha_mismatch" }, 400));

    const parsed = parsePack(body);
    if (!parsed.ok) return done("bad_pack", json({ error: "bad_pack", reason: parsed.error }, 400));
    memberCount = parsed.entries.length;
    if ((await sha256Hex(parsed.directory)) !== toHex(parsed.directorySha256)) {
      return done("bad_pack", json({ error: "bad_pack", reason: "directory_sha_mismatch" }, 400));
    }
    const memberHashes = await Promise.all(
      parsed.entries.map((entry) => sha256Hex(body.subarray(entry.offset, entry.offset + entry.length))),
    );
    if (memberHashes.some((actual, i) => actual !== parsed.entries[i]!.sha256)) {
      return done("member_sha_mismatch", json({ error: "member_sha_mismatch" }, 400));
    }

    const quota = await wouldExceedCapAggregate(
      op.env,
      accountId,
      parsed.entries.map((entry) => ({ sha: entry.sha256, size: entry.length })),
    );
    if (quota.over) return done("quota_exceeded", json({ error: "quota_exceeded", used: quota.used, cap: quota.cap }, 402));

    const db = dbFor(op.env, accountId);
    let row = await loadPack(db, packId);
    if (!row) row = await createInventory(op, accountId, packId, packSha, bodyBytes, parsed.entries, Date.now());
    if (!row) return done("retry_later", json({ error: "retry_later" }, 503));
    if (row.pack_sha256 !== packSha) return done("conflict", json({ error: "pack_conflict" }, 409));
    if (row.state === "swept") return done("retry_later", json({ error: "retry_later" }, 503));
    if (!(await inventoryMatches(db, row, bodyBytes, parsed.entries))) return done("retry_later", json({ error: "retry_later" }, 503));

    if (row.state === "ready") {
      let object: R2Object | null;
      try {
        object = await op.span.r2(() => op.env.rbox_dev_blobs.head(packKey(packId)));
      } catch {
        object = null;
      }
      if (!object || object.size !== bodyBytes) return done("retry_later", json({ error: "retry_later" }, 503));
      const checkTime = Date.now();
      if (!(await fenceRead(op, accountId, packId, parsed.entries.map((entry) => entry.sha256)))) {
        return done("retry_later", json({ error: "retry_later" }, 503));
      }
      return done("ok", await mintPackResponse(op.env, accountId, packId, packSha, parsed.entries, checkTime));
    }

    const heartbeat = await db
      .prepare("UPDATE packs SET touched_at = ? WHERE pack_id = ? AND state = 'uploading' AND pack_sha256 = ?")
      .bind(Date.now(), packId, packSha)
      .run();
    if (heartbeat.meta.changes !== 1) return done("retry_later", json({ error: "retry_later" }, 503));

    try {
      await op.span.r2(() => op.env.rbox_dev_blobs.put(packKey(packId), body, { sha256: packSha }));
    } catch {
      return done("r2_error", json({ error: "pack_r2_error" }, 500));
    }

    const checkTime = Date.now();
    if (!(await fenceRead(op, accountId, packId, parsed.entries.map((entry) => entry.sha256)))) {
      return done("retry_later", json({ error: "retry_later" }, 503));
    }
    const ready = await db
      .prepare("UPDATE packs SET state = 'ready', touched_at = ? WHERE pack_id = ? AND state = 'uploading' AND pack_sha256 = ?")
      .bind(Date.now(), packId, packSha)
      .run();
    if (ready.meta.changes !== 1) return done("retry_later", json({ error: "retry_later" }, 503));
    return done("ok", await mintPackResponse(op.env, accountId, packId, packSha, parsed.entries, checkTime));
  } catch {
    return done("error", json({ error: "internal_error" }, 500));
  }
}

async function tombstoneCursor(db: D1Database): Promise<string> {
  const row = await db.prepare("SELECT v FROM gc_state WHERE k = ?").bind(TOMBSTONE_CURSOR_KEY).first<{ v: string }>();
  if (!row?.v) return "";
  try {
    const parsed: unknown = JSON.parse(row.v);
    return typeof parsed === "string" && PACK_ID_RE.test(parsed) ? parsed : "";
  } catch {
    return "";
  }
}

export interface PackTombstone {
  packId: string;
  createdAt: number;
  touchedAt: number;
}

/** Platform-admin audit data only. Pack ids never enter metrics or logs. */
export async function packTombstones(env: Env): Promise<{ tombstones: PackTombstone[]; count: number }> {
  const rows = await dbFor(env, "")
    .prepare("SELECT pack_id,created_at,touched_at FROM packs WHERE state='swept' ORDER BY pack_id LIMIT ?")
    .bind(TOMBSTONE_SWEEP_PAGE)
    .all<{ pack_id: string; created_at: number; touched_at: number }>();
  const tombstones = rows.results.map((row) => ({
    packId: row.pack_id,
    createdAt: Number(row.created_at),
    touchedAt: Number(row.touched_at),
  }));
  return { tombstones, count: tombstones.length };
}

/** Bounded tombstone-only HEAD/delete pass; permanent deny rows are never removed. */
export async function resweepPackTombstones(env: Env): Promise<{ observed: number; reDeleted: number }> {
  const op = startOp(env, "pack.gc.resweep");
  const db = dbFor(op.env, "");
  let observed = 0;
  let reDeleted = 0;
  try {
    const cursor = await tombstoneCursor(db);
    const tombstones = await db
      .prepare("SELECT pack_id FROM packs WHERE state='swept' AND pack_id > ? ORDER BY pack_id LIMIT ?")
      .bind(cursor, TOMBSTONE_SWEEP_PAGE)
      .all<{ pack_id: string }>();
    observed = tombstones.results.length;
    for (const { pack_id: packId } of tombstones.results) {
      let present = false;
      try {
        present = (await op.span.r2(() => op.env.rbox_dev_blobs.head(packKey(packId)))) !== null;
      } catch {
        continue;
      }
      if (present) {
        try {
          await op.span.r2(() => op.env.rbox_dev_blobs.delete(packKey(packId)));
          reDeleted++;
        } catch {
          // Keep the permanent tombstone and retry on a later pass.
        }
      }
    }
    if (tombstones.results.length === TOMBSTONE_SWEEP_PAGE) {
      const last = tombstones.results.at(-1)!.pack_id;
      await db
        .prepare("INSERT INTO gc_state(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .bind(TOMBSTONE_CURSOR_KEY, JSON.stringify(last))
        .run();
    } else {
      await db.prepare("DELETE FROM gc_state WHERE k = ?").bind(TOMBSTONE_CURSOR_KEY).run();
    }
    emit(env, { op: "pack.gc.tombstones", outcome: "ok", count: observed });
    emit(env, { op: "pack.gc.resweep_deleted", outcome: "ok", count: reDeleted });
    op.done("ok", { count: reDeleted });
    return { observed, reDeleted };
  } catch {
    op.done("error", { count: reDeleted });
    throw new Error("pack tombstone resweep failed");
  }
}

/** Reclaims abandoned uploading inventories and permanently contains late PUTs. */
export async function sweepUploadingPacks(env: Env, nowMs: number = Date.now()): Promise<void> {
  const op = startOp(env, "pack.gc.uploading");
  const db = dbFor(op.env, "");
  const cutoff = nowMs - PACK_ORPHAN_GRACE_MS;
  let swept = 0;
  try {
    const stale = await db
      .prepare("SELECT pack_id FROM packs WHERE state = 'uploading' AND created_at < ? AND touched_at < ? ORDER BY pack_id LIMIT ?")
      .bind(cutoff, cutoff, UPLOADING_SWEEP_PAGE)
      .all<{ pack_id: string }>();
    for (const { pack_id: packId } of stale.results) {
      const results = await db.batch([
        db
          .prepare(
            "DELETE FROM pack_members WHERE pack_id = ? AND EXISTS (SELECT 1 FROM packs p WHERE p.pack_id = pack_members.pack_id AND p.state = 'uploading' AND p.created_at < ? AND p.touched_at < ?)",
          )
          .bind(packId, cutoff, cutoff),
        db
          .prepare("UPDATE packs SET state = 'swept' WHERE pack_id = ? AND state = 'uploading' AND created_at < ? AND touched_at < ?")
          .bind(packId, cutoff, cutoff),
      ]);
      if (results[1]!.meta.changes === 1) {
        swept++;
        try {
          await op.span.r2(() => op.env.rbox_dev_blobs.delete(packKey(packId)));
        } catch {
          // The durable tombstone makes a later re-sweep authoritative.
        }
      }
    }

    await resweepPackTombstones(env);

    emit(env, { op: "pack.gc.swept", outcome: "ok", count: swept });
    op.done("ok", { count: swept });
  } catch {
    op.done("error", { count: swept, bytes: 0 });
    throw new Error("uploading pack sweep failed");
  }
}
