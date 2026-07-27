import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { HashCache, scanManifest, type Manifest } from "../../engine/index.js";
import { bootstrapOnto, cfgFor, FakeServer, remoteFor } from "../e2ee-fake-server.js";
import { RboxDaemon } from "../daemon.js";
import { push } from "../sync.js";

const NOW = 1_900_000_000_000;
const ACCOUNT_ID = "acct_daemon_mde";
const WORKSPACE_ID = "ws_daemon_mde";

interface DaemonInternals {
  cache: HashCache;
  local: { head: Manifest };
  want: { push: boolean };
  activityWrite: Promise<void>;
  loadSyncBase(): Promise<unknown>;
  pump(): Promise<void>;
  stop(): Promise<void>;
}

let root: string;
let daemon: DaemonInternals | undefined;

beforeEach(async () => {
  delete process.env.RBOX_MDE_DELTA;
  delete process.env.RBOX_MDE_SNAPSHOT;
  delete process.env.RBOX_MDE_FAST_PULL;
  delete process.env.RBOX_MTIME_NORMALIZE;
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "rbox-daemon-mde-")));
});

afterEach(async () => {
  await daemon?.stop().catch(() => {});
  daemon = undefined;
  await fs.rm(root, { recursive: true, force: true });
});

test("daemon wires manifest attribution and publication through its log sink", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCOUNT_ID, "dev_daemon_mde", NOW);
  const lines: string[] = [];
  const sink = (line: string) => { lines.push(line); };
  const remote = remoteFor(server, secrets, ACCOUNT_ID, WORKSPACE_ID, NOW + 5_000, { warningSink: sink });
  const cfg = await cfgFor(root, secrets, remote, WORKSPACE_ID);
  daemon = new RboxDaemon(
    root,
    cfg,
    { remote, warningSink: sink, onGitLog: sink },
    { log: sink, keyDeliveryFlight: null },
  ) as unknown as DaemonInternals;
  await fs.writeFile(path.join(root, "attribution.txt"), "manifest attribution\n");
  daemon.cache = await HashCache.load(root);
  daemon.local.head = await scanManifest(root);
  await daemon.loadSyncBase();

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect(lines).toContainEqual(expect.stringMatching(/mde (delta ops=|non_delta cause=)/));
  expect(lines).toContainEqual(expect.stringContaining("push: published sequence 1"));
});

test("209/6 first daemon commit after a full boot scan emits one op for one real change despite full-tree mtime skew", async () => {
  const server = new FakeServer();
  const secrets = await bootstrapOnto(server, ACCOUNT_ID, "dev_daemon_mtime_boot", NOW);
  const lines: string[] = [];
  const sink = (line: string) => { lines.push(line); };
  const remote = remoteFor(server, secrets, ACCOUNT_ID, WORKSPACE_ID, NOW + 5_000, { warningSink: sink });
  const cfg = await cfgFor(root, secrets, remote, WORKSPACE_ID);
  const partition = path.join(root, "partition");
  await fs.mkdir(partition);
  await Promise.all(Array.from({ length: 300 }, (_, index) =>
    fs.symlink(`../target/${index}`, path.join(partition, index.toString().padStart(4, "0")))));

  expect((await push(root, cfg, { remote, warningSink: sink })).sequence).toBe(1);
  expect(server.commits).toHaveLength(1);
  lines.length = 0;

  const skew = new Date(3_000);
  await Promise.all(Array.from({ length: 300 }, (_, index) =>
    fs.lutimes(path.join(partition, index.toString().padStart(4, "0")), skew, skew)));
  const changed = path.join(partition, "0007");
  await fs.unlink(changed);
  await fs.symlink("../target/changed", changed);

  daemon = new RboxDaemon(
    root,
    cfg,
    { remote, warningSink: sink, onGitLog: sink },
    { log: sink, keyDeliveryFlight: null },
  ) as unknown as DaemonInternals;
  daemon.cache = await HashCache.load(root);
  daemon.local.head = await scanManifest(root);
  await daemon.loadSyncBase();

  daemon.want.push = true;
  await daemon.pump();
  await daemon.activityWrite;

  expect(server.commits).toHaveLength(2);
  expect(lines).toContainEqual(expect.stringMatching(/mde delta ops=1 bytes=/));
  expect(lines).toContainEqual(expect.stringContaining("push: published sequence 2"));
}, 60_000);
