import { env, SELF, applyD1Migrations } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { PHASE1_MAX_ROWS, phase1Audit, phase1Mark, phase1Purge, reconcileUsage, perAccountReachable, runPhase1 } from "../src/gc-phase1.js";
import { validateCommitRefs, commitAccounting } from "../src/commit-accounting.js";
import { grantEntitlementWithQuota } from "../src/billing.js";
import { mintReceipt, RECEIPT_TTL_MS } from "../src/receipts.js";

// §33 Phase 1 — per-account entitlement GC, against real workerd D1 (mirrors
// spike-d1-charge.test.ts). Reachability is injected as a Set (exactly what
// perAccountReachable returns from DO roots); the per-account fail-closed property is
// exercised via an explicitly broken DO namespace stub (runtime-independent — the old
// fixture leaned on the pre-2026 pool runtime lacking storage.kv).

const db = () => env.rbox_dev_db;
const NOW = 1_700_000_000_000;
const HOUR = 3_600_000;
const EMPTY = new Set<string>();

function countingDb(d1: D1Database): { db: D1Database; calls: () => number } {
  let count = 0;
  const wrapStmt = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        if (prop === "bind") return (...args: unknown[]) => wrapStmt((target.bind as (...xs: unknown[]) => D1PreparedStatement)(...args));
        if (prop === "run" || prop === "first" || prop === "all" || prop === "raw") {
          return (...args: unknown[]) => {
            count++;
            return (target[prop as "run"] as (...xs: unknown[]) => Promise<unknown>)(...args);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  return {
    db: new Proxy(d1, {
      get(target, prop, receiver) {
        if (prop === "prepare") return (sql: string) => wrapStmt(target.prepare(sql));
        if (prop === "batch") return (statements: D1PreparedStatement[]) => {
          count++;
          return target.batch(statements);
        };
        return Reflect.get(target, prop, receiver);
      },
    }),
    calls: () => count,
  };
}

async function mkAccount(id: string, capBytes = 1_000_000_000) {
  await db()
    .prepare(`INSERT INTO accounts(id, plan, created_at, used_bytes, extra_storage_bytes, cap_bytes) VALUES (?, 'pro', ?, 0, 0, ?)`)
    .bind(id, NOW, capBytes)
    .run();
}
const addBlob = (sha: string, size: number) =>
  db().prepare("INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES (?, ?, 1)").bind(sha, size).run();
// Charge a ref the way a grant would (present blob + entitlement + used_bytes bump).
async function addRef(acct: string, sha: string, size: number, grantedAt = NOW) {
  await addBlob(sha, size);
  await db().prepare("INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES (?, ?, ?)").bind(acct, sha, grantedAt).run();
  await db().prepare("UPDATE accounts SET used_bytes = used_bytes + ? WHERE id = ?").bind(size, acct).run();
}
const mark = (acct: string, sha: string, at = NOW) =>
  db().prepare("INSERT OR IGNORE INTO blob_ref_candidates(account_id, sha256, marked_at) VALUES (?, ?, ?)").bind(acct, sha, at).run();

const SEED_INSERT_CHUNK = 33; // 3 params/row stays within D1's 100-param statement limit.
async function seedRefs(
  acct: string,
  refs: Array<{ sha: string; size: number; grantedAt: number }>,
  markedAt?: number,
) {
  const chunks = Array.from({ length: Math.ceil(refs.length / SEED_INSERT_CHUNK) }, (_, i) =>
    refs.slice(i * SEED_INSERT_CHUNK, (i + 1) * SEED_INSERT_CHUNK),
  );
  await db().batch(chunks.map((chunk) =>
    db()
      .prepare(`INSERT OR IGNORE INTO blobs(sha256, size_bytes, present) VALUES ${chunk.map(() => "(?, ?, 1)").join(", ")}`)
      .bind(...chunk.flatMap(({ sha, size }) => [sha, size])),
  ));
  await db().batch(chunks.map((chunk) =>
    db()
      .prepare(`INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`)
      .bind(...chunk.flatMap(({ sha, grantedAt }) => [acct, sha, grantedAt])),
  ));
  if (markedAt !== undefined) {
    await db().batch(chunks.map((chunk) =>
      db()
        .prepare(`INSERT OR IGNORE INTO blob_ref_candidates(account_id, sha256, marked_at) VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`)
        .bind(...chunk.flatMap(({ sha }) => [acct, sha, markedAt])),
    ));
  }
  await db()
    .prepare("UPDATE accounts SET used_bytes = used_bytes + ? WHERE id = ?")
    .bind(refs.reduce((sum, { size }) => sum + size, 0), acct)
    .run();
}

const used = async (id: string) => Number((await db().prepare("SELECT used_bytes FROM accounts WHERE id=?").bind(id).first())!.used_bytes);
const refExists = async (acct: string, sha: string) => !!(await db().prepare("SELECT 1 FROM blob_refs WHERE account_id=? AND sha256=?").bind(acct, sha).first());
const candExists = async (acct: string, sha: string) => !!(await db().prepare("SELECT 1 FROM blob_ref_candidates WHERE account_id=? AND sha256=?").bind(acct, sha).first());
const gcCondemned = async (sha: string) => !!(await db().prepare("SELECT 1 FROM gc_candidates WHERE sha256=?").bind(sha).first());
const grantedAt = async (acct: string, sha: string) => Number((await db().prepare("SELECT granted_at FROM blob_refs WHERE account_id=? AND sha256=?").bind(acct, sha).first())!.granted_at);

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});
beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM blob_ref_candidates"),
    db().prepare("DELETE FROM gc_candidates"),
    db().prepare("DELETE FROM blob_refs"),
    db().prepare("DELETE FROM blobs"),
    db().prepare("DELETE FROM accounts"),
    db().prepare("DELETE FROM workspaces"),
    db().prepare("DELETE FROM gc_state"),
  ]);
});

