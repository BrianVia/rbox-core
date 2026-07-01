// §30/§33 — the shared batched-dispatch idiom for the push preflight's IN-list
// presence/entitlement reads. `blobsCheck` (POST /v1/blobs/check), `entitledSubset`,
// and workspace-sync's `missingBlobs` all used to await one 80-sha chunk per D1
// round-trip in a serial `for (i += 80)` loop — the preflight ran ~50 sequential D1
// hops before a single blob upload started (measured worst op: p50 1134ms, ~100% D1).
// This groups those per-chunk SELECTs into `db.batch()` calls (one D1 subrequest per
// group), exactly as `validateCommitRefs` already does for the commit path with a
// byte-identical query. Only the DISPATCH changes — query text, chunk math, and the
// caller's ordered result construction are untouched.
//
// A NEUTRAL module (not `commit-accounting.ts`) on purpose: importing that file into
// `authz.ts` would close an import cycle (commit-accounting → auth → authz). A little
// constant duplication here beats touching the commit hot path.

// D1 caps bound params at ≤100/statement. The preflight SELECTs bind an 80-sha IN-list
// plus at most one accountId → ≤81 params, with headroom. KEEP 80: it is the chunk size
// the serial loops used, so the set-membership math and results stay identical.
export const IN_LIST_CHUNK = 80;

// IN-list SELECTs grouped per `db.batch()` call. Each `db.batch()` is ONE D1 subrequest
// and ONE SQLite transaction, so this bounds the statements (and thus CPU/memory) inside
// a single transaction to stay within the D1 isolate's budget. Mirrors commit-accounting's
// SELECTS_PER_BATCH (≈ MAX_REFS_PER_TXN 3000 / 90); a group here covers 34·80 = 2720 shas.
export const STMTS_PER_BATCH = 34;

/**
 * Run an IN-list SELECT over `keys` in {@link IN_LIST_CHUNK}-sized chunks, dispatching
 * the per-chunk prepared statements in `db.batch()` groups of ≤{@link STMTS_PER_BATCH}
 * (one D1 subrequest per group) instead of awaiting each chunk serially. Rows from each
 * group are handed to `onRows` as they arrive; the CALLER builds its result from the
 * original `keys` order (never DB row order), so dispatch order is invisible.
 *
 * `/v1/blobs/check` has NO cap on key count, so the prepared-statement objects are built
 * ONE GROUP AT A TIME (bounded memory) — the cheap 80-key string slices are fine, an
 * unbounded up-front array of statements is not.
 *
 * `db.batch()` is transactional/ordered and rolls back on failure, so a query error
 * bubbles to the Worker boundary exactly as the prior serial `await` did (no try/catch).
 */
export async function batchedInLookup<T>(
  db: D1Database,
  keys: string[],
  makeStmt: (chunk: string[]) => D1PreparedStatement,
  onRows: (rows: T[]) => void,
): Promise<void> {
  let group: D1PreparedStatement[] = [];
  const flush = async () => {
    if (group.length === 0) return;
    for (const r of await db.batch<T>(group)) onRows(r.results ?? []);
    group = [];
  };
  for (let i = 0; i < keys.length; i += IN_LIST_CHUNK) {
    const chunk = keys.slice(i, i + IN_LIST_CHUNK);
    if (chunk.length === 0) break;
    group.push(makeStmt(chunk));
    if (group.length === STMTS_PER_BATCH) await flush();
  }
  await flush();
}
