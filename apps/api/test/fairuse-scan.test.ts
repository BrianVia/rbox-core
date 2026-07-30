import { applyD1Migrations, env } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { Env } from "../src/env.js";
import {
  acquireFairUseLease,
  declaredRefCount,
  FAIRUSE_GROUP_REF_CAP,
  FAIRUSE_LEASE_QUIESCENCE_MS,
  FAIRUSE_LEASE_TTL_MS,
  guardSql,
  headRefSet,
  parseHeadEnvelope,
  releaseFairUseLease,
  renewFairUseLease,
  runFairUseObservation,
  type FairUseTuning,
  type HeadEnvelope,
  type HeadRefMode,
} from "../src/fairuse.js";
import { usage } from "../src/billing.js";
import { WorkspaceSync } from "../src/workspace-sync.js";
import { fakeDoSql } from "./helpers/fake-do-sql.js";
import { serializeRefset } from "../../../src/engine/refset.js";
import { blobKey, sha256Hex } from "../src/util.js";

const NOW = Date.now();
const GENESIS = "0".repeat(64);
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
    db().prepare("DELETE FROM fairuse_group_progress"),
    db().prepare("DELETE FROM fairuse_workspace_group_totals"),
    db().prepare("DELETE FROM fairuse_workspace_streams"),
    db().prepare("DELETE FROM fairuse_scans"),
    db().prepare("DELETE FROM fairuse_leases"),
    db().prepare("DELETE FROM fairuse_account_queue"),
    db().prepare("DELETE FROM fairuse_scheduler"),
    // Every file in a Workers shard shares one D1, and the fair-use scheduler
    // discovers accounts globally: a foreign account row sorting below these
    // ids wins `ORDER BY next_run_at,account_id` and consumes the invocation
    // these tests expect to spend on their own account. Tombstoning leftovers
    // makes this file the scheduler's whole world.
    db().prepare("UPDATE accounts SET deleted_at=? WHERE deleted_at IS NULL").bind(NOW),
    db().prepare("DELETE FROM workspaces WHERE account_id LIKE 'acct_000_fairuse_%'"),
    db().prepare("DELETE FROM blob_refs WHERE account_id LIKE 'acct_000_fairuse_%'"),
    db().prepare("DELETE FROM accounts WHERE id LIKE 'acct_000_fairuse_%'"),
    db().prepare("DELETE FROM meta_deploy_floor WHERE key LIKE 'test_%'"),
  ]);
});

// ---- fixtures -------------------------------------------------------------

interface ProjectState {
  head: number;
  empty?: boolean;
  encManifestSha?: string;
  refMode?: HeadRefMode | null;
  chainRefs?: string[];
  pruneFloor?: number;
  indexGeneration?: number;
  failWith?: { status: number; reason: string };
  reads: number;
  /** Mutate the project between DO reads: head churn, a sidecar that appears late. */
  onRead?: (state: ProjectState) => void;
}

interface DoLog {
  paths: string[];
  headReads: string[];
  r2Gets: string[];
}

function project(overrides: Partial<ProjectState> = {}): ProjectState {
  return { head: 1, encManifestSha: sha(0x900_000), refMode: { kind: "inline", refShas: [] }, reads: 0, ...overrides };
}

function scanningEnv(projects: Record<string, ProjectState>, log: DoLog): Env {
  const blobs = {
    get: (key: string, options?: unknown) => {
      log.r2Gets.push(key);
      return (env.rbox_dev_blobs as unknown as { get: (k: string, o?: unknown) => unknown }).get(key, options);
    },
  } as unknown as R2Bucket;
  return {
    ...env,
    rbox_dev_blobs: blobs,
    WORKSPACE_SYNC: {
      idFromName: (name: string) => ({ name }),
      get: (id: { name: string }) => ({
        fetch: async (input: string | Request) => {
          const url = new URL(typeof input === "string" ? input : input.url);
          log.paths.push(url.pathname);
          const state = projects[id.name];
          if (!state) throw new Error(`unexpected workspace ${id.name}`);
          if (url.searchParams.get("head") !== "1") throw new Error("fair-use must only use the head-envelope mode");
          log.headReads.push(id.name);
          state.reads++;
          state.onRead?.(state);
          if (state.failWith) {
            return Response.json({ error: "index_unavailable", reason: state.failWith.reason }, { status: state.failWith.status });
          }
          const base = { pruneFloor: state.pruneFloor ?? 0, indexGeneration: state.indexGeneration ?? 0 };
          if (state.empty) {
            return Response.json({ ...base, head: state.head, commitHash: GENESIS, empty: true, encManifestSha: null, refMode: null, chainRefs: [] });
          }
          return Response.json({
            ...base,
            head: state.head,
            commitHash: sha(7),
            empty: false,
            encManifestSha: state.encManifestSha,
            refMode: state.refMode,
            chainRefs: state.chainRefs ?? [],
          });
        },
      }),
    } as unknown as DurableObjectNamespace,
  } as Env;
}

