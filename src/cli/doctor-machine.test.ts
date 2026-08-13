import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectMachineAggregate, collectMachineTriage, renderMachineStatusTable, renderMachineTriage } from "./doctor-machine.js";
import { serializeFolderCatalog } from "./folder-config.js";
import { daemonBoundPath, daemonPidPath, daemonRuntimeDir, daemonStatusPath, folderCatalogPath } from "./rbox-paths.js";
import type { AmbientDaemonStatusV1 } from "./daemon/ambient-status.js";
import { observeDaemon } from "./daemon/observation.js";

const NOW = Date.parse("2026-07-27T12:00:00.000Z");
const LIVE_PID = 4242;
const BOOT = "boot-live";

let home: string;
let scratch: string;
let savedHomeEnv: Record<string, string | undefined>;

beforeEach(async () => {
  savedHomeEnv = Object.fromEntries(["HOME", "RBOX_HOME"].map((key) => [key, process.env[key]]));
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-machine-home-"));
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-machine-roots-"));
  process.env.RBOX_HOME = home;
  process.env.HOME = home;
});

afterEach(async () => {
  for (const [key, value] of Object.entries(savedHomeEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(home, { recursive: true, force: true });
  await fs.rm(scratch, { recursive: true, force: true });
});

/** Seed the same on-disk records a live workspace daemon maintains: the
 * desired-state row under ~/.rbox/daemons, its pidfile, and its status record. */
async function seedWorkspace(name: string, opts: {
  workspaceId?: string;
  boundWorkspaceId?: string;
  status?: Partial<AmbientDaemonStatusV1>;
  pidBootId?: string;
  withPidfile?: boolean;
  /** Omit the startup binding, as a daemon still in startup has. */
  withBinding?: boolean;
  /** Omit the record's boot id entirely, as a pre-design-178 daemon would. */
  noStatusBootId?: boolean;
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
  if (opts.withPidfile !== false) {
    await fs.writeFile(daemonPidPath(root), `v2 ${LIVE_PID} ${opts.pidBootId ?? BOOT}\n`);
    if (opts.withBinding !== false) {
      await fs.writeFile(daemonBoundPath(root), `v2 ${opts.boundWorkspaceId ?? workspaceId} ${opts.pidBootId ?? BOOT}\n`);
    }
  }
  if (opts.status) {
    await fs.writeFile(daemonStatusPath(root), JSON.stringify({
      schemaVersion: 1,
      state: "synced",
      heartbeatAt: new Date(NOW - 1_000).toISOString(),
      sequence: 1,
      lastSyncedAt: null,
      // A real daemon stamps the incarnation that wrote the record; default to
      // the matching one so each test exercises the axis it names.
      ...(opts.noStatusBootId ? {} : { bootId: opts.pidBootId ?? BOOT }),
      ...opts.status,
    }));
  }
  return root;
}

const collectWith = (alive: boolean) =>
  collectMachineTriage({
    now: () => NOW,
    observeDaemon: (root, workspaceId, now) =>
      observeDaemon(root, workspaceId, now, { processMatches: () => alive }),
  });

test("no synced folders prints the setup pointer", async () => {
  const triage = await collectWith(false);
  expect(triage).toEqual({ schemaVersion: 1, scope: "machine", workspaces: [] });
  const rendered = renderMachineTriage(triage).join("\n");
  expect(rendered).toContain("rbox is not syncing anything here yet.");
  expect(rendered).toContain("rbox setup");
  // Design 211 retired the track-only disclaimer: the binding registry covers
  // folders bound with `rbox track` that never started background sync.
  expect(rendered).not.toContain("has never started background sync is not listed here");
});

test("human aggregate renderers add configured-but-unbound rows while JSON v1 stays byte-identical", async () => {
  const configured = path.join(scratch, "configured-only");
  await fs.mkdir(configured, { recursive: true });
  await fs.mkdir(path.dirname(folderCatalogPath()), { recursive: true });
  await fs.writeFile(folderCatalogPath(), serializeFolderCatalog({
    schemaVersion: 1,
    globalOptions: {},
    folders: [{ name: "Configured only", path: configured }],
  }));
  const aggregate = await collectMachineAggregate();
  expect(JSON.stringify(aggregate.triage)).toBe('{"schemaVersion":1,"scope":"machine","workspaces":[]}');
  expect(aggregate.configuredButUnbound).toHaveLength(1);
  for (const rendered of [
    renderMachineTriage(aggregate.triage, aggregate.configuredButUnbound),
    renderMachineStatusTable(aggregate.triage, aggregate.configuredButUnbound, NOW),
  ]) {
    expect(rendered.join("\n")).toContain("configured but not bound");
    expect(rendered.join("\n")).toContain("Configured only");
    expect(rendered.join("\n")).toContain("rbox config");
  }
});

test("a fresh status record from a DEAD daemon is never reported as up to date", async () => {
  const root = await seedWorkspace("crashed", { status: { state: "synced" } });
  const triage = await collectWith(false);
  const workspace = triage.workspaces[0]!;
  // Producer proof: the record is present and fresh; liveness is what demotes it.
  expect(JSON.parse(await fs.readFile(daemonStatusPath(root), "utf8")).state).toBe("synced");
  expect(workspace.state).not.toBe("synced");
  expect(workspace.state).toBe("stopped");
  expect(workspace.summary).toBe("background sync is not running here");
  expect(workspace.command).toBe(`cd ${root} && rbox start`);
});

test("a future-dated heartbeat from a live daemon is not trusted either", async () => {
  await seedWorkspace("skewed", {
    status: { state: "synced", heartbeatAt: new Date(NOW + 3 * 3600_000).toISOString() },
  });
  const triage = await collectWith(true);
  expect(triage.workspaces[0]!.state).toBe("unknown");
  expect(triage.workspaces[0]!.summary).toContain("may be stuck");
});

test("a starting daemon that has not written its binding yet is reported, not called stuck", async () => {
  const root = await seedWorkspace("starting", { status: { state: "synced" }, withBinding: false });
  const triage = await collectWith(true);
  const workspace = triage.workspaces[0]!;
  expect(workspace.state).toBe("synced");
  expect(workspace.summary).toBe("up to date");
  expect(workspace.command).toBe(`cd ${root} && rbox doctor`);
});

test("a live daemon with a fresh record gets its plain-English line and a cd-into-it command", async () => {
  const healthy = await seedWorkspace("aaa-notes", { status: { state: "synced" } });
  const stuck = await seedWorkspace("bbb-code", {
    status: { state: "attention", attentionReason: "watcher-degraded", deferredRepos: 2 },
  });
  const triage = await collectWith(true);
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
  expect(rendered).not.toContain("has never started background sync is not listed here");
});

test("a rejected record supplies no pending work either, not just no state", async () => {
  // The `status --all` PENDING column reads deferredRepos, so a dead daemon's
  // count must not survive the gate that already demoted its state.
  await seedWorkspace("dead-with-deferrals", { status: { state: "attention", deferredRepos: 3 } });
  const workspace = (await collectWith(false)).workspaces[0]!;
  expect(workspace.state).toBe("stopped");
  expect(workspace.deferredRepos).toBeUndefined();
  expect(workspace.summary).not.toContain("waiting on you");
});

test("a boot-bound record is trusted in full, including download-only mode", async () => {
  await seedWorkspace("bound", { status: { state: "synced", mode: "pull-only", bootId: BOOT }, pidBootId: BOOT });
  const workspace = (await collectWith(true)).workspaces[0]!;
  expect(workspace.state).toBe("synced");
  expect(workspace.summary).toBe("up to date (download-only)");
});

test("a record from a PREVIOUS boot is not trusted for STATE either, not just mode", async () => {
  // Round-2 finding: the machine view gated only `mode` on the boot id, so an
  // old-boot record still drove the headline state.
  const root = await seedWorkspace("stale-boot", {
    status: { state: "synced", mode: "pull-only", bootId: "boot-previous" },
    pidBootId: BOOT,
  });
  const workspace = (await collectWith(true)).workspaces[0]!;
  expect(JSON.parse(await fs.readFile(daemonStatusPath(root), "utf8")).state).toBe("synced");
  expect(workspace.state).not.toBe("synced");
  expect(workspace.state).toBe("unknown");
  expect(workspace.summary).toContain("may be stuck");
});

test("a legacy record with no boot id is not trusted for state", async () => {
  await seedWorkspace("legacy", { status: { state: "synced" }, pidBootId: BOOT, noStatusBootId: true });
  expect((await collectWith(true)).workspaces[0]!.state).toBe("unknown");
});

test("a daemon with no pidfile reads as stopped and is told to start", async () => {
  const root = await seedWorkspace("idle", { withPidfile: false });
  const triage = await collectWith(true);
  expect(triage.workspaces[0]!.state).toBe("stopped");
  expect(triage.workspaces[0]!.command).toBe(`cd ${root} && rbox start`);
});

test("a live daemon with a stale record reads as possibly stuck", async () => {
  await seedWorkspace("stale", { status: { state: "syncing", heartbeatAt: new Date(NOW - 3 * 3600_000).toISOString() } });
  const triage = await collectWith(true);
  expect(triage.workspaces[0]!.state).toBe("unknown");
  expect(triage.workspaces[0]!.summary).toContain("may be stuck");
});

test("a vanished folder is offered the untrack that now clears its registry entry", async () => {
  const root = await seedWorkspace("vanished", { missing: true });
  const triage = await collectWith(false);
  const workspace = triage.workspaces[0]!;
  expect(workspace.state).toBe("unreachable");
  expect(workspace.binding).toBe("missing");
  expect(workspace.summary).toContain("no longer set up for rbox");
  // Design 211 made this remedy real: untrack against a root whose binding is
  // already gone forgets the registry entry instead of erroring.
  expect(workspace.command).toBe(`rbox untrack ${root}`);
  const rendered = renderMachineTriage(triage).join("\n");
  expect(rendered).not.toMatch(/run:\s*$/m);
});

test("a folder rebound to a different workspace is reported rather than crashing the view", async () => {
  await seedWorkspace("rebound", { workspaceId: "ws_old", boundWorkspaceId: "ws_new" });
  const workspace = (await collectWith(false)).workspaces[0]!;
  expect(workspace.state).toBe("unreachable");
  expect(workspace.summary).toContain("different rbox workspace");
});
