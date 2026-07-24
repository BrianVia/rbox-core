import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Env } from "../src/env.js";
import {
  acquireFairUseLease,
  computeShaLast,
  FAIRUSE_LEASE_QUIESCENCE_MS,
  FAIRUSE_LEASE_TTL_MS,
  guardSql,
  releaseFairUseLease,
  renewFairUseLease,
  runFairUseObservation,
} from "../src/fairuse.js";
import { usage } from "../src/billing.js";

const NOW = Date.now();
const sha = (n: number): string => n.toString(16).padStart(64, "0");
const db = () => env.rbox_dev_db;

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  await db().batch([
    db().prepare("DELETE FROM fairuse_materialize_refs"),
    db().prepare("DELETE FROM fairuse_root_membership"),
    db().prepare("DELETE FROM fairuse_sha_last"),
    db().prepare("DELETE FROM fairuse_workspace_streams"),
    db().prepare("DELETE FROM fairuse_scans"),
    db().prepare("DELETE FROM fairuse_leases"),
    db().prepare("DELETE FROM fairuse_account_queue"),
    db().prepare("DELETE FROM fairuse_scheduler"),
    db().prepare("DELETE FROM workspaces WHERE account_id LIKE 'acct_000_fairuse_%'"),
    db().prepare("DELETE FROM blob_refs WHERE account_id LIKE 'acct_000_fairuse_%'"),
    db().prepare("DELETE FROM accounts WHERE id LIKE 'acct_000_fairuse_%'"),
    db().prepare("DELETE FROM meta_deploy_floor WHERE key LIKE 'test_%'"),
  ]);
});

async function seedAccount(accountId: string, workspaceId: string, refs: string[]): Promise<void> {
  await db().batch([
    db().prepare("INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes) VALUES(?,?,'pro','bootstrap',?,?)")
      .bind(accountId, accountId, NOW, 250 * 1024 * 1024 * 1024),
    db().prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES(?,'root',?,?)")
      .bind(workspaceId, accountId, NOW),
    db().prepare("INSERT INTO commits(workspace_id,project_id,sequence,commit_hash,body,sig,created_at) VALUES(?,'root',1,'h','b','s',?)")
      .bind(workspaceId, NOW),
    db().prepare("INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)")
      .bind(accountId, NOW - 1, "test", NOW),
  ]);
  for (let offset = 0; offset < refs.length; offset += 40) {
    await db().batch(refs.slice(offset, offset + 40).flatMap((ref) => [
      db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(ref, 1),
      db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)").bind(accountId, ref, NOW),
    ]));
  }
}

function scanningEnv(
  workspaceId: string,
  refs: string[],
  paths: string[],
  pinState: { head: number; pinReads?: number; changeOnPinRead?: number },
): Env {
  const manifestSha = sha(900_000);
  return {
    ...env,
    WORKSPACE_SYNC: {
      idFromName: (name: string) => ({ name }),
      get: () => ({
        fetch: async (input: string | Request) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          paths.push(url.pathname);
          if (url.searchParams.get("pinHead") === null) {
            pinState.pinReads = (pinState.pinReads ?? 0) + 1;
            if (pinState.pinReads === pinState.changeOnPinRead) pinState.head++;
          }
          const pin = {
            head: pinState.head,
            pruneFloor: 0,
            indexGeneration: pinState.head,
            indexSyncedSeq: pinState.head,
            droppedPage: [],
            seqRootsPage: [],
            gapPage: [],
          };
          if (url.searchParams.get("pinHead") !== null && Number(url.searchParams.get("pinHead")) !== pinState.head) {
            return Response.json({ error: "snapshot_changed" }, { status: 409 });
          }
          if (url.searchParams.get("fromGapSeq") !== "done") {
            pin.gapPage = [{ seq: 1, manifestSha, inlineRefs: refs }] as never[];
          }
          return Response.json(pin);
        },
      }),
    } as unknown as DurableObjectNamespace,
  } as Env;
}

