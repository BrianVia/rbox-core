import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindingRegistryPath } from "./binding-registry.js";
import {
  inspectFolderCatalog,
  serializeFolderCatalog,
} from "./folder-config.js";
import {
  applyFolderPolicy,
  listFolderInventory,
  observeFolderAdmission,
  observeFolderGeneration,
} from "./folder-inventory.js";
import type { WorkspaceConfig } from "./workspace-config.js";
import { daemonRuntimeDir, folderCatalogPath } from "./rbox-paths.js";
import { collectMachineTriage } from "./doctor-machine.js";

let home: string;
let scratch: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-inventory-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-inventory-roots-"));
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

async function bind(root: string, workspaceId: string): Promise<string> {
  const file = path.join(root, ".rbox", "workspace.json");
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({
    remoteWorkspaceId: workspaceId,
    projectId: "root",
    deviceId: `dev_${workspaceId}`,
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
  }));
  return file;
}

async function desired(root: string, workspaceId: string): Promise<string> {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  const file = path.join(daemonRuntimeDir(root), "desired.json");
  await fs.writeFile(file, JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_derived",
    workspaceId,
    at: "2026-08-11T10:00:00.000Z",
  }));
  return file;
}

async function writeRegistry(entries: object[]): Promise<string> {
  const file = bindingRegistryPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify({ schemaVersion: 1, entries }));
  return file;
}

async function writeCatalog(roots: string[]): Promise<string> {
  const file = folderCatalogPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: roots.map((root, index) => ({ name: `Folder ${index + 1}`, path: root })),
  }));
  return file;
}