const log = (): DoLog => ({ paths: [], headReads: [], r2Gets: [] });

async function seedAccount(
  accountId: string,
  projects: Array<{ ws: string; proj: string }>,
  catalog: Array<{ sha: string; size: number }>,
): Promise<void> {
  await db().batch([
    db().prepare("INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes) VALUES(?,?,'pro','bootstrap',?,?)")
      .bind(accountId, accountId, NOW, 250 * 1024 * 1024 * 1024),
    ...projects.map((p) => db().prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES(?,?,?,?)")
      .bind(p.ws, p.proj, accountId, NOW)),
    db().prepare("INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)")
      .bind(accountId, NOW - 1, "test", NOW),
  ]);
  for (let offset = 0; offset < catalog.length; offset += 40) {
    await db().batch(catalog.slice(offset, offset + 40).flatMap((entry) => [
      db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(entry.sha, entry.size),
      db().prepare("INSERT OR IGNORE INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)").bind(accountId, entry.sha, NOW),
    ]));
  }
}

async function drive(fakeEnv: Env, accountId: string, turns = 12, tuning?: FairUseTuning): Promise<string> {
  // The scheduler is global and spends one invocation on one account; make this
  // account the whole world so a sibling fixture cannot steal the turn.
  await db().batch([
    db().prepare("UPDATE accounts SET deleted_at=? WHERE id<>? AND deleted_at IS NULL").bind(NOW, accountId),
    db().prepare("DELETE FROM fairuse_account_queue WHERE account_id<>?").bind(accountId),
  ]);
  for (let turn = 0; turn < turns; turn++) {
    const state = await scan(accountId);
    if (state?.status === "complete" || state?.status === "aborted_pins") break;
    await runFairUseObservation(fakeEnv, NOW, tuning);
  }
  return (await scan(accountId))?.status ?? "none";
}

async function scan(accountId: string): Promise<{ status: string; epoch: number } | null> {
  return db().prepare("SELECT status,epoch FROM fairuse_scans WHERE account_id=? ORDER BY epoch DESC LIMIT 1")
    .bind(accountId).first<{ status: string; epoch: number }>();
}

async function completedScan(accountId: string): Promise<Record<string, number | string | null> | null> {
  return db().prepare(
    `SELECT status,active_bytes,history_bytes,bound_bytes,history_computed,entitlement_missing_count,completed_at
     FROM fairuse_scans WHERE account_id=? ORDER BY epoch DESC LIMIT 1`,
  ).bind(accountId).first<Record<string, number | string | null>>();
}

async function groupTotals(accountId: string): Promise<Array<{ workspace_id: string; active_bytes: number }>> {
  const rows = await db().prepare("SELECT workspace_id,active_bytes FROM fairuse_workspace_group_totals WHERE account_id=? ORDER BY workspace_id")
    .bind(accountId).all<{ workspace_id: string; active_bytes: number }>();
  return (rows.results ?? []).map((row) => ({ workspace_id: row.workspace_id, active_bytes: Number(row.active_bytes) }));
}

/** Publish a real, canonically encoded sidecar to R2 at its own content address. */
async function publishSidecar(refs: Array<{ encSha: string; size: number }>): Promise<{ sidecarSha: string; count: number }> {
  const sorted = [...refs].sort((a, b) => (a.encSha < b.encSha ? -1 : 1));
  const bytes = serializeRefset(sorted);
  const sidecarSha = await sha256Hex(bytes);
  await env.rbox_dev_blobs.put(blobKey(sidecarSha), bytes);
  return { sidecarSha, count: sorted.length };
}

// ---- the active-bytes fast path ------------------------------------------

