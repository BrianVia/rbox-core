import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  bindingRegistryPath,
  forgetBinding,
  isRegisteredRoot,
  readBindingRegistry,
  readPersistedEntries,
  rememberBinding,
  rememberResolvedRoot,
  REFRESH_INTERVAL_MS,
} from "./binding-registry.js";
import { daemonRuntimeDir } from "./rbox-paths.js";

let home: string;
let scratch: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-registry-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-registry-roots-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
});

afterEach(async () => {
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

/** A real binding on disk: `<root>/.rbox/workspace.json`, nothing else. */
async function bindRoot(name: string, workspaceId = `ws_${name}`, workspaceName?: string): Promise<string> {
  const root = path.join(scratch, name);
  await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: workspaceId,
    projectId: "root",
    remoteUrl: "https://api.test",
    ...(workspaceName ? { name: workspaceName } : {}),
  }));
  return root;
}

/** The desired-state row `rbox start` writes — the pre-registry enumeration source. */
async function seedDesiredRow(root: string, workspaceId: string): Promise<void> {
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(root), "desired.json"), JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_1",
    workspaceId,
    at: new Date().toISOString(),
  }));
}

test("a recorded binding round-trips and reads back as healthy", async () => {
  const root = await bindRoot("notes");
  await rememberBinding(root, { remoteWorkspaceId: "ws_notes", name: "Notes", accountId: "acct_1" });

  const rows = await readBindingRegistry();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    root,
    workspaceId: "ws_notes",
    name: "Notes",
    accountId: "acct_1",
    health: "bound",
    derived: false,
  });
  expect(await isRegisteredRoot(root)).toBe(true);
});

test("MIGRATION: an existing user's started workspaces appear with no persisted file", async () => {
  const root = await bindRoot("legacy");
  await seedDesiredRow(root, "ws_legacy");
  // Nothing was ever written by a bind path — the file does not exist at all.
  await expect(fs.stat(bindingRegistryPath())).rejects.toThrow();

  const rows = await readBindingRegistry();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ root, workspaceId: "ws_legacy", health: "bound", derived: true });
  // The derivation is a read-time union, so it never silently materializes a file.
  await expect(fs.stat(bindingRegistryPath())).rejects.toThrow();
});

test("MIGRATION: a persisted entry wins over the daemon-derived row for the same root", async () => {
  const root = await bindRoot("both");
  await seedDesiredRow(root, "ws_both");
  await rememberBinding(root, { remoteWorkspaceId: "ws_both", name: "Both" });

  const rows = await readBindingRegistry();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.name).toBe("Both");
  expect(rows[0]!.derived).toBe(false);
});

test("MIGRATION: the union cannot resurrect an untracked workspace", async () => {
  const root = await bindRoot("gone-soon");
  await seedDesiredRow(root, "ws_gone-soon");
  await rememberBinding(root, { remoteWorkspaceId: "ws_gone-soon" });
  expect(await readBindingRegistry()).toHaveLength(1);

  // What untrack does: remove the persisted entry AND the daemon runtime dir
  // that the desired row lives in. Both halves of the union go at once.
  await forgetBinding(root);
  await fs.rm(daemonRuntimeDir(root), { recursive: true, force: true });
  expect(await readBindingRegistry()).toHaveLength(0);
});

test("STALE ROOT: a deleted root is reported as missing, never dropped", async () => {
  const root = await bindRoot("deleted");
  await rememberBinding(root, { remoteWorkspaceId: "ws_deleted", name: "Deleted" });
  await fs.rm(root, { recursive: true, force: true });

  const rows = await readBindingRegistry();
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ root, health: "missing", name: "Deleted" });
  expect(rows[0]!.currentWorkspaceId).toBeUndefined();
  // Still persisted: only an explicit untrack removes it.
  expect(await readPersistedEntries()).toHaveLength(1);
});

test("STALE ROOT: a root moved away and rebound elsewhere is reported as rebound", async () => {
  const root = await bindRoot("moved", "ws_old");
  await rememberBinding(root, { remoteWorkspaceId: "ws_old" });
  await fs.writeFile(path.join(root, ".rbox", "workspace.json"), JSON.stringify({
    remoteWorkspaceId: "ws_new",
    projectId: "root",
    remoteUrl: "https://api.test",
  }));

  const rows = await readBindingRegistry();
  expect(rows[0]).toMatchObject({ health: "rebound", workspaceId: "ws_old", currentWorkspaceId: "ws_new" });
});

test("CONCURRENCY: parallel writers for different roots all survive", async () => {
  const roots = await Promise.all(
    Array.from({ length: 8 }, (_, index) => bindRoot(`parallel-${index}`)),
  );
  await Promise.all(roots.map((root, index) => rememberBinding(root, { remoteWorkspaceId: `ws_parallel-${index}` })));

  const persisted = await readPersistedEntries();
  expect(persisted.map((entry) => entry.root).sort()).toEqual([...roots].sort());
});

