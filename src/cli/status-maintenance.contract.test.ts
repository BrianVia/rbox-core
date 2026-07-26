import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { repoRecordsForState, type SyncState, type WorkspaceConfig } from "./config.js";
import type { DeferralHygieneResult } from "./sync-git/deferral-hygiene.js";
import {
  refreshStatusDeferralAssertions,
  statusStaleLockDetail,
  type StatusMaintenancePort,
} from "./status-maintenance.js";
import { saveStatusHashCache, type StatusCacheHint } from "./status-cmd.js";

const ROOT = "/tmp/rbox-status-maintenance";
const AT = "2026-07-01T00:00:00.000Z";

const CFG: WorkspaceConfig = {
  schema: "e2ee/v1",
  remoteWorkspaceId: "ws_contract",
  projectId: "root",
  deviceId: "dev_contract",
  rootPath: ROOT,
  remoteUrl: "https://api.test",
  token: "",
  encrypted: true,
};

function deferredState(sequence: number): SyncState {
  return {
    stream: "stream_contract",
    lastSyncedSequence: sequence,
    lastSyncedManifest: { generatedAt: AT, files: [] },
    repoRecords: {
      repo: {
        repoGen: 1,
        sourceSeq: sequence,
        deferrals: {
          capture: { lane: "capture", reason: "git-busy", deferredSince: AT, reasonSince: AT, lastSeen: AT },
        },
      },
    },
  } as unknown as SyncState;
}

function port(
  state: SyncState,
  reconcile: StatusMaintenancePort["reconcile"],
): StatusMaintenancePort {
  return { cfg: CFG, state, reconcile };
}

test("success returns the fresh state token bound to what the pass did", async () => {
  const prior = deferredState(7);
  const fresh = deferredState(8);
  const displayDetails = new Map([["repo\0capture", { lockCount: 2, oldestAgeMs: 500, samplePath: `${ROOT}/repo/.git/index.lock` }]]);
  const seen: Array<[string, WorkspaceConfig, SyncState]> = [];
  const result: DeferralHygieneResult = {
    state: fresh,
    changed: true,
    accepted: true,
    displayDetails,
    commonDirsInspected: 3,
    recoveredLocks: 1,
  };

  const receipt = await refreshStatusDeferralAssertions(ROOT, port(prior, async (root, cfg, state) => {
    seen.push([root, cfg, state]);
    return result;
  }));

  expect(seen).toEqual([[ROOT, CFG, prior]]);
  expect(receipt.kind).toBe("refreshed");
  if (receipt.kind !== "refreshed") throw new Error("unreachable");
  expect(receipt.root).toBe(ROOT);
  expect(receipt.state).toBe(fresh);
  expect(receipt.state).not.toBe(prior);
  expect(receipt.displayDetails).toBe(displayDetails);
  expect(receipt.changed).toBe(true);
  expect(receipt.accepted).toBe(true);
  expect(receipt.recoveredLocks).toBe(1);
  expect(receipt.commonDirsInspected).toBe(3);
});

test("a refreshed receipt carries the display evidence status renders root-relative", async () => {
  const details = new Map([["repo\0capture", { lockCount: 1, oldestAgeMs: 10, samplePath: `${ROOT}/repo/.git/index.lock` }]]);

  expect(statusStaleLockDetail(ROOT, details, "repo", "capture")?.samplePath).toBe("repo/.git/index.lock");
  expect(statusStaleLockDetail("/elsewhere", details, "repo", "capture")?.samplePath).toBe("index.lock");
  expect(statusStaleLockDetail(ROOT, details, "repo", "apply")).toBeUndefined();
  expect(statusStaleLockDetail(ROOT, new Map(), "repo", "capture")).toBeUndefined();
});

test("an unavailable writer preserves the prior durable deferrals", async () => {
  const prior = deferredState(7);

  const receipt = await refreshStatusDeferralAssertions(ROOT, port(prior, async () => {
    throw new Error("hygiene unavailable");
  }));

  expect(receipt.kind).toBe("unavailable");
  if (receipt.kind !== "unavailable") throw new Error("unreachable");
  expect(receipt.root).toBe(ROOT);
  expect(receipt.reason).toBe("hygiene unavailable");
  // No fresh token and no display evidence: the caller keeps what it loaded.
  expect(Object.keys(receipt)).toEqual(["kind", "root", "reason"]);
  expect(repoRecordsForState(prior).repo?.deferrals?.capture?.reason).toBe("git-busy");
});

test("multi-workspace summary triggers zero maintenance: hygiene has one status caller", async () => {
  const cliDir = path.dirname(fileURLToPath(import.meta.url));
  const entries = await fs.readdir(cliDir, { recursive: true, withFileTypes: true });
  const invokes: string[] = [];
  const wiresHygiene: string[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.includes(".test.")) continue;
    const rel = path.relative(cliDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/");
    const source = await fs.readFile(path.join(entry.parentPath, entry.name), "utf8");
    if (rel !== "status-maintenance.ts" && /\brefreshStatusDeferralAssertions\b/.test(source)) invokes.push(rel);
    if (rel !== "sync-git/deferral-hygiene.ts" && /\breconcileGitDeferrals\b/.test(source)) wiresHygiene.push(rel);
  }

  // An all-workspaces summary must not reach the writer by reusing the detail
  // path; a second status caller of either name fails this lock.
  expect(invokes.sort()).toEqual(["status-cmd.ts"]);
  expect(wiresHygiene.sort()).toEqual(["daemon/daemon.ts", "status-cmd.ts", "sync-git.ts"]);
});

test("composition-root cache effect: cache-ownership loss skips writeback", async () => {
  const calls: string[] = [];
  const hint: StatusCacheHint = {
    cache: {
      prune: () => calls.push("prune"),
      save: async () => void calls.push("save"),
    },
    livePaths: () => {
      calls.push("livePaths");
      return new Set(["a.txt"]);
    },
  };

  expect(await saveStatusHashCache(ROOT, hint, () => false)).toEqual({ kind: "skipped-not-owner" });
  expect(calls).toEqual([]);
});

test("composition-root cache effect: writeback re-checks ownership at rename", async () => {
  const calls: string[] = [];
  let owner = true;
  let beforeRename: (() => boolean | Promise<boolean>) | undefined;
  const hint: StatusCacheHint = {
    cache: {
      prune: () => calls.push("prune"),
      save: async (_root, opts) => {
        calls.push("save");
        beforeRename = opts?.beforeRename;
      },
    },
    livePaths: () => new Set(["a.txt"]),
  };

  expect(await saveStatusHashCache(ROOT, hint, () => owner)).toEqual({ kind: "written" });
  expect(calls).toEqual(["prune", "save"]);
  owner = false;
  expect(await beforeRename?.()).toBe(false);
});

test("composition-root cache effect: a rejected save is best-effort", async () => {
  const hint: StatusCacheHint = {
    cache: { prune: () => {}, save: async () => { throw new Error("disk full"); } },
    livePaths: () => new Set(),
  };

  expect(await saveStatusHashCache(ROOT, hint, () => true)).toEqual({ kind: "write-failed" });
});