describe("design 225 active bytes at head", () => {
  test("completes under head churn with the EXACT captured-snapshot total", async () => {
    const accountId = "acct_000_fairuse_churn";
    const ws = "ws_churn";
    const before = [{ sha: sha(1), size: 11 }, { sha: sha(2), size: 22 }];
    const after = [{ sha: sha(3), size: 300 }, { sha: sha(4), size: 4000 }];
    const manifest = sha(0x900_001);
    await seedAccount(accountId, [{ ws, proj: "root" }], [...before, ...after, { sha: manifest, size: 7 }]);

    const state = project({
      head: 1,
      encManifestSha: manifest,
      refMode: { kind: "inline", refShas: before.map((b) => b.sha) },
      // The commit that advances head lands between capture_pins and the group pass.
      onRead: (s) => {
        if (s.reads === 1) {
          s.head = 2;
          s.refMode = { kind: "inline", refShas: after.map((a) => a.sha) };
        }
      },
    });
    const doLog = log();
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, doLog), accountId)).toBe("complete");

    // As-of the snapshot the group pass actually captured (head 2) — never the
    // pre-churn head, and never an interference mixture of the two.
    const expected = after.reduce((n, a) => n + a.size, 0) + 7;
    expect(await completedScan(accountId)).toMatchObject({ status: "complete", active_bytes: expected });
    expect(expected).not.toBe(before.reduce((n, b) => n + b.size, 0) + 7);
    expect(new Set(doLog.paths)).toEqual(new Set(["/roots-inspect"]));
    // Head churn is no longer an abort or a retry.
    expect((await scan(accountId))?.epoch).toBe(1);
  });

  test("an INLINE-mode workspace (no blobRefset at all) returns its real non-zero total", async () => {
    const accountId = "acct_000_fairuse_inline";
    const ws = "ws_inline";
    const refs = [{ sha: sha(0x11), size: 5 }, { sha: sha(0x12), size: 50 }, { sha: sha(0x13), size: 500 }];
    const manifest = sha(0x900_002);
    await seedAccount(accountId, [{ ws, proj: "root" }], [...refs, { sha: manifest, size: 3 }]);

    const state = project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: refs.map((r) => r.sha) } });
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, log()), accountId)).toBe("complete");
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 555 + 3 });
    expect(await groupTotals(accountId)).toEqual([{ workspace_id: ws, active_bytes: 558 }]);
    // A sidecar-only algorithm would have returned zero here.
    expect(Number((await completedScan(accountId))?.active_bytes)).toBeGreaterThan(0);
  });

  test("chain refs, encManifestSha and the sidecar carrier are all counted", async () => {
    const accountId = "acct_000_fairuse_carriers";
    const ws = "ws_carriers";
    const data = [{ encSha: sha(0x21), size: 100 }, { encSha: sha(0x22), size: 200 }];
    const { sidecarSha, count } = await publishSidecar(data);
    const manifest = sha(0x900_003);
    const chain = [sha(0x31), sha(0x32)];
    await seedAccount(accountId, [{ ws, proj: "root" }], [
      ...data.map((d) => ({ sha: d.encSha, size: d.size })),
      { sha: manifest, size: 9 },
      { sha: sidecarSha, size: 1_000 },
      { sha: chain[0]!, size: 40 },
      { sha: chain[1]!, size: 400 },
    ]);

    const state = project({ encManifestSha: manifest, refMode: { kind: "sidecar", sidecarSha, count }, chainRefs: chain });
    const doLog = log();
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, doLog), accountId)).toBe("complete");
    // 300 data + 9 manifest + 1000 sidecar carrier + 440 chain. Sizes come from
    // blobs.size_bytes, never the client-declared sizes inside the refset bytes.
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 300 + 9 + 1_000 + 440 });
    expect(doLog.r2Gets).toContain(blobKey(sidecarSha));
  });

  test("a sha shared by two PROJECTS of one workspace_id is counted once, in one group row", async () => {
    const accountId = "acct_000_fairuse_dedup";
    const ws = "ws_dedup";
    const shared = { sha: sha(0x41), size: 1_000 };
    const onlyA = { sha: sha(0x42), size: 20 };
    const onlyB = { sha: sha(0x43), size: 3 };
    const manifest = sha(0x900_004);
    await seedAccount(accountId, [{ ws, proj: "a" }, { ws, proj: "b" }], [shared, onlyA, onlyB, { sha: manifest, size: 0 }]);

    const doLog = log();
    const fakeEnv = scanningEnv({
      [`${ws}/a`]: project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: [shared.sha, onlyA.sha] } }),
      [`${ws}/b`]: project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: [shared.sha, onlyB.sha] } }),
    }, doLog);
    expect(await drive(fakeEnv, accountId)).toBe("complete");

    expect(await groupTotals(accountId)).toEqual([{ workspace_id: ws, active_bytes: 1_023 }]);
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 1_023 });
  });

  test("a head ref with no blob_refs row is excluded and recorded as an anomaly", async () => {
    const accountId = "acct_000_fairuse_unentitled";
    const ws = "ws_unentitled";
    const entitled = { sha: sha(0x51), size: 70 };
    const unentitled = sha(0x52);
    const manifest = sha(0x900_005);
    await seedAccount(accountId, [{ ws, proj: "root" }], [entitled, { sha: manifest, size: 1 }]);
    // Present in the catalog but NOT entitled to this account: it must not be billed.
    await db().prepare("INSERT OR IGNORE INTO blobs(sha256,size_bytes,present) VALUES(?,?,1)").bind(unentitled, 99_999).run();

    const state = project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: [entitled.sha, unentitled] } });
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, log()), accountId)).toBe("complete");
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 71, entitlement_missing_count: 1 });
  });

  test("an entitled head ref with NO catalog row fails closed instead of counting zero", async () => {
    const accountId = "acct_000_fairuse_missing_catalog";
    const ws = "ws_missing_catalog";
    const manifest = sha(0x900_006);
    const orphan = sha(0x800_000);
    await seedAccount(accountId, [{ ws, proj: "root" }], [{ sha: manifest, size: 1 }]);
    await db().prepare("INSERT INTO blob_refs(account_id,sha256,granted_at) VALUES(?,?,?)").bind(accountId, orphan, NOW).run();

    const state = project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: [orphan] } });
    await expect(drive(scanningEnv({ [`${ws}/root`]: state }, log()), accountId)).rejects.toThrow("fairuse_catalog_missing");
    expect(await groupTotals(accountId)).toEqual([]);
    expect(await db().prepare("SELECT reason FROM fairuse_account_queue WHERE account_id=?").bind(accountId).first())
      .toEqual({ reason: "scan_error" });
  });

  test("workspace-SET drift still aborts the epoch", async () => {
    const accountId = "acct_000_fairuse_setdrift";
    const ws = "ws_setdrift";
    const manifest = sha(0x900_007);
    const refs = Array.from({ length: 12 }, (_, index) => ({ sha: sha(0xb0 + index), size: 1 }));
    await seedAccount(accountId, [{ ws, proj: "root" }], [...refs, { sha: manifest, size: 5 }]);
    const state = project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: refs.map((r) => r.sha) } });
    const fakeEnv = scanningEnv({ [`${ws}/root`]: state }, log());
    // Tiny pages so the intersection cannot finish inside one invocation and the
    // registry can drift underneath a group that is still paging.
    const tuning: FairUseTuning = { entitlementPage: 1, pagesPerTick: 1 };

    await runFairUseObservation(fakeEnv, NOW, tuning);
    expect((await scan(accountId))?.status).toBe("materialize_roots");
    await db().prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES(?,'root',?,?)")
      .bind("ws_setdrift_new", accountId, NOW + 1).run();
    await runFairUseObservation(fakeEnv, NOW, tuning);

    expect((await scan(accountId))?.status).toBe("aborted_pins");
    expect(await groupTotals(accountId)).toEqual([]);
  });

  test("a completed active-only scan reports history and bound as null; pre-migration rows keep theirs", async () => {
    const accountId = "acct_000_fairuse_history";
    const ws = "ws_history";
    const manifest = sha(0x900_008);
    await seedAccount(accountId, [{ ws, proj: "root" }], [{ sha: manifest, size: 64 }]);
    expect(await drive(scanningEnv({ [`${ws}/root`]: project({ encManifestSha: manifest }) }, log()), accountId)).toBe("complete");

    const completed = await completedScan(accountId);
    expect(completed).toMatchObject({ history_computed: 0, history_bytes: 0, bound_bytes: 0, active_bytes: 64 });
    const response = await usage(env, { accountId, deviceId: "dev", userId: "user", role: "owner", kind: "device" });
    expect((await response.json() as { fairUse: Record<string, unknown> }).fairUse).toMatchObject({
      activeBytes: 64, historyBytes: null, bound: null,
    });

    // A row that predates the migration keeps history_computed's DEFAULT 1 and still
    // reports the history it really measured.
    const legacyAccount = "acct_000_fairuse_history_legacy";
    await db().batch([
      db().prepare("INSERT INTO accounts(id,name,plan,origin,created_at,cap_bytes) VALUES(?,?,'pro','bootstrap',?,?)")
        .bind(legacyAccount, legacyAccount, NOW, 250 * 1024 * 1024 * 1024),
      db().prepare(`INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,workspace_set_snapshot,
        started_at,updated_at,completed_at,active_bytes,history_bytes,bound_bytes)
        VALUES(?,1,'complete','{}',1,'[]',?,?,?,10,40,100)`).bind(legacyAccount, NOW, NOW, NOW),
    ]);
    const legacy = await usage(env, { accountId: legacyAccount, deviceId: "dev", userId: "user", role: "owner", kind: "device" });
    expect((await legacy.json() as { fairUse: Record<string, unknown> }).fairUse).toMatchObject({
      activeBytes: 10, historyBytes: 40, bound: 100,
    });
  });

  test("design 228: completion records the ledger bytes we measured but do not bill", async () => {
    const accountId = "acct_000_fairuse_overhang";
    const ws = "ws_overhang";
    const manifest = sha(0x900_100);
    await seedAccount(accountId, [{ ws, proj: "root" }], [{ sha: manifest, size: 64 }]);
    // The ledger says 500 bytes are entitled; only the 64-byte manifest is live at head.
    await db().prepare("UPDATE accounts SET used_bytes=500 WHERE id=?").bind(accountId).run();
    expect(await drive(scanningEnv({ [`${ws}/root`]: project({ encManifestSha: manifest }) }, log()), accountId)).toBe("complete");

    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 64 });
    // used_bytes itself is untouched — the ledger is still the ledger and still the
    // admission input; only the allowance moved.
    expect(await db().prepare("SELECT used_bytes,history_overhang_bytes FROM accounts WHERE id=?").bind(accountId)
      .first<{ used_bytes: number; history_overhang_bytes: number }>())
      .toEqual({ used_bytes: 500, history_overhang_bytes: 436 });
    const response = await usage(env, { accountId, deviceId: "dev", userId: "user", role: "owner", kind: "device" });
    expect(await response.json()).toMatchObject({ usedBytes: 64, measuredAt: NOW });
  });

  test("design 228: an aborted epoch leaves the previous measurement standing", async () => {
    const accountId = "acct_000_fairuse_overhang_abort";
    const ws = "ws_overhang_abort";
    const manifest = sha(0x900_101);
    const refs = Array.from({ length: 12 }, (_, index) => ({ sha: sha(0x1f0 + index), size: 1 }));
    await seedAccount(accountId, [{ ws, proj: "root" }], [...refs, { sha: manifest, size: 5 }]);
    await db().prepare("UPDATE accounts SET used_bytes=500,history_overhang_bytes=400 WHERE id=?").bind(accountId).run();
    const state = project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: refs.map((r) => r.sha) } });
    const fakeEnv = scanningEnv({ [`${ws}/root`]: state }, log());
    const tuning: FairUseTuning = { entitlementPage: 1, pagesPerTick: 1 };

    await runFairUseObservation(fakeEnv, NOW, tuning);
    await db().prepare("INSERT INTO workspaces(workspace_id,project_id,account_id,created_at) VALUES(?,'root',?,?)")
      .bind("ws_overhang_abort_new", accountId, NOW + 1).run();
    await runFairUseObservation(fakeEnv, NOW, tuning);

    expect((await scan(accountId))?.status).toBe("aborted_pins");
    expect(await db().prepare("SELECT history_overhang_bytes FROM accounts WHERE id=?").bind(accountId)
      .first<{ history_overhang_bytes: number }>()).toEqual({ history_overhang_bytes: 400 });
  });

  test("a MISSING sidecar is stale (retries against the re-read head); a corrupt one aborts", async () => {
    const accountId = "acct_000_fairuse_stale";
    const ws = "ws_stale";
    const data = [{ encSha: sha(0x61), size: 12 }];
    const { sidecarSha, count } = await publishSidecar(data);
    const manifest = sha(0x900_009);
    await seedAccount(accountId, [{ ws, proj: "root" }], [
      { sha: data[0]!.encSha, size: 12 }, { sha: manifest, size: 1 }, { sha: sidecarSha, size: 8 },
    ]);

    // First group-pass read points at a sidecar retention already unrooted; the
    // re-read returns the live one.
    const gone = sha(0x6f);
    const state = project({
      encManifestSha: manifest,
      refMode: { kind: "sidecar", sidecarSha: gone, count },
      // Read 1 is capture_pins; read 2 is the group pass, which still names the
      // unrooted sidecar; read 3 is the stale re-read that returns the live one.
      onRead: (s) => {
        if (s.reads >= 3) s.refMode = { kind: "sidecar", sidecarSha, count };
      },
    });
    const doLog = log();
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, doLog), accountId)).toBe("complete");
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 12 + 1 + 8 });
    expect(doLog.r2Gets).toContain(blobKey(gone));
    expect(doLog.r2Gets).toContain(blobKey(sidecarSha));

    // A hash mismatch cannot be explained by a head advance → hard abort, fail closed.
    const corruptAccount = "acct_000_fairuse_corrupt";
    const corruptWs = "ws_corrupt";
    const bytes = serializeRefset([{ encSha: sha(0x71), size: 1 }]);
    const liar = sha(0x7f);
    await env.rbox_dev_blobs.put(blobKey(liar), bytes);
    await seedAccount(corruptAccount, [{ ws: corruptWs, proj: "root" }], [{ sha: manifest, size: 1 }]);
    const corruptEnv = scanningEnv({
      [`${corruptWs}/root`]: project({ encManifestSha: manifest, refMode: { kind: "sidecar", sidecarSha: liar, count: 1 } }),
    }, log());
    expect(await drive(corruptEnv, corruptAccount)).toBe("aborted_pins");
    expect(await groupTotals(corruptAccount)).toEqual([]);
  });

  test("the group cap counts 2 carriers in sidecar mode and 1 inline, and fails closed before any R2 GET", async () => {
    const envelope = (refMode: HeadRefMode, chainRefs: string[]): HeadEnvelope => ({
      head: 1, pruneFloor: 0, indexGeneration: 0, empty: false, encManifestSha: sha(1), refMode, chainRefs,
    });
    expect(declaredRefCount([envelope({ kind: "sidecar", sidecarSha: sha(2), count: 10 }, [sha(3)])])).toBe(10 + 1 + 2);
    expect(declaredRefCount([envelope({ kind: "inline", refShas: [sha(4), sha(5)] }, [sha(3)])])).toBe(2 + 1 + 1);
    expect(declaredRefCount([{ ...envelope({ kind: "inline", refShas: [] }, []), empty: true, refMode: null, encManifestSha: null }])).toBe(0);

    const accountId = "acct_000_fairuse_cap_over";
    const ws = "ws_cap_over";
    const manifest = sha(0x900_00a);
    await seedAccount(accountId, [{ ws, proj: "root" }], [{ sha: manifest, size: 1 }]);
    const overLog = log();
    // count + encManifest + sidecar carrier = cap + 2 → one over is enough.
    const over = project({ encManifestSha: manifest, refMode: { kind: "sidecar", sidecarSha: sha(0x8f), count: FAIRUSE_GROUP_REF_CAP } });
    expect(await drive(scanningEnv({ [`${ws}/root`]: over }, overLog), accountId)).toBe("aborted_pins");
    expect(overLog.r2Gets).toEqual([]); // rejected from the envelopes alone
    expect(await groupTotals(accountId)).toEqual([]);

    // Exactly at the cap is admitted: it reaches the R2 read rather than being rejected.
    const atAccount = "acct_000_fairuse_cap_at";
    const atWs = "ws_cap_at";
    await seedAccount(atAccount, [{ ws: atWs, proj: "root" }], [{ sha: manifest, size: 1 }]);
    const atLog = log();
    const at = project({ encManifestSha: manifest, refMode: { kind: "sidecar", sidecarSha: sha(0x8e), count: FAIRUSE_GROUP_REF_CAP - 2 } });
    await drive(scanningEnv({ [`${atWs}/root`]: at }, atLog), atAccount);
    expect(atLog.r2Gets).toContain(blobKey(sha(0x8e)));
  });

  test("cold, initialized-empty and damaged workspaces are discriminated, and an empty one is a COMPUTED zero", async () => {
    const accountId = "acct_000_fairuse_empty";
    const ws = "ws_empty";
    await seedAccount(accountId, [{ ws, proj: "root" }], []);
    const state = project({ head: 0, empty: true });
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, log()), accountId)).toBe("complete");
    // Present, not absent: 0 is a measurement, not "unmeasured".
    expect(await groupTotals(accountId)).toEqual([{ workspace_id: ws, active_bytes: 0 }]);
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 0, history_computed: 0 });
  });

  test("active_bytes reaches the billing column and no stream carries an accumulated total", async () => {
    const accountId = "acct_000_fairuse_billing";
    const manifestA = sha(0x900_00b);
    const manifestB = sha(0x900_00c);
    await seedAccount(accountId, [{ ws: "ws_bill_a", proj: "root" }, { ws: "ws_bill_b", proj: "root" }], [
      { sha: manifestA, size: 30 }, { sha: manifestB, size: 12 },
    ]);
    const fakeEnv = scanningEnv({
      "ws_bill_a/root": project({ encManifestSha: manifestA }),
      "ws_bill_b/root": project({ encManifestSha: manifestB }),
    }, log());
    expect(await drive(fakeEnv, accountId)).toBe("complete");

    expect(await groupTotals(accountId)).toEqual([
      { workspace_id: "ws_bill_a", active_bytes: 30 },
      { workspace_id: "ws_bill_b", active_bytes: 12 },
    ]);
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: 42, bound_bytes: 0 });
    const response = await usage(env, { accountId, deviceId: "dev", userId: "user", role: "owner", kind: "device" });
    expect((await response.json() as { fairUse: Record<string, unknown> }).fairUse).toMatchObject({ activeBytes: 42 });
    // No per-stream incremental accumulation exists to double-count.
    expect(await db().prepare("SELECT COUNT(*) AS n FROM fairuse_group_progress WHERE account_id=?").bind(accountId).first())
      .toEqual({ n: 0 });
  });

  test("the intersection resumes across ticks, and a head move restarts the group from cursor 0", async () => {
    const accountId = "acct_000_fairuse_crosstick";
    const ws = "ws_crosstick";
    const manifest = sha(0x900_00d);
    const refs = Array.from({ length: 12 }, (_, index) => ({ sha: sha(0xa0 + index), size: (index + 1) * 10 }));
    await seedAccount(accountId, [{ ws, proj: "root" }], [...refs, { sha: manifest, size: 5 }]);
    // One page of one row, one page per tick: the whole account needs many ticks.
    const tuning: FairUseTuning = { entitlementPage: 1, pagesPerTick: 1 };

    const state = project({ encManifestSha: manifest, refMode: { kind: "inline", refShas: refs.map((r) => r.sha) } });
    expect(await drive(scanningEnv({ [`${ws}/root`]: state }, log()), accountId, 40, tuning)).toBe("complete");
    const total = refs.reduce((n, r) => n + r.size, 0) + 5;
    expect(await completedScan(accountId)).toMatchObject({ active_bytes: total });

    // Now the same account, with head moving mid-intersection: the partial sum is
    // discarded, never merged, and the newer snapshot's exact total wins.
    const moverAccount = "acct_000_fairuse_crosstick_move";
    const moverWs = "ws_crosstick_move";
    const later = refs.slice(0, 3);
    await seedAccount(moverAccount, [{ ws: moverWs, proj: "root" }], [...refs, { sha: manifest, size: 5 }]);
    const mover = project({
      encManifestSha: manifest,
      refMode: { kind: "inline", refShas: refs.map((r) => r.sha) },
      onRead: (s) => {
        if (s.reads === 4) {
          s.head = 2;
          s.refMode = { kind: "inline", refShas: later.map((r) => r.sha) };
        }
      },
    });
    expect(await drive(scanningEnv({ [`${moverWs}/root`]: mover }, log()), moverAccount, 60, tuning)).toBe("complete");
    expect(await completedScan(moverAccount)).toMatchObject({ active_bytes: later.reduce((n, r) => n + r.size, 0) + 5 });
  });
});