test("CONCURRENCY: a parallel forget and remember of the same root leaves a consistent file", async () => {
  const keep = await bindRoot("keep");
  const drop = await bindRoot("drop");
  await rememberBinding(drop, { remoteWorkspaceId: "ws_drop" });
  await Promise.all([
    rememberBinding(keep, { remoteWorkspaceId: "ws_keep" }),
    forgetBinding(drop),
  ]);

  const persisted = await readPersistedEntries();
  expect(persisted.map((entry) => entry.root)).toEqual([keep]);
  // The file is always complete, parseable JSON — never a partial write.
  const raw = JSON.parse(await fs.readFile(bindingRegistryPath(), "utf8"));
  expect(raw.schemaVersion).toBe(1);
});

test("a corrupt registry file degrades to empty instead of throwing", async () => {
  const root = await bindRoot("survivor");
  await seedDesiredRow(root, "ws_survivor");
  await fs.mkdir(path.dirname(bindingRegistryPath()), { recursive: true });
  await fs.writeFile(bindingRegistryPath(), "{not json at all");

  expect(await readPersistedEntries()).toEqual([]);
  // The daemon-derived half still answers, so the view is not blanked out.
  expect(await readBindingRegistry()).toHaveLength(1);
  // And a subsequent write repairs the file rather than failing.
  await rememberBinding(root, { remoteWorkspaceId: "ws_survivor" });
  expect(await readPersistedEntries()).toHaveLength(1);
});

test("forgetBinding reports whether anything was actually removed", async () => {
  const root = await bindRoot("forgettable");
  await rememberBinding(root, { remoteWorkspaceId: "ws_forgettable" });
  expect(await forgetBinding(root)).toBe(true);
  expect(await forgetBinding(root)).toBe(false);
  expect(await readPersistedEntries()).toEqual([]);
});

test("a rebind replaces the entry and carries nothing over from the old workspace", async () => {
  const root = await bindRoot("rebind", "ws_first", undefined);
  await rememberBinding(root, { remoteWorkspaceId: "ws_first", name: "First", accountId: "acct_1" });
  const first = (await readPersistedEntries())[0]!;

  await rememberBinding(root, { remoteWorkspaceId: "ws_second" });
  const second = (await readPersistedEntries())[0]!;
  expect(second.workspaceId).toBe("ws_second");
  expect(second.name).toBeUndefined();
  expect(second.accountId).toBeUndefined();
  expect(Date.parse(second.boundAt)).toBeGreaterThanOrEqual(Date.parse(first.boundAt));
});

test("re-recording the same workspace keeps the original bind date", async () => {
  const root = await bindRoot("stable");
  const earlier = new Date(Date.now() - 5 * REFRESH_INTERVAL_MS);
  await rememberBinding(root, { remoteWorkspaceId: "ws_stable" }, () => earlier);
  await rememberBinding(root, { remoteWorkspaceId: "ws_stable", name: "Stable" });

  const entry = (await readPersistedEntries())[0]!;
  expect(entry.boundAt).toBe(earlier.toISOString());
  expect(Date.parse(entry.lastSeenAt)).toBeGreaterThan(Date.parse(entry.boundAt));
  expect(entry.name).toBe("Stable");
});

test("rememberResolvedRoot converges a workspace bound by an older binary", async () => {
  const root = await bindRoot("older", "ws_older", "Older");
  expect(await readPersistedEntries()).toEqual([]);

  await rememberResolvedRoot(root);
  expect(await readPersistedEntries()).toMatchObject([{ root, workspaceId: "ws_older", name: "Older" }]);
});

test("rememberResolvedRoot writes nothing when the entry is already fresh", async () => {
  const root = await bindRoot("fresh", "ws_fresh", "Fresh");
  await rememberResolvedRoot(root);
  const before = await fs.readFile(bindingRegistryPath(), "utf8");

  await rememberResolvedRoot(root);
  expect(await fs.readFile(bindingRegistryPath(), "utf8")).toBe(before);
});

test("rememberResolvedRoot refreshes a stale lastSeen and a changed binding", async () => {
  const root = await bindRoot("aging", "ws_aging", "Aging");
  const long = new Date(Date.now() - 3 * REFRESH_INTERVAL_MS);
  await rememberBinding(root, { remoteWorkspaceId: "ws_aging", name: "Aging" }, () => long);

  await rememberResolvedRoot(root);
  const entry = (await readPersistedEntries())[0]!;
  expect(Date.parse(entry.lastSeenAt)).toBeGreaterThan(long.getTime());
});

test("rememberResolvedRoot ignores a root with no readable binding", async () => {
  await rememberResolvedRoot(path.join(scratch, "not-a-workspace"));
  expect(await readPersistedEntries()).toEqual([]);
});

test("registry rows are sorted by root so aggregate views are stable", async () => {
  const b = await bindRoot("bbb");
  const a = await bindRoot("aaa");
  await rememberBinding(b, { remoteWorkspaceId: "ws_bbb" });
  await rememberBinding(a, { remoteWorkspaceId: "ws_aaa" });
  expect((await readBindingRegistry()).map((row) => row.root)).toEqual([a, b]);
});
