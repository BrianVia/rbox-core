// §23.4 — commit-time accounting (the D1 win). Moves the per-blob D1 work that
// used to run on every PUT (§25: ~7 D1 round-trips/blob) into ONE chunked, atomic
// transaction per commit, plus a staging→canonical promote. See
// docs/design/23-upload-receipts/4-commit-grant-batch.md (design v10, codex PASS).
//
// Order (account-then-publish): validate (present=1+entitled OR receipt) → D1 batch
// (catalog present=0 + charge via NOT-EXISTS + grant, under the accounts_cap_guard
// trigger) → promote staging→canonical → set present=1. The DO head-advance happens
// AFTER this in workspace-sync (so a published head ⟹ canonical present).

import type { Env } from "./env.js";
import { verifyReceiptWithExpiry } from "./receipts.js";
import { isOverCapAbort } from "./auth.js";
import { resolvePackPlacements, type PackPlacement } from "./blob-pack.js";
import { BILLABLE_BYTES_SQL } from "./plans.js";

export function isDeleteFenceAbort(e: unknown): boolean {
  return e instanceof Error && e.message.includes("rbox_delete_fence");
}

export interface RefWithSize {
  sha: string;
  size: number;
  receiptExpiresAt: number;
  pack?: PackPlacement;
}

// D1: ≤100 bound params / statement. The grant INSERT binds (account_id, sha256)
// per row = 2 params (granted_at is a server integer literal), so ≤49 rows; we use
// 33 to stay well under across catalog/charge/grant in one chunk.
export const ACCOUNTING_INSERT_CHUNK = 33;
// §30: refs charged/granted per atomic db.batch(). Each batch() is ONE D1 subrequest and
// one SQLite transaction; this bounds its statement count (~MAX_REFS_PER_TXN/
// ACCOUNTING_INSERT_CHUNK·5 = 455)
// so a single transaction stays within the D1 isolate's CPU/memory budget. A commit with
// more refs runs SEVERAL such batches in sequence — each independently atomic + cap-guarded,
// and (because accounting is idempotent + account-then-publish) crash-/retry-safe.
export const MAX_REFS_PER_TXN = 3_000;
// Validate IN-list SELECTs (≤90 refs each) grouped per db.batch() — one subrequest per group.
export const VALIDATE_IN_LIST_CHUNK = 90;
export const SELECTS_PER_BATCH = Math.ceil(MAX_REFS_PER_TXN / VALIDATE_IN_LIST_CHUNK); // ~34
// Worst mixed chunk: 5 logical-accounting statements + 1 canonical-location
// delete. Packed placements are grouped separately across the whole transaction.
export const ACCOUNTING_STATEMENTS_PER_CHUNK = 6;
// 2,000 compact rows (two 64-hex shas, a 32-hex pack id, offset, length) measure
// ~484 KB — roughly 4x under D1's documented 2,000,000-byte string/bound-value
// limit. `packed` is itself bounded by MAX_REFS_PER_TXN, so no chunk exceeds this.
export const PACKED_PLACEMENT_CHUNK = 2_000;
// §71: hard sanity reject on the ACCOUNTED ref set in one commit. For sidecar commits the
// signed descriptor's data-ref count is not the full accounting set: encManifestSha and
// sidecarSha are charged/granted too. Keep the carrier count named so a future carrier changes
// the budget math and tests deliberately.
export const CARRIER_REFS = 2; // encManifestSha + sidecarSha
export const MAX_REFS_PER_COMMIT = 250_000;
export const MAX_RECEIPTS_PER_REDEEM = 5_000;

/** Design 111's flag-gated receipt-redeem cap. The commit path continues to use
 * MAX_RECEIPTS_PER_REDEEM; this only raises the dedicated redemption endpoint. */
export function receiptRedeemMax(env: Env): number {
  const raw = env.RBOX_RECEIPT_REDEEM_MAX?.trim();
  if (!raw || !/^\d+$/.test(raw)) return MAX_RECEIPTS_PER_REDEEM;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return MAX_RECEIPTS_PER_REDEEM;
  return Math.min(15_000, parsed);
}

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export type ValidateResult =
  | { ok: true; newRefs: RefWithSize[] }
  | { ok: false; needsUpload: string[] };

