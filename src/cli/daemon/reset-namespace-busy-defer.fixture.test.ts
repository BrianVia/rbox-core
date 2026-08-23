import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// Top-level mock.module swaps reset-namespace-inventory for EVERY later file in a
// shared shard process (35 downstream failures when this ran in shard 4). Run
// the real body only in an isolated subprocess, like the other *.fixture tests.
if (process.env.RBOX_RESET_BUSY_FIXTURE !== "1") {
  test.skip("reset-busy fixture runs in an isolated subprocess", () => {});
} else {

const inventoryPath = path.resolve(import.meta.dir, "../reset-namespace-inventory.js");
const realInventory = await import(inventoryPath);
const realInventoryResetNamespace = realInventory.inventoryResetNamespace;
let mode: "busy" | "invalid" | "real" = "real";

mock.module(inventoryPath, () => ({
  ...realInventory,
  inventoryResetNamespace: async (root: string, options?: Parameters<typeof realInventory.inventoryResetNamespace>[1]) => {
    if (mode === "busy") throw new realInventory.ResetNamespaceInventoryError("RESET_NAMESPACE_BUSY", root, "directory-identity-churn");
    if (mode === "invalid") throw new realInventory.ResetNamespaceInventoryError("RESET_NAMESPACE_INVALID", root, "unexpected-entry");
    return realInventoryResetNamespace(root, options);
  },
}));

const [{ HashCache }, config, { RboxDaemon }, { readResetHaltHealth }, mutex, authority, wholeState, policy] = await Promise.all([
  import("../../engine/index.js"),
  import("../config.js"),
  import("../daemon.js"),
  import("../reset-health.js"),
  import("../sync-mutex.js"),
  import("../state-plane/authority-bootstrap.js"),
  import("../state-plane/adapters/whole-state-compat.js"),
  import("./reset-halt-policy.js"),
]);

const NOW = Date.parse("2026-08-23T12:00:00.000Z");
let root = "";
let cfg: config.WorkspaceConfig;
let state: config.SyncState;
const daemons: BusyInternals[] = [];

interface BusyInternals {
  cache: InstanceType<typeof HashCache>;
  resetLifecycle: "ready" | "halted" | "recovering" | "bootstrapping";
  resetNamespaceBusyDeferrals: number;
  resetRetryTimer?: ReturnType<typeof setTimeout>;
  nextResetRetryAt: number;
  stopped: boolean;
  want: { fullScan: boolean };
  pump(): Promise<void>;
  resetOperationBoundary(): Promise<boolean>;
}

beforeEach(async () => {
  mode = "real";
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-reset-namespace-busy-")));
  cfg = {
    schema: "e2ee/v1", remoteWorkspaceId: "ws-busy", projectId: "root", deviceId: "dev-busy",
    rootPath: root, remoteUrl: "https://api.invalid", token: "", encrypted: true,
  };
  state = {
    stream: config.syncStreamId(cfg), stateNonce: "a".repeat(32), stateRevision: 1,
    lastSyncedSequence: 3, lastSyncedManifest: { generatedAt: "", files: [] },
  };
  await config.saveConfig(root, cfg);
  await config.saveStateUnsafeLegacyOrTest(root, state);
  await establishSqliteAuthority();
});

afterEach(async () => {
  for (const daemon of daemons) if (daemon.resetRetryTimer) clearTimeout(daemon.resetRetryTimer);
  daemons.length = 0;
  await fs.rm(root, { recursive: true, force: true });
});

function daemon(logs: string[] = []): BusyInternals {
  const instance = new RboxDaemon(root, cfg, {} as never, {
    now: () => NOW,
    log: (line) => void logs.push(line),
  }) as BusyInternals;
  instance.cache = new HashCache();
  daemons.push(instance);
  return instance;
}

async function establishSqliteAuthority(): Promise<void> {
  await fs.rm(config.statePath(root));
  const held = await mutex.acquireWorkspaceSyncMutex(root, "cli");
  try {
    const outcome = await authority.admitGenesisAuthority(root, held);
    if (outcome.kind !== "selected" || outcome.authority.kind !== "sqlite-store") {
      throw new Error(`fixture did not establish SQLite authority: ${JSON.stringify(outcome)}`);
    }
  } finally {
    await mutex.releaseWorkspaceSyncMutex(held);
  }
  const current = await wholeState.loadRawState(root);
  const saved = await wholeState.applyStateSavePacket(root, {
    expectedStream: config.syncStreamId(cfg),
    expectedNonce: current?.stateNonce ?? "legacy",
    sourceGlobalSeq: state.lastSyncedSequence,
    global: { manifest: state.lastSyncedManifest },
    repos: [],
  });
  if (saved.status !== "accepted") throw new Error(`fixture did not populate SQLite authority: ${JSON.stringify(saved)}`);
}

test("a busy steady namespace defers and logs once per interval", async () => {
  const logs: string[] = [];
  const d = daemon(logs);
  mode = "busy";

  expect(await d.resetOperationBoundary()).toBe(false);
  expect(await d.resetOperationBoundary()).toBe(false);
  expect(d.resetLifecycle).toBe("ready");
  expect(await readResetHaltHealth(root)).toBeUndefined();
  expect(d.nextResetRetryAt).toBe(NOW + policy.RESET_NAMESPACE_BUSY_RETRY_MS);
  expect(d.resetRetryTimer).toBeDefined();
  expect(logs.filter((line) => line.includes("RESET_NAMESPACE_BUSY"))).toHaveLength(1);
});

test("the service loop survives a busy namespace census", async () => {
  const d = daemon();
  d.want.fullScan = true;
  mode = "busy";
  const failSafe = setTimeout(() => { d.stopped = true; }, 250);

  try {
    await expect(d.pump()).resolves.toBeUndefined();
  } finally {
    clearTimeout(failSafe);
  }
  expect(d.want.fullScan).toBe(true);
  expect(d.resetLifecycle).toBe("ready");
  mode = "real";
  expect(await d.resetOperationBoundary()).toBe(true);
});

test("the next real inspection recovers and clears the busy episode", async () => {
  const d = daemon();
  mode = "busy";
  expect(await d.resetOperationBoundary()).toBe(false);
  expect(d.resetNamespaceBusyDeferrals).toBe(1);

  mode = "real";
  expect(await d.resetOperationBoundary()).toBe(true);
  expect(d.resetLifecycle).toBe("ready");
  expect(d.resetNamespaceBusyDeferrals).toBe(0);
});

test("a pending reset escalates after the bounded busy deferrals", async () => {
  const d = daemon();
  d.resetLifecycle = "recovering";
  mode = "busy";

  for (let attempt = 1; attempt < policy.RESET_NAMESPACE_BUSY_DEFER_ATTEMPTS; attempt++) {
    expect(await d.resetOperationBoundary()).toBe(false);
    expect(await readResetHaltHealth(root)).toBeUndefined();
  }
  const shortTimer = d.resetRetryTimer;
  expect(await d.resetOperationBoundary()).toBe(false);
  expect(d.resetLifecycle).toBe("halted");
  expect((await readResetHaltHealth(root))?.reason).toContain("RESET_NAMESPACE_BUSY");
  expect(d.nextResetRetryAt).toBe(NOW + policy.RESET_RECOVERY_RETRY_MS);
  expect(d.resetRetryTimer).toBeDefined();
  expect(d.resetRetryTimer).not.toBe(shortTimer);
});

test("invalid namespace verdicts still propagate without arming a retry", async () => {
  const d = daemon();
  mode = "invalid";

  await expect(d.resetOperationBoundary()).rejects.toMatchObject({ code: "RESET_NAMESPACE_INVALID" });
  expect(d.resetRetryTimer).toBeUndefined();
  expect(d.nextResetRetryAt).toBe(Number.NEGATIVE_INFINITY);
});

}
