import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectMachineTriage, renderMachineTriage } from "./doctor-machine.js";
import { daemonRuntimeDir, daemonStatusPath } from "./daemon-control.js";
import type { AmbientDaemonStatusV1 } from "./daemon/ambient-status.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");

let home: string;
let scratch: string;
const originalHome = process.env.HOME;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-machine-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-machine-roots-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Seed the same on-disk records a live workspace daemon maintains: the
 * desired-state row under ~/.rbox/daemons and, optionally, its status record. */
async function seedWorkspace(name: string, opts: {
  workspaceId?: string;
  boundWorkspaceId?: string;
  status?: Partial<AmbientDaemonStatusV1>;
  missing?: boolean;
} = {}): Promise<string> {
  const root = path.join(scratch, name);
  const workspaceId = opts.workspaceId ?? `ws_${name}`;
  if (!opts.missing) {
    await fs.mkdir(path.join(root, ".rbox"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".rbox", "workspace.json"),
      JSON.stringify({ remoteWorkspaceId: opts.boundWorkspaceId ?? workspaceId, projectId: "root", remoteUrl: "https://api.test" }),
    );
  }
  await fs.mkdir(daemonRuntimeDir(root), { recursive: true });
  await fs.writeFile(path.join(daemonRuntimeDir(root), "desired.json"), JSON.stringify({
    rootPath: root,
    state: "running",
    accountId: "acct_1",
    workspaceId,
    at: new Date(NOW).toISOString(),
  }));
  if (opts.status) {
    await fs.writeFile(daemonStatusPath(root), JSON.stringify({
      schemaVersion: 1,
      state: "synced",
      heartbeatAt: new Date(NOW - 1_000).toISOString(),
      sequence: 1,
      lastSyncedAt: null,
      ...opts.status,
    }));
  }
  return root;
}

const collect = () => collectMachineTriage({ now: () => NOW, isDaemonProcess: () => false });

test("no synced folders prints the setup pointer instead of an error", async () => {
  const triage = await collect();
  expect(triage).toEqual({ schemaVersion: 1, scope: "machine", workspaces: [] });
  const rendered = renderMachineTriage(triage).join("\n");
  expect(rendered).toContain("rbox is not syncing anything here yet.");
  expect(rendered).toContain("rbox setup");
});

test("each workspace gets a plain-English line and a cd-into-it command", async () => {
  const healthy = await seedWorkspace("aaa-notes", { status: { state: "synced" } });
  const stuck = await seedWorkspace("bbb-code", {
    status: { state: "attention", attentionReason: "watcher-degraded", deferredRepos: 2 },
  });
  const triage = await collect();
  expect(triage.workspaces.map((w) => w.name)).toEqual(["aaa-notes", "bbb-code"]);

  const [first, second] = triage.workspaces;
  expect(first!.root).toBe(healthy);
  expect(first!.state).toBe("synced");
  expect(first!.summary).toBe("up to date");
  expect(first!.command).toBe(`cd ${healthy} && rbox doctor`);

  expect(second!.state).toBe("attention");
  expect(second!.summary).toContain("not noticing file changes instantly");
  expect(second!.summary).toContain("2 code folders are waiting on you");
  expect(second!.deferredRepos).toBe(2);
  expect(second!.command).toBe(`cd ${stuck} && rbox doctor`);

  const rendered = renderMachineTriage(triage).join("\n");
  expect(rendered).toContain("2 synced folders on this machine");
  expect(rendered).toContain("You are not inside a synced folder");
});

test("a stopped daemon reads as stopped and is told to start, not to diagnose", async () => {
  const root = await seedWorkspace("idle");
  const triage = await collect();
  expect(triage.workspaces[0]!.state).toBe("stopped");
  expect(triage.workspaces[0]!.summary).toBe("background sync is not running here");
  expect(triage.workspaces[0]!.command).toBe(`cd ${root} && rbox start`);
});

test("a stale status record from a live daemon reads as possibly stuck", async () => {
  await seedWorkspace("stale", { status: { state: "syncing", heartbeatAt: new Date(NOW - 3 * 3600_000).toISOString() } });
  const triage = await collectMachineTriage({ now: () => NOW, isDaemonProcess: () => true, readDaemonPidRecord: () => ({ present: true, pid: 4242 }) });
  expect(triage.workspaces[0]!.state).toBe("unknown");
  expect(triage.workspaces[0]!.summary).toContain("may be stuck");
});

test("a folder that is gone, or now bound elsewhere, is reported rather than crashing the view", async () => {
  await seedWorkspace("vanished", { missing: true });
  await seedWorkspace("rebound", { workspaceId: "ws_old", boundWorkspaceId: "ws_new" });
  const triage = await collect();
  const byName = new Map(triage.workspaces.map((w) => [w.name, w]));
  expect(byName.get("vanished")!.state).toBe("unreachable");
  expect(byName.get("vanished")!.summary).toContain("no longer set up for rbox");
  expect(byName.get("vanished")!.command).toContain("rbox untrack");
  expect(byName.get("rebound")!.state).toBe("unreachable");
  expect(byName.get("rebound")!.summary).toContain("different rbox workspace");
});
