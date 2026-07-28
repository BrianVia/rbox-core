import type { Env } from "./env.js";
import { errClass, json, sha256Hex } from "./util.js";
import { isOverCapAbort } from "./auth.js";
import { MAX_UNIQUE_ROOTS, reachableFromWorkspaces } from "./gc-roots.js";
import { dbFor } from "./db.js";

// Max rows per multi-row INSERT so bound params stay within D1's ≤100/statement limit
// (≤3 params/row → 33 rows = 99). Shared by the batched mark + condemn inserts below.
const INSERT_CHUNK = 33;
// Keep a cron tick's D1 subrequests bounded: mark is ~cap/33 insert batches and
// purge is ~cap/33 transaction batches (plus condemnation), never O(account refs)
// (§102 Q3). At cap, purge + condemn + cursors/probes is ~150 D1 subrequests.
export const PHASE1_MAX_ROWS = 2_000;

async function readCursor(db: D1Database, key: string): Promise<string> {
  const row = await db.prepare("SELECT v FROM gc_state WHERE k = ?").bind(key).first<{ v: string }>();
  if (!row) return "";
  try { return String(JSON.parse(row.v) ?? ""); } catch { return ""; }
}

async function writeCursor(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare("INSERT INTO gc_state (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").bind(key, JSON.stringify(value)).run();
}

// §33 Phase 1 — per-account reachability GC (the leak-closing, shardable, cron-safe
// phase). PURE D1: it reclaims a `blob_refs` row + its `used_bytes` charge for refs
// that are no longer reachable from the account's authoritative DO roots. It touches
// NO R2 — it only CONDEMNS a now-globally-unreferenced blob into `gc_candidates` for
// the existing manual/quiescent Phase 2 (canonical R2) sweep (`gc-purge.ts`, scheduled by worker.ts).
//
// This closes the design 30 §3 / design 07b §d entitlement leak (over-cap partial
// charges + head-409 orphans that stranded `blob_refs` + `used_bytes` forever).
//
// The barrier that makes purge cron-safe is the candidate-aware commit preflight: the
// `blob_ref_candidates` marker is FOLDED (as a `NOT EXISTS`) directly into the have/missing
// satisfiability queries of validateCommitRefs / blobsCheck / missingBlobs, so a marked
// (account, sha) reads as NOT-satisfied → re-grant → the marker is cleared (commit-accounting.ts
// + billing.ts). Folding it into the existing queries (vs a separate consultation pass) makes the
// barrier impossible to forget. `granted_at`/`marked_at` grace is only a secondary skip +
// defense-in-depth, NOT the correctness argument.

/**
 * §33 §3.1 — the per-account reachable set, from AUTHORITATIVE DO roots. Enumerate the
 * account's workspaces (a shard-local `WHERE account_id = ?` lookup) and ask each
 * per-(workspace, project) WorkspaceSync DO for its retained roots, unioning every
 * `encManifestSha` + referenced `encSha`. FAIL CLOSED PER ACCOUNT: any unreadable DO
 * (`roots_incomplete` 409, retained gap, unreadable sidecar) THROWS, aborting only
 * THIS account's GC — every other account stays collectible (the §32 sharding win).
 */
export async function perAccountReachable(env: Env, accountId: string): Promise<Set<string>> {
  const wss = await dbFor(env, accountId)
    .prepare("SELECT workspace_id, project_id FROM workspaces WHERE account_id = ?")
    .bind(accountId)
    .all<{ workspace_id: string; project_id: string }>();
  return reachableFromWorkspaces(env, wss.results ?? []);
}

/** §33 §3.2 MARK (non-destructive, cron-safe today). Mark this account's `blob_refs`
 *  that are NOT in `reachable` and whose `granted_at` is older than grace (a cheap
 *  skip of obviously-fresh refs). `INSERT OR IGNORE` → idempotent. */
