import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { bindingRegistryPath } from "./binding-registry.js";
import { folderConfigCmd } from "./folder-config-cmd.js";
import { parseFolderConfigJson, projectFolderConfigJson } from "./folder-config-json.js";
import { inspectFolderCatalog, readFolderCatalog, serializeFolderCatalog, type FolderOptions } from "./folder-config.js";
import { listFolderInventory } from "./folder-inventory.js";
import { folderCatalogPath } from "./rbox-paths.js";
import type { WorkspaceConfig } from "./workspace-config.js";

let home: string;
let scratch: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-cmd-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-config-cmd-roots-"));
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

function binding(root: string, workspaceId = `ws_${path.basename(root)}`): WorkspaceConfig {
  return {
    schema: "e2ee/v1",
    remoteWorkspaceId: workspaceId,
    projectId: "root",
    deviceId: `dev_${path.basename(root)}`,
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
  };
}

async function writeBinding(root: string, value = binding(root)): Promise<void> {
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify(value));
}

async function writeCatalog(folders: Array<{ name: string; path: string; options?: FolderOptions }> = []): Promise<void> {
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: { syncGit: false, trash: { days: 7 } },
    folders,
  }));
}

async function writeRegistry(root: string, workspaceId: string): Promise<void> {
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [{
      root,
      workspaceId,
      boundAt: "2026-08-11T00:00:00.000Z",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
    }],
  }));
}

test("human and JSON views project every inventory row without using machine triage", async () => {
  const bound = path.join(scratch, "bound");
  const missing = path.join(scratch, "missing");
  await writeBinding(bound);
  await writeCatalog([{ name: "Bound", path: bound, options: { ignorePaths: ["a", "b/c"] } }, { name: "Missing", path: missing }]);
  const lines: string[] = [];
  await folderConfigCmd([], { json: false, yes: false }, { write: (line) => lines.push(line) });
  expect(lines.join("\n")).toContain(folderCatalogPath());
  expect(lines.join("\n")).toContain("global defaults: syncGit=false");
  expect(lines.join("\n")).toContain("ignorePaths=none");
  expect(lines.join("\n")).toContain("ignorePaths=a b/c");
  expect(lines.join("\n")).toContain("Bound");
  expect(lines.join("\n")).toContain("Missing");
  expect(lines.join("\n")).toContain("missing: the folder does not exist");

  const state = await inspectFolderCatalog();
  if (state.kind !== "authoritative") throw new Error("expected authoritative catalog");
  const value = projectFolderConfigJson(state, (await listFolderInventory(state)).rows);
  expect(parseFolderConfigJson(JSON.stringify(value))).toEqual(value);
  expect(value).toMatchObject({
    schemaVersion: 1,
    catalogPath: folderCatalogPath(),
    folders: [
      { path: bound, name: "Bound", status: "admitted", options: { ignorePaths: ["a", "b/c"] }, effectiveOptions: { ignorePaths: ["a", "b/c"] } },
      { path: missing, name: "Missing", status: "missing" },
    ],
  });
  expect(() => parseFolderConfigJson(JSON.stringify({ ...value, machineTriage: {} }))).toThrow(/not supported/);
  expect(() => parseFolderConfigJson(JSON.stringify({
    ...value,
    globalOptions: { trash: { days: 1.5 } },
  }))).toThrow(/must be an integer/);
  expect(() => parseFolderConfigJson(JSON.stringify({
    ...value,
    folders: [{ ...value.folders[0], surprise: true }],
  }))).toThrow(/not supported/);
});

/** `rbox config` is read-shaped, but on a 1.x home activation WRITES the
 *  catalog (design 276 F1.3). A file appearing in silence is not acceptable. */
