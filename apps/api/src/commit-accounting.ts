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
import { verifyReceipt } from "./receipts.js";

export interface RefWithSize {
  sha: string;
  size: number;
}

// D1: ≤100 bound params / statement. The grant INSERT binds (account_id, sha256)
// per row = 2 params (granted_at is a server integer literal), so ≤49 rows; we use
// 33 to stay well under across catalog/charge/grant in one chunk.
const CHUNK = 33;
export const MAX_ACCOUNTING_REFS_PER_COMMIT = 6000; // larger commits need §24 (sidecar) first

const chunk = <T>(xs: T[], n: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
};

export type ValidateResult =
  | { ok: true; newRefs: RefWithSize[] }
  | { ok: false; needsUpload: string[] };

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
  const have = new Set<string>(); // entitled AND present=1
  for (const c of chunk(shas, 90)) {
    const ph = c.map(() => "?").join(",");
    const rows = await db
      .prepare(
        `SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
         WHERE r.account_id = ? AND b.present = 1 AND r.sha256 IN (${ph})`,
      )
      .bind(accountId, ...c)
      .all<{ sha256: string }>();
    for (const row of rows.results ?? []) have.add(row.sha256);
  }

  const newRefs: RefWithSize[] = [];
  const needsUpload: string[] = [];
  for (const sha of shas) {
    if (have.has(sha)) continue;
    const r = receipts[sha];
    if (!r) {
      needsUpload.push(sha);
      continue;
    }
    const v = await verifyReceipt(env, r, { accountId, encSha: sha, nowMs });
    if (!v.ok) needsUpload.push(sha);
    else newRefs.push({ sha, size: v.size });
  }
  if (needsUpload.length > 0) return { ok: false, needsUpload };
  return { ok: true, newRefs };
}

export type AccountingResult = { ok: true } | { overCap: { used: number; cap: number } };

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

  // 1. One transactional batch: per chunk → catalog(present=1) → charge(NOT-EXISTS)
  //    → grant(refresh granted_at) → un-condemn. Statements run in order within the txn,
  //    so a later chunk's NOT-EXISTS sees earlier chunks' grants (no double-charge).
  const stmts: D1PreparedStatement[] = [];
  for (const c of chunk(newRefs, CHUNK)) {
    const shas = c.map((r) => r.sha);
    const inList = shas.map(() => "?").join(",");
    // Direct-write (§23.2 v2): PUT already wrote the canonical object, so catalog present=1
    // immediately — no promote, no present=0 window. Atomic with charge+grant in this batch.
    stmts.push(
      db
        .prepare(`INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES ${c.map(() => "(?,?,1)").join(",")}`)
        .bind(...c.flatMap((r) => [r.sha, r.size])),
    );
    stmts.push(
      db
        .prepare(
          `UPDATE accounts SET used_bytes = used_bytes + (
             SELECT COALESCE(SUM(b.size_bytes),0) FROM blobs b
              WHERE b.sha256 IN (${inList})
                AND NOT EXISTS (SELECT 1 FROM blob_refs r WHERE r.account_id=? AND r.sha256=b.sha256))
           WHERE id = ?`,
        )
        .bind(...shas, accountId, accountId),
    );
    stmts.push(
      db
        .prepare(
          `INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES ${c.map(() => `(?,?,${nowMs})`).join(",")}
           ON CONFLICT(account_id, sha256) DO UPDATE SET granted_at = excluded.granted_at`,
        )
        .bind(...c.flatMap((r) => [accountId, r.sha])),
    );
    // Un-condemn: a re-uploaded blob clears its GC candidacy (the canonical object is fresh).
    stmts.push(db.prepare(`DELETE FROM gc_candidates WHERE sha256 IN (${inList})`).bind(...shas));
  }

  try {
    // `db` is the §25 span-wrapped binding — the Proxy times+counts batch() itself,
    // so we do NOT wrap in span.d1() (that would double-count).
    await db.batch(stmts);
  } catch (e) {
    // accounts_cap_guard RAISE(ABORT,'over_cap') → the whole batch rolled back.
    if (e instanceof Error && /over_cap/i.test(e.message)) {
      const acc = await db.prepare("SELECT used_bytes, cap_bytes FROM accounts WHERE id=?").bind(accountId).first<{
        used_bytes: number;
        cap_bytes: number;
      }>();
      return { overCap: { used: Number(acc?.used_bytes ?? 0), cap: Number(acc?.cap_bytes ?? 0) } };
    }
    throw e;
  }

  // Direct-write: NO promote phase. The bytes are already at the canonical key (the PUT
  // wrote them, §23.2 v2), and the batch above cataloged present=1 + charged + granted
  // atomically. The commit is now O(chunks) D1 work with zero R2 ops — eliminating the
  // serial O(N) staging→canonical copy that made §23 regress at scale (codex scaling review).
  return { ok: true };
}