export async function phase1Mark(
  db: D1Database,
  accountId: string,
  reachable: Set<string>,
  graceMs: number,
  nowMs: number,
): Promise<{ marked: number }> {
  const cursorKey = `p1_mark_cursor:${accountId}`;
  const cursor = await readCursor(db, cursorKey);
  const refs = await db
    .prepare("SELECT sha256, granted_at FROM blob_refs WHERE account_id = ? AND sha256 > ? ORDER BY sha256 LIMIT ?")
    .bind(accountId, cursor, PHASE1_MAX_ROWS)
    .all<{ sha256: string; granted_at: number }>();
  const toMark: string[] = [];
  for (const ref of refs.results ?? []) {
    if (reachable.has(ref.sha256)) continue; // still needed → never mark
    if (nowMs - Number(ref.granted_at) < graceMs) continue; // cheap skip of fresh refs
    toMark.push(ref.sha256);
  }
  // One chunked multi-row INSERT OR IGNORE per db.batch (≤33 rows × 3 bound params ≤ 100/stmt)
  // instead of one INSERT per ref — trims cron subrequests. `marked` still counts inserted rows.
  let marked = 0;
  for (let i = 0; i < toMark.length; i += INSERT_CHUNK) {
    const chunk = toMark.slice(i, i + INSERT_CHUNK);
    if (chunk.length === 0) break;
    const r = await db.batch([
      db
        .prepare(`INSERT OR IGNORE INTO blob_ref_candidates (account_id, sha256, marked_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`)
        .bind(...chunk.flatMap((sha) => [accountId, sha, nowMs])),
    ]);
    marked += r[0]?.meta.changes ?? 0;
  }
  const scanned = refs.results ?? [];
  await writeCursor(db, cursorKey, scanned.length < PHASE1_MAX_ROWS ? "" : scanned.at(-1)!.sha256);
  return { marked };
}

/**
 * §33 §3.2 PURGE (D1-only; cron-safe with the candidate-aware preflight). `reachable`
 * MUST be freshly recomputed from authoritative DO roots by the caller. A candidate is
 * dropped ONLY if it is simultaneously (i) still marked, (ii) absent from `reachable`,
 * and (iii) `marked_at` older than grace.
 *
 * `used_bytes` correctness: the release is conditioned on the ref STILL existing and is
 * batched ATOMICALLY with the delete — release happens iff the row is actually dropped
 * by THIS transaction, so two concurrent purges can't double-release (D1 serializes the
 * batch; the second sees the row already gone → EXISTS false → no release, 0-change
 * delete). When the dropped ref was the account's last reference AND the blob is now
 * globally unreferenced (`COUNT(*) = 0`), condemn it into `gc_candidates` for the manual
 * Phase 2 R2 sweep — Phase 1 itself NEVER deletes an R2 object.
 */
