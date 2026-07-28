import { applyD1Migrations, env, SELF } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env.js";
import { grantEntitlementWithQuota } from "../src/billing.js";
import {
  GC_BUDGET_SAFE,
  GC_FIXED_COST,
  GC_P1_COST,
  GC_PER_EXECUTE,
  PER_WORKSPACE_ROOTS_COST,
  INTENT_QUIESCENCE_MS,
  gcExecuteLimit,
} from "../src/gc-policy.js";
import { GC_INSERT_ROWS, gcMark } from "../src/gc-mark.js";
import { GC_MAX_WORKSPACE_ROWS, gcHealthData } from "../src/gc-health.js";
import { gcAudit } from "../src/gc-audit.js";
import { STALE_INTENT_MS, gcPurge } from "../src/gc-purge.js";
import {
  writeGcObservation,
  type GcObservationV1,
} from "../src/gc-observability.js";
import {
  PURGE_LEASE_TTL_MS,
  TAKEOVER_QUIESCENCE_MS,
} from "../src/gc-state.js";
import { blobKey } from "../src/util.js";
import worker, { GC_MARK_UTC_HOUR, GC_PURGE_UTC_HOUR } from "../src/worker.js";
import { RECEIPT_TTL_MS } from "../src/receipts.js";

const db = () => env.rbox_dev_db;
const NOW = 1_800_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const GRACE = 7 * DAY;
let testSequence = 0;
let testPrefix = "";

function sha(suffix: string): string {
  return `${testPrefix}-${suffix}`;
}

type PurgeResult = {
  purged: number;
  unwound?: number;
  opened: number;
  bytes?: number;
  executeLimit?: number;
  leaseBusy?: boolean;
  retryAfterMs?: number;
  error?: string;
  budgetExceeded?: boolean;
  ok?: boolean;
  reason?: string;
  rows?: number;
  maxRows?: number;
  uniqueRoots?: null | { value: number; measuredAt: string; stale?: true; lowerBound?: true };
  maxRoots?: number;
};

async function body(res: Response, allowTerminal = false): Promise<PurgeResult> {
  const parsed = (await res.json()) as PurgeResult;
  if (!allowTerminal && (parsed.ok === false || parsed.budgetExceeded === true)) {
    throw new Error("unexpected terminal GC response");
  }
  return parsed;
}

async function candidate(sha: string, markedAt = NOW - GRACE - 1, deletingAt: number | null = null, kind = "blob") {
  await db().prepare("INSERT INTO gc_candidates (sha256, kind, marked_at, deleting_at) VALUES (?, ?, ?, ?)").bind(sha, kind, markedAt, deletingAt).run();
}

async function catalog(sha: string, size = 10) {
  await db().prepare("INSERT INTO blobs (sha256, size_bytes, present) VALUES (?, ?, 1)").bind(sha, size).run();
}

async function put(sha: string, value = "bytes") {
  await env.rbox_dev_blobs.put(blobKey(sha), value);
}

async function exists(sql: string, ...binds: unknown[]): Promise<boolean> {
  return !!(await db().prepare(sql).bind(...binds).first());
}

// Monotonic per-test counter: COUNT(*)-derived offsets regenerate colliding ids
// after a mid-test row deletion (delete w0 of w0..w5 → count 5 → next id w5, taken).
let workspaceSeq = 0;
async function workspaces(count: number): Promise<void> {
  for (let base = 0; base < count; base += 30) {
    const n = Math.min(30, count - base);
    await db().prepare(`INSERT INTO workspaces(workspace_id,project_id,created_at) VALUES ${Array.from({ length: n }, () => "(?,?,?)").join(",")}`)
      .bind(...Array.from({ length: n }, () => [`${testPrefix}-w${workspaceSeq++}`, "p", NOW]).flat()).run();
  }
}

function emptyRootsEnv(): { value: Env; calls: () => number } {
  let count = 0;
  const value = {
    ...env,
    WORKSPACE_SYNC: {
      idFromName: () => ({} as DurableObjectId),
      get: () => ({ fetch: async () => {
        count++;
        return Response.json({ head: 0, pruneFloor: 0, indexGeneration: 0, gap: [], droppedPage: [], seqRootsPage: [] });
      } }),
    } as unknown as DurableObjectNamespace,
  } as Env;
  return { value, calls: () => count };
}

function failDbMethodOnce(sqlPart: string, method: "all" | "first" | "run"): D1Database {
  const real = db();
  let failed = false;
  const wrap = (statement: D1PreparedStatement, matches: boolean): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") return (...args: unknown[]) => wrap(target.bind(...args), matches);
      if (matches && property === method) {
        return async (...args: unknown[]) => {
          if (!failed) {
            failed = true;
            throw new Error(`injected ${method} failure`);
          }
          return (target[property] as (...inner: unknown[]) => unknown).apply(target, args);
        };
      }
      return Reflect.get(target, property, receiver);
    },
  });
  return new Proxy(real, {
    get(target, property, receiver) {
      if (property !== "prepare") return Reflect.get(target, property, receiver);
      return (sql: string) => wrap(target.prepare(sql), sql.includes(sqlPart));
    },
  }) as D1Database;
}

function envWithBucket(bucket: Partial<R2Bucket>, metrics?: Array<{ blobs: string[]; doubles: number[] }>): Env {
  return {
    ...env,
    rbox_dev_blobs: bucket as R2Bucket,
    rbox_metrics: metrics ? ({ writeDataPoint: (p: { blobs: string[]; doubles: number[] }) => metrics.push(p) } as AnalyticsEngineDataset) : undefined,
  };
}

beforeAll(async () => {
  await applyD1Migrations(env.rbox_dev_db, env.TEST_MIGRATIONS);
});