describe("§33 mark → grace → purge (the leak fix)", () => {
  it("chunks 200 unreachable candidates within the phase-1 D1 subrequest budget", async () => {
    await mkAccount("a");
    for (let i = 0; i < 200; i++) {
      const sha = `budget-dead-${String(i).padStart(3, "0")}`;
      await addRef("a", sha, 1, NOW - 4 * HOUR);
      await mark("a", sha, NOW - 2 * HOUR);
    }
    const counted = countingDb(db());
    const result = await phase1Purge(counted.db, "a", EMPTY, HOUR, NOW);
    expect(result.purged).toBe(200);
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_ref_candidates").first())!.n)).toBe(0);
    // cursor read + page + 7 purge batches + 3 condemn probes + 7 inserts + cursor write = 20.
    expect(counted.calls()).toBeLessThanOrEqual(25);
  });

  it("chunks 200 reachable candidates within the phase-1 D1 subrequest budget", async () => {
    await mkAccount("a");
    const reachable = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const sha = `budget-live-${String(i).padStart(3, "0")}`;
      reachable.add(sha);
      await addRef("a", sha, 1, NOW - 4 * HOUR);
      await mark("a", sha, NOW - 2 * HOUR);
    }
    const counted = countingDb(db());
    const result = await phase1Purge(counted.db, "a", reachable, HOUR, NOW);
    expect(result).toMatchObject({ purged: 0, resurrected: 200 });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_ref_candidates").first())!.n)).toBe(0);
    // cursor read + page + 7 resurrection batches + cursor write = 10.
    expect(counted.calls()).toBeLessThanOrEqual(25);
  });

  it("keeps route-level phase-1 dry-run and live grace handling in parity", async () => {
    const platform = { "x-rbox-platform": "test-platform-secret" };
    const realNow = Date.now();
    await mkAccount("route-grace");
    await addRef("route-grace", "route-expired", 7, realNow - 2 * 24 * HOUR);
    await mark("route-grace", "route-expired", realNow - 2 * 24 * HOUR);

    const shortAudit = await SELF.fetch("https://example.com/v1/admin/gc?phase=phase1&dryRun=1&graceMs=86400000", { method: "POST", headers: platform });
    expect(shortAudit.status).toBe(200);
    expect(await shortAudit.json()).toMatchObject({ wouldPurge: 1 });
    const shortLive = await SELF.fetch("https://example.com/v1/admin/gc?phase=phase1&graceMs=86400000", { method: "POST", headers: platform });
    expect(shortLive.status).toBe(200);
    expect(await shortLive.json()).toMatchObject({ purged: 1, failed: 0 });
    expect(await refExists("route-grace", "route-expired")).toBe(false);

    await addRef("route-grace", "route-default", 7, realNow - 2 * 24 * HOUR);
    await mark("route-grace", "route-default", realNow - 2 * 24 * HOUR);
    const defaultAudit = await SELF.fetch("https://example.com/v1/admin/gc?phase=phase1&dryRun=1", { method: "POST", headers: platform });
    expect(defaultAudit.status).toBe(200);
    expect(await defaultAudit.json()).toMatchObject({ wouldPurge: 0 });
    const defaultLive = await SELF.fetch("https://example.com/v1/admin/gc?phase=phase1", { method: "POST", headers: platform });
    expect(defaultLive.status).toBe(200);
    expect(await defaultLive.json()).toMatchObject({ purged: 0, failed: 0 });
    expect(await refExists("route-grace", "route-default")).toBe(true);
  });

  it("bounds and advances phase-1 mark cursor across pages", async () => {
    await mkAccount("a");
    await seedRefs("a", Array.from({ length: PHASE1_MAX_ROWS + 1 }, (_, i) => ({
      sha: `m${String(i).padStart(4, "0")}`,
      size: 1,
      grantedAt: NOW - 2 * HOUR,
    })));
    expect((await phase1Mark(db(), "a", EMPTY, HOUR, NOW)).marked).toBe(PHASE1_MAX_ROWS);
    expect((await phase1Mark(db(), "a", EMPTY, HOUR, NOW)).marked).toBe(1);
  });

  it("bounds and drains phase-1 purge cursor across pages", async () => {
    await mkAccount("a");
    await seedRefs("a", Array.from({ length: PHASE1_MAX_ROWS + 1 }, (_, i) => ({
      sha: `p${String(i).padStart(4, "0")}`,
      size: 1,
      grantedAt: NOW - 4 * HOUR,
    })), NOW - 2 * HOUR);
    const first = await phase1Purge(db(), "a", EMPTY, HOUR, NOW);
    expect(first.purged).toBe(PHASE1_MAX_ROWS);
    const second = await phase1Purge(db(), "a", EMPTY, HOUR, NOW);
    expect(second.purged).toBe(1);
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_ref_candidates").first())!.n)).toBe(0);
  });

  it("isolates phase-1 purge cursors per account", async () => {
    await mkAccount("small");
    await mkAccount("large");
    await seedRefs("large", Array.from({ length: PHASE1_MAX_ROWS + 1 }, (_, i) => ({
      sha: `large-${String(i).padStart(4, "0")}`,
      size: 1,
      grantedAt: NOW - 4 * HOUR,
    })), NOW - 2 * HOUR);
    for (let i = 0; i < 3; i++) {
      const sha = `small-${i}`;
      await addRef("small", sha, 1, NOW - 4 * HOUR);
      await mark("small", sha, NOW - 2 * HOUR);
    }

    expect((await phase1Purge(db(), "small", EMPTY, HOUR, NOW)).purged).toBe(3);
    expect((await phase1Purge(db(), "large", EMPTY, HOUR, NOW)).purged).toBe(PHASE1_MAX_ROWS);

    const cursors = await db()
      .prepare("SELECT k, v FROM gc_state WHERE k IN (?, ?) ORDER BY k")
      .bind("p1_purge_cursor:large", "p1_purge_cursor:small")
      .all<{ k: string; v: string }>();
    expect(cursors.results).toEqual([
      { k: "p1_purge_cursor:large", v: JSON.stringify(`large-${String(PHASE1_MAX_ROWS - 1).padStart(4, "0")}`) },
      { k: "p1_purge_cursor:small", v: JSON.stringify("") },
    ]);

    expect((await phase1Purge(db(), "large", EMPTY, HOUR, NOW)).purged).toBe(1);
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_ref_candidates").first())!.n)).toBe(0);
  });

  it("audits phase-1 candidates read-only with resurrection, purge, and release totals", async () => {
    await mkAccount("a");
    await addRef("a", "live", 5, NOW - 3 * HOUR);
    await addRef("a", "dead", 7, NOW - 3 * HOUR);
    await mark("a", "live", NOW - 2 * HOUR);
    await mark("a", "dead", NOW - 2 * HOUR);
    const before = Number((await db().prepare("SELECT COUNT(*) n FROM blob_ref_candidates").first())!.n);
    const fakeEnv = { ...env, WORKSPACE_SYNC: { ...env.WORKSPACE_SYNC } };
    // No workspaces means per-account reachability is empty; add a focused roots fixture for live.
    await db().prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES ('w','p','a',?)").bind(NOW).run();
    fakeEnv.WORKSPACE_SYNC = { idFromName: (n: string) => env.WORKSPACE_SYNC.idFromName(n), get: () => ({ fetch: async () => Response.json({ head: 1, pruneFloor: 0, indexGeneration: 1, indexSyncedSeq: 1, gap: [{ seq: 1, manifestSha: "live", chainRefs: [] }], droppedPage: [], seqRootsPage: [] }) }) } as unknown as DurableObjectNamespace;
    const audit = await phase1Audit(fakeEnv, HOUR, null, 10, NOW).then((r) => r.json()) as Record<string, number>;
    expect(audit).toMatchObject({ examined: 2, wouldResurrect: 1, wouldPurge: 1, wouldRelease: 7 });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM blob_ref_candidates").first())!.n)).toBe(before);
    expect(await refExists("a", "dead")).toBe(true);
  });
  it("keeps every chain link returned by a live retained head out of phase-1 condemnation", async () => {
    await mkAccount("chain-live");
    const chain = ["chain-live-a", "chain-live-b"];
    for (const link of chain) await addRef("chain-live", link, 10, NOW - 2 * HOUR);
    await db().prepare("INSERT INTO workspaces(workspace_id, project_id, account_id, created_at) VALUES ('ws_chain', 'root', 'chain-live', ?)").bind(NOW).run();
    const rootsDO = {
      idFromName: (name: string) => env.WORKSPACE_SYNC.idFromName(name),
      get: () => ({ fetch: async () => Response.json({
        head: 1, pruneFloor: 0, indexGeneration: 1, indexSyncedSeq: 1,
        gap: [{ seq: 1, manifestSha: "manifest-live", chainRefs: chain }],
        droppedPage: [], seqRootsPage: [],
      }) }),
    } as unknown as DurableObjectNamespace;
    const reachable = await perAccountReachable({ ...env, WORKSPACE_SYNC: rootsDO }, "chain-live");

    expect([...reachable]).toEqual(expect.arrayContaining(["manifest-live", ...chain]));
    expect((await phase1Mark(db(), "chain-live", reachable, HOUR, NOW)).marked).toBe(0);
    for (const link of chain) expect(await candExists("chain-live", link)).toBe(false);
  });

  it("marks an unreachable ref, sweeps it after grace, releases exactly its bytes, condemns the last ref", async () => {
    await mkAccount("a");
    await addRef("a", "x", 100, NOW - 2 * HOUR); // stale (granted_at past grace)
    expect(await used("a")).toBe(100);

    // reachable empty (x has fallen out of every retained root)
    expect((await phase1Mark(db(), "a", EMPTY, HOUR, NOW)).marked).toBe(1);
    expect(await candExists("a", "x")).toBe(true);

    // purge at the mark instant → not past grace → nothing dropped
    let p = await phase1Purge(db(), "a", EMPTY, HOUR, NOW);
    expect(p.purged).toBe(0);
    expect(await refExists("a", "x")).toBe(true);
    expect(await used("a")).toBe(100);

    // purge past grace → dropped, used_bytes -100, condemned (global last ref)
    p = await phase1Purge(db(), "a", EMPTY, HOUR, NOW + 2 * HOUR);
    expect(p).toMatchObject({ purged: 1, released: 100, condemned: 1, resurrected: 0 });
    expect(await refExists("a", "x")).toBe(false);
    expect(await used("a")).toBe(0);
    expect(await gcCondemned("x")).toBe(true); // handed to the MANUAL Phase 2 R2 sweep

    // idempotent: re-mark/re-purge releases 0 (the second DELETE sees 0 changes)
    await phase1Mark(db(), "a", EMPTY, HOUR, NOW + 3 * HOUR);
    const p2 = await phase1Purge(db(), "a", EMPTY, HOUR, NOW + 5 * HOUR);
    expect(p2.purged).toBe(0);
    expect(p2.released).toBe(0);
    expect(await used("a")).toBe(0); // no double-release
  });

  it("an orphan marker (no blob_refs row) releases nothing and is cleaned (EXISTS-guard)", async () => {
    await mkAccount("a");
    await db().prepare("UPDATE accounts SET used_bytes = 500 WHERE id = 'a'").run(); // pre-existing usage, unrelated
    await addBlob("x", 100); // a blobs row exists, but account a has NO blob_refs row for x
    await mark("a", "x", NOW - 2 * HOUR); // stale orphan marker
    const p = await phase1Purge(db(), "a", EMPTY, HOUR, NOW);
    expect(p.purged).toBe(0); // nothing dropped — no ref existed
    expect(p.released).toBe(0); // and crucially, NO release (the EXISTS(blob_refs) guard)
    expect(await used("a")).toBe(500); // untouched
    expect(await candExists("a", "x")).toBe(false); // orphan marker cleaned
  });

  it("a candidate that re-enters roots before sweep is un-marked, never reclaimed", async () => {
    await mkAccount("a");
    await addRef("a", "x", 100, NOW - 2 * HOUR);
    await mark("a", "x", NOW);
    // x became reachable again (a deduped commit re-referenced it; head advanced) → reachable has it
    const p = await phase1Purge(db(), "a", new Set(["x"]), HOUR, NOW + 2 * HOUR);
    expect(p).toMatchObject({ purged: 0, resurrected: 1 });
    expect(await candExists("a", "x")).toBe(false); // un-marked
    expect(await refExists("a", "x")).toBe(true);
    expect(await used("a")).toBe(100); // not released
  });

  it("only refs absent from the UNION of all workspaces' roots are pruned (multi-workspace)", async () => {
    await mkAccount("a");
    await addRef("a", "a1", 10, NOW - 2 * HOUR);
    await addRef("a", "a2", 20, NOW - 2 * HOUR);
    await addRef("a", "b1", 30, NOW - 2 * HOUR);
    expect(await used("a")).toBe(60);
    // b1 still reachable from workspace B; a1/a2 fell out of workspace A's retention.
    const reachable = new Set(["b1"]);
    await phase1Mark(db(), "a", reachable, HOUR, NOW);
    expect(await candExists("a", "a1")).toBe(true);
    expect(await candExists("a", "b1")).toBe(false); // reachable → never marked
    const p = await phase1Purge(db(), "a", reachable, HOUR, NOW + 2 * HOUR);
    expect(p.purged).toBe(2);
    expect(p.released).toBe(30);
    expect(await refExists("a", "b1")).toBe(true); // survives GC
    expect(await used("a")).toBe(30);
  });
});

