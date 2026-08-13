import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DaemonMutexResult, WorkspaceSyncMutex } from "../sync-mutex.js";
import { RECOVERY_PROBE_SERVICE_BOUND, type PumpOperation, type Wants } from "./policy.js";
import {
  DaemonOperationScheduler,
  lockStarvationPath,
  readLockStarvationEpisode,
  type DaemonOperationExecutor,
  type DaemonSchedulerPorts,
} from "./daemon-operation-scheduler.js";

/** A structurally sufficient handle: the release port is injected, so no real lock file. */
const HANDLE = { released: false } as unknown as WorkspaceSyncMutex;
const ACQUIRED: DaemonMutexResult = { status: "acquired", handle: HANDLE };
const contended = (holderKey: string, warningReason?: "foreign" | "fence"): DaemonMutexResult => ({
  status: "contended",
  holderKey,
  blockerKind: warningReason === "fence" ? "fence" : "live",
  ...(warningReason ? { warningReason } : {}),
});

interface Rig {
  scheduler: DaemonOperationScheduler;
  serviced: PumpOperation[];
  boundaries: number;
  drains: number;
  released: number;
  lines: string[];
  now: number;
  acquisitions: DaemonMutexResult[];
  stopped: boolean;
  reentryReady: boolean;
  halt: { op: keyof Wants; witness: string } | undefined;
  starvationCounts: number;
  timers: { fn: () => void; ms: number }[];
  onOperation?: (op: PumpOperation) => void | Promise<void>;
  onBoundary?: () => boolean;
  onDrain?: () => void;
  service(): Promise<void>;
}

function rig(root = "/nonexistent-rig-root"): Rig {
  const state: Rig = {
    scheduler: undefined as unknown as DaemonOperationScheduler,
    serviced: [],
    boundaries: 0,
    drains: 0,
    released: 0,
    lines: [],
    now: 0,
    acquisitions: [],
    stopped: false,
    reentryReady: true,
    halt: undefined,
    starvationCounts: 0,
    timers: [],
    service: async () => {},
  };
  const ports: DaemonSchedulerPorts = {
    root,
    now: () => state.now,
    log: (line) => void state.lines.push(line),
    recoveryClock: {
      setTimeout: (fn, ms) => {
        const handle = { fn, ms };
        state.timers.push(handle);
        return handle;
      },
      clearTimeout: (handle) => {
        const index = state.timers.indexOf(handle as { fn: () => void; ms: number });
        if (index >= 0) state.timers.splice(index, 1);
      },
    },
    acquireMutex: async () => state.acquisitions.shift() ?? ACQUIRED,
    releaseMutex: async () => void (state.released += 1),
    isStopped: () => state.stopped,
    readyForReentry: () => !state.stopped && state.reentryReady,
    standingHalt: () => state.halt,
    countLockStarvation: async () => void (state.starvationCounts += 1),
    wake: () => void state.service(),
  };
  const executor: DaemonOperationExecutor = {
    openOperationBoundary: async () => {
      state.boundaries += 1;
      return state.onBoundary ? state.onBoundary() : true;
    },
    runOperation: async (op) => {
      state.serviced.push(op);
      await state.onOperation?.(op);
    },
    settleAfterDrain: async () => {
      state.drains += 1;
      state.onDrain?.();
    },
  };
  state.scheduler = new DaemonOperationScheduler(ports);
  state.service = () => state.scheduler.service(executor);
  return state;
}

test("contract: a queued wakeup is serviced exactly once and the queue drains", async () => {
  const r = rig();
  r.scheduler.request("push");
  expect(r.scheduler.wants.push).toBe(true);
  await r.service();
  expect(r.serviced).toEqual(["push"]);
  expect(r.scheduler.wants.push).toBe(false);
  expect(r.scheduler.activePumpOp).toBeUndefined();
  expect(r.boundaries).toBe(1);
  expect(r.released).toBe(1);
  expect(r.drains).toBe(1);
});

test("contract: the active operation is published while it runs and cleared after", async () => {
  const r = rig();
  const seen: (PumpOperation | undefined)[] = [];
  r.onOperation = () => void seen.push(r.scheduler.activePumpOp);
  r.scheduler.request("pull");
  await r.service();
  expect(seen).toEqual(["pull"]);
  expect(r.scheduler.activePumpOp).toBeUndefined();
});

test("contract: contention re-queues the request instead of consuming it", async () => {
  const r = rig();
  r.acquisitions = [contended("a".repeat(64)), ACQUIRED];
  r.scheduler.request("pull");
  await r.service();
  // The contended iteration ran no boundary and no operation, and the want survived
  // to be serviced by the next acquisition.
  expect(r.boundaries).toBe(1);
  expect(r.serviced).toEqual(["pull"]);
  expect(r.released).toBe(1);
  expect(r.lines.some((line) => line.includes("sync busy; re-queued"))).toBe(true);
});