async function scan(accountId: string): Promise<{ status: string; epoch: number; entitlement_cursor_sha: string | null } | null> {
  return db().prepare("SELECT status,epoch,entitlement_cursor_sha FROM fairuse_scans WHERE account_id=? ORDER BY epoch DESC LIMIT 1")
    .bind(accountId).first<{ status: string; epoch: number; entitlement_cursor_sha: string | null }>();
}

describe("design 149 observe-only fair-use scan", () => {
  test("advances multiple bounded phase ticks, completes, and never calls /prune", async () => {
    const accountId = "acct_000_fairuse_resume";
    const workspaceId = "ws_fairuse_resume";
    const refs = Array.from({ length: 601 }, (_, index) => sha(index + 1));
    const paths: string[] = [];
    const pinState = { head: 1 };
    const fakeEnv = scanningEnv(workspaceId, refs, paths, pinState);
    await seedAccount(accountId, workspaceId, refs);

    await runFairUseObservation(fakeEnv, NOW);
    expect((await scan(accountId))?.status).toBe("materialize_roots");
    expect(Number((await db().prepare("SELECT COUNT(*) AS n FROM fairuse_root_membership WHERE account_id=?")
      .bind(accountId).first<{ n: number }>())?.n)).toBe(602);
    for (let turn = 0; turn < 12 && (await scan(accountId))?.status !== "complete"; turn++) {
      await runFairUseObservation(fakeEnv, NOW);
    }

    const completed = await db().prepare(
      "SELECT status,active_bytes,history_bytes,bound_bytes,completed_at,pruning_active FROM fairuse_scans WHERE account_id=? AND epoch=1",
    ).bind(accountId).first<Record<string, number | string | null>>();
    expect(completed).toMatchObject({
      status: "complete",
      active_bytes: 601,
      history_bytes: 0,
      bound_bytes: 5 * 1024 * 1024 * 1024,
      pruning_active: 0,
    });
    expect(Number(completed?.completed_at)).toBe(NOW);
    expect(paths.length).toBeGreaterThan(0);
    expect(new Set(paths)).toEqual(new Set(["/roots-inspect"]));

    const compact = await db().prepare("SELECT COUNT(*) AS n,MIN(in_head) AS lo,MAX(in_head) AS hi FROM fairuse_sha_last WHERE account_id=?")
      .bind(accountId).first<{ n: number; lo: number; hi: number }>();
    expect(compact).toEqual({ n: 602, lo: 1, hi: 1 });
    const timestamped = await db().prepare(
      "SELECT committed_at,timestamp_gap FROM fairuse_root_membership WHERE account_id=? AND sha256=? LIMIT 1",
    ).bind(accountId, refs[0]).first<{ committed_at: number; timestamp_gap: number }>();
    expect(timestamped).toEqual({ committed_at: NOW, timestamp_gap: 0 });
    expect(await db().prepare("SELECT singleton FROM fairuse_scheduler WHERE singleton=1").first()).toBeTruthy();
    expect(await db().prepare("SELECT reason FROM fairuse_account_queue WHERE account_id=?").bind(accountId).first()).toBeTruthy();
  });

  test("stops after eight phase ticks in one invocation", async () => {
    const accountId = "acct_000_fairuse_tick_budget";
    const workspaceId = "ws_fairuse_tick_budget_00";
    const paths: string[] = [];
    const pinState = { head: 1 };
    await seedAccount(accountId, workspaceId, []);
    for (let offset = 1; offset < 64; offset += 20) {
      const statements: D1PreparedStatement[] = [];
      for (let index = offset; index < Math.min(offset + 20, 64); index++) {
        const id = `ws_fairuse_tick_budget_${String(index).padStart(2, "0")}`;
        statements.push(
          db().prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES(?,'root',?,?)")
            .bind(id, accountId, NOW),
          db().prepare("INSERT INTO commits(workspace_id,project_id,sequence,commit_hash,body,sig,created_at) VALUES(?,'root',1,'h','b','s',?)")
            .bind(id, NOW),
        );
      }
      await db().batch(statements);
    }

    await runFairUseObservation(scanningEnv(workspaceId, [], paths, pinState), NOW);
    expect((await scan(accountId))?.status).toBe("capture_pins");
    expect(Number((await db().prepare("SELECT COUNT(*) AS n FROM fairuse_workspace_streams WHERE account_id=?")
      .bind(accountId).first<{ n: number }>())?.n)).toBe(64);
    expect(paths).toHaveLength(64);

    await runFairUseObservation(scanningEnv(workspaceId, [], paths, pinState), NOW);
    expect((await scan(accountId))?.status).toBe("materialize_roots");
    expect(paths.length).toBeGreaterThan(64);
  });

  test("pin churn aborts and cleans the incomplete epoch in bounded pages", async () => {
    const accountId = "acct_000_fairuse_pin_abort";
    const workspaceId = "ws_fairuse_pin_abort";
    const refs = Array.from({ length: 601 }, (_, index) => sha(index + 10_000));
    const paths: string[] = [];
    const pinState = { head: 1, changeOnPinRead: 2 };
    const fakeEnv = scanningEnv(workspaceId, refs, paths, pinState);
    await seedAccount(accountId, workspaceId, refs);

    for (let turn = 0; turn < 12 && (await scan(accountId))?.status !== "aborted_pins"; turn++) {
      await runFairUseObservation(fakeEnv, NOW);
    }
    expect((await scan(accountId))?.status).toBe("aborted_pins");
    const partialRows = async (): Promise<number> => {
      let total = 0;
      for (const table of ["fairuse_materialize_refs", "fairuse_root_membership", "fairuse_sha_last", "fairuse_workspace_streams"]) {
        const row = await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`).bind(accountId).first<{ n: number }>();
        total += Number(row?.n);
      }
      return total;
    };
    // One invocation now runs up to 8 phase ticks, so the per-invocation delta is
    // bounded by 8×600; the per-tick 600 bound is pinned by the tick-budget test.
    let prior = await partialRows();
    for (let call = 0; prior > 0 && call < 12; call++) {
      await runFairUseObservation(fakeEnv, NOW);
      const next = await partialRows();
      expect(prior - next).toBeGreaterThan(0);
      expect(prior - next).toBeLessThanOrEqual(8 * 600);
      prior = next;
    }
    expect(prior).toBe(0);
    for (const table of ["fairuse_materialize_refs", "fairuse_root_membership", "fairuse_sha_last", "fairuse_workspace_streams"]) {
      const row = await db().prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE account_id=?`).bind(accountId).first<{ n: number }>();
      expect(Number(row?.n), table).toBe(0);
    }
    expect(paths).not.toContain("/prune");
  });

  test("missing blob catalog evidence fails closed without advancing totals", async () => {
    const accountId = "acct_000_fairuse_missing_catalog";
    const missing = sha(800_000);
    await db().batch([
      db().prepare("INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes) VALUES(?,?,'pro','bootstrap',?,?)")
        .bind(accountId, accountId, NOW, 250 * 1024 * 1024 * 1024),
      db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)").bind(accountId, missing, NOW),
      db().prepare(`INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,workspace_set_snapshot,started_at,updated_at)
        VALUES(?,1,'classify_entitlements','{}',1,'[]',?,?)`).bind(accountId, NOW, NOW),
      db().prepare("INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)")
        .bind(accountId, NOW, "test", NOW),
    ]);
    await expect(runFairUseObservation(env, NOW)).rejects.toThrow("fairuse_catalog_missing");
    expect(await db().prepare("SELECT active_bytes,history_bytes,entitlement_cursor_sha FROM fairuse_scans WHERE account_id=?")
      .bind(accountId).first()).toEqual({ active_bytes: 0, history_bytes: 0, entitlement_cursor_sha: null });
    expect(await db().prepare("SELECT reason FROM fairuse_account_queue WHERE account_id=?").bind(accountId).first())
      .toEqual({ reason: "scan_error" });
  });

  test("missing account drains its orphaned queue row", async () => {
    const accountId = "acct_000_fairuse_missing_account";
    await db().prepare("INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)")
      .bind(accountId, NOW - 1, "test", NOW).run();

    await expect(runFairUseObservation(env, NOW)).rejects.toThrow("account_missing");

    expect(await db().prepare("SELECT 1 FROM fairuse_account_queue WHERE account_id=?").bind(accountId).first())
      .toBeNull();
  });
});