test("inventory unions all four sources without losing evidence and sorts normalized roots", async () => {
  const all = path.join(scratch, "all");
  const catalogOnly = path.join(scratch, "catalog-only");
  const missing = path.join(scratch, "missing");
  const desiredOnly = path.join(scratch, "desired-only");
  const registryOnly = path.join(scratch, "registry-only");
  await bind(all, "ws_live");
  await fs.mkdir(catalogOnly, { recursive: true });
  await bind(desiredOnly, "ws_desired");
  await bind(registryOnly, "ws_registry");
  await desired(all, "ws_stale");
  await desired(desiredOnly, "ws_desired");
  await writeRegistry([
    { root: all, workspaceId: "ws_stale", boundAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    { root: registryOnly, workspaceId: "ws_registry", boundAt: "2026-08-02T00:00:00.000Z", lastSeenAt: "2026-08-02T00:00:00.000Z" },
  ]);
  await writeCatalog([all, catalogOnly, missing]);

  const state = await inspectFolderCatalog();
  const inventory = await listFolderInventory(state, { currentRoot: all });
  expect(inventory.rows.map((row) => row.root)).toEqual([all, catalogOnly, desiredOnly, missing, registryOnly].sort());
  const joined = inventory.rows.find((row) => row.root === all)!;
  expect(joined).toMatchObject({
    isCurrentRoot: true,
    catalog: { normalizedPath: all },
    registry: { workspaceId: "ws_stale", health: "rebound", currentWorkspaceId: "ws_live", derived: false },
    desired: { desired: { workspaceId: "ws_stale" } },
    binding: { workspaceId: "ws_live", deviceId: "dev_ws_live" },
    admission: { kind: "admitted" },
  });
  expect(inventory.rows.find((row) => row.root === catalogOnly)?.admission.kind).toBe("unbound");
  expect(inventory.rows.find((row) => row.root === missing)?.admission.kind).toBe("missing");
  expect(inventory.rows.find((row) => row.root === desiredOnly)?.admission.kind).toBe("detached");
  expect(inventory.rows.find((row) => row.root === registryOnly)?.admission.kind).toBe("detached");
});

test("catalog membership plus a readable binding admits without registry evidence", async () => {
  const root = path.join(scratch, "configured");
  await bind(root, "ws_configured");
  await writeCatalog([root]);
  const state = await inspectFolderCatalog();
  const row = (await listFolderInventory(state)).rows[0]!;
  expect(row.registry).toBeUndefined();
  expect(row.admission.kind).toBe("admitted");
});

test("machine JSON filters catalog-only rows without changing its closed schema", async () => {
  const root = path.join(scratch, "catalog-only-machine");
  await fs.mkdir(root, { recursive: true });
  await writeCatalog([root]);
  expect(await collectMachineTriage()).toEqual({ schemaVersion: 1, scope: "machine", workspaces: [] });
});

test("unreadable and dangling observations stay visible and are never generated", async () => {
  const unreadable = path.join(scratch, "a-unreadable");
  const dangling = path.join(scratch, "z-dangling");
  await fs.mkdir(path.join(unreadable, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(unreadable, ".rbox", "workspace.json"), "{");
  await writeRegistry([
    { root: unreadable, workspaceId: "ws_bad", boundAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    { root: dangling, workspaceId: "ws_gone", boundAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z" },
  ]);
  await writeCatalog([unreadable, dangling]);
  const state = await inspectFolderCatalog();
  const inventory = await listFolderInventory(state);
  const bad = inventory.rows.find((row) => row.root === unreadable)!;
  expect(bad.binding).toHaveProperty("unreadable");
  expect(bad.admission.kind).toBe("unbound");
  const generation = await observeFolderGeneration(state);
  expect(generation.discoverableBindings).toEqual([]);
  expect(generation.skipped.map((row) => row.root)).toEqual([unreadable, dangling]);
});

test("overlap annotations cover lexical ancestors and observable aliases", async () => {
  const parent = path.join(scratch, "parent");
  const child = path.join(parent, "child");
  const alias = path.join(scratch, "alias");
  await fs.mkdir(child, { recursive: true });
  await fs.symlink(parent, alias);
  await writeCatalog([parent, child, alias]);
  const state = await inspectFolderCatalog();
  const rows = (await listFolderInventory(state)).rows;
  expect(rows.find((row) => row.root === parent)?.overlap).toEqual({ kind: "alias", of: alias });
  expect(rows.find((row) => row.root === alias)?.overlap).toEqual({ kind: "alias", of: parent });
  expect(rows.find((row) => row.root === child)?.overlap).toEqual({ kind: "descendant", of: parent });
});

test("all three inventory entry points are read-only over catalog, registry, desired, and binding bytes", async () => {
  const root = path.join(scratch, "read-only");
  const bindingFile = await bind(root, "ws_readonly");
  const desiredFile = await desired(root, "ws_readonly");
  const registryFile = await writeRegistry([
    { root, workspaceId: "ws_readonly", boundAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z" },
  ]);
  const catalogFile = await writeCatalog([root]);
  const files = [bindingFile, desiredFile, registryFile, catalogFile];
  const before = new Map(await Promise.all(files.map(async (file) => [file, await fs.readFile(file, "utf8")] as const)));
  const writeFile = spyOn(fs, "writeFile");
  const rename = spyOn(fs, "rename");
  try {
    const state = await inspectFolderCatalog();
    await observeFolderAdmission(root, state);
    await listFolderInventory(state, { currentRoot: root });
    await observeFolderGeneration(state, { currentRoot: root });
    expect(writeFile).not.toHaveBeenCalled();
    expect(rename).not.toHaveBeenCalled();
    for (const file of files) expect(await fs.readFile(file, "utf8")).toBe(before.get(file));
  } finally {
    writeFile.mockRestore();
    rename.mockRestore();
  }
});

test("damaged state reports its exact reason without probing the binding", async () => {
  const state = await inspectFolderCatalog();
  const damaged = { kind: "damaged", reason: "exact parse failure", revision: state.revision } as const;
  let probes = 0;
  expect(await observeFolderAdmission(path.join(scratch, "any"), damaged, {
    loadConfigIfPresent: async () => { probes++; return undefined; },
  })).toEqual({ kind: "damaged", reason: "exact parse failure" });
  expect(probes).toBe(0);
});

test("folder policy overlays only safe fields and preserves runtime attachments", () => {
  const kek = Buffer.alloc(32, 7);
  const cfg = {
    remoteWorkspaceId: "ws_runtime",
    projectId: "root",
    deviceId: "dev_runtime",
    rootPath: scratch,
    remoteUrl: "https://credential.invalid",
    token: "runtime-token",
    encrypted: true,
    kek,
    accountId: "acct_runtime",
    accountEpoch: 2,
    keyEpoch: 9,
    syncGit: true,
    git: { incremental: true, runtimeSentinel: "keep" },
  } as WorkspaceConfig & { git: { incremental?: boolean; runtimeSentinel: string } };
  const ignorePaths = ["local-only"];
  const result = applyFolderPolicy(cfg, {
    syncGit: false,
    git: { incremental: false },
    respectGitignore: true,
    ignorePaths,
    noDrift: true,
    trash: { days: 0, maxBytes: 0 },
  }) as typeof cfg;

  expect(result).toMatchObject({
    syncGit: false,
    git: { incremental: false, runtimeSentinel: "keep" },
    respectGitignore: true,
    ignorePaths: ["local-only"],
    noDrift: true,
    trash: { days: 0, maxBytes: 0 },
    encrypted: true,
    remoteUrl: "https://credential.invalid",
    token: "runtime-token",
    accountId: "acct_runtime",
    accountEpoch: 2,
    keyEpoch: 9,
  });
  expect(result.kek).toBe(kek);
  // The overlay must COPY the policy's list: the resolved policy can hand over the
  // frozen DEFAULT_FOLDER_POLICY array, and an aliased cfg field would let a later
  // mutation reach every other binding resolved from that same default.
  expect(result.ignorePaths).not.toBe(ignorePaths);
  expect(cfg.git.incremental).toBe(true);
  expect(cfg.respectGitignore).toBeUndefined();
  expect(cfg.ignorePaths).toBeUndefined();
});
