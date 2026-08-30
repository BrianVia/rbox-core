import { test, expect, beforeEach, afterEach } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { track } from "./track-cmd.js";
import { untrack } from "./untrack-cmd.js";
import { main } from "./main-dispatch.js";
import { withInteractionPolicy } from "./prompt-policy.js";
import { findRoot, loadConfig, loadState, saveConfig, syncStreamId } from "./config.js";
import { daemonRuntimeDir } from "./daemon-control.js";
import { desiredStatePath } from "./autostart-cmd.js";
import { folderCatalogPath } from "./rbox-paths.js";
import { ensureFolderAuthority } from "./folder-authority.js";

let dir: string;
let home: string;
let logs: string[];
const origLog = console.log;
const origFetch = globalThis.fetch;
let savedEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedEnv = Object.fromEntries(["HOME", "RBOX_HOME", "RBOX_TOKEN", "RBOX_DEVICE_ID"].map((key) => [key, process.env[key]]));
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-track-"));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-home-"));
  process.env.HOME = home; // isolate credentials loaded by track
  process.env.RBOX_HOME = home; // redirect ~/.rbox so daemon runtime files are inspectable
  logs = [];
  console.log = (...m: unknown[]) => void logs.push(m.map(String).join(" "));
});
afterEach(async () => {
  console.log = origLog;
  globalThis.fetch = origFetch;
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(dir, { recursive: true, force: true });
  await fs.rm(home, { recursive: true, force: true });
});

