import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindingRegistryPath, readBindingRegistry } from "./binding-registry.js";
import {
  inspectFolderCatalog,
  serializeFolderCatalog,
} from "./folder-config.js";
import {
  listFolderInventory,
  observeFolderAdmission,
  observeFolderGeneration,
} from "./folder-inventory.js";
import { daemonRuntimeDir, folderCatalogPath } from "./rbox-paths.js";

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

async function bind(root: string, workspaceId: string, extra: object = {}): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: workspaceId,
    projectId: "root",
    deviceId: `dev_${workspaceId}`,
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    ...extra,
  }));
}

async function desired(root: string, workspaceId: string): Promise<void> {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(root), "desired.json"), JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_derived",
    workspaceId,
    at: "2026-08-11T10:00:00.000Z",
  }));
}

function registryProjection(row: object): object {
  return Object.fromEntries(Object.entries(row).filter(([key]) => key !== "admission"));
}

test("required-state inventory remains a read-only differential wrapper over registry rows", async () => {
  const bound = path.join(scratch, "bound");
  const missing = path.join(scratch, "missing");
  const derived = path.join(scratch, "derived");
  await bind(bound, "ws_bound");
  await bind(derived, "ws_derived");
  await desired(derived, "ws_derived");
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [
      { root: missing, workspaceId: "ws_missing", boundAt: "2026-08-07T10:00:00.000Z", lastSeenAt: "2026-08-08T10:00:00.000Z" },
      { root: bound, workspaceId: "ws_bound", name: "Bound", boundAt: "2026-08-05T10:00:00.000Z", lastSeenAt: "2026-08-06T10:00:00.000Z" },
    ],
  }));
  const before = await fs.readFile(bindingRegistryPath(), "utf8");
  const expected = await readBindingRegistry();
  const state = await inspectFolderCatalog();
  const inventory = await listFolderInventory(state);
  expect(inventory.catalogState).toBe("absent");
  expect(inventory.revision).toBe(state.revision);
  expect(inventory.rows.map(registryProjection)).toEqual(expected);
  expect(inventory.rows.find((row) => row.root === missing)?.admission.kind).toBe("missing");
  expect(inventory.rows.find((row) => row.root === bound)?.admission.kind).toBe("damaged");
  expect(await fs.readFile(bindingRegistryPath(), "utf8")).toBe(before);
  await expect(fs.readFile(folderCatalogPath(), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("damaged state reports its exact reason without probing the binding", async () => {
  const state = await inspectFolderCatalog();
  const damaged = { kind: "damaged", reason: "exact parse failure", revision: state.revision } as const;
  expect(await observeFolderAdmission(path.join(scratch, "any"), damaged)).toEqual({
    kind: "damaged",
    reason: "exact parse failure",
  });
});

test("authoritative admission distinguishes admitted, unbound, missing, and detached roots", async () => {
  const admitted = path.join(scratch, "admitted");
  const unbound = path.join(scratch, "unbound");
  const missing = path.join(scratch, "missing");
  const detached = path.join(scratch, "detached");
  await bind(admitted, "ws_admitted");
  await fs.mkdir(unbound, { recursive: true });
  await bind(detached, "ws_detached");
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: [
      { name: "Admitted", path: admitted },
      { name: "Unbound", path: unbound },
      { name: "Missing", path: missing },
    ],
  }));
  const state = await inspectFolderCatalog();
  expect(await observeFolderAdmission(admitted, state)).toMatchObject({ kind: "admitted" });
  expect(await observeFolderAdmission(unbound, state)).toMatchObject({ kind: "unbound" });
  expect(await observeFolderAdmission(missing, state)).toMatchObject({ kind: "missing" });
  expect(await observeFolderAdmission(detached, state)).toMatchObject({ kind: "detached" });
});

test("generation observation is sorted, includes current root, skips dangling rows, and writes nothing", async () => {
  const first = path.join(scratch, "a");
  const later = path.join(scratch, "z");
  const missing = path.join(scratch, "missing");
  await bind(first, "ws_a");
  await bind(later, "ws_z");
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [
      { root: later, workspaceId: "ws_z", boundAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z" },
      { root: missing, workspaceId: "ws_missing", boundAt: "2026-08-01T00:00:00.000Z", lastSeenAt: "2026-08-01T00:00:00.000Z" },
    ],
  }));
  const before = await fs.readFile(bindingRegistryPath(), "utf8");
  const state = await inspectFolderCatalog();
  const observed = await observeFolderGeneration(state, { currentRoot: first });
  expect(observed.revision).toBe(state.revision);
  expect(observed.discoverableBindings.map((entry) => entry.root)).toEqual([first, later]);
  expect(observed.skipped).toEqual([{ root: missing, reason: "the folder does not exist" }]);
  expect(await fs.readFile(bindingRegistryPath(), "utf8")).toBe(before);
});
