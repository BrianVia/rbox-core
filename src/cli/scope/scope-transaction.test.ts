/**
 * Design 212 acceptance 6 — the scope transaction. Every crash window must
 * converge with no lost or phantom folders.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig, saveConfig, syncStreamId, type WorkspaceConfig } from "../workspace-config.js";
import { loadState, saveState } from "../sync-state-store.js";
import { planScopeIntent, resumeScopeIntent, runScopeTransition, type ScopeTransactionDeps } from "./scope-transaction.js";

let home: string;
let root: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-txn-home-"));
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-txn-root-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
});

afterEach(async () => {
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME; else process.env.RBOX_HOME = originalRboxHome;
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(root, { recursive: true, force: true });
});

const base = (scope?: string[]): WorkspaceConfig => ({
  remoteWorkspaceId: "ws_txn",
  projectId: "root",
  deviceId: "dev_1",
  rootPath: root,
  remoteUrl: "https://api.test",
  token: "",
  ...(scope ? { scope, scopeGeneration: 1 } : {}),
});

/** A durable base manifest naming `paths`, as a completed pull would leave. */
async function seedBase(paths: string[]): Promise<void> {
  const cfg = await loadConfig(root);
  await saveState(root, {
    stream: syncStreamId(cfg),
    lastSyncedSequence: 1,
    lastSyncedManifest: {
      generatedAt: "2026-07-28T00:00:00Z",
      files: paths.map((path) => ({ path, type: "file", size: 1, mtimeMs: 0, sha256: "a" })),
    },
  } as never);
}

function spies(): { deps: ScopeTransactionDeps; order: string[]; witness: Array<string[] | undefined> } {
  const order: string[] = [];
  const witness: Array<string[] | undefined> = [];
  return {
    order,
    witness,
    deps: {
      daemonRunning: () => true,
      stopDaemon: async () => { order.push("stop"); },
      startDaemon: async () => { order.push("start"); },
      recordWitness: async (_root, _ws, scope) => { order.push("witness"); witness.push(scope ? [...scope] : undefined); },
      now: () => new Date("2026-07-28T00:00:00Z"),
      log: () => {},
    },
  };
}

test("the intent names exactly what has to move", () => {
  const intent = planScopeIntent(["a", "b"], ["b", "c"], 4, "t");
  expect(intent).toMatchObject({ generation: 4, materialize: ["c"], prune: ["a"] });
});

test("adding a folder: daemon parked before the commit, restarted after, witness written", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const { deps, order, witness } = spies();
  const result = await runScopeTransition(root, ["Personal/repo-A", "Work/repo-B"], deps);
  expect(order).toEqual(["stop", "witness", "start"]);
  expect(witness).toEqual([["Personal/repo-A", "Work/repo-B"]]);
  expect(result).toMatchObject({ materialized: ["Work/repo-B"], pruned: [], daemonRestarted: true, generation: 2 });
  const cfg = await loadConfig(root);
  expect(cfg.scope).toEqual(["Personal/repo-A", "Work/repo-B"]);
  expect(cfg.scopeGeneration).toBe(2);
  expect(cfg.scopeIntent).toBeUndefined();
});

test("removing a folder moves its files to the trash rather than deleting them", async () => {
  await saveConfig(root, base(["Personal/repo-A", "Work/repo-B"]));
  await fs.mkdir(path.join(root, "Work/repo-B"), { recursive: true });
  await fs.writeFile(path.join(root, "Work/repo-B/notes.txt"), "keep me");
  const { deps } = spies();
  await runScopeTransition(root, ["Personal/repo-A"], deps);
  await expect(fs.access(path.join(root, "Work/repo-B"))).rejects.toThrow();
  const trashed = await fs.readdir(path.join(root, ".rbox", "trash"));
  expect(trashed.length).toBeGreaterThan(0);
});

test("a crash after the intent is written resumes to the SAME target", async () => {
  const cfg = base(["Personal/repo-A"]);
  const intent = planScopeIntent(["Personal/repo-A"], ["Personal/repo-A", "Work/repo-B"], 2, "t");
  await saveConfig(root, { ...cfg, scopeIntent: intent });
  const { deps } = spies();
  const resumed = await resumeScopeIntent(root, deps);
  expect(resumed).toMatchObject({ accepted: ["Personal/repo-A", "Work/repo-B"], generation: 2 });
  const after = await loadConfig(root);
  expect(after.scope).toEqual(["Personal/repo-A", "Work/repo-B"]);
  expect(after.scopeIntent).toBeUndefined();
});

test("resuming is idempotent: a completed transition has nothing to resume", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const { deps } = spies();
  expect(await resumeScopeIntent(root, deps)).toBeUndefined();
});

test("a crash before the witness write leaves the record scoped, and the witness converges on resume", async () => {
  const cfg = base(["Personal/repo-A"]);
  const intent = planScopeIntent(["Personal/repo-A"], ["Work/repo-B"], 2, "t");
  await saveConfig(root, { ...cfg, scopeIntent: intent });
  const { deps, witness } = spies();
  // First attempt dies exactly at the witness write.
  await expect(runScopeTransition(root, ["Work/repo-B"], {
    ...deps,
    recordWitness: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");
  // The accepted scope is already durable — the record never reads as unscoped.
  expect((await loadConfig(root)).scope).toEqual(["Work/repo-B"]);
  await runScopeTransition(root, ["Work/repo-B"], deps);
  expect(witness).toEqual([["Work/repo-B"]]);
});

test("adding a folder forgets what this machine last saw of it, so it materializes", async () => {
  // The hazard: a narrowed pull repopulates the full remote base as bookkeeping
  // carry. Re-adding a folder whose base already equals remote, with nothing on
  // disk, reconciles to "deleted here" and would leave it permanently empty.
  await saveConfig(root, base(["Personal/repo-A"]));
  await seedBase(["Personal/repo-A/a.txt", "Work/repo-B/b.txt"]);
  const { deps } = spies();
  await runScopeTransition(root, ["Personal/repo-A", "Work/repo-B"], deps);
  const after = await loadState(root, syncStreamId(await loadConfig(root)));
  expect(after.lastSyncedManifest.files.map((f) => f.path)).toEqual(["Personal/repo-A/a.txt"]);
});

test("removing a folder also forgets it, so nothing reads as a local deletion", async () => {
  await saveConfig(root, base(["Personal/repo-A", "Work/repo-B"]));
  await seedBase(["Personal/repo-A/a.txt", "Work/repo-B/b.txt"]);
  const { deps } = spies();
  await runScopeTransition(root, ["Personal/repo-A"], deps);
  const after = await loadState(root, syncStreamId(await loadConfig(root)));
  expect(after.lastSyncedManifest.files.map((f) => f.path)).toEqual(["Personal/repo-A/a.txt"]);
});

test("a daemon that was not running is not started by a scope edit", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const { deps, order } = spies();
  const result = await runScopeTransition(root, ["Personal/repo-A", "Work/repo-B"], { ...deps, daemonRunning: () => false });
  expect(order).toEqual(["witness"]);
  expect(result.daemonRestarted).toBe(false);
});
