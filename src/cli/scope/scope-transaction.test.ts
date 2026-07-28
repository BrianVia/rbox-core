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

interface DaemonFake {
  deps: ScopeTransactionDeps;
  order: string[];
  witness: Array<string[] | undefined>;
  /** True liveness, sampled by `daemonRunning` — never pinned. */
  live: () => boolean;
  parks: () => number;
  /** What an explicit `rbox stop` does: the daemon goes down AND the maintenance
   *  obligation is cancelled, exactly as rebuilding desired.json from a fresh
   *  identity does in autostart-cmd. */
  userStop: () => void;
}

/**
 * A stand-in for the durable desired-state record. The token outlives any single
 * `runScopeTransition` call, which is what makes a simulated crash meaningful:
 * a fresh "process" sees the same obligation the dead one left behind.
 */
function daemonFake(startLive = true): DaemonFake {
  const order: string[] = [];
  const witness: Array<string[] | undefined> = [];
  let live = startLive;
  let token: { id: string; resume: "running" | "stopped" } | undefined;
  let parks = 0;
  let ids = 0;
  return {
    order,
    witness,
    live: () => live,
    parks: () => parks,
    userStop: () => { live = false; token = undefined; },
    deps: {
      daemonRunning: () => live,
      newMaintenanceId: () => `mt_${++ids}`,
      parkedMaintenanceId: async () => token?.id,
      parkDaemon: async (_root, id) => {
        if (token !== undefined && token.id !== id) throw new Error("another rbox command is already holding background sync for maintenance");
        token = { id, resume: live ? "running" : "stopped" };
        live = false;
        parks += 1;
        order.push("park");
      },
      resumeDaemon: async (_root, id) => {
        if (token?.id !== id) return false;
        const resume = token.resume;
        token = undefined;
        if (resume !== "running") return false;
        live = true;
        order.push("resume");
        return true;
      },
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
  const { deps, order, witness } = daemonFake();
  const result = await runScopeTransition(root, ["Personal/repo-A", "Work/repo-B"], deps);
  expect(order).toEqual(["park", "witness", "resume"]);
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
  const { deps } = daemonFake();
  await runScopeTransition(root, ["Personal/repo-A"], deps);
  await expect(fs.access(path.join(root, "Work/repo-B"))).rejects.toThrow();
  const trashed = await fs.readdir(path.join(root, ".rbox", "trash"));
  expect(trashed.length).toBeGreaterThan(0);
});

test("a crash after the intent is written resumes to the SAME target", async () => {
  const cfg = base(["Personal/repo-A"]);
  const intent = planScopeIntent(["Personal/repo-A"], ["Personal/repo-A", "Work/repo-B"], 2, "t");
  await saveConfig(root, { ...cfg, scopeIntent: intent });
  const { deps } = daemonFake();
  const resumed = await resumeScopeIntent(root, deps);
  expect(resumed).toMatchObject({ accepted: ["Personal/repo-A", "Work/repo-B"], generation: 2 });
  const after = await loadConfig(root);
  expect(after.scope).toEqual(["Personal/repo-A", "Work/repo-B"]);
  expect(after.scopeIntent).toBeUndefined();
});

test("resuming is idempotent: a completed transition has nothing to resume", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const { deps } = daemonFake();
  expect(await resumeScopeIntent(root, deps)).toBeUndefined();
});

test("a crash before the witness write leaves the record scoped, and the witness converges on resume", async () => {
  const cfg = base(["Personal/repo-A"]);
  const intent = planScopeIntent(["Personal/repo-A"], ["Work/repo-B"], 2, "t");
  await saveConfig(root, { ...cfg, scopeIntent: intent });
  const { deps, witness } = daemonFake();
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
  const { deps } = daemonFake();
  await runScopeTransition(root, ["Personal/repo-A", "Work/repo-B"], deps);
  const after = await loadState(root, syncStreamId(await loadConfig(root)));
  expect(after.lastSyncedManifest.files.map((f) => f.path)).toEqual(["Personal/repo-A/a.txt"]);
});

test("removing a folder also forgets it, so nothing reads as a local deletion", async () => {
  await saveConfig(root, base(["Personal/repo-A", "Work/repo-B"]));
  await seedBase(["Personal/repo-A/a.txt", "Work/repo-B/b.txt"]);
  const { deps } = daemonFake();
  await runScopeTransition(root, ["Personal/repo-A"], deps);
  const after = await loadState(root, syncStreamId(await loadConfig(root)));
  expect(after.lastSyncedManifest.files.map((f) => f.path)).toEqual(["Personal/repo-A/a.txt"]);
});