test("track forwards --name when creating a new workspace", async () => {
  process.env.RBOX_TOKEN = "tok_track";
  let requestUrl = "";
  globalThis.fetch = (async (input: string | URL | Request) => {
    requestUrl = String(input);
    return new Response(JSON.stringify({ workspaceId: "ws_named" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const { cfg } = await track(
    dir,
    { name: "Conductor Workspaces", project: "proj_track", "no-interactive": "true" },
    "https://api.test"
  );

  expect(cfg.remoteWorkspaceId).toBe("ws_named");
  expect(requestUrl).toBe("https://api.test/v1/workspaces?project=proj_track&name=Conductor%20Workspaces");
});

test("logged-in track uses the credential device id for a new binding", async () => {
  process.env.RBOX_TOKEN = "tok_track";
  process.env.RBOX_DEVICE_ID = "dev_credential";

  const { cfg } = await track(dir, { workspace: "ws_existing" }, "https://api.test");

  expect(cfg.deviceId).toBe("dev_credential");
  expect((await loadConfig(dir)).deviceId).toBe("dev_credential");
});

test("offline --workspace track still mints a device id", async () => {
  const { cfg } = await track(dir, { workspace: "ws_offline" }, "https://api.test");

  expect(cfg.deviceId).toMatch(/^dev_[0-9a-f]{8}$/);
});

test("track --device overrides the credential device id", async () => {
  process.env.RBOX_TOKEN = "tok_track";
  process.env.RBOX_DEVICE_ID = "dev_credential";

  const { cfg } = await track(
    dir,
    { workspace: "ws_existing", device: "dev_explicit" },
    "https://api.test"
  );

  expect(cfg.deviceId).toBe("dev_explicit");
});

test("track writes a `.rbox/` binding; untrack removes it (round-trip)", async () => {
  // `--workspace` adopts an id offline (no network/login) — the bind-only path.
  const { cfg, root } = await track(dir, { workspace: "ws_abc123" }, "https://api.test");
  expect(cfg.remoteWorkspaceId).toBe("ws_abc123");
  expect(root).toBe(path.resolve(dir)); // track resolves (not realpaths) the arg

  // The workspace config is on disk and resolvable like every path command.
  const loaded = await loadConfig(root);
  expect(loaded.remoteWorkspaceId).toBe("ws_abc123");
  expect(loaded.token).toBe(""); // never persisted (injected at runtime)
  expect(await findRoot(root)).toBe(root);

  // untrack (no daemon running) removes the whole `.rbox/` tree.
  await untrack({ root, force: true });
  await expect(fs.access(path.join(root, ".rbox"))).rejects.toThrow();
  expect(await findRoot(root)).toBeUndefined();
});

// Design 276 F1.3: a lost catalog whose every folder is still a discoverable
// binding is reproduced exactly, so activation rebuilds it. Only a catalog
// generation would have to DROP a row refuses toward `rbox config regenerate`
// (folder-authority.test.ts).
test("re-tracking a bound root rebuilds a lost folder catalog it can fully reproduce", async () => {
  const { root } = await track(dir, { workspace: "ws_abc123" }, "https://api.test");
  await fs.rm(folderCatalogPath(), { force: true });
  await track(dir, { workspace: "ws_abc123" }, "https://api.test");
  const state = await ensureFolderAuthority();
  expect(state.snapshot.folders.map((folder) => folder.normalizedPath)).toEqual([root]);
});

test("track is bind-only: it persists config and Q but performs no first sync", async () => {
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  await fs.access(path.join(root, ".rbox", "workspace.json")); // exists (throws if missing)
  expect(await fs.readFile(path.join(root, ".rbox", "state.json"), "utf8")).toMatch(/^RBOX-SQLITE-AUTHORITY-v1\n[0-9a-f]{32}\n$/);
  const state = await loadState(root, syncStreamId(await loadConfig(root)));
  expect(state.lastSyncedSequence).toBe(0);
});

test("untrack also removes the global daemon runtime dir (no orphans under ~/.rbox)", async () => {
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  // Simulate a daemon having written its pid/log to the global per-workspace dir.
  const runtimeDir = daemonRuntimeDir(root);
  await fs.mkdir(runtimeDir, { recursive: true });
  await fs.writeFile(path.join(runtimeDir, "daemon.log"), "sync\n");
  await fs.writeFile(path.join(runtimeDir, "daemon.pid"), "12345");
  await fs.writeFile(desiredStatePath(root), JSON.stringify({ rootPath: root, state: "running", accountId: "acct_x", workspaceId: "ws_x", at: "2026-07-03T18:00:00.000Z" }));

  await untrack({ root, force: true });

  await expect(fs.access(runtimeDir)).rejects.toThrow(); // global runtime dir is gone
  await expect(fs.access(desiredStatePath(root))).rejects.toThrow();
  await expect(fs.access(path.join(root, ".rbox"))).rejects.toThrow(); // workspace binding too
});

test("untrack refuses when there is no binding to remove", async () => {
  await expect(untrack({ root: dir, force: true })).rejects.toThrow(/nothing to untrack/);
});

test("untrack refuses a symlinked `.rbox` instead of blindly removing it", async () => {
  const elsewhere = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-evil-"));
  await fs.writeFile(path.join(elsewhere, "keep.txt"), "important");
  await fs.symlink(elsewhere, path.join(dir, ".rbox"));
  try {
    await expect(untrack({ root: dir, force: true })).rejects.toThrow(/symlink/);
    // The symlink target is untouched.
    await fs.access(path.join(elsewhere, "keep.txt")); // exists (throws if missing)
  } finally {
    await fs.rm(elsewhere, { recursive: true, force: true });
  }
});

test("untrack honors an interactive 'no' (confirm returns false) and changes nothing", async () => {
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  await untrack({ root, force: false, confirm: async () => false });
  await fs.access(path.join(root, ".rbox", "workspace.json")); // exists (throws if missing)
});

test("untrack needs --force when interaction is disabled, and unbinds with it (#513)", async () => {
  // End-to-end over main-dispatch's own `confirm` callback. A disabled interaction
  // policy is exactly what `--no-interactive` installs. This used to be
  // headless: "proceed" — an unconfirmed unbind was the DEFAULT scripted behavior
  // while the help said `--force` was what skipped the prompt.
  const { root } = await track(dir, { workspace: "ws_x" }, "https://api.test");
  const argv = process.argv;
  const inDescriptor = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
  const headless = async (): Promise<void> => {
    await withInteractionPolicy(
      { enabled: false },
      () => main({ refreshSystemLockIdentityLedger: async () => {} }),
    );
  };
  try {
    process.argv = [process.execPath, "rbox", "untrack", root];
    await expect(headless()).rejects.toThrow(/--force/);
    await fs.access(path.join(root, ".rbox")); // still bound

    process.argv = [process.execPath, "rbox", "untrack", root, "--force"];
    await headless();
  } finally {
    process.argv = argv;
    if (inDescriptor) Object.defineProperty(process.stdin, "isTTY", inDescriptor);
    else delete (process.stdin as NodeJS.ReadStream & { isTTY?: boolean }).isTTY;
  }
  await expect(fs.access(path.join(root, ".rbox"))).rejects.toThrow();
});

// ── design 138 F1a: track is bind-only, never a consent boundary ────────────

test("re-tracking a DIFFERENT workspace refuses without changing config or baseline", async () => {
  await track(dir, { workspace: "ws_old" }, "https://api.test");
  const statePath = path.join(dir, ".rbox", "state.json");
  await fs.writeFile(
    statePath,
    JSON.stringify({ lastSyncedSequence: 9, lastSyncedManifest: { generatedAt: "", files: [{ path: "old.txt", type: "file", sha256: "x", size: 1, mode: 420, mtimeMs: 1 }] } })
  );
  const beforeState = await fs.readFile(statePath, "utf8");
  const beforeConfig = await fs.readFile(path.join(dir, ".rbox", "workspace.json"), "utf8");
  await expect(track(dir, { workspace: "ws_new" }, "https://api.test")).rejects.toThrow(/without setup confirmation/);
  expect(await fs.readFile(statePath, "utf8")).toBe(beforeState);
  expect(await fs.readFile(path.join(dir, ".rbox", "workspace.json"), "utf8")).toBe(beforeConfig);

  // Re-tracking the SAME workspace remains a harmless config refresh.
  await track(dir, { workspace: "ws_old" }, "https://api.test");
  expect(await fs.readFile(statePath, "utf8")).toBe(beforeState);
});

test("track create-new refuses an existing binding before attempting remote creation", async () => {
  await track(dir, { workspace: "ws_old" }, "https://api.test");
  await expect(track(dir, { "no-interactive": "true" }, "https://api.test")).rejects.toThrow(/without setup confirmation/);
  expect(JSON.parse(await fs.readFile(path.join(dir, ".rbox", "workspace.json"), "utf8"))).toMatchObject({
    remoteWorkspaceId: "ws_old",
  });
});

test("track refuses a foreign state lineage even when workspace config is absent", async () => {
  const statePath = path.join(dir, ".rbox", "state.json");
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  const bytes = JSON.stringify({
    stream: "https://api.test::ws_old::root",
    stateNonce: "0123456789abcdef0123456789abcdef",
    stateRevision: 2,
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  await fs.writeFile(statePath, bytes);
  await expect(track(dir, { workspace: "ws_new" }, "https://api.test")).rejects.toThrow(/without setup confirmation/);
  expect(await fs.readFile(statePath, "utf8")).toBe(bytes);
  await expect(fs.access(path.join(dir, ".rbox", "workspace.json"))).rejects.toThrow();
});

test("track rechecks lineage under the mutex instead of waiving a raced rebind from a stale snapshot", async () => {
  await track(dir, { workspace: "ws_A" }, "https://api.test");
  const statePath = path.join(dir, ".rbox", "state.json");
  const state = (workspaceId: string) => JSON.stringify({
    stream: `https://api.test::${workspaceId}::root`,
    stateNonce: "0123456789abcdef0123456789abcdef",
    stateRevision: 2,
    lastSyncedSequence: 1,
    lastSyncedManifest: { generatedAt: "", files: [] },
  });
  await fs.writeFile(statePath, state("ws_A"));

  await expect(track(dir, {}, "https://api.test", {
    isInteractive: () => true,
    promptSelect: async () => "existing",
    promptWorkspacePick: async () => {
      await saveConfig(dir, {
        schema: "e2ee/v1",
        remoteWorkspaceId: "ws_B",
        projectId: "root",
        deviceId: "dev_B",
        rootPath: dir,
        remoteUrl: "https://api.test",
        token: "",
      });
      await fs.writeFile(statePath, state("ws_B"));
      return { workspaceId: "ws_A" };
    },
  })).rejects.toThrow(/without setup confirmation/);

  expect((await loadConfig(dir)).remoteWorkspaceId).toBe("ws_B");
  expect(JSON.parse(await fs.readFile(statePath, "utf8")).stream).toBe("https://api.test::ws_B::root");
});