test("contract: mutex backoff escalates per holder, caps, and resets on acquisition", async () => {
  const r = rig();
  const key = "a".repeat(64);
  const delays = Array.from({ length: 10 }, () => r.scheduler.mutexDelay(key).delayMs);
  expect(delays).toEqual([250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000]);
  expect(r.scheduler.mutexDelay("b".repeat(64))).toEqual({ delayMs: 250, shouldLog: true });
  r.scheduler.resetMutexBackoff();
  expect(r.scheduler.mutexDelay(key)).toEqual({ delayMs: 250, shouldLog: true });
});

test("contract: a standing halt is ineligible ambiently and heals only through its own probe", async () => {
  const r = rig();
  r.halt = { op: "push", witness: "w1" };
  r.scheduler.request("push");
  // A halted op is not eligible as an ambient operation: nothing but the probe may run it.
  expect(r.scheduler.nextOperation()).toBeUndefined();
  r.scheduler.recoveryDue = true;
  expect(r.scheduler.nextOperation()).toBe("recoveryProbe");
  await r.service();
  expect(r.serviced).toEqual(["recoveryProbe"]);
  // The probe consumed the halted op's queued want and reset the fairness episode.
  expect(r.scheduler.wants.push).toBe(false);
  expect(r.scheduler.recoveryDue).toBe(false);
  expect(r.scheduler.recoveryDequeuesSinceDue).toBe(0);
});

test("contract: a due probe whose halt is already retired terminates the loop", async () => {
  const r = rig();
  r.halt = undefined; // the halt healed, but the due probe outlived it
  r.scheduler.recoveryDue = true;
  expect(r.scheduler.nextOperation()).toBe("recoveryProbe");
  const timeout = new Promise<"timeout">((resolve) => void setTimeout(() => resolve("timeout"), 2_000));
  expect(await Promise.race([r.service().then(() => "done" as const), timeout])).toBe("done");
  expect(r.serviced).toEqual([]);
  expect(r.scheduler.recoveryDue).toBe(false);
  expect(r.scheduler.nextOperation()).toBeUndefined();
});

test("contract: a refused boundary ends the loop without servicing or draining the queue", async () => {
  const r = rig();
  r.scheduler.queue("pull");
  r.onBoundary = () => false;
  await r.service();
  expect(r.serviced).toEqual([]);
  expect(r.scheduler.wants.pull).toBe(true); // a refused boundary must not consume the want
  expect(r.released).toBe(1);
});

test("contract: ambient work is serviced ahead of a due probe until the fairness bound", async () => {
  const r = rig();
  r.halt = { op: "push", witness: "w1" };
  r.scheduler.recoveryDue = true;
  let scans = 0;
  r.onOperation = (op) => {
    if (op === "deepScan" && ++scans <= RECOVERY_PROBE_SERVICE_BOUND) r.scheduler.queue("deepScan");
  };
  r.scheduler.queue("deepScan");
  await r.service();
  expect(r.serviced.slice(0, RECOVERY_PROBE_SERVICE_BOUND)).toEqual(
    Array.from({ length: RECOVERY_PROBE_SERVICE_BOUND }, () => "deepScan" as PumpOperation),
  );
  expect(r.serviced[RECOVERY_PROBE_SERVICE_BOUND]).toBe("recoveryProbe");
});

test("contract: single-flight — a second service call joins rather than starting a loop", async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  r.onOperation = () => { entered(); return gate; };
  r.scheduler.queue("pull");
  const first = r.service();
  await started; // the loop is inside its operation, parked on the gate
  r.scheduler.queue("push");
  let joined = false;
  const second = r.service().then(() => { joined = true; });
  await Promise.resolve();
  // The second caller starts no competing loop, but its completion receipt is the
  // existing flight: an awaited pump cannot claim the queued push is done yet.
  expect(joined).toBe(false);
  expect(r.serviced).toEqual(["pull"]);
  release();
  await Promise.all([first, second]);
  expect(r.serviced).toEqual(["pull", "push"]);
  expect(r.drains).toBe(1);
});

test("contract: a wakeup arriving during exit-time settlement is not lost", async () => {
  const r = rig();
  r.scheduler.queue("pull");
  r.onDrain = () => {
    if (r.drains === 1) r.scheduler.queue("push");
  };
  await r.service();
  expect(r.serviced).toEqual(["pull", "push"]);
  expect(r.drains).toBe(2);
  expect(r.scheduler.pumping).toBe(false);
});

test("contract: exit-time re-entry is refused while the daemon is not ready to service", async () => {
  const r = rig();
  r.scheduler.queue("pull");
  r.onDrain = () => {
    r.reentryReady = false;
    r.scheduler.queue("push");
  };
  await r.service();
  expect(r.serviced).toEqual(["pull"]);
  expect(r.scheduler.wants.push).toBe(true);
});