describe("§33 cross-account safety (condemn only on the GLOBAL last ref)", () => {
  it("never condemns a sha another account still references; condemns once it's globally unreferenced", async () => {
    await mkAccount("a");
    await mkAccount("b");
    await addRef("a", "x", 100, NOW - 2 * HOUR);
    await addRef("b", "x", 100, NOW - 2 * HOUR); // (hypothetical: encSha is account-unique; the COUNT guard must hold anyway)

    await phase1Mark(db(), "a", EMPTY, HOUR, NOW);
    const pa = await phase1Purge(db(), "a", EMPTY, HOUR, NOW + 2 * HOUR);
    expect(pa.purged).toBe(1);
    expect(pa.condemned).toBe(0); // b still holds x → COUNT>0 → NOT condemned
    expect(await gcCondemned("x")).toBe(false);
    expect(await refExists("b", "x")).toBe(true); // account b untouched
    expect(await used("b")).toBe(100);

    await phase1Mark(db(), "b", EMPTY, HOUR, NOW);
    const pb = await phase1Purge(db(), "b", EMPTY, HOUR, NOW + 2 * HOUR);
    expect(pb.condemned).toBe(1); // now globally unreferenced
    expect(await gcCondemned("x")).toBe(true);
  });
});

describe("§33 candidate-aware commit barrier (the dedup-race fix)", () => {
  it("a marked ref reads NOT-satisfied in validateCommitRefs and is re-granted, clearing the marker", async () => {
    await mkAccount("a");
    await addRef("a", "x", 100, NOW); // entitled + present + charged
    const enc = env.RBOX_RECEIPT_KEY; // present in test env (sanity)
    expect(enc).toBeTruthy();

    // BROKEN-DESIGN BASELINE: with NO marker, a deduped commit excludes x from newRefs →
    // commitAccounting never runs → granted_at is NOT bumped. This is exactly why a
    // `granted_at < cutoff` purge guard is unsound (the regression guard).
    const baseline = await validateCommitRefs(env, db(), "a", ["x"], {}, NOW);
    expect(baseline).toEqual({ ok: true, newRefs: [] });

    // Phase 1 marks x (it fell out of roots).
    await mark("a", "x", NOW);

    // candidate-aware validate: x is now not-satisfied. With no receipt → needsUpload.
    const unsat = await validateCommitRefs(env, db(), "a", ["x"], {}, NOW);
    expect(unsat.ok).toBe(false);
    if (!unsat.ok) expect(unsat.needsUpload).toEqual(["x"]);

    // Client re-stages → fresh receipt → x is re-granted (enters newRefs).
    const receiptNow = Date.now();
    const receipt = await mintReceipt(env, { accountId: "a", encSha: "x", size: 100, nowMs: receiptNow });
    const v = await validateCommitRefs(env, db(), "a", ["x"], { x: receipt }, receiptNow);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.newRefs.map((r) => r.sha)).toEqual(["x"]);
      expect(v.newRefs[0]!.receiptExpiresAt).toBe(receiptNow + RECEIPT_TTL_MS);
    }

    // commitAccounting re-grants: clears the marker + re-stamps granted_at, charges 0 (dedup).
    if (v.ok) {
      const r = await commitAccounting(db(), "a", v.newRefs, NOW + 5000);
      expect(r).toEqual({ ok: true });
    }
    expect(await candExists("a", "x")).toBe(false); // marker cleared atomically with the grant
    expect(await grantedAt("a", "x")).toBe(NOW + 5000); // lease re-stamped
    expect(await used("a")).toBe(100); // NO double charge (still entitled, NOT-EXISTS)

    // A later purge (reachable empty) does NOT drop it — the candidate row is gone.
    const p = await phase1Purge(db(), "a", EMPTY, HOUR, NOW + 100 * HOUR);
    expect(p.purged).toBe(0);
    expect(await refExists("a", "x")).toBe(true);
  });

  it("a legacy re-upload (grantEntitlementWithQuota already-entitled branch) clears the marker + re-stamps granted_at", async () => {
    await mkAccount("a");
    await addRef("a", "x", 100, NOW - 2 * HOUR);
    await mark("a", "x", NOW);

    // legacy blobPut re-upload → grant on an already-entitled ref (INSERT OR IGNORE → 0 changes branch).
    const g = await grantEntitlementWithQuota(env, "a", "x", 100, NOW + 1000);
    expect(g.granted).toBe(true);
    expect(await candExists("a", "x")).toBe(false); // round-3 fix: un-marked on the already-entitled path
    expect(await grantedAt("a", "x")).toBe(NOW + 1000);
    expect(await used("a")).toBe(100); // no double charge

    const p = await phase1Purge(db(), "a", EMPTY, HOUR, NOW + 100 * HOUR);
    expect(p.purged).toBe(0); // nothing to purge — the marker was cleared
    expect(await refExists("a", "x")).toBe(true);
  });

  it("grantEntitlementWithQuota stamps a real granted_at on a fresh grant (hygiene fix)", async () => {
    await mkAccount("a");
    await addBlob("x", 100);
    const g = await grantEntitlementWithQuota(env, "a", "x", 100, NOW + 7);
    expect(g.granted).toBe(true);
    expect(await grantedAt("a", "x")).toBe(NOW + 7); // NOT the SQLite default 0
    expect(await used("a")).toBe(100);
  });
});

