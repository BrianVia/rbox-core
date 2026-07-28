import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import {
  desiredStatePath,
  parkDaemonForMaintenance,
  resumeDaemonAfterMaintenance,
  startDaemonForUser,
  stopDaemonAndRecordDesired,
} from "../autostart-cmd.js";
import { withScopeTransitionLock } from "../scope/scope-lock.js";
import {
  afterEachAutostartTest,
  beforeEachAutostartTest,
  creds,
  recordDesired,
  workspace,
} from "./test-helpers.js";

beforeEach(beforeEachAutostartTest);
afterEach(afterEachAutostartTest);

test("parking records the resume obligation before the daemon is stopped", async () => {
  const root = await workspace("ws_park");
  await recordDesired(root, "running", "acct_park");
  const stopped: string[] = [];
  await parkDaemonForMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_park"),
    stopDaemon: async (r) => {
      // The obligation is already on disk while the process is still being stopped.
      const midPark = JSON.parse(await fs.readFile(desiredStatePath(r), "utf8"));
      expect(midPark.maintenance).toMatchObject({ id: "mt_1", resume: "running" });
      stopped.push(r);
    },
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });
  expect(stopped).toEqual([root]);
  const parked = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(parked).toMatchObject({ state: "stopped", maintenance: { id: "mt_1", resume: "running" } });
});

test("only the matching token resumes, and it resumes exactly once", async () => {
  const root = await workspace("ws_resume");
  await recordDesired(root, "running", "acct_resume");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_resume"), stopDaemon: async () => {} });

  const started: string[] = [];
  const start = async (r: string) => {
    started.push(r);
    return "started" as const;
  };
  expect(await resumeDaemonAfterMaintenance(root, "mt_other", { loadCredentials: creds("acct_resume"), startDaemon: start })).toBe(false);
  expect(started).toEqual([]);

  expect(await resumeDaemonAfterMaintenance(root, "mt_1", { loadCredentials: creds("acct_resume"), startDaemon: start })).toBe(true);
  expect(started).toEqual([root]);
  const resumed = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(resumed.state).toBe("running");
  expect(resumed.maintenance).toBeUndefined();

  // Replaying the same token is a no-op: the obligation was consumed.
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", { loadCredentials: creds("acct_resume"), startDaemon: start })).toBe(false);
  expect(started).toEqual([root]);
});

test("an explicit stop cancels the maintenance obligation", async () => {
  const root = await workspace("ws_userstop");
  await recordDesired(root, "running", "acct_userstop");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_userstop"), stopDaemon: async () => {} });
  await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_userstop"), stopDaemon: async () => {} });

  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toBeUndefined();
  const started: string[] = [];
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_userstop"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  })).toBe(false);
  expect(started).toEqual([]);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).state).toBe("stopped");
});

test("parking a daemon the user had already stopped does not start it later", async () => {
  const root = await workspace("ws_parkstopped");
  await recordDesired(root, "stopped", "acct_parkstopped");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_parkstopped"), stopDaemon: async () => {} });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toMatchObject({ resume: "stopped" });

  const started: string[] = [];
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_parkstopped"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  })).toBe(false);
  expect(started).toEqual([]);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toBeUndefined();
});

test("a user stop landing inside the park is never overwritten by it", async () => {
  const root = await workspace("ws_parkrace");
  await recordDesired(root, "running", "acct_parkrace");
  // Fires at EVERY credential lookup the park makes, so the stop lands in every
  // gap the park leaves between claiming the token and recording the stop.
  let races = 0;
  const raceThenLoad = async () => {
    races += 1;
    await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_parkrace"), stopDaemon: async () => {} });
    return creds("acct_parkrace")();
  };

  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: raceThenLoad, stopDaemon: async () => {} });
  expect(races).toBeGreaterThan(0);

  const started: string[] = [];
  const restarted = await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_parkrace"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  });
  expect({ restarted, started }).toEqual({ restarted: false, started: [] });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).state).toBe("stopped");
});