describe("fair-use lease and compact last-location contracts", () => {
  test("lease exact-value CAS excludes, renews, releases, and observes takeover quiescence", async () => {
    const accountId = "acct_000_fairuse_lease";
    const first = await acquireFairUseLease(db(), accountId, 1, NOW, "owner-a");
    expect(first).not.toBeNull();
    expect(await acquireFairUseLease(db(), accountId, 1, NOW, "owner-b")).toBeNull();
    const renewed = await renewFairUseLease(db(), accountId, first!, NOW + FAIRUSE_LEASE_TTL_MS - 1);
    expect(renewed?.value).not.toBe(first!.value);
    expect(await releaseFairUseLease(db(), accountId, first!.value)).toBe(false);
    expect(await releaseFairUseLease(db(), accountId, renewed!.value)).toBe(true);

    const stale = JSON.stringify({ owner: "old", epoch: 1, acquired: 1, expires: 2 });
    await db().prepare("INSERT INTO fairuse_leases(account_id,value) VALUES(?,?)").bind(accountId, stale).run();
    expect(await acquireFairUseLease(db(), accountId, 2, 2 + FAIRUSE_LEASE_QUIESCENCE_MS, "early")).toBeNull();
    expect(await acquireFairUseLease(db(), accountId, 2, 3 + FAIRUSE_LEASE_QUIESCENCE_MS, "takeover")).not.toBeNull();
    expect(await renewFairUseLease(db(), accountId, {
      lease: { owner: "expired", epoch: 3, acquired: NOW - 2, expires: NOW - 1 },
      value: JSON.stringify({ owner: "expired", epoch: 3, acquired: NOW - 2, expires: NOW - 1 }),
    }, NOW)).toBeNull();
  });

  test("guarded scan mutations no-op with expired or stolen leases", async () => {
    const accountId = "acct_000_fairuse_guard";
    const planSnapshot = "{}";
    await db().batch([
      db().prepare("INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes) VALUES(?,?,'pro','bootstrap',?,?)")
        .bind(accountId, accountId, NOW, 250 * 1024 * 1024 * 1024),
      db().prepare(`INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,
        workspace_set_snapshot,started_at,updated_at) VALUES(?,1,'capture_pins',?,1,'[]',?,?)`)
        .bind(accountId, planSnapshot, NOW, NOW),
    ]);
    const mutate = (leaseValue: string) => db().prepare(`UPDATE fairuse_scans SET active_bytes=99 WHERE ${guardSql()}`)
      .bind(accountId, 1, "capture_pins", planSnapshot, leaseValue).run();

    const expired = JSON.stringify({ owner: "expired", epoch: 1, acquired: NOW - 10_000, expires: NOW - 1 });
    await db().prepare("INSERT INTO fairuse_leases(account_id,value) VALUES(?,?)").bind(accountId, expired).run();
    expect(Number((await mutate(expired)).meta.changes ?? 0)).toBe(0);

    const prior = JSON.stringify({ owner: "prior", epoch: 1, acquired: NOW, expires: NOW + FAIRUSE_LEASE_TTL_MS });
    const stolen = JSON.stringify({ owner: "stolen", epoch: 1, acquired: NOW, expires: NOW + FAIRUSE_LEASE_TTL_MS });
    await db().prepare("UPDATE fairuse_leases SET value=? WHERE account_id=?").bind(prior, accountId).run();
    await db().prepare("UPDATE fairuse_leases SET value=? WHERE account_id=?").bind(stolen, accountId).run();
    expect(Number((await mutate(prior)).meta.changes ?? 0)).toBe(0);
    expect(await db().prepare("SELECT active_bytes FROM fairuse_scans WHERE account_id=?").bind(accountId).first())
      .toEqual({ active_bytes: 0 });
  });

  test("sha_last is exact for shared history, head reachability, and timestamp gaps", () => {
    const value = computeShaLast([
      { workspaceId: "ws_a", projectId: "root", sequence: 2, head: false, committedAt: 20, timestampGap: false },
      { workspaceId: "ws_b", projectId: "root", sequence: 1, head: false, committedAt: 30, timestampGap: false },
      { workspaceId: "ws_c", projectId: "root", sequence: 9, head: true, committedAt: 40, timestampGap: false },
      { workspaceId: "ws_gap", projectId: "root", sequence: 3, head: false, committedAt: null, timestampGap: true },
    ]);
    expect(value).toEqual({ lastWs: "ws_gap", lastProj: "root", lastSeq: 3, inHead: true });
    expect(computeShaLast([
      { workspaceId: "ws_b", projectId: "z", sequence: 2, head: true, committedAt: 2, timestampGap: false },
      { workspaceId: "ws_a", projectId: "z", sequence: 1, head: true, committedAt: 1, timestampGap: false },
    ])).toEqual({ lastWs: "ws_b", lastProj: "z", lastSeq: 2, inHead: true });
  });
});

