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

/** A 1.x-shaped bound folder: a `.rbox/` binding and nothing else. */
async function boundFolder(name: string, policy: { syncGit?: boolean } = {}): Promise<string> {
  const root = path.join(home, name);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: "ws_bound",
    projectId: "root",
    deviceId: "dev_1",
    rootPath: root,
    remoteUrl: "https://api.test",
    token: "",
    ...policy,
  }));
  return root;
}

async function writeBindingRegistry(...entries: { root: string; workspaceId: string }[]): Promise<void> {
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), JSON.stringify({
    schemaVersion: 1,
    entries: entries.map((entry) => ({ ...entry, boundAt: "2026-08-11T00:00:00.000Z", lastSeenAt: "2026-08-11T00:00:00.000Z" })),
  }));
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
 * The 1.x upgrade case (design 276 F1.3).
 *
 * A 1.11.4 home has discoverable bindings and no catalog. Generation reproduces
 * every one of them from its own pre-catalog policy, so there is nothing to lose
 * and nothing to consent to: initializing is what un-bricks the upgrade. Only a
 * row generation would DROP (the skipped case below) still refuses.
 */
test("an absent catalog with only discoverable bindings initializes instead of demanding regenerate", async () => {
  const root = await boundFolder("bound-folder", { syncGit: true });
  await writeBindingRegistry({ root, workspaceId: "ws_bound" });

  const state = await ensureFolderAuthority({ currentRoot: root });
  expect(state.snapshot.folders.map((folder) => folder.normalizedPath)).toEqual([root]);
  expect(state.snapshot.folders[0]?.policy.syncGit).toBe(true);
  expect(await catalogAbsent()).toBe(false);
});

test("an absent catalog with a binding whose evidence would be dropped still refuses", async () => {
  const root = await boundFolder("bound-folder");
  await writeBindingRegistry(
    { root, workspaceId: "ws_bound" },
    { root: path.join(home, "gone"), workspaceId: "ws_gone" },
  );

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