export async function phase1Purge(
  db: D1Database,
  accountId: string,
  reachable: Set<string>,
  graceMs: number,
  nowMs: number,
): Promise<{ purged: number; released: number; resurrected: number; condemned: number }> {
  const cursorKey = `p1_purge_cursor:${accountId}`;
  const cursor = await readCursor(db, cursorKey);
  // Hoist each candidate's blob size into the candidates query (LEFT JOIN) — no per-candidate
  // `SELECT size_bytes`. LEFT JOIN: an orphan marker with no `blobs` row yields NULL → 0 (the
  // EXISTS(blob_refs) guard already makes its release a no-op).
  const cands = await db
    .prepare("SELECT c.sha256, c.marked_at, b.size_bytes FROM blob_ref_candidates c LEFT JOIN blobs b ON b.sha256 = c.sha256 WHERE c.account_id = ? AND c.sha256 > ? ORDER BY c.sha256 LIMIT ?")
    .bind(accountId, cursor, PHASE1_MAX_ROWS)
    .all<{ sha256: string; marked_at: number; size_bytes: number | null }>();
  const scanned = cands.results ?? [];
  let purged = 0;
  let released = 0;
  let resurrected = 0;
  const dropped: string[] = []; // shas this purge removed this account's ref for (condemn-eligible)
  let condemned = 0;
  let lastProcessedSha = cursor;
  let completed = false;
  try {
    for (let i = 0; i < scanned.length; i += INSERT_CHUNK) {
      const pageChunk = scanned.slice(i, i + INSERT_CHUNK);
      const eligible = pageChunk.filter((cand) => !reachable.has(cand.sha256) && nowMs - Number(cand.marked_at) >= graceMs);
      const reentered = pageChunk.filter((cand) => reachable.has(cand.sha256));
      const statements: D1PreparedStatement[] = [];
      const guard = "EXISTS (SELECT 1 FROM blob_ref_candidates WHERE account_id = ? AND sha256 = ?)";

      // ATOMIC re-confirm + delete + conditional release + marker-clear. A chunk is one
      // coarser transaction (<=33 rows / 99 guarded statements) with the SAME per-row
      // guards and ordering as the old one-row transactions. Each release/delete re-reads
      // `blob_ref_candidates` INSIDE the transaction (§33 §3.3), so a concurrent regrant
      // that clears the marker makes that row's triple no-op. UPDATE precedes ref DELETE,
      // and marker-clear remains third, preventing missed or double releases.
      for (const cand of eligible) {
        const sha = cand.sha256;
        const size = Number(cand.size_bytes ?? 0);
        statements.push(
          db
            .prepare(
              `UPDATE accounts SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ? AND EXISTS (SELECT 1 FROM blob_refs WHERE account_id = ? AND sha256 = ?) AND ${guard}`,
            )
            .bind(size, accountId, accountId, sha, accountId, sha),
          db.prepare(`DELETE FROM blob_refs WHERE account_id = ? AND sha256 = ? AND ${guard}`).bind(accountId, sha, accountId, sha),
          db.prepare("DELETE FROM blob_ref_candidates WHERE account_id = ? AND sha256 = ?").bind(accountId, sha),
        );
      }
      // Re-referenced since mark (a deduped commit re-entered roots) → bulk un-mark.
      // This statement shares the page chunk's transaction, keeping mixed pages at one
      // D1 subrequest per 33 scanned candidates while counting only actual deletions.
      if (reentered.length > 0) {
        statements.push(
          db
            .prepare(`DELETE FROM blob_ref_candidates WHERE account_id = ? AND sha256 IN (${reentered.map(() => "?").join(",")})`)
            .bind(accountId, ...reentered.map((cand) => cand.sha256)),
        );
      }
      if (statements.length > 0) {
        const batchRes = await db.batch(statements);
        for (let k = 0; k < eligible.length; k++) {
          if ((batchRes[3 * k + 1]?.meta.changes ?? 0) !== 1) continue;
          const cand = eligible[k]!;
          purged++;
          released += Number(cand.size_bytes ?? 0);
          dropped.push(cand.sha256);
        }
        if (reentered.length > 0) resurrected += batchRes.at(-1)?.meta.changes ?? 0;
      }
      // A cursor advances only after every action in this SHA-ordered slice committed.
      // Thus finally can persist a safe contiguous prefix after any later failure.
      lastProcessedSha = pageChunk.at(-1)!.sha256;
    }

    // Condemn (for the MANUAL Phase 2 R2 sweep — Phase 1 never deletes an R2 object) every dropped
    // sha now GLOBALLY unreferenced. `encSha` is account-unique (no cross-account sharing), so once
    // this account's last ref drops the blob is orphaned — but the COUNT guard holds regardless.
    // ONE chunked existence probe + ONE batched INSERT, instead of per-candidate round-trips.
    const orphaned: string[] = [];
    for (let i = 0; i < dropped.length; i += 80) {
      const chunk = dropped.slice(i, i + 80);
      if (chunk.length === 0) break;
      const ph = chunk.map(() => "?").join(",");
      const stillRef = await db.prepare(`SELECT DISTINCT sha256 FROM blob_refs WHERE sha256 IN (${ph})`).bind(...chunk).all<{ sha256: string }>();
      const referenced = new Set((stillRef.results ?? []).map((r) => r.sha256));
      for (const sha of chunk) if (!referenced.has(sha)) orphaned.push(sha);
    }
    for (let i = 0; i < orphaned.length; i += INSERT_CHUNK) {
      const chunk = orphaned.slice(i, i + INSERT_CHUNK);
      if (chunk.length === 0) break;
      const c = await db.batch([
        db
          .prepare(`INSERT OR IGNORE INTO gc_candidates (sha256, kind, marked_at) VALUES ${chunk.map(() => "(?, 'blob', ?)").join(", ")}`)
          .bind(...chunk.flatMap((sha) => [sha, nowMs])),
      ]);
      condemned += c[0]?.meta.changes ?? 0;
    }
    completed = true;
  } finally {
    await writeCursor(db, cursorKey, completed && scanned.length < PHASE1_MAX_ROWS ? "" : lastProcessedSha);
  }
  return { purged, released, resurrected, condemned };
}

interface Phase1AuditCandidate { account_id: string; sha256: string; marked_at: number; size_bytes: number | null; entitled: number }

