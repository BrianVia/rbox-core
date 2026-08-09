import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { grantEntitlementWithQuota, usage, wouldExceedCap } from "../src/billing.js";
import { commitAccounting } from "../src/commit-accounting.js";
import { billableBytes, capBytesFor } from "../src/plans.js";

// Design 228 — rbox bills, shows and gates on ACTIVE bytes. `accounts.used_bytes`
// stays the live entitlement ledger and stays the admission input; what flips is the
// allowance, via the measured `history_overhang_bytes` the fair-use scan writes.
// (fairuse-scan.test.ts owns the writer's end-to-end path; this file owns the
// consumers and the fallback.)

const db = () => env.rbox_dev_db;
const NOW = 1_700_000_000_000;
const GiB = 1024 * 1024 * 1024;
// The app-layer cap is the PLAN cap (plans.ts); accounts.cap_bytes is the D1
// trigger's copy of the same number. Seed both so the advisory check and the fence
// are comparing against one cap.
const CAP = capBytesFor("solo");
const sha = (n: number): string => n.toString(16).padStart(64, "0");
const principal = (accountId: string) => ({ accountId, deviceId: "dev", userId: "user", role: "owner" as const, kind: "device" as const });

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM fairuse_scans WHERE account_id LIKE 'acct_228_%'"),
    db().prepare("DELETE FROM blob_refs WHERE account_id LIKE 'acct_228_%'"),
    db().prepare("DELETE FROM accounts WHERE id LIKE 'acct_228_%'"),
  ]);
});

/** Post-scan state: the ledger, the measured forgiveness, and when it was measured —
 *  all three on the accounts row, which is where every consumer reads them. */
async function seed(
  accountId: string,
  used: number,
  overhang: number,
  opts: { plan?: string; measuredAt?: number | null } = {},
): Promise<void> {
  const plan = opts.plan ?? "solo";
  const measuredAt = opts.measuredAt !== undefined ? opts.measuredAt : (overhang > 0 ? NOW : null);
  await db().prepare(
    "INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes,used_bytes,history_overhang_bytes,history_overhang_measured_at) VALUES(?,?,?,'bootstrap',?,?,?,?,?)",
  ).bind(accountId, accountId, plan, NOW, plan === "none" ? 1 : CAP, used, overhang, measuredAt).run();
}

async function completedScan(accountId: string, activeBytes: number, completedAt: number): Promise<void> {
  await db().prepare(
    `INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,workspace_set_snapshot,
       started_at,updated_at,completed_at,active_bytes,history_bytes,bound_bytes,history_computed)
     VALUES(?,1,'complete','{}',1,'[]',?,?,?,?,0,0,0)`,
  ).bind(accountId, NOW, NOW, completedAt, activeBytes).run();
}

async function ledger(accountId: string): Promise<{ used: number; overhang: number }> {
  const row = await db().prepare("SELECT used_bytes,history_overhang_bytes FROM accounts WHERE id=?")
    .bind(accountId).first<{ used_bytes: number; history_overhang_bytes: number }>();
  return { used: Number(row?.used_bytes), overhang: Number(row?.history_overhang_bytes) };
}

interface UsageBody {
  usedBytes: number;
  measuredAt: number | null;
  readOnly: boolean;
  fairUse: { activeBytes: number };
  capBytes: number;
  historyOverhangBytes: number;
}

async function usageBody(accountId: string): Promise<UsageBody> {
  return (await (await usage(env, principal(accountId))).json()) as UsageBody;
}