describe("§33 grantEntitlementWithQuota atomicity (codex round-1 findings)", () => {
  it("over-cap grant rolls the WHOLE batch back (no ref, no charge, no marker clear)", async () => {
    await mkAccount("a", 25); // cap 25; a 30-byte grant must abort
    await addBlob("x", 30);
    await mark("a", "x"); // a stale marker that must SURVIVE a failed grant (nothing was granted)
    const g = await grantEntitlementWithQuota(env, "a", "x", 30, NOW);
    expect(g.granted).toBe(false);
    expect(await used("a")).toBe(0); // not charged
    expect(await refExists("a", "x")).toBe(false); // not granted
    expect(await candExists("a", "x")).toBe(true); // marker untouched (grant rolled back)
  });

  it("concurrent same-sha grants charge the ref exactly once (atomic insert+charge)", async () => {
    await mkAccount("a");
    await addBlob("x", 100);
    // Fired together: D1 serializes the two batches, so the NOT-EXISTS charge fires once.
    const [g1, g2] = await Promise.all([grantEntitlementWithQuota(env, "a", "x", 100, NOW), grantEntitlementWithQuota(env, "a", "x", 100, NOW + 1)]);
    expect(g1.granted && g2.granted).toBe(true);
    expect(await used("a")).toBe(100); // charged once, NOT 200
    const n = Number((await db().prepare("SELECT COUNT(*) c FROM blob_refs WHERE account_id='a' AND sha256='x'").first())!.c);
    expect(n).toBe(1);
  });

  it("an AT-CAP account can re-grant its own already-entitled marked ref (charges 0, clears marker)", async () => {
    await mkAccount("a", 100); // cap 100
    await addRef("a", "x", 100, NOW - 2 * HOUR); // used == cap == 100 (at cap)
    await mark("a", "x"); // Phase 1 marked it (fell out of roots)
    // The candidate-aware "missing" forces a re-upload → grant. Charge is 0 (already entitled),
    // so the cap-guard trigger does NOT trip even though used==cap → marker MUST clear.
    const g = await grantEntitlementWithQuota(env, "a", "x", 100, NOW);
    expect(g.granted).toBe(true);
    expect(await candExists("a", "x")).toBe(false); // marker cleared (codex round-3)
    expect(await used("a")).toBe(100); // still charged exactly once
  });
});