test("a daemon that was not running is not started by a scope edit", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const { deps, order, live } = daemonFake(false);
  const result = await runScopeTransition(root, ["Personal/repo-A", "Work/repo-B"], deps);
  expect(order).toEqual(["witness"]);
  expect(result.daemonRestarted).toBe(false);
  expect(live()).toBe(false);
});

/**
 * Design 212 §3.3 — the park is a LOAN, not a stop. Every fault point below kills
 * the transaction while the daemon is down; the next command must give it back.
 * The liveness sample is deliberately honest throughout: a crashed process leaves
 * no pid behind, so anything that remembers the restart has to be on disk.
 */

const ADD = ["Personal/repo-A", "Work/repo-B"];

/** Crash `run` mid-transition, then re-enter as a fresh process would. */
async function crashThenResume(
  fake: DaemonFake,
  fault: Partial<ScopeTransactionDeps>,
  message: string,
): Promise<void> {
  await expect(runScopeTransition(root, ADD, { ...fake.deps, ...fault })).rejects.toThrow(message);
  expect((await loadConfig(root)).scopeIntent).toBeDefined();
  await resumeScopeIntent(root, fake.deps);
}

/** Every fault point converges to the same place: scope applied, intent retired,
 *  daemon back. */
async function expectConverged(fake: DaemonFake): Promise<void> {
  const cfg = await loadConfig(root);
  expect(cfg.scope).toEqual(ADD);
  expect(cfg.scopeIntent).toBeUndefined();
  expect(fake.live()).toBe(true);
}

test("fault after the intent write: the daemon is still running and stays that way", async () => {
  const intent = planScopeIntent(["Personal/repo-A"], ADD, 2, "t");
  await saveConfig(root, { ...base(["Personal/repo-A"]), scopeIntent: intent });
  const fake = daemonFake();
  await resumeScopeIntent(root, fake.deps);
  await expectConverged(fake);
  expect(fake.parks()).toBe(1);
});

test("fault after the park: the parked daemon is returned by the resume", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const fake = daemonFake();
  await crashThenResume(fake, {
    parkDaemon: async (root_, id) => {
      await fake.deps.parkDaemon?.(root_, id);
      throw new Error("power loss");
    },
  }, "power loss");
  await expectConverged(fake);
});

