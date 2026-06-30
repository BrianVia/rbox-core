import type { Env } from "./env.js";
import { json, logErr } from "./util.js";
import { dbFor } from "./db.js";

// §33 Phase 1 — per-account reachability GC (the leak-closing, shardable, cron-safe
// phase). PURE D1: it reclaims a `blob_refs` row + its `used_bytes` charge for refs
// that are no longer reachable from the account's authoritative DO roots. It touches
// NO R2 — it only CONDEMNS a now-globally-unreferenced blob into `gc_candidates` for
// the existing manual/quiescent Phase 2 (canonical R2) sweep (worker.ts, versions.ts).
//
// This closes the design 30 §3 / design 07b §d entitlement leak (over-cap partial
// charges + head-409 orphans that stranded `blob_refs` + `used_bytes` forever).
//
// The barrier that makes purge cron-safe is the candidate-aware commit preflight
// (`markedCandidateSet` below, consulted by validateCommitRefs / blobsCheck /
// missingBlobs): a marked (account, sha) reads as NOT-satisfied → re-grant → the
// marker is cleared (commit-accounting.ts + billing.ts). `granted_at`/`marked_at`
// grace is only a secondary skip + defense-in-depth, NOT the correctness argument.

/** §33 round-1: the per-account prune-candidate set for `shas`, the entitlement-level
 *  analog of the `gc_candidates` consultation. The commit preflight subtracts this
 *  from its "have" set so a marked ref forces a re-grant (which clears the marker). */
export async function markedCandidateSet(db: D1Database, accountId: string, shas: string[]): Promise<Set<string>> {
  const marked = new Set<string>();
  for (let i = 0; i < shas.length; i += 80) {
    const chunk = shas.slice(i, i + 80);
    if (chunk.length === 0) break;
    const ph = chunk.map(() => "?").join(",");
    const rows = await db
      .prepare(`SELECT sha256 FROM blob_ref_candidates WHERE account_id = ? AND sha256 IN (${ph})`)
      .bind(accountId, ...chunk)
      .all<{ sha256: string }>();
    for (const r of rows.results ?? []) marked.add(r.sha256);
  }
  return marked;
}

/**
 * §33 §3.1 — the per-account reachable set, from AUTHORITATIVE DO roots. Enumerate the
 * account's workspaces (a shard-local `WHERE account_id = ?` lookup) and ask each
 * per-(workspace, project) WorkspaceSync DO for its retained roots, unioning every
 * `encManifestSha` + referenced `encSha`. FAIL CLOSED PER ACCOUNT: any unreadable DO
 * (`roots_incomplete` 409, retained gap, unreadable sidecar) THROWS, aborting only
 * THIS account's GC — every other account stays collectible (the §32 sharding win).
 */