test("a user stop landing inside the resume wins over the restart", async () => {
  const root = await workspace("ws_resumerace");
  await recordDesired(root, "running", "acct_resumerace");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_resumerace"), stopDaemon: async () => {} });

  const started: string[] = [];
  const restarted = await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_resumerace"),
    startDaemon: async (r) => {
      // The user changes their mind while the daemon is coming up.
      await stopDaemonAndRecordDesired(root, { loadCredentials: creds("acct_resumerace"), stopDaemon: async () => {} });
      started.push(r);
      return "started" as const;
    },
  });
  expect(started).toEqual([root]);
  expect(restarted).toBe(false);
  const final = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(final.state).toBe("stopped");
  expect(final.maintenance).toBeUndefined();
});

test("a park refuses to take over someone else's open window", async () => {
  const root = await workspace("ws_twoparks");
  await recordDesired(root, "running", "acct_twoparks");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_twoparks"), stopDaemon: async () => {} });

  await expect(parkDaemonForMaintenance(root, "mt_2", {
    loadCredentials: creds("acct_twoparks"),
    stopDaemon: async () => {},
  })).rejects.toThrow("already holding background sync");
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toMatchObject({ id: "mt_1" });
});

test("re-parking under the same token keeps the state it promised to return to", async () => {
  const root = await workspace("ws_reparks");
  await recordDesired(root, "running", "acct_reparks");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_reparks"), stopDaemon: async () => {} });
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_reparks"), stopDaemon: async () => {} });
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toMatchObject({ id: "mt_1", resume: "running" });
});

test("a start that fails leaves the obligation open for the next attempt", async () => {
  const root = await workspace("ws_startfail");
  await recordDesired(root, "running", "acct_startfail");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_startfail"), stopDaemon: async () => {} });

  await expect(resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_startfail"),
    startDaemon: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");

  // The commitment is durable and the obligation is NOT consumed.
  const stranded = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(stranded).toMatchObject({ state: "running", maintenance: { id: "mt_1", resume: "running" } });

  const started: string[] = [];
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_startfail"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  })).toBe(true);
  expect(started).toEqual([root]);
  expect(JSON.parse(await fs.readFile(desiredStatePath(root), "utf8")).maintenance).toBeUndefined();
});

test("a crash between the restart and the token clear resolves to a plain clear", async () => {
  const root = await workspace("ws_clearcrash");
  await recordDesired(root, "running", "acct_clearcrash");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_clearcrash"), stopDaemon: async () => {} });
  // The daemon came up but the process died before consuming the window.
  await expect(resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_clearcrash"),
    startDaemon: async () => { throw new Error("power loss"); },
  })).rejects.toThrow("power loss");

  const starts: string[] = [];
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_clearcrash"),
    startDaemon: async (r) => {
      starts.push(r);
      return "already-running" as const;
    },
  })).toBe(true);
  const final = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(final.state).toBe("running");
  expect(final.maintenance).toBeUndefined();
});

test("a user start waits for a live scope edit and then reports it", async () => {
  const root = await workspace("ws_startblocked");
  await recordDesired(root, "running", "acct_startblocked");
  const started: string[] = [];

  await withScopeTransitionLock(root, async () => {
    // A scope edit holds the lock: the daemon must not boot into a half-applied scope.
    await expect(startDaemonForUser(root, {
      loadCredentials: creds("acct_startblocked"),
      lockWaitMs: 1,
      startDaemon: async (r) => {
        started.push(r);
        return "started" as const;
      },
    })).rejects.toThrow("in progress");
  });
  expect(started).toEqual([]);
});

test("a user start after a crashed scope edit cancels the window and boots", async () => {
  const root = await workspace("ws_startorphan");
  await recordDesired(root, "running", "acct_startorphan");
  await parkDaemonForMaintenance(root, "mt_1", { loadCredentials: creds("acct_startorphan"), stopDaemon: async () => {} });
  // The edit died here: the window is open and nothing holds the lock.

  const started: string[] = [];
  await startDaemonForUser(root, {
    loadCredentials: creds("acct_startorphan"),
    startDaemon: async (r) => {
      started.push(r);
      return "started" as const;
    },
  });
  expect(started).toEqual([root]);
  const final = JSON.parse(await fs.readFile(desiredStatePath(root), "utf8"));
  expect(final.state).toBe("running");
  expect(final.maintenance).toBeUndefined();

  // And the cancelled window cannot be resumed behind the user's back.
  expect(await resumeDaemonAfterMaintenance(root, "mt_1", {
    loadCredentials: creds("acct_startorphan"),
    startDaemon: async () => "started" as const,
  })).toBe(false);
});