describe("design 228 — the billing flip", () => {
  test("with a completed scan, the number shown is active bytes and carries when it was measured", async () => {
    const accountId = "acct_228_flip";
    // 900,000 stored; only 100,000 of it is live at head, so 800,000 is history we
    // keep but never bill.
    await seed(accountId, 900_000, 800_000, { measuredAt: NOW - 41 * 60_000 });
    await completedScan(accountId, 100_000, NOW - 41 * 60_000);

    const body = await usageBody(accountId);
    expect(body.usedBytes).toBe(100_000);
    expect(body.measuredAt).toBe(NOW - 41 * 60_000);
    expect(body.readOnly).toBe(false);
    expect((body.fairUse as { activeBytes: number }).activeBytes).toBe(100_000);
  });

  test("with no completed scan, it falls back to the stored total and says it is unmeasured", async () => {
    const accountId = "acct_228_fallback";
    await seed(accountId, 60 * GiB, 0);

    const body = await usageBody(accountId);
    expect(body.usedBytes).toBe(60 * GiB);
    expect(body.measuredAt).toBeNull();
    // The fallback is byte-for-byte today's behaviour: nothing measured, nothing
    // forgiven, and the cap comparison is unchanged.
    expect(await wouldExceedCap(env, accountId, sha(1), GiB)).toMatchObject({ over: true, used: 60 * GiB });
  });

  test("cap comparisons use billable bytes — history alone never blocks or reads as full", async () => {
    const accountId = "acct_228_cap";
    // The ledger is 10 GiB OVER the 50 GiB cap, entirely because of history: only
    // 1 GiB of the 60 GiB stored is live at head.
    await seed(accountId, 60 * GiB, 59 * GiB);
    await completedScan(accountId, GiB, NOW);

    expect(await wouldExceedCap(env, accountId, sha(2), GiB)).toMatchObject({ over: false, used: GiB });
    const body = await usageBody(accountId);
    expect(body.usedBytes).toBe(GiB);
    expect(body.readOnly).toBe(false);

    // And the authoritative D1 fence agrees: a charge that is over-cap on the LEDGER
    // but under it on billable bytes is admitted, with the full size still landing on
    // the ledger. Admission never stopped using the live counter.
    const granted = await grantEntitlementWithQuota(env, accountId, sha(2), GiB, NOW);
    expect(granted.granted).toBe(true);
    expect(await ledger(accountId)).toEqual({ used: 61 * GiB, overhang: 59 * GiB });
    expect(granted.used).toBe(2 * GiB);
  });

  test("the fence still fences: a charge past the BILLABLE cap is refused", async () => {
    const accountId = "acct_228_fence";
    await seed(accountId, 60 * GiB, 11 * GiB);
    await completedScan(accountId, 49 * GiB, NOW);

    // billable = 49 GiB against a 50 GiB cap; 2 GiB more does not fit.
    const refused = await grantEntitlementWithQuota(env, accountId, sha(3), 2 * GiB, NOW);
    expect(refused.granted).toBe(false);
    expect(refused.used).toBe(49 * GiB);
    expect(await ledger(accountId)).toEqual({ used: 60 * GiB, overhang: 11 * GiB });
    // ...and the ref is not granted, so the whole batch really did roll back.
    expect(await db().prepare("SELECT COUNT(*) AS n FROM blob_refs WHERE account_id=?").bind(accountId).first<{ n: number }>())
      .toEqual({ n: 0 });
  });

  test("a stale overhang larger than the ledger clamps to zero, never a negative allowance", async () => {
    // GC can prune the ledger below a standing overhang between hourly scans.
    expect(billableBytes("solo", 10, 40)).toBe(0);
    expect(billableBytes("solo", null, undefined)).toBe(0);
    expect(billableBytes("solo", 100, 40)).toBe(60);
    // A locked account forgives nothing, whatever the column says.
    expect(billableBytes("none", 100, 40)).toBe(100);

    const accountId = "acct_228_clamp";
    await seed(accountId, 10, 40);
    await completedScan(accountId, 10, NOW);
    expect((await usageBody(accountId)).usedBytes).toBe(0);
    expect(await grantEntitlementWithQuota(env, accountId, sha(4), 5, NOW)).toMatchObject({ granted: true });
  });

  test("in the clamped regime the advisory check is not stricter than the fence", async () => {
    // overhang > used, so MAX(0, used - overhang) + incoming would read as `incoming`
    // alone against the cap, while the trigger evaluates (used + incoming) - overhang.
    // The two must give the same verdict or the 402 refuses uploads D1 would admit.
    const accountId = "acct_228_clamped_boundary";
    const overhang = 40 * GiB;
    await seed(accountId, GiB, overhang);

    // used + incoming - overhang = 1 + 60 - 40 = 21 GiB, well under the 50 GiB cap.
    expect(await wouldExceedCap(env, accountId, sha(5), 60 * GiB)).toMatchObject({ over: false });
    expect(await grantEntitlementWithQuota(env, accountId, sha(5), 60 * GiB, NOW)).toMatchObject({ granted: true });

    // And the boundary itself: from used = 61 GiB the next byte over is refused by both.
    const exact = CAP + overhang - 61 * GiB; // lands billable exactly ON the cap
    expect(await wouldExceedCap(env, accountId, sha(6), exact)).toMatchObject({ over: false });
    expect(await wouldExceedCap(env, accountId, sha(6), exact + 1)).toMatchObject({ over: true });
    expect(await grantEntitlementWithQuota(env, accountId, sha(6), exact + 1, NOW)).toMatchObject({ granted: false });
  });

  test("a locked account is fenced at one byte however large its overhang is", async () => {
    // Its paid era left a real measured overhang. cap_bytes = 1 is the whole fence for
    // a lapsed subscription; forgiving against it would let real bytes land durably in
    // the window after a paid→none transition.
    const accountId = "acct_228_locked";
    await seed(accountId, 60 * GiB, 59 * GiB, { plan: "none" });

    expect(await wouldExceedCap(env, accountId, sha(7), 1)).toMatchObject({ over: true, reason: "no_plan" });
    const refused = await grantEntitlementWithQuota(env, accountId, sha(7), 1, NOW);
    expect(refused).toMatchObject({ granted: false, reason: "no_plan" });
    expect(await ledger(accountId)).toEqual({ used: 60 * GiB, overhang: 59 * GiB });

    // Even reaching D1 directly — the app-layer no_plan short-circuit is not the only
    // thing standing between a locked account and durable bytes.
    await expect(db().prepare("UPDATE accounts SET used_bytes = used_bytes + 1 WHERE id=?").bind(accountId).run())
      .rejects.toThrow(/over_cap/);
    // ...and the number it reports is the raw ledger, not a forgiven one.
    expect((await usageBody(accountId)).usedBytes).toBe(60 * GiB);
  });

  test("the over-cap 402 body reports billable bytes, not the raw ledger", async () => {
    const accountId = "acct_228_commit_402";
    await seed(accountId, 60 * GiB, 11 * GiB); // billable 49 GiB against a 50 GiB cap
    await db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(sha(8), 2 * GiB).run();

    const result = await commitAccounting(db(), accountId, [
      { sha: sha(8), size: 2 * GiB, receiptExpiresAt: Date.now() + 3_600_000 },
    ], Date.now());
    expect(result).toEqual({ overCap: { used: 49 * GiB, cap: CAP } });

    // A locked account's 402 reports the raw ledger, matching its fence.
    const lockedId = "acct_228_commit_402_locked";
    await seed(lockedId, 60 * GiB, 59 * GiB, { plan: "none" });
    expect(await commitAccounting(db(), lockedId, [
      { sha: sha(8), size: 2 * GiB, receiptExpiresAt: Date.now() + 3_600_000 },
    ], Date.now())).toEqual({ overCap: { used: 60 * GiB, cap: 1, reason: "no_plan" } });
  });

  test("migration 0036 backfills deploy-day accounts from their latest completed scan", async () => {
    // Miniflare applies every migration before the first test, so the pre-0036 state is
    // reconstructed by resetting the two columns to their defaults; the assertion then
    // runs the migration's OWN backfill statements, read from TEST_MIGRATIONS.
    const accountId = "acct_228_backfill";
    await seed(accountId, 900_000, 0, { measuredAt: null });
    await completedScan(accountId, 100_000, NOW - 7_200_000);
    // A newer completed scan must win, and an incomplete one must be ignored.
    await db().batch([
      db().prepare(`INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,
        workspace_set_snapshot,started_at,updated_at,completed_at,active_bytes,history_bytes,bound_bytes,history_computed)
        VALUES(?,2,'complete','{}',1,'[]',?,?,?,?,0,0,0)`).bind(accountId, NOW, NOW, NOW - 60_000, 250_000),
      db().prepare(`INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,
        workspace_set_snapshot,started_at,updated_at,active_bytes,history_bytes,bound_bytes,history_computed)
        VALUES(?,3,'materialize_roots','{}',1,'[]',?,?,999,0,0,0)`).bind(accountId, NOW, NOW),
    ]);
    // An account that has NEVER completed a scan must stay untouched — measured_at NULL
    // is what "never measured" means, and the backfill must not invent one.
    const virginId = "acct_228_backfill_virgin";
    await seed(virginId, 500_000, 0, { measuredAt: null });

    const migration = env.TEST_MIGRATIONS.find((m) => m.name.startsWith("0036_"));
    expect(migration, "migration 0036 must be in TEST_MIGRATIONS").toBeDefined();
    const backfill = migration!.queries.filter((q) => /^\s*UPDATE\s+accounts\s+SET/i.test(q));
    expect(backfill.length, "0036 must carry a backfill UPDATE").toBeGreaterThan(0);
    for (const query of backfill) await db().prepare(query).run();

    expect(await db().prepare("SELECT history_overhang_bytes AS o,history_overhang_measured_at AS at FROM accounts WHERE id=?")
      .bind(accountId).first()).toEqual({ o: 900_000 - 250_000, at: NOW - 60_000 });
    expect(await db().prepare("SELECT history_overhang_bytes AS o,history_overhang_measured_at AS at FROM accounts WHERE id=?")
      .bind(virginId).first()).toEqual({ o: 0, at: null });
  });
});