// ---- the DO head-envelope surface ----------------------------------------

function fakeCtx(kv: Map<string, unknown>) {
  return {
    storage: {
      sql: fakeDoSql(),
      kv: {
        get: (key: string) => kv.get(key),
        put: (key: string, value: unknown) => kv.set(key, value),
        delete: (key: string) => kv.delete(key),
        list: (options?: { prefix?: string }) => new Map(
          [...kv].filter(([key]) => !options?.prefix || key.startsWith(options.prefix)),
        ),
      },
      transactionSync: (fn: () => void) => fn(),
      getAlarm: () => null,
      setAlarm: () => {},
    },
    getWebSockets: () => [],
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
}

function signedCommit(encManifestSha: string, carrier: Record<string, unknown>, manifestChain?: string[]): string {
  return JSON.stringify({
    body: JSON.stringify({ type: "rbox/commit/v1", seq: 1, encManifestSha, ...(manifestChain ? { manifestChain } : {}), ...carrier }),
    commitHash: sha(0xcc),
    sig: "sig",
  });
}

const headRequest = "https://do/roots-inspect?head=1&ws=ws_1&proj=root";

describe("roots-inspect head-envelope mode", () => {
  test("a cold DO is an ordinary empty head, not 503", async () => {
    const sync = new WorkspaceSync(fakeCtx(new Map()), env);
    const response = await sync.fetch(new Request(headRequest));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      head: 0, commitHash: GENESIS, empty: true, encManifestSha: null, refMode: null, chainRefs: [],
      pruneFloor: 0, indexGeneration: 0,
    });
  });

  test("an initialized-but-empty DO is 200 empty, never 409 roots_incomplete", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 0, commitHash: GENESIS }], ["headWatermark", 0], ["index_state", "ready"]]);
    const response = await new WorkspaceSync(fakeCtx(kv), env).fetch(new Request(headRequest));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ head: 0, empty: true });
  });

  test("head-missing WITH evidence is repair_required", async () => {
    const kv = new Map<string, unknown>([["headWatermark", 4]]);
    const response = await new WorkspaceSync(fakeCtx(kv), env).fetch(new Request(headRequest));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "index_unavailable", reason: "repair_required" });
  });

  test("a LEGACY numeric head is healthy: 200 with that sequence, not a permanent 503", async () => {
    const kv = new Map<string, unknown>([
      ["head", 1],
      ["seq:1", signedCommit(sha(0xd1), { blobRefs: [{ encSha: sha(0xd2), size: 1 }] })],
    ]);
    const response = await new WorkspaceSync(fakeCtx(kv), env).fetch(new Request(headRequest));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      head: 1, empty: false, commitHash: sha(0xcc), encManifestSha: sha(0xd1),
      refMode: { kind: "inline", refShas: [sha(0xd2)] },
    });
  });

  test("head mode is not gated on index_state and never 503s a lagging DO", async () => {
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha(0xcc) }],
      ["index_state", "lagging"],
      ["index_synced_seq", 0],
      ["seq:1", signedCommit(sha(0xd1), { blobRefs: [] })],
    ]);
    const response = await new WorkspaceSync(fakeCtx(kv), env).fetch(new Request(headRequest));
    expect(response.status).toBe(200);
  });

  test("an unreadable head envelope is 409 roots_incomplete", async () => {
    const kv = new Map<string, unknown>([["head", { sequence: 1, commitHash: sha(0xcc) }]]);
    const response = await new WorkspaceSync(fakeCtx(kv), env).fetch(new Request(headRequest));
    expect(response.status).toBe(409);
  });

  test("refs(head) is EQUAL to refSetAt's set ∪ manifestSha ∪ carrierSha", async () => {
    const data = [{ encSha: sha(0xe1), size: 1 }, { encSha: sha(0xe2), size: 2 }];
    const { sidecarSha, count } = await publishSidecar(data);
    const manifest = sha(0xe0);
    const chain = [sha(0xe3), sha(0xe4)];
    const kv = new Map<string, unknown>([
      ["head", { sequence: 1, commitHash: sha(0xcc) }],
      ["seq:1", signedCommit(manifest, { blobRefset: { sidecarSha, count, totalBytes: 3 } }, chain)],
    ]);
    const sync = new WorkspaceSync(fakeCtx(kv), env);

    const response = await sync.fetch(new Request(headRequest));
    const built = await headRefSet(env, parseHeadEnvelope(await response.json()));
    expect(built.ok).toBe(true);

    // refSetAt is the DO's own head ref set — the one the fold and GC rooting consume.
    // Equality, not containment: a containment assertion would ratify an undercount.
    // The formula this pins is the one commit admission enforces on the branch
    // PRODUCTION runs (RBOX_COMMIT_DELTA_ADMISSION=enforce, workspace-sync.ts:644),
    // not the deltaMode === "off" branch at :597.
    const refSetAt = (sync as unknown as {
      refSetAt(seq: number): Promise<{ refs: Set<string>; manifestSha: string; carrierSha: string | null }>;
    }).refSetAt.bind(sync);
    const authoritative = await refSetAt(1);
    const expected = new Set([...authoritative.refs, authoritative.manifestSha, ...(authoritative.carrierSha ? [authoritative.carrierSha] : [])]);
    expect([...(built as { refs: Set<string> }).refs].sort()).toEqual([...expected].sort());
  });
});