// Integration: the legacy blobPut over-cap PRE-CHECK must be skipped for an already-entitled
// sha, so an at-cap account can re-establish (and un-mark) a ref it already owns end-to-end.
describe("§33 at-cap re-upload clears the marker (legacy blobPut pre-check skip)", () => {
  const BASE = "https://example.com";
  const authed = (t: string, x: Record<string, string> = {}) => ({ authorization: `Bearer ${t}`, ...x });
  async function bootstrap(name: string) {
    const r = await SELF.fetch(`${BASE}/v1/auth/device/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "test-bootstrap-secret", accountName: name, plan: "pro" }),
    });
    expect(r.status).toBe(200);
    return (await r.json()) as { token: string; accountId: string };
  }

  it("an at-cap account re-PUTs (legacy) its own prune-marked blob → 200, marker cleared, charged once", async () => {
    const a = await bootstrap("atcap");
    const content = "marked-but-owned-content";
    const s = createHash("sha256").update(content).digest("hex");
    // First legacy PUT (no receipts header) → entitled + charged.
    const put1 = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(content.length) }), body: content });
    expect(put1.status).toBe(200);
    // Pin the account exactly AT cap (cap == current used), then Phase-1-mark the ref.
    const u = await used(a.accountId);
    await db().prepare("UPDATE accounts SET cap_bytes = ? WHERE id = ?").bind(u, a.accountId).run();
    await mark(a.accountId, s);
    expect(await candExists(a.accountId, s)).toBe(true);

    // Re-PUT (legacy) the SAME blob: pre-check is skipped (already entitled) → grant charges 0
    // and clears the marker. Without the §33 fix this 402'd and the marker never cleared.
    const put2 = await SELF.fetch(`${BASE}/v1/blobs/${s}`, { method: "PUT", headers: authed(a.token, { "content-length": String(content.length) }), body: content });
    expect(put2.status).toBe(200);
    expect(await candExists(a.accountId, s)).toBe(false); // marker cleared
    expect(await used(a.accountId)).toBe(u); // charged exactly once (no double charge)
  });
});

describe("§33 reconciler (07b §c) — used_bytes drift correction", () => {
  it("re-derives used_bytes as SUM(blob_refs ⋈ blobs)", async () => {
    await mkAccount("a");
    await addRef("a", "x", 100, NOW);
    await addRef("a", "y", 50, NOW);
    // simulate stranded over-count (the design 30 §3 leak): inflate used_bytes
    await db().prepare("UPDATE accounts SET used_bytes = 999 WHERE id = 'a'").run();
    await reconcileUsage(db(), "a");
    expect(await used("a")).toBe(150); // back to the true joined sum
  });
});

describe("§33 per-account fail-closed (one broken DO must not reclaim another account)", () => {
  it("an account whose reachability cannot be computed is skipped; others proceed", async () => {
    await mkAccount("good");
    await mkAccount("bad");
    // GOOD: no workspace → perAccountReachable returns empty → its stale orphan is markable.
    await addRef("good", "g", 10, NOW - 2 * HOUR);
    // BAD: has a workspace → perAccountReachable must read its DO roots. Break the DO
    // explicitly (a namespace whose stubs roots_too_large on /roots) — GOOD never touches the DO (no
    // workspace), so the same env exercises fail-closed isolation between the two.
    await db().prepare("INSERT INTO workspaces(workspace_id, project_id, account_id, created_at) VALUES ('ws_bad', 'root', 'bad', ?)").bind(NOW).run();
    await addRef("bad", "b", 20, NOW - 2 * HOUR);
    const brokenDO = {
      idFromName: (name: string) => env.WORKSPACE_SYNC.idFromName(name),
      get: () => ({ fetch: async () => Response.json({ error: "roots_too_large", retained: 65 }, { status: 503 }) }),
    } as unknown as DurableObjectNamespace; // test double: only the two members reachableFromWorkspaces uses
    const envBroken = { ...env, WORKSPACE_SYNC: brokenDO };

    // sanity: reachability for BAD throws (fail-closed), GOOD resolves empty.
    await expect(perAccountReachable(envBroken, "bad")).rejects.toThrow();
    expect([...(await perAccountReachable(envBroken, "good"))]).toEqual([]);

    const successLog = vi.spyOn(console, "log").mockImplementation(() => {});
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = (await runPhase1(envBroken, HOUR, NOW).then((r) => r.json())) as { processed: number; failed: number; marked: number };
      expect(res).toMatchObject({ processed: 1, failed: 1, marked: 1 });
      const outcomes = [...successLog.mock.calls, ...errorLog.mock.calls]
        .map(([line]) => JSON.parse(String(line)) as {
          event: string; outcome: string; reachable?: number; reachableCap?: number; reachableRemaining?: number;
          marked?: number; errorClass?: string;
        });
      expect(outcomes).toHaveLength(2); // exactly one structured outcome per account/pass
      expect(successLog).toHaveBeenCalledTimes(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(outcomes).toEqual(expect.arrayContaining([
        expect.objectContaining({
          event: "phase1_account_outcome", outcome: "success", reachable: 0,
          reachableCap: 750_000, reachableRemaining: 750_000, marked: 1,
        }),
        expect.objectContaining({
          event: "phase1_account_outcome", outcome: "fail_closed", errorClass: "Error",
        }),
      ]));
      for (const outcome of outcomes) {
        expect(outcome.accountKey).toMatch(/^[0-9a-f]{16}$/);
        expect(JSON.stringify(outcome)).not.toContain('"good"');
        expect(JSON.stringify(outcome)).not.toContain('"bad"');
      }
      expect(new Set(outcomes.map((outcome) => outcome.accountKey)).size).toBe(2);
    } finally {
      successLog.mockRestore();
      errorLog.mockRestore();
    }

    // GOOD's orphan was marked; BAD's ref + usage are completely untouched.
    expect(await candExists("good", "g")).toBe(true);
    expect(await candExists("bad", "b")).toBe(false);
    expect(await refExists("bad", "b")).toBe(true);
    expect(await used("bad")).toBe(20);
  });
});