test("fault after the scope commit: the resume neither re-trashes nor abandons the daemon", async () => {
  await saveConfig(root, base(["Personal/repo-A", "Work/repo-B"]));
  await fs.mkdir(path.join(root, "Work/repo-B"), { recursive: true });
  await fs.writeFile(path.join(root, "Work/repo-B/notes.txt"), "keep me");
  const fake = daemonFake();
  await expect(runScopeTransition(root, ["Personal/repo-A"], {
    ...fake.deps,
    recordWitness: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");
  expect((await loadConfig(root)).scopeIntent).toMatchObject({ phase: "committed" });
  const trashedOnce = await fs.readdir(path.join(root, ".rbox", "trash"));
  await resumeScopeIntent(root, fake.deps);
  expect(await fs.readdir(path.join(root, ".rbox", "trash"))).toEqual(trashedOnce);
  const cfg = await loadConfig(root);
  expect(cfg.scope).toEqual(["Personal/repo-A"]);
  expect(cfg.scopeIntent).toBeUndefined();
  expect(fake.live()).toBe(true);
});

test("fault after the witness write: the intent outlives it and still owes the restart", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const fake = daemonFake();
  await crashThenResume(fake, {
    resumeDaemon: async () => { throw new Error("power loss"); },
  }, "power loss");
  await expectConverged(fake);
  expect(fake.parks()).toBe(1);
});

test("fault after the restart: the resume is a no-op that leaves the daemon up", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const fake = daemonFake();
  await crashThenResume(fake, {
    resumeDaemon: async (root_, id) => {
      await fake.deps.resumeDaemon?.(root_, id);
      throw new Error("power loss");
    },
  }, "power loss");
  await expectConverged(fake);
  // The daemon came back on the first attempt; the resume must not park it again.
  expect(fake.parks()).toBe(1);
  expect(fake.order.filter((step) => step === "resume")).toEqual(["resume"]);
});

test("an explicit stop during the window wins: the resume does not resurrect the daemon", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const fake = daemonFake();
  await expect(runScopeTransition(root, ADD, {
    ...fake.deps,
    recordWitness: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");
  fake.userStop();
  await resumeScopeIntent(root, fake.deps);
  const cfg = await loadConfig(root);
  expect(cfg.scope).toEqual(ADD);
  expect(cfg.scopeIntent).toBeUndefined();
  expect(fake.live()).toBe(false);
});

/**
 * Round 2 — the review found three more ways the obligation could be dropped:
 * a rollback that discards the cursor, two edits erasing each other's cursor, and
 * intents written before the phase field existed.
 */

test("a rollback that discards the intent still leaves the parked daemon a way back", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const fake = daemonFake();
  await expect(runScopeTransition(root, ADD, {
    ...fake.deps,
    recordWitness: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");
  // What `track --include` rollback does: restore the old config, intent and all.
  await saveConfig(root, base(["Personal/repo-A"]));
  expect(fake.live()).toBe(false);

  await resumeScopeIntent(root, fake.deps);
  expect(fake.live()).toBe(true);
});

test("a second edit refuses to plan over an unfinished one", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const first = daemonFake();
  await expect(runScopeTransition(root, ADD, {
    ...first.deps,
    recordWitness: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");

  const second = daemonFake();
  await expect(runScopeTransition(root, ["Work/repo-C"], second.deps)).rejects.toThrow("still finishing");
  expect((await loadConfig(root)).scopeIntent).toMatchObject({ target: ADD });
});

test("two interleaved edits: neither settles away the other's recovery cursor", async () => {
  await saveConfig(root, base(["Personal/repo-A"]));
  const first = daemonFake();
  const theirs = planScopeIntent(ADD, ["Work/repo-C"], 9, "theirs");

  // Both processes read an empty slot at once — the window no refusal can close.
  // The second journals its intent while the first is between its resume and its
  // settle, so the first settles against a cursor that is no longer its own.
  await runScopeTransition(root, ADD, {
    ...first.deps,
    resumeDaemon: async (root_, id) => {
      const restarted = await first.deps.resumeDaemon?.(root_, id);
      await saveConfig(root, { ...(await loadConfig(root)), scopeIntent: theirs });
      return restarted ?? false;
    },
  });
  expect(first.live()).toBe(true);
  expect((await loadConfig(root)).scopeIntent).toMatchObject({ target: ["Work/repo-C"], at: "theirs" });

  // And the surviving cursor still runs to completion.
  const second = daemonFake(false);
  await resumeScopeIntent(root, second.deps);
  const cfg = await loadConfig(root);
  expect(cfg.scope).toEqual(["Work/repo-C"]);
  expect(cfg.scopeIntent).toBeUndefined();
});

test("a legacy intent already applied to the record is not replayed onto disk", async () => {
  // Yesterday's shape: scope and generation already committed, intent re-persisted,
  // no phase and no maintenance token.
  await saveConfig(root, {
    ...base(["Personal/repo-A"]),
    scopeGeneration: 2,
    scopeIntent: { generation: 2, accepted: ["Personal/repo-A", "Work/repo-B"], target: ["Personal/repo-A"], materialize: [], prune: ["Work/repo-B"], at: "t" },
  });
  await fs.mkdir(path.join(root, "Work/repo-B"), { recursive: true });
  await fs.writeFile(path.join(root, "Work/repo-B/notes.txt"), "recreated since the crash");
  const fake = daemonFake(false);

  await resumeScopeIntent(root, fake.deps);
  expect(await fs.readFile(path.join(root, "Work/repo-B/notes.txt"), "utf8")).toBe("recreated since the crash");
  expect((await loadConfig(root)).scopeIntent).toBeUndefined();
});

test("a legacy intent not yet applied still does its disk work", async () => {
  await saveConfig(root, {
    ...base(["Personal/repo-A", "Work/repo-B"]),
    scopeIntent: { generation: 2, accepted: ["Personal/repo-A", "Work/repo-B"], target: ["Personal/repo-A"], materialize: [], prune: ["Work/repo-B"], at: "t" },
  });
  await fs.mkdir(path.join(root, "Work/repo-B"), { recursive: true });
  await fs.writeFile(path.join(root, "Work/repo-B/notes.txt"), "goes to the trash");
  const fake = daemonFake(false);

  await resumeScopeIntent(root, fake.deps);
  await expect(fs.access(path.join(root, "Work/repo-B"))).rejects.toThrow();
  expect((await loadConfig(root)).scope).toEqual(["Personal/repo-A"]);
});

test("a legacy intent whose daemon is already down says so rather than guessing", async () => {
  await saveConfig(root, {
    ...base(["Personal/repo-A"]),
    scopeGeneration: 2,
    scopeIntent: { generation: 2, accepted: ["Personal/repo-A"], target: ["Personal/repo-A"], materialize: [], prune: [], at: "t" },
  });
  const fake = daemonFake(false);
  const lines: string[] = [];

  await resumeScopeIntent(root, { ...fake.deps, log: (line) => lines.push(line) });
  expect(fake.live()).toBe(false);
  expect(lines.join("\n")).toContain("rbox start");
  expect((await loadConfig(root)).scopeIntent).toBeUndefined();
});