/** Read-only operator audit of Phase-1 marks; no durable cursor or candidate writes. */
export async function phase1Audit(env: Env, graceMs: number, cursor: string | null, requestedLimit: number, nowMs: number = Date.now()): Promise<Response> {
  const limit = Math.max(1, Math.min(PHASE1_MAX_ROWS, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 100));
  const split = cursor?.indexOf("\n") ?? -1;
  const cursorAccount = split >= 0 ? cursor!.slice(0, split) : "";
  const cursorSha = split >= 0 ? cursor!.slice(split + 1) : "";
  const rows = await dbFor(env, "")
    .prepare(`SELECT c.account_id, c.sha256, c.marked_at, b.size_bytes,
        EXISTS (SELECT 1 FROM blob_refs r WHERE r.account_id=c.account_id AND r.sha256=c.sha256) entitled
      FROM blob_ref_candidates c LEFT JOIN blobs b ON b.sha256=c.sha256
      WHERE c.account_id > ? OR (c.account_id = ? AND c.sha256 > ?)
      ORDER BY c.account_id, c.sha256 LIMIT ?`)
    .bind(cursorAccount, cursorAccount, cursorSha, limit + 1)
    .all<Phase1AuditCandidate>();
  const page = (rows.results ?? []).slice(0, limit);
  const reachableByAccount = new Map<string, Set<string>>();
  let wouldResurrect = 0;
  let wouldPurge = 0;
  let wouldRelease = 0;
  for (const candidate of page) {
    let reachable = reachableByAccount.get(candidate.account_id);
    if (!reachable) {
      reachable = await perAccountReachable(env, candidate.account_id);
      reachableByAccount.set(candidate.account_id, reachable);
    }
    if (reachable.has(candidate.sha256)) wouldResurrect++;
    else if (Number(candidate.marked_at) < nowMs - graceMs) {
      wouldPurge++;
      if (candidate.entitled) wouldRelease += Number(candidate.size_bytes ?? 0);
    }
  }
  const hasMore = (rows.results?.length ?? 0) > limit;
  const last = page.at(-1);
  return json({ examined: page.length, wouldResurrect, wouldPurge, wouldRelease, cursor: hasMore && last ? `${last.account_id}\n${last.sha256}` : null, limit });
}

/**
 * §33 §3.2 reconciler (design 07b §c): re-derive `used_bytes` as the authoritative
 * SUM(blob_refs ⋈ blobs) for the account, in ONE atomic statement (no JS-level TOCTOU
 * with a concurrent commit's charge). The over-cap guard fires only on an INCREASE past
 * cap; a leak-correction is a decrease, so it never wedges — but we still tolerate a
 * rare guard abort (an under-count correction) and leave it for the next run.
 */
export async function reconcileUsage(db: D1Database, accountId: string): Promise<void> {
  try {
    await db
      .prepare(
        `UPDATE accounts SET used_bytes = (
           SELECT COALESCE(SUM(b.size_bytes), 0) FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
            WHERE r.account_id = ?
         ) WHERE id = ?`,
      )
      .bind(accountId, accountId)
      .run();
  } catch (e) {
    if (isOverCapAbort(e)) return; // under-count correction blocked by the cap guard; retried next run
    throw e;
  }
}

/**
 * §33 §3.4 cron orchestration — per account: reachable (fail-closed) → mark → purge →
 * reconcile. One account's failure (e.g. an unreadable DO) is logged and skipped; it
 * never starves the rest (idempotent: mark is INSERT OR IGNORE, purge is conditional).
 * D1-only — Phase 2's separately fenced executor runs on its own daily cron hour.
 */
export async function runPhase1(env: Env, graceMs: number, nowMs: number = Date.now()): Promise<Response> {
  // §32 FLAG: global account fan-out has no account in scope → dbFor(env, "") (the one
  // shard at N=1; a real shard cutover turns this into a per-shard loop, §33 §7).
  const accts = await dbFor(env, "").prepare("SELECT id FROM accounts").all<{ id: string }>();
  let processed = 0;
  let failed = 0;
  const totals = { marked: 0, purged: 0, released: 0, resurrected: 0, condemned: 0 };
  for (const a of accts.results ?? []) {
    const accountId = a.id;
    // Stable enough to correlate one account's future passes during an incident,
    // without placing the raw account id in logs.
    const accountKey = (await sha256Hex(accountId)).slice(0, 16);
    try {
      const reachable = await perAccountReachable(env, accountId); // fail-closed per account
      const db = dbFor(env, accountId);
      const m = await phase1Mark(db, accountId, reachable, graceMs, nowMs);
      const p = await phase1Purge(db, accountId, reachable, graceMs, nowMs);
      await reconcileUsage(db, accountId);
      totals.marked += m.marked;
      totals.purged += p.purged;
      totals.released += p.released;
      totals.resurrected += p.resurrected;
      totals.condemned += p.condemned;
      processed++;
      console.log(JSON.stringify({
        event: "phase1_account_outcome",
        accountKey,
        outcome: "success",
        reachable: reachable.size,
        reachableCap: MAX_UNIQUE_ROOTS,
        reachableRemaining: MAX_UNIQUE_ROOTS - reachable.size,
        marked: m.marked,
        purged: p.purged,
        released: p.released,
        resurrected: p.resurrected,
        condemned: p.condemned,
      }));
    } catch (e) {
      // Exactly one outcome line per account/pass. Keep the stable pseudonymous key
      // and error class, but never the raw account id, exception message, or stack.
      failed++;
      console.error(JSON.stringify({ event: "phase1_account_outcome", accountKey, outcome: "fail_closed", errorClass: errClass(e) }));
    }
  }
  return json({ ok: true, accounts: accts.results?.length ?? 0, processed, failed, ...totals });
}