describe("migration and usage surface", () => {
  test("exercises global deploy metadata and the Unit-A covering index", async () => {
    await db().prepare("INSERT INTO meta_deploy_floor(key,value) VALUES('test_roots_format_generation','1')").run();
    expect(await db().prepare("SELECT value FROM meta_deploy_floor WHERE key='test_roots_format_generation'").first()).toEqual({ value: "1" });
    const plan = await db().prepare(
      "EXPLAIN QUERY PLAN SELECT device_id,kind,last_seen_version FROM devices INDEXED BY idx_devices_capability_population "
        + "WHERE account_id=? AND revoked=0 AND kind IN ('device','api_key') AND last_seen_at>=? "
        + "AND (expires_at IS NULL OR expires_at>?) ORDER BY kind,last_seen_at,expires_at,last_seen_version,device_id LIMIT 1025",
    ).bind("acct", 0, 0).all<Record<string, unknown>>();
    expect(JSON.stringify(plan.results)).toContain("idx_devices_capability_population");
  });

  test("usage reads only the latest completed epoch and remains observe-only", async () => {
    const accountId = "acct_000_fairuse_usage";
    await db().prepare("INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes) VALUES(?,?,'pro','bootstrap',?,?)")
      .bind(accountId, accountId, NOW, 250 * 1024 * 1024 * 1024).run();
    const scan = (epoch: number, completedAt: number | null, active: number, pruning: number) => db().prepare(
      `INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,workspace_set_snapshot,
       started_at,updated_at,completed_at,active_bytes,history_bytes,bound_bytes,pruning_active)
       VALUES(?,?,'complete','{}',1,'[]',?,?,?,?,?,?,?)`,
    ).bind(accountId, epoch, NOW, NOW, completedAt, active, active * 2, active * 5, pruning);
    await db().batch([scan(1, NOW - 2, 10, 0), scan(2, null, 999, 0), scan(3, NOW - 1, 20, 1)]);

    const response = await usage(env, { accountId, deviceId: "dev", userId: "user", role: "owner", kind: "device" });
    expect((await response.json() as { fairUse: unknown }).fairUse).toEqual({
      activeBytes: 20,
      historyBytes: 40,
      bound: 100,
      lastCompletedEpochAt: NOW - 1,
      pruningActive: false,
      overshoot: { maxBatches: 1, maxSequences: 500 },
    });
  });
});
