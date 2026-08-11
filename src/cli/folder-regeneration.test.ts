import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  confirmFolderRegeneration,
  inspectFolderCatalog,
  prepareFolderRegeneration,
  publishFolderRegeneration,
  publishNoReplace,
  serializeFolderCatalog,
  type FolderGenerationInventory,
} from "./folder-config.js";
import { folderCatalogPath } from "./rbox-paths.js";
import type { WorkspaceConfig } from "./workspace-config.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const roots: string[] = [];

async function isolate(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-regeneration-"));
  const home = path.join(base, "home");
  roots.push(base);
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
  await fs.mkdir(home, { recursive: true });
  await publishNoReplace(serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: { syncGit: false },
    folders: [{ name: "Custom", path: path.join(base, "old") }],
  }));
  return base;
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

function binding(root: string): WorkspaceConfig {
  return {
    remoteWorkspaceId: "ws_1",
    projectId: "root",
    deviceId: "dev_1",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: true,
  };
}

async function observation(root: string, skipped: FolderGenerationInventory["skipped"] = []): Promise<FolderGenerationInventory> {
  const state = await inspectFolderCatalog();
  return { revision: state.revision, discoverableBindings: [{ root, binding: binding(root) }], skipped };
}

test("preparation binds matching state/inventory revisions and names readable loss", async () => {
  const base = await isolate();
  const state = await inspectFolderCatalog();
  const inventory = await observation(path.join(base, "new"));
  const attempt = prepareFolderRegeneration(state, inventory);
  expect(attempt.loss.description).toContain("local labels");
  expect(attempt.loss.entries).toEqual([{ name: "Custom", path: path.join(base, "old") }]);
  expect(Object.isFrozen(attempt)).toBe(true);
  expect(Object.isFrozen(attempt.loss)).toBe(true);
  expect(Object.isFrozen(attempt.loss.entries)).toBe(true);
  expect(Object.isFrozen(attempt.loss.entries[0])).toBe(true);
  await fs.appendFile(folderCatalogPath(), " \n");
  const changed = await inspectFolderCatalog();
  expect(() => prepareFolderRegeneration(changed, inventory)).toThrow(/revisions do not match/);
});

test("readable damaged JSON retains best-effort affected entry names", async () => {
  const base = await isolate();
  await fs.writeFile(folderCatalogPath(), JSON.stringify({
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: "Recoverable name", path: path.join(base, "old") }],
    unsupported: true,
  }));
  const state = await inspectFolderCatalog();
  expect(state.kind).toBe("damaged");
  const inventory: FolderGenerationInventory = {
    revision: state.revision,
    discoverableBindings: [{ root: path.join(base, "new"), binding: binding(path.join(base, "new")) }],
    skipped: [],
  };
  expect(prepareFolderRegeneration(state, inventory).loss.entries).toEqual([
    { name: "Recoverable name", path: path.join(base, "old") },
  ]);
});

test("decline changes no byte while the --yes confirmation seam publishes", async () => {
  const base = await isolate();
  const state = await inspectFolderCatalog();
  const attempt = prepareFolderRegeneration(state, await observation(path.join(base, "new")));
  const before = await fs.readFile(folderCatalogPath(), "utf8");
  // Decline: the Adapter never mints authorization or calls publication.
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(before);

  const result = await publishFolderRegeneration(attempt, confirmFolderRegeneration(attempt));
  expect(result.kind).toBe("published");
  if (result.kind === "published") expect(result.snapshot.catalog.folders[0]?.name).toBe("new");
});

test("an edit after confirmation invalidates authorization without replacing the edit", async () => {
  const base = await isolate();
  const state = await inspectFolderCatalog();
  const attempt = prepareFolderRegeneration(state, await observation(path.join(base, "new")));
  const confirmed = confirmFolderRegeneration(attempt);
  const editor = serializeFolderCatalog({ schemaVersion: 1, globalOptions: {}, folders: [{ name: "Editor", path: "/editor" }] });
  await fs.writeFile(folderCatalogPath(), editor);
  expect(await publishFolderRegeneration(attempt, confirmed)).toEqual({ kind: "catalog-changed" });
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(editor);
  expect(() => confirmFolderRegeneration(attempt)).toThrow(/unknown/);
});

test("two simultaneous attempts let only the first revision publish", async () => {
  const base = await isolate();
  const state = await inspectFolderCatalog();
  const inventory = await observation(path.join(base, "new"));
  const first = prepareFolderRegeneration(state, inventory);
  const second = prepareFolderRegeneration(state, inventory);
  const firstAuthorization = confirmFolderRegeneration(first);
  const secondAuthorization = confirmFolderRegeneration(second);
  await expect(publishFolderRegeneration(first, secondAuthorization)).rejects.toThrow(/does not match/);
  expect((await publishFolderRegeneration(first, firstAuthorization)).kind).toBe("published");
  expect(await publishFolderRegeneration(second, secondAuthorization)).toEqual({ kind: "catalog-changed" });
});

test("successful publication retains skipped diagnostics from its pinned observation", async () => {
  const base = await isolate();
  const state = await inspectFolderCatalog();
  const skipped = [{ root: path.join(base, "missing"), reason: "binding is unreadable" }];
  const attempt = prepareFolderRegeneration(state, await observation(path.join(base, "new"), skipped));
  const result = await publishFolderRegeneration(attempt, confirmFolderRegeneration(attempt));
  expect(result).toMatchObject({ kind: "published", skipped });
});
