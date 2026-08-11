import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindingRegistryPath, readPersistedEntries } from "./binding-registry.js";
import { readDesiredRecord } from "./autostart/desired-state.js";
import { repairFolderMove, type FolderRepairStep } from "./folder-repair-cmd.js";
import { serializeFolderCatalog } from "./folder-config.js";
import { daemonRuntimeDir, folderCatalogPath } from "./rbox-paths.js";
import type { WorkspaceConfig } from "./workspace-config.js";

let home: string;
let scratch: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-repair-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-repair-roots-"));
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

interface MoveFixture {
  oldRoot: string;
  newRoot: string;
  workspaceId: string;
  deviceId: string;
}

async function seedMove(suffix: string): Promise<MoveFixture> {
  const oldRoot = path.join(scratch, `old-${suffix}`);
  const newRoot = path.join(scratch, `new-${suffix}`);
  const workspaceId = `ws_${suffix}`;
  const deviceId = `dev_${suffix}`;
  const config: WorkspaceConfig = {
    schema: "e2ee/v1",
    remoteWorkspaceId: workspaceId,
    projectId: "root",
    deviceId,
    rootPath: oldRoot,
    remoteUrl: "https://api.test",
    token: "",
  };
  await fs.mkdir(path.join(newRoot, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(newRoot, ".rbox", "workspace.json"), JSON.stringify(config));
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: `Moved ${suffix}`, path: newRoot }],
  }));
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [{
      root: oldRoot,
      workspaceId,
      name: `Workspace ${suffix}`,
      accountId: "acct_repair",
      boundAt: "2026-08-01T00:00:00.000Z",
      lastSeenAt: "2026-08-10T00:00:00.000Z",
      scope: ["src"],
    }],
  }));
  await fs.mkdir(daemonRuntimeDir(oldRoot), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(oldRoot), "desired.json"), JSON.stringify({
    rootPath: oldRoot,
    state: "running",
    accountId: "acct_repair",
    workspaceId,
    at: "2026-08-11T00:00:00.000Z",
    pullOnly: true,
  }));
  return { oldRoot, newRoot, workspaceId, deviceId };
}

async function expectConverged(fixture: MoveFixture): Promise<void> {
  const config = JSON.parse(await fs.readFile(path.join(fixture.newRoot, ".rbox", "workspace.json"), "utf8"));
  expect(config.rootPath).toBe(fixture.newRoot);
  expect(config.deviceId).toBe(fixture.deviceId);
  expect(await fs.exists(daemonRuntimeDir(fixture.oldRoot))).toBe(false);
  expect(await fs.exists(daemonRuntimeDir(fixture.newRoot))).toBe(true);
  expect((await readDesiredRecord(path.join(daemonRuntimeDir(fixture.newRoot), "desired.json")))?.rootPath).toBe(fixture.newRoot);
  expect(await readPersistedEntries()).toEqual([{
    root: fixture.newRoot,
    workspaceId: fixture.workspaceId,
    name: expect.any(String),
    accountId: "acct_repair",
    boundAt: "2026-08-01T00:00:00.000Z",
    lastSeenAt: "2026-08-10T00:00:00.000Z",
    scope: ["src"],
  }]);
}

test("repair rewrites binding, registry, desired state, and the path-derived runtime key", async () => {
  const fixture = await seedMove("complete");
  const lines: string[] = [];
  await repairFolderMove(fixture.newRoot, { write: (line) => lines.push(line) });
  await expectConverged(fixture);
  expect(lines.at(-1)).toContain(`${fixture.oldRoot} → ${fixture.newRoot}`);
});

test("every durable crash boundary retries to the same complete state", async () => {
  const steps: FolderRepairStep[] = [
    "daemons-stopped",
    "runtime-renamed",
    "runtime-parent-synced",
    "desired-rebased",
    "registry-relocated",
    "binding-written",
    "binding-parent-synced",
  ];
  for (const target of steps) {
    const fixture = await seedMove(target);
    let injected = false;
    await expect(repairFolderMove(fixture.newRoot, {
      write: () => {},
      onStep: (step) => {
        if (!injected && step === target) {
          injected = true;
          throw new Error(`crash after ${step}`);
        }
      },
    })).rejects.toThrow(`crash after ${target}`);
    expect(injected, `step ${target} must be reachable`).toBe(true);
    await repairFolderMove(fixture.newRoot, { write: () => {} });
    await expectConverged(fixture);
    await fs.rm(folderCatalogPath(), { force: true });
    await fs.rm(bindingRegistryPath(), { force: true });
  }
});

test("repair refuses copies by full workspace/device identity but permits another device", async () => {
  const blocked = await seedMove("blocked");
  const copy = path.join(scratch, "copy");
  await fs.mkdir(path.join(copy, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(copy, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: blocked.workspaceId,
    projectId: "root",
    deviceId: blocked.deviceId,
    rootPath: copy,
    remoteUrl: "https://api.test",
    token: "",
  }));
  const catalog = JSON.parse(await fs.readFile(folderCatalogPath(), "utf8"));
  catalog.folders.push({ name: "Copy", path: copy });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog(catalog));
  await expect(repairFolderMove(blocked.newRoot, { write: () => {} })).rejects.toThrow(/same workspace and device binding/);

  const allowed = await seedMove("allowed");
  const peer = path.join(scratch, "peer-device");
  await fs.mkdir(path.join(peer, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(peer, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: allowed.workspaceId,
    projectId: "root",
    deviceId: "dev_peer",
    rootPath: peer,
    remoteUrl: "https://api.test",
    token: "",
  }));
  const allowedCatalog = JSON.parse(await fs.readFile(folderCatalogPath(), "utf8"));
  allowedCatalog.folders.push({ name: "Peer", path: peer });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog(allowedCatalog));
  await repairFolderMove(allowed.newRoot, { write: () => {} });
  await expectConverged(allowed);
});

test("repair refuses when the old path or both runtime keys still exist", async () => {
  const existing = await seedMove("old-exists");
  await fs.mkdir(existing.oldRoot, { recursive: true });
  await expect(repairFolderMove(existing.newRoot, { write: () => {} })).rejects.toThrow(/old path still exists/);

  const conflicting = await seedMove("runtime-conflict");
  await fs.mkdir(daemonRuntimeDir(conflicting.newRoot), { recursive: true });
  await expect(repairFolderMove(conflicting.newRoot, { write: () => {} })).rejects.toThrow(/both old and new daemon runtime/);
});