export async function resolveVerifiedRefs(
  db: D1Database,
  verified: Array<{ sha: string; size: number; expiresAt: number; packId?: string }>,
): Promise<{ newRefs: RefWithSize[]; unresolved: string[] }> {
  const wanted = verified.flatMap((ref) => ref.packId ? [{ sha: ref.sha, packId: ref.packId }] : []);
  const placements = await resolvePackPlacements(db, wanted);
  const newRefs: RefWithSize[] = [];
  const unresolved: string[] = [];
  for (const ref of verified) {
    if (!ref.packId) {
      newRefs.push({ sha: ref.sha, size: ref.size, receiptExpiresAt: ref.expiresAt });
      continue;
    }
    const pack = placements.get(ref.sha);
    if (!pack || pack.packId !== ref.packId) unresolved.push(ref.sha);
    else newRefs.push({ sha: ref.sha, size: ref.size, receiptExpiresAt: ref.expiresAt, pack });
  }
  return { newRefs, unresolved };
}

/** Which referenced shas this account may use without a receipt (already entitled
 *  AND canonical-present), and verify a receipt for the rest. A ref that is entitled
 *  but present=0 (an in-flight/crashed prior promote) is NOT satisfied — it needs a
 *  receipt like any absent ref (§23.4 step 2 / the v8 present-flag decoupling). */
export async function validateCommitRefs(
  env: Env,
  db: D1Database,
  accountId: string,
  shas: string[],
  receipts: Record<string, string>,
  nowMs: number,
): Promise<ValidateResult> {
  // §30: entitled-AND-present read, batched. Each IN-list SELECT is ≤90 params; grouping them
  // into db.batch() calls (one D1 subrequest each) makes validating N refs cost ~N/(90·SELECTS_
  // PER_BATCH) subrequests instead of N/90 — the prior 90-per-round-trip loop was the subrequest
  // hog that bounded large commits (§30 limits analysis).
  const have = new Set<string>(); // entitled AND present=1 AND not a prune candidate
  // §33 candidate-aware validate (the prune barrier), FOLDED into the have-set SELECT: a ref this
  // account has marked as a prune-candidate (`blob_ref_candidates`) is excluded by the NOT EXISTS,
  // so it reads as NOT-satisfied even though it is entitled+present — forcing it into `newRefs` so
  // commitAccounting re-grants it and CLEARS the marker. Without this, a deduped commit (which
  // never bumps `granted_at`) could publish a head referencing a ref Phase-1 purge is about to
  // drop. Folding it into the existing query (vs a second pass) makes the barrier un-forgettable.
  const selects = chunk(shas, VALIDATE_IN_LIST_CHUNK).map((c) =>
    db
      .prepare(
        `SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
         WHERE r.account_id = ? AND b.present = 1 AND r.sha256 IN (${c.map(() => "?").join(",")})
           AND NOT EXISTS (SELECT 1 FROM blob_ref_candidates c WHERE c.account_id = r.account_id AND c.sha256 = r.sha256)
           AND NOT EXISTS (SELECT 1 FROM gc_candidates g WHERE g.sha256 = r.sha256 AND g.deleting_at IS NOT NULL)`,
      )
      .bind(accountId, ...c),
  );
  for (const group of chunk(selects, SELECTS_PER_BATCH)) {
    const results = await db.batch<{ sha256: string }>(group);
    for (const r of results) for (const row of r.results ?? []) have.add(row.sha256);
  }

  const verified: Array<{ sha: string; size: number; expiresAt: number; packId?: string }> = [];
  const needsUpload: string[] = [];
  for (const sha of shas) {
    if (have.has(sha)) continue;
    const r = receipts[sha];
    if (!r) {
      needsUpload.push(sha);
      continue;
    }
    const v = await verifyReceiptWithExpiry(env, r, { accountId, encSha: sha, nowMs });
    if (!v.ok) needsUpload.push(sha);
    else verified.push({ sha, size: v.size, expiresAt: v.expiresAt, ...(v.packId ? { packId: v.packId } : {}) });
  }
  const { newRefs, unresolved } = await resolveVerifiedRefs(db, verified);
  needsUpload.push(...unresolved);
  if (needsUpload.length > 0) return { ok: false, needsUpload };
  return { ok: true, newRefs };
}