beforeEach(async () => {
  testPrefix = `gc-purge-${++testSequence}`;
  await db().batch([
    db().prepare("DELETE FROM gc_state"),
    db().prepare("DELETE FROM gc_candidates"),
    db().prepare("DELETE FROM blob_refs"),
    db().prepare("DELETE FROM blobs"),
    db().prepare("DELETE FROM workspaces"),
    db().prepare("DELETE FROM accounts"),
  ]);
  for (const prefix of ["blobs/sha256/", "manifests/sha256/"]) {
    let cursor: string | undefined;
    do {
      const page = await env.rbox_dev_blobs.list({ prefix, cursor });
      await Promise.all(page.objects.map((o) => env.rbox_dev_blobs.delete(o.key)));
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
  }
});

describe("design 95 P1 intent protocol", () => {
  it("expires pre-intent publication authority strictly before P2 can dispatch", () => {
    expect(RECEIPT_TTL_MS).toBe(12 * 60 * 60 * 1000);
    expect(RECEIPT_TTL_MS).toBeLessThan(INTENT_QUIESCENCE_MS);
  });

  it("stamps once, is idempotent, and the zero-ref guard closes a concurrent grant", async () => {
    const guarded = sha("guarded");
    const hasRef = sha("has-ref");
    await candidate(guarded);
    expect((await body(await gcPurge(env, GRACE, { nowMs: NOW, owner: "p1-a" }))).opened).toBe(1);
    const first = await db().prepare("SELECT deleting_at FROM gc_candidates WHERE sha256=?").bind(guarded).first<{ deleting_at: number }>();
    expect(first?.deleting_at).toBe(NOW);

    expect((await body(await gcPurge(env, GRACE, { nowMs: NOW + 1, owner: "p1-b" }))).opened).toBe(0);
    expect((await db().prepare("SELECT deleting_at FROM gc_candidates WHERE sha256=?").bind(guarded).first<{ deleting_at: number }>())?.deleting_at).toBe(NOW);

    await db().prepare("DELETE FROM gc_candidates").run();
    await db().prepare("INSERT INTO accounts(id, plan, created_at, used_bytes, extra_storage_bytes, cap_bytes) VALUES ('a','pro',?,0,0,1000)").bind(NOW).run();
    await catalog(hasRef);
    await db().prepare("INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES ('a',?,?)").bind(hasRef, NOW).run();
    await candidate(hasRef);
    expect((await body(await gcPurge(env, GRACE, { nowMs: NOW, owner: "p1-c" }))).opened).toBe(0);
    expect((await db().prepare("SELECT deleting_at FROM gc_candidates WHERE sha256=?").bind(hasRef).first<{ deleting_at: number | null }>())?.deleting_at).toBeNull();
  });

  it("does not re-stamp a P2-touched row in the same invocation", async () => {
    const reappeared = sha("reappeared");
    await catalog(reappeared);
    await put(reappeared);
    await candidate(reappeared, NOW - 10 * DAY, NOW - 2 * DAY);
    const real = env.rbox_dev_blobs;
    const raced = envWithBucket({
      delete: async (key: string) => {
        await real.delete(key);
        await real.put(key, "new-put-between-delete-and-head");
      },
      head: (key: string) => real.head(key),
    });
    const result = await body(await gcPurge(raced, GRACE, { nowMs: NOW, owner: "touch" }));
    expect(result).toMatchObject({ purged: 0, unwound: 1, opened: 0 });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", reappeared)).toBe(false);
    expect(await real.get(blobKey(reappeared))).not.toBeNull();
  });

  it("publication before P1 is observed by P2 and activity-unwind deletes candidacy", async () => {
    const published = sha("published");
    await catalog(published);
    await db().prepare("INSERT INTO accounts(id, plan, created_at, used_bytes, extra_storage_bytes, cap_bytes) VALUES ('a','pro',?,10,0,1000)").bind(NOW).run();
    await db().prepare("INSERT INTO blob_refs(account_id, sha256, granted_at) VALUES ('a',?,?)").bind(published, NOW).run();
    await candidate(published, NOW - 10 * DAY, NOW - 2 * DAY);
    const result = await body(await gcPurge(env, GRACE, { nowMs: NOW, owner: "refs" }));
    expect(result).toMatchObject({ purged: 0, unwound: 1 });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", published)).toBe(false);
    expect((await db().prepare("SELECT used_bytes FROM accounts WHERE id='a'").first<{ used_bytes: number }>())?.used_bytes).toBe(10);
  });
});

describe("design 95 delete/head/P3 order and re-entry", () => {
  it("a PUT between delete and head is preserved and unwinds the fence", async () => {
    const raceHead = sha("race-head");
    await catalog(raceHead, 12);
    await put(raceHead, "old");
    await candidate(raceHead, NOW - 10 * DAY, NOW - 2 * DAY);
    const real = env.rbox_dev_blobs;
    const raced = envWithBucket({
      delete: async (key: string) => {
        await real.delete(key);
        await real.put(key, "replacement");
      },
      head: (key: string) => real.head(key),
    });
    expect(await body(await gcPurge(raced, GRACE, { nowMs: NOW, owner: "race" }))).toMatchObject({ purged: 0, unwound: 1 });
    expect(await (await real.get(blobKey(raceHead)))?.text()).toBe("replacement");
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", raceHead)).toBe(false);
  });

  it("a publication attempt between head-verify and P3 is fenced, then succeeds in the fresh world", async () => {
    const raceP3 = sha("race-p3");
    await catalog(raceP3, 14);
    await put(raceP3);
    await candidate(raceP3, NOW - 10 * DAY, NOW - 2 * DAY);
    let fenceAborted = false;
    const real = env.rbox_dev_blobs;
    const raced = envWithBucket({
      delete: (key: string) => real.delete(key),
      head: async (key: string) => {
        const result = await real.head(key);
        await real.put(key, "fresh-pending-publication");
        try {
          await db().prepare("INSERT INTO blobs(sha256,size_bytes,present) VALUES (?,14,1) ON CONFLICT(sha256) DO UPDATE SET present=1").bind(raceP3).run();
        } catch (error) {
          fenceAborted = String(error).includes("rbox_delete_fence");
        }
        return result;
      },
    });
    expect(await body(await gcPurge(raced, GRACE, { nowMs: NOW, owner: "p3" }))).toMatchObject({ purged: 1 });
    expect(fenceAborted).toBe(true);
    await db().prepare("INSERT INTO blobs(sha256,size_bytes,present) VALUES (?,14,1) ON CONFLICT(sha256) DO UPDATE SET present=1").bind(raceP3).run();
    expect(await (await real.get(blobKey(raceP3)))?.text()).toBe("fresh-pending-publication");
  });

  it("death after delete but before head keeps the durable handle and re-entry completes idempotently", async () => {
    const death = sha("death");
    await catalog(death, 22);
    await put(death);
    await candidate(death, NOW - 10 * DAY, NOW - 2 * DAY);
    const real = env.rbox_dev_blobs;
    const dying = envWithBucket({ delete: (key: string) => real.delete(key), head: async () => { throw new Error("worker died"); } });
    const failed = await gcPurge(dying, GRACE, { nowMs: NOW, owner: "dead" });
    expect(failed.status).toBe(500);
    expect(await body(failed)).toMatchObject({ error: "gc_purge_failed" });
    const failedObservation = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_purge'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(failedObservation).toMatchObject({ outcome: "internal_500", stage: "execute", status: 500, errorClass: "Error" });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", death)).toBe(true);
    expect(await body(await gcPurge(env, GRACE, { nowMs: NOW + 1, owner: "retry" }))).toMatchObject({ purged: 1 });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", death)).toBe(false);
  });
});

describe("design 95 exclusive lease", () => {
  it("mutually excludes an active holder and permits takeover only after TTL plus quiescence", async () => {
    const active = { owner: "B", acquired: NOW, expires: NOW + PURGE_LEASE_TTL_MS };
    await db().prepare("INSERT INTO gc_state(k,v) VALUES ('purge_lease',?)").bind(JSON.stringify(active)).run();
    const runAt = (at: number) => gcPurge(env, GRACE, { nowMs: at, owner: "A", clock: () => at });
    expect(await body(await runAt(NOW + PURGE_LEASE_TTL_MS))).toMatchObject({ leaseBusy: true, retryAfterMs: TAKEOVER_QUIESCENCE_MS + 1 });
    const busyObservation = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_purge'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(busyObservation).toMatchObject({ outcome: "lease_busy", status: 409 });
    expect(await body(await runAt(active.expires + TAKEOVER_QUIESCENCE_MS))).toMatchObject({ leaseBusy: true });
    expect((await body(await runAt(active.expires + TAKEOVER_QUIESCENCE_MS + 1))).leaseBusy).not.toBe(true);
  });

  it("records lease_lost when renewal no longer owns the row", async () => {
    const realDb = db();
    const lostDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("UPDATE gc_state SET v=? WHERE k='purge_lease' AND json_extract")) return statement;
          return { bind: () => ({ run: async () => ({ meta: { changes: 0 } }) }) };
        };
      },
    }) as D1Database;
    const response = await gcPurge({ ...env, rbox_dev_db: lostDb } as Env, GRACE, { nowMs: NOW, owner: "lost" });
    expect(response.status).toBe(409);
    expect(await body(response)).toMatchObject({ purged: 0, opened: 0, leaseLost: true });
    const stored = JSON.parse((await realDb.prepare("SELECT v FROM gc_state WHERE k='gc_obs_purge'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "lease_lost", status: 409, purged: 0, opened: 0 });
  });

  it("retries a transient lease release failure after a purge error", async () => {
    const doomed = sha("release-retry");
    await catalog(doomed);
    await put(doomed);
    await candidate(doomed, NOW - 10 * DAY, NOW - 2 * DAY);
    let releaseAttempts = 0;
    const realDb = env.rbox_dev_db;
    const flakyDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("DELETE FROM gc_state WHERE k='purge_lease'")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return new Proxy(bound, {
                  get(boundStmt, boundProperty, boundReceiver) {
                    if (boundProperty !== "run") return Reflect.get(boundStmt, boundProperty, boundReceiver);
                    return async () => {
                      releaseAttempts++;
                      if (releaseAttempts === 1) throw new Error("transient D1 failure");
                      return boundStmt.run();
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;
    const real = env.rbox_dev_blobs;
    const failing: Env = {
      ...envWithBucket({ delete: (key: string) => real.delete(key), head: async () => { throw new Error("execute failed"); } }),
      rbox_dev_db: flakyDb,
    };

    const response = await gcPurge(failing, GRACE, { nowMs: NOW, owner: "flaky-release" });
    expect(response.status).toBe(500);
    expect(releaseAttempts).toBe(2);
    expect(await exists("SELECT 1 FROM gc_state WHERE k='purge_lease'")).toBe(false);
  });

  it("records an exhausted release failure without changing the successful response", async () => {
    const realDb = db();
    const failingRelease = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("DELETE FROM gc_state WHERE k='purge_lease'")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => ({
                run: async () => { throw new Error(`release failed ${args.length}`); },
              });
            },
          });
        };
      },
    }) as D1Database;
    const response = await gcPurge({ ...env, rbox_dev_db: failingRelease } as Env, GRACE, { nowMs: NOW, owner: "release-exhausted" });
    expect(response.status).toBe(200);
    expect(await body(response)).toMatchObject({ purged: 0, opened: 0 });
    const stored = JSON.parse((await realDb.prepare("SELECT v FROM gc_state WHERE k='gc_obs_purge'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "thrown", stage: "release", status: 200, errorClass: "Error" });
    expect(await exists("SELECT 1 FROM gc_state WHERE k='purge_lease'")).toBe(true);
  });

  it("observation write failure preserves the response and happens after lease cleanup", async () => {
    const failingObservation = failDbMethodOnce("VALUES (?1, json(?2))", "run");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await gcPurge({ ...env, rbox_dev_db: failingObservation } as Env, GRACE, { nowMs: NOW, owner: "obs-failure" });
      expect(response.status).toBe(200);
      expect(await body(response)).toMatchObject({ purged: 0, opened: 0 });
      expect(await exists("SELECT 1 FROM gc_state WHERE k='purge_lease'")).toBe(false);
      expect(await exists("SELECT 1 FROM gc_state WHERE k='gc_obs_purge'")).toBe(false);
      expect(logged).toHaveBeenCalledWith(expect.stringContaining('"event":"gc_observation_write_failed"'));
    } finally {
      logged.mockRestore();
    }
  });

  it("re-verifies lease expiry immediately before dispatch and leaves the fence intact", async () => {
    const expiresBeforeDelete = sha("expires-before-delete");
    await catalog(expiresBeforeDelete);
    await put(expiresBeforeDelete);
    await candidate(expiresBeforeDelete, NOW - 10 * DAY, NOW - 2 * DAY);
    let calls = 0;
    const clock = () => (++calls < 5 ? NOW : NOW + PURGE_LEASE_TTL_MS + 1);
    let deletes = 0;
    const bucket = envWithBucket({
      delete: async () => { deletes++; },
      head: (key: string) => env.rbox_dev_blobs.head(key),
    });
    await gcPurge(bucket, GRACE, { nowMs: NOW, owner: "expiring", deadlineMs: 60 * 60 * 1000, clock });
    expect(deletes).toBe(0);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", expiresBeforeDelete)).toBe(true);
  });

  it("a stale holder resumed at P3 cannot remove intent after successor takeover", async () => {
    const zombie = sha("zombie");
    await catalog(zombie);
    await put(zombie);
    await candidate(zombie, NOW - 10 * DAY, NOW - 2 * DAY);
    const real = env.rbox_dev_blobs;
    const stale = envWithBucket({
      delete: (key: string) => real.delete(key),
      head: async (key: string) => {
        const h = await real.head(key);
        const successor = { owner: "B", acquired: NOW, expires: NOW + PURGE_LEASE_TTL_MS };
        await db().prepare("UPDATE gc_state SET v=? WHERE k='purge_lease'").bind(JSON.stringify(successor)).run();
        return h;
      },
    });
    expect(await body(await gcPurge(stale, GRACE, { nowMs: NOW, owner: "A" }))).toMatchObject({ purged: 0 });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", zombie)).toBe(true);
    await db().prepare("DELETE FROM gc_state WHERE k='purge_lease'").run();
    expect(await body(await gcPurge(env, GRACE, { nowMs: NOW + 1, owner: "B" }))).toMatchObject({ purged: 1 });
  });

  it("the activity-unwind path is also guarded against a stale holder", async () => {
    const zombieUnwind = sha("zombie-unwind");
    await catalog(zombieUnwind);
    await put(zombieUnwind);
    await candidate(zombieUnwind, NOW - 10 * DAY, NOW - 2 * DAY);
    const real = env.rbox_dev_blobs;
    const stale = envWithBucket({
      delete: async () => {}, // leave an observable object so execution selects unwind
      head: async (key: string) => {
        const successor = { owner: "B", acquired: NOW, expires: NOW + PURGE_LEASE_TTL_MS };
        await db().prepare("UPDATE gc_state SET v=? WHERE k='purge_lease'").bind(JSON.stringify(successor)).run();
        return real.head(key);
      },
    });
    expect(await body(await gcPurge(stale, GRACE, { nowMs: NOW, owner: "A" }))).toMatchObject({ purged: 0, unwound: 0 });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", zombieUnwind)).toBe(true);
  });

  it("the admin deadline dispatches no new delete after 60s while leaving the intent re-entrant", async () => {
    const deadline = sha("deadline");
    await catalog(deadline);
    await put(deadline);
    await candidate(deadline, NOW - 10 * DAY, NOW - 2 * DAY);
    let deletes = 0;
    const bounded = envWithBucket({
      delete: async () => { deletes++; },
      head: (key: string) => env.rbox_dev_blobs.head(key),
    });
    await gcPurge(bounded, GRACE, { nowMs: NOW, owner: "deadline", deadlineMs: -1 });
    expect(deletes).toBe(0);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", deadline)).toBe(true);
  });
});

