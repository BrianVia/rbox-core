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
// §30: refs charged/granted per atomic db.batch(). Each batch() is ONE D1 subrequest and
// one SQLite transaction; this bounds its statement count (~MAX_REFS_PER_TXN/CHUNK·4 ≈ 364)
// so a single transaction stays within the D1 isolate's CPU/memory budget. A commit with
// more refs runs SEVERAL such batches in sequence — each independently atomic + cap-guarded,
// and (because accounting is idempotent + account-then-publish) crash-/retry-safe.
const MAX_REFS_PER_TXN = 3_000;
// Validate IN-list SELECTs (≤90 refs each) grouped per db.batch() — one subrequest per group.
const SELECTS_PER_BATCH = Math.ceil(MAX_REFS_PER_TXN / 90); // ~34
// §30: hard sanity reject on total refs in one commit (was 6002). The REAL ceiling is the D1
// isolate CPU/memory of the multi-batch pass + validate, not subrequests; validated against a
// 12k-blob real workload, 50k kept "behind dev measurement" (telemetry: §25 commit count/ms).
// The +carriers (encManifest, and §24 sidecar) ride within this bound — workspace-sync caps the
// data-ref count so count + carriers ≤ this. One source of truth for every ref ceiling.
export const MAX_REFS_PER_COMMIT = 50_000;

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
  // §30: entitled-AND-present read, batched. Each IN-list SELECT is ≤90 params; grouping them
  // into db.batch() calls (one D1 subrequest each) makes validating N refs cost ~N/(90·SELECTS_
  // PER_BATCH) subrequests instead of N/90 — the prior 90-per-round-trip loop was the subrequest
  // hog that bounded large commits (§30 limits analysis).
  const have = new Set<string>(); // entitled AND present=1
  const selects = chunk(shas, 90).map((c) =>
    db
      .prepare(
        `SELECT r.sha256 FROM blob_refs r JOIN blobs b ON b.sha256 = r.sha256
         WHERE r.account_id = ? AND b.present = 1 AND r.sha256 IN (${c.map(() => "?").join(",")})`,
      )
      .bind(accountId, ...c),
  );
  for (const group of chunk(selects, SELECTS_PER_BATCH)) {
    const results = await db.batch<{ sha256: string }>(group);
    for (const r of results) for (const row of r.results ?? []) have.add(row.sha256);
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

  // §30: charge+grant in SEQUENTIAL atomic super-batches of ≤MAX_REFS_PER_TXN refs. Each
  // db.batch() is one transaction (cap-guarded); a commit larger than one transaction runs
  // several. On over_cap, prior super-batches stay charged+granted — real, idempotent-
  // retryable entitlements, NOT rolled back (design 30 §3: no compensation). The within-
  // batch ordering (catalog present=1 → charge NOT-EXISTS → grant → un-condemn) is unchanged,
  // so a later chunk's NOT-EXISTS still sees earlier chunks' grants (no double-charge).
  for (const superBatch of chunk(newRefs, MAX_REFS_PER_TXN)) {
    const stmts: D1PreparedStatement[] = [];
    for (const c of chunk(superBatch, CHUNK)) {
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
      // accounts_cap_guard RAISE(ABORT,'over_cap') → THIS super-batch rolled back; earlier
      // ones stayed committed (design 30 §3). Report over-cap; the client gets a 402.
      if (e instanceof Error && /over_cap/i.test(e.message)) {
        const acc = await db.prepare("SELECT used_bytes, cap_bytes FROM accounts WHERE id=?").bind(accountId).first<{
          used_bytes: number;
          cap_bytes: number;
        }>();
        return { overCap: { used: Number(acc?.used_bytes ?? 0), cap: Number(acc?.cap_bytes ?? 0) } };
      }
      throw e;
    }
  }

  // Direct-write: NO promote phase. The bytes are already at the canonical key (the PUT
  // wrote them, §23.2 v2), and the batches above cataloged present=1 + charged + granted
  // atomically. The commit is O(chunks) D1 work with zero R2 ops.
  return { ok: true };
}
