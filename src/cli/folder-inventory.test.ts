import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindingRegistryPath, readBindingRegistry } from "./binding-registry.js";
import { DEFAULT_FOLDER_POLICY, type FolderCatalogSnapshot } from "./folder-config.js";
import { collectMachineTriage } from "./doctor-machine.js";
import {
  listFolderInventory,
  observeFolderAdmission,
  type FolderInventorySnapshot,
} from "./folder-inventory.js";
import { daemonRuntimeDir } from "./rbox-paths.js";

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

async function collectViaOldDirectRegistry(): ReturnType<typeof collectMachineTriage> {
  const rows = await readBindingRegistry();
  const legacyInventory: FolderInventorySnapshot = {
    catalogState: "legacy",
    rows: rows.map((row) => ({
      ...row,
      // The old path had no admission; collectMachineTriage only consumes the
      // unchanged BindingRegistryRow projection.
      admission: { kind: "damaged", reason: "not observed by the old direct registry path" },
    })),
  };
  return collectMachineTriage({ listFolderInventory: async () => legacyInventory });
}

test("inventory is a differential read-only wrapper over every legacy registry row", async () => {
  const bound = path.join(scratch, "bound");
  const missing = path.join(scratch, "missing");
  const rebound = path.join(scratch, "rebound");
  const derived = path.join(scratch, "derived");
  await bind(bound, "ws_bound");
  await bind(rebound, "ws_new");
  await bind(derived, "ws_derived");
  await desired(derived, "ws_derived");

  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [
      {
        root: rebound,
        workspaceId: "ws_old",
        name: "Rebound",
        accountId: "acct_old",
        boundAt: "2026-08-09T10:00:00.000Z",
        lastSeenAt: "2026-08-10T10:00:00.000Z",
        scope: ["src"],
      },
      {
        root: missing,
        workspaceId: "ws_missing",
        boundAt: "2026-08-07T10:00:00.000Z",
        lastSeenAt: "2026-08-08T10:00:00.000Z",
      },
      {
        root: bound,
        workspaceId: "ws_bound",
        name: "Bound",
        boundAt: "2026-08-05T10:00:00.000Z",
        lastSeenAt: "2026-08-06T10:00:00.000Z",
      },
    ],
  }));

  const expected = await readBindingRegistry();
  const inventory = await listFolderInventory();
  expect(inventory.catalogState).toBe("legacy");
  expect(inventory.rows.map(registryProjection)).toEqual(expected);
  expect(inventory.rows.map((row) => row.root)).toEqual(expected.map((row) => row.root));
  expect(inventory.rows.find((row) => row.root === derived)?.derived).toBe(true);
  expect(await collectMachineTriage()).toEqual(await collectViaOldDirectRegistry());

  // Corrupt persisted evidence still degrades exactly as the registry does;
  // the daemon-derived discovery half remains visible and no file is healed.
  await fs.writeFile(bindingRegistryPath(), "{not json");
  const corruptBytes = await fs.readFile(bindingRegistryPath(), "utf8");
  const corruptExpected = await readBindingRegistry();
  const corruptInventory = await listFolderInventory();
  expect(corruptInventory.rows.map(registryProjection)).toEqual(corruptExpected);
  expect(await fs.readFile(bindingRegistryPath(), "utf8")).toBe(corruptBytes);
});

test("one malformed legacy policy damages only its row and preserves machine triage", async () => {
  const healthy = path.join(scratch, "healthy");
  const malformed = path.join(scratch, "malformed");
  await bind(healthy, "ws_healthy");
  await bind(malformed, "ws_malformed", { noDrift: 1 });
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [
      {
        root: healthy,
        workspaceId: "ws_healthy",
        boundAt: "2026-08-05T10:00:00.000Z",
        lastSeenAt: "2026-08-06T10:00:00.000Z",
      },
      {
        root: malformed,
        workspaceId: "ws_malformed",
        boundAt: "2026-08-07T10:00:00.000Z",
        lastSeenAt: "2026-08-08T10:00:00.000Z",
      },
    ],
  }));

  const expected = await readBindingRegistry();
  const inventory = await listFolderInventory();
  expect(inventory.rows).toHaveLength(expected.length);
  expect(inventory.rows.map(registryProjection)).toEqual(expected);
  expect(inventory.rows.find((row) => row.root === malformed)?.admission).toMatchObject({
    kind: "damaged",
  });
  expect(inventory.rows.find((row) => row.root === healthy)?.admission).toMatchObject({
    kind: "legacy",
  });
  expect(await collectMachineTriage()).toEqual(await collectViaOldDirectRegistry());
});

test("legacy admission derives every policy field from persisted binding behavior", async () => {
  const root = path.join(scratch, "policy");
  await bind(root, "ws_policy", {
    syncGit: true,
    git: { incremental: false },
    respectGitignore: true,
    noDrift: true,
    trash: { days: 12.9, maxBytes: Number.POSITIVE_INFINITY },
  });

  expect(await observeFolderAdmission(root)).toEqual({
    kind: "legacy",
    policy: {
      syncGit: true,
      git: { incremental: false },
      respectGitignore: true,
      noDrift: true,
      trash: { days: 12, maxBytes: 2 * 2 ** 30 },
    },
  });
});

test("damaged catalog state reports its exact reason", async () => {
  expect(await observeFolderAdmission(path.join(scratch, "any"), undefined, {
    inspectFolderCatalog: async () => ({
      kind: "damaged",
      authorityActivated: true,
      reason: "config-authority.json exists but config.json is absent",
    }),
  })).toEqual({
    kind: "damaged",
    reason: "config-authority.json exists but config.json is absent",
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
  const snapshot: FolderCatalogSnapshot = {
    catalog: {
      schemaVersion: 1,
      globalOptions: {},
      folders: [
        { name: "Admitted", path: admitted },
        { name: "Unbound", path: unbound },
        { name: "Missing", path: missing },
      ],
    },
    generation: "generation-1",
    folders: [
      { name: "Admitted", path: admitted, normalizedPath: admitted, policy: DEFAULT_FOLDER_POLICY },
      { name: "Unbound", path: unbound, normalizedPath: unbound, policy: DEFAULT_FOLDER_POLICY },
      { name: "Missing", path: missing, normalizedPath: missing, policy: DEFAULT_FOLDER_POLICY },
    ],
  };

  const authoritative = { kind: "authoritative", snapshot, activatedAt: "2026-08-11T10:00:00.000Z" } as const;
  expect(await observeFolderAdmission(admitted, authoritative)).toEqual({
    kind: "admitted",
    generation: "generation-1",
    policy: DEFAULT_FOLDER_POLICY,
  });
  expect(await observeFolderAdmission(unbound, authoritative)).toMatchObject({ kind: "unbound" });
  expect(await observeFolderAdmission(missing, authoritative)).toMatchObject({ kind: "missing" });
  expect(await observeFolderAdmission(detached, authoritative)).toMatchObject({ kind: "detached" });
});