test("a bare config view says so when it had to initialize the catalog first", async () => {
  const root = path.join(scratch, "precatalog");
  await fs.mkdir(root, { recursive: true });
  await writeBinding(root);
  await writeRegistry(root, `ws_${path.basename(root)}`);

  const lines: string[] = [];
  await folderConfigCmd([], { json: false, yes: false }, { write: (line) => lines.push(line) });
  expect(lines[0]).toContain(`initialized ${folderCatalogPath()}`);
  expect((await inspectFolderCatalog()).kind).toBe("authoritative");

  lines.length = 0;
  await folderConfigCmd([], { json: false, yes: false }, { write: (line) => lines.push(line) });
  expect(lines.join("\n")).not.toContain("initialized ");
});

test("add is idempotent, accepts an existing overlap, and refuses a newly introduced overlap", async () => {
  const parent = path.join(scratch, "parent");
  const child = path.join(parent, "child");
  const separate = path.join(scratch, "separate");
  await fs.mkdir(child, { recursive: true });
  await fs.mkdir(separate, { recursive: true });
  await writeCatalog([{ name: "Parent", path: parent }]);

  const lines: string[] = [];
  await folderConfigCmd(["add", parent], { json: false, yes: false }, { write: (line) => lines.push(line) });
  expect(lines.at(-1)).toContain("already configured");
  await expect(folderConfigCmd(["add", child], { json: false, yes: false })).rejects.toThrow(/physically overlaps/);
  await folderConfigCmd(["add", separate], { json: false, yes: false }, { write: (line) => lines.push(line) });
  expect((await readFolderCatalog()).folders.map((row) => row.normalizedPath)).toEqual([parent, separate]);
});

test("regeneration preserves bytes on decline and re-observes after a confirmation race", async () => {
  const root = path.join(scratch, "bound");
  const cfg = binding(root, "ws_regenerate");
  await writeBinding(root, cfg);
  await writeRegistry(root, cfg.remoteWorkspaceId);
  await writeCatalog([{ name: "Custom", path: path.join(scratch, "lost") }]);
  const before = await fs.readFile(folderCatalogPath(), "utf8");
  const declined: string[] = [];
  await folderConfigCmd(["regenerate"], { json: false, yes: false }, {
    confirm: async () => false,
    write: (line) => declined.push(line),
  });
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(before);
  expect(declined.join("\n")).toContain("Custom");
  expect(declined.at(-1)).toContain("nothing changed");

  let confirmations = 0;
  const lines: string[] = [];
  await folderConfigCmd(["regenerate"], { json: false, yes: false }, {
    confirm: async () => {
      confirmations++;
      if (confirmations === 1) await writeCatalog([{ name: "Concurrent edit", path: "/edited" }]);
      return true;
    },
    write: (line) => lines.push(line),
  });
  expect(confirmations).toBe(2);
  expect(lines.join("\n")).toContain("changed while confirming");
  expect((await readFolderCatalog()).folders.map((row) => row.normalizedPath)).toEqual([root]);
});

test("--yes replaces a damaged catalog without calling the confirmation seam", async () => {
  const root = path.join(scratch, "bound");
  const cfg = binding(root, "ws_yes");
  await writeBinding(root, cfg);
  await writeRegistry(root, cfg.remoteWorkspaceId);
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), "{");
  let confirmations = 0;
  await folderConfigCmd(["regenerate"], { json: false, yes: true }, {
    confirm: async () => { confirmations++; return false; },
    write: () => {},
  });
  expect(confirmations).toBe(0);
  expect((await readFolderCatalog()).folders[0]?.normalizedPath).toBe(root);
});

test("regeneration bounds repeated catalog races and returns an actionable error", async () => {
  await writeCatalog([]);
  let confirmations = 0;
  await expect(folderConfigCmd(["regenerate"], { json: false, yes: false }, {
    confirm: async () => {
      confirmations++;
      await writeCatalog([{ name: `Edit ${confirmations}`, path: `/edit-${confirmations}` }]);
      return true;
    },
    write: () => {},
  })).rejects.toThrow(/kept changing.*retry/);
  expect(confirmations).toBe(3);
});
