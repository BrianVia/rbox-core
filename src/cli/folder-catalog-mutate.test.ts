import { afterEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { acquireLock } from "../engine/lockfile.js";
import {
  FolderCatalogStaleEditError,
  forgetFolder,
  inspectFolderCatalog,
  publishNoReplace,
  readFolderCatalog,
  recordFolder,
  serializeFolderCatalog,
  setFolderOptions,
} from "./folder-config.js";
import { folderCatalogLockPath, folderCatalogPath } from "./rbox-paths.js";

const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;
const roots: string[] = [];
const TEST_LOCK = {
  identity: {
    current: async () => ({ hostId: "aa", bootId: "bb", pid: process.pid, startTime: "1" }),
    probe: async () => ({ status: "alive" as const, startTime: "1" }),
  },
  storageLocal: async () => true,
  skipIdentityRefresh: true,
};

async function isolate(): Promise<string> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-catalog-mutate-"));
  const home = path.join(base, "home");
  roots.push(base);
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
  await fs.mkdir(home, { recursive: true });
  await publishNoReplace(serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: { syncGit: false, git: { incremental: false }, trash: { days: 20, maxBytes: 100 } },
    folders: [{ name: "Existing", path: path.join(base, "existing"), options: { syncGit: true, git: { incremental: true }, trash: { days: 2 } } }],
  }), { lock: TEST_LOCK });
  return base;
}

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

const mutationOptions = { publication: { lock: TEST_LOCK } };

test("record is idempotent by normalized path and derives colliding labels consistently", async () => {
  const base = await isolate();
  const existing = path.join(base, "existing");
  const before = await fs.readFile(folderCatalogPath(), "utf8");
  await recordFolder(path.join(existing, "..", "existing"), { options: { noDrift: true } }, mutationOptions);
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(before);

  const first = path.join(base, "one", "Code");
  const second = path.join(base, "two", "Code");
  await recordFolder(first, {}, mutationOptions);
  await recordFolder(second, {}, mutationOptions);
  expect((await readFolderCatalog()).catalog.folders.slice(-2).map((folder) => folder.name)).toEqual(["Code", "Code (2)"]);
});

test("forget of an absent path performs no write", async () => {
  const base = await isolate();
  const before = await fs.readFile(folderCatalogPath(), "utf8");
  await forgetFolder(path.join(base, "absent"), mutationOptions);
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(before);
});

test("set options patches nested fields and own-key undefined deletes for inheritance", async () => {
  const base = await isolate();
  const root = path.join(base, "existing");
  const policy = await setFolderOptions(root, {
    syncGit: undefined,
    git: { incremental: undefined },
    respectGitignore: true,
    ignorePaths: [],
    trash: { days: undefined, maxBytes: 0 },
  }, mutationOptions);
  expect(policy).toEqual({
    syncGit: false,
    git: { incremental: false },
    respectGitignore: true,
    ignorePaths: [],
    noDrift: false,
    trash: { days: 20, maxBytes: 0 },
  });
  expect((await readFolderCatalog()).catalog.folders[0]?.options).toEqual({
    respectGitignore: true,
    ignorePaths: [],
    trash: { maxBytes: 0 },
  });
});

test("an editor write during mutation rejects the stale revision and preserves the edit", async () => {
  const base = await isolate();
  const editorBytes = serializeFolderCatalog({ schemaVersion: 1, globalOptions: {}, folders: [] });
  await expect(recordFolder(path.join(base, "new"), {}, {
    publication: {
      lock: TEST_LOCK,
      onAtomicStep: async (step) => {
        if (step === "temp-closed") await fs.writeFile(folderCatalogPath(), editorBytes);
      },
    },
  })).rejects.toBeInstanceOf(FolderCatalogStaleEditError);
  expect(await fs.readFile(folderCatalogPath(), "utf8")).toBe(editorBytes);
});

test("a live catalog lock produces the bounded busy error", async () => {
  const base = await isolate();
  const held = await acquireLock(folderCatalogLockPath(), TEST_LOCK);
  if (held.status !== "acquired") throw new Error("expected test lock");
  try {
    await expect(recordFolder(path.join(base, "new"), {}, {
      publication: { lock: TEST_LOCK, lockWaitMs: 0 },
    })).rejects.toThrow(/busy/);
  } finally {
    await held.lock.release();
  }
  expect((await inspectFolderCatalog()).kind).toBe("authoritative");
});

test("damaged mutation refusal includes exact reason and repair-copy guidance", async () => {
  const base = await isolate();
  await fs.writeFile(folderCatalogPath(), "{");
  await expect(recordFolder(path.join(base, "new"), {}, mutationOptions)).rejects.toThrow(
    /invalid rbox folder config:.*Copy .*config\.json.*rbox config regenerate/,
  );
});
