import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { readPersistedEntries } from "./binding-registry.js";
import { loadConfig, loadState, saveStateUnsafeLegacyOrTest, syncStreamId } from "./config.js";
import { flagValues, parseFlags } from "./flags.js";
import { resolveBindingScope } from "./scope/binding-scope.js";
import { scopeCmd } from "./scope/scope-cmd.js";
import { track } from "./track-cmd.js";

let root: string;
let home: string;
const originalHome = process.env.HOME;
const originalRboxHome = process.env.RBOX_HOME;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-include-root-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-include-home-"));
  process.env.HOME = home;
  process.env.RBOX_HOME = home;
});

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalRboxHome === undefined) delete process.env.RBOX_HOME;
  else process.env.RBOX_HOME = originalRboxHome;
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

test("track --include binds an existing workspace and writes the canonical scope plus witness", async () => {
  const { cfg } = await track(
    root,
    { workspace: "ws_include", include: "Personal/repo-A" },
    "https://api.test",
  );

  expect(cfg.scope).toEqual(["Personal/repo-A"]);
  expect(await resolveBindingScope(root)).toMatchObject({
    kind: "scoped",
    prefixes: ["Personal/repo-A"],
  });
  expect((await readPersistedEntries()).find((entry) => entry.root === root)?.scope)
    .toEqual(["Personal/repo-A"]);
});

test("repeatable track --include values survive parsing and are all applied", async () => {
  const parsed = parseFlags([
    "--workspace", "ws_repeat",
    "--include", "Personal/repo-A",
    "--include=Work/repo-B",
  ], "track");

  expect(flagValues(parsed.flags, "include")).toEqual(["Personal/repo-A", "Work/repo-B"]);
  const { cfg } = await track(root, parsed.flags, "https://api.test");
  expect(cfg.scope).toEqual(["Personal/repo-A", "Work/repo-B"]);
});

test("--include without --workspace fails before credentials, remote creation, or binding writes", async () => {
  let credentialsRead = false;
  let remoteCalled = false;
  await expect(track(root, { include: "Personal/repo-A" }, "https://api.test", {
    loadCredentials: async () => {
      credentialsRead = true;
      return undefined;
    },
    createRemoteWorkspace: async () => {
      remoteCalled = true;
      return "ws_unexpected";
    },
  })).rejects.toThrow("--include chooses folders of an existing workspace — use it with --workspace <id>");

  expect(credentialsRead).toBe(false);
  expect(remoteCalled).toBe(false);
  await expect(fs.access(path.join(root, ".rbox"))).rejects.toThrow();
});

test("track --include preserves include-add validation wording before reporting its rollback", async () => {
  await expect(track(
    root,
    { workspace: "ws_invalid", include: "../escape" },
    "https://api.test",
  )).rejects.toThrow(
    "'../escape' is not a folder inside the workspace — use a path like Personal/repo-A\n"
      + "the workspace was bound unscoped — run `rbox include add <folder>` to finish choosing folders",
  );
  expect(await resolveBindingScope(root)).toEqual({ kind: "unscoped" });
});

test("a post-bind include failure restores an unscoped seal, witness, and sync baseline", async () => {
  const stream = "https://api.test::ws_rollback::root";
  await saveStateUnsafeLegacyOrTest(root, {
    stream,
    lastSyncedSequence: 4,
    lastSyncedManifest: {
      generatedAt: "before",
      files: [
        { path: "Personal/repo-A/file.txt", type: "file", sha256: "a", size: 1, mode: 0o644, mtimeMs: 1 },
        { path: "Work/keep.txt", type: "file", sha256: "b", size: 1, mode: 0o644, mtimeMs: 1 },
      ],
    },
  });

  await expect(track(
    root,
    { workspace: "ws_rollback", include: "Personal/repo-A" },
    "https://api.test",
    { scopeDeps: { recordWitness: async () => { throw new Error("injected witness failure"); } } },
  )).rejects.toThrow("the workspace was bound unscoped — run `rbox include add <folder>`");

  const cfg = await loadConfig(root);
  expect(cfg.scope).toBeUndefined();
  expect(cfg.scopeIntent).toBeUndefined();
  expect(await resolveBindingScope(root)).toEqual({ kind: "unscoped" });
  expect((await readPersistedEntries()).find((entry) => entry.root === root)?.scope).toBeUndefined();
  expect((await loadState(root, stream)).lastSyncedManifest.files.map((file) => file.path))
    .toEqual(["Personal/repo-A/file.txt", "Work/keep.txt"]);
});

test("retracking an existing scoped binding preserves it before adding more folders", async () => {
  await track(root, { workspace: "ws_existing" }, "https://api.test");
  await scopeCmd(root, "add", ["Personal/repo-A"], { quiet: true }, {
    daemonRunning: () => false,
  });

  const { cfg } = await track(
    root,
    { workspace: "ws_existing", include: "Work/repo-B" },
    "https://api.test",
  );
  expect(cfg.scope).toEqual(["Personal/repo-A", "Work/repo-B"]);

  await scopeCmd(root, "remove", ["Personal/repo-A"], { quiet: true }, {
    daemonRunning: () => false,
  });
  expect((await loadConfig(root)).scope).toEqual(["Work/repo-B"]);
});

test("a failed include transition restarts background sync after restoring the previous scope", async () => {
  await track(root, { workspace: "ws_running" }, "https://api.test");
  await scopeCmd(root, "add", ["Personal/repo-A"], { quiet: true }, {
    daemonRunning: () => false,
  });
  let running = true;
  let stops = 0;
  let starts = 0;

  await expect(track(
    root,
    { workspace: "ws_running", include: "Work/repo-B" },
    "https://api.test",
    {
      scopeDeps: {
        daemonRunning: () => running,
        stopDaemon: async () => {
          stops++;
          running = false;
        },
        startDaemon: async () => {
          starts++;
          running = true;
        },
        recordWitness: async () => { throw new Error("injected witness failure"); },
      },
    },
  )).rejects.toThrow("the workspace remains bound with its previous included folders");

  expect({ running, stops, starts }).toEqual({ running: true, stops: 1, starts: 1 });
  expect(await resolveBindingScope(root)).toMatchObject({
    kind: "scoped",
    prefixes: ["Personal/repo-A"],
  });
});