export async function perAccountReachable(env: Env, accountId: string): Promise<Set<string>> {
  const reachable = new Set<string>();
  const wss = await dbFor(env, accountId)
    .prepare("SELECT workspace_id, project_id FROM workspaces WHERE account_id = ?")
    .bind(accountId)
    .all<{ workspace_id: string; project_id: string }>();
  for (const w of wss.results ?? []) {
    const id = env.WORKSPACE_SYNC.idFromName(`${w.workspace_id}/${w.project_id}`);
    const res = await env.WORKSPACE_SYNC.get(id).fetch(`https://do/v1/ws/${w.workspace_id}/proj/${w.project_id}/roots`);
    // Fail closed: a single unreadable DO must NOT make this account's refs look
    // unreachable (that would wrongly reclaim live entitlements). Abort this account.
    if (!res.ok) throw new Error(`phase1 reachable abort (fail-closed): cannot read roots for ${w.workspace_id}/${w.project_id} (acct ${accountId})`);
    const { roots } = (await res.json()) as { roots: Array<{ encManifestSha: string; encShas: string[] }> };
    for (const r of roots) {
      if (r.encManifestSha) reachable.add(r.encManifestSha);
      for (const s of r.encShas) reachable.add(s);
    }
  }
  return reachable;
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
  const refs = await db
    .prepare("SELECT sha256, granted_at FROM blob_refs WHERE account_id = ?")
    .bind(accountId)
    .all<{ sha256: string; granted_at: number }>();
  let marked = 0;
  for (const ref of refs.results ?? []) {
    if (reachable.has(ref.sha256)) continue; // still needed → never mark
    if (nowMs - Number(ref.granted_at) < graceMs) continue; // cheap skip of fresh refs
    const r = await db
      .prepare("INSERT OR IGNORE INTO blob_ref_candidates (account_id, sha256, marked_at) VALUES (?, ?, ?)")
      .bind(accountId, ref.sha256, nowMs)
      .run();
    marked += r.meta.changes ?? 0;
  }
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
  const cands = await db
    .prepare("SELECT sha256, marked_at FROM blob_ref_candidates WHERE account_id = ?")
    .bind(accountId)
    .all<{ sha256: string; marked_at: number }>();
  let purged = 0;
  let released = 0;
  let resurrected = 0;
  let condemned = 0;
  for (const cand of cands.results ?? []) {
    const sha = cand.sha256;
    if (reachable.has(sha)) {
      // Re-referenced since the mark (a deduped commit re-entered roots) → un-mark.
      await db.prepare("DELETE FROM blob_ref_candidates WHERE account_id = ? AND sha256 = ?").bind(accountId, sha).run();
      resurrected++;
      continue;
    }
    if (nowMs - Number(cand.marked_at) < graceMs) continue; // not past grace yet

    const sizeRow = await db.prepare("SELECT size_bytes FROM blobs WHERE sha256 = ?").bind(sha).first<{ size_bytes: number }>();
    const size = Number(sizeRow?.size_bytes ?? 0);

    // ATOMIC re-confirm + delete + conditional release (one db.batch = one transaction).
    // BOTH statements re-read `blob_ref_candidates` INSIDE the transaction (spec §3.3:
    // "re-read inside the delete transaction, never from the stale mark-pass list"). This
    // closes the race where a concurrent (re-)grant CLEARS the marker (un-condemns the ref)
    // between this purge's candidate snapshot and its delete: if the marker is gone the batch
    // no-ops, so we never drop a ref the commit path just re-established. The release also
    // requires the ref to still EXIST, and runs BEFORE the delete, so a crash can't drop the
    // row without the decrement, and two concurrent purges can't double-release (D1 serializes
    // the batch; the second sees the marker/ref already gone).
    const guard = "EXISTS (SELECT 1 FROM blob_ref_candidates WHERE account_id = ? AND sha256 = ?)";
    const batchRes = await db.batch([
      db
        .prepare(
          `UPDATE accounts SET used_bytes = MAX(0, used_bytes - ?) WHERE id = ? AND EXISTS (SELECT 1 FROM blob_refs WHERE account_id = ? AND sha256 = ?) AND ${guard}`,
        )
        .bind(size, accountId, accountId, sha, accountId, sha),
      db.prepare(`DELETE FROM blob_refs WHERE account_id = ? AND sha256 = ? AND ${guard}`).bind(accountId, sha, accountId, sha),
    ]);
    const dropped = (batchRes[1]?.meta.changes ?? 0) === 1;
    if (dropped) {
      purged++;
      released += size;
      // Last ref for this sha gone? `encSha` is account-unique (no cross-account
      // sharing), so once this account's last ref drops the blob is GLOBALLY
      // unreferenced. Condemn it for the MANUAL Phase 2 R2 sweep (never delete R2 here).
      const cnt = await db.prepare("SELECT COUNT(*) AS c FROM blob_refs WHERE sha256 = ?").bind(sha).first<{ c: number }>();
      if (Number(cnt?.c ?? 0) === 0) {
        const c = await db
          .prepare("INSERT OR IGNORE INTO gc_candidates (sha256, kind, marked_at) VALUES (?, 'blob', ?)")
          .bind(sha, nowMs)
          .run();
        condemned += c.meta.changes ?? 0;
      }
    }
    // Done with this candidate (dropped or already gone) → clear the marker.
    await db.prepare("DELETE FROM blob_ref_candidates WHERE account_id = ? AND sha256 = ?").bind(accountId, sha).run();
  }
  return { purged, released, resurrected, condemned };
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
    if (e instanceof Error && /over_cap/i.test(e.message)) return; // under-count correction blocked by the cap guard; retried next run
    throw e;
  }
}

/**
 * §33 §3.4 cron orchestration — per account: reachable (fail-closed) → mark → purge →
 * reconcile. One account's failure (e.g. an unreadable DO) is logged and skipped; it
 * never starves the rest (idempotent: mark is INSERT OR IGNORE, purge is conditional).
 * D1-only — Phase 2 (R2) stays the manual `/v1/admin/gc?phase=purge` sweep.
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
    } catch (e) {
      // Per-account fail-closed: one broken DO / transient error aborts only this
      // account (no raw message — touches account/blob metadata). Retried next run.
      failed++;
      logErr("phase1_account_failed", e);
    }
  }
  return json({ ok: true, accounts: accts.results?.length ?? 0, processed, failed, ...totals });
}