// ---- lease + rollout surfaces --------------------------------------------

describe("fair-use lease contracts", () => {
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

  test("missing account drains its orphaned queue row", async () => {
    const accountId = "acct_000_fairuse_missing_account";
    await db().prepare("INSERT INTO fairuse_account_queue(account_id,next_run_at,reason,updated_at) VALUES(?,?,?,?)")
      .bind(accountId, NOW - 1, "test", NOW).run();

    await expect(runFairUseObservation(env, NOW)).rejects.toThrow("account_missing");

    expect(await db().prepare("SELECT 1 FROM fairuse_account_queue WHERE account_id=?").bind(accountId).first())
      .toBeNull();
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
    const seed = (epoch: number, completedAt: number | null, active: number, pruning: number) => db().prepare(
      `INSERT INTO fairuse_scans(account_id,epoch,status,plan_snapshot,roots_format_generation,workspace_set_snapshot,
       started_at,updated_at,completed_at,active_bytes,history_bytes,bound_bytes,pruning_active)
       VALUES(?,?,'complete','{}',1,'[]',?,?,?,?,?,?,?)`,
    ).bind(accountId, epoch, NOW, NOW, completedAt, active, active * 2, active * 5, pruning);
    await db().batch([seed(1, NOW - 2, 10, 0), seed(2, null, 999, 0), seed(3, NOW - 1, 20, 1)]);

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