describe("design 95 candidacy classes and cursors", () => {
  it("a grant clears ordinary candidacy, while the trigger aborts atomically against an open intent", async () => {
    const grantOrdinary = sha("grant-ordinary");
    const grantIntent = sha("grant-intent");
    await db().prepare("INSERT INTO accounts(id, plan, created_at, used_bytes, extra_storage_bytes, cap_bytes) VALUES ('a','pro',?,0,0,1000)").bind(NOW).run();
    await catalog(grantOrdinary, 11);
    await candidate(grantOrdinary);
    expect(await grantEntitlementWithQuota(env, "a", grantOrdinary, 11, NOW)).toMatchObject({ granted: true, used: 11 });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", grantOrdinary)).toBe(false);

    await catalog(grantIntent, 13);
    await candidate(grantIntent, NOW - 10 * DAY, NOW - DAY / 2);
    await expect(grantEntitlementWithQuota(env, "a", grantIntent, 13, NOW)).rejects.toThrow(/rbox_delete_fence/);
    expect(await exists("SELECT 1 FROM blob_refs WHERE account_id='a' AND sha256=?", grantIntent)).toBe(false);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", grantIntent)).toBe(true);
    expect((await db().prepare("SELECT used_bytes FROM accounts WHERE id='a'").first<{ used_bytes: number }>())?.used_bytes).toBe(11);
  });

  it("reachable resurrection clears ordinary candidacy but never directly clears an open intent", async () => {
    const ordinary = sha("ordinary");
    const intent = sha("intent");
    await candidate(ordinary);
    await candidate(intent, NOW - 10 * DAY, NOW - DAY / 2);
    await db().prepare("INSERT INTO workspaces(workspace_id,project_id,created_at) VALUES ('w','p',?)").bind(NOW).run();
    const rooted = {
      ...env,
      WORKSPACE_SYNC: {
        idFromName: () => ({}) as DurableObjectId,
        get: () => ({ fetch: async () => Response.json({ head: 1, pruneFloor: 0, indexGeneration: 1, gap: [], droppedPage: [ordinary, intent], seqRootsPage: [] }) }),
      } as unknown as DurableObjectNamespace,
    } as Env;
    await gcPurge(rooted, GRACE, { nowMs: NOW, owner: "roots" });
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", ordinary)).toBe(false);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NOT NULL", intent)).toBe(true);
  });

  it("execute and intent cursors are independent, so ordinary backlog does not hide an old intent", async () => {
    const intentNow = sha("intent-now");
    await catalog(intentNow, 9);
    await put(intentNow);
    await candidate(intentNow, NOW - 20 * DAY, NOW - 2 * DAY);
    for (let i = 0; i < 220; i++) await candidate(sha(`ordinary-${String(i).padStart(3, "0")}`), NOW - 10 * DAY);
    await db().prepare("INSERT INTO gc_state(k,v) VALUES ('intent_cursor',?)").bind(JSON.stringify({ markedAt: NOW, sha256: sha("zzzz") })).run();
    const result = await body(await gcPurge(env, GRACE, { nowMs: NOW, owner: "cursor" }));
    expect(result.purged).toBe(1);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=?", intentNow)).toBe(false);
    expect(await exists("SELECT 1 FROM gc_state WHERE k='execute_cursor'")).toBe(true);
    expect(await exists("SELECT 1 FROM gc_state WHERE k='intent_cursor'")).toBe(true);
  });
});

