import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureFolderAuthority } from "./folder-authority.js";
import { bindingRegistryPath, folderCatalogPath, rboxDir } from "./rbox-paths.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
let home: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-authority-"));
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await fs.rm(home, { recursive: true, force: true });
});

async function catalogAbsent(): Promise<boolean> {
  try {
    await fs.access(folderCatalogPath());
    return false;
  } catch {
    return true;
  }
}

test("a genuinely fresh machine silently initializes an empty authoritative catalog", async () => {
  const state = await ensureFolderAuthority();
  expect(state.kind).toBe("authoritative");
  expect(await catalogAbsent()).toBe(false);
});

test("a corrupt binding registry blocks silent initialization instead of publishing an empty catalog", async () => {
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), "{ this is not json");
  await expect(ensureFolderAuthority()).rejects.toThrow(/unavailable|workspaces\.json/);
  expect(await catalogAbsent()).toBe(true);
});

/**
 * The refusal the daemon depends on.
 *
 * A host whose catalog was lost still has its bindings, so the inventory is not
 * empty and regeneration would "succeed" — publishing a catalog stripped of
 * labels, ordering, global defaults, inheritance, and overrides that nothing can
 * reconstruct. The daemon never created the binding it is running, so it has no
 * standing to make that call; it asks for ordinary authority and refuses.
 */
test("a lost catalog on a root the caller did not just bind refuses instead of regenerating", async () => {
  const root = path.join(home, "bound-folder");
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: "ws_bound",
    projectId: "root",
    deviceId: "dev_1",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    syncGit: true,
  }));
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: [{
      root,
      workspaceId: "ws_bound",
      boundAt: "2026-08-11T00:00:00.000Z",
      lastSeenAt: "2026-08-11T00:00:00.000Z",
    }],
  }));

  await expect(ensureFolderAuthority({ currentRoot: root })).rejects.toThrow(/regenerate/);
  expect(await catalogAbsent()).toBe(true);
});

test("a dangling desired row with no binding refuses silent initialization toward regenerate", async () => {
  const ghostRoot = path.join(home, "ghost-folder");
  const desiredDir = path.join(rboxDir(), "daemons", "ghost-abcd1234");
  await fs.mkdir(desiredDir, { recursive: true });
  await fs.writeFile(path.join(desiredDir, "desired.json"), JSON.stringify({
    rootPath: ghostRoot,
    state: "running",
    accountId: "acct_ghost",
    workspaceId: "ws_ghost",
    at: "2026-08-11T00:00:00.000Z",
  }));
  await expect(ensureFolderAuthority()).rejects.toThrow(/regenerate/);
  expect(await catalogAbsent()).toBe(true);
});