test("contract: stopping refuses new service and drains the in-flight loop", async () => {
  const r = rig();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  r.onOperation = () => gate;
  r.scheduler.queue("pull");
  const inFlight = r.service();
  r.stopped = true;
  await r.service(); // a stopped scheduler starts no loop
  const drained = r.scheduler.stop();
  release();
  const receipt = await drained;
  await inFlight;
  expect(r.serviced).toEqual(["pull"]); // the committed operation completed
  expect(receipt.activeOperation).toBeUndefined();
  expect(receipt.queued).toEqual({ pull: false, push: false, fullScan: false, deepScan: false });
  expect(r.scheduler.pumping).toBe(false);
});

test("contract: stopping disarms the standing recovery probe and any parked backoff", async () => {
  const r = rig();
  r.halt = { op: "push", witness: "w1" };
  r.scheduler.armRecoveryProbe(5_000, "w1");
  expect(r.timers).toHaveLength(1);
  const parked = r.scheduler.waitForMutexBackoff(30_000);
  expect(r.scheduler.mutexBackoffController).toBeDefined();
  await r.scheduler.stop();
  await parked;
  expect(r.timers).toHaveLength(0);
  expect(r.scheduler.mutexBackoffController).toBeUndefined();
});

test("contract: the armed probe fires only for the witness it was armed against", () => {
  const r = rig();
  r.stopped = true; // the wakeup must not start a loop inside this unit
  r.halt = { op: "push", witness: "w1" };
  r.scheduler.armRecoveryProbe(0, "w1");
  r.halt = { op: "push", witness: "w2" }; // a newer failure re-armed a different episode
  r.timers.shift()!.fn();
  expect(r.scheduler.recoveryDue).toBe(false);

  r.scheduler.armRecoveryProbe(0, "w2");
  r.timers.shift()!.fn();
  expect(r.scheduler.recoveryDue).toBe(true);
  expect(r.serviced).toEqual([]); // wake() ran; the fake service resolves asynchronously
});

test("contract: an early re-probe signal is rate limited and never fires without a parked wait", async () => {
  const r = rig();
  r.scheduler.request("push"); // no backoff parked: nothing to abort
  const parked = r.scheduler.waitForMutexBackoff(30_000);
  r.scheduler.request("push");
  await parked; // aborted early

  const rateLimited = r.scheduler.waitForMutexBackoff(30_000);
  r.scheduler.request("push");
  let resolved = false;
  void rateLimited.then(() => { resolved = true; });
  await Promise.resolve();
  expect(resolved).toBe(false);

  r.now = 2_000;
  r.scheduler.request("push");
  await rateLimited;
  expect(resolved).toBe(true);
});

test("contract: a newer parked wait is not cleared by an older one completing", async () => {
  const r = rig();
  const older = r.scheduler.waitForMutexBackoff(30_000);
  const olderController = r.scheduler.mutexBackoffController!;
  const newer = r.scheduler.waitForMutexBackoff(30_000);
  const newerController = r.scheduler.mutexBackoffController!;
  olderController.abort();
  await older;
  expect(r.scheduler.mutexBackoffController).toBe(newerController);
  r.scheduler.abortMutexBackoff();
  await newer;
  expect(r.scheduler.mutexBackoffController).toBeUndefined();
});

test("contract: a starvation episode warns and counts at most once per holder", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-scheduler-starve-"));
  try {
    const r = rig(root);
    await r.scheduler.observeLockContention({ status: "contended", holderKey: "a".repeat(64), blockerKind: "foreign", warningReason: "foreign" });
    expect(await readLockStarvationEpisode(root)).toEqual({ holderKey: "a".repeat(64), firstSeenAt: 0 });
    expect(r.starvationCounts).toBe(0);

    r.now = 15 * 60_000;
    await r.scheduler.observeLockContention({ status: "contended", holderKey: "a".repeat(64), blockerKind: "foreign", warningReason: "foreign" });
    expect(r.starvationCounts).toBe(1);
    expect(r.lines).toEqual(["lock starved: reason=foreign age=15m"]);

    r.now = 30 * 60_000;
    await r.scheduler.observeLockContention({ status: "contended", holderKey: "a".repeat(64), blockerKind: "foreign", warningReason: "foreign" });
    expect(r.starvationCounts).toBe(1);
    expect(r.lines).toHaveLength(1);

    // A live (non-warning) contention retires the durable episode.
    await r.scheduler.observeLockContention({ status: "contended", holderKey: "a".repeat(64), blockerKind: "live" });
    expect(await fs.stat(lockStarvationPath(root)).then(() => true, () => false)).toBe(false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