describe("design 95 bounded work and read-only audit", () => {
  it.each([
    ["snapshot", "SELECT workspace_id, project_id FROM workspaces", "all"],
    ["count", "SELECT COUNT(*) AS n FROM workspaces", "first"],
    ["state_read", "SELECT v FROM gc_state WHERE k = ?", "first"],
    ["state_write", "INSERT INTO gc_state (k, v) VALUES (?, ?)", "run"],
  ] as const)("gcMark records a thrown %s failure", async (stage, sql, method) => {
    if (stage === "count") await workspaces(9);
    const failing = failDbMethodOnce(sql, method);
    await expect(gcMark({ ...env, rbox_dev_db: failing } as Env, 0, NOW)).rejects.toThrow("injected");
    const stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "thrown", stage, errorClass: "Error" });
  });

  it("gcMark records thrown reachability and list failures", async () => {
    await workspaces(1);
    const rootsFailure = {
      ...env,
      WORKSPACE_SYNC: {
        idFromName: () => ({} as DurableObjectId),
        get: () => ({ fetch: async () => new Response("failed", { status: 500 }) }),
      } as unknown as DurableObjectNamespace,
    } as Env;
    await expect(gcMark(rootsFailure, 0, NOW)).rejects.toThrow("fail-closed");
    let stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "thrown", stage: "reachability" });

    await db().batch([db().prepare("DELETE FROM workspaces"), db().prepare("DELETE FROM gc_state")]);
    const listFailure = { ...env, rbox_dev_blobs: { list: async () => { throw new Error("list failed"); } } as unknown as R2Bucket } as Env;
    await expect(gcMark(listFailure, 0, NOW)).rejects.toThrow("list failed");
    stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "thrown", stage: "list" });
  });

  it("gcMark records candidate_write failures", async () => {
    const realDb = db();
    const failingBatch = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property === "batch") return async () => { throw new Error("candidate batch failed"); };
        return Reflect.get(target, property, receiver);
      },
    }) as D1Database;
    const candidateEnv = {
      ...env,
      rbox_dev_db: failingBatch,
      rbox_dev_blobs: {
        list: async () => ({
          objects: [{ key: "blobs/sha256/candidate", uploaded: new Date(NOW - 1) }],
          truncated: false,
          delimitedPrefixes: [],
        }),
      } as unknown as R2Bucket,
    } as Env;
    await expect(gcMark(candidateEnv, 0, NOW)).rejects.toThrow("candidate batch failed");
    const stored = JSON.parse((await realDb.prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "thrown", stage: "candidate_write" });
  });

  it("records roots_cap_exceeded with the exact lower-bound sample and preserves the throw", async () => {
    await workspaces(1);
    const capped = {
      ...env,
      WORKSPACE_SYNC: {
        idFromName: () => ({} as DurableObjectId),
        get: () => ({
          fetch: async () => ({
            status: 200,
            ok: true,
            json: async () => ({
              head: 0,
              pruneFloor: 0,
              indexGeneration: 0,
              gap: [],
              droppedPage: {
                *[Symbol.iterator]() {
                  for (let i = 0; i <= 750_000; i++) yield `root-${i}`;
                },
              },
              seqRootsPage: [],
            }),
          }) as Response,
        }),
      } as unknown as DurableObjectNamespace,
    } as Env;
    await expect(gcMark(capped, 0, NOW)).rejects.toThrow("reachable roots exceed");
    const stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({
      outcome: "roots_cap_exceeded",
      stage: "reachability",
      rootsSample: { value: 750_000, measuredAt: stored.at, lowerBound: true },
    });
  });

  it("records the zero_chunk terminal path", async () => {
    const realDb = db();
    let lengthReads = 0;
    const rows = new Proxy([] as Array<{ workspace_id: string; project_id: string }>, {
      get(target, property, receiver) {
        if (property === "length") return lengthReads++ === 0 ? 8 : GC_BUDGET_SAFE;
        if (property === Symbol.iterator) return function* () {};
        return Reflect.get(target, property, receiver);
      },
    });
    const synthetic = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT workspace_id, project_id FROM workspaces")) return statement;
          return { bind: () => ({ all: async () => ({ results: rows }) }) };
        };
      },
    }) as D1Database;
    const response = await gcPurge({ ...env, rbox_dev_db: synthetic } as Env, GRACE, { nowMs: NOW, owner: "zero" });
    expect(await body(response)).toMatchObject({ purged: 0, opened: 0, executeLimit: 0 });
    const stored = JSON.parse((await realDb.prepare("SELECT v FROM gc_state WHERE k='gc_obs_purge'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ outcome: "zero_chunk", status: 200, purged: 0, opened: 0 });
  });

  for (const phase of ["mark", "purge"] as const) {
    for (const rowCount of [8, 9, 12]) {
      it(`${phase} reports the exact workspace count at ${rowCount} rows`, async () => {
        await workspaces(rowCount);
        const rooted = emptyRootsEnv();
        const response = phase === "mark"
          ? await gcMark(rooted.value, GRACE, NOW)
          : await gcPurge(rooted.value, GRACE, { nowMs: NOW, owner: `${phase}-${rowCount}` });
        expect(response.status).toBe(200);
        const result = await body(response, rowCount > GC_MAX_WORKSPACE_ROWS);
        if (rowCount <= GC_MAX_WORKSPACE_ROWS) {
          expect(result.budgetExceeded).not.toBe(true);
          expect(rooted.calls()).toBe(rowCount);
          const stored = JSON.parse((await db().prepare(`SELECT v FROM gc_state WHERE k='gc_obs_${phase}'`).first<{ v: string }>())!.v) as GcObservationV1;
          expect(stored).toMatchObject({
            outcome: "success",
            status: 200,
            rows: rowCount,
            ...(phase === "mark" ? { marked: 0 } : { purged: 0, opened: 0 }),
            rootsSample: { value: 0 },
          });
        } else {
          expect(result).toMatchObject({
            budgetExceeded: true,
            ok: false,
            reason: "roots_budget_exceeded",
            rows: rowCount,
            maxRows: 8,
            uniqueRoots: null,
            maxRoots: 750_000,
            ...(phase === "mark" ? { marked: 0 } : { purged: 0, opened: 0 }),
          });
          expect(rooted.calls()).toBe(0);
          const state = await db().prepare("SELECT k FROM gc_state ORDER BY k").all<{ k: string }>();
          expect(state.results?.map((row) => row.k)).toEqual([`gc_obs_${phase}`]);
          const stored = JSON.parse((await db().prepare(`SELECT v FROM gc_state WHERE k='gc_obs_${phase}'`).first<{ v: string }>())!.v) as GcObservationV1;
          expect(stored).toMatchObject({ outcome: "roots_budget_exceeded", status: 200, rows: rowCount, rootsSample: null });
          expect(await exists("SELECT 1 FROM gc_candidates")).toBe(false);
        }
      });
    }
  }

  it("reports a post-breach COUNT that may drift from the sentinel snapshot", async () => {
    await workspaces(9);
    const realDb = db();
    let drifted = false;
    const racedDb = new Proxy(realDb, {
      get(target, property, receiver) {
        if (property !== "prepare") return Reflect.get(target, property, receiver);
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT workspace_id, project_id FROM workspaces")) return statement;
          return new Proxy(statement, {
            get(stmt, stmtProperty, stmtReceiver) {
              if (stmtProperty !== "bind") return Reflect.get(stmt, stmtProperty, stmtReceiver);
              return (...args: unknown[]) => {
                const bound = stmt.bind(...args);
                return new Proxy(bound, {
                  get(boundStmt, boundProperty, boundReceiver) {
                    if (boundProperty !== "all") return Reflect.get(boundStmt, boundProperty, boundReceiver);
                    return async () => {
                      const snapshot = await boundStmt.all();
                      if (!drifted) {
                        drifted = true;
                        await realDb.prepare("INSERT INTO workspaces(workspace_id,project_id,created_at) VALUES (?,?,?)")
                          .bind(`${testPrefix}-late`, "p", NOW).run();
                      }
                      return snapshot;
                    };
                  },
                });
              };
            },
          });
        };
      },
    }) as D1Database;
    const result = await body(await gcPurge({ ...env, rbox_dev_db: racedDb } as Env, GRACE, { nowMs: NOW, owner: "drift" }), true);
    expect(result).toMatchObject({ budgetExceeded: true, rows: 10, maxRows: 8, purged: 0, opened: 0 });
  });

  it("uses the combined P2+P1 budget arithmetic", async () => {
    const result = await body(await gcPurge(env, GRACE, { nowMs: NOW, owner: "math" }));
    expect(result.executeLimit).toBe(Math.min(200, Math.floor((GC_BUDGET_SAFE - 1 - GC_FIXED_COST - GC_P1_COST) / GC_PER_EXECUTE)));
  });

  it("makes an overfull arithmetic result an explicit zero-chunk exit", () => {
    expect(gcExecuteLimit(GC_BUDGET_SAFE)).toBe(0);
  });

  it("sentinel-W exits before any DO fan-out or GC mutation", async () => {
    const maxW = Math.floor((GC_BUDGET_SAFE - GC_FIXED_COST - GC_PER_EXECUTE - GC_P1_COST - 1) / PER_WORKSPACE_ROOTS_COST);
    for (let base = 0; base < maxW + 1; base += 30) {
      const n = Math.min(30, maxW + 1 - base); // 30 rows × 3 binds = 90 < D1's ~100-param limit
      await db().prepare(`INSERT INTO workspaces(workspace_id,project_id,created_at) VALUES ${Array.from({ length: n }, () => "(?,?,?)").join(",")}`)
        .bind(...Array.from({ length: n }, (_, i) => [`w${base + i}`, "p", NOW]).flat()).run();
    }
    let calls = 0;
    const guarded = {
      ...env,
      WORKSPACE_SYNC: { idFromName: () => ({}), get: () => ({ fetch: async () => { calls++; return Response.json({ head: 0, pruneFloor: 0, indexGeneration: 0, gap: [], droppedPage: [], seqRootsPage: [] }); } }) } as unknown as DurableObjectNamespace,
    } as Env;
    expect(await body(await gcPurge(guarded, GRACE, { nowMs: NOW, owner: "budget" }), true)).toMatchObject({ budgetExceeded: true, purged: 0, opened: 0 });
    expect(calls).toBe(0);
    expect((await db().prepare("SELECT k FROM gc_state").all<{ k: string }>()).results?.map((row) => row.k)).toEqual(["gc_obs_purge"]);
  });

  it("monotonically merges the T1/T2/T3 envelope and roots-sample components", async () => {
    const observation = (at: string, outcome: GcObservationV1["outcome"], measuredAt: string | null): GcObservationV1 => ({
      v: 1,
      at,
      outcome,
      rootsSample: measuredAt ? { value: Number(measuredAt.slice(14, 16)), measuredAt } : null,
    });
    const t1 = observation("2027-01-01T00:00:01.000Z", "success", "2027-01-01T00:00:01.000Z");
    const t2 = observation("2027-01-01T00:00:02.000Z", "success", "2027-01-01T00:00:04.000Z");
    const t3 = observation("2027-01-01T00:00:03.000Z", "thrown", "2027-01-01T00:00:03.000Z");
    for (const current of [t1, t3, t2]) await writeGcObservation(db(), "gc_obs_mark", current);
    const stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored).toMatchObject({ at: t3.at, outcome: t3.outcome, rootsSample: t2.rootsSample });

    await db().prepare("DELETE FROM gc_state WHERE k='gc_obs_mark'").run();
    for (const current of [t3, t2, t1]) await writeGcObservation(db(), "gc_obs_mark", current);
    const reverse = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(reverse).toMatchObject({ at: t3.at, outcome: t3.outcome, rootsSample: t2.rootsSample });
  });

  it("applies the ruled equal-time observation tie semantics", async () => {
    const at = "2027-01-01T00:00:01.000Z";
    const lower: GcObservationV1 = { v: 1, at, outcome: "success", rootsSample: { value: 750_000, measuredAt: at, lowerBound: true } };
    const ordinary: GcObservationV1 = { v: 1, at, outcome: "thrown", rootsSample: null };
    await writeGcObservation(db(), "gc_obs_mark", lower);
    await writeGcObservation(db(), "gc_obs_mark", ordinary);
    let stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored.outcome).toBe("success");

    const cap: GcObservationV1 = { ...lower, outcome: "roots_cap_exceeded", stage: "reachability" };
    await writeGcObservation(db(), "gc_obs_mark", cap);
    stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored.outcome).toBe("roots_cap_exceeded");

    const complete: GcObservationV1 = { ...ordinary, at: "2027-01-01T00:00:02.000Z", rootsSample: { value: 749_999, measuredAt: at } };
    await writeGcObservation(db(), "gc_obs_mark", complete);
    stored = JSON.parse((await db().prepare("SELECT v FROM gc_state WHERE k='gc_obs_mark'").first<{ v: string }>())!.v) as GcObservationV1;
    expect(stored.rootsSample).toEqual(complete.rootsSample);
  });

  it("health carries a successful sample through a later failure and warns at exact thresholds", async () => {
    expect(await gcHealthData(env)).toMatchObject({ ok: true, rows: 0, uniqueRoots: null, warn: false });
    const firstAt = "2027-01-01T00:00:01.000Z";
    await writeGcObservation(db(), "gc_obs_mark", {
      v: 1,
      at: firstAt,
      outcome: "success",
      rootsSample: { value: 562_499, measuredAt: firstAt },
    });
    await writeGcObservation(db(), "gc_obs_mark", {
      v: 1,
      at: "2027-01-01T00:00:02.000Z",
      outcome: "thrown",
      stage: "list",
      errorClass: "Error",
      rootsSample: null,
    });
    expect(await gcHealthData(env)).toMatchObject({
      uniqueRoots: { value: 562_499, measuredAt: firstAt, stale: true },
      mark: { outcome: "thrown" },
      warn: false,
    });
    const thresholdAt = "2027-01-01T00:00:03.000Z";
    await writeGcObservation(db(), "gc_obs_purge", {
      v: 1,
      at: thresholdAt,
      outcome: "success",
      rootsSample: { value: 562_500, measuredAt: thresholdAt },
    });
    expect((await gcHealthData(env)).warn).toBe(true);

    const capAt = "2027-01-01T00:00:04.000Z";
    await writeGcObservation(db(), "gc_obs_mark", {
      v: 1,
      at: capAt,
      outcome: "roots_cap_exceeded",
      stage: "reachability",
      rootsSample: { value: 750_000, measuredAt: capAt, lowerBound: true },
    });
    expect(await gcHealthData(env)).toMatchObject({
      mark: { outcome: "roots_cap_exceeded" },
      uniqueRoots: { value: 750_000, stale: true, lowerBound: true },
      warn: true,
    });
    const newerSmallAt = "2027-01-01T00:00:05.000Z";
    await writeGcObservation(db(), "gc_obs_purge", {
      v: 1,
      at: newerSmallAt,
      outcome: "success",
      rootsSample: { value: 1, measuredAt: newerSmallAt },
    });
    expect(await gcHealthData(env)).toMatchObject({ uniqueRoots: { value: 1 }, warn: true });
  });

  it("health uses exact row thresholds, stays read-only, and the platform GET is gated", async () => {
    const rooted = emptyRootsEnv();
    await workspaces(5);
    expect((await gcHealthData(rooted.value)).warn).toBe(false);
    await workspaces(1);
    const before = (await db().prepare("SELECT k,v FROM gc_state ORDER BY k").all()).results;
    expect((await gcHealthData(rooted.value)).warn).toBe(true);
    expect((await gcHealthData(rooted.value)).warn).toBe(true);
    await db().prepare("DELETE FROM workspaces WHERE workspace_id=(SELECT workspace_id FROM workspaces ORDER BY workspace_id LIMIT 1)").run();
    expect((await gcHealthData(rooted.value)).warn).toBe(false);
    expect(rooted.calls()).toBe(0);
    expect((await db().prepare("SELECT k,v FROM gc_state ORDER BY k").all()).results).toEqual(before);

    expect((await SELF.fetch("https://example.com/v1/admin/gc?phase=health")).status).toBe(404);
    const response = await SELF.fetch("https://example.com/v1/admin/gc?phase=health", { headers: { "x-rbox-platform": "test-platform-secret" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, rows: 5, maxRows: 8, maxRoots: 750_000, warn: false });

    await workspaces(20);
    expect(await gcHealthData(rooted.value)).toMatchObject({ rows: 25, warn: true });
    expect(rooted.calls()).toBe(0);
  });

  it("gcMark puts 33-row statements in one D1 batch and advances {prefix,cursor}", async () => {
    const objects = Array.from({ length: 70 }, (_, i) => ({ key: `blobs/sha256/${sha(`mark-${i}`)}`, uploaded: new Date(NOW - DAY) }));
    const batchSizes: number[] = [];
    const d1 = new Proxy(db(), {
      get(target, prop, receiver) {
        if (prop === "batch") return async (statements: D1PreparedStatement[]) => { batchSizes.push(statements.length); return target.batch(statements); };
        return Reflect.get(target, prop, receiver);
      },
    });
    const marked = {
      ...env,
      rbox_dev_db: d1,
      rbox_dev_blobs: { list: async () => ({ objects, truncated: true, cursor: "next-page", delimitedPrefixes: [] }) } as unknown as R2Bucket,
    } as Env;
    const result = (await (await gcMark(marked, 0, NOW)).json()) as { marked: number; cursor: { prefix: string; cursor?: string } };
    expect(result).toEqual({ marked: 70, cursor: { prefix: "blobs/sha256/", cursor: "next-page" } });
    expect(batchSizes).toEqual([Math.ceil(70 / GC_INSERT_ROWS)]);
    expect(await db().prepare("SELECT v FROM gc_state WHERE k='mark_cursor'").first<{ v: string }>()).toMatchObject({ v: JSON.stringify({ prefix: "blobs/sha256/", cursor: "next-page" }) });
  });

  it("audit clamps to the W-aware execute budget and performs zero mutations", async () => {
    for (let i = 0; i < 205; i++) await candidate(sha(`audit-${String(i).padStart(3, "0")}`));
    const before = Number((await db().prepare("SELECT COUNT(*) n FROM gc_candidates").first<{ n: number }>())?.n);
    const audit = (await (await gcAudit(env, GRACE, null, 10_000, NOW)).json()) as { limit: number; examined: number; wouldIntent: number; cursor: string | null };
    const expectedLimit = Math.min(200, Math.floor((GC_BUDGET_SAFE - 1 - GC_FIXED_COST - GC_P1_COST) / GC_PER_EXECUTE));
    expect(audit).toMatchObject({ limit: expectedLimit, examined: expectedLimit, wouldIntent: expectedLimit });
    expect(audit.cursor).not.toBeNull();
    let totalExamined = audit.examined;
    let totalWouldIntent = audit.wouldIntent;
    let cursor = audit.cursor;
    while (cursor) {
      const next = (await (await gcAudit(env, GRACE, cursor, 10_000, NOW)).json()) as {
        examined: number;
        wouldIntent: number;
        cursor: string | null;
      };
      totalExamined += next.examined;
      totalWouldIntent += next.wouldIntent;
      cursor = next.cursor;
    }
    expect({ totalExamined, totalWouldIntent }).toEqual({ totalExamined: 205, totalWouldIntent: 205 });
    expect(Number((await db().prepare("SELECT COUNT(*) n FROM gc_candidates").first<{ n: number }>())?.n)).toBe(before);
    expect(await exists("SELECT 1 FROM gc_state")).toBe(false);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE deleting_at IS NOT NULL")).toBe(false);
  });

  it("emits the 72h stale-intent metric and Phase 2 never changes usage", async () => {
    const staleSha = sha("stale");
    await db().prepare("INSERT INTO accounts(id, plan, created_at, used_bytes, extra_storage_bytes, cap_bytes) VALUES ('usage','pro',?,777,0,1000)").bind(NOW).run();
    await catalog(staleSha, 15);
    await put(staleSha);
    await candidate(staleSha, NOW - 20 * DAY, NOW - STALE_INTENT_MS - 1);
    const points: Array<{ blobs: string[]; doubles: number[] }> = [];
    await gcPurge(envWithBucket(env.rbox_dev_blobs, points), GRACE, { nowMs: NOW, owner: "metrics", deadlineMs: -1 });
    const stale = points.find((p) => p.blobs[0] === "gc.intents.stale");
    expect(stale?.doubles[5]).toBe(1);
    expect((await db().prepare("SELECT used_bytes FROM accounts WHERE id='usage'").first<{ used_bytes: number }>())?.used_bytes).toBe(777);
  });
});

