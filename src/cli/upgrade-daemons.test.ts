import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { restartDaemonsAfterUpgrade } from "./upgrade-cmd.js";
import { workspaceKey } from "./rbox-paths.js";
import type { DesiredStateRow } from "./autostart-cmd.js";

let home: string;
const rows: DesiredStateRow[] = [];

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "rbox-upgrade-daemons-"));
  process.env.RBOX_HOME = home;
  rows.length = 0;
});

afterEach(async () => {
  delete process.env.RBOX_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

async function runtime(name: string, pid: number, options: { state?: "running" | "stopped"; pullOnly?: boolean; pendingModeIntent?: "pull-only" | "read-write"; desired?: boolean } = {}): Promise<{ root: string; key: string }> {
  const root = path.join(home, name);
  const key = workspaceKey(root);
  const dir = path.join(home, ".rbox", "daemons", key);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, "daemon.pid"), `v2 ${pid} boot-${pid}\n`);
  if (options.desired !== false) {
    const desired = {
      rootPath: root,
      state: options.state ?? "running",
      accountId: "acct",
      workspaceId: `ws-${name}`,
      at: "2026-07-15T00:00:00.000Z",
      ...(options.pullOnly ? { pullOnly: true } : {}),
      ...(options.pendingModeIntent === undefined ? {} : { pendingModeIntent: options.pendingModeIntent }),
    } as const;
    const desiredPath = path.join(dir, "desired.json");
    await fs.writeFile(desiredPath, `${JSON.stringify(desired, null, 2)}\n`);
    rows.push({ key, path: desiredPath, desired });
  }
  return { root, key };
}

test("managed upgrade restarts every live workspace in stable key order and preserves pull-only", async () => {
  await runtime("zeta", 101, { pullOnly: true });
  await runtime("alpha", 102);
  const actions: string[] = [];
  await restartDaemonsAfterUpgrade({
    readDesiredDaemonRows: async () => rows,
    isDaemonProcess: () => true,
    currentWorkspaceId: (root) => `ws-${path.basename(root)}`,
    stopDaemon: async (root) => void actions.push(`stop:${workspaceKey(root)}`),
    startDaemon: async (root, opts) => { actions.push(`start:${workspaceKey(root)}:${opts.pullOnly === true}`); return "started"; },
    log: () => {},
  });
  const keys = rows.map((row) => row.key).sort();
  expect(actions).toEqual(keys.flatMap((key) => {
    const pullOnly = rows.find((row) => row.key === key)!.desired.pullOnly === true;
    return [`stop:${key}`, `start:${key}:${pullOnly}`];
  }));
});

test("managed upgrade gives a durable pending mode intent precedence", async () => {
  const pending = await runtime("pending", 151, { pendingModeIntent: "pull-only" });
  const starts: string[] = [];
  await restartDaemonsAfterUpgrade({
    readDesiredDaemonRows: async () => rows,
    isDaemonProcess: () => true,
    currentWorkspaceId: () => "ws-pending",
    stopDaemon: async () => {},
    startDaemon: async (root, opts) => {
      starts.push(`${root}:${opts.pullOnly === true}:${opts.modeIntent}`);
      return "started";
    },
    log: () => {},
  });
  expect(starts).toEqual([`${pending.root}:true:pending`]);
  const promoted = JSON.parse(await fs.readFile(rows[0]!.path, "utf8"));
  expect(promoted).toMatchObject({ state: "running", pullOnly: true });
  expect(promoted.pendingModeIntent).toBeUndefined();
});

test("managed upgrade does not restart a cached running row after desired state becomes stopped", async () => {
  const target = await runtime("stop-race", 171);
  let starts = 0;
  const logs: string[] = [];
  await restartDaemonsAfterUpgrade({
    readDesiredDaemonRows: async () => rows,
    isDaemonProcess: () => true,
    currentWorkspaceId: () => "ws-stop-race",
    stopDaemon: async () => {
      const desiredPath = rows[0]!.path;
      const desired = JSON.parse(await fs.readFile(desiredPath, "utf8"));
      await fs.writeFile(desiredPath, `${JSON.stringify({ ...desired, state: "stopped", at: "2026-07-15T00:01:00.000Z" }, null, 2)}\n`);
    },
    startDaemon: async () => { starts++; return "started"; },
    log: (line) => logs.push(line),
  });
  expect(target.root).toContain("stop-race");
  expect(starts).toBe(0);
  expect(logs.join("\n")).toContain("not restarted (desired state changed)");
});

test("live legacy runtime without desired state is reported and never stopped", async () => {
  const legacy = await runtime("legacy", 201, { desired: false });
  const stopped: string[] = [];
  const logs: string[] = [];
  await expect(restartDaemonsAfterUpgrade({
    readDesiredDaemonRows: async () => [],
    isDaemonProcess: () => true,
    stopDaemon: async (root) => void stopped.push(root),
    log: (line) => void logs.push(line),
  })).rejects.toThrow("could not be restarted");
  expect(stopped).toEqual([]);
  expect(logs.join("\n")).toContain(legacy.key);
});

test("managed upgrade continues after a failure and leaves stopped desired rows stopped", async () => {
  const failing = await runtime("fails", 301);
  const stopped = await runtime("stopped", 302, { state: "stopped" });
  const actions: string[] = [];
  await expect(restartDaemonsAfterUpgrade({
    readDesiredDaemonRows: async () => rows,
    isDaemonProcess: () => true,
    currentWorkspaceId: (root) => `ws-${path.basename(root)}`,
    stopDaemon: async (root) => {
      actions.push(`stop:${workspaceKey(root)}`);
      if (root === failing.root) throw new Error("private failure");
    },
    startDaemon: async (root) => { actions.push(`start:${workspaceKey(root)}`); return "started"; },
    log: () => {},
  })).rejects.toThrow("could not be restarted");
  expect(actions).toContain(`stop:${failing.key}`);
  expect(actions).toContain(`stop:${stopped.key}`);
  expect(actions).not.toContain(`start:${stopped.key}`);
});

test("managed upgrade reports malformed runtime discovery and continues", async () => {
  const valid = await runtime("valid", 401);
  const badDir = path.join(home, ".rbox", "daemons", "bad-runtime");
  await fs.mkdir(badDir, { recursive: true });
  await fs.writeFile(path.join(badDir, "daemon.pid"), "not-a-record\n");
  const actions: string[] = [];
  const logs: string[] = [];
  await expect(restartDaemonsAfterUpgrade({
    readDesiredDaemonRows: async () => rows,
    isDaemonProcess: () => true,
    currentWorkspaceId: (root) => `ws-${path.basename(root)}`,
    stopDaemon: async (root) => void actions.push(`stop:${workspaceKey(root)}`),
    startDaemon: async () => "started",
    log: (line) => void logs.push(line),
  })).rejects.toThrow("could not be restarted");
  expect(actions).toContain(`stop:${valid.key}`);
  expect(logs.join("\n")).toContain("bad-runtime: not restarted (runtime record unreadable)");
});

test("the curl installer remains binary-swap-only", async () => {
  const installer = await fs.readFile(path.resolve(import.meta.dir, "../../scripts/install.sh"), "utf8");
  expect(installer).toContain('mv -f "$TMP" "$DEST/rbox"');
  expect(installer).not.toMatch(/daemon\.pid|rbox stop|rbox start|SIGTERM|SIGKILL/);
});