export type AccountingResult =
  | { ok: true }
  | { overCap: { used: number; cap: number; reason?: "no_plan" } }
  | { needsUpload: string[] };

/** Catalog (present=1) + charge + grant + un-condemn for `newRefs` in ONE chunked,
 *  atomic D1 batch (the accounts_cap_guard trigger rolls the whole batch back on over-cap).
 *  Direct-write: the canonical objects already exist (the PUTs wrote them), so there is NO
 *  promote — pure D1, O(chunks). Idempotent: re-running inserts 0 new rows / charges 0
 *  (NOT-EXISTS). */
export async function commitAccounting(
  db: D1Database,
  accountId: string,
  newRefs: RefWithSize[],
  nowMs: number,
): Promise<AccountingResult> {
  if (newRefs.length === 0) return { ok: true };

  // §228: admission is unchanged — the charge below still moves the live `used_bytes`
  // ledger and the accounts_cap_guard trigger is still the authority. Only the number
  // REPORTED back to the client is billable bytes, so the 402 the user sees matches the
  // number the dashboard shows them.
  const acc = await db.prepare(`SELECT plan, ${BILLABLE_BYTES_SQL} AS billable_bytes, cap_bytes FROM accounts WHERE id=?`).bind(accountId).first<{
    plan: string;
    billable_bytes: number;
    cap_bytes: number;
  }>();
  if (acc?.plan === "none") {
    return { overCap: { used: Number(acc.billable_bytes ?? 0), cap: Number(acc.cap_bytes ?? 0), reason: "no_plan" } };
  }

  // §30: charge+grant in SEQUENTIAL atomic super-batches of ≤MAX_REFS_PER_TXN refs. Each
  // db.batch() is one transaction (cap-guarded); a commit larger than one transaction runs
  // several. On over_cap, prior super-batches stay charged+granted — real, idempotent-
  // retryable entitlements, NOT rolled back (design 30 §3: no compensation). The within-
  // batch ordering (catalog present=1 → charge NOT-EXISTS → grant → un-condemn) is unchanged,
  // so a later chunk's NOT-EXISTS still sees earlier chunks' grants (no double-charge).
  for (const superBatch of chunk(newRefs, MAX_REFS_PER_TXN)) {
    const receiptDeadline = Math.min(...superBatch.map((ref) => ref.receiptExpiresAt));
    const stmts: D1PreparedStatement[] = [
      db
        .prepare("SELECT CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ? AS live")
        .bind(receiptDeadline),
    ];
    const canonicalDeletes: D1PreparedStatement[] = [];
    const packed = superBatch.filter((ref): ref is RefWithSize & { pack: PackPlacement } => ref.pack !== undefined);
    for (const c of chunk(superBatch, ACCOUNTING_INSERT_CHUNK)) {
      const shas = c.map((r) => r.sha);
      const inList = shas.map(() => "?").join(",");
      // Direct-write (§23.2 v2): PUT already wrote the canonical object, so catalog present=1
      // immediately — no promote, no present=0 window. Atomic with charge+grant in this batch.
      stmts.push(
        db
          .prepare(`INSERT OR IGNORE INTO blobs(sha256, size_bytes, present)
            SELECT j.value->>'$.sha', CAST(j.value->>'$.size' AS INTEGER), 1
            FROM json_each(?) AS j
            WHERE CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?`)
          .bind(JSON.stringify(c.map((r) => ({ sha: r.sha, size: r.size }))), receiptDeadline),
      );
      stmts.push(
        db
          .prepare(
            `UPDATE accounts SET used_bytes = used_bytes + (
               SELECT COALESCE(SUM(b.size_bytes),0) FROM blobs b
                WHERE b.sha256 IN (${inList})
                  AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.account_id=? AND r.sha256=b.sha256))
             WHERE id = ? AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?`,
          )
          .bind(...shas, accountId, accountId, receiptDeadline),
      );
      stmts.push(
        db
          .prepare(
            `INSERT INTO blob_refs(account_id, sha256, granted_at)
             SELECT ?, j.value, ${nowMs}
             FROM json_each(?) AS j
             WHERE CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?
             ON CONFLICT(account_id, sha256) DO UPDATE SET granted_at = excluded.granted_at`,
          )
          .bind(accountId, JSON.stringify(shas), receiptDeadline),
      );
      // Un-condemn: a re-uploaded blob clears its GC candidacy (the canonical object is fresh).
      stmts.push(
        db
          .prepare(`DELETE FROM gc_candidates WHERE deleting_at IS NULL AND sha256 IN (${inList})
            AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?`)
          .bind(...shas, receiptDeadline),
      );
      // §33: a (re-)grant clears this account's Phase-1 prune marker, atomically with the
      // grant — so a marked ref this commit re-establishes can NEVER be dropped by a later
      // purge (its candidate row is gone). The dedup path bumps `granted_at` here too via
      // the ON CONFLICT UPDATE above, but `granted_at` is NOT the barrier — the marker is.
      stmts.push(
        db
          .prepare(`DELETE FROM blob_ref_candidates WHERE account_id = ? AND sha256 IN (${inList})
            AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?`)
          .bind(accountId, ...shas, receiptDeadline),
      );

      const canonical = c.filter((ref) => ref.pack === undefined).map((ref) => ref.sha);
      if (canonical.length > 0) {
        canonicalDeletes.push(
          db
            .prepare(`DELETE FROM blob_locations WHERE sha256 IN (${canonical.map(() => "?").join(",")})
              AND CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?`)
            .bind(...canonical, receiptDeadline),
        );
      }
    }
    for (const locations of chunk(packed, PACKED_PLACEMENT_CHUNK)) {
      const rows = locations.map((ref) => ({
        sha256: ref.sha,
        pack_id: ref.pack.packId,
        offset: ref.pack.offset,
        length: ref.pack.length,
        pack_sha256: ref.pack.packSha256,
      }));
      stmts.push(
        db
          .prepare(
            `INSERT INTO blob_locations (sha256, storage, pack_id, offset, length, pack_sha256, installed_at)
             SELECT j.value->>'$.sha256', 'pack', j.value->>'$.pack_id',
                    CAST(j.value->>'$.offset' AS INTEGER), CAST(j.value->>'$.length' AS INTEGER),
                    j.value->>'$.pack_sha256', ${nowMs}
             FROM json_each(?) AS j
             WHERE CAST((julianday('now')-2440587.5)*86400000 AS INTEGER) < ?
             ON CONFLICT(sha256) DO UPDATE SET
               pack_id=excluded.pack_id, offset=excluded.offset, length=excluded.length,
               pack_sha256=excluded.pack_sha256, installed_at=excluded.installed_at`,
          )
          .bind(JSON.stringify(rows), receiptDeadline),
      );
    }
    // Preserve placement-before-canonical trigger ordering: a destination pack
    // must not look transiently empty while another row is moving into it.
    stmts.push(...canonicalDeletes);

    try {
      // `db` is the §25 span-wrapped binding — the Proxy times+counts batch() itself,
      // so we do NOT wrap in span.d1() (that would double-count).
      const results = await db.batch(stmts);
      if (Number((results[0]?.results?.[0] as { live?: number } | undefined)?.live ?? 0) !== 1) {
        return { needsUpload: superBatch.map((r) => r.sha) };
      }
    } catch (e) {
      // The trigger has no sha payload. The immutable safe failure unit is this
      // whole caught super-batch; never shrink it with a post-hoc intent read.
      if (isDeleteFenceAbort(e)) return { needsUpload: superBatch.map((r) => r.sha) };
      // accounts_cap_guard RAISE(ABORT,'over_cap') → THIS super-batch rolled back; earlier
      // ones stayed committed (design 30 §3). Report over-cap; the client gets a 402.
      if (isOverCapAbort(e)) {
        const acc = await db.prepare(`SELECT ${BILLABLE_BYTES_SQL} AS billable_bytes, cap_bytes FROM accounts WHERE id=?`).bind(accountId).first<{
          billable_bytes: number;
          cap_bytes: number;
        }>();
        return { overCap: { used: Number(acc?.billable_bytes ?? 0), cap: Number(acc?.cap_bytes ?? 0) } };
      }
      throw e;
    }
  }

  // Direct-write: NO promote phase. The bytes are already at the canonical key (the PUT
  // wrote them, §23.2 v2), and the batches above cataloged present=1 + charged + granted
  // atomically. The commit is O(chunks) D1 work with zero R2 ops.
  return { ok: true };
}