describe("design 95 cron steering and rollout switch", () => {
  const eventAt = (hour: number) => ({ scheduledTime: Date.UTC(2027, 0, 15, hour, 23) }) as ScheduledController;

  it("reserves exactly two daily hours, leaving 22 regular maintenance ticks", () => {
    expect(new Set([GC_MARK_UTC_HOUR, GC_PURGE_UTC_HOUR])).toEqual(new Set([8, 9]));
    expect(Array.from({ length: 24 }, (_, h) => h).filter((h) => h !== GC_MARK_UTC_HOUR && h !== GC_PURGE_UTC_HOUR)).toHaveLength(22);
  });

  it("runs mark at 08 UTC even while purge is disabled", async () => {
    const scheduled = eventAt(GC_MARK_UTC_HOUR);
    const cronMark = sha("cron-mark");
    const marked = {
      ...env,
      RBOX_GC_PURGE_DISABLED: "1",
      rbox_dev_blobs: {
        list: async () => ({
          objects: [{ key: `blobs/sha256/${cronMark}`, uploaded: new Date(scheduled.scheduledTime - GRACE - 1) }],
          truncated: false,
          delimitedPrefixes: [],
        }),
      } as unknown as R2Bucket,
    } as Env;
    await worker.scheduled(scheduled, marked);
    expect(await exists("SELECT 1 FROM gc_candidates WHERE sha256=? AND deleting_at IS NULL", cronMark)).toBe(true);
  });

  it("uses scheduledTime for 09 UTC, gates only cron purge, and runs when enabled", async () => {
    const scheduled = eventAt(GC_PURGE_UTC_HOUR);
    const cronDisabled = sha("cron-disabled");
    const cronEnabled = sha("cron-enabled");
    await candidate(cronDisabled, Date.now() - GRACE - 1);
    await worker.scheduled(scheduled, { ...env, RBOX_GC_PURGE_DISABLED: "1" });
    expect((await db().prepare("SELECT deleting_at FROM gc_candidates WHERE sha256=?").bind(cronDisabled).first<{ deleting_at: number | null }>())?.deleting_at).toBeNull();

    await candidate(cronEnabled, Date.now() - GRACE - 1);
    await worker.scheduled(scheduled, { ...env, RBOX_GC_PURGE_DISABLED: "0" });
    expect((await db().prepare("SELECT deleting_at FROM gc_candidates WHERE sha256=?").bind(cronEnabled).first<{ deleting_at: number | null }>())?.deleting_at).not.toBeNull();
  });

  it("emits level-triggered health warnings at 5→6, repeated 6, and 6→5 rows", async () => {
    await workspaces(5);
    const rooted = emptyRootsEnv();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await worker.scheduled(eventAt(GC_MARK_UTC_HOUR), rooted.value);
      expect(warning).toHaveBeenCalledTimes(0);
      await workspaces(1);
      await worker.scheduled(eventAt(GC_MARK_UTC_HOUR), rooted.value);
      await worker.scheduled(eventAt(GC_MARK_UTC_HOUR), rooted.value);
      expect(warning).toHaveBeenCalledTimes(2);
      await db().prepare("DELETE FROM workspaces WHERE workspace_id=(SELECT workspace_id FROM workspaces ORDER BY workspace_id LIMIT 1)").run();
      await worker.scheduled(eventAt(GC_MARK_UTC_HOUR), rooted.value);
      expect(warning).toHaveBeenCalledTimes(2);
    } finally {
      warning.mockRestore();
    }
  });

  it("emits scheduled warnings at 562,500 roots but not 562,499", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const belowAt = "2027-01-01T00:00:01.000Z";
      await writeGcObservation(db(), "gc_obs_mark", {
        v: 1,
        at: belowAt,
        outcome: "success",
        rootsSample: { value: 562_499, measuredAt: belowAt },
      });
      await worker.scheduled(eventAt(GC_PURGE_UTC_HOUR), { ...env, RBOX_GC_PURGE_DISABLED: "1" });
      expect(warning).toHaveBeenCalledTimes(0);

      const thresholdAt = "2027-01-01T00:00:02.000Z";
      await writeGcObservation(db(), "gc_obs_purge", {
        v: 1,
        at: thresholdAt,
        outcome: "success",
        rootsSample: { value: 562_500, measuredAt: thresholdAt },
      });
      await worker.scheduled(eventAt(GC_PURGE_UTC_HOUR), { ...env, RBOX_GC_PURGE_DISABLED: "1" });
      expect(warning).toHaveBeenCalledTimes(1);
    } finally {
      warning.mockRestore();
    }
  });
});
