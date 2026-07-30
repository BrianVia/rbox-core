import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { grantEntitlementWithQuota, usage, wouldExceedCap } from "../src/billing.js";
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

async function seed(accountId: string, used: number, overhang: number): Promise<void> {
  await db().prepare(
    "INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes,used_bytes,history_overhang_bytes) VALUES(?,?,'solo','bootstrap',?,?,?,?)",
  ).bind(accountId, accountId, NOW, CAP, used, overhang).run();
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

async function usageBody(accountId: string): Promise<Record<string, unknown>> {
  return (await (await usage(env, principal(accountId))).json()) as Record<string, unknown>;
}

describe("design 228 — the billing flip", () => {
  test("with a completed scan, the number shown is active bytes and carries when it was measured", async () => {
    const accountId = "acct_228_flip";
    // 900,000 stored; only 100,000 of it is live at head, so 800,000 is history we
    // keep but never bill.
    await seed(accountId, 900_000, 800_000);
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
    expect(billableBytes(10, 40)).toBe(0);
    expect(billableBytes(null, undefined)).toBe(0);
    expect(billableBytes(100, 40)).toBe(60);

    const accountId = "acct_228_clamp";
    await seed(accountId, 10, 40);
    await completedScan(accountId, 10, NOW);
    expect((await usageBody(accountId)).usedBytes).toBe(0);
    expect(await grantEntitlementWithQuota(env, accountId, sha(4), 5, NOW)).toMatchObject({ granted: true });
  });
});
